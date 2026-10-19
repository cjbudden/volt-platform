/**
 * Pure EPG repeat logic: rule dates, wall-clock across DST, placement rules.
 * Run: npx tsx test/epg-repeat-pure.check.ts
 */
import {
  datesFor, ruleMatches, ruleToRrule, describeRule, localToUtc, localDateOf, localTimeOf, localDayBounds,
  isExcluded, weekdayOf, validateRule, addDays,
} from '../src/services/epgRepeat';
import { decide, summarise, seriesCandidates, seriesOccursOn, protectedReason, draftSeries, type Candidate } from '../src/services/epgPlace';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log('PASS ' + m)) : (fail++, console.log('FAIL ' + m)));

// ---- rules -------------------------------------------------------------------
ok(weekdayOf('2026-10-20') === 'TU', '20 Oct 2026 is a Tuesday');
const tuesdays = datesFor({ freq: 'weekly', byDay: ['TU'] }, '2026-10-20', '2026-10-20', '2026-12-31', '2026-12-15');
ok(tuesdays.length === 9 && tuesdays[0] === '2026-10-20' && tuesdays[8] === '2026-12-15', `every Tuesday to 15 Dec: 9 dates (got ${tuesdays.length})`);
ok(datesFor({ freq: 'weekdays' }, '2026-10-19', '2026-10-19', '2026-10-25').length === 5, 'weekdays: 5 in a week');
ok(datesFor({ freq: 'daily', interval: 2 }, '2026-10-19', '2026-10-19', '2026-10-28').join() === '2026-10-19,2026-10-21,2026-10-23,2026-10-25,2026-10-27', 'every 2 days');
const fortnight = datesFor({ freq: 'weekly', byDay: ['MO', 'FR'], interval: 2 }, '2026-10-19', '2026-10-19', '2026-11-15');
ok(fortnight.join() === '2026-10-19,2026-10-23,2026-11-02,2026-11-06', `every 2 weeks Mon+Fri (got ${fortnight.join()})`);
ok(!ruleMatches({ freq: 'daily' }, '2026-10-20', '2026-10-19'), 'nothing before the start date');
ok(datesFor({ freq: 'daily' }, '2026-01-01', '2026-01-01', '2030-01-01', null, 50).length === 50, 'expansion is capped');
ok(validateRule({ freq: 'weekly', byDay: [] }) !== null, 'weekly with no days is refused');
ok(validateRule({ freq: 'daily', interval: 0 }) !== null, 'interval 0 is refused');
ok(validateRule({ freq: 'weekdays' }) === null, 'weekdays is valid');

ok(ruleToRrule({ freq: 'weekly', byDay: ['TH', 'TU'] }, '2026-12-15') === 'FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261215T235959Z', 'RRULE text, days in order');
ok(ruleToRrule({ freq: 'weekdays' }) === 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'weekdays RRULE');
ok(describeRule({ freq: 'weekly', byDay: ['TU', 'TH'] }, '2026-12-15') === 'Every Tuesday and Thursday until 15 Dec 2026', 'description');
ok(isExcluded(['2026-10-27#d1'], '2026-10-27', 'd1') && !isExcluded(['2026-10-27#d1'], '2026-10-27', 'd2'), 'exdate per item');
ok(isExcluded(['2026-10-27'], '2026-10-27', 'd2'), 'exdate for a whole date');

// ---- wall clock across DST -----------------------------------------------------
// Sydney goes to daylight time on Sunday 4 Oct 2026 (+10 -> +11).
ok(localToUtc('2026-10-03', '18:00', 'Australia/Sydney') === '2026-10-03T08:00:00.000Z', '18:00 Sydney before DST = 08:00Z');
ok(localToUtc('2026-10-05', '18:00', 'Australia/Sydney') === '2026-10-05T07:00:00.000Z', '18:00 Sydney after DST = 07:00Z');
ok(localToUtc('2026-10-20', '18:00', 'Australia/Brisbane') === '2026-10-20T08:00:00.000Z', 'Brisbane has no DST');
const gap = localToUtc('2026-10-04', '02:30', 'Australia/Sydney');
ok(localTimeOf(gap, 'Australia/Sydney') === '03:30', `02:30 in the spring-forward gap moves to 03:30 (got ${localTimeOf(gap, 'Australia/Sydney')})`);
const sydDst = localDayBounds('2026-10-04', 'Australia/Sydney');
ok(Date.parse(sydDst.end) - Date.parse(sydDst.start) === 23 * 3_600_000, 'the DST day is 23 hours long');
ok(localDateOf('2026-10-19T15:30:00Z', 'Australia/Brisbane') === '2026-10-20', 'local date crosses midnight');
ok(localTimeOf('2026-10-19T08:00:30Z', 'Australia/Brisbane') === '18:00:30', 'seconds kept when set');

