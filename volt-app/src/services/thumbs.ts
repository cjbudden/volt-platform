// ============================================================================
//  KEYFRAME THUMBNAILS — the video half of the timeline's media lane.
//
//  For an audio source the lane draws a waveform, because the waveform is where
//  the clipping points are: you can see the speech stop and the song start. For
//  a video source the equivalent is a filmstrip. A flat green block says a
//  recording exists; a strip of frames says WHICH recording, where the studio cut
//  to the pitch, where the titles rolled, where the goal was.
//
//  It is cheap for one specific reason. Our encoder writes a closed GOP exactly
//  one segment long with a forced keyframe on every boundary, so every segment
//  starts on an IDR and decodes ALONE. Extracting a frame is therefore reading
//  one small file and decoding a single picture, not seeking through a stream.
//
//  Same shape as the waveform service, deliberately, so the two lanes behave the
//  same way under the same conditions: a per-run cache on disk, an answer from
//  whatever is cached with the rest reported as pending, and a background primer
//  that fills the gap. A wide window never blocks on decoding.
// ============================================================================
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config';
import { originBaseFor } from './liveOrigin';
import { listRuns, pickRenditions, scanRun, type LocalSegment } from './localRecordingIndex';

export interface Thumb {
  /** Wall-clock instant this frame is FROM, not the slot it was asked for. */
  t: number;
  url: string;
  runId: string;
  seq: number;
}

export interface ThumbStrip {
  streamId: string;
  from: number;
  to: number;
  /** How wide a slice each slot covers, in ms. */
  slotMs: number;
  width: number;
  height: number;
  complete: boolean;
  pending: number;
  priming: boolean;
  thumbs: (Thumb | null)[];
}

/** Frame height. 16:9 at 90px is 160px wide, which is the density a 1200px lane
 *  wants: seven or eight frames, each still readable. */
const THUMB_H = 90;
/** Wall-clock budget for one request's extraction work. */
const BUDGET_MS = 4000;
const MAX_EXTRACTS = 40;

const priming = new Set<string>();
export function isThumbPriming(streamId: string): boolean { return priming.has(streamId); }

function thumbDir(streamId: string, runId: string): string {
  // No leading dot: this is served by the same static mount as the segments, and
  // express.static ignores dotfiles.
  return join(originBaseFor(streamId), 'runs', runId, 'thumbs');
}
function thumbPath(streamId: string, runId: string, rendition: string, seq: number): string {
  return join(thumbDir(streamId, runId), `${rendition}-${String(seq).padStart(5, '0')}.jpg`);
}
function thumbUrl(streamId: string, runId: string, rendition: string, seq: number): string {
  return `/origin/${streamId}/runs/${runId}/thumbs/${rendition}-${String(seq).padStart(5, '0')}.jpg`;
}

/**
 * Decode ONE frame out of ONE segment.
 *
 * init + segment are piped in together because a CMAF segment is undecodable
 * without its init header; concatenated they are a valid file, which is the same
 * property the clip extractor relies on. `-frames:v 1` stops at the first
 * picture, which is the segment's keyframe.
 */
function extractFrame(initPath: string, segPath: string, dest: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tmp = `${dest}.tmp.jpg`;
    const ff = spawn(config.clips.ffmpegBin ?? 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-i', 'pipe:0',
      '-frames:v', '1',
      '-vf', `scale=-2:${THUMB_H}`,
      '-q:v', '5',
      '-f', 'image2', '-y', tmp,
    ], { stdio: ['pipe', 'ignore', 'ignore'] });

    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      try { ff.kill('SIGKILL'); } catch { /* */ }
      if (ok && existsSync(tmp) && statSync(tmp).size > 0) {
        try { renameSync(tmp, dest); resolve(true); return; } catch { /* */ }
      }
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* */ }
      resolve(false);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    ff.on('close', (code) => { clearTimeout(timer); finish(code === 0); });
    ff.on('error', () => { clearTimeout(timer); finish(false); });
    try {
      ff.stdin.write(readFileSync(initPath));
      ff.stdin.write(readFileSync(segPath));
      ff.stdin.end();
    } catch { clearTimeout(timer); finish(false); }
    ff.stdin.on('error', () => { /* the close path resolves */ });
  });
}

/** The video rendition of a run, or null when the run is audio-only. */
function videoRenditionOf(streamId: string, runId: string): string | null {
  return pickRenditions(streamId, runId).video;
}

/** Segments of every VIDEO run overlapping the window, in time order. */
function videoSegmentsInRange(streamId: string, fromMs: number, toMs: number):
  { seg: LocalSegment; rendition: string }[] {
  const out: { seg: LocalSegment; rendition: string }[] = [];
  for (const runId of listRuns(streamId)) {
    const rendition = videoRenditionOf(streamId, runId);
    if (!rendition) continue;
    for (const s of scanRun(streamId, runId, rendition)) {
      if (s.startMs + s.durMs > fromMs && s.startMs < toMs) out.push({ seg: s, rendition });
    }
  }
  return out.sort((a, b) => a.seg.startMs - b.seg.startMs);
}

