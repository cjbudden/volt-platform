// ============================================================================
//  AN ASSET'S ORIGINAL IN THE BUCKET (build queue 2.1a-2b, first piece), against
//  Postgres, a real API process, the real AWS SDK and ffmpeg.
//
//  On AWS the control plane is several Fargate tasks sharing one job queue: the
//  task that finishes an upload is rarely the one whose worker takes the encode,
//  and a replaced task takes its disk with it. Here task A is an API process with
//  its own CLIPS_DIR; this process is task B, with another CLIPS_DIR and its own
//  scratch, running the encode handler as B's worker would.
//
//  With the local driver (the Mac) the original stays on A's disk: once A is
//  gone, B's encode fails with "the source file is not there". That is the fault,
//  shown first. With VOD_SOURCE_DRIVER=s3 the original lands in the bucket under
//  vod-src/, the asset's source_key is its s3:// address, A keeps no copy, and B
//  fetches a private scratch copy for the encode and removes it afterwards. A held
//  duplicate is in the bucket too, and skipping it removes the object.
//
//  The full encode on B needs the packager (PACKAGER_BIN); without it that one
//  step reports SKIP and checks that B got past the source.
//
//  The bucket is a small S3-compatible server inside this test; set
//  UPLOAD_S3_TEST_ENDPOINT to run the same checks against moto, MinIO or S3.
//
//  Usage: DATABASE_URL=... npx tsx test/vod-source-store.check.ts   (a migrated, disposable database)
// ============================================================================
import { createServer as httpServer, IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, existsSync, readFileSync, readdirSync, renameSync, mkdirSync } from 'node:fs';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  const BUCKET = 'volt-vodsrc-check';
  const external = process.env.UPLOAD_S3_TEST_ENDPOINT;
  let s3srv: any = null;
  if (!external) { s3srv = httpServer(fakeS3).listen(0, '127.0.0.1'); await new Promise((r) => s3srv.on('listening', r)); }
  const endpoint = external || `http://127.0.0.1:${s3srv.address().port}`;
  const work = mkdtempSync(join(tmpdir(), 'vod-source-'));
  const awsEnv = { AWS_ENDPOINT_URL: endpoint, S3_FORCE_PATH_STYLE: '1', AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || 'volt', AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || 'voltvoltvolt',
    AWS_REGION: process.env.AWS_REGION || 'us-east-1', UPLOAD_STAGING_S3_BUCKET: BUCKET, FILLER_S3_BUCKET: BUCKET, VOD_SOURCE_S3_BUCKET: BUCKET, S3_BUCKET: BUCKET };
  // This process is task B: its own disk, set before any module reads config.
  const bDir = join(work, 'B');
  Object.assign(process.env, awsEnv, { CLIPS_DIR: join(bDir, 'clips'), VOD_SOURCE_CACHE_DIR: join(bDir, 'scratch'), UPLOAD_STAGING_DIR: join(bDir, 'staging'),
    FILLER_DIR: join(bDir, 'filler'), IMAGE_STORE_DIR: join(bDir, 'images') });
  const { S3Client, CreateBucketCommand, ListObjectsV2Command, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const raw = new S3Client({ region: awsEnv.AWS_REGION, forcePathStyle: true });
  await raw.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(() => { /* exists, or the fake */ });
  const listed = async (prefix = 'vod-src/'): Promise<string[]> => {
    const r: any = await raw.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
    return (r.Contents ?? []).map((c: any) => String(c.Key));
  };
  const inBucket = async (key: string): Promise<Buffer | null> => {
    try { const r: any = await raw.send(new GetObjectCommand({ Bucket: BUCKET, Key: key })); return Buffer.from(await r.Body.transformToByteArray()); } catch { return null; }
  };
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const filesUnder = (d: string): string[] => existsSync(d) ? readdirSync(d, { recursive: true, withFileTypes: true } as any).filter((e: any) => e.isFile()).map((e: any) => join(e.parentPath ?? e.path, e.name)) : [];

  // A real two second video, so the ingest probe and the encoder can read it.
  const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
  if (spawnSync(ffmpeg, ['-version'], { stdio: 'ignore' }).status !== 0) { console.log('SKIP: ffmpeg is needed (brew install ffmpeg)'); console.log('\n0 passed, 0 failed'); process.exit(0); }
  const mkVideo = (name: string, hz: number): Buffer => {
    const f = join(work, name);
    const r = spawnSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=48000`,
      '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', f]);
    if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
    return readFileSync(f);
  };

  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`vodsrc-${tag}`]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `vodsrc-${tag}@volt.test`]))!.id;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' } as any);

  const kids: ChildProcess[] = [];
  const startA = (driver: 'local' | 's3'): Promise<{ base: string; dir: string; proc: ChildProcess }> => new Promise((resolve, reject) => {
    const dir = join(work, `A-${driver}`);
    const env = { ...process.env, ...awsEnv, VOD_SOURCE_DRIVER: driver, UPLOAD_STAGING_DRIVER: 's3', FILLER_STORE_DRIVER: 's3',
      UPLOAD_STAGING_DIR: join(dir, 'staging'), FILLER_DIR: join(dir, 'filler'), CLIPS_DIR: join(dir, 'clips'), IMAGE_STORE_DIR: join(dir, 'images'),
      VOD_SOURCE_CACHE_DIR: join(dir, 'scratch'), PORT: '0' };
    const p = spawn(join(__dirname, '../node_modules/.bin/tsx'), [__filename, 'serve'], { env, cwd: join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
    kids.push(p);
    let out = '';
    const t = setTimeout(() => reject(new Error(`task A did not start: ${out.slice(-2000)}`)), 60_000);
    p.stdout!.on('data', (b) => { out += b; const m = /PORT (\d+)/.exec(out); if (m) { clearTimeout(t); resolve({ base: `http://127.0.0.1:${m[1]}`, dir, proc: p }); } });
    p.stderr!.on('data', (b) => { out += b; });
    p.on('exit', (c) => { clearTimeout(t); reject(new Error(`task A exited ${c}: ${out.slice(-2000)}`)); });
  });
  const stop = async (p: ChildProcess) => { p.removeAllListeners('exit'); p.kill(); await new Promise((r) => setTimeout(r, 300)); };
  const upload = async (base: string, name: string, body: Buffer) => {
    const o = await fetch(`${base}/api/uploads`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'vod', name, filename: `${name}.mp4`, totalBytes: body.length, contentType: 'video/mp4' }) });
    const oj: any = await o.json();
    if (o.status !== 201) throw new Error(`open ${o.status} ${JSON.stringify(oj)}`);
    const c = await fetch(`${base}/api/uploads/${oj.id}/chunks/0`, { method: 'PUT', headers: { authorization: `Bearer ${oj.token}`, 'content-type': 'application/octet-stream' }, body });
    if (c.status !== 200) throw new Error(`chunk ${c.status} ${await c.text()}`);
    const f = await fetch(`${base}/api/uploads/${oj.id}/finish`, { method: 'POST', headers: { authorization: `Bearer ${oj.token}` } });
    return { open: oj, status: f.status, j: await f.json().catch(() => null) as any };
  };
  const encodeOnB = async (assetId: string) => {
    const a = await one<any>(`SELECT v.source_key, j.payload FROM vod_assets v LEFT JOIN jobs j ON j.id = v.encode_job_id WHERE v.id = $1`, [assetId]);
    const { handleVodEncode } = await import('../src/services/jobs/handlers/vodEncode');
    try {
      const r = await handleVodEncode({ job: { payload: a?.payload ?? { vodAssetId: assetId, accountId: acct, sourcePath: a?.source_key } } as any, progress: async () => {}, isCancelled: () => false });
      return { ok: true, r, err: null as any, payload: a?.payload };
    } catch (e: any) { return { ok: false, r: null, err: e, payload: a?.payload }; }
  };
  const packager = process.env.PACKAGER_BIN || 'packager';
  const hasPackager = spawnSync(packager, ['--version'], { stdio: 'ignore' }).status === 0;

  try {
    console.log('-- what the store accepts');
    {
      const { parseSourceUri, vodSourceAvailable, fetchVodSource } = await import('../src/services/media/vodSource');
      ok(!!parseSourceUri(`s3://${BUCKET}/vod-src/a/b.mp4`), 'an s3:// key under vod-src/ is an original');
      ok(!parseSourceUri(`s3://${BUCKET}/filler/acct/x.mp4`) && !parseSourceUri(`s3://${BUCKET}/vod-src/../x.mp4`) && !parseSourceUri(`s3://${BUCKET}/vod-src/`),
        'a key outside vod-src/, with .. or naming a whole prefix is refused');
      ok(!vodSourceAvailable(join(work, 'nothing.mp4')) && vodSourceAvailable(`s3://${BUCKET}/vod-src/x.mp4`), 'a missing local file is not available; a bucket original is (the fetch tells)');
      ok((await fetchVodSource(`s3://${BUCKET}/vod-src/never-written.mp4`)) === null, 'a bucket original that is not there fetches as nothing, not an error');
    }

    // ------------------------------------------------ the fault: local driver
    console.log('-- local driver: the original stays on the task that finished the upload');
    const clipA = mkVideo('a.mp4', 440);
    {
      const A = await startA('local');
      const u = await upload(A.base, 'local-original', clipA);
      ok(u.status === 200, 'the upload finishes on A', `${u.status} ${JSON.stringify(u.j).slice(0, 200)}`);
      const row = await one<any>(`SELECT source_key, encode_job_id FROM vod_assets WHERE id = $1`, [u.open.assetId]);
      ok(!!row?.source_key && row.source_key.startsWith(join(A.dir, 'clips', 'vod-src')), 'its source_key is a path on A\'s disk, as before', row?.source_key);
      ok(!!row?.encode_job_id, 'and its encode is queued for any worker', String(row?.encode_job_id));
      ok(!(await listed()).length, 'nothing went to the bucket\'s vod-src/');
      // Task A is replaced: its disk goes with it.
      await stop(A.proc);
      renameSync(A.dir, A.dir + '.gone');
      const e = await encodeOnB(u.open.assetId);
      ok(!e.ok && /source file is not there/.test(String(e.err?.message)), 'B\'s encode fails: the source file is not there', String(e.err?.message ?? 'it ran'));
    }

    // ------------------------------------------------ AWS: s3 driver
    console.log('-- s3 driver: the original lands in the bucket and B encodes it');
    let s3Asset = '';
    const clipB = mkVideo('b.mp4', 550);
    {
      const A = await startA('s3');
      const u = await upload(A.base, 'bucket-original', clipB);
      ok(u.status === 200 && u.j?.sha256 === sha(clipB), 'the upload finishes on A', `${u.status} ${JSON.stringify(u.j).slice(0, 200)}`);
      s3Asset = u.open.assetId;
      const row = await one<any>(`SELECT source_key, ingest, encode_job_id FROM vod_assets WHERE id = $1`, [s3Asset]);
      const m = /^s3:\/\/([^/]+)\/(vod-src\/.+)$/.exec(row?.source_key ?? '');
      ok(!!m && m[1] === BUCKET, 'its source_key is the original\'s s3:// address under vod-src/', row?.source_key);
      const bytes = m ? await inBucket(m[2]) : null;
      ok(!!bytes && sha(bytes) === sha(clipB), 'the object is the whole upload');
      const job = await one<any>(`SELECT payload FROM jobs WHERE id = $1`, [row?.encode_job_id]);
      ok(job?.payload?.sourcePath === row?.source_key, 'the queued encode names the bucket original, not A\'s disk', job?.payload?.sourcePath);
      ok(filesUnder(join(A.dir, 'clips', 'vod-src')).length === 0, 'A kept no copy of the original (nor its sidecar)', filesUnder(join(A.dir, 'clips', 'vod-src')).join(' '));
      ok(row?.ingest?.status === 'ingested', 'the ingest rules ran as before', row?.ingest?.status);

      // Task A is replaced; B takes the job.
      await stop(A.proc);
      renameSync(A.dir, A.dir + '.gone');
      const { fetchVodSource } = await import('../src/services/media/vodSource');
      const f = await fetchVodSource(row.source_key);
      ok(!!f && f.fetched && f.path.startsWith(join(bDir, 'scratch')) && sha(readFileSync(f.path)) === sha(clipB), 'B fetches a whole scratch copy into its own scratch space', f?.path);
      await f?.release();
      ok(!filesUnder(join(bDir, 'scratch')).length, 'and gives it back: nothing left in B\'s scratch');

      const e = await encodeOnB(s3Asset);
      if (hasPackager) {
        ok(e.ok, 'B encodes the upload A finished, from the bucket', String(e.err?.message ?? ''));
        const after = await one<any>(`SELECT master_key, encode_result FROM vod_assets WHERE id = $1`, [s3Asset]);
        ok(!!after?.master_key, 'the asset has renditions', JSON.stringify(after).slice(0, 200));
      } else {
        console.log(`SKIP full encode on B: the packager is needed (${packager}); on the Mac PACKAGER_BIN=../packager-osx-arm64/packager`);
        ok(e.ok || (e.err?.code !== 'source_missing' && !/source file is not there/.test(String(e.err?.message))), 'B\'s encode gets past the source (it fails later only for want of the packager)', String(e.err?.message ?? 'ran'));
      }
      ok(!filesUnder(join(bDir, 'scratch')).length, 'the encode leaves no scratch copy behind on B', filesUnder(join(bDir, 'scratch')).join(' '));
    }

    console.log('-- a held duplicate is in the bucket too, and skipping it removes the object');
    {
      const A = await startA('s3');
      const u = await upload(A.base, 'bucket-duplicate', clipB);
      const row = await one<any>(`SELECT source_key, ingest FROM vod_assets WHERE id = $1`, [u.open.assetId]);
      ok(row?.ingest?.status === 'duplicate', 'the same bytes again are held as a duplicate', row?.ingest?.status);
      const key = /^s3:\/\/[^/]+\/(.+)$/.exec(row?.source_key ?? '')?.[1] ?? '';
      ok(!!key && !!(await inBucket(key)), 'the held file is in the bucket, so any task can encode it if kept', row?.source_key);
      const { resolveDuplicate } = await import('../src/services/ingest/pipeline');
      const r = await resolveDuplicate(acct, u.open.assetId, 'skip');
      ok(r.status === 'skipped' && !(await inBucket(key)), 'skipping it removes its object from the bucket', key);
      await stop(A.proc);
    }

    console.log('-- frames for an old upload, read from the bucket on B');
    {
      await query(`UPDATE vod_assets SET sprite = NULL, poster_candidates = NULL, duration_ms = 2000 WHERE id = $1`, [s3Asset]);
      const { prepareFileFrames } = await import('../src/services/media/assetImage');
      const r = await prepareFileFrames(s3Asset, { force: true }).catch((e) => { console.log(e); return false; });
      ok(r === true, 'the frames are built from a scratch copy of the bucket original');
      ok(!filesUnder(join(bDir, 'scratch')).length, 'and the copy is removed afterwards');
    }

    console.log('-- the Mac: an asset whose original is on this disk');
    {
      const { fetchVodSource, deleteVodSource, landVodSource } = await import('../src/services/media/vodSource');
      process.env.VOD_SOURCE_DRIVER = 'local';
      const p = join(bDir, 'clips', 'vod-src', 'kept.mp4');
      mkdirSync(join(bDir, 'clips', 'vod-src'), { recursive: true });
      require('node:fs').writeFileSync(p, clipA);
      ok((await landVodSource(p)) === p && existsSync(p), 'landing is a no-op with the local driver');
      const f = await fetchVodSource(p);
      ok(!!f && !f.fetched && f.path === p, 'the file itself is used, nothing fetched');
      await f?.release();
      ok(existsSync(p), 'and giving it back leaves it where it is');
      await deleteVodSource(join(work, 'a.mp4'));
      ok(existsSync(join(work, 'a.mp4')), 'a path outside vod-src/ is never removed through the store');
      await deleteVodSource(p);
      ok(!existsSync(p), 'an original inside vod-src/ is removed');
    }
    {
      const keys = await listed();
      const kept = /^s3:\/\/[^/]+\/(.+)$/.exec((await one<any>(`SELECT source_key FROM vod_assets WHERE id = $1`, [s3Asset]))?.source_key ?? '')?.[1];
      ok(keys.length === 2 && keys.includes(kept!) && keys.includes(`${kept}.json`), 'vod-src/ holds just the kept original and its sidecar at the end', keys.join(' '));
    }
  } finally {
    for (const k of kids) { k.removeAllListeners('exit'); k.kill(); }
    s3srv?.close();
    await pool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
}
