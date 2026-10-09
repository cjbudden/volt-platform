// ============================================================================
//  WORKFLOW POLICY — the settings that decide what a share page lets somebody
//  DO, as opposed to what it lets them see.
//
//  ------------------------------------------------------------------------
//  WHY THIS EXISTS AS A RESOLVER RATHER THAN AS CONFIG READS.
//
//  These settings belong to an ACCOUNT. "Review links always require a PIN",
//  "approval needs two people", "QC is a hard gate here" are decisions a
//  broadcaster makes once for their whole organisation.
//
//  There is no account management yet. This is a single-account deployment we
//  are testing on, so today the values come from the deployment's own config.
//
//  The trap in that is obvious and worth naming: if the code reads
//  `config.workflow.review.qcGate` at twenty call sites, then adding accounts
//  later means finding and rewriting twenty call sites, and the ones that get
//  missed silently keep serving the deployment default to every tenant. That
//  is a security bug wearing the costume of a config change.
//
//  So the shape is defined once, and resolution is a CHAIN with the account
//  rung already in it and currently returning nothing:
//
//      built-in defaults  ->  deployment  ->  account  ->  this one link
//
//  Adding SaaS accounts later fills the gap. It does not restructure anything,
//  and nothing outside this file learns where a value came from.
//
//  ------------------------------------------------------------------------
//  THE PAGE DECIDES NOTHING.
//
//  `shareActions` is the whole authority: given a purpose, a policy and the
//  current state, it returns which actions exist, which are enabled, and WHY
//  one is not. The page renders that list. It never works out for itself
//  whether Approve should be showable, because a page that decides is a page
//  that can be wrong in a browser, and this is the surface we hand to people
//  outside the organisation.
// ============================================================================

export type SharePurpose = 'preview' | 'review';
export type QcState = 'pass' | 'warnings' | 'failed' | null;
export type ReviewState = 'draft' | 'in_review' | 'changes_requested' | 'approved' | 'rejected';

export interface WorkflowPolicy {
  share: {
    /** Offered in the Share dialog, and the cap it may not exceed. */
    defaultExpiryDays: number;
    maxExpiryDays: number;
    pin: 'never' | 'optional' | 'required';
    watermark: 'off' | 'optional' | 'forced';
    download: 'never' | 'optional' | 'always';
    notifyOnFirstOpen: boolean;
  };
  review: {
    /**
     * How much an external reviewer's name is worth. A typed name is
     * attribution; a verified email is evidence. Which one is enough is a
     * decision about how contractual the approval is meant to be, so it is a
     * policy rather than a constant.
     */
    identify: 'typed-name' | 'verified-email';
    approvalsRequired: number;
    /** "Changes requested" with no note is a round trip that teaches the editor
     *  nothing, so most accounts will want this on. */
    requireNoteOnChanges: boolean;
    /** Soft: approving over QC findings is allowed and RECORDED. Hard: it is
     *  refused. Migration 0009 argues for soft as the default, because a check
     *  that blocks on its own is a check people learn to route around. */
    qcGate: 'soft' | 'hard';
    labels: { category: string[]; action: string[] };
    notifyOnDecision: boolean;
  };
}

export const DEFAULT_POLICY: WorkflowPolicy = {
  share: {
    defaultExpiryDays: 7,
    maxExpiryDays: 30,
    pin: 'optional',
    watermark: 'optional',
    download: 'optional',
    notifyOnFirstOpen: true,
  },
  review: {
    identify: 'typed-name',
    approvalsRequired: 1,
    requireNoteOnChanges: true,
    qcGate: 'soft',
    labels: {
      category: ['language', 'audio', 'video', 'legal', 'branding', 'caption', 'edit', 'other'],
      action: ['cut', 'beep', 'blur', 'replace', 'recut', 'none'],
    },
    notifyOnDecision: true,
  },
};

export type PolicyPatch = DeepPartial<WorkflowPolicy>;
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/**
 * The chain. `account` is a parameter today and a lookup tomorrow.
 *
 * Later rungs win, and only for the keys they actually set: a link that says
 * nothing about PINs must not silently reset the account's PIN rule.
 */
export function resolvePolicy(rungs: {
  deployment?: PolicyPatch | null;
  account?: PolicyPatch | null;
  link?: PolicyPatch | null;
} = {}): WorkflowPolicy {
  return [rungs.deployment, rungs.account, rungs.link]
    .filter(Boolean)
    .reduce<WorkflowPolicy>((acc, patch) => merge(acc, patch as PolicyPatch), clone(DEFAULT_POLICY));
}

function merge(base: WorkflowPolicy, patch: PolicyPatch): WorkflowPolicy {
  const out = clone(base) as any;
  for (const group of Object.keys(patch) as (keyof WorkflowPolicy)[]) {
    const g = (patch as any)[group];
    if (!g || typeof g !== 'object') continue;
    for (const key of Object.keys(g)) {
      if (g[key] !== undefined) out[group][key] = g[key];
    }
  }
  return out as WorkflowPolicy;
}

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)); }

// ---------------------------------------------------------------------------

export interface ShareAction {
  id: 'watch' | 'download_hires' | 'download_metadata' | 'comment'
    | 'approve' | 'request_changes' | 'copy_link';
  label: string;
  enabled: boolean;
  /** Shown beside a disabled action. A control that is greyed with no
   *  explanation produces a support ticket; one that says why produces a
   *  decision. */
  reason?: string;
  /** True when taking this action is allowed but will be marked as an
   *  override. The page says so before the click, not after. */
  override?: boolean;
}

