// ============================================================================
//  ON-DEMAND ADS (VOD SSAI and SGAI), end to end on the real API.
//
//  Pure first: where breaks go (pre, mid on segment boundaries or cue points,
//  post, the title's opt-out), the two clocks and snapback, the stitched and
//  guided playlists, VAST click trackers through a wrapper. Then, against a
//  local VAST server and hand-written HLS on disk: the play gate opening a
//  stitched session, the session's playlists (ads where the plan says, a
//  discontinuity each side, subtitles kept in step), server-side beacons
//  driven by ad segment requests, player events, a click (trackers sent, on
//  to the advertiser), the guided interstitial playlist and its asset list,
//  ad-free viewers, the title's opt-out, a content type's own rule, an ad
//  server that times out (house ads), the report, the console API and its
//  permissions, and a FAST click and ads.json.
//
//  Usage: DATABASE_URL=... npx tsx test/vod-ads.check.ts
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- media on disk

function writeAsset(dir: string, totalSec: number, seg: number, withExtras: boolean) {
  mkdirSync(dir, { recursive: true });
  const segs: number[] = [];
  for (let t = 0; t < totalSec - 1e-9; t += seg) segs.push(Math.min(seg, totalSec - t));
  const media = (folder: string) => ['#EXTM3U', '#EXT-X-VERSION:6', `#EXT-X-TARGETDURATION:${seg}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-MAP:URI="${folder}/init.mp4"`, ...segs.flatMap((d, i) => [`#EXTINF:${d.toFixed(3)},`, `${folder}/seg_${i + 1}.m4s`]), '#EXT-X-ENDLIST', ''].join('\n');
  writeFileSync(join(dir, 'stream_0.m3u8'), media('360p'));
  writeFileSync(join(dir, 'stream_1.m3u8'), media('720p'));
  writeFileSync(join(dir, 'stream_2.m3u8'), media('audio'));
  const lines = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="stream_2.m3u8"'];
  if (withExtras) {
    mkdirSync(join(dir, 'subs'), { recursive: true });
    writeFileSync(join(dir, 'subs', 'en.m3u8'), ['#EXTM3U', `#EXT-X-TARGETDURATION:${seg}`, '#EXT-X-PLAYLIST-TYPE:VOD', ...segs.flatMap((d, i) => [`#EXTINF:${d.toFixed(3)},`, `en_${i}.vtt`]), '#EXT-X-ENDLIST', ''].join('\n'));
    lines.push('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="subs/en.m3u8"');
  }
  lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="audio"${withExtras ? ',SUBTITLES="subs"' : ''}`, 'stream_0.m3u8',
    `#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,AUDIO="audio"${withExtras ? ',SUBTITLES="subs"' : ''}`, 'stream_1.m3u8');
  if (withExtras) lines.push('#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,RESOLUTION=640x360,URI="iframe.m3u8"');
  writeFileSync(join(dir, 'master.m3u8'), lines.join('\n') + '\n');
  return segs;
}

