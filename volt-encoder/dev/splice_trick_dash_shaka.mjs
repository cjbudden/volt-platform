// Shaka Player over the spliced MPD's trick-mode sets (build queue 3.2b-8 (c2)).
//
// Takes the mid-break MPD that test_splice_trick_dash.py keeps (VP9 media: the
// test Chromium has no H.264), plays it as a static presentation (same Periods,
// same sets and segments, so no clock to line up) and fast-forwards from the live
// Period into the loop Period. Checks: every variant gets a trick track, fast-
// forward fetches trick segments from BOTH the packager's live set and the loop's
// keyframe slots, every one found, no player or media error.
//
// Usage (from volt-encoder/dev):
//   SPLICE_TRICK_CODEC=vp9 SPLICE_TRICK_KEEP=/tmp/st python3 test_splice_trick_dash.py
//   node splice_trick_dash_shaka.mjs /tmp/st <path to shaka-player.compiled.js>
// Needs playwright (Chromium) and shaka-player (volt-player's node_modules).
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const [dir, SHAKA] = process.argv.slice(2);
let pass = 0, fail = 0;
const ok = (m, c, x) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m, x ? JSON.stringify(x) : ''); } };

// dynamic -> static: same Periods, rebased to 0, with a presentation duration
let mpd = readFileSync(join(dir, 'manifest_mid.mpd'), 'utf8');
const pers = [...mpd.matchAll(/<Period id="([^"]+)" start="PT([\d.]+)S"(?: duration="PT([\d.]+)S")?>([\s\S]*?)<\/Period>/g)];
const t0 = Number(pers[0][2]);
const last = pers[pers.length - 1];
let lastEnd = 0;
for (const m of last[4].matchAll(/<SegmentTemplate timescale="(\d+)" presentationTimeOffset="(\d+)"[^>]*>([\s\S]*?)<\/SegmentTemplate>/g)) {
  const ts = Number(m[1]), pto = Number(m[2]);
  let t = 0;
  for (const s of m[3].matchAll(/<S t="(\d+)" d="(\d+)"(?: r="(\d+)")?\/>/g)) t = Number(s[1]) + Number(s[2]) * (Number(s[3] || 0) + 1);
  lastEnd = Math.max(lastEnd, (t - pto) / ts);
}
const total = Number(last[2]) - t0 + lastEnd;
const starts = pers.map((p) => ({ id: p[1], start: Number(p[2]) - t0, loop: /media="filler\//.test(p[4]), trick: /trickmode/.test(p[4]) }));
mpd = mpd.replace(/<Period id="([^"]+)" start="PT([\d.]+)S"/g, (_a, id, s) => `<Period id="${id}" start="PT${(Number(s) - t0).toFixed(3)}S"`)
  .replace(/type="dynamic"[^>]*?(?=>)/, `type="static" mediaPresentationDuration="PT${total.toFixed(3)}S" minBufferTime="PT2S"`);
const loopP = starts.filter((p) => p.loop).pop();
ok(`(mid-break MPD: Periods ${starts.map((p) => `${p.id}${p.loop ? ' loop' : ''}${p.trick ? ' +trick' : ''}`).join(', ')})`, !!loopP && loopP.trick);

const srv = http.createServer((req, res) => {
  const u = decodeURIComponent((req.url || '/').split('?')[0]);
  if (u === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><body><video muted playsinline style="width:640px"></video></body>'); return; }
  if (u === '/shaka.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end(readFileSync(SHAKA)); return; }
  if (u === '/manifest.mpd') { res.writeHead(200, { 'content-type': 'application/dash+xml' }); res.end(mpd); return; }
  const f = join(dir, u);
  if (!existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(readFileSync(f));
}).listen(0);
const base = `http://127.0.0.1:${srv.address().port}`;
const pw = require('playwright');
const browser = await pw.chromium.launch({ ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}), args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await (await browser.newContext()).newPage();
const liveTrick = [], loopTrick = [], bad = [];
page.on('response', (q) => {
  const u = q.url();
  if (/_trick\/seg_/.test(u)) liveTrick.push(u.split('/').pop());
  if (/\/trick\/p\d+_/.test(u)) loopTrick.push(u.split('/').pop());
  if (q.status() !== 200 && !u.endsWith('favicon.ico')) bad.push(`${q.status()} ${u}`);
});
await page.goto(base + '/');
await page.addScriptTag({ url: base + '/shaka.js' });
const res = await page.evaluate(async ({ url, at }) => {
  const w = window;
  w.shaka.polyfill.installAll();
  const v = document.querySelector('video');
  const errors = [];
  const player = new w.shaka.Player();
  await player.attach(v);
  player.addEventListener('error', (e) => errors.push(`shaka ${e.detail?.code}`));
  await player.load(url, at);
  const variants = player.getManifest().variants;
  const withTrick = variants.filter((x) => x.video && x.video.trickModeVideo).length;
  v.play().catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  const from = v.currentTime;
  player.trickPlay(4);
  await new Promise((r) => setTimeout(r, 6000));
  const to = v.currentTime;
  player.cancelTrickPlay();
  await new Promise((r) => setTimeout(r, 1500));
  return { variants: variants.length, withTrick, errors, err: v.error ? v.error.message : null, from, to, after: v.currentTime };
}, { url: base + '/manifest.mpd', at: Math.max(0, loopP.start - 24) });
ok(`Shaka attaches a trick track to every variant (${res.withTrick} of ${res.variants})`, res.variants > 0 && res.withTrick === res.variants, res);
ok(`fast-forward crossed from the live Period into the loop Period (${res.from.toFixed(1)}s to ${res.to.toFixed(1)}s, loop from ${loopP.start.toFixed(1)}s)`, res.from < loopP.start && res.to > loopP.start, res);
ok(`it fetched the packager's live trick segments (${liveTrick.length}: ${liveTrick.slice(-2).join(', ')})`, liveTrick.length >= 1);
ok(`and the loop's keyframe slots (${loopTrick.length}: ${loopTrick.slice(0, 3).join(', ')})`, loopTrick.length >= 1);
ok('every request found', bad.length === 0, bad.slice(0, 5));
ok('no player or media error', res.errors.length === 0 && !res.err, res);
await browser.close(); srv.close();
console.log(`\nsplice_trick_dash_shaka: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
