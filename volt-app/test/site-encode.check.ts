// ============================================================================
//  HYBRID SITES 4: SITE ENCODING, THE CLOUD SIDE (build queue H4).
//
//  Through the real API on a real database, with this suite playing the site
//  worker and running the real vod_encoder.py (ffmpeg real; Shaka when it is
//  on PATH or PACKAGER_BIN, otherwise a stub that writes a coherent package):
//    - the plan half: planEncode and encoderJobFor give the cloud encode's
//      own decisions, and the job file carries no paths;
//    - requestSiteEncode: licence, site, asset and store checks; the probe
//      job waits in the site's pool and no cloud worker takes it;
//    - probe -> plan -> encode job with the plan, the ladder fitted by the
//      cloud; an unreadable source or a file with nothing in it fails the
//      asset with the reason, permanently;
//    - declared outputs: paths checked, duplicates and junk refused, appended
//      in parts, each file one upload transfer held to its checksum;
//    - verification: a missing segment, a master listing fewer renditions
//      than planned, a live (unfinished) playlist and a live DASH manifest
//      each fail the attempt, discard the upload and retry; a whole package
//      is swapped in and the asset recorded as a cloud encode is (ready,
//      master, formats, encode result with where it was encoded), QC queued;
//    - a worker's permanent failure fails the asset; a lost lease is refused;
//    - with the origin bucket, a site encode is refused (H4-2).
//
//  Usage: DATABASE_URL=... npx tsx test/site-encode.check.ts
// ============================================================================
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };

