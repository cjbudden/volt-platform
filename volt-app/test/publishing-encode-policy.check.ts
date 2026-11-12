// ============================================================================
//  ENCODE-TIME POLICY FIELDS (build queue P4, PUBLISHING_POLICIES.md
//  "Encode-time vs delivery-time fields" and "Upload and ingest";
//  services/encodePolicy.ts, the snapshot written by
//  services/jobs/handlers/vodEncode.ts, GET /api/vod/{id}/encode `policy`).
//
//    - before an upload: GET /api/publishing-rules/resolve?schemaId= says the
//      DRM a title of that type will get and which rule says so (what the
//      upload panel shows);
//    - a real encode keeps the policy as it stood on the title
//      (`vod_assets.policy_snapshot`): what it asked, from which rung and
//      rule, and what the files were packaged with;
//    - DRM PACKAGING (build queue P4-2): an encode whose policy asks for DRM
//      is packaged with a key from the account's SPEKE key service (a local
//      stand-in here, as in volt-encoder/dev/test_fairplay_drm.py): the key
//      request names the title, carries the credential from the config's
//      reference, Shaka gets the cbcs flags, no MP4 is made, the job file
//      with the key service in it does not stay in the served folder; with
//      no key service the encode is refused with the reason; a key service
//      that fails fails the encode; a FAST channel never reuses the
//      encrypted encode;
//    - the Encode tab's `policy` compares the policy now with the files:
//      Repackage pending when they disagree, with the words; a rule changed
//      later moves `now`, never the snapshot; the title's own setting is named.
//
//  THE PACKAGER: real with Shaka on PATH or PACKAGER_BIN, otherwise the same
//  recording stub as vod-audio-asset.check.ts (the cloud container).
//  Usage: DATABASE_URL=... npx tsx test/publishing-encode-policy.check.ts
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
  const root = await mkdtemp(join(tmpdir(), 'vod-encpol-'));
  process.env.IMAGE_STORE_DIR = process.env.IMAGE_STORE_DIR ?? join(root, '_images');
  process.env.FILLER_DIR = process.env.FILLER_DIR ?? join(root, '_filler');
  process.env.CLIPS_DIR = process.env.CLIPS_DIR ?? join(root, '_clips');
  process.env.ORIGIN_DIR = process.env.ORIGIN_DIR ?? join(root, '_origin');

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
  const { pool, one } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const E = await import('../src/services/encodePolicy');
  const { resolveLadder } = await import('../src/services/publishingRules');

  // ---------------------------------------------------------------- pure
  console.log('== pure ==');
  const r = resolveLadder([
    { rung: 'account', settings: {}, name: 'Account' },
    { rung: 'schema', id: 'x', settings: { protection: { drm: true } } as any, name: 'Protected films' },
  ]);
  const snap = E.encodeSnapshot(r, { drm: false }, new Date('2026-11-12T08:00:00Z'));
  check('encodeSnapshot: what the policy asked, from where, and what the files carry',
    snap, { at: '2026-11-12T08:00:00.000Z', wanted: { drm: true }, sources: { drm: 'schema' }, rule: 'Protected films', packaged: { drm: false } });
  check('pendingFields: DRM asked, clear files: pending; agreeing: none',
    [E.pendingFields({ drm: true }, { drm: false }), E.pendingFields({ drm: false }, { drm: true }), E.pendingFields({ drm: true }, { drm: true })], [['drm'], ['drm'], []]);
  check('packagedOf: the snapshot first, then the encode record, else clear and unrecorded',
    [E.packagedOf({ policy_snapshot: { packaged: { drm: true } }, encode_result: { drm: 'clear' } }), E.packagedOf({ encode_result: { drm: 'clear' } }),
     E.packagedOf({ encode_result: { drm: 'cbcs' } }), E.packagedOf({})],
    [{ drm: true, recorded: true }, { drm: false, recorded: true }, { drm: true, recorded: true }, { drm: false, recorded: false }]);
  const v1 = E.encodePolicyView(r, { encode_result: { drm: 'clear' } });
  check('the view: DRM asked by the content type rule, files clear: pending, with the rule named',
    [v1.now, v1.pending, /content type rule "Protected films"/.test(v1.note ?? ''), /repackage pending/.test(v1.note ?? ''), /plays in the clear/.test(v1.note ?? '')],
    [{ drm: true, source: 'schema', sourceLabel: 'content type rule', rule: 'Protected films' }, ['drm'], true, true, true]);
  const v2 = E.encodePolicyView(resolveLadder([]), { policy_snapshot: { packaged: { drm: true } } });
  check('the view: DRM no longer asked, files encrypted: pending, and it keeps its DRM (never weaker)',
    [v2.pending, /keeps its DRM/.test(v2.note ?? ''), /never a weaker/.test(v2.note ?? '')], [['drm'], true, true]);
  const cfg = { id: 'c', scheme: 'cbcs', systems: ['widevine', 'fairplay'], tenant_id: 't-1', key_service_url: 'https://keys.test/speke', management_key_ref: 'env:K' };
  check('encoderDrm: the live encoder\'s drm block, the title as the content id, the credential by reference only',
    E.encoderDrm(cfg, 'asset-1'), { mode: 'cbcs', speke_url: 'https://keys.test/speke', content_id: 'asset-1', auth_ref: 'env:K', tenant_id: 't-1', systems: ['widevine', 'fairplay'] });
  check('encoderDrm: no systems listed: all three', (E.encoderDrm({ ...cfg, systems: [] }, 'a') as any).systems, ['widevine', 'playready', 'fairplay']);
  check('the refusal names where the DRM ask comes from and what to do',
    [/content type rule "X"/.test(E.noDrmConfigMessage('the content type rule "X"')), /no DRM key service/.test(E.noDrmConfigMessage('x')), /not packaged in the clear/.test(E.noDrmConfigMessage('x'))], [true, true, true]);
  check('the view: DRM asked, clear files: the words say to encode it again (no "not available yet")',
    [/encode it again to package it with DRM/.test(v1.note ?? ''), /not available yet/.test(v1.note ?? '')], [true, false]);
  const { mainMatches } = await import('../src/services/fast/ladder');
  const fl: any = { groupId: 'g', groupName: 'G', rungs: [{ height: 720, bitrate_kbps: 3000 }], segmentSeconds: 2, fps: 25, packaging: 'both', codecBackend: 'x264', frameMode: 'box' };
  const er = { zeroStart: true, segmentSeconds: 2, fps: 25, kept: [{ height: 720, bitrate_kbps: 3000 }], frame: 'box' };
  check('FAST: a clear encode that fits the ladder airs as it is; the same encode with DRM never does',
    [mainMatches({ master_key: '/m', encode_result: { ...er, drm: 'clear' } }, fl, { segmentSeconds: 2, loudnorm: false }),
     mainMatches({ master_key: '/m', encode_result: er }, fl, { segmentSeconds: 2, loudnorm: false }),
     mainMatches({ master_key: '/m', encode_result: { ...er, drm: 'cbcs' } }, fl, { segmentSeconds: 2, loudnorm: false })], [true, true, false]);
  check('the view: policy and files agree: nothing pending, no words', [E.encodePolicyView(resolveLadder([]), {}).pending, E.encodePolicyView(resolveLadder([]), {}).note], [[], null]);

  // ---------------------------------------------------------------- the database
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`encpol-${tag}`]))!.id;
  const owner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `encpol-${tag}@volt.test`]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type, codec_backend, packaging)
      VALUES ($1,'HD','[{"height":720,"bitrate_kbps":3000},{"height":360,"bitrate_kbps":800}]','transcode','x264','both') RETURNING id`, [acct]))!.id;
  const { ensureTrackingGroup } = await import('../src/services/encode/store');
  await ensureTrackingGroup(acct, prof, 'Same as live', { makeDefault: true });
  const film = (await one<any>(`INSERT INTO metadata_schemas(account_id,name,target_kind,fields) VALUES ($1,'Film','vod','[]'::jsonb) RETURNING id`, [acct]))!.id as string;
  const newAsset = async (title: string, schemaId: string | null) => (await one<any>(
    `INSERT INTO vod_assets(account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, metadata, schema_id)
     VALUES ($1,'upload','export',$2,0,0,0,'{}'::jsonb,$3) RETURNING id`, [acct, title, schemaId]))!.id as string;

  const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'ignore' });
  const work = join(root, 'work'); await mkdir(work, { recursive: true });
  const mp3 = join(work, 'Theme.mp3');
  ff(['-f', 'lavfi', '-i', 'sine=f=440:d=2:sample_rate=44100', '-c:a', 'libmp3lame', '-b:a', '96k', mp3]);

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
  const mp4 = join(work, 'Feature.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=f=330:d=2:sample_rate=48000',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-c:a', 'aac', '-shortest', mp4]);
  const outOf = (id: string) => join(process.env.CLIPS_DIR!, 'vod', id);
  const lastArgs = async (): Promise<string[]> => realPackager ? [] : JSON.parse(await readFile(argLog, 'utf8'));
  const playlistsSay = async (dir: string, re: RegExp): Promise<boolean> => {
    const walk = async (d: string): Promise<string[]> =>
      ([] as string[]).concat(...await Promise.all((await readdir(d, { withFileTypes: true })).map(async (e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])));
    for (const f of (await walk(dir)).filter((f) => f.endsWith('.m3u8'))) if (re.test(await readFile(f, 'utf8'))) return true;
    return false;
  };

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
  const encode = async (id: string, sourcePath = mp3) => {
    let err: any = null;
    try { await handleVodEncode({ job: { id: null, attempts: 1, payload: { vodAssetId: id, accountId: acct, sourcePath } } as any, progress: async () => {}, isCancelled: () => false } as any); }
    catch (e) { err = e; }
    lastCode = err?.code ?? null;
    return err ? String(err?.message ?? err) : null;
  };

  try {
    console.log('\n== before the upload: the policy a title of this type gets ==');
    const put = await call('PUT', `/api/publishing-rules/schema/${film}`, { settings: { protection: { drm: true }, distribution: { mp4Download: false } }, lockedFields: [], presetKey: null, name: 'Protected films' });
    check('a content type rule turns DRM on (saved)', [put.s, put.j?.settings?.protection?.drm], [200, true]);
    const pre = await call('GET', `/api/publishing-rules/resolve?schemaId=${film}`);
    check('upload preview for Film: DRM on, from the content type rule, named',
      [pre.s, pre.j?.settings?.protection?.drm, pre.j?.fieldSources?.['protection.drm'], pre.j?.rungs?.find((x: any) => x.rung === 'schema')?.name], [200, true, 'schema', 'Protected films']);
    const pre0 = await call('GET', `/api/publishing-rules/resolve`);
    check('upload preview with no type (the ingest rules decide): the account default, DRM off',
      [pre0.s, pre0.j?.settings?.protection?.drm, pre0.j?.fieldSources?.['protection.drm'] ?? 'baseline'], [200, false, 'baseline']);

    check('upload preview: the account has no DRM key service yet (drmReady false)', pre.j?.drmReady, false);

    console.log('\n== no DRM key service: the encode is refused, never packaged in the clear ==');
    const A0 = await newAsset('Protected, no key service', film);
    const e0 = await encode(A0);
    check('the encode of a Film is refused with the reason and where the DRM ask comes from',
      [lastCode, /no DRM key service/.test(e0 ?? ''), /content type rule "Protected films"/.test(e0 ?? ''), /not packaged in the clear/.test(e0 ?? '')],
      ['drm_not_configured', true, true, true]);
    const r0 = await one<any>(`SELECT master_key, encode_result, policy_snapshot FROM vod_assets WHERE id = $1`, [A0]);
    check('...nothing was packaged or recorded, and no key was asked for', [r0.master_key, r0.encode_result, r0.policy_snapshot, seen.length], [null, null, null, 0]);

    console.log('\n== the account gets a DRM key service ==');
    await one(`INSERT INTO drm_configs(account_id, tenant_id, key_service_url, license_service_url, management_key_ref)
               VALUES ($1, 'tenant-vod', $2, 'https://licence.test', 'env:VOLT_TEST_VOD_DRM_SECRET')`, [acct, spekeUrl]);
    const pre2 = await call('GET', `/api/publishing-rules/resolve?schemaId=${film}`);
    check('upload preview: DRM on and the key service is there (drmReady true)', [pre2.j?.settings?.protection?.drm, pre2.j?.drmReady], [true, true]);

    console.log('\n== the encode packages with DRM ==');
    const A = await newAsset('Protected title', film);
    check('the encode of a Film succeeds', await encode(A), null);
    const ra = await one<any>(`SELECT policy_snapshot, encode_result, media_state, progressive_key FROM vod_assets WHERE id = $1`, [A]);
    check('its record: cbcs for the three systems the key service serves; the snapshot says DRM asked and DRM packaged',
      [ra.media_state, ra.encode_result?.drm, ra.encode_result?.drmSystems, ra.policy_snapshot?.wanted, ra.policy_snapshot?.sources, ra.policy_snapshot?.rule, ra.policy_snapshot?.packaged],
      ['ready', 'cbcs', ['widevine', 'playready', 'fairplay'], { drm: true }, { drm: 'schema' }, 'Protected films', { drm: true }]);
    check('the snapshot carries when it was resolved', Math.abs(Date.parse(ra.policy_snapshot?.at) - Date.now()) < 120_000, true);
    check('one key request, naming the title, SPEKE v2, with the Basic credential built from the tenant and the referenced secret',
      [seen.length, seen[0]?.id, seen[0]?.version, seen[0]?.auth], [1, A, '2.0', 'Basic ' + Buffer.from('tenant-vod:mgmt-secret').toString('base64')]);
    if (!realPackager) {
      const args = await lastArgs();
      const at = (f: string) => args.indexOf(f) >= 0 ? args[args.indexOf(f) + 1] : null;
      const keys = args.filter((_, i) => args[i - 1] === '--keys');
      check('Shaka is asked to encrypt: raw key, cbcs, no clear lead, the key id and key, the IV, the PSSH and the FairPlay key URI',
        [args.includes('--enable_raw_key_encryption'), at('--protection_scheme'), at('--clear_lead'), keys.length, /key_id=[0-9a-f]{32}/.test(keys[0] ?? ''), /:key=000102030405060708090a0b0c0d0e0f$/.test(keys[0] ?? ''),
         at('--iv'), /^000000287073736/.test(at('--pssh') ?? ''), at('--hls_key_uri'), at('--protection_systems')],
        [true, 'cbcs', '0', 1, true, true, 'a5'.repeat(16), true, SKD, 'Widevine,PlayReady,FairPlay']);
    } else {
      check('the real Shaka wrote FairPlay key tags into the playlists', await playlistsSay(outOf(A), /#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd:\/\/keys\.example\.test/), true);
    }
    check('the job file naming the key service is not left in the served folder', existsSync(join(outOf(A), 'encode-job.json')), false);

    const V = await newAsset('Protected feature', film);
    check('a Film with picture encodes with DRM', await encode(V, mp4), null);
    const rv = await one<any>(`SELECT encode_result->>'drm' AS drm, progressive_key, formats FROM vod_assets WHERE id = $1`, [V]);
    check('...and gets no MP4 (an MP4 would be the title in the clear)', [rv.drm, rv.progressive_key, rv.formats?.progressive], ['cbcs', null, false]);
    const W = await newAsset('Plain feature', null);
    check('the same file untyped encodes in the clear', await encode(W, mp4), null);
    const rw = await one<any>(`SELECT encode_result->>'drm' AS drm, progressive_key FROM vod_assets WHERE id = $1`, [W]);
    check('...with its MP4, as before', [rw.drm, !!rw.progressive_key], ['clear', true]);
    check('...and the job file stays as before (it names no key service)', existsSync(join(outOf(W), 'encode-job.json')), true);

    const B = await newAsset('Plain title', null);
    const n0 = seen.length;
    check('the encode of an untyped title succeeds', await encode(B), null);
    const rb = await one<any>(`SELECT policy_snapshot, encode_result->>'drm' AS drm FROM vod_assets WHERE id = $1`, [B]);
    check('its snapshot: no DRM asked (platform default), clear, and no key asked for', [rb.policy_snapshot?.wanted, rb.policy_snapshot?.sources, rb.policy_snapshot?.rule, rb.policy_snapshot?.packaged, rb.drm, seen.length - n0],
      [{ drm: false }, { drm: 'baseline' }, null, { drm: false }, 'clear', 0]);
    if (!realPackager) check('...and Shaka was not asked to encrypt', (await lastArgs()).includes('--enable_raw_key_encryption'), false);

    console.log('\n== the key service fails ==');
    spekeDown = true;
    const A2 = await newAsset('Protected, key service down', film);
    const e2 = await encode(A2);
    const r2 = await one<any>(`SELECT master_key, encode_result FROM vod_assets WHERE id = $1`, [A2]);
    check('the encode fails (to be tried again), saying the key request failed, and nothing is packaged',
      [!!e2, lastCode === 'drm_not_configured', /SPEKE key request failed|request failed/i.test(e2 ?? ''), r2.master_key, r2.encode_result], [true, false, true, null, null]);
    spekeDown = false;

    console.log('\n== the Encode tab ==');
    const ea = await call('GET', `/api/vod/${A}/encode`);
    check('the protected title: policy asks DRM, files carry it, nothing pending, no words',
      [ea.s, ea.j?.policy?.now?.drm, ea.j?.policy?.now?.rule, ea.j?.policy?.packaged, ea.j?.policy?.pending, ea.j?.policy?.note],
      [200, true, 'Protected films', { drm: true, recorded: true }, [], null]);
    check('...and the encode facts name the DRM systems, with a note', [ea.j?.drm?.value, ea.j?.drm?.source, (ea.j?.notes ?? []).some((n: string) => /Packaged with DRM \(cbcs\)/.test(n))],
      [['Widevine', 'PlayReady', 'FairPlay'], 'stored', true]);
    const eb = await call('GET', `/api/vod/${B}/encode`);
    check('the plain title: nothing pending, no words, DRM none', [eb.s, eb.j?.policy?.pending, eb.j?.policy?.note, eb.j?.drm?.value], [200, [], null, []]);

    console.log('\n== a rule changed later ==');
    const off = await call('PUT', `/api/publishing-rules/schema/${film}`, { settings: { protection: { drm: false } }, lockedFields: [], presetKey: null, name: 'Protected films' });
    check('the content type rule turns DRM off (a draft title: no repackage confirmation)', off.s, 200);
    const ea2 = await call('GET', `/api/vod/${A}/encode`);
    check('the encrypted title: no DRM asked now, repackage pending, and it keeps its DRM (never weaker); the snapshot keeps what the encode was asked',
      [ea2.j?.policy?.now?.drm, ea2.j?.policy?.pending, /keeps its DRM/.test(ea2.j?.policy?.note ?? ''), ea2.j?.policy?.atEncode?.wanted], [false, ['drm'], true, { drm: true }]);
    const own = await call('PATCH', `/api/vod/${B}/availability`, { override: { protection: { drm: true }, distribution: { mp4Download: false } } });
    check('the plain title asks DRM for itself (saved)', own.s, 200);
    const eb2 = await call('GET', `/api/vod/${B}/encode`);
    check('its own setting is named, it is pending and the words say to encode it again',
      [eb2.j?.policy?.now?.source, eb2.j?.policy?.pending, /its own setting/.test(eb2.j?.policy?.note ?? ''), /encode it again/.test(eb2.j?.policy?.note ?? '')], ['asset', ['drm'], true, true]);
    check('encoding it again packages it with DRM', await encode(B), null);
    const eb3 = await call('GET', `/api/vod/${B}/encode`);
    check('...and nothing is pending any more', [eb3.j?.policy?.packaged, eb3.j?.policy?.pending, eb3.j?.drm?.value?.length], [{ drm: true, recorded: true }, [], 3]);

    console.log('\n== another account ==');
    const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`encpol2-${tag}`]))!.id;
    const ou = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [other, `encpol2-${tag}@volt.test`]))!.id;
    const t2 = signAccess({ sub: ou, account_id: other, role: 'owner' } as any);
    const x = await fetch(`${base}/api/vod/${A}/encode`, { headers: { authorization: `Bearer ${t2}` } });
    check('another account cannot read the title\'s encode or policy', x.status, 404);
  } finally {
    srv.close();
    speke.close();
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(1); });
