// ============================================================================
//  CONCURRENT STREAMS IN THE VOLT PLAYER, in a real browser (build queue
//  P3-4d-2; volt-player/src/sdk/beacons.ts and player.ts).
//
//  The real player SDK bundled from volt-player/src plays an on-demand VP9 HLS
//  title through a stand-in play gate and beacon endpoint that answer the way
//  the control plane does (modules/apps.ts, modules/analytics.ts; the server
//  side is publishing-concurrent-streams.check.ts):
//    - a heartbeat answered with `stop` stops playback, stops fetching, shows
//      the words and offers Play here; no `end` is sent for the stopped play;
//    - Play here asks the gate again with a NEW sid and plays;
//    - the gate's 409 mode "stopped" shows the same words and Play here;
//    - the player sends `end` when the page is hidden and when it is closed;
//    - screenshots of the stopped player at 1440 and 390 px wide.
//
//  Needs ffmpeg with libvpx-vp9, esbuild (volt-app's own), shaka-player in
//  volt-player, and Playwright with a Chromium; any missing piece SKIPS the
//  browser part and says so. Screenshots go to SHOT_DIR when it is set.
//    npx tsx test/player-concurrent-stop-browser.check.ts
// ============================================================================
import { createServer as httpServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let pass = 0, fail = 0, skipped = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => Promise<unknown>, timeoutMs: number, every = 200): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (await fn()) return Date.now() - t0; } catch { /* not yet */ }
    await sleep(every);
  }
  return -1;
}

const STOP_WORDS = 'Playback stopped because this account is playing on too many devices.';

