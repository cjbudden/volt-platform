// ============================================================================
//  MIRROR AND ARCHIVE TO AN ON-PREM S3-COMPATIBLE STORE (build queue H3-4,
//  HYBRID_SITES.md: MinIO, NetApp StorageGRID, Dell ECS and similar).
//
//  Always (no store needed):
//    - the agent's own Signature V4 signer gives the same Authorization as
//      the AWS SDK's signer (PUT, GET with a query, multipart, session token);
//    - the keys stay at the site: a key file others can read is refused,
//      environment keys work, missing keys are a retry; the API refuses a
//      target that carries keys, and none ever reach the database or a job;
//    - store targets through the API: made, shown, validated, changed;
//      a target holding copies keeps its store, bucket and folder.
//
//  With a real S3 API (ARCHIVE_S3_TEST_ENDPOINT, and keys in
//  ARCHIVE_S3_TEST_KEY_ID / _SECRET; moto with IAM auth on checks the
//  signatures), the REAL agent code (volt-agent/src/siteArchive.ts) copies
//  through the real API and lease:
//    - a small original in one PUT, a 20 MB one as a multipart upload in
//      parts, both read back from the store and verified;
//    - nothing in the store is ever replaced: a taken name gets -2, and a
//      name taken between the look and the write (If-None-Match) too;
//    - a copy that does not match the original is refused by the cloud and
//      removed from the store; re-checks find a changed object corrupt and
//      a removed one missing;
//    - wrong keys, unprotected keys, missing keys and an unreachable store
//      are retries with the reason on the copy.
//
//    INITIAL_NO_AUTH_ACTION_COUNT=4 moto_server -p 5057 &   (then an IAM user with s3:*)
//    ARCHIVE_S3_TEST_ENDPOINT=http://127.0.0.1:5057 ARCHIVE_S3_TEST_KEY_ID=... \
//    ARCHIVE_S3_TEST_SECRET=... DATABASE_URL=... npx tsx test/mirror-archive-s3.check.ts
// ============================================================================
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac, randomBytes } from 'node:crypto';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** sha256 for the SDK signer, from node:crypto (its own hash package is not a direct dependency). */
class NodeSha256 {
  private h: any;
  constructor(secret?: any) { this.h = secret ? createHmac('sha256', Buffer.from(secret)) : createHash('sha256'); }
  update(d: any) { this.h.update(typeof d === 'string' ? Buffer.from(d) : Buffer.from(d)); }
  async digest() { return new Uint8Array(this.h.digest()); }
}

