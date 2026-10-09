// ============================================================================
//  THE FLEET LOG MUST NOT SAY "NOW" ABOUT THE PAST.
//
//  Two screenshots fourteen minutes apart disagreed. Monitoring showed ABC
//  Classic starting and stopping, three cycles, every row reading "just now".
//  The station's own page showed it STOPPED, auto reconnect having given up at
//  03:53:50. The events were real and correctly ordered; the presentation was
//  what lied, in three separate ways, and this suite pins the fix for each.
//
//    1. ROUNDING. `Math.round(ms/60000)` with "just now" under a minute meant a
//       29-second-old row printed "just now", so cycles forty seconds apart
//       became one indistinguishable block. Flooring on SECONDS can only ever
//       understate how recent something is, which is the safe direction.
//
//    2. NO ABSOLUTE TIME. The fleet log, the one screen used to line events up
//       across streams, could not tell you what time it was, while the
//       per-station log beside it printed 03:53:50 and was never in doubt.
//
//    3. NO FOLDING. A heartbeat writing one event every ten seconds filled a
//       sixty-row window with about nine minutes of history and pushed the
//       crash loop off the end of the page.
//
//  THE TWO COLLAPSE RULES THAT ARE EASY TO GET WRONG, and the reason this is a
//  pure function with a suite rather than an inline reduce:
//
//    * CONSECUTIVE ONLY. Folding non-adjacent rows would reorder history, and
//      two separate bursts of the same event must stay two rows: that is the
//      difference between "nine times just now" and "all afternoon".
//
//    * DETAIL IS PART OF THE IDENTITY. During a crash loop `channel.stop`
//      arrives twice, once with "encoder exited rc=183" and once with "stopped
//      by launcher". They are cause and consequence. Folding on the event type
//      alone would show "channel.stop x2" and throw away the only line that
//      says why.
//
//  Usage: npx tsx test/activity-log.check.ts     (no database, no API)
// ============================================================================
import {
  collapseRuns, fmtClock, fmtAgo, fmtSpan, type ActivityRow,
} from '../../volt-web/src/activityLog';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);

let n = 0;
const row = (over: Partial<ActivityRow> & { ts: string }): ActivityRow => ({
  id: `e${++n}`, type: 'packager.up', name: 'DEF CON Radio', detail: '',
  ownerId: 'def', ...over,
});
/** Newest-first, like the feed. */
const at = (hhmmss: string) => `2026-09-05T${hhmmss}.000Z`;

// ---------------------------------------------------------------------------
console.log('== a heartbeat burst folds into one row ==');
// Ten seconds apart, newest first, which is the real heartbeat cadence.
const newest = new Date(at('03:39:50')).getTime();
const beats = Array.from({ length: 9 }, (_, i) =>
  row({ ts: new Date(newest - i * 10_000).toISOString() }));
const folded = collapseRuns(beats);
check('nine identical events become one row', folded.length, 1);
check('and the row carries the count', folded[0].count, 9);
check('positioned at the newest of them', folded[0].newestTs, beats[0].ts);
check('spanning back to the oldest', folded[0].oldestTs, beats[8].ts);
check('labelled with the span', fmtSpan(folded[0]), '\u00d79 over 1m');

// ---------------------------------------------------------------------------
console.log('\n== but a crash loop keeps every line that says why ==');
// The real sequence from the machine, newest first.
const loop: ActivityRow[] = [
  row({ ts: at('03:53:50'), type: 'channel.stop',  detail: 'reason: stopped by launcher', ownerId: 'abc', name: 'ABC Classic (HLS)' }),
  row({ ts: at('03:53:50'), type: 'channel.stop',  detail: 'reason: encoder exited rc=183', ownerId: 'abc', name: 'ABC Classic (HLS)' }),
  row({ ts: at('03:53:50'), type: 'channel.start', detail: 'workflow: transcode', ownerId: 'abc', name: 'ABC Classic (HLS)' }),
  row({ ts: at('03:53:10'), type: 'channel.stop',  detail: 'reason: stopped by launcher', ownerId: 'abc', name: 'ABC Classic (HLS)' }),
  row({ ts: at('03:53:10'), type: 'channel.stop',  detail: 'reason: encoder exited rc=183', ownerId: 'abc', name: 'ABC Classic (HLS)' }),
  row({ ts: at('03:53:10'), type: 'channel.start', detail: 'workflow: transcode', ownerId: 'abc', name: 'ABC Classic (HLS)' }),
];
const kept = collapseRuns(loop);
check('nothing is folded away', kept.length, 6);
check('the two stop REASONS stay separate rows',
  kept.filter((r) => r.row.type === 'channel.stop').length, 4);
check('and the cause is still readable',
  kept[1].row.detail, 'reason: encoder exited rc=183');

// ---------------------------------------------------------------------------
console.log('\n== two separate bursts are two rows, not one ==');
const twoBursts = [
  row({ ts: at('12:00:20') }), row({ ts: at('12:00:10') }),
  row({ ts: at('11:00:20'), type: 'channel.start', detail: 'workflow: transcode' }),
  row({ ts: at('10:00:20') }), row({ ts: at('10:00:10') }),
];
const bursts = collapseRuns(twoBursts);
check('the interruption splits the run', bursts.length, 3);
check('first burst counted', bursts[0].count, 2);
check('second burst counted separately', bursts[2].count, 2);

console.log('\n== a different stream never folds into the one above it ==');
const mixed = [
  row({ ts: at('09:00:20'), ownerId: 'def', name: 'DEF CON Radio' }),
  row({ ts: at('09:00:10'), ownerId: 'abc', name: 'ABC Classic (HLS)' }),
];
check('two streams, two rows', collapseRuns(mixed).length, 2);

console.log('\n== a single event is not a run ==');
const one = collapseRuns([row({ ts: at('08:00:00') })]);
check('count is one', one[0].count, 1);
check('and it gets no span badge', fmtSpan(one[0]), '');
check('an empty feed collapses to nothing', collapseRuns([]).length, 0);

// ---------------------------------------------------------------------------
console.log('\n== the clock is absolute, and the age never overstates ==');
const base = new Date(at('12:00:00')).getTime();
check('29 seconds is NOT "just now"', fmtAgo(at('11:59:31'), base), '29s ago');
check('9 seconds is', fmtAgo(at('11:59:51'), base), 'just now');
check('59 seconds stays in seconds', fmtAgo(at('11:59:01'), base), '59s ago');
check('119 seconds floors to 1m, never 2m', fmtAgo(at('11:58:01'), base), '1m ago');
check('an hour and 59 minutes floors to 1h', fmtAgo(at('10:01:00'), base), '1h ago');
check('a future timestamp clamps rather than going negative',
  fmtAgo(at('12:00:30'), base), 'just now');
check('the clock prints seconds', /^\d{2}:\d{2}:\d{2}$/.test(fmtClock(at('03:53:50'))), true);
check('a null timestamp is empty, not "Invalid Date"', fmtClock(null), '');
check('and so is a broken one', fmtAgo('not-a-date', base), '');

console.log(`\nactivity-log: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
