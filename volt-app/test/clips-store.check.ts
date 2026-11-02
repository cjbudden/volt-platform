// ============================================================================
//  CLIP AND ENCODE FILES FROM ANY TASK (build queue 2.1a-2b-2, first piece),
//  against Postgres, real API processes and the real AWS SDK.
//
//  On AWS a clip is cut and an encode packaged on whichever task ran the job,
//  and copied to the origin bucket (clips/<id>/ by clip.extract's uploadTree,
//  vod/<id>/ by vodStore's uploadVodDir). Here "task A" is this process: it
//  writes a clip and an encode into its own CLIPS_DIR and uploads them with
//  those same two functions. Task B is an API process with an empty CLIPS_DIR,
//  as a viewer reached through the load balancer would find it: the clip's
//  playlist, segments (with byte ranges) and MP4, the encode's playlists and
//  every download must come from the bucket. Task C is the Mac (local stores):
//  nothing is looked up in a bucket, and the originals folder is never served.
//
//  The bucket is a small S3-compatible server inside this test; set
//  UPLOAD_S3_TEST_ENDPOINT to run the same checks against moto, MinIO or S3.
//
//  Usage: DATABASE_URL=... npx tsx test/clips-store.check.ts   (a migrated, disposable database)
// ============================================================================
import { createServer as httpServer, IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn, ChildProcess } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
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
  let gets = 0;
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
      const o = objects.get(path);
      if (!o) { res.writeHead(404, { 'content-type': 'application/xml' }); return res.end(req.method === 'HEAD' ? undefined : '<Error><Code>NoSuchKey</Code></Error>'); }
      if (req.method === 'GET') gets++;
      const m = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
      if (m && req.method === 'GET') {
        const a = Number(m[1]), b = Math.min(m[2] ? Number(m[2]) : o.body.length - 1, o.body.length - 1);
        res.writeHead(206, { 'Content-Length': b - a + 1, 'Content-Range': `bytes ${a}-${b}/${o.body.length}`, 'Content-Type': o.type, ETag: '"e"' });
        return res.end(o.body.subarray(a, b + 1));
      }
      res.writeHead(200, { 'Content-Length': o.body.length, 'Content-Type': o.type, ETag: '"e"' }); res.end(req.method === 'HEAD' ? undefined : o.body);
    });
  }

  const BUCKET = 'volt-clips-check';
  const external = process.env.UPLOAD_S3_TEST_ENDPOINT;
  let s3srv: any = null;
  if (!external) { s3srv = httpServer(fakeS3).listen(0, '127.0.0.1'); await new Promise((r) => s3srv.on('listening', r)); }
  const endpoint = external || `http://127.0.0.1:${s3srv.address().port}`;
  const work = mkdtempSync(join(tmpdir(), 'clips-store-'));
  const awsEnv = { AWS_ENDPOINT_URL: endpoint, S3_FORCE_PATH_STYLE: '1', AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || 'volt', AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || 'voltvoltvolt',
    AWS_REGION: process.env.AWS_REGION || 'us-east-1', S3_BUCKET: BUCKET };
  // This process is task A, on an S3 deployment.
  const aClips = join(work, 'A', 'clips');
  Object.assign(process.env, awsEnv, { CLIPS_DIR: aClips, MEDIA_STORE_DRIVER: 's3', VOD_STORE: 's3' });
  const { S3Client, CreateBucketCommand } = await import('@aws-sdk/client-s3');
  const raw = new S3Client({ region: awsEnv.AWS_REGION, forcePathStyle: true });
  await raw.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(() => { /* exists, or the fake */ });

  const { pool, one } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`clips-${tag}`]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `clips-${tag}@volt.test`]))!.id;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' } as any);

  const kids: ChildProcess[] = [];
  const startTask = (name: string, extra: Record<string, string>): Promise<{ base: string; dir: string }> => new Promise((resolve, reject) => {
    const dir = join(work, name);
    mkdirSync(join(dir, 'clips'), { recursive: true });
    const env = { ...process.env, ...awsEnv, CLIPS_DIR: join(dir, 'clips'), IMAGE_STORE_DIR: join(dir, 'images'), FILLER_DIR: join(dir, 'filler'), PORT: '0', ...extra };
    const p = spawn(join(__dirname, '../node_modules/.bin/tsx'), [__filename, 'serve'], { env, cwd: join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
    kids.push(p);
    let out = '';
    const t = setTimeout(() => reject(new Error(`task ${name} did not start: ${out.slice(-2000)}`)), 60_000);
    p.stdout!.on('data', (b) => { out += b; const m = /PORT (\d+)/.exec(out); if (m) { clearTimeout(t); resolve({ base: `http://127.0.0.1:${m[1]}`, dir }); } });
    p.stderr!.on('data', (b) => { out += b; });
    p.on('exit', (c) => { clearTimeout(t); reject(new Error(`task ${name} exited ${c}: ${out.slice(-2000)}`)); });
  });
  const get = async (url: string, headers: Record<string, string> = {}) => {
    const r = await fetch(url, { headers });
    return { status: r.status, h: r.headers, body: Buffer.from(await r.arrayBuffer()) };
  };

  try {
    console.log('-- which paths map to the bucket');
    {
      const s = await import('../src/services/media/clipsStore');
      const id = randomUUID();
      ok(s.bucketKeyForClipsPath(`/${id}/hls/index.m3u8`)?.key === `clips/${id}/hls/index.m3u8`, 'a clip file maps to clips/<id>/');
      ok(s.bucketKeyForClipsPath(`/vod/${id}/master.m3u8`)?.key === `vod/${id}/master.m3u8`, 'an encode file maps to vod/<id>/');
      ok(!s.bucketKeyForClipsPath(`/vod-src/${id}.mp4`) && !s.bucketKeyForClipsPath(`/${id}/../vod-src/x.mp4`) && !s.bucketKeyForClipsPath('/not-an-id/x.mp4')
        && !s.bucketKeyForClipsPath(`/vod/${id}`) && !s.bucketKeyForClipsPath(`/${id}`) && !s.bucketKeyForClipsPath(`/${id}//x`),
        'originals, .., non-uuid folders, bare folders and empty segments map to nothing');
      ok(s.isPrivateClipsPath(`/vod-src/${id}.mp4`) && s.isPrivateClipsPath('/vod/_probe/x.mp4') && !s.isPrivateClipsPath(`/vod/${id}/master.m3u8`) && !s.isPrivateClipsPath(`/${id}/clip.mp4`),
        'vod-src/ and the probe scratch are private; clip and encode files are not');
      ok(s.isEncodeBucketKey(`vod/${id}/progressive.mp4`) && !s.isEncodeBucketKey(`/clips/vod/${id}/progressive.mp4`) && !s.isEncodeBucketKey(`vod-src/${id}.mp4`) && !s.isEncodeBucketKey(`https://x/vod/${id}/a.mp4`),
        'only a bare vod/<id>/<file> key is an encode bucket key');
      ok((await s.readThroughKey(`/${id}/clip.mp4`)) === `clips/${id}/clip.mp4` && (await s.readThroughKey(`/vod/${id}/a.mp4`)) === `vod/${id}/a.mp4`, 'on an S3 deployment both are read through');
      process.env.MEDIA_STORE_DRIVER = 'local'; process.env.VOD_STORE = 'local';
      const { config } = await import('../src/config');
      const was = config.mediaStore.driver; (config.mediaStore as any).driver = 'local';
      ok((await s.readThroughKey(`/${id}/clip.mp4`)) === null && (await s.readThroughKey(`/vod/${id}/a.mp4`)) === null, 'on the Mac (local stores) nothing is read through');
      (config.mediaStore as any).driver = was; process.env.MEDIA_STORE_DRIVER = 's3'; process.env.VOD_STORE = 's3';
      process.env.CLIPS_S3_UPLOAD = 'false';
      ok((await s.readThroughKey(`/${id}/clip.mp4`)) === null, 'CLIPS_S3_UPLOAD=false (clips kept local) reads no clip through');
      delete process.env.CLIPS_S3_UPLOAD;
    }

    console.log('-- task A makes a clip and an encode and copies them to the bucket');
    const clipId = randomUUID(), encId = randomUUID();
    const seg0 = randomBytes(4096), clipMp4 = randomBytes(9000), clipMp3 = randomBytes(1500), encMp4 = randomBytes(12000), encSeg = randomBytes(3000);
    const clipList = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg_0.ts\n#EXT-X-ENDLIST\n';
    const encMaster = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nv0/index.m3u8\n';
    const encMpd = '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"><Period/></MPD>';
    {
      const c = join(aClips, clipId);
      mkdirSync(join(c, 'hls'), { recursive: true });
      writeFileSync(join(c, 'hls', 'index.m3u8'), clipList); writeFileSync(join(c, 'hls', 'seg_0.ts'), seg0);
      writeFileSync(join(c, 'clip.mp4'), clipMp4); writeFileSync(join(c, 'clip.mp3'), clipMp3);
      const { uploadTree, mediaS3Client } = await import('../src/services/media/s3Driver');
      const { config } = await import('../src/config');
      const up = await uploadTree(await mediaS3Client(config.aws.region), c, BUCKET, `clips/${clipId}`);
      ok(up.files === 4, 'the clip went up with clip.extract\'s uploadTree', JSON.stringify(up));
      const e = join(aClips, 'vod', encId);
      mkdirSync(join(e, 'v0'), { recursive: true });
      writeFileSync(join(e, 'master.m3u8'), encMaster); writeFileSync(join(e, 'manifest.mpd'), encMpd);
      writeFileSync(join(e, 'v0', 'seg_1.m4s'), encSeg); writeFileSync(join(e, 'progressive.mp4'), encMp4);
      const { uploadVodDir } = await import('../src/services/fast/vodStore');
      const u2 = await uploadVodDir(e, encId);
      ok(u2.master === `vod/${encId}/master.m3u8` && u2.files === 4, 'the encode went up with vodStore\'s uploadVodDir', JSON.stringify(u2));
    }
    // The rows as the two jobs write them on an S3 deployment: a clip keeps
    // /clips/<id>/ keys, an encode stores its bucket keys.
    await one(`INSERT INTO vod_assets (id, account_id, source_kind, title, master_key, progressive_key, export_mp4_key, export_mp3_key, start_epoch_ms, end_epoch_ms, duration_ms)
      VALUES ($1,$2,'upload','Goal of the match',$3,$4,$4,$5,0,4000,4000) RETURNING id`,
      [clipId, acct, `/clips/${clipId}/hls/index.m3u8`, `/clips/${clipId}/clip.mp4`, `/clips/${clipId}/clip.mp3`]);
    await one(`INSERT INTO vod_assets (id, account_id, source_kind, title, master_key, progressive_key, formats, start_epoch_ms, end_epoch_ms, duration_ms)
      VALUES ($1,$2,'upload','Season opener',$3,$4,'{"hls":true,"dash":true,"progressive":true}',0,4000,4000) RETURNING id`,
      [encId, acct, `vod/${encId}/master.m3u8`, `vod/${encId}/progressive.mp4`]);

    console.log('-- task B (S3 deployment, empty disk) serves them');
    const B = await startTask('B', { MEDIA_STORE_DRIVER: 's3', VOD_STORE: 's3' });
    {
      const pl = await get(`${B.base}/clips/${clipId}/hls/index.m3u8`);
      ok(pl.status === 200 && pl.body.toString().includes('seg_0.ts') && /mpegurl/.test(String(pl.h.get('content-type'))), 'the clip\'s playlist comes from the bucket', `${pl.status} ${pl.body.toString().slice(0, 120)}`);
      const sg = await get(`${B.base}/clips/${clipId}/hls/seg_0.ts`);
      ok(sg.status === 200 && sg.body.equals(seg0), 'its segment, byte for byte', `${sg.status} ${sg.body.length}`);
      ok(/immutable/.test(String(sg.h.get('cache-control'))), 'with the long cache segments always had');
      const rg = await get(`${B.base}/clips/${clipId}/clip.mp4`, { range: 'bytes=100-199' });
      ok(rg.status === 206 && rg.body.equals(clipMp4.subarray(100, 200)) && rg.h.get('content-range') === `bytes 100-199/${clipMp4.length}`, 'a byte range of the MP4 (seeking) passes through', `${rg.status} ${rg.h.get('content-range')} ${rg.body.length}`);
      const em = await get(`${B.base}/clips/vod/${encId}/master.m3u8`);
      ok(em.status === 200 && em.body.toString() === encMaster, 'an encode\'s master from the bucket', `${em.status}`);
      const ed = await get(`${B.base}/clips/vod/${encId}/manifest.mpd`);
      ok(ed.status === 200 && ed.body.toString().includes('<MPD') && /dash\+xml/.test(String(ed.h.get('content-type'))), 'and its MPD', `${ed.status}`);
      const es = await get(`${B.base}/clips/vod/${encId}/v0/seg_1.m4s`);
      ok(es.status === 200 && es.body.equals(encSeg), 'and its segments', `${es.status}`);
      const nx = await get(`${B.base}/clips/${randomUUID()}/hls/index.m3u8`);
      const nx2 = await get(`${B.base}/clips/${clipId}/hls/seg_9.ts`);
      ok(nx.status === 404 && nx2.status === 404, 'a file that is nowhere is 404', `${nx.status} ${nx2.status}`);
      const before = gets;
      const sneak = await get(`${B.base}/clips/vod-src/${clipId}.mp4`);
      ok(sneak.status === 404 && gets === before, 'an original is never looked up through /clips', `${sneak.status}`);

      console.log('-- downloads on task B');
      const auth = { authorization: `Bearer ${tok}`, 'content-type': 'application/json' };
      const lc = await fetch(`${B.base}/api/downloads/vod/${clipId}`, { headers: auth });
      const lcj: any = await lc.json();
      const mp4Row = (lcj.files ?? []).find((f: any) => f.format === 'mp4'), mp3Row = (lcj.files ?? []).find((f: any) => f.format === 'mp3');
      ok(lc.status === 200 && mp4Row?.bytes === clipMp4.length && mp3Row?.bytes === clipMp3.length, 'the clip\'s files are listed with their sizes from the bucket', JSON.stringify(lcj));
      const dl = async (id: string, format: string) => {
        const l = await fetch(`${B.base}/api/downloads/vod/${id}/link`, { method: 'POST', headers: auth, body: JSON.stringify({ format }) });
        const lj: any = await l.json();
        if (l.status !== 200) return { status: l.status, h: new Headers(), body: Buffer.from(JSON.stringify(lj)) };
        return get(`${B.base}${lj.url}`);
      };
      const d1 = await dl(clipId, 'mp4');
      ok(d1.status === 200 && d1.body.equals(clipMp4) && /attachment; filename="Goal of the match\.mp4"/.test(String(d1.h.get('content-disposition'))), 'the clip\'s MP4 downloads from the bucket under its title', `${d1.status} ${d1.h.get('content-disposition')} ${d1.body.length}`);
      const d2 = await dl(clipId, 'mp3');
      ok(d2.status === 200 && d2.body.equals(clipMp3) && d2.h.get('content-type') === 'audio/mpeg', 'and its MP3', `${d2.status} ${d2.h.get('content-type')}`);
      const le = await fetch(`${B.base}/api/downloads/vod/${encId}`, { headers: auth });
      const lej: any = await le.json();
      ok(le.status === 200 && lej.files?.[0]?.bytes === encMp4.length, 'an encode\'s MP4 (stored as its bucket key) is listed with its size', JSON.stringify(lej));
      const d3 = await dl(encId, 'mp4');
      ok(d3.status === 200 && d3.body.equals(encMp4) && /Season opener\.mp4/.test(String(d3.h.get('content-disposition'))), 'and downloads (it answered "no longer here" before)', `${d3.status} ${d3.body.toString().slice(0, 120)}`);
    }

    console.log('-- task A still serves its own copy from disk');
    {
      const A = await startTask('A', { MEDIA_STORE_DRIVER: 's3', VOD_STORE: 's3', CLIPS_DIR: aClips });
      const before = gets;
      const sg = await get(`${A.base}/clips/${clipId}/hls/seg_0.ts`);
      ok(sg.status === 200 && sg.body.equals(seg0) && gets === before, 'a file on the task\'s own disk is served from it, not fetched', `${sg.status} gets ${gets - before}`);
    }

    console.log('-- task C (the Mac, local stores)');
    {
      const C = await startTask('C', { MEDIA_STORE_DRIVER: 'local', VOD_STORE: 'local' });
      const id = randomUUID();
      mkdirSync(join(C.dir, 'clips', 'vod-src'), { recursive: true });
      writeFileSync(join(C.dir, 'clips', 'vod-src', `${id}.mp4`), randomBytes(500));
      mkdirSync(join(C.dir, 'clips', 'vod', '_probe'), { recursive: true });
      writeFileSync(join(C.dir, 'clips', 'vod', '_probe', 'p.mp4'), randomBytes(100));
      mkdirSync(join(C.dir, 'clips', id), { recursive: true });
      writeFileSync(join(C.dir, 'clips', id, 'clip.mp4'), clipMp4);
      const o1 = await get(`${C.base}/clips/vod-src/${id}.mp4`);
      const o2 = await get(`${C.base}/clips/vod%2Dsrc/${id}.mp4`);
      const o3 = await get(`${C.base}/clips/vod/_probe/p.mp4`);
      ok(o1.status === 404 && o2.status === 404 && o3.status === 404, 'an upload\'s original and the probe scratch are not served (they were)', `${o1.status} ${o2.status} ${o3.status}`);
      const c1 = await get(`${C.base}/clips/${id}/clip.mp4`);
      ok(c1.status === 200 && c1.body.equals(clipMp4), 'a clip on disk is served as before');
      const before = gets;
      const c2 = await get(`${C.base}/clips/${clipId}/hls/index.m3u8`);
      ok(c2.status === 404 && gets === before, 'a clip only in a bucket is not looked up on the Mac', `${c2.status} gets ${gets - before}`);
    }
  } finally {
    for (const k of kids) { k.removeAllListeners('exit'); k.kill(); }
    s3srv?.close();
    await pool.end().catch(() => null);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
