// ============================================================================
//  SMART RENDER, PICTURE BY PICTURE, AND THE EXACT CLIP (build queue 3.2-2).
//
//  clip-smart-render.check.ts proves the smart render has the same frame count,
//  the same timestamps and no seam. That is the shape of the film. This suite
//  proves its CONTENT: every picture in the clip is the source picture it
//  should be, at every position, on several sources, and the smart render
//  matches the full render picture for picture. It is the evidence behind
//  turning smart render on by default (Christian, 3 Nov: "make it the default
//  only if every frame matches; full render stays the fallback").
//
//  HOW A PICTURE IS IDENTIFIED. Each clip and its source are decoded to small
//  greyscale frames (96x54). For clip frame i, every source frame within three
//  of where it should be is compared (mean absolute difference); the closest
//  must be exactly the expected one. Adjacent source frames differ by about 2.5
//  on this pattern while a re-encode of the same frame differs by well under
//  that, so an off-by-one anywhere (a seam one frame late, a head that starts a
//  frame early) names itself rather than averaging away.
//
//  THE EXACT CLIP is the prototype's last assertion (volt-frame-proto/test.mjs:
//  frames 110 to 185 inclusive is 76 frames). A clip is asked for as In and Out
//  FRAMES here, turned into milliseconds the way a client must: In at the
//  start of the In frame, Out at the start of the frame after Out, both rounded
//  DOWN to the millisecond (at 29.97 a frame starts at a fraction of a ms, and
//  rounding up would drop the In frame). The first and last pictures must be
//  the In and Out frames.
//
//  Usage: npx tsx test/smart-render-frames.check.ts
//         (needs ffmpeg + ffprobe; builds its own media, touches no database)
// ============================================================================
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extract, plan } from '../src/services/clips/extract';
import type { Resolution, ResolvedBlock, ResolvedSegment } from '../src/services/clips/resolve';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);

const ROOT = join(tmpdir(), 'volt-smart-frames');
const W = 96, H = 54, FB = W * H;

interface Source {
  name: string;
  dir: string;
  fps: number;               // frames per second, exactly (30000/1001 for 29.97)
  framesPerSegment: number;
  segments: { file: string; startMs: number; endMs: number }[];
  pictures: Buffer[];        // every source frame, decoded, in presentation order
}

/** A recording-shaped source: fMP4 segments of a whole number of frames, a
 *  keyframe on every boundary, the way the live encoder writes them. */