(async () => {
  const S3 = await import('../../volt-agent/src/s3Target');
  const A = await import('../src/services/archive/archive');
  const AG = await import('../../volt-agent/src/siteArchive');

  console.log('== Signature V4: the same as the AWS SDK signs ==');
  const { SignatureV4 } = await import('@smithy/signature-v4');
  const keys = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
  const now = new Date('2026-11-06T10:20:30Z');
  const sdkAuth = async (k: any, method: string, url: URL, headers: Record<string, string>, payloadHash: string) => {
    const signer = new SignatureV4({ credentials: k, region: 'us-east-1', service: 's3', sha256: NodeSha256 as any, uriEscapePath: false, applyChecksum: true });
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, key) => { query[key] = v; });
    const req: any = { method, protocol: url.protocol, hostname: url.hostname, port: url.port ? Number(url.port) : undefined, path: url.pathname, query,
      headers: { host: url.host, 'x-amz-content-sha256': payloadHash, ...headers } };
    const signed: any = await signer.sign(req, { signingDate: now });
    return signed.headers.authorization ?? signed.headers.Authorization;
  };
  const cases: [string, string, string, Record<string, string>, string][] = [
    ['a PUT with If-None-Match', 'PUT', 'http://127.0.0.1:9000/nas-archive/Volt/Archive/EveningShow.mp4', { 'if-none-match': '*', 'content-type': 'application/octet-stream' }, sha(Buffer.from('hello'))],
    ['a GET with a list query', 'GET', 'http://minio.local:9000/nas-archive/?list-type=2&prefix=Volt%2FArchive%2FEvening&max-keys=1000', {}, S3.EMPTY_SHA256],
    ['starting a multipart upload (empty query value)', 'POST', 'https://store.example.com/b-1/a/b.mxf?uploads=', { 'content-type': 'application/octet-stream' }, S3.EMPTY_SHA256],
    ['a part, with partNumber and uploadId', 'PUT', 'https://store.example.com/b-1/a/b.mxf?partNumber=2&uploadId=abc%2Fdef%3D%3D', {}, sha(Buffer.alloc(10, 1))],
    ['virtual-hosted style', 'DELETE', 'https://nas-archive.store.example.com/Volt/x-2.mp4', {}, S3.EMPTY_SHA256],
  ];
  for (const [label, method, u, headers, ph] of cases) {
    const url = new URL(u);
    const mine = S3.signV4({ method, url, headers, payloadHash: ph, keys, region: 'us-east-1', now }).authorization;
    const theirs = await sdkAuth(keys, method, url, headers, ph);
    ok(mine === theirs, `${label}: same signature as the AWS SDK`, { mine, theirs });
  }
  const withToken = { ...keys, sessionToken: 'FQoGZXIvYXdzEJr//////////wEaDOtoken' };
  const url0 = new URL('http://127.0.0.1:9000/nas-archive/x.mp4');
  const mineT = S3.signV4({ method: 'GET', url: url0, headers: {}, payloadHash: S3.EMPTY_SHA256, keys: withToken, region: 'eu-west-1', now });
  const signerT = new SignatureV4({ credentials: withToken, region: 'eu-west-1', service: 's3', sha256: NodeSha256 as any, uriEscapePath: false });
  const theirsT: any = await signerT.sign({ method: 'GET', protocol: 'http:', hostname: '127.0.0.1', port: 9000, path: '/nas-archive/x.mp4', query: {}, headers: { host: '127.0.0.1:9000', 'x-amz-content-sha256': S3.EMPTY_SHA256 } } as any, { signingDate: now });
  ok(mineT.authorization === theirsT.headers.authorization && mineT['x-amz-security-token'] === withToken.sessionToken, 'with a session token and another region too', { mine: mineT.authorization, theirs: theirsT.headers.authorization });
  ok(S3.encodeKey("Volt/My File(1)'s.mp4") === "Volt/My%20File%281%29%27s.mp4", 'object keys are encoded per segment, slashes kept');

  console.log('== the keys stay at the site ==');
  const kdir = mkdtempSync(join(tmpdir(), 'ma-keys-'));
  const kfile = join(kdir, 'archive-keys.json');
  writeFileSync(kfile, JSON.stringify({ 'nas-minio': { accessKeyId: 'AK1', secretAccessKey: 'SK1' } }));
  chmodSync(kfile, 0o644);
  const thr = (f: () => unknown) => { try { f(); return null; } catch (e: any) { return e; } };
  ok(thr(() => S3.keysFor('nas-minio', kfile, {}))?.code === 'keys_unprotected', 'a key file others can read is refused, not used');
  chmodSync(kfile, 0o600);
  ok(S3.keysFor('nas-minio', kfile, {}).secretAccessKey === 'SK1', 'an owner-only key file is read');
  ok(S3.keysFor('ecs.main', kfile, { VOLT_ARCHIVE_KEY_ECS_MAIN_ID: 'AK2', VOLT_ARCHIVE_KEY_ECS_MAIN_SECRET: 'SK2' }).accessKeyId === 'AK2', 'or keys from the environment, by name');
  const miss = thr(() => S3.keysFor('other', kfile, {}));
  ok(miss?.code === 'keys_missing' && miss?.permanent === false && /VOLT_ARCHIVE_KEY_OTHER_ID/.test(miss?.message), 'missing keys say where to put them, and are a retry', miss?.message);
  ok(S3.partSizeFor(1e6) === 8 * 2 ** 20 && S3.partSizeFor(200 * 2 ** 30) >= Math.ceil(200 * 2 ** 30 / 9000) && S3.partSizeFor(null) === 64 * 2 ** 20, 'parts: 8 MiB at least, under 10 000 parts for big files');

  console.log('== store targets (pure) ==');
  const st = A.cleanStore({ endpoint: 'http://minio.local:9000/', bucket: 'nas-archive', prefix: '/Volt/Archive/' });
  ok(JSON.stringify(st) === JSON.stringify({ endpoint: 'http://minio.local:9000', bucket: 'nas-archive', prefix: 'Volt/Archive', region: 'us-east-1', pathStyle: true, credentialRef: 'default' }), 'defaults: path style, us-east-1, keys named "default"', st);
  ok(thr(() => A.cleanStore({ endpoint: 'http://m:9000', bucket: 'b-1', secretAccessKey: 'x' }))?.code === 'keys_stay_at_site', 'keys in the request are refused');
  ok(thr(() => A.cleanStore({ endpoint: 'http://m:9000/bucket', bucket: 'b-1' }))?.status === 400 && thr(() => A.cleanStore({ endpoint: 'http://u:p@m:9000', bucket: 'b-1' }))?.status === 400 && thr(() => A.cleanStore({ endpoint: 'ftp://m', bucket: 'b-1' }))?.status === 400, 'an endpoint with a path, a user or another scheme is refused');
  ok(thr(() => A.cleanStore({ endpoint: 'http://m:9000', bucket: 'Bad_Bucket' }))?.status === 400 && thr(() => A.cleanStore({ endpoint: 'http://m:9000', bucket: 'b-1', prefix: 'a/../b' }))?.status === 400 && thr(() => A.cleanStore({ endpoint: 'http://m:9000', bucket: 'b-1', prefix: 'a b' }))?.status === 400, 'a bad bucket or a prefix with .. or spaces is refused');
  ok(A.storePath(st) === 's3://nas-archive/Volt/Archive', 'shown as s3://bucket/prefix');

  // ---- through the API ---------------------------------------------------------------
  process.env.CLIPS_DIR ||= mkdtempSync(join(tmpdir(), 'ma3-clips-'));
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name, licences) VALUES ($1, $2) RETURNING id`, [`ma3-${tag}`, ['mirror_archive']]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `ma3-${tag}@example.com`]))!.id;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' } as any);
  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: unknown, t: string | null = tok) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let b: any = null; try { b = text ? JSON.parse(text) : null; } catch { b = text; }
    return { status: r.status, body: b };
  };
  const facts = (hostname: string) => ({ hostname, cpuCores: 4, memoryBytes: 8 * 2 ** 30, diskFreeBytes: 1e12, diskTotalBytes: 2e12, os: 'Linux', arch: 'x64', agentVersion: '0.6.0' });
  const site = (await api('POST', '/api/sites', { name: 'Object store room' })).body.id;
  const tk = await api('POST', `/api/sites/${site}/enrolment-tokens`, {});
  const e = await api('POST', '/api/site-agent/enrol', { token: tk.body.token, host: facts('store-01') }, null);
  await api('POST', `/api/sites/${site}/hosts/${e.body.hostId}/approve`, {});
  const cred = e.body.credential as string;

  console.log('== store targets through the API ==');
  const ENDPOINT = process.env.ARCHIVE_S3_TEST_ENDPOINT || undefined;
  const KEY_ID = process.env.ARCHIVE_S3_TEST_KEY_ID ?? 'test', SECRET = process.env.ARCHIVE_S3_TEST_SECRET ?? 'test';
  const bucket = `volt-ma-${tag}`.toLowerCase();
  let r = await api('POST', '/api/archive/targets', { name: 'MinIO', siteId: site, kind: 's3', s3: { endpoint: ENDPOINT ?? 'http://minio.local:9000', bucket, prefix: 'Volt/Archive', credentialRef: 'nas-minio', secretAccessKey: 'SHOULD-NEVER-BE-STORED' } });
  ok(r.status === 400 && r.body?.code === 'keys_stay_at_site', 'a target sent with its secret is refused', r);
  ok((await one<any>(`SELECT count(*)::int AS n FROM archive_targets WHERE s3::text LIKE '%SHOULD-NEVER%' OR path LIKE '%SHOULD-NEVER%'`)).n === 0
    && (await one<any>(`SELECT count(*)::int AS n FROM audit_log WHERE audit_log::text LIKE '%SHOULD-NEVER%'`)).n === 0, 'and the secret is nowhere in the database');
  r = await api('POST', '/api/archive/targets', { name: 'MinIO', siteId: site, kind: 's3', s3: { endpoint: 'http://minio.local:9000/x', bucket } });
  ok(r.status === 400, 'a bad endpoint is refused', r.status);
  r = await api('POST', '/api/archive/targets', { name: 'MinIO', siteId: site, kind: 'path', path: '/mnt/x', s3: { endpoint: 'http://m:9000', bucket } });
  ok(r.status === 400, 's3 settings on a folder target are refused', r.status);
  r = await api('POST', '/api/archive/targets', { name: 'MinIO', siteId: site, kind: 's3', bandwidthMbps: 200, s3: { endpoint: ENDPOINT ?? 'http://minio.local:9000', bucket, prefix: 'Volt/Archive', credentialRef: 'nas-minio' } });
  ok(r.status === 201 && r.body.kind === 's3' && r.body.path === `s3://${bucket}/Volt/Archive` && r.body.s3?.bucket === bucket && r.body.s3?.credentialRef === 'nas-minio' && r.body.s3?.pathStyle === true && r.body.bandwidthMbps === 200, 'an S3-compatible store target is made', r.body);
  const target = r.body.id;
  ok(!JSON.stringify(r.body).match(/secret|accessKey/i), 'its view names the keys, never carries them');
  r = await api('GET', `/api/archive/targets?kind=s3`);
  ok(r.status === 200 && r.body.items.length === 1 && r.body.items[0].id === target, 'listed by kind', r.body);
  r = await api('PATCH', `/api/archive/targets/${target}`, { path: '/mnt/x' });
  ok(r.status === 400, 'a store target\'s path follows its bucket and prefix', r.status);
  r = await api('PATCH', `/api/archive/targets/${target}`, { kind: 'path' });
  ok(r.status === 400, 'a target keeps its kind', r.status);
  r = await api('PATCH', `/api/archive/targets/${target}`, { s3: { credentialRef: 'nas-old', region: 'eu-central-1' } });
  ok(r.status === 200 && r.body.s3.credentialRef === 'nas-old' && r.body.s3.region === 'eu-central-1' && r.body.s3.bucket === bucket && r.body.changed.includes('s3'), 'its keys\' name and region can change, the rest is kept', r.body);
  r = await api('PATCH', `/api/archive/targets/${target}`, { s3: { credentialRef: 'nas-minio', region: 'us-east-1', accessKeyId: 'AK' } });
  ok(r.status === 400 && r.body?.code === 'keys_stay_at_site', 'and keys are refused on a change too', r.status);
  await api('PATCH', `/api/archive/targets/${target}`, { s3: { credentialRef: 'nas-minio', region: 'us-east-1' } });

  const srcDir = join(process.env.CLIPS_DIR!, 'vod-src');
  mkdirSync(srcDir, { recursive: true });
  const mkAsset = async (file: string, body: Buffer, recordedSha?: string) => {
    // Its own folder, so the original keeps its plain name (the copy is named after it).
    const dir = join(srcDir, `${tag}-${randomBytes(3).toString('hex')}`); mkdirSync(dir, { recursive: true });
    const key = join(dir, file); writeFileSync(key, body);
    return (await one<any>(`INSERT INTO vod_assets (account_id, source_kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, source_key, sha256)
      VALUES ($1,'upload',$2,'/x',0,0,1,$3,$4) RETURNING id`, [acct, file, key, recordedSha ?? sha(body)]))!.id as string;
  };
  const small = randomBytes(200_000);
  const a1 = await mkAsset('Evening Show.mp4', small);
  r = await api('POST', '/api/archive/copies', { targetId: target, vodAssetId: a1 });
  const copy1 = r.body.id;
  const job1 = await one<any>(`SELECT j.payload FROM archive_copies c JOIN jobs j ON j.id = c.job_id WHERE c.id = $1`, [copy1]);
  ok(r.status === 202 && job1.payload.target.kind === 's3' && job1.payload.target.s3.bucket === bucket && job1.payload.target.s3.credentialRef === 'nas-minio' && !/secret|accessKeyId/i.test(JSON.stringify(job1.payload)), 'the copy job tells the agent where the store is and the keys\' name, nothing more', job1.payload.target);

  if (!ENDPOINT) {
    console.log('PASS skipped the store part: set ARCHIVE_S3_TEST_ENDPOINT (and _KEY_ID, _SECRET) to run against moto, MinIO or another S3-compatible store');
    srv.close(); await pool.end();
    console.log(`\nmirror-archive-s3: ${pass}/${pass + fail} passed`);
    process.exit(fail ? 1 : 0);
  }

  console.log('== copies into a real S3 API ==');
  const { S3Client, CreateBucketCommand, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const sdk = new S3Client({ endpoint: ENDPOINT, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: KEY_ID, secretAccessKey: SECRET } });
  await sdk.send(new CreateBucketCommand({ Bucket: bucket }));
  const get = async (key: string): Promise<Buffer | null> => {
    try { const o: any = await sdk.send(new GetObjectCommand({ Bucket: bucket, Key: key })); return Buffer.from(await o.Body.transformToByteArray()); } catch { return null; }
  };
  const list = async () => ((await sdk.send(new ListObjectsV2Command({ Bucket: bucket }))).Contents ?? []).map((o: any) => o.Key).sort();
  const keyFile = join(kdir, 'site-keys.json');
  const writeKeys = (secret: string, mode = 0o600) => { writeFileSync(keyFile, JSON.stringify({ 'nas-minio': { accessKeyId: KEY_ID, secretAccessKey: secret } })); chmodSync(keyFile, mode); };
  writeKeys(SECRET);
  const logs: string[] = [];
  let fetchHook: ((u: string, init: any) => Promise<void>) | null = null;
  const hooked: typeof fetch = (async (u: any, init: any) => { if (fetchHook) await fetchHook(String(u), init); return fetch(u, init); }) as any;
  const ctx = { server: base, credential: () => cred, log: (s: string) => logs.push(s), progressEveryMs: 50, keysFile: keyFile, fetch: hooked };
  const copyOf = async (id: string) => (await api('GET', `/api/archive/copies/${id}`)).body;
  const due = (id: string) => query(`UPDATE jobs SET run_after = now() FROM archive_copies c WHERE (c.job_id = jobs.id OR c.verify_job_id = jobs.id) AND c.id = $1`, [id]);

  let ran = await AG.archivePass(ctx);
  let c = await copyOf(copy1);
  ok(ran === 1 && c.state === 'verified' && c.storedPath === 'EveningShow.mp4' && c.sha256 === sha(small) && c.bytes === small.length, 'a small original: written in one PUT, read back, verified', { c, logs });
  ok((await get('Volt/Archive/EveningShow.mp4'))?.equals(small), 'and it is in the bucket, inside the target\'s folder');

  const big = randomBytes(20 * 2 ** 20 + 12345);
  const a2 = await mkAsset('Evening Show.mp4', big);
  const copy2 = (await api('POST', '/api/archive/copies', { targetId: target, vodAssetId: a2 })).body.id;
  const puts: string[] = [];
  fetchHook = async (u, init) => { if (init?.method === 'PUT' || init?.method === 'POST') puts.push(`${init.method} ${new URL(u).search}`); };
  ran = await AG.archivePass(ctx);
  fetchHook = null;
  c = await copyOf(copy2);
  const parts = puts.filter((p) => p.includes('partNumber')).length;
  ok(c.state === 'verified' && c.storedPath === 'EveningShow-2.mp4' && c.bytes === big.length, 'a 20 MB original: a taken name gets -2, verified', c);
  ok(parts === 3 && puts.some((p) => p.includes('uploads')) && puts.some((p) => p.startsWith('POST ?uploadId')), `sent as a multipart upload in ${parts} parts of 8 MiB`, puts);
  ok((await get('Volt/Archive/EveningShow-2.mp4'))?.equals(big) && (await get('Volt/Archive/EveningShow.mp4'))?.equals(small), 'both objects are whole, the first untouched');

  console.log('== nothing is ever replaced ==');
  const racer = randomBytes(1000);
  const a3 = await mkAsset('Race.mp4', randomBytes(5000));
  const copy3 = (await api('POST', '/api/archive/copies', { targetId: target, vodAssetId: a3 })).body.id;
  let planted = false;
  fetchHook = async (u, init) => {
    if (!planted && init?.method === 'PUT' && new URL(u).pathname.endsWith('/Volt/Archive/Race.mp4')) {
      planted = true;   // someone else writes the same name between the look and the write
      await sdk.send(new PutObjectCommand({ Bucket: bucket, Key: 'Volt/Archive/Race.mp4', Body: racer }));
    }
  };
  await AG.archivePass(ctx);
  fetchHook = null;
  c = await copyOf(copy3);
  ok(planted && c.state === 'verified' && c.storedPath === 'Race-2.mp4', 'a name taken between the look and the write: refused by the store (412), the copy takes -2', c);
  ok((await get('Volt/Archive/Race.mp4'))?.equals(racer), 'the other object is untouched');

  console.log('== a copy that does not match is refused and removed ==');
  const a4 = await mkAsset('Bad Sum.mov', randomBytes(30_000), 'e'.repeat(64));
  const copy4 = (await api('POST', '/api/archive/copies', { targetId: target, vodAssetId: a4 })).body.id;
  await AG.archivePass(ctx);
  c = await copyOf(copy4);
  ok(c.state === 'queued' && c.errorCode === 'checksum_mismatch' && !c.verifiedAt, 'not the original\'s checksum: refused, never verified', c);
  ok(!(await list()).includes('Volt/Archive/BadSum.mov'), 'and the agent removed its object from the store', await list());

  console.log('== re-checks ==');
  r = await api('POST', `/api/archive/copies/${copy1}/verify`);
  await AG.archivePass(ctx);
  c = await copyOf(copy1);
  ok(r.status === 202 && c.state === 'verified' && !!c.checkedAt && c.checking === false, 'an intact object stays verified', c);
  const changed = Buffer.from(small); changed[10] ^= 0xff;
  await sdk.send(new PutObjectCommand({ Bucket: bucket, Key: 'Volt/Archive/EveningShow.mp4', Body: changed }));
  await api('POST', `/api/archive/copies/${copy1}/verify`);
  await AG.archivePass(ctx);
  c = await copyOf(copy1);
  ok(c.state === 'corrupt' && c.errorCode === 'checksum_mismatch', 'an object changed in the store is found corrupt', c);
  await sdk.send(new DeleteObjectCommand({ Bucket: bucket, Key: 'Volt/Archive/Race-2.mp4' }));
  await api('POST', `/api/archive/copies/${copy3}/verify`);
  await AG.archivePass(ctx);
  c = await copyOf(copy3);
  ok(c.state === 'missing', 'an object removed from the store is found missing', c);

  console.log('== keys and reachability ==');
  const a5 = await mkAsset('Keys.mp4', randomBytes(4000));
  const copy5 = (await api('POST', '/api/archive/copies', { targetId: target, vodAssetId: a5 })).body.id;
  writeKeys('not-the-secret');
  await AG.archivePass(ctx);
  c = await copyOf(copy5);
  ok(c.state === 'queued' && c.errorCode === 'target_refused' && /SignatureDoesNotMatch|AccessDenied|InvalidAccessKeyId/.test(c.error ?? ''), 'wrong keys: the store refuses, the copy waits with why', c);
  writeKeys(SECRET, 0o644);
  await due(copy5); await AG.archivePass(ctx);
  c = await copyOf(copy5);
  ok(c.state === 'queued' && c.errorCode === 'keys_unprotected', 'a key file others can read is not used', c);
  writeFileSync(keyFile, JSON.stringify({})); chmodSync(keyFile, 0o600);
  await due(copy5); await AG.archivePass(ctx);
  c = await copyOf(copy5);
  ok(c.state === 'queued' && c.errorCode === 'keys_missing', 'no keys of that name on the host: a retry, with where to put them', c);
  writeKeys(SECRET);
  const down = await one<any>(`SELECT payload FROM jobs j JOIN archive_copies c ON c.job_id = j.id WHERE c.id = $1`, [copy5]);
  down.payload.target.s3.endpoint = 'http://127.0.0.1:1';
  await query(`UPDATE jobs SET payload = $2, run_after = now() FROM archive_copies c WHERE c.job_id = jobs.id AND c.id = $1`, [copy5, down.payload]);
  await AG.archivePass(ctx);
  c = await copyOf(copy5);
  ok(c.state === 'queued' && c.errorCode === 'target_unavailable', 'a store that cannot be reached is a retry', c);
  down.payload.target.s3.endpoint = ENDPOINT;
  await query(`UPDATE jobs SET payload = $2, run_after = now() FROM archive_copies c WHERE c.job_id = jobs.id AND c.id = $1`, [copy5, down.payload]);
  await AG.archivePass(ctx);
  c = await copyOf(copy5);
  ok(c.state === 'verified' && c.storedPath === 'Keys.mp4', 'with the keys back and the store reachable, the same copy goes through', c);

  console.log('== a target holding copies keeps its place ==');
  r = await api('PATCH', `/api/archive/targets/${target}`, { s3: { bucket: 'another-bucket' } });
  ok(r.status === 409 && r.body?.code === 'target_in_use', 'another bucket: refused while it holds copies', r.status);
  r = await api('PATCH', `/api/archive/targets/${target}`, { s3: { prefix: 'Elsewhere' } });
  ok(r.status === 409 && r.body?.code === 'target_in_use', 'another folder too', r.status);
  r = await api('PATCH', `/api/archive/targets/${target}`, { s3: { credentialRef: 'nas-minio-2' } });
  ok(r.status === 200 && r.body.s3.credentialRef === 'nas-minio-2', 'the keys\' name can still change (key rotation at the site)', r.body);
  ok((await list()).every((k: string) => k.startsWith('Volt/Archive/')), 'nothing was ever written outside the target\'s folder', await list());

  srv.close();
  await pool.end();
  console.log(`\nmirror-archive-s3: ${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
