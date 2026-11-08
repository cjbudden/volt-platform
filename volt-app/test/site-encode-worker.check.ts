// ============================================================================
//  HYBRID SITES 4b: THE SITE WORKER (build queue H4-2).
//
//  The agent's real encode worker (volt-agent/src/siteEncode.ts) against the
//  real API on a real database, running the real vod_encoder.py and ffmpeg
//  (Shaka when it is on PATH or PACKAGER_BIN, otherwise the same stub as
//  site-encode.check.ts):
//    - the Docker runner: the source read only, no network, a GPU only for a
//      job planned for one, the job file with the container's paths;
//    - a whole site encode end to end: probe, plan in the cloud, encode,
//      the package declared in parts and uploaded, verified, asset ready,
//      the attempt's scratch folder removed;
//    - a package the cloud refuses is discarded and the retry succeeds;
//    - GPU jobs only to GPU hosts, and a GPU job that reaches a host without
//      one is handed back, not encoded on the CPU;
//    - a missing source fails for good, an unmounted share is a retry, an
//      encoder that gives no answer is a retry;
//    - the lease reaped mid-encode: the worker stops the encoder and sends
//      nothing more, the job is retried and then succeeds; a reaped lease
//      drops a half declaration; reaped on the last attempt the asset says why.
//
//  Usage: DATABASE_URL=... npx tsx test/site-encode-worker.check.ts
// ============================================================================
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, chmodSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const root = mkdtempSync(join(tmpdir(), 'site-worker-'));
  process.env.CLIPS_DIR = join(root, 'clips');
  process.env.VOD_STORE = 'local';
  mkdirSync(process.env.CLIPS_DIR, { recursive: true });

  const realPackager = spawnSync(process.env.PACKAGER_BIN || 'packager', ['--version'], { stdio: 'ignore' }).status === 0;
  if (!realPackager) {
    // The same stub as site-encode.check.ts: what Shaka writes, one segment per started segment length.
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
  console.log(realPackager ? '(the real packager)' : '(no packager here: a stub writes the package)');

  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { config } = await import('../src/config');
  const Q = await import('../src/services/jobs/queue');
  const E = await import('../src/services/sites/siteEncode');
  const V = await import('../src/services/jobs/handlers/vodEncode');
  const W = await import('../../volt-agent/src/siteEncode');

  const work = join(root, 'site', 'drop'); mkdirSync(work, { recursive: true });
  const src = join(work, 'Evening News.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=640x360:r=25:d=6', '-f', 'lavfi', '-i', 'sine=f=440:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src], { stdio: 'ignore' });

  // ---- the database -----------------------------------------------------------
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name, licences) VALUES ($1, '{hybrid_sites}') RETURNING id`, [`sw-${tag}`]))!.id;
  const owner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `sw-${tag}@example.com`]))!.id;
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
  const facts = { hostname: 'enc-01', cpuCores: 8, memoryBytes: 16 * 2 ** 30, gpus: [], diskFreeBytes: 1e12, diskTotalBytes: 2e12, os: 'Linux', arch: 'x64', agentVersion: '0.7.0', encoderVersion: null };
  const site = (await api('POST', '/api/sites', { name: 'Main broadcast centre' })).body.id;
  const tk = await api('POST', `/api/sites/${site}/enrolment-tokens`, {});
  const en = await api('POST', '/api/site-agent/enrol', { token: tk.body.token, host: facts }, null);
  await api('POST', `/api/sites/${site}/hosts/${en.body.hostId}/approve`, {});
  const cred = en.body.credential as string;
  const hostId = en.body.hostId as string;
  ok(!!cred, 'a site with an approved host');
  const asset = async (id: string) => one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [id]);
  const jobOf = async (type: string, id: string) => one<any>(`SELECT * FROM jobs WHERE type = $1 AND payload->>'vodAssetId' = $2 ORDER BY created_at DESC LIMIT 1`, [type, id]);
  const req = (vodAssetId: string, sitePath = src) => E.requestSiteEncode({ vodAssetId, accountId: acct, siteId: site, sitePath, sourceBytes: statSync(src).size });

  const realRunner = W.encoderRunner({ ...process.env, VOLT_ENCODER_IMAGE: '', VOLT_ENCODER_BIN: config.testStream.encoderBin, VOLT_PYTHON: config.testStream.pythonBin });
  const scratchDir = join(root, 'scratch');
  const logs: string[] = [];
  const ctx = (over: Partial<Parameters<typeof W.encodePass>[0]> = {}) => ({
    server: base, credential: () => cred, scratchDir, runner: realRunner, progressEveryMs: 200, declareBatch: 4, hasGpu: false,
    log: (s: string) => { logs.push(s); }, ...over,
  });
  const scratchEmpty = () => !existsSync(scratchDir) || readdirSync(scratchDir).length === 0;

  console.log('== the Docker runner ==');
  const a1 = W.dockerArgs('volt-encoder:1.2.3', { gpu: false }, '/mnt/news/drop', '/var/scratch/j1');
  ok(a1.join(' ') === 'run --rm --network none -v /mnt/news/drop:/src:ro -v /var/scratch/j1:/work --entrypoint python3 volt-encoder:1.2.3 /app/bin/vod_encoder.py /work/job.json',
    'the pinned image runs with the source read only, the scratch folder as /work and no network', a1.join(' '));
  ok(!a1.includes('--gpus') && W.dockerArgs('volt-encoder:1.2.3', { gpu: true }, '/s', '/w').join(' ').includes('--gpus all'), 'a GPU only for a job planned for NVENC');
  const fakeDocker = join(root, 'fake-docker.sh');
  writeFileSync(fakeDocker, `#!/bin/sh\necho "$@" > "${join(root, 'docker-args.txt')}"\necho '{"ok":true,"width":1}'\n`);
  chmodSync(fakeDocker, 0o755);
  const dockerScratch = join(root, 'dscratch'); mkdirSync(dockerScratch);
  const dr = await W.encoderRunner({ ...process.env, VOLT_ENCODER_IMAGE: 'volt-encoder:1.2.3', VOLT_DOCKER_BIN: fakeDocker })
    .run({ input: src, out_dir: '/here/out', work_dir: '/here/tmp', segment_seconds: 6, gpu: false }, { sourceDir: work, scratch: dockerScratch, onLine: () => {}, signal: new AbortController().signal });
  const dj = JSON.parse(readFileSync(join(dockerScratch, 'job.json'), 'utf8'));
  ok(dr.code === 0 && W.lastJson(dr.stdout)?.ok === true, 'the runner calls docker and reads its answer', dr);
  ok(dj.input === '/src/Evening News.mp4' && dj.out_dir === '/work/out' && dj.work_dir === '/work/tmp' && dj.segment_seconds === 6, 'the job file carries the container paths and the cloud settings', dj);
  ok(readFileSync(join(root, 'docker-args.txt'), 'utf8').includes(`-v ${work}:/src:ro`), 'the source folder is mounted read only');
  const noEnc = W.encoderRunner({ PATH: process.env.PATH });
  let threw: any = null;
  try { await noEnc.run({}, { sourceDir: null, scratch: dockerScratch, onLine: () => {}, signal: new AbortController().signal }); } catch (e) { threw = e; }
  ok(threw?.code === 'no_encoder', 'a host with no encoder configured says so', threw?.message);

  console.log('== a site encode, end to end ==');
  const A = await newAsset('Evening News');
  await req(A);
  logs.length = 0;
  const ran = await W.encodePass(ctx());
  let a = await asset(A);
  ok(ran === 2 && logs.filter((l) => /: done$/.test(l)).length === 2, 'one pass runs the probe, then the encode the cloud queued', { ran, logs });
  ok(a.media_state === 'ready' && a.master_key === `/clips/vod/${A}/master.m3u8`, 'the asset is ready, played from its own master', [a.media_state, a.master_key, a.media_error]);
  ok(a.encode_result?.encodedAt?.site === site && a.encode_result?.kept?.length === 2 && a.formats?.hls && a.formats?.dash, 'recorded as encoded at the site, the ladder fitted by the cloud', a.encode_result?.encodedAt);
  const encA = await jobOf(E.SITE_VOD_ENCODE, A);
  ok(encA.state === 'succeeded' && encA.attempts === 1 && encA.payload.declared.length > 4, `the package was declared in parts (${encA.payload.declared?.length} files, 4 per request) and verified first time`, [encA.state, encA.attempts]);
  const outDir = V.outDirFor(A);
  ok(encA.payload.declared.every((d: any) => existsSync(join(outDir, d.path)) && statSync(join(outDir, d.path)).size === d.bytes), 'every declared file is in the asset folder at its size');
  const master = readFileSync(join(outDir, 'master.m3u8'), 'utf8');
  ok((master.match(/^#EXT-X-STREAM-INF/gm) ?? []).length === 2, 'the master lists the two renditions the cloud planned (no upscale to 720p)');
  ok(scratchEmpty(), "the attempt's scratch folder is removed once the cloud has verified");
  ok(/^(encoding|uploaded)/.test(String(encA.progress_note ?? '')), 'progress was reported while it worked (which keeps the lease)', encA.progress_note);
  const att = await query<any>(`SELECT outcome FROM job_attempts WHERE job_id = $1`, [encA.id]);
  ok(att.length === 1, 'one attempt, no lease lost', att);

  console.log('== a package the cloud refuses is redone ==');
  const B = await newAsset('Refused once');
  await req(B);
  let tampered = 0;
  const tamper: typeof realRunner = {
    describe: 'tampering runner',
    async run(job, o) {
      const r = await realRunner.run(job, o);
      if (!job.probe_only && !tampered) {
        // A segment lost between the encoder and the upload: the package no
        // longer matches its own playlists.
        const segs = (function walk(d: string): string[] { return readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]); })(job.out_dir).filter((f) => f.endsWith('seg_2.m4s'));
        unlinkSync(segs[0]); tampered++;
      }
      return r;
    },
  };
  logs.length = 0;
  await W.encodePass(ctx({ runner: tamper }));
  let encB = await jobOf(E.SITE_VOD_ENCODE, B);
  ok(tampered === 1 && logs.some((l) => /refused by the cloud \(verification_failed\)/.test(l)) && encB.state === 'queued', 'the cloud refused the package and the job waits for another attempt', logs);
  ok(!readdirSync(join(process.env.CLIPS_DIR!, 'vod')).some((n) => n.includes('.site-')) && scratchEmpty(), 'the refused upload and the scratch folder are both gone');
  ok((await asset(B)).media_state === 'processing', 'the asset still reads Processing');
  await query(`UPDATE jobs SET run_after = now() WHERE id = $1`, [encB.id]);
  await W.encodePass(ctx({ runner: tamper }));
  encB = await jobOf(E.SITE_VOD_ENCODE, B);
  ok(encB.state === 'succeeded' && encB.attempts === 2 && (await asset(B)).media_state === 'ready', 'the retry encodes again and the asset is ready', [encB.state, encB.attempts]);

  console.log('== GPU jobs only to GPU hosts ==');
  const G = await newAsset('Needs NVENC');
  await req(G);
  await W.encodePass(ctx({ maxJobs: 1 }));
  const encG = await jobOf(E.SITE_VOD_ENCODE, G);
  await query(`UPDATE jobs SET payload = jsonb_set(payload, '{encoder,gpu}', 'true') WHERE id = $1`, [encG.id]);
  let calls: any[] = [];
  const spy: typeof realRunner = { describe: 'spy', async run(job) { calls.push(job); return { code: 1, stdout: '', stderr: 'nvenc not here' }; } };
  ok(await W.encodePass(ctx({ runner: spy })) === 0 && (await one<any>(`SELECT state FROM jobs WHERE id = $1`, [encG.id])).state === 'queued', 'a host that reported no NVIDIA GPU is not handed a job planned for NVENC');
  await query(`UPDATE site_hosts SET gpus = '[{"name":"Tesla T4","vendor":"nvidia","memoryBytes":16000000000,"encodeSessions":null}]'::jsonb WHERE id = $1`, [hostId]);
  logs.length = 0;
  await W.encodePass(ctx({ runner: spy, hasGpu: false, maxJobs: 1 }));
  let jg = await one<any>(`SELECT state, error_code FROM jobs WHERE id = $1`, [encG.id]);
  ok(calls.length === 0 && jg.state === 'queued' && jg.error_code === 'no_gpu', 'a GPU job that reaches a host without one is handed back, not encoded on the CPU', [calls.length, jg]);
  await query(`UPDATE jobs SET run_after = now() WHERE id = $1`, [encG.id]);
  await W.encodePass(ctx({ runner: spy, hasGpu: true, maxJobs: 1 }));
  ok(calls.length === 1 && calls[0].gpu === true, 'a host with an NVIDIA GPU takes it, with the GPU setting', calls[0]?.gpu);
  await query(`UPDATE site_hosts SET gpus = '[]'::jsonb WHERE id = $1`, [hostId]);
  await query(`UPDATE jobs SET state = 'cancelled' WHERE id = $1`, [encG.id]);

  console.log('== the source and the encoder ==');
  const M = await newAsset('Missing');
  await req(M, join(work, 'gone.mp4'));
  await W.encodePass(ctx({ maxJobs: 1 }));
  a = await asset(M);
  ok(a.media_state === 'failed' && a.media_error_code === 'source_missing' && /not at the site/.test(a.media_error ?? ''), 'a file that is not at the site fails the asset for good, with the reason', [a.media_state, a.media_error_code]);
  const U = await newAsset('Share not mounted');
  await req(U, '/mnt/not-mounted-share/news/x.mp4');
  await W.encodePass(ctx({ maxJobs: 1 }));
  let ju = await jobOf(E.SITE_VOD_PROBE, U);
  ok(ju.state === 'queued' && ju.error_code === 'source_unavailable' && (await asset(U)).media_state === 'processing', 'a share that is not mounted is a retry, not a failure', [ju.state, ju.error_code]);
  await query(`UPDATE jobs SET state = 'cancelled' WHERE id = $1`, [ju.id]);
  const X = await newAsset('Encoder broken');
  await req(X);
  await W.encodePass(ctx({ maxJobs: 1, runner: { describe: 'broken', async run() { return { code: 127, stdout: '', stderr: 'python3: not found' }; } } }));
  const jx = await jobOf(E.SITE_VOD_PROBE, X);
  ok(jx.state === 'queued' && jx.error_code === 'encoder_failed' && /not found/.test(jx.last_error ?? ''), 'an encoder that gives no answer is a retry, with its error', [jx.state, jx.error_code, jx.last_error]);
  await query(`UPDATE jobs SET state = 'cancelled' WHERE id = $1`, [jx.id]);
  ok(scratchEmpty(), 'no scratch folder is left after failed attempts');

  console.log('== the lease reaped mid-encode ==');
  const R = await newAsset('Worker went quiet');
  await req(R);
  await W.encodePass(ctx({ maxJobs: 1 }));
  const encR = await jobOf(E.SITE_VOD_ENCODE, R);
  let aborted = false; let reaped = 0;
  const quiet: typeof realRunner = {
    describe: 'a worker that goes quiet',
    async run(_job, o) {
      // The host stops reporting long enough for the reaper to take the job back.
      await query(`UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [encR.id]);
      reaped = await Q.reapExpiredLeases();
      await new Promise<void>((res) => { const t = setTimeout(res, 5000); o.signal.addEventListener('abort', () => { aborted = true; clearTimeout(t); res(); }, { once: true }); });
      return { code: null, stdout: '', stderr: 'killed' };
    },
  };
  logs.length = 0;
  await W.encodePass(ctx({ runner: quiet, maxJobs: 1 }));
  let jr = await one<any>(`SELECT * FROM jobs WHERE id = $1`, [encR.id]);
  ok(reaped >= 1 && aborted, 'the worker learns the lease is gone and stops the encoder', { reaped, aborted });
  ok(logs.some((l) => /the lease was lost, stopped/.test(l)) && jr.state === 'queued' && jr.error_code === 'lease_expired', 'it sends nothing more; the job is back in the pool to be retried', [jr.state, jr.error_code, logs]);
  ok((await asset(R)).media_state === 'processing' && scratchEmpty(), 'the asset still reads Processing and the scratch folder is gone');
  await query(`UPDATE jobs SET run_after = now() WHERE id = $1`, [encR.id]);
  await W.encodePass(ctx({ maxJobs: 1 }));
  jr = await one<any>(`SELECT * FROM jobs WHERE id = $1`, [encR.id]);
  ok(jr.state === 'succeeded' && jr.attempts === 2 && (await asset(R)).media_state === 'ready', 'the retry succeeds and the asset is ready', [jr.state, jr.attempts]);

  console.log('== a reaped lease drops a half declaration; on the last attempt the asset says why ==');
  const H = await newAsset('Last attempt');
  await req(H);
  await W.encodePass(ctx({ maxJobs: 1 }));
  const encH = await jobOf(E.SITE_VOD_ENCODE, H);
  let L = (await api('POST', '/api/site-agent/jobs/lease', { types: W.ENCODE_JOB_TYPES }, cred)).body;
  const d = await api('POST', `/api/site-agent/jobs/${L.id}/outputs`, { leaseId: L.leaseId, files: [{ path: 'master.m3u8', bytes: 7, sha256: 'a'.repeat(64) }] }, cred);
  ok(L.id === encH.id && d.status === 200, 'a host leases the encode and declares part of a package');
  await query(`UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [encH.id]);
  await Q.reapExpiredLeases();
  let jh = await one<any>(`SELECT * FROM jobs WHERE id = $1`, [encH.id]);
  ok(jh.state === 'queued' && !jh.payload.declared && !jh.payload.staging && Array.isArray(jh.payload.transfers) && jh.payload.transfers.length === 0, 'the reaper drops the half declaration, so the next attempt starts clean', jh.payload.declared);
  await query(`UPDATE jobs SET run_after = now(), attempts = max_attempts - 1 WHERE id = $1`, [encH.id]);
  L = (await api('POST', '/api/site-agent/jobs/lease', { types: W.ENCODE_JOB_TYPES }, cred)).body;
  ok(L.id === encH.id && L.attempt === L.maxAttempts, 'the last attempt is leased', [L.attempt, L.maxAttempts]);
  await query(`UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [encH.id]);
  await Q.reapExpiredLeases();
  jh = await one<any>(`SELECT * FROM jobs WHERE id = $1`, [encH.id]);
  a = await asset(H);
  ok(jh.state === 'failed' && a.media_state === 'failed' && a.media_error_code === 'lease_expired' && /stopped reporting/.test(a.media_error ?? ''), 'reaped on the last attempt, the job fails and the asset says why', [jh.state, a.media_state, a.media_error]);

  console.log(`\nsite-encode-worker: ${pass}/${pass + fail} passed`);
  srv.close();
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
