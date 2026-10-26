// ============================================================================
//  CATCH-UP DYNAMIC AD REPLACEMENT (SSAI.md 5.2, build queue 1.14k-3).
//
//  A recording of a live channel or event knows where its broadcast breaks
//  were (stream_breaks). Its catch-up title leaves those stretches out (no
//  re-encode: the playlist skips their segments) and the on-demand ad rule
//  fills each one with a decided pod.
//
//  Pure first: the cut windows (snapped to segment starts, clipped, merged),
//  where they fall in catch-up time, the cut playlist (whole segments, audio
//  following the picture, a discontinuity after each cut even when no ad fills
//  it), and the plan (the broadcast breaks are the mid-rolls). Then the real
//  API with a local VAST server and HLS on disk: a recorded hour with two
//  breaks plays with both replaced by decided pods and the content either side
//  unchanged, in stitched and guided form; a cancelled break and another
//  channel's break are ignored; an event replay dated from its recording; a
//  clip of one range; what stays as recorded (no mid-rolls, ad-free viewers,
//  a clip joined from several ranges, an upload).
//
//  Usage: DATABASE_URL=... npx tsx test/vod-ads-catchup.check.ts
// ============================================================================
import { createServer as httpServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `expected [${JSON.stringify(want)}] got [${JSON.stringify(got)}]`);
const truthy = (m: string, v: unknown, d = '') => (v ? ok(m) : bad(m, d || `got [${JSON.stringify(v)}]`));

/** An HLS asset on disk: two video renditions and audio, 4 s segments, optionally dated and with captions. */
function writeAsset(dir: string, totalSec: number, opts: { pdtMs?: number; subs?: boolean } = {}) {
  const seg = 4;
  mkdirSync(dir, { recursive: true });
  const segs: number[] = [];
  for (let t = 0; t < totalSec - 1e-9; t += seg) segs.push(Math.min(seg, totalSec - t));
  const pdt = opts.pdtMs != null ? [`#EXT-X-PROGRAM-DATE-TIME:${new Date(opts.pdtMs).toISOString()}`] : [];
  const media = (folder: string) => ['#EXTM3U', '#EXT-X-VERSION:6', `#EXT-X-TARGETDURATION:${seg}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-MAP:URI="${folder}/init.mp4"`, ...pdt, ...segs.flatMap((d, i) => [`#EXTINF:${d.toFixed(3)},`, `${folder}/seg_${i + 1}.m4s`]), '#EXT-X-ENDLIST', ''].join('\n');
  writeFileSync(join(dir, 'stream_0.m3u8'), media('360p'));
  writeFileSync(join(dir, 'stream_1.m3u8'), media('720p'));
  writeFileSync(join(dir, 'stream_2.m3u8'), media('audio'));
  const lines = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="stream_2.m3u8"'];
  if (opts.subs) {
    mkdirSync(join(dir, 'subs'), { recursive: true });
    writeFileSync(join(dir, 'subs', 'en.m3u8'), ['#EXTM3U', `#EXT-X-TARGETDURATION:${seg}`, '#EXT-X-PLAYLIST-TYPE:VOD', ...segs.flatMap((d, i) => [`#EXTINF:${d.toFixed(3)},`, `en_${i + 1}.vtt`]), '#EXT-X-ENDLIST', ''].join('\n'));
    lines.push('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="subs/en.m3u8"');
  }
  const s = opts.subs ? ',SUBTITLES="subs"' : '';
  lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="audio"${s}`, 'stream_0.m3u8',
    `#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,AUDIO="audio"${s}`, 'stream_1.m3u8');
  writeFileSync(join(dir, 'master.m3u8'), lines.join('\n') + '\n');
}

