// ============================================================================
//  DASH TRICK-MODE FOR ON-DEMAND ASSETS (build queue 3.2b-2, services/trickplay).
//
//  Real media made here with ffmpeg (20 s, 25 fps, B-frames, a keyframe every
//  2 s), packaged three ways:
//    SH   Shaka Packager's layout: media playlists beside the master
//         (stream_0.m3u8, stream_1.m3u8) naming v720/seg_1.m4s, and an MPD with
//         literal init paths (two video renditions and audio);
//    FF   ffmpeg's own DASH muxer with its HLS playlists, whose MPD names files
//         by $RepresentationID$;
//    EN   CENC-encrypted (AES-CTR, subsamples) in Shaka's layout, with
//         ContentProtection in the MPD and a key line in the HLS playlist.
//
//  What is checked:
//    - a trick segment is one fragment holding exactly the keyframe: one
//      sample, an mdat of exactly its bytes, the keyframe's decode time; init
//      plus it decodes to the source frame at that time; all of a rendition's
//      trick segments in a row decode to one picture per keyframe;
//    - the encrypted one carries the keyframe's senc entry (saiz, saio point at
//      it) and decrypts with the asset's key to the right frame;
//    - the MPD gains a trick-mode AdaptationSet after each video set, pointing
//      at it, one Representation per rendition, its timeline covering the
//      media; audio untouched; ContentProtection carried; never a second one,
//      never in a stitched (multi-Period) MPD;
//    - off (the default) nothing is listed and segments answer 404; switched on
//      later the first MPD queues the build; off again unlisted and 404; a
//      re-encode's older build is not served; a build from before 3.2b-2 is
//      rebuilt; a FAST ladder's MPD and master under the asset get nothing;
//    - Shaka's layout gives each rendition its own I-frame playlist (3.2b gave
//      them all one address).
//
//  Usage: DATABASE_URL=... npx tsx test/trickplay-dash.check.ts
// ============================================================================
import { execFileSync } from 'node:child_process';
import { createCipheriv } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const WORK = mkdtempSync(join(tmpdir(), 'volt-trickdash-check-'));
process.env.CLIPS_DIR = join(WORK, 'clips');
process.env.ORIGIN_DIR = join(WORK, 'origin');
process.env.IMAGE_STORE_DIR = join(WORK, 'image-store');
mkdirSync(process.env.CLIPS_DIR, { recursive: true });

let pass = 0, fail = 0;
const ok = (m: string, c: boolean, extra?: unknown) => {
  if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (extra === undefined ? '' : `  -> ${JSON.stringify(extra)}`)); }
};

const A = '00000000-0000-0000-0000-0000000e5a01';
const P = '00000000-0000-0000-0000-0000000e5b01';
const G = '00000000-0000-0000-0000-0000000e5c01';
const CH = '00000000-0000-0000-0000-0000000e5d01';
const SH = '00000000-0000-0000-0000-0000000e6001';
const FF = '00000000-0000-0000-0000-0000000e6002';
const EN = '00000000-0000-0000-0000-0000000e6003';
const KEY = '00112233445566778899aabbccddeeff', KID = 'a0a1a2a3a4a5a6a7a8a9aaabacadaeaf';

const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const CLIPS = process.env.CLIPS_DIR!;

const SRC = join(WORK, 'source.mp4');
ff(['-f', 'lavfi', '-i', "nullsrc=size=640x360:rate=25:duration=20,geq=lum='mod(2*X+41*N,256)':cb='mod(Y+3*N,256)':cr=128",
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
  '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-bf', '2', '-b:v', '1500k',
  '-c:a', 'aac', '-b:a', '96k', SRC]);
