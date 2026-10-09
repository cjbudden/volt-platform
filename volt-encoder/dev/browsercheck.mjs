#!/usr/bin/env node
// browsercheck.mjs: play a live channel in a REAL browser with the console's own player
// libraries (hls.js and dash.js from volt-web/node_modules) and report what a viewer got:
// stalls, time spent waiting, and the colour on screen every second (so a failover test
// can see live -> loop -> live as the viewer saw it).
//
//   node dev/browsercheck.mjs --url http://127.0.0.1:8099/manifest_cc.mpd --seconds 200
//   node dev/browsercheck.mjs --url http://127.0.0.1:8099/master_cc.m3u8 --seconds 200 --snap product
//
// Needs a Chrome with H.264 (Chromium builds have none):
//   npx @puppeteer/browsers install chrome@stable      -> prints the binary path
//   CHROME_BIN=<that path> (on a Mac: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
// and playwright-core resolvable (npm i playwright-core, or NODE_PATH pointing at one).
//
// --snap product  copies the console player's start behaviour (ChannelDetail.tsx): after
//                 load, jump to `seekable.end - 12s` (captions off) or `- 14s` (captions on).
// --snap edge     the console's behaviour before 9 Oct: `seekable.end - 0.5s`.
// --snap none     leaves the library's own live start (hls.js: 3 segments back; dash.js:
//                 its liveDelay), which is what the stream is designed for.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const url = arg('url');
const seconds = Number(arg('seconds', '120'));
const snap = arg('snap', 'none');
const capHold = Number(arg('cap-hold', '0'));
const jsonOut = process.argv.includes('--json');
const web = arg('web', path.resolve(here, '../../volt-web/node_modules'));
const chrome = process.env.CHROME_BIN;
const T_START = Date.now();
if (!url || !chrome) { console.log('SKIP needs --url and CHROME_BIN (a Chrome with H.264)'); process.exit(0); }

let chromium;
try { ({ chromium } = require('playwright-core')); } catch { console.log('SKIP playwright-core is not installed'); process.exit(0); }
const isDash = url.split('?')[0].endsWith('.mpd');
const lib = isDash ? path.join(web, 'dashjs/dist/dash.all.min.js') : path.join(web, 'hls.js/dist/hls.min.js');

const browser = await chromium.launch({ executablePath: chrome, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
// --log FILE: every console line the player library writes, with a wall-clock stamp
const logFile = arg('log');
if (logFile) {
  const fs = await import('node:fs');
  fs.writeFileSync(logFile, '');
  page.on('console', (m) => fs.appendFileSync(logFile, `${((Date.now() - T_START) / 1000).toFixed(1)} ${m.type()} ${m.text()}\n`));
}
// a page on the stream's own origin, so no CORS is involved
await page.goto(new URL('./', url).href).catch(() => {});
await page.setContent('<video id="v" muted playsinline width="640" height="360"></video><canvas id="c" width="64" height="36"></canvas>');
await page.addScriptTag({ path: lib });
await page.evaluate(({ url, isDash, snap, capHold, dashLog }) => {
  window.__dashLog = dashLog;
  const v = document.getElementById('v');
  const w = (window.__w = { waiting: 0, errors: [], periods: 0 });
  v.addEventListener('waiting', () => { w.waiting++; });
  const doSnap = () => {
    if (snap !== 'product' && snap !== 'edge') return;
    const once = () => { try { const sk = v.seekable; if (sk.length && !w.snapped) { const end = sk.end(sk.length - 1), start = sk.start(0); const hold = Math.min(snap === 'edge' ? (capHold || 0.5) : (capHold || 12), Math.max(0.5, (end - start) - 3)); v.currentTime = end - hold; w.snapped = true; } } catch {} };
    setTimeout(once, 300); setTimeout(once, 1200);
  };
  if (isDash) {
    const p = dashjs.MediaPlayer().create();
    p.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: true } }, retryAttempts: { MPD: 12 } }, debug: { logLevel: Number(window.__dashLog || 1) } });
    p.on(dashjs.MediaPlayer.events.ERROR, (e) => w.errors.push(JSON.stringify(e.error || e).slice(0, 200)));
    p.on(dashjs.MediaPlayer.events.PERIOD_SWITCH_COMPLETED, () => { w.periods++; });
    p.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => { v.play().catch(() => {}); doSnap(); });
    p.initialize(v, url, true);
    window.__p = p;
  } else {
    const cfg = { lowLatencyMode: false, manifestLoadingMaxRetry: 12, manifestLoadingRetryDelay: 1000, levelLoadingMaxRetry: 12, debug: Number(window.__dashLog || 1) >= 5 };
    if (capHold) cfg.liveSyncDuration = capHold; else cfg.liveSyncDurationCount = 3;
    const h = new Hls(cfg);
    h.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) { w.errors.push(`${d.type}/${d.details}`); if (d.type === Hls.ErrorTypes.MEDIA_ERROR) h.recoverMediaError(); else setTimeout(() => { h.loadSource(url); h.startLoad(); }, 1500); } });
    h.on(Hls.Events.MANIFEST_PARSED, () => { v.play().catch(() => {}); doSnap(); });
    h.loadSource(url); h.attachMedia(v);
    window.__p = h;
  }
}, { url, isDash, snap, capHold, dashLog: arg('dash-log', '1') });

