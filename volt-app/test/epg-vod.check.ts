// ============================================================================
//  THE VOD LIFECYCLE OF A PROGRAMME.
//
//  The guide used to render one of four things in an "Auto clip" column: a
//  dash, "on end", "created", or "failed". THREE SEPARATE SITUATIONS SHARED
//  THE DASH, and the most valuable one was invisible:
//
//      it aired, it was recorded, the media is still on disk,
//      and nothing is going to turn it into a VOD.
//
//  That is every slot where auto_vod was left off, and every slot whose
//  automatic conversion failed. The material is there today and gone once
//  retention sweeps, and the only way to notice used to be to remember.
//
//  This suite is about the state machine, because that is where the mistakes
//  live. Every case injects its own clock and its own coverage, so each of the
//  seven outcomes is asserted directly rather than by arranging real media on
//  disk — which is how a seven-branch machine ends up with three branches
//  nobody ever ran.
//
//  THE TWO ASYMMETRIES IT PINS DOWN:
//
//    A FAILED ATTEMPT REPORTS FAILED even when the bytes are present. The
//    reason it failed is the actionable thing; hiding it behind "convertible"
//    because the media happens to be there would lose it.
//
//    UNKNOWN COVERAGE REPORTS CONVERTIBLE, NOT UNAVAILABLE. A scan that did
//    not run is not evidence of absence. Offering a button that might fail
//    beats telling an operator their recording is gone when we simply did not
//    look.
//
//  Usage: DATABASE_URL=... npx tsx test/epg-vod.check.ts
// ============================================================================
import { __testing, coveredWithin } from '../src/services/epgVod';

