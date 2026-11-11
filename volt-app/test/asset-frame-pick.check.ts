// ============================================================================
//  PICKING AND SETTING AN ASSET'S IMAGE FROM ITS FRAMES (8 Nov 2026).
//
//    - scoring (pure, frameScore.ts): a low-key frame with lit highlights is not
//      called black, a true black frame still is; a well-exposed frame beats a
//      dim one of the same sharpness; a clear lit face beats a sharp close-up of
//      hands; a face in shadow counts for less than a lit one; when a video has
//      faces its face-less frames are marked down; the kept frames are spread
//      over the video, not twelve copies of one shot;
//    - faces (frame_faces.py): runs over a batch and says so, or says why not;
//    - extraction (assetImage.ts extractFrames): more frames are read than kept,
//      twelve are kept, spread out, stored and recorded best first;
//    - "Use this frame as the image" (POST /api/vod/:id/image/from-frame): the
//      exact frame from the packaged media (frame number or time), else the
//      original file at that time; saved to the Image Library, set and locked,
//      audited; audio-only refused; another account's asset not found.
//
//  Usage: DATABASE_URL=... npx tsx test/asset-frame-pick.check.ts
// ============================================================================
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORK = mkdtempSync(join(tmpdir(), 'afp-'));
process.env.CLIPS_DIR = join(WORK, 'clips');
process.env.IMAGE_STORE_DIR = join(WORK, 'img');
process.env.VOD_SOURCE_DIR = process.env.VOD_SOURCE_DIR || join(WORK, 'src');
mkdirSync(process.env.CLIPS_DIR, { recursive: true });
let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${JSON.stringify(d)}` : '')); } };
const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

(async () => {
  const S = await import('../src/services/media/frameScore');
  console.log('== scoring (pure) ==');
  const base = { stdev: 0.18, sharpness: 400, colourfulness: 0.2, entropy: 5, columnUniformity: 0.2 };
  const lowKey = S.scoreFrame({ ...base, mean: 0.05, p98: 0.55, stdev: 0.08 });
  ok(!lowKey.rejected && lowKey.score > 0 && lowKey.notes.includes('low light'), 'a low-key frame with lit highlights is low light, not black', lowKey);
  ok(S.scoreFrame({ ...base, mean: 0.03, p98: 0.1, stdev: 0.02 }).rejected === 'black', 'a frame with no highlights is still black');
  const lit = S.scoreFrame({ ...base, mean: 0.42, p98: 0.9 }), dim = S.scoreFrame({ ...base, mean: 0.2, p98: 0.6 });
  ok(lit.score > dim.score, `well exposed beats dim (${lit.score} > ${dim.score})`);
  const hands = S.scoreFrame({ ...base, mean: 0.4, p98: 0.9, sharpness: 1500, stdev: 0.25 });
  const face = S.scoreFrame({ ...base, mean: 0.3, p98: 0.8, sharpness: 250, faces: { count: 1, largest: 0.03, score: 0.9, luma: 0.4 } });
  ok(face.score > hands.score && face.notes.includes('a face'), `a clear face beats a crisp close-up of hands (${face.score} > ${hands.score})`);
  const shadow = S.scoreFrame({ ...base, mean: 0.3, p98: 0.8, sharpness: 250, faces: { count: 1, largest: 0.03, score: 0.9, luma: 0.06 } });
  ok(shadow.score < face.score && shadow.notes.includes('face in shadow'), `a face in shadow counts for less (${shadow.score} < ${face.score})`);
  const small = S.scoreFrame({ ...base, mean: 0.3, p98: 0.8, sharpness: 250, faces: { count: 1, largest: 0.002, score: 0.9, luma: 0.4 } });
  ok(small.score < face.score, 'a tiny face counts for less than a good-sized one');
  const darkFace = S.scoreFrame({ ...base, mean: 0.04, p98: 0.2, stdev: 0.03, faces: { count: 1, largest: 0.02, score: 0.8, luma: 0.2 } });
  ok(!darkFace.rejected, 'a dark frame with a face in it is never thrown away as black');
  const pref = S.preferFaces([{ score: 60, faces: { count: 0, largest: 0, score: 0, luma: 0 } }, { score: 50, faces: { count: 1, largest: 0.02, score: 0.9, luma: 0.4 } }]);
  ok(pref[0].score === 45 && pref[0].notes?.includes('no face') && pref[1].score === 50, 'a video with faces marks down its face-less frames', pref);
  ok(S.preferFaces([{ score: 60, faces: { count: 0, largest: 0, score: 0, luma: 0 } }])[0].score === 60, 'a video with no faces is scored as before');
  ok(S.preferFaces([{ score: 60 }, { score: 50, faces: { count: 1, largest: 0.02, score: 0.9, luma: 0.4 } }] as any)[0].score === 60, 'no detector result: not marked down');
  const many = Array.from({ length: 30 }, (_, i) => ({ atMs: i * 1000, score: i < 10 ? 90 - i : 50 - i }));
  const kept = S.keepBestSpread(many, 6, 5000);
  const ats = kept.map((k) => k.atMs!).sort((a, b) => a - b);
  ok(kept.length === 6 && ats.every((t, i) => i === 0 || t - ats[i - 1] >= 5000), 'kept frames are spread out, not one shot six times', ats);
  ok(kept[0].atMs === 0 && kept[0].score === 90, 'the best frame is kept first');

  console.log('\n== faces (frame_faces.py) ==');
  const { detectFaces } = await import('../src/services/media/frameFaces');
  const plain = join(WORK, 'plain.jpg');
  ff(['-f', 'lavfi', '-i', 'testsrc=size=320x180:duration=1', '-frames:v', '1', plain]);
  const fr = await detectFaces([readFileSync(plain), readFileSync(plain)]);
  let cv = false; try { execFileSync(process.env.PYTHON_BIN || 'python3', ['-c', 'import cv2; cv2.FaceDetectorYN']); cv = true; } catch { /* no OpenCV here */ }
  if (cv) ok(Array.isArray(fr) && fr.length === 2 && fr.every((f) => f && f.count === 0), 'with OpenCV: a batch of two, no faces in a test card', fr);
  else ok(fr === null, 'without OpenCV: no face data, frames scored as before');

  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { imageStore } = await import('../src/services/imageStore');
  const AI = await import('../src/services/media/assetImage');
  const tag = Date.now().toString(36);
  const mk = async (n: string) => {
    const a = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`${n}-${tag}`]))!.id;
    const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `${n}-${tag}@volt.test`]))!.id;
    return { a, tok: signAccess({ sub: u, account_id: a, role: 'owner' } as any) };
  };
  const me = await mk('afp'), them = await mk('afp-o');

  console.log('\n== extraction ==');
  const SRC = join(WORK, 'source.mp4');
  ff(['-f', 'lavfi', '-i', "nullsrc=size=640x360:rate=25:duration=40,geq=lum='mod(2*X+41*N,256)':cb='mod(Y+3*N,256)':cr=128",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-b:v', '1500k', SRC]);
  const up = (await one<any>(`INSERT INTO vod_assets(account_id, source_kind, kind, title, source_key, start_epoch_ms, end_epoch_ms, duration_ms) VALUES ($1,'upload','clip','Frames',$2,0,40000,40000) RETURNING id`, [me.a, SRC]))!.id;
  const c = await AI.extractFrames(up, me.a, SRC, 40000);
  const times = c.map((x) => x.atMs!).sort((a, b) => a - b);
  ok(c.length === 12, 'twelve frames kept', c.length);
  ok(times.every((t, i) => i === 0 || t - times[i - 1] >= 1000), 'spread over the video', times);
  ok(c.every((x, i) => i === 0 || (x.score ?? 0) <= (c[i - 1].score ?? 0)), 'recorded best first');
  ok((await Promise.all(c.map((x) => imageStore().exists(x.key)))).every(Boolean), 'each kept frame is stored');
  const rec = await one<any>(`SELECT poster_candidates FROM vod_assets WHERE id = $1`, [up]);
  ok(rec.poster_candidates.length === 12, 'and recorded on the asset');

  console.log('\n== use this frame as the image ==');
  const srv = createServer().listen(0);
  const baseUrl = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = async (path: string, body: any, tok = me.tok) => {
    const r = await fetch(baseUrl + path, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { s: r.status, j: await r.json().catch(() => null) as any };
  };
  // Packaged media: the exact frame through the frame index.
  const id = '00000000-0000-0000-0000-00000a1f0001'.replace('0001', String(Date.now() % 10000).padStart(4, '0'));
  const dir = join(process.env.CLIPS_DIR!, 'vod', id);
  mkdirSync(join(dir, 'v720'), { recursive: true });
  ff(['-i', SRC, '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', join(dir, 'v720', 'seg_%03d.m4s'), join(dir, 'v720', 'index.m3u8')]);
  writeFileSync(join(dir, 'master.m3u8'), ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1600000,RESOLUTION=640x360', 'v720/index.m3u8', ''].join('\n'));
  await query(`INSERT INTO vod_assets(id, account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms) VALUES ($1,$2,'upload','clip','Packaged clip',$3,0,40000,40000)`, [id, me.a, `/clips/vod/${id}/master.m3u8`]);
  let r = await call(`/api/vod/${id}/image/from-frame`, { frame: 251 });
  let a = await one<any>(`SELECT poster_key, poster_source, poster_locked, poster_reason FROM vod_assets WHERE id = $1`, [id]);
  ok(r.s === 200 && r.j.frame === 251 && /^00:00:10:01/.test(r.j.timecode ?? ''), 'the exact frame asked for, with its timecode', r.j && { frame: r.j.frame, tc: r.j.timecode, err: r.j.error });
  ok(a.poster_key?.startsWith(`library/${me.a}/`) && a.poster_source === 'manual' && a.poster_locked === true && /chosen in the preview by/.test(a.poster_reason), 'set as the image, from the library, locked, saying why', a);
  ok(!!(await one<any>(`SELECT 1 FROM media_files WHERE account_id = $1 AND store_key = $2`, [me.a, a.poster_key])), 'the still is in the Image Library');
  r = await call(`/api/vod/${id}/image/from-frame`, { ms: 20000 });
  ok(r.s === 200 && r.j.frame === 500, 'by time: the frame at 20 s (frame 500 at 25 fps)', r.j?.frame);
  ok(!!(await one<any>(`SELECT 1 FROM audit_log WHERE entity_id = $1 AND detail::text LIKE '%preview frame%'`, [id]).catch(() => null)), 'the change is in the audit log');
  // No packaged media yet: the original file at that time.
  r = await call(`/api/vod/${up}/image/from-frame`, { ms: 5000 });
  a = await one<any>(`SELECT poster_key, poster_reason FROM vod_assets WHERE id = $1`, [up]);
  ok(r.s === 200 && r.j.frame === null && /Frame at 00:05/.test(a.poster_reason), 'no packaged media: read from the original at that time', { s: r.s, j: r.j?.error, reason: a.poster_reason });
  r = await call(`/api/vod/${id}/image/from-frame`, {});
  ok(r.s === 400 || r.s === 422, 'a frame or a time is required', r.s);
  r = await call(`/api/vod/${id}/image/from-frame`, { frame: 10 }, them.tok);
  ok(r.s === 404, "another account's asset is not found", r.s);
  const aud = (await one<any>(`INSERT INTO vod_assets(account_id, source_kind, kind, title, export_mp3_key, start_epoch_ms, end_epoch_ms, duration_ms) VALUES ($1,'upload','clip','Song','/x.mp3',0,1000,1000) RETURNING id`, [me.a]))!.id;
  r = await call(`/api/vod/${aud}/image/from-frame`, { ms: 0 });
  ok(r.s === 422 && /audio only/.test(r.j?.error ?? ''), 'an audio-only asset is refused', r);

  srv.close();
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
