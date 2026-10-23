// ============================================================================
//  PLAYBACK STATS IN A REAL BROWSER (docs/PLAYER_SDK.md section 12).
//
//  The SDK bundled from volt-player/src plays an HLS stream (made here with
//  ffmpeg) in Chromium, from a little server that answers like a CDN
//  (x-amz-cf-pop, x-cache). Then: Shift+D opens the panel and every row says
//  what is really playing; right-click gives the player's menu; Copy debug
//  info puts a token-free report on the clipboard; × closes it; the admin
//  skin's Stats button drives the same panel; debug:false hands right-click
//  back to the browser; and the console's hls.js monitors get the same panel
//  through attachStats + hlsJsProbe.
//
//  The rules behind the rows are player-stats.check.ts.
//
//  Needs ffmpeg (libx264), esbuild (volt-app's own), shaka-player installed in
//  volt-player, hls.js in volt-web (part 4 only), and playwright-core with a
//  Chromium. Anything missing SKIPS, and says so:
//    npm i --no-save playwright-core          (in volt-app)
//    CHROMIUM_PATH=/path/to/chrome            (optional; else Playwright's own)
//  Usage: npx tsx test/player-stats-browser.check.ts
// ============================================================================
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ' -- ' + JSON.stringify(d) : '')); } };
const skip = (why: string) => { console.log(`SKIP player-stats-browser: ${why}`); process.exit(0); };
declare const window: any, document: any, navigator: any, VoltPlayer: any, VoltStats: any, Hls: any;

const ROOT = path.resolve(__dirname, '..');
const PLAYER = path.resolve(ROOT, '../volt-player');
const HLSJS = path.resolve(ROOT, '../volt-web/node_modules/hls.js/dist/hls.min.js');
const DASHJS = path.resolve(ROOT, '../volt-web/node_modules/dashjs/dist/dash.all.min.js');

let pw: any = null;
try { pw = require(require.resolve('playwright-core', { paths: [ROOT, process.cwd(), ...(process.env.PLAYWRIGHT_CORE_DIR ? [process.env.PLAYWRIGHT_CORE_DIR] : [])] })); } catch { /* */ }
if (!pw) skip('playwright-core is not installed (npm i --no-save playwright-core)');
if (spawnSync('ffmpeg', ['-version']).status !== 0) skip('ffmpeg is not on the PATH');
if (!fs.existsSync(path.join(PLAYER, 'node_modules/shaka-player'))) skip('shaka-player is not installed in volt-player');

const WWW = fs.mkdtempSync(path.join(os.tmpdir(), 'volt-stats-'));
const esb = (entry: string, name: string, out: string) => spawnSync('npx', ['esbuild', entry, '--bundle', '--format=iife', `--global-name=${name}`, `--outfile=${path.join(WWW, out)}`, '--log-level=warning'], { cwd: PLAYER, stdio: 'inherit', env: { ...process.env, PATH: `${path.join(ROOT, 'node_modules/.bin')}:${process.env.PATH}` } }).status === 0;
if (!esb('src/index.ts', 'VoltPlayer', 'volt-player.js') || !esb('src/sdk/stats.ts', 'VoltStats', 'volt-stats.js')) skip('esbuild could not bundle the SDK');
const hasHlsJs = fs.existsSync(HLSJS);
if (hasHlsJs) fs.copyFileSync(HLSJS, path.join(WWW, 'hls.min.js'));
const ff = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000', '-t', '40',
  '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-g', '60', '-c:a', 'aac', '-ac', '2', '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod',
  '-hls_segment_filename', path.join(WWW, 'seg%03d.ts'), path.join(WWW, 'vod.m3u8')], { stdio: 'inherit' });
if (ff.status !== 0) skip('ffmpeg could not make the test stream (needs libx264)');
// The same picture as DASH, two renditions, for Shaka and dash.js.
fs.mkdirSync(path.join(WWW, 'dash'));
const hasDash = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000', '-t', '40',
  '-map', '0:v', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
  '-b:v:0', '2500k', '-s:v:0', '1280x720', '-b:v:1', '800k', '-s:v:1', '640x360', '-c:a', 'aac', '-ac', '2',
  '-f', 'dash', '-seg_duration', '4', '-use_template', '1', '-use_timeline', '0', '-adaptation_sets', 'id=0,streams=v id=1,streams=a',
  path.join(WWW, 'dash/manifest.mpd')], { stdio: 'inherit' }).status === 0;
