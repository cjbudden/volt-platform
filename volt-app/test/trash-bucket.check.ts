// ============================================================================
//  THE RESTORE BIN IN THE BUCKET (build queue 2.1a-2c; services/media/trash.ts,
//  vodRemove.ts, fast/vodStore.ts moveKey, putFileAt, getKeyTo).
//
//  On AWS the control plane is several Fargate tasks and a task's disk goes with
//  it. Before this item the bin kept deleted files on the disk of the task that
//  did the delete (VOLT_TRASH_DIR), so a restore asked of another task found
//  nothing, and an original held in the bucket (vod-src/, 2.1a-2b) was never
//  touched by a delete: it stayed in the bucket for good after the purge.
//
//  Against Postgres, the real AWS SDK and an S3 API (a small S3-compatible server
//  inside this test that copies and bulk-deletes; set SITE_S3_TEST_ENDPOINT to run
//  the same checks against moto, MinIO or S3):
//    - the driver: local unless VOLT_TRASH_DRIVER=s3;
//    - the Mac (local driver) is unchanged: files wait under VOLT_TRASH_DIR and a
//      restore renames them back;
//    - on the S3 driver, deleting a bucket-held VOD output moves its package
//      (vod/<id>/), its original and sidecar (exact keys: a neighbour whose name
//      only starts the same stays) and the task's local copy into trash/<item>/,
//      and leaves nothing for the item on this disk;
//    - a restore run by ANOTHER process (task B: its own VOLT_TRASH_DIR, nothing
//      on its disk) puts the asset row, the package, the original, the sidecar
//      and the local files back, byte for byte, and empties trash/<item>/;
//    - the purge deletes trash/<item>/ and the original; the neighbour stays;
//    - an original another asset still points at stays where it is;
//    - segments of a run (filesUnder) go to the bucket and come back; a file
//      already back in place is kept, not overwritten;
//    - with the bucket refusing writes, the delete fails and nothing leaves the disk.
//
//  Usage: DATABASE_URL=... npx tsx test/trash-bucket.check.ts   (a migrated, disposable database)
// ============================================================================
import { createServer as httpServer, IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Task B: a second process with its own disk and bin folder, asked only to restore.
if (process.argv[2] === 'restore') {
  (async () => {
    const { restoreItem } = await import('../src/services/media/trash');
    const r = await restoreItem(process.argv[3], { accountId: process.argv[4], by: 'task-b' });
    console.log('RESULT ' + JSON.stringify(r));
    (await import('../src/db')).pool.end();
  })().catch((e) => { console.error(e); process.exit(1); });
} else {
  main().catch((e) => { console.error(e); process.exit(1); });
}

async function main() {
  let pass = 0, fail = 0;
  const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };

  // ---------------------------------------------------------------- the bucket
  const objects = new Map<string, Buffer>();
  let refusePuts = false;
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
      const b = path.split('/')[0];
      if (req.method === 'GET' && u.searchParams.get('list-type') === '2') {
        const prefix = u.searchParams.get('prefix') ?? '';
        const hits = [...objects.entries()].filter(([k]) => k.startsWith(`${b}/${prefix}`)).sort();
        const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${b}</Name><Prefix>${esc(prefix)}</Prefix><KeyCount>${hits.length}</KeyCount><IsTruncated>false</IsTruncated>` +
          hits.map(([k, v]) => `<Contents><Key>${esc(k.slice(b.length + 1))}</Key><Size>${v.length}</Size><ETag>"e"</ETag><StorageClass>STANDARD</StorageClass></Contents>`).join('') + `</ListBucketResult>`;
        res.writeHead(200, { 'content-type': 'application/xml' }); return res.end(xml);
      }
      if (req.method === 'POST' && u.searchParams.has('delete')) {
        const body = Buffer.concat(chunks).toString();
        for (const m of body.matchAll(/<Key>([^<]*)<\/Key>/g)) objects.delete(`${b}/${m[1].replace(/&lt;/g, '<').replace(/&amp;/g, '&')}`);
        res.writeHead(200, { 'content-type': 'application/xml' }); return res.end('<?xml version="1.0" encoding="UTF-8"?><DeleteResult></DeleteResult>');
      }
      if (req.method === 'PUT') {
        if (refusePuts) { res.writeHead(503, { 'content-type': 'application/xml' }); return res.end('<Error><Code>ServiceUnavailable</Code><Message>refused by the test</Message></Error>'); }
        const copy = req.headers['x-amz-copy-source'];
        if (copy) {
          const src = decodeURIComponent(String(copy)).replace(/^\//, '');
          const o = objects.get(src);
          if (!o) { res.writeHead(404, { 'content-type': 'application/xml' }); return res.end('<Error><Code>NoSuchKey</Code></Error>'); }
          objects.set(path, Buffer.from(o));
          res.writeHead(200, { 'content-type': 'application/xml' }); return res.end('<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>"e"</ETag><LastModified>2026-11-12T00:00:00.000Z</LastModified></CopyObjectResult>');
        }
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

  const BUCKET = 'volt-trash-check';
  const external = process.env.SITE_S3_TEST_ENDPOINT;
  let s3srv: any = null;
  if (!external) { s3srv = httpServer(fakeS3).listen(0, '127.0.0.1'); await new Promise((r) => s3srv.on('listening', r)); }
  const endpoint = external || `http://127.0.0.1:${s3srv.address().port}`;
  const work = mkdtempSync(join(tmpdir(), 'trash-bucket-'));
  const awsEnv = { AWS_ENDPOINT_URL: endpoint, AWS_ENDPOINT_URL_S3: endpoint, S3_FORCE_PATH_STYLE: '1', AWS_ACCESS_KEY_ID: process.env.SITE_S3_TEST_KEY_ID || 'volt', AWS_SECRET_ACCESS_KEY: process.env.SITE_S3_TEST_SECRET || 'voltvoltvolt',
    AWS_REGION: process.env.AWS_REGION || 'us-east-1', S3_BUCKET: BUCKET, VOD_SOURCE_S3_BUCKET: BUCKET };
  // Task A (this process): its own disk, set before any module reads config.
  const aDir = join(work, 'A');
  Object.assign(process.env, awsEnv, { CLIPS_DIR: join(aDir, 'clips'), VOLT_TRASH_DIR: join(aDir, 'trash'), IMAGE_STORE_DIR: join(aDir, 'images'),
    FILLER_DIR: join(aDir, 'filler'), ORIGIN_DIR: join(aDir, 'origin'), VOD_STORE: 's3', VOD_SOURCE_DRIVER: 's3' });
  delete process.env.VOLT_TRASH_DRIVER;
  const { S3Client, CreateBucketCommand, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const raw = new S3Client({ region: awsEnv.AWS_REGION, forcePathStyle: true, endpoint });
  await raw.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(() => { /* exists, or the fake */ });
  const listed = async (prefix: string): Promise<string[]> => {
    const r: any = await raw.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
    return (r.Contents ?? []).map((c: any) => String(c.Key)).sort();
  };
  const inBucket = async (key: string): Promise<string | null> => {
    try { const r: any = await raw.send(new GetObjectCommand({ Bucket: BUCKET, Key: key })); return Buffer.from(await r.Body.transformToByteArray()).toString(); } catch { return null; }
  };
  const put = (Key: string, Body: string) => raw.send(new PutObjectCommand({ Bucket: BUCKET, Key, Body }));
  const filesUnder = (d: string): string[] => existsSync(d) ? (readdirSync(d, { recursive: true, withFileTypes: true } as any) as any[]).filter((e) => e.isFile()).map((e) => join(e.parentPath ?? e.path, e.name)).sort() : [];

  const T = await import('../src/services/media/trash');
  const { removeVodAsset } = await import('../src/services/vodRemove');
  const { pool, one, query } = await import('../src/db');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`trash-bucket-${tag}`]))!.id as string;

  // A title as the bucket store leaves it: a package under vod/<id>/, an original and its
  // sidecar under vod-src/, and the task's local copy of the package under clips/vod/<id>.
  const mk = async (title: string, o: { localSource?: boolean; sourceKey?: string } = {}) => {
    const id = (await one<any>(
      `INSERT INTO vod_assets (account_id, source_kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, availability_state)
       VALUES ($1,'upload',$2,'pending',0,0,1,'draft') RETURNING id`, [acct, title]))!.id as string;
    await put(`vod/${id}/master.m3u8`, '#EXTM3U\n');
    await put(`vod/${id}/v0/seg_1.m4s`, `segment of ${id}`);
    const local = join(process.env.CLIPS_DIR!, 'vod', id);
    mkdirSync(join(local, 'v0'), { recursive: true });
    writeFileSync(join(local, 'master.m3u8'), '#EXTM3U\n'); writeFileSync(join(local, 'v0', 'seg_1.m4s'), `local segment of ${id}`);
    let src: string;
    if (o.sourceKey) src = o.sourceKey;
    else if (o.localSource) {
      src = join(process.env.CLIPS_DIR!, 'vod-src', `${id}.mp4`); mkdirSync(join(process.env.CLIPS_DIR!, 'vod-src'), { recursive: true }); writeFileSync(src, `original of ${id}`);
    } else {
      const key = `vod-src/${id}/film.mp4`;
      await put(key, `original of ${id}`); await put(`${key}.json`, `{"sidecar":"${id}"}`);
      await put(`${key}0`, 'a neighbour whose name only starts the same');
      src = `s3://${BUCKET}/${key}`;
    }
    await query(`UPDATE vod_assets SET master_key = $2, source_key = $3 WHERE id = $1`, [id, `vod/${id}/master.m3u8`, src]);
    return { id, local, src };
  };
  const row = (id: string) => one<any>(`SELECT id, title, source_key FROM vod_assets WHERE id = $1`, [id]);
  // Asynchronous on purpose: the in-test bucket is served from this process, so a
  // blocking spawnSync would leave task B waiting on a bucket that cannot answer.
  const restoreOnTaskB = (binId: string): Promise<{ status: number | null; result: any; out: string }> => new Promise((resolve) => {
    const bDir = join(work, 'B');
    const env = { ...process.env, ...awsEnv, VOLT_TRASH_DRIVER: 's3', CLIPS_DIR: join(bDir, 'clips'), VOLT_TRASH_DIR: join(bDir, 'trash'), IMAGE_STORE_DIR: join(aDir, 'images') };
    const p = spawn(join(__dirname, '../node_modules/.bin/tsx'), [__filename, 'restore', binId, acct], { env, cwd: join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout!.on('data', (b) => { out += b; }); p.stderr!.on('data', (b) => { out += b; });
    const t = setTimeout(() => p.kill(), 90_000);
    p.on('exit', (status) => { clearTimeout(t); const m = /RESULT (.*)/.exec(out); resolve({ status, result: m ? JSON.parse(m[1]) : null, out }); });
  });

  try {
    // Read through `any` so the same file runs against the code before this item and fails there on behaviour.
    const drv = (): string => (T as any).trashDriver?.() ?? 'missing';
    console.log('== the driver ==');
    ok(drv() === 'local', 'local unless VOLT_TRASH_DRIVER=s3 (the Mac keeps its bin on disk)');
    process.env.VOLT_TRASH_DRIVER = 's3';
    ok(drv() === 's3', 'VOLT_TRASH_DRIVER=s3 puts it in the bucket');
    process.env.VOLT_TRASH_DRIVER = 'local';

    console.log('\n== the Mac: local driver, unchanged ==');
    const M = await mk('Mac title', { localSource: true });
    const mBin = await removeVodAsset(M.id, { reason: 'test' });
    ok(!!mBin && !(await row(M.id)) && !existsSync(M.local) && !existsSync(M.src), 'deleted: row, local package and local original leave their places');
    ok(filesUnder(join(process.env.VOLT_TRASH_DIR!, mBin!)).length === 3, 'and wait under VOLT_TRASH_DIR/<item>', filesUnder(join(process.env.VOLT_TRASH_DIR!, mBin!)));
    let r: any = await T.restoreItem(mBin!, { accountId: acct });
    ok(!!(await row(M.id)) && existsSync(join(M.local, 'v0', 'seg_1.m4s')) && readFileSync(M.src, 'utf8') === `original of ${M.id}`, 'restored by rename: row, package and original back', r);
    ok(!existsSync(join(process.env.VOLT_TRASH_DIR!, mBin!)), 'the bin folder is gone after the restore');

    console.log('\n== AWS: delete a bucket-held VOD output ==');
    process.env.VOLT_TRASH_DRIVER = 's3';
    const A = await mk('Bucket title');
    const key = A.src.slice(`s3://${BUCKET}/`.length);
    const bin = await removeVodAsset(A.id, { reason: 'test' });
    ok(!!bin && !(await row(A.id)), 'deleted: the asset row is in the bin', bin);
    ok((await listed(`vod/${A.id}/`)).length === 0 && JSON.stringify(await listed(`trash/${bin}/vod/${A.id}/`)) === JSON.stringify([`trash/${bin}/vod/${A.id}/master.m3u8`, `trash/${bin}/vod/${A.id}/v0/seg_1.m4s`]),
      'the package moved from vod/<id>/ to trash/<item>/vod/<id>/', await listed(`trash/${bin}/`));
    ok(await inBucket(key) === null && await inBucket(`${key}.json`) === null && await inBucket(`trash/${bin}/${key}`) === `original of ${A.id}` && await inBucket(`trash/${bin}/${key}.json`) === `{"sidecar":"${A.id}"}`,
      'the original and its sidecar moved to trash/<item>/vod-src/... (they used to stay for good)');
    ok(await inBucket(`${key}0`) === 'a neighbour whose name only starts the same' && !(await listed(`trash/${bin}/${key}0`)).length, 'exact keys: a neighbour whose name only starts the same is not taken');
    ok(!existsSync(A.local) && (await listed(`trash/${bin}/output/`)).length === 2, 'the task\'s local copy left the disk for trash/<item>/output/...', await listed(`trash/${bin}/output/`));
    ok(!existsSync(join(process.env.VOLT_TRASH_DIR!, bin!)), 'nothing for the item is kept on this task\'s disk');
    const item = await one<any>(`SELECT files, objects, bytes, file_count FROM trash_items WHERE id = $1`, [bin]);
    ok(item.files.length === 1 && item.files[0].store === 's3' && item.objects.length === 3 && item.objects.filter((o: any) => o.key).length === 2 && item.file_count === 6,
      'the item records the bucket files, the package prefix and the two exact keys (6 files)', item);

    console.log('\n== AWS: restore from another task ==');
    const B = await restoreOnTaskB(bin!);
    ok(B.status === 0 && B.result?.files === 6 && B.result?.skipped === 0, 'task B (own disk, own VOLT_TRASH_DIR, nothing on it) restores the item: 6 files, none skipped', B.result ?? B.out.slice(-1500));
    ok((await row(A.id))?.source_key === A.src, 'the asset row is back with its original\'s address');
    ok(JSON.stringify(await listed(`vod/${A.id}/`)) === JSON.stringify([`vod/${A.id}/master.m3u8`, `vod/${A.id}/v0/seg_1.m4s`]) && await inBucket(`vod/${A.id}/v0/seg_1.m4s`) === `segment of ${A.id}`, 'the package is back under vod/<id>/');
    ok(await inBucket(key) === `original of ${A.id}` && await inBucket(`${key}.json`) === `{"sidecar":"${A.id}"}`, 'the original and its sidecar are back at their keys');
    ok(readFileSync(join(A.local, 'v0', 'seg_1.m4s'), 'utf8') === `local segment of ${A.id}` && readFileSync(join(A.local, 'master.m3u8'), 'utf8') === '#EXTM3U\n', 'the local files are back where they were, byte for byte');
    ok((await listed(`trash/${bin}/`)).length === 0, 'trash/<item>/ is empty after the restore');
    ok((await one<any>(`SELECT state FROM trash_items WHERE id = $1`, [bin]))!.state === 'restored', 'the item is marked restored');

    console.log('\n== AWS: purge ==');
    const bin2 = await removeVodAsset(A.id, { reason: 'test again' });
    ok((await listed(`trash/${bin2}/`)).length === 6, 'deleted again: 6 objects in trash/<item>/', await listed(`trash/${bin2}/`));
    await T.purgeItem(bin2!);
    ok((await listed(`trash/${bin2}/`)).length === 0 && (await listed(`vod/${A.id}/`)).length === 0 && await inBucket(key) === null, 'the purge deletes trash/<item>/: package, original, sidecar and local copy are gone');
    ok(await inBucket(`${key}0`) !== null, 'the neighbour key is still there');
    ok((await one<any>(`SELECT state FROM trash_items WHERE id = $1`, [bin2]))!.state === 'purged', 'the item is marked purged');

    console.log('\n== an original another asset uses ==');
    const S1 = await mk('Shared one');
    const S2 = await mk('Shared two', { sourceKey: S1.src });
    const sBin = await removeVodAsset(S2.id, { reason: 'test' });
    const sKey = S1.src.slice(`s3://${BUCKET}/`.length);
    ok(!!sBin && await inBucket(sKey) === `original of ${S1.id}` && !(await listed(`trash/${sBin}/vod-src/`)).length, 'the original stays where it is while another asset points at it');

    console.log('\n== segments of a run (filesUnder) ==');
    const run = join(process.env.ORIGIN_DIR!, 'stream-x', 'run-1');
    mkdirSync(join(run, 'v0'), { recursive: true }); mkdirSync(join(run, 'a0'), { recursive: true });
    for (const f of ['v0/seg_1.m4s', 'v0/seg_2.m4s', 'a0/seg_1.m4s', 'v0/seg_3.m4s']) writeFileSync(join(run, f), `run ${f}`);
    const it = await T.BinItem.open({ accountId: acct, kind: 'recording_media', subjectId: null, label: 'run', reason: 'test' });
    await it.filesUnder(run, [join(run, 'v0/seg_1.m4s'), join(run, 'v0/seg_2.m4s'), join(run, 'a0/seg_1.m4s')], 'run');
    const runBin = await it.save();
    ok(!existsSync(join(run, 'v0/seg_1.m4s')) && !existsSync(join(run, 'a0/seg_1.m4s')) && existsSync(join(run, 'v0/seg_3.m4s')), 'the pruned segments left the disk, the kept one stayed');
    ok((await listed(`trash/${runBin}/run/0/`)).length === 3, 'they are in trash/<item>/run/0/ with their folders', await listed(`trash/${runBin}/`));
    writeFileSync(join(run, 'v0/seg_2.m4s'), 'written again since');
    r = await T.restoreItem(runBin, { accountId: acct });
    ok(r.files === 2 && r.skipped === 1, 'restore: 2 back, 1 skipped because a file is already in its place', r);
    ok(readFileSync(join(run, 'a0/seg_1.m4s'), 'utf8') === 'run a0/seg_1.m4s' && readFileSync(join(run, 'v0/seg_2.m4s'), 'utf8') === 'written again since', 'restored files have their bytes; the one already there is not overwritten');

    console.log('\n== the bucket refuses writes ==');
    if (external) ok(true, 'skipped against an external endpoint (it cannot be told to refuse)');
    else {
      const F = await mk('Unreachable', { localSource: true });
      refusePuts = true;
      let err = '';
      try { await removeVodAsset(F.id, { reason: 'test' }); } catch (e: any) { err = String(e?.message ?? e); }
      refusePuts = false;
      ok(!!err && !!(await row(F.id)), 'the delete fails and the asset row stays', err);
      ok(existsSync(join(F.local, 'v0', 'seg_1.m4s')) && existsSync(F.src) && (await listed(`vod/${F.id}/`)).length === 2, 'nothing left the disk or the package', { local: existsSync(F.local), src: existsSync(F.src) });
    }
  } catch (e: any) {
    // An exception part-way is a failure, never a quiet stop that reads as a pass.
    fail++; console.log('FAIL the suite stopped: ' + (e?.stack ?? e));
  } finally {
    s3srv?.close();
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
}