function makeSource(name: string, rate: string, framesPerSegment: number, segments: number, x264: string[], audio = false): Source {
  const dir = join(ROOT, name);
  const [num, den] = rate.split('/').map(Number);
  const fps = num / (den || 1);
  const frames = framesPerSegment * segments;
  if (!existsSync(join(dir, 'index.m3u8'))) {
    mkdirSync(dir, { recursive: true });
    const r = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=${rate}`,
      '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-map', '0:v', ...(audio ? ['-map', '1:a'] : []), '-frames:v', String(frames),
      '-c:v', 'libx264', ...x264, '-pix_fmt', 'yuv420p',
      '-g', String(framesPerSegment), '-keyint_min', String(framesPerSegment), '-sc_threshold', '0',
      ...(audio ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-shortest'] : []),
      '-f', 'hls', '-hls_time', String(framesPerSegment / fps), '-hls_list_size', '0', '-start_number', '0',
      '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', join(dir, 'seg_%05d.m4s'),
      join(dir, 'index.m3u8'),
    ], { encoding: 'utf8' });
    if (r.status !== 0) console.log('ffmpeg: ' + (r.stderr || r.error));
  }
  // Segment times from the frame count, not from EXTINF: every segment holds
  // exactly framesPerSegment pictures, so its start is that many frame times on.
  const segs = [];
  for (let i = 0; i < segments; i++) {
    segs.push({
      file: `seg_${String(i).padStart(5, '0')}.m4s`,
      startMs: (i * framesPerSegment * 1000) / fps,
      endMs: ((i + 1) * framesPerSegment * 1000) / fps,
    });
  }
  return { name, dir, fps, framesPerSegment, segments: segs, pictures: decode(join(dir, 'index.m3u8')) };
}

/** Every picture of a file as small greyscale frames, in presentation order. */
function decode(path: string): Buffer[] {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:v:0',
    '-vf', `scale=${W}:${H},format=gray`, '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'],
    { maxBuffer: 1 << 30 });
  const d = r.stdout as Buffer;
  const out: Buffer[] = [];
  for (let i = 0; i + FB <= d.length; i += FB) out.push(d.subarray(i, i + FB));
  return out;
}

const mad = (a: Buffer, b: Buffer) => { let s = 0; for (let i = 0; i < FB; i++) s += Math.abs(a[i] - b[i]); return s / FB; };

/** The clip [inF, outF] (frames, inclusive) as a Resolution over the source. */
function clipOf(src: Source, inF: number, outF: number): { r: Resolution; fromMs: number; toMs: number } {
  const fromMs = Math.floor((inF * 1000) / src.fps);
  const toMs = Math.floor(((outF + 1) * 1000) / src.fps);
  const segs: ResolvedSegment[] = [];
  src.segments.forEach((s, i) => {
    if (s.endMs <= fromMs || s.startMs >= toMs) return;
    const takeFromMs = Math.max(0, fromMs - s.startMs);
    const takeToMs = Math.min(s.endMs, toMs) - s.startMs;
    segs.push({
      runId: 'run-1', rendition: 'video', file: s.file, seq: i,
      startMs: s.startMs, endMs: s.endMs, path: join(src.dir, s.file),
      takeFromMs, takeToMs,
      // A sliver under a millisecond is rounding, not a partial segment.
      partial: takeFromMs > 0.5 || takeToMs < s.endMs - s.startMs - 0.5,
    });
  });
  const block: ResolvedBlock = {
    runId: 'run-1', blockIndex: 0, rendition: 'video', initPath: join(src.dir, 'init.mp4'),
    segments: segs, startMs: segs[0].startMs, endMs: segs[segs.length - 1].endMs,
  };
  const r: Resolution = {
    streamId: 'stream-1', requestedFromMs: fromMs, requestedToMs: toMs, requestedMs: toMs - fromMs,
    blocks: [block], runCount: 1, gaps: [], coveredMs: toMs - fromMs, coveragePct: 100,
    effectiveFromMs: fromMs, effectiveToMs: toMs, kind: 'video',
    needsTrim: segs.some((s) => s.partial),
  };
  return { r, fromMs, toMs };
}

/** Which source frame each clip picture is: the closest within +-3 of where it
 *  should be. Returns the first position that is not the expected frame. */
function identify(src: Source, pics: Buffer[], inF: number): { wrongAt: number; got: number; worstSame: number; nearestOther: number } {
  let worstSame = 0, nearestOther = Infinity;
  for (let i = 0; i < pics.length; i++) {
    const want = inF + i;
    let best = -1, bestD = Infinity;
    for (let k = Math.max(0, want - 3); k <= Math.min(src.pictures.length - 1, want + 3); k++) {
      const d = mad(pics[i], src.pictures[k]);
      if (d < bestD) { bestD = d; best = k; }
      if (k !== want) nearestOther = Math.min(nearestOther, d);
    }
    if (best !== want) return { wrongAt: i, got: best, worstSame, nearestOther };
    worstSame = Math.max(worstSame, bestD);
  }
  return { wrongAt: -1, got: -1, worstSame, nearestOther };
}

async function oneClip(src: Source, inF: number, outF: number, label: string, expectSmart = true): Promise<void> {
  console.log(`\n== ${label}: ${src.name}, frames ${inF} to ${outF} ==`);
  const { r } = clipOf(src, inF, outF);
  const out = join(ROOT, 'out', `${src.name}-${inF}-${outF}`);
  rmSync(out, { recursive: true, force: true });
  const full = await extract({ resolution: r, outDir: join(out, 'full'), formats: ['mp4'], smartRender: false });
  // No flag: the default. It is the smart render now, which is what this checks.
  const smart = await extract({ resolution: r, outDir: join(out, 'smart'), formats: ['mp4'] });
  check('the full render ran when asked for', full.strategyPerBlock[0], 'full-render');
  check(expectSmart ? 'the default ran the smart render, with no fallback' : 'the default fell back to the full render',
    smart.strategyPerBlock[0], expectSmart ? 'smart-render' : 'full-render');
  if (smart.smartRenderSkipped.length) console.log('     skipped: ' + smart.smartRenderSkipped.join('; '));

  const F = decode(join(out, 'full', 'clip.mp4'));
  const S = decode(join(out, 'smart', 'clip.mp4'));
  const want = outF - inF + 1;
  check(`the exact clip is ${want} frames, In to Out inclusive (full render)`, F.length, want);
  check(`and ${want} frames in the smart render`, S.length, want);

  const fi = identify(src, F, inF), si = identify(src, S, inF);
  check('every full render picture is the source frame it should be', fi.wrongAt, -1);
  if (fi.wrongAt >= 0) console.log(`     full: picture ${fi.wrongAt} is source frame ${fi.got}, wanted ${inF + fi.wrongAt}`);
  check('every smart render picture is the source frame it should be', si.wrongAt, -1);
  if (si.wrongAt >= 0) console.log(`     smart: picture ${si.wrongAt} is source frame ${si.got}, wanted ${inF + si.wrongAt}`);
  console.log(`     worst match to its own frame ${si.worstSame.toFixed(2)}, nearest other frame ${si.nearestOther.toFixed(2)}`);
  check('and the identification has margin (own frame closer than any neighbour by 2x)',
    si.worstSame * 2 < si.nearestOther && fi.worstSame * 2 < fi.nearestOther, true);

  // Picture for picture against the full render: the same frame both times,
  // only encoder noise between them.
  let worst = 0, at = -1;
  for (let i = 0; i < Math.min(F.length, S.length); i++) {
    const d = mad(F[i], S[i]);
    if (d > worst) { worst = d; at = i; }
  }
  console.log(`     smart against full: worst picture difference ${worst.toFixed(2)} at ${at}`);
  check('the smart render matches the full render picture for picture', worst < si.nearestOther, true);
  check('the first picture is the In frame', mad(S[0], src.pictures[inF]) < si.nearestOther, true);
  check('the last picture is the Out frame', mad(S[S.length - 1], src.pictures[outF]) < si.nearestOther, true);
}

(async () => {
  rmSync(join(ROOT, 'out'), { recursive: true, force: true });
  const s25 = makeSource('25', '25', 100, 6, ['-preset', 'ultrafast']);
  const s50 = makeSource('50b', '50', 200, 4, ['-preset', 'veryfast', '-bf', '3']);
  const s2997 = makeSource('2997b', '30000/1001', 120, 5, ['-preset', 'veryfast', '-bf', '2']);
  for (const s of [s25, s50, s2997]) {
    if (s.pictures.length !== s.framesPerSegment * s.segments.length) {
      console.log(`FATAL source ${s.name} decoded ${s.pictures.length} frames`); process.exit(1);
    }
  }

  // Three sources, cuts on different frames at each end, so no seam lands on
  // the same place twice. Plus a head on a segment boundary (tail only), and a
  // clip inside one segment, which smart render must refuse and hand back.
  await oneClip(s25, 62, 436, 'a 15 s clip at 25 fps');
  await oneClip(s50, 67, 733, 'B-frames at 50 fps');
  await oneClip(s2997, 50, 430, 'B-frames at 29.97 fps');
  await oneClip(s25, 100, 357, 'a head on a segment boundary, the tail cut');
  await oneClip(s25, 110, 185, "the prototype's exact clip, 76 frames", false);
  // The recorder writes video and audio as separate renditions, so the sources
  // above are video only. A source with its audio muxed in, picture starting
  // after the audio (the shape of clip-smart-render.check.ts's fixture), is
  // checked too: packaged ladders can arrive like this.
  const s25a = makeSource('25a', '25', 100, 6, ['-preset', 'ultrafast'], true);
  await oneClip(s25a, 62, 436, 'video with its audio muxed in, 25 fps');

  // A clip inside one segment has no whole middle to copy, so it is planned
  // and run as a full render from the start: nothing is tried and nothing is
  // reported as skipped.
  console.log('\n== a clip inside one segment is a full render, as planned ==');
  const { r } = clipOf(s25, 110, 185);
  check('it is planned as a full render', plan(r).strategy, 'full-render');
  const one = await extract({ resolution: r, outDir: join(ROOT, 'out', 'one'), formats: ['mp4'] });
  check('and run as one, with no smart render attempted', one.smartRenderSkipped.length, 0);

  rmSync(join(ROOT, 'out'), { recursive: true, force: true });
  console.log(`\nsmart-render-frames: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
