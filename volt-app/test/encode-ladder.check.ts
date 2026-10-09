// ============================================================================
//  WHICH RUNGS GET ENCODED, AND WHY.
//
//  The requirement is that a file encode match the live transcoder. The way that
//  is achieved is a ladder group that TRACKS a live output profile rather than
//  copying its numbers, so this suite's first job is to prove that tracking is
//  real: change the live profile, and the file ladder changes with no write of
//  its own.
//
//  The rest is the upscale cap, and the three ways it goes wrong:
//
//    A SOURCE WHOSE HEIGHT WAS NOT MEASURED. This is the one that matters most,
//    and it is the shape of bug this codebase keeps finding: null read as zero.
//    Zero is below every rung, so every rung is dropped, and the asset ends up
//    with no renditions while the log says the source was too small. Absent must
//    mean absent — encode the full ladder and SAY that nothing was measured,
//    which is a different fact from "everything fitted".
//
//    A SOURCE BELOW EVERY RUNG. Dropping all of them leaves an encode that
//    produced nothing and reported success. The lowest rung is adapted to the
//    source's own height instead: playable, and still not an upscale.
//
//    A TRACKING GROUP WHOSE PROFILE HAS GONE. Falling back to the group's own
//    members means encoding to an empty ladder and calling it a success. It has
//    to be an error.
//
//  Usage: npx tsx test/encode-ladder.check.ts   (no database, no ffmpeg)
// ============================================================================
import {
  resolveLadder, fitToSource, describeFit,
  type LadderGroupRow, type Rung, type ResolvedLadder,
} from '../src/services/encode/ladder';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
function threw(m: string, f: () => unknown, match: RegExp) {
  try { f(); bad(m, 'it did not throw'); }
  catch (e: any) {
    match.test(String(e?.message ?? e)) ? ok(m)
      : bad(m, `threw the wrong thing: ${String(e?.message ?? e)}`);
  }
}

const LIVE: Rung[] = [
  { height: 1080, bitrate_kbps: 5000 },
  { height: 720, bitrate_kbps: 3000 },
  { height: 480, bitrate_kbps: 1200 },
  { height: 360, bitrate_kbps: 600 },
];

const group = (over: Partial<LadderGroupRow> = {}): LadderGroupRow => ({
  id: 'g1', name: 'Standard', tracks_output_profile_id: null,
  segment_dur: 4, fps: 25, packaging: 'both', codec_backend: 'x264',
  cap_to_source: true, ...over,
});

const heights = (rs: Rung[]) => rs.map((r) => r.height).join(',');

