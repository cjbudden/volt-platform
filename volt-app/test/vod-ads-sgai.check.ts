// ============================================================================
//  ON-DEMAND ADS, second slice (build queue 1.14k-2): guided ads through the
//  SDK's own engine, stitched DASH, and keys and captions across ad parts.
//
//  Pure first: the stitched MPD (services/vodAds/dash.ts) from a packager-
//  style MPD (content Periods cut at each break, startNumber and
//  presentationTimeOffset moved, audio split where its segments fall, the
//  ad's renditions as SegmentLists through the segment route, protection
//  kept on content and absent from ads, captions continuous); what cannot be
//  stitched; the HLS key change at each pod (METHOD=NONE before a clear ad,
//  the content's key again after); CUE on the interstitial DATERANGE; codecs
//  from a master.
//
//  Then the real API (Postgres, HTTP, a local VAST server): the play gate
//  offering the session's MPD next to its HLS, the MPD as served, beacons
//  from its ad segments, and the cases that get HLS only.
//
//  Then a real browser (Chromium, VP9 and Opus made by ffmpeg, the SDK
//  bundled from volt-player/src): the Volt player asking for guided ads,
//  Shaka fetching each break's asset list for its own playback, the ad
//  playing in the same video element with the overlay, the content resuming
//  where it left off; the stitched MPD played across a break by Shaka and by
//  dash.js, with captions in step on both sides of the break.
//  The browser part SKIPS, and says what is missing, without playwright-core
//  (or a global playwright), ffmpeg with libvpx-vp9 and libopus, or
//  volt-player's node_modules; dash.js is looked for in DASHJS_DIR or
//  node_modules and only its part skips without it.
//
//  Not covered here: playing encrypted content. ffmpeg's CENC output does not
//  play in Chromium and Shaka Packager is not in the container, so DRM is
//  checked on the manifests (protection kept on content Periods, none on ads;
//  the HLS key closed before a clear pod and stated again after it). An
//  encrypted title through a real licence server is Christian's to try.
//
//  Usage: DATABASE_URL=... npx tsx test/vod-ads-sgai.check.ts
// ============================================================================
import { createServer as httpServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let pass = 0, fail = 0, skipped = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `expected [${JSON.stringify(want)}] got [${JSON.stringify(got)}]`);
const truthy = (m: string, v: unknown, d = '') => (v ? ok(m) : bad(m, d || `got [${JSON.stringify(v)}]`));
const skip = (m: string) => { console.log('SKIP ' + m); skipped++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => Promise<unknown>, timeoutMs: number, every = 150): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { if (await fn()) return Date.now() - t0; } catch { /* not yet */ } await sleep(every); }
  return -1;
}

// ---------------------------------------------------------------- MPD reading for the checks

interface N { name: string; attrs: Record<string, string>; children: N[]; text: string }
const kids = (n: N | undefined, name: string) => n?.children.filter((c) => c.name === name) ?? [];
const kid = (n: N | undefined, name: string) => kids(n, name)[0];
async function periodsOf(text: string): Promise<{ root: Record<string, string>; periods: N[] }> {
  const { XmlStream } = await import('../src/services/xmltvParse');
  const periods: N[] = [];
  let root: Record<string, string> = {};
  const s = new XmlStream(new Set(['Period']), (n) => periods.push(n as N), (a) => { root = a; });
  s.write(text); s.end();
  return { root, periods };
}
const sets = (p: N, ct: string) => kids(p, 'AdaptationSet').filter((a) => a.attrs.contentType === ct);
const tpl = (p: N, ct: string) => kid(kid(sets(p, ct)[0], 'Representation'), 'SegmentTemplate');
const sCount = (t: N | undefined) => kids(kid(t, 'SegmentTimeline'), 'S').reduce((n, s) => n + 1 + Number(s.attrs.r ?? 0), 0);

// A packager-style MPD: 24 s, 2 s video segments at 90 kHz, AAC audio whose
// segments end on whole frames (not on the video's boundaries), protection
// with a PSSH, and a sidecar WebVTT.
function packagerMpd(opts: { asLevelTemplate?: boolean } = {}) {
  const aud: string[] = [];
  let prev = 0;
  for (let k = 1; k <= 12; k++) { const end = k === 12 ? 24 * 48000 : Math.round((k * 2 * 48000) / 1024) * 1024; aud.push(`<S t="${prev}" d="${end - prev}"/>`); prev = end; }
  const cp = `<ContentProtection value="cenc" schemeIdUri="urn:mpeg:dash:mp4protection:2011" cenc:default_KID="a7e61c37-3e21-9033-c210-91fa607bf3b8"/>
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"><cenc:pssh>AAAAQ3Bzc2g&amp;x</cenc:pssh></ContentProtection>`;
  const vt = `<SegmentTemplate timescale="90000" initialization="${opts.asLevelTemplate ? 'v$RepresentationID$' : 'v360'}/init.mp4" media="${opts.asLevelTemplate ? 'v$RepresentationID$' : 'v360'}/$Number$.m4s" startNumber="1"><SegmentTimeline><S t="0" d="180000" r="11"/></SegmentTimeline></SegmentTemplate>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!--Generated by a packager-->
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013" profiles="urn:mpeg:dash:profile:isoff-live:2011" minBufferTime="PT2S" type="static" mediaPresentationDuration="PT24S" maxSegmentDuration="PT2S">
  <Period id="0">
    <AdaptationSet id="0" contentType="video" width="640" height="360" segmentAlignment="true">
      ${cp}
      ${opts.asLevelTemplate ? vt : ''}
      <Representation id="0" bandwidth="800000" codecs="avc1.64001e" mimeType="video/mp4" width="640" height="360">${opts.asLevelTemplate ? '' : vt}</Representation>
    </AdaptationSet>
    <AdaptationSet id="1" contentType="audio" lang="en" segmentAlignment="true">
      ${cp}
      <Representation id="1" bandwidth="128000" codecs="mp4a.40.2" mimeType="audio/mp4" audioSamplingRate="48000">
        <SegmentTemplate timescale="48000" initialization="audio/init.mp4" media="audio/$Number$.m4s" startNumber="1"><SegmentTimeline>${aud.join('')}</SegmentTimeline></SegmentTemplate>
      </Representation>
    </AdaptationSet>
    <AdaptationSet id="2" contentType="text" lang="en">
      <Role schemeIdUri="urn:mpeg:dash:role:2011" value="subtitle"/>
      <Representation id="2" bandwidth="256" mimeType="text/vtt"><BaseURL>subs/en.vtt</BaseURL></Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
}

// ---------------------------------------------------------------- synthetic media on disk (the API part)

function writeHls(dir: string, totalSec: number, seg: number, opts: { ts?: boolean; mpd?: boolean } = {}) {
  mkdirSync(dir, { recursive: true });
  const segs: number[] = [];
  for (let t = 0; t < totalSec - 1e-9; t += seg) segs.push(Math.min(seg, totalSec - t));
  const media = (folder: string) => ['#EXTM3U', '#EXT-X-VERSION:6', `#EXT-X-TARGETDURATION:${seg}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD',
    ...(opts.ts ? [] : [`#EXT-X-MAP:URI="${folder}/init.mp4"`]), ...segs.flatMap((d, i) => [`#EXTINF:${d.toFixed(3)},`, `${folder}/seg_${i + 1}.${opts.ts ? 'ts' : 'm4s'}`]), '#EXT-X-ENDLIST', ''].join('\n');
  writeFileSync(join(dir, 'stream_0.m3u8'), media('720p'));
  writeFileSync(join(dir, 'stream_2.m3u8'), media('audio'));
  writeFileSync(join(dir, 'master.m3u8'), ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="stream_2.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="audio"', 'stream_0.m3u8', ''].join('\n'));
  if (opts.mpd) {
    const n = segs.length;
    mkdirSync(join(dir, 'subs'), { recursive: true });
    writeFileSync(join(dir, 'subs', 'en.vtt'), 'WEBVTT\n\n00:00:05.000 --> 00:00:07.000\nEarly line\n\n00:10:05.000 --> 00:10:07.000\nLine at 605 s\n');
    writeFileSync(join(dir, 'manifest.mpd'), `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011" type="static" mediaPresentationDuration="PT${totalSec}S" minBufferTime="PT2S">
 <Period id="0">
  <AdaptationSet id="0" contentType="video" mimeType="video/mp4"><Representation id="v720" codecs="avc1.64001f" bandwidth="2500000" width="1280" height="720">
   <SegmentTemplate timescale="1000" initialization="720p/init.mp4" media="720p/seg_$Number$.m4s" startNumber="1"><SegmentTimeline><S t="0" d="${seg * 1000}" r="${n - 1}"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet>
  <AdaptationSet id="1" contentType="audio" mimeType="audio/mp4" lang="en"><Representation id="a" codecs="mp4a.40.2" bandwidth="128000">
   <SegmentTemplate timescale="1000" initialization="audio/init.mp4" media="audio/seg_$Number$.m4s" startNumber="1"><SegmentTimeline><S t="0" d="${seg * 1000}" r="${n - 1}"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet>
  <AdaptationSet id="2" contentType="text" lang="en"><Representation id="t" bandwidth="256" mimeType="text/vtt"><BaseURL>subs/en.vtt</BaseURL></Representation></AdaptationSet>
 </Period>
</MPD>`);
  }
}