(async () => {
  // ---------------------------------------------------------------- a VAST server
  const hits: { path: string; ip: string | null; ua: string | null }[] = [];
  let slow = false;
  const vast = httpServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname.startsWith('/px/')) { hits.push({ path: u.pathname, ip: (req.headers['x-device-ip'] as string) ?? null, ua: (req.headers['x-device-user-agent'] as string) ?? null }); res.writeHead(200); return res.end(); }
    if (u.pathname === '/vast' && slow) await sleep(2500);
    const base = `http://127.0.0.1:${(vast.address() as any).port}`;
    if (u.pathname === '/wrap') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end(`<VAST version="4.1"><Ad id="w1" sequence="1"><Wrapper><AdSystem>Wrap</AdSystem><VASTAdTagURI><![CDATA[${base}/vast]]></VASTAdTagURI>
        <Impression><![CDATA[${base}/px/wimp]]></Impression><Creatives><Creative><Linear><VideoClicks><ClickTracking><![CDATA[${base}/px/wclick]]></ClickTracking></VideoClicks></Linear></Creative></Creatives></Wrapper></Ad></VAST>`);
    }
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end(`<VAST version="4.1"><Ad id="a1" sequence="1"><InLine><AdSystem>Stub</AdSystem><AdTitle>Spring sale</AdTitle><Advertiser>Shop</Advertiser>
      <Impression><![CDATA[${base}/px/imp]]></Impression><Creatives><Creative id="c1"><UniversalAdId idRegistry="ad-id.org">UAI-1</UniversalAdId><Linear><Duration>00:00:15</Duration>
      <TrackingEvents>${['start', 'firstQuartile', 'midpoint', 'thirdQuartile', 'complete', 'pause', 'mute'].map((e) => `<Tracking event="${e}"><![CDATA[${base}/px/${e}]]></Tracking>`).join('')}</TrackingEvents>
      <VideoClicks><ClickThrough><![CDATA[https://advertiser.example/landing]]></ClickThrough><ClickTracking><![CDATA[${base}/px/click]]></ClickTracking></VideoClicks>
      <MediaFiles><MediaFile delivery="progressive" type="video/mp4" width="1280" height="720"><![CDATA[${base}/ad.mp4]]></MediaFile></MediaFiles></Linear></Creative></Creatives></InLine></Ad></VAST>`);
  });
  await new Promise<void>((r) => vast.listen(0, '127.0.0.1', () => r()));
  const VBASE = `http://127.0.0.1:${(vast.address() as any).port}`;

  const work = mkdtempSync(join(tmpdir(), 'vod-ads-'));
  Object.assign(process.env, { CLIPS_DIR: join(work, 'clips'), AD_BEACONS_ALLOW_PRIVATE: '1', PUBLIC_BASE_URL: 'https://volt.example' });

  const P = await import('../src/services/vodAds/plan');
  const H = await import('../src/services/vodAds/hls');
  const { parseVast } = await import('../src/services/fast/vast');

  console.log('== where the breaks go ==');
  const pol = P.resolveVodAdPolicy({});
  const bounds = Array.from({ length: 450 }, (_, i) => i * 4);
  let br = P.planVodBreaks(1800, pol, { boundaries: bounds });
  check('30 minutes, defaults: a pre-roll and mid-rolls every 10 minutes after the first 8, none in the last 3', br.map((b) => [b.position, b.atSec]), [['pre', 0], ['mid', 600], ['mid', 1200]]);
  br = P.planVodBreaks(1800, P.resolveVodAdPolicy({ midroll: { everyMin: 7 } }), { boundaries: bounds });
  check('every 7 minutes: the first after 8 minutes, then every 7', br.filter((b) => b.position === 'mid').map((b) => b.atSec), [480, 900, 1320]);
  br = P.planVodBreaks(1801, P.resolveVodAdPolicy({ midroll: { everyMin: 9.55 } }), { boundaries: bounds });
  check('a moment between segment starts moves to the nearest one (573 to 572)', br.filter((b) => b.position === 'mid')[0]?.atSec, 572);
  br = P.planVodBreaks(1800, pol, { boundaries: bounds, cuesSec: [300, 610, 640, 1790] });
  check('cue points win: the opening minutes, a cue too close to the last, and the end guard are left out', br.filter((b) => b.position === 'mid').map((b) => [b.atSec, b.source]), [[608, 'cue']]);
  check('a 40 second clip gets no pre-roll (under a minute)', P.planVodBreaks(40, pol).length, 0);
  check('a title marked adRule none gets nothing', P.planVodBreaks(1800, pol, { titleRule: 'none' }).length, 0);
  check('no_mid keeps the pre-roll only', P.planVodBreaks(1800, pol, { titleRule: 'no_mid' }).map((b) => b.position), ['pre']);
  check('a post-roll when the rule has one', P.planVodBreaks(1800, P.resolveVodAdPolicy({ postroll: { on: true } })).map((b) => b.position).slice(-1), ['post']);
  const clamp = P.resolveVodAdPolicy({ preroll: { sec: 9999 }, midroll: { everyMin: 0 }, adFreeFor: ['entitlement', 'bogus'], delivery: 'nonsense' });
  check('a stored policy is clamped to sane values', [clamp.preroll.sec, clamp.midroll.everyMin, clamp.adFreeFor, clamp.delivery], [300, 2, ['entitlement'], 'auto']);

  console.log('\n== the two clocks and snapback ==');
  const clock = [{ index: 0, atSec: 0, durationSec: 15 }, { index: 1, atSec: 600, durationSec: 30 }, { index: 2, atSec: 1200, durationSec: 30 }];
  check('stitched starts of each break', P.stitchedStarts(clock), [0, 615, 1245]);
  check('stitched 700 s is content 655 s', P.toContent(700, clock), { contentSec: 655, inBreak: null });
  check('stitched 620 s is inside the second break, at content 600 s', P.toContent(620, clock), { contentSec: 600, inBreak: 1 });
  check('resume at content 900 s lands at stitched 945 s (after both breaks before it)', P.toStitched(900, clock), 945);
  check('content 600 s at its break start, or after it', [P.toStitched(600, clock, false), P.toStitched(600, clock, true)], [615, 645]);
  check('a seek from 100 s to 1500 s plays the last skipped mid-roll first', P.snapbackFor(100, 1500, clock.map((c, i) => ({ ...c, position: i ? 'mid' as const : 'pre' as const })), new Set())?.index, 2);
  check('...unless it was watched, then the one before', P.snapbackFor(100, 1500, clock.map((c, i) => ({ ...c, position: i ? 'mid' as const : 'pre' as const })), new Set([2]))?.index, 1);
  check('a seek backwards replays nothing', P.snapbackFor(1500, 100, clock, new Set()), null);

  console.log('\n== playlists ==');
  const masterText = ['#EXTM3U', '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="A",URI="stream_2.m3u8"', '#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360,AUDIO="a"', 'stream_0.m3u8',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="i.m3u8"'].join('\n');
  const ents = H.masterEntries(masterText, '/clips/vod/x/master.m3u8');
  check('master entries with absolute URLs and track names', ents.map((e) => [e.kind, e.track, e.url]), [['audio', 'audio', '/clips/vod/x/stream_2.m3u8'], ['video', 'v360', '/clips/vod/x/stream_0.m3u8']]);
  const rw = H.rewriteMaster(masterText, '/clips/vod/x/master.m3u8', (e) => `/s/${e.track}.m3u8`);
  truthy('rewritten master points at the session and drops the I-frame playlist', rw.includes('URI="/s/audio.m3u8"') && rw.includes('\n/s/v360.m3u8') && !rw.includes('I-FRAME'));
  const cmed = H.parseMedia(['#EXTM3U', '#EXT-X-MAP:URI="i.mp4"', '#EXTINF:4,', 'a.m4s', '#EXTINF:4,', 'b.m4s', '#EXTINF:4,', 'c.m4s', '#EXT-X-ENDLIST'].join('\n'), 'https://cdn.example/vod/x/v.m3u8')!;
  check('media segments resolved against the playlist', cmed.segments.map((s) => s.url), ['https://cdn.example/vod/x/a.m4s', 'https://cdn.example/vod/x/b.m4s', 'https://cdn.example/vod/x/c.m4s']);
  const st = H.stitchMedia(cmed, [{ index: 0, atSec: 0, segments: [{ dur: 5, url: '/ad/0', init: '/ad/i.mp4', tags: [] }] }, { index: 1, atSec: 4, segments: [{ dur: 5, url: '/ad/1', init: '/ad/i.mp4', tags: [] }] }]);
  const order = st.split('\n').filter((l) => l && (!l.startsWith('#') || l === '#EXT-X-DISCONTINUITY'));
  check('stitched: pre-roll, content, discontinuity, mid-roll, discontinuity, content, end', order,
    ['/ad/0', '#EXT-X-DISCONTINUITY', 'https://cdn.example/vod/x/a.m4s', '#EXT-X-DISCONTINUITY', '/ad/1', '#EXT-X-DISCONTINUITY', 'https://cdn.example/vod/x/b.m4s', 'https://cdn.example/vod/x/c.m4s']);
  truthy('stitched: VOD, ENDLIST, target duration covers the ads, init re-sent after each discontinuity',
    st.includes('#EXT-X-PLAYLIST-TYPE:VOD') && st.trim().endsWith('#EXT-X-ENDLIST') && st.includes('#EXT-X-TARGETDURATION:5') && st.split('#EXT-X-MAP:URI="https://cdn.example/vod/x/i.mp4"').length === 3);
  const gd = H.guidedMedia(cmed, [{ index: 0, atSec: 0, durationSec: 15, position: 'pre' }, { index: 1, atSec: 8, durationSec: 30, position: 'mid' }], (b) => `/list/${b.index}.json`);
  truthy('guided: interstitial DATERANGEs with asset lists, PRE cue, restrictions, a program date time',
    gd.includes('CLASS="com.apple.hls.interstitial"') && gd.includes('X-ASSET-LIST="/list/1.json"') && gd.includes('CUE="PRE"') && !gd.includes('X-CUE') && gd.includes('X-RESTRICT="SKIP,JUMP"')
    && gd.includes('START-DATE="2000-01-01T00:00:08.000Z"') && gd.includes('#EXT-X-PROGRAM-DATE-TIME:2000-01-01T00:00:00.000Z'));

  console.log('\n== VAST click trackers ==');
  const doc = parseVast(`<VAST version="4.0"><Ad id="x"><InLine><Creatives><Creative><Linear><Duration>00:00:10</Duration><VideoClicks><ClickThrough>https://a.example/</ClickThrough><ClickTracking>https://t.example/1</ClickTracking><ClickTracking>https://t.example/2</ClickTracking></VideoClicks></Linear></Creative></Creatives></InLine></Ad></VAST>`);
  check('click-through and every click tracker read', [doc.ads[0].clickThrough, doc.ads[0].clickTracking], ['https://a.example/', ['https://t.example/1', 'https://t.example/2']]);

  // ---------------------------------------------------------------- the real thing
  const { query, one, pool } = await import('../src/db');
  const { createServer } = await import('../src/server');
  const { signAccess } = await import('../src/auth/jwt');
  const { generateKey } = await import('../src/services/apiKeys');
  const VA = await import('../src/services/vodAds');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`va-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`va-o-${tag}`]))!.id;
  const owner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `va-${tag}@volt.test`]))!.id;
  const viewerUser = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','viewer','active') RETURNING id`, [acct, `vav-${tag}@volt.test`]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
  const g = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name, status) VALUES ($1,'VA Ch','ended') RETURNING id`, [g]))!.id;
  const series = (await one<any>(`INSERT INTO metadata_schemas(account_id, name) VALUES ($1,'Kids series') RETURNING id`, [acct]))!.id;
  const mkAsset = async (title: string, sec: number, extras: boolean, md: any = {}, schema: string | null = null) => {
    const id = (await one<any>(`INSERT INTO vod_assets(channel_id, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, metadata, thumb_status, schema_id)
      VALUES ($1,'clip',$2,0,$3,$3,$4::jsonb,'ready',$5) RETURNING id`, [ch, title, sec * 1000, JSON.stringify(md), schema]))!.id;
    writeAsset(join(process.env.CLIPS_DIR!, 'vod', id), sec, 4, extras);
    await query(`UPDATE vod_assets SET master_key = $2, published = true WHERE id = $1`, [id, `/clips/vod/${id}/master.m3u8`]);
    return id;
  };
  const film = await mkAsset('The long film', 1800, true);
  const optedOut = await mkAsset('Ad-free special', 1800, false, { adRule: 'none' });
  const kidsEp = await mkAsset('Kids episode', 1800, false, {}, series);
  const adAsset = await mkAsset('Spring sale (conditioned)', 15, false);
  const houseAsset = await mkAsset('House promo', 10, false);
  await query(`INSERT INTO ad_creatives(account_id, creative_key, vod_asset_id, status, duration_ms) VALUES ($1,'ad-id.org:UAI-1',$2,'ready',15000)`, [acct, adAsset]);
  const server = (await one<any>(`INSERT INTO ad_servers(account_id, name, tag_template, timeout_ms) VALUES ($1,'Stub',$2,1000) RETURNING id`, [acct, `${VBASE}/wrap?sid=[SESSION_ID]&pos=[BREAK_POSITION]`]))!.id;
  const otherServer = (await one<any>(`INSERT INTO ad_servers(account_id, name, tag_template) VALUES ($1,'Theirs','http://x')  RETURNING id`, [other]))!.id;
  const app = await one<any>(`INSERT INTO apps(account_id, name, type, restrictions) VALUES ($1,'Web','web','{}') RETURNING id`, [acct]);
  const k = generateKey('publishable');
  await query(`INSERT INTO api_keys(account_id, app_id, kind, key_prefix, key_hash, scopes) VALUES ($1,$2,'publishable',$3,$4,'{playback}')`, [acct, app!.id, k.prefix, k.hash]);

  const srv = createServer().listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = (sub: string, role: string) => signAccess({ sub, account_id: acct, role } as any);
  const api = async (method: string, path: string, body?: any, sub = owner, role = 'owner') => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok(sub, role)}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text(); let j: any = null; try { j = JSON.parse(t); } catch { j = t; }
    return { s: r.status, j };
  };
  const gate = async (assetId: string, extra: any = {}) => {
    const r = await fetch(`${base}/api/availability`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'TestPlayer/1.0' }, body: JSON.stringify({ appKey: k.raw, assetId, ...extra }) });
    return { s: r.status, j: await r.json() as any };
  };
  const text = async (path: string) => { const r = await fetch(base + path, { redirect: 'manual' }); return { s: r.status, t: await r.text(), loc: r.headers.get('location') }; };

  console.log('\n== the console API ==');
  let r = await api('GET', '/api/vod/ads/rules');
  check('no rule yet: the default is off', [r.s, r.j.default.mode], [200, 'off']);
  let g1 = await gate(film);
  check('with ads off, the gate plays the asset as it is (DASH kept, no ads)', [g1.s, !!g1.j.delivery.hls?.startsWith('/clips/vod/'), g1.j.ads], [200, true, undefined]);
  r = await api('PUT', '/api/vod/ads/rules/default', { mode: 'on', policy: {}, adServerId: otherServer, houseAds: [] });
  check('another account\'s ad server is refused', r.s, 400);
  r = await api('PUT', '/api/vod/ads/rules/default', { mode: 'on', policy: {}, adServerId: server, houseAds: [{ assetId: houseAsset }] }, viewerUser, 'viewer');
  check('a viewer cannot change the rule', r.s, 403);
  r = await api('PUT', '/api/vod/ads/rules/default', { mode: 'on', policy: { postroll: { on: true, sec: 10 } }, adServerId: server, houseAds: [{ assetId: houseAsset }] });
  check('the owner turns ads on for the account', [r.s, r.j.mode, r.j.policy.postroll.on, r.j.policy.snapback, r.j.policy.adFreeFor], [200, 'on', true, true, ['entitlement']]);
  r = await api('PUT', `/api/vod/ads/rules/content-type/${series}`, { mode: 'off', policy: {} });
  check('the Kids series content type has its own rule: off', [r.s, r.j.contentTypeId, r.j.mode], [200, series, 'off']);
  r = await api('GET', `/api/vod/ads/assets/${film}/plan`);
  check('the film\'s plan: pre, two mid-rolls, post', [r.s, r.j.breaks.map((b: any) => [b.position, b.atSec])], [200, [['pre', 0], ['mid', 600], ['mid', 1200], ['post', 1800]]]);
  r = await api('GET', `/api/vod/ads/assets/${optedOut}/plan`);
  check('a title marked ad-free plans nothing, and says why', [r.j.breaks.length, r.j.why], [0, 'This item is marked ad-free.']);
  r = await api('GET', `/api/vod/ads/assets/${kidsEp}/plan`);
  check('the Kids episode follows its content type: no rule on', r.j.rule, null);
  truthy('rule changes are audited', (await query(`SELECT 1 FROM audit_log WHERE account_id=$1 AND entity_type='vod_ad_rule'`, [acct])).length === 2);

  console.log('\n== the play gate: stitched ==');
  g1 = await gate(film, { sid: 'play-attempt-0001' });
  check('the gate opens a stitched session: HLS through it, no DASH', [g1.s, g1.j.ads?.delivery, !!g1.j.ads?.sessionId, g1.j.delivery.hls === `/vod-ads/s/${g1.j.ads.sessionId}/master.m3u8`, g1.j.delivery.dash], [200, 'stitched', true, true, null]);
  const sid = g1.j.ads.sessionId;
  const srow = await one<any>(`SELECT * FROM vod_ad_sessions WHERE id=$1`, [sid]);
  check('the session joins the play attempt and keeps the viewer\'s player', [srow.play_sid, srow.ctx.userAgent], ['play-attempt-0001', 'TestPlayer/1.0']);
  const m = await text(g1.j.delivery.hls);
  truthy('session master: every rendition through the session, no I-frame playlist', m.s === 200 && m.t.includes(`/vod-ads/s/${sid}/v720.m3u8`) && m.t.includes(`URI="/vod-ads/s/${sid}/audio.m3u8"`) && m.t.includes(`URI="/vod-ads/s/${sid}/subs.m3u8"`) && !m.t.includes('I-FRAME'));
  const v = await text(`/vod-ads/s/${sid}/v720.m3u8`);
  const vl = v.t.split('\n').filter((l) => l && !l.startsWith('#'));
  const adPos = vl.map((l, i) => (l.includes('/seg/') ? i : -1)).filter((i) => i >= 0);
  // pod per break: the 15 s ad (4 segments) + the 10 s house promo (3 segments) when the 60 s mid-roll has room
  const firstAd = vl.findIndex((l) => l.includes('/seg/'));
  check('the pre-roll opens the playlist', firstAd, 0);
  truthy('ad segments go through the session\'s segment route', vl.filter((l) => l.includes(`/vod-ads/s/${sid}/seg/`)).length >= 8, String(adPos.length));
  const contentIdx = vl.findIndex((l) => l.endsWith('720p/seg_151.m4s'));
  truthy('a mid-roll sits right before content segment 151 (600 s)', vl[contentIdx - 1]?.includes('/seg/1/'), vl[contentIdx - 1]);
  truthy('content segments are the asset\'s own', vl.includes(`/clips/vod/${film}/720p/seg_1.m4s`));
  check('discontinuities around every pod and between its items (1 + 3 + 3 + 1)', (v.t.match(/#EXT-X-DISCONTINUITY/g) ?? []).length, 8);
  const subs = await text(`/vod-ads/s/${sid}/subs.m3u8`);
  truthy('subtitles stay in step: blank captions for each pod', (subs.t.match(/\/vod-ads\/blank\.vtt/g) ?? []).length === 4);
  const tl = (await (await fetch(`${base}/vod-ads/s/${sid}/timeline.json`)).json()) as any;
  check('timeline: four breaks, content and stitched times', tl.breaks.map((b: any) => [b.position, b.contentSec, b.stitchedStartSec, b.durationSec]),
    [['pre', 0, 0, 15], ['mid', 600, 615, 25], ['mid', 1200, 1240, 25], ['post', 1800, 1865, 10]]);
  const adEntry = tl.breaks[1].ads[0];
  check('timeline: the paid ad first, then the house promo; only the paid ad is clickable', [tl.breaks[1].ads.map((a: any) => a.kind), !!adEntry.clickUrl, tl.breaks[1].ads[1].clickUrl, tl.snapback],
    [['ad', 'house'], true, null, true]);
  const dec = await query<any>(`SELECT position, ad_ms, house_ms, fallback FROM vod_ad_breaks WHERE session_id=$1 ORDER BY break_index`, [sid]);
  check('every break decided once and recorded (60 s mid-rolls part filled)', dec.map((d) => [d.position, d.ad_ms, d.house_ms]), [['pre', 15000, 0], ['mid', 15000, 10000], ['mid', 15000, 10000], ['post', 0, 10000]]);

  console.log('\n== server-side beacons from ad segment requests ==');
  hits.length = 0;
  const seg0 = await text(`/vod-ads/s/${sid}/seg/1/0/v720/0`);
  check('an ad segment redirects to the real file', [seg0.s, seg0.loc], [302, `/clips/vod/${adAsset}/720p/seg_1.m4s`]);
  await sleep(400);
  check('segment 0: impression (wrapper and inline) and start, with the viewer\'s player', [hits.map((h) => h.path).sort(), hits.every((h) => h.ua === 'TestPlayer/1.0')], [['/px/imp', '/px/start', '/px/wimp'], true]);
  await text(`/vod-ads/s/${sid}/seg/1/0/audio/0`);
  await text(`/vod-ads/s/${sid}/seg/1/0/v720/0`);
  await sleep(300);
  check('audio segments and a repeat request send nothing more', hits.length, 3);
  await text(`/vod-ads/s/${sid}/seg/1/0/v720/1`);
  await sleep(300);
  check('segment 1 (from 4 s of 15): the first quartile (3.75 s) is now behind the viewer', hits.slice(3).map((h) => h.path).sort(), ['/px/firstQuartile']);
  await text(`/vod-ads/s/${sid}/seg/1/0/v360/3`);
  await sleep(300);
  check('the last segment (any rendition, segment 2 never asked): midpoint, third quartile, complete', hits.slice(4).map((h) => h.path).sort(), ['/px/complete', '/px/midpoint', '/px/thirdQuartile']);
  const evRows = await query<any>(`SELECT event, ok FROM vod_ad_events WHERE session_id=$1 AND break_index=1 AND pod_index=0 ORDER BY id`, [sid]);
  check('each recorded once (creativeView with no URL counted too), all answered', [evRows.length, evRows.every((e) => e.ok !== false)], [8, true]);
  hits.length = 0;
  await text(`/vod-ads/s/${sid}/seg/1/1/v720/0`);
  await sleep(300);
  check('a house promo sends no beacons', hits.length, 0);

  console.log('\n== what the player reports: events and clicks ==');
  let pe = await fetch(`${base}/vod-ads/s/${sid}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events: [{ b: 1, p: 0, event: 'pause' }, { b: 1, p: 0, event: 'mute' }, { b: 1, p: 1, event: 'pause' }] }) });
  const pej = await pe.json() as any;
  await sleep(300);
  check('pause and mute on the paid ad are sent; the house promo has none to send', [pej.accepted, hits.map((h) => h.path).sort()], [2, ['/px/mute', '/px/pause']]);
  pe = await fetch(`${base}/vod-ads/s/${sid}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events: [{ b: 1, p: 0, event: 'complete' }] }) });
  check('the player cannot send events only the server sends', pe.status, 422);
  hits.length = 0;
  const click = await fetch(base + adEntry.clickUrl, { redirect: 'manual', headers: { 'user-agent': 'Browser/2' } });
  await sleep(300);
  check('a click: on to the advertiser, both click trackers (inline and wrapper) sent with the viewer\'s address', [click.status, click.headers.get('location'), hits.map((h) => h.path).sort(), !!hits[0]?.ip],
    [302, 'https://advertiser.example/landing', ['/px/click', '/px/wclick'], true]);
  check('the house promo has no page to open', (await fetch(`${base}/vod-ads/s/${sid}/click/1/1`, { redirect: 'manual' })).status, 404);
  check('a made-up session is not found', (await text(`/vod-ads/s/vaXXXXXXXXXXXXXXXXXXXXXXXXXX/master.m3u8`)).s, 404);

  console.log('\n== guided (HLS Interstitials) ==');
  const g2 = await gate(film, { caps: ['hls-interstitials'] });
  check('a player with interstitials gets the shared guided playlist, no session yet', [g2.j.ads?.delivery, g2.j.ads?.sessionId, /^\/vod-ads\/g\/[0-9a-f-]{36}\/[\w-]{10}\/master\.m3u8$/.test(g2.j.delivery.hls)], ['guided', null, true]);
  const gm = await fetch(base + g2.j.delivery.hls);
  check('the guided master may be cached by the CDN', gm.headers.get('cache-control'), 'public, max-age=300');
  const gv = await text(g2.j.delivery.hls.replace('master.m3u8', 'v720.m3u8'));
  truthy('the guided playlist: content only, four interstitials', (gv.t.match(/com\.apple\.hls\.interstitial/g) ?? []).length === 4 && !gv.t.includes('/seg/'));
  const listUrl = gv.t.match(/X-ASSET-LIST="([^"]+\/list\/1\.json)"/)?.[1];
  check('an asset list without the player\'s playback id is refused', (await text(listUrl!)).s, 400);
  const al = (await (await fetch(`${base}${listUrl}?_HLS_primary_id=PRIMARY-1`)).json()) as any;
  check('the asset list: the paid ad and the house promo, decided for this playback', [al.ASSETS.length, al.ASSETS.map((a: any) => a.DURATION)], [2, [15, 10]]);
  const gsid = al['X-VOLT-SESSION'];
  const again = (await (await fetch(`${base}${listUrl}?_HLS_primary_id=PRIMARY-1`)).json()) as any;
  check('asking again is the same session and the same decision', [again['X-VOLT-SESSION'], (await query(`SELECT 1 FROM vod_ad_breaks WHERE session_id=$1`, [gsid])).length], [gsid, 1]);
  const am = await text(al.ASSETS[0].URI);
  truthy('the ad as its own stream, its renditions through the session', am.s === 200 && am.t.includes(`/vod-ads/s/${gsid}/ad/1/0/v720.m3u8`));
  const amv = await text(`/vod-ads/s/${gsid}/ad/1/0/v720.m3u8`);
  truthy('its segments through the segment route (so beacons work for any player)', amv.t.includes(`/vod-ads/s/${gsid}/seg/1/0/v720/0`) && amv.t.includes('#EXT-X-ENDLIST'));
  hits.length = 0;
  await text(`/vod-ads/s/${gsid}/seg/1/0/v720/0`);
  await sleep(300);
  check('guided: the first segment sends the impression and start', hits.map((h) => h.path).sort(), ['/px/imp', '/px/start', '/px/wimp']);
  const stale = await text(g2.j.delivery.hls.replace(/\/[\w-]{10}\/master/, '/AAAAAAAAAA/master'));
  check('a guided playlist of an old rule version is not served', stale.s, 404);

  console.log('\n== who gets no ads ==');
  check('a title marked ad-free plays as it is', (await gate(optedOut)).j.ads, undefined);
  check('a content type whose rule is off plays as it is', (await gate(kidsEp)).j.ads, undefined);
  check('a viewer who paid (entitlement) is ad-free by default', await VA.adsForPlay({ accountId: acct, assetId: film, via: 'entitlement', ctx: {} }), null);
  const member = await VA.adsForPlay({ accountId: acct, assetId: film, via: 'members', ctx: {} });
  check('a signed-in member still gets ads unless the rule says otherwise', member?.delivery, 'stitched');
  await VA.readySession(member!.sessionId!);
  check('another account cannot open a session on this asset', await VA.adsForPlay({ accountId: other, assetId: film, ctx: {} }), null);

  console.log('\n== an ad server that does not answer ==');
  slow = true;
  const t0 = Date.now();
  const g3 = await gate(film);
  const v3 = await text(`/vod-ads/s/${g3.j.ads.sessionId}/v720.m3u8`);
  const took = Date.now() - t0;
  slow = false;
  const d3 = await query<any>(`SELECT fallback, ad_ms, house_ms FROM vod_ad_breaks WHERE session_id=$1 ORDER BY break_index`, [g3.j.ads.sessionId]);
  check('every break falls back to the house promo, recorded as a timeout', d3.map((d) => [d.fallback, d.ad_ms, d.house_ms]), Array(4).fill(['ad-server-timeout', 0, 10000]));
  truthy('the playlist did not wait longer than the budget plus a little', took < 2500 && v3.s === 200, `${took} ms`);

  console.log('\n== the report ==');
  r = await api('GET', '/api/vod/ads/report?days=1');
  check('report: sessions, impressions, completion, clicks', [r.s, r.j.sessions, r.j.impressions, r.j.completes, r.j.clicks, r.j.timeouts], [200, 4, 2, 1, 1, 4]);
  truthy('report: fill and house share', r.j.fillRate > 0 && r.j.houseShare > 0 && r.j.clickRate === 0.5);

  console.log('\n== production routing ==');
  {
    const { scaleConfig } = await import('../src/scale/config');
    const { readFileSync } = await import('node:fs');
    truthy('the public API tier serves /vod-ads/', scaleConfig.publicPrefixes.includes('/vod-ads/'));
    truthy('the load balancer sends /vod-ads/* to the public tier', readFileSync(join(__dirname, '../../deploy/terraform/scaling_alb.tf'), 'utf8').includes('["/vod-ads/*"]'));
  }

  console.log('\n== the player: snapback, the ad on screen, clicks (sdk/ads.ts) ==');
  {
    const SDK = await import('../../volt-player/src/sdk/ads');
    const tlUrl = g1.j.ads.timelineUrl;
    // a media element stand-in: currentTime, events, pause
    class FakeMedia extends EventTarget { currentTime = 0; paused = false; muted = false; volume = 1; pause() { this.paused = true; this.dispatchEvent(new Event('pause')); } }
    const media = new FakeMedia() as any;
    const opened: string[] = [];
    (globalThis as any).window = { open: (u: string) => { opened.push(u); return null; } };
    const states: any[] = [];
    const ctl = new SDK.VodAds(media, base, { delivery: 'stitched', sessionId: sid, timelineUrl: tlUrl }, (a) => states.push(a));
    await sleep(300);
    const at = async (t: number, ev = 'timeupdate') => { media.currentTime = t; media.dispatchEvent(new Event(ev)); await sleep(5); };
    await at(3);
    check('the pre-roll on screen: ad 1 of 1, 12 s left, clickable', [states.at(-1)?.number, states.at(-1)?.of, states.at(-1)?.remainingSec, states.at(-1)?.canClick], [1, 1, 12, true]);
    await at(5, 'seeking');
    await sleep(300);
    check('a seek inside an unwatched ad is undone', media.currentTime, 3);
    await at(16);
    check('after the pre-roll: no ad, content time 1 s', [states.at(-1), Math.round(ctl.contentTime)], [null, 1]);
    // seek from content 1 s to content 1300 s (stitched 1300 + 65): both mid-rolls skipped
    await at(SDK.toStitched(1300, (ctl as any).cs), 'seeking');
    check('a seek past two unwatched mid-rolls plays the later one first (snapback)', media.currentTime, 1240);
    await sleep(300);
    await at(1250);
    check('during it: ad 1 of 2 in that break', [states.at(-1)?.breakIndex, states.at(-1)?.number, states.at(-1)?.of], [2, 1, 2]);
    hits.length = 0;
    ctl.click();
    await fetch(opened[0], { redirect: 'manual' });   // what the browser does with the window it opened
    await sleep(300);
    check('Learn more: the player pauses, opens Volt\'s click address, the click is recorded', [media.paused, opened[0], (await query(`SELECT count(*)::int AS n FROM vod_ad_events WHERE session_id=$1 AND break_index=2 AND event='click'`, [sid]))[0].n],
      [true, `${base}/vod-ads/s/${sid}/click/2/0`, 2]);
    await at(1265);
    await sleep(300);
    check('when the break ends, on to where the viewer asked (content 1300 s, after the three breaks before it)', [media.currentTime, Math.round(ctl.contentTime)], [1365, 1300]);
    await sleep(300);
    await at(1245, 'seeking');
    await sleep(300);
    check('a seek back into a watched break jumps past it', media.currentTime, 1265);
    check('scrubber markers: breaks behind the viewer count as played (the earlier skipped one is not forced later), the post-roll is not', ctl.markers.map((m: any) => m.watched), [true, true, true, false]);
    ctl.dispose();
  }

  console.log('\n== FAST: a click on a stitched ad ==');
  const { sessionStore } = await import('../src/services/fast/sessionStore');
  await query(`INSERT INTO channel_ads(channel_id, mode) VALUES ($1,'stitched')`, [ch]);
  const bk = (await one<any>(`INSERT INTO stream_breaks(channel_id, source, starts_at, duration_ms, position, status) VALUES ($1,'manual', now() - interval '20 seconds', 60000, 'mid', 'scheduled') RETURNING id`, [ch]))!.id;
  await sessionStore.savePod('fastviewer01', bk, { items: [
    { kind: 'ad', adId: 'a1', creativeKey: 'ad-id.org:UAI-1', assetId: adAsset, durationSec: 15, title: 'Spring sale', impressions: [], tracking: {}, clickThrough: 'https://advertiser.example/fast', clickTracking: [`${VBASE}/px/fastclick`] },
    { kind: 'house', assetId: houseAsset, durationSec: 10, title: 'House promo' }] });
  const aj = (await (await fetch(`${base}/fast/${ch}/s/fastviewer01/ads.json`)).json()) as any;
  check('ads.json: the break\'s paid ad with its moment and click address', [aj.breaks.length, aj.breaks[0].ads.length, aj.breaks[0].ads[0].clickUrl], [1, 1, `/fast/${ch}/s/fastviewer01/click/${bk}/0`]);
  hits.length = 0;
  const fc = await fetch(base + aj.breaks[0].ads[0].clickUrl, { redirect: 'manual' });
  await sleep(300);
  check('the click: tracker sent, on to the advertiser, recorded with the beacons', [fc.status, fc.headers.get('location'), hits.map((h) => h.path), (await query(`SELECT 1 FROM ad_beacons WHERE break_id=$1 AND event='click' AND ok`, [bk])).length],
    [302, 'https://advertiser.example/fast', ['/px/fastclick'], 1]);
  check('a click on the house promo is not found', (await fetch(`${base}/fast/${ch}/s/fastviewer01/click/${bk}/1`, { redirect: 'manual' })).status, 404);

  srv.close(); vast.close(); await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
