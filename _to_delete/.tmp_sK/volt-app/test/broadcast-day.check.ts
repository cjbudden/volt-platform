// ============================================================================
//  BROADCAST DAY CHECKS — the DST cases, because those are where it breaks.
//
//  Any implementation that computes the end of a broadcast day as start +
//  86_400_000 passes every test except two weekends a year, and fails those in
//  the direction that silently loses or duplicates an hour of recording. These
//  tests pin the real UK clock changes and a southern-hemisphere zone whose
//  transitions run the other way.
//
//  Run: npx tsx test/broadcast-day.check.ts     (no database needed)
// ============================================================================
import {
  broadcastDayOf, broadcastDayBounds, broadcastDaysBetween,
  utcForLocal, localPartsAt, localClock, instantOfLocalTimeInDay,
  offsetMinutesAt, DEFAULT_ANCHOR_HOUR,
} from '../src/services/broadcastDay';

let pass = 0, failed = 0;
const ok = (n: string) => { console.log(`PASS ${n}`); pass++; };
const bad = (n: string, d: string) => { console.log(`FAIL ${n} -- ${d}`); failed++; };
const check = (n: string, a: unknown, e: unknown) =>
  Object.is(a, e) ? ok(n) : bad(n, `expected [${String(e)}] got [${String(a)}]`);

const LON = 'Europe/London';
const NY = 'America/New_York';
const SYD = 'Australia/Sydney';
const iso = (ms: number) => new Date(ms).toISOString();

// ---------------------------------------------------------------- basics
{
  // 2026-06-15 is firmly inside BST (UTC+1), so 06:00 local is 05:00Z.
  const d = broadcastDayBounds('2026-06-15', LON, 6);
  check('a summer day starts at 06:00 local', iso(d.startMs), '2026-06-15T05:00:00.000Z');
  check('a summer day ends at the next 06:00 local', iso(d.endMs), '2026-06-16T05:00:00.000Z');
  check('an ordinary day is 24 hours', d.hours, 24);

  // 2026-01-15 is GMT (UTC+0).
  const w = broadcastDayBounds('2026-01-15', LON, 6);
  check('a winter day starts at 06:00 local', iso(w.startMs), '2026-01-15T06:00:00.000Z');
  check('a winter day is 24 hours', w.hours, 24);
}

// -------------------------------------------- THE SPRING FORWARD (23 hours)
// UK clocks go forward on Sunday 29 March 2026 at 01:00 GMT.
// So 2026-03-28 06:00 GMT = 06:00Z, and 2026-03-29 06:00 BST = 05:00Z.
{
  const d = broadcastDayBounds('2026-03-28', LON, 6);
  check('the day before the spring change starts at 06:00Z', iso(d.startMs), '2026-03-28T06:00:00.000Z');
  check('and ends at 05:00Z, because the clocks went forward', iso(d.endMs), '2026-03-29T05:00:00.000Z');
  check('a spring-forward broadcast day is 23 hours', d.hours, 23);

  const naive = d.startMs + 86_400_000;
  check('a naive start + 24h would have been an hour wrong', iso(naive), '2026-03-29T06:00:00.000Z');
}

// --------------------------------------------- THE FALL BACK (25 hours)
// UK clocks go back on Sunday 25 October 2026 at 02:00 BST.
// So 2026-10-24 06:00 BST = 05:00Z, and 2026-10-25 06:00 GMT = 06:00Z.
{
  const d = broadcastDayBounds('2026-10-24', LON, 6);
  check('the day before the autumn change starts at 05:00Z', iso(d.startMs), '2026-10-24T05:00:00.000Z');
  check('and ends at 06:00Z, because the clocks went back', iso(d.endMs), '2026-10-25T06:00:00.000Z');
  check('a fall-back broadcast day is 25 hours', d.hours, 25);
}

// ----------------------------------------- late night belongs to the day before
{
  // 01:30 local on 16 June, i.e. still "the 15th's" programming.
  const lateNight = utcForLocal(2026, 6, 16, 1, 30, LON);
  const d = broadcastDayOf(lateNight, LON, 6);
  check('01:30 belongs to the PREVIOUS broadcast day', d.day, '2026-06-15');

  const morning = utcForLocal(2026, 6, 16, 6, 30, LON);
  check('06:30 belongs to its own day', broadcastDayOf(morning, LON, 6).day, '2026-06-16');

  // the exact anchor instant belongs to the day it opens
  const atAnchor = utcForLocal(2026, 6, 16, 6, 0, LON);
  check('the anchor instant opens its own day', broadcastDayOf(atAnchor, LON, 6).day, '2026-06-16');

  const justBefore = atAnchor - 1;
  check('one millisecond earlier is still the previous day',
    broadcastDayOf(justBefore, LON, 6).day, '2026-06-15');
}

