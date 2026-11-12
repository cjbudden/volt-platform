// ============================================================================
//  REPACKAGE ON A CONFIRMED DRM CHANGE (build queue P4-3; services/repackage.ts,
//  the `vod.repackage` job in services/jobs/handlers/vodEncode.ts).
//
//    - the impact gives the job time ("about N min of jobs") beside the count;
//    - a confirmed rule, title or bulk change queues one vod.repackage per
//      published title whose files no longer carry what its policy asks, at
//      a lower priority than new uploads, in batches; drafts, titles already
//      matching and a second confirm queue nothing;
//    - the Encode tab says the repackage is queued;
//    - the job packages into a folder beside the title's own and swaps it in
//      whole: DRM on gives cbcs files and takes the clear MP4 away; DRM off
//      gives clear files and the MP4 back; FAST ladders are carried, trick
//      play is not; the title never reads as processing;
//    - a repackage that fails (the key service down) leaves the title's files
//      and state exactly as they were, and no staging folder behind;
//    - a job whose change was undone before it ran does nothing;
//    - an original kept at a site waits with the reason instead of being
//      queued; files in the origin bucket are queued (P4-4, the job itself is
//      in publishing-repackage-bucket.check.ts).
//
//  THE PACKAGER: real with Shaka on PATH or PACKAGER_BIN, otherwise the
//  recording stub of publishing-encode-policy.check.ts (the cloud container).
//  Usage: DATABASE_URL=... npx tsx test/publishing-repackage.check.ts
// ============================================================================
import { mkdtemp, mkdir, writeFile, chmod, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer as httpServer } from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  g === w ? ok(m) : bad(m, `expected ${w} got ${g}`);
};

