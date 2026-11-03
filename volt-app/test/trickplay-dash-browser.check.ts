// ============================================================================
//  DASH TRICK-MODE IN A REAL PLAYER (build queue 3.2b-2).
//
//  Shaka Player (the engine inside the Volt web SDK) in Chromium plays an
//  on-demand asset with trick-play on, served by the real API: the MPD with
//  its trick-mode set, and the trick segments made on request. Checked:
//    - Shaka attaches a trick-mode track to every video rendition;
//    - fast-forward (trickPlay 8x) fetches trick segments, the picture moves
//      on, and the media element and Shaka report no error (the segments are
//      valid to a browser's decoder, not only to ffmpeg);
//    - with the Volt SDK's own setting (disableIFrames) no trick-mode track is
//      attached and no trick segment is fetched: web viewers keep sprites.
//
//  The container's Chromium has no H.264, so the asset here is VP9 in CMAF
//  (the trick-mode code does not look at the codec). Needs ffmpeg with
//  libvpx-vp9, shaka-player in volt-player and playwright-core; anything
//  missing SKIPS and says so.
//
//  Usage: DATABASE_URL=... npx tsx test/trickplay-dash-browser.check.ts
// ============================================================================
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

const ROOT = resolve(__dirname, '..');
const SHAKA = resolve(ROOT, '../volt-player/node_modules/shaka-player/dist/shaka-player.compiled.js');
const skip = (why: string) => { console.log(`SKIP trickplay-dash-browser: ${why}`); process.exit(0); };
let pw: any = null;
try { pw = require(require.resolve('playwright-core', { paths: [ROOT, process.cwd(), ...(process.env.PLAYWRIGHT_CORE_DIR ? [process.env.PLAYWRIGHT_CORE_DIR] : [])] })); } catch { /* */ }
if (!pw) { try { pw = require(require.resolve('playwright', { paths: [ROOT, process.cwd(), '/usr/lib/node_modules', '/usr/local/lib/node_modules'] })); } catch { /* */ } }
if (!pw) skip('playwright-core is not installed (npm i --no-save playwright-core)');
if (!existsSync(SHAKA)) skip('shaka-player is not installed in volt-player');
if (!/libvpx-vp9/.test(spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout?.toString() ?? '')) skip('ffmpeg has no libvpx-vp9');

const WORK = mkdtempSync(join(tmpdir(), 'volt-trickdash-browser-'));
process.env.CLIPS_DIR = join(WORK, 'clips');
process.env.ORIGIN_DIR = join(WORK, 'origin');
process.env.IMAGE_STORE_DIR = join(WORK, 'image-store');

let pass = 0, fail = 0;
const ok = (m: string, c: boolean, extra?: unknown) => {
  if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (extra === undefined ? '' : `  -> ${JSON.stringify(extra)}`)); }
};
declare const window: any, document: any, shaka: any;

const A = '00000000-0000-0000-0000-0000000e7a01';
const ASSET = '00000000-0000-0000-0000-0000000e7b01';

const dir = join(process.env.CLIPS_DIR!, 'vod', ASSET);
mkdirSync(dir, { recursive: true });
// 40 s of a moving picture, VP9 with a keyframe every 2 s, two renditions,
// DASH and HLS over the same CMAF segments (ffmpeg's DASH muxer).
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=40', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40',
  '-map', '0:v', '-map', '0:v', '-map', '1:a', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-lag-in-frames', '0', '-auto-alt-ref', '0',
  '-g', '50', '-keyint_min', '50', '-b:v:0', '900k', '-s:v:0', '640x360', '-b:v:1', '300k', '-s:v:1', '320x180', '-c:a', 'libopus', '-b:a', '64k',
  '-f', 'dash', '-dash_segment_type', 'mp4', '-seg_duration', '2', '-use_template', '1', '-use_timeline', '1', '-hls_playlist', '1', '-adaptation_sets', 'id=0,streams=v id=1,streams=a', join(dir, 'manifest.mpd')]);