const hasDashJs = hasDash && fs.existsSync(DASHJS);
if (hasDashJs) fs.copyFileSync(DASHJS, path.join(WWW, 'dash.all.min.js'));
fs.writeFileSync(path.join(WWW, 'master.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.640028,mp4a.40.2",FRAME-RATE=30\nvod.m3u8\n');
const shots = process.env.STATS_SCREENSHOTS || null;

const srv = http.createServer((req, res) => {
  const p = path.join(WWW, decodeURIComponent((req.url || '/').split('?')[0]));
  if (req.url === '/' || !fs.existsSync(p)) { res.writeHead(req.url === '/' ? 200 : 404, { 'content-type': 'text/html' }); res.end('<!doctype html><body style="margin:0;background:#222"><div id="p" style="width:960px"></div></body>'); return; }
  const type = p.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : p.endsWith('.ts') ? 'video/mp2t' : p.endsWith('.mpd') ? 'application/dash+xml' : p.endsWith('.m4s') ? 'video/iso.segment' : 'application/javascript';
  res.writeHead(200, { 'content-type': type, 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-amz-cf-pop, x-cache',
    'x-amz-cf-pop': 'TEST1-P1', 'x-cache': 'Hit from testcdn' });
  fs.createReadStream(p).pipe(res);
}).listen(0, async () => {
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const browser = await pw.chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  // tsx compiles the evaluate() callbacks with esbuild's keepNames, which calls __name in the page.
  await ctx.addInitScript('window.__name = (f) => f');
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const page = await ctx.newPage();
  page.on('pageerror', (e: any) => console.log('pageerror', e.message));
  try {
    // ---- 1. the video skin: Shift+D, the rows, the menu, copy, close ----
    await page.goto(base + '/');
    await page.addScriptTag({ url: base + '/volt-player.js' });
    await page.evaluate(async (b) => {
      window.events = [];
      window.p = await VoltPlayer.VoltPlayer.create({ el: '#p', skin: 'video', source: { url: b + '/master.m3u8?token=SECRET123' }, autoplay: true, muted: true, beacons: false, cast: false, airplay: false,
        onEvent: (n, d) => { if (n === 'statschange') window.events.push(d); } });
    }, base);
    await page.waitForFunction(() => window.p.getState().status === 'playing' && window.p.media.currentTime > 3, null, { timeout: 30000 });
    ok(await page.locator('.vp-stats').count() === 0, 'nothing is built until the panel is first opened');
    await page.focus('.vp');
    await page.keyboard.press('Shift+D');
    await page.waitForTimeout(2600);
    ok(await page.locator('.vp-stats').isVisible(), 'Shift+D opens the playback stats panel');
    ok(await page.evaluate(() => window.p.getState().stats === true && window.events[0] === true), 'state.stats and the statschange event follow');
    const rows = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.vp-stats-k')].map((k) => [k.textContent, k.nextElementSibling.textContent])));
        ok(/^1280×720@30 \//.test(rows['Current / Optimal Res'] || ''), 'current resolution and frame rate of the playing rendition', rows['Current / Optimal Res']);
    ok(/H\.264 High L4 \(avc1\.640028\)/.test(rows['Codecs'] || '') && /AAC-LC/.test(rows['Codecs'] || ''), 'codecs named', rows['Codecs']);
    ok(/dropped of \d+/.test(rows['Viewport / Frames'] || '') && /^960×/.test(rows['Viewport / Frames']), 'viewport and decoded frames', rows['Viewport / Frames']);
    ok(parseFloat(rows['Buffer Health']) > 1, 'buffer health in seconds', rows['Buffer Health']);
    ok(/kbps|Mbps/.test(rows['Connection Speed'] || ''), 'connection speed from the engine', rows['Connection Speed']);
    ok(/total\)/.test(rows['Network Activity'] || ''), 'network activity with a running total', rows['Network Activity']);
    ok(/^Shaka 4\.16/.test(rows['Engine'] || ''), 'engine and version', rows['Engine']);
    ok(/POP TEST1-P1/.test(rows['Delivery'] || '') && /Hit from testcdn/.test(rows['Delivery']), 'delivery: the CDN POP and cache result from the segment headers', rows['Delivery']);
    ok((rows['Manifest'] || '').endsWith('master.m3u8?…') && !JSON.stringify(rows).includes('SECRET'), 'the manifest is shown without its token', rows['Manifest']);
    ok((rows['Stream'] || '').startsWith('HLS, on demand'), 'on demand stream mode', rows['Stream']);
    ok(!('Live Latency' in rows), 'no live latency row on demand');
    ok(await page.locator('.vp-stats canvas').count() >= 3, 'graphs for speed, network and buffer');
    await page.screenshot({ path: shots ? path.join(shots, 'stats-video.png') : undefined });

    // right-click menu
    const box = await page.locator('.vp-stage').boundingBox();
    await page.mouse.click(box.x + box.width - 120, box.y + box.height - 140, { button: 'right' });
    ok(await page.locator('.vp-ctx').isVisible(), 'right-click opens the player menu');
    const items = await page.locator('.vp-ctx button').allTextContents();
    ok(items.join('|') === 'Playback stats|Copy debug info', 'menu items', items);
    ok(await page.locator('.vp-ctx button.on').count() === 1, 'Playback stats is ticked while open');
    ok(/Volt Player 1\.0\.0/.test(await page.locator('.vp-ctx-foot').textContent()), 'menu footer names the SDK version');
    await page.screenshot({ path: shots ? path.join(shots, 'stats-menu.png') : undefined });
    await page.locator('.vp-ctx button', { hasText: 'Copy debug info' }).click();
    await page.waitForTimeout(300);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    ok(clip.startsWith('Volt Player debug info (SDK 1.0.0)') && clip.includes('Codecs') && !clip.includes('SECRET123'), 'Copy debug info puts a token-free report on the clipboard', clip.slice(0, 120));
    ok(await page.locator('.vp-ctx').count() === 0, 'the menu closes after a choice');
    const playingBefore = await page.evaluate(() => window.p.getState().playing);
    await page.locator('.vp-stats-btn', { hasText: 'Copy' }).click();
    ok(await page.evaluate(() => window.p.getState().playing) === playingBefore, 'clicking inside the panel does not play or pause');
    await page.locator('.vp-stats-btn', { hasText: '×' }).click();
    ok(!(await page.locator('.vp-stats').isVisible()) && await page.evaluate(() => window.p.getState().stats === false && window.events.at(-1) === false), '× closes it and the state follows');
    const pre = await page.evaluate(() => window.p.getStats());
    ok(pre.res && pre.res.w === 1280 && pre.engine.startsWith('Shaka'), 'player.getStats() answers with the panel closed');

    // ---- 2. the admin skin: its Stats button opens the same panel ----
    await page.evaluate(() => { window.p.setSkin('admin'); });
    await page.waitForTimeout(300);
    await page.locator('.vpa-bar button[aria-label="Playback stats"]').click();
    await page.waitForTimeout(1300);
    ok(await page.locator('.vp-stats').isVisible() && await page.locator('.vpa-bar button[aria-label="Playback stats"].on').count() === 1, 'admin skin: the Stats button opens the shared panel and lights up');
    await page.screenshot({ path: shots ? path.join(shots, 'stats-admin.png') : undefined });
    await page.locator('.vpa-bar button[aria-label="Playback stats"]').click();
    await page.waitForTimeout(200);
    ok(!(await page.locator('.vp-stats').isVisible()), 'and closes it again');
    await page.evaluate(() => window.p.destroy());

    // ---- 3. debug: false keeps the browser's own menu and no shortcut ----
    await page.evaluate(async (b) => { window.q = await VoltPlayer.VoltPlayer.create({ el: '#p', skin: 'video', debug: false, source: { url: b + '/master.m3u8' }, muted: true, beacons: false, cast: false }); }, base);
    const prevented = await page.evaluate(() => { const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }); document.querySelector('.vp-stage').dispatchEvent(e); return e.defaultPrevented; });
    ok(!prevented && await page.locator('.vp-ctx').count() === 0, 'debug:false: right-click is the browser\'s own');
    await page.focus('.vp'); await page.keyboard.press('Shift+D'); await page.waitForTimeout(200);
    ok(await page.evaluate(() => window.q.getState().stats === false), 'debug:false: Shift+D does nothing');
    await page.evaluate(() => window.q.showStats(true));
    ok(await page.locator('.vp-stats').isVisible(), 'debug:false: player.showStats() still works');
    await page.evaluate(() => window.q.destroy());

    // ---- 4. the console's hls.js monitors (attachStats + hlsJsProbe) ----
    if (!hasHlsJs) console.log('SKIP part 4: hls.js is not installed in volt-web');
    else {
    const p2 = await ctx.newPage();
    await p2.goto(base + '/');
    await p2.addScriptTag({ url: base + '/hls.min.js' });
    await p2.addScriptTag({ url: base + '/volt-stats.js' });
    await p2.evaluate((b) => {
      const host = document.getElementById('p'); host.style.position = 'relative'; host.style.height = '540px';
      const v = document.createElement('video'); v.muted = true; v.style.width = '100%'; v.style.height = '100%'; host.appendChild(v);
      const hls = new Hls(); hls.loadSource(b + '/master.m3u8?token=SECRET'); hls.attachMedia(v); hls.on(Hls.Events.MANIFEST_PARSED, () => v.play());
      const S = VoltStats;
      const hp = S.hlsJsProbe(hls, v), mp = S.mediaProbe(v, host);
      window.st = S.attachStats(host, S.combineProbes(hp, mp), { version: S.SDK_VERSION });
    }, base);
    await p2.waitForFunction(() => document.querySelector('video').currentTime > 3, null, { timeout: 30000 });
    const b2 = await p2.locator('#p').boundingBox();
    await p2.mouse.click(b2.x + b2.width - 150, b2.y + b2.height - 150, { button: 'right' });
    await p2.locator('.vp-ctx button', { hasText: 'Playback stats' }).click();
    await p2.waitForTimeout(2600);
    const r2 = await p2.evaluate(() => Object.fromEntries([...document.querySelectorAll('.vp-stats-k')].map((k) => [k.textContent, k.nextElementSibling.textContent])));
        ok(/^hls\.js 1\.6/.test(r2['Engine'] || ''), 'hls.js monitor: engine', r2['Engine']);
    ok(/^1280×720@30/.test(r2['Current / Optimal Res'] || '') && /avc1\.640028/.test(r2['Codecs'] || ''), 'hls.js monitor: rendition and codecs', [r2['Current / Optimal Res'], r2['Codecs']]);
    ok(/kbps|Mbps/.test(r2['Connection Speed'] || '') && parseFloat(r2['Buffer Health']) > 0, 'hls.js monitor: bandwidth estimate and buffer');
    ok(/POP TEST1-P1/.test(r2['Delivery'] || ''), 'hls.js monitor: CDN POP from the fragment headers', r2['Delivery']);
    await p2.screenshot({ path: shots ? path.join(shots, 'stats-hlsjs.png') : undefined });
    await p2.evaluate(() => window.st.destroy());
    ok(await p2.locator('.vp-stats').count() === 0, 'destroy removes the panel');
    }

    // ---- 5. DASH through the SDK (Shaka): the same panel, the same rows ----
    const rowsOf = (pg: any) => pg.evaluate(() => Object.fromEntries([...document.querySelectorAll('.vp-stats-k')].map((k: any) => [k.textContent, k.nextElementSibling.textContent])));
    if (!hasDash) console.log('SKIP parts 5-6: ffmpeg could not write DASH');
    else {
      const p3 = await ctx.newPage();
      await p3.goto(base + '/'); await p3.addScriptTag({ url: base + '/volt-player.js' });
      await p3.evaluate(async (b: string) => { window.p = await VoltPlayer.VoltPlayer.create({ el: '#p', skin: 'admin', source: { url: b + '/dash/manifest.mpd?token=SECRET' }, autoplay: true, muted: true, beacons: false, cast: false, airplay: false }); }, base);
      await p3.waitForFunction(() => window.p.media.currentTime > 4, null, { timeout: 30000 });
      await p3.evaluate(() => window.p.showStats(true)); await p3.waitForTimeout(2600);
      const r3: any = await rowsOf(p3);
      ok((r3['Stream'] || '').startsWith('DASH, on demand, 4 s segments'), 'DASH (Shaka): format and segment length', r3['Stream']);
      ok(/^1280×720@30 \/ 1280×720@30$/.test(r3['Current / Optimal Res'] || ''), 'DASH (Shaka): the playing representation, and 720p for a 497 px box', r3['Current / Optimal Res']);
      ok(/avc1\.64001f/.test(r3['Codecs'] || '') && /AAC-LC/.test(r3['Codecs']), 'DASH (Shaka): the playing representation\'s codec', r3['Codecs']);
      ok(/POP TEST1-P1/.test(r3['Delivery'] || ''), 'DASH (Shaka): CDN POP from the segment headers', r3['Delivery']);
      ok(/manifest\.mpd\?…$/.test(r3['Manifest'] || ''), 'DASH (Shaka): the MPD without its token', r3['Manifest']);
      if (shots) await p3.screenshot({ path: path.join(shots, 'stats-dash-shaka.png') });
      await p3.evaluate(() => window.p.destroy());

      // ---- 6. the console's dash.js monitors (attachStats + dashJsProbe) ----
      if (!hasDashJs) console.log('SKIP part 6: dash.js is not installed in volt-web');
      else {
        const p4 = await ctx.newPage();
        await p4.goto(base + '/'); await p4.addScriptTag({ url: base + '/dash.all.min.js' }); await p4.addScriptTag({ url: base + '/volt-stats.js' });
        await p4.evaluate((b: string) => {
          const host = document.getElementById('p'); host.style.position = 'relative'; host.style.height = '540px';
          const v = document.createElement('video'); v.muted = true; v.style.width = '100%'; v.style.height = '100%'; host.appendChild(v);
          const pl = (window as any).dashjs.MediaPlayer().create(); pl.initialize(v, b + '/dash/manifest.mpd?token=SECRET', true);
          const S = VoltStats; window.st = S.attachStats(host, S.combineProbes(S.dashJsProbe(pl), S.mediaProbe(v, host)), { version: S.SDK_VERSION });
        }, base);
        await p4.waitForFunction(() => document.querySelector('video').currentTime > 4, null, { timeout: 30000 });
        await p4.evaluate(() => window.st.show(true)); await p4.waitForTimeout(2600);
        const r4: any = await rowsOf(p4);
        ok(/^dash\.js 4/.test(r4['Engine'] || ''), 'dash.js monitor: engine', r4['Engine']);
        ok((r4['Current / Optimal Res'] || '') === '1280×720 / 1280×720', 'dash.js monitor: current and optimal', r4['Current / Optimal Res']);
        ok(/avc1\.64001f/.test(r4['Codecs'] || ''), 'dash.js monitor: the PLAYING representation\'s codec, not the first one\'s', r4['Codecs']);
        ok(/2500 kbps/.test(r4['Bitrate'] || '') && /kbps|Mbps/.test(r4['Connection Speed'] || ''), 'dash.js monitor: bitrate and throughput');
        ok(/[1-9][\d.]* MB total/.test(r4['Network Activity'] || ''), 'dash.js monitor: bytes counted', r4['Network Activity']);
        ok(parseFloat(r4['Buffer Health']) > 1 && (r4['Stream'] || '').includes('4 s segments'), 'dash.js monitor: buffer and segment length');
        ok(/manifest\.mpd\?…$/.test(r4['Manifest'] || ''), 'dash.js monitor: the MPD without its token', r4['Manifest']);
        if (shots) await p4.screenshot({ path: path.join(shots, 'stats-dash-dashjs.png') });
        await p4.evaluate(() => window.st.destroy());
      }
    }
  } catch (e: any) { fail++; console.log('FAIL (threw) ' + (e && e.stack || e)); }
  console.log(`\nplayer-stats-browser: ${pass} passed, ${fail} failed`);
  await browser.close(); srv.close(); fs.rmSync(WWW, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
});
