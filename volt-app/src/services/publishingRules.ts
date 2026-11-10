// ============================================================================
//  PUBLISHING RULES — the ladder, resolved per field.
//
//    account default  <  content type  <  channel / event / station  <  asset
//
//  Each rung is a partial: only the keys it states. resolve() lays them on top
//  of the platform baseline in that order and remembers, per key, which rung
//  supplied the value, so the library can say "went to YouTube because of the
//  Sky Sport rule" rather than "because". The result is what is stamped on
//  the asset at publish time, and what the play gate reads afterwards.
//
//  PUBLISHING POINTS ARE THE CLIENT'S OWN. A target is one of: the platform
//  catalogue ('portal'), one of the client's registered apps ('app', by id),
//  or one of the client's configured social accounts ('social', by
//  publish_targets id). validateTargets() refuses anything else, so a rule
//  can never name an app or an account the client does not have.
// ============================================================================
import { query, one } from '../db';
import type { AccessRule } from './accessRules';

export type Target =
  | { kind: 'portal' }
  | { kind: 'app'; appId: string }
  | { kind: 'social'; targetId: string; platform?: string };

export interface RuleSettings {
  /** Where a publish sends the asset. */
  targets?: Target[];
  /** Publish derived assets as soon as they are built and pass the gate. */
  autoPublish?: boolean;
  /** When it becomes available: at publish, or at a set time. */
  availableFrom?: { mode: 'publish' } | { mode: 'at'; at: string };
  /** When it stops being available. */
  expire?: { mode: 'never' } | { mode: 'days'; days: number } | { mode: 'at'; at: string };
  geo?: { mode: 'worldwide' | 'allow' | 'block'; countries: string[] };
  /** free: anyone the geo allows; entitled: needs an entitlement; paid: needs the paywall. */
  access?: 'free' | 'entitled' | 'paid';
  paywall?: { tier?: string; priceCents?: number; currency?: string } | null;
  /** Gate before an automatic or manual publish goes through. */
  gate?: { requireReview: boolean; blockOnQcFail: boolean };
  /** The FOR / IF / THEN / TERMS rule set (services/accessRules.ts). When
   *  present and non-empty it decides access for the content it governs, and
   *  the simple geo / access / paywall fields are the fallback for content no
   *  rule matches. */
  accessRules?: AccessRule[];
  /** COPY RULES (Mirror and Archive, build queue H3-3): copy the asset's
   *  original to these storage targets when it lands or when it is
   *  published, optionally only inside an off-peak window. `recording`
   *  (H3-7) archives the recordings of the channels and events the rule
   *  governs, one file per programme or hour as each closes
   *  (services/archive/recordings.ts). Needs the
   *  `mirror_archive` licence to be saved (modules/publishingRules.ts) and
   *  to run (services/archive/archive.ts copyOnRule). `schedule` (H3-8)
   *  copies nightly what the target does not hold yet, and `what` picks the
   *  original, its sidecars (metadata JSON, captions, companion files,
   *  poster; services/archive/sidecars.ts) or both, a clip's file (H3-9) or
   *  the HLS/DASH package as a folder (H3-11, services/archive/packages.ts);
   *  the original alone when unsaid. */
  archive?: {
    copies: { targetId: string; on: ('ingest' | 'publish' | 'recording' | 'schedule')[]; what?: ('source' | 'sidecars' | 'clips' | 'packages')[] }[];
    offPeak?: { from: string; to: string; timeZone?: string } | null;
  };
  /** PROTECTION (build queue P3, PUBLISHING_POLICIES.md "What a policy
   *  contains"). `drm` is an encode-time field: it changes the files, so a
   *  change on published titles is confirmed with its count (P4 repackages).
   *  The rest apply at delivery. Each field resolves on its own, so a content
   *  type can lock DRM on and leave the WAF profile to the rungs below. */
  protection?: {
    drm?: boolean;
    /** Playback token lifetime in seconds; null: the platform default (services/edgeTokens.ts). */
    tokenLifetimeSec?: number | null;
    /** off; standard (VPN and proxy flagged); rights_managed (VPN, proxy, hosting and Tor blocked or challenged). */
    waf?: 'off' | 'standard' | 'rights_managed';
    /** Domains a player may be embedded on; empty: any. */
    referrers?: string[];
    /** Streams one viewer may play at once; null: no limit. */
    concurrentStreams?: number | null;
  };
  /** DISTRIBUTION (P3): what else may be done with a published title. */
  distribution?: {
    mp4Download?: boolean;
    shareLinks?: boolean;
    fastEligible?: boolean;
    /** Listed in the schema.org data and the sitemap. */
    sitemap?: boolean;
  };
  /** RETENTION (P3; the sweep is P5): how long a title is kept. */
  retention?: {
    keep?: 'forever' | 'days';
    days?: number | null;
    /** What the days count from. */
    anchor?: 'ingest' | 'available_from' | 'available_until';
    legalHoldAllowed?: boolean;
    /** Storage class an archived title moves to; null: stays where it is. */
    archiveTier?: 'infrequent' | 'glacier' | null;
  };
}
export type RuleKey = keyof RuleSettings;
export const RULE_KEYS: RuleKey[] = ['targets', 'autoPublish', 'availableFrom', 'expire', 'geo', 'access', 'paywall', 'gate', 'accessRules', 'archive', 'protection', 'distribution', 'retention'];

