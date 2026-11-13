// ============================================================================
//  WHAT IS RECORDED, FROM THE BUCKET LISTING ALONE (build queue 2.3c-6).
//
//  On AWS the encoder uploads each run under
//  s3://<bucket>/<kind>/<id>/runs/<runId>/<rendition>/ and the control plane's
//  disk holds nothing, so every question that asked the disk "what media
//  covers this window" answered "none": the schedule called every aired
//  programme Unavailable (no Convert to VOD button, auto-VOD shown as gone),
//  and the recordings timeline drew no media lane and no gaps.
//
//  clips/resolveBucket.ts answers the same question exactly, but it reads the
//  head of every segment it places (the decode time inside the file). That is
//  right for a clip of a few minutes and far too much for a day: a 24 hour
//  channel has 21,600 segments a rendition. Coverage does not need the decode
//  time. It needs where the media starts and stops and where it has holes,
//  and the listing already says that:
//
//    WHICH SEGMENTS   the keys (seg_<n>.m4s): a skipped number is a hole.
//    WHEN             LastModified, less half an uploader pass, as the clip
//                     resolver does.
//    HOW LONG EACH    the run's own cadence: over the longest unbroken chain
//                     of numbers, the time between the first and last upload
//                     divided by the segments between them. Over a long chain
//                     the uploader's 2 s passes and the bucket's whole
//                     seconds average out; a short run may be off by about a
//                     second a segment, which is fine for a lane drawn at
//                     minutes per pixel and for a percentage.
//
//  The placement is then the Mac's own (placeSegments), fed a decode clock
//  built from that cadence, so stalls, restarts and holes come out by the
//  same rules as on the disk, and blocks, gaps and coverage are assembled by
//  the same code (assembleResolution). Nothing is read but listings: a day of
//  one rendition is about 22 list calls.
//
//  Listings are kept for a short while (COVERAGE_BUCKET_CACHE_MS, 30 s): the
//  schedule grid asks per stream and the timeline asks for coverage and the
//  lanes in turn, and a run being recorded only grows by a segment every few
//  seconds.
//
//  This is for drawing and counting. A clip is still resolved exactly
//  (resolveRangeAny), and the clip flow refuses or accepts by that.
// ============================================================================
import { config } from '../../config';
import { clipFallbacks, listRuns, parsePlayoutLog, placeSegments, type FallbackSpan, type LocalSegment } from '../localRecordingIndex';
import { bucketRecordings, listAll, runsApi } from '../media/s3Runs';
import type { S3Api } from '../media/s3Driver';
import { assembleResolution, resolveRange, type MediaKind, type RunPick } from './resolve';
import { pickBucketRendition, runsForRange, streamRoot, type AnyResolution } from './resolveBucket';

const SEGMENT = /^seg_(\d+)\.m4s$/;
const UNREADABLE = new Set(['GLACIER', 'DEEP_ARCHIVE']);
const NOMINAL_SEGMENT_MS = 4000;
const MIN_SEGMENT_MS = 500;
const MAX_SEGMENT_MS = 60_000;

const uploadLagMs = () => Number(process.env.CLIP_BUCKET_UPLOAD_LAG_MS ?? 1000);
const cacheMs = () => Number(process.env.COVERAGE_BUCKET_CACHE_MS ?? 30_000);

type Listed = Awaited<ReturnType<typeof listAll>>[number];
const listings = new Map<string, { at: number; items: Promise<Listed[]> }>();

/** listAll with a short memory, so the grid and the timeline do not list a run twice in a row. */
async function listCached(api: S3Api, bucket: string, prefix: string): Promise<Listed[]> {
  const key = `${bucket}/${prefix}`;
  const now = Date.now();
  const hit = listings.get(key);
  if (hit && now - hit.at < cacheMs()) return hit.items;
  const items = listAll(api, bucket, prefix);
  listings.set(key, { at: now, items });
  // A failed listing is not remembered: the next ask tries again.
  items.catch(() => { if (listings.get(key)?.items === items) listings.delete(key); });
  if (listings.size > 2000) for (const [k, v] of listings) if (now - v.at >= cacheMs()) listings.delete(k);
  return items;
}

/** For tests: forget every remembered listing. */
export function clearCoverageCache(): void { listings.clear(); }

/**
 * A run's segment length, from its uploads: over the longest unbroken chain of
 * segment numbers, (last upload - first upload) / (segments between). Falls
 * back to the nominal 4 s when the chain is too short to say.
 */