(async () => {
  const root = mkdtempSync(join(tmpdir(), 'site-encode-'));
  process.env.CLIPS_DIR = join(root, 'clips');
  process.env.VOD_STORE = 'local';
  mkdirSync(process.env.CLIPS_DIR, { recursive: true });

  // THE PACKAGER: real when there is one, otherwise a stub that writes what
  // Shaka writes (init and numbered segments per stream, a media playlist per
  // stream, the master and a static MPD), with one segment per started
  // segment length of the input, so the counts are checked for real.
  const realPackager = spawnSync(process.env.PACKAGER_BIN || 'packager', ['--version'], { stdio: 'ignore' }).status === 0;
  if (!realPackager) {
    const stub = join(root, 'packager-stub.py');
    writeFileSync(stub, `#!/usr/bin/env python3
import json, math, os, subprocess, sys
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
        open(s['segment_template'].replace('$Number$', str(k)), 'wb').write(b'seg%d' % k)
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
  console.log(realPackager ? '(the real packager)' : '(no packager here: a stub writes the package; on the Mac run with PACKAGER_BIN=../packager-osx-arm64/packager)');

  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { config } = await import('../src/config');
  const Q = await import('../src/services/jobs/queue');
  const E = await import('../src/services/sites/siteEncode');
  const V = await import('../src/services/jobs/handlers/vodEncode');

  const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'ignore' });
  const work = join(root, 'site'); mkdirSync(work, { recursive: true });
  // The customer's source: 6 s of 640x360 with sound.
  const src = join(work, 'Evening News.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc=s=640x360:r=25:d=6', '-f', 'lavfi', '-i', 'sine=f=440:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  const junk = join(work, 'broken.mp4'); writeFileSync(junk, 'this is not a video');
  const encoder = join(config.testStream.encoderBin, 'vod_encoder.py');
  const runEnc = (job: any) => {
    const j = join(work, `job-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(j, JSON.stringify(job));
    const r = spawnSync(config.testStream.pythonBin, [encoder, j], { encoding: 'utf8' });
    return { code: r.status, json: V.lastJson(r.stdout ?? ''), err: (r.stderr ?? '').slice(-600) };
  };
  const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
  const filesIn = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? filesIn(join(dir, e.name)) : [join(dir, e.name)]);

  // ---- the database ---------------------------------------------------------------
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name, licences) VALUES ($1, '{hybrid_sites}') RETURNING id`, [`se-${tag}`]))!.id;
  const plain = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`se-plain-${tag}`]))!.id;
  const owner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `se-${tag}@example.com`]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type, codec_backend, packaging)
      VALUES ($1,'HD','[{"height":720,"bitrate_kbps":3000},{"height":360,"bitrate_kbps":800},{"height":240,"bitrate_kbps":400}]','transcode','x264','both') RETURNING id`, [acct]))!.id;
  const { ensureTrackingGroup } = await import('../src/services/encode/store');
  await ensureTrackingGroup(acct, prof, 'Same as live', { makeDefault: true });
  const newAsset = async (title: string, a = acct) => (await one<any>(
    `INSERT INTO vod_assets(account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, metadata)
     VALUES ($1,'watchfolder','export',$2,0,0,0,'{}'::jsonb) RETURNING id`, [a, title]))!.id;
  const tok = signAccess({ sub: owner, account_id: acct, role: 'owner' } as any);

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: unknown, t: string | null = tok) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let b: any = null; try { b = text ? JSON.parse(text) : null; } catch { b = text; }
    return { status: r.status, body: b };
  };
  const facts = (hostname: string) => ({ hostname, cpuCores: 8, memoryBytes: 16 * 2 ** 30, diskFreeBytes: 1e12, diskTotalBytes: 2e12, os: 'Linux', arch: 'x64', agentVersion: '0.7.0' });
  const site = (await api('POST', '/api/sites', { name: 'Main broadcast centre' })).body.id;
  const tk = await api('POST', `/api/sites/${site}/enrolment-tokens`, {});
  const en = await api('POST', '/api/site-agent/enrol', { token: tk.body.token, host: facts('enc-01') }, null);
  await api('POST', `/api/sites/${site}/hosts/${en.body.hostId}/approve`, {});
  const cred = en.body.credential as string;
  ok(!!cred, 'a site with an approved host');
  const TYPES = E.SITE_ENCODE_JOB_TYPES;
  const lease = async () => api('POST', '/api/site-agent/jobs/lease', { types: TYPES }, cred);
  const asset = async (id: string) => one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [id]);

  console.log('== the plan half ==');
  const encProbe = runEnc({ input: src, out_dir: join(work, 'probe-out'), probe_only: true }).json;
  ok(encProbe?.width === 640 && encProbe?.height === 360 && Math.round(encProbe.durationMs / 1000) === 6, 'vod_encoder.py probes the source', encProbe);
  const steps: string[] = [];
  const plan = await V.planEncode({ accountId: acct }, encProbe, { step: (s: string) => steps.push(s) });
  ok(plan.fit.kept.map((r: any) => r.height).join() === '360,240' && plan.fit.dropped.some((r: any) => r.height === 720), 'planEncode fits the ladder to the source: no upscale to 720p', plan.fit.kept.map((r: any) => r.height));
  ok(steps.some((s) => s.startsWith('ladder "')), 'and logs it as the cloud encode does', steps);
  const job0 = V.encoderJobFor(plan, { accountId: acct }, encProbe);
  ok(!('input' in job0) && !('out_dir' in job0) && !('work_dir' in job0) && job0.packaging === 'both' && (job0.ladder as any[]).length === 2 && job0.duration_sec === encProbe.durationMs / 1000, 'the encoder job file carries the settings and no paths', job0);
  let threw: any = null;
  try { await V.planEncode({ accountId: acct }, { hasVideo: false, hasAudio: false } as any, { step: () => {} }); } catch (e) { threw = e; }
  ok(threw?.code === 'no_media', 'a file with neither picture nor sound is refused by the plan, permanently', threw?.code);

  console.log('== asking for a site encode ==');
  const A = await newAsset('Evening News');
  const req = { vodAssetId: A, accountId: acct, siteId: site, sitePath: '/mnt/news/drop/Evening News.mp4', sourceBytes: statSync(src).size };
  const t = async (f: () => Promise<unknown>) => { try { await f(); return null; } catch (e: any) { return e; } };
  ok((await t(() => E.requestSiteEncode({ ...req, accountId: plain })))?.status === 404, "another account's request finds no site");
  await query(`UPDATE accounts SET licences = '{}' WHERE id = $1`, [acct]);
  ok((await t(() => E.requestSiteEncode(req)))?.code === 'licence_required', 'without Hybrid Sites it is refused');
  await query(`UPDATE accounts SET licences = '{hybrid_sites}' WHERE id = $1`, [acct]);
  ok((await t(() => E.requestSiteEncode({ ...req, sitePath: '' })))?.status === 400, 'a source path at the site is required');
  const theirs = await newAsset('Theirs', plain);
  ok((await t(() => E.requestSiteEncode({ ...req, vodAssetId: theirs })))?.status === 404, "another account's asset is not found");
  process.env.VOD_STORE = 's3';
  ok(/^s3:\/\/[^/]+\/site-staging\/[0-9a-f-]+\/j1-a2$/.test(E.stagingDirFor({ id: 'j1', attempts: 2, payload: { vodAssetId: A } } as any)),
    'with the origin bucket the package waits under site-staging/ in the bucket (H4-4; site-encode-bucket.check.ts runs it)', E.stagingDirFor({ id: 'j1', attempts: 2, payload: { vodAssetId: A } } as any));
  process.env.VOD_STORE = 'local';
  const probeJob = await E.requestSiteEncode(req);
  ok(probeJob.type === E.SITE_VOD_PROBE && probeJob.pool === Q.sitePool(site), 'the probe waits in the site pool', [probeJob.type, probeJob.pool]);
  let a = await asset(A);
  ok(a.media_state === 'processing' && a.encode_job_id === probeJob.id, 'the asset reads Processing', a.media_state);
  ok((await Q.claim(TYPES, 'cloud-worker')) === null, 'no cloud worker takes a site encode job');

  console.log('== probe, then the plan ==');
  let r = await lease();
  ok(r.status === 200 && r.body.type === E.SITE_VOD_PROBE && r.body.payload.sitePath === req.sitePath, 'the host leases the probe with the path at the site', r.body?.type);
  let L = r.body;
  r = await api('POST', `/api/site-agent/jobs/${L.id}/complete`, { leaseId: L.leaseId, result: { probe: 'nope' } }, cred);
  ok(r.status === 400 && r.body?.code === 'bad_result', 'a result without a probe is refused', r);
  r = await api('POST', `/api/site-agent/jobs/${L.id}/complete`, { leaseId: L.leaseId, result: { probe: encProbe } }, cred);
  ok(r.status === 200, 'the probe completes', r);
  const encJob = await one<any>(`SELECT * FROM jobs WHERE type = $1 AND payload->>'vodAssetId' = $2`, [E.SITE_VOD_ENCODE, A]);
  ok(encJob && encJob.pool === Q.sitePool(site) && encJob.payload.plan.fit.kept.length === 2 && encJob.payload.encoder.ladder.length === 2, 'the cloud queued the encode with its plan', encJob?.payload?.plan?.summary);
  a = await asset(A);
  ok(a.encode_job_id === encJob.id && a.media_state === 'processing', 'the asset follows the encode job');

  console.log('== attempt 1: a segment missing ==');
  r = await lease();
  L = r.body;
  ok(r.status === 200 && L.type === E.SITE_VOD_ENCODE && L.payload.encoder.segment_seconds > 0 && !('transfers' in L.payload) && L.transfers.length === 0, 'the host leases the encode: the settings, no transfers yet', L?.type);
  const out1 = join(work, 'out1');
  const e1 = runEnc({ ...L.payload.encoder, input: src, out_dir: out1, work_dir: join(out1, '.enc') });
  ok(e1.code === 0 && existsSync(join(out1, 'master.m3u8')), 'the worker encodes with the given settings', e1.err);
  const pkgFiles = (dir: string) => filesIn(dir).filter((f) => !relative(dir, f).startsWith('.enc')).map((f) => ({ path: relative(dir, f).split('\\').join('/'), bytes: statSync(f).size, sha256: sha(f) }));
  const files1 = pkgFiles(out1);
  ok(files1.some((f) => f.path === 'manifest.mpd') && files1.filter((f) => f.path.endsWith('.m4s')).length >= 4, 'it produced a package', files1.length);
  // the declaration rules
  for (const [bad, why] of [['../etc/passwd', 'a way out'], ['/abs/x.m4s', 'an absolute path'], ['.hidden', 'a dot file'], ['a//b', 'an empty segment']] as const) {
    r = await api('POST', `/api/site-agent/jobs/${L.id}/outputs`, { leaseId: L.leaseId, files: [{ path: bad, bytes: 1, sha256: 'a'.repeat(64) }] }, cred);
    ok(r.status === 400, `declaring ${why} is refused`, r.status);
  }
  r = await api('POST', `/api/site-agent/jobs/${L.id}/outputs`, { leaseId: L.leaseId, files: [files1[0], files1[0]] }, cred);
  ok(r.status === 400 && /twice/.test(r.body?.error ?? r.body?.message ?? JSON.stringify(r.body)), 'a path listed twice is refused', r.body);
  r = await api('POST', `/api/site-agent/jobs/${L.id}/outputs`, { leaseId: L.leaseId, files: [{ ...files1[0], sha256: 'xyz' }] }, cred);
  ok(r.status === 400, 'a bad checksum is refused', r.status);
  r = await api('POST', `/api/site-agent/jobs/${L.id}/outputs`, { leaseId: 'site-host:not-mine', files: files1 }, cred);
  ok(r.status === 409 && r.body?.code === 'lease_lost', 'another lease cannot declare', r.status);
  // declared in two parts
  const half = Math.ceil(files1.length / 2);
  r = await api('POST', `/api/site-agent/jobs/${L.id}/outputs`, { leaseId: L.leaseId, files: files1.slice(0, half) }, cred);
  const r2 = await api('POST', `/api/site-agent/jobs/${L.id}/outputs`, { leaseId: L.leaseId, files: files1.slice(half), append: true }, cred);
  ok(r.status === 200 && r2.status === 200 && r2.body.files === files1.length && r2.body.transfers.length === files1.length && r2.body.transfers.every((x: any) => x.direction === 'upload' && x.name.startsWith('out/')), 'declared in two parts, one upload transfer per file', [r.status, r2.status, r2.body?.files]);
  r = await api('POST', `/api/site-agent/jobs/${L.id}/outputs`, { leaseId: L.leaseId, files: [files1[0]], append: true }, cred);
  ok(r.status === 400, 'appending a path already declared is refused', r.status);
  const upload = async (Lx: any, f: { path: string }, body: Buffer) => {
    const u = await api('POST', `/api/site-agent/jobs/${Lx.id}/transfer-url`, { leaseId: Lx.leaseId, name: `out/${f.path}` }, cred);
    if (u.status !== 200) return u.status;
    const put = await fetch(base + u.body.url, { method: 'PUT', body: body as any, headers: { authorization: `Bearer ${cred}` } });
    await put.text();
    return put.status;
  };
  const missing = files1.find((f) => f.path.endsWith('seg_2.m4s'))!;
  let codes: number[] = [];
  for (const f of files1) if (f !== missing) codes.push(await upload(L, f, readFileSync(join(out1, f.path))));
  ok(codes.every((c) => c === 201), 'every other file uploads through its transfer', codes);
  ok(await upload(L, missing, Buffer.from('not the segment')) === 422, 'a file whose bytes do not match the declared checksum is refused as it arrives');
  const staging1 = E.stagingDirFor({ id: L.id, attempts: L.attempt, payload: L.payload } as any);
  ok(existsSync(join(staging1, 'master.m3u8')) && staging1.startsWith(join(process.env.CLIPS_DIR!, 'vod')), 'the upload waits in a staging folder of this attempt', staging1);
  r = await api('POST', `/api/site-agent/jobs/${L.id}/complete`, { leaseId: L.leaseId, result: {} }, cred);
  ok(r.status === 422 && r.body?.code === 'verification_failed' && /seg_2\.m4s was declared but not uploaded/.test(r.body?.error ?? r.body?.message ?? ''), 'complete is refused: the package did not verify, and says why', r.body);
  const st1 = await one<any>(`SELECT state, payload FROM jobs WHERE id = $1`, [L.id]);
  ok(st1.state === 'queued' && !st1.payload.declared && st1.payload.transfers.length === 0, 'the job goes back to the pool for another attempt, its declaration cleared', st1.state);
  ok(!existsSync(staging1), 'the unverified upload is discarded');
  a = await asset(A);
  ok(a.media_state === 'processing' && !a.master_key, 'the asset is still Processing, with no master', [a.media_state, a.master_key]);

  console.log('== attempt 2: the master lists fewer renditions than planned ==');
  await query(`UPDATE jobs SET run_after = now() WHERE id = $1`, [L.id]);
  r = await lease();
  L = r.body;
  ok(r.status === 200 && L.attempt === 2 && L.transfers.length === 0, 'attempt 2 starts with no transfers', [L?.attempt, L?.transfers?.length]);
  const out2 = join(work, 'out2');
  runEnc({ ...L.payload.encoder, input: src, out_dir: out2, work_dir: join(out2, '.enc') });
  const m2 = readFileSync(join(out2, 'master.m3u8'), 'utf8').split('\n');
  const si = m2.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
  writeFileSync(join(out2, 'master.m3u8'), [...m2.slice(0, si), ...m2.slice(si + 2)].join('\n'));
  const files2 = pkgFiles(out2);
  r = await api('POST', `/api/site-agent/jobs/${L.id}/outputs`, { leaseId: L.leaseId, files: files2 }, cred);
  for (const f of files2) await upload(L, f, readFileSync(join(out2, f.path)));
  r = await api('POST', `/api/site-agent/jobs/${L.id}/complete`, { leaseId: L.leaseId, result: {} }, cred);
  ok(r.status === 422 && /lists 1 rendition\(s\); the plan has 2/.test(r.body?.error ?? r.body?.message ?? ''), 'a master with fewer renditions than planned does not verify', r.body?.error ?? r.body);

  console.log('== attempt 3: the whole package ==');
  await query(`UPDATE jobs SET run_after = now() WHERE id = $1`, [L.id]);
  L = (await lease()).body;
  const out3 = join(work, 'out3');
  const e3 = runEnc({ ...L.payload.encoder, input: src, out_dir: out3, work_dir: join(out3, '.enc') });
  const files3 = pkgFiles(out3);
  await api('POST', `/api/site-agent/jobs/${L.id}/progress`, { leaseId: L.leaseId, pct: 80, note: 'uploading' }, cred);
  r = await api('POST', `/api/site-agent/jobs/${L.id}/outputs`, { leaseId: L.leaseId, files: files3 }, cred);
  codes = [];
  for (const f of files3) codes.push(await upload(L, f, readFileSync(join(out3, f.path))));
  ok(r.status === 200 && codes.every((c) => c === 201), 'declared and uploaded', codes.filter((c) => c !== 201));
  r = await api('POST', `/api/site-agent/jobs/${L.id}/complete`, { leaseId: L.leaseId, result: { encoder: e3.json ?? {} } }, cred);
  ok(r.status === 200 && r.body?.state === 'succeeded', 'complete is accepted: the package verified', r.body);
  a = await asset(A);
  const outDir = V.outDirFor(A);
  ok(a.media_state === 'ready' && a.master_key === `/clips/vod/${A}/master.m3u8`, 'the asset is ready, played from its own master', [a.media_state, a.master_key]);
  ok(a.formats?.hls === true && a.formats?.dash === true && a.formats?.progressive === false, 'HLS and DASH, no MP4 (the source is at the site)', a.formats);
  ok(a.encode_result?.kept?.length === 2 && a.encode_result?.ladder?.name && a.encode_result?.probe?.width === 640 && a.encode_result?.encodedAt?.site === site && a.encode_result?.encodedAt?.job === L.id, 'the encode result is recorded as a cloud encode records it, with where it was encoded', a.encode_result?.encodedAt);
  ok(Number(a.source_bytes) === req.sourceBytes && Math.round(a.duration_ms / 1000) === 6, 'the source size and the length are on the asset', [a.source_bytes, a.duration_ms]);
  ok(files3.every((f) => existsSync(join(outDir, f.path)) && sha(join(outDir, f.path)) === f.sha256), 'every file is in the asset folder, byte for byte');
  ok(!readdirSync(join(process.env.CLIPS_DIR!, 'vod')).some((n) => n.includes('.site-') || n.includes('.replaced-')), 'no staging or replaced folder is left behind', readdirSync(join(process.env.CLIPS_DIR!, 'vod')));
  ok(!!(await one<any>(`SELECT id FROM jobs WHERE type = 'qc.run' AND payload->>'vodAssetId' = $1`, [A])), 'QC is queued, as after a cloud encode');
  const logs = await query<any>(`SELECT line FROM job_logs WHERE job_id = $1 ORDER BY seq`, [L.id]);
  ok(logs.some((l: any) => /package from the site verified/.test(l.line)) && logs.some((l: any) => /MP4: not made, the source is at the site/.test(l.line)), "the job's log says what happened", logs.map((l: any) => l.line).slice(0, 6));

  console.log('== a re-encode replaces the package whole ==');
  const oldMaster = readFileSync(join(outDir, 'master.m3u8'), 'utf8');
  const pj = await E.requestSiteEncode(req);
  L = (await lease()).body;
  ok(L.id === pj.id, 'a second request queues a new probe');
  await api('POST', `/api/site-agent/jobs/${L.id}/complete`, { leaseId: L.leaseId, result: { probe: encProbe } }, cred);
  L = (await lease()).body;
  const out4 = join(work, 'out4');
  runEnc({ ...L.payload.encoder, input: src, out_dir: out4, work_dir: join(out4, '.enc') });
  writeFileSync(join(out4, 'manifest.mpd'), '<MPD type="dynamic"><Period/></MPD>');
  let files4 = pkgFiles(out4);
  await api('POST', `/api/site-agent/jobs/${L.id}/outputs`, { leaseId: L.leaseId, files: files4 }, cred);
  for (const f of files4) await upload(L, f, readFileSync(join(out4, f.path)));
  r = await api('POST', `/api/site-agent/jobs/${L.id}/complete`, { leaseId: L.leaseId, result: {} }, cred);
  ok(r.status === 422 && /not static/.test(r.body?.error ?? ''), 'a live DASH manifest does not verify', r.body?.error);
  ok(readFileSync(join(outDir, 'master.m3u8'), 'utf8') === oldMaster && (await asset(A)).media_state === 'processing', 'the playing package is untouched while the new one fails');
  await query(`UPDATE jobs SET run_after = now() WHERE id = $1`, [L.id]);
  L = (await lease()).body;
  const pl = readdirSync(out4).find((n) => /^stream_\d+\.m3u8$/.test(n))!;
  writeFileSync(join(out4, 'manifest.mpd'), '<MPD type="static"><Period/></MPD>');
  writeFileSync(join(out4, pl), readFileSync(join(out4, pl), 'utf8').replace('#EXT-X-ENDLIST\n', ''));
  files4 = pkgFiles(out4);
  await api('POST', `/api/site-agent/jobs/${L.id}/outputs`, { leaseId: L.leaseId, files: files4 }, cred);
  for (const f of files4) await upload(L, f, readFileSync(join(out4, f.path)));
  r = await api('POST', `/api/site-agent/jobs/${L.id}/complete`, { leaseId: L.leaseId, result: {} }, cred);
  ok(r.status === 422 && /not a finished \(VOD\) playlist/.test(r.body?.error ?? ''), 'an unfinished (live) media playlist does not verify', r.body?.error);
  ok((await one<any>(`SELECT state FROM jobs WHERE id = $1`, [L.id])).state === 'queued' && (await asset(A)).media_state === 'processing', 'with an attempt left, the job waits and the asset stays Processing');
  await query(`UPDATE jobs SET run_after = now() WHERE id = $1`, [L.id]);
  L = (await lease()).body;
  r = await api('POST', `/api/site-agent/jobs/${L.id}/fail`, { leaseId: L.leaseId, error: 'ffmpeg ran out of disk at the site', code: 'disk_full' }, cred);
  ok(r.status === 200 && r.body?.state === 'failed', 'the worker reports the third attempt failed: the job fails', r.body);
  a = await asset(A);
  ok(a.media_state === 'failed' && /encoding at the site failed: ffmpeg ran out of disk/.test(a.media_error ?? '') && a.media_error_code === 'disk_full', 'after its attempts the asset says why', [a.media_state, a.media_error]);

  console.log('== a re-encode that succeeds keeps the FAST ladder packages (H4-5) ==');
  // A FAST channel's package of this asset to its ladder sits inside the asset
  // folder (ladders/, vod.ladder); a running playout may be reading it.
  const lad = join(outDir, 'ladders', 'grp', '4s', 'v1');
  mkdirSync(lad, { recursive: true });
  writeFileSync(join(lad, 'master.m3u8'), '#EXTM3U\n');
  await E.requestSiteEncode(req);
  L = (await lease()).body;
  await api('POST', `/api/site-agent/jobs/${L.id}/complete`, { leaseId: L.leaseId, result: { probe: encProbe } }, cred);
  L = (await lease()).body;
  r = await api('POST', `/api/site-agent/jobs/${L.id}/outputs`, { leaseId: L.leaseId, files: files3 }, cred);
  for (const f of files3) await upload(L, f, readFileSync(join(out3, f.path)));
  r = await api('POST', `/api/site-agent/jobs/${L.id}/complete`, { leaseId: L.leaseId, result: { encoder: e3.json ?? {} } }, cred);
  a = await asset(A);
  ok(r.status === 200 && a.media_state === 'ready' && files3.every((f) => sha(join(outDir, f.path)) === f.sha256), 'the new package is swapped in and the asset is ready again', [r.status, a.media_state]);
  ok(existsSync(join(lad, 'master.m3u8')), 'the FAST ladder package beside it is carried into the new folder, not removed with the old one');
  ok(!readdirSync(join(process.env.CLIPS_DIR!, 'vod')).some((n) => n.includes('.replaced-')), 'and the old folder is gone');

  console.log('== failures reported by the worker ==');
  const B = await newAsset('Broken');
  await E.requestSiteEncode({ ...req, vodAssetId: B, sitePath: '/mnt/news/drop/broken.mp4' });
  L = (await lease()).body;
  const bp = runEnc({ input: junk, out_dir: join(work, 'probe-b'), probe_only: true }).json;
  r = await api('POST', `/api/site-agent/jobs/${L.id}/complete`, { leaseId: L.leaseId, result: { probe: bp ?? { ok: false, error: 'unreadable' } } }, cred);
  ok(r.status === 422 && r.body?.code === 'unreadable_source' && (await one<any>(`SELECT state FROM jobs WHERE id = $1`, [L.id])).state === 'failed', 'an unreadable source fails the probe permanently', r.body);
  a = await asset(B);
  ok(a.media_state === 'failed' && /could not be read at the site/.test(a.media_error ?? ''), 'and the asset says so', a.media_error);
  ok(!(await one<any>(`SELECT id FROM jobs WHERE type = $1 AND payload->>'vodAssetId' = $2`, [E.SITE_VOD_ENCODE, B])), 'no encode was queued for it');
  const C = await newAsset('Gone');
  await E.requestSiteEncode({ ...req, vodAssetId: C, sitePath: '/mnt/news/drop/gone.mp4' });
  L = (await lease()).body;
  r = await api('POST', `/api/site-agent/jobs/${L.id}/fail`, { leaseId: L.leaseId, error: 'source file not found at the site', code: 'source_missing', permanent: true }, cred);
  a = await asset(C);
  ok(r.status === 200 && r.body?.state === 'failed' && a.media_state === 'failed' && a.media_error_code === 'source_missing', "the worker's permanent failure fails the asset with its reason", [r.body?.state, a.media_state, a.media_error_code]);
  r = await api('POST', `/api/site-agent/jobs/${L.id}/outputs`, { leaseId: L.leaseId, files: files3 }, cred);
  ok(r.status === 409, 'a finished job takes no more declarations', r.status);
  const D = await newAsset('Probe only');
  await E.requestSiteEncode({ ...req, vodAssetId: D });
  L = (await lease()).body;
  r = await api('POST', `/api/site-agent/jobs/${L.id}/outputs`, { leaseId: L.leaseId, files: files3 }, cred);
  ok(r.status === 409 && r.body?.code === 'not_an_encode', 'a probe job declares no outputs', r.body?.code);

  console.log(`\nsite-encode: ${pass}/${pass + fail} passed`);
  srv.close();
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
