#!/usr/bin/env node
// Volt graphics sidecar (spike). One headless Chromium page per graphic binding.
//
//   node sidecar/sidecar.js --template scorebug --port 8090 --file /tmp/gfx/bug.png
//   node sidecar/sidecar.js --template scorebug --fifo /tmp/gfx/bug.rgba
//   node sidecar/sidecar.js --url https://example/overlay.html --bbox 0,0,1920,1080 --file ...
//
// HTTP API (the same calls a console panel, a sports feed or a test script make):
//   GET  /state                current state + on-air flag
//   POST /state   {..}         replace fields (CasparCG update())      -> re-render
//   PATCH /state  {..}         merge fields (same as POST here)        -> re-render
//   POST /play | /stop | /next                                       -> transition
//   GET  /events               Server-Sent Events of every state change (preview pages)
//   GET  /health               {fps, frames_out, last_render_ms, ...}
//   GET  /templates/<name>/    the template itself (the preview renders this same file)
//   GET  /preview/             operator test page (JSON editor + live preview)
const fs = require('fs');
const path = require('path');
const http = require('http');
const { PNG } = require('pngjs');
const { Renderer } = require('./renderer');
const { serveStatic } = require('./static');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const PORT = +arg('port', 8090);
const TEMPLATE = arg('template', 'scorebug');
const URL_ = arg('url', `http://127.0.0.1:${PORT}/templates/${TEMPLATE}/`);
const FILE = arg('file', null);          // atomic PNG hand-off (write tmp + rename)
const FIFO = arg('fifo', null);          // raw RGBA at a steady fps
const CLOCK = arg('clock', 'vclock');
const FPS = +arg('fps', 25);
const LOG = arg('log', null);
const BBOX = arg('bbox', null) ? arg('bbox').split(',').map(Number) : null;
const AUTOPLAY = argv.includes('--autoplay');

const log = (ev, o = {}) => {
  const line = JSON.stringify({ t: Date.now(), ev, ...o });
  if (LOG) fs.appendFileSync(LOG, line + '\n'); else if (!['frame'].includes(ev)) console.log(line);
};

let state = {}, onAir = false;
const clients = new Set();
const queue = [];           // rendered frames waiting for playout: {png, rgba, tag}
let current = null;         // the frame on air (held between changes)
let framesOut = 0, lastRenderMs = 0, continuous = false;
let r;

// The file is the ONLY hand-off ffmpeg sees, and two failure modes were measured:
// a missing file ends the image2 input for good (graphic frozen until the transcoder
// restarts) and a corrupt file makes ffmpeg spin on decode errors (2.5 s main-path
// stall). So: write tmp fully, then rename (never unlink, never write in place), and
// re-assert the current frame every 2 s so anything else touching the file self-heals.
function writeAtomic(png) {
  const tmp = FILE + '.tmp';
  try { fs.writeFileSync(tmp, png); fs.renameSync(tmp, FILE); }
  catch (e) { log('write_error', { e: String(e) }); }   // keep the old file rather than a partial one
}
function emitFrame(f) {
  current = f;
  if (FILE) writeAtomic(f.png);
  if (f.tag) log('frame_out', f.tag);
}
if (FILE) setInterval(() => { if (current) writeAtomic(current.png); }, 2000);

// ---- playout clock: one tick per output frame, drift-corrected ----
let fifo = null, fifoBusy = false, fifoDrops = 0;
function openFifo() {
  if (!FIFO) return;
  fifo = fs.createWriteStream(FIFO, { flags: 'w', highWaterMark: 1 << 20 });
  fifo.on('error', (e) => { log('fifo_error', { e: String(e) }); fifo = null; setTimeout(openFifo, 1000); });
  fifo.on('drain', () => { fifoBusy = false; });
}
const t0 = Date.now(); let tick = 0;
function playout() {
  tick++;
  const f = queue.shift();
  if (f) { emitFrame(f); }
  if (fifo && current && current.rgba) {
    if (fifoBusy) fifoDrops++;           // never block the sidecar on a slow reader
    else { framesOut++; if (!fifo.write(current.rgba)) fifoBusy = true; }
  } else if (f) framesOut++;
  setTimeout(playout, Math.max(0, t0 + tick * (1000 / FPS) - Date.now()));
}

function toFrame(png, tag) {
  const f = { png, tag };
  if (FIFO) f.rgba = PNG.sync.read(png).data;   // decoded once per change, not per tick
  return f;
}

