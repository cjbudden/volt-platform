// ============================================================================
//  CLIPS FROM RECORDED RUNS IN THE BUCKET (build queue 2.3c-2).
//
//  On the Mac a clip is resolved from the run folders on the control plane's
//  disk (clips/resolve.ts) and cut from those files. On AWS the encoder is a
//  task of its own and uploads each run under
//  s3://<bucket>/<kind>/<id>/runs/<runId>/<rendition>/ (build queue 2.2); the
//  control plane's disk and the media-jobs task's disk hold none of it. So
//  every clip on AWS was refused with "Nothing is recorded", or, had it got
//  through, the extractor would have found no files.
//
//  This is the bucket side of the same resolution:
//
//    PLACE   the same placement as the disk (placeSegments): each segment's
//            decode time from the head of the object (a ranged read, not the
//            whole segment) and its write time from the bucket's LastModified.
//            LastModified is when the uploader's pass put it there: the
//            encoder's uploader runs every 2 s, so an object lands between a
//            few tenths of a second and about 2.5 s after the file was
//            written, and the bucket keeps whole seconds. Half a pass
//            (CLIP_BUCKET_UPLOAD_LAG_MS, 1 s) is taken off each write time, so
//            a segment is placed within about 1.5 s of where the Mac would put
//            it. Exact placement needs the encoder's own write time stored on
//            each object (queued with 2.3c-3).
//    LIMIT   only the segments the range can need are read: those written
//            between the range's start and its end plus the longest upload
//            lag (CLIP_BUCKET_WRITE_LAG_MS, 2 min), plus two neighbours each
//            side so the first and last get measured durations. A day's run
//            is listed (about 22 calls for 21,600 keys) but not read.
//    STAGE   the job copies exactly the segments and init files the
//            resolution names into its own scratch folder, cuts them with the
//            Mac's extractor unchanged, and removes the folder when it ends.
//
//  The disk is always asked first: a stream with runs on this machine (the
//  Mac, including the Mac with MinIO) resolves from the disk as before. The
//  bucket is read only when the deployment keeps recordings in the bucket and
//  this machine holds no run of the stream.
//
//  A segment in archive storage (GLACIER, DEEP_ARCHIVE) cannot be read until
//  it is restored: the range is refused with code `media_archived`, not cut
//  short or reported as a gap.
// ============================================================================
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from '../../config';
import { isAudioOnly, listRuns, placeSegments, mdhdTimescaleOf, tfdtOf, type LocalSegment } from '../localRecordingIndex';
import { bucketRecordings, listAll, listLevel, runStartMs, runsApi } from '../media/s3Runs';
import type { S3Api } from '../media/s3Driver';
import { assembleResolution, assessRange, resolveRange, type MediaKind, type Resolution, type RunPick } from './resolve';

const SEGMENT = /^seg_(\d+)\.m4s$/;
const RUN_ID = /^[A-Za-z0-9._-]+$/;
/** Folders of a run that are not renditions (s3Runs.ts keeps the same list). */
const NOT_RENDITIONS = new Set(['thumbs', 'filler', 'subtitles', 'id3', 'captions', 'audio']);
/** Storage classes a GetObject refuses until the object is restored. */
const UNREADABLE = new Set(['GLACIER', 'DEEP_ARCHIVE']);
/** A run id is the encoder's clock at start; the range is the control plane's. */
const CLOCK_SLACK_MS = 60_000;
/** How much of the head of an object holds the box we need (moof/tfdt, moov/mdhd). */
const SEG_HEAD_BYTES = 16 * 1024;
const INIT_HEAD_BYTES = 64 * 1024;
const NEIGHBOURS = 2;
const PARALLEL = 16;

const writeLagMs = () => Number(process.env.CLIP_BUCKET_WRITE_LAG_MS ?? 120_000);
/** The typical time from the encoder writing a file to the bucket having it. */
const uploadLagMs = () => Number(process.env.CLIP_BUCKET_UPLOAD_LAG_MS ?? 1000);

/** A resolution that may come from the bucket. */
export type AnyResolution = Resolution & {
  /** True when the segment paths are s3:// keys (stage before cutting). */
  fromBucket?: boolean;
  /** Segments in range that sit in archive storage and cannot be read now. */
  archivedSegments?: number;
};

/** Run `fn` over `items`, at most `n` at once, results in order. */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

