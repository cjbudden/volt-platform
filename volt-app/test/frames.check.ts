// ============================================================================
//  FRAME-ACCURATE ACCESS (build queue 3.2 (a) and (b); services/frames).
//
//  Real media, made here with ffmpeg: a 20 s, 25 fps asset with B-frames and
//  2 s keyframe intervals packaged as CMAF HLS (the shape Volt's encodes and
//  clips have), the same asset as MPEG-TS, a 29.97 fps asset whose segments
//  are not all the same length, an audio-only asset, and a live capture run
//  laid out like the origin's runs/<run>/<rendition>/ for a recording.
//
//  The prototype's 15 assertions (volt-frame-proto/test.mjs) are carried over
//  where they still apply: frame counts, rate, segment count, locating across
//  a boundary, exact frames against a ground-truth decode of the source, the
//  neighbour being different content, the still's width. Its clip, sprite and
//  I-frame playlist assertions belong to later items (3.2 (c) and (d), 3.2b).
//
//  Usage: DATABASE_URL=... npx tsx test/frames.check.ts
// ============================================================================
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const WORK = mkdtempSync(join(tmpdir(), 'volt-frames-check-'));
process.env.CLIPS_DIR = join(WORK, 'clips');
process.env.ORIGIN_DIR = join(WORK, 'origin');
process.env.IMAGE_STORE_DIR = join(WORK, 'image-store');
mkdirSync(process.env.CLIPS_DIR, { recursive: true });

let pass = 0, fail = 0;
const ok = (m: string, c: boolean, extra?: unknown) => {
  if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (extra === undefined ? '' : `  -> ${JSON.stringify(extra)}`)); }
};

const A = '00000000-0000-0000-0000-0000000f3a01';
const A2 = '00000000-0000-0000-0000-0000000f3a02';
const G = '00000000-0000-0000-0000-0000000f3b01';
const CH = '00000000-0000-0000-0000-0000000f3c01';
const U = '00000000-0000-0000-0000-0000000f3d01';
const U2 = '00000000-0000-0000-0000-0000000f3d02';
const REC = '00000000-0000-0000-0000-0000000f3e01';
const CMAF = '00000000-0000-0000-0000-0000000f3f01';
const TS = '00000000-0000-0000-0000-0000000f3f02';
const NTSC = '00000000-0000-0000-0000-0000000f3f03';
const AUDIO = '00000000-0000-0000-0000-0000000f3f04';
const OLD = '00000000-0000-0000-0000-0000000f3f05';

const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

