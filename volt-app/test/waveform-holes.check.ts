// ============================================================================
//  WAVEFORM CONTIGUITY — where a hole in a run puts everything after it.
//
//  EXACT mode decodes a run's segments in one ffmpeg pass and maps sample
//  offsets onto the wall clock. That is only valid while the media is
//  contiguous: concatenating segments produces PCM that is continuous in
//  SAMPLES whether or not the recording is continuous in TIME.
//
//  With a hole in the middle of a run, anchoring the whole decode to the first
//  segment placed everything after the hole EARLIER by exactly the length of
//  the hole. Nothing errored, and the picture looked entirely plausible. A
//  waveform is where an editor picks in and out points, so being shown the
//  wrong moment is the whole failure: the clip comes out of the wrong part of
//  the programme.
//
//  resolve.ts already refuses to byte-join across a hole. This pins the rule
//  that the waveform agrees with it, and agrees at the same tolerance, because
//  two different answers to "is this contiguous" is its own bug.
//
//  Usage: npx tsx test/waveform-holes.check.ts   (no database, no ffmpeg)
// ============================================================================
import { __testing } from '../src/services/waveform';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);

const seg = (startMs: number, durMs = 4000, file = `seg_${startMs}.m4s`) =>
  ({ runId: 'R', rendition: 'audio', file, seq: startMs / 1000, startMs, durMs, uri: '' }) as any;

const { contiguousBlocks } = __testing;

// ---- the ordinary case -----------------------------------------------------
const solid = [seg(0), seg(4000), seg(8000), seg(12000)];
const b1 = contiguousBlocks(solid);
check('an unbroken run is one block', b1.length, 1);
check('holding every segment', b1[0].length, 4);

// ---- a hole ----------------------------------------------------------------
// Twelve seconds missing in the middle. Before the split, the second half was
// decoded into the same PCM stream and drawn twelve seconds to the left.
const holed = [seg(0), seg(4000), seg(20000), seg(24000)];
const b2 = contiguousBlocks(holed);
check('a hole splits the run into two blocks', b2.length, 2);
check('the first block ends at the hole', b2[0].length, 2);
check('and the second begins after it', b2[1][0].startMs, 20000);

// THE POINT. Each block is anchored to its OWN first segment, so the media
// after the hole is placed where it actually happened.
check('the second block anchors after the hole, not at the run start',
  b2[1][0].startMs, 20000);

// ---- the tolerance ---------------------------------------------------------
// Real encoder writes are not sample-exact. A few milliseconds of drift is the
// same segment following the last one, not a hole; the tolerance has to match
// the clip resolver's or the two will disagree about the same media.
const drifting = [seg(0), seg(4030), seg(8060)];
check('a few ms of write drift is not a hole', contiguousBlocks(drifting).length, 1);
const realGap = [seg(0), seg(4900)];
check('but most of a second is', contiguousBlocks(realGap).length, 2);

// ---- ordering --------------------------------------------------------------
// Segments arrive in directory order, which is not time order once a sequence
// wraps or a run is rebuilt. Splitting an unsorted list would invent holes.
const shuffled = [seg(8000), seg(0), seg(12000), seg(4000)];
const b3 = contiguousBlocks(shuffled);
check('an out-of-order list is sorted before splitting, not split into pieces', b3.length, 1);
check('and comes back in time order', b3[0][0].startMs, 0);

// ---- degenerate ------------------------------------------------------------
check('no segments is no blocks', contiguousBlocks([]).length, 0);
check('one segment is one block', contiguousBlocks([seg(0)]).length, 1);

console.log(`\nwaveform-holes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
