// ============================================================================
//  XMLTV OUT — the format rules, pinned without a database.
//
//  Builds documents from fixture rows and checks: offsets per instant (DST),
//  zero-based xmltv_ns, escaping and control-character stripping, DTD element
//  order, as-run vs scheduled, radio marking, and finally validates every
//  document against the real xmltv.dtd (test/fixtures/xmltv.dtd, from the
//  XMLTV project) with xmllint, which is what tv_validate_file does too.
//
//  Usage: npx tsx test/xmltv-pure.check.ts
// ============================================================================
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildXmltv, xmltvTime, zoneOffsetMinutes, episodeNums, xmlText, listedSpan, langCode,
  type XmltvChannel,
} from '../src/services/xmltv';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `expected [${JSON.stringify(want)}] got [${JSON.stringify(got)}]`);
const truthy = (m: string, v: unknown, d = '') => (v ? ok(m) : bad(m, d || `expected truthy, got [${String(v)}]`));

console.log('== times ==');
check('UTC instant in UTC', xmltvTime('2026-10-10T09:00:00Z', 'UTC'), '20261010090000 +0000');
check('Brisbane has no DST: +1000', xmltvTime('2026-10-10T09:00:00Z', 'Australia/Brisbane'), '20261010190000 +1000');
check('Sydney before DST change (4 Oct 2026, 2am) is +1000', xmltvTime('2026-10-03T12:00:00Z', 'Australia/Sydney'), '20261003220000 +1000');
check('Sydney after DST change is +1100', xmltvTime('2026-10-05T12:00:00Z', 'Australia/Sydney'), '20261005230000 +1100');
check('London summer +0100', xmltvTime('2026-07-01T17:30:00Z', 'Europe/London'), '20260701183000 +0100');
check('New York winter -0500', xmltvTime('2026-01-15T17:00:00Z', 'America/New_York'), '20260115120000 -0500');
check('half-hour zone (Adelaide winter +0930)', xmltvTime('2026-07-01T00:00:00Z', 'Australia/Adelaide'), '20260701093000 +0930');
check('India +0530', zoneOffsetMinutes(new Date('2026-07-01T00:00:00Z'), 'Asia/Kolkata'), 330);
check('unknown zone falls back to UTC, never throws', xmltvTime('2026-07-01T00:00:00Z', 'Not/AZone'), '20260701000000 +0000');
check('local time crosses midnight correctly', xmltvTime('2026-12-31T20:00:00Z', 'Pacific/Auckland'), '20270101090000 +1300');

console.log('\n== episode numbering ==');
check('S2E5 is xmltv_ns 1.4. (zero based) plus onscreen', episodeNums({ season: 2, episodeNumber: 5 }), [{ system: 'xmltv_ns', value: '1.4.' }, { system: 'onscreen', value: 'S2E5' }]);
check('episode of total', episodeNums({ season: 1, episodeNumber: 3, episodeCount: 10 })[0], { system: 'xmltv_ns', value: '0.2/10.' });
check('episode only', episodeNums({ episodeNumber: 7 })[0], { system: 'xmltv_ns', value: '.6.' });
check('free text episode is onscreen', episodeNums({ episode: 'Ep 12' }), [{ system: 'onscreen', value: 'Ep 12' }]);
check('nothing in, nothing out', episodeNums({}), []);

console.log('\n== escaping ==');
check('ampersand and angle brackets', xmlText('Tom & Jerry <live>'), 'Tom &amp; Jerry &lt;live&gt;');
check('control characters stripped', xmlText('Bell\u0007 and \u001Fend'), 'Bell and end');
check('tabs and newlines kept', xmlText('a\tb\nc'), 'a\tb\nc');
check('lone surrogate stripped', xmlText('x\uD800y'), 'xy');
check('emoji (valid pair) kept', xmlText('Goal \u{26BD}'), 'Goal ⚽');
check('lang code accepted', langCode('en-AU'), 'en-AU');
check('a language NAME is not a lang code', langCode('English'), null);

console.log('\n== as-run vs scheduled ==');
const row = { title: 'X', starts_at: '2026-10-10T09:00:00Z', ends_at: '2026-10-10T10:00:00Z', actual_start: '2026-10-10T09:02:10Z', actual_end: '2026-10-10T10:04:00Z' };
check('scheduled uses the plan', listedSpan(row, 'scheduled').start.toISOString(), '2026-10-10T09:00:00.000Z');
check('asrun uses the observed airing', listedSpan(row, 'asrun').start.toISOString(), '2026-10-10T09:02:10.000Z');
check('asrun without actuals falls back to plan', listedSpan({ ...row, actual_start: null, actual_end: null }, 'asrun').stop.toISOString(), '2026-10-10T10:00:00.000Z');
check('asrun with only a start keeps the planned end', listedSpan({ ...row, actual_end: null }, 'asrun').stop.toISOString(), '2026-10-10T10:00:00.000Z');

