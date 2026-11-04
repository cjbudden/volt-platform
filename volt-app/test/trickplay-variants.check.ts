// ============================================================================
//  TRICK-PLAY INSIDE A RIGHTS VARIANT (build queue 3.2b-9 (d), HLS).
//
//  A live channel's delivered output on disk as the encoder leaves it while
//  playout runs: CMAF made with ffmpeg (the programme RED), its delivered
//  I-frame playlist 720p.iframes_cc.m3u8 (a time and a keyframe byte range on
//  every entry), and the pre-built loop (BLUE) in filler/ with filler.json.
//  An audience blacked out from a minute ago gets the variant. Checked:
//    - the variant master lists the delivered I-frame playlist, relative, with
//      the tester's carry; never the packager's own (no times on its entries);
//    - the variant I-frame playlist: every slot kept with the source's media
//      and discontinuity sequence; before the window the programme's entries
//      as they were; inside it the loop's keyframes, each a byte range that
//      decodes alone to exactly one picture, the loop segment's first, and is
//      BLUE: not one programme picture inside the window;
//    - discontinuities and EXT-X-MAP where it switches, as the variant media
//      playlist has them; slots line up with the variant media playlist;
//    - a loop whose keyframes cannot be read: refused, never the programme;
//    - the packager's own I-frame playlist (no times): refused as before;
//    - an audience with no window: the I-frame playlist as delivered.
//
//  Usage: npx tsx test/trickplay-variants.check.ts   (no database)
// ============================================================================
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGIN = mkdtempSync(join(tmpdir(), 'volt-trickvar-'));
process.env.ORIGIN_DIR = ORIGIN;
process.env.VARIANT_SOURCE_CACHE_MS = '0';
let pass = 0, fail = 0;
const ok = (m: string, c: boolean, extra?: unknown) => {
  if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (extra === undefined ? '' : `  -> ${JSON.stringify(extra).slice(0, 400)}`)); }
};
const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const CH = '00000000-0000-0000-0000-0000000f9a01';
const dir = join(ORIGIN, CH);
mkdirSync(join(dir, '720p'), { recursive: true });
mkdirSync(join(dir, 'filler', '720p'), { recursive: true });
// 80 s of programme (RED) in 4 s segments, a keyframe each; 20 s of loop (BLUE).
const cmaf = (out: string, colour: string, secs: number) => ff(['-f', 'lavfi', '-i', `color=c=${colour}:size=320x180:rate=25:duration=${secs},drawtext=text='%{n}':fontsize=40:x=10:y=10:fontcolor=white`,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '100', '-keyint_min', '100', '-sc_threshold', '0', '-bf', '2',
  '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-start_number', '1',
  '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', join(out, 'seg_%d.m4s'), join(out, 'index.m3u8')]);
try { cmaf(join(dir, '720p'), 'red', 80); } catch { cmaf(join(dir, '720p'), 'red', 80); }
cmaf(join(dir, 'filler', '720p'), 'blue', 20);

// the opening keyframe's byte range, as the encoder lists it (the same reader it uses)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { keyframeRanges } = require('../src/services/trickplay/iframes');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { readInit } = require('../src/services/frames/fmp4');
const progInit = readInit(readFileSync(join(dir, '720p', 'init.mp4')));
function keyframeOf(file: string): [number, number] {
  const k = keyframeRanges(readFileSync(file), progInit)[0];
  return [k.start, k.end - k.start];
}
const now = Math.floor(Date.now() / 1000);
const t0 = now - 80;
const iso = (s: number) => new Date(s * 1000).toISOString();
// the delivered media and I-frame playlists of the 720p variant: 20 slots of 4 s
const N = 20;
const media = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:100', '#EXT-X-DISCONTINUITY-SEQUENCE:2', '#EXT-X-MAP:URI="720p/init.mp4"'];
const ifr = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:100', '#EXT-X-DISCONTINUITY-SEQUENCE:2', '#EXT-X-I-FRAMES-ONLY', '#EXT-X-MAP:URI="720p/init.mp4"'];
for (let i = 0; i < N; i++) {
  const seg = `720p/seg_${i + 1}.m4s`;
  const [o, l] = keyframeOf(join(dir, seg));
  media.push(`#EXT-X-PROGRAM-DATE-TIME:${iso(t0 + i * 4)}`, '#EXTINF:4.000,', seg);
  ifr.push(`#EXT-X-PROGRAM-DATE-TIME:${iso(t0 + i * 4)}`, '#EXTINF:4.000,', `#EXT-X-BYTERANGE:${l}@${o}`, seg);
}
writeFileSync(join(dir, 'stream_0_cc.m3u8'), media.join('\n') + '\n');
writeFileSync(join(dir, '720p.iframes_cc.m3u8'), ifr.join('\n') + '\n');
writeFileSync(join(dir, '720p.iframes.m3u8'), ifr.filter((l) => !l.startsWith('#EXT-X-PROGRAM-DATE-TIME')).join('\n') + '\n');
writeFileSync(join(dir, 'master_cc.m3u8'), ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=320x180,CODECS="avc1.64000d"', 'stream_0_cc.m3u8',
  '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,CODECS="avc1.64000d",RESOLUTION=320x180,URI="720p.iframes.m3u8"',
  '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,CODECS="avc1.64000d",RESOLUTION=320x180,URI="720p.iframes_cc.m3u8"', ''].join('\n'));
