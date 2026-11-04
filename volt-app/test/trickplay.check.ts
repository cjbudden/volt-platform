// ============================================================================
//  I-FRAME TRICK-PLAY FOR ON-DEMAND ASSETS (build queue 3.2b, services/trickplay).
//
//  Real media made here with ffmpeg: a 20 s, 25 fps CMAF asset with B-frames,
//  a keyframe every 2 s, two video renditions and an audio-only one (the shape
//  of Volt's encodes); the small one has a keyframe every second inside each
//  2 s fragment. Two segments back to back stand in for a two-fragment one.
//
//  What is checked:
//    - every I-frame entry is a byte range that starts at a moof, whose first
//      sample is a keyframe, and that ends exactly where the keyframe's sample
//      ends; decoding the range gives the source frame at that time;
//    - one entry per keyframe that opens a fragment (a later keyframe in the
//      same fragment is not listed), durations add up to the media's;
//    - switched off (the default), nothing is made or listed and the playlist
//      route answers 404;
//    - switched on later, the first master asked for queues the build (no
//      re-encode), and then lists an EXT-X-I-FRAME-STREAM-INF per video
//      rendition, never the audio one;
//    - an encrypted rendition's key is carried into its I-frame playlist;
//    - which switch applies: the channel's group profile for a clip, the
//      profile a ladder mirrors for an upload, the account default otherwise;
//      a new profile starts with the account default;
//    - a stitched (ad) master leaves the I-frame streams out;
//    - only account administrators change the switch, and only their own.
//
//  Usage: DATABASE_URL=... npx tsx test/trickplay.check.ts
// ============================================================================
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const WORK = mkdtempSync(join(tmpdir(), 'volt-trickplay-check-'));
process.env.CLIPS_DIR = join(WORK, 'clips');
process.env.ORIGIN_DIR = join(WORK, 'origin');
process.env.IMAGE_STORE_DIR = join(WORK, 'image-store');
mkdirSync(process.env.CLIPS_DIR, { recursive: true });

let pass = 0, fail = 0;
const ok = (m: string, c: boolean, extra?: unknown) => {
  if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (extra === undefined ? '' : `  -> ${JSON.stringify(extra)}`)); }
};

const A = '00000000-0000-0000-0000-0000000e3a01';
const A2 = '00000000-0000-0000-0000-0000000e3a02';
const P = '00000000-0000-0000-0000-0000000e3b01';      // the channel group's profile
const P2 = '00000000-0000-0000-0000-0000000e3b02';     // the profile a ladder mirrors
const G = '00000000-0000-0000-0000-0000000e3c01';
const CH = '00000000-0000-0000-0000-0000000e3d01';
const L = '00000000-0000-0000-0000-0000000e3e01';
const U = '00000000-0000-0000-0000-0000000e3f01';
const UOP = '00000000-0000-0000-0000-0000000e3f02';
const U2 = '00000000-0000-0000-0000-0000000e3f03';
const CLIP = '00000000-0000-0000-0000-0000000e4001';   // cut from the channel
const UPL = '00000000-0000-0000-0000-0000000e4002';    // upload, ladder mirrors P2
const LONE = '00000000-0000-0000-0000-0000000e4003';   // upload, no ladder: account default

const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

// A ramp that moves 41 levels a frame: every frame differs from its neighbours.
const SRC = join(WORK, 'source.mp4');
ff(['-f', 'lavfi', '-i', "nullsrc=size=640x360:rate=25:duration=20,geq=lum='mod(2*X+41*N,256)':cb='mod(Y+3*N,256)':cr=128",
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
  '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-bf', '2', '-b:v', '1500k',
  '-c:a', 'aac', '-b:a', '96k', SRC]);
