// ============================================================================
//  ALPHA VIDEO IN THE IMAGE LIBRARY AND THE CORNER BUG, end to end: a ProRes 4444
//  upload becomes VP9-with-alpha WebM + transparent PNG + the original; the library
//  serves it with byte ranges; a graphics binding resolves to the WebM; and the
//  Corner bug template plays it in Chromium with the transparency intact.
//
//  Usage: DATABASE_URL=... npx tsx test/motion-graphics.check.ts   (a migrated, disposable database)
// ============================================================================
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(tmpdir(), `volt-motion-${Date.now().toString(36)}`);
process.env.IMAGE_STORE_DIR = join(ROOT, 'image-store');
let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };

(async () => {
  mkdirSync(ROOT, { recursive: true });
  // A 4 s ProRes 4444 bug, 320x120: the left half opaque test pattern, the right half fully transparent.
  const mov = join(ROOT, 'bug.mov');
  const mk = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x120:r=25', '-t', '4',
    '-vf', "format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,160),255,0)'", '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', mov]);
  if (mk.status !== 0) { console.log('SKIP: ffmpeg could not make ProRes 4444'); process.exit(0); }
  const flat = join(ROOT, 'flat.mp4');
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', flat]);

  const { createServer } = await import('../src/server');
  const { pool, one } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { imageUrls } = await import('../src/services/graphics/runtime');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`motion-${tag}`]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `m-${tag}@volt.test`]))!.id;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' });
  const app: any = createServer(); const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const up = async (file: string, name: string) => {
    const r = await fetch(`${base}/api/files/motion?folder=bugs&name=${encodeURIComponent(name)}`, { method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/octet-stream' }, body: new Uint8Array(readFileSync(file)) });
    return { s: r.status, j: await r.json() as any };
  };

  try {
    console.log('== upload ==');
    const t0 = Date.now();
    let r = await up(mov, 'rtm-bug.mov');
    ok(r.s === 201 && r.j.kind === 'bug' && r.j.metadata?.motion?.alpha === true, `a ProRes 4444 upload becomes an alpha video (${Date.now() - t0} ms)`, `status ${r.s} kind ${r.j.kind} motion ${JSON.stringify(r.j.metadata?.motion)}`);
    const m = r.j.metadata.motion;
    ok(r.j.path === 'bugs/rtm-bug.webm' && r.j.store_key.endsWith('bugs/rtm-bug.png') && m.video.endsWith('bugs/rtm-bug.webm') && m.source.endsWith('rtm-bug.source.mov'),
      'stored as WebM, a first-frame PNG (the thumbnail) and the original');
    ok(m.width === 320 && m.height === 120 && Math.round(m.durationSec) === 4 && m.sourcePixFmt.startsWith('yuva'), 'with what the source was');
    ok(r.j.warning === null, 'no warning for a file with transparency');

    const vid = await fetch(`${base}/${m.video}`, { headers: { range: 'bytes=0-99' } });
    ok(vid.status === 206 && vid.headers.get('content-type') === 'video/webm' && vid.headers.get('content-range')?.startsWith('bytes 0-99/'), 'the library answers byte ranges for the video');
    const whole = Buffer.from(await (await fetch(`${base}/${m.video}`)).arrayBuffer());
    const vf = join(ROOT, 'got.webm'); require('node:fs').writeFileSync(vf, whole);
    const pr = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name:stream_tags=alpha_mode', '-of', 'json', vf], { encoding: 'utf8' });
    const st = JSON.parse(pr.stdout).streams[0];
    ok(st.codec_name === 'vp9' && String(st.tags?.alpha_mode ?? st.tags?.ALPHA_MODE) === '1', 'the WebM is VP9 with alpha', JSON.stringify(st));
    const png = await (await fetch(`${base}/${r.j.store_key}`)).arrayBuffer();
    const sharp = (await import('sharp')).default;
    const meta = await sharp(Buffer.from(png)).metadata();
    const px = await sharp(Buffer.from(png)).ensureAlpha().raw().toBuffer();
    ok(meta.hasAlpha === true && px[(60 * 320 + 40) * 4 + 3] === 255 && px[(60 * 320 + 280) * 4 + 3] === 0, 'the PNG keeps the transparency (left opaque, right clear)');

    // A bug's advertising details: on upload, edited, searchable, described in schema.org.
    let rr = await fetch(`${base}/api/files/motion?folder=bugs&name=sting.mov&advertiser=Qantas&campaign=Summer%20Sale`, { method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/octet-stream' }, body: new Uint8Array(readFileSync(mov)) });
    let jj: any = await rr.json();
    ok(rr.status === 201 && jj.metadata?.ad?.advertiser === 'Qantas' && jj.metadata.ad.campaign === 'Summer Sale', 'advertiser and campaign can come with the upload');
    rr = await fetch(`${base}/api/files/${jj.id}/ad`, { method: 'PUT', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ advertiser: 'Qantas', agency: 'Mojo', campaign: 'Summer Sale', adCode: 'QFA-2026-001' }) });
    jj = await rr.json();
    ok(rr.status === 200 && jj.metadata.ad.agency === 'Mojo' && jj.jsonLd?.sponsor?.name === 'Qantas' && jj.jsonLd.producer.name === 'Mojo'
      && jj.jsonLd.isPartOf['@type'] === 'CreativeWorkSeries' && jj.jsonLd.identifier.value === 'QFA-2026-001' && jj.jsonLd['@type'] === 'VideoObject', 'details saved, with schema.org (sponsor, producer, isPartOf, identifier)', JSON.stringify(jj.jsonLd));
    rr = await fetch(`${base}/api/files?q=mojo`, { headers: { authorization: `Bearer ${tok}` } });
    const found: any = await rr.json();
    const listF = Array.isArray(found) ? found : found.items ?? found.files ?? [];
    ok(listF.some((x: any) => x.id === jj.id), 'searching the library for the agency finds it');
    rr = await fetch(`${base}/api/files?kind=bug`, { headers: { authorization: `Bearer ${tok}` } });
    const bugs: any = await rr.json(); const listB = Array.isArray(bugs) ? bugs : bugs.items ?? bugs.files ?? [];
    ok(listB.length >= 2 && listB.every((x: any) => x.kind === 'bug'), `the Bugs filter shows only bugs (${listB.length})`);

    r = await up(flat, 'flat.mp4');
    ok(r.s === 201 && r.j.metadata.motion.alpha === false && /no transparency/.test(r.j.warning ?? ''), 'a video without alpha is accepted with a warning');
    r = await up(mov, 'rtm-bug.mov');
    ok(r.s === 409, 'the same name twice is refused');
    const junk = join(ROOT, 'junk.mov'); require('node:fs').writeFileSync(junk, 'not a video');
    r = await up(junk, 'junk.mov');
    ok(r.s === 400 || r.s === 422, `a file that is not a video is refused (${r.s}: ${r.j.error})`);

    console.log('== graphics binding and the template ==');
    const row = await one<any>(`SELECT id FROM media_files WHERE account_id = $1 AND path = 'bugs/rtm-bug.webm'`, [acct]);
    const urls = await imageUrls(acct, [row.id]);
    ok(urls.get(row.id) === '/' + m.video, 'a template field bound to it receives the WebM');

    // Playwright from the app, the encoder's graphics renderer, or a global install.
    const { createRequire } = await import('node:module');
    const rq = createRequire(__filename);
    let chromium: any = null;
    for (const m of ['playwright', 'playwright-core', join(__dirname, '../../volt-encoder/gfx/node_modules/playwright-core')]) { try { chromium = rq(m).chromium; break; } catch { /* next */ } }
    if (!chromium) { console.log('SKIP the browser part: no Playwright here'); return; }
    const b = await chromium.launch();
    const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
    const errs: string[] = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto('file://' + join(__dirname, '../assets/graphics/corner-bug/index.html'));
    await p.addStyleTag({ content: 'html{background:#ff00ff!important}' });
    await p.evaluate((d) => (window as any).update(JSON.stringify(d)), { logo: base + '/' + m.video, panel: false, caption: '', height: 120, opacity: 1 });
    await p.evaluate(() => (window as any).play());
    await p.waitForTimeout(1500);
    const info = await p.evaluate(() => { const v = document.getElementById('vid') as HTMLVideoElement; return { t: v.currentTime, paused: v.paused, w: v.videoWidth, loop: v.loop, shown: getComputedStyle(v).display } });
    ok(info.w === 320 && !info.paused && info.t > 0.3 && info.loop && info.shown === 'block', 'Chromium plays it in the template, looping', JSON.stringify(info));
    const shot = await p.screenshot({ clip: { x: 1500, y: 58, width: 324, height: 120 } });
    const raw = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => { const i = (y * raw.info.width + x) * raw.info.channels; return [raw.data[i], raw.data[i + 1], raw.data[i + 2]]; };
    const right = at(300, 60), left = at(100, 60);
    ok(right[0] > 240 && right[1] < 20 && right[2] > 240, 'the transparent half shows the picture behind it (magenta)', JSON.stringify(right));
    ok(!(left[0] > 240 && left[1] < 20 && left[2] > 240), 'the opaque half shows the video', JSON.stringify(left));
    ok(await p.evaluate(() => getComputedStyle(document.getElementById('logo')!).display === 'none'), 'one field: a video in the logo field plays as video, no broken image');
    await p.evaluate(() => (window as any).stop()); await p.waitForTimeout(600);
    ok(await p.evaluate(() => (document.getElementById('vid') as HTMLVideoElement).paused), 'stop fades it out and pauses the video');
    await p.evaluate((d) => (window as any).update(JSON.stringify(d)), { loop: false });
    await p.evaluate(() => (window as any).play()); await p.waitForTimeout(5000);
    ok(await p.evaluate(() => { const v = document.getElementById('vid') as HTMLVideoElement; return v.ended && v.currentTime > 3.5 }), 'with loop off it plays once and holds the last frame');
    // A still in the same field replaces the video; clearing it shows nothing.
    await p.evaluate((d) => (window as any).update(JSON.stringify(d)), { logo: base + '/' + r.j.store_key });
    let st2 = await p.evaluate(() => ({ img: getComputedStyle(document.getElementById('logo')!).display, vid: getComputedStyle(document.getElementById('vid')!).display }));
    ok(st2.img === 'block' && st2.vid === 'none', 'a still in the same field shows as an image', JSON.stringify(st2));
    await p.evaluate(() => (window as any).update(JSON.stringify({ logo: '' })));
    st2 = await p.evaluate(() => ({ img: getComputedStyle(document.getElementById('logo')!).display, vid: getComputedStyle(document.getElementById('vid')!).display }));
    ok(st2.img === 'none' && st2.vid === 'none', 'cleared, it shows nothing', JSON.stringify(st2));
    ok(errs.length === 0, 'no page errors', errs.join('; '));
    await b.close();
  } catch (e) {
    fail++; console.log('FAIL threw', e);
  } finally {
    srv.close(); await pool.end().catch(() => {});
    rmSync(ROOT, { recursive: true, force: true });
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
