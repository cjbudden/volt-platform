// ============================================================================
//  WAVEFORM — the audio envelope behind the clipping timeline.
//
//  Why: trimming by eye is far faster than trimming by scrubbing. A waveform
//  shows where speech starts, where a song ends, where the silence between
//  items is — which is exactly where clip in/out points belong.
//
//  The hard part is SCALE. A 24x7 channel with a long retention rule can hold
//  many days of segments, and decoding days of audio per request is not an
//  option. Two modes, chosen by how far the operator is zoomed in:
//
//   EXACT  (short windows): decode every segment in the window in ONE ffmpeg
//          pass to low-rate mono PCM and compute a true peak/RMS per bucket.
//          Fast because the audio rendition is small (~240x realtime) and the
//          window is short: this is the zoom level where clipping happens.
//
//   SAMPLED (wide windows): pick ONE segment near each bucket's centre and
//          decode just those, in parallel, with a bounded budget. At a
//          multi-hour zoom a bucket is minutes wide, so a representative
//          sample per bucket IS the envelope at that scale.
//
//  Every decoded segment's peak/RMS is cached in a per-run sidecar
//  (<run>/.peaks.json), so panning and re-zooming reuse work, and a window
//  that was already visited returns instantly. A request never blocks for
//  longer than its budget: whatever is still missing comes back as `pending`
//  and the client asks again, so the picture fills in progressively instead of
//  hanging.
// ============================================================================
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { originBaseFor } from './liveOrigin';
import { audioSegmentsInRange, type LocalSegment } from './localRecordingIndex';

export interface WaveBucket {
  t: number;            // bucket start (epoch ms)
  peak: number;         // 0..1 (linear from dBFS)
  rms: number;          // 0..1
}
export interface WaveformResult {
  streamId: string;
  from: number; to: number;
  bucketMs: number;
  mode: 'exact' | 'sampled';
  complete: boolean;
  pending: number;      // buckets still without data (ask again to fill them)
  priming?: boolean;    // a background pass is measuring the rest right now
  buckets: (WaveBucket | null)[];
}

/**
 * dBFS -> 0..1 for drawing: LINEAR AMPLITUDE, floored at -60 dBFS.
 *
 * This is what a waveform view draws, and it is the same scale the live radio
 * meter and the video page's dock meter use, so the clipping surface and the
 * live surface agree about how loud a thing looked.
 *
 * It was `(db + 60) / 60` — linear in DECIBELS over a 60 dB window. On real
 * programme audio that puts -4 dBFS at 0.93 and -13 dBFS at 0.78: a 9 dB swing
 * drawn as a 15% difference in height, so the waveform came out as a fat block
 * with no shape to trim against. Linear amplitude puts those at 0.63 and 0.22.
 *
 * The per-run cache stores dB, not units, so this changes the picture without
 * invalidating a single cached file.
 */
function dbToUnit(db: number): number {
  if (!Number.isFinite(db) || db <= -60) return 0;
  return Math.max(0, Math.min(1, Math.pow(10, db / 20)));
}

// ---- per-run peak cache -----------------------------------------------------
type RunCache = Record<string, [number, number]>;   // seq -> [peakDb, rmsDb]
const memCache = new Map<string, RunCache>();       // key: streamId/runId

function cachePath(streamId: string, runId: string) {
  return join(originBaseFor(streamId), 'runs', runId, '.peaks.json');
}
function loadCache(streamId: string, runId: string): RunCache {
  const key = `${streamId}/${runId}`;
  const hit = memCache.get(key);
  if (hit) return hit;
  let c: RunCache = {};
  try {
    const p = cachePath(streamId, runId);
    if (existsSync(p)) c = JSON.parse(readFileSync(p, 'utf8')) as RunCache;
  } catch { c = {}; }
  memCache.set(key, c);
  return c;
}
function saveCache(streamId: string, runId: string) {
  const key = `${streamId}/${runId}`;
  const c = memCache.get(key);
  if (!c) return;
  try {
    const p = cachePath(streamId, runId);
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(c));
    renameSync(tmp, p);      // atomic: a half-written cache must never be read
  } catch { /* cache is an optimisation, never a hard failure */ }
}

// ---- decoding ---------------------------------------------------------------
const PCM_RATE = 4000;       // enough for an envelope, 60x cheaper than 48k