// ---------------------------------------------------------------- media
const SRC = join(WORK, 'source.mp4');
// B-frames on purpose: presentation order differs from decode order inside a segment.
// The picture is a ramp that moves 41 levels a frame, so every frame differs
// from its neighbours everywhere and a one-frame slip cannot hide.
ff(['-f', 'lavfi', '-i', "nullsrc=size=640x360:rate=25:duration=20,geq=lum='mod(2*X+41*N,256)':cb='mod(Y+3*N,256)':cr=128",
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-bf', '2', '-b:v', '1500k', SRC]);

function packageCmaf(src: string, dir: string, hlsTime: number) {
  mkdirSync(dir, { recursive: true });
  ff(['-i', src, '-c', 'copy', '-f', 'hls', '-hls_time', String(hlsTime), '-hls_playlist_type', 'vod',
    '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', join(dir, 'v720', 'seg_%03d.m4s'), join(dir, 'v720', 'index.m3u8')]);
  writeFileSync(join(dir, 'master.m3u8'), ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1600000,RESOLUTION=640x360', 'v720/index.m3u8', ''].join('\n'));
}
// The CMAF asset: master -> v720/index.m3u8 (the shape vod.encode leaves), plus
// an audio-only variant in the master that must not be picked.
const cmafDir = join(process.env.CLIPS_DIR, 'vod', CMAF);
mkdirSync(join(cmafDir, 'v720'), { recursive: true });
packageCmaf(SRC, cmafDir, 2);
writeFileSync(join(cmafDir, 'master.m3u8'), [
  '#EXTM3U', '#EXT-X-VERSION:7',
  '#EXT-X-STREAM-INF:BANDWIDTH=96000,CODECS="mp4a.40.2"', 'audio/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=1600000,RESOLUTION=640x360,CODECS="avc1.64001e"', 'v720/index.m3u8', ''].join('\n'));

// The MPEG-TS asset (older clips): a media playlist as the master.
const tsDir = join(process.env.CLIPS_DIR, TS);
mkdirSync(tsDir, { recursive: true });
ff(['-i', SRC, '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'mpegts',
  '-hls_segment_filename', join(tsDir, 'seg_%03d.ts'), join(tsDir, 'index.m3u8')]);

// 29.97 fps, keyframes every 37 frames, segments cut at the first keyframe
// after 1.5 s: lengths that are neither equal nor whole seconds.
const SRC_NTSC = join(WORK, 'ntsc.mp4');
ff(['-f', 'lavfi', '-i', "nullsrc=size=320x180:rate=30000/1001:duration=12,geq=lum='mod(4*X+41*N,256)':cb=128:cr='mod(Y+5*N,256)'",
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '37', '-keyint_min', '37', '-sc_threshold', '0', '-bf', '2', SRC_NTSC]);
const ntscDir = join(process.env.CLIPS_DIR, 'vod', NTSC);
mkdirSync(join(ntscDir, 'v720'), { recursive: true });
packageCmaf(SRC_NTSC, ntscDir, 1.5);

// Audio only (a radio show): state none, not a failure.
const audioDir = join(process.env.CLIPS_DIR, 'vod', AUDIO);
mkdirSync(join(audioDir, 'a'), { recursive: true });
ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:a', 'aac', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
  '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', join(audioDir, 'a', 'seg_%03d.m4s'),
  join(audioDir, 'a', 'index.m3u8')]);
writeFileSync(join(audioDir, 'master.m3u8'), ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=96000,CODECS="mp4a.40.2"', 'a/index.m3u8', ''].join('\n'));

// A live capture run, laid out as the origin writes it, written in real time
// from T0: segment i was finished at T0 + (i + 1) * 2 s.
const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);
const runDir = join(process.env.ORIGIN_DIR, CH, 'runs', '20261102T120000Z', '720p');
mkdirSync(runDir, { recursive: true });
ff(['-i', SRC, '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
  '-hls_segment_filename', join(runDir, 'seg_%d.m4s'), join(runDir, 'index.m3u8')]);
for (const f of readdirSync(runDir).filter((x) => /^seg_\d+\.m4s$/.test(x))) {
  const i = Number(/\d+/.exec(f)![0]);
  const t = (T0 + (i + 1) * 2000) / 1000;
  utimesSync(join(runDir, f), t, t);
}

// ------------------------------------------------------------ ground truth
const truthCache = new Map<string, Buffer>();
/** 32x32 grey signature of frame n decoded straight from the source file. */
function truth(src: string, n: number): Buffer {
  const k = `${src}#${n}`;
  if (!truthCache.has(k)) truthCache.set(k, execFileSync('ffmpeg', ['-v', 'error', '-i', src, '-vf', `select=eq(n\\,${n}),scale=32:32,format=gray`,
    '-fps_mode', 'passthrough', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 1 << 20 }));
  return truthCache.get(k)!;
}
function sigOf(jpg: Buffer): Buffer {
  const p = join(WORK, `sig-${Math.random().toString(36).slice(2)}.jpg`);
  writeFileSync(p, jpg);
  return execFileSync('ffmpeg', ['-v', 'error', '-i', p, '-vf', 'scale=32:32,format=gray', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 1 << 20 });
}
const mad = (a: Buffer, b: Buffer) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
const sourceFrames = (src: string) => Number(JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
  '-show_entries', 'stream=nb_read_frames', '-of', 'json', src], { encoding: 'utf8' })).streams[0].nb_read_frames);