const loopSegs = readdirSync(join(dir, 'filler', '720p')).filter((f) => /^seg_\d+\.m4s$/.test(f)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
writeFileSync(join(dir, 'filler', 'filler.json'), JSON.stringify({ hash: 'h', segment_seconds: 4, loop_seconds: 20,
  tracks: { '720p': { kind: 'video', init: '720p/init.mp4', segments: loopSegs.map((f) => ({ uri: `720p/${f}`, dur: 4 })) } } }));

// A range ends inside its mdat (as Apple's I-frame entries do); ffmpeg says so, and decodes it.
const QUIET = { stdio: ['ignore', 'pipe', 'ignore'] as any };
/** Mean colour of the first picture of init + a byte range, as [r, g, b]. */
const rgb = (file: string) => {
  const b = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], QUIET);
  return [b[0], b[1], b[2]];
};
const frames = (file: string) => execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file], QUIET).toString().trim();
const md5first = (file: string) => execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'framemd5', '-'], QUIET).toString().split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop()!.trim())[0];

interface Ent { uri: string; range: [number, number] | null; pdt: number; disc: boolean; map: string | null }
function entries(text: string) {
  const out: Ent[] = [];
  let range: [number, number] | null = null, pdt = NaN, disc = false, map: string | null = null;
  for (const l of text.split('\n')) {
    if (l === '#EXT-X-DISCONTINUITY') disc = true;
    else if (l.startsWith('#EXT-X-MAP:')) map = /URI="([^"]*)"/.exec(l)![1];
    else if (l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pdt = Date.parse(l.slice(25)) / 1000;
    else if (l.startsWith('#EXT-X-BYTERANGE:')) { const [n, o] = l.slice(17).split('@').map(Number); range = [o, n]; }
    else if (l && !l.startsWith('#')) { out.push({ uri: l, range, pdt, disc, map }); range = null; disc = false; }
  }
  return out;
}
const header = (text: string, tag: string) => Number(new RegExp(`#${tag}:(\\d+)`).exec(text)?.[1]);

