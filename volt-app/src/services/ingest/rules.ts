// ============================================================================
//  INGEST RULES — the ladder that decides what happens to an arriving file.
//
//    account default  <  content / media type  <  source or folder  <  item
//
//  Same shape as publishingRules: each rung is a partial, an absent key
//  inherits, and the result remembers which rung supplied each value so the
//  panel can say "GUID naming because of the Sports drop rule".
//
//  Within a rung there can be several rules, each with a WHEN. They are tried
//  in ordinal order and the FIRST MATCH WINS, exactly as the watchfolder rules
//  do today (those become source-rung rules). A rule with no WHEN always
//  matches and is the rung's default.
//
//  WHEN is evaluated on what is known at the time. At pick time that is name,
//  size and relative path; after transfer it is also real type, duration and
//  resolution. resolve() is therefore called twice for a browser upload and
//  may answer differently the second time (a rule on duration cannot match at
//  pick time). The caller records both and the later answer is the one that
//  ingests.
// ============================================================================
import { globToRegExp } from '../watchfolder/rules';
import type { NamingMode, StructureMode } from './naming';

export type Rung = 'baseline' | 'account' | 'type' | 'source' | 'item';
export const RUNGS: Rung[] = ['baseline', 'account', 'type', 'source', 'item'];

export type DuplicateAction = 'skip' | 'replace' | 'version' | 'rename' | 'ask';
export type TransferMode = 'auto' | 'local' | 'cloud';
export type MetadataRequired = 'none' | 'before_ingest' | 'before_upload';
export type MediaKind = 'video' | 'audio' | 'image' | 'other';

export interface IngestSettings {
  /** metadata_schemas id the asset is created with. */
  contentTypeId?: string | null;
  /** What the library row becomes: vod | filler:slate | filler:loop | file:<kind>. */
  targetKind?: string | null;
  naming?: NamingMode;
  structure?: StructureMode;
  nameTemplate?: string | null;
  pathTemplate?: string | null;
  lowercase?: boolean;
  duplicate?: DuplicateAction;
  /** Check names against the library before any byte moves. */
  nameCheck?: boolean;
  transfer?: TransferMode;
  metadataRequired?: MetadataRequired;
  autoUpload?: boolean;
  sidecar?: 'none' | 'json' | 'xml';
  /** notification / webhook target ids to POST the ingest payload to. */
  webhooks?: string[];
  /** Encode ladder group to queue after ingest; null = account default. */
  ladderGroupId?: string | null;
  /** Reject the file with this reason instead of ingesting. */
  reject?: string | null;
  /**
   * Read the file name for metadata (services/ingest/filenameApply.ts): 'auto'
   * applies what is confident, 'suggest' only records the reading for a person,
   * 'off' leaves the name alone.
   */
  filenameMetadata?: 'auto' | 'suggest' | 'off';
}
export type IngestKey = keyof IngestSettings;
export const INGEST_KEYS: IngestKey[] = [
  'contentTypeId', 'targetKind', 'naming', 'structure', 'nameTemplate', 'pathTemplate', 'lowercase',
  'duplicate', 'nameCheck', 'transfer', 'metadataRequired', 'autoUpload', 'sidecar', 'webhooks',
  'ladderGroupId', 'reject', 'filenameMetadata',
];

/** The platform baseline. Decisions of 17 Sep: guid, flat, ask, auto, acceleration on. */
export const BASELINE: Required<IngestSettings> = {
  contentTypeId: null, targetKind: 'vod',
  naming: 'guid', structure: 'flat', nameTemplate: null, pathTemplate: null, lowercase: false,
  duplicate: 'ask', nameCheck: true, transfer: 'auto',
  metadataRequired: 'before_ingest', autoUpload: true,
  sidecar: 'json', webhooks: [], ladderGroupId: null, reject: null, filenameMetadata: 'auto',
};

/** What a rule can test. All present conditions must hold. */
export interface When {
  extensions?: string[];              // without dots, case-insensitive
  kinds?: MediaKind[];
  mimePrefixes?: string[];            // 'video/', 'audio/mpeg'
  namePattern?: { type: 'glob' | 'regex'; pattern: string };
  pathPrefix?: string;                // relative path from the drop, forward slashes
  minBytes?: number; maxBytes?: number;
  minDurationSec?: number; maxDurationSec?: number;
  minHeight?: number;                 // 1080 means "1080p or larger"
  hasTags?: boolean;                  // ID3 / container tags present
}

export interface IngestRule {
  id: string;
  rung: Exclude<Rung, 'baseline'>;
  /** type: metadata_schemas id; source: watchfolder id, 'panel', 'api', provider key. */
  scopeId?: string | null;
  ordinal: number;
  name: string;
  enabled?: boolean;
  when?: When | null;
  then: IngestSettings;
}