// sample once a second: playhead, buffer ahead, and the colour of a patch the moving box
// and the watermark never cover (left middle)
const samples = [];
const t0 = Date.now();
while (Date.now() - t0 < seconds * 1000) {
  await new Promise((r) => setTimeout(r, 1000));
  samples.push(await page.evaluate(() => {
    const v = document.getElementById('v');
    const c = document.getElementById('c').getContext('2d', { willReadFrequently: true });
    let col = null;
    try {
      c.drawImage(v, 0, 0, 64, 36);
      const d = c.getImageData(2, 10, 6, 16).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      const n = d.length / 4; r /= n; g /= n; b /= n;
      col = Math.max(r, g, b) < 40 ? 'BLACK' : r > g && r > b ? 'RED' : b > r && b > g ? 'BLUE' : g > r && g > b ? 'GREEN' : 'OTHER';
    } catch {}
    let ahead = 0;
    try { for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.1 && v.buffered.end(i) > v.currentTime) ahead = v.buffered.end(i) - v.currentTime; } catch {}
    let behind = null;
    try { const sk = v.seekable; if (sk.length) behind = sk.end(sk.length - 1) - v.currentTime; } catch {}
    let ranges = [];
    try { for (let i = 0; i < v.buffered.length; i++) ranges.push([+v.buffered.start(i).toFixed(2), +v.buffered.end(i).toFixed(2)]); } catch {}
    let per = null, bv = null, ba = null;
    try { per = window.__p.getActiveStream ? window.__p.getActiveStream().getId() : null; } catch {}
    try { bv = +window.__p.getBufferLength('video').toFixed(2); ba = +window.__p.getBufferLength('audio').toFixed(2); } catch {}
    console.log('STATE ' + JSON.stringify({ ct: +v.currentTime.toFixed(2), ranges, per, bv, ba, rs: v.readyState, paused: v.paused }));
    return { ct: v.currentTime, ahead, behind, ready: v.readyState, paused: v.paused, col, waiting: window.__w.waiting, errs: window.__w.errors.length, periods: window.__w.periods };
  }));
}
const w = await page.evaluate(() => window.__w);
await browser.close();

// after the first frame: a second in which the playhead moved less than 0.5s is a stall
const startIdx = samples.findIndex((s) => s.ct > 0 && s.ready >= 3);
const play = startIdx < 0 ? [] : samples.slice(startIdx);
let stuck = 0, events = 0, inStall = false;
const stallAt = [];
for (let i = 1; i < play.length; i++) {
  const moved = play[i].ct - play[i - 1].ct;
  if (moved < 0.5) { stuck++; if (!inStall) { events++; stallAt.push(Math.round(i + startIdx)); } inStall = true; } else inStall = false;
}
const seq = [];
for (const s of play) { if (!s.col) continue; if (!seq.length || seq[seq.length - 1][0] !== s.col) seq.push([s.col, 0]); seq[seq.length - 1][1]++; }
const behind = play.map((s) => s.behind).filter((x) => x != null);
const res = {
  engine: isDash ? 'dash.js' : 'hls.js', snap, first_frame_sec: startIdx < 0 ? null : startIdx + 1,
  stall_events: events, stalled_sec: stuck, stall_at_sec: stallAt.slice(0, 10),
  waiting_events: w.waiting, player_errors: w.errors.slice(0, 5), period_switches: w.periods,
  behind_live_sec: behind.length ? { min: +Math.min(...behind).toFixed(1), max: +Math.max(...behind).toFixed(1) } : null,
  on_screen: seq.map(([c, n]) => `${c} ${n}s`).join(' -> '),
};
if (jsonOut) console.log(JSON.stringify(res));
console.log(`${res.engine} (${snap} start): first frame ${res.first_frame_sec}s, on screen: ${res.on_screen}`);
console.log(`  behind live ${JSON.stringify(res.behind_live_sec)}, ${res.waiting_events} waiting events, ${res.period_switches} Period switches, errors ${JSON.stringify(res.player_errors)}`);
if (startIdx < 0) { console.log('FAIL never played'); process.exit(1); }
if (events || w.errors.length) { console.log(`FAIL ${events} stall(s), ${stuck}s frozen, at ${JSON.stringify(stallAt.slice(0, 10))}s`); process.exit(1); }
console.log('OK no stalls: the playhead advanced every second from the first frame to the end');