async function main() {
  const vm = await import('../src/services/variantManifest');
  const W: any = [[now - 60, now + 600, 'loop:filler-1']];
  const render = (file: string, timeline: any = W, carry = '') => vm.renderVariant({ kind: 'channel', id: CH, key: 'k1', file, timeline, carry });

  console.log('== the variant master ==');
  const m = (await render('master.m3u8', W, '?as=AU'))!.body;
  const il = m.split('\n').filter((l) => l.startsWith('#EXT-X-I-FRAME-STREAM-INF'));
  ok('it lists the delivered I-frame playlist, relative, with the carry', il.length === 1 && il[0].includes('URI="720p.iframes_cc.m3u8?as=AU"'), il);
  ok('never the packager\'s own', !m.includes('720p.iframes.m3u8"') && !m.includes('URI="720p.iframes.m3u8?'));

  console.log('\n== the variant I-frame playlist ==');
  const src = readFileSync(join(dir, '720p.iframes_cc.m3u8'), 'utf8');
  const out = (await render('720p.iframes_cc.m3u8'))!.body;
  const a = entries(src), b = entries(out);
  ok(`every slot kept (${b.length} of ${a.length})`, b.length === a.length);
  ok('same media sequence; discontinuity sequence the source\'s', header(out, 'EXT-X-MEDIA-SEQUENCE') === 100 && header(out, 'EXT-X-DISCONTINUITY-SEQUENCE') >= 2 && out.includes('#EXT-X-I-FRAMES-ONLY'));
  ok('same times', JSON.stringify(a.map((e) => e.pdt)) === JSON.stringify(b.map((e) => e.pdt)));
  const inWin = b.filter((e) => e.pdt >= now - 60), before = b.filter((e) => e.pdt < now - 60);
  ok(`before the window the programme as delivered (${before.length})`, before.length === 5 && before.every((e, i) => e.uri.endsWith(a[i].uri) && JSON.stringify(e.range) === JSON.stringify(a[i].range)));
  ok(`inside it the loop (${inWin.length})`, inWin.length === 15 && inWin.every((e) => e.uri.includes('/filler/720p/seg_') && e.range));
  ok('a discontinuity and the loop\'s init where it switches', inWin[0].disc && /filler\/720p\/init\.mp4$/.test(inWin[0].map ?? ''));
  let one = 0, same = 0, blue = 0, red = 0;
  const work = join(ORIGIN, 'w.mp4'), full = join(ORIGIN, 'f.mp4');
  for (const e of b) {
    const rel = e.uri.replace(/^\/origin\/[^/]+\/live\//, '');
    const initRel = (e.map ?? '').replace(/^\/origin\/[^/]+\/live\//, '');
    const seg = readFileSync(join(dir, rel)), init = readFileSync(join(dir, initRel));
    writeFileSync(work, Buffer.concat([init, seg.subarray(e.range![0], e.range![0] + e.range![1])]));
    writeFileSync(full, Buffer.concat([init, seg]));
    if (e.pdt < now - 60) continue;   // the programme's own entries are checked by identity above
    const c = rgb(work);
    {
      if (frames(work) === '1') one++;
      if (md5first(work) === md5first(full)) same++;
      if (c[2] > 150 && c[0] < 80) blue++;
      if (c[0] > 150 && c[2] < 80) red++;
    }
  }
  ok(`inside the window every range decodes alone to one picture (${one}/15)`, one === 15);
  ok(`the loop segment's first picture (${same}/15)`, same === 15);
  ok(`all the loop's, not one programme picture (${blue} blue, ${red} red)`, blue === 15 && red === 0);
  const mv = (await render('stream_0_cc.m3u8'))!.body;
  const mvE = entries(mv);
  ok('slot for slot the same segments as the variant media playlist', mvE.length === b.length && mvE.every((e, i) => e.uri === b[i].uri));

  console.log('\n== refusals ==');
  renameSync(join(dir, 'filler', '720p', loopSegs[1]), join(dir, 'filler', '720p', 'x.m4s'));
  // a fresh process would not have it cached: drop the cache by renaming the loop
  writeFileSync(join(dir, 'filler', 'filler.json'), JSON.stringify({ hash: 'h2', segment_seconds: 4, loop_seconds: 20,
    tracks: { '720p': { kind: 'video', init: '720p/init.mp4', segments: loopSegs.map((f) => ({ uri: `720p/${f}`, dur: 4 })).concat([{ uri: '720p/missing.m4s', dur: 4 }]) } } }));
  let err = '';
  try { await render('720p.iframes_cc.m3u8'); } catch (e: any) { err = e.message; }
  ok(`a loop keyframe that cannot be read: refused (${err})`, /not known/.test(err));
  renameSync(join(dir, 'filler', '720p', 'x.m4s'), join(dir, 'filler', '720p', loopSegs[1]));
  writeFileSync(join(dir, 'filler', 'filler.json'), JSON.stringify({ hash: 'h', segment_seconds: 4, loop_seconds: 20,
    tracks: { '720p': { kind: 'video', init: '720p/init.mp4', segments: loopSegs.map((f) => ({ uri: `720p/${f}`, dur: 4 })) } } }));
  err = '';
  try { await render('720p.iframes.m3u8'); } catch (e: any) { err = e.message; }
  ok(`the packager's own I-frame playlist (no times): refused as before (${err})`, /without times/.test(err));

  console.log('\n== no window ==');
  const plain = (await render('720p.iframes_cc.m3u8', []))!.body;
  const pe = entries(plain);
  ok('an audience with no window: the I-frame playlist as delivered', pe.length === a.length && pe.every((e, i) => e.uri.endsWith(a[i].uri) && JSON.stringify(e.range) === JSON.stringify(a[i].range) && !e.uri.includes('filler')));

  console.log(`\ntrickplay-variants: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