async function ensureThumb(streamId: string, seg: LocalSegment, rendition: string, timeoutMs: number): Promise<boolean> {
  const dest = thumbPath(streamId, seg.runId, rendition, seg.seq);
  if (existsSync(dest)) return true;
  const dir = join(originBaseFor(streamId), 'runs', seg.runId, rendition);
  const init = join(dir, 'init.mp4');
  const file = join(dir, seg.file);
  if (!existsSync(init) || !existsSync(file)) return false;
  mkdirSync(thumbDir(streamId, seg.runId), { recursive: true });
  return extractFrame(init, file, dest, timeoutMs);
}

/** Run `jobs` with at most `limit` in flight. */
async function pool<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      out[i] = await jobs[i]();
    }
  }));
  return out;
}

/**
 * Extract every missing frame for a window, in the background.
 *
 * One job per stream, newest first because that is where an operator starts.
 * Bounded concurrency and a yield between batches, so it never starves live
 * encoding on the same box.
 */
export function primeThumbs(streamId: string, fromMs: number, toMs: number): void {
  if (priming.has(streamId)) return;
  priming.add(streamId);
  void (async () => {
    try {
      const segs = videoSegmentsInRange(streamId, fromMs, toMs).reverse();
      // Only one frame per segment is ever needed, and a dense window would
      // extract thousands. Cap the pass at what a filmstrip could ever show.
      const stride = Math.max(1, Math.floor(segs.length / 400));
      const todo = segs.filter((_, i) => i % stride === 0)
        .filter((s) => !existsSync(thumbPath(streamId, s.seg.runId, s.rendition, s.seg.seq)));
      for (let i = 0; i < todo.length; i += 12) {
        const batch = todo.slice(i, i + 12);
        await pool(batch.map((s) => () => ensureThumb(streamId, s.seg, s.rendition, 4000)), 3);
        await new Promise((r) => setTimeout(r, 40));
      }
    } catch { /* priming is opportunistic */ } finally {
      priming.delete(streamId);
    }
  })();
}

/**
 * A filmstrip across a window.
 *
 * `count` slots, each filled by the segment nearest the slot's centre. Reports
 * the frame's OWN time rather than the slot's, because a frame from four seconds
 * away is still an honest picture of a different moment, and the UI places it
 * where it actually came from.
 */
export async function thumbStrip(
  streamId: string, fromMs: number, toMs: number, count: number
): Promise<ThumbStrip> {
  const from = Math.min(fromMs, toMs);
  const to = Math.max(fromMs, toMs);
  const n = Math.max(2, Math.min(60, Math.round(count)));
  const slotMs = (to - from) / n;
  const thumbs: (Thumb | null)[] = new Array(n).fill(null);

  const segs = videoSegmentsInRange(streamId, from, to);
  const base: ThumbStrip = {
    streamId, from, to, slotMs,
    width: Math.round(THUMB_H * 16 / 9), height: THUMB_H,
    complete: true, pending: 0, priming: priming.has(streamId), thumbs,
  };
  if (!segs.length) return base;

  // Pick the segment nearest each slot's centre.
  const chosen = new Map<number, { seg: LocalSegment; rendition: string }>();
  for (let i = 0; i < n; i++) {
    const centre = from + (i + 0.5) * slotMs;
    let best: { seg: LocalSegment; rendition: string } | null = null;
    let bestD = Infinity;
    for (const s of segs) {
      const mid = s.seg.startMs + s.seg.durMs / 2;
      const d = Math.abs(mid - centre);
      if (d < bestD) { bestD = d; best = s; }
    }
    // A slot whose nearest frame is more than half a slot away is a slot with no
    // media in it: a gap, and drawing a neighbour's frame there would claim
    // coverage that does not exist.
    if (best && bestD <= Math.max(slotMs, best.seg.durMs)) chosen.set(i, best);
  }

  const missing: [number, { seg: LocalSegment; rendition: string }][] = [];
  for (const [i, s] of chosen) {
    const p = thumbPath(streamId, s.seg.runId, s.rendition, s.seg.seq);
    if (existsSync(p)) {
      thumbs[i] = {
        t: Math.round(s.seg.startMs), url: thumbUrl(streamId, s.seg.runId, s.rendition, s.seg.seq),
        runId: s.seg.runId, seq: s.seg.seq,
      };
    } else missing.push([i, s]);
  }

  const take = missing.slice(0, MAX_EXTRACTS);
  const started = Date.now();
  const results = await pool(take.map(([, s]) => async () => {
    if (Date.now() - started > BUDGET_MS) return false;
    return ensureThumb(streamId, s.seg, s.rendition, 3000);
  }), 4);
  results.forEach((okFlag, k) => {
    if (!okFlag) return;
    const [i, s] = take[k];
    thumbs[i] = {
      t: Math.round(s.seg.startMs), url: thumbUrl(streamId, s.seg.runId, s.rendition, s.seg.seq),
      runId: s.seg.runId, seq: s.seg.seq,
    };
  });

  base.pending = Array.from(chosen.keys()).filter((i) => thumbs[i] === null).length;
  base.complete = base.pending === 0;
  base.priming = priming.has(streamId);
  return base;
}