(async () => {
  const root = await mkdtemp(join(tmpdir(), 'vod-repack-'));
  process.env.IMAGE_STORE_DIR = process.env.IMAGE_STORE_DIR ?? join(root, '_images');
  process.env.FILLER_DIR = process.env.FILLER_DIR ?? join(root, '_filler');
  process.env.CLIPS_DIR = process.env.CLIPS_DIR ?? join(root, '_clips');
  process.env.ORIGIN_DIR = process.env.ORIGIN_DIR ?? join(root, '_origin');
  delete process.env.VOD_STORE;

  // THE PACKAGER: real when there is one, otherwise the recording stub.
  const realPackager = spawnSync(process.env.PACKAGER_BIN || 'packager', ['--version'], { stdio: 'ignore' }).status === 0;
  const argLog = join(root, 'packager-args.json');
  if (!realPackager) {
    const stub = join(root, 'packager-stub.py');
    await writeFile(stub, `#!/usr/bin/env python3
# Stands in for Shaka in a container without it: records its arguments and
# writes what Shaka writes (init and segments per stream, the manifests), with
# the init segment made by ffmpeg so what is read back is real AAC.
import json, os, subprocess, sys
args = sys.argv[1:]
json.dump(args, open(${JSON.stringify(argLog)}, 'w'))
streams = [dict(kv.split('=', 1) for kv in a.split(',')) for a in args if a.startswith('in=')]
for s in streams:
    d = os.path.dirname(s['init_segment']); os.makedirs(d, exist_ok=True)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', s['in'], '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov', s['init_segment']], check=True)
    open(s['segment_template'].replace('$Number$', '1'), 'wb').write(b'seg')
def opt(name):
    return args[args.index(name) + 1] if name in args else None
if opt('--hls_master_playlist_output'):
    open(opt('--hls_master_playlist_output'), 'w').write('#EXTM3U\\n#EXT-X-STREAM-INF:BANDWIDTH=140000,CODECS="mp4a.40.2"\\naudio/stream.m3u8\\n')
if opt('--mpd_output'):
    open(opt('--mpd_output'), 'w').write('<MPD type="static"><Period><AdaptationSet contentType="audio"/></Period></MPD>')
`);
    await chmod(stub, 0o755);
    process.env.PACKAGER_BIN = stub;
  }
  console.log(realPackager ? '(the real packager)' : '(no packager here: a recording stub stands in for it; run on the Mac with PACKAGER_BIN for the real one)');

  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const R = await import('../src/services/repackage');

  console.log('== pure ==');
  check('repackageSeconds: about real time plus 30 s; no length: 30 s', [R.repackageSeconds(2000), R.repackageSeconds(3_600_000), R.repackageSeconds(null)], [32, 3630, 30]);
  check('repackageTimeLabel: minutes, then hours', [R.repackageTimeLabel(32), R.repackageTimeLabel(1500), R.repackageTimeLabel(10_800)], ['about 1 min', 'about 25 min', 'about 3 h']);

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`repack-${tag}`]))!.id;
  const owner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `repack-${tag}@volt.test`]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type, codec_backend, packaging)
      VALUES ($1,'HD','[{"height":720,"bitrate_kbps":3000},{"height":360,"bitrate_kbps":800}]','transcode','x264','both') RETURNING id`, [acct]))!.id;
  const { ensureTrackingGroup } = await import('../src/services/encode/store');
  await ensureTrackingGroup(acct, prof, 'Same as live', { makeDefault: true });
  const schema = async (name: string) => (await one<any>(`INSERT INTO metadata_schemas(account_id,name,target_kind,fields) VALUES ($1,$2,'vod','[]'::jsonb) RETURNING id`, [acct, name]))!.id as string;
  const film = await schema('Film'), series = await schema('Series'), doc = await schema('Documentary');
  const LIVE = `availability_state = 'available', published = true, available_from = now() - interval '1 day'`;

  // THE KEY SERVICE: a SPEKE v2 stand-in answering a CPIX key with an IV, a
  // Widevine PSSH and FairPlay's HLS signalling (the shape Axinom returns).
  const seen: { id: string | null; auth: string | null; version: string | null }[] = [];
  let spekeDown = false;
  const KEY_B64 = Buffer.from([...Array(16).keys()]).toString('base64');
  const IV_B64 = Buffer.alloc(16, 0xa5).toString('base64');
  const SKD = 'skd://keys.example.test/fairplay/vod';
  const speke = httpServer((rq, rs) => {
    let body = '';
    rq.on('data', (d) => { body += d; });
    rq.on('end', () => {
      seen.push({ id: /<cpix:CPIX[^>]*\bid="([^"]+)"/.exec(body)?.[1] ?? null, auth: String(rq.headers.authorization ?? '') || null, version: String(rq.headers['x-speke-version'] ?? '') || null });
      if (spekeDown) { rs.writeHead(500); rs.end('down'); return; }
      const kid = /ContentKey[^>]*\bkid="([^"]+)"/.exec(body)?.[1] ?? '00000000-0000-0000-0000-000000000000';
      const b64 = (x: string) => Buffer.from(x).toString('base64');
      const media = `#EXT-X-KEY:METHOD=SAMPLE-AES,URI="${SKD}",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"`;
      const pssh = Buffer.concat([Buffer.from([0, 0, 0, 40]), Buffer.from('pssh'), Buffer.alloc(4), Buffer.from('edef8ba979d64acea3c827dcd51d21ed', 'hex'), Buffer.from([0, 0, 0, 8]), Buffer.from('volttest')]).toString('base64');
      rs.writeHead(200, { 'content-type': 'application/xml' });
      rs.end(`<?xml version="1.0" encoding="UTF-8"?>
<cpix:CPIX xmlns:cpix="urn:dashif:org:cpix" xmlns:pskc="urn:ietf:params:xml:ns:keyprov:pskc" id="x">
 <cpix:ContentKeyList><cpix:ContentKey kid="${kid}" explicitIV="${IV_B64}" commonEncryptionScheme="cbcs"><cpix:Data><pskc:Secret><pskc:PlainValue>${KEY_B64}</pskc:PlainValue></pskc:Secret></cpix:Data></cpix:ContentKey></cpix:ContentKeyList>
 <cpix:DRMSystemList>
  <cpix:DRMSystem kid="${kid}" systemId="edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"><cpix:PSSH>${pssh}</cpix:PSSH></cpix:DRMSystem>
  <cpix:DRMSystem kid="${kid}" systemId="94ce86fb-07ff-4f43-adb8-93d2fa968ca2"><cpix:HLSSignalingData playlist="media">${b64(media)}</cpix:HLSSignalingData><cpix:HLSSignalingData playlist="master">${b64(media.replace('#EXT-X-KEY', '#EXT-X-SESSION-KEY'))}</cpix:HLSSignalingData></cpix:DRMSystem>
 </cpix:DRMSystemList>
</cpix:CPIX>`);
    });
  }).listen(0, '127.0.0.1');
  await new Promise((res) => speke.once('listening', res));
  const spekeUrl = `http://127.0.0.1:${(speke.address() as any).port}/speke/v2.0/copyProtection`;
  process.env.VOLT_TEST_VOD_DRM_SECRET = 'mgmt-secret';
  await one(`INSERT INTO drm_configs(account_id, tenant_id, key_service_url, license_service_url, management_key_ref)
             VALUES ($1, 'tenant-vod', $2, 'https://licence.test', 'env:VOLT_TEST_VOD_DRM_SECRET')`, [acct, spekeUrl]);

  const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'ignore' });
  const work = join(root, 'work'); await mkdir(work, { recursive: true });
  const mp4 = join(work, 'Feature.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=f=330:d=2:sample_rate=48000',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-c:a', 'aac', '-shortest', mp4]);
  const outOf = (id: string) => join(process.env.CLIPS_DIR!, 'vod', id);
  const lastArgs = async (): Promise<string[]> => realPackager ? [] : JSON.parse(await readFile(argLog, 'utf8'));
  const leftovers = async (id: string) => (await readdir(join(process.env.CLIPS_DIR!, 'vod'))).filter((n) => n.startsWith(id + '.'));

  const srv = createServer().listen(0);
  await new Promise((res) => srv.once('listening', res));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = signAccess({ sub: owner, account_id: acct, role: 'owner' } as any);
  const call = async (method: string, path: string, body?: any) => {
    const x = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { s: x.status, j: await x.json().catch(() => null) as any };
  };
  const { handleVodEncode } = await import('../src/services/jobs/handlers/vodEncode');
  let lastCode: string | null = null;
  const ctxRun = async (payload: any, jobId: string | null = null) => {
    let err: any = null, out: any = null;
    try { out = await handleVodEncode({ job: { id: jobId, attempts: 1, payload }, progress: async () => {}, isCancelled: () => false } as any); }
    catch (e) { err = e; }
    lastCode = err?.code ?? null;
    return { err: err ? String(err?.message ?? err) : null, out };
  };
  const newAsset = async (title: string, schemaId: string | null) => (await one<any>(
    `INSERT INTO vod_assets(account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, metadata, schema_id, source_key)
     VALUES ($1,'upload','export',$2,0,0,0,'{}'::jsonb,$3,$4) RETURNING id`, [acct, title, schemaId, mp4]))!.id as string;
  const encodeNew = async (title: string, schemaId: string | null) => {
    const id = await newAsset(title, schemaId);
    const job = await one<any>(`INSERT INTO jobs(type, payload, state) VALUES ('vod.encode', $1::jsonb, 'succeeded') RETURNING id`, [JSON.stringify({ vodAssetId: id })]);
    await query(`UPDATE vod_assets SET encode_job_id = $2 WHERE id = $1`, [id, job!.id]);
    const r = await ctxRun({ vodAssetId: id, accountId: acct, sourcePath: mp4 }, job!.id);
    if (r.err) throw new Error(`encode of ${title} failed: ${r.err}`);
    return id;
  };
  const jobsFor = (id: string) => query<any>(`SELECT id, type, state, priority, run_after, payload FROM jobs WHERE type = 'vod.repackage' AND payload->>'vodAssetId' = $1 ORDER BY created_at`, [id]);
  const runQueued = async (id: string) => {
    const j = (await jobsFor(id)).find((x) => x.state === 'queued');
    if (!j) return { err: 'no queued job', out: null };
    await query(`UPDATE jobs SET state = 'running', started_at = now() WHERE id = $1`, [j.id]);
    const r = await ctxRun(j.payload, j.id);
    await query(`UPDATE jobs SET state = $2, finished_at = now() WHERE id = $1`, [j.id, r.err ? 'failed' : 'succeeded']);
    return r;
  };
  const row = (id: string) => one<any>(`SELECT encode_result->>'drm' AS drm, policy_snapshot->'packaged' AS packaged, progressive_key, media_state, encode_job_id, master_key,
      (SELECT state FROM jobs WHERE id = v.encode_job_id) AS encode_state FROM vod_assets v WHERE id = $1`, [id]);

  try {
    console.log('\n== published titles, packaged in the clear ==');
    const A = await encodeNew('Feature A', film);
    const B = await encodeNew('Feature B', series);
    const D = await encodeNew('Draft film', film);
    await query(`UPDATE vod_assets SET ${LIVE} WHERE id = ANY($1::uuid[])`, [[A, B]]);
    const ra0 = await row(A);
    check('Feature A: clear, with its MP4, ready', [ra0.drm, !!ra0.progressive_key, existsSync(join(outOf(A), 'file.mp4')), ra0.media_state], ['clear', true, true, 'ready']);
    // What lives beside the packaging: a FAST ladder variant (carried) and a trick set made from the clear files (not carried).
    await mkdir(join(outOf(A), 'ladders', 'g1'), { recursive: true });
    await writeFile(join(outOf(A), 'ladders', 'g1', 'master.m3u8'), '#EXTM3U\n');
    await writeFile(join(outOf(A), 'trick.json'), '{}');

    console.log('\n== the change, before and at the confirm ==');
    const rule = { settings: { protection: { drm: true }, distribution: { mp4Download: false } }, lockedFields: [], presetKey: null, name: 'Protected films' };
    const dry = await call('PUT', `/api/publishing-rules/schema/${film}?dryRun=1`, rule);
    check('Before you save: 1 published title to repackage (the draft is not counted), about 32 s of jobs',
      [dry.s, dry.j?.impact?.repackage, dry.j?.impact?.repackageSeconds], [200, 1, 32]);
    const no = await call('PUT', `/api/publishing-rules/schema/${film}`, rule);
    check('without confirm: 409 confirm_repackage, nothing queued', [no.s, no.j?.code, no.j?.details?.impact?.repackageSeconds, (await jobsFor(A)).length], [409, 'confirm_repackage', 32, 0]);
    const yes = await call('PUT', `/api/publishing-rules/schema/${film}`, { ...rule, confirm: true });
    check('confirmed: saved, and one repackage queued with its job time', [yes.s, yes.j?.repackage?.queued, yes.j?.repackage?.seconds, yes.j?.repackage?.waiting], [200, 1, 32, []]);
    const ja = await jobsFor(A);
    check('...a vod.repackage for Feature A, behind new uploads (priority 150), with the original to package from',
      [ja.length, ja[0]?.type, ja[0]?.state, ja[0]?.priority, ja[0]?.payload?.sourcePath, ja[0]?.payload?.repackage], [1, 'vod.repackage', 'queued', 150, mp4, true]);
    check('...none for the draft or for the Series title', [(await jobsFor(D)).length, (await jobsFor(B)).length], [0, 0]);
    const again = await call('PUT', `/api/publishing-rules/schema/${film}`, { ...rule, confirm: true });
    check('saving the same rule again queues nothing more', [again.s, again.j?.repackage ?? null, (await jobsFor(A)).length], [200, null, 1]);
    const tab = await call('GET', `/api/vod/${A}/encode`);
    check('the Encode tab: pending, the repackage queued, and the words say it switches when ready',
      [tab.j?.policy?.pending, tab.j?.policy?.repackage?.state, /A repackage is queued: it switches to the new files once they are complete/.test(tab.j?.policy?.note ?? ''), /encode it again/.test(tab.j?.policy?.note ?? '')], [['drm'], 'queued', true, false]);
    const ra1 = await row(A);
    check('until it runs, the title plays from its clear files: still ready, its encode untouched', [ra1.drm, ra1.media_state, ra1.encode_state, existsSync(join(outOf(A), 'file.mp4'))], ['clear', 'ready', 'succeeded', true]);

    console.log('\n== the repackage runs: DRM on ==');
    const n0 = seen.length;
    const r1 = await runQueued(A);
    check('the job succeeds and says it repackaged with cbcs', [r1.err, r1.out?.repackaged, r1.out?.drm], [null, true, 'cbcs']);
    if (!realPackager) {
      const inits = (await lastArgs()).filter((a) => a.startsWith('in=')).map((a) => /init_segment=([^,]+)/.exec(a)?.[1] ?? '');
      check('the packager wrote into a folder beside the title\'s own, not into it', [inits.length > 0, inits.every((p) => p.includes(`${A}.repack-`))], [true, true]);
      check('...and was asked to encrypt', (await lastArgs()).includes('--enable_raw_key_encryption'), true);
    }
    check('one key asked for, naming the title', [seen.length - n0, seen[seen.length - 1]?.id], [1, A]);
    const ra2 = await row(A);
    check('the title now: cbcs, the snapshot says encrypted, no MP4, still ready, its own encode job untouched',
      [ra2.drm, ra2.packaged, ra2.progressive_key, existsSync(join(outOf(A), 'file.mp4')), ra2.media_state, ra2.encode_state, ra2.encode_job_id === ra0.encode_job_id],
      ['cbcs', { drm: true }, null, false, 'ready', 'succeeded', true]);
    check('the FAST ladder variant was carried across; the trick set made from the clear files was not', [existsSync(join(outOf(A), 'ladders', 'g1', 'master.m3u8')), existsSync(join(outOf(A), 'trick.json'))], [true, false]);
    check('no staging or replaced folder is left behind', await leftovers(A), []);
    const tab2 = await call('GET', `/api/vod/${A}/encode`);
    check('the Encode tab: nothing pending, no repackage', [tab2.j?.policy?.pending, tab2.j?.policy?.repackage ?? null], [[], null]);
    check('the frame index and QC of the new files are queued', (await query<any>(`SELECT type FROM jobs WHERE type IN ('qc.run','frame.index','vod.frames') AND payload->>'vodAssetId' = $1 AND state = 'queued'`, [A])).length >= 1, true);

    console.log('\n== DRM off: encrypted until the clear files are ready ==');
    const offRule = { settings: { protection: { drm: false } }, lockedFields: [], presetKey: null, name: 'Protected films' };
    const off = await call('PUT', `/api/publishing-rules/schema/${film}`, { ...offRule, confirm: true });
    check('turning DRM off queues its repackage', [off.s, off.j?.repackage?.queued], [200, 1]);
    check('...and until it runs the title stays encrypted', (await row(A)).drm, 'cbcs');
    const r2 = await runQueued(A);
    const ra3 = await row(A);
    check('after it: clear files and the MP4 back', [r2.err, ra3.drm, ra3.packaged, !!ra3.progressive_key, existsSync(join(outOf(A), 'file.mp4'))], [null, 'clear', { drm: false }, true, true]);
    if (!realPackager) check('...and Shaka was not asked to encrypt', (await lastArgs()).includes('--enable_raw_key_encryption'), false);

    console.log('\n== a repackage that fails leaves the title as it was ==');
    await call('PUT', `/api/publishing-rules/schema/${film}`, { ...rule, confirm: true });
    spekeDown = true;
    const r3 = await runQueued(A);
    spekeDown = false;
    const ra4 = await row(A);
    check('the job fails on the key request', [!!r3.err, /request failed/i.test(r3.err ?? '')], [true, true]);
    check('...the title keeps its clear files and MP4, ready, its encode untouched', [ra4.drm, existsSync(join(outOf(A), 'file.mp4')), existsSync(join(outOf(A), 'master.m3u8')), ra4.media_state, ra4.encode_state], ['clear', true, true, 'ready', 'succeeded']);
    check('...and no staging folder is left behind', await leftovers(A), []);

    console.log('\n== a change undone before its job runs ==');
    await query(`UPDATE jobs SET state = 'failed' WHERE type = 'vod.repackage' AND state IN ('queued','running')`);
    const off2 = await call('PUT', `/api/publishing-rules/schema/${film}`, { ...offRule, confirm: true });
    check('DRM off while the files are clear: confirmed, nothing to queue', [off2.s, off2.j?.repackage?.queued], [200, 0]);
    const on2 = await call('PUT', `/api/publishing-rules/schema/${film}`, { ...rule, confirm: true });
    check('DRM on again: queued', on2.j?.repackage?.queued, 1);
    const undo = await call('PUT', `/api/publishing-rules/schema/${film}`, { ...offRule, confirm: true });
    check('turned off again before it ran: confirmed, but nothing new queued (the files are clear already)', [undo.s, undo.j?.repackage?.queued], [200, 0]);
    const n1 = seen.length;
    const r4 = await runQueued(A);
    check('the queued job does nothing: no key asked for, files as they were', [r4.err, r4.out?.repackaged, /already carry/.test(r4.out?.reason ?? ''), seen.length - n1, (await row(A)).drm], [null, false, true, 0, 'clear']);

    console.log('\n== the title\'s own setting and bulk ==');
    const own = await call('PATCH', `/api/vod/${B}/availability`, { override: { protection: { drm: true }, distribution: { mp4Download: false } }, confirm: true });
    check('a published title turns DRM on for itself (confirmed): its repackage is queued', [own.s, own.j?.repackage?.queued, (await jobsFor(B)).length], [200, 1, 1]);
    const blk = await call('POST', `/api/vod/bulk/availability`, { ids: [A, B], action: 'apply', override: { protection: { drm: true }, distribution: { mp4Download: false } }, confirm: true });
    check('bulk DRM on for both (confirmed): A queued, B already queued (one job each)', [blk.s, blk.j?.repackage?.queued, (await jobsFor(A)).filter((j: any) => j.state === 'queued').length, (await jobsFor(B)).filter((j: any) => j.state === 'queued').length], [200, 2, 1, 1]);
    await query(`UPDATE jobs SET state = 'cancelled' WHERE type = 'vod.repackage' AND state = 'queued'`);
    await query(`UPDATE vod_assets SET availability_override = '{}'::jsonb WHERE id = ANY($1::uuid[])`, [[A, B]]);

    console.log('\n== in batches ==');
    const many: string[] = [];
    for (let i = 0; i < 27; i++) many.push(await newAsset(`Doc ${i}`, doc));
    await query(`UPDATE vod_assets SET ${LIVE}, master_key = '/clips/vod/' || id || '/master.m3u8', duration_ms = 60000, encode_result = '{"drm":"clear"}'::jsonb WHERE id = ANY($1::uuid[])`, [many]);
    const t0 = Date.now();
    const bd = await call('PUT', `/api/publishing-rules/schema/${doc}`, { ...rule, name: 'Protected docs', confirm: true });
    const bj = await query<any>(`SELECT run_after FROM jobs WHERE type = 'vod.repackage' AND payload->>'vodAssetId' = ANY($1::text[]) ORDER BY run_after`, [many]);
    const later = bj.filter((j) => new Date(j.run_after).getTime() - t0 > 9 * 60_000).length;
    check('27 titles: 27 queued, about 41 min of jobs (90 s each)', [bd.s, bd.j?.repackage?.queued, bd.j?.repackage?.seconds, R.repackageTimeLabel(bd.j?.repackage?.seconds)], [200, 27, 2430, 'about 41 min']);
    check('...the first 25 now, the last 2 a batch later (10 minutes on)', [bj.length, later], [27, 2]);
    await query(`UPDATE jobs SET state = 'cancelled' WHERE type = 'vod.repackage' AND state = 'queued'`);

    console.log('\n== what waits instead of being queued ==');
    const S = await newAsset('Kept at a site', film);
    await query(`UPDATE vod_assets SET ${LIVE}, source_key = NULL, master_key = '/clips/vod/' || id || '/master.m3u8', encode_result = '{"drm":"clear"}'::jsonb,
                 ingest = '{"siteSource":{"siteId":"00000000-0000-0000-0000-0000000000aa","sitePath":"/x.mp4"}}'::jsonb WHERE id = $1`, [S]);
    const ws = await call('PUT', `/api/publishing-rules/schema/${film}`, { ...rule, confirm: true });
    const wS = (ws.j?.repackage?.waiting ?? []).find((w: any) => w.id === S);
    check('an original kept at a site: waits with the reason, no job', [ws.s, /kept at a site/.test(wS?.reason ?? ''), (await jobsFor(S)).length], [200, true, 0]);
    await query(`UPDATE jobs SET state = 'cancelled' WHERE type = 'vod.repackage' AND state = 'queued'`);
    await call('PUT', `/api/publishing-rules/schema/${film}`, { ...offRule, confirm: true });
    process.env.VOD_STORE = 's3';
    const wb = await call('PUT', `/api/publishing-rules/schema/${film}`, { ...rule, confirm: true });
    const wA = (wb.j?.repackage?.waiting ?? []).find((w: any) => w.id === A);
    // P4-4: the bucket store no longer waits; the job itself is checked against a real S3 API in publishing-repackage-bucket.
    check('files in the origin bucket: queued like any other (P4-4), none waiting for that reason', [wb.s, wb.j?.repackage?.queued, wA ?? null, (await jobsFor(A)).filter((j: any) => j.state === 'queued').length], [200, 1, null, 1]);
    await query(`UPDATE jobs SET state = 'cancelled' WHERE type = 'vod.repackage' AND state = 'queued'`);
    delete process.env.VOD_STORE;
  } finally {
    srv.close();
    speke.close();
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(1); });
