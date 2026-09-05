// ============================================================================
//  WAVEFORM ENVELOPE CACHE — a window measured once is served without decoding.
//
//  The clipping workbench was slow for two reasons that this pins:
//
//   1. EXACT windows (under 15 min) re-ran ffmpeg on every pan and zoom, because
//      the per-run cache held one peak per SEGMENT, which is no use at clip
//      zoom. The cache now also holds a 100ms envelope per segment, cut from
//      the same decode, so a second look at any part of a measured window is
//      served in about a millisecond.
//   2. The segment index re-read the head of every segment file on every call.
//      It now remembers what it has measured and touches only new files.
//
//  Builds a real fMP4 run with ffmpeg (loud 4s / quiet 4s alternating), places
//  it on the wall clock with mtimes, and checks: the picture is right, the
//  second call is served from cache, a legacy two-value cache is upgraded, the
//  background primer reports progress, and the index scan stays cheap.
//
//  Usage: ORIGIN_DIR=$(mktemp -d) npx tsx test/waveform-cache.check.ts   (needs ffmpeg)
// ============================================================================
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, utimesSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

process.env.ORIGIN_DIR = process.env.ORIGIN_DIR || join(process.cwd(), '.tmp-waveform-cache');
const originDir = process.env.ORIGIN_DIR;
rmSync(originDir, { recursive: true, force: true });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { waveform, primeWaveformCache, primingProgress } = require('../src/services/waveform') as typeof import('../src/services/waveform');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { audioSegmentsInRange, scanRun } = require('../src/services/localRecordingIndex') as typeof import('../src/services/localRecordingIndex');

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, cond: boolean, d = '') => (cond ? ok(m) : bad(m, d));

(async () => {
  const dir = join(originDir, 'st1', 'runs', 'r1', 'audio');
  mkdirSync(dir, { recursive: true });
  const ff = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=40',
    '-af', "volume='if(lt(mod(t,8),4),1.0,0.05)':eval=frame",
    '-c:a', 'aac', '-b:a', '64k', '-f', 'hls', '-hls_time', '4', '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', 'seg_%05d.m4s', '-hls_list_size', '0', 'live.m3u8',
  ], { cwd: dir });
  if (ff.status !== 0) { console.log('SKIP ffmpeg unavailable or failed'); process.exit(0); }
  // place the run on the wall clock: segment N finished writing at base + (N+1)*4s
  const base = Math.floor(Date.now() / 1000) - 600;
  for (let i = 0; i <= 10; i++) {
    const t = base + (i + 1) * 4;
    try { utimesSync(join(dir, `seg_${String(i).padStart(5, '0')}.m4s`), t, t); } catch { /* fewer segments */ }
  }

  const segs = audioSegmentsInRange('st1', 0, 9e15);
  check('index sees the run', segs.length >= 10, `got ${segs.length}`);
  const from = segs[0].startMs, to = segs[segs.length - 1].startMs + segs[segs.length - 1].durMs;

  let t = Date.now();
  let w = await waveform('st1', from, to, 200);
  const firstMs = Date.now() - t;
  check('exact window measured completely', w.mode === 'exact' && w.complete && w.coverage?.measured === segs.length, JSON.stringify(w.coverage));
  const peaks = w.buckets.map((b) => (b ? b.peak : 0));
  const loud = peaks.slice(5, 15).reduce((a, b) => a + b, 0) / 10;
  const quiet = peaks.slice(25, 35).reduce((a, b) => a + b, 0) / 10;
  check('loud seconds are louder than quiet seconds', loud > quiet * 5, `loud ${loud.toFixed(3)} quiet ${quiet.toFixed(3)}`);

  const cachePath = join(originDir, 'st1', 'runs', 'r1', '.peaks.json');
  const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, unknown[]>;
  check('every segment cached with a fine envelope', Object.values(cache).every((v) => v.length === 3), '');

  t = Date.now();
  w = await waveform('st1', from, to, 200);
  const secondMs = Date.now() - t;
  check('second look is served from cache (no decode)', secondMs < Math.max(20, firstMs / 4), `first ${firstMs}ms second ${secondMs}ms`);

  const z = await waveform('st1', from + 10_000, from + 13_000, 300);
  check('clip zoom (3s, 10ms buckets) is filled from the fine envelope', z.buckets.filter(Boolean).length === 300 && z.complete, `${z.buckets.filter(Boolean).length}`);

  const s = await waveform('st1', from - 3600e3, to + 3600e3, 400);
  check('wide window is sampled and complete from the same cache', s.mode === 'sampled' && s.complete, JSON.stringify({ mode: s.mode, complete: s.complete }));

  // legacy cache (two values per segment) upgrades on the exact path
  const legacy: Record<string, number[]> = {};
  for (const sg of segs) legacy[String(sg.seq)] = [-18, -21];
  writeFileSync(cachePath, JSON.stringify(legacy));
  delete require.cache[require.resolve('../src/services/waveform')];
  const W2 = require('../src/services/waveform') as typeof import('../src/services/waveform');
  w = await W2.waveform('st1', from, to, 100);
  const upgraded = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, unknown[]>;
  check('legacy two-value entries are upgraded in place', w.complete && Object.values(upgraded).every((v) => v.length === 3), '');

  // the primer measures a legacy cache and reports progress
  writeFileSync(cachePath, JSON.stringify(legacy));
  delete require.cache[require.resolve('../src/services/waveform')];
  const W3 = require('../src/services/waveform') as typeof import('../src/services/waveform');
  W3.primeWaveformCache('st1', from, to);
  const p0 = W3.primingProgress('st1');
  check('primer reports a total on start', !!p0 && p0.total === segs.length, JSON.stringify(p0));
  await new Promise((r) => setTimeout(r, 2500));
  const p1 = W3.primingProgress('st1');
  check('primer finishes and reports full progress', !!p1 && p1.measured === p1.total, JSON.stringify(p1));
  t = Date.now();
  w = await W3.waveform('st1', from, to, 100);
  check('after priming, exact is served from cache', Date.now() - t < 20 && w.complete, `${Date.now() - t}ms`);

  // index scan: cold reads every file, warm reads only new ones
  const big = join(originDir, 'st2', 'runs', 'r1', 'audio');
  mkdirSync(big, { recursive: true });
  copyFileSync(join(dir, 'init.mp4'), join(big, 'init.mp4'));
  for (let i = 0; i < 3000; i++) copyFileSync(join(dir, 'seg_00005.m4s'), join(big, `seg_${String(i).padStart(5, '0')}.m4s`));
  t = Date.now(); scanRun('st2', 'r1', 'audio'); const cold = Date.now() - t;
  await new Promise((r) => setTimeout(r, 1600));
  t = Date.now(); const warmList = scanRun('st2', 'r1', 'audio'); const warm = Date.now() - t;
  check('warm index scan is far cheaper than cold', warm * 5 < Math.max(cold, 25) && warmList.length === 3000, `cold ${cold}ms warm ${warm}ms`);
  copyFileSync(join(dir, 'seg_00005.m4s'), join(big, 'seg_03000.m4s'));
  await new Promise((r) => setTimeout(r, 1600));
  check('a new segment appears on the next scan', scanRun('st2', 'r1', 'audio').length === 3001, '');

  void primeWaveformCache; void primingProgress;
  rmSync(originDir, { recursive: true, force: true });
  console.log(`waveform-cache: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
