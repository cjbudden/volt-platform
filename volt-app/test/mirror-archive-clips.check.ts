// ============================================================================
//  MIRROR AND ARCHIVE: clips as a copy source (build queue H3-9 (a),
//  HYBRID_SITES.md "Copy rules": clips).
//
//  Through the real API on a real database, with the REAL site agent code
//  (volt-agent/src/siteArchive.ts) writing into folders that stand in for
//  the customer's NAS:
//    - which file a clip is (MP4, or M4A/MP3 for audio; none while HLS only),
//      and that uploads are never clips (pure);
//    - rules: `what: ['clips']` saved alone and with the others;
//    - a clip's file as made and its metadata file, named
//      Title-Channel-YYYYMMDD-HHMM in the channel's zone, copied and verified;
//      the clip's own file never removed; asking again copies nothing;
//    - the moments: when the clip is made (clip.extract's hook), when it is
//      published, nightly;
//    - skips: an upload, a clip with no file yet, an unlicensed account;
//    - a clip that changes under the copy is not counted as archived;
//    - on an S3 deployment the bucket copy is fetched when the disk has none.
//
//  Usage: DATABASE_URL=... npx tsx test/mirror-archive-clips.check.ts
// ============================================================================
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

(async () => {
  process.env.CLIPS_DIR = mkdtempSync(join(tmpdir(), 'mac-clips-'));
  process.env.IMAGE_STORE_DIR = mkdtempSync(join(tmpdir(), 'mac-img-'));
  process.env.ARCHIVE_BUILD_DIR = mkdtempSync(join(tmpdir(), 'mac-build-'));
  const A = await import('../src/services/archive/archive');
  const S = await import('../src/services/archive/sidecars');
  const C = await import('../src/services/archive/clips');
  const AG = await import('../../volt-agent/src/siteArchive');
  const { config } = await import('../src/config');
  const { imageStore } = await import('../src/services/imageStore');

  console.log('== which file a clip is (pure) ==');
  const id0 = '11111111-2222-3333-4444-555555555555';
  ok(JSON.stringify(S.clipFileOf({ id: id0, source_kind: 'recording', progressive_key: `/clips/${id0}/clip.mp4` })) === JSON.stringify({ rel: `${id0}/clip.mp4`, ext: 'mp4' }), 'a clip\'s file is its MP4');
  ok(S.clipFileOf({ id: id0, source_kind: 'recording', export_m4a_key: `/clips/${id0}/clip.m4a` })?.ext === 'm4a', 'an audio clip\'s is its M4A');
  ok(S.clipFileOf({ id: id0, source_kind: 'recording', master_key: `/clips/${id0}/hls/index.m3u8` }) === null, 'a clip made as HLS only has no single file');
  ok(S.clipFileOf({ id: id0, source_kind: 'recording', progressive_key: `/clips/99999999-2222-3333-4444-555555555555/clip.mp4` }) === null, 'a file under another asset\'s folder is not this clip\'s');
  ok(!S.isClipAsset({ source_kind: 'upload', source_key: '/x.mp4' }) && !S.isClipAsset({ source_kind: 'watchfolder' }) && S.isClipAsset({ source_kind: 'recording' }), 'uploads and watch folder files are never clips');

  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');

  const tag = Date.now().toString(36);
  const mkAcct = async (n: string, lic: string[]) => (await one<any>(`INSERT INTO accounts(name, licences) VALUES ($1, $2) RETURNING id`, [`${n}-${tag}`, lic]))!.id;
  const acct = await mkAcct('mac', ['mirror_archive']);
  const none = await mkAcct('mcn', []);
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `mac-${tag}@example.com`]))!.id;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' } as any);
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
  const grp = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
  const ch1 = (await one<any>(`INSERT INTO channels(group_id, name, status, tz) VALUES ($1,'Channel 1','live','UTC') RETURNING id`, [grp]))!.id;
  const chB = (await one<any>(`INSERT INTO channels(group_id, name, status, tz) VALUES ($1,'Sky Arts','live','Europe/Berlin') RETURNING id`, [grp]))!.id;
  const prof2 = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [none]))!.id;
  const grp2 = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [none, prof2]))!.id;
  const chN = (await one<any>(`INSERT INTO channels(group_id, name, status, tz) VALUES ($1,'Theirs','live','UTC') RETURNING id`, [grp2]))!.id;

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: unknown, t: string | null = tok) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let b: any = null; try { b = text ? JSON.parse(text) : null; } catch { b = text; }
    return { status: r.status, body: b };
  };
  const facts = (hostname: string) => ({ hostname, cpuCores: 4, memoryBytes: 8 * 2 ** 30, diskFreeBytes: 1e12, diskTotalBytes: 2e12, os: 'Linux', arch: 'x64', agentVersion: '0.6.0' });
  const site = (await api('POST', '/api/sites', { name: 'NAS room' })).body.id;
  const tk = await api('POST', `/api/sites/${site}/enrolment-tokens`, {});
  const en = await api('POST', '/api/site-agent/enrol', { token: tk.body.token, host: facts('nas-01') }, null);
  await api('POST', `/api/sites/${site}/hosts/${en.body.hostId}/approve`, {});
  const ctx = { server: base, credential: () => en.body.credential as string, log: (_s: string) => {}, progressEveryMs: 50 };
  const drain = async () => { let n = 0; for (let i = 0; i < 20; i++) { const ran = await AG.archivePass(ctx); n += ran; if (!ran) break; } return n; };

  const nas = mkdtempSync(join(tmpdir(), 'mac-nas-'));
  const nas2 = mkdtempSync(join(tmpdir(), 'mac-nas2-'));
  const target = (await api('POST', '/api/archive/targets', { name: 'Clip NAS', siteId: site, path: nas })).body.id;
  const target2 = (await api('POST', '/api/archive/targets', { name: 'Nightly NAS', siteId: site, path: nas2 })).body.id;

  // A clip as clip.extract leaves it: a vod_assets row cut from a recording,
  // its file under CLIPS_DIR/<id>/, the public path on the asset.
  const mkClip = async (o: { title: string; channel?: string; account?: string; startMs: number; file?: 'mp4' | 'm4a' | null; body?: Buffer }) => {
    const id = (await one<any>(`INSERT INTO vod_assets (account_id, channel_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms)
      VALUES ($1,$2,'recording','clip',$3,'/x',$4,$5,60000) RETURNING id`, [o.account ?? acct, o.channel ?? ch1, o.title, o.startMs, o.startMs + 60000]))!.id as string;
    await query(`UPDATE vod_assets SET master_key = $2 WHERE id = $1`, [id, `/clips/${id}/hls/index.m3u8`]);
    if (o.file !== null) {
      const ext = o.file ?? 'mp4';
      mkdirSync(join(process.env.CLIPS_DIR!, id), { recursive: true });
      writeFileSync(join(process.env.CLIPS_DIR!, id, `clip.${ext}`), o.body ?? randomBytes(40_000));
      await query(ext === 'mp4' ? `UPDATE vod_assets SET progressive_key = $2, export_mp4_key = $2 WHERE id = $1` : `UPDATE vod_assets SET export_m4a_key = $2 WHERE id = $1`, [id, `/clips/${id}/clip.${ext}`]);
    }
    return id;
  };
  const T = Date.UTC(2026, 10, 3, 14, 14);

  console.log('== copy rules: clips ==');
  let r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: target, on: ['ingest'], what: ['clips'] }] } } });
  ok(r.status === 200 && JSON.stringify(r.body.settings.archive.copies[0].what) === '["clips"]', 'clips alone are saved', r.body?.settings?.archive ?? r.body);
  r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: target, on: ['ingest', 'publish'], what: ['source', 'clips', 'sidecars', 'clips'] }] } } });
  ok(r.status === 200 && JSON.stringify(r.body.settings.archive.copies[0].what) === '["source","clips","sidecars"]', 'with the original and sidecars, deduplicated', r.body?.settings?.archive ?? r.body);
  r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: target, on: ['ingest'], what: ['clip'] }] } } });
  ok(r.status === 422, 'an unknown "what" is still refused', r.status);
  r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: target, on: ['ingest', 'publish'], what: ['clips'] }, { targetId: target2, on: ['schedule'], what: ['clips'] }] } } });
  ok(r.status === 200, 'a clips rule on ingest and publish, and a nightly one', r.status);

  console.log('== a clip\'s file and its metadata file ==');
  const goalBytes = randomBytes(120_000);
  const goal = await mkClip({ title: 'Goal of the Day', startMs: T, body: goalBytes });
  let out = await A.copyOnRule(acct, goal, 'ingest');
  ok(out.queued.length === 2, 'ingest queues the clip\'s file and its metadata file', out);
  ok((await one<any>(`SELECT count(*)::int AS n FROM archive_copies WHERE vod_asset_id = $1 AND target_id = $2`, [goal, target2])).n === 0, 'the nightly-only target gets nothing on ingest');
  let ran = await drain();
  const cp = await query<any>(`SELECT what, state, stored_path, file_name, expected_sha256 FROM archive_copies WHERE vod_asset_id = $1 AND target_id = $2 ORDER BY what`, [goal, target]);
  ok(ran >= 2 && cp.length === 2 && cp.every((c) => c.state === 'verified'), 'the agent copies both and each is verified', cp.map((c) => [c.what, c.state]));
  const name = 'GoaloftheDay-Channel1-20261103-1414';
  ok(existsSync(join(nas, `${name}.mp4`)) && readFileSync(join(nas, `${name}.mp4`)).equals(goalBytes), 'the clip\'s file is at the target byte for byte, named Title-Channel-YYYYMMDD-HHMM', readdirSync(nas));
  ok(cp.find((c) => c.what === 'clip')?.expected_sha256 === sha(goalBytes), 'checked against the checksum of the file the cloud made');
  let meta: any = null; try { meta = JSON.parse(readFileSync(join(nas, `${name}.json`), 'utf8')); } catch { /* checked below */ }
  ok(meta?.kind === 'volt.asset' && meta.asset.id === goal && meta.clip?.fileName === `${name}.mp4`, 'the metadata file sits beside it and names the clip\'s file', meta?.clip);
  ok(meta?.clip?.stream?.kind === 'channel' && meta.clip.stream.id === ch1 && meta.clip.from === new Date(T).toISOString(), 'and says where the clip was cut from', meta?.clip);
  ok(existsSync(join(process.env.CLIPS_DIR!, goal, 'clip.mp4')), 'the clip\'s own file is never removed');
  const built = join(process.env.ARCHIVE_BUILD_DIR!, 'assets', goal);
  const left = existsSync(built) ? readdirSync(built, { recursive: true } as any).filter((f: any) => /\.[a-z]+$/.test(String(f))) : [];
  ok(left.length === 0, 'the built metadata file is released once verified', left);
  out = await A.copyOnRule(acct, goal, 'publish');
  ok(out.queued.length === 0 && out.skipped.some((s) => s.why === 'clip_already_copied_or_queued'), 'publishing it afterwards copies nothing again', out);

  console.log('== names ==');
  const goal2 = await mkClip({ title: 'Goal of the Day', startMs: T + 3 * 3600_000 });
  const arts = await mkClip({ title: 'Opera Night', channel: chB, startMs: Date.UTC(2026, 10, 3, 19, 30) });
  const radio = await mkClip({ title: 'Top Song', startMs: T, file: 'm4a' });
  for (const id of [goal2, arts, radio]) await A.copyOnRule(acct, id, 'ingest');
  await drain();
  const files = readdirSync(nas);
  ok(files.includes('GoaloftheDay-Channel1-20261103-1714.mp4'), 'two clips with the same title stay apart (their start differs)', files);
  ok(files.includes('OperaNight-SkyArts-20261103-2030.mp4'), 'the time is in the channel\'s own zone (Berlin)', files);
  ok(files.includes('TopSong-Channel1-20261103-1414.m4a') && files.includes('TopSong-Channel1-20261103-1414.json'), 'an audio clip is copied as its M4A, with its metadata file', files);

  console.log('== skips ==');
  const srcDir = join(process.env.CLIPS_DIR!, 'vod-src'); mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, 'up.mp4'), randomBytes(1000));
  const upload = (await one<any>(`INSERT INTO vod_assets (account_id, source_kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, source_key)
    VALUES ($1,'upload','Uploaded','/x',0,0,1000,$2) RETURNING id`, [acct, join(srcDir, 'up.mp4')]))!.id;
  out = await A.copyOnRule(acct, upload, 'ingest');
  ok(out.queued.length === 0 && out.skipped.some((s) => s.why === 'not_a_clip'), 'an upload under a clips-only rule copies nothing (its original is "source")', out);
  const hlsOnly = await mkClip({ title: 'Stream only', startMs: T, file: null });
  out = await A.copyOnRule(acct, hlsOnly, 'ingest');
  ok(out.queued.length === 0 && out.skipped.some((s) => s.why === 'clip_not_made'), 'a clip with no single file (HLS only, or not made yet) copies nothing', out);
  const theirs = await mkClip({ title: 'Theirs', channel: chN, account: none, startMs: T });
  out = await A.copyOnRule(none, theirs, 'ingest');
  ok(out.queued.length === 0 && !(await one(`SELECT 1 FROM archive_copies WHERE vod_asset_id = $1`, [theirs])), 'an account without the add-on copies nothing');

  console.log('== made, then copied (clip.extract\'s hook) ==');
  const hookSrc = readFileSync(join(__dirname, '..', 'src/services/jobs/handlers/clipExtract.ts'), 'utf8');
  ok(/copyClipOnReady\(p\.vodAssetId\)/.test(hookSrc) && hookSrc.indexOf('copyClipOnReady') < hookSrc.indexOf('autoPublishOnBuild(p.vodAssetId)'), 'clip.extract runs the copy rules once the file exists, before it may auto-publish');
  const fresh = await mkClip({ title: 'Fresh', startMs: T });
  await C.copyClipOnReady(fresh);
  ok((await query<any>(`SELECT what FROM archive_copies WHERE vod_asset_id = $1 AND target_id = $2`, [fresh, target])).length === 2, 'the hook queues the clip and its metadata file');

  console.log('== a clip that changes under the copy ==');
  const shifty = await mkClip({ title: 'Shifty', startMs: T + 60_000, body: randomBytes(5000) });
  await A.copyOnRule(acct, shifty, 'ingest');
  writeFileSync(join(process.env.CLIPS_DIR!, shifty, 'clip.mp4'), randomBytes(5000));   // same size, other bytes
  await AG.archivePass(ctx); await AG.archivePass(ctx);
  const sc = await one<any>(`SELECT state, error_code, stored_path FROM archive_copies WHERE vod_asset_id = $1 AND what = 'clip'`, [shifty]);
  ok(sc.state !== 'verified' && sc.error_code === 'checksum_mismatch', 'it is not counted as archived (checksum mismatch, retried)', sc);
  ok(!readdirSync(nas).some((f) => f.startsWith('Shifty-')  && f.endsWith('.mp4')), 'and the agent removed the copy it wrote', readdirSync(nas).filter((f) => f.startsWith('Shifty')));
  await query(`UPDATE jobs SET state = 'cancelled' WHERE id = (SELECT job_id FROM archive_copies WHERE vod_asset_id = $1 AND what = 'clip')`, [shifty]).catch(() => {});

  console.log('== nightly ==');
  const sw = await S.scheduledSweep({ accountId: acct, limit: 100, now: new Date('2026-11-07T23:00:00Z') });
  const nightly = await query<any>(`SELECT vod_asset_id, what FROM archive_copies WHERE target_id = $1`, [target2]);
  const got = new Set(nightly.filter((c) => c.what === 'clip').map((c) => c.vod_asset_id));
  ok(sw.queued >= 10 && [goal, goal2, arts, radio, fresh].every((id) => got.has(id)), 'the nightly walk copies every clip the target lacks', { sw, got: got.size });
  ok(!got.has(upload) && !got.has(hlsOnly), 'but no upload and no clip without a file');
  await drain();
  ok((await one<any>(`SELECT count(*)::int AS n FROM archive_copies WHERE target_id = $1 AND what = 'clip' AND state = 'verified'`, [target2])).n >= 5, 'and the agent copies them');

  console.log('== clips and sidecars together ==');
  const nas3 = mkdtempSync(join(tmpdir(), 'mac-nas3-'));
  const target3 = (await api('POST', '/api/archive/targets', { name: 'Both NAS', siteId: site, path: nas3 })).body.id;
  r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: target3, on: ['publish'], what: ['clips', 'sidecars'] }] } } });
  const posterB = randomBytes(3000);
  await imageStore().put(`posters/${goal}.jpg`, posterB);
  await query(`UPDATE vod_assets SET poster_key = $2 WHERE id = $1`, [goal, `posters/${goal}.jpg`]);
  out = await A.copyOnRule(acct, goal, 'publish');
  await drain();
  const both = await query<any>(`SELECT what, state FROM archive_copies WHERE target_id = $1 ORDER BY what`, [target3]);
  ok(both.length === 3 && both.filter((c) => c.what === 'metadata').length === 1 && both.every((c) => c.state === 'verified'), 'the clip, one metadata file and the poster (not two metadata files)', both);
  ok(existsSync(join(nas3, `${name}.jpg`)) && existsSync(join(nas3, `${name}.mp4`)), 'the poster is named after the clip too', readdirSync(nas3));

  console.log('== on S3 ==');
  const was = config.mediaStore.driver;
  (config.mediaStore as any).driver = 's3';
  const s3 = C.clipSourceUri(`${goal}/gone.mp4`);
  ok(s3?.uri === `s3://${config.aws.s3Bucket}/clips/${goal}/gone.mp4` && !s3.local, 'with the local copy gone, the bucket copy is fetched', s3);
  ok(C.clipSourceUri(`${goal}/clip.mp4`)?.local === true, 'the disk copy is preferred while it is there');
  (config.mediaStore as any).driver = was;
  ok(C.clipSourceUri(`${goal}/gone.mp4`) === null, 'on a local deployment a missing file is not made up');

  srv.close();
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
