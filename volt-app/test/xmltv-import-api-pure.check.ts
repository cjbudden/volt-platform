// ============================================================================
//  XMLTV import from a hosted guide API: the request plan, without a network.
//  Dates in the source's zone (Brisbane is already tomorrow when UTC is not),
//  every date format, one request per day vs one for the window, the window
//  end across a DST change, template mistakes caught before saving, header
//  names, and the retry backoff.
//
//  Usage: npx tsx test/xmltv-import-api-pure.check.ts
// ============================================================================
import { xmltvOffset, stripOffset, resolveChannel, parseXmltvTime } from '../src/services/xmltvParse';
import { planRequests, templateProblem, headerProblem, retryDelayMinutes, todayIn, localMidnight, formatDay, daysAheadOf } from '../src/services/xmltvRequests';

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { console.log('PASS ' + m); pass++; }
  else { console.log(`FAIL ${m} -- expected [${JSON.stringify(want)}] got [${JSON.stringify(got)}]`); fail++; }
};

// 2026-10-10 15:30 UTC is already 11 Oct 01:30 in Brisbane.
const now = new Date('2026-10-10T15:30:00Z');
check('today in UTC', todayIn(now, null), { y: 2026, m: 10, d: 10 });
check('today in Brisbane is a day later', todayIn(now, 'Australia/Brisbane'), { y: 2026, m: 10, d: 11 });
check('Brisbane midnight as an instant', localMidnight({ y: 2026, m: 10, d: 11 }, 'Australia/Brisbane').toISOString(), '2026-10-10T14:00:00.000Z');
check('Sydney midnight on the DST change day (AEST, +10)', localMidnight({ y: 2026, m: 10, d: 4 }, 'Australia/Sydney').toISOString(), '2026-10-03T14:00:00.000Z');
check('Sydney midnight the day after (AEDT, +11)', localMidnight({ y: 2026, m: 10, d: 5 }, 'Australia/Sydney').toISOString(), '2026-10-04T13:00:00.000Z');

check('date format YYYY-MM-DD', formatDay({ y: 2026, m: 1, d: 5 }, 'YYYY-MM-DD', null), '2026-01-05');
check('date format YYYYMMDD', formatDay({ y: 2026, m: 1, d: 5 }, 'YYYYMMDD', null), '20260105');
check('date format DD/MM/YYYY', formatDay({ y: 2026, m: 1, d: 5 }, 'DD/MM/YYYY', null), '05/01/2026');
check('date format unix is local midnight', formatDay({ y: 2026, m: 1, d: 5 }, 'unix', 'Australia/Brisbane'), String(Date.UTC(2026, 0, 4, 14) / 1000));

// ---- one request for the window
const single = planRequests({ template: 'https://api.example/guide.xml?from={from}&to={to}&days={days}&key=abc', mode: 'single', daysAhead: 7, dateFormat: 'YYYY-MM-DD', zone: 'Australia/Brisbane', now });
check('single: one request', single.requests.length, 1);
check('single: from today to today + 7 in the source zone', single.requests[0].url, 'https://api.example/guide.xml?from=2026-10-11&to=2026-10-18&days=7&key=abc');
check('single: the window ends at local midnight after the last day', single.windowEnd.toISOString(), '2026-10-18T14:00:00.000Z');
check('single: the request is not a day request', single.requests[0].day, null);

const unix = planRequests({ template: 'https://api.example/epg?start={from_unix}&end={to_unix}', mode: 'single', daysAhead: 1, dateFormat: 'YYYY-MM-DD', zone: null, now });
check('unix window placeholders', unix.requests[0].url, `https://api.example/epg?start=${Date.UTC(2026, 9, 10) / 1000}&end=${Date.UTC(2026, 9, 12) / 1000}`);

