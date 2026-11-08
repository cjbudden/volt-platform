// ============================================================================
//  MIRROR AND ARCHIVE: packaged outputs as a copy source (build queue H3-11,
//  HYBRID_SITES.md "Copy rules": "optionally packaged outputs").
//
//  Through the real API on a real database, with the REAL site agent code
//  (volt-agent/src/siteArchive.ts) writing into folders that stand in for
//  the customer's NAS:
//    - where a package is (the encode's folder, a clip's HLS folder, never
//      another asset's) and the two checksums over a set of files (pure);
//    - rules: `what: ['packages']` saved alone and with the others;
//    - an encoded asset's package copied as ONE job into one folder, every
//      file byte for byte, the progressive MP4, FAST ladders, reframes and
//      the encoder's own files left out; asking again copies nothing;
//    - an agent from before this release never leases a package job;
//    - a package missing a file, or with a file changed under the copy, is
//      not counted as archived, and the agent removes what it wrote;
//    - the cloud refuses a report of fewer files or other sizes;
//    - re-checks: verified, then one file gone or changed is corrupt (and
//      says how many), the whole folder gone is missing;
//    - a clip's HLS package, named as clips are; nightly; skips (no package,
//      no add-on); a package listed from the bucket on an S3 deployment;
//    - (H3-12) a store target takes a package: one folder job naming the
//      store and its key name, never keys.
//
//  With a real S3 API (ARCHIVE_S3_TEST_ENDPOINT and keys, as
//  mirror-archive-s3.check.ts; moto with IAM auth checks the signatures),
//  the real agent puts a package into the store (H3-12):
//    - every file an object under `<prefix>/<name>-package/`, byte for byte,
//      read back and verified; asking again copies nothing;
//    - a folder name with any object under it is taken: the WHOLE package
//      goes to -2, the other object untouched;
//    - an object taken between the look and the write (If-None-Match, 412):
//      the other object untouched, every object this job wrote removed, then
//      retried under -2;
//    - a file gone or changed under the copy: not archived, and every object
//      the job wrote removed;
//    - re-checks: verified, one object gone or changed is corrupt, all gone
//      is missing; nothing ever written outside the target's folder.
//
//  Usage: DATABASE_URL=... npx tsx test/mirror-archive-packages.check.ts
//    (ARCHIVE_S3_TEST_ENDPOINT=... ARCHIVE_S3_TEST_KEY_ID=... ARCHIVE_S3_TEST_SECRET=... for the store part)
// ============================================================================
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const walk = (d: string, rel = ''): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name), rel ? `${rel}/${e.name}` : e.name) : [rel ? `${rel}/${e.name}` : e.name]).sort();

