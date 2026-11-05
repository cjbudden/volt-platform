// ============================================================================
//  HYBRID SITES: IMAGES, AUDIO AND COMPANIONS FROM A SITE (build queue H2b-5).
//
//  Through the real API on a real database, with the agent's own watch code
//  scanning a real folder standing in for customer storage, and a site folder
//  made with the default rules (which a site folder now gets in full):
//    - an image goes to the Image Library, uploaded on the site tus path, the
//      original left at the site; the copy here removed once taken in;
//    - a slate goes to Loops & Fillers by its own rule;
//    - an mp3 goes to the Media Library as an audio asset: uploaded as audio,
//      its encode queued, as for any upload;
//    - a caption dropped with its video is attached to that video's asset;
//    - a caption that arrives before its video waits, is not asked for again,
//      and attaches on the pass after its video lands;
//    - a caption with no video after 24 hours goes to review: the cloud
//      decides, the agent moves the file into the review folder AT THE SITE;
//    - a caption over 25 MB is sent to review without being uploaded;
//    - an image over the folder's ceiling fails without being uploaded;
//    - bytes that changed on the way are not taken in;
//    - a copy lost on this side is asked for again and arrives again;
//    - "Add default rules" gives an older site folder (video only) the rest;
//    - another site's host cannot read the review list.
//
//  Usage: DATABASE_URL=... npx tsx test/site-watchfolder-files.check.ts
// ============================================================================
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, utimesSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };

