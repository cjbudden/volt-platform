// ============================================================================
//  DASH TRICK-PLAY INSIDE A RIGHTS VARIANT (build queue 3.2b-10 (d2)).
//
//  A live channel's delivered output on disk as the encoder leaves it with
//  trick-play on: CMAF made with ffmpeg (the programme RED), the packager's
//  keyframe-only set `360p_trick/` in manifest.mpd (listed BEFORE the video set
//  here, so the variant must not take it for the lead), and the pre-built loop
//  (BLUE) in filler/ with its keyframes prepared by the encoder's own
//  prepare_loop_trick (filler/360p/trick/k_<i>.m4s). An audience blacked out
//  from a minute ago gets the variant MPD. Checked:
//    - every Period of the variant has one trick-mode set naming its video set;
//    - the live Period's lists only the programme's trick segments before the
//      window, as delivered;
//    - each loop Period's lists the loop's keyframes slot for slot with its
//      video (same timeline), each decoding alone to exactly one picture, the
//      loop segment's first, BLUE, at the time it is listed: not one programme
//      picture inside the window;
//    - a loop prepared before 3.2b-10 (keyframes all at time 0) or with a
//      keyframe missing: no trick set in any Period, as before, never the
//      programme's keyframes inside a window;
//    - no window at all: the MPD as delivered, trick set kept.
//  With TRICKVAR_SHAKA=<shaka-player.compiled.js> (and TRICKVAR_CODEC=vp9 where
//  Chromium has no H.264): Shaka plays the variant and fast-forwards from the
//  live Period into the loop, fetching both kinds of trick segment, no error.
//
//  Usage: npx tsx test/trickplay-variants-dash.check.ts   (no database)
// ============================================================================
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGIN = mkdtempSync(join(tmpdir(), 'volt-trickvar-dash-'));
process.env.ORIGIN_DIR = ORIGIN;
process.env.VARIANT_SOURCE_CACHE_MS = '0';
let pass = 0, fail = 0;
const ok = (m: string, c: boolean, extra?: unknown) => {
  if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (extra === undefined ? '' : `  -> ${JSON.stringify(extra).slice(0, 400)}`)); }
};
const VP9 = process.env.TRICKVAR_CODEC === 'vp9';
const CODEC = VP9 ? 'vp09.00.20.08' : 'avc1.64000d';
const CH = '00000000-0000-0000-0000-0000000f9a02';
const dir = join(ORIGIN, CH);
const BIN = join(__dirname, '..', '..', 'volt-encoder', 'bin');
const QUIET = { stdio: ['ignore', 'pipe', 'ignore'] as any };

// 80 s of programme (RED) and 20 s of loop (BLUE), 4 s segments, a keyframe each
function cmaf(out: string, colour: string, secs: number) {
  mkdirSync(out, { recursive: true });
  const enc = VP9 ? ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-lag-in-frames', '0', '-auto-alt-ref', '0', '-b:v', '300k']
    : ['-c:v', 'libx264', '-preset', 'ultrafast', '-sc_threshold', '0'];
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${colour}:size=320x180:rate=25:duration=${secs},drawtext=text='%{n}':fontsize=40:x=10:y=10:fontcolor=white`,
    ...enc, '-g', '100', '-keyint_min', '100', '-pix_fmt', 'yuv420p',
    '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-start_number', '1',
    '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', join(out, 'seg_%d.m4s'), join(out, 'index.m3u8')]);
}
cmaf(join(dir, '360p'), 'red', 80);
cmaf(join(dir, 'filler', '360p'), 'blue', 20);
const py = (code: string) => execFileSync('python3', ['-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(BIN)})\n${code}`], { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] }).toString();

