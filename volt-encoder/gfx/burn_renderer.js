#!/usr/bin/env node
// ============================================================================
//  VOLT GRAPHICS BURN-IN RENDERER (build queue 1.10).
//
//  One process per transcode stream that has graphics "Burned into the video".
//  Started and supervised by encoder.py (bin/gfx_burn.py says how the pieces
//  fit and why each rule is there; the measurements behind them are
//  volt-app/docs/SPIKE_live_graphics_burnin.md).
//
//  WHAT IT DOES. Follows the control plane's burn feed
//  (GET /api/streams/:id/burn-graphics: the graphics, their placement and the
//  state now). One headless Chromium page holds each graphic in its own
//  sandboxed iframe loaded from /gfx/<published version>/, laid out exactly as
//  the Volt player lays out its overlay, and driven through the same bridge
//  (update / play / stop by postMessage). When anything changes it captures
//  the REGION (the box the encoder composites, never the whole canvas) as a
//  PNG with alpha, frame by frame until the transition settles, and writes it
//  to --out by temp file + rename, so ffmpeg never reads half a file. The
//  current frame is re-written every 2 s: that is the heartbeat the encoder's
//  dead-man watches.
//
//  WHAT IT NEVER DOES. Block the encoder (ffmpeg reads the file when it wants
//  a frame), delete the file (a missing input freezes the graphic until the
//  transcoder restarts), or let a template reach the network or the host page
//  (sandbox allow-scripts only, and the package's own CSP).
//
//    node burn_renderer.js --feed <url> --api <control plane base> --out <png>
//         --region x,y,w,h [--fps 25] [--poll-ms 500] [--chrome <path>]
//    VOLT_INGEST_TOKEN in the environment authenticates the feed.
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const FEED = arg('feed');
const API = String(arg('api', '') || '').replace(/\/+$/, '');
const OUT = arg('out');
const REGION = String(arg('region', '0,0,1920,1080')).split(',').map(Number);
const FPS = Math.max(1, Number(arg('fps', 25)) || 25);
const POLL_MS = Math.max(100, Number(arg('poll-ms', 500)) || 500);
const STREAM = arg('stream', '');
const TOKEN = process.env.VOLT_INGEST_TOKEN || '';
const HEARTBEAT_MS = 2000;
const BURST_MAX_MS = 4000;     // the longest a change is followed frame by frame
const SETTLE_FRAMES = 3;       // identical frames in a row that end a burst
const MIN_BURST_MS = 600;      // a play() starts its animation on the next frames

const log = (ev, o = {}) => process.stdout.write(JSON.stringify({ t: new Date().toISOString(), src: 'gfx-renderer', stream: STREAM, ev, ...o }) + '\n');

if (!FEED || !OUT || REGION.length !== 4 || REGION.some((n) => !Number.isFinite(n))) {
  log('usage', { error: 'need --feed, --out and --region x,y,w,h' });
  process.exit(2);
}