// ---- one request per day
const per = planRequests({ template: 'https://api.example/day/{date}.xml', mode: 'per_day', daysAhead: 6, dateFormat: 'YYYYMMDD', zone: null, now });
check('per day: today and the next 6 days', per.requests.map((r) => r.url.slice(-12)), ['20261010.xml', '20261011.xml', '20261012.xml', '20261013.xml', '20261014.xml', '20261015.xml', '20261016.xml']);
check('per day: each request owns its day', [per.requests[1].day, per.requests[1].from.toISOString(), per.requests[1].to.toISOString()], ['2026-10-11', '2026-10-11T00:00:00.000Z', '2026-10-12T00:00:00.000Z']);
const slash = planRequests({ template: 'https://api.example/epg?d={date}', mode: 'per_day', daysAhead: 1, dateFormat: 'DD/MM/YYYY', zone: null, now });
check('per day: slashes are URL-encoded', slash.requests[0].url, 'https://api.example/epg?d=10%2F10%2F2026');
const dst = planRequests({ template: 'https://api.example/{date}', mode: 'per_day', daysAhead: 2, dateFormat: 'YYYY-MM-DD', zone: 'Australia/Sydney', now: new Date('2026-10-03T20:00:00Z') });
check('per day across the Sydney DST change: the 23-hour day', (dst.requests[0].to.getTime() - dst.requests[0].from.getTime()) / 3_600_000, 23);

// ---- mistakes caught before saving
check('per day without {date} is refused', !!templateProblem('https://api.example/guide.xml', 'per_day'), true);
check('single with {date} is refused', !!templateProblem('https://api.example/{date}.xml', 'single'), true);
check('unknown placeholder is named', templateProblem('https://api.example/{day}.xml', 'per_day')?.includes('{day}'), true);
check('not http is refused', !!templateProblem('ftp://api.example/{date}', 'per_day'), true);
check('a plain static URL is fine', templateProblem('https://provider.example/guide.xml.gz', 'single'), null);
check('a good per-day template is fine', templateProblem('https://api.example/v1/epg?date={date}&apikey=XYZ', 'per_day'), null);

check('an API key header name is fine', headerProblem('x-api-key'), null);
check('Authorization is allowed', headerProblem('authorization'), null);
check('Host cannot be set', !!headerProblem('host'), true);
check('a header name with a space is refused', !!headerProblem('x api key'), true);

check('retry backoff 15, 30, 60, 120', [1, 2, 3, 4].map((n) => retryDelayMinutes(n, 24)), [15, 30, 60, 120]);
check('retry never waits longer than the refresh', retryDelayMinutes(9, 6), 360);
check('days ahead to one decimal', daysAheadOf(new Date(now.getTime() + 6.44 * 86_400_000), now), 6.4);

// ---- the source time zone and how times are read
check('offset read from a time', [xmltvOffset('20261010080000 +0000'), xmltvOffset('20261010190000 +11:00'), xmltvOffset('20261010190000'), xmltvOffset('20261010080000Z')], ['+0000', '+1100', null, 'Z']);
check('offset stripped', [stripOffset('20261010190000 +0000'), stripOffset('20261010190000 +11:00'), stripOffset('20261010190000')], ['20261010190000', '20261010190000', '20261010190000']);
check('a correct feed: ABC News stamped 08:00 +0000 is 19:00 in Sydney (AEDT)', parseXmltvTime('20261010080000 +0000', 'Australia/Sydney')?.toISOString(), '2026-10-10T08:00:00.000Z');
check('no offset: read in the zone given (Sydney 19:00 AEDT = 08:00 UTC)', parseXmltvTime('20261010190000', 'Australia/Sydney')?.toISOString(), '2026-10-10T08:00:00.000Z');
const wrong = [{ channel: 'c', startRaw: '20261010190000 +0000', stopRaw: '20261010193000 +0000', title: 'News', lengthSec: null, metadata: {} }];
check('a mislabelled feed read as stamped lands 11 hours late', resolveChannel(wrong, 'Australia/Sydney').ok[0].startsAt.toISOString(), '2026-10-10T19:00:00.000Z');
check('with offsets ignored it is 19:00 Sydney', resolveChannel(wrong, 'Australia/Sydney', true).ok[0].startsAt.toISOString(), '2026-10-10T08:00:00.000Z');
check('offsets ignored across the DST change (4 Oct, Sydney +10 then +11)',
  resolveChannel([{ channel: 'c', startRaw: '20261003190000 +0000', stopRaw: null, title: 'A', lengthSec: 1800, metadata: {} },
                  { channel: 'c', startRaw: '20261004190000 +0000', stopRaw: null, title: 'B', lengthSec: 1800, metadata: {} }], 'Australia/Sydney', true).ok.map((p) => p.startsAt.toISOString()),
  ['2026-10-03T09:00:00.000Z', '2026-10-04T08:00:00.000Z']);

console.log(`\nxmltv-import-api-pure.check: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