const SRC1 = join(WORK, 'source-1s.mp4');
ff(['-i', SRC, '-an', '-vf', 'scale=320:180', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-keyint_min', '25', '-sc_threshold', '0', '-bf', '2', SRC1]);

function hls(src: string, dir: string, extra: string[], map: string[]) {
  mkdirSync(dir, { recursive: true });
  ff(['-i', src, ...map, ...extra, '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', join(dir, 'seg_%03d.m4s'), join(dir, 'index.m3u8')]);
}
function makeAsset(id: string) {
  const d = join(process.env.CLIPS_DIR!, 'vod', id);
  hls(SRC, join(d, 'v720'), ['-c', 'copy'], ['-map', '0:v']);
  // Two fragments per 2 s segment, each opening on a keyframe.
  hls(SRC1, join(d, 'v180'), ['-c', 'copy'], ['-map', '0:v']);
  hls(SRC, join(d, 'a'), ['-c', 'copy'], ['-map', '0:a']);
  writeFileSync(join(d, 'master.m3u8'), ['#EXTM3U', '#EXT-X-VERSION:7',
    '#EXT-X-STREAM-INF:BANDWIDTH=96000,CODECS="mp4a.40.2"', 'a/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1700000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2"', 'v720/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=320x180,CODECS="avc1.64000d,mp4a.40.2"', 'v180/index.m3u8', ''].join('\n'));
}
for (const id of [CLIP, UPL, LONE]) makeAsset(id);
// The clip's 720p rendition is encrypted (a key line as the packager writes it;
// the bytes are left clear: only the playlist is under test here).
const keyed = join(process.env.CLIPS_DIR!, 'vod', CLIP, 'v720', 'index.m3u8');
writeFileSync(keyed, readFileSync(keyed, 'utf8').replace('#EXT-X-MAP:', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k1",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXT-X-MAP:'));

/** 32x32 grey signature of source frame n, and of a JPEG/raw decode. */
const sig = (file: string, filter: string) => execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `${filter}scale=32:32,format=gray`,
  '-fps_mode', 'passthrough', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 1 << 20 });
const truth = (n: number) => sig(SRC, `select=eq(n\\,${n}),`);
const mad = (a: Buffer, b: Buffer) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };

async function main() {
  const { keyframeRanges, buildIframePlaylist, mediaSegments, videoVariants, withIframeStreams } = await import('../src/services/trickplay/iframes');
  const { readInit } = await import('../src/services/frames/fmp4');
  const store = await import('../src/services/trickplay/store');
  const { rewriteMaster } = await import('../src/services/vodAds/hls');
  const { query, one, pool } = await import('../src/db');
  const { createServer } = await import('../src/server');
  const { signAccess } = await import('../src/auth/jwt');

  await query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [[A, A2]]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'Trick'),($2,'Other')`, [A, A2]);
  await query(`INSERT INTO output_profiles(id,account_id,name,rungs) VALUES ($1,$3,'HD','[{"height":720,"bitrate_kbps":1500}]'),($2,$3,'Files','[{"height":720,"bitrate_kbps":1500}]')`, [P, P2, A]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id) VALUES ($1,$2,'g',$3)`, [G, A, P]);
  await query(`INSERT INTO channels(id,group_id,name,status) VALUES ($1,$2,'tp-ch','scheduled')`, [CH, G]);
  await query(`INSERT INTO encode_ladder_groups(id,account_id,name,tracks_output_profile_id) VALUES ($1,$2,'Mirror',$3)`, [L, A, P2]);
  await query(`INSERT INTO users(id,account_id,email,password_hash,role,status) VALUES ($1,$2,'tp@test.local','x','admin','active'),($3,$2,'tpop@test.local','x','operator','active'),($4,$5,'tpo@test.local','x','admin','active')`, [U, A, UOP, U2, A2]);
  const asset = (id: string, extra: Record<string, string | null>) => query(
    `INSERT INTO vod_assets(id, account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, channel_id, ladder_group_id)
     VALUES ($1,$2,$3,'clip',$4,$5,0,20000,20000,$6,$7)`,
    [id, A, extra.channel ? 'recording' : 'upload', id.slice(-4), `/clips/vod/${id}/master.m3u8`, extra.channel ?? null, extra.ladder ?? null]);
  await asset(CLIP, { channel: CH });
  await asset(UPL, { ladder: L });
  await asset(LONE, {});

  const app = createServer();
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const tok = (sub: string, acc: string, role: string) => ({ authorization: `Bearer ${signAccess({ sub, account_id: acc, role } as any)}`, 'content-type': 'application/json' });
  const H = tok(U, A, 'admin'), HOP = tok(UOP, A, 'operator'), H2 = tok(U2, A2, 'admin');
  const get = (p: string) => fetch(base + p);
  const patch = (p: string, body: unknown, h: Record<string, string> = H) => fetch(base + p, { method: 'PATCH', headers: h, body: JSON.stringify(body) });
  const { invalidateAll } = await import('../src/scale/cache');

  console.log('== keyframe byte ranges (pure) ==');
  const dir720 = join(process.env.CLIPS_DIR!, 'vod', UPL, 'v720');
  const init = readInit(readFileSync(join(dir720, 'init.mp4')))!;
  ok('the init has a video track', !!init && init.isVideo);
  const segs = mediaSegments(readFileSync(join(dir720, 'index.m3u8'), 'utf8'));
  ok(`10 segments of 2 s (got ${segs.length})`, segs.length === 10);
  let allMoof = true, allEnd = true, k1 = 0;
  const seg2 = readFileSync(join(dir720, segs[2].uri));
  for (const s of segs) {
    const b = readFileSync(join(dir720, s.uri));
    const ks = keyframeRanges(b, init);
    k1 += ks.length;
    for (const k of ks) {
      if (b.toString('latin1', k.start + 4, k.start + 8) !== 'moof') allMoof = false;
      if (!(k.end > k.start && k.end <= b.length)) allEnd = false;
    }
  }
  ok(`one keyframe per segment at a 2 s GOP (got ${k1} for 10)`, k1 === 10);
  ok('every range starts at a moof', allMoof);
  ok('every range ends inside its segment', allEnd);
  // The range is the moof and exactly the keyframe's sample: the mdat header
  // plus the first sample, and nothing of the second.
  const k2 = keyframeRanges(seg2, init)[0];
  const mdatAt = seg2.indexOf(Buffer.from('mdat')) - 4;
  ok('the range starts at the moof (after the styp) and covers the mdat header and the keyframe sample', k2.start === seg2.indexOf(Buffer.from('moof')) - 4 && k2.end > mdatAt + 8 && k2.end < seg2.length, { k2, mdatAt, len: seg2.length });
  ok(`keyframe pts is frame 100 at 25 fps (got ${k2.pts / (init.timescale / 25)})`, Math.round(k2.pts / (init.timescale / 25)) === 100 + 2, k2.pts);
  // Decoding the range alone (init + range) gives source frame 100.
  const piece = join(WORK, 'iframe.mp4');
  writeFileSync(piece, Buffer.concat([readFileSync(join(dir720, 'init.mp4')), seg2.subarray(k2.start, k2.end)]));
  let decoded: Buffer | null = null;
  try { decoded = sig(piece, ''); } catch { decoded = null; }
  ok('the range alone decodes to a picture', !!decoded && decoded.length === 1024);
  if (decoded) {
    const d100 = mad(decoded, truth(100)), d99 = mad(decoded, truth(99)), d101 = mad(decoded, truth(101));
    ok(`and it is source frame 100 (MAD ${d100.toFixed(2)}, neighbours ${d99.toFixed(2)} / ${d101.toFixed(2)})`, d100 < 6 && d100 * 3 < Math.min(d99, d101));
  }
  const dir180 = join(process.env.CLIPS_DIR!, 'vod', UPL, 'v180');
  const init180 = readInit(readFileSync(join(dir180, 'init.mp4')))!;
  const s180 = mediaSegments(readFileSync(join(dir180, 'index.m3u8'), 'utf8'));
  const ks180 = s180.map((s) => keyframeRanges(readFileSync(join(dir180, s.uri)), init180));
  // 180p has a keyframe every second inside one fragment per 2 s segment: only
  // the keyframe that opens the fragment is listed (a range always starts at
  // the moof, so a later one would carry the fragment's earlier pictures).
  ok(`a 1 s GOP in one 2 s fragment lists one I-frame per segment (got ${ks180.map((k) => k.length).join(',')})`, ks180.every((k) => k.length === 1));
  const pl = buildIframePlaylist(s180.map((s, i) => ({ ...s, keyframes: ks180[i] })), init180.timescale)!;
  const durs = [...pl.text.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]));
  ok(`10 entries, 2 s each, 20 s in all (got ${durs.length}, sum ${durs.reduce((a, b) => a + b, 0).toFixed(3)})`, durs.length === 10 && durs.every((d) => Math.abs(d - 2) < 0.002) && Math.abs(durs.reduce((a, b) => a + b, 0) - 20) < 0.01);
  // Two fragments in one segment (two 720p segments back to back): each
  // opening keyframe is listed, the second from its own moof.
  const two = Buffer.concat([seg2, readFileSync(join(dir720, segs[3].uri))]);
  const kTwo = keyframeRanges(two, init);
  ok(`two fragments in a segment give two I-frames (got ${kTwo.length})`, kTwo.length === 2);
  ok('the second starts at its own moof', kTwo.length === 2 && kTwo[1].start >= seg2.length && two.toString('latin1', kTwo[1].start + 4, kTwo[1].start + 8) === 'moof');
  ok('the playlist says I-frames only, VOD, with the init map and an end', /#EXT-X-I-FRAMES-ONLY/.test(pl.text) && /#EXT-X-PLAYLIST-TYPE:VOD/.test(pl.text) && /#EXT-X-MAP:URI="init.mp4"/.test(pl.text) && /#EXT-X-ENDLIST/.test(pl.text));
  ok('bandwidths are worked out', pl.bandwidth > 0 && pl.averageBandwidth > 0 && pl.bandwidth >= pl.averageBandwidth);
  const master = readFileSync(join(process.env.CLIPS_DIR!, 'vod', UPL, 'master.m3u8'), 'utf8');
  ok('video variants: the two video renditions, not the audio one', JSON.stringify(videoVariants(master).map((v) => v.uri)) === JSON.stringify(['v720/index.m3u8', 'v180/index.m3u8']));
  const withI = withIframeStreams(master, [{ variantUri: 'v720/index.m3u8', bandwidth: 300000, averageBandwidth: 90000, resolution: '640x360', codecs: 'avc1.64001e,mp4a.40.2' }]);
  ok('the I-frame stream line names video codecs only and its URI', /#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=300000,AVERAGE-BANDWIDTH=90000,CODECS="avc1.64001e",RESOLUTION=640x360,URI="v720\/index.iframes.m3u8"/.test(withI), withI);
  // Shaka Packager writes the media playlists beside the master
  // (stream_0.m3u8, stream_1.m3u8): each rendition still gets its own address
  // (3.2b gave them all iframes.m3u8 in the master's folder).
  const { iframeUriFor } = await import('../src/services/trickplay/iframes');
  ok('renditions beside the master get distinct I-frame playlists', iframeUriFor('stream_0.m3u8') === 'stream_0.iframes.m3u8' && iframeUriFor('stream_1.m3u8') === 'stream_1.iframes.m3u8');
  const stitched = rewriteMaster(withI, 'https://cdn.example/clips/vod/x/master.m3u8', () => 'https://api.example/s/1.m3u8');
  ok('a stitched (ad) master leaves the I-frame streams out', !/I-FRAME/.test(stitched));

  console.log('\n== off by default ==');
  const iframeLines = async (id: string) => (await (await get(`/clips/vod/${id}/master.m3u8`)).text()).split('\n').filter((l) => l.startsWith('#EXT-X-I-FRAME-STREAM-INF'));
  ok('a new profile has trick-play off', (await one<any>(`SELECT trick_play FROM output_profiles WHERE id = $1`, [P]))?.trick_play === false);
  ok('the clip\'s master lists no I-frame streams', (await iframeLines(CLIP)).length === 0);
  ok('its I-frame playlist answers 404', (await get(`/clips/vod/${CLIP}/v720/index.iframes.m3u8`)).status === 404);
  const offBuild = await store.buildAssetTrickPlay(CLIP);
  ok('a build with the switch off makes nothing', offBuild.state === 'off');
  ok('nothing is written', Number((await one<any>(`SELECT count(*)::int AS n FROM vod_iframe_playlists WHERE vod_asset_id = ANY($1::uuid[])`, [[CLIP, UPL, LONE]]))?.n) === 0);
  ok('no build is queued', Number((await one<any>(`SELECT count(*)::int AS n FROM jobs WHERE type = 'trickplay.build'`))?.n) === 0);

  console.log('\n== who may switch it ==');
  ok('an operator may not', (await patch(`/api/output-profiles/${P}`, { trickPlay: true }, HOP)).status === 403);
  ok('another account may not (404)', (await patch(`/api/output-profiles/${P}`, { trickPlay: true }, H2)).status === 404);
  const on = await patch(`/api/output-profiles/${P}`, { trickPlay: true });
  ok('an administrator turns it on', on.status === 200 && (await on.json()).trick_play === true);
  ok('the change is in the audit log', !!(await one<any>(`SELECT 1 FROM audit_log WHERE entity_type = 'output_profile' AND entity_id = $1`, [P])));
  invalidateAll();

  console.log('\n== switched on later: no re-encode ==');
  ok('the first master asked for is served as it was', (await iframeLines(CLIP)).length === 0);
  // queued without holding up the answer: wait for it a little (it raced once in 3.2b-9's run)
  let queuedN = 0;
  for (let i = 0; i < 40 && queuedN !== 1; i++) {
    queuedN = Number((await one<any>(`SELECT count(*)::int AS n FROM jobs WHERE type = 'trickplay.build' AND payload->>'vodAssetId' = $1`, [CLIP]))?.n);
    if (queuedN !== 1) await new Promise((r) => setTimeout(r, 50));
  }
  ok('and queues the build', queuedN === 1);
  const segBefore = readFileSync(join(process.env.CLIPS_DIR!, 'vod', CLIP, 'v720', 'seg_003.m4s'));
  const b1 = await store.buildAssetTrickPlay(CLIP);
  ok(`the build makes one per video rendition (got ${b1.renditions})`, b1.state === 'ready' && b1.renditions === 2, b1);
  ok('the media is untouched', Buffer.compare(segBefore, readFileSync(join(process.env.CLIPS_DIR!, 'vod', CLIP, 'v720', 'seg_003.m4s'))) === 0);
  invalidateAll();
  const lines = await iframeLines(CLIP);
  ok(`the master now lists two I-frame streams (got ${lines.length})`, lines.length === 2, lines);
  ok('one for 720p and one for 180p, none for the audio rendition', lines.some((l) => /URI="v720\/index.iframes.m3u8"/.test(l)) && lines.some((l) => /URI="v180\/index.iframes.m3u8"/.test(l)) && !lines.some((l) => /URI="a\//.test(l)));
  const r720 = await get(`/clips/vod/${CLIP}/v720/index.iframes.m3u8`);
  const t720 = await r720.text();
  ok('the 720p I-frame playlist is served', r720.status === 200 && /#EXT-X-I-FRAMES-ONLY/.test(t720) && (r720.headers.get('content-type') ?? '').includes('mpegurl'));
  ok('10 entries for 10 keyframes', (t720.match(/#EXT-X-BYTERANGE/g) ?? []).length === 10);
  ok('its key is carried over, before the first entry', /#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd:\/\/k1"/.test(t720) && t720.indexOf('#EXT-X-KEY') < t720.indexOf('#EXTINF'));
  ok('the 180p one has no key (it is clear)', !/#EXT-X-KEY/.test(await (await get(`/clips/vod/${CLIP}/v180/index.iframes.m3u8`)).text()));
  // Every served range: a moof at its start in the file it names, with a keyframe first.
  let rangesOk = true, n = 0;
  for (const m of t720.matchAll(/#EXT-X-BYTERANGE:(\d+)@(\d+)\n(\S+)/g)) {
    const b = readFileSync(join(process.env.CLIPS_DIR!, 'vod', CLIP, 'v720', m[3]));
    const off = Number(m[2]), len = Number(m[1]);
    const ks = keyframeRanges(b, init);
    if (b.toString('latin1', off + 4, off + 8) !== 'moof' || !ks.some((k) => k.start === off && k.end === off + len)) rangesOk = false;
    n++;
  }
  ok(`every served entry (${n}) is a moof plus exactly a keyframe in its segment`, rangesOk && n === 10);
  ok('a path that is not a rendition answers 404', (await get(`/clips/vod/${CLIP}/a/index.iframes.m3u8`)).status === 404);

  console.log('\n== which switch applies ==');
  ok('the upload follows the profile its ladder mirrors (off)', !(await store.trickPlayOn(UPL)));
  await query(`UPDATE output_profiles SET trick_play = true WHERE id = $1`, [P2]);
  ok('turned on there, the upload has it', await store.trickPlayOn(UPL));
  ok('an upload with no ladder follows the account default (off)', !(await store.trickPlayOn(LONE)));
  ok('the account default changes it', (await patch('/api/account-settings', { trickPlayDefault: true })).status === 200 && await store.trickPlayOn(LONE));
  const np = await fetch(base + '/api/output-profiles', { method: 'POST', headers: H, body: JSON.stringify({ name: 'New', rungs: [{ height: 360, bitrate_kbps: 800 }] }) });
  ok('a new profile starts with the account default (on)', np.status === 201 && (await np.json()).trick_play === true);
  ok('account settings report the default', (await (await fetch(base + '/api/account-settings', { headers: H })).json()).trickPlayDefault === true);

  console.log('\n== switched off again ==');
  ok('turned off', (await patch(`/api/output-profiles/${P}`, { trickPlay: false })).status === 200);
  invalidateAll();
  ok('the master lists no I-frame streams', (await iframeLines(CLIP)).length === 0);
  ok('the I-frame playlist answers 404', (await get(`/clips/vod/${CLIP}/v720/index.iframes.m3u8`)).status === 404);
  ok('what was made is kept for turning it on again', Number((await one<any>(`SELECT count(*)::int AS n FROM vod_iframe_playlists WHERE vod_asset_id = $1`, [CLIP]))?.n) === 2);
  await patch(`/api/output-profiles/${P}`, { trickPlay: true });
  invalidateAll();
  ok('on again: listed at once, no build needed', (await iframeLines(CLIP)).length === 2);

  console.log('\n== a re-encode ==');
  await query(`UPDATE vod_assets SET master_key = $2 WHERE id = $1`, [CLIP, `/clips/vod/${CLIP}/master.m3u8?v=2`.replace('?v=2', '')]);
  await query(`UPDATE vod_iframe_playlists SET source = 'old' WHERE vod_asset_id = $1`, [CLIP]);
  invalidateAll();
  ok('playlists of an older build are not listed', (await iframeLines(CLIP)).length === 0);
  ok('and are not served', (await get(`/clips/vod/${CLIP}/v720/index.iframes.m3u8`)).status === 404);

  srv.close();
  await query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [[A, A2]]);
  await pool.end();
  console.log(`\ntrickplay: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
