// ============================================================================
//  THE PROGRAMME FLAG: one per guide entry or logged song, fixed precedence.
//  Pure (programmeMedia.flagFor), so it runs with no database.
//  Usage: npx tsx test/programme-flag.check.ts
// ============================================================================
import { flagFor, type FlagInput } from '../src/services/programmeMedia';

let pass = 0, fail = 0;
const eq = (m: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { console.log('PASS ' + m); pass++; }
  else { console.log(`FAIL ${m} -- got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); fail++; }
};
const NOW = Date.parse('2026-10-24T08:00:00Z'), H = 3600_000, D = 86_400_000;
const rec = (expDays: number | null, partial = false) => ({ id: 'r1', from: NOW - 2 * H, to: NOW - H, partial,
  expiresAt: expDays == null ? null : new Date(NOW + expDays * D).toISOString() });
const f = (o: Partial<FlagInput>) => flagFor({ startMs: NOW - 2 * H, endMs: NOW - H, nowMs: NOW, autoVod: false, clipStatus: 'none',
  asset: null, recording: null, ...o });
const k = (o: Partial<FlagInput>) => f(o)?.kind ?? null;

// before air
eq('upcoming, not Auto VOD: no flag', k({ startMs: NOW + H, endMs: NOW + 2 * H }), null);
eq('upcoming, Auto VOD: AUTO VOD', k({ startMs: NOW + H, endMs: NOW + 2 * H, autoVod: true }), 'autovod');
eq('on air, Auto VOD: AUTO VOD', k({ startMs: NOW - H, endMs: NOW + H, autoVod: true }), 'autovod');
eq('on air, not Auto VOD: no flag', k({ startMs: NOW - H, endMs: NOW + H }), null);
// aired
eq('asset wins over everything', k({ asset: { id: 'a', title: 'x' }, recording: rec(6), clipStatus: 'created' }), 'vod');
eq('VOD not published: draft (blue)', f({ asset: { id: 'a', title: 'x', publish: 'draft' }, clipStatus: 'created' })?.publish, 'draft');
eq('VOD published (green)', f({ asset: { id: 'a', title: 'x', publish: 'published' }, clipStatus: 'created' })?.publish, 'published');
eq('VOD expired (grey)', f({ asset: { id: 'a', title: 'x', publish: 'expired' }, clipStatus: 'created' })?.publish, 'expired');
eq('VOD with no state reads as draft', f({ asset: { id: 'a', title: 'x' }, clipStatus: 'created' })?.publish, 'draft');
eq('VOD links to the asset', f({ asset: { id: 'a', title: 'x' }, clipStatus: 'created' })?.assetId, 'a');
eq('firing: CONVERTING', k({ clipStatus: 'firing', recording: rec(6), autoVod: true }), 'converting');
eq('aired with Auto VOD, not fired yet: CONVERTING', k({ autoVod: true, recording: rec(6) }), 'converting');
eq('failed: VOD FAILED', k({ clipStatus: 'error', clipError: 'boom', recording: rec(6) }), 'failed');
eq('failed keeps the recording link', f({ clipStatus: 'error', recording: rec(6) })?.recording?.id, 'r1');
eq('recording, no asset: REC', k({ recording: rec(6) }), 'rec');
eq('REC carries days left', f({ recording: rec(6) })?.daysLeft, 6);
eq('REC not amber at 6 days', f({ recording: rec(6) })?.warn, false);
eq('REC amber within 2 days', f({ recording: rec(1.5) })?.warn, true);
eq('REC kept indefinitely: no days', f({ recording: rec(null) })?.daysLeft, null);
eq('REC partial', f({ recording: rec(6, true) })?.partial, true);
eq('no recording ever covered it: NOT RECORDED', k({}), 'notrecorded');
eq('recorded then removed: EXPIRED', k({ expiredRecording: { removedAt: new Date(NOW - D).toISOString() } }), 'expired');
eq('a live recording beats an old removed one', k({ recording: rec(6), expiredRecording: { removedAt: null } }), 'rec');
eq('row says yes, disk says no: UNAVAILABLE', k({ recording: rec(6), measuredGone: true }), 'unavailable');
eq('EXPIRED has no link', f({ expiredRecording: { removedAt: null } })?.recording, null);
eq('NOT RECORDED has no link', f({})?.recording, null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
