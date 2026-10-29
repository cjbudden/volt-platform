// ============================================================================
//  COMPANION FILES: the pure part, pinned (services/companions/formats.ts and
//  delivery.ts, docs/COMPANION_FILES.md). No database.
//
//  Formats told apart by content; language and flags from file names; SRT,
//  WebVTT and TTML (clock, frames, ticks, div offsets) read into cues; the
//  checks; clean WebVTT out with an offset and a timestamp map; JSON, XML
//  (NFO) and CSV sidecars flattened and matched to content-type fields; the
//  HLS master and DASH manifest gaining subtitle tracks; the tfdt clock.
//
//  Usage: npx tsx test/companion-files.check.ts
// ============================================================================
import {
  detectFormat, kindOf, nameHints, parseSrt, parseVtt, parseTtml, checkCaptions, toVtt, vttTime, parseSidecar, matchFields, languageName,
} from '../src/services/companions/formats';
import { withHlsSubtitles, subtitlePlaylist, withDashSubtitles, timestampMap, readTfdt, readTimescale } from '../src/services/companions/delivery';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const eq = (m: string, got: unknown, want: unknown) => JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
const yes = (m: string, c: boolean, d = '') => (c ? ok(m) : bad(m, d || 'false'));

console.log('== what a file is ==');
const SRT = '﻿1\r\n00:00:01,000 --> 00:00:03,500\r\n<i>Hello</i> {\\an8}there\r\n\r\n2\r\n00:00:03,400 --> 00:00:05,000\r\n<font color="red">Second</font> & more\r\nline two\r\n\r\n3\r\n00:00:07,000 --> 00:00:06,000\r\nBackwards\r\n';
eq('srt by content', detectFormat('x.txt', SRT), 'srt');
eq('vtt by content', detectFormat('x', 'WEBVTT\n\n00:01.000 --> 00:02.000\nHi'), 'vtt');
eq('ttml by content', detectFormat('x.xml', '<?xml version="1.0"?>\n<tt xmlns="http://www.w3.org/ns/ttml"><body/></tt>'), 'ttml');
eq('json sidecar', detectFormat('m.json', '{"title":"x"}'), 'json');
eq('nfo is xml', detectFormat('movie.nfo', '<movie><title>x</title></movie>'), 'xml');
eq('csv', detectFormat('m.csv', 'field,value\ntitle,X'), 'csv');
eq('kinds', ['srt', 'json', 'unknown'].map((f) => kindOf(f as any)), ['captions', 'metadata', 'other']);

console.log('== names ==');
eq('movie.en.srt', nameHints('movie.en.srt'), { language: 'en', forced: false, sdh: false });
eq('Movie_FR.vtt', nameHints('Movie_FR.vtt').language, 'fr');
eq('pt-BR forced', nameHints('film.pt-BR.forced.srt'), { language: 'pt-BR', forced: true, sdh: false });
eq('eng sdh', nameHints('show.eng.sdh.srt'), { language: 'en', forced: false, sdh: true });
eq('no language', nameHints('episode-12.srt').language, null);
eq('a title that starts with a code is not a language', nameHints('de-bruges.srt').language, null);
eq('just a code is the language', nameHints('de.srt').language, 'de');
eq('language names', [languageName('fr'), languageName('pt-BR'), languageName(null)], ['French', 'Brazilian Portuguese', 'Subtitles']);

