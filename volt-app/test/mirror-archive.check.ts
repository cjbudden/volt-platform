// ============================================================================
//  MIRROR AND ARCHIVE, first part (build queue H3-2, HYBRID_SITES.md).
//
//  Through the real API on a real database, with the REAL site agent code
//  (volt-agent/src/siteArchive.ts) writing into a folder that stands in for
//  the customer's NAS:
//    - names: values cleaned, `-` between them, -2 and -3 on a clash, the
//      recording names for EPG and hourly files in the channel's zone;
//    - licences: Mirror and Archive alone opens sites, hosts and the lease
//      but not on-prem watchfolders or their uploads; Hybrid Sites alone does
//      not open /api/archive and never leases archive work; neither: 403;
//    - storage targets: create, refuse bad paths and other accounts' sites,
//      list, change, disable;
//    - a copy: queued in the site's pool, the address never shown to the
//      host, written by the agent into the folder, read back, matched
//      against the original's checksum and only then verified; asking again
//      returns the same copy; a clash gets -2;
//    - a corrupted copy is detected: a wrong checksum is refused, the file
//      removed at the target, the attempt retried, and failed when the
//      attempts are spent; a re-check finds a changed copy corrupt and a
//      vanished one missing;
//    - a host cannot report a path outside the target; the bandwidth cap is
//      kept; an unmounted folder is a retry, not a new folder.
//
//  Usage: DATABASE_URL=... npx tsx test/mirror-archive.check.ts
// ============================================================================
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