// ---- series candidates ---------------------------------------------------------
const owner = { kind: 'channel' as const, id: 'c' };
const item = (key: string, title: string, at: string, mins: number) => ({
  key, title, at, durationMs: mins * 60_000, autoVod: false, geoMode: 'worldwide', geoCountries: [],
  replacementKind: 'none', replacementRef: null, metadata: {},
});
const day = draftSeries({
  owner, kind: 'day', rule: { freq: 'weekly', byDay: ['TU'] }, tz: 'Australia/Sydney', startDate: '2026-09-29',
  untilDate: '2026-10-13', policy: 'replace', sourceDate: '2026-09-28',
  items: [item('d0', 'Breakfast', '06:00', 180), item('d1', 'Evening', '18:00', 60)],
});
day.exdates = ['2026-10-13#d1'];
const c = seriesCandidates(day, '2026-09-29', '2026-10-31');
ok(c.length === 5, `3 Tuesdays x 2 items minus 1 exdate = 5 (got ${c.length})`);
ok(c.filter((x) => x.title === 'Evening').map((x) => x.startsAt).join() === '2026-09-29T08:00:00.000Z,2026-10-06T07:00:00.000Z', 'evening stays 18:00 local across DST');
ok(c[0].sourceRef === `series:${day.id}:2026-09-29:d0`, 'idempotent source_ref');
ok(seriesOccursOn(day, '2026-10-06', 'd0') && !seriesOccursOn(day, '2026-10-07') && !seriesOccursOn(day, '2026-10-20'), 'occursOn honours days and until');
ok(!seriesOccursOn(day, '2026-10-13', 'd1') && seriesOccursOn(day, '2026-10-13', 'd0'), 'occursOn honours exdates');

// ---- placement rules ------------------------------------------------------------
const NOW = Date.parse('2026-10-19T00:00:00Z');
const cand = (title: string, s: string, e: string, extra: Partial<Candidate> = {}): Candidate => ({
  title, startsAt: s, endsAt: e, date: s.slice(0, 10), autoVod: false, geoMode: 'worldwide', geoCountries: [],
  replacementKind: 'none', replacementRef: null, metadata: {}, ...extra,
});
const row = (id: string, title: string, s: string, e: string, extra: any = {}) => ({ id, title, starts_at: s, ends_at: e, source_ref: null, series_id: null, clip_asset_id: null, clip_status: 'none', ...extra });
const existing = [
  row('x1', 'Old Lunch', '2026-10-20T11:00:00Z', '2026-10-20T13:00:00Z'),
  row('x2', 'Feed News', '2026-10-20T14:00:00Z', '2026-10-20T15:00:00Z', { source_ref: 'xmltv:abc' }),
  row('x3', 'Clipped', '2026-10-20T16:00:00Z', '2026-10-20T17:00:00Z', { clip_asset_id: 'a' }),
];
const incoming = [
  cand('Lunch', '2026-10-20T11:30:00Z', '2026-10-20T12:30:00Z'),
  cand('News', '2026-10-20T14:30:00Z', '2026-10-20T15:30:00Z'),
  cand('Drive', '2026-10-20T16:30:00Z', '2026-10-20T18:00:00Z'),
  cand('Late', '2026-10-20T20:00:00Z', '2026-10-20T21:00:00Z'),
  cand('Yesterday', '2026-10-18T20:00:00Z', '2026-10-18T21:00:00Z'),
];
const rep = decide(incoming, existing, 'replace', NOW);
const byT = (t: string) => rep.outcomes.find((o) => o.title === t)!;
ok(byT('Lunch').result === 'replace' && byT('Lunch').replaces![0].title === 'Old Lunch', 'replace: overlapped programme is replaced');
ok(byT('News').result === 'skip' && /imported guide feed/.test(byT('News').reason!), 'replace: feed programme is protected');
ok(byT('Drive').result === 'skip' && /VOD/.test(byT('Drive').reason!), 'replace: programme with a VOD is protected');
ok(byT('Late').result === 'add', 'free time is just added');
ok(byT('Yesterday').result === 'skip' && /past/.test(byT('Yesterday').reason!), 'nothing is placed in the past');
ok(rep.removed.map((r) => r.id).join() === 'x1', 'only the unprotected overlap is removed');
const sm = summarise(rep.outcomes);
ok(sm.added === 2 && sm.replaced === 1 && sm.skipped === 3, `summary ${JSON.stringify(sm)}`);

const sk = decide(incoming, existing, 'skip', NOW);
ok(sk.outcomes.filter((o) => o.result === 'add').length === 1 && !sk.removed.length, 'skip: only empty time is filled, nothing removed');
const kp = decide(incoming, existing, 'keep', NOW);
ok(kp.outcomes.filter((o) => o.result === 'add').length === 4 && !kp.removed.length && kp.outcomes.find((o) => o.title === 'Lunch')!.overlaps![0] === 'Old Lunch', 'keep: added with overlaps listed');

const again = decide([cand('Breakfast', '2026-10-20T06:00:00Z', '2026-10-20T09:00:00Z', { sourceRef: 'series:s:2026-10-20:d0' })],
  [row('y', 'Breakfast', '2026-10-20T06:00:00Z', '2026-10-20T09:00:00Z', { source_ref: 'series:s:2026-10-20:d0', series_id: 's' })], 'replace', NOW);
ok(again.outcomes[0].result === 'exists' && !again.removed.length, 'an occurrence already placed is left alone (top-up is idempotent)');
const same = decide([cand('Lunch', '2026-10-20T11:00:00Z', '2026-10-20T13:00:00Z')], [row('s1', 'Lunch', '2026-10-20T11:00:00Z', '2026-10-20T13:00:00Z', { series_id: 'd' })], 'replace', NOW);
ok(same.outcomes[0].replaces![0].same === true && summarise(same.outcomes).replaced === 0 && summarise(same.outcomes).takenOver === 1, 'an identical programme is taken over, not counted as replaced');
ok(protectedReason(row('z', 'Repeat', '2026-10-20T06:00:00Z', '2026-10-20T07:00:00Z', { source_ref: 'series:s:x:d0' }), NOW) === null, 'a repeat occurrence can be replaced');
ok(protectedReason(row('z', 'On air', '2026-10-18T06:00:00Z', '2026-10-20T07:00:00Z'), NOW) !== null, 'an on-air programme is protected');

console.log(`\nepg-repeat-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
void addDays;
