// ============================================================================
//  RESTORE AN ORIGINAL TO THE CLOUD (build queue H3-5b; services/archive/
//  originals.ts, the agent's runRestore in volt-agent/src/siteArchive.ts).
//
//  Through the real API on a real database, with the REAL site agent code
//  reading the archive copy from a folder that stands in for the NAS and
//  uploading it back:
//    - an original copied by the agent and taken out of the cloud by the rule;
//    - restore: refused for an original still in the cloud, without the
//      licence, for another account, and from a copy that is not verified;
//      queued in the copy's site, once (asking again joins it); an older agent
//      that does not know the job never leases it;
//    - the agent uploads the copy, the cloud reads it back against the
//      archived checksum, the asset points at it again (same address, same
//      bytes), the list no longer shows it, an audit entry says so;
//    - the rung's clock restarts at the restore: the next pass keeps it;
//    - a copy changed at the NAS is not uploaded: the restore fails with the
//      reason on the asset, the copy row is left alone;
//    - bytes in the cloud that do not match are removed and the attempt fails;
//    - the Workflows map counts the job with the archive copies.
//
//  Usage: DATABASE_URL=... npx tsx test/retention-originals-restore.check.ts
// ============================================================================
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

(async () => {
  process.env.CLIPS_DIR ||= mkdtempSync(join(tmpdir(), 'rtr-clips-'));
  const AG = await import('../../volt-agent/src/siteArchive');
  const O = await import('../src/services/archive/originals');
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');

  const tag = Date.now().toString(36);
  const mkAcct = async (n: string, lic: string[]) => (await one<any>(`INSERT INTO accounts(name, licences) VALUES ($1, $2) RETURNING id`, [`${n}-${tag}`, lic]))!.id;
  const acct = await mkAcct('rtr', ['mirror_archive']);
  const other = await mkAcct('rtr-o', ['mirror_archive']);
  const none = await mkAcct('rtr-n', []);
  const tokFor = async (a: string, n: string) => {
    const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `${n}-${tag}@example.com`]))!.id;
    return signAccess({ sub: u, account_id: a, role: 'owner' } as any);
  };
  const tok = await tokFor(acct, 'own'), tokO = await tokFor(other, 'oth'), tokN = await tokFor(none, 'none');
  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: unknown, t: string | null = tok) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let b: any = null; try { b = text ? JSON.parse(text) : null; } catch { b = text; }
    return { status: r.status, body: b };
  };
  const facts = (hostname: string) => ({ hostname, cpuCores: 4, memoryBytes: 8 * 2 ** 30, diskFreeBytes: 1e12, diskTotalBytes: 2e12, os: 'Linux', arch: 'x64', agentVersion: '0.12.0' });
  const site = (await api('POST', '/api/sites', { name: 'NAS room' })).body.id;
  const tk = await api('POST', `/api/sites/${site}/enrolment-tokens`, {});
  const e = await api('POST', '/api/site-agent/enrol', { token: tk.body.token, host: facts('nas-01') }, null);
  await api('POST', `/api/sites/${site}/hosts/${e.body.hostId}/approve`, {});
  const cred = e.body.credential as string;
  const logs: string[] = [];
  const ctx = { server: base, credential: () => cred, log: (s: string) => logs.push(s), progressEveryMs: 50 };
  const nas = mkdtempSync(join(tmpdir(), 'rtr-nas-'));
  const target = (await api('POST', '/api/archive/targets', { name: 'Archive NAS', siteId: site, path: nas })).body.id;

  const srcDir = join(process.env.CLIPS_DIR!, 'vod-src');
  mkdirSync(srcDir, { recursive: true });
  const mkAsset = async (a: string, name: string, ageDays: number) => {
    const body = randomBytes(300_000);
    const key = join(srcDir, `${name}-${tag}.mp4`); writeFileSync(key, body);
    const id = (await one<any>(`INSERT INTO vod_assets (account_id, source_kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, source_key, sha256, created_at)
      VALUES ($1,'upload',$2,'/x',0,0,1,$3,$4, now() - make_interval(days => $5)) RETURNING id`, [a, name, key, sha(body), ageDays]))!.id as string;
    return { id, key, body };
  };
  const row = (id: string) => one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [id]);

  console.log('== an original archived, then taken out of the cloud ==');
  let r = await api('PUT', '/api/storage/retention', { name: 'Default', stages: [{ afterDays: 3650, action: 'delete' }], originalAfterDays: 30 });
  ok(r.status === 200 && r.body.original_after_days === 30, 'the rule takes originals out after 30 days', r.body);
  const one1 = await mkAsset(acct, 'Harbour', 40);
  const two = await mkAsset(acct, 'Valley', 40);
  const kept = await mkAsset(acct, 'Kept', 5);
  for (const a of [one1, two]) await api('POST', '/api/archive/copies', { targetId: target, vodAssetId: a.id });
  await AG.archivePass(ctx);
  const copies = (await api('GET', '/api/archive/copies')).body.items;
  ok(copies.length === 2 && copies.every((c: any) => c.state === 'verified'), 'the agent made two verified copies at the NAS', { copies, logs });
  const res = await O.sweepOriginals({ accountId: acct, actor: 'test' });
  ok(res.removed === 2 && !existsSync(one1.key) && !existsSync(two.key), 'the pass took both originals out of the cloud', res);
  let st = (await api('GET', `/api/archive/originals/${one1.id}`)).body;
  ok(st.state === 'removed' && st.restorable === true && st.restoring === false, 'the status says it can be restored', st);

  console.log('== asking for a restore ==');
  r = await api('POST', `/api/archive/originals/${kept.id}/restore`);
  ok(r.status === 409 && r.body?.code === 'not_removed', 'an original still in the cloud: nothing to restore (409 not_removed)', r);
  r = await api('POST', `/api/archive/originals/${one1.id}/restore`, {}, tokN);
  ok(r.status === 403 && r.body?.code === 'licence_required', 'without Mirror and Archive: 403', r.status);
  r = await api('POST', `/api/archive/originals/${one1.id}/restore`, {}, tokO);
  ok(r.status === 404, "another account's asset: 404", r.status);
  // An older agent (it does not list archive.restore) never takes the job.
  r = await api('POST', `/api/archive/originals/${one1.id}/restore`);
  ok(r.status === 202 && r.body.state === 'removed' && r.body.restoring === true && r.body.jobId, 'queued (202), the status says it is being restored', r.body);
  const jobId = r.body.jobId;
  const job = await one<any>(`SELECT type, pool, payload FROM jobs WHERE id = $1`, [jobId]);
  ok(job.type === 'archive.restore' && job.pool === `site:${site}` && job.payload.transfers[0].direction === 'upload' && job.payload.sha256 === sha(one1.body),
    "an archive.restore job in the copy's site, one upload held to the archived checksum", job);
  r = await api('POST', `/api/archive/originals/${one1.id}/restore`);
  ok(r.status === 200 && r.body.jobId === jobId, 'asking again joins the restore in flight (200, same job)', r.body);
  const old = await api('POST', '/api/site-agent/jobs/lease', { types: ['archive.copy', 'archive.verify', 'archive.copy-folder', 'archive.verify-folder'] }, cred);
  ok(old.status === 204, 'an older agent that does not know restores leases nothing', old.status);
  let list = (await api('GET', '/api/archive/originals')).body.items;
  ok(list.find((i: any) => i.vodAssetId === one1.id)?.restoring === true, 'the list shows it being restored');
  ok(AG.ARCHIVE_JOB_TYPES.includes('archive.restore'), 'this agent leases restores');

  console.log('== the agent uploads the copy ==');
  let ran = await AG.archivePass(ctx);
  let a = await row(one1.id);
  ok(ran === 1 && existsSync(one1.key) && readFileSync(one1.key).equals(one1.body), 'the original is back at its address, the same bytes', { ran, logs: logs.slice(-3) });
  ok(a.source_key === one1.key && !a.original_removed_at && !a.original_removed_key && !a.original_copy_id && a.original_restored_at && !a.original_restore_job_id,
    'the asset points at it again, the removed columns cleared, the restore time kept', a);
  ok((await one<any>(`SELECT state FROM jobs WHERE id = $1`, [jobId]))!.state === 'succeeded', 'the job succeeded');
  const audit = await one<any>(`SELECT * FROM audit_log WHERE entity_type = 'vod_original' AND entity_id = $1 AND detail::text LIKE '%restored%'`, [one1.id]);
  ok(!!audit, 'an audit entry records the restore');
  list = (await api('GET', '/api/archive/originals')).body.items;
  ok(!list.some((i: any) => i.vodAssetId === one1.id), 'it leaves the list of originals out of the cloud');
  const c1 = (await one<any>(`SELECT stored_path, state FROM archive_copies WHERE vod_asset_id = $1`, [one1.id]))!;
  ok(c1.state === 'verified' && readFileSync(join(nas, c1.stored_path)).equals(one1.body), 'the copy at the NAS is untouched', c1);

  console.log('== the clock restarts at the restore ==');
  await O.sweepOriginals({ accountId: acct, actor: 'test' });
  st = (await api('GET', `/api/archive/originals/${one1.id}`)).body;
  ok(existsSync(one1.key) && st.state === 'scheduled' && new Date(st.dueAt).getTime() > Date.now() + 29 * 86400_000, 'the next pass keeps it: due 30 days after the restore', st);

  console.log('== a copy changed at the NAS ==');
  const twoCopy = (await one<any>(`SELECT stored_path, state FROM archive_copies WHERE vod_asset_id = $1`, [two.id]))!;
  writeFileSync(join(nas, twoCopy.stored_path), randomBytes(300_000));
  r = await api('POST', `/api/archive/originals/${two.id}/restore`);
  ok(r.status === 202, 'the restore is queued (the cloud does not know yet)', r.status);
  ran = await AG.archivePass(ctx);
  a = await row(two.id);
  ok(ran === 1 && !existsSync(two.key) && a.original_removed_at && /no longer matches/.test(a.original_restore_error ?? ''), 'the agent refuses to upload it; the reason is on the asset', { a, logs: logs.slice(-2) });
  const c2 = (await one<any>(`SELECT state, error FROM archive_copies WHERE vod_asset_id = $1`, [two.id]))!;
  ok(c2.state === 'verified' && !c2.error, 'the copy row is left alone (a re-check finds it corrupt)', c2);
  list = (await api('GET', '/api/archive/originals')).body.items;
  const li = list.find((i: any) => i.vodAssetId === two.id);
  ok(li && li.restoring === false && /no longer matches/.test(li.restoreError ?? ''), 'the list shows the last restore failed, with why', li);

  console.log('== a copy that is not verified ==');
  await query(`UPDATE archive_copies SET state = 'missing' WHERE vod_asset_id = $1`, [two.id]);
  r = await api('POST', `/api/archive/originals/${two.id}/restore`);
  ok(r.status === 409 && r.body?.code === 'copy_not_verified' && /missing/.test(r.body.error ?? r.body.message ?? ''), 'restore from a missing copy is refused (409 copy_not_verified)', r);

  console.log('== bytes in the cloud that do not match ==');
  const three = await mkAsset(acct, 'Third', 40);
  const fake = { id: '00000000-0000-4000-8000-000000000001', payload: { vodAssetId: three.id, copyId: null, sha256: sha(three.body), transfers: [{ name: 'restore', direction: 'upload', uri: three.key }] } } as any;
  await query(`UPDATE vod_assets SET source_key = NULL, original_removed_at = now(), original_removed_key = $2 WHERE id = $1`, [three.id, three.key]);
  writeFileSync(three.key, randomBytes(1000));
  let v: any = await O.judgeRestore(fake, { sha256: sha(three.body) });
  ok(!v.ok && v.code === 'checksum_mismatch' && !existsSync(three.key), 'other bytes at the address: refused and removed', v);
  v = await O.judgeRestore(fake, { sha256: sha(three.body) });
  ok(!v.ok && v.code === 'not_uploaded', 'nothing there: refused (not_uploaded)', v);
  writeFileSync(three.key, three.body);
  v = await O.judgeRestore(fake, { sha256: 'zz' });
  ok(!v.ok && v.status === 400, 'a result without a checksum is a bad result (400)', v);
  v = await O.judgeRestore(fake, { sha256: sha(three.body) });
  ok(v.ok, 'the right bytes: accepted', v);
  await v.apply();
  ok((await row(three.id)).source_key === three.key, 'and the asset points at them');

  console.log('== wiring ==');
  const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
  ok(/'archive\.restore': 'archive'/.test(src('src/services/workflows/map.ts')), 'the Workflows map counts restores with the archive copies');

  srv.close();
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

