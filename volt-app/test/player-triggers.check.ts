// ============================================================================
//  PLAYER SIDE OF IN-STREAM GRAPHIC TRIGGERS (volt-player/src/sdk/triggers.ts).
//
//  Every case here was learned from a real Shaka run (live HLS and DASH through
//  the encoder's own timed_events.py), not guessed:
//    - Shaka splits one DATERANGE into one metadata region PER ATTRIBUTE and drops
//      ID, so the player regroups by class + times and dedupes on X-ID;
//    - Shaka hands DASH attribute values over still XML-escaped, so messageData
//      arrives as {&quot;title&quot;:...} and must be unescaped before JSON.parse;
//    - a retimed programme must REPLACE the copy the player already holds.
//
//  Usage: npx tsx test/player-triggers.check.ts   (no database)
// ============================================================================
import {
  fromHlsRegions, fromDashRegion, fromNativeCues, mergeGraphics, activeAt, upNextFromGraphic, xmlUnescape,
} from '../../volt-player/src/sdk/triggers';
import { resolveTheme } from '../../volt-player/src/sdk/theme';
import type { StreamGraphic } from '../../volt-player/src/sdk/types';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- expected ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `[${JSON.stringify(want)}] got [${JSON.stringify(got)}]`);

// One DATERANGE as Shaka 4.16 reports it: a region per attribute, no ID.
const hls = (cls: string, start: number, end: number, attrs: Record<string, string>) =>
  Object.entries(attrs).map(([key, data]) => ({ startTime: start, endTime: end, metadataType: cls, payload: { key, data } }));

console.log('== HLS: regions regrouped into one graphic ==');
const up = fromHlsRegions(hls('com.boomlabs.volt.graphic', 71.7, 83.7,
  { 'X-ID': 'up-next:p1', 'X-GRAPHIC': 'up-next', 'X-TITLE': 'Evening Bulletin', 'X-STARTS': '2026-10-20T18:30:00.000Z', 'X-SUBTITLE': 'Live from the harbour' }));
check('five attribute regions become one graphic', up.length, 1);
check('its id is the X-ID the server repeats', up[0].id, 'up-next:p1');
check('its kind', up[0].graphic, 'up-next');
check('keys are lower case without the X-', Object.keys(up[0].data).sort(), ['graphic', 'id', 'starts', 'subtitle', 'title']);
check('media times kept', [up[0].start, up[0].end], [71.7, 83.7]);
const mixed = fromHlsRegions([
  ...hls('com.boomlabs.volt.programme', 0, 3600, { 'X-ID': 'p1', 'X-TITLE': 'Morning Show' }),
  ...hls('com.apple.quicktime.HLS', 0, 10, { 'X-COM-EXAMPLE': 'x' }),
  ...hls('com.example.ads', 5, 35, { 'X-AD': '1' }),
]);
check('someone else\'s classes are ignored', mixed.map((g) => g.graphic), ['programme']);
check('an older server without X-ID still groups, by class and times', fromHlsRegions(hls('com.boomlabs.volt.programme', 10, 20, { 'X-TITLE': 'T' }))[0].id, 'com.boomlabs.volt.programme@10');

console.log('\n== DASH: escaped messageData ==');
const esc = '{&quot;graphic&quot;:&quot;up-next&quot;,&quot;title&quot;:&quot;Six O&apos;Clock &amp; More&quot;}';
const d = fromDashRegion({ schemeIdUri: 'urn:com:boomlabs:volt:graphic:2026', value: 'up-next', startTime: 342, endTime: 354, id: '1232061384',
  eventNode: { attributes: { messageData: esc } } });
check('Shaka\'s still-escaped attribute parses', d?.data.title, "Six O'Clock & More");
check('graphic from the payload', d?.graphic, 'up-next');
check('stable id from scheme and Event@id', d?.id, 'urn:com:boomlabs:volt:graphic:2026#1232061384');
const decoded = fromDashRegion({ schemeIdUri: 'urn:com:boomlabs:volt:graphic:2026', startTime: 1, endTime: 2, id: '9',
  eventElement: { getAttribute: () => '{"graphic":"up-next","title":"A & B"}' } });
check('a parser that already decoded is not double-decoded into nonsense', decoded?.data.title, 'A & B');
check('another scheme is not ours', fromDashRegion({ schemeIdUri: 'urn:scte:scte35:2013:xml', startTime: 1 }), null);
check('broken JSON is an empty payload, not a throw', fromDashRegion({ schemeIdUri: 'urn:com:boomlabs:volt:graphic:2026', value: 'up-next', startTime: 1, endTime: 2, eventNode: { attributes: { messageData: '{oops' } } })?.graphic, 'up-next');
check('numeric references decode', xmlUnescape('&#39;&#x41;'), "'A");

console.log('\n== Safari DataCues ==');
const nat = fromNativeCues([
  { id: 'up-next:p1', type: 'com.boomlabs.volt.graphic', startTime: 5, endTime: 17, value: { key: 'X-TITLE', data: 'Evening Bulletin' } },
  { id: 'up-next:p1', type: 'com.boomlabs.volt.graphic', startTime: 5, endTime: 17, value: { key: 'X-GRAPHIC', data: 'up-next' } },
  { id: 'up-next:p1', type: 'com.boomlabs.volt.graphic', startTime: 5, endTime: 17, value: { key: 'X-ID', data: 'up-next:p1' } },
]);
check('cues per attribute become one graphic', [nat.length, nat[0]?.graphic, nat[0]?.data.title], [1, 'up-next', 'Evening Bulletin']);

console.log('\n== what is on screen, and a retimed programme ==');
const store = new Map<string, StreamGraphic>();
mergeGraphics(store, fromHlsRegions(hls('com.boomlabs.volt.programme', 0, 100, { 'X-ID': 'p1', 'X-TITLE': 'Morning Show' })));
mergeGraphics(store, fromHlsRegions(hls('com.boomlabs.volt.programme', 0, 250, { 'X-ID': 'p1', 'X-TITLE': 'Morning Show' })));
check('the retimed copy replaces the old one (one programme, new end)', [store.size, store.get('p1')?.end], [1, 250]);
mergeGraphics(store, up);
check('at 75 s: the programme and the up next card', activeAt(store.values(), 75).map((g) => g.graphic), ['programme', 'up-next']);
check('at 90 s: the card has gone', activeAt(store.values(), 90).map((g) => g.graphic), ['programme']);
check('a viewer who scrubs back into the window sees it again', activeAt(store.values(), 72).some((g) => g.graphic === 'up-next'), true);
mergeGraphics(store, [], 5000);
check('long-past graphics are forgotten so a 24 h session does not grow', store.size, 0);

console.log('\n== the card ==');
const wall = Date.parse('2026-10-20T18:28:00.000Z');
const card = upNextFromGraphic(up[0], 72, wall);
check('counts down to the next programme\'s start by the playhead clock', card.inMs, 120000);
check('lasts as long as the trigger', card.totalMs, 12000);
check('names it', [card.title, card.subtitle, card.kind, card.autoAdvance], ['Evening Bulletin', 'Live from the harbour', 'programme', false]);
check('without a wall clock it counts to the card\'s own end', upNextFromGraphic(up[0], 80, null).inMs, 3700);

console.log('\n== the switch ==');
check('graphics are on by default', resolveTheme().showGraphics, true);
check('a saved setup can turn them off', resolveTheme({ showGraphics: false }).showGraphics, false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