(async () => {
  // ---------------------------------------------------------------- a VAST server: one 15 s ad
  const vast = httpServer((req, res) => {
    const base = `http://127.0.0.1:${(vast.address() as any).port}`;
    if (req.url?.startsWith('/px/')) { res.writeHead(200); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end(`<VAST version="4.1"><Ad id="a1" sequence="1"><InLine><AdSystem>Stub</AdSystem><AdTitle>Spring sale</AdTitle>
      <Impression><![CDATA[${base}/px/imp]]></Impression><Creatives><Creative id="c1"><UniversalAdId idRegistry="ad-id.org">UAI-1</UniversalAdId><Linear><Duration>00:00:15</Duration>
      <MediaFiles><MediaFile delivery="progressive" type="video/mp4" width="1280" height="720"><![CDATA[${base}/ad.mp4]]></MediaFile></MediaFiles></Linear></Creative></Creatives></InLine></Ad></VAST>`);
  });
  await new Promise<void>((r) => vast.listen(0, '127.0.0.1', () => r()));
  const VBASE = `http://127.0.0.1:${(vast.address() as any).port}`;

  const work = mkdtempSync(join(tmpdir(), 'vod-ads-catchup-'));
  Object.assign(process.env, { CLIPS_DIR: join(work, 'clips'), AD_BEACONS_ALLOW_PRIVATE: '1', PUBLIC_BASE_URL: 'https://volt.example' });

  const P = await import('../src/services/vodAds/plan');
  const H = await import('../src/services/vodAds/hls');

  console.log('== the cut windows ==');
  const bounds = Array.from({ length: 900 }, (_, i) => i * 4);
  const T0 = Date.UTC(2026, 9, 26, 19, 0, 0);
  check('two breaks on segment starts are cut exactly',
    P.catchupWindows([{ startMs: T0 + 1200_000, durationMs: 120_000 }, { startMs: T0 + 2400_000, durationMs: 90_000 }], T0, 3600, bounds),
    [{ fromSec: 1200, toSec: 1320 }, { fromSec: 2400, toSec: 2488 }]);
  check('a break between segment starts moves to the nearest ones (600.9 s to 662.2 s: 600 to 664)',
    P.catchupWindows([{ startMs: T0 + 600_900, durationMs: 61_300 }], T0, 3600, bounds), [{ fromSec: 600, toSec: 664 }]);
  check('a break that began before the recording is cut from its start; one after its end is ignored',
    P.catchupWindows([{ startMs: T0 - 30_000, durationMs: 62_000 }, { startMs: T0 + 3700_000, durationMs: 60_000 }], T0, 3600, bounds), [{ fromSec: 0, toSec: 32 }]);
  check('a break running past the end is cut to the end',
    P.catchupWindows([{ startMs: T0 + 3560_000, durationMs: 120_000 }], T0, 3600, bounds), [{ fromSec: 3560, toSec: 3600 }]);
  check('overlapping breaks (an operator break and the same SCTE-35 one) merge',
    P.catchupWindows([{ startMs: T0 + 1200_000, durationMs: 60_000 }, { startMs: T0 + 1240_000, durationMs: 60_000 }], T0, 3600, bounds), [{ fromSec: 1200, toSec: 1300 }]);
  check('a cut shorter than half a segment disappears', P.catchupWindows([{ startMs: T0 + 1201_000, durationMs: 1_000 }], T0, 3600, bounds), []);
  check('a cut that would leave nothing to play is dropped', P.catchupWindows([{ startMs: T0, durationMs: 3600_000 }], T0, 3600, bounds), []);
  const cuts = [{ fromSec: 1200, toSec: 1320 }, { fromSec: 2400, toSec: 2488 }];
  check('replaced breaks in catch-up time: 1200 s, then 2280 s (120 s cut before it), with their broadcast lengths',
    P.replaceBreaks(cuts), [{ atSec: 1200, durationSec: 120 }, { atSec: 2280, durationSec: 88 }]);
  check('recording time to catch-up time: before, inside and after the cuts',
    [P.recordedToCatchup(100, cuts), P.recordedToCatchup(1250, cuts), P.recordedToCatchup(1320, cuts), P.recordedToCatchup(3600, cuts)], [100, 1200, 1200, 3392]);

  console.log('\n== the cut playlist ==');
  const vid = H.parseMedia(['#EXTM3U', '#EXT-X-MAP:URI="i.mp4"', '#EXT-X-PROGRAM-DATE-TIME:2026-10-26T19:00:08.000Z',
    ...[1, 2, 3, 4, 5, 6].flatMap((n) => ['#EXTINF:4,', `v${n}.m4s`]), '#EXT-X-ENDLIST'].join('\n'), '/clips/r/v.m3u8')!;
  check('a recording\'s PROGRAM-DATE-TIME dates its first segment (on the first one seen)', vid.startMs, Date.UTC(2026, 9, 26, 19, 0, 8));
  const vc = H.cutMedia(vid, [{ fromSec: 8, toSec: 16 }]);
  check('the cut leaves segments 3 and 4 out and marks 5 as after a cut', vc.segments.map((s) => `${s.url.split('/').pop()}${s.disc ? '*' : ''}`), ['v1.m4s', 'v2.m4s', 'v5.m4s*', 'v6.m4s']);
  const aud = H.parseMedia(['#EXTM3U', ...[3.98, 4.01, 4.02, 3.99, 4.0, 4.0].flatMap((d, n) => [`#EXTINF:${d},`, `a${n + 1}.aac`]), '#EXT-X-ENDLIST'].join('\n'), '/clips/r/a.m3u8')!;
  check('audio segments that do not line up go with the picture (by their middle)', H.cutMedia(aud, [{ fromSec: 8, toSec: 16 }]).segments.map((s) => s.url.split('/').pop()), ['a1.aac', 'a2.aac', 'a5.aac', 'a6.aac']);
  const st = H.stitchMedia(vc, []);
  check('a cut no ad fills is still a discontinuity, with the init sent again',
    st.split('\n').filter((l) => l.startsWith('#EXT-X-DISCONTINUITY') || l.startsWith('#EXT-X-MAP') || l.endsWith('.m4s')).map((l) => l.replace(/^.*\//, '')),
    ['i.mp4"', 'v1.m4s', 'v2.m4s', '#EXT-X-DISCONTINUITY', 'i.mp4"', 'v5.m4s', 'v6.m4s']);
  const sf = H.stitchMedia(vc, [{ index: 0, atSec: 8, segments: [{ dur: 5, url: '/ad/0', init: '/ad/i.mp4', tags: [] }] }]);
  check('a filled cut: the pod where the broadcast break was, one discontinuity each side',
    sf.split('\n').filter((l) => l === '#EXT-X-DISCONTINUITY' || (l && !l.startsWith('#'))).map((l) => l.replace(/^.*\//, '')),
    ['v1.m4s', 'v2.m4s', '#EXT-X-DISCONTINUITY', '0', '#EXT-X-DISCONTINUITY', 'v5.m4s', 'v6.m4s']);
  const gd = H.guidedMedia(vc, [{ index: 0, atSec: 8, durationSec: 8, position: 'mid' }], (b) => `/list/${b.index}.json`);
  truthy('guided: the interstitial at catch-up 8 s, the clock restated after the cut at 8 s',
    gd.includes('START-DATE="2000-01-01T00:00:08.000Z"') && /#EXT-X-DISCONTINUITY\n#EXT-X-PROGRAM-DATE-TIME:2000-01-01T00:00:08\.000Z\n#EXT-X-MAP:URI="\/clips\/r\/i\.mp4"/.test(gd), gd);

  console.log('\n== the plan ==');
  const pol = P.resolveVodAdPolicy({});
  let br = P.planVodBreaks(3392, pol, { boundaries: bounds, replace: P.replaceBreaks(cuts) });
  check('the broadcast breaks are the mid-rolls, as long as the breaks they replace; no interval mid-rolls added',
    br.map((b) => [b.position, b.atSec, b.durationSec, b.source]), [['pre', 0, 15, 'pre'], ['mid', 1200, 120, 'replace'], ['mid', 2280, 88, 'replace']]);
  br = P.planVodBreaks(3392, pol, { replace: [{ atSec: 120, durationSec: 60 }, { atSec: 150, durationSec: 60 }, { atSec: 3390, durationSec: 30 }] });
  check('a replaced break keeps its place even in the opening minutes, close to another, or by the end',
    br.filter((b) => b.position === 'mid').map((b) => b.atSec), [120, 150, 3390]);
  check('a cut at the very start is covered by the pre-roll, not a second break',
    P.planVodBreaks(3392, pol, { replace: [{ atSec: 0, durationSec: 30 }] }).map((b) => b.position), ['pre']);
  check('no_mid: only the pre-roll', P.planVodBreaks(3392, pol, { titleRule: 'no_mid', replace: P.replaceBreaks(cuts) }).map((b) => b.position), ['pre']);

  // ---------------------------------------------------------------- the real thing
  const { query, one, pool } = await import('../src/db');
  const { createServer } = await import('../src/server');
  const { signAccess } = await import('../src/auth/jwt');
  const { generateKey } = await import('../src/services/apiKeys');
  const VA = await import('../src/services/vodAds');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`vac-${tag}`]))!.id;
  const owner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `vac-${tag}@volt.test`]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
  const g = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name, status) VALUES ($1,'News 24',$2) RETURNING id`, [g, 'ended']))!.id;
  const ch2 = (await one<any>(`INSERT INTO channels(group_id, name, status) VALUES ($1,'Other',$2) RETURNING id`, [g, 'ended']))!.id;
  const ev = (await one<any>(`INSERT INTO events(group_id, name, scheduled_start, scheduled_end) VALUES ($1,'Cup final',now(),now()+interval '2 hours') RETURNING id`, [g]))!.id;

  // The recorded hour: 19:00 to 20:00 UTC, its playlists dated.
  const rec = (await one<any>(`INSERT INTO recordings(kind, channel_id, day_utc, status, start_epoch_ms, end_epoch_ms, duration_ms, master_key)
    VALUES ('channel_day',$1,'2026-10-26','complete',$2,$3,3600000,'x') RETURNING id`, [ch, T0, T0 + 3600_000]))!.id;
  const mk = async (sql: string, args: unknown[], sec: number, opts: { pdtMs?: number; subs?: boolean } = {}) => {
    const id = (await one<any>(sql, args))!.id;
    writeAsset(join(process.env.CLIPS_DIR!, 'vod', id), sec, opts);
    await query(`UPDATE vod_assets SET master_key = $2, published = true WHERE id = $1`, [id, `/clips/vod/${id}/master.m3u8`]);
    return id;
  };
  const hour = await mk(`INSERT INTO vod_assets(channel_id, recording_id, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, thumb_status)
    VALUES ($1,$2,'full_event','News at seven',$3,$4,3600000,'ready') RETURNING id`, [ch, rec, T0, T0 + 3600_000], 3600, { pdtMs: T0, subs: true });
  // the two broadcast breaks (an operator's and a SCTE-35 one), a cancelled one, another channel's
  await query(`INSERT INTO stream_breaks(channel_id, source, starts_at, duration_ms, status) VALUES
    ($1,'manual',to_timestamp($2/1000.0),120000,'aired'), ($1,'scte35',to_timestamp($3/1000.0),90000,'aired'),
    ($1,'manual',to_timestamp($4/1000.0),60000,'cancelled'), ($5,'manual',to_timestamp($6/1000.0),60000,'aired'),
    ($1,'manual',to_timestamp($7/1000.0),60000,'aired')`,
  [ch, T0 + 1200_000, T0 + 2400_000, T0 + 3000_000, ch2, T0 + 600_000, T0 + 7200_000]);

  const adAsset = await mk(`INSERT INTO vod_assets(channel_id, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, thumb_status) VALUES ($1,'clip','Spring sale',0,15000,15000,'ready') RETURNING id`, [ch], 15);
  const house = await mk(`INSERT INTO vod_assets(channel_id, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, thumb_status) VALUES ($1,'clip','House promo',0,10000,10000,'ready') RETURNING id`, [ch], 10);
  await query(`INSERT INTO ad_creatives(account_id, creative_key, vod_asset_id, status, duration_ms) VALUES ($1,'ad-id.org:UAI-1',$2,'ready',15000)`, [acct, adAsset]);
  const server = (await one<any>(`INSERT INTO ad_servers(account_id, name, tag_template, timeout_ms) VALUES ($1,'Stub',$2,1000) RETURNING id`, [acct, `${VBASE}/vast?sid=[SESSION_ID]`]))!.id;
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
    const r = await fetch(`${base}/api/availability`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'TestPlayer/1.0' }, body: JSON.stringify({ appKey: k.raw, assetId, ...extra }) });
    return { s: r.status, j: await r.json() as any };
  };
  const text = async (path: string) => { const r = await fetch(base + path); return { s: r.status, t: await r.text() }; };
  const uris = (t: string) => t.split('\n').filter((l) => l && !l.startsWith('#'));

  console.log('\n== before ads are on: the recording plays as recorded ==');
  let g1 = await gate(hour);
  check('no rule: the gate gives the recording itself', [g1.s, g1.j.delivery.hls, g1.j.ads], [200, `/clips/vod/${hour}/master.m3u8`, undefined]);

  let r = await api('PUT', '/api/vod/ads/rules/default', { mode: 'on', policy: {}, adServerId: server, houseAds: [{ assetId: house }] });
  check('the owner turns on-demand ads on (defaults: pre-roll, mid-rolls)', [r.s, r.j.mode], [200, 'on']);

  console.log('\n== the plan of a recorded hour ==');
  r = await api('GET', `/api/vod/ads/assets/${hour}/plan`);
  check('the plan: a pre-roll and the two broadcast breaks replaced, nothing else',
    [r.s, r.j.contentSec, r.j.breaks.map((b: any) => [b.position, b.atSec, b.durationSec, b.source])],
    [200, 3392, [['pre', 0, 15, 'pre'], ['mid', 1200, 120, 'replace'], ['mid', 2280, 88, 'replace']]]);
  check('the plan says where the broadcast breaks were cut (the cancelled one, the other channel\'s and the one after the hour are not)',
    r.j.replaced, [{ contentSec: 1200, recordedFromSec: 1200, recordedToSec: 1320 }, { contentSec: 2280, recordedFromSec: 2400, recordedToSec: 2488 }]);

  console.log('\n== stitched: the breaks replaced ==');
  g1 = await gate(hour, { sid: 'catchup-play-0001' });
  const sid = g1.j.ads?.sessionId;
  check('the gate opens a stitched session; HLS only (the DASH cut is not built for catch-up)', [g1.s, g1.j.ads?.delivery, !!sid, g1.j.delivery.dash], [200, 'stitched', true, null]);
  const v = await text(`/vod-ads/s/${sid}/v720.m3u8`);
  const vl = uris(v.t);
  const content = vl.filter((l) => l.includes(`/clips/vod/${hour}/`)).map((l) => Number(l.match(/seg_(\d+)\.m4s$/)![1]));
  const expected = Array.from({ length: 900 }, (_, i) => i + 1).filter((n) => !(n >= 301 && n <= 330) && !(n >= 601 && n <= 622));
  check('the content is the recording without the broadcast breaks: 848 of 900 segments, in order', [content.length, JSON.stringify(content) === JSON.stringify(expected)], [848, true]);
  const at = (n: number) => vl.indexOf(`/clips/vod/${hour}/720p/seg_${n}.m4s`);
  truthy('first break: the pod sits between segment 300 (ends 20:00) and segment 331 (from 22:00)',
    vl.slice(at(300) + 1, at(331)).length > 0 && vl.slice(at(300) + 1, at(331)).every((l) => l.includes(`/vod-ads/s/${sid}/seg/1/`)), vl.slice(at(300), at(331) + 1).join(' '));
  truthy('second break: the pod sits between segment 600 (ends 40:00) and segment 623 (from 41:28)',
    vl.slice(at(600) + 1, at(623)).length > 0 && vl.slice(at(600) + 1, at(623)).every((l) => l.includes(`/vod-ads/s/${sid}/seg/2/`)), vl.slice(at(600), at(623) + 1).join(' '));
  truthy('the pre-roll opens the playlist', vl[0].includes(`/vod-ads/s/${sid}/seg/0/`));
  const a = await text(`/vod-ads/s/${sid}/audio.m3u8`);
  const al = uris(a.t).filter((l) => l.includes('/audio/seg_')).map((l) => Number(l.match(/seg_(\d+)\.m4s$/)![1]));
  check('audio is cut at the same places', JSON.stringify(al) === JSON.stringify(expected), true);
  const sub = await text(`/vod-ads/s/${sid}/subs.m3u8`);
  const sl = uris(sub.t);
  check('captions are cut too and stay in step: blank for each pod, none of the cut cues',
    [sl.filter((l) => l.endsWith('/vod-ads/blank.vtt')).length, sl.some((l) => /en_(30[1-9]|31\d|32\d|330)\.vtt$/.test(l)), sl.filter((l) => /en_\d+\.vtt$/.test(l)).length], [3, false, 848]);
  const tl = (await (await fetch(`${base}/vod-ads/s/${sid}/timeline.json`)).json()) as any;
  check('timeline: breaks at content 0, 1200 and 2280 s; content time is the programme without the broadcast ads',
    [tl.contentSec, tl.breaks.map((b: any) => [b.position, b.contentSec, b.stitchedStartSec, b.durationSec])],
    [3392, [['pre', 0, 0, 15], ['mid', 1200, 1215, 25], ['mid', 2280, 2320, 25]]]);
  check('timeline: where the broadcast breaks were', tl.replaced.map((x: any) => [x.contentSec, x.recordedFromSec, x.recordedToSec]), [[1200, 1200, 1320], [2280, 2400, 2488]]);
  const dec = await query<any>(`SELECT position, break_ms, ad_ms, house_ms FROM vod_ad_breaks WHERE session_id=$1 ORDER BY break_index`, [sid]);
  check('each replaced break decided as long as the broadcast break it replaces (120 s, 88 s), filled by the ad server then a house spot',
    dec.map((d) => [d.position, d.break_ms, d.ad_ms, d.house_ms]), [['pre', 15000, 15000, 0], ['mid', 120000, 15000, 10000], ['mid', 88000, 15000, 10000]]);
  check('the session\'s MPD is not offered', (await text(`/vod-ads/s/${sid}/manifest.mpd`)).s, 404);

  console.log('\n== guided: the same breaks, the shared playlist cut ==');
  const g2 = await gate(hour, { caps: ['hls-interstitials'] });
  check('a player with interstitials gets the guided playlist', g2.j.ads?.delivery, 'guided');
  const gpath = g2.j.delivery.hls.replace(/master\.m3u8$/, 'v720.m3u8');
  const gv = await text(gpath);
  const gl = uris(gv.t).map((l) => Number(l.match(/seg_(\d+)\.m4s$/)?.[1]));
  check('guided content: the recording without the broadcast breaks', JSON.stringify(gl) === JSON.stringify(expected), true);
  truthy('guided: interstitials at catch-up 0, 20:00 and 38:00, as long as the breaks they replace',
    gv.t.includes('START-DATE="2000-01-01T00:20:00.000Z",DURATION=120.000') && gv.t.includes('START-DATE="2000-01-01T00:38:00.000Z",DURATION=88.000') && (gv.t.match(/com\.apple\.hls\.interstitial/g) ?? []).length === 3);
  truthy('guided: a discontinuity and the clock restated after each cut',
    gv.t.includes('#EXT-X-DISCONTINUITY\n#EXT-X-PROGRAM-DATE-TIME:2000-01-01T00:20:00.000Z') && gv.t.includes('#EXT-X-DISCONTINUITY\n#EXT-X-PROGRAM-DATE-TIME:2000-01-01T00:38:00.000Z'));
  const ver1 = gpath.split('/')[4];
  await query(`UPDATE stream_breaks SET status = 'cancelled' WHERE channel_id = $1 AND source = 'scte35'`, [ch]);
  const g3 = await gate(hour, { caps: ['hls-interstitials'] });
  truthy('cancelling a broadcast break changes the guided version, so no CDN copy is stale', g3.j.delivery.hls.split('/')[4] !== ver1);
  r = await api('GET', `/api/vod/ads/assets/${hour}/plan`);
  check('...and the plan now replaces one break', r.j.replaced.length, 1);
  await query(`UPDATE stream_breaks SET status = 'aired' WHERE channel_id = $1 AND source = 'scte35'`, [ch]);

  console.log('\n== other recorded titles ==');
  // An event replay as deriveEventVod makes it: 0-based range, no dates in the playlist; the recording dates it.
  const ET0 = T0 + 86400_000;
  const erec = (await one<any>(`INSERT INTO recordings(kind, event_id, status, start_epoch_ms, end_epoch_ms, duration_ms, master_key) VALUES ('event',$1,'complete',$2,$3,1800000,'x') RETURNING id`, [ev, ET0, ET0 + 1800_000]))!.id;
  const replay = await mk(`INSERT INTO vod_assets(event_id, recording_id, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, thumb_status) VALUES ($1,$2,'full_event','Cup final',0,1800000,1800000,'ready') RETURNING id`, [ev, erec], 1800);
  await query(`INSERT INTO stream_breaks(event_id, source, starts_at, duration_ms, status) VALUES ($1,'scte35',to_timestamp($2/1000.0),61300,'aired')`, [ev, ET0 + 600_900]);
  r = await api('GET', `/api/vod/ads/assets/${replay}/plan`);
  check('an event replay is dated from its recording: the half-time break (600.9 s, 61.3 s) cut on segment starts, 600 to 664 s',
    [r.j.replaced, r.j.breaks.filter((b: any) => b.position === 'mid').map((b: any) => [b.atSec, b.durationSec])], [[{ contentSec: 600, recordedFromSec: 600, recordedToSec: 664 }], [[600, 64]]]);
  const clip = await mk(`INSERT INTO vod_assets(channel_id, recording_id, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, clip_spec, thumb_status)
    VALUES ($1,$2,'clip','News at seven, second half',$3,$4,1800000,$5::jsonb,'ready') RETURNING id`, [ch, rec, T0 + 1800_000, T0 + 3600_000, JSON.stringify([{ recording_id: rec, start_ms: T0 + 1800_000, end_ms: T0 + 3600_000 }])], 1800);
  r = await api('GET', `/api/vod/ads/assets/${clip}/plan`);
  check('a clip of one range (an auto-VOD programme) is dated from its range: the 40:00 break is at 10:00 in it', r.j.replaced, [{ contentSec: 600, recordedFromSec: 600, recordedToSec: 688 }]);
  const joined = await mk(`INSERT INTO vod_assets(channel_id, recording_id, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, clip_spec, thumb_status)
    VALUES ($1,$2,'clip','Highlights',$3,$4,1800000,$5::jsonb,'ready') RETURNING id`, [ch, rec, T0, T0 + 3600_000,
    JSON.stringify([{ recording_id: rec, start_ms: T0, end_ms: T0 + 900_000 }, { recording_id: rec, start_ms: T0 + 2700_000, end_ms: T0 + 3600_000 }])], 1800);
  r = await api('GET', `/api/vod/ads/assets/${joined}/plan`);
  check('a clip joined from several ranges has no single clock: planned as an ordinary title', [r.j.replaced, r.j.breaks.some((b: any) => b.source === 'replace')], [[], false]);
  const upload = await mk(`INSERT INTO vod_assets(account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, thumb_status) VALUES ($1,'upload','clip','A film',0,3600000,3600000,'ready') RETURNING id`, [acct], 3600);
  r = await api('GET', `/api/vod/ads/assets/${upload}/plan`);
  check('an uploaded film: interval mid-rolls as before', [r.j.replaced, r.j.breaks.filter((b: any) => b.position === 'mid').map((b: any) => b.source)], [[], ['interval', 'interval', 'interval', 'interval', 'interval']]);

  console.log('\n== what plays as recorded ==');
  const asset = await VA.assetFor(hour, acct);
  check('with mid-rolls off in the rule, nothing is cut (replacing means replacing)', (await VA.breaksFor(asset!, P.resolveVodAdPolicy({ midroll: { on: false } }))).cuts, []);
  await query(`UPDATE vod_assets SET metadata = '{"adRule":"no_mid"}' WHERE id = $1`, [hour]);
  r = await api('GET', `/api/vod/ads/assets/${hour}/plan`);
  check('a title marked no_mid keeps its broadcast breaks and gets a pre-roll only', [r.j.replaced, r.j.contentSec, r.j.breaks.map((b: any) => b.position)], [[], 3600, ['pre']]);
  await query(`UPDATE vod_assets SET metadata = '{}' WHERE id = $1`, [hour]);
  check('a viewer who paid plays the recording as recorded', await VA.adsForPlay({ accountId: acct, assetId: hour, via: 'entitlement', ctx: {} }), null);

  srv.close(); vast.close(); await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