async function head(api: S3Api, bucket: string, key: string, bytes: number): Promise<Buffer | null> {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  try {
    const r = await api.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${bytes - 1}` }));
    const body: any = r.Body;
    if (body?.transformToByteArray) return Buffer.from(await body.transformToByteArray());
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  } catch { return null; }
}

/** The stream's root key in the bucket: `channel/<id>/` or `event/<id>/`, whichever has runs. */
async function streamRoot(api: S3Api, bucket: string, streamId: string): Promise<{ rootKey: string; runs: string[] } | null> {
  for (const kind of ['channel', 'event']) {
    const rootKey = `${kind}/${streamId}/`;
    const level = await listLevel(api, bucket, `${rootKey}runs/`);
    const runs = level.folders.map((p) => p.slice(`${rootKey}runs/`.length).replace(/\/$/, '')).filter((r) => RUN_ID.test(r));
    if (runs.length) return { rootKey, runs };
  }
  return null;
}

/**
 * The runs a range can touch: every run that started inside it, and the last
 * one that started before it (a run ends before the next one starts, so an
 * earlier run cannot reach into the range).
 */
export function runsForRange(runs: string[], fromMs: number, toMs: number): string[] {
  const placed = runs.map((id) => ({ id, at: runStartMs(id) }))
    .filter((r): r is { id: string; at: number } => r.at != null)
    .sort((a, b) => a.at - b.at);
  const before = placed.filter((r) => r.at <= fromMs).pop();
  const inside = placed.filter((r) => r.at > fromMs && r.at <= toMs + CLOCK_SLACK_MS);
  return [...(before ? [before] : []), ...inside].map((r) => r.id);
}

/** The rendition a clip of `kind` is cut from in one run, the Mac's rule (pickRenditions). */
async function pickBucketRendition(api: S3Api, bucket: string, runKey: string, kind: MediaKind): Promise<string | null> {
  const level = await listLevel(api, bucket, runKey);
  const names = level.folders.map((p) => p.slice(runKey.length).replace(/\/$/, ''));
  const audio = names.includes('audio');
  const videos = names.filter((n) => !NOT_RENDITIONS.has(n) && RUN_ID.test(n))
    .map((r) => ({ r, h: parseInt(r, 10) || 0 })).sort((a, b) => b.h - a.h);
  if (kind === 'audio') return audio ? 'audio' : null;
  return videos[0]?.r ?? (audio ? 'audio' : null);
}

/**
 * Resolve [fromMs..toMs] on a stream from its runs in the bucket. Same blocks,
 * gaps and coverage as the disk; segment and init paths are s3:// keys.
 */
export async function resolveRangeBucket(streamId: string, fromMs: number, toMs: number, kind: MediaKind = 'video'): Promise<AnyResolution> {
  const from = Math.min(fromMs, toMs);
  const to = Math.max(fromMs, toMs);
  const bucket = config.aws.s3Bucket;
  const api = await runsApi();
  const root = await streamRoot(api, bucket, streamId);
  const picks: RunPick[] = [];
  let archived = 0;
  for (const runId of root ? runsForRange(root.runs, from, to) : []) {
    const runKey = `${root!.rootKey}runs/${runId}/`;
    const rendition = await pickBucketRendition(api, bucket, runKey, kind);
    if (!rendition) continue;
    const prefix = `${runKey}${rendition}/`;
    const listed = await listAll(api, bucket, prefix);
    const init = listed.find((o) => o.key === `${prefix}init.mp4`);
    if (!init) continue;
    const segs = listed
      .map((o) => ({ ...o, file: o.key.slice(prefix.length) }))
      .filter((o) => SEGMENT.test(o.file))
      .map((o) => ({ ...o, seq: Number(SEGMENT.exec(o.file)![1]) }))
      .sort((a, b) => a.seq - b.seq);
    // Written after its content ended, and at most the upload lag after: a
    // segment that overlaps the range was put between `from` and `to + lag`.
    // LastModified is whole seconds, hence the second either side.
    const hit = segs.map((o, i) => (o.lastModified >= from - 1000 && o.lastModified <= to + writeLagMs() + 1000 ? i : -1)).filter((i) => i >= 0);
    if (!hit.length) continue;
    const window = segs.slice(Math.max(0, hit[0] - NEIGHBOURS), Math.min(segs.length, hit[hit.length - 1] + NEIGHBOURS + 1));
    const ts = UNREADABLE.has(init.storageClass) ? null : mdhdTimescaleOf((await head(api, bucket, init.key, INIT_HEAD_BYTES)) ?? Buffer.alloc(0));
    const tfdts = await pool(window, PARALLEL, async (o) =>
      UNREADABLE.has(o.storageClass) ? null : tfdtOf((await head(api, bucket, o.key, SEG_HEAD_BYTES)) ?? Buffer.alloc(0)));
    const placed = placeSegments(window.map((o, i) => ({ seq: o.seq, tfdt: tfdts[i], mtimeMs: o.lastModified - uploadLagMs() })), ts ?? 90000);
    const inRange: LocalSegment[] = [];
    window.forEach((o, i) => {
      const p = placed[i];
      if (!(p.startMs + p.durMs > from && p.startMs < to)) return;
      if (UNREADABLE.has(o.storageClass) || UNREADABLE.has(init.storageClass)) { archived++; return; }
      inRange.push({ runId, rendition, file: o.file, seq: o.seq, startMs: p.startMs, durMs: p.durMs, uri: `s3://${bucket}/${o.key}` });
    });
    if (inRange.length) picks.push({ runId, rendition, dir: `s3://${bucket}/${prefix}`, segs: inRange });
  }
  const r: AnyResolution = assembleResolution(streamId, from, to, kind, picks);
  r.fromBucket = true;
  r.archivedSegments = archived;
  return r;
}