/** The sections whose fields resolve one by one rather than as a whole object. */
export const SECTION_KEYS = ['protection', 'distribution', 'retention'] as const;
export type SectionKey = typeof SECTION_KEYS[number];
export const SECTION_FIELDS: Record<SectionKey, string[]> = {
  protection: ['drm', 'tokenLifetimeSec', 'waf', 'referrers', 'concurrentStreams'],
  distribution: ['mp4Download', 'shareLinks', 'fastEligible', 'sitemap'],
  retention: ['keep', 'days', 'anchor', 'legalHoldAllowed', 'archiveTier'],
};
/** Every field a rung can lock: the plain keys and each section field ("protection.drm"). */
export const LOCKABLE_FIELDS: string[] = [
  ...RULE_KEYS.filter((k) => !(SECTION_KEYS as readonly string[]).includes(k)),
  ...SECTION_KEYS.flatMap((sec) => SECTION_FIELDS[sec].map((f) => `${sec}.${f}`)),
];
/** How the console groups the fields into the five sections of a policy. */
export const POLICY_SECTIONS: Record<'lifecycle' | 'access' | 'protection' | 'distribution' | 'retention', string[]> = {
  lifecycle: ['autoPublish', 'availableFrom', 'expire', 'gate'],
  access: ['accessRules', 'geo', 'access', 'paywall'],
  protection: SECTION_FIELDS.protection.map((f) => `protection.${f}`),
  distribution: ['targets', ...SECTION_FIELDS.distribution.map((f) => `distribution.${f}`), 'archive'],
  retention: SECTION_FIELDS.retention.map((f) => `retention.${f}`),
};

/** The platform baseline under the account rung: catalogue only, manual, worldwide, free. */
export const BASELINE: Required<Omit<RuleSettings, 'paywall'>> & { paywall: RuleSettings['paywall'] } = {
  targets: [{ kind: 'portal' }],
  autoPublish: false,
  availableFrom: { mode: 'publish' },
  expire: { mode: 'never' },
  geo: { mode: 'worldwide', countries: [] },
  access: 'free',
  paywall: null,
  gate: { requireReview: false, blockOnQcFail: false },
  accessRules: [],
  archive: { copies: [], offPeak: null },
  // Today's behaviour, stated: nothing protected, everything allowed, kept forever.
  protection: { drm: false, tokenLifetimeSec: null, waf: 'off', referrers: [], concurrentStreams: null },
  distribution: { mp4Download: true, shareLinks: true, fastEligible: true, sitemap: true },
  retention: { keep: 'forever', days: null, anchor: 'available_until', legalHoldAllowed: true, archiveTier: null },
};

export type Rung = 'baseline' | 'account' | 'schema' | 'owner' | 'asset';