(async () => {
  const N = await import('../src/services/archive/naming');
  const A = await import('../src/services/archive/archive');
  const AG = await import('../../volt-agent/src/siteArchive');

  console.log('== names (pure) ==');
  ok(N.nameValue('Morning News!') === 'MorningNews', 'spaces and unsupported characters removed', N.nameValue('Morning News!'));
  ok(N.nameValue('Café Société') === 'CafeSociete', 'accents kept as their letters', N.nameValue('Café Société'));
  ok(N.safeFileName('../../etc/My Show (final).MOV') === 'MyShowfinal.mov', 'a file name loses its path and odd characters, keeps a lower-case extension', N.safeFileName('../../etc/My Show (final).MOV'));
  ok(N.safeFileName('...', 'Fallback Title') === 'FallbackTitle' && N.safeFileName('') === 'file', 'a name that cleans to nothing falls back');
  const taken = new Set(['a.mp4', 'a-2.mp4']);
  ok(N.freeName('a.mp4', (n) => taken.has(n)) === 'a-3.mp4' && N.freeName('b.mp4', (n) => taken.has(n)) === 'b.mp4', 'a taken name gets -2, -3 before the extension');
  const epg = N.recordingFileName({ title: 'Morning News', channel: 'Channel 1', start: Date.parse('2026-11-03T06:00:00Z'), timeZone: 'Europe/London' });
  ok(epg === 'MorningNews-Channel1-20261103-0600.mp4', 'EPG file: Title-Channel-YYYYMMDD-HHMM', epg);
  const summer = N.recordingFileName({ title: 'Morning News', channel: 'Channel 1', start: Date.parse('2026-07-01T05:00:00Z'), timeZone: 'Europe/London' });
  ok(summer === 'MorningNews-Channel1-20260701-0600.mp4', 'in the channel\'s zone (summer time)', summer);
  const hourly = N.recordingFileName({ channel: 'Sports HD', start: Date.parse('2026-11-03T23:00:00Z'), timeZone: 'America/New_York' });
  ok(hourly === 'SportsHD-20261103-1800.mp4', 'hourly file: no title', hourly);
  ok(N.recordingFileName({ title: '???', channel: 'C1', start: 0 }) === 'C1-19700101-0000.mp4', 'a title that cleans to nothing leaves no stray dash');

  console.log('== target paths (pure) ==');
  const thr = (f: () => unknown) => { try { f(); return null; } catch (e: any) { return e; } };
  ok(A.cleanTargetPath(' /mnt/nas/archive ') === '/mnt/nas/archive' && A.cleanTargetPath('D:\\Archive') === 'D:\\Archive' && A.cleanTargetPath('\\\\nas\\archive') === '\\\\nas\\archive', 'POSIX, drive and share paths accepted');
  ok(thr(() => A.cleanTargetPath('archive'))?.status === 400 && thr(() => A.cleanTargetPath('/mnt/../etc'))?.status === 400 && thr(() => A.cleanTargetPath(''))?.status === 400, 'relative, .. and empty refused');
  ok(thr(() => AG.insideTarget('/srv/nas', '../x'))?.code === 'outside_target' && thr(() => AG.insideTarget('/srv/nas', ''))?.code === 'outside_target' && AG.insideTarget('/srv/nas', 'a/b.mp4') === '/srv/nas/a/b.mp4', 'the agent writes only inside the target');

  process.env.CLIPS_DIR ||= mkdtempSync(join(tmpdir(), 'ma-clips-'));
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const Q = await import('../src/services/jobs/queue');

  const tag = Date.now().toString(36);
  const mkAcct = async (n: string, lic: string[]) => (await one<any>(`INSERT INTO accounts(name, licences) VALUES ($1, $2) RETURNING id`, [`${n}-${tag}`, lic]))!.id;
  const acct = await mkAcct('ma', ['mirror_archive']);
  const hyb = await mkAcct('hy', ['hybrid_sites']);
  const none = await mkAcct('no', []);
  const other = await mkAcct('ot', ['mirror_archive']);
  const tokFor = async (a: string, n: string) => {
    const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `${n}-${tag}@example.com`]))!.id;
    return signAccess({ sub: u, account_id: a, role: 'owner' } as any);
  };
  const tok = await tokFor(acct, 'own'), tokH = await tokFor(hyb, 'hyb'), tokN = await tokFor(none, 'none'), tokO = await tokFor(other, 'oth');

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: unknown, t: string | null = tok) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let b: any = null; try { b = text ? JSON.parse(text) : null; } catch { b = text; }
    return { status: r.status, body: b };
  };
  const facts = (hostname: string) => ({ hostname, cpuCores: 4, memoryBytes: 8 * 2 ** 30, diskFreeBytes: 1e12, diskTotalBytes: 2e12, os: 'Linux', arch: 'x64', agentVersion: '0.5.0' });
  const host = async (siteId: string, name: string, t: string) => {
    const tk = await api('POST', `/api/sites/${siteId}/enrolment-tokens`, {}, t);
    const e = await api('POST', '/api/site-agent/enrol', { token: tk.body.token, host: facts(name) }, null);
    await api('POST', `/api/sites/${siteId}/hosts/${e.body.hostId}/approve`, {}, t);
    return { id: e.body.hostId as string, cred: e.body.credential as string };
  };

  console.log('== licences ==');
  let r = await api('GET', '/api/archive/targets', undefined, tokN);
  ok(r.status === 403 && r.body?.code === 'licence_required', 'no add-on: /api/archive refused', r);
  r = await api('GET', '/api/sites', undefined, tokN);
  ok(r.status === 403 && r.body?.code === 'licence_required', 'no add-on: /api/sites refused, as before', r.status);
  r = await api('GET', '/api/archive/targets', undefined, tokH);
  ok(r.status === 403 && r.body?.code === 'licence_required', 'Hybrid Sites alone does not open Mirror and Archive', r.status);
  r = await api('POST', '/api/sites', { name: 'NAS room' });
  ok(r.status === 201, 'Mirror and Archive alone can make a site', r);
  const site = r.body.id;
  const h = await host(site, 'nas-01', tok);
  ok(!!h.cred, 'and enrol and approve a host');
  r = await api('POST', '/api/site-agent/heartbeat', { host: facts('nas-01'), configVersion: null }, h.cred);
  ok(r.status === 200 && r.body.status === 'approved', 'its host heartbeats', r);
  r = await api('GET', '/api/site-agent/config', undefined, h.cred);
  ok(r.status === 200 && JSON.stringify(r.body.addOns) === '["mirror_archive"]' && r.body.watchfolders.length === 0 && r.body.pools.length === 1, 'its config names the add-on, a pool and no watchfolders', r.body);
  r = await api('GET', '/api/site-agent/watchfolders', undefined, h.cred);
  ok(r.status === 403 && r.body?.code === 'licence_required', 'on-prem watchfolders stay Hybrid Sites only', r);
  r = await fetch(base + '/api/site-agent/tus', { method: 'POST', headers: { authorization: `Bearer ${h.cred}`, 'tus-resumable': '1.0.0', 'upload-length': '10' } }).then((x) => ({ status: x.status }));
  ok(r.status === 403, 'and so do uploads from a site', r.status);
  const siteH = (await api('POST', '/api/sites', { name: 'Encoders' }, tokH)).body.id;
  const hH = await host(siteH, 'enc-01', tokH);

  console.log('== storage targets ==');
  const nas = mkdtempSync(join(tmpdir(), 'ma-nas-'));
  r = await api('POST', '/api/archive/targets', { name: 'Archive NAS', siteId: site, path: 'relative/folder' });
  ok(r.status === 400, 'a relative path is refused', r);
  r = await api('POST', '/api/archive/targets', { name: 'Archive NAS', siteId: site, path: '/mnt/../etc' });
  ok(r.status === 400, 'a path with .. is refused', r.status);
  r = await api('POST', '/api/archive/targets', { name: 'Archive NAS', siteId: site, path: nas, kind: 's3' });
  ok(r.status === 422 && r.body?.code === 'kind_not_available', 'only folder targets so far', r);
  r = await api('POST', '/api/archive/targets', { name: 'Archive NAS', siteId: siteH, path: nas });
  ok(r.status === 404, "another account's site is not found", r.status);
  r = await api('POST', '/api/archive/targets', { name: 'Archive NAS', siteId: site, path: nas, bandwidthMbps: 0 });
  ok(r.status === 400, 'a bandwidth cap of 0 is refused', r.status);
  r = await api('POST', '/api/archive/targets', { name: 'Archive NAS', siteId: site, path: nas });
  ok(r.status === 201 && r.body.kind === 'path' && r.body.path === nas && r.body.siteName === 'NAS room' && r.body.bandwidthMbps === null && r.body.status === 'active', 'a folder target is made', r.body);
  const target = r.body.id;
  r = await api('POST', '/api/archive/targets', { name: 'archive nas', siteId: site, path: nas });
  ok(r.status === 409, 'names are unique per account', r.status);
  r = await api('GET', '/api/archive/targets?limit=10');
  ok(r.status === 200 && r.body.items.length === 1 && r.body.items[0].id === target, 'listed', r.body);
  r = await api('GET', `/api/archive/targets/${target}`, undefined, tokO);
  ok(r.status === 404, 'another account cannot see it', r.status);
  r = await api('PATCH', `/api/archive/targets/${target}`, { bandwidthMbps: 500 });
  ok(r.status === 200 && r.body.bandwidthMbps === 500 && r.body.changed.includes('bandwidthMbps'), 'a cap can be set', r.body);
  const audit = await one<any>(`SELECT count(*)::int AS n FROM audit_log WHERE entity_type = 'archive_target' AND entity_id = $1`, [target]);
  ok(audit.n === 2, 'create and change are audited', audit);

  console.log('== a copy, end to end ==');
  const srcDir = join(process.env.CLIPS_DIR!, 'vod-src');
  mkdirSync(srcDir, { recursive: true });
  const mkAsset = async (a: string, file: string | null, body: Buffer | null, recordedSha?: string | null) => {
    let key: string | null = null;
    if (file && body) { key = join(srcDir, file); writeFileSync(key, body); }
    return (await one<any>(`INSERT INTO vod_assets (account_id, source_kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, source_key, sha256)
      VALUES ($1,'upload',$2,'/x',0,0,1,$3,$4) RETURNING id`, [a, file ?? 'none', key, recordedSha === undefined ? (body ? sha(body) : null) : recordedSha]))!.id as string;
  };
  const bytes1 = randomBytes(300_000);
  const asset1 = await mkAsset(acct, `Evening Show ${tag}.mp4`, bytes1);
  const noSource = await mkAsset(acct, null, null);
  const theirs = await mkAsset(other, `theirs-${tag}.mp4`, randomBytes(10));
  r = await api('POST', '/api/archive/copies', { targetId: target, vodAssetId: noSource });
  ok(r.status === 422 && r.body?.code === 'no_source', 'an asset with no original kept has nothing to archive', r);
  r = await api('POST', '/api/archive/copies', { targetId: target, vodAssetId: theirs });
  ok(r.status === 404, "another account's asset is not found", r.status);
  r = await api('POST', '/api/archive/copies', { targetId: target, vodAssetId: asset1 });
  ok(r.status === 202 && r.body.state === 'queued' && r.body.vodAssetId === asset1 && r.body.fileName === `EveningShow${tag}.mp4`, 'a copy is queued with a clean name', r.body);
  const copy1 = r.body.id;
  const row1 = await one<any>(`SELECT j.* FROM archive_copies c JOIN jobs j ON j.id = c.job_id WHERE c.id = $1`, [copy1]);
  ok(row1.type === 'archive.copy' && row1.pool === `site:${site}` && row1.payload.transfers[0].sha256 === sha(bytes1) && row1.payload.target.path === nas, 'as a job in the site\'s pool, carrying the original\'s checksum', row1);
  r = await api('POST', '/api/archive/copies', { targetId: target, vodAssetId: asset1 });
  ok(r.status === 200 && r.body.id === copy1, 'asking again while it is queued returns the same copy', r.status);
  ok((await one<any>(`SELECT count(*)::int AS n FROM jobs WHERE type = 'archive.copy' AND payload->>'copyId' = $1`, [copy1])).n === 1, 'and queues nothing more');

  // The Hybrid Sites host of another account never sees it, and a Hybrid
  // Sites-only site never leases archive work even in its own pool.
  r = await api('POST', '/api/site-agent/jobs/lease', {}, hH.cred);
  ok(r.status === 204, 'another account\'s host gets nothing', r.status);
  const strayArchive = await Q.enqueue({ type: 'archive.copy', payload: { copyId: '00000000-0000-0000-0000-000000000000' }, pool: Q.sitePool(siteH) });
  r = await api('POST', '/api/site-agent/jobs/lease', {}, hH.cred);
  ok(r.status === 204, 'a Hybrid Sites-only host never leases archive work', r.status);
  await Q.cancel(strayArchive.id);
  const strayOther = await Q.enqueue({ type: 'test.sitejob', payload: {}, pool: Q.sitePool(site) });
  r = await api('POST', '/api/site-agent/jobs/lease', { types: ['test.sitejob'] }, h.cred);
  ok(r.status === 204, 'a Mirror and Archive-only host never leases Hybrid Sites work', r.status);
  await Q.cancel(strayOther.id);

  const logs: string[] = [];
  const ctx = { server: base, credential: () => h.cred, log: (s: string) => logs.push(s), progressEveryMs: 50 };
  // Peek at what the host is told, as the agent would see it.
  const peek = await api('POST', '/api/site-agent/jobs/lease', { types: ['archive.copy'] }, h.cred);
  ok(peek.status === 200 && peek.body.transfers[0].name === 'source' && !JSON.stringify(peek.body).includes(srcDir), 'the host sees the transfer by name, never the original\'s address', peek.body);
  r = await api('POST', `/api/site-agent/jobs/${peek.body.id}/complete`, { leaseId: peek.body.leaseId, result: { storedPath: '../outside.mp4', sha256: sha(bytes1), bytes: bytes1.length } }, h.cred);
  ok(r.status === 400 && r.body?.code === 'bad_result', 'a host cannot report a path outside the target', r);
  r = await api('POST', `/api/site-agent/jobs/${peek.body.id}/fail`, { leaseId: peek.body.leaseId, error: 'test hand-back', code: 'test' }, h.cred);
  await query(`UPDATE jobs SET run_after = now() WHERE id = $1`, [peek.body.id]);
  let c = (await api('GET', `/api/archive/copies/${copy1}`)).body;
  ok(c.state === 'queued' && c.errorCode === 'test', 'a failed attempt keeps the copy queued, with why', c);

  let ran = await AG.archivePass(ctx);
  c = (await api('GET', `/api/archive/copies/${copy1}`)).body;
  const written = join(nas, `EveningShow${tag}.mp4`);
  ok(ran === 1 && existsSync(written) && readFileSync(written).equals(bytes1), 'the agent wrote the original into the folder', { ran, logs });
  ok(c.state === 'verified' && c.sha256 === sha(bytes1) && c.bytes === bytes1.length && c.storedPath === `EveningShow${tag}.mp4` && !!c.verifiedAt && !!c.copiedAt, 'read back, matched, verified', c);
  ok(!readdirSync(nas).some((f) => f.includes('.part-')), 'no partial file left behind');
  r = await api('POST', '/api/archive/copies', { targetId: target, vodAssetId: asset1 });
  ok(r.status === 200 && r.body.id === copy1 && r.body.state === 'verified', 'asking for a verified copy again returns it', r.body);

  console.log('== a clash, and the bandwidth cap ==');
  const bytes2 = randomBytes(250_000);
  const asset2 = await mkAsset(acct, `Evening Show ${tag}.mp4`.replace('.mp4', '.MP4'), bytes2);
  await api('PATCH', `/api/archive/targets/${target}`, { bandwidthMbps: 4 });
  r = await api('POST', '/api/archive/copies', { targetId: target, vodAssetId: asset2 });
  const copy2 = r.body.id;
  const t0 = Date.now();
  ran = await AG.archivePass(ctx);
  const took = Date.now() - t0;
  c = (await api('GET', `/api/archive/copies/${copy2}`)).body;
  ok(c.state === 'verified' && c.storedPath === `EveningShow${tag}-2.mp4` && readFileSync(join(nas, c.storedPath)).equals(bytes2), 'a taken name gets -2 and the first copy is untouched', c);
  ok(readFileSync(written).equals(bytes1), 'the first copy is unchanged');
  ok(took >= 400, `the 4 Mbit/s cap is kept (250 KB took ${took} ms, at least 500 expected less slack)`, took);
  const prog = await one<any>(`SELECT progress_note FROM jobs j JOIN archive_copies c ON c.job_id = j.id WHERE c.id = $1`, [copy2]);
  ok(/bytes copied/.test(prog?.progress_note ?? ''), 'progress was reported while copying (it keeps the lease)', prog);
  await api('PATCH', `/api/archive/targets/${target}`, { bandwidthMbps: null });

  console.log('== a corrupted copy is detected ==');
  const bytes3 = randomBytes(50_000);
  const asset3 = await mkAsset(acct, `Bad Sum ${tag}.mov`, bytes3, 'f'.repeat(64));
  r = await api('POST', '/api/archive/copies', { targetId: target, vodAssetId: asset3 });
  const copy3 = r.body.id;
  ran = await AG.archivePass(ctx);
  c = (await api('GET', `/api/archive/copies/${copy3}`)).body;
  ok(c.state === 'queued' && c.errorCode === 'checksum_mismatch' && !c.verifiedAt, 'a copy that does not match the original is refused, never verified', c);
  ok(!existsSync(join(nas, `BadSum${tag}.mov`)), 'and the agent removed it from the target', readdirSync(nas));
  let j3 = await one<any>(`SELECT j.state, j.attempts, j.error_code FROM jobs j JOIN archive_copies c ON c.job_id = j.id WHERE c.id = $1`, [copy3]);
  ok(j3.state === 'queued' && j3.attempts === 1 && j3.error_code === 'checksum_mismatch', 'the attempt is retried with backoff', j3);
  await query(`UPDATE jobs SET attempts = max_attempts - 1, run_after = now() FROM archive_copies c WHERE c.job_id = jobs.id AND c.id = $1`, [copy3]);
  ran = await AG.archivePass(ctx);
  c = (await api('GET', `/api/archive/copies/${copy3}`)).body;
  ok(c.state === 'failed' && c.errorCode === 'checksum_mismatch', 'when the attempts are spent the copy is failed', c);

  r = await api('POST', `/api/archive/copies/${copy3}/verify`);
  ok(r.status === 409 && r.body?.code === 'not_copied', 'a copy never made cannot be checked', r.status);
  r = await api('POST', `/api/archive/copies/${copy1}/verify`);
  ok(r.status === 202 && r.body.checking === true, 'a re-check is queued', r.body);
  r = await api('POST', `/api/archive/copies/${copy1}/verify`);
  ok(r.status === 200, 'and not twice', r.status);
  const before = c.checkedAt;
  ran = await AG.archivePass(ctx);
  c = (await api('GET', `/api/archive/copies/${copy1}`)).body;
  ok(ran === 1 && c.state === 'verified' && c.checkedAt && c.checking === false, 'an intact copy stays verified, with a new check time', c);
  const tampered = Buffer.from(bytes1); tampered[1000] ^= 0xff;
  writeFileSync(written, tampered);
  await api('POST', `/api/archive/copies/${copy1}/verify`);
  await AG.archivePass(ctx);
  c = (await api('GET', `/api/archive/copies/${copy1}`)).body;
  ok(c.state === 'corrupt' && c.errorCode === 'checksum_mismatch', 'a copy changed at the target is found corrupt', c);
  unlinkSync(join(nas, `EveningShow${tag}-2.mp4`));
  await api('POST', `/api/archive/copies/${copy2}/verify`);
  await AG.archivePass(ctx);
  c = (await api('GET', `/api/archive/copies/${copy2}`)).body;
  ok(c.state === 'missing' && c.errorCode === 'missing', 'a copy gone from the target is found missing', c);
  r = await api('POST', '/api/archive/copies', { targetId: target, vodAssetId: asset1 });
  ok(r.status === 202 && r.body.id === copy1 && r.body.state === 'queued', 'a corrupt copy can be made again (same record)', r.body);
  await AG.archivePass(ctx);
  c = (await api('GET', `/api/archive/copies/${copy1}`)).body;
  ok(c.state === 'verified' && c.storedPath === `EveningShow${tag}-2.mp4`, 'the fresh copy is verified, beside the damaged file (never over it)', c);

  console.log('== the folder is not there ==');
  rmSync(nas, { recursive: true, force: true });
  const asset4 = await mkAsset(acct, `Later ${tag}.mp4`, randomBytes(1000));
  const copy4 = (await api('POST', '/api/archive/copies', { targetId: target, vodAssetId: asset4 })).body.id;
  await AG.archivePass(ctx);
  c = (await api('GET', `/api/archive/copies/${copy4}`)).body;
  j3 = await one<any>(`SELECT j.state FROM jobs j JOIN archive_copies c ON c.job_id = j.id WHERE c.id = $1`, [copy4]);
  ok(c.state === 'queued' && c.errorCode === 'target_unavailable' && j3.state === 'queued' && !existsSync(nas), 'an unmounted folder is a retry, and no folder is made', { c, j3 });

  console.log('== lists, disable, withdraw ==');
  r = await api('GET', `/api/archive/copies?vod_asset_id=${asset1}`);
  ok(r.status === 200 && r.body.items.length === 1 && r.body.items[0].id === copy1, 'copies filter by asset', r.body);
  r = await api('GET', '/api/archive/copies?state=failed');
  ok(r.status === 200 && r.body.items.length === 1 && r.body.items[0].id === copy3, 'and by state', r.body.items?.length);
  r = await api('GET', '/api/archive/copies', undefined, tokO);
  ok(r.status === 200 && r.body.items.length === 0, 'another account sees none of them');
  r = await api('PATCH', `/api/archive/targets/${target}`, { path: '/mnt/elsewhere' });
  ok(r.status === 409 && r.body?.code === 'target_in_use', 'a target holding copies keeps its folder', r.status);
  await api('PATCH', `/api/archive/targets/${target}`, { status: 'disabled' });
  r = await api('POST', '/api/archive/copies', { targetId: target, vodAssetId: asset2 });
  ok(r.status === 409 && r.body?.code === 'target_disabled', 'a disabled target takes no new copies', r.status);
  await query(`UPDATE accounts SET licences = '{}' WHERE id = $1`, [acct]);
  r = await api('POST', '/api/site-agent/jobs/lease', {}, h.cred);
  ok(r.status === 403 && r.body?.code === 'licence_required', 'with the add-on withdrawn the host is refused', r.status);
  ok((await one<any>(`SELECT count(*)::int AS n FROM archive_copies WHERE account_id = $1`, [acct])).n === 4, 'and nothing was deleted');

  srv.close();
  await pool.end();
  console.log(`\nmirror-archive: ${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