(async () => {
  process.env.CLIPS_DIR = mkdtempSync(join(tmpdir(), 'map-clips-'));
  process.env.IMAGE_STORE_DIR = mkdtempSync(join(tmpdir(), 'map-img-'));
  process.env.ARCHIVE_BUILD_DIR = mkdtempSync(join(tmpdir(), 'map-build-'));
  const A = await import('../src/services/archive/archive');
  const S = await import('../src/services/archive/sidecars');
  const P = await import('../src/services/archive/packages');
  const M = await import('../src/services/archive/packageManifest');
  const AG = await import('../../volt-agent/src/siteArchive');
  const { config } = await import('../src/config');

  console.log('== where a package is (pure) ==');
  const id0 = '11111111-2222-3333-4444-555555555555', other = '99999999-2222-3333-4444-555555555555';
  ok(P.packageRootOf({ id: id0, master_key: `/clips/vod/${id0}/master.m3u8` }) === `/vod/${id0}`, 'an encoded asset\'s package is its /vod/<id> folder');
  ok(P.packageRootOf({ id: id0, master_key: `vod/${id0}/master.m3u8` }) === `/vod/${id0}`, 'the same on an S3 deployment (a key, no leading slash)');
  ok(P.packageRootOf({ id: id0, master_key: `/clips/${id0}/hls/index.m3u8` }) === `/${id0}/hls`, 'a clip\'s package is its HLS folder');
  ok(P.packageRootOf({ id: id0, master_key: `/clips/vod/${other}/master.m3u8` }) === null && P.packageRootOf({ id: id0, master_key: `/clips/${other}/hls/index.m3u8` }) === null, 'a master in another asset\'s folder gives no package');
  ok(P.packageRootOf({ id: id0, master_key: `/clips/vod/${id0}/../${other}/master.m3u8` }) === null && P.packageRootOf({ id: id0, master_key: '/x' }) === null && P.packageRootOf({ id: id0, master_key: `/clips/${id0}/clip.mp4` }) === null, 'a path that walks out, a placeholder or a single file give none');
  ok(M.cleanPackagePath('720p/seg_1.m4s') === '720p/seg_1.m4s' && M.cleanPackagePath('../x') === null && M.cleanPackagePath('/abs') === null && M.cleanPackagePath('a//b') === null && M.cleanPackagePath('a/./b') === null && M.cleanPackagePath('a b') === null, 'a file\'s place in a package stays inside it');
  const fs1 = [{ path: 'b', bytes: 2, sha256: 'x' }, { path: 'a', bytes: 1, sha256: 'y' }];
  ok(M.packageLayout(fs1) === M.packageLayout([...fs1].reverse()) && M.packageManifest(fs1) === M.packageManifest([...fs1].reverse()), 'the checksums do not depend on the order files are listed in');
  ok(M.packageLayout(fs1) !== M.packageLayout(fs1.slice(1)) && M.packageManifest(fs1) !== M.packageManifest([{ ...fs1[0], sha256: 'z' }, fs1[1]]), 'one file fewer changes the layout; one file changed changes the manifest');
  ok(M.packageLayout(fs1) === M.packageLayout([{ ...fs1[0], sha256: 'z' }, fs1[1]]), 'the layout is names and sizes only (what the cloud knows of a bucket package)');

  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');

  const tag = Date.now().toString(36);
  const mkAcct = async (n: string, lic: string[]) => (await one<any>(`INSERT INTO accounts(name, licences) VALUES ($1, $2) RETURNING id`, [`${n}-${tag}`, lic]))!.id;
  const acct = await mkAcct('map', ['mirror_archive']);
  const none = await mkAcct('mpn', []);
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `map-${tag}@example.com`]))!.id;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' } as any);
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
  const grp = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
  const ch1 = (await one<any>(`INSERT INTO channels(group_id, name, status, tz) VALUES ($1,'Channel 1','live','UTC') RETURNING id`, [grp]))!.id;

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: unknown, t: string | null = tok) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let b: any = null; try { b = text ? JSON.parse(text) : null; } catch { b = text; }
    return { status: r.status, body: b };
  };
  const facts = (hostname: string) => ({ hostname, cpuCores: 4, memoryBytes: 8 * 2 ** 30, diskFreeBytes: 1e12, diskTotalBytes: 2e12, os: 'Linux', arch: 'x64', agentVersion: '0.7.0' });
  const site = (await api('POST', '/api/sites', { name: 'NAS room' })).body.id;
  const tk = await api('POST', `/api/sites/${site}/enrolment-tokens`, {});
  const en = await api('POST', '/api/site-agent/enrol', { token: tk.body.token, host: facts('nas-01') }, null);
  await api('POST', `/api/sites/${site}/hosts/${en.body.hostId}/approve`, {});
  const ctx = { server: base, credential: () => en.body.credential as string, log: (_s: string) => {}, progressEveryMs: 50 };
  const drain = async () => { let n = 0; for (let i = 0; i < 20; i++) { const ran = await AG.archivePass(ctx); n += ran; if (!ran) break; } return n; };

  const nas = mkdtempSync(join(tmpdir(), 'map-nas-'));
  const nas2 = mkdtempSync(join(tmpdir(), 'map-nas2-'));
  const target = (await api('POST', '/api/archive/targets', { name: 'Package NAS', siteId: site, path: nas })).body.id;
  const target2 = (await api('POST', '/api/archive/targets', { name: 'Nightly NAS', siteId: site, path: nas2 })).body.id;
  const store = await api('POST', '/api/archive/targets', { name: 'Object store', siteId: site, kind: 's3', s3: { endpoint: 'http://minio.local:9000', bucket: 'volt-archive', credentialRef: 'k1' } });

  // An encoded asset as vod.encode leaves it on a single server: the package
  // under CLIPS_DIR/vod/<id>/, beside files that are not the package.
  const PKG = ['master.m3u8', 'manifest.mpd', 'stream_0.m3u8', 'stream_1.m3u8', '720p/init.mp4', ...Array.from({ length: 30 }, (_, i) => `720p/seg_${i + 1}.m4s`),
    '1080p/init.mp4', ...Array.from({ length: 30 }, (_, i) => `1080p/seg_${i + 1}.m4s`), 'audio/init.mp4', ...Array.from({ length: 30 }, (_, i) => `audio/seg_${i + 1}.m4s`), 'trickplay/iframes.m3u8'];
  const NOT = ['encode-job.json', 'file.mp4', 'ladders/2s/master.m3u8', 'ladders/2s/720p/seg_1.m4s', 'reframe/tracks.json', '.enc/tmp.bin', '720p/seg_31.m4s.part-abc'];
  const mkEncoded = async (title: string, sourceName: string, o: { account?: string; files?: string[] } = {}) => {
    const id = (await one<any>(`INSERT INTO vod_assets (account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, source_key)
      VALUES ($1,'upload','clip',$2,'/x',0,0,120000,$3) RETURNING id`, [o.account ?? acct, title, join(process.env.CLIPS_DIR!, 'vod-src', sourceName)]))!.id as string;
    const dir = join(process.env.CLIPS_DIR!, 'vod', id);
    for (const f of [...(o.files ?? PKG), ...NOT]) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), f.endsWith('.m3u8') || f.endsWith('.mpd') ? `#EXTM3U\n# ${f}\n` : randomBytes(800 + Math.floor(Math.random() * 400))); }
    await query(`UPDATE vod_assets SET master_key = $2 WHERE id = $1`, [id, `/clips/vod/${id}/master.m3u8`]);
    return { id, dir };
  };

  console.log('== copy rules: packages ==');
  let r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: target, on: ['ingest'], what: ['packages'] }] } } });
  ok(r.status === 200 && JSON.stringify(r.body.settings.archive.copies[0].what) === '["packages"]', 'packages alone are saved', r.body?.settings?.archive ?? r.body);
  r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: target, on: ['ingest', 'publish'], what: ['source', 'packages', 'packages'] }] } } });
  ok(r.status === 200 && JSON.stringify(r.body.settings.archive.copies[0].what) === '["source","packages"]', 'with the original, deduplicated', r.body?.settings?.archive ?? r.body);
  r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: target, on: ['ingest'], what: ['package'] }] } } });
  ok(r.status === 422, 'an unknown "what" is still refused', r.status);
  r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: target, on: ['ingest', 'publish'], what: ['packages'] }, { targetId: target2, on: ['schedule'], what: ['packages'] }] } } });
  ok(r.status === 200, 'a packages rule on ingest and publish, and a nightly one', r.status);

  console.log('== an asset\'s package, as one folder ==');
  const show = await mkEncoded('Morning News', 'Morning News.mp4');
  let out = await A.copyOnRule(acct, show.id, 'ingest');
  ok(out.queued.length === 1, 'ingest queues one copy for the whole package', out);
  const job = await one<any>(`SELECT j.type, j.payload FROM archive_copies c JOIN jobs j ON j.id = c.job_id WHERE c.vod_asset_id = $1`, [show.id]);
  ok(job?.type === 'archive.copy-folder' && job.payload.files.length === PKG.length && job.payload.transfers.length === PKG.length, `one job lists all ${PKG.length} files, a transfer each`, { type: job?.type, n: job?.payload?.files?.length });
  ok(!job.payload.transfers.some((t: any) => /encode-job|file\.mp4|ladders|reframe|\.enc|\.part-/.test(t.uri)), 'the progressive MP4, ladders, reframes and the encoder\'s files are left out');
  const lease = await api('POST', '/api/site-agent/jobs/lease', { types: ['archive.copy', 'archive.verify'] }, en.body.credential);
  ok(lease.status === 204, 'an agent from before this release (asking for copy and verify only) is never handed a package', lease.status);
  ok(!JSON.stringify((await api('POST', '/api/site-agent/jobs/lease', { types: ['archive.copy-folder'] }, en.body.credential)).body?.transfers ?? []).includes('/'), 'the agent sees transfer names only, never where the files are');
  await query(`UPDATE jobs SET state = 'queued', claimed_by = NULL, lease_until = NULL WHERE id = (SELECT job_id FROM archive_copies WHERE vod_asset_id = $1)`, [show.id]);
  let ran = await drain();
  const cp = await one<any>(`SELECT * FROM archive_copies WHERE vod_asset_id = $1 AND target_id = $2`, [show.id, target]);
  ok(ran === 1 && cp.state === 'verified' && cp.what === 'package', 'the agent runs one job and the package is verified', { ran, state: cp?.state, err: cp?.error });
  ok(cp.stored_path === 'MorningNews-package' && existsSync(join(nas, 'MorningNews-package', 'master.m3u8')), 'it is a folder named after the original', readdirSync(nas));
  const atTarget = walk(join(nas, 'MorningNews-package'));
  ok(JSON.stringify(atTarget) === JSON.stringify([...PKG].sort()), 'the folder holds exactly the package, laid out as the player reads it', atTarget.filter((f) => !PKG.includes(f)));
  ok(PKG.every((f) => readFileSync(join(nas, 'MorningNews-package', f)).equals(readFileSync(join(show.dir, f)))), 'every file byte for byte');
  const totalBytes = PKG.reduce((s, f) => s + readFileSync(join(show.dir, f)).length, 0);
  ok(Number(cp.bytes) === totalBytes && cp.sha256 === cp.expected_sha256 && /^[0-9a-f]{64}$/.test(cp.sha256), 'the copy records the package\'s size and the checksum over every file, matching the cloud\'s', { bytes: cp.bytes, totalBytes });
  ok(existsSync(join(show.dir, 'master.m3u8')) && readdirSync(nas).every((f) => !f.includes('.part-')), 'the package in the cloud is untouched and no part folder is left');
  const view = await api('GET', `/api/archive/copies?vod_asset_id=${show.id}`);
  const v = (view.body?.items ?? view.body ?? []).find?.((c: any) => c.what === 'package');
  ok(v && v.storedPath === 'MorningNews-package' && v.state === 'verified', 'the copies list shows it', view.body);
  out = await A.copyOnRule(acct, show.id, 'publish');
  ok(out.queued.length === 0 && out.skipped.some((s) => s.why === 'package_already_copied_or_queued'), 'publishing it afterwards copies nothing again', out);

  console.log('== re-checks ==');
  let vr = await api('POST', `/api/archive/copies/${cp.id}/verify`, {});
  ok(vr.status === 200 || vr.status === 201 || vr.status === 202, 'a re-check is queued', vr.status);
  ok((await one<any>(`SELECT j.type FROM archive_copies c JOIN jobs j ON j.id = c.verify_job_id WHERE c.id = $1`, [cp.id]))?.type === 'archive.verify-folder', 'as a folder re-check');
  await drain();
  ok((await one<any>(`SELECT state FROM archive_copies WHERE id = $1`, [cp.id])).state === 'verified', 'an untouched package stays verified');
  unlinkSync(join(nas, 'MorningNews-package', '720p', 'seg_7.m4s'));
  await api('POST', `/api/archive/copies/${cp.id}/verify`, {}); await drain();
  let cs = await one<any>(`SELECT state, error FROM archive_copies WHERE id = $1`, [cp.id]);
  ok(cs.state === 'corrupt' && /1 file missing, 0 changed/.test(cs.error), 'one segment gone: corrupt, and it says one file is missing', cs);
  await query(`UPDATE archive_copies SET state = 'verified' WHERE id = $1`, [cp.id]);
  writeFileSync(join(nas, 'MorningNews-package', '720p', 'seg_7.m4s'), readFileSync(join(show.dir, '720p', 'seg_7.m4s')));
  const s8 = join(nas, 'MorningNews-package', '1080p', 'seg_8.m4s'); const b8 = readFileSync(s8); b8[10] ^= 0xff; writeFileSync(s8, b8);
  await api('POST', `/api/archive/copies/${cp.id}/verify`, {}); await drain();
  cs = await one<any>(`SELECT state, error FROM archive_copies WHERE id = $1`, [cp.id]);
  ok(cs.state === 'corrupt' && /0 files missing/.test(cs.error), 'one segment changed (same size): corrupt', cs);
  await query(`UPDATE archive_copies SET state = 'verified' WHERE id = $1`, [cp.id]);
  rmSync(join(nas, 'MorningNews-package'), { recursive: true });
  await api('POST', `/api/archive/copies/${cp.id}/verify`, {}); await drain();
  ok((await one<any>(`SELECT state FROM archive_copies WHERE id = $1`, [cp.id])).state === 'missing', 'the whole folder gone: missing');
  out = await A.copyOnRule(acct, show.id, 'publish');
  await drain();
  ok(out.queued.length === 1 && (await one<any>(`SELECT state FROM archive_copies WHERE id = $1`, [cp.id])).state === 'verified' && walk(join(nas, 'MorningNews-package')).length === PKG.length, 'a missing package is copied afresh on the next moment', out);

  console.log('== a package that is not whole is not archived ==');
  const gap = await mkEncoded('Gap', 'Gap.mp4');
  await A.copyOnRule(acct, gap.id, 'ingest');
  unlinkSync(join(gap.dir, '720p', 'seg_12.m4s'));      // gone after the copy was planned
  await AG.archivePass(ctx);
  let gc = await one<any>(`SELECT state, error_code, stored_path FROM archive_copies WHERE vod_asset_id = $1`, [gap.id]);
  ok(gc.state !== 'verified' && gc.stored_path === null, 'a file gone from the package: not archived, retried', gc);
  ok(!readdirSync(nas).some((f) => f.startsWith('Gap-package')), 'and the agent removed the part folder it wrote', readdirSync(nas));
  await query(`UPDATE jobs SET state = 'cancelled' WHERE id = (SELECT job_id FROM archive_copies WHERE vod_asset_id = $1)`, [gap.id]);
  const shifty = await mkEncoded('Shifty', 'Shifty.mp4');
  await A.copyOnRule(acct, shifty.id, 'ingest');
  const f9 = join(shifty.dir, 'audio', 'seg_9.m4s'); writeFileSync(f9, randomBytes(readFileSync(f9).length));   // same size, other bytes
  await AG.archivePass(ctx);
  gc = await one<any>(`SELECT state, error_code FROM archive_copies WHERE vod_asset_id = $1`, [shifty.id]);
  ok(gc.state !== 'verified' && gc.error_code === 'checksum_mismatch', 'a file changed under the copy: the cloud refuses it (checksum mismatch)', gc);
  ok(!readdirSync(nas).some((f) => f.startsWith('Shifty-package')), 'and the agent removed the whole folder', readdirSync(nas));
  await query(`UPDATE jobs SET state = 'cancelled' WHERE id = (SELECT job_id FROM archive_copies WHERE vod_asset_id = $1)`, [shifty.id]);
  // The cloud's own judgement of a report, as a host would send it.
  const jrow = await one<any>(`SELECT j.* FROM archive_copies c JOIN jobs j ON j.id = c.job_id WHERE c.vod_asset_id = $1 AND c.target_id = $2`, [show.id, target]);
  const good = { storedPath: 'MorningNews-package', files: PKG.length, bytes: totalBytes, sha256: cp.sha256, downloadSha256: cp.sha256, layoutSha256: jrow.payload.layoutSha256 };
  ok((await A.judge(jrow, good)).ok === true, 'a whole report is accepted');
  const less: any = await A.judge(jrow, { ...good, files: PKG.length - 1, layoutSha256: M.packageLayout(jrow.payload.files.slice(1)) });
  ok(!less.ok && less.code === 'package_incomplete', 'a report of one file fewer is refused as incomplete', less);
  const size: any = await A.judge(jrow, { ...good, bytes: totalBytes - 1 });
  ok(!size.ok && size.code === 'package_incomplete', 'other sizes are refused', size);
  const other2: any = await A.judge(jrow, { ...good, sha256: 'a'.repeat(64), downloadSha256: 'a'.repeat(64) });
  ok(!other2.ok && other2.code === 'checksum_mismatch', 'a package that is not what Volt has is refused', other2);
  const outside: any = await A.judge(jrow, { ...good, storedPath: '../etc' });
  ok(!outside.ok && outside.status === 400, 'a folder outside the target is refused', outside);

  console.log('== a clip\'s package ==');
  const T = Date.UTC(2026, 10, 3, 14, 14);
  const clip = (await one<any>(`INSERT INTO vod_assets (account_id, channel_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms)
    VALUES ($1,$2,'recording','clip','Goal of the Day','/x',$3,$4,60000) RETURNING id`, [acct, ch1, T, T + 60000]))!.id as string;
  const cdir = join(process.env.CLIPS_DIR!, clip);
  for (const f of ['hls/index.m3u8', 'hls/seg_0.ts', 'hls/seg_1.ts']) { mkdirSync(dirname(join(cdir, f)), { recursive: true }); writeFileSync(join(cdir, f), randomBytes(500)); }
  writeFileSync(join(cdir, 'clip.mp4'), randomBytes(500));
  await query(`UPDATE vod_assets SET master_key = $2 WHERE id = $1`, [clip, `/clips/${clip}/hls/index.m3u8`]);
  await A.copyOnRule(acct, clip, 'ingest'); await drain();
  const cc = await one<any>(`SELECT state, stored_path FROM archive_copies WHERE vod_asset_id = $1 AND target_id = $2`, [clip, target]);
  ok(cc?.state === 'verified' && cc.stored_path === 'GoaloftheDay-Channel1-20261103-1414-package', 'a clip\'s HLS folder, named as clips are', cc);
  ok(JSON.stringify(walk(join(nas, cc.stored_path))) === '["index.m3u8","seg_0.ts","seg_1.ts"]', 'only the package, not the clip\'s MP4 beside it', walk(join(nas, cc.stored_path)));

  console.log('== skips ==');
  const bare = (await one<any>(`INSERT INTO vod_assets (account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms) VALUES ($1,'upload','clip','Bare','/x',0,0,1) RETURNING id`, [acct]))!.id;
  out = await A.copyOnRule(acct, bare, 'ingest');
  ok(out.queued.length === 0 && out.skipped.some((s) => s.why === 'no_package'), 'an asset not packaged yet copies nothing', out);
  // H3-12: a store target takes a package (it was refused before), as one
  // folder job naming the store and the keys' name, never the keys.
  const sq = await P.requestPackageCopy(acct, store.body.id, show.id);
  const sjob = await one<any>(`SELECT j.id, j.type, j.payload FROM archive_copies c JOIN jobs j ON j.id = c.job_id WHERE c.target_id = $1 AND c.vod_asset_id = $2`, [store.body.id, show.id]);
  ok(store.status === 201 && sq.queued.length === 1 && sjob?.type === 'archive.copy-folder' && sjob.payload.target.kind === 's3' && sjob.payload.target.s3?.bucket === 'volt-archive'
    && sjob.payload.target.s3?.credentialRef === 'k1' && sjob.payload.files.length === PKG.length && !/secret|accessKeyId/i.test(JSON.stringify(sjob.payload)),
    'a store target takes a package: one folder job with the store and its keys\' name, no keys', { status: store.status, sq, type: sjob?.type, target: sjob?.payload?.target });
  await query(`UPDATE jobs SET state = 'cancelled' WHERE id = $1`, [sjob.id]);   // minio.local is not there; the real store is below
  const theirs = await mkEncoded('Theirs', 'Theirs.mp4', { account: none });
  out = await A.copyOnRule(none, theirs.id, 'ingest');
  ok(out.queued.length === 0 && !(await one(`SELECT 1 FROM archive_copies WHERE vod_asset_id = $1`, [theirs.id])), 'an account without the add-on copies nothing');

  console.log('== nightly ==');
  const sw = await S.scheduledSweep({ accountId: acct, limit: 100, now: new Date('2026-11-07T23:00:00Z') });
  const nightly = await query<any>(`SELECT vod_asset_id FROM archive_copies WHERE target_id = $1 AND what = 'package'`, [target2]);
  const got = new Set(nightly.map((c) => c.vod_asset_id));
  ok(sw.queued >= 3 && [show.id, gap.id, shifty.id, clip].every((id) => got.has(id)) && !got.has(bare), 'the nightly walk copies every package the target lacks', { sw, n: got.size });

  console.log('== on S3 ==');
  const wasDriver = config.mediaStore.driver;
  (config.mediaStore as any).driver = 's3';
  const s3id = '33333333-4444-5555-6666-777777777777';
  let asked = '';
  P.setBucketLister(async (bucket, prefix) => { asked = `${bucket}/${prefix}`; return [
    { key: `${prefix}master.m3u8`, bytes: 100 }, { key: `${prefix}720p/seg_1.m4s`, bytes: 5000 }, { key: `${prefix}ladders/2s/seg.m4s`, bytes: 9 }, { key: `${prefix}reframe/x.m4s`, bytes: 9 }, { key: `${prefix}encode-job.json`, bytes: 9 },
  ]; });
  const plan = await P.planPackage({ id: s3id, master_key: `vod/${s3id}/master.m3u8` });
  ok(asked === `${config.aws.s3Bucket}/vod/${s3id}/`, 'with no folder on this server, the origin bucket\'s folder is listed', asked);
  ok(plan && !plan.local && JSON.stringify(plan.files.map((f) => f.path)) === '["720p/seg_1.m4s","master.m3u8"]' && plan.files.every((f) => f.uri.startsWith(`s3://${config.aws.s3Bucket}/vod/${s3id}/`)), 'the package\'s files, each fetched from the bucket, ladders and reframes left out', plan?.files);
  (config.mediaStore as any).driver = wasDriver;
  ok(await P.planPackage({ id: s3id, master_key: `vod/${s3id}/master.m3u8` }) === null, 'on a local deployment a missing folder is not made up');

  console.log('== into a real S3-compatible store (H3-12) ==');
  const ENDPOINT = process.env.ARCHIVE_S3_TEST_ENDPOINT || undefined;
  if (!ENDPOINT) {
    console.log('PASS skipped the store part: set ARCHIVE_S3_TEST_ENDPOINT (and _KEY_ID, _SECRET) to run against moto, MinIO or another S3-compatible store');
  } else {
    const KEY_ID = process.env.ARCHIVE_S3_TEST_KEY_ID ?? 'test', SECRET = process.env.ARCHIVE_S3_TEST_SECRET ?? 'test';
    const bucket = `volt-map-${tag}`.toLowerCase();
    const { S3Client, CreateBucketCommand, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const sdk = new S3Client({ endpoint: ENDPOINT, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: KEY_ID, secretAccessKey: SECRET } });
    await sdk.send(new CreateBucketCommand({ Bucket: bucket }));
    const get = async (key: string): Promise<Buffer | null> => {
      try { const o: any = await sdk.send(new GetObjectCommand({ Bucket: bucket, Key: key })); return Buffer.from(await o.Body.transformToByteArray()); } catch { return null; }
    };
    const list = async (prefix = ''): Promise<string[]> => {
      const out: string[] = []; let token: string | undefined;
      do {
        const r: any = await sdk.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of r.Contents ?? []) out.push(o.Key);
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return out.sort();
    };
    const under = async (folder: string) => (await list(`Volt/Packages/${folder}/`)).map((k) => k.slice(`Volt/Packages/${folder}/`.length));
    const kdir = mkdtempSync(join(tmpdir(), 'map-keys-'));
    const keyFile = join(kdir, 'archive-keys.json');
    writeFileSync(keyFile, JSON.stringify({ 'pkg-store': { accessKeyId: KEY_ID, secretAccessKey: SECRET } })); chmodSync(keyFile, 0o600);
    let hook: ((u: string, init: any) => Promise<void>) | null = null;
    const hooked: typeof fetch = (async (u: any, init: any) => { if (hook) await hook(String(u), init); return fetch(u, init); }) as any;
    const sctx = { ...ctx, keysFile: keyFile, fetch: hooked };
    const sdrain = async () => { let n = 0; for (let i = 0; i < 20; i++) { const ran = await AG.archivePass(sctx); n += ran; if (!ran) break; } return n; };
    const st = await api('POST', '/api/archive/targets', { name: 'Package store', siteId: site, kind: 's3', s3: { endpoint: ENDPOINT, bucket, prefix: 'Volt/Packages', credentialRef: 'pkg-store' } });
    ok(st.status === 201, 'a store target at the real S3 API', st.body);
    const storeCopy = async (assetId: string) => one<any>(`SELECT * FROM archive_copies WHERE vod_asset_id = $1 AND target_id = $2`, [assetId, st.body.id]);
    const due = (copyId: string) => query(`UPDATE jobs SET run_after = now() FROM archive_copies c WHERE (c.job_id = jobs.id OR c.verify_job_id = jobs.id) AND c.id = $1`, [copyId]);
    const cancel = (copyId: string) => query(`UPDATE jobs SET state = 'cancelled' FROM archive_copies c WHERE c.job_id = jobs.id AND c.id = $1`, [copyId]);

    let q = await P.requestPackageCopy(acct, st.body.id, show.id);
    await sdrain();
    let sc = await storeCopy(show.id);
    ok(q.queued.length === 1 && sc?.state === 'verified' && sc.stored_path === 'MorningNews-package', 'the package is copied into the store and verified', { q, state: sc?.state, err: sc?.error, code: sc?.error_code });
    const inStore = await under('MorningNews-package');
    ok(JSON.stringify(inStore) === JSON.stringify([...PKG].sort()), `every file an object under Volt/Packages/MorningNews-package/ (${inStore.length} objects), nothing else`, inStore.filter((f) => !PKG.includes(f)));
    let same = true;
    for (const f of PKG) if (!(await get(`Volt/Packages/MorningNews-package/${f}`))?.equals(readFileSync(join(show.dir, f)))) { same = false; break; }
    ok(same, 'every object byte for byte');
    ok(Number(sc.bytes) === totalBytes && sc.sha256 === sc.expected_sha256, 'the copy records the size and the checksum over every object, matching the cloud\'s', { bytes: sc.bytes, totalBytes });
    q = await P.requestPackageCopy(acct, st.body.id, show.id);
    ok(q.queued.length === 0 && q.kept.length === 1, 'asking again copies nothing', q);

    // A folder name with ANY object under it is taken: the whole package goes to -2.
    const taken = await mkEncoded('Taken', 'Taken.mp4');
    const theirsObj = randomBytes(300);
    await sdk.send(new PutObjectCommand({ Bucket: bucket, Key: 'Volt/Packages/Taken-package/notes.txt', Body: theirsObj }));
    await P.requestPackageCopy(acct, st.body.id, taken.id); await sdrain();
    sc = await storeCopy(taken.id);
    ok(sc?.state === 'verified' && sc.stored_path === 'Taken-package-2' && (await under('Taken-package-2')).length === PKG.length, 'a folder name already in use: the whole package goes to -2', { state: sc?.state, path: sc?.stored_path, err: sc?.error });
    ok(JSON.stringify(await under('Taken-package')) === '["notes.txt"]' && (await get('Volt/Packages/Taken-package/notes.txt'))?.equals(theirsObj), 'and nothing was added to or replaced in the other folder', await under('Taken-package'));

    // An object taken between the look and the write: If-None-Match answers 412.
    const race = await mkEncoded('Race', 'Race.mp4');
    const racer = randomBytes(700);
    let planted = false;
    hook = async (u, init) => {
      if (!planted && init?.method === 'PUT' && new URL(u).pathname.endsWith('/Volt/Packages/Race-package/720p/seg_5.m4s')) {
        planted = true;
        await sdk.send(new PutObjectCommand({ Bucket: bucket, Key: 'Volt/Packages/Race-package/720p/seg_5.m4s', Body: racer }));
      }
    };
    await P.requestPackageCopy(acct, st.body.id, race.id);
    await AG.archivePass(sctx);
    hook = null;
    sc = await storeCopy(race.id);
    ok(planted && sc?.state !== 'verified' && sc?.error_code === 'name_taken', 'an object taken while copying: refused by the store (412), the copy waits to retry', { planted, state: sc?.state, code: sc?.error_code });
    ok(JSON.stringify(await under('Race-package')) === '["720p/seg_5.m4s"]' && (await get('Volt/Packages/Race-package/720p/seg_5.m4s'))?.equals(racer), 'the other object is untouched and every object the job wrote is removed', await under('Race-package'));
    await due(sc.id); await sdrain();
    sc = await storeCopy(race.id);
    ok(sc?.state === 'verified' && sc.stored_path === 'Race-package-2' && (await under('Race-package-2')).length === PKG.length, 'retried, the whole package goes to -2 and is verified', { state: sc?.state, path: sc?.stored_path, err: sc?.error });

    // Not whole: nothing stays in the store.
    const gone = await mkEncoded('Gone', 'Gone.mp4');
    await P.requestPackageCopy(acct, st.body.id, gone.id);
    unlinkSync(join(gone.dir, '1080p', 'seg_20.m4s'));
    await AG.archivePass(sctx);
    sc = await storeCopy(gone.id);
    ok(sc?.state !== 'verified' && sc?.stored_path === null && (await list('Volt/Packages/Gone-package')).length === 0, 'a file gone from the package: not archived, and every object the job wrote is removed', { state: sc?.state, code: sc?.error_code, left: (await list('Volt/Packages/Gone-package')).length });
    await cancel(sc.id);
    const shift = await mkEncoded('Shift', 'Shift.mp4');
    await P.requestPackageCopy(acct, st.body.id, shift.id);
    const f3 = join(shift.dir, '720p', 'seg_3.m4s'); writeFileSync(f3, randomBytes(readFileSync(f3).length));
    await AG.archivePass(sctx);
    sc = await storeCopy(shift.id);
    ok(sc?.state !== 'verified' && sc?.error_code === 'checksum_mismatch' && (await list('Volt/Packages/Shift-package')).length === 0, 'a file changed under the copy: the cloud refuses it and the agent removes every object it wrote', { state: sc?.state, code: sc?.error_code, left: (await list('Volt/Packages/Shift-package')).length });
    await cancel(sc.id);

    // Re-checks, read back object by object.
    const sid = (await storeCopy(show.id)).id;
    await api('POST', `/api/archive/copies/${sid}/verify`, {}); await sdrain();
    ok((await one<any>(`SELECT j.type FROM archive_copies c JOIN jobs j ON j.id = c.verify_job_id WHERE c.id = $1`, [sid]))?.type === 'archive.verify-folder' && (await storeCopy(show.id)).state === 'verified', 'a re-check of an untouched package in the store: verified');
    const k7 = 'Volt/Packages/MorningNews-package/720p/seg_7.m4s', keep7 = await get(k7);
    await sdk.send(new DeleteObjectCommand({ Bucket: bucket, Key: k7 }));
    await api('POST', `/api/archive/copies/${sid}/verify`, {}); await sdrain();
    sc = await storeCopy(show.id);
    ok(sc.state === 'corrupt' && /1 file missing, 0 changed/.test(sc.error), 'one object gone: corrupt, and it says one file is missing', { state: sc.state, error: sc.error });
    await sdk.send(new PutObjectCommand({ Bucket: bucket, Key: k7, Body: keep7! }));
    await query(`UPDATE archive_copies SET state = 'verified' WHERE id = $1`, [sid]);
    const k8 = 'Volt/Packages/MorningNews-package/1080p/seg_8.m4s', b8s = (await get(k8))!; b8s[10] ^= 0xff;
    await sdk.send(new PutObjectCommand({ Bucket: bucket, Key: k8, Body: b8s }));
    await api('POST', `/api/archive/copies/${sid}/verify`, {}); await sdrain();
    sc = await storeCopy(show.id);
    ok(sc.state === 'corrupt' && /0 files missing/.test(sc.error), 'one object changed (same size): corrupt', { state: sc.state, error: sc.error });
    await query(`UPDATE archive_copies SET state = 'verified' WHERE id = $1`, [sid]);
    for (const k of await list('Volt/Packages/MorningNews-package/')) await sdk.send(new DeleteObjectCommand({ Bucket: bucket, Key: k }));
    await api('POST', `/api/archive/copies/${sid}/verify`, {}); await sdrain();
    ok((await storeCopy(show.id)).state === 'missing', 'every object gone: missing');
    ok((await list()).every((k) => k.startsWith('Volt/Packages/')), 'nothing was ever written outside the target\'s folder', (await list()).filter((k) => !k.startsWith('Volt/Packages/')));
  }

  srv.close();
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