export function cadenceMs(segs: { seq: number; lastModified: number }[]): number {
  let best: { a: number; b: number } | null = null;
  let a = 0;
  for (let i = 1; i <= segs.length; i++) {
    if (i === segs.length || segs[i].seq !== segs[i - 1].seq + 1) {
      if (!best || i - 1 - a > best.b - best.a) best = { a, b: i - 1 };
      a = i;
    }
  }
  if (!best || best.b - best.a < 2) return NOMINAL_SEGMENT_MS;
  const ms = (segs[best.b].lastModified - segs[best.a].lastModified) / (segs[best.b].seq - segs[best.a].seq);
  return Number.isFinite(ms) ? Math.min(MAX_SEGMENT_MS, Math.max(MIN_SEGMENT_MS, Math.round(ms))) : NOMINAL_SEGMENT_MS;
}

/**
 * The media covering [fromMs..toMs] on a stream, from the bucket listing.
 * Same shape as resolveRange (blocks, gaps, coverage); segment paths are
 * s3:// keys and segment times are placed from the listing, not measured.
 */
export async function coverageRangeBucket(streamId: string, fromMs: number, toMs: number, kind: MediaKind = 'video',
  /** minHeight: the lightest picture at least that tall (pickBucketRendition). skipArchived: leave
   *  segments in archive storage out of the blocks (still counted), for a reader that must open them. */
  opts: { minHeight?: number; skipArchived?: boolean } = {}): Promise<AnyResolution & { measured: 'listing' }> {
  const from = Math.min(fromMs, toMs);
  const to = Math.max(fromMs, toMs);
  const bucket = config.aws.s3Bucket;
  const api = await runsApi();
  const root = await streamRoot(api, bucket, streamId);
  const picks: RunPick[] = [];
  let archived = 0;
  for (const runId of root ? runsForRange(root.runs, from, to) : []) {
    const runKey = `${root!.rootKey}runs/${runId}/`;
    const rendition = await pickBucketRendition(api, bucket, runKey, kind, opts.minHeight);
    if (!rendition) continue;
    const prefix = `${runKey}${rendition}/`;
    const listed = await listCached(api, bucket, prefix);
    if (!listed.some((o) => o.key === `${prefix}init.mp4`)) continue;
    const segs = listed
      .map((o) => ({ ...o, file: o.key.slice(prefix.length) }))
      .filter((o) => SEGMENT.test(o.file))
      .map((o) => ({ ...o, seq: Number(SEGMENT.exec(o.file)![1]) }))
      .sort((a, b) => a.seq - b.seq);
    if (!segs.length) continue;
    // A decode clock built from the cadence, in milliseconds: consecutive
    // numbers are one cadence apart, so placeSegments takes that as each
    // segment's length and breaks the run wherever a number is skipped.
    const dur = cadenceMs(segs);
    const placed = placeSegments(segs.map((o) => ({ seq: o.seq, tfdt: BigInt(o.seq) * BigInt(dur), mtimeMs: o.lastModified - uploadLagMs() })), 1000);
    const inRange: LocalSegment[] = [];
    segs.forEach((o, i) => {
      const p = placed[i];
      if (!(p.startMs + p.durMs > from && p.startMs < to)) return;
      // Cold media is still recorded media: counted, and reported, so the
      // caller can say it needs a restore before a clip.
      if (UNREADABLE.has(o.storageClass)) { archived++; if (opts.skipArchived) return; }
      inRange.push({ runId, rendition, file: o.file, seq: o.seq, startMs: p.startMs, durMs: p.durMs, uri: `s3://${bucket}/${o.key}` });
    });
    if (inRange.length) picks.push({ runId, rendition, dir: `s3://${bucket}/${prefix}`, segs: inRange });
  }
  const r = assembleResolution(streamId, from, to, kind, picks) as AnyResolution & { measured: 'listing' };
  r.fromBucket = true;
  r.archivedSegments = archived;
  r.measured = 'listing';
  return r;
}

/**
 * Coverage for drawing and counting: the disk when this machine holds the
 * stream's runs (the Mac, unchanged), else the bucket listing (AWS).
 */
export async function coverageRangeAny(streamId: string, fromMs: number, toMs: number, kind: MediaKind = 'video'): Promise<AnyResolution> {
  if (bucketRecordings() && listRuns(streamId).length === 0) return coverageRangeBucket(streamId, fromMs, toMs, kind);
  return resolveRange(streamId, fromMs, toMs, kind);
}

/** Under this a hole is segment jitter, not missing media (localRecordingIndex's GAP_MIN_MS). */
const GAP_MIN_MS = 1500;

/** Does this machine answer the stream's recordings from the bucket? Only when its disk has no run of it. */
export function coverageFromBucket(streamId: string): boolean {
  return bucketRecordings() && listRuns(streamId).length === 0;
}

