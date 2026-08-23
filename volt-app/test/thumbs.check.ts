// ============================================================================
//  KEYFRAME THUMBNAILS — the video half of the media lane.
//
//  Self-contained by construction: the suite ENCODES its own short run with
//  ffmpeg, using the same muxer shape the encoder writes (fMP4 CMAF, closed GOP
//  one segment long, a forced keyframe on every boundary). That matters more
//  than convenience. The whole reason extracting a frame is cheap is that every
//  segment starts on an IDR and decodes alone, so a fixture that did not have
//  that property would test nothing worth knowing.
//
//  The source is testsrc2, which moves: consecutive frames differ, so "the strip
//  shows different moments" is a claim that can actually be checked rather than
//  assumed.
//
//  Usage: DATABASE_URL=... npx tsx test/thumbs.check.ts
// ============================================================================
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from '../src/db';
import { originBaseFor } from '../src/services/liveOrigin';
import { thumbStrip, primeThumbs, isThumbPriming } from '../src/services/thumbs';
import { scanRun, pickRenditions } from '../src/services/localRecordingIndex';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected truthy, got [${String(v)}]`));

const STREAM = 'thumbtest-0000-4000-8000-000000000001';
const RUN = '20260101T000000Z';
const REND = '720p';
const SEG_S = 4, FPS = 25, DUR_S = 48;      // twelve segments

function encodeRun(): boolean {
  const dir = join(originBaseFor(STREAM), 'runs', RUN, REND);
  rmSync(originBaseFor(STREAM), { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const gop = String(SEG_S * FPS);
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=${FPS}:duration=${DUR_S}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '600k',
    '-g', gop, '-keyint_min', gop, '-sc_threshold', '0',
    '-force_key_frames', `expr:gte(t,n_forced*${SEG_S})`,
    '-f', 'hls', '-hls_time', String(SEG_S), '-hls_playlist_type', 'vod',
    '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', join(dir, 'seg_%05d.m4s'),
    '-y', join(dir, 'index.m3u8'),
  ], { encoding: 'utf8' });
  if (r.status !== 0) { console.log('ffmpeg failed:', (r.stderr ?? '').slice(0, 400)); return false; }

  // Placement comes from write times, so they have to describe a plausible run
  // rather than the instant the test happened to encode it.
  const base = Math.floor(Date.now() / 1000) - 3600;
  const files = readdirSync(dir).filter((f) => /^seg_\d+\.m4s$/.test(f)).sort();
  files.forEach((f, i) => {
    const t = base + (i + 1) * SEG_S;
    utimesSync(join(dir, f), t, t);
  });
  utimesSync(join(dir, 'init.mp4'), base, base);
  return true;
}

/** A JPEG's dimensions, read from its SOF marker. */
function jpegSize(path: string): { w: number; h: number } | null {
  const b = readFileSync(path);
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i < b.length - 9) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

async function main() {
  if (!encodeRun()) { console.log('SKIP: ffmpeg could not produce a test run'); process.exit(0); }

  const segs = scanRun(STREAM, RUN, REND);
  check('the encoded run has twelve segments', segs.length, 12);
  check('and is seen as a video rendition', pickRenditions(STREAM, RUN).video, REND);
  const from = segs[0].startMs;
  const to = segs[segs.length - 1].startMs + segs[segs.length - 1].durMs;
  truthy('the run spans about the encoded duration',
    Math.abs((to - from) - DUR_S * 1000) < 2000);

  // ---- a cold strip -------------------------------------------------------
  const t0 = Date.now();
  const strip = await thumbStrip(STREAM, from, to, 6);
  const coldMs = Date.now() - t0;
  check('every slot comes back', strip.thumbs.length, 6);
  check('all six are filled from real media', strip.thumbs.filter(Boolean).length, 6);
  check('and the strip reports itself complete', strip.complete, true);
  check('with nothing pending', strip.pending, 0);
  check('frames are 16:9 at the lane height', `${strip.width}x${strip.height}`, '160x90');
  truthy(`a cold strip of six is quick (${coldMs}ms)`, coldMs < 15000);

  // ---- the frames are real pictures, of different moments -----------------
  const paths = strip.thumbs.filter(Boolean).map((t) =>
    join(originBaseFor(STREAM), 'runs', t!.runId, 'thumbs',
      `${REND}-${String(t!.seq).padStart(5, '0')}.jpg`));
  check('every frame was written to disk', paths.filter((p) => existsSync(p)).length, 6);
  truthy('and none of them is empty', paths.every((p) => statSync(p).size > 500));
  const sizes = paths.map((p) => jpegSize(p));
  truthy('every frame is a decodable JPEG', sizes.every((s) => !!s));
  check('scaled to the requested height', sizes[0]?.h, 90);
  // The source moves, so identical bytes across the strip would mean every slot
  // took its picture from the same segment.
  const digests = paths.map((p) => readFileSync(p).length + ':' + readFileSync(p).subarray(0, 64).toString('hex'));
  check('the frames are of different moments', new Set(digests).size, 6);

  // ---- placement is the frame's own time, not the slot's ------------------
  const seqs = strip.thumbs.filter(Boolean).map((t) => t!.seq);
  check('frames come from distinct segments', new Set(seqs).size, 6);
  check('and in time order', seqs.join(',') , [...seqs].sort((a, b) => a - b).join(','));
  const inWindow = strip.thumbs.filter(Boolean).every((t) => t!.t >= from - 5000 && t!.t <= to + 5000);
  check('every frame is placed inside the window it came from', inWindow, true);

  // ---- a warm strip is free ----------------------------------------------
  const t1 = Date.now();
  const again = await thumbStrip(STREAM, from, to, 6);
  const warmMs = Date.now() - t1;
  check('a second look returns the same frames',
    again.thumbs.map((t) => t?.seq ?? -1).join(','), strip.thumbs.map((t) => t?.seq ?? -1).join(','));
  truthy(`and costs almost nothing (${warmMs}ms)`, warmMs < 500);

  // ---- a window with no media draws nothing -------------------------------
  const empty = await thumbStrip(STREAM, from - 3_600_000, from - 3_500_000, 6);
  check('a window before the run is empty', empty.thumbs.filter(Boolean).length, 0);
  check('and says so rather than reporting work to do', empty.complete, true);

  // ---- a slot with no media stays empty rather than borrowing a neighbour --
  // Half the window is the run, half is empty air after it. The empty half must
  // not be filled with the nearest frame: that would claim coverage that is not
  // there, which is the whole reason the lane draws gaps as gaps.
  const wide = await thumbStrip(STREAM, from, to + (to - from), 8);
  const filled = wide.thumbs.filter(Boolean).length;
  truthy(`only the recorded half is drawn (${filled}/8)`, filled >= 3 && filled <= 5);
  const lastFilled = wide.thumbs.reduce((n, t, i) => (t ? i : n), -1);
  truthy('and the empty half is at the end', lastFilled < 6);

  // ---- priming ------------------------------------------------------------
  rmSync(join(originBaseFor(STREAM), 'runs', RUN, 'thumbs'), { recursive: true, force: true });
  primeThumbs(STREAM, from, to);
  truthy('priming reports itself as running', isThumbPriming(STREAM));
  for (let i = 0; i < 60 && isThumbPriming(STREAM); i++) await new Promise((r) => setTimeout(r, 250));
  check('and finishes', isThumbPriming(STREAM), false);
  const primed = readdirSync(join(originBaseFor(STREAM), 'runs', RUN, 'thumbs')).filter((f) => f.endsWith('.jpg'));
  check('having extracted a frame for every segment', primed.length, 12);
  truthy('with no temporary files left behind',
    readdirSync(join(originBaseFor(STREAM), 'runs', RUN, 'thumbs')).every((f) => !f.includes('.tmp')));

  rmSync(originBaseFor(STREAM), { recursive: true, force: true });
  console.log(`\nthumbs: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
