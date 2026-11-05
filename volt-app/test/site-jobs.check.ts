// ============================================================================
//  HYBRID SITES 3a: THE JOB LEASE (build queue H3, HYBRID_SITES.md).
//
//  Through the real API on a real database:
//    - pools: a cloud worker never claims a site's job, a site never leases
//      cloud work, and the in-process claim is otherwise unchanged;
//    - lease: an approved host takes the next job of its own site's pool,
//      sees transfer names and never their addresses; a pending host, a
//      console session and a made-up credential are refused;
//    - wrong pool: another site of the same account gets nothing and its
//      calls on the job answer 404; another account likewise;
//    - progress extends the lease, bounds checked; complete and fail (retry
//      with backoff, permanent, attempts spent); a cancelled job;
//    - lease expiry and the reaper: a quiet host's lease is taken back, the
//      job goes to another host, the old lease can no longer progress,
//      complete or fail it, and each attempt is recorded;
//    - transfer URLs: one object a job lists, never one the host names;
//      signed API URLs for files on this server (download, upload with its
//      checksum, tampered, expired, after the lease ended); S3 presigned
//      URLs for one key (a prefix refused), round-tripped through a real S3
//      API when MOTO_URL is set;
//    - the licence withdrawn stops the lease.
//
//  Usage: DATABASE_URL=... npx tsx test/site-jobs.check.ts
//         (MOTO_URL=http://127.0.0.1:5000 for the S3 round trip)
// ============================================================================
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };

(async () => {
  if (process.env.MOTO_URL) {
    process.env.AWS_ENDPOINT_URL_S3 = process.env.MOTO_URL;
    process.env.S3_FORCE_PATH_STYLE = '1';
    process.env.AWS_ACCESS_KEY_ID ||= 'testing';
    process.env.AWS_SECRET_ACCESS_KEY ||= 'testing';
  }
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const Q = await import('../src/services/jobs/queue');
  const J = await import('../src/services/sites/siteJobs');

  console.log('== transfer tokens (pure) ==');
  const t0 = J.signTransfer({ j: 'a', l: 'b', n: 'c', e: Math.floor(Date.now() / 1000) + 60 });
  ok(J.verifyTransfer(t0).n === 'c', 'a signed transfer verifies');
  const thr = (f: () => unknown) => { try { f(); return null; } catch (e: any) { return e; } };
  const [b0, s0] = t0.split('.');
  const forged = Buffer.from(JSON.stringify({ j: 'a', l: 'b', n: 'other', e: Math.floor(Date.now() / 1000) + 60 })).toString('base64url') + '.' + s0;
  ok(thr(() => J.verifyTransfer(forged))?.code === 'transfer_invalid', 'a changed claim with the old signature is refused');
  ok(thr(() => J.verifyTransfer(b0))?.code === 'transfer_invalid' && thr(() => J.verifyTransfer('x.y'))?.code === 'transfer_invalid', 'no signature, or junk, refused');
  ok(thr(() => J.verifyTransfer(J.signTransfer({ j: 'a', l: 'b', n: 'c', e: Math.floor(Date.now() / 1000) - 1 })))?.code === 'transfer_expired', 'an expired one is refused');
  ok(J.transfersOf({ payload: { transfers: [{ name: 'a', direction: 'download', uri: '/x' }, { name: 'b', direction: 'sideways', uri: '/y' }, { name: 'c', direction: 'upload' }] } } as any).map((t) => t.name).join() === 'a', 'only well-formed transfers count');

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name, licences) VALUES ($1, '{hybrid_sites}') RETURNING id`, [`sj-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name, licences) VALUES ($1, '{hybrid_sites}') RETURNING id`, [`sj-b-${tag}`]))!.id;
  const mkUser = async (a: string, n: string) => (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `${n}-${tag}@example.com`]))!.id;
  const tok = signAccess({ sub: await mkUser(acct, 'own'), account_id: acct, role: 'owner' } as any);
  const tokB = signAccess({ sub: await mkUser(other, 'ownb'), account_id: other, role: 'owner' } as any);

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: unknown, t: string | null = tok) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let b: any = null; try { b = text ? JSON.parse(text) : null; } catch { b = text; }
    return { status: r.status, body: b };
  };
  const facts = (hostname: string) => ({ hostname, cpuCores: 8, memoryBytes: 16 * 2 ** 30, diskFreeBytes: 1e12, diskTotalBytes: 2e12, os: 'Linux', arch: 'x64', agentVersion: '0.4.0' });
  const host = async (siteId: string, name: string, t: string, approve = true) => {
    const tk = await api('POST', `/api/sites/${siteId}/enrolment-tokens`, {}, t);
    const e = await api('POST', '/api/site-agent/enrol', { token: tk.body.token, host: facts(name) }, null);
    if (approve) await api('POST', `/api/sites/${siteId}/hosts/${e.body.hostId}/approve`, {}, t);
    return { id: e.body.hostId as string, cred: e.body.credential as string };
  };

  const siteA = (await api('POST', '/api/sites', { name: 'Main' })).body.id;
  const siteA2 = (await api('POST', '/api/sites', { name: 'Second' })).body.id;
  const siteB = (await api('POST', '/api/sites', { name: 'Theirs' }, tokB)).body.id;
  const h1 = await host(siteA, 'enc-01', tok);
  const h2 = await host(siteA, 'enc-02', tok);
  const hPending = await host(siteA, 'enc-03', tok, false);
  const hA2 = await host(siteA2, 'second-01', tok);
  const hB = await host(siteB, 'theirs-01', tokB);
  ok(!!h1.cred && !!h2.cred && !!hA2.cred && !!hB.cred, 'sites and approved hosts in place');

  console.log('== pools ==');
  ok(Q.sitePool(siteA) === `site:${siteA}`, 'a site pool is named after its site');
  const cloudJob = await Q.enqueue({ type: 'test.sitejob', payload: { n: 'cloud' } });
  const siteJob = await Q.enqueue({ type: 'test.sitejob', payload: { n: 'site' }, pool: Q.sitePool(siteA) });
  ok(cloudJob.pool === null && siteJob.pool === `site:${siteA}`, 'a job with no pool is cloud work; a site job carries its pool', [cloudJob.pool, siteJob.pool]);
  const cloudClaim = await Q.claim(['test.sitejob'], 'cloud-worker-1');
  ok(cloudClaim?.id === cloudJob.id, 'the cloud worker claims the cloud job', cloudClaim?.id);
  ok((await Q.claim(['test.sitejob'], 'cloud-worker-1')) === null, "and never the site's job, though it handles the type");
  await Q.succeed(cloudJob.id, {});
  let threw = false; try { await Q.claimInPool('', null, 'x'); } catch { threw = true; }
  ok(threw, 'claimInPool needs a pool (cloud work is never leased remotely)');

  console.log('== lease ==');
  let r = await api('POST', '/api/site-agent/jobs/lease', {}, hPending.cred);
  ok(r.status === 403 && r.body?.code === 'waiting_for_approval', 'a pending host is refused', r);
  r = await api('POST', '/api/site-agent/jobs/lease', {}, tok);
  ok(r.status === 401, 'a console session cannot lease', r.status);
  r = await api('POST', '/api/site-agent/jobs/lease', {}, 'vsite_forged');
  ok(r.status === 401, 'a made-up credential cannot lease', r.status);
  r = await api('POST', '/api/site-agent/jobs/lease', { types: 'all' }, h1.cred);
  ok(r.status === 400, 'types must be a list', r.status);
  r = await api('POST', '/api/site-agent/jobs/lease', {}, hA2.cred);
  ok(r.status === 204, 'another site of the same account gets nothing', r.status);
  r = await api('POST', '/api/site-agent/jobs/lease', {}, hB.cred);
  ok(r.status === 204, 'another account gets nothing', r.status);
  r = await api('POST', '/api/site-agent/jobs/lease', { types: ['mirror.copy'] }, h1.cred);
  ok(r.status === 204, 'a host asking only for other types gets nothing', r.status);
  r = await api('POST', '/api/site-agent/jobs/lease', { types: ['test.sitejob'] }, h1.cred);
  ok(r.status === 200 && r.body.id === siteJob.id && r.body.attempt === 1 && r.body.payload.n === 'site' && r.body.leaseSeconds === Q.LEASE_SECONDS && /^site-host:/.test(r.body.leaseId) && r.body.leaseId.includes(h1.id), 'an approved host leases its site\'s job', r.body);
  const lease1 = r.body.leaseId;
  r = await api('POST', '/api/site-agent/jobs/lease', {}, h2.cred);
  ok(r.status === 204, 'a leased job is not handed out twice', r.status);
  const row1 = await one<any>(`SELECT state, claimed_by FROM jobs WHERE id = $1`, [siteJob.id]);
  ok(row1.state === 'running' && row1.claimed_by === lease1, 'the job runs under that lease', row1);

  console.log('== wrong pool, other account, wrong lease ==');
  for (const [who, cred] of [['another site', hA2.cred], ['another account', hB.cred]] as const) {
    for (const verb of ['progress', 'complete', 'fail', 'transfer-url']) {
      r = await api('POST', `/api/site-agent/jobs/${siteJob.id}/${verb}`, { leaseId: lease1, name: 'x' }, cred);
      ok(r.status === 404, `${who}: ${verb} answers 404, as for an unknown job`, r.status);
    }
  }
  r = await api('POST', `/api/site-agent/jobs/${cloudJob.id}/progress`, { leaseId: lease1 }, h1.cred);
  ok(r.status === 404, 'a cloud job is not reachable through the site API', r.status);
  r = await api('POST', '/api/site-agent/jobs/not-a-uuid/progress', { leaseId: lease1 }, h1.cred);
  ok(r.status === 404, 'a malformed id is 404', r.status);
  r = await api('POST', `/api/site-agent/jobs/${siteJob.id}/progress`, {}, h1.cred);
  ok(r.status === 400, 'the lease id is required', r.status);
  r = await api('POST', `/api/site-agent/jobs/${siteJob.id}/progress`, { leaseId: 'site-host:someone-else' }, h2.cred);
  ok(r.status === 409 && r.body.code === 'lease_lost', 'another host of the site, not holding the lease, is refused', r);

  console.log('== progress ==');
  await query(`UPDATE jobs SET lease_until = now() + interval '5 seconds' WHERE id = $1`, [siteJob.id]);
  r = await api('POST', `/api/site-agent/jobs/${siteJob.id}/progress`, { leaseId: lease1, pct: 40, note: 'copying' }, h1.cred);
  const row2 = await one<any>(`SELECT progress_pct, progress_note, extract(epoch from lease_until - now()) AS left FROM jobs WHERE id = $1`, [siteJob.id]);
  ok(r.status === 200 && row2.progress_pct === 40 && row2.progress_note === 'copying' && Number(row2.left) > Q.LEASE_SECONDS - 10, 'progress is recorded and extends the lease', row2);
  r = await api('POST', `/api/site-agent/jobs/${siteJob.id}/progress`, { leaseId: lease1, pct: 140 }, h1.cred);
  ok(r.status === 400, 'pct out of range refused', r.status);

  console.log('== lease expiry and the reaper ==');
  await query(`UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [siteJob.id]);
  const reaped = await Q.reapExpiredLeases();
  const row3 = await one<any>(`SELECT state, claimed_by, error_code FROM jobs WHERE id = $1`, [siteJob.id]);
  ok(reaped >= 1 && row3.state === 'queued' && row3.claimed_by === null && row3.error_code === 'lease_expired', 'a quiet host\'s lease is reaped and the job queued again', row3);
  r = await api('POST', `/api/site-agent/jobs/${siteJob.id}/progress`, { leaseId: lease1, pct: 50 }, h1.cred);
  ok(r.status === 409 && r.body.code === 'lease_lost', 'the old lease can no longer report progress', r);
  r = await api('POST', '/api/site-agent/jobs/lease', {}, h2.cred);
  ok(r.status === 200 && r.body.id === siteJob.id && r.body.attempt === 2 && r.body.leaseId !== lease1 && r.body.leaseId.includes(h2.id), 'another host of the site takes it, attempt 2', r.body);
  const lease2 = r.body.leaseId;
  r = await api('POST', `/api/site-agent/jobs/${siteJob.id}/complete`, { leaseId: lease1, result: { stale: true } }, h1.cred);
  ok(r.status === 409 && r.body.code === 'lease_lost', 'the old lease cannot complete it', r);
  r = await api('POST', `/api/site-agent/jobs/${siteJob.id}/fail`, { leaseId: lease1, error: 'late' }, h1.cred);
  ok(r.status === 409, 'nor fail it', r.status);
  r = await api('POST', `/api/site-agent/jobs/${siteJob.id}/complete`, { leaseId: lease2, result: { copied: 3 } }, h2.cred);
  const row4 = await one<any>(`SELECT state, result, progress_pct FROM jobs WHERE id = $1`, [siteJob.id]);
  ok(r.status === 200 && row4.state === 'succeeded' && row4.result.copied === 3 && row4.progress_pct === 100, 'the current holder completes it with its result', row4);
  const atts = await query<any>(`SELECT attempt, claimed_by, outcome, error_code FROM job_attempts WHERE job_id = $1 ORDER BY attempt`, [siteJob.id]);
  ok(atts.length === 2 && atts[0].outcome === 'lease_expired' && atts[0].claimed_by === lease1 && atts[1].outcome === 'succeeded' && atts[1].claimed_by === lease2, 'both attempts recorded with who held them', atts);
  r = await api('POST', `/api/site-agent/jobs/${siteJob.id}/complete`, { leaseId: lease2 }, h2.cred);
  ok(r.status === 409 && r.body.code === 'lease_lost', 'a finished job cannot be completed again', r);

  console.log('== fail: retry, permanent, attempts spent ==');
  const fj = await Q.enqueue({ type: 'test.sitejob', payload: {}, pool: Q.sitePool(siteA), maxAttempts: 2 });
  r = await api('POST', '/api/site-agent/jobs/lease', {}, h1.cred);
  r = await api('POST', `/api/site-agent/jobs/${fj.id}/fail`, { leaseId: r.body.leaseId, error: 'NAS not mounted', code: 'target_offline' }, h1.cred);
  const row5 = await one<any>(`SELECT state, last_error, error_code, run_after > now() AS later FROM jobs WHERE id = $1`, [fj.id]);
  ok(r.status === 200 && r.body.state === 'queued' && r.body.retryAfter && row5.later && row5.error_code === 'target_offline' && row5.last_error === 'NAS not mounted', 'a failure is retried after a backoff, with its reason and code', row5);
  r = await api('POST', '/api/site-agent/jobs/lease', {}, h1.cred);
  ok(r.status === 204, 'not before the backoff', r.status);
  await query(`UPDATE jobs SET run_after = now() WHERE id = $1`, [fj.id]);
  r = await api('POST', '/api/site-agent/jobs/lease', {}, h1.cred);
  r = await api('POST', `/api/site-agent/jobs/${fj.id}/fail`, { leaseId: r.body.leaseId, error: 'still offline', code: 'Bad Code!' }, h1.cred);
  const row6 = await one<any>(`SELECT state, error_code FROM jobs WHERE id = $1`, [fj.id]);
  ok(r.body.state === 'failed' && row6.state === 'failed' && row6.error_code === 'site_error', 'attempts spent: failed (a code that is not a plain word becomes site_error)', row6);
  const pj = await Q.enqueue({ type: 'test.sitejob', payload: {}, pool: Q.sitePool(siteA), maxAttempts: 5 });
  r = await api('POST', '/api/site-agent/jobs/lease', {}, h1.cred);
  r = await api('POST', `/api/site-agent/jobs/${pj.id}/fail`, { leaseId: r.body.leaseId, error: 'checksum mismatch', code: 'checksum_mismatch', permanent: true }, h1.cred);
  ok(r.body.state === 'failed', 'a permanent failure is not retried', r.body);

  console.log('== cancelled ==');
  const cj = await Q.enqueue({ type: 'test.sitejob', payload: {}, pool: Q.sitePool(siteA) });
  r = await api('POST', '/api/site-agent/jobs/lease', {}, h1.cred);
  const leaseC = r.body.leaseId;
  await Q.cancel(cj.id);
  r = await api('POST', `/api/site-agent/jobs/${cj.id}/progress`, { leaseId: leaseC, pct: 10 }, h1.cred);
  ok(r.status === 409 && r.body.code === 'lease_lost' && /cancelled/.test(r.body.error ?? r.body.message ?? ''), 'a cancelled job tells its host to stop', r.body);

  console.log('== transfer URLs: files on this server ==');
  const dir = mkdtempSync(join(tmpdir(), 'site-jobs-'));
  const src = join(dir, 'src', 'programme.mxf');
  require('node:fs').mkdirSync(join(dir, 'src'), { recursive: true });
  const srcBytes = Buffer.from('volt'.repeat(50_000));
  writeFileSync(src, srcBytes);
  const upBytes = Buffer.from('restored copy '.repeat(10_000));
  const upSha = createHash('sha256').update(upBytes).digest('hex');
  const dest = join(dir, 'restore', 'programme.mxf');
  const checked = join(dir, 'restore', 'checked.mxf');
  const tj = await Q.enqueue({ type: 'test.sitejob', pool: Q.sitePool(siteA), payload: { transfers: [
    { name: 'source', direction: 'download', uri: src, bytes: srcBytes.length },
    { name: 'restore', direction: 'upload', uri: dest },
    { name: 'checked', direction: 'upload', uri: checked, sha256: upSha },
  ] } });
  r = await api('POST', '/api/site-agent/jobs/lease', {}, h1.cred);
  const leaseT = r.body.leaseId;
  ok(r.body.id === tj.id && r.body.transfers.length === 3 && r.body.transfers[0].name === 'source' && r.body.transfers[0].bytes === srcBytes.length && !JSON.stringify(r.body).includes(dir), 'the host sees transfer names and sizes, never the paths', r.body);
  r = await api('POST', `/api/site-agent/jobs/${tj.id}/transfer-url`, { leaseId: leaseT, name: 'elsewhere' }, h1.cred);
  ok(r.status === 404, 'a transfer the job does not list is refused', r.status);
  r = await api('POST', `/api/site-agent/jobs/${tj.id}/transfer-url`, { leaseId: leaseT, name: 'source', uri: '/etc/passwd' }, h1.cred);
  ok(r.status === 200 && r.body.via === 'api' && r.body.method === 'GET' && r.body.url.startsWith('/api/site-agent/transfers/') && new Date(r.body.expiresAt).getTime() > Date.now(), 'a download URL for the named object (a path the host sends is ignored)', r.body);
  const dl = r.body.url;
  let g = await fetch(base + dl);
  let got = Buffer.from(await g.arrayBuffer());
  ok(g.status === 200 && got.equals(srcBytes), 'the download URL gives the bytes, with no credential', [g.status, got.length]);
  g = await fetch(base + dl, { method: 'PUT', body: 'x' });
  ok(g.status === 405, 'a download URL does not take an upload', g.status);
  const [db0, ds0] = dl.split('/').pop()!.split('.');
  g = await fetch(base + `/api/site-agent/transfers/${db0}.${ds0.slice(0, -2)}AA`);
  ok(g.status === 403, 'a tampered URL is refused', g.status);
  r = await api('POST', `/api/site-agent/jobs/${tj.id}/transfer-url`, { leaseId: leaseT, name: 'restore' }, h1.cred);
  ok(r.body.method === 'PUT', 'an upload URL is a PUT', r.body);
  g = await fetch(base + r.body.url, { method: 'PUT', body: upBytes });
  let gb: any = await g.json();
  ok(g.status === 201 && gb.bytes === upBytes.length && gb.sha256 === upSha && readFileSync(dest).equals(upBytes), 'the upload lands whole, with its size and SHA-256', gb);
  ok(!readdirSync(join(dir, 'restore')).some((f) => f.includes('.part-')), 'no part file left behind');
  r = await api('POST', `/api/site-agent/jobs/${tj.id}/transfer-url`, { leaseId: leaseT, name: 'checked' }, h1.cred);
  g = await fetch(base + r.body.url, { method: 'PUT', body: Buffer.from('not the bytes') });
  gb = await g.json();
  ok(g.status === 422 && gb.code === 'checksum_mismatch' && !existsSync(checked), 'an upload that does not match the expected checksum is refused and not kept', [g.status, gb]);
  g = await fetch(base + r.body.url, { method: 'PUT', body: upBytes });
  ok(g.status === 201 && readFileSync(checked).equals(upBytes), 'the matching bytes are taken', g.status);
  const expired = J.signTransfer({ j: tj.id, l: leaseT, n: 'source', e: Math.floor(Date.now() / 1000) - 5 });
  g = await fetch(base + `/api/site-agent/transfers/${expired}`);
  gb = await g.json();
  ok(g.status === 403 && gb.code === 'transfer_expired', 'an expired URL is refused', [g.status, gb]);
  await api('POST', `/api/site-agent/jobs/${tj.id}/complete`, { leaseId: leaseT }, h1.cred);
  g = await fetch(base + dl);
  gb = await g.json();
  ok(g.status === 409 && gb.code === 'lease_lost', 'once the lease ends, its URLs stop working', [g.status, gb]);

  console.log('== transfer URLs: S3 ==');
  const sj = await Q.enqueue({ type: 'test.sitejob', pool: Q.sitePool(siteA), payload: { transfers: [
    { name: 'src', direction: 'download', uri: 's3://volt-media-test/vod-src/a b/programme.mxf' },
    { name: 'tree', direction: 'download', uri: 's3://volt-media-test/vod-out/asset/' },
    { name: 'back', direction: 'upload', uri: 's3://volt-media-test/restore/programme.mxf' },
  ] } });
  r = await api('POST', '/api/site-agent/jobs/lease', {}, h1.cred);
  const leaseS = r.body.leaseId;
  r = await api('POST', `/api/site-agent/jobs/${sj.id}/transfer-url`, { leaseId: leaseS, name: 'src' }, h1.cred);
  let u: URL | null = null; try { u = new URL(r.body.url); } catch { /* checked below */ }
  ok(r.status === 200 && r.body.via === 's3' && u && u.searchParams.get('X-Amz-Expires') === String(J.TRANSFER_URL_SECONDS) && !!u.searchParams.get('X-Amz-Signature') && u.pathname.endsWith('/vod-src/a%20b/programme.mxf'), 'a presigned GET for that one key, straight to the bucket', r.body);
  r = await api('POST', `/api/site-agent/jobs/${sj.id}/transfer-url`, { leaseId: leaseS, name: 'tree' }, h1.cred);
  ok(r.status === 400, 'a prefix (a whole tree) is refused: one URL, one object', r.status);
  if (process.env.MOTO_URL) {
    const { mediaS3Client } = await import('../src/services/media/s3Driver');
    const { CreateBucketCommand, PutObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
    const s3: any = await mediaS3Client(process.env.AWS_REGION ?? 'ap-southeast-1');
    await s3.send(new CreateBucketCommand({ Bucket: 'volt-media-test', CreateBucketConfiguration: { LocationConstraint: process.env.AWS_REGION ?? 'ap-southeast-1' } })).catch(() => {});
    await s3.send(new PutObjectCommand({ Bucket: 'volt-media-test', Key: 'vod-src/a b/programme.mxf', Body: srcBytes }));
    r = await api('POST', `/api/site-agent/jobs/${sj.id}/transfer-url`, { leaseId: leaseS, name: 'src' }, h1.cred);
    g = await fetch(r.body.url);
    got = Buffer.from(await g.arrayBuffer());
    ok(g.status === 200 && got.equals(srcBytes), 'the presigned GET downloads the object from S3', [g.status, got.length]);
    r = await api('POST', `/api/site-agent/jobs/${sj.id}/transfer-url`, { leaseId: leaseS, name: 'back' }, h1.cred);
    g = await fetch(r.body.url, { method: 'PUT', body: upBytes });
    const back = await s3.send(new GetObjectCommand({ Bucket: 'volt-media-test', Key: 'restore/programme.mxf' }));
    const backBytes = Buffer.from(await back.Body.transformToByteArray());
    ok(g.status === 200 && backBytes.equals(upBytes), 'the presigned PUT uploads it', [g.status, backBytes.length]);
  } else {
    console.log('SKIP S3 round trip: MOTO_URL not set');
  }
  await api('POST', `/api/site-agent/jobs/${sj.id}/complete`, { leaseId: leaseS }, h1.cred);

  console.log('== config and licence ==');
  r = await api('GET', '/api/site-agent/config', undefined, h1.cred);
  ok(r.status === 200 && r.body.pools.length === 1 && r.body.pools[0].name === `site:${siteA}`, 'an approved host is told its pool', r.body.pools);
  r = await api('GET', '/api/site-agent/config', undefined, hPending.cred);
  ok(r.status === 200 && r.body.pools.length === 0, 'a pending host has none', r.body.pools);
  await Q.enqueue({ type: 'test.sitejob', payload: {}, pool: Q.sitePool(siteA) });
  await query(`UPDATE accounts SET licences = '{}' WHERE id = $1`, [acct]);
  r = await api('POST', '/api/site-agent/jobs/lease', {}, h1.cred);
  ok(r.status === 403 && r.body.code === 'licence_required', 'the licence withdrawn stops the lease', r);
  ok((await one<any>(`SELECT count(*)::int AS n FROM jobs WHERE pool = $1 AND state = 'queued'`, [Q.sitePool(siteA)]))!.n === 1, 'and the waiting job is kept, not deleted');

  srv.close();
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
