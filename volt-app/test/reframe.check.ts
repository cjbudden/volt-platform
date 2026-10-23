// ============================================================================
//  REFRAME (volt/REFRAME.md): social formats made by following the picture.
//
//  1. Settings: defaults, a patch, a bad patch refused.
//  2. Framing (pure): crop sizes; a still subject holds, a moving one pans with
//     editable keyframes, two people too far apart take the fallback, an empty
//     shot is framed on the centre; never a slide across a cut; the safe area;
//     an operator's choice for one shot; re-planning one shot keeps the others;
//     sampling; cleaning an operator's keys.
//  3. Render (real ffmpeg): pixels read back where the path says the crop is:
//     held, glided, the whole picture on the blurred fill, mixed in one clip.
//  4. API against Postgres, the job worker and the real analysis script:
//     analyse, formats planned, tracks, choose who a shot follows, move a key,
//     re-analysis keeps an edited format, reset, approve, settings (and who may
//     change them), auto-approval, render to a file, stale after an edit,
//     tenancy, a sound-only asset, and the file a social platform receives.
//
//  Usage: DATABASE_URL=... npx tsx test/reframe.check.ts   (a migrated, disposable database)
//  Needs ffmpeg with libx264, python3 with numpy and OpenCV for the analysis.
// ============================================================================
let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d: unknown = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d !== '' ? ' -- ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); } };

