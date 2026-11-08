// ============================================================================
//  HYBRID SITES 4d: A SITE'S PACKAGE STRAIGHT TO THE ORIGIN BUCKET (build
//  queue H4-4 (c) and (e)).
//
//  The agent's real encode worker (volt-agent/src/siteEncode.ts) against the
//  real API on a real database, the real vod_encoder.py and ffmpeg (a stub for
//  Shaka when it is not here, as site-encode-worker.check.ts), and a REAL S3
//  API: moto, started by this suite when `moto_server` is on PATH, or the
//  endpoint in SITE_S3_TEST_ENDPOINT.
//    - with packages in the bucket (VOD_STORE s3) a site encode is no longer
//      refused: every file is PUT straight to the bucket under
//      site-staging/<asset>/<job>-a<attempt>/ with a presigned URL that signs
//      its SHA-256 (sent as the x-amz-checksum-sha256 header); not one byte
//      goes through the API;
//    - the cloud reads the package back, hashes it, verifies it and records
//      it as after a cloud encode: master_key vod/<id>/master.m3u8, every
//      declared file under vod/<id>/ at its size; the staging prefix and the
//      local read-back folder are gone;
//    - bytes changed on the way (S3 itself refuses them; moto does not check
//      the header, so here the cloud's own hash catches them) and a file never
//      uploaded: refused, the staging prefix emptied, the retry succeeds;
//    - (e) large files streamed from disk with their length stated, to the
//      bucket and to this API's own transfer URL (the Mac), both verified;
//    - the staging remover never touches anything outside site-staging/;
//    - the lifecycle rule in deploy/terraform that sweeps site-staging/.
//
//  Usage: DATABASE_URL=... npx tsx test/site-encode-bucket.check.ts
// ============================================================================
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---- the bucket: a real S3 API ------------------------------------------------
  let moto: ChildProcess | null = null;
  let endpoint = process.env.SITE_S3_TEST_ENDPOINT || '';
  if (!endpoint) {
    if (spawnSync('moto_server', ['--help'], { stdio: 'ignore' }).status !== 0) {
      console.log('PASS skipped: no S3 API here (install moto: pip install "moto[server]", or set SITE_S3_TEST_ENDPOINT)');
      console.log(`\nsite-encode-bucket: ${pass}/${pass + fail} passed`);
      process.exit(0);
    }
    const port = 5600 + Math.floor(Math.random() * 300);
    moto = spawn('moto_server', ['-p', String(port)], { stdio: 'ignore' });
    endpoint = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) { try { await fetch(endpoint); break; } catch { await sleep(200); } }
  }
  const BUCKET = `volt-site-encode-${Date.now().toString(36)}`;
  const root = mkdtempSync(join(tmpdir(), 'site-bucket-'));
  Object.assign(process.env, {
    CLIPS_DIR: join(root, 'clips'), VOD_STORE: 's3', S3_BUCKET: BUCKET, AWS_ENDPOINT_URL: endpoint, S3_FORCE_PATH_STYLE: '1',
    AWS_ACCESS_KEY_ID: process.env.SITE_S3_TEST_KEY_ID || 'test', AWS_SECRET_ACCESS_KEY: process.env.SITE_S3_TEST_SECRET || 'test',
    AWS_REGION: process.env.AWS_REGION || 'us-east-1',
  });
  mkdirSync(process.env.CLIPS_DIR!, { recursive: true });

  const realPackager = spawnSync(process.env.PACKAGER_BIN || 'packager', ['--version'], { stdio: 'ignore' }).status === 0;
  if (!realPackager) {
    const stub = join(root, 'packager-stub.py');
    writeFileSync(stub, `#!/usr/bin/env python3
import math, os, subprocess, sys
args = sys.argv[1:]
def opt(name):
    return args[args.index(name) + 1] if name in args else None
seg = float(opt('--segment_duration') or 6)
streams = [dict(kv.split('=', 1) for kv in a.split(',')) for a in args if a.startswith('in=')]
master = opt('--hls_master_playlist_output')
root = os.path.dirname(master or opt('--mpd_output'))
lines = ['#EXTM3U']
for i, s in enumerate(streams):
    d = os.path.dirname(s['init_segment']); os.makedirs(d, exist_ok=True)
    dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', s['in']], capture_output=True, text=True).stdout.strip() or 0)
    n = max(1, math.ceil(dur / seg - 1e-6))
    open(s['init_segment'], 'wb').write(b'init' + s['stream'].encode())
    rel = os.path.relpath(d, root)
    pl = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-TARGETDURATION:%d' % math.ceil(seg), '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-MAP:URI="%s/init.mp4"' % rel]
    for k in range(1, n + 1):
        open(s['segment_template'].replace('$Number$', str(k)), 'wb').write(b'seg%d' % k + os.urandom(2048))
        pl += ['#EXTINF:%.3f,' % min(seg, dur - (k - 1) * seg), '%s/seg_%d.m4s' % (rel, k)]
    pl.append('#EXT-X-ENDLIST')
    open(os.path.join(root, 'stream_%d.m3u8' % i), 'w').write('\\n'.join(pl) + '\\n')
    if s['stream'] == 'audio':
        lines.append('#EXT-X-MEDIA:TYPE=AUDIO,URI="stream_%d.m3u8",GROUP-ID="audio",NAME="Audio"' % i)
    else:
        lines.append('#EXT-X-STREAM-INF:BANDWIDTH=1000000,AUDIO="audio"')
        lines.append('stream_%d.m3u8' % i)
if master:
    open(master, 'w').write('\\n'.join(lines) + '\\n')
if opt('--mpd_output'):
    open(opt('--mpd_output'), 'w').write('<?xml version="1.0"?>\\n<MPD type="static" mediaPresentationDuration="PT6S"><Period/></MPD>\\n')
`);
    chmodSync(stub, 0o755);
    process.env.PACKAGER_BIN = stub;
  }
  console.log(realPackager ? '(the real packager)' : '(no packager here: a stub writes the package)');

  const { S3Client, CreateBucketCommand, ListObjectsV2Command, PutObjectCommand, HeadObjectCommand } = await import('@aws-sdk/client-s3');
  const s3 = new S3Client({ region: process.env.AWS_REGION, endpoint, forcePathStyle: true });
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
  const keysUnder = async (prefix: string) => {
    const out = new Map<string, number>(); let token: string | undefined;
    do {
      const r: any = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) out.set(o.Key, Number(o.Size));
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  };

  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { config } = await import('../src/config');
  const E = await import('../src/services/sites/siteEncode');
  const V = await import('../src/services/jobs/handlers/vodEncode');
  const W = await import('../../volt-agent/src/siteEncode');
  ok(config.aws.s3Bucket === BUCKET, `packages go to the bucket ${BUCKET} at ${endpoint}`);

  const work = join(root, 'site', 'drop'); mkdirSync(work, { recursive: true });
  const src = join(work, 'Evening News.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=640x360:r=25:d=6', '-f', 'lavfi', '-i', 'sine=f=440:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src], { stdio: 'ignore' });

  // ---- the database -----------------------------------------------------------
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name, licences) VALUES ($1, '{hybrid_sites}') RETURNING id`, [`sb-${tag}`]))!.id;
  const owner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `sb-${tag}@example.com`]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type, codec_backend, packaging)
      VALUES ($1,'HD','[{"height":720,"bitrate_kbps":3000},{"height":360,"bitrate_kbps":800},{"height":240,"bitrate_kbps":400}]','transcode','x264','both') RETURNING id`, [acct]))!.id;
  const { ensureTrackingGroup } = await import('../src/services/encode/store');
  await ensureTrackingGroup(acct, prof, 'Same as live', { makeDefault: true });
  const newAsset = async (title: string) => (await one<any>(
    `INSERT INTO vod_assets(account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, metadata)
     VALUES ($1,'watchfolder','export',$2,0,0,0,'{}'::jsonb) RETURNING id`, [acct, title]))!.id;
  const tok = signAccess({ sub: owner, account_id: acct, role: 'owner' } as any);
  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: unknown, t: string | null = tok) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let b: any = null; try { b = text ? JSON.parse(text) : null; } catch { b = text; }
    return { status: r.status, body: b };
  };
  const facts = { hostname: 'enc-01', cpuCores: 8, memoryBytes: 16 * 2 ** 30, gpus: [], diskFreeBytes: 1e12, diskTotalBytes: 2e12, os: 'Linux', arch: 'x64', agentVersion: '0.8.0', encoderVersion: null };
  const site = (await api('POST', '/api/sites', { name: 'Main broadcast centre' })).body.id;
  const tk = await api('POST', `/api/sites/${site}/enrolment-tokens`, {});
  const en = await api('POST', '/api/site-agent/enrol', { token: tk.body.token, host: facts }, null);
  await api('POST', `/api/sites/${site}/hosts/${en.body.hostId}/approve`, {});
  const cred = en.body.credential as string;
  ok(!!cred, 'a site with an approved host');
  const asset = async (id: string) => one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [id]);
  const jobOf = async (type: string, id: string) => one<any>(`SELECT * FROM jobs WHERE type = $1 AND payload->>'vodAssetId' = $2 ORDER BY created_at DESC LIMIT 1`, [type, id]);
  const req = (vodAssetId: string) => E.requestSiteEncode({ vodAssetId, accountId: acct, siteId: site, sitePath: src, sourceBytes: statSync(src).size });

  const realRunner = W.encoderRunner({ ...process.env, VOLT_ENCODER_IMAGE: '', VOLT_ENCODER_BIN: config.testStream.encoderBin, VOLT_PYTHON: config.testStream.pythonBin });
  const scratchDir = join(root, 'scratch');
  const logs: string[] = [];
  // Every upload the worker makes, as it left the agent.
  interface Put { url: string; headers: Record<string, string>; streamed: boolean; status: number }
  const puts: Put[] = [];
  type Mangle = (url: string, body: any) => { skip?: boolean; body?: any } | null;
  let mangle: Mangle | null = null;
  const watched: typeof fetch = (async (url: any, init?: any) => {
    if (init?.method === 'PUT') {
      const headers: Record<string, string> = { ...(init.headers ?? {}) };
      const streamed = !!init.body && typeof init.body.pipe === 'function';
      const m = mangle?.(String(url), init.body) ?? null;
      if (m?.skip) { puts.push({ url: String(url), headers, streamed, status: 200 }); return new Response('', { status: 200 }); }
      const r = await fetch(url, m?.body !== undefined ? { ...init, body: m.body } : init);
      puts.push({ url: String(url), headers, streamed, status: r.status });
      return r;
    }
    return fetch(url, init);
  }) as any;
  const ctx = (over: Partial<Parameters<typeof W.encodePass>[0]> = {}) => ({
    server: base, credential: () => cred, scratchDir, runner: realRunner, progressEveryMs: 200, declareBatch: 4, hasGpu: false, fetch: watched,
    log: (s: string) => { logs.push(s); }, ...over,
  });
  const scratchEmpty = () => !existsSync(scratchDir) || readdirSync(scratchDir).length === 0;
  const noLocalCopies = () => !existsSync(join(process.env.CLIPS_DIR!, 'vod')) || !readdirSync(join(process.env.CLIPS_DIR!, 'vod')).some((n) => n.includes('.site-'));

  console.log('== a site encode with packages in the bucket ==');
  const A = await newAsset('Evening News');
  let threw: any = null;
  try { await req(A); } catch (e) { threw = e; }
  ok(!threw, 'with the origin bucket a site encode is accepted (was 409 site_encode_needs_local_store)', threw?.message);
  logs.length = 0; puts.length = 0;
  const ran = await W.encodePass(ctx());
  let a = await asset(A);
  ok(ran === 2 && a.media_state === 'ready', 'one pass probes and encodes, and the asset is ready', { ran, state: a.media_state, err: a.media_error, logs });
  ok(a.master_key === `vod/${A}/master.m3u8`, 'played from the bucket, as after a cloud encode', a.master_key);
  const encA = await jobOf(E.SITE_VOD_ENCODE, A);
  const declared: { path: string; bytes: number; sha256: string }[] = encA.payload.declared ?? [];
  const staging = `site-staging/${A}/${encA.id}-a1/`;
  ok(declared.length > 4 && encA.attempts === 1 && encA.payload.staging === `s3://${BUCKET}/${staging.slice(0, -1)}`, `the package (${declared.length} files) waited under ${staging}`, encA.payload.staging);
  ok(encA.payload.transfers.every((t: any) => t.uri === `s3://${BUCKET}/${staging}${t.name.slice(4)}`), 'every upload transfer names one object under that prefix');
  ok(puts.length === declared.length && puts.every((p) => new URL(p.url).origin === new URL(endpoint).origin && p.status === 200), 'every file was PUT straight to the bucket', puts.map((p) => [p.url.slice(0, 60), p.status]).slice(0, 3));
  ok(!puts.some((p) => p.url.startsWith(base)), 'not one byte went through the API');
  const shaB64 = new Map(declared.map((d) => [d.path, Buffer.from(d.sha256, 'hex').toString('base64')]));
  ok(puts.every((p) => {
    const u = new URL(p.url); const path = decodeURIComponent(u.pathname).split(staging)[1];
    return u.searchParams.get('X-Amz-SignedHeaders')?.split(';').includes('x-amz-checksum-sha256') && p.headers['x-amz-checksum-sha256'] === shaB64.get(path);
  }), "each URL signs the file's SHA-256 and the agent sends it as given (S3 refuses other bytes)");
  ok(puts.every((p) => !p.headers.authorization), 'no credential on any upload: the URL is the permission');
  const vod = await keysUnder(`vod/${A}/`);
  ok(declared.every((d) => vod.get(`vod/${A}/${d.path}`) === d.bytes), 'every declared file is under vod/<id>/ in the bucket at its size', [...vod.keys()].slice(0, 5));
  ok((await keysUnder(staging)).size === 0, 'the staging prefix is removed once the package is recorded');
  ok(noLocalCopies() && scratchEmpty(), 'no read-back folder is left beside the asset and the scratch folder is removed');
  ok(a.encode_result?.encodedAt?.site === site && a.formats?.hls && a.formats?.dash, 'recorded as encoded at the site, HLS and DASH', a.encode_result?.encodedAt);
  const head: any = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: `vod/${A}/master.m3u8` }));
  ok(/mpegurl/.test(String(head.ContentType)), 'the master in the bucket carries its playlist type (written by the same upload as a cloud encode)', head.ContentType);

  console.log('== bytes changed on the way, and a file never uploaded ==');
  const B = await newAsset('Changed on the way');
  await req(B);
  let changed = 0;
  mangle = (url, body) => (!changed && /seg_2\.m4s/.test(url) ? (changed++, { body: Buffer.concat([Buffer.from(body), Buffer.from('x')]).subarray(1) }) : null);
  logs.length = 0;
  await W.encodePass(ctx());
  mangle = null;
  let encB = await jobOf(E.SITE_VOD_ENCODE, B);
  ok(changed === 1 && encB.state === 'queued' && /does not match its declared SHA-256/.test(encB.last_error ?? ''), 'a file with other bytes is caught when the cloud reads it back; the job waits for another attempt', [encB.state, encB.last_error]);
  ok((await keysUnder(`site-staging/${B}/`)).size === 0 && noLocalCopies(), 'the refused upload is removed from the bucket and from this disk');
  ok((await asset(B)).media_state === 'processing', 'the asset still reads Processing');
  await query(`UPDATE jobs SET run_after = now() WHERE id = $1`, [encB.id]);
  let skipped = 0;
  mangle = (url) => (!skipped && /stream_0\.m3u8|seg_1\.m4s/.test(url) ? (skipped++, { skip: true }) : null);
  await W.encodePass(ctx());
  mangle = null;
  encB = await jobOf(E.SITE_VOD_ENCODE, B);
  ok(skipped === 1 && encB.state === 'queued' && /declared but not uploaded/.test(encB.last_error ?? ''), 'a declared file that never reached the bucket is refused too', [encB.state, encB.last_error]);
  ok((await keysUnder(`site-staging/${B}/`)).size === 0, 'and its staging prefix is emptied');
  await query(`UPDATE jobs SET run_after = now() WHERE id = $1`, [encB.id]);
  await W.encodePass(ctx());
  encB = await jobOf(E.SITE_VOD_ENCODE, B);
  ok(encB.state === 'succeeded' && encB.attempts === 3 && (await asset(B)).media_state === 'ready', 'the third attempt verifies and the asset is ready', [encB.state, encB.attempts]);

  console.log('== large files streamed from disk (e) ==');
  const C = await newAsset('Streamed to the bucket');
  await req(C);
  puts.length = 0;
  await W.encodePass(ctx({ streamAboveBytes: 1024 }));
  const encC = await jobOf(E.SITE_VOD_ENCODE, C);
  const bigC = (encC.payload.declared as any[]).filter((d) => d.bytes > 1024).length;
  const streamedC = puts.filter((p) => p.streamed);
  ok(bigC > 0 && streamedC.length === bigC && streamedC.every((p) => p.headers['content-length'] && p.status === 200), `files over the threshold (${bigC}) went as streams with their length stated, the rest read whole`, [bigC, streamedC.length]);
  ok(encC.state === 'succeeded' && (await asset(C)).media_state === 'ready', 'and the streamed package verifies in the bucket', [encC.state, encC.last_error]);
  ok(W.STREAM_ABOVE_BYTES === 256 * 2 ** 20, 'the default threshold is 256 MB (VOLT_SITE_STREAM_ABOVE_MB)', W.STREAM_ABOVE_BYTES);

  process.env.VOD_STORE = 'local';
  const D = await newAsset('Streamed to the Mac');
  await req(D);
  puts.length = 0;
  await W.encodePass(ctx({ streamAboveBytes: 1024 }));
  const encD = await jobOf(E.SITE_VOD_ENCODE, D);
  const d = await asset(D);
  ok(puts.length > 0 && puts.every((p) => p.url.startsWith(base + '/api/site-agent/transfers/')) && puts.some((p) => p.streamed), 'on the Mac the same streams go to this API\'s own transfer URLs', puts.slice(0, 2).map((p) => p.url.slice(0, 50)));
  ok(encD.state === 'succeeded' && d.media_state === 'ready' && d.master_key === `/clips/vod/${D}/master.m3u8`, 'checked against their SHA-256 as they arrive, and the asset is ready on this disk', [encD.state, d.master_key, encD.last_error]);
  ok(!puts.some((p) => p.headers['x-amz-checksum-sha256']), 'no bucket header is asked for on the Mac');
  process.env.VOD_STORE = 's3';

  console.log('== an agent from before 0.9.0 ==');
  const F = await newAsset('Older agent');
  await req(F);
  await W.encodePass(ctx({ maxJobs: 1 }));
  const L = (await api('POST', '/api/site-agent/jobs/lease', { types: W.ENCODE_JOB_TYPES }, cred)).body;
  const sha = 'ab'.repeat(32);
  const dec = await api('POST', `/api/site-agent/jobs/${L.id}/outputs`, { leaseId: L.leaseId, files: [{ path: 'master.m3u8', bytes: 8, sha256: sha }] }, cred);
  const older = await api('POST', `/api/site-agent/jobs/${L.id}/transfer-url`, { leaseId: L.leaseId, name: 'out/master.m3u8' }, cred);
  const newer = await api('POST', `/api/site-agent/jobs/${L.id}/transfer-url`, { leaseId: L.leaseId, name: 'out/master.m3u8', signedHeaders: true }, cred);
  ok(dec.status === 200 && older.status === 200 && older.body.via === 's3' && !older.body.headers && new URL(older.body.url).searchParams.get('X-Amz-SignedHeaders') === 'host',
    'an agent that does not say it sends signed headers gets a URL that signs only the host, so S3 does not refuse it; the read-back hash still holds it', older.body);
  ok(newer.body.headers?.['x-amz-checksum-sha256'] === Buffer.from(sha, 'hex').toString('base64') && new URL(newer.body.url).searchParams.get('X-Amz-SignedHeaders') === 'host;x-amz-checksum-sha256',
    'one that does gets the checksum header to send, signed into the URL', newer.body.headers);

  console.log('== the staging remover stays inside site-staging/ ==');
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'vod/keep-me/master.m3u8', Body: '#EXTM3U\n' }));
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'site-staging/x/j-a1/a.m4s', Body: 'a' }));
  await E.removeStaging(`s3://${BUCKET}/vod/keep-me`);
  await E.removeStaging(`s3://${BUCKET}/site-staging`);
  await E.removeStaging(`s3://${BUCKET}/site-staging/x`);
  ok((await keysUnder('vod/keep-me/')).size === 1 && (await keysUnder('site-staging/x/')).size === 1, 'a payload naming any other prefix, or a whole asset\'s staging, removes nothing');
  await E.removeStaging(`s3://${BUCKET}/site-staging/x/j-a1`);
  ok((await keysUnder('site-staging/x/')).size === 0, "one attempt's prefix is removed");
  ok(await E.readBackFromBucket(`s3://${BUCKET}/site-staging/none/j-a1`, [{ path: 'master.m3u8', bytes: 8, sha256: createHash('sha256').update('#EXTM3U\n').digest('hex') }], join(root, 'rb'))
    .then((p) => p.length === 1 && /declared but not uploaded/.test(p[0])), 'reading back an empty prefix lists what is missing');

  console.log('== the bucket sweeps what a dead task left ==');
  const tf = readFileSync(join(__dirname, '../../deploy/terraform/s3_cloudfront.tf'), 'utf8');
  ok(/id\s*=\s*"site-staging"[\s\S]{0,200}prefix\s*=\s*"site-staging\/"[\s\S]{0,80}days\s*=\s*3/.test(tf), 'the origin bucket expires site-staging/ after 3 days (deploy/terraform/s3_cloudfront.tf)');

  console.log(`\nsite-encode-bucket: ${pass}/${pass + fail} passed`);
  srv.close();
  await pool.end();
  moto?.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