// ---------------------------------------------------------------- real media (the browser part)

function ffmpegDash(dir: string, color: string, tone: number, sec: number) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:size=320x180:rate=25`, '-f', 'lavfi', '-i', `sine=f=${tone}:sample_rate=48000`,
    '-t', String(sec), '-c:v', 'libvpx-vp9', '-g', '50', '-keyint_min', '50', '-b:v', '200k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-b:a', '64k',
    '-f', 'dash', '-dash_segment_type', 'mp4', '-seg_duration', '2', '-use_template', '1', '-use_timeline', '1', '-hls_playlist', '1',
    '-init_seg_name', 'init-$RepresentationID$.mp4', '-media_seg_name', 'seg-$RepresentationID$-$Number%05d$.m4s', '-adaptation_sets', 'id=0,streams=v id=1,streams=a',
    join(dir, 'manifest.mpd')], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
}

/** Captions on the content, in both forms: an HLS subtitle rendition and a DASH text AdaptationSet. */
function addCaptions(dir: string, sec: number) {
  mkdirSync(join(dir, 'subs'), { recursive: true });
  writeFileSync(join(dir, 'subs', 'en.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello one\n\n00:00:13.000 --> 00:00:15.000\nHello thirteen\n');
  writeFileSync(join(dir, 'subs', 'en.m3u8'), ['#EXTM3U', `#EXT-X-TARGETDURATION:${sec}`, '#EXT-X-PLAYLIST-TYPE:VOD', `#EXTINF:${sec}.000,`, 'en.vtt', '#EXT-X-ENDLIST', ''].join('\n'));
  let m = readFileSync(join(dir, 'master.m3u8'), 'utf8');
  m = m.replace('#EXT-X-STREAM-INF:', '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="subs/en.m3u8"\n#EXT-X-STREAM-INF:')
    .replace(/(#EXT-X-STREAM-INF:[^\n]*)/, '$1,SUBTITLES="subs"');
  writeFileSync(join(dir, 'master.m3u8'), m);
  let mpd = readFileSync(join(dir, 'manifest.mpd'), 'utf8');
  mpd = mpd.replace('</Period>', '<AdaptationSet id="2" contentType="text" lang="en"><Role schemeIdUri="urn:mpeg:dash:role:2011" value="subtitle"/><Representation id="t" bandwidth="256" mimeType="text/vtt"><BaseURL>subs/en.vtt</BaseURL></Representation></AdaptationSet></Period>');
  writeFileSync(join(dir, 'manifest.mpd'), mpd);
}

(async () => {
  const ROOT = resolve(__dirname, '..');
  const PLAYER = resolve(ROOT, '../volt-player');
  const work = mkdtempSync(join(tmpdir(), 'vod-ads-sgai-'));
  Object.assign(process.env, { CLIPS_DIR: join(work, 'clips'), AD_BEACONS_ALLOW_PRIVATE: '1', PUBLIC_BASE_URL: 'https://volt.example' });

  const H = await import('../src/services/vodAds/hls');
  const D = await import('../src/services/vodAds/dash');

  console.log('== reading an MPD ==');
  const mpd = D.parseMpd(packagerMpd())!;
  check('a packager MPD: static, one Period, 24 s, video segments every 2 s', [!!mpd, mpd?.durationSec, D.segmentStarts(mpd).slice(0, 4), D.segmentStarts(mpd).length], [true, 24, [0, 2, 4, 6], 12]);
  truthy('a SegmentTemplate on the AdaptationSet is read too', !!D.parseMpd(packagerMpd({ asLevelTemplate: true })));
  check('what cannot be cut is refused: SegmentBase, a live MPD, two Periods, not an MPD',
    [D.parseMpd(packagerMpd().replace(/<SegmentTemplate[\s\S]*?<\/SegmentTemplate>/g, '<SegmentBase indexRange="0-100"/>')), D.parseMpd(packagerMpd().replace('type="static"', 'type="dynamic"')),
      D.parseMpd(packagerMpd().replace('</Period>', '</Period><Period id="1"></Period>')), D.parseMpd('#EXTM3U')], [null, null, null, null]);
  check('xs:duration', [D.parseDuration('PT1H2M3.5S'), D.parseDuration('PT24S'), D.parseDuration('P1D'), D.parseDuration('nonsense')], [3723.5, 24, 86400, null]);

  console.log('\n== the stitched MPD ==');
  const adTracks = (b: number, p: number) => [
    { kind: 'video' as const, id: `ad${b}-${p}-v720`, init: 'https://cdn.example/ads/a/720p/init.mp4', codecs: 'avc1.64001f', bandwidth: 2000000, width: 1280, height: 720,
      segments: [0, 1].map((n) => ({ dur: 2, url: `/vod-ads/s/vaSESSION/seg/${b}/${p}/v720/${n}?x=1&y=2` })) },
    { kind: 'audio' as const, id: `ad${b}-${p}-audio`, init: 'https://cdn.example/ads/a/audio/init.mp4', codecs: 'mp4a.40.2', bandwidth: 128000,
      segments: [0, 1].map((n) => ({ dur: 2, url: `/vod-ads/s/vaSESSION/seg/${b}/${p}/audio/${n}` })) }];
  const ad = (b: number, p: number) => ({ id: `ad-${b}-${p}`, tracks: adTracks(b, p) });
  const out = D.stitchMpd(mpd, 'https://cdn.example/vod/x/manifest.mpd', [
    { index: 0, atSec: 0, ads: [ad(0, 0)] }, { index: 1, atSec: 8, ads: [ad(1, 0), ad(1, 1)] }, { index: 2, atSec: 24, ads: [ad(2, 0)] }, { index: 3, atSec: 16, ads: [] }], '/vod-ads/blank.vtt');
  const { root, periods } = await periodsOf(out);
  check('Periods: pre-roll, content, two mid-roll ads, content, post-roll (an empty break leaves no cut)', periods.map((p) => p.attrs.id), ['ad-0-0', 'c0', 'ad-1-0', 'ad-1-1', 'c1', 'ad-2-0']);
  check('each Period starts where the one before it ends', periods.map((p) => [D.parseDuration(p.attrs.start), D.parseDuration(p.attrs.duration)]), [[0, 4], [4, 8], [12, 4], [16, 4], [20, 16], [36, 4]]);
  check('the whole: static, 24 s of content and 16 s of ads, no maxSegmentDuration, namespaces kept', [root.type, root.mediaPresentationDuration, root.maxSegmentDuration, root['xmlns:cenc']], ['static', 'PT40.000S', undefined, 'urn:mpeg:cenc:2013']);
  const [c0, c1] = [periods[1], periods[4]];
  check('first content Period: video segments 1 to 4, from the asset\'s start', [tpl(c0, 'video')?.attrs.startNumber, tpl(c0, 'video')?.attrs.presentationTimeOffset, sCount(tpl(c0, 'video'))], ['1', '0', 4]);
  check('second: from segment 5, its offset moved to 8 s (90 kHz)', [tpl(c1, 'video')?.attrs.startNumber, tpl(c1, 'video')?.attrs.presentationTimeOffset, sCount(tpl(c1, 'video'))], ['5', '720000', 8]);
  check('audio is split where its segments fall (by their middle), none lost, offset at the cut', [sCount(tpl(c0, 'audio')), sCount(tpl(c1, 'audio')), tpl(c1, 'audio')?.attrs.presentationTimeOffset, tpl(c1, 'audio')?.attrs.startNumber], [4, 8, '384000', '5']);
  check('the asset\'s own segment names and init, from the asset\'s folder', [tpl(c1, 'video')?.attrs.media, tpl(c1, 'video')?.attrs.initialization, kid(c1, 'BaseURL')?.text], ['v360/$Number$.m4s', 'v360/init.mp4', 'https://cdn.example/vod/x/']);
  check('protection kept on content (the PSSH too), none on any ad', [kids(sets(c0, 'video')[0], 'ContentProtection').length, kids(sets(c1, 'audio')[0], 'ContentProtection').length,
    kid(kids(sets(c1, 'video')[0], 'ContentProtection')[1], 'cenc:pssh')?.text, periods.filter((p) => p.attrs.id.startsWith('ad')).some((p) => /ContentProtection/.test(JSON.stringify(p)))], [2, 2, 'AAAAQ3Bzc2g&x', false]);
  truthy('the PSSH is written back escaped', out.includes('AAAAQ3Bzc2g&amp;x'));
  const adP = periods[2];
  const adV = kid(sets(adP, 'video')[0], 'Representation');
  check('an ad Period: its own renditions, codecs and size, as a SegmentList', [adV?.attrs.id, adV?.attrs.codecs, adV?.attrs.width, kid(kid(adV, 'SegmentList'), 'Initialization')?.attrs.sourceURL, kids(kid(adV, 'SegmentList'), 'SegmentURL').map((s) => s.attrs.media)],
    ['ad1-0-v720', 'avc1.64001f', '1280', 'https://cdn.example/ads/a/720p/init.mp4', ['/vod-ads/s/vaSESSION/seg/1/0/v720/0?x=1&y=2', '/vod-ads/s/vaSESSION/seg/1/0/v720/1?x=1&y=2']]);
  truthy('segment addresses escaped in the XML', out.includes('?x=1&amp;y=2'));
  check('ad timeline: 2 s segments from 0, at 1 kHz, one S each (dash.js reads a repeated S in a SegmentList as one segment)', kids(kid(kid(adV, 'SegmentList'), 'SegmentTimeline'), 'S').map((s) => s.attrs), [{ t: '0', d: '2000' }, { d: '2000' }]);
  check('adaptation sets keep their ids across Periods, so players join them', [kids(c0, 'AdaptationSet').map((a) => a.attrs.id), kids(adP, 'AdaptationSet').map((a) => a.attrs.id)], [['0', '1', '2'], ['0', '1', '2']]);
  const tx = (p: N) => sets(p, 'text')[0];
  check('captions with no server for them: the content\'s own WebVTT kept as it is', kid(kid(tx(c0), 'Representation'), 'BaseURL')?.text, 'subs/en.vtt');
  const withText = await periodsOf(D.stitchMpd(mpd, 'https://cdn.example/vod/x/manifest.mpd', [{ index: 1, atSec: 8, ads: [ad(1, 0)] }], '/b.vtt', (k2, rep) => `/s/text/${k2}/${rep}.vtt`));
  check('captions: each content Period gets its own part of the WebVTT, served for it', [0, 2].map((i) => kid(kid(tx(withText.periods[i]), 'Representation'), 'BaseURL')?.text), ['/s/text/0/2.vtt', '/s/text/1/2.vtt']);
  check('where the sidecar is, and the content edges it is cut at', [D.sidecarText(mpd, 'https://cdn.example/vod/x/manifest.mpd', '2'), D.sidecarText(mpd, '/m.mpd', '0'), D.contentEdges(mpd, [0, 8, 24, 8])], ['https://cdn.example/vod/x/subs/en.vtt', null, [0, 8, 24]]);
  const vtt = 'WEBVTT - title\n\nSTYLE\n::cue { color: yellow }\n\nNOTE drop me\n\n1\n00:00:01.000 --> 00:00:03.000 align:start\nHello one\n\n00:07.500 --> 00:09.000\nAcross the cut\n\n00:00:13.000 --> 00:00:15.000\nHello thirteen\n';
  check('cutVtt: the second Period\'s cues on its own clock, a cue across the cut clipped, header and style kept, notes dropped', D.cutVtt(vtt, 8, 24),
    'WEBVTT\n\nSTYLE\n::cue { color: yellow }\n\n00:00:00.000 --> 00:00:01.000\nAcross the cut\n\n00:00:05.000 --> 00:00:07.000\nHello thirteen\n');
  check('cutVtt: the first Period keeps cue ids and settings', D.cutVtt(vtt, 0, 8).split('\n\n').slice(2), ['1\n00:00:01.000 --> 00:00:03.000 align:start\nHello one', '00:00:07.500 --> 00:00:08.000\nAcross the cut\n']);
  check('captions: an ad Period has a blank WebVTT in the same language and role', [tx(adP)?.attrs.lang, tx(adP)?.attrs.mimeType, kid(kid(tx(adP), 'Representation'), 'BaseURL')?.text, kid(tx(adP), 'Role')?.attrs.value], ['en', 'text/vtt', '/vod-ads/blank.vtt', 'subtitle']);
  const none = await periodsOf(D.stitchMpd(mpd, '/clips/vod/x/manifest.mpd', [], '/b.vtt'));
  check('no breaks: one content Period with every segment, base kept path-only for /clips', [none.periods.length, sCount(tpl(none.periods[0], 'video')), sCount(tpl(none.periods[0], 'audio')), kid(none.periods[0], 'BaseURL')?.text], [1, 12, 12, '/clips/vod/x/']);
  const asl = await periodsOf(D.stitchMpd(D.parseMpd(packagerMpd({ asLevelTemplate: true }))!, '/m.mpd', [{ index: 1, atSec: 8, ads: [ad(1, 0)] }], '/b.vtt'));
  check('a template on the AdaptationSet moves into each Representation, cut the same way', [kids(sets(asl.periods[2], 'video')[0], 'SegmentTemplate').length, tpl(asl.periods[2], 'video')?.attrs.startNumber, tpl(asl.periods[2], 'video')?.attrs.media], [0, '5', 'v$RepresentationID$/$Number$.m4s']);

  console.log('\n== keys across a pod (HLS) ==');
  const KEY = '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key1",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"';
  const KEY2 = '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:text/plain;base64,AAAA",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",KEYFORMATVERSIONS="1"';
  const enc = H.parseMedia(['#EXTM3U', '#EXT-X-VERSION:6', KEY, KEY2, '#EXT-X-MAP:URI="i.mp4"', '#EXTINF:4,', 'a.m4s', '#EXTINF:4,', 'b.m4s', '#EXTINF:4,', 'c.m4s', '#EXT-X-ENDLIST'].join('\n'), 'https://cdn.example/x/v.m3u8')!;
  const adSeg = (u: string) => ({ dur: 5, url: u, init: '/ad/i.mp4', tags: [] as string[] });
  const st = H.stitchMedia(enc, [{ index: 0, atSec: 0, segments: [adSeg('/ad/0')] }, { index: 1, atSec: 4, segments: [adSeg('/ad/1')] }]);
  const tags = st.split('\n').filter((l) => /^#EXT-X-(KEY|MAP|DISCONTINUITY)/.test(l) || (l && !l.startsWith('#')))
    .map((l) => l.startsWith('#EXT-X-KEY') ? (l.includes('NONE') ? 'KEY:NONE' : l.includes('skd') ? 'KEY:fairplay' : 'KEY:widevine') : l.startsWith('#EXT-X-MAP') ? `MAP:${l.match(/URI="([^"]+)"/)![1].split('/').pop()}` : l);
  check('a clear pre-roll plays clear, the content\'s keys come before its init, a clear mid-roll closes them and they return after it',
    tags, ['MAP:i.mp4', '/ad/0', '#EXT-X-DISCONTINUITY', 'KEY:fairplay', 'KEY:widevine', 'MAP:i.mp4', 'https://cdn.example/x/a.m4s',
      '#EXT-X-DISCONTINUITY', 'KEY:NONE', 'MAP:i.mp4', '/ad/1', '#EXT-X-DISCONTINUITY', 'KEY:fairplay', 'KEY:widevine', 'MAP:i.mp4', 'https://cdn.example/x/b.m4s', 'https://cdn.example/x/c.m4s']);
  const clear = H.parseMedia(['#EXTM3U', '#EXT-X-MAP:URI="i.mp4"', '#EXTINF:4,', 'a.m4s', '#EXTINF:4,', 'b.m4s', '#EXT-X-ENDLIST'].join('\n'), '/x/v.m3u8')!;
  truthy('clear content with clear ads has no KEY line at all', !H.stitchMedia(clear, [{ index: 1, atSec: 4, segments: [adSeg('/ad/1')] }]).includes('#EXT-X-KEY'));
  const AES = '#EXT-X-KEY:METHOD=AES-128,URI="https://ads.example/k"';
  const own = H.stitchMedia(enc, [{ index: 1, atSec: 4, segments: [{ ...adSeg('/ad/1'), tags: [AES] }, adSeg('/ad/2')] }]);
  truthy('an ad with its own key keeps it, and the content\'s keys are stated again after it',
    own.indexOf(AES) > own.indexOf('/ad/0') && own.indexOf(AES) < own.indexOf('/ad/1') && own.lastIndexOf('skd://key1') > own.indexOf('/ad/2') && !own.includes('METHOD=NONE'), own);

  console.log('\n== interstitials and masters ==');
  const gd = H.guidedMedia(clear, [{ index: 0, atSec: 0, durationSec: 5, position: 'pre' }, { index: 1, atSec: 8, durationSec: 5, position: 'post' }], (b) => `/l/${b.index}.json`);
  truthy('pre- and post-roll are marked with CUE, the playlist attribute players read (not X-CUE)', gd.includes(',CUE="PRE"') && gd.includes(',CUE="POST"') && !gd.includes('X-CUE'));
  const gm = H.guidedMedia(clear, [{ index: 1, atSec: 4, durationSec: 5, position: 'mid' }], (b) => `/l/${b.index}.json`);
  truthy('a mid-roll plays ONCE: never again on a seek back, nor when the content resumes at its moment', gm.includes(',CUE="ONCE"'), gm);
  const me = H.masterEntries(['#EXTM3U', '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a1",NAME="audio_1",LANGUAGE="en",URI="media_1.m3u8"', '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="E",LANGUAGE="en",URI="s.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=366336,RESOLUTION=320x180,CODECS="vp09.00.11.08,opus",AUDIO="a1",SUBTITLES="s"', 'media_0.m3u8'].join('\n'), '/x/master.m3u8');
  check('a master\'s codecs split between video and audio, with bandwidth, size and language', me.map((e) => [e.kind, e.codecs ?? null, e.bandwidth ?? null, e.width ?? null, e.lang ?? null]),
    [['audio', 'opus', null, null, 'en'], ['subtitles', null, null, null, 'en'], ['video', 'vp09.00.11.08', 366336, 320, null]]);

  const SDK = await import('../../volt-player/src/sdk/ads');
  check('the SDK finds a guided ad\'s session, break and place from its address (for Learn more and the events)',
    [SDK.guidedRef('https://api.example/vod-ads/s/vaABCDEFGHIJKLMNOPQRSTUVWX/ad/1/0/master.m3u8'), SDK.guidedRef('/clips/vod/x/master.m3u8')], [{ sid: 'vaABCDEFGHIJKLMNOPQRSTUVWX', b: 1, p: 0 }, null]);

  // ---------------------------------------------------------------- the real API
  const hits: { path: string; ua: string | null }[] = [];
  const vast = httpServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname.startsWith('/px/')) { hits.push({ path: u.pathname, ua: (req.headers['x-device-user-agent'] as string) ?? null }); res.writeHead(200); return res.end(); }
    const base = `http://127.0.0.1:${(vast.address() as any).port}`;
    const short = u.pathname === '/vast4';
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end(`<VAST version="4.1"><Ad id="${short ? 'b4' : 'a1'}" sequence="1"><InLine><AdSystem>Stub</AdSystem><AdTitle>${short ? 'Red sale' : 'Spring sale'}</AdTitle>
      <Impression><![CDATA[${base}/px/${short ? 'imp4' : 'imp'}]]></Impression><Creatives><Creative id="c1"><UniversalAdId idRegistry="ad-id.org">${short ? 'UAI-4' : 'UAI-1'}</UniversalAdId><Linear><Duration>00:00:${short ? '04' : '15'}</Duration>
      <TrackingEvents>${['start', 'complete', 'pause'].map((e) => `<Tracking event="${e}"><![CDATA[${base}/px/${e}${short ? '4' : ''}]]></Tracking>`).join('')}</TrackingEvents>
      <VideoClicks><ClickThrough><![CDATA[https://advertiser.example/landing]]></ClickThrough></VideoClicks>
      <MediaFiles><MediaFile delivery="progressive" type="video/mp4" width="1280" height="720"><![CDATA[${base}/ad.mp4]]></MediaFile></MediaFiles></Linear></Creative></Creatives></InLine></Ad></VAST>`);
  });
  await new Promise<void>((r) => vast.listen(0, '127.0.0.1', () => r()));
  const VBASE = `http://127.0.0.1:${(vast.address() as any).port}`;

  const { query, one, pool } = await import('../src/db');
  const { createServer } = await import('../src/server');
  const { signAccess } = await import('../src/auth/jwt');
  const { generateKey } = await import('../src/services/apiKeys');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`vas-${tag}`]))!.id;
  const owner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `vas-${tag}@volt.test`]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
  const g = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name, status) VALUES ($1,'VAS Ch','ended') RETURNING id`, [g]))!.id;
  const tsType = (await one<any>(`INSERT INTO metadata_schemas(account_id, name) VALUES ($1,'TS house') RETURNING id`, [acct]))!.id;
  const shortType = (await one<any>(`INSERT INTO metadata_schemas(account_id, name) VALUES ($1,'Short films') RETURNING id`, [acct]))!.id;
  const mkAsset = async (title: string, sec: number, write: (dir: string) => void, o: { schema?: string | null; formats?: any; cues?: number[] } = {}) => {
    const id = (await one<any>(`INSERT INTO vod_assets(channel_id, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, metadata, thumb_status, schema_id, formats, break_cues_ms)
      VALUES ($1,'clip',$2,0,$3,$3,'{}'::jsonb,'ready',$4,$5::jsonb,$6) RETURNING id`, [ch, title, sec * 1000, o.schema ?? null, JSON.stringify(o.formats ?? { hls: true, dash: true }), o.cues ?? []]))!.id;
    write(join(process.env.CLIPS_DIR!, 'vod', id));
    await query(`UPDATE vod_assets SET master_key = $2, published = true WHERE id = $1`, [id, `/clips/vod/${id}/master.m3u8`]);
    return id;
  };
  const film = await mkAsset('The long film', 1800, (d) => writeHls(d, 1800, 4, { mpd: true }));
  const hlsOnly = await mkAsset('HLS only film', 1800, (d) => writeHls(d, 1800, 4, { mpd: true }), { formats: { hls: true, dash: false } });
  const tsFilm = await mkAsset('Film with a TS house ad', 1800, (d) => writeHls(d, 1800, 4, { mpd: true }), { schema: tsType });
  const adAsset = await mkAsset('Spring sale (conditioned)', 15, (d) => writeHls(d, 15, 4));
  const tsHouse = await mkAsset('TS house promo', 10, (d) => writeHls(d, 10, 5, { ts: true }));
  await query(`INSERT INTO ad_creatives(account_id, creative_key, vod_asset_id, status, duration_ms) VALUES ($1,'ad-id.org:UAI-1',$2,'ready',15000)`, [acct, adAsset]);
  const server = (await one<any>(`INSERT INTO ad_servers(account_id, name, tag_template, timeout_ms) VALUES ($1,'Stub',$2,1500) RETURNING id`, [acct, `${VBASE}/vast?sid=[SESSION_ID]`]))!.id;
  const app = await one<any>(`INSERT INTO apps(account_id, name, type, restrictions) VALUES ($1,'Web','web','{}') RETURNING id`, [acct]);
  const k = generateKey('publishable');
  await query(`INSERT INTO api_keys(account_id, app_id, kind, key_prefix, key_hash, scopes) VALUES ($1,$2,'publishable',$3,$4,'{playback}')`, [acct, app!.id, k.prefix, k.hash]);

  const srv = createServer().listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: any) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${signAccess({ sub: owner, account_id: acct, role: 'owner' } as any)}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text(); let j: any = null; try { j = JSON.parse(t); } catch { j = t; }
    return { s: r.status, j };
  };
  const gate = async (assetId: string, extra: any = {}) => {
    const r = await fetch(`${base}/api/availability`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'TestPlayer/2.0' }, body: JSON.stringify({ appKey: k.raw, assetId, ...extra }) });
    return { s: r.status, j: await r.json() as any };
  };
  const get = async (path: string) => { const r = await fetch(base + path, { redirect: 'manual' }); return { s: r.status, t: await r.text(), h: r.headers }; };

  console.log('\n== the play gate: DASH beside HLS ==');
  let r = await api('PUT', '/api/vod/ads/rules/default', { mode: 'on', policy: {}, adServerId: server, houseAds: [] });
  check('ads on for the account (pre-roll and mid-rolls every 10 minutes)', r.s, 200);
  r = await api('PUT', `/api/vod/ads/rules/content-type/${tsType}`, { mode: 'on', policy: {}, adServerId: null, houseAds: [{ assetId: tsHouse }] });
  check('a content type whose only ad is a TS house promo', r.s, 200);
  const g1 = await gate(film, { sid: 'attempt-dash-01' });
  const sid = g1.j.ads?.sessionId;
  check('stitched: HLS and DASH both through the viewer\'s session', [g1.s, g1.j.ads?.delivery, g1.j.delivery.hls, g1.j.delivery.dash], [200, 'stitched', `/vod-ads/s/${sid}/master.m3u8`, `/vod-ads/s/${sid}/manifest.mpd`]);
  const m1 = await get(g1.j.delivery.dash);
  check('the MPD: DASH, any origin, never cached', [m1.s, m1.h.get('content-type')?.split(';')[0], m1.h.get('access-control-allow-origin'), m1.h.get('cache-control')], [200, 'application/dash+xml', '*', 'no-store']);
  const p1 = await periodsOf(m1.t);
  check('Periods for the decided pods: pre-roll, content, mid, content, mid, content', p1.periods.map((p) => p.attrs.id), ['ad-0-0', 'c0', 'ad-1-0', 'c1', 'ad-2-0', 'c2']);
  const tl = (await (await fetch(`${base}/vod-ads/s/${sid}/timeline.json`)).json()) as any;
  check('ad Periods start where the ad timeline says the breaks are (same decisions as the HLS)', p1.periods.filter((p) => p.attrs.id.startsWith('ad')).map((p) => D.parseDuration(p.attrs.start)), tl.breaks.map((b: any) => b.stitchedStartSec));
  check('content after the first mid-roll starts at segment 151 (600 s)', [tpl(p1.periods[3], 'video')?.attrs.startNumber, tpl(p1.periods[3], 'video')?.attrs.presentationTimeOffset, kid(p1.periods[3], 'BaseURL')?.text], ['151', '600000', `/clips/vod/${film}/`]);
  const adRep = kid(sets(p1.periods[2], 'video')[0], 'Representation');
  check('the ad\'s segments through the session\'s segment route, its init straight from storage', [kids(kid(adRep, 'SegmentList'), 'SegmentURL')[0]?.attrs.media, kid(kid(adRep, 'SegmentList'), 'Initialization')?.attrs.sourceURL, adRep?.attrs.codecs],
    [`/vod-ads/s/${sid}/seg/1/0/v720/0`, `/clips/vod/${adAsset}/720p/init.mp4`, 'avc1.64001f']);
  check('the whole: 30 minutes and 45 s of ads', p1.root.mediaPresentationDuration, 'PT1845.000S');
  const c1Text = kid(kid(sets(p1.periods[3], 'text')[0], 'Representation'), 'BaseURL')?.text;
  const vt = await get(c1Text ?? '/none');
  check('captions of the second content Period served by the session, on its clock (605 s is 5 s in)', [c1Text, vt.s, vt.h.get('content-type')?.split(';')[0], vt.t],
    [`/vod-ads/s/${sid}/text/1/t.vtt`, 200, 'text/vtt', 'WEBVTT\n\n00:00:05.000 --> 00:00:07.000\nLine at 605 s\n']);
  check('a caption file of a Period or track that does not exist is not found', [(await get(`/vod-ads/s/${sid}/text/9/t.vtt`)).s, (await get(`/vod-ads/s/${sid}/text/1/nope.vtt`)).s], [404, 404]);
  hits.length = 0;
  const s0 = await get(kids(kid(adRep, 'SegmentList'), 'SegmentURL')[0].attrs.media);
  await sleep(400);
  check('a DASH player fetching the ad sends its impression and start, as in HLS', [s0.s, s0.h.get('location'), hits.map((h) => h.path).sort(), hits.every((h) => h.ua === 'TestPlayer/2.0')], [302, `/clips/vod/${adAsset}/720p/seg_1.m4s`, ['/px/imp', '/px/start'], true]);
  const hlsV = await get(`/vod-ads/s/${sid}/v720.m3u8`);
  truthy('the HLS of the same session is unchanged', hlsV.s === 200 && hlsV.t.includes(`/vod-ads/s/${sid}/seg/1/0/v720/0`));

  console.log('\n== who gets HLS only ==');
  const g2 = await gate(hlsOnly);
  check('an asset encoded without DASH: stitched HLS, no DASH', [g2.j.ads?.delivery, g2.j.delivery.dash], ['stitched', null]);
  const g3 = await gate(film, { caps: ['hls-interstitials'] });
  check('a guided player: the shared interstitial playlist, no DASH (guided DASH is not built)', [g3.j.ads?.delivery, g3.j.delivery.dash], ['guided', null]);
  const g4 = await gate(tsFilm);
  const m4 = await get(g4.j.delivery.dash);
  check('an ad with no fMP4 rendition (TS) cannot be a Period: the MPD says so, the HLS still plays', [m4.s, /HLS/.test(m4.t), (await get(g4.j.delivery.hls)).s], [404, true, 200]);
  const gl = (await get(g3.j.delivery.hls.replace('master.m3u8', 'v720.m3u8'))).t.match(/X-ASSET-LIST="([^"]+)"/)![1];
  const al = (await (await fetch(`${base}${gl}?_HLS_primary_id=attempt-guided-01`)).json()) as any;
  check('a guided session has no MPD', (await get(`/vod-ads/s/${al['X-VOLT-SESSION']}/manifest.mpd`)).s, 404);
  check('a made-up session has no MPD', (await get('/vod-ads/s/vaXXXXXXXXXXXXXXXXXXXXXXXXXX/manifest.mpd')).s, 404);
  check('without any ad rule the asset\'s own MPD is handed out as before', await (async () => {
    await api('PUT', '/api/vod/ads/rules/default', { mode: 'off', policy: {}, adServerId: server, houseAds: [] });
    const x = await gate(film); await api('PUT', '/api/vod/ads/rules/default', { mode: 'on', policy: {}, adServerId: server, houseAds: [] });
    return [x.j.ads, x.j.delivery.dash];
  })(), [undefined, `/clips/vod/${film}/manifest.mpd`]);

  // ---------------------------------------------------------------- a real browser
  console.log('\n== in a browser: guided through the Volt player, stitched DASH in Shaka and dash.js ==');
  let pw: any = null;
  for (const name of ['playwright-core', 'playwright']) {
    if (pw) break;
    try { pw = require(require.resolve(name, { paths: [ROOT, process.cwd(), ...(process.env.PLAYWRIGHT_CORE_DIR ? [process.env.PLAYWRIGHT_CORE_DIR] : [])] })); } catch { try { pw = require(name); } catch { /* skip below */ } }
  }
  const chromiumPath = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  const encoders = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout ?? '';
  const haveFfmpeg = encoders.includes('libvpx-vp9') && encoders.includes('libopus');
  const shakaFile = join(PLAYER, 'node_modules/shaka-player/dist/shaka-player.compiled.js');
  let esbuild: any = null;
  try { esbuild = require(require.resolve('esbuild', { paths: [ROOT, PLAYER] })); } catch { /* skip below */ }
  const missing = [!pw && 'playwright-core (npm i --no-save playwright-core in volt-app)', !haveFfmpeg && 'ffmpeg with libvpx-vp9 and libopus',
    !existsSync(shakaFile) && 'volt-player node_modules (npm install in volt-player)', !esbuild && 'esbuild'].filter(Boolean);
  let dashjsFile: string | null = null;
  for (const d of [process.env.DASHJS_DIR, ...(() => { try { return [resolve(require.resolve('dashjs/package.json', { paths: [ROOT, PLAYER] }), '..')]; } catch { return []; } })()]) {
    if (d && existsSync(join(d, 'dist/dash.all.min.js'))) { dashjsFile = join(d, 'dist/dash.all.min.js'); break; }
  }

  let browser: any = null;
  if (missing.length) skip(`the browser part: missing ${missing.join(', ')}`);
  else try {
    // ---- real media: a blue 24 s title with captions, a red 4 s ad, both VP9 + Opus in fMP4, HLS and DASH ----
    const real = await mkAsset('Short blue film', 24, (d) => { ffmpegDash(d, 'blue', 440, 24); addCaptions(d, 24); }, { schema: shortType, cues: [8000] });
    const red = await mkAsset('Red sale (conditioned)', 4, (d) => ffmpegDash(d, 'red', 880, 4));
    await query(`INSERT INTO ad_creatives(account_id, creative_key, vod_asset_id, status, duration_ms) VALUES ($1,'ad-id.org:UAI-4',$2,'ready',4000)`, [acct, red]);
    const server4 = (await one<any>(`INSERT INTO ad_servers(account_id, name, tag_template, timeout_ms) VALUES ($1,'Stub 4',$2,1500) RETURNING id`, [acct, `${VBASE}/vast4?sid=[SESSION_ID]`]))!.id;
    r = await api('PUT', `/api/vod/ads/rules/content-type/${shortType}`, { mode: 'on', adServerId: server4, houseAds: [],
      policy: { preroll: { on: true, sec: 5, minContentSec: 0 }, midroll: { on: true, sec: 5, everyMin: 120, firstAfterMin: 0, endGuardMin: 0, minGapMin: 1, useCues: true, maxBreaks: 1 }, postroll: { on: false } } });
    const plan = await api('GET', `/api/vod/ads/assets/${real}/plan`);
    check('the short film\'s plan: a pre-roll and a mid-roll at its cue (8 s)', [r.s, plan.j.breaks?.map((b: any) => [b.position, b.atSec])], [200, [['pre', 0], ['mid', 8]]]);

    const bundle = esbuild.buildSync({ entryPoints: [join(PLAYER, 'src/index.ts')], bundle: true, format: 'iife', globalName: 'VoltPlayer',
      write: false, target: 'es2018', logLevel: 'silent', nodePaths: [join(PLAYER, 'node_modules')] }).outputFiles[0].text;
    const COLOR = `window.colorOf = function () { var v = document.querySelector('video'); if (!v || v.readyState < 2) return 'none';
      var c = document.createElement('canvas'); c.width = 32; c.height = 18; var x = c.getContext('2d'); x.drawImage(v, 0, 0, 32, 18);
      var d = x.getImageData(16, 9, 1, 1).data; return d[0] > 150 && d[2] < 110 ? 'red' : d[2] > 150 && d[0] < 110 ? 'blue' : 'other:' + d[0] + ',' + d[1] + ',' + d[2]; };
      window.cues = function () { var v = document.querySelector('video'); var out = []; for (var i = 0; i < v.textTracks.length; i++) { var t = v.textTracks[i]; for (var j = 0; t.activeCues && j < t.activeCues.length; j++) out.push(t.activeCues[j].text); } return out; };`;
    const pages: Record<string, { type: string; body: string | Buffer }> = {
      '/__t/volt-player.js': { type: 'text/javascript', body: bundle },
      '/__t/shaka.js': { type: 'text/javascript', body: readFileSync(shakaFile) },
      '/__t/guided.html': { type: 'text/html', body: `<!doctype html><html><body style="margin:0;background:#000"><div id="p" style="width:640px;height:360px"></div>