(async () => {
  const { mkdtempSync, mkdirSync, existsSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  process.env.CLIPS_DIR ??= mkdtempSync(`${tmpdir()}/reframe-clips-`);
  process.env.ORIGIN_DIR ??= mkdtempSync(`${tmpdir()}/reframe-origin-`);
  process.env.ENCODER_BIN ??= join(process.cwd(), '..', 'volt-encoder', 'bin');
  const CLIPS = process.env.CLIPS_DIR!;
  const W = mkdtempSync(`${tmpdir()}/reframe-src-`);
  const ff = (args: string[]) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args]); if (r.status !== 0) throw new Error(String(r.stderr)); };
  /** One pixel (R,G,B) of a video at time t (to RGB before the crop: a 1×1 crop of 4:2:0 is refused). */
  const px = (file: string, t: number, x: number, y: number): number[] => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    return [...(r.stdout as Buffer)];
  };
  const dims = (file: string) => { const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]); return String(r.stdout).trim(); };

  const F = await import('../src/services/reframe/formats');
  const P = await import('../src/services/reframe/framing');
  const R = await import('../src/services/reframe/render');

  // ------------------------------------------------------------------ 1. settings
  console.log('== settings ==');
  const d = F.resolveSettings({});
  ok(d.formats['9x16'] && d.formats['1x1'] && d.formats['4x5'] && d.movement === 'steady' && d.fallback === 'fill' && d.requireApproval, 'defaults: all three formats, steady, blurred fill, approval required');
  ok(d.renderOnPublish === false, 'publishing a format is off until an admin turns it on (an account that never looked publishes as before)');
  ok(d.targets.tiktok === '9x16' && d.targets.youtube === '16x9' && d.targets.facebook === '1x1', 'defaults: TikTok gets 9:16, YouTube the 16:9, Facebook 1:1');
  const p1 = F.applyPatch(d, F.settingsPatch.parse({ movement: 'locked', formats: { '4x5': false }, targets: { x: '9x16' } }));
  ok(p1.movement === 'locked' && !p1.formats['4x5'] && p1.formats['9x16'] && p1.targets.x === '9x16' && p1.targets.tiktok === '9x16', 'a patch changes only what it names');
  ok(!F.settingsPatch.safeParse({ priority: ['faces', 'faces'] }).success, 'a priority list with a repeat is refused');
  ok(!F.settingsPatch.safeParse({ targets: { myspace: '9x16' } }).success, 'an unknown platform is refused');
  ok(F.resolveSettings({ movement: 'wild', priority: ['ghosts'], autoApproveAbove: 7 }).movement === 'steady', 'stored junk falls back to the defaults');

  // ------------------------------------------------------------------ 2. framing
  console.log('== framing (pure) ==');
  const c916 = P.cropSize('9x16', 1920, 1080), c11 = P.cropSize('1x1', 1920, 1080), c45 = P.cropSize('4x5', 1920, 1080);
  ok(Math.abs(c916.w - 0.3164) < 1e-3 && c916.h === 1 && Math.abs(c11.w - 0.5625) < 1e-3 && Math.abs(c45.w - 0.45) < 1e-3, 'crop sizes from 16:9: full height, 31.6%, 56.3% and 45% of the width', [c916, c11, c45]);
  ok(P.cropSize('1x1', 1080, 1920).w === 1 && P.cropSize('1x1', 1080, 1920).h < 1, 'from a vertical source the crop is full width and moves up and down');

  const fps = 5;
  const samples = (t0: number, t1: number, f: (t: number) => [number, number, number, number]) => {
    const out: any[] = []; for (let t = t0; t < t1 - 1e-6; t += 1 / fps) { const [x, y, w, h] = f(t); out.push([Math.round(t * 1000) / 1000, x, y, w, h, 0.9]); } return out;
  };
  const store: any = {
    source: { width: 1920, height: 1080, fps: 25, durationSec: 40 },
    analysis: { sampleFps: fps },
    shots: [{ index: 0, start: 0, end: 10 }, { index: 1, start: 10, end: 20 }, { index: 2, start: 20, end: 30 }, { index: 3, start: 30, end: 40 }],
    subjects: [
      { id: 'f1', kind: 'face', label: 'Face 1', onScreenSec: 30, meanArea: 0.02, shots: [0, 1, 2] },
      { id: 'f2', kind: 'face', label: 'Face 2', onScreenSec: 10, meanArea: 0.02, shots: [2] },
    ],
    tracks: [
      { id: 't1', subject: 'f1', kind: 'face', shot: 0, start: 0, end: 9.8, samples: samples(0, 10, (t) => [0.30 + 0.002 * t, 0.25, 0.08, 0.14]) },
      { id: 't2', subject: 'f1', kind: 'face', shot: 1, start: 10, end: 19.8, samples: samples(10, 20, (t) => [0.05 + 0.08 * (t - 10), 0.25, 0.08, 0.14]) },
      { id: 't3', subject: 'f1', kind: 'face', shot: 2, start: 20, end: 29.8, samples: samples(20, 30, () => [0.08, 0.3, 0.08, 0.14]) },
      { id: 't4', subject: 'f2', kind: 'face', shot: 2, start: 20, end: 29.8, samples: samples(20, 30, () => [0.82, 0.3, 0.08, 0.14]) },
    ],
  };
  const S = (o: Partial<typeof d> = {}) => ({ ...d, ...o });
  const path = P.planPath({ store, format: '9x16', settings: S() });
  const ofShot = (p: any, i: number) => p.keys.filter((k: any) => k.shot === i);
  ok(ofShot(path, 0).length === 1 && ofShot(path, 0)[0].ease === 'hold', 'steady: a subject that barely moves gets one framing for the shot', ofShot(path, 0));
  const k1 = ofShot(path, 1);
  ok(k1.length >= 3 && k1.every((k: any, i: number) => i === 0 || k.cx >= k1[i - 1].cx - 1e-6), 'a subject crossing the frame gets a pan of a few keyframes, left to right', k1.map((k: any) => [k.t, k.cx]));
  ok(k1.length <= 12, 'and few enough for a person to edit', k1.length);
  ok(path.shots[2].mode === 'fill' && path.shots[2].confidence < 0.75 && path.needsReview.includes(2), 'two people too far apart for 9:16: whole picture on the blurred fill, flagged for review', path.shots[2]);
  ok(path.shots[3].follow === 'centre' && ofShot(path, 3)[0].cx === 0.5, 'a shot with nobody in it is framed on the centre', path.shots[3]);
  ok(store.shots.every((s: any) => { const k = ofShot(path, s.index); return k[0].t === s.start && k[0].cut && k[k.length - 1].ease === 'hold'; }), 'every shot starts with its own cut keyframe and its last keyframe holds (no slide across a cut)');
  ok(path.keys.every((k: any) => k.cx >= k.w / 2 - 1e-6 && k.cx <= 1 - k.w / 2 + 1e-6), 'the crop never leaves the picture');
  const sq = P.planPath({ store, format: '1x1', settings: S() });
  ok(sq.shots[2].mode === 'fill', '1:1 is wider but these two still do not fit', sq.shots[2]);
  const follow = P.planPath({ store, format: '9x16', settings: S({ fallback: 'follow' }) });
  ok(follow.shots[2].mode === 'crop' && follow.shots[2].fits === false && follow.shots[2].follow === 'f1', 'fallback "follow": the main face is followed and the shot says it does not fit everyone', follow.shots[2]);
  const locked = P.planPath({ store, format: '9x16', settings: S({ movement: 'locked' }) });
  ok(ofShot(locked, 1).length === 1, 'locked: one framing per shot, even for a moving subject');
  const noSafe = P.planPath({ store, format: '9x16', settings: S({ safeArea: false }) });
  ok(ofShot(path, 0)[0].cx > ofShot(noSafe, 0)[0].cx, 'the 9:16 safe area puts the subject left of the platform buttons', [ofShot(path, 0)[0].cx, ofShot(noSafe, 0)[0].cx]);
  const ov = P.planPath({ store, format: '9x16', settings: S(), overrides: { '2': { follow: 'f2' } } });
  ok(ov.shots[2].follow === 'f2' && ov.shots[2].chosenBy === 'operator' && ofShot(ov, 2)[0].cx > 0.7 && ov.shots[2].confidence === 1, 'an operator picks who shot 3 follows', [ov.shots[2], ofShot(ov, 2)[0]]);
  const edited = P.withKeys(path, path.keys.map((k: any) => (k.shot === 0 ? { ...k, cx: 0.6 } : k)));
  const re = P.replanShots(edited, { store, format: '9x16', settings: S(), overrides: { '2': { follow: 'f2' } } }, [2]);
  ok(ofShot(re, 0)[0].cx === 0.6 && ofShot(re, 2)[0].cx > 0.7, 're-planning one shot keeps a person\'s edit in another', [ofShot(re, 0)[0].cx]);
  const ks = [{ t: 0, cx: 0.3, cy: 0.5, w: 0.3, h: 1, ease: 'glide', mode: 'crop', shot: 0 }, { t: 2, cx: 0.7, cy: 0.5, w: 0.3, h: 1, ease: 'hold', mode: 'crop', shot: 0 }] as any;
  ok(Math.abs(P.sampleAt(ks, 1).cx - 0.5) < 1e-9 && P.sampleAt(ks, 0.5).cx < 0.4 && P.sampleAt(ks, 5).cx === 0.7 && P.sampleAt(ks, -1).cx === 0.3, 'sampling: eased between keys, held after the last and before the first');
  const cl = P.cleanKeys([{ t: 25, cx: 0.99 }, { t: 3, cx: 0.4, ease: 'linear' }, { t: 3, cx: 0.45 }, { t: 12, cx: 0.5 }], path, store.shots, 40);
  ok(cl.map((k) => k.t).join() === '3,12,25' && cl[0].cx === 0.45, 'operator keys: sorted, one per instant (the later wins)', cl);
  ok(cl[2].cx <= 1 - cl[2].w / 2 && cl[1].shot === 1 && cl[0].ease === 'hold', 'clamped to the picture, given their shot, and held before a cut', cl);
  let threw = 0; try { P.cleanKeys([{ t: 'x', cx: 1 }], path, store.shots, 40); } catch (e: any) { threw = e.status; }
  ok(threw === 400, 'a keyframe that is not numbers is a 400');

  // ------------------------------------------------------------------ 3. render
  console.log('== render (ffmpeg) ==');
  const grad = join(W, 'grad.mp4');
  ff(['-f', 'lavfi', '-i', 'color=s=640x360:d=4:r=25', '-vf', "geq=r='X/W*255':g='128':b='128'", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', grad]);
  const run = async (fmt: any, keys: any[], name: string) => {
    const cmd = R.buildRenderArgs({ input: grad, output: join(W, name), format: fmt, keys, srcW: 640, srcH: 360, duration: 4, preset: 'ultrafast' });
    const r = await R.runRender(cmd, 4, () => {});
    return { r, cmd, file: join(W, name) };
  };
  const w9 = P.cropSize('9x16', 640, 360).w;
  const held = await run('9x16', [{ t: 0, cx: 0.3, cy: 0.5, w: w9, h: 1, ease: 'hold', mode: 'crop', shot: 0, cut: true }, { t: 2, cx: 0.7, cy: 0.5, w: w9, h: 1, ease: 'hold', mode: 'crop', shot: 1, cut: true }], 'held.mp4');
  ok(held.r.ok && dims(held.file) === '1080,1920', '9:16 renders at 1080×1920', held.r.error ?? dims(held.file));
  const a1 = px(held.file, 1, 540, 960)[0], a2 = px(held.file, 3, 540, 960)[0];
  ok(Math.abs(a1 - 0.3 * 255) < 14 && Math.abs(a2 - 0.7 * 255) < 14, 'the crop is where the path says: centred at 30% before the cut, 70% after', [a1, a2]);
  const glided = await run('9x16', [{ t: 0, cx: 0.3, cy: 0.5, w: w9, h: 1, ease: 'glide', mode: 'crop', shot: 0 }, { t: 4, cx: 0.7, cy: 0.5, w: w9, h: 1, ease: 'hold', mode: 'crop', shot: 0 }], 'glide.mp4');
  const g1 = px(glided.file, 2, 540, 960)[0], g0 = px(glided.file, 0.6, 540, 960)[0];
  ok(glided.r.ok && Math.abs(g1 - 0.5 * 255) < 14, 'a glide is halfway at the midpoint', g1);
  ok(g0 < 0.34 * 255, 'and eased: still near the start early on (smoothstep, not linear)', g0);
  const filled = await run('4x5', [{ t: 0, cx: 0.5, cy: 0.5, w: 0.45, h: 1, ease: 'hold', mode: 'fill', shot: 0, cut: true }], 'fill.mp4');
  const left = px(filled.file, 1, 4, 675)[0], right = px(filled.file, 1, 1075, 675)[0];
  ok(filled.r.ok && dims(filled.file) === '1080,1350' && left < 40 && right > 215, 'fill: the whole picture across the 4:5 frame, left edge to right edge', [dims(filled.file), left, right]);
  ok(!filled.cmd.graph.includes('crop=w='), 'a clip that is all fill is not cropped at all');
  const mixed = await run('9x16', [{ t: 0, cx: 0.3, cy: 0.5, w: w9, h: 1, ease: 'hold', mode: 'crop', shot: 0, cut: true }, { t: 2, cx: 0.5, cy: 0.5, w: w9, h: 1, ease: 'hold', mode: 'fill', shot: 1, cut: true }], 'mixed.mp4');
  const m1 = px(mixed.file, 1, 1075, 960)[0], m2 = px(mixed.file, 3, 1075, 960)[0];
  ok(mixed.r.ok && mixed.cmd.graph.includes("enable='between(t,2"), 'crop and fill in one clip: one graph, the fill switched in by time', mixed.cmd.graph.slice(0, 120));
  ok(m1 < 0.47 * 255 && m2 > 0.9 * 255, 'cropped before the cut (right edge at 46%), whole picture after (right edge at 100%)', [m1, m2]);
  ok(R.fillSpans([{ t: 0, mode: 'fill' }, { t: 2, mode: 'fill' }, { t: 3, mode: 'crop' }] as any, 4).length === 1, 'adjacent fill spans join');

  // ------------------------------------------------------------------ 4. API
  console.log('== API ==');
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const H = await import('../src/services/jobs/handlers/reframe');
  const { startWorker } = await import('../src/services/jobs/worker');
  H.registerReframeHandlers();
  const worker = startWorker({ concurrency: 2, pollMs: 150 });

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`rf-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`rf-o-${tag}`]))!.id;
  const owner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `rf-${tag}@volt.test`]))!.id;
  const viewer = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','viewer','active') RETURNING id`, [acct, `rf-v-${tag}@volt.test`]))!.id;
  const otherUser = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [other, `rf-o-${tag}@volt.test`]))!.id;
  const g = (await one<any>(`INSERT INTO groups(account_id, name) VALUES ($1,'G') RETURNING id`, [acct]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'Harbour TV') RETURNING id`, [g]))!.id;

  // the source: a face panned across the frame when a face picture is to hand, then a cut to a test card
  const face = process.env.REFRAME_FACE_IMAGE || (existsSync('/tmp/rf/lena.jpg') ? '/tmp/rf/lena.jpg' : '');
  const mkAsset = async (o: { audio?: boolean } = {}) => {
    const id = (await one<any>(`INSERT INTO vod_assets(channel_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms)
      VALUES ($1,'recording','clip','Interview',NULL,0,8000,8000) RETURNING id`, [ch]))!.id;
    const dir = join(CLIPS, 'vod', id); mkdirSync(dir, { recursive: true });
    if (o.audio) {
      ff(['-f', 'lavfi', '-i', 'sine=d=2', join(dir, 'a.mp3')]);
      await query(`UPDATE vod_assets SET export_mp3_key=$2, top_height=NULL WHERE id=$1`, [id, `/clips/vod/${id}/a.mp3`]);
      return id;
    }
    const a = join(W, `a-${id}.mp4`), b = join(W, `b-${id}.mp4`);
    if (face) ff(['-f', 'lavfi', '-i', 'color=c=0x203040:s=1280x720:d=5:r=25', '-loop', '1', '-i', face, '-filter_complex', "[1]scale=260:260[f];[0][f]overlay=x='80+t*180':y=180:shortest=1,format=yuv420p", '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast', a]);
    else ff(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=25:d=5', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', a]);
    ff(['-f', 'lavfi', '-i', 'color=c=0x805020:s=1280x720:r=25:d=3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', b]);
    writeFileSync(join(W, `l-${id}.txt`), `file '${a}'\nfile '${b}'\n`);
    ff(['-f', 'concat', '-safe', '0', '-i', join(W, `l-${id}.txt`), '-c', 'copy', join(dir, 'clip.mp4')]);
    await query(`UPDATE vod_assets SET progressive_key=$2, top_height=720 WHERE id=$1`, [id, `/clips/vod/${id}/clip.mp4`]);
    return id;
  };
  const A = await mkAsset();
  const AUD = await mkAsset({ audio: true });

  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = signAccess({ sub: owner, account_id: acct, role: 'owner' } as any);
  const tokViewer = signAccess({ sub: viewer, account_id: acct, role: 'viewer' } as any);
  const tokOther = signAccess({ sub: otherUser, account_id: other, role: 'owner' } as any);
  const api = async (method: string, path: string, body?: any, token = tok) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j: any = null; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
    return { status: r.status, j };
  };
  const until = async (fn: () => Promise<boolean>, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };

  try {
    let v = await api('GET', `/api/vod/${A}/reframe`);
    ok(v.status === 200 && v.j.analysis.state === 'none' && v.j.formats.length === 3 && v.j.formats.every((f: any) => f.path === null), 'before analysis: no formats framed yet', v.j?.analysis);
    ok(v.j.media.file === `/clips/vod/${A}/clip.mp4`, 'the console is told what to play');

    const q = await api('POST', `/api/vod/${A}/reframe/analyse`);
    ok(q.status === 202 && q.j.jobId, 'analyse is queued as a job', q.j);
    const done = await until(async () => (await api('GET', `/api/vod/${A}/reframe`)).j.analysis.state === 'ready');
    v = await api('GET', `/api/vod/${A}/reframe`);
    ok(done && v.j.analysis.summary.shots.length === 2, 'the job ran the real analysis: two shots found', v.j.analysis);
    if (face) ok(v.j.analysis.summary.subjects.some((s: any) => s.label === 'Face 1'), 'and the face', v.j.analysis.summary.subjects);
    ok(v.j.formats.every((f: any) => f.path?.keys?.length && f.review === 'pending' && !f.edited), 'all three formats planned, waiting for approval', v.j.formats.map((f: any) => [f.format, f.review]));
    ok(existsSync(join(CLIPS, 'vod', A, 'reframe', 'tracks.json')), 'the track store is a sidecar beside the asset');
    const tr = await api('GET', `/api/vod/${A}/reframe/tracks`);
    ok(tr.status === 200 && tr.j.kind === 'volt.tracks' && Array.isArray(tr.j.tracks), 'GET tracks returns the full store');
    if (face) {
      const p = v.j.formats[0].path;
      const k0 = p.keys.filter((k: any) => k.shot === 0);
      ok(k0.length >= 2 && k0[k0.length - 1].cx > k0[0].cx, '9:16 pans with the face across shot 1', k0.map((k: any) => k.cx));
    }

    const put = await api('PUT', `/api/vod/${A}/reframe/formats/9x16`, { overrides: { '1': { follow: 'centre' } } });
    ok(put.status === 200 && put.j.path.shots[1].follow === 'centre' && put.j.overrides['1'].follow === 'centre', 'choose who a shot follows: shot 2 on the centre', put.j?.path?.shots?.[1]);
    const keys = put.j.path.keys.map((k: any) => (k.shot === 1 ? { ...k, cx: 0.35 } : k));
    const put2 = await api('PUT', `/api/vod/${A}/reframe/formats/9x16`, { keys });
    ok(put2.status === 200 && put2.j.edited === true && put2.j.path.keys.find((k: any) => k.shot === 1).cx === 0.35, 'move a keyframe: saved, and the format is marked as edited');
    const bad = await api('PUT', `/api/vod/${A}/reframe/formats/9x16`, { keys: [{ t: 'soon', cx: 0.4 }] });
    ok(bad.status === 400, 'a malformed keyframe is a 400', bad);
    ok((await api('PUT', `/api/vod/${A}/reframe/formats/16x9`, { keys })).status === 400, 'an unknown format is a 400');

    // re-analysis keeps the edited format, replans the others
    const before11 = JSON.stringify((await api('GET', `/api/vod/${A}/reframe`)).j.formats[1].path);
    await api('POST', `/api/vod/${A}/reframe/analyse`);
    await new Promise((r) => setTimeout(r, 300));
    await until(async () => { const x = await api('GET', `/api/vod/${A}/reframe`); return x.j.analysis.state === 'ready' && !x.j.analysis.progress; });
    v = await api('GET', `/api/vod/${A}/reframe`);
    ok(v.j.formats[0].edited && v.j.formats[0].path.keys.find((k: any) => k.shot === 1).cx === 0.35, 're-analysis keeps a person\'s edit');
    ok(JSON.stringify(v.j.formats[1].path) === before11, 'and an untouched format comes out the same');

    const rs = await api('POST', `/api/vod/${A}/reframe/formats/9x16/reset`);
    ok(rs.status === 200 && rs.j.edited === false && Object.keys(rs.j.overrides).length === 0, 'reset: back to Volt\'s framing');

    const ap = await api('POST', `/api/vod/${A}/reframe/formats/9x16/approve`);
    ok(ap.status === 200 && ap.j.review === 'approved' && ap.j.approvedBy, 'approve: who and when are kept', ap.j);

    // render
    const rq = await api('POST', `/api/vod/${A}/reframe/render`, { formats: ['9x16'] });
    ok(rq.status === 202 && rq.j.queued['9x16'], 'render is queued');
    await until(async () => (await api('GET', `/api/vod/${A}/reframe`)).j.formats[0].render.state === 'ready', 90000);
    v = await api('GET', `/api/vod/${A}/reframe`);
    const r9 = v.j.formats[0].render;
    ok(r9.state === 'ready' && r9.key === `/clips/vod/${A}/reframe/9x16.mp4` && r9.width === 1080 && r9.height === 1920 && r9.bytes > 1000, 'rendered to a 1080×1920 file beside the asset', r9);
    ok(dims(join(CLIPS, 'vod', A, 'reframe', '9x16.mp4')) === '1080,1920', 'and the file really is 1080×1920');
    const fetched = await fetch(base + r9.key);
    ok(fetched.status === 200, 'the console can play it from its key', fetched.status);
    const k2 = v.j.formats[0].path.keys.map((k: any, i: number) => (i === 0 ? { ...k, cx: k.cx + 0.05 } : k));
    const ed = await api('PUT', `/api/vod/${A}/reframe/formats/9x16`, { keys: k2 });
    ok(ed.j.renderState === 'stale' && ed.j.review === 'pending', 'an edit after a render: the file is stale and the approval is taken away', ed.j);

    // settings
    const sg = await api('GET', '/api/account-settings/reframe');
    ok(sg.status === 200 && sg.j.settings.requireApproval === true && sg.j.formats.length === 3 && sg.j.platforms.some((p: any) => p.key === 'tiktok') && sg.j.canEdit, 'settings: defaults, formats, platforms', sg.j?.settings);
    ok((await api('PATCH', '/api/account-settings/reframe', { movement: 'locked' }, tokViewer)).status === 403, 'a viewer cannot change the settings');
    ok((await api('PATCH', '/api/account-settings/reframe', { movement: 'sideways' })).status === 422, 'a bad value is refused with the field named');
    const sp = await api('PATCH', '/api/account-settings/reframe', { requireApproval: false, targets: { x: '9x16' } });
    ok(sp.status === 200 && sp.j.settings.requireApproval === false && sp.j.settings.targets.x === '9x16' && sp.j.updatedBy, 'an owner changes them', sp.j?.settings);
    ok((await api('GET', '/api/account-settings/reframe', undefined, tokOther)).j.settings.requireApproval === true, 'another account keeps its own');
    const auto = await api('PUT', `/api/vod/${A}/reframe/formats/1x1`, { overrides: { '0': { follow: 'centre' } } });
    ok(auto.j.review === 'approved', 'with approval not required, a change is approved as it is saved', auto.j.review);

    // tenancy and refusals
    ok((await api('GET', `/api/vod/${A}/reframe`, undefined, tokOther)).status === 404, 'another account cannot see the formats');
    ok((await api('PUT', `/api/vod/${A}/reframe/formats/9x16`, { keys: k2 }, tokOther)).status === 404, 'nor change them');
    ok((await api('POST', `/api/vod/${A}/reframe/analyse`, undefined, tokOther)).status === 404, 'nor analyse');
    ok((await api('GET', `/api/vod/${A}/reframe/tracks`, undefined, tokOther)).status === 404, 'nor read the tracks');
    const au = await api('POST', `/api/vod/${AUD}/reframe/analyse`);
    ok(au.status === 409 && /sound only/.test(au.j.error), 'a sound-only asset: nothing to frame, said plainly', au.j);
    const B = await mkAsset();
    const nb = await api('PUT', `/api/vod/${B}/reframe/formats/9x16`, { keys: [] });
    ok(nb.status === 409 && /Analyse/.test(nb.j.error), 'editing before analysis: told to analyse first', nb.j);

    // auto-queue respects the setting
    await api('PATCH', '/api/account-settings/reframe', { autoAnalyse: false });
    ok((await H.queueReframeAnalysis(B)) === null, 'auto-analysis off: a new clip is not analysed');
    await api('PATCH', '/api/account-settings/reframe', { autoAnalyse: true });
    ok(!!(await H.queueReframeAnalysis(AUD)) === false, 'and a sound-only clip never is');

    // the file a social platform receives
    const { formatMediaFor, ReframeNotReady } = await import('../src/services/reframe/publish');
    const asset = await one<any>(`SELECT * FROM vod_assets WHERE id=$1`, [A]);
    ok((await formatMediaFor(asset, 'tiktok', () => {})) === null, 'off by default: TikTok gets the asset\'s own file, as before');
    await api('PATCH', '/api/account-settings/reframe', { renderOnPublish: true });
    ok((await formatMediaFor(asset, 'youtube', () => {})) === null, 'YouTube is set to the 16:9: the asset\'s own file is used');
    const stages: string[] = [];
    const tik = await formatMediaFor(asset, 'tiktok', (_p, s) => { stages.push(s); });
    ok(!!tik && tik.endsWith('9x16.mp4') && dims(tik) === '1080,1920' && stages.some((s) => /rendering 9:16/.test(s)), 'TikTok gets the 9:16, re-rendered there because the old one was stale', [tik, stages]);
    await api('PATCH', '/api/account-settings/reframe', { requireApproval: true });
    await api('PUT', `/api/vod/${A}/reframe/formats/9x16`, { keys: k2 });
    let refused = '';
    try { await formatMediaFor(asset, 'tiktok', () => {}); } catch (e: any) { refused = e instanceof ReframeNotReady ? e.message : `wrong error: ${e?.message}`; }
    ok(/not been approved/.test(refused) && /Formats tab/.test(refused), 'not approved: the publication stops and says where to approve it', refused);
    const fresh = await one<any>(`SELECT * FROM vod_assets WHERE id=$1`, [B]);
    let none = '';
    try { await formatMediaFor(fresh, 'tiktok', () => {}); } catch (e: any) { none = e.message; }
    ok(/has none yet/.test(none) && /16:9/.test(none), 'never framed: says so, and how to send the 16:9 instead', none);
  } finally {
    await worker.stop();
    srv.close();
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
