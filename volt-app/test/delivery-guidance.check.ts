// ============================================================================
//  SERVER-GUIDED QUALITY AND CONTENT STEERING (build queue 2.10).
//
//  1. CMSD values: CMSD-Static for a live playlist, CMSD-Dynamic with and
//     without guidance, read back the way players read them; rung floor.
//  2. The meter and the duress with hysteresis: on above `hi`, held until
//     the load has stayed under `lo` for holdSec, ceilings scaled to `target`
//     and floored to the stream's own rungs, never below the lowest.
//  3. The steered masters: HLS with every group and variant once per
//     pathway (suffixed group ids, absolute addresses, the steering tag);
//     DASH with a BaseURL per pathway and ContentSteering; an MPD with its
//     own BaseURL left alone. Priority: region order, drain, and a pathway
//     clearly worse in one country moved last there only.
//  4. Postgres and real HTTP through createServer(): /origin playlists carry
//     CMSD (none when DELIVERY_CMSD=off), segments are metered per viewer by
//     the CMCD sid, load from other viewers puts mb on the playlists and the
//     guidance lifts after the hold; /live serves the steered master and MPD
//     when pathways are configured (and redirects as before when not); the
//     steering service orders by the players' own reports in the analytics
//     database for that country.
//    DATABASE_URL=... npx tsx test/delivery-guidance.check.ts
// ============================================================================
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGIN = mkdtempSync(join(tmpdir(), 'volt-delivery-'));
process.env.ORIGIN_DIR = ORIGIN;
// the origin's allowance for this suite: 20 Mb/s, a short window and hold
process.env.DELIVERY_ALLOWANCE_MBPS = '20';
process.env.DELIVERY_METER_WINDOW_SEC = '2';
process.env.DELIVERY_DURESS_HOLD_SEC = '1';
process.env.STEERING_MIN_PLAYING_MS = '60000';

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Shaka's own reading of CMSD-Dynamic (shaka.util.CmsdManager.parseCMSDDynamic_), for parity. */
function shakaDynamic(a: string): Map<string, unknown> {
  const b = new Map<string, unknown>(); const c = a.split(';');
  const val = (x?: string) => (x ? (x.toLowerCase() === 'false' ? false : /^[-0-9]/.test(x) ? parseInt(x, 10) : x.replace(/["]+/g, '')) : true);
  for (let i = 1; i < c.length; i++) { const d = c[i].split('='); b.set(d[0], val(d[1])); }
  return b;
}

const MASTER = [
  '#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-INDEPENDENT-SEGMENTS',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",DEFAULT=YES,URI="stream_0_cc.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",URI="subs_cc.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.64001f",AUDIO="audio",SUBTITLES="subs",CLOSED-CAPTIONS=NONE',
  'stream_1_cc.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=1200000,CODECS="avc1.64001f",AUDIO="audio",SUBTITLES="subs",CLOSED-CAPTIONS=NONE',
  'stream_2_cc.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=400000,CODECS="avc1.64001f",AUDIO="audio",SUBTITLES="subs",CLOSED-CAPTIONS=NONE',
  'stream_3_cc.m3u8', '',
].join('\n');
const MPD = `<?xml version="1.0" encoding="UTF-8"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" minimumUpdatePeriod="PT2S">\n  <Period id="0" start="PT0S"><AdaptationSet><Representation id="1" bandwidth="3000000"><SegmentTemplate media="v1/seg_$Number$.m4s" initialization="v1/init.mp4"/></Representation></AdaptationSet></Period>\n</MPD>\n`;
const media = (n: number) => ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${n}`, '#EXTINF:2.0,', `v1/seg_${n}.m4s`, ''].join('\n');

(async () => {
  const cm = await import('../src/services/delivery/cmsd');
  const st = await import('../src/services/delivery/steering');

  // ---- 1. the values ----------------------------------------------------------------------------
  check('CMSD-Static of a live HLS playlist', cm.cmsdStatic({ format: 'hls', live: true }), 'ot=m,sf=h,st=l');
  check('...and of a DASH MPD', cm.cmsdStatic({ format: 'dash', live: true }), 'ot=m,sf=d,st=l');
  check('CMSD-Dynamic under guidance', cm.cmsdDynamic({ mb: 1200.7, du: true }), '"volt-origin";mb=1200;du');
  check('CMSD-Dynamic without guidance is the server id alone (it lifts an earlier ceiling)', cm.cmsdDynamic({ mb: null }), '"volt-origin"');
  check('Shaka reads our mb as kb/s and du as set', [...shakaDynamic(cm.cmsdDynamic({ mb: 1200, du: true }))], [['mb', 1200], ['du', true]]);
  check('Shaka reads the lifted header as no keys at all', shakaDynamic(cm.cmsdDynamic({})).size, 0);
  check('our parser reads the last server on the path', cm.parseCmsdDynamic('"edge";mb=5000, "volt-origin";mb=800;du'), { server: 'volt-origin', mb: 800, du: true });
  check('rung floor: 2000 kb/s on 400/1200/3000 is 1200', cm.rungFloor(2000, [3000, 400, 1200]), 1200);
  check('rung floor: below every rung is the lowest rung, never nothing', cm.rungFloor(100, [3000, 400, 1200]), 400);
  check('rung floor: no ladder known rounds down to 100 kb/s, at least 100', [cm.rungFloor(1234, []), cm.rungFloor(20, [])], [1200, 100]);
  check('rungs read from a master', cm.hlsRungs(MASTER), [3000, 1200, 400]);

  // ---- 2. meter and duress ----------------------------------------------------------------------
  const cfg = { allowanceBps: 10e6, hi: 0.9, lo: 0.7, holdSec: 5, target: 0.8, windowSec: 2 };
  const meter = new cm.DeliveryMeter(2000);
  const g = new cm.Guidance(cfg, meter, () => [400, 1200, 3000]);
  let t = 1_000_000;
  // 3 viewers on stream A at 3 Mb/s = 9 Mb/s over 2 s: under 90 % of 10 Mb/s
  for (const v of ['a', 'b', 'c']) meter.add('A', 3e6 / 8 * 2 * 0.95, v, t);
  check('8.55 Mb/s of a 10 Mb/s allowance: no duress, no ceiling', g.forStream('A', t), { mb: null, du: false });
  meter.add('B', 2e6 / 8 * 2, 'd', t);
  const under = g.forStream('A', t);
  check('a fourth viewer takes it to 10.55 Mb/s: duress, A capped to the rung under its share of 8 Mb/s', under, { mb: 1200, du: true });
  check('...and B (2 Mb/s, one viewer) to 1200 as well', g.forStream('B', t).mb, 1200);
  check('...the fair share: 8 Mb/s over 4 viewers who would each take 3 Mb/s is 2 Mb/s', Math.round(g.shareKbps(t)!), 2000);
  // the ratchet the fair share prevents: a viewer already guided down to 1.2 Mb/s
  const m3 = new cm.DeliveryMeter(2000);
  const g3 = new cm.Guidance({ ...cfg, allowanceBps: 8e6 }, m3, (s) => (s === 'A' ? [400, 1200, 3000] : []));
  m3.add('A', 1.2e6 / 8 * 2, 'a', t);
  for (const v of ['o1', 'o2', 'o3', 'o4']) m3.add('O', 1.6e6 / 8 * 2, v, t);
  check('a viewer already guided to 1.2 Mb/s keeps 1200 (share 1280 of 6.4 Mb/s), not 400 from its own lowered rate', g3.forStream('A', t), { mb: 1200, du: true });
  check('...viewers of a stream with no known ladder count at their measured rate', Math.round(g3.shareKbps(t)!), 1280);
  // guided down, the four viewers pull 4.8 Mb/s: under `lo`, but they would take 12 unguided
  const m4 = new cm.DeliveryMeter(2000), g4 = new cm.Guidance(cfg, m4, () => [400, 1200, 3000]);
  for (const v of ['a', 'b', 'c', 'd']) m4.add('A', 3e6 / 8 * 2, v, t);
  check('four viewers at 3 Mb/s: guided', g4.forStream('A', t).mb, 1200);
  for (let k = 1; k <= 8; k++) for (const v of ['a', 'b', 'c', 'd']) m4.add('A', 1.2e6 / 8, v, t + k * 1000);
  check('...pulling 4.8 Mb/s at the ceiling for 8 s (past the hold): still guided, no cycle back to the top', g4.forStream('A', t + 8000), { mb: 1200, du: true });
  t += 2500; // the window has passed: no load at all
  check('load gone: still under duress inside the hold', g.forStream('A', t).du, true);
  t += 3000;
  check('...still held at 3 s of calm (hold 5 s)', g.forStream('A', t).du, true);
  t += 2100;
  check('...lifted once calm for 5 s', g.forStream('A', t), { mb: null, du: false });
  check('an allowance of 0 never guides', new cm.Guidance({ ...cfg, allowanceBps: 0 }, meter, () => []).forStream('A', t), { mb: null, du: false });
  meter.add('C', 100e6, 'x', t);
  check('a stream nobody watches yet, under duress, gets its lowest rung', g.forStream('D', t), { mb: 400, du: true });
  check('viewer key: the CMCD sid, else the address', [cm.viewerKey({ query: { CMCD: 'br=3000,sid="abc-1",ot=v' }, ip: '1.2.3.4' }), cm.viewerKey({ query: {}, ip: '1.2.3.4' })], ['s:abc-1', 'a:1.2.3.4']);

  // ---- 3. steered masters and priority ----------------------------------------------------------
  const P = [{ id: 'cf', base: 'https://d1.cloudfront.net' }, { id: 'b', base: 'https://cdn-b.example.net' }];
  check('config: off with one pathway', st.steeringConfig({ DELIVERY_PATHWAYS: JSON.stringify([P[0]]) } as any), null);
  check('config: off when unreadable', st.steeringConfig({ DELIVERY_PATHWAYS: '{nope' } as any), null);
  const sc = st.steeringConfig({ DELIVERY_PATHWAYS: JSON.stringify({ pathways: [...P, { id: 'bad id', base: 'x' }], regions: { AU: ['b', 'cf', 'zz'] }, ttlSec: 30 }) } as any)!;
  check('config: pathways kept, bad ones dropped, region list to known ids, ttl', [sc.pathways.map((p) => p.id), sc.regions.AU, sc.ttlSec], [['cf', 'b'], ['b', 'cf'], 30]);
  const url = 'https://d1.cloudfront.net/channel/abc/master_cc.m3u8';
  check('the same file on another pathway', st.pathwayUrl(url, P[1]), 'https://cdn-b.example.net/channel/abc/master_cc.m3u8');
  check('...and from a path on this origin', st.pathwayUrl('/origin/abc/live/master_cc.m3u8', { id: 'l', base: 'http://localhost:8080' }), 'http://localhost:8080/origin/abc/live/master_cc.m3u8');
  const sm = st.steerHlsMaster(MASTER, url, P, '/live/abc/steering?f=hls');
  const L = sm.split('\n');
  check('steered HLS: the steering tag after the version, first pathway as default', L.slice(0, 3), ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-CONTENT-STEERING:SERVER-URI="/live/abc/steering?f=hls",PATHWAY-ID="cf"']);
  check('steered HLS: 3 variants per pathway, each with its PATHWAY-ID', [L.filter((l) => l.includes('PATHWAY-ID="cf",BANDWIDTH')).length, L.filter((l) => l.includes('PATHWAY-ID="b",BANDWIDTH')).length], [3, 3]);
  check('steered HLS: each pathway names its own renditions', L.filter((l) => l.startsWith('#EXT-X-MEDIA')).map((l) => /GROUP-ID="([^"]+)"/.exec(l)![1]), ['audio-cf', 'subs-cf', 'audio-b', 'subs-b']);
  check('steered HLS: a variant points at its own pathway\'s groups', L.find((l) => l.includes('PATHWAY-ID="b"'))!.includes('AUDIO="audio-b",SUBTITLES="subs-b",CLOSED-CAPTIONS=NONE'), true);
  check('steered HLS: every address absolute on its pathway', [L[L.indexOf(L.find((l) => l.includes('PATHWAY-ID="b",BANDWIDTH=400000'))!) + 1], /URI="([^"]+)"/.exec(L.find((l) => l.includes('GROUP-ID="audio-b"'))!)![1]],
    ['https://cdn-b.example.net/channel/abc/stream_3_cc.m3u8', 'https://cdn-b.example.net/channel/abc/stream_0_cc.m3u8']);
  check('steered HLS: the rungs are unchanged (each listed once per pathway)', cm.hlsRungs(sm), [3000, 1200, 400, 3000, 1200, 400]);
  check('steered HLS: steering an already steered master gives one steering tag', st.steerHlsMaster(MASTER.replace('#EXT-X-VERSION:6', '#EXT-X-VERSION:6\n#EXT-X-CONTENT-STEERING:SERVER-URI="x",PATHWAY-ID="y"'), url, P, 's').split('\n').filter((l) => l.startsWith('#EXT-X-CONTENT-STEERING')).length, 1);
  const smpd = st.steerMpd(MPD, 'https://d1.cloudfront.net/channel/abc/manifest_cc.mpd', P, '/live/abc/steering?f=dash&as=AU')!;
  check('steered MPD: a BaseURL per pathway', [...smpd.matchAll(/<BaseURL serviceLocation="([^"]+)">([^<]+)</g)].map((m) => [m[1], m[2]]), [['cf', 'https://d1.cloudfront.net/channel/abc/'], ['b', 'https://cdn-b.example.net/channel/abc/']]);
  check('steered MPD: ContentSteering, escaped, asked before the first segment', /<ContentSteering defaultServiceLocation="cf" queryBeforeStart="true">\/live\/abc\/steering\?f=dash&amp;as=AU<\/ContentSteering>/.test(smpd), true);
  check('steered MPD: inside the MPD, before the Period', smpd.indexOf('<ContentSteering') > smpd.indexOf('<MPD') && smpd.indexOf('<ContentSteering') < smpd.indexOf('<Period'), true);
  check('an MPD with its own BaseURL is left alone', st.steerMpd(MPD.replace('<Period', '<BaseURL>x/</BaseURL><Period'), url, P, 's'), null);
  const q = (playingMs: number, rebufferMs: number, attempts = 10, failures = 0) => ({ playingMs, rebufferMs, attempts, failures });
  check('priority: the configured order', st.pathwayPriority(sc, 'NZ'), ['cf', 'b']);
  check('priority: a region\'s own order', st.pathwayPriority(sc, 'AU'), ['b', 'cf']);
  check('priority: b stalling 6 % against cf 1 % in AU: b last there', st.pathwayPriority(sc, 'AU', new Map([['b', q(600_000, 38_000)], ['cf', q(600_000, 6_000)]])), ['cf', 'b']);
  check('priority: only a little worse (1.5 % against 1 %): left where it is', st.pathwayPriority(sc, 'AU', new Map([['b', q(600_000, 9_200)], ['cf', q(600_000, 6_000)]])), ['b', 'cf']);
  check('priority: too little playing time to judge: left where it is', st.pathwayPriority(sc, 'AU', new Map([['b', q(30_000, 9_000)], ['cf', q(600_000, 0)]])), ['b', 'cf']);
  check('priority: failures count too (3 of 10 attempts)', st.pathwayPriority(sc, 'AU', new Map([['b', q(600_000, 0, 10, 3)], ['cf', q(600_000, 0)]])), ['cf', 'b']);
  check('priority: a drained pathway goes last', st.pathwayPriority({ ...sc, drain: ['b'] }, 'AU'), ['cf', 'b']);

  // ---- 4. Postgres and real HTTP ----------------------------------------------------------------
  if (!process.env.DATABASE_URL) {
    console.log('PASS skipped the database part: set DATABASE_URL');
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
  const { createServer } = await import('../src/server');
  const { pool, one } = await import('../src/db');
  const { aquery, closeAnalytics } = await import('../src/services/qoe/analyticsDb');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`dg-${tag}`]))!.id;
  const grp = (await one<any>(`INSERT INTO groups(account_id, name) VALUES ($1,'News') RETURNING id`, [acct]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name, status, on_air) VALUES ($1,'DG News','live',true) RETURNING id`, [grp]))!.id;
  const run = join(ORIGIN, ch, 'runs', 'r1');
  mkdirSync(join(run, 'v1'), { recursive: true });
  writeFileSync(join(ORIGIN, ch, 'current_run.txt'), 'r1');
  writeFileSync(join(run, 'master_cc.m3u8'), MASTER);
  writeFileSync(join(run, 'manifest_cc.mpd'), MPD);
  for (const n of [0, 1, 2, 3]) writeFileSync(join(run, `stream_${n}_cc.m3u8`), media(5));
  writeFileSync(join(run, 'v1', 'seg_5.m4s'), Buffer.alloc(250_000, 1));
  const srv = createServer().listen(0);
  await new Promise((r) => srv.once('listening', r));
  const port = (srv.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  const get = (p: string, h: Record<string, string> = {}) => fetch(base + p, { headers: h, redirect: 'manual' });
  cm.resetOriginGuidance();

  let r = await get(`/origin/${ch}/live/stream_1_cc.m3u8`);
  check('/origin media playlist: CMSD-Static', r.headers.get('cmsd-static'), 'ot=m,sf=h,st=l');
  check('...CMSD-Dynamic with no guidance while the origin is calm', r.headers.get('cmsd-dynamic'), '"volt-origin"');
  check('...both readable by a page on another site', r.headers.get('access-control-expose-headers'), 'cmsd-static, cmsd-dynamic');
  r = await get(`/origin/${ch}/live/v1/seg_5.m4s?CMCD=${encodeURIComponent('br=3000,ot=v,sid="viewer-1"')}`);
  await r.arrayBuffer();
  await sleep(50);
  const rate = cm.originGuidance().meter.rate(ch);
  check('a segment carries no CMSD (one header per playlist is the design)', r.headers.get('cmsd-dynamic'), null);
  check('...but its bytes are counted against the stream (the playlist too)', rate.bps >= 250_000 * 8 / 2 && rate.bps < 260_000 * 8 / 2, true);
  check('...per viewer: the CMCD sid, and the playlist fetch without CMCD by its address', rate.viewers, 2);
  // 30 Mb/s from other viewers of another stream: over the 20 Mb/s allowance
  for (let i = 0; i < 10; i++) cm.originGuidance().meter.add('00000000-0000-0000-0000-00000000beef', 3e6 / 8 * 2, 'other-' + i);
  r = await get(`/origin/${ch}/live/stream_1_cc.m3u8`);
  const dyn = cm.parseCmsdDynamic(r.headers.get('cmsd-dynamic'));
  check('the origin under duress: the playlist says du and a ceiling on one of this stream\'s rungs', [dyn.du, [400, 1200, 3000].includes(dyn.mb ?? -1)], [true, true]);
  check('...this stream\'s 2 viewers and the 10 others share 16 Mb/s: 1333 kb/s each, floored to 1200', dyn.mb, 1200);
  await sleep(2600); // the window passes
  r = await get(`/origin/${ch}/live/stream_1_cc.m3u8`);
  check('load gone, inside the 1 s hold: still guided', cm.parseCmsdDynamic(r.headers.get('cmsd-dynamic')).du, true);
  await sleep(1100);
  r = await get(`/origin/${ch}/live/stream_1_cc.m3u8`);
  check('...after the hold the playlist lifts the ceiling', r.headers.get('cmsd-dynamic'), '"volt-origin"');
  process.env.DELIVERY_CMSD = 'off';
  r = await get(`/origin/${ch}/live/stream_1_cc.m3u8`);
  check('DELIVERY_CMSD=off: no CMSD at all', [r.headers.get('cmsd-static'), r.headers.get('cmsd-dynamic')], [null, null]);
  delete process.env.DELIVERY_CMSD;

  const fresh = () => { for (const f of ['master_cc.m3u8', 'manifest_cc.mpd']) utimesSync(join(run, f), new Date(), new Date()); };
  fresh();
  r = await get(`/live/${ch}/master.m3u8`);
  check('/live without pathways configured: the redirect as before', [r.status, r.headers.get('location')], [302, `/origin/${ch}/live/master_cc.m3u8`]);
  r = await get(`/live/${ch}/steering`);
  check('...and no steering service', r.status, 404);
  const A = { id: 'a', base: `http://127.0.0.1:${port}` }, B = { id: 'b', base: `http://localhost:${port}` };
  process.env.DELIVERY_PATHWAYS = JSON.stringify({ pathways: [A, B], ttlSec: 5 });
  r = await get(`/live/${ch}/master.m3u8?as=AU`);
  const body = await r.text();
  check('/live with two pathways: the master answered here', [r.status, r.headers.get('content-type')?.split(';')[0], r.headers.get('access-control-allow-origin')], [200, 'application/vnd.apple.mpegurl', '*']);
  check('...steering tag with the tester\'s country carried', body.split('\n')[2], `#EXT-X-CONTENT-STEERING:SERVER-URI="/live/${ch}/steering?f=hls&as=AU",PATHWAY-ID="a"`);
  check('...each variant on both paths, absolute', [body.includes(`${A.base}/origin/${ch}/live/stream_1_cc.m3u8`), body.includes(`${B.base}/origin/${ch}/live/stream_1_cc.m3u8`)], [true, true]);
  check('...and the master carries CMSD-Static too', r.headers.get('cmsd-static'), 'ot=m,sf=h,st=l');
  const bvar = body.split('\n').find((l) => l.startsWith(B.base))!;
  r = await fetch(bvar);
  check('a player that ignores steering can follow any listed address and play', [r.status, (await r.text()).includes('v1/seg_5.m4s')], [200, true]);
  r = await get(`/live/${ch}/manifest.mpd`);
  const mpd = await r.text();
  check('/live DASH: the MPD answered here with both BaseURLs and ContentSteering', [r.status, (mpd.match(/<BaseURL serviceLocation=/g) ?? []).length, mpd.includes('<ContentSteering defaultServiceLocation="a"')], [200, 2, true]);
  check('...and CMSD on the MPD (it is reloaded through here)', r.headers.get('cmsd-dynamic'), '"volt-origin"');

  // the analytics database outlives a run of the suite: start from no reports on these hosts
  await aquery(`DELETE FROM qoe_minutes WHERE cdn IN ('127.0.0.1', 'localhost')`);
  st.clearQualityCache();
  r = await get(`/live/${ch}/steering?f=hls&as=AU&_HLS_pathway=a&_HLS_throughput=4000000`);
  check('steering service: version 1, TTL, configured order, never cached', [await r.json(), r.headers.get('cache-control')], [{ VERSION: 1, TTL: 5, 'RELOAD-URI': `/live/${ch}/steering?f=hls&as=AU`, 'PATHWAY-PRIORITY': ['a', 'b'] }, 'private, no-store']);
  // the players' own reports: viewers in AU on 127.0.0.1 (path a) stalled 10 % of the time
  const minute = new Date(Math.floor(Date.now() / 60000) * 60000 - 60000);
  await aquery(`INSERT INTO qoe_minutes(account_id, minute, content_id, stream_type, country, device_class, cdn, def_version, attempts, starts, stalls, playing_ms, rebuffer_ms)
                VALUES ($1,$2,$3,'live','AU','desktop','127.0.0.1',1,20,20,40,540000,60000), ($1,$2,$3,'live','AU','desktop','localhost',1,20,20,1,580000,1000),
                       ($1,$2,$3,'live','NZ','desktop','127.0.0.1',1,20,20,0,600000,0)`, [acct, minute, ch]);
  st.clearQualityCache();
  r = await get(`/live/${ch}/steering?f=hls&as=AU`);
  check('path a stalling in AU: AU viewers steered to b', (await r.json())['PATHWAY-PRIORITY'], ['b', 'a']);
  r = await get(`/live/${ch}/steering?f=hls&as=NZ`);
  check('...NZ viewers, where a is fine, stay on a', (await r.json())['PATHWAY-PRIORITY'], ['a', 'b']);
  process.env.DELIVERY_PATHWAYS_DRAIN = 'a';
  r = await get(`/live/${ch}/steering?f=hls&as=NZ`);
  check('an operator drains a: everyone to b', (await r.json())['PATHWAY-PRIORITY'], ['b', 'a']);
  delete process.env.DELIVERY_PATHWAYS_DRAIN;
  delete process.env.DELIVERY_PATHWAYS;

  srv.close(); await closeAnalytics(); await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
