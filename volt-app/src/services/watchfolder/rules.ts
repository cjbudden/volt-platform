// ============================================================================
//  WATCHFOLDER RULES — WHAT IS THIS FILE, AND WHAT IF WE CANNOT TELL?
//
//  The second half of that question is the one that shapes the design. A drop
//  folder receives slates, loops, posters and finished VOD named by whatever
//  convention the edit suite uses, and every week it also receives something
//  that is none of them. There are three things you can do with that file and
//  two of them are wrong:
//
//    INGEST IT ANYWAY, as `other`. The library fills with junk nobody can
//    identify later, and the operator who could have said what it was has long
//    since moved on.
//    DELETE IT. That destroys the only copy of a file whose crime was being
//    named unexpectedly, and it is found out days later.
//    REFUSE IT, move it to a review folder, and record WHY. A person then
//    corrects the rule, reclassifies the item, or removes it deliberately.
//
//  Only the third is reversible, so it is the only one this returns.
//
//  FIRST MATCH WINS, AND THE ORDER IS THE RULE SET. `*.png -> poster` and
//  `slate_*.png -> slate` both match `slate_open.png`. Without a defined order
//  that is a coin toss decided by however the rows came back from the database,
//  and it changes when somebody adds an index. Ordinal, ascending, first match.
//
//  A RULE MAY ALSO REFUSE. "Project files are never wanted here" as an explicit
//  rule with its own reason beats letting `.prproj` fall to the bottom and be
//  reported as "no rule matched", which tells the operator nothing about whether
//  the rule set is wrong or the drop was.
//
//  THE HYGIENE CHECKS RUN FIRST and are not rules, because they are not about
//  what the file IS. A `.DS_Store`, a `~$` lock file or a `.part` still being
//  copied are artefacts of the filesystem, and a half-copied upload classified
//  and ingested is a corrupt asset in the library with a plausible name.
// ============================================================================

export type MatchType = 'glob' | 'regex' | 'extension' | 'prefix' | 'suffix';

export interface WatchRule {
  id: string;
  ordinal: number;
  name: string;
  matchType: MatchType;
  pattern: string;
  targetKind: string;
  workflow?: string | null;
  action?: 'accept' | 'reject';
  rejectReason?: string | null;
  enabled?: boolean;
}

export interface FolderPolicy {
  /** What an unmatched file becomes. NULL means quarantine it instead. */
  defaultTargetKind?: string | null;
  defaultWorkflow?: string | null;
  /** Bytes. A file outside these is refused rather than ingested. */
  minBytes?: number | null;
  maxBytes?: number | null;
}

export interface Accepted {
  decision: 'accept';
  targetKind: string;
  workflow: string | null;
  ruleId: string | null;
  ruleName: string;
}
export interface Quarantined {
  decision: 'quarantine';
  /** Stored verbatim on the item. See the migration on why it is not recomputed. */
  reason: string;
  ruleId: string | null;
}
export type Classification = Accepted | Quarantined;

/* ---------------------------------------------------------------------------
 *  HYGIENE — filesystem artefacts, not content.
 * ------------------------------------------------------------------------ */

/** Files that are never content, whatever the rules say. */
const JUNK = [
  /^\.DS_Store$/i,
  /^Thumbs\.db$/i,
  /^desktop\.ini$/i,
  /^\._/,                 // macOS AppleDouble sidecar
  /^~\$/,                 // Office lock file
];

/** Extensions that mean "still being written". */
const IN_FLIGHT = /\.(part|partial|crdownload|tmp|temp|filepart|download)$/i;

export function hygiene(name: string, sizeBytes: number | null | undefined): string | null {
  const base = name.split('/').pop() ?? name;
  if (!base) return 'the object has no filename';
  // A LEADING DOT IS NOT AUTOMATICALLY JUNK — plenty of legitimate files start
  // with one — but the named artefacts are, and so is anything still in flight.
  if (JUNK.some((re) => re.test(base))) return `${base} is a filesystem artefact, not content`;
  if (IN_FLIGHT.test(base)) return `${base} looks like a partial upload still being written`;
  // ZERO BYTES IS THE QUIET ONE. A copy that failed leaves a correctly-named
  // empty file, and classified by name alone it becomes a valid-looking asset
  // that plays as nothing.
  if (sizeBytes === 0) return `${base} is zero bytes, so the copy did not finish`;
  return null;
}

/* ---------------------------------------------------------------------------
 *  MATCHING
 * ------------------------------------------------------------------------ */