<script src="/__t/volt-player.js"></script><script>${COLOR}
VoltPlayer.create({ el: '#p', appKey: ${JSON.stringify(k.raw)}, apiBase: location.origin, autoplay: true, muted: true, beacons: false,
  item: { id: ${JSON.stringify(real)}, assetId: ${JSON.stringify(real)} } }).then(function (p) { window.vp = p; });</script></body></html>` },
      '/__t/plain.html': { type: 'text/html', body: `<!doctype html><html><body style="margin:0;background:#000"><video id="v" muted playsinline width="320" height="180"></video>
<script src="/__t/shaka.js"></script>${dashjsFile ? '<script src="/__t/dash.js"></script>' : ''}<script>${COLOR}</script></body></html>` },
    };
    if (dashjsFile) pages['/__t/dash.js'] = { type: 'text/javascript', body: readFileSync(dashjsFile) };

    browser = await pw.chromium.launch({ executablePath: chromiumPath, args: ['--autoplay-policy=no-user-gesture-required'] });
    const ctx = await browser.newContext({ viewport: { width: 700, height: 420 } });
    await ctx.route(`${base}/__t/**`, (route: any) => {
      const f = pages[new URL(route.request().url()).pathname];
      return f ? route.fulfill({ status: 200, contentType: f.type, body: f.body }) : route.fulfill({ status: 404, body: '' });
    });

    // ---- B1: the Volt player, guided: Shaka plays the interstitials ----
    {
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e: any) => errors.push(String(e?.message ?? e)));
      const asked: string[] = [];
      let gateBody: any = null;
      page.on('request', (q: any) => {
        const u = q.url();
        if (u.includes('/api/availability') && q.method() === 'POST') { try { gateBody = JSON.parse(q.postData() ?? '{}'); } catch { /* */ } }
        if (/\/vod-ads\/g\/.+\/list\/\d+\.json/.test(u)) asked.push(u);
      });
      hits.length = 0;
      await page.goto(`${base}/__t/guided.html`);
      const colour = () => page.evaluate('window.colorOf()') as Promise<string>;
      const overlay = () => page.evaluate(`(function () { var e = document.querySelector('.vp-ad'); return e && !e.hidden ? e.textContent : null; })()`) as Promise<string | null>;
      const tPre = await until(async () => (await colour()) === 'red', 20000);
      check('the player says it can play interstitials and asks for ads its way', [gateBody?.caps, gateBody?.adDelivery], [['hls-interstitials'], 'auto']);
      truthy('Shaka asked for the pre-roll\'s asset list, naming this playback', asked.some((u) => /\/list\/0\.json\?_HLS_primary_id=/.test(u)), asked.join(' '));
      truthy('the pre-roll plays (red) in the player\'s own video element', tPre >= 0, `colour ${await colour()}`);
      const ov = await overlay();
      truthy('the overlay shows the ad and its time left, with Learn more once the timeline says it has a page',
        (await until(async () => /^Ad · 0:0\d\s*Learn more$/.test((await overlay()) ?? ''), 4000)) >= 0, String(ov));
      const tBlue = await until(async () => (await colour()) === 'blue' && (await overlay()) == null, 15000);
      truthy('then the content (blue), the overlay gone', tBlue >= 0, `colour ${await colour()} overlay ${await overlay()}`);
      const tMid = await until(async () => (await colour()) === 'red', 20000);
      truthy('the mid-roll at 8 s: its asset list asked when playback got there, the ad plays', tMid >= 0 && asked.some((u) => /\/list\/1\.json\?/.test(u)), asked.join(' '));
      const trail: string[] = [];
      const tBack = await until(async () => {
        const c = await colour(), t = Number(await page.evaluate(`document.querySelector('video').currentTime`));
        trail.push(`${c}@${t.toFixed(1)}`);
        return c === 'blue' && t >= 8.5;
      }, 15000, 500);
      if (tBack < 0) console.log('   after the mid-roll: ' + trail.join(' '));
      truthy('and the content resumes after it, from 8 s (not from the start)', tBack >= 0, `t=${await page.evaluate(`document.querySelector('video').currentTime`)}`);
      await sleep(500);
      const imps = hits.filter((h) => h.path === '/px/imp4').length;
      check('the server sent each ad\'s impression and start from its segment requests (no player code)', [imps, hits.filter((h) => h.path === '/px/start4').length], [2, 2]);
      const ps = new Set(asked.map((u) => new URL(u).searchParams.get('_HLS_primary_id')));
      check('both breaks decided for the same playback (one session)', ps.size, 1);
      check('no page errors', errors, []);
      await page.close();
    }

    // ---- B2, B3: the stitched MPD across a break, in Shaka and in dash.js ----
    const st1 = await gate(real, { adDelivery: 'stitched' });
    const dashUrl = st1.j.delivery?.dash;
    check('stitched for this title: the session\'s MPD', /^\/vod-ads\/s\/va[\w-]+\/manifest\.mpd$/.test(dashUrl ?? ''), true);
    const across = async (page: any) => {
      const seen: string[] = [];
      for (let i = 0; i < 36; i++) { const c = await page.evaluate('window.colorOf()'); if (seen[seen.length - 1] !== c) seen.push(c); await sleep(250); }
      console.log('   colours seen: ' + seen.join(' '));
      return seen.filter((c: string) => c === 'red' || c === 'blue');
    };
    {
      const page = await ctx.newPage();
      const segs: string[] = [];
      page.on('request', (q: any) => { if (q.url().includes('/seg/')) segs.push(q.url()); });
      await page.goto(`${base}/__t/plain.html`);
      const res = await page.evaluate(`(async function () {
        var v = document.getElementById('v'); var sp = new shaka.Player(); await sp.attach(v);
        window.errs = []; sp.addEventListener('error', function (e) { window.errs.push(e.detail && e.detail.code); });
        await sp.load(${JSON.stringify(base + dashUrl)}); window.sp = sp;
        v.currentTime = 10.5; await v.play();
        return { duration: v.duration, text: sp.getTextTracks().length };
      })()`);
      check('Shaka loads the stitched MPD: 24 s of content and 8 s of ads, one caption track across the Periods', [Math.round(res.duration), res.text], [32, 1]);
      const seq = await across(page);
      check('played from 10.5 s across the break: content, the red ad, content again', seq.slice(0, 3), ['blue', 'red', 'blue']);
      truthy('the ad\'s segments came through the session\'s segment route', segs.some((u) => /\/vod-ads\/s\/va[\w-]+\/seg\/1\/0\//.test(u)), segs.slice(0, 3).join(' '));
      const after = await page.evaluate(`({ t: document.getElementById('v').currentTime, errs: window.errs, tracks: sp.getTextTracks().length })`);
      truthy('past the break with no error, the caption track still there', after.t > 16.5 && after.errs.length === 0 && after.tracks === 1, JSON.stringify(after));
      const cueAt = async (t: number) => {
        await page.evaluate(`(function () { var v = document.getElementById('v'); v.pause(); var tr = sp.getTextTracks()[0]; sp.selectTextTrack(tr); sp.setTextTrackVisibility(true); v.currentTime = ${t}; })()`);
        await until(async () => (await page.evaluate('window.cues()')).length > 0, 2500);
        await sleep(300);
        const got = await page.evaluate('window.cues()');
        if (!got.length) console.log('   text tracks: ' + JSON.stringify(await page.evaluate(`(function () { var v = document.getElementById('v'); var o = []; for (var i = 0; i < v.textTracks.length; i++) { var t = v.textTracks[i]; o.push([t.kind, t.label, t.language, t.mode, t.cues ? t.cues.length : null]); } return { o: o, vis: sp.isTextTrackVisible(), tt: sp.getTextTracks().map(function (x) { return [x.language, x.active]; }), t: v.currentTime }; })()`)));
        return got;
      };
      check('captions in step in the first content Period (content 2 s at stitched 6 s)', await cueAt(6), ['Hello one']);
      check('nothing during the ad (blank captions)', await cueAt(14), []);
      check('captions in step after the mid-roll (content 13.5 s at stitched 21.5 s, moved by the Period\'s offset)', await cueAt(21.5), ['Hello thirteen']);
      await page.close();
    }
    if (!dashjsFile) skip('dash.js: not found (npm i --no-save dashjs, or set DASHJS_DIR)');
    else {
      const page = await ctx.newPage();
      await page.goto(`${base}/__t/plain.html`);
      await page.evaluate(`(function () {
        var v = document.getElementById('v'); var p = dashjs.MediaPlayer().create(); window.dp = p; window.errs = [];
        p.updateSettings({ debug: { logLevel: 0 } });
        p.on(dashjs.MediaPlayer.events.ERROR, function (e) { window.errs.push((e.error && (e.error.code || e.error.message)) || 'error'); });
        p.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, function () { window.ready = true; });
        p.initialize(v, ${JSON.stringify(base + dashUrl)}, false);
      })()`);
      const ready = await until(async () => await page.evaluate('window.ready === true'), 15000);
      await page.evaluate(`(function () { window.dp.seek(10.5); window.dp.play(); })()`);
      const dur = await page.evaluate('window.dp.duration()');
      check('dash.js reads the stitched MPD: 32 s in all', [ready >= 0, Math.round(Number(dur))], [true, 32]);
      const seq = await across(page);
      check('dash.js plays across the break: content, the red ad, content again', seq.slice(0, 3), ['blue', 'red', 'blue']);
      const after = await page.evaluate(`({ t: window.dp.time(), errs: window.errs })`);
      truthy('dash.js past the break with no error', after.t > 16.5 && after.errs.length === 0, JSON.stringify(after));
      // dash.js 4.7 places a sidecar WebVTT of a multi-Period MPD on the
      // presentation's clock, not the Period's (Shaka, and the DASH spec, use
      // the Period's): its first cue lands at 1 s instead of 5 s. Recorded, not
      // passed: captions in dash.js need segmented (fMP4) WebVTT, not built.
      await page.evaluate(`(function () { var p = window.dp; p.pause(); p.enableText(true); p.setTextTrack(0); p.seek(21.5); })()`);
      await sleep(1500);
      const dt = await page.evaluate(`(function () { var v = document.getElementById('v'); var t = v.textTracks[0]; return t && t.cues && t.cues.length ? t.cues[0].startTime : null; })()`);
      skip(`dash.js captions: first cue at ${dt} s in the presentation (Shaka: 5 s); dash.js reads sidecar WebVTT cues on the presentation clock in a multi-Period MPD`);
      await page.close();
    }
  } catch (e: any) {
    bad('the browser part ran to the end', String(e?.stack ?? e));
  } finally {
    if (browser) await browser.close().catch(() => null);
  }

  srv.close(); vast.close(); await pool.end();
  console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
