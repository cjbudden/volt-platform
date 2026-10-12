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
}

export interface LaneDef { id: string; label: string; description: string }

export const LANES: LaneDef[] = [
  { id: 'live', label: 'Live', description: 'A channel or event from source to viewer, recorded as it runs.' },
  { id: 'post', label: 'Post-production', description: 'What happens to recorded and uploaded media before it is published.' },
  { id: 'file', label: 'File ingest', description: 'Uploaded and watch-folder files on their way into the library.' },
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
];

/** Arrows between stages, including where one lane feeds another. */
export const EDGES: Array<[string, string]> = [
  ['source', 'encode'], ['encode', 'package'], ['package', 'deliver'], ['package', 'record'],
  ['record', 'thumbs'], ['record', 'clip'], ['clip', 'qc'], ['qc', 'review'], ['review', 'publish'],
  ['upload', 'rules'], ['rules', 'vodenc'], ['vodenc', 'qc'],
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

/** Subject types that can be sent to an add-on by hand. */
export const MANUAL_SUBJECTS: SubjectType[] = ['recording', 'vod_asset'];
