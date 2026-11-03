// ============================================================================
//  DASH TRICK-MODE FOR FAST CHANNELS (build queue 3.2b-6 (a)).
//
//  A packaged asset made here with ffmpeg's DASH muxer (its HLS beside it, the
//  shape the FAST playout reads; $RepresentationID$ and $Number%05d$ names),
//  two video renditions and audio, a keyframe every 2 s. Checked:
//    - the trick track is cut from the smallest rendition at 360p or above;
//      one trick segment per segment, same numbers; each one fragment of one
//      sample lasting the whole segment, and init + it decodes to exactly the
//      segment's first picture; trick.json written last;
//    - built once: a second ask writes nothing; no MPD, or a segment that does
//      not open on a keyframe, refuses with the reason; nothing is written
//      outside the clips folder;
//    - queued once per asset (the timeline asks every 20 s);
//    - the playout (fast_playout.py) lists it in every Period of the channel's
//      MPD as a trick-mode set pointing at the video set, same numbers and
//      timeline as the rendition; not with trick-play off, not for an asset
//      without trick.json;
//    - Shaka in Chromium (when there): attaches the trick track to the
//      channel's video and fetches trick segments when fast-forwarding. VP9,
//      since the container's Chromium has no H.264.
//
//  Usage: DATABASE_URL=... npx tsx test/trickplay-fast-dash.check.ts
// ============================================================================
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

const WORK = mkdtempSync(join(tmpdir(), 'volt-fastdash-'));
const CLIPS = join(WORK, 'clips');
process.env.CLIPS_DIR = CLIPS;
process.env.ORIGIN_DIR = join(WORK, 'origin');
process.env.IMAGE_STORE_DIR = join(WORK, 'image-store');
process.env.VOD_STORE = 'local';
mkdirSync(CLIPS, { recursive: true });
const ROOT = resolve(__dirname, '..');
const PLAYOUT = resolve(ROOT, '../volt-encoder/bin/fast_playout.py');

let pass = 0, fail = 0;
const ok = (m: string, c: boolean, extra?: unknown) => {
  if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (extra === undefined ? '' : `  -> ${JSON.stringify(extra).slice(0, 400)}`)); }
};
const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

/** /clips/vod/<id>/: DASH + HLS over the same CMAF segments, two video sizes and audio. */
function makeAsset(id: string, vcodec: string[]) {
  const d = join(CLIPS, 'vod', id);
  mkdirSync(d, { recursive: true });
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=20', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
    '-map', '0:v', '-map', '0:v', '-map', '1:a', ...vcodec, '-g', '50', '-keyint_min', '50', '-sc_threshold', '0',
    '-b:v:0', '900k', '-s:v:0', '640x360', '-b:v:1', '300k', '-s:v:1', '320x180', '-c:a', 'aac', '-b:a', '64k',
    '-f', 'dash', '-dash_segment_type', 'mp4', '-seg_duration', '2', '-use_template', '1', '-use_timeline', '1', '-hls_playlist', '1',
    '-adaptation_sets', 'id=0,streams=v id=1,streams=a', join(d, 'manifest.mpd')]);
  return `/clips/vod/${id}/master.m3u8`;
}
const A = '00000000-0000-0000-0000-0000000f1a01';
const B = '00000000-0000-0000-0000-0000000f1a02';   // packaged, never given a trick track
const NOMPD = '00000000-0000-0000-0000-0000000f1a03';
const H264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-bf', '2'];
const mA = makeAsset(A, H264), mB = makeAsset(B, H264);
mkdirSync(join(CLIPS, 'vod', NOMPD), { recursive: true });
writeFileSync(join(CLIPS, 'vod', NOMPD, 'master.m3u8'), '#EXTM3U\n');

function boxesOf(b: Buffer, from = 0, to = b.length) {
  const out: { type: string; start: number; body: number; end: number }[] = [];
  let p = from;
  while (p + 8 <= to) { const size = b.readUInt32BE(p); if (size < 8 || p + size > to) break; out.push({ type: b.toString('latin1', p + 4, p + 8), start: p, body: p + 8, end: p + size }); p += size; }
  return out;
}
const firstFrameMd5 = (file: string) => execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0', '-frames:v', '1', '-f', 'framemd5', '-']).toString().trim().split('\n').filter((l) => !l.startsWith('#')).map((l) => l.split(',').pop()!.trim());
const frameCount = (file: string) => execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file]).toString().trim();

