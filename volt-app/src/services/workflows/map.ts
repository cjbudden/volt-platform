// ============================================================================
//  THE BASE WORKFLOW, as data.
//
//  What Volt does to media, stage by stage, and the HOOKS each stage fires.
//  The dashboard draws this; the hook bus only accepts hooks declared here;
//  and an add-on author reads it to know where they can attach. One
//  definition, so the picture and the behaviour cannot disagree.
//
//  `live: true` on a hook means the code fires it today. `false` means the
//  attachment point is designed and shown, but nothing emits it yet: the
//  dashboard says "planned" rather than offering a trigger that never fires.
// ============================================================================

import type { Licence } from '../sites/licences';

export type SubjectType = 'channel' | 'event' | 'recording' | 'vod_asset';

export interface HookDef {
  id: string;
  label: string;
  stage: string;
  subject: SubjectType;
  live: boolean;
  description: string;
}

export interface StageDef {
  id: string;
  label: string;
  lane: string;
  col: number;
  description: string;
  /** Module(s) that implement it, for the reader who wants the code. */
  impl: string;
  /**
   * The licensed add-on the stage belongs to (services/sites/licences.ts).
   * An add-on that is not licensed is not there, so an account without it
   * does not see the stage on the map or in the report (`mapFor`).
   */
  licence?: Licence;
}

export interface LaneDef { id: string; label: string; description: string }

export const LANES: LaneDef[] = [
  { id: 'live', label: 'Live', description: 'A channel or event from source to viewer, recorded as it runs.' },
  { id: 'post', label: 'Post-production', description: 'What happens to recorded and uploaded media before it is published.' },
  { id: 'file', label: 'File ingest', description: 'Uploaded and watch-folder files on their way into the library.' },
  { id: 'site', label: 'Your sites', description: 'Work done by the Volt agent on your own servers: encoding at the site, and copies to your own storage.' },
];

export const STAGES: StageDef[] = [
  { id: 'source',   lane: 'live', col: 0, label: 'Source',          impl: 'source_selector.py, sourceReadiness.ts', description: 'Primary and backup inputs arrive over SRT, RTMP or HLS and are health checked.' },
  { id: 'encode',   lane: 'live', col: 1, label: 'Encode',          impl: 'encoder.py, services/engines', description: 'The ladder is encoded by the stream\'s engine: Volt built-in, or a vendor engine in encode only or full mode.' },
  { id: 'package',  lane: 'live', col: 2, label: 'Package',         impl: 'encoder.py (Shaka), playout.py', description: 'CMAF segments, HLS and DASH, DRM, captions, and seamless filler on input loss.' },
  { id: 'deliver',  lane: 'live', col: 3, label: 'Deliver',         impl: 'liveOrigin.ts, rights.ts', description: 'Origin and CDN, with geo and rights decided at the edge behind one stable play URL.' },
  { id: 'record',   lane: 'live', col: 4, label: 'Record',          impl: 'orchestrator/service.ts', description: 'Segments land as the recording; when the run or day closes the recording is finalised.' },

  { id: 'thumbs',   lane: 'post', col: 5, label: 'Thumbnails',      impl: 'thumbnailer.py', description: 'Poster and sprite grid for recordings and assets.' },
  { id: 'clip',     lane: 'post', col: 6, label: 'Clip',            impl: 'clips.ts, jobs/handlers/clipExtract.ts', description: 'Clips and full-event VODs cut from recordings by manifest range or remux.' },
  { id: 'qc',       lane: 'post', col: 7, label: 'QC',              impl: 'qc.ts, jobs/handlers/qcRun.ts', description: 'Automatic checks on every clip and encoded asset.' },
  { id: 'review',   lane: 'post', col: 8, label: 'Review',          impl: 'review.ts', description: 'A person approves, rejects or sends back for changes.' },
  { id: 'publish',  lane: 'post', col: 9, label: 'Publish',         impl: 'publishing.ts, publishingRules.ts, social', description: 'Availability rules, apps, partners and social destinations.' },

  { id: 'upload',   lane: 'file', col: 0, label: 'Upload',          impl: 'uploads.ts, tus.ts, watchfolder', description: 'Files arrive by upload, cloud picker or watch folder.' },
  { id: 'rules',    lane: 'file', col: 1, label: 'Ingest rules',    impl: 'ingest/rules.ts', description: 'Naming, content type, duplicates and metadata rules decide what the file becomes.' },
  { id: 'vodenc',   lane: 'file', col: 2, label: 'Encode',          impl: 'jobs/handlers/vodEncode.ts', description: 'The file is encoded to the account ladder and packaged.' },

  // HYBRID SITES (build queue H5-2). Jobs in a site's pool, leased by the
  // agent on the customer's servers (services/sites/siteJobs.ts). Encode at
  // site sits under the cloud encode it replaces. The copies sit past Publish
  // with one arrow from it: a copy rule also fires on ingest and on a
  // schedule, and recordings are copied as they close, but arrows from
  // Ingest rules and Record would cross the whole map; its description says
  // so instead.
  { id: 'siteenc',  lane: 'site', col: 2, label: 'Encode at site',  impl: 'sites/siteEncode.ts, volt-agent/src/siteEncode.ts', licence: 'hybrid_sites', description: 'A file kept at your site is probed and encoded there by the Volt agent, and the package is checked in the cloud before it can play.' },
  { id: 'archive',  lane: 'site', col: 10, label: 'Archive copies', impl: 'archive/archive.ts, archive/recordings.ts, volt-agent/src/siteArchive.ts', licence: 'mirror_archive', description: 'Originals, sidecars, clips, packages and recordings are copied to your own storage when a file is ingested or published, on a schedule, and as recordings close. Each copy is read back to check it.' },
];

