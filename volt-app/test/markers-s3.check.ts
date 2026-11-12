// ============================================================================
//  INTRO AND CREDITS DETECTION WITH THE S3 STORE (build queue 2.1a-2b-7),
//  against Postgres, the real AWS SDK and real audio.
//
//  On AWS the task running detection rarely holds an episode's files: they
//  live in the bucket, so detection found nothing. Now each episode's audio
//  is fetched from its bucket copy (audio export, progressive MP4 or download,
//  else the bucket original; an encrypted title its original only) into job
//  scratch, and released when detection ends.
//
//  Three episodes share a 40 s theme at different points, each held in the
//  bucket a different way, none on this task's disk.
//
//  The bucket is a small S3-compatible server inside this test; set
//  UPLOAD_S3_TEST_ENDPOINT to run the same checks against moto, MinIO or S3.
//  Usage: DATABASE_URL=... npx tsx test/markers-s3.check.ts   (ffmpeg with Chromaprint on PATH)
// ============================================================================
import { createServer as httpServer, IncomingMessage, ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

main().catch((e) => { console.error(e); process.exit(1); });

async function main() {
  let pass = 0, fail = 0;
  const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };

  // ---------------------------------------------------------------- the bucket
  const objects = new Map<string, { body: Buffer; type: string; cache: string }>();
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
        objects.set(path, { body, type: String(req.headers['content-type'] ?? 'application/octet-stream'), cache: String(req.headers['cache-control'] ?? '') });
        res.writeHead(200, { ETag: '"e"' }); return res.end();
      }
      if (req.method === 'DELETE') { objects.delete(path); res.writeHead(204); return res.end(); }
      const o = objects.get(path);
      if (!o) { res.writeHead(404, { 'content-type': 'application/xml' }); return res.end(req.method === 'HEAD' ? undefined : '<Error><Code>NoSuchKey</Code></Error>'); }
      res.writeHead(200, { 'Content-Length': o.body.length, 'Content-Type': o.type, ETag: '"e"' }); res.end(req.method === 'HEAD' ? undefined : o.body);
    });
  }

  const BUCKET = 'volt-markers-s3-check';
  const external = process.env.UPLOAD_S3_TEST_ENDPOINT;
  let s3srv: any = null;
  if (!external) { s3srv = httpServer(fakeS3).listen(0, '127.0.0.1'); await new Promise((r) => s3srv.on('listening', r)); }
  const endpoint = external || `http://127.0.0.1:${s3srv.address().port}`;
  const work = mkdtempSync(join(tmpdir(), 'markers-s3-'));
  const clips = join(work, 'clips');
  mkdirSync(clips, { recursive: true });
  Object.assign(process.env, {
    AWS_ENDPOINT_URL: endpoint, S3_FORCE_PATH_STYLE: '1', AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || 'volt', AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || 'voltvoltvolt',
    AWS_REGION: process.env.AWS_REGION || 'us-east-1', S3_BUCKET: BUCKET,
    CLIPS_DIR: clips, FILLER_DIR: join(work, 'filler'), IMAGE_STORE_DIR: join(work, 'images'), MEDIA_STORE_DRIVER: 's3', VOD_STORE: 's3', VOD_SOURCE_DRIVER: 's3',
  });
  const { S3Client, CreateBucketCommand, GetObjectCommand, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const raw = new S3Client({ region: process.env.AWS_REGION, forcePathStyle: true });
  await raw.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(() => { /* exists, or the fake */ });
  const get = async (key: string): Promise<string | null> => {
    if (!external) return objects.get(`${BUCKET}/${key}`)?.body.toString('utf8') ?? null;
    try { const r: any = await raw.send(new GetObjectCommand({ Bucket: BUCKET, Key: key })); return Buffer.from(await r.Body.transformToByteArray()).toString('utf8'); } catch { return null; }
  };
  const putObject = (key: string, body: Buffer | string, type = 'application/octet-stream') =>
    raw.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: typeof body === 'string' ? Buffer.from(body) : body, ContentType: type }));

  const scratch = join(work, 'scratch');
  mkdirSync(scratch, { recursive: true });
  process.env.VOD_SOURCE_CACHE_DIR = scratch;
  process.env.VOD_SOURCE_S3_BUCKET = BUCKET;

  // ---------------------------------------------------------------- real audio
  const d = join(work, 'audio'); mkdirSync(d);
  const ff = (...a: string[]) => execFileSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...a]);
  ff('-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*(220+110*floor(mod(t*2\\,8)))*t)+0.2*sin(2*PI*(330+55*floor(mod(t*1.5\\,6)))*t)+0.15*sin(2*PI*82*t)*lt(mod(t\\,0.5)\\,0.08)':s=22050:d=40", '-ac', '1', join(d, 'theme.wav'));
  const bed = (name: string, f: number, rate: number, dur: number, seed: number) => ff(
    '-f', 'lavfi', '-i', `aevalsrc='0.25*sin(2*PI*(${f}+70*floor(mod(t*${rate}\\,9)))*t)':s=22050:d=${dur}`,
    '-f', 'lavfi', '-i', `anoisesrc=color=brown:amplitude=0.05:sample_rate=22050:d=${dur}:seed=${seed}`,
    '-filter_complex', 'amix=inputs=2', '-ac', '1', join(d, name));
  bed('a1.wav', 300, 3.1, 20, 1); bed('a2.wav', 180, 2.3, 90, 2);
  bed('b1.wav', 410, 1.7, 55, 3); bed('b2.wav', 260, 2.9, 150, 4);
  bed('c1.wav', 150, 4.2, 8, 5); bed('c2.wav', 500, 1.3, 90, 6);
  const ep = (out: string, parts: string[]) => {
    const inputs = parts.flatMap((p) => ['-i', join(d, p)]);
    ff(...inputs, '-filter_complex', `${parts.map((_, i) => `[${i}:a]aresample=22050,aformat=channel_layouts=mono[a${i}]`).join(';')};${parts.map((_, i) => `[a${i}]`).join('')}concat=n=${parts.length}:v=0:a=1`, '-c:a', 'aac', '-b:a', '128k', join(d, out));
  };
  ep('A.m4a', ['a1.wav', 'theme.wav', 'a2.wav']);      // theme 20-60
  ep('B.m4a', ['b1.wav', 'theme.wav', 'b2.wav']);      // theme 55-95
  ep('C.m4a', ['c1.wav', 'theme.wav', 'c2.wav']);      // theme 8-48

  const { pool, one, query } = await import('../src/db');
  const mk = await import('../src/services/vodMarkers');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`markers-s3-${tag}`]))!.id;
  const asset = async (title: string, set: Record<string, any>, durMs = 150_000) => {
    const id = randomUUID();
    await one(`INSERT INTO vod_assets (id, account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, metadata)
               VALUES ($1,$2,'upload','export',$3,0,$4,$4,'{"series":"Harbour Tales"}'::jsonb) RETURNING id`, [id, acct, title, durMs]);
    for (const [k, v] of Object.entries(set)) await query(`UPDATE vod_assets SET ${k} = $2 WHERE id = $1`, [id, typeof v === 'function' ? v(id) : v]);
    return id;
  };
  // A: a clip's audio export (clips/<id>/ in the bucket). B: an encode's MP4 download (vod/<id>/).
  // C: only its original, in the bucket under vod-src/.
  const A = await asset('Harbour Tales 1', {}, 150_000);
  await query(`UPDATE vod_assets SET export_m4a_key = $2 WHERE id = $1`, [A, `/clips/${A}/audio.m4a`]);
  await putObject(`clips/${A}/audio.m4a`, readFileSync(join(d, 'A.m4a')), 'audio/mp4');
  const B = await asset('Harbour Tales 2', {}, 245_000);  // long enough that the intro window (half of it) holds 55 to 95 s
  await query(`UPDATE vod_assets SET export_mp4_key = $2, master_key = $3 WHERE id = $1`, [B, `vod/${B}/download.mp4`, `vod/${B}/master.m3u8`]);
  await putObject(`vod/${B}/download.mp4`, readFileSync(join(d, 'B.m4a')), 'video/mp4');
  const C = await asset('Harbour Tales 3', {}, 138_000);
  await query(`UPDATE vod_assets SET source_key = $2 WHERE id = $1`, [C, `s3://${BUCKET}/vod-src/${C}.m4a`]);
  await putObject(`vod-src/${C}.m4a`, readFileSync(join(d, 'C.m4a')), 'audio/mp4');
  const rowOf = async (id: string) => one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [id]);
  const left = () => readdirSync(scratch);

  try {
    console.log('-- where each episode\'s audio is read from');
    for (const [id, what] of [[A, 'a clip\'s audio export'], [B, 'an encode\'s MP4 download'], [C, 'the original in the bucket']] as const) {
      ok(mk.mediaPathFor(await rowOf(id)) === null, `${what}: nothing on this task's disk (the old answer: no media)`);
      const s = await mk.mediaSourceFor(await rowOf(id));
      ok(!!s && s.fetched && readFileSync(s.path).length > 1000, `${what}: fetched from the bucket into scratch`, JSON.stringify(s));
      await s?.release();
    }
    ok(left().length === 0, 'released copies leave nothing in scratch', JSON.stringify(left()));

    const E = await asset('Harbour Tales 4', {});
    await query(`UPDATE vod_assets SET export_mp4_key = $2, encode_result = '{"drm":"cbcs"}'::jsonb WHERE id = $1`, [E, `vod/${E}/download.mp4`]);
    await putObject(`vod/${E}/download.mp4`, readFileSync(join(d, 'A.m4a')), 'video/mp4');
    ok((await mk.mediaSourceFor(await rowOf(E))) === null, 'an encrypted title with no original: nothing, never its packaged files');
    await query(`UPDATE vod_assets SET source_key = $2 WHERE id = $1`, [E, `s3://${BUCKET}/vod-src/${E}.m4a`]);
    await putObject(`vod-src/${E}.m4a`, readFileSync(join(d, 'A.m4a')), 'audio/mp4');
    const es = await mk.mediaSourceFor(await rowOf(E));
    ok(!!es && es.path.endsWith(`${E}.m4a`), '...with its original in the bucket: the original', es?.path);
    await es?.release();
    await query(`DELETE FROM vod_assets WHERE id = $1`, [E]);
    const G = await asset('Harbour Tales 5', {});
    await query(`UPDATE vod_assets SET export_m4a_key = $2 WHERE id = $1`, [G, `/clips/${G}/audio.m4a`]);
    ok((await mk.mediaSourceFor(await rowOf(G))) === null, 'a key whose object is not in the bucket: nothing, not an error');
    await query(`DELETE FROM vod_assets WHERE id = $1`, [G]);

    const local = join(clips, randomUUID(), 'audio.m4a');
    mkdirSync(join(local, '..'), { recursive: true }); writeFileSync(local, readFileSync(join(d, 'A.m4a')));
    const L = await asset('Elsewhere', {});
    await query(`UPDATE vod_assets SET export_m4a_key = $2 WHERE id = $1`, [L, `/clips/${local.slice(clips.length + 1)}`]);
    const ls = await mk.mediaSourceFor(await rowOf(L));
    ok(!!ls && !ls.fetched && ls.path === local, 'a file on this task\'s disk is used in place, as on the Mac', ls?.path);
    await query(`DELETE FROM vod_assets WHERE id = $1`, [L]);

    console.log('-- detection with every episode in the bucket');
    const r = await mk.detectMarkers(A);
    ok(r.peers.length === 2 && r.peers.includes(B) && r.peers.includes(C), 'both other episodes are compared, read from the bucket', JSON.stringify(r));
    const intro = async (id: string) => one<any>(`SELECT start_ms, end_ms, status FROM vod_markers WHERE vod_asset_id = $1 AND kind = 'intro'`, [id]);
    const near = (got: number | undefined, want: number) => got != null && Math.abs(got - want) <= 1000;
    const ia = await intro(A), ib = await intro(B), ic = await intro(C);
    ok(near(ia?.start_ms, 20_000) && near(ia?.end_ms, 60_000), 'episode 1\'s intro is found at 20 to 60 s', JSON.stringify(ia));
    ok(near(ib?.start_ms, 55_000) && near(ib?.end_ms, 95_000), 'episode 2\'s at 55 to 95 s (its peer, from its MP4 download)', JSON.stringify(ib));
    ok(near(ic?.start_ms, 8_000) && near(ic?.end_ms, 48_000), 'episode 3\'s at 8 to 48 s (from its original)', JSON.stringify(ic));
    ok(/Compared with 2 other episodes/.test(r.note), 'the note says what it compared', r.note);
    ok(left().length === 0, 'and no copy is left in scratch afterwards', JSON.stringify(left()));

    const N = await asset('Lost Episode', {});
    const rn = await mk.detectMarkers(N);
    ok(/not available yet/.test(rn.note) && /storage bucket/.test(rn.note), 'an episode with no file anywhere says so', rn.note);
  } finally {
    s3srv?.close();
    await pool.end();
  }
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
}