export interface ShareContext {
  purpose: SharePurpose;
  policy: WorkflowPolicy;
  /** What the link itself was created with. Policy caps these, it does not
   *  invent them: a link created without download rights never gains them. */
  link: { allowHiRes?: boolean; allowMetadata?: boolean };
  qcState: QcState;
  reviewState: ReviewState;
  /** Has this viewer identified themselves to the standard the policy asks
   *  for? A typed name, or a verified email. */
  identified: boolean;
  /** Notes this viewer has written but not yet submitted. */
  pendingNotes: number;
  /** Approvals already recorded against this asset. */
  approvals: number;
}

export function shareActions(ctx: ShareContext): ShareAction[] {
  const { policy: p, purpose } = ctx;
  const out: ShareAction[] = [
    { id: 'watch', label: 'Watch', enabled: true },
  ];

  // Downloads: the link's grant AND the policy's ceiling. Both must allow it.
  const dl = p.share.download;
  if (dl !== 'never') {
    if (ctx.link.allowHiRes || dl === 'always') {
      out.push({ id: 'download_hires', label: 'Download hi-res', enabled: true });
    }
    if (ctx.link.allowMetadata || dl === 'always') {
      out.push({ id: 'download_metadata', label: 'Download metadata', enabled: true });
    }
  }

  if (purpose !== 'review') return out;

  const decided = ctx.reviewState === 'approved' || ctx.reviewState === 'rejected';
  const needsId = !ctx.identified;
  const idReason = p.review.identify === 'verified-email'
    ? 'Verify your email on this link first'
    : 'Add your name first';

  out.push({
    id: 'comment',
    label: 'Add a note',
    enabled: !needsId,
    reason: needsId ? idReason : undefined,
  });

  // Request changes. Cheap to allow, and the note requirement is the only gate.
  const noteMissing = p.review.requireNoteOnChanges && ctx.pendingNotes === 0;
  out.push({
    id: 'request_changes',
    label: 'Request changes',
    enabled: !needsId && !noteMissing && !decided,
    reason: needsId ? idReason
      : noteMissing ? 'Add at least one note saying what needs to change'
      : decided ? 'This review is already closed'
      : undefined,
  });

  // Approve. The one action policy actually restrains.
  const qcBlocked = p.review.qcGate === 'hard' && (ctx.qcState === 'failed' || ctx.qcState === 'warnings');
  const qcOverride = p.review.qcGate === 'soft' && (ctx.qcState === 'failed' || ctx.qcState === 'warnings');
  const remaining = Math.max(0, p.review.approvalsRequired - ctx.approvals);
  out.push({
    id: 'approve',
    label: remaining > 1 ? `Approve (${remaining} approvals needed)` : 'Approve',
    enabled: !needsId && !qcBlocked && !decided,
    // Only flag an override on an action somebody can actually take. A closed
    // review carrying an "approving anyway will be recorded" warning is a
    // warning about something that is not going to happen.
    override: (qcOverride && !decided && !needsId && !qcBlocked) || undefined,
    reason: needsId ? idReason
      : qcBlocked ? `QC ${ctx.qcState === 'failed' ? 'failed' : 'raised warnings'} and this account requires QC to pass before approval`
      : decided ? 'This review is already closed'
      : qcOverride ? 'QC findings are outstanding. Approving anyway is allowed here, and will be recorded against your name.'
      : undefined,
  });

  return out;
}

/**
 * Read the deployment's rung out of environment variables.
 *
 * Kept here rather than in `config.ts` so that the shape and the way it is read
 * stay next to each other, and so the account rung can be added beside it.
 */
export function deploymentPolicyFromEnv(env: Record<string, string | undefined>): PolicyPatch {
  const num = (v?: string) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : undefined);
  const bool = (v?: string) => (v === undefined || v === '' ? undefined : v === 'true' || v === '1');
  const pick = <T extends string>(v: string | undefined, allowed: readonly T[]) =>
    (v !== undefined && (allowed as readonly string[]).includes(v) ? (v as T) : undefined);

  return {
    share: {
      defaultExpiryDays: num(env.WORKFLOW_SHARE_DEFAULT_EXPIRY_DAYS),
      maxExpiryDays: num(env.WORKFLOW_SHARE_MAX_EXPIRY_DAYS),
      pin: pick(env.WORKFLOW_SHARE_PIN, ['never', 'optional', 'required'] as const),
      watermark: pick(env.WORKFLOW_SHARE_WATERMARK, ['off', 'optional', 'forced'] as const),
      download: pick(env.WORKFLOW_SHARE_DOWNLOAD, ['never', 'optional', 'always'] as const),
      notifyOnFirstOpen: bool(env.WORKFLOW_SHARE_NOTIFY_FIRST_OPEN),
    },
    review: {
      identify: pick(env.WORKFLOW_REVIEW_IDENTIFY, ['typed-name', 'verified-email'] as const),
      approvalsRequired: num(env.WORKFLOW_REVIEW_APPROVALS),
      requireNoteOnChanges: bool(env.WORKFLOW_REVIEW_REQUIRE_NOTE),
      qcGate: pick(env.WORKFLOW_REVIEW_QC_GATE, ['soft', 'hard'] as const),
      notifyOnDecision: bool(env.WORKFLOW_REVIEW_NOTIFY_DECISION),
    },
  };
}
