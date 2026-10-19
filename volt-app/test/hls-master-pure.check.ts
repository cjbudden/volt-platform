// ============================================================================
//  HLS master playlists, without a network: the real ABC Jazz and NewsRadio
//  masters (10 Oct 2026), a video master with separate audio renditions,
//  relative URIs, quoted CODECS with commas, and media playlists.
//
//  Usage: npx tsx test/hls-master-pure.check.ts
// ============================================================================
import { parsePlaylist, parseAttrs, codecName, looksLikeHls } from '../src/services/hlsMaster';

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { console.log('PASS ' + m); pass++; }
  else { console.log(`FAIL ${m} -- expected [${JSON.stringify(want)}] got [${JSON.stringify(got)}]`); fail++; }
};

const ABC_JAZZ = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-START:TIME-OFFSET=-40.0,PRECISE=NO
#EXT-X-STREAM-INF:BANDWIDTH=252000,AVERAGE-BANDWIDTH=246000,CODECS="mp4a.40.2",CLOSED-CAPTIONS=NONE
https://mediaserviceslive.akamaized.net/hls/live/2108543/abcjazz/v0-221.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=140000,AVERAGE-BANDWIDTH=112000,CODECS="mp4a.40.29",CLOSED-CAPTIONS=NONE
https://mediaserviceslive.akamaized.net/hls/live/2108543/abcjazz/v0-222.m3u8`;
const j = parsePlaylist(ABC_JAZZ, 'https://streaming.abc-cdn.net.au/audio/hls/abcjazz.m3u8');
check('ABC Jazz is a master with 2 variants', [j.ok, j.kind, j.variants?.length], [true, 'master', 2]);
check('variant 1: AAC-LC at 252 kbps, audio only', [j.variants![0].codecNames, j.variants![0].bandwidth, j.variants![0].averageBandwidth, j.variants![0].audioOnly], [['AAC-LC'], 252000, 246000, true]);
check('variant 2: HE-AAC v2 at 140 kbps', [j.variants![1].codecNames, j.variants![1].bandwidth], [['HE-AAC v2'], 140000]);
check('variant addresses kept absolute', j.variants![1].uri, 'https://mediaserviceslive.akamaized.net/hls/live/2108543/abcjazz/v0-222.m3u8');
check('neither needs a separate audio playlist', j.variants!.map((v) => v.externalAudio), [false, false]);

const REL = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,FRAME-RATE=50.000,CODECS="avc1.640028,mp4a.40.2"\n../hd/index.m3u8?token=a,b`;
const r = parsePlaylist(REL, 'https://cdn.example/live/chan/master.m3u8?sig=1');
check('relative variant addresses resolved against the master', r.variants!.map((v) => v.uri), ['https://cdn.example/live/chan/low/index.m3u8', 'https://cdn.example/live/hd/index.m3u8?token=a,b']);
check('quoted CODECS with a comma are two codecs', [r.variants![0].codecs, r.variants![0].codecNames], [['avc1.4d401e', 'mp4a.40.2'], ['H.264', 'AAC-LC']]);
check('resolution and frame rate', [r.variants![1].resolution, r.variants![1].frameRate, r.variants![1].audioOnly], ['1920x1080', 50, false]);

const ALT = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Français",LANGUAGE="fr",DEFAULT=NO,URI="audio/fr.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="subs/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aud",SUBTITLES="subs"
video/720.m3u8`;
const a = parsePlaylist(ALT, 'https://cdn.example/m.m3u8');
check('alternative audio renditions are listed', a.renditions!.filter((x) => x.type === 'AUDIO').map((x) => [x.name, x.language, x.default, x.uri]),
  [['English', 'en', true, 'https://cdn.example/audio/en.m3u8'], ['Français', 'fr', false, 'https://cdn.example/audio/fr.m3u8']]);
check('a variant whose audio is in a separate playlist is marked (it cannot be used alone)', [a.variants![0].audioGroup, a.variants![0].externalAudio], ['aud', true]);
check('subtitles are a rendition too', a.renditions!.filter((x) => x.type === 'SUBTITLES').length, 1);

const MEDIA = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:6.0,\nseg1.aac\n#EXTINF:6.0,\nseg2.aac`;
check('a live media playlist', parsePlaylist(MEDIA, 'https://x.example/v0-221.m3u8'), { ok: true, kind: 'media', live: true, targetDuration: 6,
  recentSegments: [{ uri: 'https://x.example/seg1.aac', duration: 6, length: null }, { uri: 'https://x.example/seg2.aac', duration: 6, length: null }] });
const LONG = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n' + [1, 2, 3, 4, 5].map((n) => `#EXTINF:4.0,\ns${n}.ts`).join('\n');
check('measuring the bitrate uses the last three segments', parsePlaylist(LONG, 'https://x.example/v/i.m3u8').recentSegments!.map((x) => x.uri.split('/').pop()), ['s3.ts', 's4.ts', 's5.ts']);
const BR = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\n#EXT-X-BYTERANGE:250000@0\nall.ts\n#EXTINF:2.0,\n#EXT-X-BYTERANGE:260000\nall.ts';
check('a byte-range segment carries its length', parsePlaylist(BR, 'https://x.example/i.m3u8').recentSegments!.map((x) => x.length), [250000, 260000]);
check('a VOD media playlist', parsePlaylist(MEDIA + '\n#EXT-X-ENDLIST', 'https://x.example/a.m3u8').live, false);
check('not a playlist', parsePlaylist('<html>nope</html>', 'https://x.example/').ok, false);
check('a BOM and CRLF line ends are fine', parsePlaylist('﻿#EXTM3U\r\n#EXT-X-STREAM-INF:BANDWIDTH=1\r\na.m3u8\r\n', 'https://x.example/m.m3u8').variants?.length, 1);

check('attribute list parsing', parseAttrs('BANDWIDTH=1,CODECS="a,b",NAME="x=y"'), { BANDWIDTH: '1', CODECS: 'a,b', NAME: 'x=y' });
check('codec names', ['mp4a.40.5', 'ec-3', 'hvc1.1.6.L120.90', 'opus', 'xyz'].map(codecName), ['HE-AAC', 'E-AC-3', 'HEVC', 'Opus', 'xyz']);
check('looks like HLS', [looksLikeHls('https://a/b.m3u8'), looksLikeHls('https://a/b.m3u8?x=1'), looksLikeHls('https://a/live', 'hls'), looksLikeHls('https://a/stream.mp3'), looksLikeHls('srt://a:1')], [true, true, true, false, false]);

console.log(`\nhls-master-pure.check: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
