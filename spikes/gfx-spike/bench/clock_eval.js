// Which way of driving template animation is deterministic and seekable?
// For each template x clock mode: update(sample) + play(), render the transition
// frame by frame, twice in fresh browsers, and compare the frame hash sequences.
// Also: does jumping straight to frame K give the same pixels as stepping to K?
const http = require('http');
const crypto = require('crypto');
const { Renderer } = require('../sidecar/renderer');
const { serveStatic } = require('../sidecar/static');

const PORT = 18091;
const srv = http.createServer((q, s) => { if (!serveStatic(q, s)) { s.writeHead(404); s.end(); } });

async function run(tpl, clock, maxFrames) {
  const r = await new Renderer({ clock }).init(`http://127.0.0.1:${PORT}/templates/${tpl}/`);
  const sample = r.manifest.sample;
  if (tpl === 'scorebug') { await r.call('update', sample); await r.call('play'); }
  else { await r.call('update', sample); await r.call('play'); }
  const hashes = [];
  const res = await r.renderTransition(async (png, i, h) => { hashes.push(h.slice(0, 8)); }, { maxFrames, minFrames: tpl === 'ticker' ? maxFrames : 1 });
  let jump = null;
  if (clock === 'vclock' && hashes.length > 8) {
    // fresh page: jump directly to frame 8 in one virtual step
    const r2 = await new Renderer({ clock }).init(`http://127.0.0.1:${PORT}/templates/${tpl}/`);
    await r2.call('update', sample); await r2.call('play');
    await r2.page.evaluate(() => window.__vstep(8 * 40));
    const png = await r2.capture();
    jump = crypto.createHash('md5').update(png).digest('hex').slice(0, 8) === hashes[8];
    await r2.close();
  }
  await r.close();
  const t = res.timings.slice(1); t.sort((a, b) => a - b);
  return { frames: res.frames, distinct: new Set(hashes).size, hashes, medMs: t[Math.floor(t.length / 2)] || res.timings[0], jump };
}

(async () => {
  srv.listen(PORT);
  const out = [];
  for (const tpl of ['scorebug', 'lowerthird', 'ticker']) {
    for (const clock of ['vclock', 'cdp', 'seek', 'realtime']) {
      if (clock === 'seek' && tpl !== 'lowerthird') continue; // only GSAP template exposes seek()
      const max = tpl === 'ticker' ? 25 : 60;
      try {
        const lim = (pr) => Promise.race([pr, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 45s (capture never returned)')), 45000))]);
        const a = await lim(run(tpl, clock, max));
        const b = await lim(run(tpl, clock, max));
        const det = a.hashes.join() === b.hashes.join();
        const row = { tpl, clock, frames: a.frames, distinctFrames: a.distinct, deterministic: det, jumpEqualsStep: a.jump, perFrameMs: +a.medMs.toFixed(1) };
        out.push(row); console.log(JSON.stringify(row));
      } catch (e) { console.log(JSON.stringify({ tpl, clock, error: String(e).slice(0, 200) })); }
    }
  }
  require('fs').writeFileSync(__dirname + '/../out/clock_eval.json', JSON.stringify(out, null, 1));
  srv.close(); process.exit(0);
})();
