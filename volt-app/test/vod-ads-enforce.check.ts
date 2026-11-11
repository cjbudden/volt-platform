// ============================================================================
//  ON-DEMAND AD SESSIONS UNDER ENFORCE (build queue P2-2e; services/vodAds
//  folderToken, tokeniseHls, tokeniseMpd, sessionEdgeOf; modules/apps.ts the
//  gate's spec; modules/vodAds.ts the withdrawn refusal).
//
//  Under VOLT_EDGE_TOKENS=enforce the edge refuses a title's plain address. A
//  stitched session's playlists name the title's segments, and each ad's (a
//  conditioned creative or a house ad is an asset under /clips/vod/ too), so
//  without tokens on-demand ads did not play under enforce. Here, on the real
//  API with media on disk: a stitched session's HLS and DASH play end to end
//  (content, init, house ad and creative segments 200 through tokens), the
//  tokens bound to the viewer's country and each to its own folder, the
//  playlists the same on every request, a withdrawn title's session refused,
//  guided sessions' ads tokenised, and issue and off as before.
//    DATABASE_URL=... npx tsx test/vod-ads-enforce.check.ts
// ============================================================================
import { createServer as httpServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLIPS = mkdtempSync(join(tmpdir(), 'volt-vaenf-'));
Object.assign(process.env, { CLIPS_DIR: CLIPS, TRUST_EDGE_GEO: 'true', VOLT_EDGE_TOKENS: 'enforce', AD_BEACONS_ALLOW_PRIVATE: '1', PUBLIC_BASE_URL: 'https://volt.example' });
delete process.env.EDGE_SHARED_SECRET;

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('PASS ' + m); pass++; } else { console.log(`FAIL ${m} -- expected [${w}] got [${g}]`); fail++; }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An fMP4 HLS asset (and its MPD), every init and segment a real file whose body names it. */
function writeAsset(dir: string, totalSec: number, seg: number, mpd: boolean) {
  const segs: number[] = [];
  for (let t = 0; t < totalSec - 1e-9; t += seg) segs.push(Math.min(seg, totalSec - t));
  for (const f of ['720p', 'audio']) {
    mkdirSync(join(dir, f), { recursive: true });
    writeFileSync(join(dir, f, 'init.mp4'), `INIT ${dir}/${f}`);
    segs.forEach((_d, i) => writeFileSync(join(dir, f, `seg_${i + 1}.m4s`), `SEG ${f} ${i + 1}`));
  }
  const media = (f: string) => ['#EXTM3U', '#EXT-X-VERSION:6', `#EXT-X-TARGETDURATION:${seg}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-MAP:URI="${f}/init.mp4"`, ...segs.flatMap((d, i) => [`#EXTINF:${d.toFixed(3)},`, `${f}/seg_${i + 1}.m4s`]), '#EXT-X-ENDLIST', ''].join('\n');
  writeFileSync(join(dir, 'stream_0.m3u8'), media('720p'));
  writeFileSync(join(dir, 'stream_2.m3u8'), media('audio'));
  writeFileSync(join(dir, 'master.m3u8'), ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="stream_2.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="audio"', 'stream_0.m3u8', ''].join('\n'));
  if (mpd) {
    const n = segs.length;
    writeFileSync(join(dir, 'manifest.mpd'), `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011" type="static" mediaPresentationDuration="PT${totalSec}S" minBufferTime="PT2S">
 <Period id="0">
  <AdaptationSet id="0" contentType="video" mimeType="video/mp4"><Representation id="v720" codecs="avc1.64001f" bandwidth="2500000" width="1280" height="720">
   <SegmentTemplate timescale="1000" initialization="720p/init.mp4" media="720p/seg_$Number$.m4s" startNumber="1"><SegmentTimeline><S t="0" d="${seg * 1000}" r="${n - 1}"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet>
  <AdaptationSet id="1" contentType="audio" mimeType="audio/mp4" lang="en"><Representation id="a" codecs="mp4a.40.2" bandwidth="128000">
   <SegmentTemplate timescale="1000" initialization="audio/init.mp4" media="audio/seg_$Number$.m4s" startNumber="1"><SegmentTimeline><S t="0" d="${seg * 1000}" r="${n - 1}"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet>
 </Period>
</MPD>`);
  }
}

(async () => {
  // ---------------------------------------------------------------- a VAST server
  const vast = httpServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname.startsWith('/px/')) { res.writeHead(200); return res.end(); }
    const b = `http://127.0.0.1:${(vast.address() as any).port}`;
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end(`<VAST version="4.1"><Ad id="a1" sequence="1"><InLine><AdSystem>Stub</AdSystem><AdTitle>Spring sale</AdTitle>
      <Impression><![CDATA[${b}/px/imp]]></Impression><Creatives><Creative id="c1"><UniversalAdId idRegistry="ad-id.org">UAI-1</UniversalAdId><Linear><Duration>00:00:15</Duration>
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

  // ---------------------------------------------------------------- pure
  const fakeRow = { vod_asset_id: 'aaaaaaaa-0000-4000-8000-000000000001', play_sid: 'ps1', ctx: { country: 'AU', edge: { c: 'AU', k: 'rights', n: 1000, e: 9000 } }, plan: { breaks: [] } };
  const ft = VA.folderToken(fakeRow, fakeRow.vod_asset_id, `/clips/vod/${fakeRow.vod_asset_id}/master.m3u8`);
  const fc = ft ? JSON.parse(Buffer.from(ft.token.split('.')[0], 'base64url').toString()) : null;
  check('the title\'s folder token carries the session\'s claims (asset, folder, country, class, sid, times)', fc && [fc.a, fc.p, fc.c, fc.k, fc.s, fc.n, fc.e], [fakeRow.vod_asset_id, `/clips/vod/${fakeRow.vod_asset_id}/`, 'AU', 'rights', 'ps1', 1000, 9000]);
  const adT = VA.folderToken(fakeRow, 'bbbbbbbb-0000-4000-8000-000000000002', 'vod/bbbbbbbb-0000-4000-8000-000000000002/master.m3u8');
  const ac = adT ? JSON.parse(Buffer.from(adT.token.split('.')[0], 'base64url').toString()) : null;
  check('an ad\'s folder (in the bucket, through the CDN) gets the same times and country, class open, no sid', ac && [ac.p, ac.c, ac.k, 's' in ac, ac.n, ac.e], ['/vod/bbbbbbbb-0000-4000-8000-000000000002/', 'AU', 'open', false, 1000, 9000]);
  check('an ad creative\'s source folder under /clips/ads/ is not guarded: no token', VA.folderToken(fakeRow, 'x', '/clips/ads/cr1/master.m3u8'), null);
  check('a guided session\'s own title (no claims) gets no token here (P2-2f)', VA.folderToken({ ...fakeRow, ctx: { country: 'AU' } }, fakeRow.vod_asset_id, `/clips/vod/${fakeRow.vod_asset_id}/master.m3u8`), null);
  check('the same claims sign the same token every time', VA.folderToken(fakeRow, fakeRow.vod_asset_id, `/clips/vod/${fakeRow.vod_asset_id}/master.m3u8`)?.token, ft?.token);
  const toks = [{ prefix: '/clips/vod/f/', token: 'TOK' }];
  check('tokeniseHls: URI lines and URI="" attributes in the folder, others untouched',
    VA.tokeniseHls(['#EXT-X-MAP:URI="/clips/vod/f/720p/init.mp4"', '#EXTINF:4,', '/clips/vod/f/720p/seg_1.m4s', '/vod-ads/s/x/seg/0/0/v720/0', '/vod-ads/blank.vtt', 'https://cdn/clips/vod/f/a.m4s'].join('\n'), toks).split('\n'),
    ['#EXT-X-MAP:URI="/t/TOK/clips/vod/f/720p/init.mp4"', '#EXTINF:4,', '/t/TOK/clips/vod/f/720p/seg_1.m4s', '/vod-ads/s/x/seg/0/0/v720/0', '/vod-ads/blank.vtt', 'https://cdn/t/TOK/clips/vod/f/a.m4s']);
  check('tokeniseMpd: BaseURL and sourceURL in the folder, relative templates untouched',
    VA.tokeniseMpd('<BaseURL>/clips/vod/f/</BaseURL><SegmentTemplate media="720p/seg_$Number$.m4s"/><Initialization sourceURL="/clips/vod/f/i.mp4"/><BaseURL>/vod-ads/blank.vtt</BaseURL>', toks),
    '<BaseURL>/t/TOK/clips/vod/f/</BaseURL><SegmentTemplate media="720p/seg_$Number$.m4s"/><Initialization sourceURL="/t/TOK/clips/vod/f/i.mp4"/><BaseURL>/vod-ads/blank.vtt</BaseURL>');
  check('an address that already has a token is left alone', VA.tokeniseHls('/t/OLD/clips/vod/f/a.m4s', toks), '/t/OLD/clips/vod/f/a.m4s');

  // ---------------------------------------------------------------- the API
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`vae-${tag}`]))!.id;
  const owner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `vae-${tag}@volt.test`]))!.id;
  const tok = signAccess({ sub: owner, account_id: acct, role: 'owner' } as any);
  const mkAsset = async (title: string, sec: number, mpd: boolean) => {
    const id = (await one<any>(
      `INSERT INTO vod_assets(account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, formats, thumb_status)
       VALUES ($1,'upload','clip',$2,0,$3,$3,$4::jsonb,'ready') RETURNING id`, [acct, title, sec * 1000, JSON.stringify({ hls: true, dash: mpd })]))!.id;
    writeAsset(join(CLIPS, 'vod', id), sec, 4, mpd);
    await query(`UPDATE vod_assets SET master_key = $2, availability_state = 'available', published = true, media_state = 'ready',
                   availability = '{"targets":[{"kind":"portal"}],"access":"free"}'::jsonb, available_from = now() - interval '1 day' WHERE id = $1`, [id, `/clips/vod/${id}/master.m3u8`]);
    await P.refreshPublicStatus(id); invalidateTag(`asset:${id}`);
    return id;
  };
  const film = await mkAsset('Short film', 120, true);
  const film2 = await mkAsset('Second film', 120, true);
  const adAsset = await mkAsset('Spring sale (conditioned)', 15, false);
  const house = await mkAsset('House promo', 10, false);
  await query(`INSERT INTO ad_creatives(account_id, creative_key, vod_asset_id, status, duration_ms) VALUES ($1,'ad-id.org:UAI-1',$2,'ready',15000)`, [acct, adAsset]);
  const server = (await one<any>(`INSERT INTO ad_servers(account_id, name, tag_template, timeout_ms) VALUES ($1,'Stub',$2,1000) RETURNING id`, [acct, `${VBASE}/vast?sid=[SESSION_ID]`]))!.id;

  const srv = createServer().listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const http = async (method: string, path: string, body?: any, h: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...h }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text(); let j: any = null; try { j = JSON.parse(t); } catch { j = t; }
    return { s: r.status, j, t, loc: r.headers.get('location') };
  };
  const AU = { 'cloudfront-viewer-country': 'AU' }, JP = { 'cloudfront-viewer-country': 'JP' };
  const get = (p: string, h: Record<string, string> = AU) => http('GET', p, undefined, h);
  const lines = (t: string) => t.split('\n').filter((l) => l && !l.startsWith('#'));
  const maps = (t: string) => [...t.matchAll(/#EXT-X-MAP:URI="([^"]+)"/g)].map((m) => m[1]);
  try {
    const r = await http('PUT', '/api/vod/ads/rules/default', { mode: 'on', policy: { postroll: { on: true, sec: 10, minContentSec: 0 } }, adServerId: server, houseAds: [{ assetId: house }] }, { authorization: `Bearer ${tok}` });
    check('ads on for the account: a pre-roll from the ad server, a post-roll of the house promo', r.s, 200);
    const pk = (await http('POST', '/api/apps', { name: 'Web', type: 'web' }, { authorization: `Bearer ${tok}` })).j.publishableKey.key;
    const gate = (assetId: string, extra: any = {}) => http('POST', '/api/availability', { appKey: pk, assetId, geo: 'AU', sid: 'sid-vaenf-0001', ...extra });

    // ---- the gate opens a stitched session that carries the viewer's claims
    const g = await gate(film, { adDelivery: 'stitched' });
    const sid = g.j.ads?.sessionId;
    check('enforce: the gate opens a stitched session with HLS and DASH through it', [g.s, g.j.ads?.delivery, g.j.delivery?.hls, g.j.delivery?.dash], [200, 'stitched', `/vod-ads/s/${sid}/master.m3u8`, `/vod-ads/s/${sid}/manifest.mpd`]);
    const row = await one<any>(`SELECT * FROM vod_ad_sessions WHERE id = $1`, [sid]);
    const ed = row?.ctx?.edge;
    const nowS = Math.floor(Date.now() / 1000);
    check('the session keeps the token\'s claims: the viewer\'s country, open class, issued now, the open lifetime', ed && [ed.c, ed.k, Math.abs(ed.n - nowS) < 30, ed.e - ed.n], ['AU', 'open', true, T.tokenLifetimeSec('open')]);

    // ---- HLS
    const m = await get(g.j.delivery.hls);
    check('the session master plays and names no plain title address', [m.s, /\/clips\/vod\//.test(m.t.replace(/\/t\/[^/]+\/clips\/vod\//g, ''))], [200, false]);
    const v = await get(`/vod-ads/s/${sid}/v720.m3u8`);
    const vl = lines(v.t);
    const content = vl.filter((l) => l.includes(`/clips/vod/${film}/`));
    check('HLS: every content segment carries a token in front of the title\'s folder', [v.s, content.length, content.every((l) => new RegExp(`^/t/[^/]+/clips/vod/${film}/720p/seg_\\d+\\.m4s$`).test(l))], [200, 30, true]);
    const mp = maps(v.t);
    check('HLS: the init segments too, the title\'s and each ad\'s, each with its own folder\'s token',
      [mp.every((u) => /^\/t\/[^/]+\/clips\/vod\//.test(u)), [film, adAsset, house].map((id) => mp.some((u) => u.includes(`/clips/vod/${id}/720p/init.mp4`)))], [true, [true, true, true]]);
    check('HLS: no plain title, ad or house ad address left in the playlist', v.t.split('\n').some((l) => /(^|")\/clips\/vod\//.test(l)), false);
    check('HLS: ad segments still go through the session\'s segment route (the beacons)', vl.filter((l) => l.startsWith(`/vod-ads/s/${sid}/seg/`)).length, 4 + 3);
    check('the playlist reads the same on every request (one cached copy per session)', (await get(`/vod-ads/s/${sid}/v720.m3u8`)).t, v.t);
    const seg1 = content[0];
    check('a content segment plays through its token, init too', [(await get(seg1)).t, (await get(mp.find((u) => u.includes(film))!)).t.startsWith('INIT ')], ['SEG 720p 1', true]);
    check('...from another country it is refused (the token is bound to the viewer\'s)', (await get(seg1, JP)).s, 403);
    check('...by plain address it is refused, as before', (await get(seg1.replace(/^\/t\/[^/]+/, ''))).s, 403);
    check('...and the title\'s token does not open another title\'s folder', (await get(seg1.replace(film, film2))).s, 403);
    const a = await get(`/vod-ads/s/${sid}/seg/0/0/v720/0`);
    check('the creative\'s segment redirects to its own folder with a token, and plays', [a.s, new RegExp(`^/t/[^/]+/clips/vod/${adAsset}/720p/seg_1\\.m4s$`).test(a.loc ?? ''), (await get(a.loc!)).t], [302, true, 'SEG 720p 1']);
    const hb = (await get(`/vod-ads/s/${sid}/timeline.json`)).j.breaks.find((b: any) => b.position === 'post');
    const h = await get(`/vod-ads/s/${sid}/seg/${hb.index}/0/audio/2`);
    check('the house promo\'s segment (post-roll, audio) the same', [h.s, new RegExp(`^/t/[^/]+/clips/vod/${house}/audio/seg_3\\.m4s$`).test(h.loc ?? ''), (await get(h.loc!)).t], [302, true, 'SEG audio 3']);
    check('the ad\'s token opens only the ad\'s folder', (await get(a.loc!.replace(adAsset, film))).s, 403);
    const ai = mp.find((u) => u.includes(adAsset))!;
    check('the creative\'s init segment plays from the playlist', (await get(ai)).t.startsWith('INIT '), true);

    // ---- DASH
    const d = await get(g.j.delivery.dash);
    const bases = [...d.t.matchAll(/<BaseURL>([^<]+)<\/BaseURL>/g)].map((x) => x[1]);
    const srcs = [...d.t.matchAll(/(sourceURL|media)="([^"]+)"/g)].map((x) => x[2]).filter((u) => u.startsWith('/'));
    check('DASH: the content Periods\' BaseURL is the title\'s folder with the token', [d.s, bases.length >= 1, bases.filter((b) => b.includes('/clips/vod/')).every((b) => new RegExp(`^/t/[^/]+/clips/vod/${film}/$`).test(b))], [200, true, true]);
    check('DASH: the ads\' init segments carry their folders\' tokens, their segments go through the route',
      [srcs.filter((u) => u.includes('/clips/vod/')).every((u) => /^\/t\/[^/]+\/clips\/vod\//.test(u)), srcs.some((u) => u.includes(`/clips/vod/${adAsset}/`)), srcs.some((u) => u.includes(`/clips/vod/${house}/`)), srcs.some((u) => u.startsWith(`/vod-ads/s/${sid}/seg/`))],
      [true, true, true, true]);
    check('DASH: no plain title address', /(>|")\/clips\/vod\//.test(d.t), false);
    const cb = bases.find((b) => b.includes(film))!;
    check('DASH: a content segment and init resolved against that BaseURL play', [(await get(cb + '720p/seg_5.m4s')).t, (await get(cb + 'audio/init.mp4')).t.startsWith('INIT ')], ['SEG 720p 5', true]);
    check('DASH: the ad\'s init plays', (await get(srcs.find((u) => u.includes(`/clips/vod/${adAsset}/`) && u.endsWith('init.mp4'))!)).t.startsWith('INIT '), true);

    // ---- guided: the ads tokenised the same way
    const gg = await gate(film2, { adDelivery: 'guided', caps: ['hls-interstitials'], sid: 'sid-vaenf-guided' });
    const gpl = await get(gg.j.delivery.hls.replace('master.m3u8', 'v720.m3u8'));
    const list = (gpl.t.match(/X-ASSET-LIST="([^"]+)"/) ?? [])[1];
    const al = list ? await http('GET', `${list}?_HLS_primary_id=prim-1`, undefined, AU) : null;
    const adm = al?.j?.ASSETS?.[0]?.URI ? await get(al.j.ASSETS[0].URI.replace('master.m3u8', 'v720.m3u8')) : null;
    const gmap = adm ? maps(adm.t) : [];
    const gseg = adm ? await get(lines(adm.t)[0]) : null;
    check('guided: the ad\'s own playlist names its init with a token and its segments through the route, which redirects with one',
      [gg.j.ads?.delivery, gmap.length === 1 && /^\/t\/[^/]+\/clips\/vod\//.test(gmap[0]), gseg?.s, /^\/t\/[^/]+\/clips\/vod\//.test(gseg?.loc ?? '')], ['guided', true, 302, true]);
    check('guided: the ad plays through it', gseg?.loc ? (await get(gseg.loc)).t : null, 'SEG 720p 1');

    // ---- withdrawn: the session stops
    await query(`UPDATE vod_assets SET availability_state = 'withdrawn' WHERE id = $1`, [film]);
    await P.refreshPublicStatus(film);
    await T.revokeAsset(film, 'test: withdrawn', Math.floor(Date.now() / 1000) + 1);
    invalidateTag(`asset:${film}`);
    await sleep(5200);   // the revocation read is cached 5 s
    check('withdrawn: the session\'s playlists, segment route and timeline are refused, with the edge\'s words',
      [(await get(`/vod-ads/s/${sid}/master.m3u8`)).s, (await get(`/vod-ads/s/${sid}/v720.m3u8`)).s, (await get(`/vod-ads/s/${sid}/manifest.mpd`)).s, (await get(`/vod-ads/s/${sid}/seg/0/0/v720/1`)).s, (await get(`/vod-ads/s/${sid}/timeline.json`)).j?.error ?? (await get(`/vod-ads/s/${sid}/timeline.json`)).j],
      [403, 403, 403, 403, 'No longer available']);
    check('withdrawn: the content segments already in the player\'s playlist stop at the edge', (await get(seg1)).s, 403);
    check('withdrawn: the gate no longer plays it', (await gate(film)).s === 200, false);

    // ---- issue and off
    process.env.VOLT_EDGE_TOKENS = 'issue';
    const gi = await gate(film2, { adDelivery: 'stitched', sid: 'sid-vaenf-issue' });
    const vi = await get(`/vod-ads/s/${gi.j.ads.sessionId}/v720.m3u8`);
    const ci = lines(vi.t).filter((l) => l.includes(`/clips/vod/${film2}/`));
    check('issue: the session is tokenised the same way, and the plain address still plays', [ci.length, ci.every((l) => l.startsWith('/t/')), (await get(ci[0])).t, (await get(ci[0].replace(/^\/t\/[^/]+/, ''))).t], [30, true, 'SEG 720p 1', 'SEG 720p 1']);
    process.env.VOLT_EDGE_TOKENS = 'off';
    const go = await gate(film2, { adDelivery: 'stitched', sid: 'sid-vaenf-off' });
    const ro = await one<any>(`SELECT ctx FROM vod_ad_sessions WHERE id = $1`, [go.j.ads.sessionId]);
    const vo = await get(`/vod-ads/s/${go.j.ads.sessionId}/v720.m3u8`);
    const ao = await get(`/vod-ads/s/${go.j.ads.sessionId}/seg/0/0/v720/0`);
    check('off: no claims kept, plain addresses and redirects as before', ['edge' in (ro?.ctx ?? {}), lines(vo.t).some((l) => l.startsWith('/t/')), maps(vo.t).some((u) => u.startsWith('/t/')), ao.loc], [false, false, false, `/clips/vod/${adAsset}/720p/seg_1.m4s`]);
    process.env.VOLT_EDGE_TOKENS = 'enforce';
  } catch (e: any) {
    console.log('FAIL unexpected error -- ' + (e?.stack ?? e)); fail++;
  } finally {
    srv.close(); vast.close();
    await pool.end().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
