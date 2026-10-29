// ============================================================================
//  HLS master playlists, without a network: the real ABC Jazz and NewsRadio
//  masters (10 Oct 2026), a video master with separate audio renditions,
//  relative URIs, quoted CODECS with commas, and media playlists.
//
//  Usage: npx tsx test/hls-master-pure.check.ts
// ============================================================================
import { parsePlaylist, parseAttrs, codecName, looksLikeHls, extinfTitle } from '../src/services/hlsMaster';
import { readId3 } from '../src/services/sourceValidate';

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
  recentSegments: [{ uri: 'https://x.example/seg1.aac', duration: 6, length: null }, { uri: 'https://x.example/seg2.aac', duration: 6, length: null }],
  segmentTitle: null, markers: { dateRanges: 0, cues: 0, programDateTime: false } });

// NOW PLAYING AND MARKERS IN A MEDIA PLAYLIST (a Revma / RadioJar style radio stream)
const RADIO = `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:179606142\n#EXT-X-DISCONTINUITY\n#EXTINF:10,title="OLD SONG",artist="SOMEONE"\nhttps://r.example/1.aac\n#EXTINF:10,title="HINGGA AKHIR NANTI",artist="NEON"\nhttps://r.example/2.aac`;
const rp = parsePlaylist(RADIO, 'https://r.example/p.m3u8');
check('now playing from the newest #EXTINF (title="",artist="")', [rp.segmentTitle?.title, rp.segmentTitle?.artist, Object.keys(rp.segmentTitle?.fields ?? {})], ['HINGGA AKHIR NANTI', 'NEON', ['title', 'artist']]);
check('a plain "Artist - Title" #EXTINF', [extinfTitle('#EXTINF:6,Queen - Bohemian Rhapsody')?.artist, extinfTitle('#EXTINF:6,Queen - Bohemian Rhapsody')?.title], ['Queen', 'Bohemian Rhapsody']);
check('an empty #EXTINF title is nothing', extinfTitle('#EXTINF:6.0,'), null);
const MK = `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-PROGRAM-DATE-TIME:2026-10-28T00:00:00Z\n#EXT-X-DATERANGE:ID="a",START-DATE="2026-10-28T00:00:00Z"\n#EXT-X-CUE-OUT:30\n#EXTINF:6,\ns.ts`;
check('markers: date ranges, SCTE-35 cues, program date-time', parsePlaylist(MK, 'https://x.example/m.m3u8').markers, { dateRanges: 1, cues: 1, programDateTime: true });
check('closed captions announced on a variant', parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CLOSED-CAPTIONS="cc"\nv.m3u8', 'https://x.example/m.m3u8').closedCaptions, true);

// ID3 AT THE START OF A PACKED-AUDIO SEGMENT: Apple's timestamp, then title and artist
const syncsafe = (n: number) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
const frame = (id: string, body: Buffer) => Buffer.concat([Buffer.from(id, 'latin1'), syncsafe(body.length), Buffer.from([0, 0]), body]);
const tag = (frames: Buffer[]) => { const b = Buffer.concat(frames); return Buffer.concat([Buffer.from('ID3\x04\x00\x00', 'latin1'), syncsafe(b.length), b]); };
const seg = Buffer.concat([
  tag([frame('PRIV', Buffer.concat([Buffer.from('com.apple.streaming.transportStreamTimestamp\0', 'latin1'), Buffer.from([0, 0, 0, 0, 3, 0xd0, 0x99, 0x4a])]))]),
  tag([frame('TIT2', Buffer.concat([Buffer.from([3]), Buffer.from('HINGGA AKHIR NANTI')])), frame('TPE1', Buffer.concat([Buffer.from([3]), Buffer.from('NEON')]))]),
  Buffer.from([0xff, 0xf9, 0x58, 0x80]),
]);
const t = readId3(seg);
check('ID3 in a segment: title, artist and the Apple timestamp', [t?.title, t?.artist, t?.timestamp, t?.frames], ['HINGGA AKHIR NANTI', 'NEON', true, ['PRIV', 'TIT2', 'TPE1']]);
check('no ID3: nothing', readId3(Buffer.from([0xff, 0xf1, 0x50, 0x80])), null);
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