// ------------------------------------------------- midnight-anchored channels
{
  // A channel that wants calendar days must still work.
  const d = broadcastDayBounds('2026-06-15', LON, 0);
  check('a midnight anchor starts at 00:00 local', iso(d.startMs), '2026-06-14T23:00:00.000Z');
  const lateNight = utcForLocal(2026, 6, 16, 1, 30, LON);
  check('with a midnight anchor, 01:30 is its own day',
    broadcastDayOf(lateNight, LON, 0).day, '2026-06-16');
}

// ------------------------------------------------------------ other zones
{
  // New York spring forward: 8 March 2026, 02:00 EST -> 03:00 EDT.
  const d = broadcastDayBounds('2026-03-07', NY, 6);
  check('New York spring-forward day is 23 hours', d.hours, 23);

  // Sydney runs the opposite way: clocks go BACK on 5 April 2026.
  const s = broadcastDayBounds('2026-04-04', SYD, 6);
  check('Sydney autumn day is 25 hours', s.hours, 25);
  // and forward on 4 October 2026
  const s2 = broadcastDayBounds('2026-10-03', SYD, 6);
  check('Sydney spring day is 23 hours', s2.hours, 23);
}

// ------------------------------------------------------- days between
{
  const from = utcForLocal(2026, 3, 27, 12, 0, LON);
  const to = utcForLocal(2026, 3, 30, 12, 0, LON);
  const days = broadcastDaysBetween(from, to, LON, 6);
  check('spanning four days returns four', days.length, 4);
  check('they are in order and named correctly',
    days.map((d) => d.day).join(','), '2026-03-27,2026-03-28,2026-03-29,2026-03-30');
  check('the change day among them is 23 hours',
    days.find((d) => d.day === '2026-03-28')!.hours, 23);
  // contiguous: each day starts exactly where the last ended
  let contiguous = true;
  for (let i = 1; i < days.length; i++) if (days[i].startMs !== days[i - 1].endMs) contiguous = false;
  check('broadcast days tile with no gap or overlap', contiguous, true);
}

// -------------------------------------------------- daypart anchors in a day
{
  const day = broadcastDayBounds('2026-06-15', LON, 6);
  const breakfast = instantOfLocalTimeInDay(day, '06:00');
  check('breakfast opens the day', breakfast, day.startMs);

  const drive = instantOfLocalTimeInDay(day, '16:00');
  check('drive is on the same calendar date', localPartsAt(drive, LON).day, 15);
  check('drive reads 16:00 locally', localClock(drive, LON), '16:00');

  // THE ONE THAT CATCHES PEOPLE OUT: an overnight strip at 01:00 belongs to
  // this broadcast day but falls on the NEXT calendar date.
  const overnight = instantOfLocalTimeInDay(day, '01:00');
  check('overnight lands on the next calendar date', localPartsAt(overnight, LON).day, 16);
  check('and reads 01:00 locally', localClock(overnight, LON), '01:00');
  const inside = overnight > day.startMs && overnight < day.endMs;
  check('overnight is still inside its broadcast day', inside, true);
}

// ------------------------------------------------------------ offsets
{
  check('London is UTC+1 in summer', offsetMinutesAt(Date.UTC(2026, 5, 15, 12), LON), 60);
  check('London is UTC+0 in winter', offsetMinutesAt(Date.UTC(2026, 0, 15, 12), LON), 0);
  check('the default anchor is 6', DEFAULT_ANCHOR_HOUR, 6);
}

// ------------------------------- round trip: any instant lands in a day holding it
{
  let held = true;
  for (const t of [
    Date.UTC(2026, 2, 29, 0, 30), Date.UTC(2026, 2, 29, 5, 30), Date.UTC(2026, 2, 29, 6, 30),
    Date.UTC(2026, 9, 25, 0, 30), Date.UTC(2026, 9, 25, 5, 30), Date.UTC(2026, 9, 25, 6, 30),
    Date.UTC(2026, 5, 1, 23, 59), Date.UTC(2026, 11, 31, 23, 59),
  ]) {
    const d = broadcastDayOf(t, LON, 6);
    if (!(t >= d.startMs && t < d.endMs)) { held = false; console.log('   not held:', iso(t), d.day, iso(d.startMs), iso(d.endMs)); }
  }
  check('every instant falls inside the day it is assigned to, DST included', held, true);
}

console.log(`\nbroadcast-day: ${pass} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