// the packager's trick set: one keyframe lasting each segment, same numbers (as 3.2b-8's test)
mkdirSync(join(dir, '360p_trick'));
copyFileSync(join(dir, '360p', 'init.mp4'), join(dir, '360p_trick', 'init.mp4'));
py(`
import mp4util
for n in range(1, 21):
    s = f"360p/seg_{n}.m4s"
    open(f"360p_trick/seg_{n}.m4s", "wb").write(mp4util.keyframe_fragment(open(s, "rb").read(), mp4util.frag_duration(s, "360p/init.mp4")))
`);
// the loop as the encoder copies it beside the run, and its keyframes prepared by the encoder itself
const LOOPN = 5;
const prepare = (tfdt: 'own' | 'zero') => py(`
import encoder, mp4util
segs = [{"uri": f"filler/360p/seg_{i}.m4s", "dur": 4.0, "d": mp4util.frag_duration(f"filler/360p/seg_{i}.m4s", "filler/360p/init.mp4")} for i in range(1, ${LOOPN + 1})]
fl = {"360p": {"init": "filler/360p/init.mp4", "timescale": mp4util.timescale("filler/360p/init.mp4"), "segments": segs}}
if ${JSON.stringify(tfdt)} == "own":
    print(json.dumps(encoder.prepare_loop_trick(fl, ".")))
else:
    # what an encoder before 3.2b-10 wrote: every keyframe at decode time 0
    for i, s in enumerate(segs):
        open(f"filler/360p/trick/k_{i + 1}.m4s", "wb").write(mp4util.keyframe_fragment(open(s["uri"], "rb").read(), s["d"], 0))
    print("[]")
`);
const filler = (hash: string) => writeFileSync(join(dir, 'filler', 'filler.json'), JSON.stringify({ hash, segment_seconds: 4, loop_seconds: 20,
  tracks: { '360p': { kind: 'video', init: '360p/init.mp4', segments: Array.from({ length: LOOPN }, (_, i) => ({ uri: `360p/seg_${i + 1}.m4s`, dur: 4 })) } } }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { readInit, readFragments } = require('../src/services/frames/fmp4');
const progInit = readInit(readFileSync(join(dir, '360p', 'init.mp4')));
const TS = progInit.timescale;
const segFacts = (n: number) => readFragments(readFileSync(join(dir, '360p', `seg_${n}.m4s`)), progInit);
const now = Math.floor(Date.now() / 1000);
const t0 = now - 80;
const iso = (s: number) => new Date(s * 1000).toISOString();
const pto = segFacts(1).baseDecodeTime;
const tl = Array.from({ length: 20 }, (_, i) => { const f = segFacts(i + 1); return `<S t="${f.baseDecodeTime}" d="${f.durations.reduce((a: number, b: number) => a + b, 0)}"/>`; }).join('');
const TRICK = `<AdaptationSet id="1" contentType="video" mimeType="video/mp4" segmentAlignment="true" maxWidth="320" maxHeight="180"><EssentialProperty schemeIdUri="http://dashif.org/guidelines/trickmode" value="0"/><Representation id="t360" bandwidth="40000" codecs="${CODEC}" width="320" height="180" maxPlayoutRate="4"><SegmentTemplate timescale="${TS}" presentationTimeOffset="${pto}" initialization="360p_trick/init.mp4" media="360p_trick/seg_$Number$.m4s" startNumber="1"><SegmentTimeline>${tl}</SegmentTimeline></SegmentTemplate></Representation></AdaptationSet>`;
const VIDEO = `<AdaptationSet id="0" contentType="video" mimeType="video/mp4" segmentAlignment="true" maxWidth="320" maxHeight="180"><Representation id="v360" bandwidth="300000" codecs="${CODEC}" width="320" height="180"><SegmentTemplate timescale="${TS}" presentationTimeOffset="${pto}" initialization="360p/init.mp4" media="360p/seg_$Number$.m4s" startNumber="1"><SegmentTimeline>${tl}</SegmentTimeline></SegmentTemplate></Representation></AdaptationSet>`;
const MPD = `<?xml version="1.0" encoding="UTF-8"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" profiles="urn:mpeg:dash:profile:isoff-live:2011" availabilityStartTime="${iso(t0)}" publishTime="${iso(now)}" minimumUpdatePeriod="PT4S" timeShiftBufferDepth="PT80S" maxSegmentDuration="PT4S" minBufferTime="PT4S"><Period id="p0" start="PT0S">${TRICK}${VIDEO}</Period></MPD>\n`;
writeFileSync(join(dir, 'manifest.mpd'), MPD);

const xmlOk = (xml: string) => { try { execFileSync('python3', ['-c', 'import sys,xml.dom.minidom as m; m.parseString(sys.stdin.read())'], { input: xml }); return true; } catch { return false; } };
const attr = (tag: string, n: string) => new RegExp(`\\s${n}="([^"]*)"`).exec(tag)?.[1] ?? null;
const sOf = (tpl: string) => {
  const out: { t: number; d: number }[] = [];
  let t = 0;
  for (const m of tpl.matchAll(/<S\b[^>]*\/>/g)) {
    const tt = attr(m[0], 't'), d = Number(attr(m[0], 'd')), r = Number(attr(m[0], 'r') ?? 0);
    if (tt != null) t = Number(tt);
    for (let k = 0; k <= r; k++) { out.push({ t, d }); t += d; }
  }
  return out;
};
interface Per { id: string; start: number; xml: string; trick: string[]; video: string | null }
const periodsOf = (mpd: string): Per[] => [...mpd.matchAll(/<Period\b[^>]*>[\s\S]*?<\/Period>/g)].map((m) => {
  const open = m[0].match(/^<Period\b[^>]*>/)![0];
  const sets = [...m[0].matchAll(/<AdaptationSet\b[^>]*>[\s\S]*?<\/AdaptationSet>/g)].map((x) => x[0]);
  return { id: attr(open, 'id')!, start: Number(/PT([\d.]+)S/.exec(attr(open, 'start') ?? 'PT0S')![1]), xml: m[0],
    trick: sets.filter((s) => s.includes('trickmode')), video: sets.find((s) => !s.includes('trickmode') && s.includes('contentType="video"')) ?? null };
});
const local = (u: string) => join(dir, u.replace(/^\/origin\/[^/]+\/live\//, ''));
/** [frames, keyframe first, [r,g,b], md5 of its picture] of init + seg. */
function look(init: string, seg: string) {
  const f = join(ORIGIN, 'probe.mp4');
  writeFileSync(f, Buffer.concat([readFileSync(init), readFileSync(seg)]));
  const fl = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=flags', '-of', 'csv=p=0', f], QUIET).toString().trim().split('\n').filter(Boolean);
  const px = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], QUIET);
  const md = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-frames:v', '1', '-f', 'framemd5', '-'], QUIET).toString().split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop()!.trim())[0];
  return { n: fl.length, key: fl[0]?.startsWith('K') ?? false, rgb: [px[0], px[1], px[2]], md };
}
const isBlue = (c: number[]) => c[2] > 150 && c[0] < 80;
const isRed = (c: number[]) => c[0] > 150 && c[2] < 80;

async function main() {
  const vm = await import('../src/services/variantManifest');
  const WSTART = now - 60;
  const W: any = [[WSTART, now + 600, 'loop:filler-1']];
  const render = async (timeline: any = W) => (await vm.renderVariant({ kind: 'channel', id: CH, key: 'vdash1', file: 'manifest.mpd', timeline }))!.body;

  console.log('== the loop\'s keyframes, prepared by the encoder ==');
  const done = JSON.parse(prepare('own').trim().split('\n').pop()!);   // the encoder logs to stdout first
  filler('h-own');
  ok(`prepare_loop_trick made them for 360p (${JSON.stringify(done)})`, done.length === 1 && done[0] === '360p' && existsSync(join(dir, 'filler', '360p', 'trick', `k_${LOOPN}.m4s`)));
  const loopInit = readInit(readFileSync(join(dir, 'filler', '360p', 'init.mp4')));
  let own = 0;
  for (let i = 1; i <= LOOPN; i++) {
    const k = readFragments(readFileSync(join(dir, 'filler', '360p', 'trick', `k_${i}.m4s`)), loopInit);
    const s = readFragments(readFileSync(join(dir, 'filler', '360p', `seg_${i}.m4s`)), loopInit);
    own += Number(k.durations.length === 1 && k.baseDecodeTime === s.baseDecodeTime && k.durations[0] === s.durations.reduce((a: number, b: number) => a + b, 0));
  }
  ok(`each one keyframe at its segment's own decode time, lasting the segment (${own}/${LOOPN})`, own === LOOPN);

  console.log('\n== the variant MPD ==');
  const out = await render();
  ok('valid XML', xmlOk(out));
  const ps = periodsOf(out);
  const live = ps.filter((p) => !p.xml.includes('/filler/360p/seg_')), loops = ps.filter((p) => p.xml.includes('/filler/360p/seg_'));
  ok(`one live Period before the window and three loop passes (${live.length} + ${loops.length})`, live.length === 1 && loops.length === 3);
  ok(`a trick-mode set in every Period (${ps.filter((p) => p.trick.length === 1).length}/${ps.length})`, ps.every((p) => p.trick.length === 1));
  ok('each names that Period\'s video set', ps.every((p) => p.video && attr(p.trick[0], 'value') === attr(p.video.match(/^<AdaptationSet\b[^>]*>/)![0], 'id')));
  ok('the lead is the video set, not the trick set listed before it (loop video Periods built)', loops.every((p) => /filler\/360p\/seg_\$Number\$\.m4s/.test(p.video ?? '')));

  console.log('\n== outside the window: the stream\'s own trick set ==');
  const lt = live[0].trick[0];
  const ltpl = lt.match(/<SegmentTemplate\b[^>]*>/)![0];
  const lsegs = sOf(lt);
  const first = Number(attr(ltpl, 'startNumber'));
  ok(`the packager's segments, absolute (${attr(ltpl, 'media')})`, attr(ltpl, 'media') === `/origin/${CH}/live/360p_trick/seg_$Number$.m4s` && attr(ltpl, 'initialization') === `/origin/${CH}/live/360p_trick/init.mp4`);
  const wallOf = (t: number) => t0 + (t - pto) / TS;
  ok(`only those starting before the window (${lsegs.length}, numbers ${first} to ${first + lsegs.length - 1})`, lsegs.length === 5 && first === 1 && lsegs.every((g) => wallOf(g.t) < WSTART));
  let liveRed = 0;
  for (let i = 0; i < lsegs.length; i++) { const r = look(join(dir, '360p_trick', 'init.mp4'), join(dir, '360p_trick', `seg_${first + i}.m4s`)); liveRed += Number(r.n === 1 && isRed(r.rgb)); }
  ok(`each the programme's keyframe (${liveRed}/5)`, liveRed === 5);

  console.log('\n== inside the window: the loop\'s keyframes ==');
  let slots = 0, alone = 0, same = 0, blue = 0, red = 0, timed = 0, grid = 0, codecs = 0;
  for (const p of loops) {
    const tt = p.trick[0];
    const tpl = tt.match(/<SegmentTemplate\b[^>]*>/)![0];
    const media = attr(tpl, 'media')!, init = attr(tpl, 'initialization')!;
    const vs = sOf(p.video!), ts = sOf(tt);
    grid += Number(JSON.stringify(vs) === JSON.stringify(ts) && media === `/origin/${CH}/live/filler/360p/trick/k_$Number$.m4s` && init === `/origin/${CH}/live/filler/360p/init.mp4` && attr(tpl, 'startNumber') === '1');
    codecs += Number(attr(tt.match(/<Representation\b[^>]*>/)![0], 'codecs') === attr(p.video!.match(/<Representation\b[^>]*>/)![0], 'codecs'));
    for (let i = 0; i < ts.length; i++) {
      slots++;
      const k = local(media.replace('$Number$', String(i + 1)));
      const r = look(local(init), k);
      alone += Number(r.n === 1 && r.key);
      same += Number(r.md === look(local(init), join(dir, 'filler', '360p', `seg_${i + 1}.m4s`)).md);
      blue += Number(isBlue(r.rgb));
      red += Number(isRed(r.rgb));
      const f = readFragments(readFileSync(k), loopInit);
      timed += Number(Math.abs(f.baseDecodeTime / loopInit.timescale - ts[i].t / 1000) < 0.002);
    }
  }
  ok(`slot for slot the loop Period's video timeline, the loop's keyframes from 1 (${grid}/${loops.length})`, grid === loops.length);
  ok(`the loop video set's codecs (${codecs}/${loops.length})`, codecs === loops.length);
  ok(`every slot decodes alone to one keyframe (${alone}/${slots})`, slots === 15 && alone === slots);
  ok(`the loop segment's first picture (${same}/${slots})`, same === slots);
  ok(`at the time it is listed (${timed}/${slots})`, timed === slots);
  ok(`all the loop's, not one programme picture inside the window (${blue} blue, ${red} red)`, blue === slots && red === 0);

  console.log('\n== loops without keyframes of their own ==');
  prepare('zero');
  filler('h-zero');
  const z = await render();
  ok('keyframes all at time 0 (a loop prepared before 3.2b-10): no trick set in any Period', !z.includes('trickmode') && !z.includes('_trick/') && !z.includes('/trick/k_') && periodsOf(z).length === 4);
  prepare('own');
  renameSync(join(dir, 'filler', '360p', 'trick', 'k_3.m4s'), join(dir, 'filler', '360p', 'trick', 'x.m4s'));
  filler('h-missing');
  const mi = await render();
  ok('a keyframe missing: no trick set in any Period', !mi.includes('trickmode') && periodsOf(mi).length === 4);
  renameSync(join(dir, 'filler', '360p', 'trick', 'x.m4s'), join(dir, 'filler', '360p', 'trick', 'k_3.m4s'));
  filler('h-own');
  ok('back again once it is there', (await render()).includes('/trick/k_$Number$.m4s'));

  console.log('\n== no window ==');
  const plain = await render([]);
  const strip = (s: string) => s.replace(/\s*<Location>[^<]*<\/Location>/, '');
  ok('the MPD as delivered, its trick set kept', strip(plain).includes('trickmode') && periodsOf(plain).length === 1 && !plain.includes('filler'));

  const SHAKA = process.env.TRICKVAR_SHAKA;
  if (SHAKA) await shaka(out, SHAKA);
  console.log(`\ntrickplay-variants-dash: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

/** Shaka Player over the variant MPD, made static (same Periods, rebased to 0). */
async function shaka(variant: string, shakaJs: string) {
  console.log('\n== Shaka in Chromium ==');
  const http = await import('node:http');
  const pers = [...variant.matchAll(/<Period id="([^"]+)" start="PT([\d.]+)S"(?: duration="PT([\d.]+)S")?>([\s\S]*?)<\/Period>/g)];
  const p0 = Number(pers[0][2]);
  const last = pers[pers.length - 1];
  let lastEnd = 0;
  for (const m of last[4].matchAll(/<SegmentTemplate timescale="(\d+)" presentationTimeOffset="(\d+)"[^>]*>([\s\S]*?)<\/SegmentTemplate>/g)) {
    const s = sOf(m[3]);
    if (s.length) lastEnd = Math.max(lastEnd, (s[s.length - 1].t + s[s.length - 1].d - Number(m[2])) / Number(m[1]));
  }
  const total = Number(last[2]) - p0 + lastEnd;
  const loopStart = Number(pers.find((p) => /\/filler\/360p\/seg_/.test(p[4]))![2]) - p0;
  const mpd = variant.replace(/<Period id="([^"]+)" start="PT([\d.]+)S"/g, (_a, id, s) => `<Period id="${id}" start="PT${(Number(s) - p0).toFixed(3)}S"`)
    .replace(/type="dynamic"[^>]*?(?=>)/, `type="static" mediaPresentationDuration="PT${total.toFixed(3)}S" minBufferTime="PT2S"`);
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent((req.url || '/').split('?')[0]);
    if (u === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><body><video muted playsinline></video></body>'); return; }
    if (u === '/shaka.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end(readFileSync(shakaJs)); return; }
    if (u === '/v.mpd') { res.writeHead(200, { 'content-type': 'application/dash+xml' }); res.end(mpd); return; }
    const f = local(u);
    if (!u.startsWith(`/origin/${CH}/live/`) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(readFileSync(f));
  }).listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pw = require('playwright');
  const browser = await pw.chromium.launch({ ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}), args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await (await browser.newContext()).newPage();
  const liveTrick: string[] = [], loopTrick: string[] = [], bad: string[] = [];
  page.on('response', (q: any) => {
    const u = q.url();
    if (/360p_trick\/seg_/.test(u)) liveTrick.push(u.split('/').pop());
    if (/\/trick\/k_/.test(u)) loopTrick.push(u.split('/').pop());
    if (q.status() !== 200 && !u.endsWith('favicon.ico')) bad.push(`${q.status()} ${u}`);
  });
  await page.goto(base + '/');
  await page.addScriptTag({ url: base + '/shaka.js' });
  const res = await page.evaluate(async ({ url, at }: any) => {
    const w = window as any;
    w.shaka.polyfill.installAll();
    const v = document.querySelector('video') as HTMLVideoElement;
    const errors: string[] = [];
    const player = new w.shaka.Player();
    await player.attach(v);
    // a short buffer, so the live Period is still ahead when fast-forward starts
    player.configure({ streaming: { bufferingGoal: 4, rebufferingGoal: 1 } });
    player.addEventListener('error', (e: any) => errors.push(`shaka ${e.detail?.code}`));
    try { await player.load(url, at); } catch (e: any) { return { loadError: `shaka ${e?.code} ${JSON.stringify(e?.data ?? []).slice(0, 300)}` } as any; }
    const variants = player.getManifest().variants;
    const withTrick = variants.filter((x: any) => x.video && x.video.trickModeVideo).length;
    v.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    const from = v.currentTime;
    player.trickPlay(4);
    // until the playhead is well into the loop, or 15 s
    for (let i = 0; i < 30 && v.currentTime < at + 28; i++) await new Promise((r) => setTimeout(r, 500));
    const to = v.currentTime;
    player.cancelTrickPlay();
    await new Promise((r) => setTimeout(r, 1500));
    return { variants: variants.length, withTrick, errors, err: v.error ? v.error.message : null, from, to };
  }, { url: base + '/v.mpd', at: Math.max(0, loopStart - 16) });
  ok(`Shaka loads the variant (${(res as any).loadError ?? 'ok'})`, !(res as any).loadError);
  if ((res as any).loadError) { await browser.close(); srv.close(); return; }
  ok(`Shaka attaches a trick track to the variant (${res.withTrick} of ${res.variants})`, res.variants > 0 && res.withTrick === res.variants, res);
  ok(`fast-forward crossed from the live Period into the loop (${res.from.toFixed(1)}s to ${res.to.toFixed(1)}s, loop from ${loopStart.toFixed(1)}s)`, res.from < loopStart && res.to > loopStart, res);
  ok(`it fetched the stream's trick segments (${liveTrick.length}) and the loop's keyframes (${loopTrick.length}: ${loopTrick.slice(0, 3).join(', ')})`, liveTrick.length >= 1 && loopTrick.length >= 1);
  ok('every request found', bad.length === 0, bad.slice(0, 5));
  ok('no player or media error', res.errors.length === 0 && !res.err, res);
  await browser.close();
  srv.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