/** Decode init + segments (in order) to mono PCM at PCM_RATE. */
function decodePcm(initPath: string, segPaths: string[], timeoutMs: number): Promise<Int16Array> {
  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-ac', '1', '-ar', String(PCM_RATE), '-f', 's16le', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { ff.kill('SIGKILL'); } catch { /* */ }
      const buf = Buffer.concat(chunks);
      resolve(new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)));
    };
    const timer = setTimeout(finish, timeoutMs);
    ff.stdout.on('data', (c: Buffer) => chunks.push(c));
    ff.on('close', () => { clearTimeout(timer); finish(); });
    ff.on('error', () => { clearTimeout(timer); finish(); });
    try {
      ff.stdin.write(readFileSync(initPath));
      for (const p of segPaths) ff.stdin.write(readFileSync(p));
      ff.stdin.end();
    } catch { clearTimeout(timer); finish(); }
    ff.stdin.on('error', () => { /* closed early: the timeout/close path resolves */ });
  });
}

function peakRms(pcm: Int16Array, from: number, to: number): { peakDb: number; rmsDb: number } {
  let peak = 0, sumSq = 0, n = 0;
  for (let i = from; i < to && i < pcm.length; i++) {
    const v = Math.abs(pcm[i]) / 32768;
    if (v > peak) peak = v;
    sumSq += v * v; n++;
  }
  if (!n) return { peakDb: -100, rmsDb: -100 };
  const rms = Math.sqrt(sumSq / n);
  const toDb = (x: number) => (x <= 0.00001 ? -100 : 20 * Math.log10(x));
  return { peakDb: toDb(peak), rmsDb: toDb(rms) };
}

function runDirOf(streamId: string, runId: string) {
  return join(originBaseFor(streamId), 'runs', runId, 'audio');
}