async function main() {
  const lad = await import('../src/services/trickplay/ladder');
  const { readInit } = await import('../src/services/frames/fmp4');

  console.log('== the trick track of a packaged asset ==');
  const mpd = readFileSync(join(CLIPS, 'vod', A, 'manifest.mpd'), 'utf8');
  const reps = lad.videoReps(mpd);
  ok(`two video renditions read from the MPD (${reps.map((r) => r.height).join(', ')})`, reps.length === 2);
  const tr = lad.trickRep(reps)!;
  ok(`cut from the smallest at 360p or above (${tr.height}p, id ${tr.id})`, tr.height === 360);
  ok(`its names resolved ($RepresentationID$, $Number%05d$): ${tr.init}, ${lad.segmentName(tr.media, 7)}`, !tr.init.includes('$') && /chunk-stream\d-00007\.m4s/.test(lad.segmentName(tr.media, 7)));
  ok('the next size down when there is nothing at 360p or above', lad.trickRep(reps.filter((r) => r.height < 360))!.height === 180);
  const order: string[] = [];
  const realPut: any = async (rel: string, body: Buffer) => {
    order.push(rel);
    const f = join(CLIPS, rel);
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, body);
  };
  const r1 = await lad.buildLadderTrick(mA, { put: realPut });
  ok(`built: ${r1.trick.segments} segments, ${r1.trick.media}`, r1.state === 'ready' && r1.trick.segments === tr.times.length && r1.trick.segments === 10);
  ok('trick.json is written last', order[order.length - 1] === `/vod/${A}/trick.json` && order.length === r1.trick.segments + 1);
  ok('same numbers as the rendition', order.slice(0, -1).every((p, i) => p.endsWith(`/seg_${tr.startNumber + i}.m4s`)));
  const dA = join(CLIPS, 'vod', A);
  const initBuf = readFileSync(join(dA, tr.init));
  const init = readInit(initBuf)!;
  let shape = 0, dur = 0, pic = 0;
  for (let i = 0; i < tr.times.length; i++) {
    const n = tr.startNumber + i;
    const t = readFileSync(join(dA, lad.segmentName(r1.trick.media, n)));
    const src = readFileSync(join(dA, lad.segmentName(tr.media, n)));
    const bx = boxesOf(t);
    const traf = bx[0]?.type === 'moof' ? boxesOf(t, bx[0].body, bx[0].end).find((b) => b.type === 'traf') : null;
    const trun = traf ? boxesOf(t, traf.body, traf.end).find((b) => b.type === 'trun') : null;
    if (bx.map((b) => b.type).join() === 'moof,mdat' && trun && t.readUInt32BE(trun.body + 4) === 1) shape++;
    if (trun && t.readUInt32BE(trun.body + 12) === Math.round((tr.times[i][1] * init.timescale) / tr.timescale)) dur++;
    const a = join(WORK, 'a.mp4'), b = join(WORK, 'b.mp4');
    writeFileSync(a, Buffer.concat([initBuf, t])); writeFileSync(b, Buffer.concat([initBuf, src]));
    if (frameCount(a) === '1' && firstFrameMd5(a)[0] === firstFrameMd5(b)[0]) pic++;
  }
  ok(`every trick segment is one fragment of one sample (${shape}/10)`, shape === 10);
  ok(`each lasts its whole segment (${dur}/10)`, dur === 10);
  ok(`init + it decodes to one picture, the segment's first (${pic}/10)`, pic === 10);
  const tj = JSON.parse(readFileSync(join(dA, 'trick.json'), 'utf8'));
  ok('trick.json says which rendition, where, and its bandwidth', tj.version === 1 && tj.rep === tr.id && tj.media === r1.trick.media && tj.bandwidth > 0);
  order.length = 0;
  const r2 = await lad.buildLadderTrick(mA, { put: realPut });
  ok('asked again: already made, nothing written', r2.state === 'exists' && order.length === 0);
  let err = '';
  try { await lad.buildLadderTrick(`/clips/vod/${NOMPD}/master.m3u8`, { put: realPut }); } catch (e: any) { err = e.message; }
  ok(`an asset with no DASH manifest is refused (${err})`, /no DASH manifest/.test(err));
  // A segment that does not open on a keyframe: the first sample's flags made non-sync.
  const C = '00000000-0000-0000-0000-0000000f1a04';
  execFileSync('cp', ['-r', join(CLIPS, 'vod', B), join(CLIPS, 'vod', C)]);
  const s3p = join(CLIPS, 'vod', C, lad.segmentName(tr.media, tr.startNumber + 2));
  const sb = readFileSync(s3p);
  const moof = boxesOf(sb).find((b) => b.type === 'moof')!;
  const trafB = boxesOf(sb, moof.body, moof.end).find((b) => b.type === 'traf')!;
  const trunB = boxesOf(sb, trafB.body, trafB.end).find((b) => b.type === 'trun')!;
  const tfl = sb.readUInt32BE(trunB.body) & 0xffffff;
  if (tfl & 0x04) { const p = trunB.body + 8 + (tfl & 0x01 ? 4 : 0); sb.writeUInt32BE(sb.readUInt32BE(p) | 0x00010000, p); }
  else { sb.writeUInt32BE((sb.readUInt32BE(trunB.body) | 0x04), trunB.body); }
  writeFileSync(s3p, sb);
  err = '';
  order.length = 0;
  try { await lad.buildLadderTrick(`/clips/vod/${C}/master.m3u8`, { put: realPut }); } catch (e: any) { err = e.message; }
  ok(`a segment that does not open on a keyframe refuses (${err})`, /does not open on a keyframe/.test(err) && !order.some((o) => o.endsWith('trick.json')));
  err = '';
  try { await lad.buildLadderTrick('/clips/../../etc/master.m3u8'); } catch (e: any) { err = e.message; }
  ok('nothing outside the clips folder', !!err && !existsSync('/etc/trick'));

  if (process.env.DATABASE_URL) {
    console.log('\n== queued once per asset ==');
    const { one, pool, query } = await import('../src/db');
    await query(`DELETE FROM jobs WHERE type = 'trickplay.ladder'`);
    await lad.queueLadderTricks([mA, mB, mA]);
    await lad.queueLadderTricks([mA, mB]);
    const n = Number((await one<any>(`SELECT count(*)::int AS n FROM jobs WHERE type = 'trickplay.ladder'`))?.n);
    ok(`two assets, asked twice: two jobs (${n})`, n === 2);
    await pool.end();
  }

  console.log('\n== the FAST playout lists it ==');
  const runPlayout = (tag: string, trickPlay: boolean, master: string, clips = CLIPS) => {
    const out = join(WORK, `out-${tag}`);
    const now = Date.now() / 1000, base = now - 30;
    const iso = (t: number) => new Date(t * 1000).toISOString();
    const tl = { channelId: 'c', segmentSec: 2, ladder: null, trickPlay, items: [
      { kind: 'content', id: 'x:0', start: iso(base), durationSec: 20, assetId: 'film', master, inSec: 0, outSec: 20 },
      { kind: 'content', id: 'x:1', start: iso(base + 20), durationSec: 20, assetId: 'film', master, inSec: 0, outSec: 20 }] };
    const tf = join(WORK, `tl-${tag}.json`);
    writeFileSync(tf, JSON.stringify(tl));
    const p = spawnSync('python3', [PLAYOUT, '--channel', 'c', '--out', out, '--clips-dir', clips, '--timeline-file', tf, '--once'], { encoding: 'utf8', timeout: 60000 });
    const m = existsSync(join(out, 'manifest.mpd')) ? readFileSync(join(out, 'manifest.mpd'), 'utf8') : '';
    return { m, err: p.stderr ?? '' };
  };
  if (spawnSync('python3', ['-c', 'import sys']).status !== 0) { console.log('SKIP the playout part: no python3'); }
  else {
    const on = runPlayout('on', true, mA);
    const periods = [...on.m.matchAll(/<Period\b[\s\S]*?<\/Period>/g)].map((x) => x[0]);
    const tricks = periods.map((p) => /<AdaptationSet id="2"[\s\S]*?<\/AdaptationSet>/.exec(p)?.[0] ?? '');
    ok(`every Period has a trick-mode set (${tricks.filter(Boolean).length}/${periods.length})`, periods.length >= 2 && tricks.every(Boolean), on.err.slice(-400));
    ok('pointing at the video set (id 0), after it', tricks.every((t) => /<EssentialProperty schemeIdUri="http:\/\/dashif.org\/guidelines\/trickmode" value="0"\/>/.test(t)) && periods.every((p) => /<AdaptationSet id="0" contentType="video"/.test(p)));
    ok('its segments are the asset\'s trick files, on the main init', tricks.every((t) => t.includes(`media="/clips/vod/${A}/trick/`) && t.includes(`initialization="/clips/vod/${A}/${tr.init}"`)) && /maxPlayoutRate="50"/.test(tricks[0]) && /codingDependency="false"/.test(tricks[0]));
    // the same numbers and timeline as the rendition it was cut from
    const same = periods.every((p) => {
      const main = [...p.matchAll(/<Representation id="(v\d+)"[^>]*>\s*<SegmentTemplate([^>]*)>\s*<SegmentTimeline>([\s\S]*?)<\/SegmentTimeline>/g)];
      const trick = /<Representation id="(v\d+)_trick"[^>]*>\s*<SegmentTemplate([^>]*)>\s*<SegmentTimeline>([\s\S]*?)<\/SegmentTimeline>/.exec(p);
      const m = trick ? main.find((x) => x[1] === trick[1]) : null;
      const strip = (t: string) => t.replace(/\s(initialization|media)="[^"]*"/g, '');
      return !!m && strip(m[2]) === strip(trick![2]) && m[3].replace(/\s/g, '') === trick![3].replace(/\s/g, '');
    });
    ok('same numbers and timeline as its rendition, in every Period', same);
    ok('the MPD parses as XML', spawnSync('python3', ['-c', 'import sys,xml.dom.minidom as m; m.parseString(sys.stdin.read())'], { input: on.m }).status === 0);
    const off = runPlayout('off', false, mA);
    ok('trick-play off: no trick-mode set', off.m.includes('<Period') && !off.m.includes('trickmode'));
    const none = runPlayout('none', true, mB);
    ok('an asset without its trick track yet: none listed, the rest as before', none.m.includes('<Period') && !none.m.includes('trickmode'));
    ok('no errors in the playout\'s log', !/Traceback|tick failed/.test(on.err + off.err + none.err), (on.err + off.err + none.err).slice(-400));
  }

  // ---- Shaka in Chromium
  const SHAKA = resolve(ROOT, '../volt-player/node_modules/shaka-player/dist/shaka-player.compiled.js');
  let pw: any = null;
  try { pw = require(require.resolve('playwright-core', { paths: [ROOT, process.cwd()] })); } catch { /* */ }
  const vp9 = /libvpx-vp9/.test(spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout?.toString() ?? '');
  if (!pw || !existsSync(SHAKA) || !vp9) { console.log(`SKIP the browser part: ${!pw ? 'no playwright-core' : !existsSync(SHAKA) ? 'no shaka-player in volt-player' : 'no libvpx-vp9'}`); }
  else {
    console.log('\n== Shaka in Chromium ==');
    const V = '00000000-0000-0000-0000-0000000f1a09';
    const mV = makeAsset(V, ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-lag-in-frames', '0', '-auto-alt-ref', '0']);
    await lad.buildLadderTrick(mV, { put: realPut });
    const r = runPlayout('vp9', true, mV);
    ok('the channel\'s MPD lists the trick track', r.m.includes('trickmode'));
    const outDir = join(WORK, 'out-vp9');
    const srv = http.createServer((req, res) => {
      const u = decodeURIComponent((req.url || '/').split('?')[0]);
      if (u === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><body><video muted playsinline style="width:640px"></video></body>'); return; }
      if (u === '/shaka.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end(readFileSync(SHAKA)); return; }
      const f = u.startsWith('/clips/') ? join(CLIPS, u.slice(7)) : join(outDir, u);
      if (!existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': f.endsWith('.mpd') ? 'application/dash+xml' : 'video/mp4' }); res.end(readFileSync(f));
    }).listen(0);
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const browser = await pw.chromium.launch({ ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}), args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = await (await browser.newContext()).newPage();
    await page.addInitScript('window.__name = (f) => f');
    const trickReqs: string[] = [], bad: string[] = [];
    page.on('request', (q: any) => { if (/\/trick\//.test(q.url())) trickReqs.push(q.url()); });
    page.on('response', (q: any) => { if (/\/trick\//.test(q.url()) && q.status() !== 200) bad.push(`${q.status()} ${q.url()}`); });
    await page.goto(base + '/');
    await page.addScriptTag({ url: base + '/shaka.js' });
    const res = await page.evaluate(async (url: string) => {
      const w: any = window as any;
      w.shaka.polyfill.installAll();
      const v = document.querySelector('video') as any;
      const errors: string[] = [];
      const player = new w.shaka.Player();
      await player.attach(v);
      player.addEventListener('error', (e: any) => errors.push(`shaka ${e.detail?.code}`));
      player.configure({ manifest: { disableIFrames: false } });
      await player.load(url, 0);
      const variants = player.getManifest().variants;
      const withTrick = variants.filter((x: any) => x.video && x.video.trickModeVideo).length;
      // not awaited: on a live (dynamic) MPD play() can stay pending in a headless browser
      v.play().catch(() => {});
      await new Promise((r) => setTimeout(r, 1000));
      player.trickPlay(4);
      await new Promise((r) => setTimeout(r, 3000));
      player.cancelTrickPlay();
      return { variants: variants.length, withTrick, errors, err: v.error ? v.error.message : null };
    }, base + '/manifest.mpd');
    ok(`Shaka attaches a trick track to the channel's video (${res.withTrick} of ${res.variants})`, res.variants > 0 && res.withTrick === res.variants, res);
    ok(`fast-forward fetches trick segments (${trickReqs.length}), all found`, trickReqs.length >= 1 && bad.length === 0, { trickReqs: trickReqs.slice(0, 3), bad });
    ok('no player or media error', res.errors.length === 0 && !res.err, res);
    await browser.close(); srv.close();
  }

  console.log(`\ntrickplay-fast-dash: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
