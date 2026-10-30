// ============================================================================
//  SLATES AND LOOPS IN THE BUCKET (build queue 2.1a), against Postgres, the
//  real HTTP app and the real AWS SDK.
//
//  On AWS the control plane is several Fargate tasks that come and go, so a
//  slate or loop kept on one task's disk is lost with it and missing on the
//  others. With FILLER_STORE_DRIVER=s3 every way a slate or loop arrives
//  (chunked upload, copy from the Image Library, a watch folder loop) ends in
//  the bucket under its source key, nothing is left on the task's disk, and
//  `/filler/...` (the browser preview and the encoder's failover fetch) is
//  answered from the bucket, byte ranges included. The FAST render takes a
//  scratch copy. With the local driver (the Mac) nothing changes.
//
//  The bucket is a small S3-compatible server inside this test (path style,
//  aws-chunked bodies decoded), so the suite runs offline; set
//  FILLER_S3_TEST_ENDPOINT to run the same checks against MinIO, moto or S3.
//
//  Usage: DATABASE_URL=... npx tsx test/filler-store.check.ts   (a migrated, disposable database)
// ============================================================================
import { createServer as httpServer, IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };

// ---------------------------------------------------------------- the bucket
const objects = new Map<string, { body: Buffer; type: string }>();
let gets = 0;
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
function fakeS3(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const key = decodeURIComponent(new URL(req.url!, 'http://x').pathname.slice(1));   // bucket/key
    const o = objects.get(key);
    if (req.method === 'PUT' && !req.headers['x-amz-copy-source']) {
      let body = Buffer.concat(chunks);
      if (String(req.headers['content-encoding'] ?? '').includes('aws-chunked') || String(req.headers['x-amz-content-sha256'] ?? '').startsWith('STREAMING-')) body = decodeAwsChunked(body);
      objects.set(key, { body, type: String(req.headers['content-type'] ?? '') });
      res.writeHead(200, { ETag: '"e"' }); return res.end();
    }
    if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end(); }
    if (!o) { res.writeHead(404, { 'content-type': 'application/xml' }); return res.end(req.method === 'HEAD' ? undefined : '<Error><Code>NoSuchKey</Code></Error>'); }
    if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Length': o.body.length, 'Content-Type': o.type, ETag: '"e"' }); return res.end(); }
    gets++;
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (m) {
      const start = m[1] ? Number(m[1]) : o.body.length - Number(m[2]);
      const end = m[1] && m[2] ? Math.min(Number(m[2]), o.body.length - 1) : o.body.length - 1;
      if (start >= o.body.length) { res.writeHead(416); return res.end('<Error><Code>InvalidRange</Code></Error>'); }
      res.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${o.body.length}`, 'Content-Type': o.type, ETag: '"e"' });
      return res.end(o.body.subarray(start, end + 1));
    }
    res.writeHead(200, { 'Content-Length': o.body.length, 'Content-Type': o.type, ETag: '"e"' }); res.end(o.body);
  });
}

(async () => {
  const BUCKET = 'volt-filler-check';
  const external = process.env.FILLER_S3_TEST_ENDPOINT;
  let s3srv: any = null;
  if (!external) { s3srv = httpServer(fakeS3).listen(0, '127.0.0.1'); await new Promise((r) => s3srv.on('listening', r)); }
  process.env.AWS_ENDPOINT_URL = external || `http://127.0.0.1:${s3srv.address().port}`;
  process.env.S3_FORCE_PATH_STYLE = '1';
  process.env.AWS_ACCESS_KEY_ID ||= 'volt'; process.env.AWS_SECRET_ACCESS_KEY ||= 'voltvoltvolt';
  process.env.FILLER_S3_BUCKET = BUCKET;
  const work = mkdtempSync(join(tmpdir(), 'filler-store-'));
  process.env.FILLER_DIR = join(work, 'filler');
  process.env.FILLER_CACHE_DIR = join(work, 'cache');
  process.env.UPLOAD_STAGING_DIR = join(work, 'staging');
  process.env.IMAGE_STORE_DIR ||= join(work, 'images');
  delete process.env.FILLER_STORE_DRIVER;

  const { S3Client, CreateBucketCommand, GetObjectCommand, HeadObjectCommand } = await import('@aws-sdk/client-s3');
  const raw = new S3Client({ region: process.env.AWS_REGION ?? 'ap-southeast-1', forcePathStyle: true });
  await raw.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(() => { /* exists, or the fake */ });
  const inBucket = async (key: string): Promise<Buffer | null> => {
    if (!external) return objects.get(`${BUCKET}/${key}`)?.body ?? null;
    try { const r: any = await raw.send(new GetObjectCommand({ Bucket: BUCKET, Key: key })); return Buffer.from(await r.Body.transformToByteArray()); } catch { return null; }
  };
  const typeInBucket = async (key: string) => external
    ? (await raw.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => null as any))?.ContentType
    : objects.get(`${BUCKET}/${key}`)?.type;

  const { createServer } = await import('../src/server');
  const { pool, one } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { imageStore } = await import('../src/services/imageStore');
  const fs = await import('../src/services/media/fillerStore');
  const { fillerSource, vodForFiller } = await import('../src/services/fast/fillerBridge');

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`fstore-${tag}`]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `fstore-${tag}@volt.test`]))!.id;
  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' } as any);
  const api = async (method: string, path: string, body?: any) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j: any = null; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
    return { status: r.status, j };
  };
  /** The console's chunked upload, start to finish. */
  const upload = async (name: string, filename: string, kind: 'slate' | 'loop', bytes: Buffer) => {
    const o = await api('POST', '/api/uploads', { purpose: 'filler', fillerKind: kind, name, filename, totalBytes: bytes.length });
    if (o.status !== 201) throw new Error(`open ${o.status} ${JSON.stringify(o.j)}`);
    const put = await fetch(`${base}/api/uploads/${o.j.id}/chunks/0`, { method: 'PUT', headers: { authorization: `Bearer ${o.j.token}`, 'content-type': 'application/octet-stream' }, body: bytes });
    if (put.status !== 200) throw new Error(`chunk ${put.status} ${await put.text()}`);
    const fin = await fetch(`${base}/api/uploads/${o.j.id}/finish`, { method: 'POST', headers: { authorization: `Bearer ${o.j.token}` } });
    const fj: any = await fin.json().catch(() => null);
    const row = await one<any>(`SELECT * FROM filler_assets WHERE id = $1`, [o.j.assetId]);
    return { status: fin.status, body: fj, row };
  };
  const filesUnder = (dir: string): string[] => { if (!existsSync(dir)) return []; const out: string[] = []; for (const e of readdirSync(dir, { withFileTypes: true, recursive: true } as any) as any[]) if (e.isFile()) out.push(e.name); return out; };

  const sharp = (await import('sharp')).default;
  const png = await sharp({ create: { width: 640, height: 360, channels: 3, background: '#224488' } }).png().toBuffer();
  const video = Buffer.alloc(300_000); for (let i = 0; i < video.length; i++) video[i] = (i * 31 + 7) & 0xff;

  try {
    // ------------------------------------------------ the Mac: local driver
    console.log('-- local driver (the Mac)');
    ok(fs.fillerDriver() === 'local', 'local is the default');
    const L = await upload('Local slate', 'local.png', 'slate', png);
    ok(L.status === 200 && L.row?.status === 'ready', 'a slate uploaded on the Mac is ready', `${L.status} ${L.row?.status}`);
    const lkey = L.row?.source_key as string;
    ok(lkey === `filler/${acct}/${L.row?.id}.png`, 'its source key is filler/<account>/<id>.png', lkey);
    ok(existsSync(join(process.env.FILLER_DIR!, acct, `${L.row?.id}.png`)), 'the file is in FILLER_DIR as before');
    ok(!(await inBucket(lkey)), 'and not in the bucket');
    const lg = await fetch(`${base}/${lkey}`);
    ok(lg.status === 200 && Buffer.compare(Buffer.from(await lg.arrayBuffer()), png) === 0, '/filler serves it from disk');
    ok(((await fillerSource(L.row)) ?? '') === join(process.env.FILLER_DIR!, acct, `${L.row?.id}.png`), 'the FAST render opens the file itself');

    // ------------------------------------------------ AWS: the bucket
    console.log('-- s3 driver (AWS)');
    process.env.FILLER_STORE_DRIVER = 's3'; fs.resetFillerStoreClient();
    ok(fs.fillerDriver() === 's3', 'FILLER_STORE_DRIVER=s3 switches to the bucket');

    const S = await upload('Bucket loop', 'opening loop.mp4', 'loop', video);
    ok(S.status === 200 && S.row?.status === 'ready' && Number(S.row?.bytes) === video.length, 'a loop uploaded on AWS is ready with its size', `${S.status} ${S.row?.status} ${S.row?.bytes}`);
    const skey = S.row?.source_key as string;
    ok(skey === `filler/${acct}/${S.row?.id}.mp4`, 'its source key is the object key', skey);
    const sb = await inBucket(skey);
    ok(!!sb && Buffer.compare(sb, video) === 0, 'the bucket holds exactly the uploaded bytes', `${sb?.length}`);
    ok((await typeInBucket(skey)) === 'video/mp4', 'stored as video/mp4');
    ok(!existsSync(join(process.env.FILLER_DIR!, acct, `${S.row?.id}.mp4`)), 'nothing is left on the task\'s disk');
    ok(filesUnder(process.env.UPLOAD_STAGING_DIR!).length === 0, 'the upload staging holds no chunks after it lands');

    const g = await fetch(`${base}/${skey}`);
    const gb = Buffer.from(await g.arrayBuffer());
    ok(g.status === 200 && Buffer.compare(gb, video) === 0, '/filler serves it from the bucket (any task can answer)', `${g.status} ${gb.length}`);
    ok(g.headers.get('content-type') === 'video/mp4', 'with its content type', String(g.headers.get('content-type')));
    ok(/immutable/.test(String(g.headers.get('cache-control'))), 'cacheable forever, as before');
    ok(g.headers.get('accept-ranges') === 'bytes', 'and says it takes byte ranges');
    const r = await fetch(`${base}/${skey}`, { headers: { range: 'bytes=1000-1999' } });
    const rb = Buffer.from(await r.arrayBuffer());
    ok(r.status === 206 && rb.length === 1000 && Buffer.compare(rb, video.subarray(1000, 2000)) === 0, 'a byte range answers 206 with exactly those bytes (the preview and the encoder seek)', `${r.status} ${rb.length}`);
    ok(r.headers.get('content-range') === `bytes 1000-1999/${video.length}`, 'with its Content-Range', String(r.headers.get('content-range')));
    const h = await fetch(`${base}/${skey}`, { method: 'HEAD' });
    ok(h.status === 200 && h.headers.get('content-length') === String(video.length), 'HEAD answers the size', `${h.status} ${h.headers.get('content-length')}`);
    ok((await fetch(`${base}/filler/${acct}/nope.mp4`)).status === 404, 'a key with no object is 404');
    ok((await fetch(`${base}/filler/..%2F..%2Fetc%2Fpasswd`)).status === 404, 'a path that climbs out is 404');
    ok((await fetch(`${base}/filler/${acct}`)).status === 404, 'a bare account folder is 404');

    // Copy from the Image Library lands in the bucket too.
    const storeKey = `library/${acct}/slates/copy-${tag}.png`;
    await imageStore().put(storeKey, png, 'image/png');
    await one<any>(`INSERT INTO media_files(account_id, kind, path, folder, name, content_type, size_bytes, width, height, store_key)
        VALUES ($1,'slate',$2,'slates','Copy slate','image/png',$3,640,360,$4) RETURNING id`, [acct, `slates/copy-${tag}.png`, png.length, storeKey]);
    const cp = await api('POST', '/api/filler-assets/copy-from-library', { ref: '/' + storeKey });
    const cpRow = cp.j?.asset ?? cp.j;
    const cpKey = cpRow?.source_key ?? cpRow?.sourceKey ?? (await one<any>(`SELECT source_key FROM filler_assets WHERE account_id = $1 AND name = 'Copy slate'`, [acct]))?.source_key;
    ok(cp.status === 201 || cp.status === 200, 'copy from the Image Library answers', `${cp.status} ${JSON.stringify(cp.j).slice(0, 200)}`);
    const cb = cpKey ? await inBucket(cpKey) : null;
    ok(!!cb && Buffer.compare(cb, png) === 0, 'the copied slate is in the bucket', String(cpKey));
    ok(!!cpKey && !existsSync(join(process.env.FILLER_DIR!, String(cpKey).replace(/^filler\//, ''))), 'and not on the task\'s disk');

    // The FAST render's scratch copy.
    gets = 0;
    const p1 = await fillerSource(S.row);
    ok(!!p1 && p1.startsWith(process.env.FILLER_CACHE_DIR!) && Buffer.compare(readFileSync(p1), video) === 0, 'the FAST render gets a scratch copy with the same bytes', String(p1));
    const g1 = gets;
    const p2 = await fillerSource(S.row);
    ok(p2 === p1 && (external || gets === g1), 'a second render reuses it rather than fetching again', `${gets - g1} more fetches`);
    ok((await fillerSource({ ...S.row, source_key: `filler/${acct}/gone.mp4` })) === null, 'an asset with no object has no source (the render says upload it again)');

    // Landing and removing, as the watch folder loop does.
    const loose = join(work, 'dropped.mp4'); writeFileSync(loose, video.subarray(0, 5000));
    const wkey = `filler/${acct}/wf-${tag}.mp4`;
    await fs.landFile(loose, wkey);
    ok(!existsSync(loose) && (await inBucket(wkey))?.length === 5000, 'a landed file goes to the bucket and leaves the disk');
    ok((await fs.statFiller(wkey))?.size === 5000, 'its size is read from the bucket');
    await fs.deleteFiller(wkey);
    ok(!(await inBucket(wkey)) && (await fs.statFiller(wkey)) === null, 'and a removed one is gone');
    let refused = false; try { await fs.putFiller('library/x.png', png); } catch { refused = true; }
    ok(refused, 'only filler/ keys are written');
    refused = false; try { await fs.putFiller(`filler/${acct}/../../x.png`, png); } catch { refused = true; }
    ok(refused, 'a key that climbs out is refused');

    // The real render, when this machine has ffmpeg: a slate in the bucket
    // becomes a FAST library asset.
    if (spawnSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-version']).status === 0) {
      const sl = await upload('Bucket slate', 'bucket.png', 'slate', png);
      const v = await vodForFiller(acct, sl.row.id).catch((e) => ({ error: String(e?.message ?? e) } as any));
      const va = v.assetId ? await one<any>(`SELECT source_bytes FROM vod_assets WHERE id = $1`, [v.assetId]) : null;
      ok(!!v.assetId && Number(va?.source_bytes) > 0, 'a slate held only in the bucket renders for a FAST channel', JSON.stringify(v).slice(0, 200));
    } else console.log('SKIP the FAST render (no ffmpeg here)');
  } finally {
    srv.close(); s3srv?.close(); await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