/** Decode ONE segment and cache its peak/RMS. */
async function segmentPeak(streamId: string, s: LocalSegment, timeoutMs: number): Promise<[number, number] | null> {
  const cache = loadCache(streamId, s.runId);
  const hit = cache[String(s.seq)];
  if (hit) return hit;
  const dir = runDirOf(streamId, s.runId);
  const init = join(dir, 'init.mp4');
  const seg = join(dir, s.file);
  if (!existsSync(init) || !existsSync(seg)) return null;
  const pcm = await decodePcm(init, [seg], timeoutMs);
  if (!pcm.length) return null;
  const { peakDb, rmsDb } = peakRms(pcm, 0, pcm.length);
  const val: [number, number] = [Math.round(peakDb * 10) / 10, Math.round(rmsDb * 10) / 10];
  cache[String(s.seq)] = val;
  return val;
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

// ---- public API -------------------------------------------------------------
/** Longest window we will decode in full (EXACT mode). Beyond this we sample. */
const EXACT_MAX_MS = 15 * 60_000;
/** Wall-clock budget for one request's decoding work. */
const BUDGET_MS = 4500;
const MAX_SAMPLES = 220;

// ---- background cache primer ------------------------------------------------
//  A recording is finite, so the honest fix for "wide windows are slow the
//  first time" is to measure the whole thing ONCE, in the background, at low
//  concurrency. After that every zoom level is served from cache instantly.
//  One job per stream; newest segments first, because that is where an
//  operator starts. Cheap per segment (~70ms), and it yields between batches
//  so it never starves live encoding.
const priming = new Set<string>();

export function primeWaveformCache(streamId: string, fromMs: number, toMs: number): void {
  if (priming.has(streamId)) return;
  priming.add(streamId);
  void (async () => {
    try {
      const segs = audioSegmentsInRange(streamId, fromMs, toMs).reverse();  // newest first
      const todo = segs.filter((s) => !loadCache(streamId, s.runId)[String(s.seq)]);
      for (let i = 0; i < todo.length; i += 24) {
        const batch = todo.slice(i, i + 24);
        await pool(batch.map((s) => () => segmentPeak(streamId, s, 2500)), 4);
        for (const runId of new Set(batch.map((s) => s.runId))) saveCache(streamId, runId);
        await new Promise((r) => setTimeout(r, 40));   // yield to live work
      }
    } catch { /* priming is opportunistic */ } finally {
      priming.delete(streamId);
    }
  })();
}

export function isPriming(streamId: string): boolean { return priming.has(streamId); }

export async function waveform(streamId: string, fromMs: number, toMs: number, buckets: number): Promise<WaveformResult> {
  const from = Math.min(fromMs, toMs);
  const to = Math.max(fromMs, toMs);
  const n = Math.max(16, Math.min(1200, Math.round(buckets)));
  const bucketMs = (to - from) / n;
  const out: (WaveBucket | null)[] = new Array(n).fill(null);
  const segs = audioSegmentsInRange(streamId, from, to);
  const base: WaveformResult = {
    streamId, from, to, bucketMs, mode: 'exact', complete: true, pending: 0, buckets: out,
  };
  if (!segs.length) return base;

  // ---- EXACT: decode the whole window, one pass per run ---------------------
  if (to - from <= EXACT_MAX_MS) {
    const byRun = new Map<string, LocalSegment[]>();
    for (const s of segs) {
      if (!byRun.has(s.runId)) byRun.set(s.runId, []);
      byRun.get(s.runId)!.push(s);
    }
    const started = Date.now();
    for (const [runId, list] of byRun) {
      if (Date.now() - started > BUDGET_MS) { base.complete = false; break; }
      const dir = runDirOf(streamId, runId);
      const init = join(dir, 'init.mp4');
      if (!existsSync(init)) continue;
      const pcm = await decodePcm(init, list.map((s) => join(dir, s.file)),
        Math.max(1000, BUDGET_MS - (Date.now() - started)));
      if (!pcm.length) continue;
      // PCM is contiguous across the run's segments: map sample -> wall clock
      const runStart = list[0].startMs;
      for (let i = 0; i < n; i++) {
        const bStart = from + i * bucketMs;
        const bEnd = bStart + bucketMs;
        const s0 = Math.floor(((bStart - runStart) / 1000) * PCM_RATE);
        const s1 = Math.ceil(((bEnd - runStart) / 1000) * PCM_RATE);
        if (s1 <= 0 || s0 >= pcm.length) continue;
        const { peakDb, rmsDb } = peakRms(pcm, Math.max(0, s0), Math.min(pcm.length, s1));
        if (peakDb <= -100 && out[i]) continue;
        out[i] = { t: bStart, peak: dbToUnit(peakDb), rms: dbToUnit(rmsDb) };
      }
    }
    // In EXACT mode everything available was decoded: an empty bucket is a real
    // GAP in the recording, not work still to do. Only a budget cut-off (set
    // above) leaves the picture incomplete.
    base.pending = 0;
    return base;
  }

  // ---- SAMPLED: one representative segment per bucket -----------------------
  //
  //  A segment's measured peak describes its WHOLE duration, so it paints every
  //  bucket it overlaps, not just the one holding its midpoint. This matters as
  //  soon as a bucket is narrower than a segment — at a half-hour zoom on a
  //  900px lane a bucket is ~1.4s against a 4s segment, and painting only the
  //  midpoint bucket left two of every three columns blank. The result read as a
  //  picket fence rather than an envelope, which is worse than useless when the
  //  job is to find the quiet moment to cut on.
  base.mode = 'sampled';
  const segForBucket: (LocalSegment | null)[] = new Array(n).fill(null);
  for (const s of segs) {
    const b0 = Math.floor((s.startMs - from) / bucketMs);
    const b1 = Math.floor((s.startMs + Math.max(1, s.durMs) - 1 - from) / bucketMs);
    if (b1 < 0 || b0 >= n) continue;
    for (let i = Math.max(0, b0); i <= Math.min(n - 1, b1); i++) {
      if (!segForBucket[i]) segForBucket[i] = s;    // first segment wins the bucket
    }
  }

  interface Paint { seg: LocalSegment; buckets: number[] }
  const paint = new Map<string, Paint>();
  for (let i = 0; i < n; i++) {
    const s = segForBucket[i];
    if (!s) continue;
    const key = `${s.runId}/${s.seq}`;
    let e = paint.get(key);
    if (!e) { e = { seg: s, buckets: [] }; paint.set(key, e); }
    e.buckets.push(i);
  }
  const apply = (e: Paint, peakDb: number, rmsDb: number) => {
    for (const i of e.buckets) {
      out[i] = { t: from + i * bucketMs, peak: dbToUnit(peakDb), rms: dbToUnit(rmsDb) };
    }
  };

  // fill from cache first (free), then decode what is missing within budget
  const missing: Paint[] = [];
  for (const e of paint.values()) {
    const cached = loadCache(streamId, e.seg.runId)[String(e.seg.seq)];
    if (cached) apply(e, cached[0], cached[1]);
    else missing.push(e);
  }
  const take = missing.slice(0, MAX_SAMPLES);
  const started = Date.now();
  const results = await pool(take.map((e) => async () => {
    if (Date.now() - started > BUDGET_MS) return null;
    return segmentPeak(streamId, e.seg, 2500);
  }), 8);
  results.forEach((r, k) => { if (r) apply(take[k], r[0], r[1]) });
  for (const runId of new Set(take.map((e) => e.seg.runId))) saveCache(streamId, runId);

  base.pending = out.reduce<number>((acc, b, i) => acc + (b === null && segForBucket[i] ? 1 : 0), 0);
  base.complete = base.pending === 0;
  base.priming = isPriming(streamId);
  return base;
}