/** Arrows between stages, including where one lane feeds another. */
export const EDGES: Array<[string, string]> = [
  ['source', 'encode'], ['encode', 'package'], ['package', 'deliver'], ['package', 'record'],
  ['record', 'thumbs'], ['record', 'clip'], ['clip', 'qc'], ['qc', 'review'], ['review', 'publish'],
  ['upload', 'rules'], ['rules', 'vodenc'], ['vodenc', 'qc'],
  ['rules', 'siteenc'], ['siteenc', 'qc'],
  ['publish', 'archive'],
];

export const HOOKS: HookDef[] = [
  { id: 'stream.started',      stage: 'encode',  subject: 'channel',   live: true,  label: 'Stream started',      description: 'A channel or event went live: the encoder (or vendor engine) was launched and the run recorded.' },
  { id: 'stream.stopped',      stage: 'encode',  subject: 'channel',   live: true,  label: 'Stream stopped',      description: 'A run ended, by an operator, the schedule, or a fault. detail.intent says which.' },
  { id: 'recording.completed', stage: 'record',  subject: 'recording', live: true,  label: 'Recording completed', description: 'A recording closed (end of an event, a channel stop, or the UTC day roll). The typical place to send media to an AI agent.' },
  { id: 'clip.ready',          stage: 'clip',    subject: 'vod_asset', live: true,  label: 'Clip ready',          description: 'A clip or full-event VOD finished extracting and is playable.' },
  { id: 'qc.completed',        stage: 'qc',      subject: 'vod_asset', live: true,  label: 'QC completed',        description: 'Automatic QC finished. detail.state is passed, warnings or failed.' },
  { id: 'review.decided',      stage: 'review',  subject: 'vod_asset', live: true,  label: 'Review decided',      description: 'A reviewer approved, rejected or requested changes. detail.to is the new state.' },
  { id: 'publication.published', stage: 'publish', subject: 'vod_asset', live: false, label: 'Published',         description: 'An asset became available on a destination. Planned.' },
  { id: 'upload.received',     stage: 'upload',  subject: 'vod_asset', live: false, label: 'Upload received',     description: 'A file finished uploading, before ingest rules. Planned.' },
  { id: 'vod.encoded',         stage: 'vodenc',  subject: 'vod_asset', live: true,  label: 'VOD encoded',         description: 'An uploaded file finished encoding and packaging.' },
];

export const HOOK_IDS = new Set(HOOKS.map((h) => h.id));

/**
 * Which stage each job type is the work of, for the workflow report
 * (services/workflows/rollup.ts). A job type not listed here still counts,
 * under "other jobs" by its type, so a new handler shows up in the report
 * before anyone decides where it belongs. `addon.dispatch` is left out on
 * purpose: add-on runs are reported from addon_runs, and counting their
 * delivery jobs as well would count each run twice.
 */
export const JOB_STAGES: Record<string, string> = {
  'ingest.remote': 'upload',
  'vod.encode': 'vodenc',
  'vod.ladder': 'vodenc',
  'vod.image': 'thumbs',
  'filler.thumbs': 'thumbs',
  'clip.extract': 'clip',
  'qc.run': 'qc',
  'social.publish': 'publish',
  // Hybrid sites (H5-2). Before this they were listed under other jobs, and
  // copies not at all: their jobs name the copy, not the asset (rollup.ts).
  'site.vod-probe': 'siteenc',
  'site.vod-encode': 'siteenc',
  'archive.copy': 'archive',
  'archive.copy-folder': 'archive',
  'archive.verify': 'archive',
  'archive.verify-folder': 'archive',
  'archive.restore': 'archive',
  'archive.recording': 'archive',
};
/** Job types the report never counts (see JOB_STAGES). */
export const REPORT_SKIPS_JOBS = new Set(['addon.dispatch']);

/**
 * The map as one account sees it: stages of an add-on it is not licensed for
 * are left out, with their arrows, and a lane with no stage left goes too.
 * The base workflow has no licence, so an account with no add-on sees the
 * three lanes it always did.
 */
export function mapFor(licences: readonly string[]): { lanes: LaneDef[]; stages: StageDef[]; edges: Array<[string, string]> } {
  const stages = STAGES.filter((s) => !s.licence || licences.includes(s.licence));
  const ids = new Set(stages.map((s) => s.id));
  return {
    lanes: LANES.filter((l) => stages.some((s) => s.lane === l.id)),
    stages,
    edges: EDGES.filter(([a, b]) => ids.has(a) && ids.has(b)),
  };
}

/** Subject types that can be sent to an add-on by hand. */
export const MANUAL_SUBJECTS: SubjectType[] = ['recording', 'vod_asset'];
