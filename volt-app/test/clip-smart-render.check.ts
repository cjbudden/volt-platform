// ============================================================================
//  SMART RENDER, VALIDATED AGAINST THE FULL RENDER RATHER THAN A STOPWATCH.
//
//  Smart render re-encodes only the partial segment at each end and stream-copies
//  everything between, so its cost is flat -- roughly two segments -- whatever the
//  clip length. That is the whole point, and it is also why it is dangerous: the
//  saving comes from NOT decoding the middle, so nothing in the fast path ever
//  looks at the frames it is shipping.
//
//  THE FAILURE THIS SUITE EXISTS FOR is not a crash. It is a clip that plays.
//  Join a re-encoded end to a copied middle inside MP4 and only the FIRST part's
//  SPS/PPS survives into the output; the middle is then decoded against parameter
//  sets that are not its own. The result opens, seeks, and looks entirely
//  plausible in a screenshot, and is wrong in the edit suite. A duration check
//  would pass it. So the assertion here is FRAME-FOR-FRAME against the output of
//  the full render, which is slow, obvious, and correct by construction:
//
//    * the same number of video frames, exactly;
//    * the same presentation timestamps, in the same order, to the millisecond;
//    * the same duration.
//
//  If those three hold, the fast path produced the same film as the slow one.
//
//  ALSO ASSERTED, and easy to forget: that smart render actually RAN. It falls
//  back to the full render on any refusal or error, which is the right behaviour
//  and also means a completely broken smart path would leave every test green
//  while quietly doing nothing. `strategyPerBlock` is checked, not just the
//  output, so "it fell back every time" fails rather than passes.
//
//  Usage: npx tsx test/clip-smart-render.check.ts
//         (needs ffmpeg + ffprobe; builds its own media, touches no database)
// ============================================================================
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extract, plan, smartEligible, probeSource, probeDurationMs, seamFault } from '../src/services/clips/extract';
import type { Resolution, ResolvedBlock, ResolvedSegment } from '../src/services/clips/resolve';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const near = (m: string, got: number, want: number, tol: number) =>
  Math.abs(got - want) <= tol ? ok(m) : bad(m, `expected ~${want} (±${tol}) got ${got}`);

// The suite makes its own media. It used to read volt-app/media/audio, which
// nothing in the repo generates, so on any machine but the one it was written
// on it stopped at "test media missing" and proved nothing. VOLT_SMART_MEDIA
// still points it at hand-made media when someone wants to try a real capture.
const MEDIA = process.env.VOLT_SMART_MEDIA || join(tmpdir(), 'volt-smart-render-media');
const OUT = join(__dirname, '../out');
const SEG_MS = 4000;

/** Video frames and their PTS, in order. The ground truth for "same film". */
function frames(path: string): { n: number; pts: number[] } {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', path,
  ], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const pts = (r.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean)
    .map((v) => Math.round(parseFloat(v) * 1000)).filter((v) => Number.isFinite(v));
  return { n: pts.length, pts };
}

/**
 * Five-plus whole 4 s segments of 25 fps H.264 + AAC in fMP4, named the way the
 * recorder names them (init.mp4, seg_00000.m4s ...). A keyframe on every
 * segment boundary (-g 100 at 25 fps) is what a live run has, and is what lets
 * the middle be copied at all.
 */
