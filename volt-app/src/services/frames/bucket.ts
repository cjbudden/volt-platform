// ============================================================================
//  A RECORDING'S FRAMES FROM THE BUCKET ON AWS (build queue 2.3c-11).
//
//  On the Mac a recording's exact frame is read from the run folders on the
//  control plane's disk (store.ts streamSegmentAt, segmentFrames). On AWS the
//  encoder is a task of its own and uploads each run under
//  s3://<bucket>/<kind>/<id>/runs/<runId>/<rendition>/ (build queue 2.2), so
//  the disk held nothing and every frame of every recording answered
//  "a gap in the capture".
//
//  This is the bucket side of the same lookup, on the placement the clips
//  already use (clips/resolveBucket.ts: decode times from the head of each
//  object, write times from the bucket), so a frame and a clip cut at the same
//  moment agree.
//
//  COST. Stepping through a scene asks for the next frame many times a
//  second, and resolving from the bucket lists the run. So a lookup resolves
//  a window around the moment (FRAME_BUCKET_WINDOW_MS either side, 60 s) and
//  keeps it for FRAME_BUCKET_CACHE_MS (30 s): the frames of that minute need
//  no listing at all. The segment bytes are kept too (a few, newest used
//  last), so the frame lookup and the still made from it read a segment once,
//  and a run's init.mp4 is read once.
//
//  A segment in archive storage (Glacier, Deep Archive) cannot be read until
//  the recording is restored: that moment is refused with 409 and says so,
//  rather than reported as a gap.
// ============================================================================
import { config } from '../../config';
import { runsApi } from '../media/s3Runs';
import { resolveRangeBucket } from '../clips/resolveBucket';
import type { LocalSegment } from '../localRecordingIndex';
import { FrameError } from './exactFrame';

/** A segment placed from the bucket, with its keys. */
export type BucketSegment = LocalSegment & { src: string; initSrc: string };

interface Window { from: number; to: number; at: number; segs: BucketSegment[]; archived: number }

const windowMs = () => Number(process.env.FRAME_BUCKET_WINDOW_MS ?? 60_000);
const cacheMs = () => Number(process.env.FRAME_BUCKET_CACHE_MS ?? 30_000);
/** Objects bigger than this are not segments a frame can come from. */
const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const KEEP_SEGMENTS = 8;
const KEEP_INITS = 64;
const KEEP_STREAMS = 64;

const windows = new Map<string, Window[]>();
const segBytes = new Map<string, Buffer>();
const initBytes = new Map<string, Buffer>();
const initReading = new Map<string, Promise<Buffer | null>>();

/** Forget everything kept (tests, and a stream's run removed). */
export function clearFrameBucketCache(): void { windows.clear(); segBytes.clear(); initBytes.clear(); }

function find(w: Window, ms: number): BucketSegment | null {
  for (const s of w.segs) if (ms >= s.startMs && ms < s.startMs + s.durMs) return s;
  return null;
}

/**
 * The video segment of a stream in the bucket covering wall time `ms`, or
 * null in a hole. Throws 409 when that moment is in archive storage.
 */
export async function bucketSegmentAt(streamId: string, ms: number): Promise<BucketSegment | null> {
  const now = Date.now();
  const list = (windows.get(streamId) ?? []).filter((w) => now - w.at < cacheMs());
  // A window answers a moment well inside it; one near its edge is resolved
  // again, because the neighbours that measure an edge segment are outside.
  for (const w of list) {
    if (ms < w.from + 5_000 || ms >= w.to - 5_000) continue;
    const s = find(w, ms);
    if (s) return s;
    if (!w.archived) return null;
  }
  const half = Math.max(5_000, windowMs());
  const r = await resolveRangeBucket(streamId, ms - half, ms + half, 'video');
  const segs: BucketSegment[] = [];
  for (const b of r.blocks) {
    for (const s of b.segments) {
      segs.push({ runId: s.runId, rendition: s.rendition, file: s.file, seq: s.seq, startMs: s.startMs,
        durMs: s.endMs - s.startMs, uri: s.path, src: s.path, initSrc: b.initPath });
    }
  }
  segs.sort((a, b) => a.startMs - b.startMs);
  const w: Window = { from: ms - half, to: ms + half, at: now, segs, archived: r.archivedSegments ?? 0 };
  windows.set(streamId, [...list.slice(-3), w]);
  for (const k of windows.keys()) { if (windows.size <= KEEP_STREAMS) break; windows.delete(k); }
  const hit = find(w, ms);
  if (hit) return hit;
  if (w.archived) {
    // The window holds a segment in archive storage. Is it this moment?
    // Resolving just this moment counts only the segments placed over it
    // (rare, so the extra listing is fine).
    const narrow = await resolveRangeBucket(streamId, ms, ms + 1, 'video');
    if (narrow.archivedSegments) {
      throw new FrameError(409, 'that moment of the recording is in archive storage; restore the recording, then ask for the frame again');
    }
  }
  return null;
}

/** The whole object at an s3:// address, or null when it cannot be read. */
async function getObject(src: string): Promise<Buffer | null> {
  const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(src);
  if (!m || m[1] !== config.aws.s3Bucket) return null;
  try {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const api = await runsApi();
    const r = await api.send(new GetObjectCommand({ Bucket: m[1], Key: m[2] }));
    if (Number(r.ContentLength ?? 0) > MAX_OBJECT_BYTES) return null;
    const body: any = r.Body;
    let buf: Buffer;
    if (body?.transformToByteArray) buf = Buffer.from(await body.transformToByteArray());
    else {
      const chunks: Buffer[] = [];
      for await (const c of body) chunks.push(Buffer.from(c));
      buf = Buffer.concat(chunks);
    }
    return buf.length > MAX_OBJECT_BYTES ? null : buf;
  } catch (e: any) {
    if (e?.name === 'InvalidObjectState') {
      throw new FrameError(409, 'that moment of the recording is in archive storage; restore the recording, then ask for the frame again');
    }
    return null;
  }
}

function keep(map: Map<string, Buffer>, key: string, b: Buffer, max: number): void {
  map.delete(key);
  map.set(key, b);
  for (const k of map.keys()) { if (map.size <= max) break; map.delete(k); }
}

/**
 * A bucket segment's init and media bytes (kept for the next ask). The
 * storyboard builder passes `keepSegment: false`: it reads each segment once,
 * and keeping them would push out the few an operator stepping through a
 * scene is using. The init is kept either way (one per run).
 */
export async function readBucketSegment(s: BucketSegment, opts: { keepSegment?: boolean } = {}): Promise<{ init: Buffer | null; seg: Buffer | null }> {
  let init = initBytes.get(s.initSrc) ?? null;
  if (!init) {
    // Several tiles decode at once (THUMBS_CONCURRENCY): they share one read of the init.
    let p = initReading.get(s.initSrc);
    if (!p) {
      p = getObject(s.initSrc).finally(() => initReading.delete(s.initSrc));
      initReading.set(s.initSrc, p);
    }
    init = await p;
    if (init) keep(initBytes, s.initSrc, init, KEEP_INITS);
  }
  let seg = segBytes.get(s.src) ?? null;
  if (seg) keep(segBytes, s.src, seg, KEEP_SEGMENTS);
  else { seg = await getObject(s.src); if (seg && opts.keepSegment !== false) keep(segBytes, s.src, seg, KEEP_SEGMENTS); }
  return { init, seg };
}
