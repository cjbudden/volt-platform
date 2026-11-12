// ============================================================================
//  A STREAM'S PRE-BUILT LOOP IN THE BUCKET (build queue 2.1a-3; services/fillerPrep.ts
//  publishPrebuilt, media/fillerStore.ts, jobConfig.ts, modules/fillerAssets.ts,
//  volt-encoder/bin/filler_build.py fetch_prebuilt).
//
//  On AWS the control plane is several Fargate tasks and the encoder runs as its
//  own ECS task: a loop built on one task's disk (ORIGIN_DIR/<stream>/filler/prebuilt)
//  was out of reach of the encoder and of every other task, so on a loss the
//  encoder had to build the loop itself, at failover time.
//
//  Against Postgres, the real AWS SDK, an S3 API (a small S3-compatible server in
//  this test; SITE_S3_TEST_ENDPOINT runs it against moto, MinIO or S3), a second
//  API process with its own disk, and the encoder's own Python:
//    - the folder name per stream and build hash, sanitised;
//    - on the Mac (FILLER_STORE_DRIVER=local) nothing is stored: the encoder reads the disk as before;
//    - on S3 every file of the build lands under filler/prebuilt/<stream>/<hash>/,
//      byte for byte, filler.json last;
//    - a second API process serves them at /filler/... (types, bytes);
//    - the encoder's fetch_prebuilt, pointed at that process, gets the whole loop;
//    - the encoder job carries the URL (and only when the build is stored);
//    - the Loops & Fillers details preview plays the stored copy, and says what it was built from;
//    - an old build's folder is removed, another stream's is not.
//
//  Usage: DATABASE_URL=... npx tsx test/filler-prebuilt-bucket.check.ts   (a migrated, disposable database)
// ============================================================================
import { createServer as httpServer, IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawn, ChildProcess } from 'node:child_process';
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
  const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };

  // ---------------------------------------------------------------- the bucket
  const objects = new Map<string, Buffer>();
  const putOrder: string[] = [];
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
          hits.map(([k, v]) => `<Contents><Key>${esc(k.slice(b.length + 1))}</Key><Size>${v.length}</Size><ETag>"e"</ETag></Contents>`).join('') + `</ListBucketResult>`;
        res.writeHead(200, { 'content-type': 'application/xml' }); return res.end(xml);
      }
      if (req.method === 'POST' && u.searchParams.has('delete')) {
        for (const m of Buffer.concat(chunks).toString().matchAll(/<Key>([^<]*)<\/Key>/g)) objects.delete(`${b}/${m[1].replace(/&lt;/g, '<').replace(/&amp;/g, '&')}`);
        res.writeHead(200, { 'content-type': 'application/xml' }); return res.end('<?xml version="1.0" encoding="UTF-8"?><DeleteResult></DeleteResult>');
      }
      if (req.method === 'PUT') {
        let body = Buffer.concat(chunks);
        if (String(req.headers['content-encoding'] ?? '').includes('aws-chunked') || String(req.headers['x-amz-content-sha256'] ?? '').startsWith('STREAMING-')) body = decodeAwsChunked(body);
        objects.set(path, body); putOrder.push(path.slice(b.length + 1)); res.writeHead(200, { ETag: '"e"' }); return res.end();
      }
      if (req.method === 'DELETE') { objects.delete(path); res.writeHead(204); return res.end(); }
      const o = objects.get(path);
      if (!o) { res.writeHead(404, { 'content-type': 'application/xml' }); return res.end(req.method === 'HEAD' ? undefined : '<Error><Code>NoSuchKey</Code></Error>'); }
      res.writeHead(200, { 'Content-Length': o.length, ETag: '"e"' }); res.end(req.method === 'HEAD' ? undefined : o);
    });
  }

  const BUCKET = `volt-prebuilt-${Date.now().toString(36)}`;   // a fresh bucket: moto keeps state between runs
  const external = process.env.SITE_S3_TEST_ENDPOINT;
  let s3srv: any = null;
  if (!external) { s3srv = httpServer(fakeS3).listen(0, '127.0.0.1'); await new Promise((r) => s3srv.on('listening', r)); }
  const endpoint = external || `http://127.0.0.1:${s3srv.address().port}`;
  const work = mkdtempSync(join(tmpdir(), 'prebuilt-'));
  const awsEnv = { AWS_ENDPOINT_URL: endpoint, AWS_ENDPOINT_URL_S3: endpoint, S3_FORCE_PATH_STYLE: '1', AWS_ACCESS_KEY_ID: process.env.SITE_S3_TEST_KEY_ID || 'volt', AWS_SECRET_ACCESS_KEY: process.env.SITE_S3_TEST_SECRET || 'voltvoltvolt',
    AWS_REGION: process.env.AWS_REGION || 'us-east-1', S3_BUCKET: BUCKET, FILLER_S3_BUCKET: BUCKET };
  const aDir = join(work, 'A');
  Object.assign(process.env, awsEnv, { ORIGIN_DIR: join(aDir, 'origin'), FILLER_DIR: join(aDir, 'filler'), CLIPS_DIR: join(aDir, 'clips'), IMAGE_STORE_DIR: join(aDir, 'images'),
    FILLER_STORE_DRIVER: 'local', INTERNAL_API_BASE_URL: 'http://control-plane.internal:8080' });
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

  // A build as filler_build.py leaves it: two tracks, playlists, filler.json.
  const FILES = ['720p/init.mp4', '720p/seg_1.m4s', '720p/seg_2.m4s', 'audio/init.mp4', 'audio/seg_1.m4s'];
  const mkBuild = (dir: string, hash: string) => {
    for (const f of FILES) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), `${hash}:${f}`); }
    writeFileSync(join(dir, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2500000\n720p.m3u8\n');
    writeFileSync(join(dir, '720p.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="720p/init.mp4"\n#EXTINF:2,\n720p/seg_1.m4s\n');
    writeFileSync(join(dir, 'filler.json'), JSON.stringify({ hash, segment_seconds: 2, loop_seconds: 4, has_watermark: false, tracks: {
      '720p': { kind: 'video', width: 1280, height: 720, init: '720p/init.mp4', segments: [{ uri: '720p/seg_1.m4s', dur: 2 }, { uri: '720p/seg_2.m4s', dur: 2 }] },
      audio: { kind: 'audio', init: 'audio/init.mp4', segments: [{ uri: 'audio/seg_1.m4s', dur: 2 }] } } }));
  };

  const P = await import('../src/services/fillerPrep');
  const FS = await import('../src/services/media/fillerStore');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const kids: ChildProcess[] = [];

  try {
    console.log('== the folder ==');
    ok(FS.prebuiltPrefix('5a0c-ab', 'f00d1e') === 'filler/prebuilt/5a0c-ab/f00d1e/', 'filler/prebuilt/<stream>/<hash>/');
    ok(FS.prebuiltPrefix('../x', '../../h?') === 'filler/prebuilt/x/h/', 'stream id and hash are reduced to plain characters (no way out of the folder)');

    const sid = 'c0ffee00-0000-4000-8000-000000000001';
    const dir = join(aDir, 'origin', sid, 'filler', 'prebuilt');
    mkBuild(dir, 'hash1');

    console.log('\n== the Mac (local driver) ==');
    ok(await P.publishPrebuilt(sid, dir, 'hash1') === null && (await listed('filler/')).length === 0, 'nothing is stored: the encoder reads the build on this disk, as before');

    console.log('\n== AWS (S3 driver): stored ==');
    process.env.FILLER_STORE_DRIVER = 's3';
    const key = await P.publishPrebuilt(sid, dir, 'hash1');
    ok(key === `filler/prebuilt/${sid}/hash1/`, 'the build is stored under filler/prebuilt/<stream>/<hash>/', key);
    const stored = await listed(key!);
    ok(stored.length === FILES.length + 3, 'every file: 5 media files, 2 playlists and filler.json', stored);
    let same = true;
    for (const f of FILES) same = same && (await inBucket(key + f)) === `hash1:${f}`;
    ok(same, 'byte for byte');
    const mine = putOrder.filter((k) => k.startsWith(key!));
    if (external) ok(true, 'upload order: skipped against an external endpoint (only the in-test bucket records it)');
    else ok(mine[mine.length - 1] === key + 'filler.json' && mine.slice(0, 5).every((k) => !/\.(m3u8|json)$/.test(k)), 'media first, playlists next, filler.json last (a reader that finds it finds every file)', mine);

    console.log('\n== served by another task, fetched by the encoder ==');
    const bDir = join(work, 'B');
    const env = { ...process.env, ...awsEnv, FILLER_STORE_DRIVER: 's3', ORIGIN_DIR: join(bDir, 'origin'), FILLER_DIR: join(bDir, 'filler'), CLIPS_DIR: join(bDir, 'clips'), IMAGE_STORE_DIR: join(bDir, 'images'), PORT: '0' };
    const B: { base: string } = await new Promise((resolve, reject) => {
      const p = spawn(join(__dirname, '../node_modules/.bin/tsx'), [__filename, 'serve'], { env, cwd: join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
      kids.push(p);
      let out = '';
      const t = setTimeout(() => reject(new Error(`task B did not start: ${out.slice(-1500)}`)), 60_000);
      p.stdout!.on('data', (b) => { out += b; const m = /PORT (\d+)/.exec(out); if (m) { clearTimeout(t); resolve({ base: `http://127.0.0.1:${m[1]}` }); } });
      p.stderr!.on('data', (b) => { out += b; });
      p.on('exit', (c) => { clearTimeout(t); reject(new Error(`task B exited ${c}: ${out.slice(-1500)}`)); });
    });
    ok(!existsSync(join(bDir, 'origin', sid)), 'task B has nothing of the build on its disk');
    let r = await fetch(`${B.base}/${key}720p/seg_2.m4s`);
    ok(r.status === 200 && (await r.text()) === 'hash1:720p/seg_2.m4s' && r.headers.get('content-type') === 'video/iso.segment', 'task B serves a segment from the bucket', r.status);
    r = await fetch(`${B.base}/${key}master.m3u8`);
    ok(r.status === 200 && /mpegurl/.test(r.headers.get('content-type') ?? '') && /720p\.m3u8/.test(await r.text()), 'and the master playlist, as a playlist (the console preview plays it)');
    r = await fetch(`${B.base}/filler/prebuilt/${sid}/hash1/../../../etc/passwd`);
    ok(r.status === 404, 'nothing outside the store is reachable', r.status);
    const bin = join(__dirname, '../../volt-encoder/bin');
    const dest = join(work, 'encoder', 'filler-pre', 'hash1');
    // Asynchronous: task B reads the in-test bucket served from this process.
    const py: { status: number | null; stdout: string; stderr: string } = await new Promise((resolve) => {
      const p = spawn('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(bin)}); import filler_build, json; print(json.dumps(filler_build.fetch_prebuilt(sys.argv[1], sys.argv[2])['hash']))`, `${B.base}/${key}`, dest], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      p.stdout!.on('data', (b) => { stdout += b; }); p.stderr!.on('data', (b) => { stderr += b; });
      const t = setTimeout(() => p.kill(), 60_000);
      p.on('exit', (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); });
    });
    let got = py.status === 0;
    for (const f of FILES) got = got && existsSync(join(dest, f)) && readFileSync(join(dest, f), 'utf8') === `hash1:${f}`;
    ok(got && existsSync(join(dest, 'filler.json')), "the encoder's fetch_prebuilt gets the whole loop from task B", (py.stderr || py.stdout).slice(-800));

    console.log('\n== the encoder job ==');
    const { buildEncoderJobConfig } = await import('../src/services/jobConfig');
    const ctx = (fb: any): any => ({
      kind: 'channel', account: {},
      owner: { id: sid, input_failover_enabled: true, input_loss_behavior: 'vod_loop', filler_build: fb },
      inputs: [{ role: 'primary', rendition_label: null, rendition_bitrate_kbps: null, protocol: 'srt', ingest_url: 'srt://x', stream_key: null }],
      profile: { rungs: [{ height: 720, bitrate_kbps: 2500 }], packaging: 'both', workflow_type: 'transcode', codec_backend: 'x264', segment_dur: 2, dvr_window_sec: 60 },
    });
    let pre = buildEncoderJobConfig(ctx({ status: 'ready', dir, hash: 'hash1', key }))?.redundancy?.filler?.prebuilt;
    ok(pre?.url === `http://control-plane.internal:8080/${key}` && pre?.dir === dir && pre?.hash === 'hash1', 'a stored build: the job names its URL on the control plane (the dir and hash as before)', pre);
    pre = buildEncoderJobConfig(ctx({ status: 'ready', dir, hash: 'hash1' }))?.redundancy?.filler?.prebuilt;
    ok(pre && !('url' in pre) && pre.dir === dir, 'a build on the Mac: no URL, the dir as before', pre);
    pre = buildEncoderJobConfig(ctx({ status: 'building' }))?.redundancy?.filler?.prebuilt;
    ok(!pre, 'a build not ready: no prebuilt at all');

    console.log('\n== Loops & Fillers details ==');
    const tag = Date.now().toString(36);
    const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`prebuilt-${tag}`]))!.id;
    const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `prebuilt-${tag}@example.com`]))!.id;
    const tok = signAccess({ sub: user, account_id: acct, role: 'owner' } as any);
    const asset = (await one<any>(`INSERT INTO filler_assets(account_id, kind, name, status, source_key) VALUES ($1,'loop','Loop',  'ready', $2) RETURNING id`, [acct, `filler/${acct}/loop.mp4`]))!.id;
    const grp = (await one<any>(`INSERT INTO groups(account_id, name) VALUES ($1,'G') RETURNING id`, [acct]))!.id;
    const ch = (await one<any>(`INSERT INTO channels(group_id, name, input_failover_enabled, input_loss_behavior, filler_asset_id, filler_build) VALUES ($1,'Stored',true,'vod_loop',$2,$3::jsonb) RETURNING id`,
      [grp, asset, JSON.stringify({ status: 'ready', dir: '/gone/with/the/task', hash: 'hash1', key, built_from: `http://control-plane.internal:8080/filler/${acct}/loop.mp4` })]))!.id;
    r = await fetch(`${B.base}/api/filler-assets/${asset}/details`, { headers: { authorization: `Bearer ${tok}` } });
    const body: any = await r.json().catch(() => null);
    const use = (body?.streams ?? []).find((s: any) => s.id === ch || s.name === 'Stored');
    ok(r.status === 200 && use?.build?.preview === `/${key}master.m3u8`, 'the preview plays the stored copy (any task serves it), though the building task is gone', use?.build ?? body);
    ok(use?.build?.fromThisAsset === true, 'and it says the copy was made from this loop (recorded on the build, not read from a disk)', use?.build);

    console.log('\n== a rebuild removes the old folder ==');
    await raw.send(new PutObjectCommand({ Bucket: BUCKET, Key: `filler/prebuilt/other-stream/hash9/filler.json`, Body: '{}' }));
    const n = await FS.deleteFillerPrefix(key!);
    ok(n === FILES.length + 3 && (await listed(key!)).length === 0, 'the old build is removed whole', n);
    ok((await listed('filler/prebuilt/other-stream/')).length === 1, "another stream's build is untouched");
    ok(await FS.deleteFillerPrefix('vod/') === 0 && await FS.deleteFillerPrefix('filler/') === 0 && (await listed('filler/prebuilt/other-stream/')).length === 1, 'only a folder inside filler/<...>/ is accepted (not vod/, not the whole store)');
    const src = readFileSync(join(__dirname, '../src/services/fillerPrep.ts'), 'utf8');
    ok(/const prev = await fillerStatus\(kind, id\)[\s\S]*setBuild\(kind, id, \{ status: 'building'[\s\S]*publishPrebuilt\(id, dir, meta\.hash\)[\s\S]*if \(prev\?\.key && prev\.key !== key\)[\s\S]*deleteFillerPrefix\(prev\.key\)/.test(src),
      'the build job reads the previous build before marking it building, stores the new one, then removes the old folder (order checked in the source: the build itself needs the packager)');
  } catch (e: any) {
    // An exception part-way is a failure, never a quiet stop that reads as a pass.
    fail++; console.log('FAIL the suite stopped: ' + (e?.stack ?? e));
  } finally {
    for (const k of kids) k.kill();
    s3srv?.close();
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
}