console.log('\n== documents ==');
const tv: XmltvChannel = { xmltvId: 'news.volt.example', displayNames: ['Volt News', '101'], icon: 'https://cdn.example/n.png', url: 'https://volt.example', tz: 'Australia/Brisbane', medium: 'tv', lang: 'en' };
const radio: XmltvChannel = { xmltvId: '0000000e-0000-0000-0000-0000000000aa', displayNames: ['Volt FM'], tz: 'Europe/London', medium: 'radio', lang: 'English' };
const full = {
  title: 'Evening News & Weather', starts_at: '2026-10-10T08:00:00Z', ends_at: '2026-10-10T09:00:00Z',
  metadata: {
    subTitle: 'Friday <edition>', description: 'Headlines\u0007 from "everywhere"',
    credits: [{ role: 'presenter', name: 'A. Anchor' }, { role: 'director', name: 'D. Rector' }, { role: 'actor', name: 'Sam', character: 'Self' }, { role: 'stagehand', name: 'Odd Role' }],
    'credits.commentator': ['C One', 'C Two'],
    genre: 'News', categories: ['Current affairs', 'News'], tags: ['politics', 'bulletin'],
    language: 'en', icon: 'https://cdn.example/p.jpg', url: 'https://volt.example/news',
    country: 'AU', season: 3, episodeNumber: 12, premiere: true, isNew: true, subtitles: true,
    rating: 'PG', ratingSystem: 'ACMA', starRating: '4/5', date: '2026-10-10',
  },
};
const minimal = { title: 'Breakfast', starts_at: '2026-10-10T20:00:00Z', ends_at: '2026-10-10T23:00:00Z', metadata: {} };
const music = { title: 'Late Jazz', starts_at: '2026-10-10T22:00:00Z', ends_at: '2026-10-11T00:00:00Z', metadata: { genre: ['Jazz'], repeat: true } };
const doc = buildXmltv([tv, radio], [
  { channel: tv, row: full }, { channel: tv, row: minimal }, { channel: radio, row: music },
], { timeBasis: 'scheduled', tzMode: 'local', lang: 'en', generatedAt: new Date('2026-10-10T00:00:00Z') });

truthy('doctype points at xmltv.dtd', doc.includes('<!DOCTYPE tv SYSTEM "xmltv.dtd">'));
truthy('time basis is stated in the document', doc.includes('<!-- times: scheduled; zone: channel local -->'));
truthy('channels come before programmes', doc.lastIndexOf('<channel ') < doc.indexOf('<programme '));
truthy('channel number is a second display-name', doc.includes('<display-name lang="en">101</display-name>'));
truthy('programme uses the operator xmltv id', doc.includes('channel="news.volt.example"'));
truthy('programme start is channel-local with offset', doc.includes('start="20261010180000 +1000" stop="20261010190000 +1000"'));
truthy('title escaped', doc.includes('<title lang="en">Evening News &amp; Weather</title>'));
truthy('control char gone from desc', doc.includes('<desc lang="en">Headlines from "everywhere"</desc>'));
truthy('categories de-duplicated', (doc.match(/<category lang="en">News<\/category>/g) ?? []).length === 1);
truthy('xmltv_ns zero based', doc.includes('<episode-num system="xmltv_ns">2.11.</episode-num>'));
truthy('rating with system', doc.includes('<rating system="ACMA">'));
truthy('unknown credit role carried as guest', doc.includes('<guest>Odd Role</guest>'));
truthy('actor carries the character', doc.includes('<actor role="Self">Sam</actor>'));
truthy('credits in DTD order (director before presenter)', doc.indexOf('<director>') < doc.indexOf('<presenter>'));
truthy('radio programme says no video', /channel="0000000e[^"]*"[\s\S]*<video>\s*<present>no<\/present>/.test(doc));
truthy('radio channel name "English" is not used as a lang attribute', !doc.includes('lang="English"'));
truthy('radio London times are BST', doc.includes('start="20261010230000 +0100"'));
truthy('repeat becomes previously-shown', doc.includes('<previously-shown/>'));

const utc = buildXmltv([tv], [{ channel: tv, row: minimal }], { timeBasis: 'asrun', tzMode: 'utc' });
truthy('tz=utc writes +0000', utc.includes('start="20261010200000 +0000"'));
truthy('as-run documents say so', utc.includes('times: as-run'));
const nasty = buildXmltv([{ ...tv, displayNames: ['A & B <C>'] }], [], { timeBasis: 'scheduled', tzMode: 'local' });

console.log('\n== DTD validation (xmllint against the XMLTV project DTD) ==');
const lint = spawnSync('xmllint', ['--version'], { encoding: 'utf8' });
if (lint.error) {
  console.log('SKIP xmllint not installed; DTD validation not run (macOS and most Linux images ship it)');
} else {
  const dir = mkdtempSync(join(tmpdir(), 'xmltv-'));
  copyFileSync(join(__dirname, 'fixtures/xmltv.dtd'), join(dir, 'xmltv.dtd'));
  for (const [name, body] of [['full', doc], ['utc-asrun', utc], ['escaped-channel', nasty]] as const) {
    const f = join(dir, `${name}.xml`);
    writeFileSync(f, body);
    const r = spawnSync('xmllint', ['--noout', '--valid', f], { encoding: 'utf8', cwd: dir });
    r.status === 0 ? ok(`${name} validates against xmltv.dtd`) : bad(`${name} validates against xmltv.dtd`, (r.stderr || '').slice(0, 600));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
