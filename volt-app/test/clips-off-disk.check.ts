// ============================================================================
//  AD CONDITIONING, FAST RENDERS AND CAPTION TRACKS OFF THE TASK'S DISK
//  (build queue 2.1a-2b-3), against Postgres, a real API process, real ffmpeg
//  and the real AWS SDK.
//
//  On AWS the control plane is several tasks sharing one job queue, and the
//  task that starts a piece of work is rarely the one that finishes it or
//  serves it. Three things still lived only on the starting task's disk:
//    - an ad creative's download (CLIPS_DIR/ads/<creative>/source.mp4), which
//      the vod.encode job, on any task, then had to open;
//    - the FAST render of a slate or loop (FILLER_DIR/<account>/<id>.fast.mp4),
//      which the channel's prepare encodes, on any task;
//    - the files the caption tracks' clock is read from (an asset's master,
//      variant, init and first segment), read from CLIPS_DIR only, so on S3 a
//      track's cues lost their X-TIMESTAMP-MAP and drifted from the picture.
//  With VOD_SOURCE_DRIVER=s3 the first two land in the bucket under vod-src/
//  like any original; the third reads through the bucket copy the job made.
//  The Mac (local drivers) must behave exactly as before.
//
//  The bucket is a small S3-compatible server inside this test; set
//  UPLOAD_S3_TEST_ENDPOINT to run the same checks against moto, MinIO or S3
//  (the bucket-content checks then read through the SDK).
//
//  Usage: DATABASE_URL=... npx tsx test/clips-off-disk.check.ts   (a migrated, disposable database)
// ============================================================================
import { createServer as httpServer, IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
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
  const objects = new Map<string, { body: Buffer; type: string }>();
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
      const u = new URL(req.url!, 'http://x');
      const path = decodeURIComponent(u.pathname.slice(1));
      if (req.method === 'PUT') {
        let body = Buffer.concat(chunks);
        if (String(req.headers['content-encoding'] ?? '').includes('aws-chunked') || String(req.headers['x-amz-content-sha256'] ?? '').startsWith('STREAMING-')) body = decodeAwsChunked(body);
        objects.set(path, { body, type: String(req.headers['content-type'] ?? 'application/octet-stream') }); res.writeHead(200, { ETag: '"e"' }); return res.end();
      }
      if (req.method === 'DELETE') { objects.delete(path); res.writeHead(204); return res.end(); }
      const o = objects.get(path);
      if (!o) { res.writeHead(404, { 'content-type': 'application/xml' }); return res.end(req.method === 'HEAD' ? undefined : '<Error><Code>NoSuchKey</Code></Error>'); }
      res.writeHead(200, { 'Content-Length': o.body.length, 'Content-Type': o.type, ETag: '"e"' }); res.end(req.method === 'HEAD' ? undefined : o.body);
    });
  }

  const BUCKET = 'volt-offdisk-check';
  const external = process.env.UPLOAD_S3_TEST_ENDPOINT;
  let s3srv: any = null;
  if (!external) { s3srv = httpServer(fakeS3).listen(0, '127.0.0.1'); await new Promise((r) => s3srv.on('listening', r)); }
  const endpoint = external || `http://127.0.0.1:${s3srv.address().port}`;
  const work = mkdtempSync(join(tmpdir(), 'clips-off-disk-'));
  const awsEnv = { AWS_ENDPOINT_URL: endpoint, S3_FORCE_PATH_STYLE: '1', AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || 'volt', AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || 'voltvoltvolt',
    AWS_REGION: process.env.AWS_REGION || 'us-east-1', S3_BUCKET: BUCKET };
  // This process is task A of an S3 deployment. Images (caption WebVTT) are
  // shared through one folder so task B can read the track this test writes.
  const aClips = join(work, 'A', 'clips'), aFiller = join(work, 'A', 'filler'), images = join(work, 'images');
  mkdirSync(aClips, { recursive: true }); mkdirSync(aFiller, { recursive: true });
  Object.assign(process.env, awsEnv, { CLIPS_DIR: aClips, FILLER_DIR: aFiller, IMAGE_STORE_DIR: images, MEDIA_STORE_DRIVER: 's3', VOD_STORE: 's3',
    VOD_SOURCE_DRIVER: 's3', VOD_SOURCE_CACHE_DIR: join(work, 'A', 'src-cache') });
  const { S3Client, CreateBucketCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const raw = new S3Client({ region: awsEnv.AWS_REGION, forcePathStyle: true });
  await raw.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(() => { /* exists, or the fake */ });
  const inBucket = async (key: string): Promise<Buffer | null> => {
    if (!external) return objects.get(`${BUCKET}/${key}`)?.body ?? null;
    try { const r: any = await raw.send(new GetObjectCommand({ Bucket: BUCKET, Key: key })); return Buffer.from(await r.Body.transformToByteArray()); } catch { return null; }
  };
  const putObject = async (key: string, body: Buffer, type = 'application/octet-stream') => {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await raw.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: type }));
  };

  const { pool, one } = await import('../src/db');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`offdisk-${tag}`]))!.id;

  // The ad server's creative, served over HTTP like a VAST MediaFile.
  const creativeBytes = randomBytes(64 * 1024);
  const adSrv = httpServer((req, res) => { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': creativeBytes.length }); res.end(creativeBytes); }).listen(0, '127.0.0.1');
  await new Promise((r) => adSrv.on('listening', r));
  const adUrl = `http://127.0.0.1:${(adSrv.address() as any).port}/creative.mp4`;

  const kids: ChildProcess[] = [];
  const startTask = (name: string, extra: Record<string, string>): Promise<{ base: string }> => new Promise((resolve, reject) => {
    const dir = join(work, name);
    mkdirSync(join(dir, 'clips'), { recursive: true });
    const env = { ...process.env, ...awsEnv, CLIPS_DIR: join(dir, 'clips'), FILLER_DIR: join(dir, 'filler'), IMAGE_STORE_DIR: images, PORT: '0', ...extra };
    const p = spawn(join(__dirname, '../node_modules/.bin/tsx'), [__filename, 'serve'], { env, cwd: join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
    kids.push(p);
    let out = '';
    const t = setTimeout(() => reject(new Error(`task ${name} did not start: ${out.slice(-2000)}`)), 60_000);
    p.stdout!.on('data', (b) => { out += b; const m = /PORT (\d+)/.exec(out); if (m) { clearTimeout(t); resolve({ base: `http://127.0.0.1:${m[1]}` }); } });
    p.stderr!.on('data', (b) => { out += b; });
    p.on('exit', (c) => { clearTimeout(t); reject(new Error(`task ${name} exited ${c}: ${out.slice(-2000)}`)); });
  });

  const ctxFor = (payload: Record<string, unknown>) => ({ job: { payload } as any, progress: async () => {}, isCancelled: () => false }) as any;

  try {
    const { handleAdCondition } = await import('../src/services/jobs/handlers/adCondition');
    const { fetchVodSource, vodSourceAvailable } = await import('../src/services/media/vodSource');

    console.log('-- an ad creative on S3: the download lands in the bucket, any task can encode it');
    {
      const c = (await one<any>(`INSERT INTO ad_creatives (account_id, creative_key, source_url, title, duration_ms) VALUES ($1,$2,$3,'Spot A',15000) RETURNING id`, [acct, `uaid-a-${tag}`, adUrl]))!;
      const r: any = await handleAdCondition(ctxFor({ accountId: acct, creativeKey: `uaid-a-${tag}` }));
      const a = await one<any>(`SELECT source_key, metadata FROM vod_assets WHERE id = $1`, [r.vodAssetId]);
      const key = `vod-src/ads/${c.id}/source.mp4`;
      ok(a?.source_key === `s3://${BUCKET}/${key}`, 'the asset\'s source_key is the creative\'s own bucket key', String(a?.source_key));
      ok((await inBucket(key))?.equals(creativeBytes) === true, 'the bucket holds the creative\'s bytes');
      ok(!existsSync(join(aClips, 'vod-src', 'ads', c.id, 'source.mp4')) && !existsSync(join(aClips, 'ads', c.id, 'source.mp4')), 'nothing of it is left on this task\'s disk');
      const job = await one<any>(`SELECT payload FROM jobs WHERE dedupe_key = $1`, [`vodenc:${r.vodAssetId}`]);
      ok(job?.payload?.sourcePath === a?.source_key, 'the encode job is given the bucket key, not a path on this task', JSON.stringify(job?.payload));
      const f = await fetchVodSource(job?.payload?.sourcePath);
      ok(!!f && f.fetched && readFileSync(f.path).equals(creativeBytes), 'the encode, on whichever task, gets a scratch copy of the same bytes');
      if (f) { const p = f.path; await f.release(); ok(!existsSync(p), 'and the scratch copy is gone when the job is done'); }
      const c2 = (await one<any>(`INSERT INTO ad_creatives (account_id, creative_key, source_url) VALUES ($1,$2,$3) RETURNING id`, [acct, `uaid-b-${tag}`, adUrl]))!;
      const r2: any = await handleAdCondition(ctxFor({ accountId: acct, creativeKey: `uaid-b-${tag}` }));
      const a2 = await one<any>(`SELECT source_key FROM vod_assets WHERE id = $1`, [r2.vodAssetId]);
      ok(a2?.source_key === `s3://${BUCKET}/vod-src/ads/${c2.id}/source.mp4` && a2?.source_key !== a?.source_key, 'a second creative lands under its own key (no shared source.mp4)');
      const st = await one<any>(`SELECT status, vod_asset_id FROM ad_creatives WHERE id = $1`, [c.id]);
      ok(st?.status === 'conditioning' && st?.vod_asset_id === r.vodAssetId, 'the creative is conditioning and points at its asset, as before');
    }

    console.log('-- an ad creative on the Mac (local originals): unchanged');
    {
      process.env.VOD_SOURCE_DRIVER = 'local';
      const before = objects.size;
      const c = (await one<any>(`INSERT INTO ad_creatives (account_id, creative_key, source_url) VALUES ($1,$2,$3) RETURNING id`, [acct, `uaid-mac-${tag}`, adUrl]))!;
      const r: any = await handleAdCondition(ctxFor({ accountId: acct, creativeKey: `uaid-mac-${tag}` }));
      const local = join(aClips, 'ads', c.id, 'source.mp4');
      const a = await one<any>(`SELECT source_key FROM vod_assets WHERE id = $1`, [r.vodAssetId]);
      const job = await one<any>(`SELECT payload FROM jobs WHERE dedupe_key = $1`, [`vodenc:${r.vodAssetId}`]);
      ok(existsSync(local) && readFileSync(local).equals(creativeBytes), 'the download stays in CLIPS_DIR/ads/<creative>/');
      ok(job?.payload?.sourcePath === local && a?.source_key == null, 'the encode reads it there; source_key is left empty as before');
      ok(external ? true : objects.size === before, 'nothing is written to a bucket');
      process.env.VOD_SOURCE_DRIVER = 's3';
    }

    const ff = spawnSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-version']);
    if (ff.status !== 0) {
      ok(false, 'ffmpeg is needed for the FAST render checks (set FFMPEG_BIN)');
    } else {
      const { vodForFiller } = await import('../src/services/fast/fillerBridge');
      const slate = async (name: string) => {
        const fa = (await one<any>(`INSERT INTO filler_assets (account_id, kind, name, source_key, status) VALUES ($1,'slate',$2,'',  'ready') RETURNING id`, [acct, name]))!;
        const key = `filler/${acct}/${fa.id}.png`;
        await one(`UPDATE filler_assets SET source_key = $2 WHERE id = $1 RETURNING id`, [fa.id, key]);
        mkdirSync(join(aFiller, acct), { recursive: true });
        const png = join(aFiller, acct, `${fa.id}.png`);
        const g = spawnSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180', '-frames:v', '1', png]);
        if (g.status !== 0) throw new Error(`could not make a test slate: ${g.stderr}`);
        return fa.id as string;
      };

      console.log('-- the FAST render of a slate on S3: lands in the bucket, the prepare can read it anywhere');
      {
        const fid = await slate(`Slate S3 ${tag}`);
        const r = await vodForFiller(acct, fid);
        const a = await one<any>(`SELECT source_key, metadata FROM vod_assets WHERE id = $1`, [r.assetId]);
        const key = `vod-src/fast-filler/${acct}/${fid}.fast.mp4`;
        ok(r.created && a?.source_key === `s3://${BUCKET}/${key}`, 'the library asset\'s source_key is the render\'s bucket key', String(a?.source_key));
        const body = await inBucket(key);
        ok(!!body && body.length > 1000 && body.subarray(4, 8).toString() === 'ftyp', 'the bucket holds the rendered MP4', `${body?.length} bytes`);
        ok(!existsSync(join(aFiller, acct, `${fid}.fast.mp4`)) && !existsSync(join(aClips, 'vod-src', 'fast-filler', acct, `${fid}.fast.mp4`)), 'nothing of the render is left on this task\'s disk');
        ok(vodSourceAvailable(a?.source_key) && a?.metadata?.fastFiller === true, 'the prepare counts it as available; it is still a hidden fastFiller asset');
        const f = await fetchVodSource(a?.source_key);
        ok(!!f && readFileSync(f.path).equals(body!), 'the prepare\'s encode gets a scratch copy of it');
        await f?.release();
        const again = await vodForFiller(acct, fid);
        ok(!again.created && again.assetId === r.assetId, 'a second channel using the slate shares the same asset (no second render)');
      }

      console.log('-- the FAST render on the Mac: unchanged');
      {
        process.env.VOD_SOURCE_DRIVER = 'local';
        const fid = await slate(`Slate Mac ${tag}`);
        const r = await vodForFiller(acct, fid);
        const a = await one<any>(`SELECT source_key FROM vod_assets WHERE id = $1`, [r.assetId]);
        const local = join(aFiller, acct, `${fid}.fast.mp4`);
        ok(a?.source_key === local && existsSync(local), 'written beside the filler files, source_key is that path', String(a?.source_key));
        ok(!(await inBucket(`vod-src/fast-filler/${acct}/${fid}.fast.mp4`)), 'and not to the bucket');
        process.env.VOD_SOURCE_DRIVER = 's3';
      }
    }

    console.log('-- caption tracks: the clock is read from the bucket copy when this task has none');
    const { timestampMap } = await import('../src/services/companions/delivery');
    const serve = await import('../src/services/companions/serve');
    const box = (type: string, body: Buffer) => { const b = Buffer.alloc(8); b.writeUInt32BE(8 + body.length); b.write(type, 4, 'ascii'); return Buffer.concat([b, body]); };
    const mdhd = Buffer.alloc(24); mdhd.writeUInt32BE(90_000, 12);
    const init = Buffer.concat([box('ftyp', Buffer.alloc(8)), box('moov', box('trak', box('mdia', box('mdhd', mdhd))))]);
    const tfdt = Buffer.alloc(12); tfdt[0] = 1; tfdt.writeBigUInt64BE(10n * 90_000n, 4);
    const seg = Buffer.concat([box('styp', Buffer.alloc(8)), box('moof', Buffer.concat([box('mfhd', Buffer.alloc(8)), box('traf', Buffer.concat([box('tfhd', Buffer.alloc(8)), box('tfdt', tfdt)]))]))]);
    const want = timestampMap(10n * 90_000n, 90_000);
    const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nv360/index.m3u8\n';
    const MEDIA = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.0,\nseg_1.m4s\n#EXT-X-ENDLIST\n';
    const encId = randomUUID(), clipId = randomUUID();
    for (const [base] of [[`vod/${encId}`], [`clips/${clipId}`]]) {
      await putObject(`${base}/master.m3u8`, Buffer.from(MASTER), 'application/vnd.apple.mpegurl');
      await putObject(`${base}/v360/index.m3u8`, Buffer.from(MEDIA), 'application/vnd.apple.mpegurl');
      await putObject(`${base}/v360/init.mp4`, init, 'video/mp4');
      await putObject(`${base}/v360/seg_1.m4s`, seg, 'video/iso.segment');
    }
    {
      ok(serve.clipsPathOfMaster(`vod/${encId}/master.m3u8`) === `/vod/${encId}/master.m3u8` && serve.clipsPathOfMaster(`/clips/${clipId}/master.m3u8`) === `/${clipId}/master.m3u8`,
        'an encode\'s bucket master_key and a clip\'s /clips key both name a path under /clips');
      ok(serve.clipsPathOfMaster('https://cdn.example/x.m3u8') === null && serve.clipsPathOfMaster('/live/abc/master.m3u8') === null && serve.clipsPathOfMaster(null) === null,
        'a URL, a live path or nothing names none');
      ok((await serve.timestampMapFor(`/vod/${encId}/master.m3u8`)) === want, 'an encode held only in the bucket gives its X-TIMESTAMP-MAP', String(await serve.timestampMapFor(`/vod/${encId}/master.m3u8`)));
      ok((await serve.timestampMapFor(`/${clipId}/master.m3u8`)) === want, 'so does a clip held only in the bucket');
      await putObject(`vod-src/${encId}.mp4`, Buffer.from('original'));
      ok((await serve.readClipsFile(`/vod-src/${encId}.mp4`)) === null && (await serve.readClipsFile(`/../../etc/passwd`)) === null && (await serve.readClipsFile(`/vod/${encId}/../../vod-src/${encId}.mp4`)) === null,
        'originals and paths outside CLIPS_DIR are never read through');
      mkdirSync(join(aClips, 'vod', encId), { recursive: true });
      writeFileSync(join(aClips, 'vod', encId, 'local.txt'), 'on this disk');
      ok((await serve.readClipsFile(`/vod/${encId}/local.txt`))?.toString() === 'on this disk', 'a file this task holds is read from its disk first');
      process.env.VOD_STORE = 'local';
      ok((await serve.timestampMapFor(`/vod/${encId}/master.m3u8`)) === null, 'on the Mac (local stores) nothing is looked up in a bucket');
      process.env.VOD_STORE = 's3';
    }

    console.log('-- the subtitle route on another task');
    {
      // An encode made on another task: its row names the bucket key, its files are only in the bucket.
      await one(`INSERT INTO vod_assets (id, account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, master_key)
                 VALUES ($1,$2,'upload','clip','Captioned',0,2000,2000,$3) RETURNING id`, [encId, acct, `vod/${encId}/master.m3u8`]);
      const { imageStore } = await import('../src/services/imageStore');
      const vttKey = `companions/${acct}/${encId}/en.vtt`;
      await imageStore().put(vttKey, Buffer.from('WEBVTT\n\n00:00:00.500 --> 00:00:01.500\nHello\n'), 'text/vtt');
      const fid = (await one<any>(`INSERT INTO vod_asset_files (asset_id, account_id, kind, format, name, store_key, vtt_key, language, enabled)
                                   VALUES ($1,$2,'captions','vtt','en.vtt',$3,$3,'en',true) RETURNING id`, [encId, acct, vttKey]))!.id;
      const b = await startTask('B', { MEDIA_STORE_DRIVER: 's3', VOD_STORE: 's3', VOD_SOURCE_DRIVER: 's3' });
      const r = await fetch(`${b.base}/clips/vod/${encId}/subs/${fid}.vtt`);
      const t = await r.text();
      ok(r.status === 200 && t.split('\n')[1] === want, 'a task with an empty CLIPS_DIR serves the track with the clock from the bucket', `${r.status} ${JSON.stringify(t.slice(0, 120))}`);
      ok(t.includes('00:00:00.500 --> 00:00:01.500'), 'the cues are the track\'s own');
      const d = await fetch(`${b.base}/clips/vod/${encId}/subs/${fid}.dash.vtt`).then((x) => x.text());
      ok(!d.includes('X-TIMESTAMP-MAP'), 'the DASH form carries no map, as before');
    }
  } finally {
    for (const k of kids) k.kill();
    adSrv.close();
    s3srv?.close();
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
