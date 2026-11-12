// ============================================================================
//  THE HOUSE PREVIEW OF A SLATE OR LOOP IN THE BUCKET (build queue 2.1a-3b;
//  services/media/fillerPreview.ts, media/fillerStore.ts putFillerDir and
//  copyFillerPrefix).
//
//  On AWS the control plane is several tasks that come and go. The house
//  preview (11 Nov) was kept under ORIGIN_DIR/filler-preview/<id>/ on the disk
//  of the task that built it, so it did not play from the others, QC could not
//  run on them, and it was lost with the task.
//
//  Against Postgres, the real AWS SDK, an S3 API (a small S3-compatible server
//  in this test; SITE_S3_TEST_ENDPOINT runs it against moto, MinIO or S3), a
//  second API process with its own disk, and real ffmpeg (QC and its stills):
//    - the folder per build, sanitised; the upload order; QC's working files left out;
//    - on the Mac (FILLER_STORE_DRIVER=local) nothing changes: built under
//      ORIGIN_DIR and served from /origin, nothing in the bucket;
//    - on S3 the build lands under filler/preview/<id>/<build>/, its URL is
//      there, its QC stills beside it, and the task's disk keeps nothing;
//    - a second task plays it (playlists, repeats, segments, stills) and runs
//      QC over it from the bucket, with the same findings and new stills, and
//      leaves no scratch behind;
//    - a rebuild gets a new folder and the old one is removed;
//    - a build missing from storage is a QC error, not a crash;
//    - deleting the slate or loop removes its stored previews, nobody else's.
//
//  The build itself is filler_build.py with Shaka Packager, which this suite
//  does not need: ENCODER_BIN points at a stand-in that lays the build out the
//  same way with ffmpeg alone (fMP4 HLS, <label>.m3u8 + <label>/, audio).
//  filler-preview.check.ts runs the real build where the packager is installed.
//
//  Usage: DATABASE_URL=... npx tsx test/filler-preview-bucket.check.ts   (a migrated, disposable database)
// ============================================================================
import { createServer as httpServer, IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A stand-in for filler_build.py: the same arguments, the same layout, the same
// last line of JSON, with ffmpeg's own HLS muxer in place of the packager.
const FAKE_BUILD = String.raw`
import json, os, shutil, subprocess, sys, time
spec = json.load(open(sys.argv[1])); out = sys.argv[2]
t0 = time.time(); seg = float(spec["segment_seconds"]); src = spec["source"]["path"]
still = spec["source"]["kind"] == "image"
if still:
    L = 2 * seg
else:
    d = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src], capture_output=True, text=True).stdout.strip() or 0)
    L = max(2, min(int(d // seg), int(spec["max_loop_seconds"] // seg))) * seg
tmp = out.rstrip("/") + ".tmp"
shutil.rmtree(tmp, ignore_errors=True); os.makedirs(tmp)
inp = (["-loop", "1"] if still else []) + ["-i", src]
def hls(label, args):
    d = os.path.join(tmp, label); os.makedirs(d)
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *inp, "-t", str(L), *args,
        "-f", "hls", "-start_number", "1", "-hls_time", str(seg), "-hls_playlist_type", "vod", "-hls_segment_type", "fmp4",
        "-hls_fmp4_init_filename", "init.mp4", "-hls_segment_filename", os.path.join(d, "seg_%d.m4s"), os.path.join(d, "index.m3u8")], check=True)
    lines = []
    for l in open(os.path.join(d, "index.m3u8")).read().splitlines():
        if l.startswith("#EXT-X-MAP:URI="):
            l = '#EXT-X-MAP:URI="%s/init.mp4"' % label
        elif l and not l.startswith("#"):
            l = label + "/" + l
        lines.append(l)
    os.remove(os.path.join(d, "index.m3u8"))
    open(os.path.join(tmp, label + ".m3u8"), "w").write("\n".join(lines) + "\n")
master = ["#EXTM3U", "#EXT-X-VERSION:7"]
if spec.get("audio") and not still:
    hls("audio", ["-vn", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "128k"])
    master.append('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"')
for v in spec["video"]:
    g = int(round(v["fps"] * seg))
    hls(v["label"], ["-an", "-vf", "scale=%d:%d,fps=%s" % (v["width"], v["height"], v["fps"]), "-c:v", "libx264", "-preset", "ultrafast",
        "-pix_fmt", "yuv420p", "-g", str(g), "-keyint_min", str(g), "-sc_threshold", "0", "-b:v", "800k"])
    master.append('#EXT-X-STREAM-INF:BANDWIDTH=%d,RESOLUTION=%dx%d%s' % (v["bitrate_kbps"] * 1000, v["width"], v["height"], ',AUDIO="audio"' if spec.get("audio") and not still else ""))
    master.append(v["label"] + ".m3u8")
open(os.path.join(tmp, "master.m3u8"), "w").write("\n".join(master) + "\n")
meta = {"hash": "fake", "segment_seconds": seg, "loop_seconds": L, "build_seconds": round(time.time() - t0, 1)}
json.dump(meta, open(os.path.join(tmp, "filler.json"), "w"))
shutil.rmtree(out, ignore_errors=True); os.replace(tmp, out)
print(json.dumps(meta))
`;

// After FAKE_BUILD is defined: main() reaches it before its first await.
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

  const BUCKET = `volt-preview-${Date.now().toString(36)}`;   // a fresh bucket: moto keeps state between runs
  const external = process.env.SITE_S3_TEST_ENDPOINT;
  let s3srv: any = null;
  if (!external) { s3srv = httpServer(fakeS3).listen(0, '127.0.0.1'); await new Promise((r) => s3srv.on('listening', r)); }
  const endpoint = external || `http://127.0.0.1:${s3srv.address().port}`;
  const work = mkdtempSync(join(tmpdir(), 'preview-bucket-'));
  const bin = join(work, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'filler_build.py'), FAKE_BUILD);
  const awsEnv = { AWS_ENDPOINT_URL: endpoint, AWS_ENDPOINT_URL_S3: endpoint, S3_FORCE_PATH_STYLE: '1', AWS_ACCESS_KEY_ID: process.env.SITE_S3_TEST_KEY_ID || 'volt', AWS_SECRET_ACCESS_KEY: process.env.SITE_S3_TEST_SECRET || 'voltvoltvolt',
    AWS_REGION: process.env.AWS_REGION || 'us-east-1', S3_BUCKET: BUCKET, FILLER_S3_BUCKET: BUCKET, ENCODER_BIN: bin, PYTHON_BIN: 'python3' };
  const aDir = join(work, 'A');
  Object.assign(process.env, awsEnv, { ORIGIN_DIR: join(aDir, 'origin'), FILLER_DIR: join(aDir, 'filler'), CLIPS_DIR: join(aDir, 'clips'), IMAGE_STORE_DIR: join(aDir, 'images'),
    FILLER_CACHE_DIR: join(aDir, 'cache'), FILLER_STORE_DRIVER: 'local' });
  const { S3Client, CreateBucketCommand, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const raw = new S3Client({ region: awsEnv.AWS_REGION, forcePathStyle: true, endpoint });
  await raw.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(() => { /* exists, or the fake */ });
  const listed = async (prefix: string): Promise<string[]> => {
    const r: any = await raw.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
    return (r.Contents ?? []).map((c: any) => String(c.Key)).sort();
  };
  const inBucket = async (key: string): Promise<Buffer | null> => {
    try { const r: any = await raw.send(new GetObjectCommand({ Bucket: BUCKET, Key: key })); return Buffer.from(await r.Body.transformToByteArray()); } catch { return null; }
  };

  // A loop that cuts from red to blue: QC finds a jump at the join, and a jump
  // carries stills (the last frame and the first), so the stills are tested too.
  const src = join(work, 'loop.mp4');
  const ff = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=25:d=4', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=25:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=8', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
  if (ff.status !== 0) throw new Error(`ffmpeg: ${ff.stderr}`);
  const { readFileSync } = await import('node:fs');
  const srcBytes = readFileSync(src);

  const P = await import('../src/services/media/fillerPreview');
  const FS = await import('../src/services/media/fillerStore');
  const { pool, one } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const kids: ChildProcess[] = [];

  try {
    console.log('== the folder ==');
    ok(P.previewPrefix('5a0c-ab', 'lq9x2a') === 'filler/preview/5a0c-ab/lq9x2a/', 'filler/preview/<id>/<build>/');
    ok(P.previewPrefix('../x', '../../b?') === 'filler/preview/x/b/' && P.previewRoot('../x') === 'filler/preview/x/', 'id and build are reduced to plain characters (no way out of the folder)');
    const order = ['preview.m3u8', '1080p.loop.m3u8', 'master.m3u8', '1080p.m3u8', '1080p/seg_1.m4s', '1080p/init.mp4'].sort((a, b) => P.previewRank(a) - P.previewRank(b));
    ok(order.slice(0, 2).every((f) => !f.endsWith('.m3u8')) && order[2] === '1080p.m3u8' && order[order.length - 1] === 'preview.m3u8', 'upload order: media, media playlists, master and repeats, preview.m3u8 last', order);
    ok(P.previewSkip('.qc/f001.png') && P.previewSkip('qc-frames/x-last.jpg') && !P.previewSkip('1080p/seg_1.m4s'), "QC's working files and stills are not part of the build");

    const tag = Date.now().toString(36);
    const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`preview-bucket-${tag}`]))!.id;
    const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `preview-bucket-${tag}@example.com`]))!.id;
    const tok = signAccess({ sub: user, account_id: acct, role: 'owner' } as any);
    const probe = JSON.stringify({ video: { width: 640, height: 360, fps: 25, scan: 'progressive' }, audio: { codec: 'aac', channels: 1 } });
    const mkAsset = async (name: string) => {
      const id = (await one<any>(`INSERT INTO filler_assets(account_id, kind, name, status, duration_ms, width, height, probe) VALUES ($1,'loop',$2,'ready',8000,640,360,$3::jsonb) RETURNING id`, [acct, name, probe]))!.id;
      const key = FS.fillerKey(acct, id, '.mp4');
      await one(`UPDATE filler_assets SET source_key = $2, filename = $3 WHERE id = $1 RETURNING id`, [id, key, `${id}.mp4`]);
      return { id, key };
    };

    console.log('\n== the Mac (local driver) ==');
    const mac = await mkAsset('On the Mac');
    mkdirSync(join(aDir, 'filler', acct), { recursive: true });
    writeFileSync(join(aDir, 'filler', acct, `${mac.id}.mp4`), srcBytes);
    let r1 = await P.buildFillerPreview(mac.id);
    let row = await one<any>(`SELECT * FROM filler_assets WHERE id = $1`, [mac.id]);
    ok(r1.status === 'ready' && row.preview?.url === `/origin/filler-preview/${mac.id}/preview.m3u8` && !row.preview?.key, 'built and served from /origin as before, no key', { r1, preview: row.preview });
    ok(existsSync(join(P.previewDir(mac.id), 'preview.m3u8')) && (await listed('filler/')).length === 0, 'kept under ORIGIN_DIR/filler-preview, nothing in the bucket');
    const macJump = (row.qc_findings ?? []).find((f: any) => f.check === 'loop_point');
    ok(macJump?.frames?.length === 2 && macJump.frames.every((f: any) => f.url.startsWith(`/origin/filler-preview/${mac.id}/qc-frames/`)), 'QC stills beside it, served by /origin', macJump);

    console.log('\n== AWS (S3 driver): stored ==');
    process.env.FILLER_STORE_DRIVER = 's3'; FS.resetFillerStoreClient();
    const aws = await mkAsset('On AWS');
    await raw.send(new PutObjectCommand({ Bucket: BUCKET, Key: aws.key, Body: srcBytes }));
    putOrder.length = 0;
    r1 = await P.buildFillerPreview(aws.id);
    row = await one<any>(`SELECT * FROM filler_assets WHERE id = $1`, [aws.id]);
    const key: string = row.preview?.key;
    ok(r1.status === 'ready' && new RegExp(`^filler/preview/${aws.id}/[0-9a-z]+/$`).test(key ?? ''), 'the build is stored under filler/preview/<id>/<build>/', { r1, preview: row.preview });
    ok(row.preview?.url === `/${key}preview.m3u8`, 'and its URL points there (any task serves /filler/...)', row.preview?.url);
    const stored = (await listed(key)).map((k) => k.slice(key.length));
    const need = ['preview.m3u8', 'master.m3u8', '1080p.m3u8', '1080p.loop.m3u8', '720p.m3u8', '720p.loop.m3u8', 'audio.m3u8', 'audio.loop.m3u8', '1080p/init.mp4', '1080p/seg_1.m4s', '1080p/seg_2.m4s', 'audio/init.mp4'];
    ok(need.every((f) => stored.includes(f)), 'playlists, repeats, inits and segments of both renditions and the sound', stored);
    ok(!stored.some((f) => f.startsWith('.qc/')), "QC's working frames are not stored", stored);
    const local = join(P.previewDir(aws.id), '1080p', 'seg_1.m4s');
    ok(existsSync(join(aDir, 'origin')) && !existsSync(P.previewDir(aws.id)) && !existsSync(`${P.previewDir(aws.id)}.spec.json`), "the building task's disk keeps nothing of it (it was scratch)", local);
    const bytesOk = (await inBucket(`${key}1080p/seg_2.m4s`))?.length ?? 0;
    ok(bytesOk > 0, 'segments have their bytes', bytesOk);
    if (external) ok(true, 'upload order: skipped against an external endpoint (only the in-test bucket records it)');
    else {
      const mine = putOrder.filter((k) => k.startsWith(key) && !k.startsWith(`${key}qc-frames/`)).map((k) => k.slice(key.length));
      const firstList = mine.findIndex((f) => f.endsWith('.m3u8'));
      ok(mine[mine.length - 1] === 'preview.m3u8' && mine.slice(firstList).every((f) => f.endsWith('.m3u8') || f === 'filler.json') && firstList > 0,
        'media first, playlists next, preview.m3u8 last (a player that finds it finds every file)', mine);
    }
    const jumpA = (row.qc_findings ?? []).find((f: any) => f.check === 'loop_point');
    ok(row.qc_state && jumpA?.frames?.length === 2 && jumpA.frames.every((f: any) => f.url.startsWith(`/${key}qc-frames/`)), 'QC ran at build time and its stills are stored beside the build', { state: row.qc_state, jumpA });
    const stillsA: string[] = (jumpA?.frames ?? []).map((f: any) => f.url.slice(1));
    let present = true;
    for (const k of stillsA) present = present && ((await inBucket(k))?.length ?? 0) > 0;
    ok(stillsA.length === 2 && present, 'the stills are in the bucket', stillsA);

    console.log('\n== played and checked on another task ==');
    const bDir = join(work, 'B');
    const env = { ...process.env, ...awsEnv, FILLER_STORE_DRIVER: 's3', ORIGIN_DIR: join(bDir, 'origin'), FILLER_DIR: join(bDir, 'filler'), CLIPS_DIR: join(bDir, 'clips'), IMAGE_STORE_DIR: join(bDir, 'images'),
      FILLER_CACHE_DIR: join(bDir, 'cache'), PORT: '0' };
    const B: { base: string } = await new Promise((resolve, reject) => {
      const p = spawn(join(__dirname, '../node_modules/.bin/tsx'), [__filename, 'serve'], { env, cwd: join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
      kids.push(p);
      let out = '';
      const t = setTimeout(() => reject(new Error(`task B did not start: ${out.slice(-1500)}`)), 60_000);
      p.stdout!.on('data', (b) => { out += b; const m = /PORT (\d+)/.exec(out); if (m) { clearTimeout(t); resolve({ base: `http://127.0.0.1:${m[1]}` }); } });
      p.stderr!.on('data', (b) => { out += b; });
      p.on('exit', (c) => { clearTimeout(t); reject(new Error(`task B exited ${c}: ${out.slice(-1500)}`)); });
    });
    ok(!existsSync(join(bDir, 'origin', 'filler-preview', aws.id)), 'task B has nothing of the preview on its disk');
    let r = await fetch(`${B.base}/${key}preview.m3u8`);
    let text = await r.text();
    ok(r.status === 200 && /mpegurl/.test(r.headers.get('content-type') ?? '') && /1080p\.loop\.m3u8/.test(text), 'task B serves preview.m3u8 from the bucket, pointed at the repeats', { status: r.status, text });
    r = await fetch(`${B.base}/${key}1080p.loop.m3u8`);
    text = await r.text();
    ok(r.status === 200 && (text.match(/#EXT-X-DISCONTINUITY/g) ?? []).length === 2 && /1080p\/seg_1\.m4s/.test(text), 'and the repeated playlist: three rounds, two discontinuities', text);
    r = await fetch(`${B.base}/${key}1080p/seg_2.m4s`);
    const seg = Buffer.from(await r.arrayBuffer());
    ok(r.status === 200 && seg.equals((await inBucket(`${key}1080p/seg_2.m4s`))!) && r.headers.get('content-type') === 'video/iso.segment', 'and its segments, byte for byte', r.status);
    r = await fetch(`${B.base}/${stillsA[0]}`);
    ok(r.status === 200 && r.headers.get('content-type') === 'image/jpeg' && (await r.arrayBuffer()).byteLength > 0, 'and the QC stills', r.status);
    r = await fetch(`${B.base}/api/filler-assets/${aws.id}/house`, { headers: { authorization: `Bearer ${tok}` } });
    let house: any = await r.json().catch(() => null);
    ok(r.status === 200 && house?.preview?.url === `/${key}preview.m3u8`, 'the console reads the stored URL from any task', house?.preview);

    r = await fetch(`${B.base}/api/filler-assets/${aws.id}/qc`, { method: 'POST', headers: { authorization: `Bearer ${tok}` } });
    house = await r.json().catch(() => null);
    const keysA = (row.qc_findings ?? []).map((f: any) => f.key).sort();
    const keysB = (house?.qc?.findings ?? []).map((f: any) => f.key).sort();
    ok(r.status === 200 && JSON.stringify(keysA) === JSON.stringify(keysB) && house?.qc?.state === row.qc_state, 'QC run again on task B, from the bucket: the same findings as at build time', { status: r.status, keysA, keysB, house: house?.qc ?? house });
    ok(!(house?.qc?.findings ?? []).some((f: any) => f.check === 'media' || f.check === 'playback'), 'it read and decoded the build (no media or playback error)', house?.qc?.findings);
    const jumpB = (house?.qc?.findings ?? []).find((f: any) => f.check === 'loop_point');
    const stillsB: string[] = (jumpB?.frames ?? []).map((f: any) => f.url.slice(1));
    present = stillsB.length === 2 && stillsB.every((k) => k.startsWith(`${key}qc-frames/`) && !stillsA.includes(k));
    for (const k of stillsB) present = present && ((await inBucket(k))?.length ?? 0) > 0;
    ok(present, 'its stills are new ones, stored beside the build', stillsB);
    let gone = true;
    for (const k of stillsA) gone = gone && (await inBucket(k)) === null;
    ok(gone, "the last run's stills are removed", stillsA);
    const scratch = join(bDir, 'cache', 'preview-qc');
    ok(!existsSync(scratch) || readdirSync(scratch).length === 0, 'task B leaves no scratch copy behind', existsSync(scratch) ? readdirSync(scratch) : null);
    ok(!existsSync(join(bDir, 'origin', 'filler-preview')), 'and writes nothing under its ORIGIN_DIR');

    console.log('\n== a rebuild ==');
    r1 = await P.buildFillerPreview(aws.id);
    row = await one<any>(`SELECT * FROM filler_assets WHERE id = $1`, [aws.id]);
    const key2: string = row.preview?.key;
    ok(r1.status === 'ready' && key2 && key2 !== key && key2.startsWith(P.previewRoot(aws.id)), 'a rebuild is stored in a new folder', { key, key2 });
    ok((await listed(key)).length === 0 && (await listed(key2)).some((k) => k.endsWith('/preview.m3u8')), 'and the old folder is removed whole (its stills with it)');

    console.log('\n== missing from storage ==');
    for (const k of await listed(`${key2}1080p`)) await raw.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: k }));
    r = await fetch(`${B.base}/api/filler-assets/${aws.id}/qc`, { method: 'POST', headers: { authorization: `Bearer ${tok}` } });
    house = await r.json().catch(() => null);
    const media = (house?.qc?.findings ?? []).find((f: any) => f.check === 'media');
    ok(r.status === 200 && house?.qc?.state === 'failed' && /missing from storage/.test(media?.message ?? ''), 'QC says the preview is missing from storage (an error, not a crash)', { status: r.status, qc: house?.qc ?? house });

    console.log('\n== deleting the slate or loop ==');
    await raw.send(new PutObjectCommand({ Bucket: BUCKET, Key: `filler/preview/${mac.id}x/other/preview.m3u8`, Body: '#EXTM3U\n' }));
    r = await fetch(`${B.base}/api/filler-assets/${aws.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${tok}` } });
    ok(r.status === 204 && (await listed(P.previewRoot(aws.id))).length === 0, 'its stored previews are removed, from any task', r.status);
    ok((await listed(`filler/preview/${mac.id}x/`)).length === 1, "another asset's previews are not touched");
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
