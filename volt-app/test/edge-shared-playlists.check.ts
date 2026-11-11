// ============================================================================
//  SHARED PLAYLISTS UNDER ENFORCE: GUIDED ADS AND THE FAST STITCHER (build
//  queue P2-2f-3; services/vodAds guidedVersions, guidedMaster,
//  guidedPlaylist; modules/vodAds.ts the guided routes; modules/fast.ts
//  podTokeniser, podSegments and the session route).
//
//  Under VOLT_EDGE_TOKENS=enforce the edge refuses a title's plain address.
//  1. The guided on-demand playlists (/vod-ads/g/...) are one answer for every
//     viewer, cached at the CDN, and named the title's segments plainly, so
//     guided ads did not play under enforce. Here, on the real API with media
//     on disk: the guided master and media playlists name the title's
//     segments and init through a shared token (scope guided:<version>, no
//     country), the segments play through it (from any country), the plain
//     address and other titles' folders are refused, the playlist reads the
//     same on every request and stays cacheable; the version changes when the
//     token rotates while the earlier version still answers with its own
//     token as long as that is valid (the title's length on top of the
//     overlap); a withdrawn title's segments stop; tokens off as before.
//  2. A viewer's stitched FAST session (/fast/<id>/s/<sid>/...) puts pods into
//     the channel's breaks: a paid ad's conditioned creative and a house spot
//     are titles of their own, which were named plainly. Here their segments
//     and init carry the channel's shared token and play; the channel's own
//     segments are untouched; a withdrawn ad is left out and stops.
//    DATABASE_URL=... npx tsx test/edge-shared-playlists.check.ts
// ============================================================================
import { createServer as httpServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORK = mkdtempSync(join(tmpdir(), 'volt-esp-'));
const CLIPS = join(WORK, 'clips');
mkdirSync(CLIPS, { recursive: true });
Object.assign(process.env, {
  CLIPS_DIR: CLIPS, ORIGIN_DIR: join(WORK, 'origin'), FAST_OUTPUT: 'local', FAST_SEGMENT_SEC: '2',
  TRUST_EDGE_GEO: 'true', VOLT_EDGE_TOKENS: 'enforce', AD_BEACONS_ALLOW_PRIVATE: '1', PUBLIC_BASE_URL: 'https://volt.example',
  EDGE_SHARED_TOKEN_PERIOD_SEC: '300', EDGE_SHARED_TOKEN_OVERLAP_SEC: '120',
});
process.env.ORCH_LAUNCHER ??= 'mock';
process.env.ORCH_TICK_SECONDS ??= '3600';
delete process.env.EDGE_SHARED_SECRET;

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('PASS ' + m); pass++; } else { console.log(`FAIL ${m} -- expected [${w}] got [${g}]`); fail++; }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const claimsOf = (t: string) => JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString('utf8'));
const hex = (id: string) => id.replace(/-/g, '').toLowerCase();