const { shape } = __testing;

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected truthy, got [${String(v)}]`));

const NOW = Date.parse('2026-03-10T12:00:00Z');
const H = 3_600_000;

/** A programme row as the query returns it. */
function prog(over: Record<string, any> = {}) {
  return {
    id: 'p1', title: 'Show',
    starts_at: new Date(NOW - 3 * H).toISOString(),
    ends_at: new Date(NOW - 2 * H).toISOString(),
    actual_start: null, actual_end: null,
    auto_vod: false, clip_status: 'none', clip_asset_id: null, clip_error: null,
    asset_title: null, asset_state: null,
    ...over,
  };
}

/** A resolution covering [from,to] as one block. `null` = the scan did not run. */
function cover(fromMs: number, toMs: number): any {
  return { blocks: [{ startMs: fromMs, endMs: toMs, runId: 'r', blockIndex: 0, rendition: '720p', segments: [] }] };
}
const NOTHING: any = { blocks: [] };

const DAYS_14 = 14 * 86_400_000;

// ---------------------------------------------------------------------------
console.log('\n== before it has aired, the only question is whether it will convert ==');
{
  const future = { starts_at: new Date(NOW + H).toISOString(), ends_at: new Date(NOW + 2 * H).toISOString() };
  check('auto_vod off reads as manual',
        shape(prog({ ...future, auto_vod: false }), NOTHING, DAYS_14, NOW).state, 'manual');
  check('auto_vod on reads as scheduled',
        shape(prog({ ...future, auto_vod: true }), NOTHING, DAYS_14, NOW).state, 'scheduled');
  check('and both are flagged as still to come',
        shape(prog({ ...future }), NOTHING, DAYS_14, NOW).future, true);

  // A slot that has STARTED but not finished is still future: converting it
  // now would cut an asset that stops mid-programme.
  const midAir = { starts_at: new Date(NOW - H).toISOString(), ends_at: new Date(NOW + H).toISOString() };
  check('a slot currently on air is not yet convertible',
        shape(prog({ ...midAir, auto_vod: true }), cover(NOW - H, NOW), DAYS_14, NOW).state, 'scheduled');
}

// ---------------------------------------------------------------------------
console.log('\n== an asset exists, or it does not ==');
{
  check('created with an asset id is converted',
        shape(prog({ clip_status: 'created', clip_asset_id: 'a1' }), NOTHING, DAYS_14, NOW).state, 'converted');
  // The defensive case: a status of 'created' with nothing to open is not a
  // conversion, whatever the column says. Trusting the flag alone would show
  // "VOD ready" with no asset behind it.
  check('created with NO asset id is not treated as converted',
        shape(prog({ clip_status: 'created', clip_asset_id: null }), NOTHING, DAYS_14, NOW).state, 'unavailable');
  check('firing is converting',
        shape(prog({ clip_status: 'firing' }), NOTHING, DAYS_14, NOW).state, 'converting');
  const conv = shape(prog({ clip_status: 'created', clip_asset_id: 'a1', asset_title: 'Breakfast', asset_state: 'ready' }), NOTHING, DAYS_14, NOW);
  check('and the asset is named', conv.assetTitle, 'Breakfast');
  check('with its build state', conv.assetState, 'ready');
}

// ---------------------------------------------------------------------------
console.log('\n== the state that did not exist: recorded and still convertible ==');
{
  const start = NOW - 3 * H, end = NOW - 2 * H;
  const v = shape(prog({ auto_vod: false }), cover(start, end), DAYS_14, NOW);
  check('an aired slot with media is convertible', v.state, 'convertible');
  check('coverage is reported in full', v.coveragePct, 100);
  check('and in milliseconds', v.coveredMs, H);
  truthy('with a deletion date, because the channel has a retention rule', v.expiresAt);
  check('measured from the END of the slot, not from now',
        v.expiresAt, new Date(end + DAYS_14).toISOString());

  // Partial coverage still converts, but the figure has to be honest: an
  // encoder restart mid-slot produces an asset with a hole, and finding that
  // out after the build is the expensive way.
  const partial = shape(prog({}), cover(start, start + H / 2), DAYS_14, NOW);
  check('half-covered reads as half covered', partial.coveragePct, 50);
  check('and is still offered as convertible', partial.state, 'convertible');

  // No retention rule means the material is kept indefinitely. That must be
  // null rather than some far-future date, so the UI can say nothing at all
  // instead of implying a deadline.
  check('no retention rule means no deletion date',
        shape(prog({}), cover(start, end), null, NOW).expiresAt, null);
}

// ---------------------------------------------------------------------------
console.log('\n== aired with nothing behind it ==');
{
  check('no media at all is unavailable',
        shape(prog({}), NOTHING, DAYS_14, NOW).state, 'unavailable');
  // Coverage OUTSIDE the slot is not coverage OF the slot. Intersecting is
  // the whole job of coveredWithin, and a resolution that spans the day would
  // otherwise make every slot in it look recorded.
  check('media from a different part of the day does not count',
        shape(prog({}), cover(NOW - 12 * H, NOW - 11 * H), DAYS_14, NOW).state, 'unavailable');
}

// ---------------------------------------------------------------------------
console.log('\n== a failure reports as a failure, even when the bytes are there ==');
//
// The asymmetry that matters. `clip_error` has stored the reason since the
// schema was written and nothing has ever displayed it; burying a failed slot
// under "convertible" because the media survived would lose it again.
{
  const start = NOW - 3 * H, end = NOW - 2 * H;
  const v = shape(prog({ auto_vod: true, clip_status: 'error', clip_error: 'no recording covers the slot' }),
                  cover(start, end), DAYS_14, NOW);
  check('the state is failed', v.state, 'failed');
  check('the reason survives', v.error, 'no recording covers the slot');
  check('and the coverage is still reported, so a retry is an informed one', v.coveragePct, 100);
}

// ---------------------------------------------------------------------------
console.log('\n== a scan that did not run is not evidence of absence ==');
//
// `null` coverage means the archive could not be read — a permissions problem,
// a mount not yet up, an exception in the scanner. Reporting `unavailable`
// there would tell an operator their recording is gone on the strength of not
// having looked, and there is no way back from that conclusion.
{
  const v = shape(prog({}), null, DAYS_14, NOW);
  check('unknown coverage is offered as convertible, not written off', v.state, 'convertible');
  check('with coverage reported as zero rather than invented', v.coveragePct, 0);
}

// ---------------------------------------------------------------------------
console.log('\n== as-run times win over scheduled ones ==');
//
// A programme that started late and ran long is clipped from what ACTUALLY
// aired. Using the scheduled span would cut the beginning off the asset.
{
  const v = shape(prog({
    starts_at: new Date(NOW - 3 * H).toISOString(),
    ends_at: new Date(NOW - 2 * H).toISOString(),
    actual_start: new Date(NOW - 2.5 * H).toISOString(),
    actual_end: new Date(NOW - 1 * H).toISOString(),
  }), cover(NOW - 2.5 * H, NOW - 1 * H), DAYS_14, NOW);
  check('coverage is measured over the as-run span', v.coveragePct, 100);
  check('and the deletion date follows the as-run end',
        v.expiresAt, new Date(NOW - 1 * H + DAYS_14).toISOString());
}

// ---------------------------------------------------------------------------
console.log('\n== coveredWithin intersects rather than sums ==');
{
  const r: any = { blocks: [
    { startMs: 0, endMs: 100 },
    { startMs: 150, endMs: 300 },
  ] };
  check('fully inside', coveredWithin(r, 0, 300), 100 + 150);
  check('a window inside one block', coveredWithin(r, 10, 40), 30);
  check('a window straddling the gap', coveredWithin(r, 50, 200), 50 + 50);
  check('a window entirely in the gap', coveredWithin(r, 110, 140), 0);
  check('a window past the end', coveredWithin(r, 400, 500), 0);
  check('and a null resolution is unknown, not zero', coveredWithin(null, 0, 300), null);
}

console.log(`\nepg-vod: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