/**
 * A RECORDING'S TIMELINE FROM THE BUCKET (build queue 2.3c-7): what
 * GET /api/recordings/:id/timeline draws, on AWS. The same answers the disk
 * gives (localRecordingIndex recordingSpans and recordingGaps): per-run spans
 * inside the recording's window, the holes with their reasons (jitter under
 * 1.5 s is not a hole), whether it has sound and a picture. A recording still
 * being made ends at its last segment, so its trailing edge is not a hole.
 * Placed from the listing, as coverageRangeBucket is.
 */
export async function recordingTimelineBucket(streamId: string, startMs: number, endMs: number | null, nowMs = Date.now()): Promise<{
  spans: { runId: string; startMs: number; endMs: number; segments: number }[];
  gaps: { fromMs: number; toMs: number; ms: number; reason: 'between-runs' | 'missing-media' | 'no-recording' }[];
  hasAudio: boolean; hasVideo: boolean; winEndMs: number;
}> {
  const to = endMs ?? nowMs;
  const r = await coverageRangeBucket(streamId, startMs, to, 'video');
  const byRun = new Map<string, { runId: string; startMs: number; endMs: number; segments: number }>();
  for (const b of r.blocks) {
    const s = byRun.get(b.runId);
    if (!s) byRun.set(b.runId, { runId: b.runId, startMs: b.startMs, endMs: b.endMs, segments: b.segments.length });
    else { s.startMs = Math.min(s.startMs, b.startMs); s.endMs = Math.max(s.endMs, b.endMs); s.segments += b.segments.length; }
  }
  const spans = [...byRun.values()].sort((a, b) => a.startMs - b.startMs);
  const winEndMs = endMs ?? (spans.length ? spans[spans.length - 1].endMs : startMs);
  const gaps = r.gaps
    .map((g) => ({ ...g, toMs: Math.min(g.toMs, winEndMs) }))
    .map((g) => ({ ...g, ms: g.toMs - g.fromMs }))
    .filter((g) => g.ms > GAP_MIN_MS)
    .map(({ fromMs, toMs, ms, reason }) => ({ fromMs, toMs, ms, reason }));
  // Sound and picture: from the renditions of the runs in the window.
  let hasAudio = false, hasVideo = false;
  const bucket = config.aws.s3Bucket;
  const api = await runsApi();
  const root = await streamRoot(api, bucket, streamId);
  for (const runId of root ? runsForRange(root.runs, startMs, to) : []) {
    const runKey = `${root!.rootKey}runs/${runId}/`;
    if (!hasAudio && (await pickBucketRendition(api, bucket, runKey, 'audio'))) hasAudio = true;
    if (!hasVideo) { const v = await pickBucketRendition(api, bucket, runKey, 'video'); if (v && v !== 'audio') hasVideo = true; }
    if (hasAudio && hasVideo) break;
  }
  return { spans, gaps, hasAudio, hasVideo, winEndMs };
}

/**
 * WHERE VIEWERS SAW THE LOOP, FROM THE BUCKET (build queue 2.3c-8). The
 * encoder writes every playout splice to playout.jsonl in its run folder, and
 * the uploader's segment sync (s3-uploader.sh, everything but playlists) takes
 * that file up with the run, so on AWS it is at runs/<runId>/playout.jsonl.
 * Read the same way as the disk (parsePlayoutLog): one GetObject per run in
 * the window, a run without the file (no splice yet, or an encoder from before
 * splices were logged) simply has none. A run that ended on the loop, or is
 * still on it, lasts to that run's last segment, from `spans` (the timeline's
 * own, so no second listing).
 */
export async function recordingFallbacksBucket(streamId: string, fromMs: number, toMs: number,
  spans: { runId: string; endMs: number }[], nowMs = Date.now()): Promise<FallbackSpan[]> {
  const bucket = config.aws.s3Bucket;
  const api = await runsApi();
  const root = await streamRoot(api, bucket, streamId);
  if (!root) return [];
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const out: FallbackSpan[] = [];
  for (const runId of runsForRange(root.runs, fromMs, toMs)) {
    let txt: string;
    try {
      const o = await api.send(new GetObjectCommand({ Bucket: bucket, Key: `${root.rootKey}runs/${runId}/playout.jsonl` }));
      txt = String(await o.Body?.transformToString?.() ?? '');
    } catch { continue; }
    const { closed, open } = parsePlayoutLog(txt);
    out.push(...closed);
    if (open) {
      const last = spans.filter((s) => s.runId === runId).pop();
      open.toMs = Math.max(open.fromMs, last ? last.endMs : nowMs);
      out.push(open);
    }
  }
  return clipFallbacks(out, fromMs, toMs);
}