export interface Resolved {
  settings: typeof BASELINE;
  /** Which rung each key came from (a section: the most specific rung that set any of its fields). */
  sources: Record<RuleKey, Rung>;
  /** Which rung each section field came from ("protection.drm" -> "schema"). */
  fieldSources: Record<string, Rung>;
  /** Fields locked by a rung, and which one: lower rungs cannot change them. */
  locks: Record<string, Rung>;
  /** What a lower rung said about a locked field and was not listened to. */
  ignored: { rung: Rung; field: string; lockedBy: Rung }[];
  /** The rule rows that took part, for the UI to show and link. */
  rungs: { rung: Rung; id: string | null; scopeId: string | null; settings: RuleSettings; lockedFields?: string[]; name?: string | null; presetKey?: string | null }[];
}

/** The rungs from least to most specific, so a lock is set before what it locks. */
export const RUNG_ORDER: Rung[] = ['baseline', 'account', 'schema', 'owner', 'asset'];

type LadderInput = { rung: Rung; id?: string | null; scopeId?: string | null; settings: RuleSettings | null | undefined; lockedFields?: string[] | null; name?: string | null; presetKey?: string | null };

/**
 * Pure: lay the rungs (lowest first) over the baseline, per field. A section
 * (protection, distribution, retention) is merged field by field, so a rung
 * that states only `protection.drm` leaves the WAF profile to the others. A
 * field a rung locks is final from that rung up: what a more specific rung
 * says about it is ignored and reported, never applied.
 */
export function resolveLadder(rungs: LadderInput[]): Resolved {
  const settings: any = { ...BASELINE };
  for (const sec of SECTION_KEYS) settings[sec] = { ...(BASELINE as any)[sec] };
  const sources = Object.fromEntries(RULE_KEYS.map((k) => [k, 'baseline'])) as Record<RuleKey, Rung>;
  const fieldSources: Record<string, Rung> = {};
  for (const sec of SECTION_KEYS) for (const f of SECTION_FIELDS[sec]) fieldSources[`${sec}.${f}`] = 'baseline';
  const locks: Record<string, Rung> = {};
  const ignored: Resolved['ignored'] = [];
  const used: Resolved['rungs'] = [];
  const locked = (field: string, rung: Rung) => {
    const by = locks[field] ?? (field.includes('.') ? locks[field.split('.')[0]] : undefined);
    if (by && by !== rung) { ignored.push({ rung, field, lockedBy: by }); return true; }
    return false;
  };
  for (const r of rungs) {
    const s: any = r.settings ?? {};
    used.push({ rung: r.rung, id: r.id ?? null, scopeId: r.scopeId ?? null, settings: s,
      ...(r.lockedFields?.length ? { lockedFields: r.lockedFields } : {}),
      ...(r.name !== undefined ? { name: r.name } : {}), ...(r.presetKey !== undefined ? { presetKey: r.presetKey } : {}) });
    for (const k of RULE_KEYS) {
      if ((SECTION_KEYS as readonly string[]).includes(k)) {
        const sec = s[k];
        if (!sec || typeof sec !== 'object') continue;
        for (const f of SECTION_FIELDS[k as SectionKey]) {
          if (!(f in sec) || sec[f] === undefined) continue;
          const field = `${k}.${f}`;
          if (locked(field, r.rung)) continue;
          settings[k][f] = sec[f];
          fieldSources[field] = r.rung;
          sources[k] = r.rung;
        }
        continue;
      }
      if (s[k] !== undefined && s[k] !== null || (k === 'paywall' && s.paywall === null && 'paywall' in s)) {
        if (locked(k, r.rung)) continue;
        settings[k] = s[k];
        sources[k] = r.rung;
      }
    }
    // Locks take effect for the rungs above this one. The asset rung is the
    // last, so a lock there would lock nothing: it is not offered.
    if (r.rung !== 'asset') for (const f of r.lockedFields ?? []) if (!locks[f]) locks[f] = r.rung;
  }
  return { settings, sources, fieldSources, locks, ignored, rungs: used };
}

