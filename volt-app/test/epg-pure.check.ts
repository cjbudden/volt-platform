/** Pure EPG logic: RRULE expansion + effective-end resolution. */
import { expandRrule, resolveEffectiveEnds } from '../src/services/epg';

let pass = 0,
  fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log('PASS ' + m)) : (fail++, console.log('FAIL ' + m)));

const dt = new Date('2027-01-01T16:30:00Z');
const inst = expandRrule('FREQ=DAILY;COUNT=5', dt, 1_800_000, dt, new Date('2027-02-01T00:00:00Z'));
ok(inst.length === 5, `daily COUNT=5 → 5 instances (got ${inst.length})`);
ok((Date.parse(inst[0].endsAt) - Date.parse(inst[0].startsAt)) / 60000 === 30, 'instance duration honoured (30m)');
ok(inst[1].startsAt.startsWith('2027-01-02T16:30'), 'second instance is next day same time');

const weekly = expandRrule('FREQ=WEEKLY;COUNT=8', dt, 1_800_000, dt, new Date('2027-06-01T00:00:00Z'));
ok(weekly.length === 8, `weekly COUNT=8 → 8 instances (got ${weekly.length})`);

const r = resolveEffectiveEnds([
  { startsAt: '2027-01-01T09:00:00Z' },
  { startsAt: '2027-01-01T10:00:00Z', endsAt: '2027-01-01T10:30:00Z' },
  { startsAt: '2027-01-01T12:00:00Z' },
]);
ok(r[0].endsAt === '2027-01-01T10:00:00Z', 'open programme ends at next start');
ok(r[1].endsAt === '2027-01-01T10:30:00Z', 'explicit end preserved');
ok(Date.parse(r[2].endsAt) - Date.parse(r[2].startsAt) === 3_600_000, 'last open programme gets +1h default');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
