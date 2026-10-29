// KEY METADATA IN THE MANIFESTS: what now / next displays read from the
// programme markers (graphicTriggers.ts keyMetadata + buildTriggers). Pure.
import { keyMetadata, buildTriggers, hlsTag, dashEvent, DEFAULT_GRAPHICS } from '../src/services/graphicTriggers';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m); } };

console.log('== key metadata ==');
const km = keyMetadata({ series: 'Drama Hour' }, { description: 'A "quiet" town,\nand a storm.', genre: ['Drama', 'Mystery'], season: 1, episode: 3, contentRating: 'M', releaseYear: 2024, inLanguage: 'en' }, { assetId: 'a1', durationSec: 1800.4 });
ok(km.DESCRIPTION === 'A quiet town, and a storm.', 'description on one line, with no quotes');
ok(km.GENRE === 'Drama, Mystery', 'a list of genres joined');
ok(km.SERIES === 'Drama Hour' && km.SEASON === '1' && km.EPISODE === '3', 'series, season and episode');
ok(km.RATING === 'M' && km.YEAR === '2024' && km.LANGUAGE === 'en', 'rating, year and language from schema.org-style names');
ok(km.ASSET === 'a1' && km.DURATION === '1800', 'asset id and whole-second duration');
ok(!('ARTIST' in km), 'only what is set');
const long = keyMetadata({}, { description: 'word '.repeat(200) });
ok(long.DESCRIPTION!.length <= 282 && long.DESCRIPTION!.endsWith('…'), 'a long description is cut on a word');
const song = keyMetadata({}, { artist: 'Siti', album: 'Best Of' }, { audio: true });
ok(song.ARTIST === 'Siti' && song.ALBUM === 'Best Of' && song.MEDIA === 'audio', 'a song carries artist, album and that it is audio');

console.log('== now and next in the programme marker ==');
const t0 = Date.parse('2026-10-28T10:00:00Z');
const items = [
  { id: 'p1', title: 'Episode 3', startsAt: new Date(t0), endsAt: new Date(t0 + 1800_000), kind: 'content', extra: km },
  { id: 'p2', title: 'Episode 4', subtitle: 'The flood', startsAt: new Date(t0 + 1800_000), endsAt: new Date(t0 + 3600_000), kind: 'content', imageUrl: 'https://cdn.example/p4.jpg', extra: { GENRE: 'Drama', EPISODE: '4', DESCRIPTION: 'Water rises.' } },
];
const tr = buildTriggers(items as any, DEFAULT_GRAPHICS);
const p1 = tr.find((t) => t.id === 'p1')!;
ok(p1.data.DESCRIPTION === km.DESCRIPTION && p1.data.GENRE === 'Drama, Mystery', 'the programme marker carries its key metadata');
ok(p1.data['NEXT-TITLE'] === 'Episode 4' && p1.data['NEXT-START'] === new Date(t0 + 1800_000).toISOString(), 'and what is next, with its start');
ok(p1.data['NEXT-SUBTITLE'] === 'The flood' && p1.data['NEXT-IMAGE'] === 'https://cdn.example/p4.jpg', 'next subtitle and image');
const tag = hlsTag(p1);
ok(/X-DESCRIPTION="A quiet town, and a storm\."/.test(tag) && /X-NEXT-TITLE="Episode 4"/.test(tag), 'in the HLS DATERANGE as X- attributes');
const de = dashEvent(p1);
const body = JSON.parse(de.messageData);
ok(body.description === km.DESCRIPTION && body['next-title'] === 'Episode 4', 'in the DASH event payload (lower-case keys, the player normalises to next_title)');
const up = tr.find((t) => t.graphic === 'up-next');
ok(!!up && up.data.GENRE === 'Drama' && up.data.EPISODE === '4' && up.data.DESCRIPTION === 'Water rises.', 'Up next repeats the next programme\'s key fields');
const p2 = tr.find((t) => t.id === 'p2')!;
ok(!('NEXT-TITLE' in p2.data), 'the last programme names no next');

console.log(`\nstream-metadata: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
