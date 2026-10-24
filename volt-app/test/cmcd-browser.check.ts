// ============================================================================
//  CMCD v2 FROM THE REAL PLAYER, IN A REAL BROWSER (build queue 1.14d).
//
//  The Volt SDK bundled from volt-player/src plays in Chromium on a site of
//  its own, through the real play gate and the real collector (Postgres +
//  HTTP), from a stand-in CDN on a third origin that behaves as the Terraform
//  says CloudFront does: the cache key ignores query strings (so CMCD), every
//  response carries its own x-amz-cf-id, exposed to the page.
//
//  1. A viewer plays an on-demand asset: every playlist and segment request
//     carries CMCD that the SVTA library's validator accepts as v2 request
//     mode, with this attempt's sid and the asset as cid; the event reports
//     are valid application/cmcd POSTs with v, ts, e, sid and sn in sequence;
//     startup is timed and broken down (entitlement through decode); the
//     startup responses carry the CDN's own request id; the playback token
//     and the Analytics beacon session are the same sid; the collector kept
//     every report.
//  2. A second viewer: different CMCD on the same segment URLs, and the CDN
//     fetched each segment from the origin once.
//  3. A refused entitlement (the app's site list does not include this site)
//     is still a view: starting, the gate's code at the entitlement step,
//     fatal; no media request at all.
//  4. A failed licence (DASH with ClearKey, a licence server answering 500)
//     is still a view: the DRM step and Shaka's licence error code; the
//     licence request carried no CMCD.
//
//  Needs: DATABASE_URL, ffmpeg with libvpx, esbuild (volt-app's), volt-player
//  node_modules, playwright-core with a Chromium. The browser part SKIPS (and
//  says so) when one is missing. Usage: DATABASE_URL=... npx tsx test/cmcd-browser.check.ts
// ============================================================================
import { createServer as httpServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

let pass = 0, fail = 0, skipped = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d !== undefined ? ' -- ' + (typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 600) : ''}`); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => Promise<unknown>, timeoutMs: number, every = 150): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { if (await fn()) return Date.now() - t0; } catch { /* not yet */ } await sleep(every); }
  return -1;
}

(async () => {
  const ROOT = resolve(__dirname, '..');
  const PLAYER = resolve(ROOT, '../volt-player');
  let pw: any = null;
  try { pw = require(require.resolve('playwright-core', { paths: [ROOT, process.cwd(), ...(process.env.PLAYWRIGHT_CORE_DIR ? [process.env.PLAYWRIGHT_CORE_DIR] : [])] })); } catch { /* skip */ }
  const chromium = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  const haveFfmpeg = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout?.includes('libvpx-vp9');
  const haveCml = existsSync(join(PLAYER, 'node_modules/@svta/cml-cmcd'));
  const missing = [!pw && 'playwright-core (npm i --no-save playwright-core)', !haveFfmpeg && 'ffmpeg with libvpx-vp9', !haveCml && 'volt-player node_modules (npm install in volt-player)'].filter(Boolean);
  if (missing.length) { console.log(`SKIP: missing ${missing.join(', ')}`); console.log('\n0 passed, 0 failed (skipped)'); process.exit(0); }

  // ---- the stand-in CDN, on its own origin; its address is the CDN base the gate hands out ----
  const work = mkdtempSync(join(tmpdir(), 'cmcd-browser-'));
  process.env.QOE_RAW_DIR = join(work, 'qoe-raw');
  const cdnLog: { path: string; cmcd: string | null; cfId: string; method: string }[] = [];
  const originFetches = new Map<string, number>();
  const cache = new Map<string, Buffer>();
  const cdn = httpServer((q, res) => {
    const u = new URL(String(q.url), 'http://x');
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', '*');
    res.setHeader('access-control-allow-methods', 'GET, HEAD, POST, OPTIONS');
    // What the delivery response headers policy adds (deploy/terraform s3_cloudfront.tf).
    res.setHeader('access-control-expose-headers', 'x-amz-cf-id, x-amz-cf-pop, x-cache, age, cmsd-static, cmsd-dynamic');
    res.setHeader('timing-allow-origin', '*');
    const cfId = randomBytes(42).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    res.setHeader('x-amz-cf-id', cfId);
    res.setHeader('x-amz-cf-pop', 'SYD62-P1');
    if (q.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    cdnLog.push({ path: u.pathname, cmcd: u.searchParams.get('CMCD'), cfId, method: String(q.method) });
    if (u.pathname === '/lic') { res.statusCode = 500; return res.end('licence server down'); }
    // The protected asset's media arrives late, as an encrypted stream's
    // pictures do without a key: the licence is decided first.
    const hold = u.pathname.startsWith('/drm/b/') && !u.pathname.endsWith('.mpd') ? 4000 : 0;
    if (hold) { setTimeout(() => serve(u, res), hold); return; }
    serve(u, res);
  }).listen(0);
  function serve(u: URL, res: any) {
    // The cache key: the path alone, as query_string_behavior = "none" makes it.
    let body = cache.get(u.pathname);
    res.setHeader('x-cache', body ? 'Hit from cloudfront' : 'Miss from cloudfront');
    if (!body) {
      const f = join(work, 'origin', u.pathname.replace(/^\/+/, ''));
      if (!f.startsWith(join(work, 'origin')) || !existsSync(f)) { res.statusCode = 404; return res.end(); }
      body = readFileSync(f);
      originFetches.set(u.pathname, (originFetches.get(u.pathname) ?? 0) + 1);
      cache.set(u.pathname, body);
    }
    res.setHeader('content-type', u.pathname.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : u.pathname.endsWith('.mpd') ? 'application/dash+xml' : 'video/mp4');
    res.end(body);
  }
  const cdnUrl = `http://127.0.0.1:${(cdn.address() as any).port}`;
  process.env.CDN_BASE_URL = cdnUrl;

  const cml: any = await import(join(PLAYER, 'node_modules/@svta/cml-cmcd/dist/index.js'));
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { generateKey } = await import('../src/services/apiKeys');
  const { readSession } = await import('../src/services/qoe/rawStore');
  const { _analyticsInternals } = await import('../src/services/analytics');
  const jwt = require('jsonwebtoken');

  // ---- media: a VP9 HLS asset, and a DASH asset that announces ClearKey ----
  const origin = join(work, 'origin');
  mkdirSync(join(origin, 'vod/a'), { recursive: true });
  mkdirSync(join(origin, 'drm/b'), { recursive: true });
  const enc = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-t', '24',
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '300k', '-g', '50', '-keyint_min', '50',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', join(origin, 'vod/a/seg%d.m4s'), join(origin, 'vod/a/v.m3u8')], { encoding: 'utf8' });
  writeFileSync(join(origin, 'vod/a/master.m3u8'), '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-STREAM-INF:BANDWIDTH=360000,RESOLUTION=320x180,CODECS="vp09.00.10.08"\nv.m3u8\n');
  const enc2 = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-t', '8',
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '300k', '-g', '50', '-keyint_min', '50',
    // Really encrypted (encv/tenc in the init segment), so no frame can show before a licence.
    '-f', 'dash', '-dash_segment_type', 'mp4', '-seg_duration', '2', '-use_template', '1', '-use_timeline', '0',
    '-format_options', 'encryption_scheme=cenc-aes-ctr:encryption_key=00112233445566778899aabbccddeeff:encryption_kid=10000000100010001000100000000001',
    join(origin, 'drm/b/manifest.mpd')], { encoding: 'utf8' });
  // A common-system PSSH (version 1, one key id): ClearKey in Shaka and Chromium.
  const kid = Buffer.from('10000000100010001000100000000001', 'hex');
  const sysId = Buffer.from('1077efecc0b24d02ace33c1e52e2fb4b', 'hex');
  const pssh = Buffer.concat([Buffer.from([0, 0, 0, 52]), Buffer.from('pssh'), Buffer.from([1, 0, 0, 0]), sysId, Buffer.from([0, 0, 0, 1]), kid, Buffer.from([0, 0, 0, 0])]);
  let mpd = existsSync(join(origin, 'drm/b/manifest.mpd')) ? readFileSync(join(origin, 'drm/b/manifest.mpd'), 'utf8') : '';
  mpd = mpd.replace('<MPD ', '<MPD xmlns:cenc="urn:mpeg:cenc:2013" ').replace(/(<AdaptationSet[^>]*>)/, `$1
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc" cenc:default_KID="10000000-1000-1000-1000-100000000001"/>
      <ContentProtection schemeIdUri="urn:uuid:1077efec-c0b2-4d02-ace3-3c1e52e2fb4b"><cenc:pssh>${pssh.toString('base64')}</cenc:pssh></ContentProtection>`);
  writeFileSync(join(origin, 'drm/b/manifest.mpd'), mpd);
  ok(enc.status === 0 && existsSync(join(origin, 'vod/a/seg5.m4s')) && enc2.status === 0 && mpd.includes('cenc:pssh'), 'test media: 24 s VP9 HLS, and an 8 s VP9 DASH, encrypted, that announces ClearKey', (enc.stderr || '') + (enc2.stderr || ''));

  // ---- seed: an account, two on-demand assets, an app for this site and one for another site ----
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`cmcdb-${tag}`]))!.id;
  const vod = (await one<any>(`INSERT INTO vod_assets (account_id, source_kind, kind, title, master_key, formats, start_epoch_ms, end_epoch_ms, duration_ms, metadata, published)
    VALUES ($1,'upload','clip','Test card','vod/a','{"hls":true,"dash":false}',0,24000,24000,'{}',true) RETURNING id`, [acct]))!.id;
  const drmVod = (await one<any>(`INSERT INTO vod_assets (account_id, source_kind, kind, title, master_key, formats, start_epoch_ms, end_epoch_ms, duration_ms, metadata, published)
    VALUES ($1,'upload','clip','Protected','drm/b','{"hls":false,"dash":true}',0,8000,8000,'{}',true) RETURNING id`, [acct]))!.id;
  const mkApp = async (restrictions: any) => {
    const app = await one<any>(`INSERT INTO apps(account_id, name, type, restrictions) VALUES ($1,'Web','web',$2) RETURNING id`, [acct, JSON.stringify(restrictions)]);
    const k = generateKey('publishable');
    await query(`INSERT INTO api_keys(account_id, app_id, kind, key_prefix, key_hash, scopes) VALUES ($1,$2,'publishable',$3,$4,'{playback}')`, [acct, app!.id, k.prefix, k.hash]);
    return k.raw;
  };
  const key = await mkApp({});
  const keyElsewhere = await mkApp({ origins: ['https://elsewhere.example'] });

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;

  const esbuild = require(require.resolve('esbuild', { paths: [ROOT] }));
  const bundle = esbuild.buildSync({ entryPoints: [join(PLAYER, 'src/index.ts')], bundle: true, format: 'iife', globalName: 'VoltPlayer',
    write: false, target: 'es2018', logLevel: 'silent', nodePaths: [join(PLAYER, 'node_modules')] }).outputFiles[0].text;
  const page = (opts: Record<string, unknown>) => `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#000">
<div id="p" style="width:640px;height:360px"></div><script src="/volt-player.js"></script>
<script>VoltPlayer.create(Object.assign({ el: '#p', apiBase: ${JSON.stringify(base)}, autoplay: true, muted: true }, ${JSON.stringify(opts)}))
  .then(function (p) { window.vp = p; window.sid0 = p.sessionId; }, function (e) { window.createError = String(e); });</script></body></html>`;
  const pages: Record<string, string> = {
    '/play': page({ appKey: key, assetId: vod, cmcd: { app: 'Volt test site', appVersion: '3.1.4' } }),
    '/refused': page({ appKey: keyElsewhere, assetId: vod }),
    '/drm': page({ appKey: key, assetId: drmVod, drm: { servers: { 'org.w3.clearkey': `${cdnUrl}/lic` } } }),
  };
  const site = httpServer((q, res) => {
    const u = String(q.url).split('?')[0];
    if (pages[u]) { res.setHeader('content-type', 'text/html'); return res.end(pages[u]); }
    if (u === '/volt-player.js') { res.setHeader('content-type', 'text/javascript'); return res.end(bundle); }
    res.statusCode = 404; res.end();
  }).listen(0);
  const siteUrl = `http://127.0.0.1:${(site.address() as any).port}`;

  let browser: any = null;
  try {
    browser = await pw.chromium.launch({ executablePath: chromium, args: ['--autoplay-policy=no-user-gesture-required'] });
    const open = async (path: string) => {
      const ctx = await browser.newContext({ viewport: { width: 700, height: 400 } });
      const pg = await ctx.newPage();
      const posts: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
      const gate: any[] = [];
      const errors: string[] = [];
      pg.on('pageerror', (e: any) => errors.push(String(e?.message ?? e)));
      pg.on('request', (r: any) => { if (r.url().startsWith(base + '/api/cmcd') && r.method() === 'POST') posts.push({ url: r.url(), method: r.method(), headers: r.headers(), body: r.postData() ?? '' }); });
      pg.on('response', async (r: any) => { if (r.url().startsWith(base + '/api/availability')) gate.push({ status: r.status(), body: await r.json().catch(() => null) }); });
      await pg.goto(siteUrl + path);
      return { ctx, pg, posts, gate, errors };
    };
    const linesOf = (posts: { body: string }[]) => posts.flatMap((p) => p.body.split('\n').filter(Boolean));
    const decoded = (posts: { body: string }[]) => linesOf(posts).map((l) => cml.decodeCmcd(l));
    const VK = 'com.volt-';

    console.log('== 1. a viewer plays: request mode, event mode, one sid ==');
    const A = await open('/play');
    const played = await until(() => A.pg.evaluate(() => { const v = document.querySelector('video') as HTMLVideoElement | null; return !!v && v.currentTime > 2; }), 30_000);
    ok(played >= 0, `the asset plays through the gate and the CDN (${played} ms)`, await A.pg.evaluate(() => (window as any).vp?.getState?.().error ?? (window as any).createError));
    const sidA: string = await A.pg.evaluate(() => (window as any).vp.sessionId);
    ok(/^[0-9a-f-]{36}$/.test(sidA), 'the attempt has a UUID sid (player.sessionId)', sidA);
    const reqA = cdnLog.filter((r) => r.cmcd && cml.decodeCmcd(r.cmcd).sid === sidA);
    const mediaA = cdnLog.filter((r) => r.path.startsWith('/vod/a/'));
    ok(mediaA.length >= 6 && reqA.length === mediaA.length, `every playlist and segment request carried CMCD (${reqA.length} of ${mediaA.length})`);
    const invalid = reqA.map((r) => cml.validateCmcd(cml.decodeCmcd(r.cmcd!), { reportingMode: 'request' })).filter((v: any) => !v.valid);
    ok(invalid.length === 0, `all ${reqA.length} are valid CMCD v2 request mode (library validator)`, invalid[0]);
    const dA = reqA.map((r) => ({ path: r.path, ...cml.decodeCmcd(r.cmcd!) }));
    ok(dA.every((d: any) => d.v === 2 && d.cid === vod && d.sf === 'h' && d.st === 'v'), 'each: v=2, cid = the asset, sf=h, st=v', dA[0]);
    const ot = (p: string) => dA.find((d: any) => d.path.endsWith(p))?.ot;
    ok(ot('master.m3u8') === 'm' && ot('v.m3u8') === 'm' && ot('init.mp4') === 'i' && ot('seg0.m4s') === 'v', 'object types: playlists m, init i, segments v', dA.map((d: any) => [d.path.split('/').pop(), d.ot]));
    const seg0 = dA.find((d: any) => d.path.endsWith('seg0.m4s')) as any;
    ok(seg0?.su === true, 'the first segment: su (startup)', seg0);
    const late = dA.filter((d: any) => /seg(9|1\d)\.m4s$/.test(d.path));
    ok(late.length > 0 && late.every((d: any) => !d.su && Array.isArray(d.bl) && JSON.stringify(d.br).includes('360') && JSON.stringify(d.tb).includes('360')),
      'later segments: no su, the buffer length (bl), br and tb 360 kbps from the playlist', late.slice(0, 2));

    await A.pg.evaluate(() => (window as any).vp.pause());
    await sleep(300);
    await A.pg.evaluate(() => (window as any).vp.destroy());
    await until(async () => decoded(A.posts).some((d: any) => d.sta === 'q'), 10_000);
    const evA = decoded(A.posts);
    const reportOk = A.posts.map((p) => cml.validateCmcdEventReport({ url: p.url, method: p.method, headers: { 'content-type': p.headers['content-type'] }, body: p.body }));
    ok(A.posts.length >= 2 && reportOk.every((v: any) => v.valid), `${A.posts.length} event POSTs, each a valid application/cmcd event report (library validator)`, reportOk.find((v: any) => !v.valid)?.issues);
    ok(evA.every((d: any) => d.v === 2 && typeof d.ts === 'number' && d.e && d.sid === sidA && Number.isInteger(d.sn)), 'every report: v, ts, e, sid (this attempt), sn');
    const sns = evA.map((d: any) => d.sn).sort((a: number, b: number) => a - b);
    ok(sns.every((n: number, i: number) => n === i + 1), `sn 1 to ${sns.length} with no gap`, sns);
    const states = evA.filter((d: any) => d.e === 'ps').sort((a: any, b: any) => a.sn - b.sn).map((d: any) => d.sta).join(' ');
    ok(/^s p .*a q$/.test(states) && !states.includes('r'), 'play states: starting, playing, ..., paused, quit; no rebuffering', states);
    const ff = evA.find((d: any) => d.e === 'ps' && d.sta === 'p') as any;
    const spans = ['tent', 'tman', 'tseg', 'tdec', 'toth'].map((k) => Number(ff?.[VK + k]));
    ok(ff && ff.msd > 0 && spans.every((x) => Number.isFinite(x) && x >= 0) && Number(ff[VK + 'tent']) > 0 && spans.reduce((a, b) => a + b, 0) === ff.msd,
      `first frame after ${ff?.msd} ms: entitlement ${spans[0]}, manifest ${spans[1]}, first segment ${spans[2]}, decode ${spans[3]}, other ${spans[4]} (they add up)`, ff);
    const first = evA.find((d: any) => d.sn === 1) as any;
    ok(first?.[VK + 'app'] === 'Volt test site' && first[VK + 'appv'] === '3.1.4' && first[VK + 'sdkv'] && first[VK + 'dm'], 'the first report names the app, its version, the SDK version and the device', first);
    const rr = evA.filter((d: any) => d.e === 'rr');
    const joined = rr.filter((d: any) => cdnLog.some((r) => r.cfId === d[VK + 'cfid'] && d.url.endsWith(r.path)));
    ok(rr.length >= 3 && joined.length === rr.length, `the startup responses (${rr.length}) carry the CDN's own x-amz-cf-id for that request, read across origins (they join the CDN log)`, rr.slice(0, 2));
    ok(rr.every((d: any) => !String(d.url).includes('CMCD') && d.rc === 200 && typeof d.ttlb === 'number'), 'rr: the URL without its CMCD, status 200, ttlb', rr[0]);
    const tok = A.gate[0]?.body?.playbackToken;
    ok(A.gate[0]?.status === 200 && jwt.decode(tok)?.sid === sidA, 'the play gate was told the sid: it is in the playback token', jwt.decode(tok ?? ''));
    await _analyticsInternals.flushSessions();
    const ps = await one<any>(`SELECT session_key FROM play_sessions WHERE account_id=$1 AND session_key=$2`, [acct, sidA]);
    ok(!!ps, 'the Analytics beacon session is the same sid (play_sessions.session_key)', ps);
    const kept = await readSession(acct, sidA);
    ok(kept.length === linesOf(A.posts).length && kept.length === evA.length, `the collector kept every report raw (${kept.length})`, [kept.length, evA.length]);

    console.log('== 2. a second viewer: different CMCD, one cached copy ==');
    const B = await open('/play');
    const playedB = await until(() => B.pg.evaluate(() => { const v = document.querySelector('video') as HTMLVideoElement | null; return !!v && v.currentTime > 2; }), 30_000);
    const sidB: string = await B.pg.evaluate(() => (window as any).vp.sessionId);
    ok(playedB >= 0 && sidB !== sidA, 'a second viewer plays with its own sid', [playedB, sidB]);
    const both = ['/vod/a/init.mp4', '/vod/a/seg0.m4s', '/vod/a/seg1.m4s'];
    const bySid = (p: string) => new Set(cdnLog.filter((r) => r.path === p && r.cmcd).map((r) => cml.decodeCmcd(r.cmcd!).sid));
    ok(both.every((p) => bySid(p).has(sidA) && bySid(p).has(sidB)), 'both viewers asked for the same segment URLs, each with its own CMCD');
    ok(both.every((p) => originFetches.get(p) === 1), 'and the CDN fetched each from the origin once: the cache key ignores CMCD', both.map((p) => [p, originFetches.get(p)]));
    await B.pg.evaluate(() => (window as any).vp.destroy());
    await B.ctx.close();

    console.log('== 3. a refused entitlement is still a view ==');
    const before = cdnLog.length;
    const C = await open('/refused');
    await until(() => C.pg.evaluate(() => (window as any).vp?.getState().status === 'error'), 15_000);
    await until(async () => decoded(C.posts).some((d: any) => d.sta === 'f'), 10_000);
    const evC = decoded(C.posts).sort((a: any, b: any) => a.sn - b.sn);
    const sidC: string = await C.pg.evaluate(() => (window as any).vp.sessionId);
    ok(C.gate[0]?.status === 403, 'the gate refused (this site is not on the app\'s list): 403', C.gate[0]);
    ok(evC.map((d: any) => d.e + (d.sta ? ':' + d.sta : '')).join(' ') === 'ps:s e ps:f', 'reported: starting, the error, fatal', evC.map((d: any) => [d.e, d.sta]));
    const eC = evC.find((d: any) => d.e === 'e') as any;
    ok(JSON.stringify(eC?.ec) === '["gate-403"]' && eC[VK + 'step'] === 'entitlement' && eC.su === true && eC.sid === sidC, 'the code (gate-403), the step (entitlement), before the first frame (su)', eC);
    ok(cdnLog.length === before, 'and no media request was made');
    ok(C.posts.every((p) => cml.validateCmcdEventReport({ url: p.url, method: p.method, headers: { 'content-type': p.headers['content-type'] }, body: p.body }).valid) && (await readSession(acct, sidC)).length === 3,
      'valid reports, kept by the collector for the app\'s account even though playback was refused');
    await C.ctx.close();

    console.log('== 4. a failed licence is still a view ==');
    const D = await open('/drm');
    await until(() => D.pg.evaluate(() => (window as any).vp?.getState().status === 'error'), 20_000);
    await until(async () => decoded(D.posts).some((d: any) => d.sta === 'f'), 10_000);
    const evD = decoded(D.posts).sort((a: any, b: any) => a.sn - b.sn);
    const sidD: string = await D.pg.evaluate(() => (window as any).vp.sessionId);
    const lic = cdnLog.filter((r) => r.path === '/lic' && r.method === 'POST');
    ok(lic.length >= 1 && lic.every((r) => r.cmcd == null), `the player asked the licence server (${lic.length} POST), with no CMCD on it`, lic);
    const mpdReq = cdnLog.find((r) => r.path === '/drm/b/manifest.mpd' && r.cmcd);
    ok(mpdReq && cml.decodeCmcd(mpdReq.cmcd!).sid === sidD && cml.decodeCmcd(mpdReq.cmcd!).sf === 'd' && cml.decodeCmcd(mpdReq.cmcd!).ot === 'm', 'the MPD request carried this attempt\'s CMCD', mpdReq);
    const eD = evD.find((d: any) => d.e === 'e') as any;
    ok(eD && JSON.stringify(eD.ec) === '["shaka-6007"]' && eD[VK + 'step'] === 'drm' && evD[evD.length - 1].sta === 'f', 'reported: Shaka 6007 (licence request failed) at the DRM step, then fatal', evD.map((d: any) => [d.e, d.sta, d.ec, d[VK + 'step']]));
    ok(!evD.some((d: any) => d.e === 'ps' && d.sta === 'p'), 'never a first frame');
    ok((await readSession(acct, sidD)).length === evD.length, 'kept by the collector');
    const errs = [...A.errors, ...D.errors].filter((e) => !/codec|decode/i.test(e));
    ok(errs.length === 0, 'no page errors', errs);
  } catch (e) {
    fail++; console.log('FAIL unexpected: ' + ((e as Error).stack ?? e));
  } finally {
    try { await browser?.close(); } catch { /* */ }
    site.close(); cdn.close(); srv.close();
    await pool.end().catch(() => {});
    if (!process.env.KEEP_WORK) try { rmSync(work, { recursive: true, force: true }); } catch { /* */ }
  }
  console.log(`\n${pass} passed, ${fail} failed${skipped ? ' (browser part skipped)' : ''}`);
  process.exit(fail ? 1 : 0);
})();