const SRC180 = join(WORK, 'source-180.mp4');
ff(['-i', SRC, '-an', '-vf', 'scale=320:180', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-bf', '2', SRC180]);

/** Boxes at the top level of a buffer (or inside one box's body). */
function boxesOf(b: Buffer, from = 0, to = b.length) {
  const out: { type: string; start: number; body: number; end: number }[] = [];
  let p = from;
  while (p + 8 <= to) {
    const size = b.readUInt32BE(p);
    if (size < 8 || p + size > to) break;
    out.push({ type: b.toString('latin1', p + 4, p + 8), start: p, body: p + 8, end: p + size });
    p += size;
  }
  return out;
}

/** Shaka's layout from per-rendition HLS output: <dir>/seg_N.m4s named from stream_K.m3u8 beside the master. */
function hlsDir(src: string, dir: string, map: string[]) {
  mkdirSync(dir, { recursive: true });
  ff(['-i', src, ...map, '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-start_number', '1',
    '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', join(dir, 'seg_%d.m4s'), join(dir, 'index.m3u8')]);
}
function besideMaster(assetDir: string, sub: string, out: string, keyLine?: string) {
  const t = readFileSync(join(assetDir, sub, 'index.m3u8'), 'utf8').split('\n').map((l) => {
    if (l.startsWith('#EXT-X-MAP:')) return (keyLine ? keyLine + '\n' : '') + l.replace('URI="', `URI="${sub}/`);
    return l && !l.startsWith('#') ? `${sub}/${l}` : l;
  }).join('\n');
  writeFileSync(join(assetDir, out), t);
}
/** A Shaka-style SegmentTimeline of a rendition: one S per segment, from its tfdt. */
function timeline(dir: string, n: number): { xml: string; timescale: number } {
  const { readInit } = require('../src/services/frames/fmp4');
  const init = readInit(readFileSync(join(dir, 'init.mp4')));
  const S: string[] = [];
  const pl = readFileSync(join(dir, 'index.m3u8'), 'utf8');
  const durs = [...pl.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]));
  let t = 0;
  for (let i = 0; i < n; i++) { const d = Math.round(durs[i] * init.timescale); S.push(`<S t="${t}" d="${d}"/>`); t += d; }
  return { xml: S.join(''), timescale: init.timescale };
}
/**
 * CENC (AES-CTR) the way a packager writes it, from clear fragments: per
 * sample an 8-byte IV and one subsample (the first 32 bytes clear, the rest
 * encrypted), senc/saiz/saio in each traf, the mdat encrypted in place.
 * ffmpeg encrypts whole files but its fragmented output carries no senc, so
 * the test does it. The init comes from ffmpeg's encrypted file (encv, tenc).
 */