// ---- command chain: commands are serialized, each renders its transition ----
let chain = Promise.resolve();
function command(fn, arg, tag = {}) {
  const rx = Date.now();
  log('cmd_rx', { fn, ...tag });
  chain = chain.then(async () => {
    if (fn === 'update') Object.assign(state, arg);
    if (fn === 'play') onAir = true;
    if (fn === 'stop') onAir = false;
    await r.call(fn, arg);
    broadcast({ fn, arg, state, onAir });
    if (continuous) return;              // the continuous loop picks it up
    const t = Date.now();
    let first = true;
    const res = await r.renderTransition(async (png) => {
      queue.push(toFrame(png, first ? { ...tag, fn, rx, firstReady: Date.now() } : null));
      first = false;
    });
    lastRenderMs = Date.now() - t;
    log('rendered', { fn, frames: res.frames, ms: lastRenderMs, medFrameMs: med(res.timings) });
  }).catch((e) => log('render_error', { e: String(e) }));
  return chain;
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return +(s[Math.floor(s.length / 2)] || 0).toFixed(1); };

// Continuously animated templates (tickers): render one frame per tick, realtime.
async function continuousLoop() {
  let n = 0; const times = [];
  for (;;) {
    const t = process.hrtime.bigint();
    await chain;
    let png;
    try { await r.step(); png = await r.capture(); } catch (e) { log('continuous_stop', { e: String(e) }); return; }
    if (queue.length < 3) queue.push(toFrame(png));
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
    if (++n % 250 === 0) { log('continuous', { medFrameMs: med(times), p95: +[...times].sort((a, b) => a - b)[Math.floor(times.length * .95)].toFixed(1) }); times.length = 0; }
    const wait = 1000 / FPS - Number(process.hrtime.bigint() - t) / 1e6;
    if (wait > 0) await new Promise(res => setTimeout(res, wait));
  }
}

function broadcast(o) { const s = `data: ${JSON.stringify(o)}\n\n`; for (const c of clients) c.write(s); }

function body(req) {
  return new Promise((res) => { let b = ''; req.on('data', (d) => b += d); req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (_) { res(null); } }); });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(o)); };
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': '*', 'access-control-allow-headers': '*' }); return res.end(); }
  if (u.pathname === '/state' && req.method === 'GET') return json(200, { state, onAir, template: TEMPLATE });
  if (u.pathname === '/state' && (req.method === 'POST' || req.method === 'PATCH')) {
    const b = await body(req); if (!b) return json(400, { error: 'bad json' });
    const tag = b.marker !== undefined ? { marker: b.marker } : {};
    command('update', b, tag); return json(202, { ok: true });
  }
  if (['/play', '/stop', '/next'].includes(u.pathname) && req.method === 'POST') { command(u.pathname.slice(1)); return json(202, { ok: true }); }
  if (u.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.write(`data: ${JSON.stringify({ state, onAir, init: true })}\n\n`); clients.add(res); req.on('close', () => clients.delete(res)); return;
  }
  if (u.pathname === '/health') return json(200, { fps: FPS, framesOut, fifoDrops, queue: queue.length, lastRenderMs, onAir, rssMB: Math.round(process.memoryUsage().rss / 1048576) });
  if (u.pathname === '/frame.png') { res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }); return res.end(current ? current.png : Buffer.alloc(0)); }
  if (u.pathname === '/' ) { res.writeHead(302, { location: `/preview/?template=${TEMPLATE}` }); return res.end(); }
  if (serveStatic(req, res)) return;
  json(404, { error: 'not found' });
});

(async () => {
  server.listen(PORT, '127.0.0.1');
  r = await new Renderer({ clock: CLOCK, fps: FPS, bbox: BBOX }).init(URL_);
  continuous = !!(r.manifest && r.manifest.animation === 'continuous');
  log('ready', { url: URL_, bbox: r.bbox, clock: CLOCK, continuous, chromePid: r.browser.process && r.browser.process() ? r.browser.process().pid : null });
  // initial (empty / off-air) frame so the consumer always has something to hold
  queue.push(toFrame(await r.capture()));
  openFifo();
  playout();
  if (AUTOPLAY && r.manifest && r.manifest.sample) { command('update', r.manifest.sample); command('play'); }
  if (continuous) continuousLoop();
})();
process.on('SIGTERM', async () => { if (r) await r.close(); process.exit(0); });