/** Load the rungs that apply to an asset and resolve them. */
export async function resolveForAsset(accountId: string, asset: {
  id?: string; schema_id?: string | null; channel_id?: string | null; event_id?: string | null;
  availability_override?: RuleSettings | null;
}): Promise<Resolved> {
  const ownerId = asset.channel_id ?? asset.event_id ?? null;
  const rows = await query<any>(
    `SELECT id, scope_kind, scope_id, settings, locked_fields, name, preset_key FROM publishing_rules
      WHERE account_id = $1 AND (
        scope_kind = 'account'
        OR (scope_kind = 'schema' AND scope_id = $2::uuid)
        OR (scope_kind = 'owner'  AND scope_id = $3::uuid))`,
    [accountId, asset.schema_id ?? null, ownerId]);
  const pick = (kind: string) => rows.find((r) => r.scope_kind === kind);
  const acc = pick('account'), sch = pick('schema'), own = pick('owner');
  const meta = (r: any) => r ? { lockedFields: r.locked_fields ?? [], name: r.name ?? null, presetKey: r.preset_key ?? null } : {};
  return resolveLadder([
    { rung: 'account', id: acc?.id, scopeId: null, settings: acc?.settings, ...meta(acc) },
    { rung: 'schema', id: sch?.id, scopeId: asset.schema_id ?? null, settings: sch?.settings, ...meta(sch) },
    { rung: 'owner', id: own?.id, scopeId: ownerId, settings: own?.settings, ...meta(own) },
    { rung: 'asset', id: asset.id ?? null, scopeId: asset.id ?? null, settings: asset.availability_override ?? {} },
  ]);
}

/**
 * Every target in a rule must be one of the client's own publishing points.
 * Returns the cleaned list, or throws with the first offender.
 */
export async function validateTargets(accountId: string, targets: Target[] | undefined): Promise<Target[] | undefined> {
  if (!targets) return undefined;
  const out: Target[] = [];
  for (const t of targets) {
    if (t.kind === 'portal') { out.push({ kind: 'portal' }); continue; }
    if (t.kind === 'app') {
      const app = await one<any>(`SELECT id FROM apps WHERE id = $1 AND account_id = $2`, [t.appId, accountId]);
      if (!app) throw new Error(`app ${t.appId} is not registered to this account`);
      out.push({ kind: 'app', appId: t.appId }); continue;
    }
    if (t.kind === 'social') {
      const tg = await one<any>(`SELECT id, platform FROM publish_targets WHERE id = $1 AND account_id = $2`, [t.targetId, accountId]);
      if (!tg) throw new Error(`social account ${t.targetId} is not configured for this account`);
      // X is off unless switched on or the account has its own X app (build queue 1.14h).
      if (tg.platform === 'x') { const { xAccess, X_OFF } = await import('./social'); if (!(await xAccess(accountId)).allowed) throw new Error(X_OFF); }
      out.push({ kind: 'social', targetId: t.targetId, platform: tg.platform }); continue;
    }
    throw new Error(`unknown target kind ${(t as any).kind}`);
  }
  return out;
}

/** The window a resolved plan gives an asset published now. */
export function windowFor(s: typeof BASELINE, now = new Date()): { from: Date; until: Date | null } {
  const from = s.availableFrom.mode === 'at' ? new Date(s.availableFrom.at) : now;
  let until: Date | null = null;
  if (s.expire.mode === 'days') until = new Date(from.getTime() + s.expire.days * 86_400_000);
  else if (s.expire.mode === 'at') until = new Date(s.expire.at);
  return { from, until };
}

/** The publishing points a client can choose from: its apps and its social accounts. */
export async function publishingPoints(accountId: string) {
  const apps = await query<any>(`SELECT id, name, type, enabled FROM apps WHERE account_id = $1 ORDER BY name`, [accountId]);
  const social = await query<any>(`SELECT id, platform, name, external_account, enabled FROM publish_targets WHERE account_id = $1 ORDER BY platform, name`, [accountId]);
  // Linked X accounts stay listed while X is off, as off, so a rule naming one can be seen and changed.
  const xOn = social.some((s) => s.platform === 'x') ? (await (await import('./social')).xAccess(accountId)).allowed : true;
  return {
    portal: { kind: 'portal', name: 'Catalogue (portal)' },
    apps: apps.map((a) => ({ kind: 'app', appId: a.id, name: a.name, type: a.type, enabled: a.enabled })),
    social: social.map((s) => {
      const off = s.platform === 'x' && !xOn;
      return { kind: 'social', targetId: s.id, platform: s.platform, name: s.name, account: s.external_account, enabled: s.enabled && !off, ...(off ? { off: true } : {}) };
    }),
  };
}
