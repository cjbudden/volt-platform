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
import { listRuns, placeSegments, type LocalSegment } from '../localRecordingIndex';
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
export async function coverageRangeBucket(streamId: string, fromMs: number, toMs: number, kind: MediaKind = 'video'): Promise<AnyResolution & { measured: 'listing' }> {
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
      if (UNREADABLE.has(o.storageClass)) archived++;
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