async function main() {
  const { query, pool } = await import('../src/db');
  const { createServer } = await import('../src/server');
  const store = await import('../src/services/trickplay/store');
  await query(`DELETE FROM accounts WHERE id = $1`, [A]);
  await query(`INSERT INTO accounts(id,name,trick_play_default) VALUES ($1,'TrickBrowser',true)`, [A]);
  await query(`INSERT INTO vod_assets(id, account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms)
     VALUES ($1,$2,'upload','clip','vp9',$3,0,40000,40000)`, [ASSET, A, `/clips/vod/${ASSET}/master.m3u8`]);
  const built = await store.buildAssetTrickPlay(ASSET);
  ok(`built for both renditions (${built.renditions}, ${built.note})`, built.state === 'ready' && built.renditions === 2 && !built.note);

  const api = createServer().listen(0);
  const apiPort = (api.address() as AddressInfo).port;
  // One origin for the page, Shaka and the API (the plain segments are served
  // without CORS headers, as they are behind the CDN).
  const front = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><body><video muted playsinline style="width:640px"></video></body>'); return; }
    if (req.url === '/shaka.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end(readFileSync(SHAKA)); return; }
    const p = http.request({ host: '127.0.0.1', port: apiPort, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    p.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(p);
  }).listen(0);
  const base = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;

  const browser = await pw.chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
    args: ['--autoplay-policy=no-user-gesture-required'] });
  const run = async (disableIFrames: boolean) => {
    const ctx = await browser.newContext();
    await ctx.addInitScript('window.__name = (f) => f');
    const page = await ctx.newPage();
    const trickReqs: string[] = [];
    const bad: string[] = [];
    page.on('request', (r: any) => { if (/\/trick\//.test(r.url())) trickReqs.push(r.url()); });
    page.on('response', (r: any) => { if (/\/trick\//.test(r.url()) && r.status() !== 200) bad.push(`${r.status()} ${r.url()}`); });
    page.on('pageerror', (e: any) => bad.push('pageerror ' + e.message));
    await page.goto(base + '/');
    await page.addScriptTag({ url: base + '/shaka.js' });
    const r = await page.evaluate(async ({ url, disableIFrames }: any) => {
      shaka.polyfill.installAll();
      const v = document.querySelector('video');
      const errors: string[] = [];
      const player = new shaka.Player();
      await player.attach(v);
      player.addEventListener('error', (e: any) => errors.push(`shaka ${e.detail?.code}`));
      v.addEventListener('error', () => errors.push(`video ${v.error?.code} ${v.error?.message}`));
      player.configure({ manifest: { disableIFrames }, streaming: { bufferingGoal: 6 } });
      await player.load(url);
      const variants = player.getManifest().variants;
      const withTrick = variants.filter((x: any) => x.video && x.video.trickModeVideo).length;
      await v.play().catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
      const t0 = v.currentTime;
      player.trickPlay(8);
      await new Promise((r) => setTimeout(r, 3000));
      const t1 = v.currentTime;
      player.cancelTrickPlay();
      await new Promise((r) => setTimeout(r, 1000));
      return { variants: variants.length, withTrick, t0, t1, errors, readyState: v.readyState };
    }, { url: base + `/clips/vod/${ASSET}/manifest.mpd`, disableIFrames });
    await ctx.close();
    return { ...r, trickReqs, bad };
  };

  console.log('== Shaka with trick-mode tracks allowed ==');
  const on = await run(false);
  ok(`a trick-mode track on every video rendition (${on.withTrick} of ${on.variants})`, on.variants > 0 && on.withTrick === on.variants, on);
  ok(`fast-forward fetches trick segments (${on.trickReqs.length})`, on.trickReqs.length >= 3, on.trickReqs.slice(0, 3));
  ok('every one answered 200', on.bad.filter((b) => !b.startsWith('pageerror')).length === 0, on.bad);
  ok(`the picture moves on at 8x (${on.t0.toFixed(1)} s to ${on.t1.toFixed(1)} s)`, on.t1 - on.t0 > 6, on);
  ok('no player, media or page error', on.errors.length === 0 && on.bad.length === 0 && on.readyState >= 2, { errors: on.errors, bad: on.bad, rs: on.readyState });

  console.log('\n== the Volt SDK\'s setting (disableIFrames) ==');
  const off = await run(true);
  ok('no trick-mode track attached', off.variants > 0 && off.withTrick === 0, off);
  ok(`no trick segment fetched (${off.trickReqs.length})`, off.trickReqs.length === 0);
  ok('and it still plays without error', off.errors.length === 0 && off.readyState >= 2, off.errors);

  await browser.close();
  api.close(); front.close();
  await query(`DELETE FROM accounts WHERE id = $1`, [A]);
  await pool.end();
  console.log(`\ntrickplay-dash-browser: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