function makeMedia(dir = MEDIA, fps = 25, x264: string[] = ['-preset', 'ultrafast']): void {
  mkdirSync(dir, { recursive: true });
  const gop = String(fps * SEG_MS / 1000);
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=${fps}:duration=24`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=24',
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', ...x264, '-pix_fmt', 'yuv420p',
    '-g', gop, '-keyint_min', gop, '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-start_number', '0',
    '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', join(dir, 'seg_%05d.m4s'),
    join(dir, 'index.m3u8'),
  ], { encoding: 'utf8' });
  if (r.status !== 0) console.log('ffmpeg: ' + (r.stderr || r.error));
}

function seg(i: number, takeFromMs: number, takeToMs: number, dir = MEDIA): ResolvedSegment {
  const startMs = i * SEG_MS;
  return {
    runId: 'run-1', rendition: 'audio', file: `seg_${String(i).padStart(5, '0')}.m4s`,
    seq: i, startMs, endMs: startMs + SEG_MS,
    path: join(dir, `seg_${String(i).padStart(5, '0')}.m4s`),
    takeFromMs, takeToMs,
    partial: takeFromMs > 0 || takeToMs < SEG_MS,
  };
}

function resolution(segs: ResolvedSegment[], fromMs: number, toMs: number, dir = MEDIA): Resolution {
  const block: ResolvedBlock = {
    runId: 'run-1', blockIndex: 0, rendition: 'audio',
    initPath: join(dir, 'init.mp4'),
    segments: segs, startMs: segs[0].startMs, endMs: segs[segs.length - 1].endMs,
  };
  return {
    streamId: 'stream-1', requestedFromMs: fromMs, requestedToMs: toMs, requestedMs: toMs - fromMs,
    blocks: [block], runCount: 1, gaps: [], coveredMs: toMs - fromMs, coveragePct: 100,
    effectiveFromMs: fromMs, effectiveToMs: toMs, kind: 'video',
    needsTrim: segs.some((s) => s.partial),
  };
}

(async () => {
  if (!existsSync(join(MEDIA, 'init.mp4'))) makeMedia();
  if (!existsSync(join(MEDIA, 'init.mp4'))) {
    console.log('FATAL test media missing and ffmpeg could not make it'); process.exit(1);
  }
  rmSync(OUT, { recursive: true, force: true });

  // A 15s range: 1.5s of segment 0, all of 1-3, 1.5s of segment 4.
  const FROM = 2500, TO = 17500;
  const segs = [seg(0, 2500, 4000), seg(1, 0, 4000), seg(2, 0, 4000), seg(3, 0, 4000), seg(4, 0, 1500)];
  const r = resolution(segs, FROM, TO);

  // ---- the plan ------------------------------------------------------------
  console.log('== the plan says what it will do, and what that saves ==');
  const p = plan(r);
  check('a trimmed range with a whole middle plans a smart render', p.strategy, 'smart-render');
  check('five segments are involved', p.segments, 5);
  check('two of them need re-encoding', p.smartRenderSegments, 2);
  check('and three are copied rather than decoded', p.segmentsSaved, 3);

  // ---- the gate ------------------------------------------------------------
  console.log('\n== the gate refuses anything it cannot join cleanly ==');
  const probe = await probeSource(join(MEDIA, 'seg_00001.m4s').replace('seg_00001.m4s', 'init.mp4'));
  const realProbe = await probeSource(join(OUT, 'nothing')) ?? null;
  check('a block of one segment is refused',
    smartEligible(resolution([seg(0, 1000, 3000)], 1000, 3000).blocks[0], { videoStreams: 1, videoCodec: 'h264' }).ok, false);
  check('a block of two is refused as well (both ends, no middle)',
    smartEligible(resolution([seg(0, 1000, 4000), seg(1, 0, 2000)], 1000, 6000).blocks[0], { videoStreams: 1, videoCodec: 'h264' }).ok, false);
  check('an unknown codec is refused rather than guessed at',
    smartEligible(r.blocks[0], { videoStreams: 1, videoCodec: 'vp9' }).ok, false);
  check('two video streams are refused',
    smartEligible(r.blocks[0], { videoStreams: 2, videoCodec: 'h264' }).ok, false);
  check('an unprobeable source is refused', smartEligible(r.blocks[0], null).ok, false);
  check('and a normal h264 block is allowed',
    smartEligible(r.blocks[0], { videoStreams: 1, videoCodec: 'h264' }).ok, true);
  check('probing a file that is not there returns null rather than throwing', realProbe, null);

  // ---- render both ways ----------------------------------------------------
  console.log('\n== the same range, rendered both ways ==');
  const fullDir = join(OUT, 'full'), smartDir = join(OUT, 'smart');
  const t0 = Date.now();
  const full = await extract({ resolution: r, outDir: fullDir, formats: ['mp4'], smartRender: false });
  const fullMs = Date.now() - t0;
  const t1 = Date.now();
  const smart = await extract({ resolution: r, outDir: smartDir, formats: ["mp4"], smartRender: true });
  const smartMs = Date.now() - t1;

  check('the full render reports the path it took', full.strategyPerBlock[0], 'full-render');
  // THE ONE THAT CATCHES A DEAD FAST PATH. Everything below would still pass if
  // smart render silently fell back on every block.
  check('the smart render actually ran, rather than falling back', smart.strategyPerBlock[0], 'smart-render');
  check('with nothing skipped', smart.smartRenderSkipped.length, 0);
  if (smart.smartRenderSkipped.length) console.log('     skipped: ' + smart.smartRenderSkipped.join('; '));

  const fullMp4 = join(fullDir, 'clip.mp4'), smartMp4 = join(smartDir, 'clip.mp4');
  check('both produced an mp4', existsSync(fullMp4) && existsSync(smartMp4), true);

  // ---- frame for frame -----------------------------------------------------
  console.log('\n== and they are the same film, frame for frame ==');
  const F = frames(fullMp4), S = frames(smartMp4);
  check('the same number of video frames', S.n, F.n);
  check('and it is the number 15 seconds at 25fps should give', F.n, 375);

  let firstDiff = -1;
  for (let i = 0; i < Math.min(F.pts.length, S.pts.length); i++) {
    if (Math.abs(F.pts[i] - S.pts[i]) > 1) { firstDiff = i; break; }
  }
  // A DRIFTING JOIN SHOWS UP HERE AND NOWHERE ELSE. If the copied middle were
  // decoded against the wrong parameter sets, or an AAC priming gap pushed the
  // tail late, the sequences diverge at the seam and this names the frame.
  check('every presentation timestamp matches', firstDiff, -1);
  if (firstDiff >= 0) {
    console.log(`     first divergence at frame ${firstDiff}: full=${F.pts[firstDiff]}ms smart=${S.pts[firstDiff]}ms`);
  }

  const fullDur = await probeDurationMs(fullMp4);
  const smartDur = await probeDurationMs(smartMp4);
  near('the durations agree', smartDur ?? -1, fullDur ?? -2, 40);
  near('and both are the 15s that was asked for', smartDur ?? -1, 15000, 80);

  // ---- the seams themselves -----------------------------------------------
  // Item 1.5. The PTS comparison above found the tail seam (frame 338 one step
  // late) because the concat demuxer started each part at its file's length,
  // which runs to the end of the AAC, not of the picture. These look at the
  // seams directly: packet timestamps, sorted, every step one frame.
  console.log('\n== no gap and no overlap at either seam ==');
  check('the smart render has no gap or overlap anywhere', await seamFault(smartMp4, 'ffprobe', 40), null);
  check('nor does the full render it is compared with', await seamFault(fullMp4, 'ffprobe', 40), null);
  const S338 = S.pts[338] - S.pts[337];
  check('the step across the tail seam (frames 337 to 338) is one frame', S338, 40);
  const S37 = S.pts[38] - S.pts[37];
  check('and so is the step across the head seam (frames 37 to 38)', S37, 40);

  // THE CHECK MUST BE ABLE TO FAIL. A file with a 23ms jump in it, the size of
  // the old seam, is reported, so a pass above means something.
  const gapped = join(OUT, 'gapped.mp4');
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=2',
    // A millisecond time base first, or the 23ms rounds away into 1/25s ticks.
    '-vf', 'settb=1/1000,setpts=PTS+gte(N\\,20)*23', '-fps_mode', 'passthrough', '-enc_time_base', '1/1000',
    '-c:v', 'libx264', '-preset', 'ultrafast', gapped], { encoding: 'utf8' });
  const g = await seamFault(gapped, 'ffprobe', 40);
  check('a 23ms jump planted at frame 20 is caught', /^gap of 23\.0ms before frame 20/.test(g ?? ''), true);
  if (g) console.log('     ' + g);

  // ---- a second source: 50fps with B-frames ------------------------------
  // The live encoder's own shape, not the fixture's: B-frames reorder the
  // picture, so presentation order differs from packet order and the first
  // picture does not sit at the start of its file. A cut on different frame
  // boundaries at each end, so neither seam lands where the first one did.
  console.log('\n== the same at 50fps with B-frames, cut elsewhere ==');
  const MEDIA50 = MEDIA + '-50b';
  if (!existsSync(join(MEDIA50, 'init.mp4'))) makeMedia(MEDIA50, 50, ['-preset', 'veryfast', '-bf', '3']);
  const F50 = 1300, T50 = 14700;
  const segs50 = [seg(0, 1300, 4000, MEDIA50), seg(1, 0, 4000, MEDIA50), seg(2, 0, 4000, MEDIA50), seg(3, 0, 2700, MEDIA50)];
  const r50 = resolution(segs50, F50, T50, MEDIA50);
  const full50 = await extract({ resolution: r50, outDir: join(OUT, 'full50'), formats: ['mp4'], smartRender: false });
  const smart50 = await extract({ resolution: r50, outDir: join(OUT, 'smart50'), formats: ['mp4'], smartRender: true });
  check('the full render ran', full50.strategyPerBlock[0], 'full-render');
  check('the smart render ran, rather than falling back', smart50.strategyPerBlock[0], 'smart-render');
  if (smart50.smartRenderSkipped.length) console.log('     skipped: ' + smart50.smartRenderSkipped.join('; '));
  const F5 = frames(join(OUT, 'full50', 'clip.mp4')), S5 = frames(join(OUT, 'smart50', 'clip.mp4'));
  check('13.4s at 50fps is 670 frames, in the full render', F5.n, 670);
  check('and in the smart render', S5.n, 670);
  let diff50 = -1;
  for (let i = 0; i < Math.min(F5.pts.length, S5.pts.length); i++) {
    if (Math.abs(F5.pts[i] - S5.pts[i]) > 1) { diff50 = i; break; }
  }
  check('every presentation timestamp matches the full render', diff50, -1);
  if (diff50 >= 0) console.log(`     first divergence at frame ${diff50}: full=${F5.pts[diff50]}ms smart=${S5.pts[diff50]}ms`);
  check('and there is no gap or overlap at any seam', await seamFault(join(OUT, 'smart50', 'clip.mp4'), 'ffprobe', 20), null);

  // ---- the saving ----------------------------------------------------------
  console.log('\n== the saving is real, and is reported rather than assumed ==');
  const fullBytes = statSync(fullMp4).size, smartBytes = statSync(smartMp4).size;
  console.log(`     full  ${fullMs}ms  ${(fullBytes / 1e6).toFixed(2)}MB`);
  console.log(`     smart ${smartMs}ms  ${(smartBytes / 1e6).toFixed(2)}MB`);
  check('smart render is not slower than the full render', smartMs <= fullMs, true);
  // The copied middle keeps its original bitrate, so the output should be in the
  // same ballpark rather than re-compressed to something smaller.
  check('and the output is not silently re-compressed',
    smartBytes > fullBytes * 0.5, true);

  // ---- a range needing no trim at all --------------------------------------
  console.log('\n== a range on segment boundaries never renders at all ==');
  const whole = resolution([seg(1, 0, 4000), seg(2, 0, 4000), seg(3, 0, 4000)], 4000, 16000);
  check('it plans a copy', plan(whole).strategy, 'copy');
  check('and claims no saving, because there was nothing to save', plan(whole).segmentsSaved, 0);

  rmSync(OUT, { recursive: true, force: true });
  console.log(`\nclip-smart-render: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