/** Does this machine resolve the stream from the bucket? Only when its disk has no run of it. */
export function resolvesFromBucket(streamId: string): boolean {
  return bucketRecordings() && listRuns(streamId).length === 0;
}

/** The disk when it holds the stream's runs, else the bucket (AWS). */
export async function resolveRangeAny(streamId: string, fromMs: number, toMs: number, kind: MediaKind = 'video'): Promise<AnyResolution> {
  return resolvesFromBucket(streamId) ? resolveRangeBucket(streamId, fromMs, toMs, kind) : resolveRange(streamId, fromMs, toMs, kind);
}

/**
 * IS THIS STREAM SOUND ONLY? (build queue 2.3c-3). A radio station's clip is
 * cut from its audio and delivered as MP3 and M4A, never an MP4. On the Mac
 * that is read from the run folders on disk (isAudioOnly); on AWS there are
 * none, so every station read as video and its clips were promised an MP4
 * that the audio rendition cannot make. From the bucket: a channel whose kind
 * is radio, or a stream whose newest run in the bucket has the sound and no
 * picture (one short listing). The disk is still asked first.
 */
export async function isAudioOnlyAny(streamId: string): Promise<boolean> {
  if (!resolvesFromBucket(streamId)) return isAudioOnly(streamId);
  try {
    const { one } = await import('../../db');
    const ch = await one<{ kind: string | null }>(`SELECT kind FROM channels WHERE id = $1`, [streamId]);
    if (ch?.kind === 'radio') return true;
  } catch { /* not a channel id (an event), or no database: ask the bucket */ }
  const api = await runsApi();
  const bucket = config.aws.s3Bucket;
  const root = await streamRoot(api, bucket, streamId);
  const newest = root?.runs.map((id) => ({ id, at: runStartMs(id) }))
    .filter((r): r is { id: string; at: number } => r.at != null)
    .sort((a, b) => b.at - a.at)[0];
  if (!root || !newest) return false;
  const runKey = `${root.rootKey}runs/${newest.id}/`;
  return (await pickBucketRendition(api, bucket, runKey, 'video')) === 'audio';
}

/** assessRange, plus the refusal for media that has to be restored first. */
export function assessRangeAny(r: AnyResolution, opts: { maxGapMs?: number } = {}):
  { ok: true } | { ok: false; code: string; message: string } {
  if (r.archivedSegments) {
    return { ok: false, code: 'media_archived',
      message: `Part of this range is in archive storage (${r.archivedSegments} segment${r.archivedSegments === 1 ? '' : 's'}). Restore the recording, then cut the clip.` };
  }
  return assessRange(r, opts);
}

/**
 * Copy the bucket segments and init files a resolution names into `dir`, and
 * return the same resolution with local paths, for the extractor. The caller
 * removes `dir` when the cut is done (release()).
 */
export async function stageResolution(r: AnyResolution, dir: string): Promise<{ resolution: Resolution; files: number; bytes: number; release: () => Promise<void> }> {
  const release = async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}); };
  if (!r.fromBucket) return { resolution: r, files: 0, bytes: 0, release: async () => {} };
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const api = await runsApi();
  const wanted = new Map<string, string>(); // s3 uri -> local path
  const local = (uri: string, runId: string, rendition: string) => {
    const name = uri.slice(uri.lastIndexOf('/') + 1);
    const path = join(dir, runId, rendition, name);
    wanted.set(uri, path);
    return path;
  };
  const blocks = r.blocks.map((b) => ({
    ...b,
    initPath: local(b.initPath, b.runId, b.rendition),
    segments: b.segments.map((s) => ({ ...s, path: local(s.path, s.runId, s.rendition) })),
  }));
  let bytes = 0;
  try {
    await pool([...wanted.entries()], 8, async ([uri, path]) => {
      const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
      if (!m) throw new Error(`not a bucket address: ${uri}`);
      await mkdir(join(path, '..'), { recursive: true });
      const o = await api.send(new GetObjectCommand({ Bucket: m[1], Key: m[2] }));
      await pipeline(o.Body as any, createWriteStream(path));
      bytes += Number(o.ContentLength ?? 0);
    });
  } catch (e) {
    await release();
    throw e;
  }
  return { resolution: { ...r, blocks }, files: wanted.size, bytes, release };
}