/** An fMP4 HLS asset with a subtitles rendition, every init and segment a real file whose body names it. */
function writeAsset(dir: string, totalSec: number, seg: number) {
  const segs: number[] = [];
  for (let t = 0; t < totalSec - 1e-9; t += seg) segs.push(Math.min(seg, totalSec - t));
  for (const f of ['720p', 'audio']) {
    mkdirSync(join(dir, f), { recursive: true });
    writeFileSync(join(dir, f, 'init.mp4'), `INIT ${f}`);
    segs.forEach((_d, i) => writeFileSync(join(dir, f, `seg_${i + 1}.m4s`), `SEG ${f} ${i + 1}`));
  }
  const media = (f: string) => ['#EXTM3U', '#EXT-X-VERSION:6', `#EXT-X-TARGETDURATION:${seg}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-MAP:URI="${f}/init.mp4"`, ...segs.flatMap((d, i) => [`#EXTINF:${d.toFixed(3)},`, `${f}/seg_${i + 1}.m4s`]), '#EXT-X-ENDLIST', ''].join('\n');
  writeFileSync(join(dir, 'stream_0.m3u8'), media('720p'));
  writeFileSync(join(dir, 'stream_2.m3u8'), media('audio'));
  writeFileSync(join(dir, 'subs_en.m3u8'), ['#EXTM3U', '#EXT-X-TARGETDURATION:120', '#EXTINF:120.000,', 'subs_en.vtt', '#EXT-X-ENDLIST', ''].join('\n'));
  writeFileSync(join(dir, 'subs_en.vtt'), 'WEBVTT\n');
  writeFileSync(join(dir, 'master.m3u8'), ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="stream_2.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="subs_en.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="audio",SUBTITLES="subs"', 'stream_0.m3u8', ''].join('\n'));
}

(async () => {
  // ---------------------------------------------------------------- a VAST server (one 15 s ad)
  const vast = httpServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname.startsWith('/px/')) { res.writeHead(200); return res.end(); }
    const b = `http://127.0.0.1:${(vast.address() as any).port}`;
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end(`<VAST version="4.1"><Ad id="a1" sequence="1"><InLine><AdSystem>Stub</AdSystem><AdTitle>Spring sale</AdTitle>
      <Impression><![CDATA[${b}/px/imp]]></Impression><Creatives><Creative id="c1"><UniversalAdId idRegistry="ad-id.org">UAI-ESP</UniversalAdId><Linear><Duration>00:00:15</Duration>
      <MediaFiles><MediaFile delivery="progressive" type="video/mp4" width="1280" height="720"><![CDATA[${b}/ad.mp4]]></MediaFile></MediaFiles></Linear></Creative></Creatives></InLine></Ad></VAST>`);
  });
  await new Promise<void>((r) => vast.listen(0, '127.0.0.1', () => r()));
  const VBASE = `http://127.0.0.1:${(vast.address() as any).port}`;

  const T = await import('../src/services/edgeTokens');
  const VA = await import('../src/services/vodAds');
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { invalidateTag } = await import('../src/scale/cache');
  const P = await import('../src/services/publicStatus');
  const { sessionStore } = await import('../src/services/fast/sessionStore');

  // ---------------------------------------------------------------- pure: the longer overlap
  const tag = Date.now().toString(36);
  {
    const k = `/clips/vod/aaaaaaaa-0000-4000-8000-0000000000e1/master.m3u8`;
    const now = 1_800_000_100;   // 100 s into a 300 s period
    const a = await T.playlistEdgeTokens('x', [k], now);
    const b = await T.playlistEdgeTokens('x', [k], now, { overlapSec: 1000 });
    const c = await T.playlistEdgeTokens('x', [k], now, { overlapSec: 10 });
    const d = await T.playlistEdgeTokens('x', [k], now, { overlapSec: 10 ** 7 });
    const e = (x: any) => claimsOf(Object.values(x.byAsset)[0] as string).e;
    check('playlistEdgeTokens: a longer overlap when asked, never shorter than the default, never past a day',
      [e(a) - 1_800_000_000, e(b) - 1_800_000_000, e(c) - 1_800_000_000, e(d) - 1_800_000_000, b.overlapSec], [300 + 120, 300 + 1000, 300 + 120, 300 + 86400, 1000]);
  }

  // ---------------------------------------------------------------- the API
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`esp-${tag}`]))!.id;
  const owner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `esp-${tag}@volt.test`]))!.id;
  const tok = signAccess({ sub: owner, account_id: acct, role: 'owner' } as any);
  const mkAsset = async (title: string, sec: number, publish = true) => {
    const id = (await one<any>(
      `INSERT INTO vod_assets(account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, formats, thumb_status)
       VALUES ($1,'upload','clip',$2,0,$3,$3,'{"hls":true}'::jsonb,'ready') RETURNING id`, [acct, title, sec * 1000]))!.id;
    writeAsset(join(CLIPS, 'vod', id), sec, 4);
    await query(`UPDATE vod_assets SET master_key = $2, media_state = 'ready' WHERE id = $1`, [id, `/clips/vod/${id}/master.m3u8`]);
    if (publish) {
      await query(`UPDATE vod_assets SET availability_state = 'available', published = true,
                     availability = '{"targets":[{"kind":"portal"}],"access":"free"}'::jsonb, available_from = now() - interval '1 day' WHERE id = $1`, [id]);
      await P.refreshPublicStatus(id);
    }
    invalidateTag(`asset:${id}`);
    return String(id);
  };
  const film = await mkAsset('Guided film', 120);
  const film2 = await mkAsset('Other film', 120);
  const adAsset = await mkAsset('Spring sale (conditioned)', 16);
  const house = await mkAsset('House promo', 8);
  await query(`INSERT INTO ad_creatives(account_id, creative_key, vod_asset_id, status, duration_ms) VALUES ($1,'ad-id.org:UAI-ESP',$2,'ready',15000)`, [acct, adAsset]);
  const server = (await one<any>(`INSERT INTO ad_servers(account_id, name, tag_template, timeout_ms) VALUES ($1,'Stub',$2,1000) RETURNING id`, [acct, `${VBASE}/vast?sid=[SESSION_ID]`]))!.id;

  const srv = createServer().listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const http = async (method: string, path: string, body?: any, h: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...h }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text(); let j: any = null; try { j = JSON.parse(t); } catch { j = t; }
    return { s: r.status, j, t, loc: r.headers.get('location'), cc: r.headers.get('cache-control') };
  };
  const AU = { 'cloudfront-viewer-country': 'AU' }, JP = { 'cloudfront-viewer-country': 'JP' };
  const get = (p: string, h: Record<string, string> = AU) => http('GET', p, undefined, h);
  const auth = { authorization: `Bearer ${tok}` };
  const lines = (t: string) => t.split('\n').filter((l) => l && !l.startsWith('#'));
  const maps = (t: string) => [...t.matchAll(/#EXT-X-MAP:URI="([^"]+)"/g)].map((m) => m[1]);
  try {
    // ================================================================ 1. guided
    const r = await http('PUT', '/api/vod/ads/rules/default', { mode: 'on', policy: { postroll: { on: true, sec: 8, minContentSec: 0 } }, adServerId: server, houseAds: [{ assetId: house }] }, auth);
    check('ads on for the account: a pre-roll from the ad server, a post-roll of the house promo', r.s, 200);
    const pk = (await http('POST', '/api/apps', { name: 'Web', type: 'web' }, auth)).j.publishableKey.key;
    const gate = (assetId: string, extra: any = {}) => http('POST', '/api/availability', { appKey: pk, assetId, geo: 'AU', sid: 'sid-esp-0001', adDelivery: 'guided', caps: ['hls-interstitials'], ...extra });

    const g = await gate(film);
    const hls: string = g.j.delivery?.hls ?? '';
    const ver = (hls.match(/^\/vod-ads\/g\/[^/]+\/([^/]+)\/master\.m3u8$/) ?? [])[1];
    check('enforce: the gate hands out the guided playlist', [g.s, g.j.ads?.delivery, !!ver], [200, 'guided', true]);
    const m = await get(hls);
    check('guided master: every rendition (video, audio, subtitles) through the guided route, no plain title address',
      [m.s, lines(m.t).every((l) => l.startsWith(`/vod-ads/g/${film}/${ver}/`)), m.t.includes(`URI="/vod-ads/g/${film}/${ver}/subs.m3u8"`), /(^|")\/clips\/vod\//m.test(m.t)], [200, true, true, false]);
    const v = await get(hls.replace('master.m3u8', 'v720.m3u8'));
    const vl = lines(v.t);
    const content = vl.filter((l) => l.includes(`/clips/vod/${film}/`));
    check('guided media: every content segment carries a token in front of the title\'s folder',
      [v.s, content.length, content.every((l) => new RegExp(`^/t/[^/]+/clips/vod/${film}/720p/seg_\\d+\\.m4s$`).test(l))], [200, 30, true]);
    const mp = maps(v.t);
    check('guided media: the init too, and the interstitials\' asset lists stay on the guided route',
      [mp.length >= 1 && mp.every((u) => new RegExp(`^/t/[^/]+/clips/vod/${film}/720p/init\\.mp4$`).test(u)), /X-ASSET-LIST="\/vod-ads\/g\/[^"]+\/list\/\d+\.json"/.test(v.t)], [true, true]);
    check('guided media: no plain title address left', v.t.split('\n').some((l) => /(^|")\/clips\/vod\//.test(l)), false);
    const token = content[0].split('/')[2];
    const c = claimsOf(token);
    const nowS = Math.floor(Date.now() / 1000);
    check('the token is the shared kind: this title only, scope guided:<version>, no country, alive for a period plus the overlap plus the title\'s length',
      [c.k, c.A, String(c.g).startsWith('guided:'), 'c' in c, c.n <= nowS, c.e - Math.floor(nowS / 300) * 300], ['shared', [hex(film)], true, false, true, 300 + 120 + 120]);
    const subs = await get(hls.replace('master.m3u8', 'subs.m3u8'));
    check('every content address carries the same token, the subtitles\' too', [content.every((l) => l.split('/')[2] === token), lines(subs.t), (await get(lines(subs.t)[0] ?? '/x')).t],
      [true, [`/t/${token}/clips/vod/${film}/subs_en.vtt`], 'WEBVTT\n']);
    const again = await get(hls.replace('master.m3u8', 'v720.m3u8'));
    check('the playlist reads the same on every request and stays cacheable at the CDN', [again.t === v.t, again.cc], [true, 'public, max-age=300']);
    check('a content segment plays through it, the init too', [(await get(content[0])).t, (await get(mp[0])).t], ['SEG 720p 1', 'INIT 720p']);
    check('...from any country (country rules stay at the gate, which hands this playlist out)', (await get(content[1], JP)).t, 'SEG 720p 2');
    check('...by plain address it is refused', (await get(content[0].replace(/^\/t\/[^/]+/, ''))).s, 403);
    check('...and it does not open another title\'s folder', (await get(content[0].replace(film, film2))).s, 403);
    const al = await http('GET', `${(v.t.match(/X-ASSET-LIST="([^"]+)"/) ?? [])[1]}?_HLS_primary_id=prim-esp-1`, undefined, AU);
    const adm = al.j?.ASSETS?.[0]?.URI ? await get(al.j.ASSETS[0].URI.replace('master.m3u8', 'v720.m3u8')) : null;
    const gseg = adm ? await get(lines(adm.t)[0]) : null;
    check('the pre-roll\'s asset list and its ad still play through the viewer\'s own tokens (P2-2e)',
      [al.s, gseg?.s, gseg?.loc ? (await get(gseg.loc)).t : null], [200, 302, 'SEG 720p 1']);

    // ---- rotation: the version changes, the earlier one still answers with its own token while valid
    const asset = await VA.assetFor(film);
    const rule = await VA.ruleForAsset(asset!.account_id, asset!.schema_id);
    const cur = await VA.guidedVersions(asset!, rule!);
    check('now: the current version is the one the gate handed out, with that token', [cur[0].ver, cur[0].edge?.token], [ver, token]);
    const next = Math.floor(nowS / 300) * 300 + 300 + 5;
    const after = await VA.guidedVersions(asset!, rule!, { nowSec: next });
    check('after a rotation: a new version with a new token, and the earlier version still listed with the token it gave',
      [after.length, after[0].ver !== ver, after[0].edge?.token !== token, after[1]?.ver, after[1]?.edge?.token], [2, true, true, ver, token]);
    check('the new token is the next period\'s', claimsOf(after[0].edge!.token).n, Math.floor(nowS / 300) * 300 + 300);
    const late = await VA.guidedVersions(asset!, rule!, { nowSec: c.e + 1 });
    check('once the earlier token has expired, its version is gone (the gate is asked again)', late.some((x) => x.ver === ver), false);
    const want = await VA.guidedVersions(asset!, rule!, { nowSec: next, want: ver });
    check('the route\'s lookup stops at the version asked for', want.map((x) => x.ver).includes(ver), true);
    check('a version that never was answers 404 (ask the gate again)', (await get(hls.replace(ver, 'zzzzzzzzzz'))).s, 404);

    // ---- issue and off
    process.env.VOLT_EDGE_TOKENS = 'off';
    const go = await gate(film2, { sid: 'sid-esp-off' });
    const vo = await get(go.j.delivery.hls.replace('master.m3u8', 'v720.m3u8'));
    check('off: plain addresses as before', [vo.s, lines(vo.t).some((l) => l.startsWith('/t/')), lines(vo.t).filter((l) => l.startsWith(`/clips/vod/${film2}/`)).length], [200, false, 30]);
    const offVer = (go.j.delivery.hls.match(/\/g\/[^/]+\/([^/]+)\//) ?? [])[1];
    process.env.VOLT_EDGE_TOKENS = 'issue';
    const gi = await gate(film2, { sid: 'sid-esp-issue' });
    const vi = await get(gi.j.delivery.hls.replace('master.m3u8', 'v720.m3u8'));
    const ci = lines(vi.t).filter((l) => l.includes(`/clips/vod/${film2}/`));
    check('issue: tokenised the same way (a version of its own), the plain address still plays',
      [ci.every((l) => l.startsWith('/t/')), (gi.j.delivery.hls.match(/\/g\/[^/]+\/([^/]+)\//) ?? [])[1] !== offVer, (await get(ci[0].replace(/^\/t\/[^/]+/, ''))).t], [true, true, 'SEG 720p 1']);
    process.env.VOLT_EDGE_TOKENS = 'enforce';

    // ================================================================ 2. the FAST stitcher
    const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[{"height":720,"bitrate_kbps":2500}]','transcode') RETURNING id`, [acct]))!.id;
    const grp = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
    const ch = String((await one<any>(`INSERT INTO channels(group_id, name, origin, recording_enabled) VALUES ($1,'Stitched FAST','playlist',false) RETURNING id`, [grp]))!.id);
    let x = await http('POST', '/api/fast/ad-servers', { name: 'Stub', tagTemplate: `${VBASE}/vast?s=[SESSION_ID]`, timeoutMs: 1000 }, auth);
    x = await http('PUT', `/api/fast/channels/${ch}/ads`, { mode: 'stitched', adServerId: x.j.id, houseAds: [{ assetId: house }], scope: 'channel' }, auth);
    check('a FAST channel with stitched ads, decided once for the channel', [x.s, x.j.mode], [200, 'stitched']);
    // A break 8 s long that started 4 s ago, in a static window of 2 s segments.
    const BS = Math.floor(Date.now() / 1000) * 1000 - 4000, T0 = BS - 4000;
    const brk = String((await one<any>(`INSERT INTO stream_breaks (channel_id, source, starts_at, duration_ms, position) VALUES ($1,'fast',$2,8000,'mid') RETURNING id`, [ch, new Date(BS).toISOString()]))!.id);
    const out = join(process.env.ORIGIN_DIR!, ch, 'fast');
    mkdirSync(out, { recursive: true });
    const L = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-DISCONTINUITY-SEQUENCE:0'];
    for (let k = 0; k < 6; k++) {
      const t = T0 + k * 2000, b = t >= BS;
      if (k === 2) L.push('#EXT-X-DISCONTINUITY');
      if (k === 0 || k === 2) L.push(`#EXT-X-MAP:URI="/clips/${b ? 'house' : 'content'}/v720_init.mp4"`);
      if (t === BS) { L.push(`#EXT-X-DATERANGE:ID="brk:${brk}",CLASS="com.boomlabs.volt.ad",START-DATE="${new Date(BS).toISOString()}",PLANNED-DURATION=8.000,DURATION=8.000`); L.push('#EXT-X-CUE-OUT:DURATION=8.000'); }
      else if (b) L.push(`#EXT-X-CUE-OUT-CONT:ElapsedTime=${((t - BS) / 1000).toFixed(3)},Duration=8.000`);
      L.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(t).toISOString()}`, '#EXTINF:2.000,', `/clips/${b ? 'house' : 'content'}/v720_${k}.m4s`);
    }
    writeFileSync(join(out, 'v720.m3u8'), L.join('\n') + '\n');
    writeFileSync(join(out, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720\nv720.m3u8\n');
    await sessionStore.savePod(`channel-${ch}`, brk, { items: [
      { kind: 'ad', adId: 'a1', creativeKey: 'ad-id.org:UAI-ESP', assetId: adAsset, durationSec: 4, title: 'Spring sale' },
      { kind: 'house', assetId: house, durationSec: 4, title: 'House promo' },
    ] });
    const sv = await get(`/fast/${ch}/s/viewer-esp-0001/v720.m3u8`);
    const sl = lines(sv.t);
    const adSegs = sl.filter((l) => l.includes(`/clips/vod/${adAsset}/`)), houseSegs = sl.filter((l) => l.includes(`/clips/vod/${house}/`));
    check('stitched: the break holds the ad and the house spot', [sv.s, adSegs.length, houseSegs.length], [200, 1, 1]);
    check('stitched: their segments carry a token in front of each title\'s folder',
      [adSegs.concat(houseSegs).every((l) => /^\/t\/[^/]+\/clips\/vod\/[0-9a-f-]{36}\/720p\/seg_\d+\.m4s$/.test(l))], [true]);
    const sm = maps(sv.t).filter((u) => u.includes('/clips/vod/'));
    check('stitched: the pods\' init segments too', [sm.length, sm.every((u) => /^\/t\/[^/]+\/clips\/vod\//.test(u))], [2, true]);
    check('stitched: no plain pod address, the channel\'s own segments untouched',
      [sv.t.split('\n').some((l) => /(^|")\/clips\/vod\//.test(l)), sl.filter((l) => l.startsWith('/clips/content/')).length], [false, 2]);
    const st = claimsOf(adSegs[0].split('/')[2]);
    check('stitched: the channel\'s shared token, naming the pod\'s titles, no country',
      [st.k, st.g, [...st.A].sort(), 'c' in st], ['shared', `fast:${ch}`, [hex(adAsset), hex(house)].sort(), false]);
    check('stitched: the ad and the house spot play through it, init too',
      [(await get(adSegs[0])).t, (await get(houseSegs[0], JP)).t, (await get(sm[0])).t], ['SEG 720p 1', 'SEG 720p 1', 'INIT 720p']);
    check('stitched: their plain addresses are refused', (await get(adSegs[0].replace(/^\/t\/[^/]+/, ''))).s, 403);
    const sv2 = await get(`/fast/${ch}/s/viewer-esp-0002/v720.m3u8`);
    check('another viewer of the channel gets the same addresses for the pod (one token for everyone)', lines(sv2.t).filter((l) => l.includes('/clips/vod/')), adSegs.concat(houseSegs));

    // ================================================================ withdrawn
    await query(`UPDATE vod_assets SET availability_state = 'withdrawn' WHERE id = ANY($1::uuid[])`, [[film, adAsset]]);
    await P.refreshPublicStatus(film); await P.refreshPublicStatus(adAsset);
    const at = Math.floor(Date.now() / 1000) + 1;
    await T.revokeAsset(film, 'test: withdrawn', at);
    await T.revokeAsset(adAsset, 'test: withdrawn', at);
    invalidateTag(`asset:${film}`); invalidateTag(`asset:${adAsset}`);
    await sleep(5200);   // the revocation read is cached 5 s
    check('withdrawn: the guided content segments already in a player\'s playlist stop at the edge', [(await get(content[2])).s, (await get(content[2])).t.trim()], [403, 'No longer available']);
    check('withdrawn: the guided playlists are gone', (await get(hls.replace('master.m3u8', 'v720.m3u8'))).s, 404);
    check('withdrawn: the stitched ad\'s segment already handed out stops', (await get(adSegs[0])).s, 403);
    const sv3 = await get(`/fast/${ch}/s/viewer-esp-0003/v720.m3u8`);
    const ad3 = lines(sv3.t).filter((l) => l.includes(`/clips/vod/${adAsset}/`));
    check('withdrawn: a new playlist names the ad with no token (refused), the house spot still with one',
      [ad3.length, ad3.every((l) => l.startsWith('/clips/vod/')), lines(sv3.t).filter((l) => l.includes(`/clips/vod/${house}/`)).every((l) => l.startsWith('/t/'))], [1, true, true]);
    check('...and the house spot\'s new token does not name the withdrawn ad', claimsOf(lines(sv3.t).find((l) => l.includes(`/clips/vod/${house}/`))!.split('/')[2]).A, [hex(house)]);
  } catch (e: any) {
    console.log('FAIL unexpected error -- ' + (e?.stack ?? e)); fail++;
  } finally {
    srv.close(); vast.close();
    await pool.end().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