/** A glob with `*` and `?`, anchored, case-insensitive. Nothing more exotic. */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

export function matches(rule: WatchRule, name: string): boolean {
  const base = (name.split('/').pop() ?? name);
  const p = rule.pattern ?? '';
  try {
    switch (rule.matchType) {
      case 'glob': return globToRegExp(p).test(base);
      // A BAD REGEX MUST NOT TAKE THE SCAN DOWN. An operator typing one into a
      // form is the normal case, and an unclosed bracket there should refuse
      // that rule, not stop every folder on the account from being scanned.
      case 'regex': return new RegExp(p, 'i').test(base);
      case 'extension': return base.toLowerCase().endsWith(
        (p.startsWith('.') ? p : '.' + p).toLowerCase());
      case 'prefix': return base.toLowerCase().startsWith(p.toLowerCase());
      case 'suffix': return base.toLowerCase().endsWith(p.toLowerCase());
      default: return false;
    }
  } catch { return false; }
}

/* ---------------------------------------------------------------------------
 *  THE DECISION
 * ------------------------------------------------------------------------ */

/**
 * Classify one arriving object.
 *
 * Pure, and returns a decision rather than performing one, so the same function
 * answers "what would happen to this file" for the dry-run screen and "what
 * happens to this file" for the scanner. An operator who can try a filename
 * against the rules before any file moves is an operator who finds the rule set
 * is wrong at the desk rather than in the review folder.
 */
export function classify(
  name: string,
  sizeBytes: number | null | undefined,
  rules: WatchRule[],
  policy: FolderPolicy = {}
): Classification {
  const dirty = hygiene(name, sizeBytes);
  if (dirty) return { decision: 'quarantine', reason: dirty, ruleId: null };

  // Size before rules: a file of the wrong size is refused whatever it claims
  // to be, and reporting "no rule matched" for a 4GB drop into an image folder
  // would send the operator to edit rules that are perfectly correct.
  if (policy.minBytes != null && sizeBytes != null && sizeBytes < policy.minBytes) {
    return { decision: 'quarantine', reason: `${sizeBytes} bytes is below the folder's minimum of ${policy.minBytes}`, ruleId: null };
  }
  if (policy.maxBytes != null && sizeBytes != null && sizeBytes > policy.maxBytes) {
    return { decision: 'quarantine', reason: `${sizeBytes} bytes is above the folder's maximum of ${policy.maxBytes}`, ruleId: null };
  }

  const ordered = rules
    .filter((r) => r.enabled !== false)
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal);

  for (const r of ordered) {
    if (!matches(r, name)) continue;
    if (r.action === 'reject') {
      return {
        decision: 'quarantine',
        reason: r.rejectReason?.trim() || `refused by rule "${r.name}"`,
        ruleId: r.id,
      };
    }
    return {
      decision: 'accept',
      targetKind: r.targetKind,
      workflow: r.workflow ?? null,
      ruleId: r.id,
      ruleName: r.name,
    };
  }

  // NOTHING MATCHED. A folder may declare a fallback; the absence of one is a
  // deliberate choice to review rather than guess, which is why the column is
  // nullable and defaults to null.
  if (policy.defaultTargetKind) {
    return {
      decision: 'accept',
      targetKind: policy.defaultTargetKind,
      workflow: policy.defaultWorkflow ?? null,
      ruleId: null,
      ruleName: 'folder default',
    };
  }
  return {
    decision: 'quarantine',
    reason: 'no rule matched and this folder has no default, so it needs a person to look at it',
    ruleId: null,
  };
}

/**
 * Where a refused file is moved to.
 *
 * NAME PRESERVED, PATH FLATTENED under the review folder, and a collision gets a
 * suffix rather than overwriting: two rejected files called `output.mov` from
 * different subfolders must both survive, or the review queue quietly loses one
 * and the operator reviews a file that is not the one the row describes.
 */
export function quarantineKey(quarantinePath: string, objectKey: string, existing: Set<string> = new Set()): string {
  const base = objectKey.split('/').pop() || 'file';
  const root = (quarantinePath || '_review').replace(/^\/+|\/+$/g, '');
  let candidate = `${root}/${base}`;
  if (!existing.has(candidate)) return candidate;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  for (let n = 2; n < 1000; n++) {
    candidate = `${root}/${stem}-${n}${ext}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${root}/${stem}-${Date.now()}${ext}`;
}
