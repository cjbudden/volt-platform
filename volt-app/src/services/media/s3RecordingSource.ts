// ============================================================================
//  A RECORDING'S MEDIA IN THE BUCKET, AS ONE PLAYLIST (build queue 2.3c).
//
//  On AWS an encoder run uploads under s3://<bucket>/<kind>/<id>/runs/<runId>/
//  (2.2), but a recording row still names the old layout in `master_key`
//  (`channel/<id>/<day>` or `event/<id>`), which nothing writes. So the CPU
//  thumbnailer, launched when a recording closes, was pointed at
//  s3://<bucket>/channel/<id>/<day>/<rendition>/index.m3u8: a key that never
//  exists, so every recording on AWS ended without a poster, storyboard or
//  scrub-bar thumbnails, after paying for a task start.
//
//  This builds what the Mac's local launcher builds from the disk
//  (localLauncher.ts writeVodPlaylist): a VOD playlist over the recording's
//  segments, for the bucket. A recording can span several runs (a channel's
//  day row is reopened by every restart that day), so it takes every run that
//  started inside the recording's window, in order, with a discontinuity
//  between runs and each run's own init segment.
//
//  The segment addresses are s3:// URIs, not signed links: the control plane's
//  task credentials can expire before a long storyboard pass reaches the end
//  of the list, so the thumbnailer signs them itself when it starts
//  (thumbnailer.py presign_playlist), with its own fresh credentials.
//
//  The segments are LISTED, not read from the run's own rendition playlist:
//  that playlist is the live one, and it only holds the DVR window, not the
//  whole run. Listing costs one call per thousand keys, once per recording.
// ============================================================================
import { config } from '../../config';
import { listAll, listLevel, runsApi, runStartMs, streamRootUri } from './s3Runs';
import { parseS3Uri } from './s3Driver';

const SEGMENT = /^seg_(\d+)\.(m4s|ts|aac|m4a|mp4)$/;
const RUN_ID = /^[A-Za-z0-9._-]+$/;
/** A run id is the encoder's own clock at start; the row is written by the control plane's. */
const CLOCK_SLACK_MS = 60_000;

export interface RecordingLike {
  id: string;
  channel_id?: string | null;
  event_id?: string | null;
  hi_res_rendition?: string | null;
  start_epoch_ms: number | string;
  end_epoch_ms?: number | string | null;
}

export interface RecordingSource {
  text: string;
  runs: string[];
  segments: number;
}

/**
 * The VOD playlist over the recording's runs in the bucket, or null when no run
 * in its window has any segment of its rendition.
 */
export async function buildRecordingSource(rec: RecordingLike, opts: {
  segmentSeconds?: number; now?: number;
  /** Another rendition than the recording's top one (the full-recording title takes `audio` too, 2.3c-4). */
  rendition?: string;
  /** How a segment is addressed; s3:// by default (the thumbnailer signs them itself). */
  segmentUri?: (bucket: string, key: string) => string;
} = {}): Promise<RecordingSource | null> {
  const streamId = rec.channel_id ?? rec.event_id;
  const rendition = opts.rendition ?? rec.hi_res_rendition;
  if (!streamId || !rendition || !RUN_ID.test(rendition)) return null;
  const kind: 'channel' | 'event' = rec.channel_id ? 'channel' : 'event';
  const root = parseS3Uri(streamRootUri(kind, streamId))!;
  const api = await runsApi();
  const from = Number(rec.start_epoch_ms) - CLOCK_SLACK_MS;
  const to = rec.end_epoch_ms != null ? Number(rec.end_epoch_ms) : (opts.now ?? Date.now());

  const level = await listLevel(api, root.bucket, `${root.key}runs/`);
  const runs = level.folders
    .map((p) => p.slice(`${root.key}runs/`.length).replace(/\/$/, ''))
    .filter((r) => RUN_ID.test(r))
    .map((r) => ({ id: r, at: runStartMs(r) }))
    // A run id the encoder did not write (no time in it) cannot be placed.
    .filter((r): r is { id: string; at: number } => r.at != null && r.at >= from && r.at <= to)
    .sort((a, b) => a.at - b.at);

  const seg = opts.segmentSeconds ?? 4;
  const body: string[] = [];
  const used: string[] = [];
  let segments = 0;
  for (const run of runs) {
    const prefix = `${root.key}runs/${run.id}/${rendition}/`;
    const keys = (await listAll(api, root.bucket, prefix)).map((o) => o.key.slice(prefix.length));
    const segs = keys.filter((k) => SEGMENT.test(k))
      .sort((a, b) => Number(SEGMENT.exec(a)![1]) - Number(SEGMENT.exec(b)![1]));
    if (!segs.length) continue;
    if (used.length) body.push('#EXT-X-DISCONTINUITY');
    // Each run has its own init segment: a restart may change the encode.
    const uri = opts.segmentUri ?? ((b: string, k: string) => `s3://${b}/${k}`);
    if (keys.includes('init.mp4')) body.push(`#EXT-X-MAP:URI="${uri(root.bucket, `${prefix}init.mp4`)}"`);
    for (const s of segs) body.push(`#EXTINF:${seg.toFixed(3)},`, uri(root.bucket, `${prefix}${s}`));
    used.push(run.id);
    segments += segs.length;
  }
  if (!segments) return null;
  const text = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    `#EXT-X-TARGETDURATION:${Math.ceil(seg)}`,
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-MEDIA-SEQUENCE:0',
    ...body,
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
  return { text, runs: used, segments };
}

/** Where a recording's source playlist is kept: beside its thumbnails, which are recording-level too. */
export function recordingSourceKey(recordingId: string): string {
  return `thumbs/${recordingId}/source.m3u8`;
}

/**
 * Build the playlist and put it in the bucket. Returns its s3:// URI for the
 * thumbnailer job, or null when the bucket holds nothing for this recording
 * (then no task is started: it could only fail).
 */
export async function writeRecordingSource(rec: RecordingLike, opts: { segmentSeconds?: number } = {}): Promise<{ uri: string; runs: string[]; segments: number } | null> {
  const built = await buildRecordingSource(rec, opts);
  if (!built) return null;
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const api = await runsApi();
  const key = recordingSourceKey(rec.id);
  await api.send(new PutObjectCommand({
    Bucket: config.aws.s3Bucket, Key: key, Body: built.text,
    ContentType: 'application/vnd.apple.mpegurl',
  }));
  return { uri: `s3://${config.aws.s3Bucket}/${key}`, runs: built.runs, segments: built.segments };
}