console.log('== reading captions ==');
const s = parseSrt(SRT);
eq('srt cue count', s.length, 3);
eq('srt times', [s[0].startMs, s[0].endMs], [1000, 3500]);
eq('srt styling to vtt', s[0].text, '<i>Hello</i> there');
eq('srt font dropped, & escaped, two lines', s[1].text, 'Second &amp; more\nline two');
const v = parseVtt('WEBVTT\nKind: captions\n\nNOTE a note\n\nintro\n00:00:01.000 --> 00:00:02.000 line:0 align:start\nTop\n\n01:02.500 --> 01:04.000\n<v Anna>Short form</v>');
eq('vtt cues', v.map((c) => [c.startMs, c.endMs, c.text]), [[1000, 2000, 'Top'], [62500, 64000, '<v Anna>Short form</v>']]);
eq('vtt settings and id kept', [v[0].settings, v[0].id], ['line:0 align:start', 'intro']);
const TT = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" xmlns:tts="http://www.w3.org/ns/ttml#styling" ttp:frameRate="25" ttp:tickRate="10000000">
<body><div begin="00:00:10.000">
<p begin="00:00:01.000" end="00:00:02.500">One<br/>two</p>
<p begin="00:00:03:12" dur="1s"><span tts:fontStyle="italic">Frames</span> &amp; &apos;ticks&apos;</p>
<p begin="60000000t" end="70000000t">Ticks</p>
</div></body></tt>`;
const t = parseTtml(TT);
eq('ttml with div offset, frames, ticks', t.map((c) => [c.startMs, c.endMs, c.text]), [[11000, 12500, 'One\ntwo'], [13480, 14480, '<i>Frames</i> &amp; \'ticks\''], [16000, 17000, 'Ticks']]);

console.log('== checks ==');
const r = checkCaptions('srt', s, 6000);
eq('three read, two usable', r.cues, 2);
yes('backwards cue reported', r.issues.some((i) => i.code === 'timing' && i.cue === 3));
yes('overlap reported', r.issues.some((i) => i.code === 'overlap'));
yes('still usable', r.ok);
eq('empty file is an error', checkCaptions('vtt', [], 1000).ok, false);
yes('past the end', checkCaptions('srt', [{ startMs: 9000, endMs: 9500, text: 'x' }], 5000).issues.some((i) => i.code === 'past-end'));
yes('timecode-timed file suggests an offset', checkCaptions('srt', [{ startMs: 36_000_000, endMs: 36_002_000, text: 'x' }], 60_000).issues.some((i) => i.code === 'offset'));
yes('fast reading', checkCaptions('srt', [{ startMs: 0, endMs: 500, text: 'This is far too much text to read in half a second' }]).issues.some((i) => i.code === 'reading-speed'));

console.log('== WebVTT out ==');
eq('vtt time', vttTime(3_723_004), '01:02:03.004');
const out = toVtt(s, { offsetMs: -500, timestampMap: 'X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000' });
eq('clean vtt', out.split('\n').slice(0, 8), ['WEBVTT', 'X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000', '', '1', '00:00:00.500 --> 00:00:03.000', '<i>Hello</i> there', '', '2']);
yes('backwards cue left out', !out.includes('Backwards'));
eq('round trip', parseVtt(toVtt(v)).map((c) => c.text), ['Top', '<v Anna>Short form</v>']);

console.log('== metadata sidecars ==');
const nfo = parseSidecar('xml', `<?xml version="1.0"?><episodedetails><title>The Pilot</title><showtitle>Harbour</showtitle><season>1</season><episode>1</episode>
  <plot><![CDATA[A ship & a storm.]]></plot><genre>Drama</genre><genre>Crime</genre><aired>2026-03-04</aired><uniqueid type="imdb">tt123</uniqueid></episodedetails>`);
eq('nfo flattened', [nfo.title, nfo.showtitle, nfo.plot, nfo.genre, nfo['uniqueid@type']], ['The Pilot', 'Harbour', 'A ship & a storm.', ['Drama', 'Crime'], 'imdb']);
const js = parseSidecar('json', JSON.stringify({ programme: { title: 'Grand Final', synopsis: 'The decider', tags: ['sport', 'final'] }, rating: 'PG', live: 'yes' }));
eq('json flattened', [js['programme.title'], js['programme.tags'], js.rating], ['Grand Final', ['sport', 'final'], 'PG']);
eq('csv pairs', parseSidecar('csv', 'field,value\ntitle,"Hello, world"\nseason,2'), { title: 'Hello, world', season: '2' });
eq('csv header + one row', parseSidecar('csv', 'Title;Season;Genre\nX;3;News'), { Title: 'X', Season: '3', Genre: 'News' });
const fields = [
  { key: 'title', label: 'Title', type: 'string' }, { key: 'description', label: 'Description', type: 'text' },
  { key: 'series', label: 'Series', type: 'string' }, { key: 'season', type: 'integer' }, { key: 'episode', type: 'integer' },
  { key: 'genre', type: 'enum', options: ['Drama', 'News', 'Crime'], multiple: true }, { key: 'released', type: 'date' },
  { key: 'artwork', type: 'image' }, { key: 'live', type: 'boolean' }, { key: 'rating', label: 'Classification', type: 'string' },
];
const mf = matchFields(nfo, fields, { title: 'Old', season: 1 });
const by = Object.fromEntries(mf.proposals.map((p) => [p.field, p.value]));
eq('nfo matched', by, { title: 'The Pilot', description: 'A ship & a storm.', series: 'Harbour', season: 1, episode: 1, genre: ['Drama', 'Crime'], released: '2026-03-04' });
eq('changes flagged', mf.proposals.filter((p) => p.changes).map((p) => p.field).includes('season'), false);
yes('unmatched kept for the person', mf.unmatched.includes('uniqueid@type'));
const mj = Object.fromEntries(matchFields(js, fields).proposals.map((p) => [p.field, p.value]));
eq('json matched by path, synonym and label', [mj.title, mj.description, mj.rating, mj.live], ['Grand Final', 'The decider', 'PG', true]);
eq('synonyms both ways: <episode> fills episodeNumber', matchFields({ episode: '7' }, [{ key: 'episodeNumber', label: 'Episode number', type: 'number' }]).proposals[0]?.value, 7);
eq('enum options matched in any case, unknown dropped', matchFields({ genre: 'drama; Horror' }, fields).proposals[0].value, ['Drama']);
eq('image fields are never filled from text', matchFields({ artwork: 'x.jpg' }, fields).proposals.length, 0);

console.log('== delivery: HLS ==');
const MASTER = '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"\n720p/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n360p/index.m3u8\n';
const tracks = [
  { id: '11111111-1111-1111-1111-111111111111', language: 'en', label: 'English', isDefault: true, forced: false, sdh: true },
  { id: '22222222-2222-2222-2222-222222222222', language: 'fr', label: 'Français', isDefault: false, forced: false, sdh: false },
];
const m2 = withHlsSubtitles(MASTER, tracks);
yes('media lines added', m2.includes('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="volt-subs",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,CHARACTERISTICS="public.accessibility.transcribes-spoken-dialog,public.accessibility.describes-music-and-sound",URI="subs/11111111-1111-1111-1111-111111111111.m3u8"'), m2);
yes('every variant points at the group', m2.split('\n').filter((l) => l.startsWith('#EXT-X-STREAM-INF')).every((l) => l.endsWith(',SUBTITLES="volt-subs"')));
yes('before the first variant', m2.indexOf('TYPE=SUBTITLES') < m2.indexOf('#EXT-X-STREAM-INF'));
eq('idempotent', withHlsSubtitles(m2, tracks), m2);
eq('no tracks, no change', withHlsSubtitles(MASTER, []), MASTER);
eq('a media playlist is left alone', withHlsSubtitles('#EXTM3U\n#EXTINF:4,\na.m4s\n', tracks), '#EXTM3U\n#EXTINF:4,\na.m4s\n');
eq('subtitle playlist', subtitlePlaylist('abc', 125_400).split('\n'), ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:126', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXTINF:125.400,', 'abc.vtt', '#EXT-X-ENDLIST', '']);
eq('timestamp map from tfdt', timestampMap(10_000n * 90_000n, 90_000), 'X-TIMESTAMP-MAP=MPEGTS:900000000,LOCAL:00:00:00.000');
eq('timestamp map at another timescale', timestampMap(48_000n * 3n, 48_000), 'X-TIMESTAMP-MAP=MPEGTS:270000,LOCAL:00:00:00.000');
eq('wraps at 33 bits', timestampMap(2n ** 33n + 90_000n, 90_000), 'X-TIMESTAMP-MAP=MPEGTS:90000,LOCAL:00:00:00.000');

console.log('== delivery: DASH ==');
const MPD = '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"><Period id="0" start="PT0S"><AdaptationSet contentType="video"></AdaptationSet></Period></MPD>';
const d2 = withDashSubtitles(MPD, tracks, 'https://x.example/clips/vod/a/');
yes('text adaptation sets', (d2.match(/<AdaptationSet contentType="text" mimeType="text\/vtt"/g) ?? []).length === 2, d2);
yes('role and url', d2.includes('<Role schemeIdUri="urn:mpeg:dash:role:2011" value="subtitle"/>') && d2.includes('<BaseURL>https://x.example/clips/vod/a/subs/11111111-1111-1111-1111-111111111111.dash.vtt</BaseURL>'));
yes('sdh is a caption role', d2.includes('value="caption"'));
yes('relative base', withDashSubtitles(MPD, tracks, '').includes('<BaseURL>subs/22222222-2222-2222-2222-222222222222.dash.vtt</BaseURL>'));
eq('dash idempotent', withDashSubtitles(d2, tracks, 'https://x.example/clips/vod/a/'), d2);

console.log('== delivery: the segment clock ==');
const box = (type: string, body: Buffer) => { const b = Buffer.alloc(8); b.writeUInt32BE(8 + body.length); b.write(type, 4, 'ascii'); return Buffer.concat([b, body]); };
const tfdt1 = Buffer.alloc(12); tfdt1[0] = 1; tfdt1.writeBigUInt64BE(123_456_789n, 4);
const seg = box('moof', Buffer.concat([box('mfhd', Buffer.alloc(8)), box('traf', Buffer.concat([box('tfhd', Buffer.alloc(8)), box('tfdt', tfdt1)]))]));
eq('tfdt v1', String(readTfdt(Buffer.concat([box('styp', Buffer.alloc(8)), seg]))), '123456789');
const tfdt0 = Buffer.alloc(8); tfdt0.writeUInt32BE(90_000, 4);
eq('tfdt v0', String(readTfdt(box('moof', box('traf', box('tfdt', tfdt0))))), '90000');
const mdhd = Buffer.alloc(24); mdhd.writeUInt32BE(12_800, 12);
eq('timescale from mdhd', readTimescale(box('moov', box('trak', box('mdia', box('mdhd', mdhd))))), 12_800);
eq('nothing found', readTfdt(Buffer.from('nope')), null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