(async () => {
  const ROOT = resolve(__dirname, '..');
  const PLAYER = resolve(ROOT, '../volt-player');
  let pw: any = null;
  for (const name of ['playwright-core', 'playwright']) {
    if (pw) break;
    try { pw = require(require.resolve(name, { paths: [ROOT, process.cwd(), ...(process.env.PLAYWRIGHT_CORE_DIR ? [process.env.PLAYWRIGHT_CORE_DIR] : [])] })); } catch { /* next */ }
  }
  const chromium = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  const haveFfmpeg = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout?.includes('libvpx-vp9');
  const haveShaka = existsSync(join(PLAYER, 'node_modules/shaka-player'));
  const missing = [!pw && 'playwright-core', !haveFfmpeg && 'ffmpeg with libvpx-vp9', !haveShaka && 'volt-player node_modules'].filter(Boolean);
  if (missing.length) {
    skipped = 1;
    console.log(`SKIP the browser part: missing ${missing.join(', ')}`);
    console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
    process.exit(0);
  }

  let work = '', site: any = null, browser: any = null;
  try {
    work = mkdtempSync(join(tmpdir(), 'cs-player-'));
    const enc = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-t', '90',
      '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '200k', '-g', '50', '-keyint_min', '50',
      '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', join(work, 'seg%d.m4s'), join(work, 'index.m3u8')], { encoding: 'utf8' });
    ok(enc.status === 0 && existsSync(join(work, 'seg20.m4s')), '90 s of VP9 test picture in 2 s fMP4 segments', enc.stderr?.slice(0, 300));

    // ---- a stand-in play gate and beacon endpoint, answering as the control plane does ----
    const gateSids: Array<string | null> = [];
    const beacons: Array<{ event: string; sessionId: string }> = [];
    const stopSids = new Set<string>();        // heartbeats of these are answered with stop
    const refuseSids = new Set<string>();      // the gate answers these 409 mode stopped
    let segAfter = 0, counting = false;
    const json = (res: any, code: number, o: any) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    const body = (q: any) => new Promise<any>((r) => { let b = ''; q.on('data', (c: any) => (b += c)); q.on('end', () => { try { r(JSON.parse(b)); } catch { r({}); } }); });

    const esbuild = require(require.resolve('esbuild', { paths: [ROOT] }));
    const bundle = esbuild.buildSync({ entryPoints: [join(PLAYER, 'src/index.ts')], bundle: true, format: 'iife', globalName: 'VoltPlayer',
      write: false, target: 'es2018', logLevel: 'silent', nodePaths: [join(PLAYER, 'node_modules')] }).outputFiles[0].text;
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#111"><div id="p" style="width:100%;max-width:960px;aspect-ratio:16/9;margin:0 auto"></div>
<script src="/volt-player.js"></script>
<script>window.events = [];
VoltPlayer.create({ el: '#p', appKey: 'pk_test_concurrent', apiBase: location.origin, autoplay: true, muted: true,
  onEvent: function (n, d) { if (n === 'stopped') window.events.push({ n: n, d: d }); },
  item: { id: 'film-1', assetId: 'film-1', title: 'Members film' } }).then(function (p) { window.vp = p; });</script></body></html>`;
    site = httpServer(async (q, res) => {
      const u = String(q.url).split('?')[0];
      if (u === '/') { res.setHeader('content-type', 'text/html'); return res.end(html); }
      if (u === '/volt-player.js') { res.setHeader('content-type', 'text/javascript'); return res.end(bundle); }
      if (u === '/api/availability' && q.method === 'POST') {
        const b = await body(q);
        const sid = typeof b.sid === 'string' ? b.sid : null;
        gateSids.push(sid);
        if (sid && refuseSids.has(sid)) {
          return json(res, 409, { available: false, mode: 'stopped', code: 'concurrent_streams', error: STOP_WORDS, reason: STOP_WORDS, message: 'Playing on too many devices', limit: 1 });
        }
        return json(res, 200, { available: true, mode: 'play', assetId: 'film-1', playbackToken: `pt-${gateSids.length}`, expiresIn: 120,
          delivery: { hls: `/vod/film-1/index.m3u8`, dash: null }, sid: sid ?? `cs-gate-${gateSids.length}`, streams: { limit: 1, open: 1, stopped: 0 },
          meta: { title: 'Members film', live: false, kind: 'vod' } });
      }
      if (u === '/api/analytics/beacon' && q.method === 'POST') {
        const b = await body(q);
        beacons.push({ event: b.event, sessionId: b.sessionId });
        if (stopSids.has(b.sessionId)) return json(res, 202, { ok: true, stop: { code: 'concurrent_streams', message: STOP_WORDS } });
        return json(res, 202, { ok: true });
      }
      if (u.startsWith('/api/')) { res.statusCode = 204; return res.end(); }
      const m = /^\/vod\/film-1\/(index\.m3u8|init\.mp4|seg\d+\.m4s)$/.exec(u);
      if (m && existsSync(join(work, m[1]))) {
        if (counting && m[1].startsWith('seg')) segAfter++;
        res.setHeader('content-type', m[1].endsWith('m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4');
        return res.end(readFileSync(join(work, m[1])));
      }
      res.statusCode = 404; res.end();
    }).listen(0);
    const siteUrl = `http://127.0.0.1:${(site.address() as any).port}`;
    browser = await pw.chromium.launch({ executablePath: chromium, args: ['--autoplay-policy=no-user-gesture-required'] });
    const shotDir = process.env.SHOT_DIR || '';

    const open = async (width: number, height: number) => {
      const page = await browser.newPage({ viewport: { width, height } });
      const errs: string[] = [];
      page.on('pageerror', (e: any) => errs.push(String(e?.message ?? e)));
      await page.goto(siteUrl + '/');
      return { page, errs };
    };
    const playing = (page: any) => page.evaluate(() => { const v = document.querySelector('video') as HTMLVideoElement | null; return !!v && !v.paused && v.currentTime > 0.5; });
    const sidOf = (page: any) => page.evaluate(() => (window as any).vp?.sessionId ?? null);
    const msgOf = (page: any) => page.evaluate(() => {
      const m = document.querySelector('.vpv-msg') as HTMLElement | null;
      const b = m?.querySelector('button') as HTMLElement | null;
      return { visible: !!m && m.offsetParent !== null && getComputedStyle(m).display !== 'none' && !m.hidden, text: m?.textContent ?? '', button: b && !b.hidden ? b.textContent : null };
    });

    // ================= a heartbeat answered with stop =================
    console.log('== a heartbeat answered with stop ==');
    const A = await open(1440, 900);
    ok((await until(() => playing(A.page), 30_000)) >= 0, 'the title plays through the play gate');
    const sid1 = await sidOf(A.page);
    ok(typeof sid1 === 'string' && gateSids[0] === sid1, 'the gate was asked with the play attempt\'s sid', `${sid1} / ${gateSids[0]}`);
    ok((await until(async () => beacons.some((b) => b.event === 'start' && b.sessionId === sid1), 10_000)) >= 0, 'the start beacon carries the same sid');
    stopSids.add(sid1);
    const tStop = Date.now();
    const stoppedIn = await until(async () => (await A.page.evaluate(() => (window as any).vp.getState().access.mode)) === 'stopped', 40_000, 250);
    ok(stoppedIn >= 0, `the next heartbeat's stop answer stops the play (${Math.round((Date.now() - tStop) / 1000)} s, heartbeats every 30 s)`);
    const st = await A.page.evaluate(() => { const s = (window as any).vp.getState(); const v = document.querySelector('video') as HTMLVideoElement; return { status: s.status, error: s.error, code: s.errorCode, playing: s.playing, paused: v.paused }; });
    ok(st.status === 'error' && st.paused && !st.playing && st.code === 'concurrent_streams', 'playback stopped: the video is paused, the state says why', JSON.stringify(st));
    ok(st.error === STOP_WORDS, 'the state carries the server\'s words', String(st.error));
    const m1 = await msgOf(A.page);
    ok(m1.visible && m1.text.includes(STOP_WORDS), 'the player shows the words', JSON.stringify(m1));
    ok(m1.button === 'Play here', 'with a Play here button (not Try again)', String(m1.button));
    ok((await A.page.evaluate(() => (window as any).events.length)) === 1 && (await A.page.evaluate(() => (window as any).events[0].d.code)) === 'concurrent_streams',
      'the host page gets one `stopped` event with the code');
    counting = true; segAfter = 0;
    const beatsAt = beacons.length;
    await sleep(4000);
    ok(segAfter === 0, 'nothing more is fetched once stopped', `${segAfter} segment(s)`);
    ok(!beacons.slice(beatsAt).some((b) => b.sessionId === sid1) && !beacons.some((b) => b.sessionId === sid1 && b.event === 'end'),
      'no more beacons for the stopped play, and no end (the server closed it)');
    counting = false;
    if (shotDir) await A.page.screenshot({ path: join(shotDir, 'player-stopped-1440.png') });

    // ================= Play here =================
    console.log('== Play here ==');
    const gatesBefore = gateSids.length;
    await A.page.click('.vpv-msg button');
    ok((await until(() => playing(A.page), 30_000)) >= 0, 'Play here plays again');
    const sid2 = await sidOf(A.page);
    ok(gateSids.length === gatesBefore + 1 && gateSids[gatesBefore] === sid2 && sid2 !== sid1, 'it asked the gate again with a NEW sid', `${sid1} -> ${sid2}; asked ${JSON.stringify(gateSids.slice(gatesBefore))}`);
    ok((await A.page.evaluate(() => (window as any).vp.getState().access.mode)) !== 'stopped', 'the stopped state is gone');

    // ================= end on page hide and on close =================
    console.log('== end on page hide and close ==');
    await A.page.evaluate(() => dispatchEvent(new Event('pagehide')));
    ok((await until(async () => beacons.some((b) => b.event === 'end' && b.sessionId === sid2), 5_000)) >= 0, 'page hide sends end for the open play');
    await A.page.close();
    const C = await open(1440, 900);
    ok((await until(() => playing(C.page), 30_000)) >= 0, 'a fresh page plays');
    const sid3 = await sidOf(C.page);
    await until(async () => beacons.some((b) => b.event === 'start' && b.sessionId === sid3), 10_000);
    await C.page.close({ runBeforeUnload: true });
    ok((await until(async () => beacons.some((b) => b.event === 'end' && b.sessionId === sid3), 5_000)) >= 0, 'closing the page sends end');

    // ================= the gate's 409 =================
    console.log('== the gate\'s 409 mode stopped ==');
    // The gate answers 409 mode "stopped" (as it does a stopped sid asking again, e.g.
    // a player that kept its sid): the player shows it as stopped, at phone width.
    const before409 = gateSids.length;
    const origHas = refuseSids.has.bind(refuseSids);
    (refuseSids as any).has = () => true;
    const B = await open(390, 844);
    const shown = await until(async () => (await B.page.evaluate(() => (window as any).vp?.getState().access.mode)) === 'stopped', 15_000);
    (refuseSids as any).has = origHas;
    ok(gateSids.length > before409 && shown >= 0, 'a 409 mode "stopped" from the gate shows the player as stopped', JSON.stringify({ asked: gateSids.slice(before409) }));
    ok(await B.page.evaluate(() => { const v = document.querySelector('video') as HTMLVideoElement | null; return !v || v.paused; }), 'and nothing plays');
    const m2 = await msgOf(B.page);
    ok(m2.visible && m2.text.includes(STOP_WORDS) && m2.button === 'Play here', 'the 409\'s full words (its reason) and Play here', JSON.stringify(m2));
    const fits = await B.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    ok(fits, 'at 390 px the page does not scroll sideways');
    const msgBox = await B.page.evaluate(() => { const r = (document.querySelector('.vpv-msg') as HTMLElement).getBoundingClientRect(); const p = (document.querySelector('#p') as HTMLElement).getBoundingClientRect(); return { l: r.left >= p.left - 1, r: r.right <= p.right + 1 }; });
    ok(msgBox.l && msgBox.r, 'at 390 px the message fits inside the player', JSON.stringify(msgBox));
    if (shotDir) await B.page.screenshot({ path: join(shotDir, 'player-stopped-390.png') });
    const refusedSid = gateSids[gateSids.length - 1];
    const gb = gateSids.length;
    await B.page.click('.vpv-msg button');
    ok((await until(() => playing(B.page), 30_000)) >= 0, 'Play here after the 409 plays');
    ok(gateSids.length === gb + 1 && gateSids[gb] !== refusedSid && gateSids[gb] === await sidOf(B.page), 'with a new sid', JSON.stringify(gateSids.slice(gb - 1)));
    ok([...A.errs, ...B.errs, ...C.errs].length === 0, 'no page errors', [...A.errs, ...B.errs, ...C.errs].join(' | '));
  } catch (e: any) {
    console.log('FAIL threw: ' + (e?.stack ?? e)); fail++;
  } finally {
    try { await browser?.close(); } catch { /* */ }
    try { site?.close(); } catch { /* */ }
    if (work) rmSync(work, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  process.exit(fail ? 1 : 0);
})();
