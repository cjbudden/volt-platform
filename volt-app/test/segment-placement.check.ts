// ============================================================================
//  Where recording segments sit on the wall clock (localRecordingIndex.ts
//  placeSegments), without a disk.
//
//  The first case is REAL: 24 segments of the ABC Jazz (HLS) station's run of
//  10 Oct 2026 17:28:38 (seq, tfdt at 44.1 kHz, write time in ms after the
//  first). The source delivers 10 s at a time, so the station wrote two or
//  three 4 s segments within 0.1 s, every 10 s. Placed at "written minus
//  duration" that recording showed a gap every 10 s (31 in the run) although
//  the media is continuous and played smoothly. Around it, the holes that must
//  still show: a missing segment, an encoder clock reset, a real stall, and a
//  steady encoder that must be placed exactly as before.
//
//  Usage: npx tsx test/segment-placement.check.ts
// ============================================================================
import { placeSegments, type SegmentFacts } from '../src/services/localRecordingIndex';

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { console.log('PASS ' + m); pass++; }
  else { console.log(`FAIL ${m} -- expected [${JSON.stringify(want)}] got [${JSON.stringify(got)}]`); fail++; }
};
const T0 = 1_791_617_318_859;
const gaps = (p: { startMs: number; durMs: number }[], min = 1500) => {
  const out: number[] = [];
  for (let i = 1; i < p.length; i++) { const g = p[i].startMs - (p[i - 1].startMs + p[i - 1].durMs); if (g > min) out.push(Math.round(g)); }
  return out;
};
const neverAfterWritten = (facts: SegmentFacts[], p: { startMs: number; durMs: number }[]) => p.every((x, i) => x.startMs + x.durMs <= facts[i].mtimeMs + 0.5);

// ---- the real ABC Jazz run
const ABC: [number, bigint, number][] = [
  [0, 0n, 0.0],
  [1, 177152n, 38.6],
  [2, 353280n, 10073.2],
  [3, 529409n, 10125.2],
  [4, 706560n, 20191.8],
  [5, 882688n, 20260.0],
  [6, 1058816n, 20348.0],
  [7, 1234944n, 30386.5],
  [8, 1412097n, 30455.3],
  [9, 1588224n, 40491.3],
  [10, 1764353n, 40552.8],
  [11, 1940480n, 40607.0],
  [12, 2117632n, 50732.9],
  [13, 2293760n, 50778.3],
  [14, 2469888n, 60887.3],
  [15, 2646016n, 60973.3],
  [16, 2823168n, 61047.1],
  [17, 2999296n, 71227.3],
  [18, 3175424n, 71294.2],
  [19, 3352576n, 81157.5],
  [20, 3528704n, 81256.8],
  [21, 3704832n, 81329.9],
  [22, 3880960n, 91444.2],
  [23, 4058112n, 91551.7],
];
const abc: SegmentFacts[] = ABC.map(([seq, tfdt, w]) => ({ seq, tfdt, mtimeMs: T0 + w }));
const pa = placeSegments(abc, 44100);
const old = abc.map((f, i) => { const d = i + 1 < abc.length ? Number((abc[i + 1].tfdt! - f.tfdt!) * 1000n / 44100n) : 3994; return { startMs: f.mtimeMs - d, durMs: d }; });
check('the old rule found false gaps every 10 s in this run', gaps(old).length >= 8, true);
check('placed by the media clock: no gaps at all', gaps(pa), []);
check('segments follow on exactly (each starts where the last ended)', pa.slice(1).every((x, i) => Math.abs(x.startMs - (pa[i].startMs + pa[i].durMs)) < 1), true);
check('durations are the measured 3.993 / 4.017 s (whole ms)', [...new Set(pa.map(x => x.durMs))].sort(), [3993, 4017]);
check('no segment is placed after it was written', neverAfterWritten(abc, pa), true);
check('the run covers 96 s of media (24 segments)', Math.round((pa[pa.length - 1].startMs + pa[pa.length - 1].durMs - pa[0].startMs) / 1000), 96);

// ---- a steady encoder: one 4 s segment written as each finishes, placed as before
const steady: SegmentFacts[] = Array.from({ length: 10 }, (_, i) => ({ seq: i, tfdt: BigInt(i * 360000), mtimeMs: T0 + (i + 1) * 4000 + (i % 3) * 30 }));
const ps = placeSegments(steady, 90000);
check('a steady encoder: no gaps', gaps(ps), []);
check('and the first segment where the old rule put it (written minus duration)', ps[0].startMs, steady[0].mtimeMs - 4000);

// ---- holes that are real must still show
const missing = steady.filter(f => f.seq < 4 || f.seq > 6);   // seq 4, 5, 6 pruned
const pm = placeSegments(missing, 90000);
check('three missing segments leave a 12 s hole', gaps(pm), [12000]);

const reset: SegmentFacts[] = [
  ...Array.from({ length: 4 }, (_, i) => ({ seq: i, tfdt: BigInt(500_000_000 + i * 360000), mtimeMs: T0 + (i + 1) * 4000 })),
  ...Array.from({ length: 4 }, (_, i) => ({ seq: 4 + i, tfdt: BigInt(i * 360000), mtimeMs: T0 + 30_000 + (i + 1) * 4000 })),
];
const pr = placeSegments(reset, 90000);
check('an encoder clock reset inside a run: the 14 s it was away shows as a hole', gaps(pr), [14000]);
check('and nothing lands in the future', neverAfterWritten(reset, pr), true);

const stall: SegmentFacts[] = Array.from({ length: 10 }, (_, i) => ({ seq: i, tfdt: BigInt(i * 360000), mtimeMs: T0 + (i + 1) * 4000 + (i >= 5 ? 60_000 : 0) }));
const pst = placeSegments(stall, 90000);
check('a 60 s stall with a continuous media clock shows as a 60 s hole', gaps(pst), [60000]);

const burstThenStall = abc.map((f, i) => ({ ...f, mtimeMs: f.mtimeMs + (i >= 12 ? 45_000 : 0) }));
const pbs = placeSegments(burstThenStall, 44100);
check('a burst source that also stalls 45 s: only the stall shows', gaps(pbs).length === 1 && Math.abs(gaps(pbs)[0] - 45_000) < 10_500, true);
check('and still nothing after it was written', neverAfterWritten(burstThenStall, pbs), true);

const shortStall: SegmentFacts[] = Array.from({ length: 4 }, (_, i) => ({ seq: i, tfdt: BigInt(i * 360000), mtimeMs: T0 + (i + 1) * 4000 + (i >= 2 ? 20_000 : 0) }));
check('a 20 s stall in a 4-segment run still shows', gaps(placeSegments(shortStall, 90000)), [20000]);
check('an empty run', placeSegments([], 90000), []);
check('a segment with no tfdt yet (still being written) takes its neighbour\'s length', placeSegments([{ seq: 0, tfdt: 0n, mtimeMs: T0 + 4000 }, { seq: 1, tfdt: 360000n, mtimeMs: T0 + 8000 }, { seq: 2, tfdt: null, mtimeMs: T0 + 12000 }], 90000).map(x => x.durMs), [4000, 4000, 4000]);

console.log(`\nsegment-placement.check: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
