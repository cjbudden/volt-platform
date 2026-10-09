// ============================================================================
//  XMLTV IN, the reader and the mapping, without a database.
//
//  The strongest single check is the ROUND TRIP: a guide written by our own
//  exporter (services/xmltv.ts) read back by the importer gives back the same
//  titles, times and metadata. Around it, the cases real files throw at a
//  reader: entities and multi-byte characters split across chunks, CDATA,
//  comments, a DOCTYPE with an internal subset, times with no offset either
//  side of a DST change, zero-based xmltv_ns, a missing stop, a truncated file.
//
//  Usage: npx tsx test/xmltv-import-pure.check.ts
// ============================================================================
import { buildXmltv, type XmltvChannel } from '../src/services/xmltv';
import { XmlStream, mapChannel, mapProgramme, parseXmltvTime, parseXmltvNs, resolveChannel, decodeEntities, type XmlNode, type XmltvProgrammeIn } from '../src/services/xmltvParse';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `expected [${JSON.stringify(want)}] got [${JSON.stringify(got)}]`);
const truthy = (m: string, v: unknown, d = '') => (v ? ok(m) : bad(m, d || `got [${JSON.stringify(v)}]`));

/** Read a document in chunks of `size` characters, collecting channels and programmes. */
function read(doc: string, size = 7) {
  const nodes: XmlNode[] = [];
  const s = new XmlStream(new Set(['channel', 'programme']), (n) => nodes.push(n));
  for (let i = 0; i < doc.length; i += size) s.write(doc.slice(i, i + size));
  s.end();
  return {
    channels: nodes.filter((n) => n.name === 'channel').map(mapChannel),
    programmes: nodes.filter((n) => n.name === 'programme').map((n) => mapProgramme(n)!).filter(Boolean),
  };
}

console.log('== round trip through our own exporter ==');
const ch: XmltvChannel = { xmltvId: 'news.volt.example', displayNames: ['Volt News & Sport', '101'], icon: 'https://cdn.example/n.png', tz: 'Australia/Sydney', medium: 'tv', lang: 'en' };
const rows = [
  { title: 'Morning <Live> & “Quoted”', starts_at: '2026-10-03T20:00:00Z', ends_at: '2026-10-03T23:00:00Z',
    metadata: { subTitle: 'Saturday', description: 'Line 1\nLine 2 — café', genre: 'News', categories: ['News', 'Current affairs'], tags: ['politics'],
      season: 3, episodeNumber: 12, rating: 'PG', ratingSystem: 'ACMA', premiere: true, isNew: true, repeat: true,
      credits: [{ role: 'presenter', name: 'A. Anchor' }, { role: 'actor', name: 'Sam', character: 'Self' }], icon: 'https://cdn.example/p.jpg', country: 'AU' } },
  { title: 'Across the DST change', starts_at: '2026-10-04T14:00:00Z', ends_at: '2026-10-04T16:00:00Z', metadata: {} },
];
const doc = buildXmltv([ch], rows.map((row) => ({ channel: ch, row })), { timeBasis: 'scheduled', tzMode: 'local', lang: 'en' });
const back = read(doc, 5);
check('one channel back, same id', back.channels.map((c) => c.id), ['news.volt.example']);
check('display names back, entities decoded', back.channels[0].displayNames, ['Volt News & Sport', '101']);
check('icon back', back.channels[0].icon, 'https://cdn.example/n.png');
check('two programmes back', back.programmes.length, 2);
const res = resolveChannel(back.programmes, 'Australia/Sydney');
check('start instants identical (offsets honoured both sides of DST)', res.ok.map((p) => p.startsAt.toISOString()), rows.map((r) => new Date(r.starts_at).toISOString()));
check('end instants identical', res.ok.map((p) => p.endsAt.toISOString()), rows.map((r) => new Date(r.ends_at).toISOString()));
const m = res.ok[0].metadata;
check('title with markup and quotes', res.ok[0].title, 'Morning <Live> & “Quoted”');
check('description with newline and non-ASCII', m.description, 'Line 1\nLine 2 — café');
check('sub-title', m.subTitle, 'Saturday');
check('categories', [m.genre, m.categories], ['News', ['News', 'Current affairs']]);
check('season and episode survive the zero-based xmltv_ns', [m.season, m.episodeNumber], [3, 12]);
check('rating and its system', [m.rating, m.ratingSystem], ['PG', 'ACMA']);
check('flags', [m.premiere, m.isNew, m.repeat], [true, true, true]);
check('credits with the actor role', m.credits, [{ role: 'actor', name: 'Sam', character: 'Self' }, { role: 'presenter', name: 'A. Anchor' }]);
check('keywords and icon and country', [m.tags, m.icon, m.country], [['politics'], 'https://cdn.example/p.jpg', 'AU']);