(async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'site-files-'));
  process.env.IMAGE_STORE_DIR = process.env.IMAGE_STORE_DIR ?? join(tmp, '_images');
  process.env.FILLER_DIR = process.env.FILLER_DIR ?? join(tmp, '_filler');
  process.env.CLIPS_DIR = process.env.CLIPS_DIR ?? join(tmp, '_clips');
  process.env.SITE_STAGING_DIR = join(tmp, '_site_staging');
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const W = await import('../../volt-agent/src/siteWatch');
  const SW = await import('../src/services/sites/siteWatchfolders');

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name, licences) VALUES ($1, '{hybrid_sites}') RETURNING id`, [`sitefiles-${tag}`]))!.id;
  const owner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `own-${tag}@example.com`]))!.id;
  const tok = signAccess({ sub: owner, account_id: acct, role: 'owner' } as any);
  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: unknown, t: string | null = tok) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };
  const facts = (hostname: string) => ({ hostname, cpuCores: 8, memoryBytes: 16 * 2 ** 30, gpus: [], diskFreeBytes: 1e12, diskTotalBytes: 2e12, os: 'Linux', arch: 'x64', agentVersion: '0.4.0', encoderVersion: null });
  const enrol = async (siteId: string, name: string) => {
    const tk = (await api('POST', `/api/sites/${siteId}/enrolment-tokens`, {})).body.token;
    const e = (await api('POST', '/api/site-agent/enrol', { token: tk, host: facts(name) }, null)).body;
    await api('POST', `/api/sites/${siteId}/hosts/${e.hostId}/approve`, {});
    return e as { hostId: string; credential: string };
  };

  const site = (await api('POST', '/api/sites', { name: 'Main broadcast centre' })).body.id;
  const site2 = (await api('POST', '/api/sites', { name: 'Edit suite' })).body.id;
  const h1 = await enrol(site, 'nas-01');
  const h2 = await enrol(site2, 'edit-01');
  const root = mkdtempSync(join(tmpdir(), 'site-nas-'));

  console.log('== a site folder gets every default ==');
  let r = await api('POST', '/api/watchfolders', { name: 'NAS drop', kind: 'site', siteId: site, config: { path: root, min_age_ms: 5000 } });
  ok(r.status === 201, 'created', r);
  const fid = r.body.id;
  ok(JSON.stringify(r.body.rules.map((x: any) => x.builtin)) === JSON.stringify(['images', 'video', 'audio', 'captions', 'sidecars']), 'with images, video, audio, captions and sidecars', r.body.rules?.map((x: any) => x.builtin));
  r = await api('POST', `/api/watchfolders/${fid}/rules`, { name: 'Slates', matchType: 'glob', pattern: 'slate_*.png', targetKind: 'filler-slate' });
  ok(r.status === 201, 'and a slate rule of its own, above the defaults', r.status);

  const old = (Date.now() - 60_000) / 1000;
  const put = (name: string, data: Buffer | string) => { const p = join(root, name); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, data); utimesSync(p, old, old); return p; };
  const ff = (args: string[]) => spawnSync('ffmpeg', ['-v', 'error', ...args], { stdio: 'ignore' }).status === 0;
  const png = (name: string, size = '64x36') => { const p = join(root, name); mkdirSync(join(p, '..'), { recursive: true }); const made = ff(['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=1`, '-frames:v', '1', '-y', p]); if (!made) writeFileSync(p, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(200)])); utimesSync(p, old, old); return p; };
  const realMedia = ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', join(root, 'Show-e1.mp4')])
    && ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:a', 'libmp3lame', '-y', join(root, 'Theme.mp3')]);
  if (!realMedia) { console.log('NOTE ffmpeg not here: media are bytes'); writeFileSync(join(root, 'Show-e1.mp4'), randomBytes(100_000)); writeFileSync(join(root, 'Theme.mp3'), randomBytes(30_000)); }
  utimesSync(join(root, 'Show-e1.mp4'), old, old); utimesSync(join(root, 'Theme.mp3'), old, old);
  const vtt = (lang: string) => `WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nHello (${lang})\n`;
  png('Logo.png');
  png('slate_open.png', '320x180');
  put('Show-e1_en.vtt', vtt('en'));
  put('Later_en.vtt', vtt('later'));

  console.log('== one pass ==');
  const mem = W.emptyMemory();
  const logs: string[] = [];
  let tusPosts = 0;
  const counting: typeof fetch = async (url: any, init: any) => { if (init?.method === 'POST' && /\/api\/site-agent\/tus$/.test(String(url))) tusPosts++; return fetch(url, init); };
  const ctx = (m = mem, extra: any = {}) => ({ server: base, credential: () => h1.credential, memory: m, log: (s: string) => logs.push(s), fetch: counting, ...extra });
  let res = await W.watchPass(ctx());
  const p1 = res[0];
  ok(!p1.error && p1.uploadErrors.length === 0, 'no fault', p1.error ?? p1.uploadErrors);
  ok(['Logo.png', 'slate_open.png', 'Show-e1.mp4', 'Theme.mp3', 'Show-e1_en.vtt', 'Later_en.vtt'].every((k) => p1.uploaded.includes(k)), 'every accepted file uploaded on the site tus path', p1.uploaded);
  const item = (k: string) => one<any>(`SELECT * FROM watchfolder_items WHERE watchfolder_id = $1 AND object_key = $2`, [fid, k]);

  const logo = await item('Logo.png');
  const mf = logo?.media_file_id ? await one<any>(`SELECT * FROM media_files WHERE id = $1`, [logo.media_file_id]) : null;
  ok(logo?.status === 'ingested' && mf?.account_id === acct && mf.content_type === 'image/png' && (mf.tags ?? []).includes('watchfolder'), 'the image is in the Image Library of this account', { s: logo?.status, r: logo?.reason, mf: mf && { k: mf.kind, p: mf.path } });
  ok(existsSync(join(root, 'Logo.png')), 'the original stays at the site');
  ok(!existsSync(SW.stagedPath(fid, 'Logo.png')), 'the copy here is removed once it is in the library');
  const logoSess = await one<any>(`SELECT * FROM upload_sessions WHERE id = $1`, [logo.upload_session_id]);
  ok(logoSess?.purpose === 'site_file' && logoSess.state === 'complete' && !logoSess.vod_asset_id && !logoSess.filler_asset_id, 'its upload opened no Media Library or Loops & Fillers record of its own', logoSess && { p: logoSess.purpose, s: logoSess.state });

  const slate = await item('slate_open.png');
  const fa = await one<any>(`SELECT * FROM filler_assets WHERE account_id = $1 AND kind = 'slate'`, [acct]);
  ok(slate?.status === 'ingested' && fa?.status === 'ready' && fa.name, 'the slate is in Loops & Fillers, ready', { s: slate?.status, r: slate?.reason, fa: fa && fa.status });

  const theme = await item('Theme.mp3');
  const audio = theme?.vod_asset_id ? await one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [theme.vod_asset_id]) : null;
  const themeSess = await one<any>(`SELECT * FROM upload_sessions WHERE id = $1`, [theme?.upload_session_id]);
  ok(theme?.status === 'ingested' && audio?.source_kind === 'watchfolder' && audio.encode_job_id && themeSess?.content_type === 'audio/mpeg', 'the mp3 is in the Media Library, uploaded as audio, its encode queued', { s: theme?.status, r: theme?.reason, ct: themeSess?.content_type });
  ok(audio && readFileSync(audio.source_key).equals(readFileSync(join(root, 'Theme.mp3'))), 'byte for byte the file at the site');

  const show = await item('Show-e1.mp4');
  const cap = await item('Show-e1_en.vtt');
  const files = await query<any>(`SELECT * FROM vod_asset_files WHERE asset_id = $1`, [show?.vod_asset_id]);
  ok(show?.status === 'ingested' && cap?.status === 'ingested' && cap.vod_asset_id === show.vod_asset_id && files.length === 1 && files[0].kind === 'captions', 'the caption is attached to its video\'s asset', { cap: cap?.reason, n: files.length });

  const later = await item('Later_en.vtt');
  ok(later?.status === 'seen' && /waiting for its video/.test(later.reason ?? '') && existsSync(SW.stagedPath(fid, 'Later_en.vtt')), 'a caption with no video yet waits, its copy kept here', later?.reason);

  console.log('== the next pass ==');
  const before = tusPosts;
  res = await W.watchPass(ctx());
  ok(tusPosts === before && res[0].uploaded.length === 0, 'nothing is uploaded again, the waiting caption included', res[0].uploaded);
  ok((await item('Later_en.vtt'))?.status === 'seen', 'it still waits');

  console.log('== its video arrives ==');
  if (realMedia) ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', join(root, 'Later.mp4')]);
  else writeFileSync(join(root, 'Later.mp4'), randomBytes(50_000));
  utimesSync(join(root, 'Later.mp4'), old, old);
  res = await W.watchPass(ctx());
  const laterVid = await item('Later.mp4');
  const later2 = await item('Later_en.vtt');
  ok(res[0].uploaded.includes('Later.mp4') && laterVid?.status === 'ingested' && later2?.status === 'ingested' && later2.vod_asset_id === laterVid.vod_asset_id, 'it attaches in the pass its video lands in', { v: laterVid?.status, c: later2?.reason });
  ok(!existsSync(SW.stagedPath(fid, 'Later_en.vtt')), 'and its copy here is gone');

  console.log('== no video after 24 hours ==');
  put('Orphan_en.vtt', vtt('orphan'));
  res = await W.watchPass(ctx());
  let orphan = await item('Orphan_en.vtt');
  ok(orphan?.status === 'seen' && existsSync(SW.stagedPath(fid, 'Orphan_en.vtt')), 'waits at first', orphan?.reason);

  console.log('== a copy lost here is asked for again ==');
  unlinkSync(SW.stagedPath(fid, 'Orphan_en.vtt'));
  const firstUpload = orphan.upload_session_id;
  const n0 = tusPosts;
  res = await W.watchPass(ctx());   // this pass: the cloud notices at its end, and asks again
  res = await W.watchPass(ctx());   // the next: uploaded again
  orphan = await item('Orphan_en.vtt');
  ok(tusPosts === n0 + 1 && orphan.upload_session_id && orphan.upload_session_id !== firstUpload && orphan.status === 'seen' && existsSync(SW.stagedPath(fid, 'Orphan_en.vtt')), 'uploaded once more, waiting again with its copy here', { posts: tusPosts - n0, s: orphan.status });

  await query(`UPDATE watchfolder_items SET seen_at = now() - interval '25 hours' WHERE id = $1`, [orphan.id]);
  res = await W.watchPass(ctx());   // the cloud sends it to review at the end of this pass
  orphan = await item('Orphan_en.vtt');
  ok(orphan.status === 'quarantined' && orphan.site_action === 'review' && /after 24 hours/.test(orphan.reason) && !existsSync(SW.stagedPath(fid, 'Orphan_en.vtt')), 'after a day: Needs review, waiting for the site to move it', { s: orphan.status, a: orphan.site_action, r: orphan.reason });
  r = await api('GET', `/api/site-agent/watchfolders/${fid}/reviews`, undefined, h2.credential);
  ok(r.status === 404, "another site's host cannot read the list", r.status);
  res = await W.watchPass(ctx());
  orphan = await item('Orphan_en.vtt');
  ok(res[0].reviewed === 1 && orphan.site_action === null && orphan.status === 'quarantined' && existsSync(join(root, orphan.quarantine_key)) && !existsSync(join(root, 'Orphan_en.vtt')), 'the agent moved it into the review folder at the site', { reviewed: res[0].reviewed, q: orphan.quarantine_key });
  r = await api('GET', `/api/watchfolders/${fid}/items?status=quarantined`);
  ok(r.body.items.some((i: any) => i.object_key === 'Orphan_en.vtt' && i.quarantine_key === orphan.quarantine_key), 'and it is in the console\'s review queue');

  console.log('== too big to cross ==');
  put('Huge_en.srt', Buffer.alloc(26 * 1024 * 1024, 0x41));
  await query(`UPDATE watchfolders SET config = config || '{"max_ingest_bytes": 4000}'::jsonb WHERE id = $1`, [fid]);
  png('Big.png', '640x360');
  const n1 = tusPosts;
  res = await W.watchPass(ctx());
  const huge = await item('Huge_en.srt');
  const bigPng = await item('Big.png');
  ok(tusPosts === n1, 'neither is uploaded', tusPosts - n1);
  ok(huge.status === 'quarantined' && /over the 25 MB limit/.test(huge.reason) && !huge.upload_session_id && res[0].reviewed === 1 && existsSync(join(root, huge.quarantine_key)), 'a caption over 25 MB goes to review, moved at the site in the same pass', { r: huge.reason, q: huge.quarantine_key, rev: res[0].reviewed });
  ok(bigPng.status === 'failed' && /ingest ceiling/.test(bigPng.reason) && !bigPng.upload_session_id && existsSync(join(root, 'Big.png')), 'an image over the folder\'s ceiling fails, left at the site', bigPng.reason);
  await query(`UPDATE watchfolders SET config = config - 'max_ingest_bytes' WHERE id = $1`, [fid]);

  console.log('== changed on the way ==');
  png('Badge.png');
  const mangling: typeof fetch = async (url: any, init: any) => {
    if (init?.method === 'PATCH' && Buffer.isBuffer(init.body)) { const b = Buffer.from(init.body); b[b.length - 1] ^= 0xff; init = { ...init, body: b }; }
    return fetch(url, init);
  };
  res = await W.watchPass(ctx(mem, { fetch: mangling }));
  const badge = await item('Badge.png');
  ok(badge.status === 'failed' && /changed while it was uploading/.test(badge.reason) && !badge.media_file_id && !existsSync(SW.stagedPath(fid, 'Badge.png')), 'bytes that do not match the accepted file are not taken in', badge.reason);

  console.log('== an older site folder ==');
  r = await api('POST', '/api/watchfolders', { name: 'Old drop', kind: 'site', siteId: site, config: { path: mkdtempSync(join(tmpdir(), 'site-old-')) } });
  const oldId = r.body.id;
  await query(`DELETE FROM watchfolder_rules WHERE watchfolder_id = $1 AND builtin <> 'video'`, [oldId]);   // as made before H2b-5
  r = await api('GET', `/api/watchfolders/${oldId}`);
  ok(JSON.stringify((r.body.defaultsMissing ?? []).slice().sort()) === JSON.stringify(['audio', 'captions', 'images', 'sidecars']), 'it shows the four it lacks as missing', r.body.defaultsMissing);
  r = await api('POST', `/api/watchfolders/${oldId}/rules/defaults`, {});
  const after = await query<any>(`SELECT builtin FROM watchfolder_rules WHERE watchfolder_id = $1 ORDER BY ordinal`, [oldId]);
  ok(r.status < 300 && JSON.stringify(after.map((x) => x.builtin)) === JSON.stringify(['video', 'images', 'audio', 'captions', 'sidecars']), 'Add default rules adds them after its video rule', after.map((x) => x.builtin));

  srv.close();
  await pool.end();
  console.log(`\nsite-watchfolder-files: ${pass}/${pass + fail} passed${realMedia ? '' : ' (no ffmpeg: media were bytes)'}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
