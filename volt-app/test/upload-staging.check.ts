// ============================================================================
//  RESUMABLE UPLOADS SPREAD OVER SEVERAL TASKS (build queue 2.1a-2), against
//  Postgres, two real API processes and the real AWS SDK.
//
//  On AWS the control plane is several Fargate tasks behind a load balancer
//  with no stickiness, so one upload's chunks (and a tus upload's PATCHes)
//  reach different tasks. Each task has its own disk. Here two API processes,
//  A and B, share the database and the bucket but each has its own
//  UPLOAD_STAGING_DIR, FILLER_DIR and CLIPS_DIR, which is what two tasks are.
//
//  With the local driver (the Mac) an upload split over A and B cannot be
//  finished: that is the fault, shown first. With UPLOAD_STAGING_DRIVER=s3 the
//  same upload assembles on either, a tus upload alternating between them
//  completes, two finishes at once give one file, a retried PATCH at the same
//  offset on both counts once, and nothing is left in the bucket afterwards.
//
//  The bucket is a small S3-compatible server inside this test; set
//  UPLOAD_S3_TEST_ENDPOINT to run the same checks against moto, MinIO or S3.
//
//  Usage: DATABASE_URL=... npx tsx test/upload-staging.check.ts   (a migrated, disposable database)
// ============================================================================
import { createServer as httpServer, IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawn, ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ------------------------------------------------------------- serve mode
// The child: one API process, as one task would be.
if (process.argv[2] === 'serve') {
  (async () => {
    const { createServer } = await import('../src/server');
    const srv = createServer().listen(0, '127.0.0.1', () => console.log(`PORT ${(srv.address() as any).port}`));
  })().catch((e) => { console.error(e); process.exit(1); });
} else {
  main().catch((e) => { console.error(e); process.exit(1); });
}

async function main() {
  let pass = 0, fail = 0;
  const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };

  // ---------------------------------------------------------------- the bucket
  const objects = new Map<string, Buffer>();
  function decodeAwsChunked(b: Buffer): Buffer {
    const out: Buffer[] = []; let i = 0;
    for (;;) {
      const nl = b.indexOf('\r\n', i); if (nl < 0) break;
      const size = parseInt(b.subarray(i, nl).toString().split(';')[0], 16);
      if (!size) break;
      out.push(b.subarray(nl + 2, nl + 2 + size)); i = nl + 2 + size + 2;
    }
    return Buffer.concat(out);
  }
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  function fakeS3(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url!, 'http://x');
      const path = decodeURIComponent(u.pathname.slice(1));
      if (req.method === 'GET' && u.searchParams.get('list-type') === '2') {
        const b = path.replace(/\/$/, ''); const prefix = u.searchParams.get('prefix') ?? '';
        const hits = [...objects.entries()].filter(([k]) => k.startsWith(`${b}/${prefix}`)).sort();
        const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${b}</Name><Prefix>${esc(prefix)}</Prefix><KeyCount>${hits.length}</KeyCount><IsTruncated>false</IsTruncated>` +
          hits.map(([k, v]) => `<Contents><Key>${esc(k.slice(b.length + 1))}</Key><Size>${v.length}</Size><ETag>"e"</ETag></Contents>`).join('') + `</ListBucketResult>`;
        res.writeHead(200, { 'content-type': 'application/xml' }); return res.end(xml);
      }
      if (req.method === 'PUT') {
        let body = Buffer.concat(chunks);
        if (String(req.headers['content-encoding'] ?? '').includes('aws-chunked') || String(req.headers['x-amz-content-sha256'] ?? '').startsWith('STREAMING-')) body = decodeAwsChunked(body);
        objects.set(path, body); res.writeHead(200, { ETag: '"e"' }); return res.end();
      }
      if (req.method === 'DELETE') { objects.delete(path); res.writeHead(204); return res.end(); }
      const o = objects.get(path);
      if (!o) { res.writeHead(404, { 'content-type': 'application/xml' }); return res.end(req.method === 'HEAD' ? undefined : '<Error><Code>NoSuchKey</Code></Error>'); }
      res.writeHead(200, { 'Content-Length': o.length, ETag: '"e"' }); res.end(req.method === 'HEAD' ? undefined : o);
    });
  }

  const BUCKET = 'volt-staging-check';
  const external = process.env.UPLOAD_S3_TEST_ENDPOINT;
  let s3srv: any = null;
  if (!external) { s3srv = httpServer(fakeS3).listen(0, '127.0.0.1'); await new Promise((r) => s3srv.on('listening', r)); }
  const endpoint = external || `http://127.0.0.1:${s3srv.address().port}`;
  const awsEnv = { AWS_ENDPOINT_URL: endpoint, S3_FORCE_PATH_STYLE: '1', AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || 'volt', AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || 'voltvoltvolt',
    AWS_REGION: process.env.AWS_REGION || 'us-east-1', UPLOAD_STAGING_S3_BUCKET: BUCKET, FILLER_S3_BUCKET: BUCKET, S3_BUCKET: BUCKET };
  Object.assign(process.env, awsEnv);
  const { S3Client, CreateBucketCommand, ListObjectsV2Command, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const raw = new S3Client({ region: awsEnv.AWS_REGION, forcePathStyle: true });
  await raw.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(() => { /* exists, or the fake */ });
  const staged = async (prefix = 'upload-staging/'): Promise<string[]> => {
    const r: any = await raw.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
    return (r.Contents ?? []).map((c: any) => String(c.Key));
  };
  const inBucket = async (key: string): Promise<Buffer | null> => {
    try { const r: any = await raw.send(new GetObjectCommand({ Bucket: BUCKET, Key: key })); return Buffer.from(await r.Body.transformToByteArray()); } catch { return null; }
  };

  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`ustage-${tag}`]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `ustage-${tag}@volt.test`]))!.id;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' } as any);

  // ---------------------------------------------------------------- two tasks
  const work = mkdtempSync(join(tmpdir(), 'upload-staging-'));
  const kids: ChildProcess[] = [];
  const startTask = (name: string, driver: 'local' | 's3'): Promise<{ base: string; dir: string; clips: string }> => new Promise((resolve, reject) => {
    const dir = join(work, `${name}-${driver}`);
    const env = { ...process.env, ...awsEnv, UPLOAD_STAGING_DRIVER: driver, FILLER_STORE_DRIVER: 's3',
      UPLOAD_STAGING_DIR: join(dir, 'staging'), FILLER_DIR: join(dir, 'filler'), CLIPS_DIR: join(dir, 'clips'), IMAGE_STORE_DIR: join(dir, 'images'),
      FILLER_CACHE_DIR: join(dir, 'cache'), PORT: '0' };
    const p = spawn(join(__dirname, '../node_modules/.bin/tsx'), [__filename, 'serve'], { env, cwd: join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
    kids.push(p);
    let out = '';
    const t = setTimeout(() => reject(new Error(`task ${name} did not start: ${out.slice(-2000)}`)), 60_000);
    p.stdout!.on('data', (b) => { out += b; const m = /PORT (\d+)/.exec(out); if (m) { clearTimeout(t); resolve({ base: `http://127.0.0.1:${m[1]}`, dir, clips: join(dir, 'clips') }); } });
    p.stderr!.on('data', (b) => { out += b; });
    p.on('exit', (c) => { clearTimeout(t); reject(new Error(`task ${name} exited ${c}: ${out.slice(-2000)}`)); });
  });
  const api = async (base: string, method: string, path: string, body?: any) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j: any = null; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
    return { status: r.status, j };
  };
  const putChunk = (base: string, o: any, i: number, b: Buffer) =>
    fetch(`${base}/api/uploads/${o.id}/chunks/${i}`, { method: 'PUT', headers: { authorization: `Bearer ${o.token}`, 'content-type': 'application/octet-stream' }, body: b });
  const finish = async (base: string, o: any) => {
    const r = await fetch(`${base}/api/uploads/${o.id}/finish`, { method: 'POST', headers: { authorization: `Bearer ${o.token}` } });
    return { status: r.status, j: await r.json().catch(() => null) as any };
  };
  const CH = 8 * 1024 * 1024;
  // Three chunks: 8 MB, 8 MB and a short last one.
  const big = Buffer.alloc(2 * CH + 123_457); for (let i = 0; i < big.length; i++) big[i] = (i * 131 + (i >> 13)) & 0xff;
  const parts = [big.subarray(0, CH), big.subarray(CH, 2 * CH), big.subarray(2 * CH)];
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const openLoop = async (base: string, name: string) => {
    const o = await api(base, 'POST', '/api/uploads', { purpose: 'filler', fillerKind: 'loop', name, filename: `${name}.mp4`, totalBytes: big.length });
    if (o.status !== 201) throw new Error(`open ${o.status} ${JSON.stringify(o.j)}`);
    return o.j;
  };

  try {
    // ------------------------------------------------ the fault: local driver
    console.log('-- local driver, one upload over two tasks (the fault)');
    const LA = await startTask('A', 'local'), LB = await startTask('B', 'local');
    {
      const o = await openLoop(LA.base, 'local-split');
      const r = [await putChunk(LA.base, o, 0, parts[0]), await putChunk(LB.base, o, 1, parts[1]), await putChunk(LA.base, o, 2, parts[2])];
      ok(r.every((x) => x.status === 200), 'every chunk is acknowledged by the task it reached', r.map((x) => x.status).join(','));
      const f = await finish(LB.base, o);
      ok(f.status >= 400, 'finishing on B fails: chunks 0 and 2 are on A\'s disk only', `${f.status} ${JSON.stringify(f.j)}`);
      ok(/missing from disk/.test(JSON.stringify(f.j ?? '')), 'and says a chunk is missing from disk', JSON.stringify(f.j));
      // The Mac: one task takes every chunk and assembles, unchanged.
      const o2 = await openLoop(LA.base, 'local-one');
      for (let i = 0; i < 3; i++) await putChunk(LA.base, o2, i, parts[i]);
      ok(existsSync(join(LA.dir, 'staging', o2.id, '000001.part')), 'with the local driver the chunks wait on the task\'s disk as before');
      const f2 = await finish(LA.base, o2);
      ok(f2.status === 200 && f2.j?.sha256 === sha(big), 'one task, local driver: it assembles as before', `${f2.status} ${f2.j?.sha256}`);
      ok(!(await staged()).length, 'and nothing went to the bucket\'s upload-staging/');
    }
    for (const k of kids.splice(0)) k.kill();

    // ------------------------------------------------ AWS: s3 driver
    console.log('-- s3 driver, chunks spread over two tasks');
    const A = await startTask('A', 's3'), B = await startTask('B', 's3');
    {
      const o = await openLoop(A.base, 'split');
      const r = [await putChunk(A.base, o, 0, parts[0]), await putChunk(B.base, o, 1, parts[1]), await putChunk(A.base, o, 2, parts[2])];
      ok(r.every((x) => x.status === 200), 'chunks to A, B, A are acknowledged', r.map((x) => x.status).join(','));
      const keys = await staged(`upload-staging/${o.id}/`);
      ok(keys.length === 3 && keys.every((k) => /\/c\/00000[0-2]\.part$/.test(k)), 'the three chunks wait in the bucket under upload-staging/<session>/c/', keys.join(' '));
      ok(!existsSync(join(A.dir, 'staging', o.id, '000000.part')) && !existsSync(join(B.dir, 'staging', o.id, '000001.part')), 'and not on either task\'s disk');
      const dup = await putChunk(B.base, o, 0, parts[0]);
      const dj: any = await dup.json();
      ok(dup.status === 200 && dj.duplicate === true && dj.receivedBytes === big.length, 'a chunk retried on the other task is a duplicate, counted once', JSON.stringify(dj).slice(0, 200));
      const f = await finish(B.base, o);
      ok(f.status === 200 && f.j?.sha256 === sha(big) && f.j?.bytes === big.length, 'finishing on B assembles the whole file', `${f.status} ${JSON.stringify(f.j).slice(0, 200)}`);
      const row = await one<any>(`SELECT * FROM filler_assets WHERE id = $1`, [o.assetId]);
      ok(row?.status === 'ready', 'the loop is ready', row?.status);
      const landed = await inBucket(row?.source_key ?? '');
      ok(!!landed && sha(landed) === sha(big), 'its bytes are in the bucket under its source key, whole', row?.source_key);
      ok(!(await staged(`upload-staging/${o.id}/`)).length, 'the staged chunks are removed from the bucket once assembled');
      const again = await finish(A.base, o);
      ok(again.status === 200 && again.j?.assetId === o.assetId, 'finish asked again on A answers the same asset', `${again.status}`);
    }

    console.log('-- two finishes at once, on A and on B');
    {
      const o = await openLoop(A.base, 'race');
      for (let i = 0; i < 3; i++) await putChunk(i % 2 ? A.base : B.base, o, i, parts[i]);
      const [fa, fb] = await Promise.all([finish(A.base, o), finish(B.base, o)]);
      ok(fa.status === 200 && fb.status === 200, 'both answer 200', `${fa.status} ${fb.status} ${JSON.stringify(fa.j).slice(0, 120)} ${JSON.stringify(fb.j).slice(0, 120)}`);
      ok(fa.j?.assetId === o.assetId && fb.j?.assetId === o.assetId, 'with the same asset');
      const row = await one<any>(`SELECT * FROM filler_assets WHERE id = $1`, [o.assetId]);
      const landed = await inBucket(row?.source_key ?? '');
      ok(!!landed && sha(landed) === sha(big), 'and one whole file in the bucket');
      const sess = await one<any>(`SELECT state FROM upload_sessions WHERE id = $1`, [o.id]);
      ok(sess?.state === 'complete', 'the session is complete', sess?.state);
    }

    console.log('-- abort and expiry clear the bucket');
    {
      const o = await openLoop(A.base, 'aborted');
      await putChunk(A.base, o, 0, parts[0]); await putChunk(B.base, o, 1, parts[1]);
      ok((await staged(`upload-staging/${o.id}/`)).length === 2, 'two chunks staged');
      const d = await fetch(`${B.base}/api/uploads/${o.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${tok}` } });
      ok(d.status < 300, 'abort answered', String(d.status));
      ok(!(await staged(`upload-staging/${o.id}/`)).length, 'an aborted upload leaves nothing in the bucket');
      const o2 = await openLoop(A.base, 'expired');
      await putChunk(B.base, o2, 2, parts[2]);
      await query(`UPDATE upload_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [o2.id]);
      process.env.UPLOAD_STAGING_DRIVER = 's3'; process.env.UPLOAD_STAGING_DIR = join(work, 'sweeper');
      const { sweepUploads } = await import('../src/services/uploads');
      const sw = await sweepUploads();
      ok(sw.expired >= 1 && sw.bytesFreed >= parts[2].length, 'the sweep expires a silent upload and counts the bucket bytes it frees', JSON.stringify(sw));
      ok(!(await staged(`upload-staging/${o2.id}/`)).length, 'an expired upload leaves nothing in the bucket');
    }

    console.log('-- tus on Postgres, one task (0119: it could not create an upload at all)');
    {
      const T = { 'Tus-Resumable': '1.0.0', authorization: `Bearer ${tok}` };
      const c = await fetch(`${A.base}/api/tus`, { method: 'POST', headers: { ...T, 'Upload-Length': '10' } });
      ok(c.status === 201, 'POST /api/tus creates an upload session', `${c.status} ${c.status !== 201 ? await c.text() : ''}`);
      const id = (c.headers.get('location') ?? '').split('/').pop()!;
      const s = await one<any>(`SELECT chunk_count, purpose FROM upload_sessions WHERE id = $1`, [id]).catch(() => null);
      ok(s?.chunk_count === 0, 'with no chunks, so the chunk endpoint refuses it', JSON.stringify(s));
      await fetch(`${A.base}/api/tus/${id}`, { method: 'DELETE', headers: T });
    }

    console.log('-- tus, PATCHes alternating between the two tasks');
    {
      const T = { 'Tus-Resumable': '1.0.0', authorization: `Bearer ${tok}` };
      const body = Buffer.alloc(300_001); for (let i = 0; i < body.length; i++) body[i] = (i * 7 + 3) & 0xff;
      const meta = `filename ${Buffer.from('tus-split.mp4').toString('base64')},filetype ${Buffer.from('video/mp4').toString('base64')}`;
      const c = await fetch(`${A.base}/api/tus`, { method: 'POST', headers: { ...T, 'Upload-Length': String(body.length), 'Upload-Metadata': meta } });
      const loc = c.headers.get('location') ?? '';
      ok(c.status === 201 && /\/api\/tus\/[0-9a-f-]{36}$/.test(loc), 'created on A', `${c.status} ${loc}`);
      const id = loc.split('/').pop()!;
      const patch = (base: string, off: number, b: Buffer, extra: Record<string, string> = {}) => fetch(`${base}/api/tus/${id}`, {
        method: 'PATCH', headers: { ...T, 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(off), ...extra }, body: b });
      const p1 = await patch(A.base, 0, body.subarray(0, 100_000));
      ok(p1.status === 204 && p1.headers.get('upload-offset') === '100000', 'first PATCH on A', `${p1.status} ${p1.headers.get('upload-offset')}`);
      const h = await fetch(`${B.base}/api/tus/${id}`, { method: 'HEAD', headers: T });
      ok(h.status === 200 && h.headers.get('upload-offset') === '100000', 'B reports the offset A took (HEAD)', `${h.status} ${h.headers.get('upload-offset')}`);
      const bad = await patch(B.base, 100_000, body.subarray(100_000, 200_000), { 'Upload-Checksum': `sha256 ${createHash('sha256').update('not this').digest('base64')}` });
      ok(bad.status === 460, 'a body whose checksum is wrong is refused (460)', String(bad.status));
      const [pa, pb] = await Promise.all([patch(A.base, 100_000, body.subarray(100_000, 200_000)), patch(B.base, 100_000, body.subarray(100_000, 150_000))]);
      const st = [pa.status, pb.status].sort().join(',');
      ok(st === '204,409', 'the same offset sent to both tasks at once: one counts, the other is told 409', st);
      const off = Number((await fetch(`${A.base}/api/tus/${id}`, { method: 'HEAD', headers: T })).headers.get('upload-offset'));
      ok(off === 200_000 || off === 150_000, 'the offset is the winner\'s end', String(off));
      const p3 = await patch(B.base, off, body.subarray(off));
      ok(p3.status === 204 && p3.headers.get('upload-offset') === String(body.length), 'the last PATCH on B completes the upload', `${p3.status} ${p3.headers.get('upload-offset')} ${p3.status !== 204 ? await p3.text() : ''}`);
      const s = await one<any>(`SELECT * FROM upload_sessions WHERE id = $1`, [id]);
      ok(s?.state === 'complete', 'the session is complete', s?.state);
      // The ingest names the source file itself; whichever .mp4 B landed must be the whole upload.
      const dir = join(B.clips, 'vod-src');
      const mp4s = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.mp4')) : [];
      ok(mp4s.length === 1 && sha(readFileSync(join(dir, mp4s[0]))) === sha(body), 'the joined file is whole (parts from A and B, the losing part left out)', mp4s.join(' '));
      ok(!(await staged(`upload-staging/${id}/`)).length, 'its parts are removed from the bucket');
      ok(!existsSync(join(A.dir, 'staging', id, 'upload.tus')), 'A kept no copy of the bytes it took');
    }

    console.log('-- tus termination clears the bucket');
    {
      const T = { 'Tus-Resumable': '1.0.0', authorization: `Bearer ${tok}` };
      const c = await fetch(`${B.base}/api/tus`, { method: 'POST', headers: { ...T, 'Upload-Length': '1000', 'Content-Type': 'application/offset+octet-stream' }, body: Buffer.alloc(400, 1) });
      const id = (c.headers.get('location') ?? '').split('/').pop()!;
      ok(c.status === 201 && c.headers.get('upload-offset') === '400', 'creation with upload keeps the first part', `${c.status} ${c.headers.get('upload-offset')}`);
      ok((await staged(`upload-staging/${id}/`)).length === 1, 'one part in the bucket');
      const d = await fetch(`${A.base}/api/tus/${id}`, { method: 'DELETE', headers: T });
      ok(d.status === 204 && !(await staged(`upload-staging/${id}/`)).length, 'terminated on the other task: nothing left in the bucket', String(d.status));
      ok(!existsSync(join(B.dir, 'staging', id)), 'and the task that took the part kept nothing on its disk');
    }
    ok(!(await staged()).length, 'upload-staging/ is empty at the end');
  } finally {
    for (const k of kids) k.kill();
    s3srv?.close();
    await pool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
}