function findChrome() {
  const c = [arg('chrome'), process.env.GFX_CHROMIUM_PATH, process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
  return c.find((p) => p && fs.existsSync(p)) || undefined;
}

// The page every graphic lives in. The layout is the Volt player's
// (volt-player/src/sdk/overlay.ts) with the picture box fixed at the
// 1920x1080 canvas: the box is scaled to fit, the iframe translated and scaled
// about its anchor. Kept in step by test (graphics-burn.check.ts compares the
// region the control plane computes with where the graphic is really drawn).
const HOST = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden;width:1920px;height:1080px}
#root{position:absolute;left:0;top:0;width:1920px;height:1080px}
</style></head><body><div id="root"></div><script>
(function(){
  var ORIGIN={top_left:'0 0',top:'50% 0',top_right:'100% 0',left:'0 50%',center:'50% 50%',right:'100% 50%',bottom_left:'0 100%',bottom:'50% 100%',bottom_right:'100% 100%'};
  var layers={}, dirty=false, errors=[];
  addEventListener('message',function(e){
    for(var id in layers){var l=layers[id];if(e.source!==l.frame.contentWindow||!e.data||typeof e.data!=='object')continue;
      if(e.data.type==='volt-gfx-ready'){l.ready=true;l.sentValues='';l.sentOn=null;sync(l);dirty=true}
      if(e.data.type==='volt-gfx-error'){errors.push({id:id,message:String(e.data.message||'')});dirty=true}}
  });
  function post(l,op,data){try{l.frame.contentWindow.postMessage({type:'volt-gfx',op:op,data:data},'*')}catch(_){}}
  function sync(l){
    if(!l.ready)return false;var sent=false;var v=JSON.stringify(l.values||{});
    if(l.on&&v!==l.sentValues){post(l,'update',l.values||{});l.sentValues=v;sent=true}
    if(l.on!==l.sentOn){post(l,l.on?'play':'stop');l.sentOn=l.on;sent=true}
    return sent;
  }
  function layout(l){
    var cw=l.def.canvas[0],ch=l.def.canvas[1],s=Math.min(1920/cw,1080/ch),p=l.def.placement||{};
    l.box.style.cssText='position:absolute;left:0;top:0;width:'+cw+'px;height:'+ch+'px;transform-origin:0 0;transform:scale('+s+');z-index:'+(p.layer==null?2:p.layer);
    l.frame.style.transformOrigin=ORIGIN[p.anchor||'top_left']||'0 0';
    l.frame.style.transform='translate('+(p.x||0)+'px, '+(p.y||0)+'px) scale('+(p.scale==null?1:p.scale)+')';
  }
  window.__apply=function(defs,state,apiBase){
    var changed=false,want={};
    defs.forEach(function(d){want[d.id]=d});
    for(var id in layers){if(!want[id]||want[id].url!==layers[id].def.url){layers[id].box.remove();delete layers[id];changed=true}}
    defs.forEach(function(d){
      var l=layers[d.id];
      if(!l){
        var box=document.createElement('div'),frame=document.createElement('iframe');
        frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('referrerpolicy','no-referrer');
        frame.style.cssText='width:'+d.canvas[0]+'px;height:'+d.canvas[1]+'px;border:0;background:transparent;display:block;color-scheme:normal';
        frame.src=/^https?:/.test(d.url)?d.url:apiBase+d.url;
        box.appendChild(frame);document.getElementById('root').appendChild(box);
        l=layers[d.id]={def:d,box:box,frame:frame,ready:false,sentValues:'',sentOn:null,on:false,values:{}};changed=true;
      }
      if(JSON.stringify(l.def.placement||{})!==JSON.stringify(d.placement||{})||String(l.def.canvas)!==String(d.canvas))changed=true;
      l.def=d;layout(l);
      var st=state&&state[d.id];l.on=!!(st&&st.on);if(l.on)l.values=st.v||{};
      if(sync(l))changed=true;
    });
    return changed;
  };
  window.__takeDirty=function(){var d=dirty;dirty=false;return d};
  window.__status=function(){var n=0,r=0,on=0;for(var id in layers){n++;if(layers[id].ready)r++;if(layers[id].on)on++}return{layers:n,ready:r,on:on,errors:errors.splice(0)}};
})();
</script></body></html>`;

let chromium;
try { ({ chromium } = require('playwright-core')); } catch (e) {
  log('fatal', { error: 'playwright-core is not installed next to the renderer (npm ci in volt-encoder/gfx)' });
  process.exit(3);
}

let browser = null, page = null, cdp = null;
let current = null, currentHash = '';
let framesWritten = 0;

function writeAtomic(buf) {
  const tmp = `${OUT}.tmp${process.pid}`;
  try { fs.writeFileSync(tmp, buf); fs.renameSync(tmp, OUT); return true; }
  catch (e) { log('write_error', { error: String(e && e.message || e) }); return false; }  // keep the old file
}

async function capture() {
  const [x, y, w, h] = REGION;
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x, y, width: w, height: h, scale: 1 }, fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: true });
  return Buffer.from(r.data, 'base64');
}

async function frame() {
  const png = await capture();
  const h = crypto.createHash('sha1').update(png).digest('hex');
  if (h !== currentHash) { current = png; currentHash = h; if (writeAtomic(png)) framesWritten++; return true; }
  return false;
}

let feedFails = 0, lastFeedOk = 0, lastSig = '';
async function readFeed() {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 4000);
  try {
    const r = await fetch(FEED, { headers: TOKEN ? { 'X-Volt-Ingest-Token': TOKEN } : {}, signal: ac.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(`feed answered ${r.status}`);
    const j = await r.json();
    if (feedFails) log('feed_back', { after: feedFails });
    feedFails = 0; lastFeedOk = Date.now();
    return j;
  } catch (e) {
    // A dead feed HOLDS the last state: the graphic stays as it was rather than
    // flicking off because the control plane is restarting.
    if (feedFails++ % 20 === 0) log('feed_error', { error: String(e && e.message || e), fails: feedFails });
    return null;
  } finally { clearTimeout(t); }
}

async function main() {
  const exe = findChrome();
  browser = await chromium.launch({
    executablePath: exe,
    args: ['--disable-gpu', '--disable-frame-rate-limit', '--disable-gpu-vsync', '--hide-scrollbars', '--mute-audio',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--font-render-hinting=none', '--no-first-run', '--autoplay-policy=no-user-gesture-required'],
  });
  browser.on('disconnected', () => { log('fatal', { error: 'Chromium went away' }); process.exit(1); });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page = await ctx.newPage();
  page.on('pageerror', (e) => log('page_error', { error: String(e && e.message || e) }));
  cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await page.setContent(HOST, { waitUntil: 'load' });
  await frame();                                   // a valid (empty) frame of the right size at once
  log('ready', { chrome: exe || 'playwright default', region: REGION, fps: FPS, pollMs: POLL_MS });

  let burstUntil = 0, burstStart = 0, same = 0, lastBeat = Date.now(), lastPoll = 0, polling = false;
  const startBurst = () => { const n = Date.now(); if (n >= burstUntil) burstStart = n; burstUntil = n + BURST_MAX_MS; same = 0; };

  for (;;) {
    const t0 = Date.now();
    if (!polling && t0 - lastPoll >= POLL_MS) {
      polling = true; lastPoll = t0;
      readFeed().then(async (f) => {
        if (!f || !Array.isArray(f.graphics)) return;
        const changed = await page.evaluate(([d, s, a]) => window.__apply(d, s, a), [f.graphics, f.state || {}, API]);
        const sig = JSON.stringify([f.graphics.map((g) => g.id), f.state]);
        if (changed) { startBurst(); if (sig !== lastSig) log('state', { graphics: f.graphics.length, on: Object.values(f.state || {}).filter((v) => v && v.on).length, inBreak: !!f.inBreak }); }
        lastSig = sig;
      }).catch((e) => log('apply_error', { error: String(e && e.message || e) })).finally(() => { polling = false; });
    }
    try {
      if (await page.evaluate(() => window.__takeDirty())) startBurst();
      if (Date.now() < burstUntil) {
        const moved = await frame();
        same = moved ? 0 : same + 1;
        if (same >= SETTLE_FRAMES && Date.now() - burstStart >= MIN_BURST_MS) {
          burstUntil = 0;
          const st = await page.evaluate(() => window.__status());
          for (const e of st.errors) log('template_error', e);
          log('settled', { frames: framesWritten, layers: st.layers, ready: st.ready, on: st.on });
        }
      }
      if (Date.now() - lastBeat >= HEARTBEAT_MS) { lastBeat = Date.now(); if (current) writeAtomic(current); }
    } catch (e) {
      log('render_error', { error: String(e && e.message || e) });
      if (!browser.isConnected()) process.exit(1);
    }
    const wait = (Date.now() < burstUntil ? 1000 / FPS : 50) - (Date.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { try { await browser?.close(); } catch { /* exiting */ } process.exit(0); });
main().catch((e) => { log('fatal', { error: String(e && e.stack || e) }); process.exit(1); });
