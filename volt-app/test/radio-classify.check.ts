/**
 * ICY classifier rules, pinned against titles observed on the REAL test
 * stations (SomaFM, NPO Radio 1, WFMU, WPLN, NA0D). These are the cases that
 * decide whether a station's log is useful for clipping, and whether
 * transcription is pointed at speech instead of music.
 *   npx tsx test/radio-classify.check.ts
 */
import { classifyIcyTitle } from '../src/services/radio/icyMeta';

let pass = 0, fail = 0;
function eq(label: string, got: string, want: string) {
  if (got === want) { console.log(`PASS ${label}`); pass++; }
  else { console.log(`FAIL ${label}: got ${got}, want ${want}`); fail++; }
}

// ---- songs: the shapes real music stations send ----------------------------
eq('SomaFM "Artist - Title"', classifyIcyTitle('Alex Cortiz - Funked up flow'), 'song');
eq('en dash separator', classifyIcyTitle('Bonobo – Kerala'), 'song');
eq('WFMU quoted-by form', classifyIcyTitle('"Wonderful Thing" by Ralfi Pagan on Marty McSorley'), 'song');
eq('feat. does not become programme info', classifyIcyTitle('Calvin Harris - Summer ft. Example'), 'song');

// ---- programme / station info (content) ------------------------------------
eq('NPO three-part programme line',
  classifyIcyTitle('NPO Radio 1 - De Ochtend - KRO-NCRV', { stationName: 'NPO Radio1' }), 'content');
eq('title repeating the station name',
  classifyIcyTitle('WPLN-FM News - Morning Edition', { stationName: 'WPLN-FM' }), 'content');
eq('news keyword', classifyIcyTitle('News bulletin with Dana Reeves'), 'content');
eq('ham repeater id', classifyIcyTitle('Baxter 575 Repeater net control'), 'content');
eq('DJ talk', classifyIcyTitle('DJ Max morning show'), 'content');

// ---- advertising -----------------------------------------------------------
eq('explicit advert', classifyIcyTitle('Advert: Crunchy Cola refreshes best'), 'ad');
eq('underwriting spot', classifyIcyTitle('Underwriting message'), 'ad');

// ---- the blank-title case: CONTEXT decides ---------------------------------
eq('blank on a music station = ad break', classifyIcyTitle('', { songsSeen: 5 }), 'ad');
eq('blank on a speech station = content', classifyIcyTitle('', { songsSeen: 0 }), 'content');
eq('blank before any song is not called advertising', classifyIcyTitle('', { songsSeen: 1 }), 'content');

console.log(`\nradio-classify: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