const widthOf = (jpg: Buffer) => {
  const p = join(WORK, `w-${Math.random().toString(36).slice(2)}.jpg`);
  writeFileSync(p, jpg);
  return Number(JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width', '-of', 'json', p], { encoding: 'utf8' })).streams[0].width);
};

async function main() {
  const fi = await import('../src/services/frames/frameIndex');
  const fm = await import('../src/services/frames/fmp4');
  const store = await import('../src/services/frames/store');
  const { extractFrame } = await import('../src/services/frames/exactFrame');
  const { query, one, pool } = await import('../src/db');
  const { createServer } = await import('../src/server');
  const { signAccess } = await import('../src/auth/jwt');
  const { sweepFrameIndexes, registerFrameIndexHandlers, FRAMES_INDEX } = await import('../src/services/jobs/handlers/frameIndex');

  console.log('== timecode (pure) ==');
  const r25 = { num: 25, den: 1 }, r2997 = { num: 30000, den: 1001 }, r5994 = { num: 60000, den: 1001 };
  ok('frame 137 at 25 fps is 00:00:05:12', fi.timecode(r25, 137) === '00:00:05:12', fi.timecode(r25, 137));
  ok('25 fps: an hour is 90000 frames, 01:00:00:00', fi.timecode(r25, 90000) === '01:00:00:00');
  ok('29.97 is drop-frame', fi.isDropFrame(r2997) && !fi.isDropFrame(r25) && !fi.isDropFrame({ num: 24000, den: 1001 }));
  ok('29.97: frame 1799 is 00:00:59;29', fi.timecode(r2997, 1799) === '00:00:59;29', fi.timecode(r2997, 1799));
  ok('29.97: frame 1800 skips to 00:01:00;02', fi.timecode(r2997, 1800) === '00:01:00;02', fi.timecode(r2997, 1800));
  ok('29.97: frame 17982 is 00:10:00;00 (tenth minute keeps ;00)', fi.timecode(r2997, 17982) === '00:10:00;00', fi.timecode(r2997, 17982));
  ok('29.97: an hour of frames (107892) is 01:00:00;00', fi.timecode(r2997, 107892) === '01:00:00;00', fi.timecode(r2997, 107892));
  ok('59.94: frame 3600 skips four to 00:01:00;04', fi.timecode(r5994, 3600) === '00:01:00;04', fi.timecode(r5994, 3600));
  let round = true;
  for (const n of [0, 1, 2, 1799, 1800, 1801, 3597, 17981, 17982, 17983, 54000, 107891]) if (fi.parseTimecode(r2997, fi.timecode(r2997, n)) !== n) round = false;
  ok('29.97: timecode -> frame -> timecode round trips', round);
  ok('a dropped number does not parse (00:01:00;00)', fi.parseTimecode(r2997, '00:01:00;00') === null);
  ok('25 fps: 00:00:05:12 parses to 137', fi.parseTimecode(r25, '00:00:05:12') === 137);
  ok('frames past the rate do not parse (00:00:01:25 at 25)', fi.parseTimecode(r25, '00:00:01:25') === null);
  ok('frameAtMs: 5480 ms is frame 137, 5519 ms still 137, 5520 is 138', fi.frameAtMs(r25, 5480) === 137 && fi.frameAtMs(r25, 5519.9) === 137 && fi.frameAtMs(r25, 5520) === 138);
  ok('rate from sample durations: 3003 ticks at 90 kHz is 30000/1001', JSON.stringify(fi.rateFromDurations([3003, 3003, 3003, 6006], 90000)) === JSON.stringify(r2997));
  ok('pickVideoVariant skips the audio-only variant', fi.pickVideoVariant('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=9,CODECS="mp4a.40.2"\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=5,RESOLUTION=640x360\nv.m3u8\n') === 'v.m3u8');

  console.log('\n== the index of a CMAF asset (prototype 1 to 5) ==');
  const built = await store.indexFromMaster(`/clips/vod/${CMAF}/master.m3u8`);
  const idx = 'index' in built ? built.index : null;
  ok('index made', !!idx, built);
  if (!idx) throw new Error('no index');
  ok(`index counts 500 frames (got ${idx.totalFrames})`, idx.totalFrames === 500);
  ok(`rate 25/1 from the fragments, B-frames and all (got ${idx.rate.num}/${idx.rate.den})`, idx.rate.num === 25 && idx.rate.den === 1);
  ok(`10 segments (got ${idx.segments.length})`, idx.segments.length === 10);
  ok('the video variant was picked, not the audio one', idx.playlist === 'v720/index.m3u8', idx.playlist);
  const loc = fi.locateFrame(idx, 137);
  ok(`frame 137 -> segment 2, frame 37 (got ${loc?.segmentIndex}, ${loc?.localFrame})`, loc?.segmentIndex === 2 && loc?.localFrame === 37);
  ok('frame 137 -> 5480 ms', Math.abs(fi.msOfFrame(idx.rate, 137) - 5480) < 1e-6);
  ok('frame 49 is the last of segment 0, frame 50 the first of segment 1',
    fi.locateFrame(idx, 49)?.segmentIndex === 0 && fi.locateFrame(idx, 49)?.localFrame === 49 && fi.locateFrame(idx, 50)?.segmentIndex === 1 && fi.locateFrame(idx, 50)?.localFrame === 0);
  ok('frame 500 and -1 are outside', fi.locateFrame(idx, 500) === null && fi.locateFrame(idx, -1) === null);
  const seg0 = readdirSync(join(cmafDir, 'v720')).filter((f) => f.endsWith('.m4s')).sort()[0];
  const { readFileSync } = await import('node:fs');
  const initFacts = fm.readInit(readFileSync(join(cmafDir, 'v720', 'init.mp4')));
  const frag0 = initFacts && fm.readFragments(readFileSync(join(cmafDir, 'v720', seg0)), initFacts);
  ok('fragment boxes: video track, 50 samples, starts on a keyframe', !!initFacts?.isVideo && frag0?.pts.length === 50 && frag0?.startsWithSync === true, { init: initFacts, n: frag0?.pts.length });
  ok('fragment boxes: presentation times strictly increasing after sorting (B-frames reordered)', !!frag0 && frag0.pts.every((p, i) => i === 0 || p > frag0.pts[i - 1]));

  console.log('\n== exact frames against a ground-truth decode (prototype 6 to 8) ==');
  for (const n of [137, 0, 49, 50, 499]) {
    const l = fi.locateFrame(idx, n)!;
    const jpg = await extractFrame(readFileSync(join(cmafDir, 'v720', 'init.mp4')), readFileSync(join(cmafDir, 'v720', l.segment.uri)), l.localFrame);
    const m = mad(sigOf(jpg), truth(SRC, n));
    const nb = mad(sigOf(jpg), truth(SRC, n === 499 ? 498 : n + 1));
    ok(`frame ${n} == ground truth (MAD ${m.toFixed(2)} < 3) and != its neighbour (MAD ${nb.toFixed(2)})`, m < 3 && nb > Math.max(3, m * 3));
  }
  ok('the still is the source size (640)', widthOf(await extractFrame(readFileSync(join(cmafDir, 'v720', 'init.mp4')), readFileSync(join(cmafDir, 'v720', seg0)), 3)) === 640);

  console.log('\n== MPEG-TS, 29.97 with uneven segments, audio only ==');
  const tsBuilt = await store.indexFromMaster(`/clips/${TS}/index.m3u8`);
  const tsIdx = 'index' in tsBuilt ? tsBuilt.index : null;
  ok('MPEG-TS: 500 frames, 25 fps, container ts', tsIdx?.totalFrames === 500 && tsIdx.rate.num === 25 && tsIdx.container === 'ts', tsIdx && { n: tsIdx.totalFrames, r: tsIdx.rate });
  if (tsIdx) {
    const l = fi.locateFrame(tsIdx, 263)!;
    const jpg = await extractFrame(null, readFileSync(join(tsDir, l.segment.uri)), l.localFrame);
    ok(`MPEG-TS: frame 263 == ground truth (MAD ${mad(sigOf(jpg), truth(SRC, 263)).toFixed(2)})`, mad(sigOf(jpg), truth(SRC, 263)) < 3);
  }
  const nBuilt = await store.indexFromMaster(`/clips/vod/${NTSC}/master.m3u8`);
  const nIdx = 'index' in nBuilt ? nBuilt.index : null;
  const nTruth = sourceFrames(SRC_NTSC);
  ok(`29.97: rate 30000/1001 and every frame counted (${nIdx?.totalFrames} == ${nTruth})`, nIdx?.rate.num === 30000 && nIdx.rate.den === 1001 && nIdx.totalFrames === nTruth);
  const lens = new Set(nIdx?.segments.map((s) => s.frames));
  ok(`29.97: segments of different lengths (${[...lens].join(', ')} frames)`, lens.size > 1);
  if (nIdx) {
    let allOk = true;
    const tried: string[] = [];
    for (const s of nIdx.segments.slice(1, 4)) {
      for (const n of [s.startFrame - 1, s.startFrame]) {
        const l = fi.locateFrame(nIdx, n)!;
        const jpg = await extractFrame(readFileSync(join(ntscDir, 'v720', 'init.mp4')), readFileSync(join(ntscDir, 'v720', l.segment.uri)), l.localFrame);
        const m = mad(sigOf(jpg), truth(SRC_NTSC, n));
        tried.push(`${n}:${m.toFixed(2)}`);
        if (m >= 3) allOk = false;
      }
    }
    ok(`29.97: both sides of three uneven boundaries == ground truth (${tried.join(' ')})`, allOk);
  }
  const aBuilt = await store.indexFromMaster(`/clips/vod/${AUDIO}/master.m3u8`);
  ok('audio only: no index, said why', 'none' in aBuilt && /audio/.test((aBuilt as any).none), aBuilt);
  ok('no packaged HLS: no index, said why', 'none' in await store.indexFromMaster(null));

  console.log('\n== the API ==');
  await query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [[A, A2]]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'Frames'),($2,'Other')`, [A, A2]);
  await query(`INSERT INTO groups(id,account_id,name,max_channels) VALUES ($1,$2,'g',10)`, [G, A]);
  await query(`INSERT INTO channels(id,group_id,name,status) VALUES ($1,$2,'frames-ch','scheduled')`, [CH, G]);
  await query(`INSERT INTO users(id,account_id,email,password_hash,role,status) VALUES ($1,$2,'frames@test.local','x','admin','active'),($3,$4,'other@test.local','x','admin','active')`, [U, A, U2, A2]);
  const asset = (id: string, master: string) => query(
    `INSERT INTO vod_assets(id, account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms) VALUES ($1,$2,'upload','clip',$3,$4,0,20000,20000)`, [id, A, id.slice(-4), master]);
  await asset(CMAF, `/clips/vod/${CMAF}/master.m3u8`);
  await asset(TS, `/clips/${TS}/index.m3u8`);
  await asset(AUDIO, `/clips/vod/${AUDIO}/master.m3u8`);
  await asset(OLD, `/clips/vod/${NTSC}/master.m3u8`);
  await query(`INSERT INTO recordings(id,kind,channel_id,title,status,start_epoch_ms,end_epoch_ms,duration_ms,day_utc) VALUES ($1,'channel_day',$2,'Noon',$3,$4,$5,20000,'2026-11-02')`,
    [REC, CH, 'complete', T0, T0 + 20000]);

  const app = createServer();
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const H = { authorization: `Bearer ${signAccess({ sub: U, account_id: A, role: 'admin' } as any)}` };
  const H2 = { authorization: `Bearer ${signAccess({ sub: U2, account_id: A2, role: 'admin' } as any)}` };
  const get = async (p: string, h: Record<string, string> = H) => {
    const r = await fetch(base + p, { headers: h, redirect: 'manual' });
    const t = await r.text();
    let j: any = null; try { j = JSON.parse(t); } catch { /* not json */ }
    return { status: r.status, j, location: r.headers.get('location') };
  };
  try {
    const before = await get(`/api/vod/${CMAF}/frame-index`);
    ok('an asset with no index: GET says queued and queues a frames.index job', before.j?.state === 'queued'
      && !!(await one(`SELECT 1 FROM jobs WHERE type=$1 AND dedupe_key=$2`, [FRAMES_INDEX, `frames.index:${CMAF}`])), before);
    const fr409 = await get(`/api/vod/${CMAF}/frame?n=137`);
    ok('a frame before the index exists: 409, being made', fr409.status === 409, fr409);
    const made = await get(`/api/vod/${CMAF}/frame-index?build=1`);
    ok('?build=1 makes it: ready, 500 frames, 25 fps, last timecode 00:00:19:24', made.j?.state === 'ready' && made.j.totalFrames === 500 && made.j.rate?.fps === 25 && made.j.lastTimecode === '00:00:19:24', made.j);
    const f = await get(`/api/vod/${CMAF}/frame?n=137&w=320`);
    ok('frame 137: number, timecode, time, segment and frame inside it', f.status === 200 && f.j.frame === 137 && f.j.timecode === '00:00:05:12' && f.j.ms === 5480
      && f.j.segment.index === 2 && f.j.segment.frame === 37 && f.j.cache === 'made', f.j);
    ok('a signed image URL at the width asked for', /^.*\/img\/[A-Za-z0-9_-]{22}\/320x0,inside/.test(f.j?.image?.url ?? '') && f.j.image.width === 320, f.j?.image);
    const imgPath = new URL(f.j.image.url, base).pathname;
    const img = await fetch(base + imgPath);
    const imgBuf = Buffer.from(await img.arrayBuffer());
    ok(`the image service serves it as a ${img.headers.get('content-type')} 320 px wide`, img.status === 200 && /jpeg/.test(img.headers.get('content-type') ?? '') && widthOf(imgBuf) === 320);
    // Resized twice (the image service, then the signature) so compared by
    // nearness: far closer to frame 137 than to either neighbour.
    const viaImg = sigOf(imgBuf);
    const [m136, m137, m138] = [136, 137, 138].map((n) => mad(viaImg, truth(SRC, n)));
    ok(`through the image service it is still frame 137 (MAD ${m137.toFixed(2)}; neighbours ${m136.toFixed(2)}, ${m138.toFixed(2)})`, m137 * 2 < Math.min(m136, m138));
    const again = await get(`/api/vod/${CMAF}/frame?n=137&w=1280`);
    ok('the same frame again: cached, one still kept, any width', again.j?.cache === 'cached' && again.j.image.width === 1280
      && Number((await one(`SELECT count(*)::int AS n FROM frame_stills WHERE store_key LIKE $1`, [`%/assets/${CMAF}/%/137.jpg`]))?.n) === 1, again.j);
    const both = await Promise.all([get(`/api/vod/${CMAF}/frame?n=300`), get(`/api/vod/${CMAF}/frame?n=300`), get(`/api/vod/${CMAF}/frame?n=300`)]);
    ok('three requests for a new frame at once: one decode, one still', both.every((x) => x.status === 200) && both.filter((x) => x.j.cache === 'made').length >= 1
      && Number((await one(`SELECT count(*)::int AS n FROM frame_stills WHERE store_key LIKE $1`, [`%/assets/${CMAF}/%/300.jpg`]))?.n) === 1);
    const byTc = await get(`/api/vod/${CMAF}/frame?tc=00:00:05:12`);
    const byMs = await get(`/api/vod/${CMAF}/frame?ms=5519`);
    ok('by timecode and by time: the same frame 137', byTc.j?.frame === 137 && byMs.j?.frame === 137);
    ok('frame 500: 404 outside the asset', (await get(`/api/vod/${CMAF}/frame?n=500`)).status === 404);
    ok('a bad timecode: 400', (await get(`/api/vod/${CMAF}/frame?tc=5s`)).status === 400);
    ok('no frame named: 400', (await get(`/api/vod/${CMAF}/frame`)).status === 400);
    ok('w too large: 400', (await get(`/api/vod/${CMAF}/frame?n=1&w=99999`)).status === 400);
    const red = await get(`/api/vod/${CMAF}/frame?n=137&w=320&redirect=1`);
    ok('?redirect=1: 302 to the signed image', red.status === 302 && /\/img\//.test(red.location ?? ''));
    ok('another account: 404', (await get(`/api/vod/${CMAF}/frame-index`, H2)).status === 404 && (await get(`/api/vod/${CMAF}/frame?n=1`, H2)).status === 404);
    const { requirementFor } = await import('../src/auth/roles');
    const needV = await requirementFor('GET', `/api/vod/${CMAF}/frame`, {});
    const needR = await requirementFor('GET', `/api/recordings/${REC}/frame`, {});
    ok('permissions: Media library view for asset frames, Recordings view for recording frames',
      needV?.features?.[0] === 'vod' && needV.level === 'view' && needR?.features?.[0] === 'recordings' && needR.level === 'view', { needV, needR });
    ok('no sign-in: 401', (await get(`/api/vod/${CMAF}/frame-index`, {})).status === 401);

    console.log('\n== the job and the sweep ==');
    await query(`DELETE FROM jobs WHERE type = $1`, [FRAMES_INDEX]);
    const sw = await sweepFrameIndexes(50);
    const queued = (await query<{ id: string }>(`SELECT payload->>'vodAssetId' AS id FROM jobs WHERE type=$1`, [FRAMES_INDEX])).map((r) => r.id).sort();
    // (The template database's demo assets have no index either, and are queued too.)
    ok(`the sweep queues every asset without an index (${sw.queued}), not the indexed one`, [TS, AUDIO, OLD].every((x) => queued.includes(x)) && !queued.includes(CMAF), queued);
    registerFrameIndexHandlers();
    const { startWorker } = await import('../src/services/jobs/worker');
    const w = startWorker({ concurrency: 2, pollMs: 100 });
    const t0 = Date.now();
    while (Date.now() - t0 < 30_000 && Number((await one(`SELECT count(*)::int AS n FROM jobs WHERE type=$1 AND state IN ('queued','running')`, [FRAMES_INDEX]))?.n) > 0) await new Promise((r) => setTimeout(r, 200));
    await w.stop();
    const rows = await query<any>(`SELECT vod_asset_id::text AS id, state, total_frames, rate_num, rate_den FROM asset_frame_indexes ORDER BY vod_asset_id`);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    ok('the jobs made them: TS ready (500), 29.97 ready, audio none', by[TS]?.state === 'ready' && by[TS].total_frames === 500 && by[OLD]?.state === 'ready'
      && by[OLD].rate_num === 30000 && by[AUDIO]?.state === 'none', rows);
    ok('a second sweep finds nothing left', (await sweepFrameIndexes(50)).queued === 0);
    const aud = await get(`/api/vod/${AUDIO}/frame?n=1`);
    ok('an audio asset asked for a frame: 409 saying it has no video', aud.status === 409 && /audio/.test(aud.j?.error ?? ''), aud);
    const df = await get(`/api/vod/${OLD}/frame?n=60`);
    ok('the 29.97 asset answers in drop-frame timecode (frame 60 = 00:00:02;00)', df.j?.timecode === '00:00:02;00' && df.j.rate.dropFrame === true, df.j);

    console.log('\n== a recording (live capture run) ==');
    const rf = await get(`/api/recordings/${REC}/frame?n=137&w=320`);
    ok('recording frame 137: segment 2 of the run, frame 37, 5480 ms in', rf.status === 200 && rf.j.frame === 137 && rf.j.segment.seq === 2 && rf.j.segment.frame === 37
      && Math.abs(rf.j.ms - 5480) < 0.5 && rf.j.timecode === '00:00:05:12', rf.j);
    if (rf.status === 200) {
      const k = (await one<any>(`SELECT store_key FROM frame_stills WHERE store_key LIKE $1`, [`%/streams/${CH}/%2-37.jpg`]))?.store_key;
      const jpg = k ? readFileSync(join(process.env.IMAGE_STORE_DIR!, k)) : null;
      ok(`recording frame 137 == ground truth (MAD ${jpg ? mad(sigOf(jpg), truth(SRC, 137)).toFixed(2) : '-'})`, !!jpg && mad(sigOf(jpg), truth(SRC, 137)) < 3);
    }
    const atWall = await get(`/api/recordings/${REC}/frame?at=${T0 + 4000}`);
    const before4 = await get(`/api/recordings/${REC}/frame?at=${T0 + 3999}`);
    ok('across the segment boundary on the wall clock: 4000 ms is frame 100 (segment 2), 3999 ms frame 99 (segment 1)',
      atWall.j?.frame === 100 && atWall.j.segment.seq === 2 && atWall.j.segment.frame === 0 && before4.j?.frame === 99 && before4.j.segment.seq === 1 && before4.j.segment.frame === 49, { a: atWall.j?.segment, b: before4.j?.segment });
    ok('outside the recording: 404', (await get(`/api/recordings/${REC}/frame?ms=25000`)).status === 404);
    ok('another account: 404', (await get(`/api/recordings/${REC}/frame?n=1`, H2)).status === 404);

    console.log('\n== where stills are kept, and the clean-up ==');
    const { folderAddress } = await import('../src/services/frames/folders');
    const { config } = await import('../src/config');
    const st = await one<any>(`SELECT * FROM frame_stills WHERE store_key LIKE $1`, [`%/assets/${CMAF}/%/137.jpg`]);
    ok('each still records its folder, its size and its folder object (bucket empty on a local store)',
      !!st && st.bucket === null && /^derived\/[0-9a-f-]+\/frames\/assets\/[0-9a-f-]+\/\d+$/.test(st.folder) && st.bytes > 0 && !!st.media_object_id, st);
    const fo = st && await one<any>(`SELECT o.*, l.uri, l.tier, l.bytes AS loc_bytes FROM media_objects o JOIN media_locations l ON l.object_id = o.id AND l.present WHERE o.id = $1`, [st.media_object_id]);
    const sum = st && Number((await one<any>(`SELECT sum(bytes)::int AS n FROM frame_stills WHERE media_object_id = $1`, [st.media_object_id]))?.n);
    ok('the folder is a media object of kind frame_stills, owned by the asset alone, its location the folder on disk, sized as its stills',
      fo?.kind === 'frame_stills' && fo.vod_asset_id === CMAF && !fo.channel_id && fo.logical_key.startsWith(`frames/assets/${CMAF}/`)
      && fo.uri === join(process.env.IMAGE_STORE_DIR!, st.folder) && fo.tier === 'local' && Number(fo.bytes) === sum && Number(fo.loc_bytes) === sum, { fo, sum });
    const saved = { ...config.imageStore };
    Object.assign(config.imageStore, { driver: 's3', s3Bucket: 'volt-media-test', s3Prefix: 'images/' });
    const s3a = folderAddress('derived/acct/frames/assets/x/1');
    Object.assign(config.imageStore, saved);
    ok('on S3 the record is the bucket and the folder as a prefix (trailing slash, so only that tree is removed)',
      s3a.bucket === 'volt-media-test' && s3a.uri === 's3://volt-media-test/images/derived/acct/frames/assets/x/1/' && s3a.tier === 's3_standard', s3a);
    const rs = await one<any>(`SELECT s.*, o.channel_id, o.logical_key, o.kind FROM frame_stills s JOIN media_objects o ON o.id = s.media_object_id WHERE s.store_key LIKE $1`, [`%/streams/${CH}/%2-37.jpg`]);
    ok('a recording still: its folder is owned by the channel, keyed by run and rendition',
      rs?.kind === 'frame_stills' && rs.channel_id === CH && rs.logical_key === 'frames/run/20261102T120000Z/720p' && rs.folder.endsWith(`/streams/${CH}/20261102T120000Z/720p`), rs);

    // A second capture run of the channel, ten minutes later, for the run removal.
    const run2 = join(process.env.ORIGIN_DIR!, CH, 'runs', '20261102T121000Z', '720p');
    mkdirSync(run2, { recursive: true });
    for (const f of readdirSync(runDir)) {
      writeFileSync(join(run2, f), readFileSync(join(runDir, f)));
      const m = /^seg_(\d+)\.m4s$/.exec(f);
      if (m) { const t = (T0 + 600_000 + (Number(m[1]) + 1) * 2000) / 1000; utimesSync(join(run2, f), t, t); }
    }
    const fr2 = await store.streamFrameAt(CH, T0 + 600_000 + 5480);
    const s2 = fr2 && await store.streamFrameStill(A, CH, fr2);
    const s2row = s2 && await one<any>(`SELECT * FROM frame_stills WHERE store_key = $1`, [s2.key]);
    const { pruneRun } = await import('../src/services/media/prune');
    await pruneRun({ streamId: CH, runId: '20261102T121000Z', accountId: A, reason: 'test removal', actor: 'test' });
    const o2 = s2row && await one<any>(`SELECT state FROM media_objects WHERE id = $1`, [s2row.media_object_id]);
    ok('removing a run (retention or clean-up) removes the stills taken from it: folder gone, object deleted, rows gone',
      !!s2row && o2?.state === 'deleted' && !existsSync(join(process.env.IMAGE_STORE_DIR!, s2row.folder))
      && !(await one(`SELECT 1 FROM frame_stills WHERE media_object_id = $1`, [s2row.media_object_id])), { s2row, o2 });
    const firstRunStill = rs && join(process.env.IMAGE_STORE_DIR!, rs.store_key);
    ok('the other run\'s stills are untouched', !!firstRunStill && existsSync(firstRunStill));

    // The channel's retention rule: delete after a day. The folder is two days old.
    const { saveRule, sweep } = await import('../src/services/media/retention');
    await saveRule({ actingAccountId: A, channelId: CH, name: 'Frames test', appliesTo: 'recording', stages: [{ afterDays: 1, action: 'delete' }] });
    await query(`UPDATE media_objects SET created_at = now() - interval '2 days' WHERE id = $1`, [rs.media_object_id]);
    const swept = await sweep({ accountId: A, actor: 'test' });
    const o1 = await one<any>(`SELECT state FROM media_objects WHERE id = $1`, [rs.media_object_id]);
    ok(`the stream's retention rule deletes its stills folder at the delete rung (${swept.deleted} deleted)`,
      o1?.state === 'deleted' && !existsSync(join(process.env.IMAGE_STORE_DIR!, rs.folder))
      && !(await one(`SELECT 1 FROM frame_stills WHERE media_object_id = $1`, [rs.media_object_id])), { o1, swept });
    const after = await get(`/api/recordings/${REC}/frame?n=137`);
    ok('a still of media whose stills retention removed is refused (410), not left outside the clean-up', after.status === 410, after);

    // An asset deleted: its folder is ownerless and the sweep reclaims it after the grace period.
    const tsStill = await get(`/api/vod/${TS}/frame?n=10`);
    const tsRow = await one<any>(`SELECT * FROM frame_stills WHERE store_key LIKE $1`, [`%/assets/${TS}/%/10.jpg`]);
    await query(`DELETE FROM vod_assets WHERE id = $1`, [TS]);
    await query(`UPDATE media_objects SET updated_at = now() - interval '2 days' WHERE id = $1`, [tsRow?.media_object_id]);
    const orphan = await sweep({ actor: 'test', limit: 5000 });
    const oTs = tsRow && await one<any>(`SELECT state FROM media_objects WHERE id = $1`, [tsRow.media_object_id]);
    ok(`a deleted asset's stills: reclaimed as ownerless (${orphan.orphaned} reclaimed), folder and rows gone`,
      tsStill.status === 200 && oTs?.state === 'deleted' && !existsSync(join(process.env.IMAGE_STORE_DIR!, tsRow.folder))
      && !(await one(`SELECT 1 FROM frame_stills WHERE media_object_id = $1`, [tsRow.media_object_id])), { oTs, orphan: orphan.orphaned });

    console.log('\n== upkeep ==');
    await query(`UPDATE frame_stills SET created_at = now() - interval '8 days' WHERE store_key LIKE $1`, [`%/137.jpg`]);
    const oldKeys = (await query<any>(`SELECT store_key FROM frame_stills WHERE store_key LIKE $1`, [`%/137.jpg`])).map((r) => r.store_key);
    const pruned = await store.pruneFrameStills(7);
    ok(`stills past the TTL are removed from the store and the table (${pruned})`, pruned === oldKeys.length && oldKeys.length > 0
      && oldKeys.every((k: string) => !existsSync(join(process.env.IMAGE_STORE_DIR!, k)))
      && Number((await one(`SELECT count(*)::int AS n FROM frame_stills WHERE store_key = ANY($1)`, [oldKeys]))?.n) === 0);
    ok('newer stills stay', Number((await one(`SELECT count(*)::int AS n FROM frame_stills`))?.n) > 0);
    const rebuilt = await get(`/api/vod/${CMAF}/frame-index?build=1`);
    const fresh = await get(`/api/vod/${CMAF}/frame?n=300`);
    ok('after a rebuild (a re-encode) a frame is made again from the new index, not the old still', rebuilt.j?.state === 'ready' && fresh.j?.cache === 'made', fresh.j);
    const objs = await query<any>(`SELECT logical_key, state FROM media_objects WHERE kind = 'frame_stills' AND vod_asset_id = $1 ORDER BY created_at`, [CMAF]);
    ok('the rebuild retired the old version\'s stills folder; only the new one is live',
      objs.length >= 2 && objs.filter((o) => o.state !== 'deleted').length === 1 && objs[objs.length - 1].state !== 'deleted', objs);
    await query(`DELETE FROM vod_assets WHERE id = $1`, [CMAF]);
    ok('deleting the asset removes its index row', !(await one(`SELECT 1 FROM asset_frame_indexes WHERE vod_asset_id = $1`, [CMAF])));
  } finally {
    srv.close();
    await query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [[A, A2]]).catch(() => {});
    await pool.end();
  }
}

main().catch((e) => { console.error(e); fail++; }).finally(() => {
  console.log(`\nframes: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