console.log('\n== the reader ==');
check('entities and numeric references', decodeEntities('A &amp; B &lt;C&gt; &#233; &#x263A; &bogus;'), 'A & B <C> é ☺ &bogus;');
const odd = `<?xml version="1.0"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd" [ <!ENTITY x "y"> ]>
<!-- a comment with <programme> inside it -->
<tv generator-info-name="other">
  <channel id="a.example"><display-name lang="en"><![CDATA[Fish & <Chips>]]></display-name></channel>
  <programme start="20261010090000 +0000" stop="20261010100000 +0000" channel="a.example">
    <title lang="de">Nachrichten</title><title lang="en">News</title>
    <unknown-element foo='bar'>ignored</unknown-element>
    <episode-num system="onscreen">S1 E2</episode-num>
    <length units="minutes">45</length>
  </programme>
  <programme start="20261010100000 +0000" channel="a.example"><title>No stop, next starts later</title></programme>
  <programme start="20261010110000 +0000" channel="a.example"><title>Last, has a length</title><length units="hours">1.5</length></programme>
  <programme start="20261010130000 +0000" channel="a.example"><title>Last and no length</title></programme>
</tv>`;
const r2 = read(odd, 3);
check('CDATA kept literally', r2.channels[0].displayNames, ['Fish & <Chips>']);
check('a comment containing a tag is not a programme', r2.programmes.length, 4);
check('first title when no language asked', r2.programmes[0].title, 'Nachrichten');
const nodes: XmlNode[] = []; const s2 = new XmlStream(new Set(['programme']), (n) => nodes.push(n)); s2.write(odd); s2.end();
check('the preferred language title when asked', mapProgramme(nodes[0], 'en')!.title, 'News');
check('onscreen episode kept as text', r2.programmes[0].metadata.episode, 'S1 E2');
const r2res = resolveChannel(r2.programmes, null);
check('missing stop = next start', r2res.ok[1].endsAt.toISOString(), '2026-10-10T11:00:00.000Z');
check('missing stop with a later programme: the next start wins over the length (end = next start)', r2res.ok[2].endsAt.toISOString(), '2026-10-10T13:00:00.000Z');
const lenOnly = resolveChannel([{ channel: 'c', startRaw: '20261010110000 +0000', stopRaw: null, title: 'L', lengthSec: 5400, metadata: {} }], null);
check('missing stop and nothing after: the length is used', lenOnly.ok[0]?.endsAt.toISOString(), '2026-10-10T12:30:00.000Z');
check('the last one with neither is reported, not invented', [r2res.noEnd, r2res.ok.length], [1, 3]);

const multibyte = '<tv><channel id="x"><display-name>Ünïcödé 日本 ☺</display-name></channel></tv>';
check('multi-byte text survives one-character chunks', read(multibyte, 1).channels[0].displayNames, ['Ünïcödé 日本 ☺']);
check('an entity split across chunks decodes whole', read('<tv><channel id="x"><display-name>A &amp; B</display-name></channel></tv>', 1).channels[0].displayNames, ['A & B']);
let threw = '';
try { read('<tv><channel id="x"><display-name>cut off', 4); } catch (e: any) { threw = e.message; }
truthy('a truncated file is an error, not a silent partial import', /truncated/.test(threw), threw);
threw = '';
try { read('<tv><channel id="x"></programme></tv>'); } catch (e: any) { threw = e.message; }
truthy('mismatched tags are an error', /Mismatched/.test(threw), threw);

console.log('\n== times ==');
check('explicit offset', parseXmltvTime('20261010183000 +1000', null)?.toISOString(), '2026-10-10T08:30:00.000Z');
check('offset with a colon', parseXmltvTime('20261010183000 -05:30', null)?.toISOString(), '2026-10-11T00:00:00.000Z');
check('no offset resolved in the channel zone (Sydney, before DST)', parseXmltvTime('20261003220000', 'Australia/Sydney')?.toISOString(), '2026-10-03T12:00:00.000Z');
check('no offset resolved in the channel zone (Sydney, after DST)', parseXmltvTime('20261005230000', 'Australia/Sydney')?.toISOString(), '2026-10-05T12:00:00.000Z');
check('no offset and no zone is UTC', parseXmltvTime('20261010090000', null)?.toISOString(), '2026-10-10T09:00:00.000Z');
check('partial time (minutes)', parseXmltvTime('202610100930 +0000', null)?.toISOString(), '2026-10-10T09:30:00.000Z');
check('date only', parseXmltvTime('20261010', 'UTC')?.toISOString(), '2026-10-10T00:00:00.000Z');
check('garbage is null, not a guess', parseXmltvTime('next tuesday', 'UTC'), null);

console.log('\n== xmltv_ns ==');
check('"1.4." is season 2 episode 5', parseXmltvNs('1.4.'), { season: 2, episodeNumber: 5 });
check('"0.2/10.0/2" with totals and part', parseXmltvNs('0.2/10.0/2'), { season: 1, episodeNumber: 3, episodeCount: 10, part: 1 });
check('episode only', parseXmltvNs('.6.'), { episodeNumber: 7 });

console.log('\n== resolution ==');
const unsorted: XmltvProgrammeIn[] = [
  { channel: 'c', startRaw: '20261010120000 +0000', stopRaw: null, title: 'B', lengthSec: null, metadata: {} },
  { channel: 'c', startRaw: '20261010100000 +0000', stopRaw: null, title: 'A', lengthSec: null, metadata: {} },
  { channel: 'c', startRaw: 'nonsense', stopRaw: null, title: 'X', lengthSec: null, metadata: {} },
];
const rr = resolveChannel(unsorted, null);
check('sorted by start before resolving', rr.ok.map((p) => p.title), ['A']);
check('an unreadable start is counted', rr.badTime, 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