/** What is known about the file when resolve() runs. */
export interface FileFacts {
  name: string;
  relativePath?: string | null;
  bytes?: number | null;
  mime?: string | null;          // real type once sniffed, declared type before
  kind?: MediaKind | null;
  durationSec?: number | null;
  height?: number | null;
  hasTags?: boolean | null;
}

export function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

/** Does a WHEN hold for these facts? Unknown facts fail the conditions that need them. */
export function matches(when: When | null | undefined, f: FileFacts): boolean {
  if (!when) return true;
  if (when.extensions && !when.extensions.map((e) => e.toLowerCase().replace(/^\./, '')).includes(extOf(f.name))) return false;
  if (when.kinds && (!f.kind || !when.kinds.includes(f.kind))) return false;
  if (when.mimePrefixes && (!f.mime || !when.mimePrefixes.some((p) => f.mime!.toLowerCase().startsWith(p.toLowerCase())))) return false;
  if (when.namePattern) {
    const rx = when.namePattern.type === 'glob' ? globToRegExp(when.namePattern.pattern) : new RegExp(when.namePattern.pattern, 'i');
    if (!rx.test(f.name)) return false;
  }
  if (when.pathPrefix !== undefined) {
    const p = (f.relativePath ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    const want = when.pathPrefix.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (want && !(p === want || p.startsWith(want + '/'))) return false;
  }
  if (when.minBytes != null && !(f.bytes != null && f.bytes >= when.minBytes)) return false;
  if (when.maxBytes != null && !(f.bytes != null && f.bytes <= when.maxBytes)) return false;
  if (when.minDurationSec != null && !(f.durationSec != null && f.durationSec >= when.minDurationSec)) return false;
  if (when.maxDurationSec != null && !(f.durationSec != null && f.durationSec <= when.maxDurationSec)) return false;
  if (when.minHeight != null && !(f.height != null && f.height >= when.minHeight)) return false;
  if (when.hasTags != null && (f.hasTags == null || f.hasTags !== when.hasTags)) return false;
  return true;
}

export interface Resolved {
  settings: Required<IngestSettings>;
  sources: Record<IngestKey, Rung>;
  /** The rule that won on each rung, lowest first. */
  matched: { rung: Rung; ruleId: string; ruleName: string }[];
  /** Facts that were needed by some rule but unknown, so a later pass may differ. */
  deferred: boolean;
}

function needsLateFacts(when: When | null | undefined, f: FileFacts): boolean {
  if (!when) return false;
  return (
    ((when.minDurationSec != null || when.maxDurationSec != null) && f.durationSec == null) ||
    (when.minHeight != null && f.height == null) ||
    (when.hasTags != null && f.hasTags == null) ||
    (when.mimePrefixes != null && f.mime == null) ||
    (when.kinds != null && f.kind == null)
  );
}

/**
 * Pure. Lay the rungs over the baseline. `rules` may be in any order; within
 * each rung ordinal decides. The item rung is a single partial supplied by the
 * caller (an operator override) and has no WHEN.
 */
export function resolveIngest(rules: IngestRule[], facts: FileFacts, item?: IngestSettings | null): Resolved {
  const settings: any = { ...BASELINE };
  const sources = Object.fromEntries(INGEST_KEYS.map((k) => [k, 'baseline'])) as Record<IngestKey, Rung>;
  const matched: Resolved['matched'] = [];
  let deferred = false;

  const apply = (rung: Rung, s: IngestSettings) => {
    for (const k of INGEST_KEYS) {
      if (s[k] !== undefined) { settings[k] = s[k]; sources[k] = rung; }
    }
  };

  for (const rung of ['account', 'type', 'source'] as const) {
    const cands = rules
      .filter((r) => r.rung === rung && r.enabled !== false)
      .sort((a, b) => a.ordinal - b.ordinal);
    for (const r of cands) {
      if (needsLateFacts(r.when, facts)) deferred = true;
      if (matches(r.when, facts)) {
        apply(rung, r.then);
        matched.push({ rung, ruleId: r.id, ruleName: r.name });
        break;
      }
    }
  }
  if (item) { apply('item', item); matched.push({ rung: 'item', ruleId: 'item', ruleName: 'operator override' }); }
  return { settings, sources, matched, deferred };
}

/** Kind from a real or declared mime, falling back to the extension. */
export function kindOf(mime: string | null | undefined, name: string): MediaKind {
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('image/')) return 'image';
  const e = extOf(name);
  if (['mp4', 'mov', 'mxf', 'mkv', 'ts', 'm2ts', 'avi', 'webm', 'mpg', 'mpeg', 'm4v'].includes(e)) return 'video';
  if (['mp3', 'aac', 'm4a', 'wav', 'flac', 'ogg', 'opus', 'aif', 'aiff', 'wma'].includes(e)) return 'audio';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'tif', 'tiff', 'bmp', 'svg', 'heic'].includes(e)) return 'image';
  return 'other';
}
