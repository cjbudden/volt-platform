// ============================================================================
//  REPACKAGE ON THE BUCKET STORE (build queue P4-4 (a); services/repackage.ts,
//  fast/vodStore.ts repackSubdir, the finish in jobs/handlers/vodEncode.ts).
//
//  On VOD_STORE=s3 the CDN keeps a title's segments as immutable under their
//  names, so a repackage must not upload under the title's existing keys.
//  Against a REAL S3 API (moto, started here when `moto_server` is on PATH,
//  or the endpoint in SITE_S3_TEST_ENDPOINT), with a real database:
//    - pure: the prefix name, what counts as a repackage folder (never
//      `reframe/` or `ladders/`), which old keys go, the grace before they go;
//    - a confirmed DRM change on a title in the bucket is queued, not held;
//    - the job uploads under vod/<id>/r-<job>-a<n>/ and points master_key
//      there; the old package is untouched until its grace is over; the
//      cleanup is queued for then;
//    - the readers follow master_key: bucketBaseOf (caption tracks written
//      beside the new master), packageRootOf (archive copies), the /clips
//      read-through (trick play, frame index) from another task's view;
//    - the cleanup takes the old package and keeps FAST ladder variants,
//      reframes and the current package; a second repackage's cleanup takes
//      the first repackage folder whole;
//    - a repackage that fails leaves no prefix behind and the title as it was;
//    - deleting the title moves the repackage folder into the restore bin.
//
//  Usage: DATABASE_URL=... npx tsx test/publishing-repackage-bucket.check.ts
// ============================================================================
import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises';
import { createServer as httpServer } from 'node:http';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  g === w ? ok(m) : bad(m, `expected ${w} got ${g}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---- the bucket: a real S3 API ------------------------------------------------
  let moto: ChildProcess | null = null;
  let endpoint = process.env.SITE_S3_TEST_ENDPOINT || '';
  if (!endpoint) {
    if (spawnSync('moto_server', ['--help'], { stdio: 'ignore' }).status !== 0) {
      console.log('PASS skipped: no S3 API here (install moto: pip install "moto[server]", or set SITE_S3_TEST_ENDPOINT)');
      console.log('\n1 passed, 0 failed');
      process.exit(0);
    }
    const port = 5600 + Math.floor(Math.random() * 300);
    moto = spawn('moto_server', ['-p', String(port)], { stdio: 'ignore' });
    endpoint = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) { try { await fetch(endpoint); break; } catch { await sleep(200); } }
  }
  const BUCKET = `volt-repack-${Date.now().toString(36)}`;
  const root = await mkdtemp(join(tmpdir(), 'vod-repack-bucket-'));
  Object.assign(process.env, {
    IMAGE_STORE_DIR: join(root, '_images'), FILLER_DIR: join(root, '_filler'), CLIPS_DIR: join(root, '_clips'), ORIGIN_DIR: join(root, '_origin'),
    VOD_STORE: 's3', S3_BUCKET: BUCKET, AWS_ENDPOINT_URL: endpoint, S3_FORCE_PATH_STYLE: '1',
    AWS_ACCESS_KEY_ID: process.env.SITE_S3_TEST_KEY_ID || 'test', AWS_SECRET_ACCESS_KEY: process.env.SITE_S3_TEST_SECRET || 'test',
    AWS_REGION: process.env.AWS_REGION || 'us-east-1',
  });
  await mkdir(process.env.CLIPS_DIR!, { recursive: true });

  // THE PACKAGER: real when there is one, otherwise a stub that writes what
  // Shaka writes (init and a segment per stream, the manifests).
  const realPackager = spawnSync(process.env.PACKAGER_BIN || 'packager', ['--version'], { stdio: 'ignore' }).status === 0;
  if (!realPackager) {
    const stub = join(root, 'packager-stub.py');
    await writeFile(stub, `#!/usr/bin/env python3
import os, subprocess, sys
args = sys.argv[1:]
streams = [dict(kv.split('=', 1) for kv in a.split(',')) for a in args if a.startswith('in=')]
for s in streams:
    d = os.path.dirname(s['init_segment']); os.makedirs(d, exist_ok=True)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', s['in'], '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov', s['init_segment']], check=True)
    open(s['segment_template'].replace('$Number$', '1'), 'wb').write(b'seg' + (b'-enc' if '--enable_raw_key_encryption' in args else b'-clear'))
def opt(name):
    return args[args.index(name) + 1] if name in args else None
if opt('--hls_master_playlist_output'):
    open(opt('--hls_master_playlist_output'), 'w').write('#EXTM3U\\n#EXT-X-STREAM-INF:BANDWIDTH=140000,CODECS="mp4a.40.2"\\naudio/stream.m3u8\\n' + ('#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES\\n' if '--enable_raw_key_encryption' in args else ''))
if opt('--mpd_output'):
    open(opt('--mpd_output'), 'w').write('<MPD type="static"><Period><AdaptationSet contentType="audio"/></Period></MPD>')
`);
    await chmod(stub, 0o755);
    process.env.PACKAGER_BIN = stub;
  }
  console.log(realPackager ? '(the real packager)' : '(no packager here: a stub stands in for it)');

  const { S3Client, CreateBucketCommand, ListObjectsV2Command, PutObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const s3 = new S3Client({ region: process.env.AWS_REGION, endpoint, forcePathStyle: true });
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
  const keysUnder = async (prefix: string) => {
    const out: string[] = []; let token: string | undefined;
    do {
      const r: any = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) out.push(o.Key);
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out.sort();
  };
  const text = async (key: string) => { try { const r: any = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key })); return await r.Body.transformToString(); } catch { return null; } };
  const put = (key: string, body: string) => s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body }));

  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { config } = await import('../src/config');
  const R = await import('../src/services/repackage');
  const VS = await import('../src/services/fast/vodStore');
  const BT = await import('../src/services/companions/bucketTracks');
  const PK = await import('../src/services/archive/packages');
  const SV = await import('../src/services/companions/serve');
  check('packages go to the bucket under test', [config.aws.s3Bucket, VS.vodStore()], [BUCKET, 's3']);

  console.log('== pure ==');
  const ID = '0b9c1f0e-1111-4222-8333-944455556666';
  const sub1 = VS.repackSubdir('6f1c2d3e-aaaa-4bbb-8ccc-0d0e0f101112', 2);
  check('repackSubdir: r-<first 12 of the job id>-a<attempt>', sub1, 'r-6f1c2d3eaaaa-a2');
  check('REPACK_DIR: a repackage folder, never reframe/ or ladders/ or a rendition', ['r-6f1c2d3eaaaa-a2', 'reframe', 'ladders', 'r-x-a1', '720p', 'r-6f1c2d3eaaaa'].map((n) => VS.REPACK_DIR.test(n)), [true, false, false, false, false, false]);
  check('bucketBaseOf: the root master, a repackage master, nothing else',
    [BT.bucketBaseOf(ID, `vod/${ID}/master.m3u8`), BT.bucketBaseOf(ID, `vod/${ID}/${sub1}/master.m3u8`), BT.bucketBaseOf(ID, `vod/${ID}/ladders/master.m3u8`), BT.bucketBaseOf(ID, `vod/${ID}/reframe/master.m3u8`), BT.bucketBaseOf('11111111-2222-4333-8444-555555555555', `vod/${ID}/${sub1}/master.m3u8`)],
    [`vod/${ID}`, `vod/${ID}/${sub1}`, null, null, null]);
  check('packageRootOf: a repackage folder is the asset\'s own package; a ladder folder is not',
    [PK.packageRootOf({ id: ID, master_key: `vod/${ID}/${sub1}/master.m3u8` }), PK.packageRootOf({ id: ID, master_key: `vod/${ID}/ladders/master.m3u8` })], [`/vod/${ID}/${sub1}`, null]);
  const isR = (n: string) => VS.REPACK_DIR.test(n);
  const all = [`vod/${ID}/master.m3u8`, `vod/${ID}/manifest.mpd`, `vod/${ID}/720p/seg_1.m4s`, `vod/${ID}/file.mp4`, `vod/${ID}/subs/x.vtt`,
    `vod/${ID}/ladders/g/master.m3u8`, `vod/${ID}/reframe/a.mp4`, `vod/${ID}/${sub1}/master.m3u8`, `vod/${ID}/r-abcdabcd-a1/master.m3u8`];
  check('stalePackageKeys, old at the root: the packaging and its captions go; ladders, reframes and every repackage folder stay',
    R.stalePackageKeys(all, { assetId: ID, oldBase: `vod/${ID}`, currentBase: `vod/${ID}/${sub1}` }, isR),
    [`vod/${ID}/master.m3u8`, `vod/${ID}/manifest.mpd`, `vod/${ID}/720p/seg_1.m4s`, `vod/${ID}/file.mp4`, `vod/${ID}/subs/x.vtt`]);
  check('...old a repackage folder: that folder goes whole, nothing else',
    R.stalePackageKeys(all, { assetId: ID, oldBase: `vod/${ID}/r-abcdabcd-a1`, currentBase: `vod/${ID}/${sub1}` }, isR), [`vod/${ID}/r-abcdabcd-a1/master.m3u8`]);
  check('...nothing when old is current, or old is not the asset\'s own package folder',
    [R.stalePackageKeys(all, { assetId: ID, oldBase: `vod/${ID}/${sub1}`, currentBase: `vod/${ID}/${sub1}` }, isR).length,
     R.stalePackageKeys(all, { assetId: ID, oldBase: `vod/${ID}/reframe`, currentBase: `vod/${ID}/${sub1}` }, isR).length,
     R.stalePackageKeys(all, { assetId: ID, oldBase: `vod/11111111-2222-4333-8444-555555555555`, currentBase: null }, isR).length,
     R.stalePackageKeys(all, { assetId: ID, oldBase: `vod`, currentBase: null }, isR).length], [0, 0, 0, 0]);
  check('oldPackageGraceMs: cache time, 10 min margin and the title\'s length (3 h when unknown)',
    [R.oldPackageGraceMs(2000), R.oldPackageGraceMs(5_400_000), R.oldPackageGraceMs(null)], [662_000, 6_060_000, 11_460_000]);

  // ---- the account, its key service, a title ------------------------------------
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`repack-b-${tag}`]))!.id;
  const owner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `repack-b-${tag}@volt.test`]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type, codec_backend, packaging)
      VALUES ($1,'HD','[{"height":720,"bitrate_kbps":3000},{"height":360,"bitrate_kbps":800}]','transcode','x264','both') RETURNING id`, [acct]))!.id;
  const { ensureTrackingGroup } = await import('../src/services/encode/store');
  await ensureTrackingGroup(acct, prof, 'Same as live', { makeDefault: true });
  const film = (await one<any>(`INSERT INTO metadata_schemas(account_id,name,target_kind,fields) VALUES ($1,'Film','vod','[]'::jsonb) RETURNING id`, [acct]))!.id as string;

  let spekeDown = false;
  const KEY_B64 = Buffer.from([...Array(16).keys()]).toString('base64');
  const speke = httpServer((rq, rs) => {
    let body = '';
    rq.on('data', (d) => { body += d; });
    rq.on('end', () => {
      if (spekeDown) { rs.writeHead(500); rs.end('down'); return; }
      const kid = /ContentKey[^>]*\bkid="([^"]+)"/.exec(body)?.[1] ?? '00000000-0000-0000-0000-000000000000';
      const media = '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://keys.example.test/fp",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"';
      const b64 = (x: string) => Buffer.from(x).toString('base64');
      rs.writeHead(200, { 'content-type': 'application/xml' });
      rs.end(`<?xml version="1.0" encoding="UTF-8"?>
<cpix:CPIX xmlns:cpix="urn:dashif:org:cpix" xmlns:pskc="urn:ietf:params:xml:ns:keyprov:pskc" id="x">
 <cpix:ContentKeyList><cpix:ContentKey kid="${kid}" explicitIV="${Buffer.alloc(16, 1).toString('base64')}" commonEncryptionScheme="cbcs"><cpix:Data><pskc:Secret><pskc:PlainValue>${KEY_B64}</pskc:PlainValue></pskc:Secret></cpix:Data></cpix:ContentKey></cpix:ContentKeyList>
 <cpix:DRMSystemList><cpix:DRMSystem kid="${kid}" systemId="94ce86fb-07ff-4f43-adb8-93d2fa968ca2"><cpix:HLSSignalingData playlist="media">${b64(media)}</cpix:HLSSignalingData><cpix:HLSSignalingData playlist="master">${b64(media.replace('#EXT-X-KEY', '#EXT-X-SESSION-KEY'))}</cpix:HLSSignalingData></cpix:DRMSystem></cpix:DRMSystemList>
</cpix:CPIX>`);
    });
  }).listen(0, '127.0.0.1');
  await new Promise((res) => speke.once('listening', res));
  process.env.VOLT_TEST_VOD_DRM_SECRET = 'mgmt-secret';
  await one(`INSERT INTO drm_configs(account_id, tenant_id, key_service_url, license_service_url, management_key_ref)
             VALUES ($1, 'tenant-vod', $2, 'https://licence.test', 'env:VOLT_TEST_VOD_DRM_SECRET')`, [acct, `http://127.0.0.1:${(speke.address() as any).port}/speke/v2.0/copyProtection`]);

  const work = join(root, 'work'); await mkdir(work, { recursive: true });
  const mp4 = join(work, 'Feature.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=f=330:d=2:sample_rate=48000',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-c:a', 'aac', '-shortest', mp4], { stdio: 'ignore' });

  const srv = createServer().listen(0);
  await new Promise((res) => srv.once('listening', res));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = signAccess({ sub: owner, account_id: acct, role: 'owner' } as any);
  const call = async (method: string, path: string, body?: any) => {
    const x = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { s: x.status, j: await x.json().catch(() => null) as any };
  };
  const { handleVodEncode } = await import('../src/services/jobs/handlers/vodEncode');
  const ctxRun = async (payload: any, jobId: string | null) => {
    try { return { err: null, out: await handleVodEncode({ job: { id: jobId, attempts: 1, payload }, progress: async () => {}, isCancelled: () => false } as any) as any }; }
    catch (e: any) { return { err: String(e?.message ?? e), out: null as any }; }
  };
  const jobsFor = (id: string, type = 'vod.repackage') => query<any>(`SELECT id, state, run_after, payload, created_at FROM jobs WHERE type = $2 AND payload->>'vodAssetId' = $1 ORDER BY created_at`, [id, type]);
  const runQueued = async (id: string) => {
    const j = (await jobsFor(id)).find((x) => x.state === 'queued');
    if (!j) return { err: 'no queued job', out: null as any, jobId: null };
    await query(`UPDATE jobs SET state = 'running', started_at = now() WHERE id = $1`, [j.id]);
    const r = await ctxRun(j.payload, j.id);
    await query(`UPDATE jobs SET state = $2, finished_at = now() WHERE id = $1`, [j.id, r.err ? 'failed' : 'succeeded']);
    return { ...r, jobId: j.id as string };
  };
  const row = (id: string) => one<any>(`SELECT master_key, progressive_key, encode_result->>'drm' AS drm, media_state, duration_ms FROM vod_assets WHERE id = $1`, [id]);
  const ruleOn = { settings: { protection: { drm: true }, distribution: { mp4Download: false } }, lockedFields: [], presetKey: null, name: 'Protected films', confirm: true };
  const ruleOff = { settings: { protection: { drm: false } }, lockedFields: [], presetKey: null, name: 'Protected films', confirm: true };

  try {
    console.log('\n== a title encoded into the bucket ==');
    const A = (await one<any>(`INSERT INTO vod_assets(account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, metadata, schema_id, source_key)
       VALUES ($1,'upload','export','Feature A',0,0,0,'{}'::jsonb,$2,$3) RETURNING id`, [acct, film, mp4]))!.id as string;
    const ej = await one<any>(`INSERT INTO jobs(type, payload, state) VALUES ('vod.encode', $1::jsonb, 'succeeded') RETURNING id`, [JSON.stringify({ vodAssetId: A })]);
    await query(`UPDATE vod_assets SET encode_job_id = $2 WHERE id = $1`, [A, ej!.id]);
    const e0 = await ctxRun({ vodAssetId: A, accountId: acct, sourcePath: mp4 }, ej!.id);
    const r0 = await row(A);
    check('the encode lands at the root of the title\'s folder, clear, with its MP4', [e0.err, r0.master_key, r0.drm, r0.progressive_key], [null, `vod/${A}/master.m3u8`, 'clear', `vod/${A}/file.mp4`]);
    const rootKeys0 = await keysUnder(`vod/${A}/`);
    check('...its files are in the bucket', [rootKeys0.includes(`vod/${A}/master.m3u8`), rootKeys0.includes(`vod/${A}/manifest.mpd`), rootKeys0.includes(`vod/${A}/file.mp4`)], [true, true, true]);
    // What lives beside the packaging and must outlive it.
    await put(`vod/${A}/ladders/g1/6s/master.m3u8`, '#EXTM3U\n');
    await put(`vod/${A}/reframe/vertical.mp4`, 'x');
    await query(`UPDATE vod_assets SET availability_state = 'available', published = true, available_from = now() - interval '1 day' WHERE id = $1`, [A]);

    console.log('\n== DRM on: queued, not held ==');
    const on1 = await call('PUT', `/api/publishing-rules/schema/${film}`, ruleOn);
    check('confirmed: one repackage queued, none waiting', [on1.s, on1.j?.repackage?.queued, on1.j?.repackage?.waiting], [200, 1, []]);
    const t0 = Date.now();
    const j1 = await runQueued(A);
    const r1 = await row(A);
    const sub = VS.repackSubdir(j1.jobId, 1);
    const nb1 = `vod/${A}/${sub}`;
    check('the job succeeds: cbcs, the title still ready', [j1.err, j1.out?.repackaged, r1.drm, r1.media_state], [null, true, 'cbcs', 'ready']);
    check('master_key moved to the repackage\'s own prefix; no MP4 for an encrypted title', [r1.master_key, r1.progressive_key], [`${nb1}/master.m3u8`, null]);
    const k1 = await keysUnder(`${nb1}/`);
    check('the new files are under that prefix: master, MPD, init and segments, no MP4, no job file',
      [k1.includes(`${nb1}/master.m3u8`), k1.includes(`${nb1}/manifest.mpd`), k1.some((k) => k.endsWith('init.mp4')), k1.some((k) => k.endsWith('.m4s')), k1.some((k) => k.endsWith('.mp4') && !k.endsWith('init.mp4')), k1.some((k) => k.endsWith('encode-job.json'))],
      [true, true, true, true, false, false]);
    check('the old package is untouched until its grace is over (viewers mid-title keep reading it)',
      [await text(`vod/${A}/master.m3u8`) !== null, (await keysUnder(`vod/${A}/`)).includes(`vod/${A}/file.mp4`)], [true, true]);
    const cj = await jobsFor(A, 'vod.repackage.cleanup');
    const wait = cj[0] ? new Date(cj[0].run_after).getTime() - t0 : -1;
    check('the cleanup of the old package is queued, for the title\'s length plus 11 min from now',
      [cj.length, cj[0]?.payload?.oldBase, wait > R.oldPackageGraceMs(Number(r1.duration_ms)) - 120_000 && wait < R.oldPackageGraceMs(Number(r1.duration_ms)) + 60_000], [1, `vod/${A}`, true]);

    console.log('\n== the readers follow master_key ==');
    check('bucketBaseOf: the new prefix', BT.bucketBaseOf(A, r1.master_key), nb1);
    const st = await BT.syncBucketTracks(A);
    check('caption tracks are written beside the new master, not the old one', [st.error ?? null, st.skipped ?? null, st.written.length > 0 && st.written.every((k) => k.startsWith(`${nb1}/`))], [null, null, true]);
    check('packageRootOf: the archive copies the new package', PK.packageRootOf({ id: A, master_key: r1.master_key }), `/${nb1}`);
    const plan = await PK.planPackage({ id: A, master_key: r1.master_key });
    check('...and its plan lists the new files from the bucket (this task holds them under another name)', [plan?.local, !!plan?.files.some((f) => f.path === 'master.m3u8'), !!plan?.files.every((f) => f.uri.includes(`/${nb1}/`))], [false, true, true]);
    const rel = SV.clipsPathOfMaster(r1.master_key);
    const viaClips = (await SV.readClipsFile(rel!))?.toString('utf8') ?? null;
    check('the /clips read-through (trick play, frame index) reads the new master from the bucket', [rel, viaClips != null && viaClips === await text(`${nb1}/master.m3u8`), /SESSION-KEY|EXT-X-KEY/.test(viaClips ?? '') || realPackager], [`/${nb1}/master.m3u8`, true, true]);
    const viaApi = await call('GET', `/api/vod/${A}`);
    check('the asset answers with the new master', [viaApi.s, JSON.stringify(viaApi.j ?? {}).includes(`${sub}/master.m3u8`)], [200, true]);

    console.log('\n== the cleanup ==');
    const c1 = await R.removeOldPackage(A, `vod/${A}`);
    const after1 = await keysUnder(`vod/${A}/`);
    check('the old package is gone: master, MPD, renditions, MP4', [c1.removed > 0, after1.filter((k) => !k.startsWith(`${nb1}/`) && !k.includes('/ladders/') && !k.includes('/reframe/'))], [true, []]);
    check('...FAST ladder variants, reframes and the new package stay', [after1.includes(`vod/${A}/ladders/g1/6s/master.m3u8`), after1.includes(`vod/${A}/reframe/vertical.mp4`), k1.every((k) => after1.includes(k))], [true, true, true]);
    check('running it again removes nothing more', (await R.removeOldPackage(A, `vod/${A}`)).removed, 0);
    check('a cleanup naming the current package removes nothing', (await R.removeOldPackage(A, nb1)).removed, 0);

    console.log('\n== DRM off again: a second prefix, the first goes whole ==');
    await query(`UPDATE jobs SET state = 'cancelled' WHERE type = 'vod.repackage.cleanup' AND state = 'queued'`);
    const off = await call('PUT', `/api/publishing-rules/schema/${film}`, ruleOff);
    check('turning DRM off: queued', [off.s, off.j?.repackage?.queued], [200, 1]);
    const j2 = await runQueued(A);
    const r2 = await row(A);
    const nb2 = `vod/${A}/${VS.repackSubdir(j2.jobId, 1)}`;
    check('clear files under a second prefix, the MP4 back beside them', [j2.err, r2.drm, r2.master_key, r2.progressive_key], [null, 'clear', `${nb2}/master.m3u8`, `${nb2}/file.mp4`]);
    check('...the encrypted first package is still there until its grace is over', (await keysUnder(`${nb1}/`)).length, k1.length);
    const cj2 = (await jobsFor(A, 'vod.repackage.cleanup')).filter((j) => j.state === 'queued');
    check('...its cleanup is queued, naming the first prefix', cj2.map((j) => j.payload.oldBase), [nb1]);
    const c2 = await R.removeOldPackage(A, nb1);
    check('the cleanup takes the first prefix whole and nothing else', [c2.removed, (await keysUnder(`${nb1}/`)).length, (await text(`${nb2}/master.m3u8`)) !== null, (await keysUnder(`vod/${A}/ladders/`)).length], [k1.length, 0, true, 1]);

    console.log('\n== a repackage that fails ==');
    await query(`UPDATE jobs SET state = 'cancelled' WHERE type = 'vod.repackage.cleanup' AND state = 'queued'`);
    await call('PUT', `/api/publishing-rules/schema/${film}`, ruleOn);
    spekeDown = true;
    const j3 = await runQueued(A);
    spekeDown = false;
    const r3 = await row(A);
    const dirs = [...new Set((await keysUnder(`vod/${A}/`)).map((k) => k.split('/')[2]).filter((n) => VS.REPACK_DIR.test(n)))];
    check('the job fails; the title keeps its clear files and its master; no new prefix; no cleanup queued',
      [!!j3.err, r3.master_key, r3.drm, dirs, (await jobsFor(A, 'vod.repackage.cleanup')).filter((j) => j.state === 'queued').length], [true, `${nb2}/master.m3u8`, 'clear', [VS.repackSubdir(j2.jobId, 1)], 0]);

    console.log('\n== deleting the title ==');
    const { removeVodAsset } = await import('../src/services/vodRemove');
    const binId = await removeVodAsset(A, { reason: 'test' });
    const inBin = await keysUnder(`trash/`);
    check('the repackage folder moves into the restore bin with the rest of the title', [!!binId, (await keysUnder(`vod/${A}/`)).length, inBin.some((k) => k.endsWith(`vod/${A}/${VS.repackSubdir(j2.jobId, 1)}/master.m3u8`))], [true, 0, true]);
    check('a cleanup after the delete finds the title gone and removes nothing', (await R.removeOldPackage(A, nb1)).removed, 0);
  } finally {
    srv.close();
    speke.close();
    moto?.kill();
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(1); });