function encryptRendition(dir: string) {
  const whole = join(WORK, 'enc-whole.mp4');
  ff(['-i', SRC, '-map', '0:v', '-c', 'copy', '-encryption_scheme', 'cenc-aes-ctr', '-encryption_key', KEY, '-encryption_kid', KID,
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', whole]);
  const wb = readFileSync(whole);
  const top = boxesOf(wb);
  writeFileSync(join(dir, 'init.mp4'), Buffer.concat(top.filter((b) => b.type === 'ftyp' || b.type === 'moov').map((b) => wb.subarray(b.start, b.end))));
  let ivn = 1;
  for (const f of readdirSync(dir).filter((x) => /^seg_\d+\.m4s$/.test(x))) {
    const b = readFileSync(join(dir, f));
    const parts: Buffer[] = [];
    const bx = boxesOf(b);
    for (let i = 0; i < bx.length; i++) {
      const x = bx[i];
      if (x.type !== 'moof') { if (!(i > 0 && bx[i - 1].type === 'moof' && x.type === 'mdat')) parts.push(b.subarray(x.start, x.end)); continue; }
      const mdat = bx[i + 1];
      const traf = boxesOf(b, x.body, x.end).find((y) => y.type === 'traf')!;
      const trun = boxesOf(b, traf.body, traf.end).find((y) => y.type === 'trun')!;
      const fl = b.readUInt32BE(trun.body) & 0xffffff, n = b.readUInt32BE(trun.body + 4);
      let q = trun.body + 8;
      const offAt = q; const dataOff = b.readInt32BE(q); q += 4;
      if (fl & 0x04) q += 4;
      const sizes: number[] = [];
      for (let k = 0; k < n; k++) {
        if (fl & 0x100) q += 4;
        sizes.push(b.readUInt32BE(q)); q += 4;
        if (fl & 0x400) q += 4;
        if (fl & 0x800) q += 4;
      }
      const entries: Buffer[] = [];
      const data = Buffer.from(b.subarray(x.start + dataOff, x.start + dataOff + sizes.reduce((a, c) => a + c, 0)));
      let at = 0;
      for (const sz of sizes) {
        const iv = Buffer.alloc(8); iv.writeUInt32BE(ivn++, 4);
        const clear = Math.min(32, sz), prot = sz - clear;
        const e = Buffer.alloc(8 + 2 + 6); iv.copy(e, 0); e.writeUInt16BE(1, 8); e.writeUInt16BE(clear, 10); e.writeUInt32BE(prot, 12);
        entries.push(e);
        const c = createCipheriv('aes-128-ctr', Buffer.from(KEY, 'hex'), Buffer.concat([iv, Buffer.alloc(8)]));
        const enc = c.update(data.subarray(at + clear, at + sz)); enc.copy(data, at + clear);
        at += sz;
      }
      const mk = (type: string, body: Buffer) => { const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length); h.write(type, 4, 'latin1'); return Buffer.concat([h, body]); };
      const u32 = (v: number) => { const t = Buffer.alloc(4); t.writeUInt32BE(v); return t; };
      const senc = mk('senc', Buffer.concat([u32(2), u32(n), ...entries]));
      const saiz = mk('saiz', Buffer.concat([u32(0), Buffer.from([16]), u32(n)]));
      const saioLen = 8 + 4 + 4 + 4;
      const add = saiz.length + saioLen + senc.length;
      // senc goes last in the traf, the traf is last in the moof.
      const sencDataFromMoof = (x.end - x.start) + add - senc.length + 16;
      const saio = mk('saio', Buffer.concat([u32(0), u32(1), u32(sencDataFromMoof)]));
      const moofB = Buffer.from(b.subarray(x.start, x.end));
      moofB.writeUInt32BE(moofB.length + add, 0);
      moofB.writeUInt32BE(traf.end - traf.start + add, traf.start - x.start);
      moofB.writeInt32BE(dataOff + add, offAt - x.start);
      if (traf.end !== x.end) throw new Error('traf is not last in the moof');
      parts.push(moofB, saiz, saio, senc, b.subarray(mdat.start, mdat.body), data);
      i++;
    }
    writeFileSync(join(dir, f), Buffer.concat(parts));
  }
}

function shakaAsset(id: string, opts: { encrypted?: boolean } = {}) {
  const d = join(CLIPS, 'vod', id);
  hlsDir(SRC, join(d, 'v720'), ['-map', '0:v']);
  if (opts.encrypted) encryptRendition(join(d, 'v720'));
  if (!opts.encrypted) hlsDir(SRC180, join(d, 'v180'), ['-map', '0:v']);
  hlsDir(SRC, join(d, 'audio'), ['-map', '0:a']);
  const key = opts.encrypted ? `#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:text/plain;base64,AAAA",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"` : undefined;
  besideMaster(d, 'v720', 'stream_0.m3u8', key);
  if (!opts.encrypted) besideMaster(d, 'v180', 'stream_1.m3u8');
  besideMaster(d, 'audio', 'stream_2.m3u8');
  writeFileSync(join(d, 'master.m3u8'), ['#EXTM3U', '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-MEDIA:TYPE=AUDIO,URI="stream_2.m3u8",GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES',
    '#EXT-X-STREAM-INF:BANDWIDTH=1700000,CODECS="avc1.64001e,mp4a.40.2",RESOLUTION=640x360,FRAME-RATE=25.000,AUDIO="audio"', 'stream_0.m3u8',
    ...(opts.encrypted ? [] : ['#EXT-X-STREAM-INF:BANDWIDTH=400000,CODECS="avc1.64000d,mp4a.40.2",RESOLUTION=320x180,FRAME-RATE=25.000,AUDIO="audio"', 'stream_1.m3u8']), ''].join('\n'));
  const t720 = timeline(join(d, 'v720'), 10), t180 = opts.encrypted ? null : timeline(join(d, 'v180'), 10), ta = timeline(join(d, 'audio'), 10);
  const prot = opts.encrypted ? `<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc" cenc:default_KID="${KID.replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-')}"/><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"><cenc:pssh>AAAA</cenc:pssh></ContentProtection>` : '';
  writeFileSync(join(d, 'manifest.mpd'), `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013" profiles="urn:mpeg:dash:profile:isoff-live:2011" minBufferTime="PT2S" type="static" mediaPresentationDuration="PT20S">
  <Period id="0">
    <AdaptationSet id="0" contentType="video" maxWidth="640" maxHeight="360" frameRate="25" segmentAlignment="true" par="16:9">
      ${prot}
      <Representation id="0" bandwidth="1500000" codecs="avc1.64001e" mimeType="video/mp4" sar="1:1" width="640" height="360">
        <SegmentTemplate timescale="${t720.timescale}" initialization="v720/init.mp4" media="v720/seg_$Number$.m4s" startNumber="1"><SegmentTimeline>${t720.xml}</SegmentTimeline></SegmentTemplate>
      </Representation>${t180 ? `
      <Representation id="1" bandwidth="400000" codecs="avc1.64000d" mimeType="video/mp4" sar="1:1" width="320" height="180">
        <SegmentTemplate timescale="${t180.timescale}" initialization="v180/init.mp4" media="v180/seg_$Number$.m4s" startNumber="1"><SegmentTimeline>${t180.xml}</SegmentTimeline></SegmentTemplate>
      </Representation>` : ''}
    </AdaptationSet>
    <AdaptationSet id="1" contentType="audio" lang="en" segmentAlignment="true">
      <Representation id="2" bandwidth="96000" codecs="mp4a.40.2" mimeType="audio/mp4" audioSamplingRate="44100">
        <SegmentTemplate timescale="${ta.timescale}" initialization="audio/init.mp4" media="audio/seg_$Number$.m4s" startNumber="1"><SegmentTimeline>${ta.xml}</SegmentTimeline></SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>
`);
}
shakaAsset(SH);
shakaAsset(EN, { encrypted: true });
// ffmpeg's own DASH muxer, with its HLS playlists over the same segments.
{
  const d = join(CLIPS, 'vod', FF);
  mkdirSync(d, { recursive: true });
  ff(['-i', SRC, '-i', SRC180, '-map', '0:v', '-map', '1:v', '-map', '0:a', '-c', 'copy', '-f', 'dash', '-seg_duration', '2', '-use_template', '1', '-use_timeline', '1',
    '-hls_playlist', '1', '-adaptation_sets', 'id=0,streams=v id=1,streams=a', join(d, 'manifest.mpd')]);
}
// A FAST ladder's own MPD and master under the SH asset (another folder).
{
  const L = join(CLIPS, 'vod', SH, 'ladders', 'x', '4s');
  mkdirSync(L, { recursive: true });
  copyFileSync(join(CLIPS, 'vod', SH, 'manifest.mpd'), join(L, 'manifest.mpd'));
  copyFileSync(join(CLIPS, 'vod', SH, 'master.m3u8'), join(L, 'master.m3u8'));
}

const sig = (file: string, filter: string, extra: string[] = []) => execFileSync('ffmpeg', ['-v', 'error', ...extra, '-i', file, '-vf', `${filter}scale=32:32,format=gray`,
  '-fps_mode', 'passthrough', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 1 << 20 });
const truth = (n: number) => sig(SRC, `select=eq(n\\,${n}),`);
const mad = (a: Buffer, b: Buffer) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
/** Is the picture this source frame and clearly not its neighbours? */
const isFrame = (pic: Buffer | null, n: number) => {
  if (!pic || pic.length !== 1024) return false;
  const d = mad(pic, truth(n)), lo = n > 0 ? mad(pic, truth(n - 1)) : Infinity, hi = mad(pic, truth(n + 1));
  return d < 6 && d * 3 < Math.min(lo, hi);
};

async function main() {
  const tp = await import('../src/services/trickplay/iframes');
  const { readInit } = await import('../src/services/frames/fmp4');
  const store = await import('../src/services/trickplay/store');
  const { query, one, pool } = await import('../src/db');
  const { createServer } = await import('../src/server');
  const { invalidateAll } = await import('../src/scale/cache');

  await query(`DELETE FROM accounts WHERE id = $1`, [A]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'TrickDash')`, [A]);
  await query(`INSERT INTO output_profiles(id,account_id,name,rungs) VALUES ($1,$2,'HD','[{"height":720,"bitrate_kbps":1500}]')`, [P, A]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id) VALUES ($1,$2,'g',$3)`, [G, A, P]);
  await query(`INSERT INTO channels(id,group_id,name,status) VALUES ($1,$2,'td-ch','scheduled')`, [CH, G]);
  for (const id of [SH, FF, EN]) await query(
    `INSERT INTO vod_assets(id, account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, channel_id)
     VALUES ($1,$2,'recording','clip',$3,$4,0,20000,20000,$5)`, [id, A, id.slice(-4), `/clips/vod/${id}/master.m3u8`, CH]);

  const app = createServer();
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const get = (p: string) => fetch(base + p);
  const mpdOf = async (id: string, file = 'manifest.mpd') => (await get(`/clips/vod/${id}/${file}`)).text();
  // The build is queued without holding up the answer: wait for it a little.
  const queued = async (id: string) => {
    for (let i = 0; i < 40; i++) {
      if (Number((await one<any>(`SELECT count(*)::int AS n FROM jobs WHERE type = 'trickplay.build' AND payload->>'vodAssetId' = $1`, [id]))?.n) === 1) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };
  const trickSets = (mpd: string) => [...mpd.matchAll(/<AdaptationSet\b[^>]*>(?:(?!<\/AdaptationSet>)[\s\S])*?dashif\.org\/guidelines\/trickmode[\s\S]*?<\/AdaptationSet>/g)].map((m) => m[0]);

  console.log('== a trick segment (pure) ==');
  const d720 = join(CLIPS, 'vod', SH, 'v720');
  const initBuf = readFileSync(join(d720, 'init.mp4'));
  const init = readInit(initBuf)!;
  ok('the clear init has no IV size (not encrypted)', tp.initIvSize(initBuf) === null);
  const seg3 = readFileSync(join(d720, 'seg_3.m4s'));
  const k = tp.keyframeRanges(seg3, init)[0];
  const frag = tp.keyframeFragment(seg3.subarray(k.start, k.end), init.trackId, 2 * init.timescale, null)!;
  ok('a fragment is made', !!frag);
  const top = boxesOf(frag);
  ok('it is a moof and an mdat, nothing else', top.map((b) => b.type).join(',') === 'moof,mdat', top.map((b) => b.type));
  const moof = top[0], mdat = top[1];
  const traf = boxesOf(frag, moof.body, moof.end).find((b) => b.type === 'traf')!;
  const kids = boxesOf(frag, traf.body, traf.end);
  const trun = kids.find((b) => b.type === 'trun')!, tfdt = kids.find((b) => b.type === 'tfdt')!;
  ok('one sample', frag.readUInt32BE(trun.body + 4) === 1);
  const sampleSize = frag.readUInt32BE(trun.body + 16);
  ok('the mdat holds exactly the keyframe', mdat.end - mdat.body === sampleSize && Buffer.compare(frag.subarray(mdat.body, mdat.end), seg3.subarray(k.end - sampleSize, k.end)) === 0);
  ok('the data offset points at it', frag.readInt32BE(trun.body + 8) === mdat.body);
  ok('it lasts 2 s', frag.readUInt32BE(trun.body + 12) === 2 * init.timescale);
  ok('flagged as a sync sample', ((frag.readUInt32BE(trun.body + 20) >>> 16) & 1) === 0);
  const srcMoof = boxesOf(seg3).find((b) => b.type === 'moof')!;
  const srcTfdt = boxesOf(seg3, boxesOf(seg3, srcMoof.body, srcMoof.end).find((b) => b.type === 'traf')!.body).find((b) => b.type === 'tfdt')!;
  const srcDecode = seg3[srcTfdt.body] === 1 ? Number(seg3.readBigUInt64BE(srcTfdt.body + 4)) : seg3.readUInt32BE(srcTfdt.body + 4);
  ok('its decode time is the keyframe\'s', Number(frag.readBigUInt64BE(tfdt.body + 4)) === srcDecode);
  const one1 = join(WORK, 'trick1.mp4');
  writeFileSync(one1, Buffer.concat([initBuf, frag]));
  let pic: Buffer | null = null;
  try { pic = sig(one1, ''); } catch { pic = null; }
  ok('init plus the trick segment decodes to source frame 100', isFrame(pic, 100));
  ok('not a range that does not start at a moof', tp.keyframeFragment(seg3.subarray(k.start + 8, k.end), init.trackId, 1, null) === null);
  ok('not for another track', tp.keyframeFragment(seg3.subarray(k.start, k.end), init.trackId + 7, 1, null) === null);

  // All ten in a row decode to ten pictures, one per keyframe.
  const segs = tp.mediaSegments(readFileSync(join(d720, 'index.m3u8'), 'utf8')).map((s) => ({ ...s, keyframes: tp.keyframeRanges(readFileSync(join(d720, s.uri)), init) }));
  const entries = tp.dashEntries(segs, init.timescale);
  ok(`ten entries of 2 s covering 20 s (got ${entries.length})`, entries.length === 10 && entries.every((e) => e.dur === 2 * init.timescale));
  const all = Buffer.concat([initBuf, ...entries.map((e) => tp.keyframeFragment(readFileSync(join(d720, e.uri)).subarray(e.start, e.end), init.trackId, e.dur, null)!)]);
  const allFile = join(WORK, 'trick-all.mp4');
  writeFileSync(allFile, all);
  const frames = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', allFile]).toString().trim();
  ok(`the whole trick track decodes to 10 pictures (got ${frames})`, frames === '10');
  let lastPic: Buffer | null = null;
  try { lastPic = execFileSync('ffmpeg', ['-v', 'error', '-i', allFile, '-vf', 'select=eq(n\\,9),scale=32:32,format=gray', '-fps_mode', 'passthrough', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 1 << 20 }); } catch { lastPic = null; }
  ok('its tenth picture is source frame 450', isFrame(lastPic, 450));

  console.log('\n== the MPD (pure) ==');
  const mainMpd = readFileSync(join(CLIPS, 'vod', SH, 'manifest.mpd'), 'utf8');
  const trick = { init: 'v720/init.mp4', timescale: init.timescale, trackId: init.trackId, ivSize: null, key: 'abcd0123', entries };
  const withT = tp.withDashTrickMode(mainMpd, [trick], () => 123456);
  const sets = trickSets(withT);
  ok('one trick-mode set added', sets.length === 1);
  ok('it points at the video set and comes right after it', /value="0"/.test(sets[0] ?? '') && withT.indexOf(sets[0]) > withT.indexOf('<AdaptationSet id="0"') && withT.indexOf(sets[0]) < withT.indexOf('<AdaptationSet id="1"'));
  ok('its id is new', /<AdaptationSet id="2"/.test(sets[0] ?? ''));
  ok('only the rendition that has one gets a Representation', (sets[0].match(/<Representation\b/g) ?? []).length === 1 && /id="trick-0"/.test(sets[0]));
  ok('codecs, size, maxPlayoutRate 50 (one picture per 50) and codingDependency false', /codecs="avc1.64001e"/.test(sets[0]) && /width="640"/.test(sets[0]) && /maxPlayoutRate="50"/.test(sets[0]) && /codingDependency="false"/.test(sets[0]));
  ok('its segments are trick/<key>/$Number$.m4s on the main init', /initialization="v720\/init.mp4" media="trick\/abcd0123\/\$Number\$.m4s" startNumber="1"/.test(sets[0]));
  const S = [...sets[0].matchAll(/<S t="(\d+)" d="(\d+)"(?: r="(\d+)")?\/>/g)];
  const total = S.reduce((a, m) => a + Number(m[2]) * (1 + Number(m[3] ?? 0)), 0);
  ok(`its timeline is 10 entries over 20 s (${S.length} S, ${total / init.timescale} s)`, S.reduce((a, m) => a + 1 + Number(m[3] ?? 0), 0) === 10 && total === 20 * init.timescale);
  ok('the audio set is untouched', withT.includes(mainMpd.slice(mainMpd.indexOf('<AdaptationSet id="1"'), mainMpd.indexOf('</Period>'))));
  ok('a second pass adds nothing', tp.withDashTrickMode(withT, [trick], () => 1) === withT);
  const twoPeriods = mainMpd.replace('</Period>', '</Period><Period id="1"></Period>');
  ok('a stitched MPD (several Periods) is left alone', tp.withDashTrickMode(twoPeriods, [trick], () => 1) === twoPeriods);
  ok('no renditions, no change', tp.withDashTrickMode(mainMpd, [], () => 1) === mainMpd);

  console.log('\n== off by default ==');
  ok('the MPD lists no trick-mode set', trickSets(await mpdOf(SH)).length === 0);
  ok('a trick segment answers 404', (await get(`/clips/vod/${SH}/trick/abcd0123/1.m4s`)).status === 404);
  ok('no build is queued', Number((await one<any>(`SELECT count(*)::int AS n FROM jobs WHERE type = 'trickplay.build'`))?.n) === 0);

  console.log('\n== switched on ==');
  await query(`UPDATE output_profiles SET trick_play = true WHERE id = $1`, [P]);
  invalidateAll();
  ok('the first MPD is served as it was', trickSets(await mpdOf(SH)).length === 0);
  ok('and queues the build', await queued(SH));
  const bSH = await store.buildAssetTrickPlay(SH);
  ok(`the build covers both renditions (${bSH.renditions}, note ${bSH.note})`, bSH.state === 'ready' && bSH.renditions === 2 && !bSH.note);
  invalidateAll();
  const mSH = await mpdOf(SH);
  const setsSH = trickSets(mSH);
  ok('the MPD now has one trick-mode set for the video set', setsSH.length === 1 && /value="0"/.test(setsSH[0]));
  ok('with a Representation per rendition', (setsSH[0].match(/<Representation\b/g) ?? []).length === 2 && /initialization="v720\/init.mp4"/.test(setsSH[0]) && /initialization="v180\/init.mp4"/.test(setsSH[0]));
  const keys = [...setsSH[0].matchAll(/media="trick\/([0-9a-f]{8})\//g)].map((m) => m[1]);
  ok('two different keys', keys.length === 2 && keys[0] !== keys[1]);
  let served = 0, valid = 0;
  for (const kk of keys) for (let n = 1; n <= 10; n++) {
    const r = await get(`/clips/vod/${SH}/trick/${kk}/${n}.m4s`);
    if (r.status === 200 && (r.headers.get('content-type') ?? '') === 'video/mp4') served++;
    const b = Buffer.from(await r.arrayBuffer());
    const bx = boxesOf(b);
    if (bx.length === 2 && bx[0].type === 'moof' && bx[1].type === 'mdat') valid++;
  }
  ok(`every trick segment is served (${served}/20) and is one fragment (${valid}/20)`, served === 20 && valid === 20);
  const r720 = Buffer.from(await (await get(`/clips/vod/${SH}/trick/${keys[0]}/6.m4s`)).arrayBuffer());
  const kInit = /initialization="([^"]+)" media="trick\/([0-9a-f]{8})/g;
  const initOfKey = new Map([...setsSH[0].matchAll(kInit)].map((m) => [m[2], m[1]]));
  const servedFile = join(WORK, 'served.mp4');
  writeFileSync(servedFile, Buffer.concat([readFileSync(join(CLIPS, 'vod', SH, initOfKey.get(keys[0])!)), r720]));
  let pic6: Buffer | null = null;
  try { pic6 = sig(servedFile, ''); } catch { pic6 = null; }
  ok('the sixth served one decodes to source frame 250', isFrame(pic6, 250));
  ok('past the end answers 404', (await get(`/clips/vod/${SH}/trick/${keys[0]}/11.m4s`)).status === 404);
  ok('an unknown key answers 404', (await get(`/clips/vod/${SH}/trick/ffffffff/1.m4s`)).status === 404);
  ok('a trick path in another folder answers 404', (await get(`/clips/vod/${SH}/v720/trick/${keys[0]}/1.m4s`)).status === 404);

  console.log('\n== Shaka layout: one I-frame playlist per rendition ==');
  const master = await (await get(`/clips/vod/${SH}/master.m3u8`)).text();
  const iLines = master.split('\n').filter((l) => l.startsWith('#EXT-X-I-FRAME-STREAM-INF'));
  ok('two I-frame streams with their own addresses', iLines.length === 2 && iLines.some((l) => /URI="stream_0.iframes.m3u8"/.test(l)) && iLines.some((l) => /URI="stream_1.iframes.m3u8"/.test(l)), iLines);
  const i0 = await (await get(`/clips/vod/${SH}/stream_0.iframes.m3u8`)).text();
  const i1 = await (await get(`/clips/vod/${SH}/stream_1.iframes.m3u8`)).text();
  ok('each served, naming its own rendition\'s segments', /v720\/seg_1.m4s/.test(i0) && !/v180/.test(i0) && /v180\/seg_1.m4s/.test(i1) && !/v720/.test(i1));

  console.log('\n== ffmpeg\'s DASH muxer ($RepresentationID$) ==');
  const bFF = await store.buildAssetTrickPlay(FF);
  ok(`built for both renditions (${bFF.renditions}, ${bFF.note})`, bFF.state === 'ready' && bFF.renditions === 2);
  invalidateAll();
  const mFF = await mpdOf(FF);
  const setsFF = trickSets(mFF);
  ok('one trick-mode set', setsFF.length === 1);
  const inits = [...(setsFF[0] ?? '').matchAll(/initialization="([^"]+)"/g)].map((m) => m[1]);
  ok(`its inits are the resolved files (${inits.join(', ')})`, inits.length === 2 && inits.every((x) => !x.includes('$') && readdirSync(join(CLIPS, 'vod', FF)).includes(x)));
  const kFF = /media="trick\/([0-9a-f]{8})\//.exec(setsFF[0] ?? '')?.[1];
  ok('and its segments are served', !!kFF && (await get(`/clips/vod/${FF}/trick/${kFF}/1.m4s`)).status === 200);

  console.log('\n== encrypted (CENC, AES-CTR with subsamples) ==');
  const dEN = join(CLIPS, 'vod', EN, 'v720');
  const initEN = readFileSync(join(dEN, 'init.mp4'));
  ok(`the init's IV size is read (${tp.initIvSize(initEN)})`, tp.initIvSize(initEN) === 8 || tp.initIvSize(initEN) === 16);
  const wholeEN = join(WORK, 'enc-seg3.mp4');
  writeFileSync(wholeEN, Buffer.concat([initEN, readFileSync(join(dEN, 'seg_3.m4s'))]));
  let segPic: Buffer | null = null, segClear: Buffer | null = null;
  try { segPic = sig(wholeEN, '', ['-decryption_key', KEY]); } catch { segPic = null; }
  try { segClear = sig(wholeEN, ''); } catch { segClear = null; }
  ok('(the test asset: its segment decrypts to frame 100, and is not that frame undecrypted)', isFrame(segPic, 100) && !isFrame(segClear, 100));
  const bEN = await store.buildAssetTrickPlay(EN);
  ok(`built (${bEN.renditions}, ${bEN.note})`, bEN.state === 'ready' && bEN.renditions === 1 && !bEN.note);
  invalidateAll();
  const setsEN = trickSets(await mpdOf(EN));
  ok('the MPD has its trick-mode set', setsEN.length === 1);
  ok('with the video set\'s ContentProtection carried', (setsEN[0]?.match(/<ContentProtection\b/g) ?? []).length === 2 && /cenc:default_KID/.test(setsEN[0] ?? ''));
  const kEN = /media="trick\/([0-9a-f]{8})\//.exec(setsEN[0] ?? '')?.[1];
  const fEN = Buffer.from(await (await get(`/clips/vod/${EN}/trick/${kEN}/3.m4s`)).arrayBuffer());
  const mEN = boxesOf(fEN)[0];
  const tEN = boxesOf(fEN, mEN.body, mEN.end).find((b) => b.type === 'traf')!;
  const kidsEN = boxesOf(fEN, tEN.body, tEN.end).map((b) => b.type);
  ok(`the fragment carries senc, saiz and saio (${kidsEN.join(',')})`, ['senc', 'saiz', 'saio'].every((x) => kidsEN.includes(x)));
  const senc = boxesOf(fEN, tEN.body, tEN.end).find((b) => b.type === 'senc')!;
  const saio = boxesOf(fEN, tEN.body, tEN.end).find((b) => b.type === 'saio')!;
  ok('one senc entry, with saio pointing at it', fEN.readUInt32BE(senc.body + 4) === 1 && fEN.readUInt32BE(saio.body + 8) === senc.body + 8);
  const encFile = join(WORK, 'enc-trick.mp4');
  writeFileSync(encFile, Buffer.concat([initEN, fEN]));
  let picEN: Buffer | null = null;
  try { picEN = sig(encFile, '', ['-decryption_key', KEY]); } catch { picEN = null; }
  ok('decrypted with the asset\'s key it is source frame 100', isFrame(picEN, 100));
  let wrong: Buffer | null = null;
  try { wrong = sig(encFile, '', ['-decryption_key', 'ffeeddccbbaa99887766554433221100']); } catch { wrong = null; }
  ok('and with another key it is not', !isFrame(wrong, 100));
  const iEN = await (await get(`/clips/vod/${EN}/stream_0.iframes.m3u8`)).text();
  ok('its HLS I-frame playlist still carries the key line', /#EXT-X-KEY:METHOD=SAMPLE-AES-CTR/.test(iEN) && /#EXT-X-I-FRAMES-ONLY/.test(iEN));

  console.log('\n== only the asset\'s own MPD and master ==');
  ok('a FAST ladder\'s MPD under the asset gets no trick-mode set', trickSets(await mpdOf(SH, 'ladders/x/4s/manifest.mpd')).length === 0);
  ok('nor its master any I-frame stream', !/I-FRAME/.test(await (await get(`/clips/vod/${SH}/ladders/x/4s/master.m3u8`)).text()));

  console.log('\n== a build from before 3.2b-2 ==');
  await query(`UPDATE vod_iframe_playlists SET dash = NULL WHERE vod_asset_id = $1`, [FF]);
  await query(`DELETE FROM jobs WHERE type = 'trickplay.build'`);
  invalidateAll();
  ok('its MPD has no trick-mode set yet', trickSets(await mpdOf(FF)).length === 0);
  ok('and queues the rebuild', await queued(FF));
  ok('its HLS I-frame streams stay listed meanwhile', /I-FRAME-STREAM-INF/.test(await (await get(`/clips/vod/${FF}/master.m3u8`)).text()));

  console.log('\n== switched off again ==');
  await query(`UPDATE output_profiles SET trick_play = false WHERE id = $1`, [P]);
  invalidateAll();
  ok('the MPD lists no trick-mode set', trickSets(await mpdOf(SH)).length === 0);
  ok('its segments answer 404', (await get(`/clips/vod/${SH}/trick/${keys[0]}/1.m4s`)).status === 404);
  await query(`UPDATE output_profiles SET trick_play = true WHERE id = $1`, [P]);
  invalidateAll();
  ok('on again: listed at once', trickSets(await mpdOf(SH)).length === 1);

  console.log('\n== a re-encode ==');
  await query(`UPDATE vod_iframe_playlists SET source = 'old' WHERE vod_asset_id = $1`, [SH]);
  invalidateAll();
  ok('an older build is not listed', trickSets(await mpdOf(SH)).length === 0);
  ok('nor its segments served', (await get(`/clips/vod/${SH}/trick/${keys[0]}/1.m4s`)).status === 404);

  srv.close();
  await query(`DELETE FROM accounts WHERE id = $1`, [A]);
  await pool.end();
  console.log(`\ntrickplay-dash: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