(async () => {
  // ---- tracking is the whole point -----------------------------------------
  console.log('== a tracking group reads the live rungs, it does not hold a copy ==');
  const tracked = group({ tracks_output_profile_id: 'op-1', segment_dur: 6, fps: 50 });
  const r1 = resolveLadder(tracked, {
    trackedRungs: LIVE, trackedProfileName: 'Live HD',
    trackedSegmentDur: 4, trackedFps: 25,
  });
  check('the rungs came from the live profile', heights(r1.rungs), '1080,720,480,360');
  check('and it says where they came from', r1.origin.kind, 'tracked');
  // THE GOP HAS TO MATCH. Segment x fps is the GOP, so a file encoded at a
  // different segment length has its keyframes in different places from the
  // channel it is supposed to match, and the two do not splice.
  check('the segment length came from the live profile, not the group', r1.segmentSeconds, 4);
  check('and so did the frame rate', r1.fps, 25);

  console.log('\n== change the live profile and the file ladder changes with it ==');
  const retuned = LIVE.map((r) => (r.height === 720 ? { ...r, bitrate_kbps: 2600 } : r));
  const r2 = resolveLadder(tracked, { trackedRungs: retuned, trackedSegmentDur: 4, trackedFps: 25 });
  check('the 720p rung followed the live change',
    r2.rungs.find((r) => r.height === 720)?.bitrate_kbps, 2600);
  // This is the assertion the whole design exists for: nothing was written to
  // the ladder group, and it still matches.
  check('with no rungs stored on the group at all',
    (tracked as any).rungs === undefined, true);

  console.log('\n== a tracking group whose profile has gone is an ERROR ==');
  threw('an empty tracked profile refuses rather than encoding nothing',
    () => resolveLadder(tracked, { trackedRungs: [] }), /no rungs|deleted/);
  threw('and so does a group with no members and no tracking',
    () => resolveLadder(group(), { memberRungs: [] }), /no renditions/);

  console.log('\n== a standalone group uses its own members ==');
  const own = resolveLadder(group(), { memberRungs: [{ height: 480, bitrate_kbps: 1000 }] });
  check('its rungs are its members', heights(own.rungs), '480');
  check('and it says so', own.origin.kind, 'members');
  check('its own segment length is used', own.segmentSeconds, 4);

  console.log('\n== rungs are always highest first ==');
  const jumbled = resolveLadder(group(), {
    memberRungs: [{ height: 360, bitrate_kbps: 600 }, { height: 1080, bitrate_kbps: 5000 },
                  { height: 720, bitrate_kbps: 3000 }],
  });
  // A player taking the first variant should not get the 360p one because the
  // rows came back in insertion order.
  check('sorted regardless of how they were stored', heights(jumbled.rungs), '1080,720,360');

  const full = resolveLadder(group(), { memberRungs: LIVE });

  // ---- the cap --------------------------------------------------------------
  console.log('\n== a 720p source does not get a 1080p rung ==');
  const f720 = fitToSource(full, { height: 720, width: 1280 });
  check('three rungs kept', heights(f720.kept), '720,480,360');
  check('and one dropped', f720.dropped.length, 1);
  check('the dropped one is the 1080', f720.dropped[0]?.height, 1080);
  check('with the reason recorded', f720.dropped[0]?.why, 'above_source_height');
  // The measurement the decision was made from, so it can be argued with later.
  check('and the measurement it was judged against', f720.dropped[0]?.sourceHeight, 720);
  check('it was measured, so this is not the unmeasured case', f720.sourceUnmeasured, false);

  console.log('\n== an exact match is kept, not dropped ==');
  check('a 1080p source keeps the 1080p rung',
    heights(fitToSource(full, { height: 1080 }).kept), '1080,720,480,360');

  console.log('\n== a source larger than every rung keeps them all ==');
  check('a 4K source still encodes the ladder it was given',
    heights(fitToSource(full, { height: 2160 }).kept), '1080,720,480,360');

  // ---- THE ONE THAT MATTERS -------------------------------------------------
  console.log('\n== a source whose height was NOT MEASURED is not a source of height zero ==');
  const unknown = fitToSource(full, { height: null });
  // Null read as zero drops every rung and produces an asset with no renditions,
  // while the log claims the source was too small. That is the bug.
  check('the full ladder is encoded', heights(unknown.kept), '1080,720,480,360');
  check('nothing was dropped', unknown.dropped.length, 0);
  check('and it is recorded as unmeasured rather than as a clean fit',
    unknown.sourceUnmeasured, true);
  check('which is said in words too',
    /could not be measured/.test(unknown.notes.join(' ')), true);
  check('an undefined height behaves the same as null',
    fitToSource(full, {}).sourceUnmeasured, true);
  check('and so does a zero, which is not a real measurement',
    fitToSource(full, { height: 0 }).sourceUnmeasured, true);
  check('and a NaN', fitToSource(full, { height: NaN }).sourceUnmeasured, true);

  // ---- below every rung -----------------------------------------------------
  console.log('\n== a source below every rung still produces something playable ==');
  const tiny = fitToSource(full, { height: 240 });
  // "No rungs" is not an encode. It is a job that reports success having made
  // nothing, which is the worst of the available outcomes.
  check('exactly one rung is encoded', tiny.kept.length, 1);
  check('at the SOURCE height, not upscaled', tiny.kept[0]?.height, 240);
  check('using the lowest rung\'s bitrate', tiny.kept[0]?.bitrate_kbps, 600);
  check('and the adaptation is recorded', tiny.adapted?.from, 360);
  check('with what it became', tiny.adapted?.to, 240);
  check('and why', tiny.adapted?.reason, 'source_below_every_rung');
  check('the adapted rung is not ALSO listed as dropped',
    tiny.dropped.some((d) => d.height === 360), false);

  // ---- frame rate -----------------------------------------------------------
  console.log('\n== a 25fps source is not encoded at 50 ==');
  const fifty = resolveLadder(group({ fps: 50 }), { memberRungs: LIVE });
  const f25 = fitToSource(fifty, { height: 1080, fps: 25 });
  check('encoded at the source rate', f25.fps, 25);
  check('and said so', /duplicating frames/.test(f25.notes.join(' ')), true);
  check('a 50fps source keeps the 50fps ladder',
    fitToSource(fifty, { height: 1080, fps: 50 }).fps, 50);
  // 29.97 and 30 are the same source in practice; rounding one down changes the
  // GOP for no reason.
  const f30 = resolveLadder(group({ fps: 30 }), { memberRungs: LIVE });
  check('29.97 is not treated as slower than 30',
    fitToSource(f30, { height: 1080, fps: 29.97 }).fps, 30);
  check('an unmeasured frame rate leaves the ladder alone',
    fitToSource(fifty, { height: 1080, fps: null }).fps, 50);

  // ---- capping turned off ---------------------------------------------------
  console.log('\n== a ladder set not to cap encodes every rung ==');
  const noCap = resolveLadder(group({ cap_to_source: false }), { memberRungs: LIVE });
  const nc = fitToSource(noCap, { height: 480 });
  check('every rung survives', heights(nc.kept), '1080,720,480,360');
  check('nothing is reported as dropped', nc.dropped.length, 0);
  // Distinct from the unmeasured case: here we DID measure and chose to ignore it.
  check('and it is not confused with an unmeasured source', nc.sourceUnmeasured, false);
  check('the reason is on the record', /regardless of the source/.test(nc.notes.join(' ')), true);

  // ---- duplicates -----------------------------------------------------------
  console.log('\n== two rungs at one height would be two identical variants ==');
  const dup = resolveLadder(group(), {
    memberRungs: [{ height: 720, bitrate_kbps: 3000 }, { height: 720, bitrate_kbps: 2000 }],
  });
  const fd = fitToSource(dup, { height: 1080 });
  check('only one survives', fd.kept.length, 1);
  check('the higher bitrate one', fd.kept[0]?.bitrate_kbps, 3000);
  check('and the other is recorded as a duplicate', fd.dropped[0]?.why, 'duplicate_height');

  // ---- the summary ----------------------------------------------------------
  console.log('\n== the one-line summary says which case it was ==');
  check('a clean fit', describeFit(fitToSource(full, { height: 1080 })), '1080p, 720p, 480p, 360p');
  check('a capped fit names the count',
    /2 above the source dropped/.test(describeFit(fitToSource(full, { height: 480 }))), true);
  check('an adapted fit says so', /adapted from 360p/.test(describeFit(tiny)), true);
  check('an unmeasured source says THAT rather than pretending it fitted',
    /source not measured/.test(describeFit(unknown)), true);

  console.log(`\nencode-ladder: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
