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
//      rule, and what the files were packaged with (in the clear today);
//    - the Encode tab's `policy` compares the policy now with the files:
//      Repackage pending when they disagree, with the words; a rule changed
//      later moves `now`, never the snapshot; the title's own setting is named.
//
//  THE PACKAGER: real with Shaka on PATH or PACKAGER_BIN, otherwise the same
//  recording stub as vod-audio-asset.check.ts (the cloud container).
//  Usage: DATABASE_URL=... npx tsx test/publishing-encode-policy.check.ts
// ============================================================================
import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises';
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

  const srv = createServer().listen(0);
  await new Promise((res) => srv.once('listening', res));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = signAccess({ sub: owner, account_id: acct, role: 'owner' } as any);
  const call = async (method: string, path: string, body?: any) => {
    const x = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { s: x.status, j: await x.json().catch(() => null) as any };
  };
  const { handleVodEncode } = await import('../src/services/jobs/handlers/vodEncode');
  const encode = async (id: string) => {
    let err: any = null;
    try { await handleVodEncode({ job: { payload: { vodAssetId: id, accountId: acct, sourcePath: mp3 } } as any, progress: async () => {}, isCancelled: () => false } as any); }
    catch (e) { err = e; }
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

    console.log('\n== the encode keeps the policy with what the files carry ==');
    const A = await newAsset('Protected title', film);
    check('the encode of a Film succeeds', await encode(A), null);
    const ra = await one<any>(`SELECT policy_snapshot, encode_result->>'drm' AS drm, media_state FROM vod_assets WHERE id = $1`, [A]);
    check('its snapshot: DRM asked by the content type rule "Protected films", files packaged in the clear',
      [ra.media_state, ra.drm, ra.policy_snapshot?.wanted, ra.policy_snapshot?.sources, ra.policy_snapshot?.rule, ra.policy_snapshot?.packaged],
      ['ready', 'clear', { drm: true }, { drm: 'schema' }, 'Protected films', { drm: false }]);
    check('the snapshot carries when it was resolved', Math.abs(Date.parse(ra.policy_snapshot?.at) - Date.now()) < 120_000, true);
    const B = await newAsset('Plain title', null);
    check('the encode of an untyped title succeeds', await encode(B), null);
    const rb = await one<any>(`SELECT policy_snapshot FROM vod_assets WHERE id = $1`, [B]);
    check('its snapshot: no DRM asked (platform default), clear', [rb.policy_snapshot?.wanted, rb.policy_snapshot?.sources, rb.policy_snapshot?.rule, rb.policy_snapshot?.packaged],
      [{ drm: false }, { drm: 'baseline' }, null, { drm: false }]);

    console.log('\n== the Encode tab ==');
    const ea = await call('GET', `/api/vod/${A}/encode`);
    check('the protected title: policy asks DRM, files clear, Repackage pending, the words',
      [ea.s, ea.j?.policy?.now?.drm, ea.j?.policy?.now?.rule, ea.j?.policy?.packaged, ea.j?.policy?.pending, /repackage pending/.test(ea.j?.policy?.note ?? '')],
      [200, true, 'Protected films', { drm: false, recorded: true }, ['drm'], true]);
    check('...and the encode facts are still there (DRM none)', [ea.j?.drm?.value, ea.j?.policy?.atEncode?.wanted], [[], { drm: true }]);
    const eb = await call('GET', `/api/vod/${B}/encode`);
    check('the plain title: nothing pending, no words', [eb.s, eb.j?.policy?.pending, eb.j?.policy?.note], [200, [], null]);

    console.log('\n== a rule changed later ==');
    const off = await call('PUT', `/api/publishing-rules/schema/${film}`, { settings: { protection: { drm: false } }, lockedFields: [], presetKey: null, name: 'Protected films' });
    check('the content type rule turns DRM off (a draft title: no repackage confirmation)', off.s, 200);
    const ea2 = await call('GET', `/api/vod/${A}/encode`);
    check('the title follows the rule now: no DRM asked, nothing pending; the snapshot still says what the encode was asked',
      [ea2.j?.policy?.now?.drm, ea2.j?.policy?.pending, ea2.j?.policy?.atEncode?.wanted], [false, [], { drm: true }]);
    const own = await call('PATCH', `/api/vod/${B}/availability`, { override: { protection: { drm: true }, distribution: { mp4Download: false } } });
    check('the plain title asks DRM for itself (saved)', own.s, 200);
    const eb2 = await call('GET', `/api/vod/${B}/encode`);
    check('its own setting is named and it is pending', [eb2.j?.policy?.now?.source, eb2.j?.policy?.pending, /its own setting/.test(eb2.j?.policy?.note ?? '')], ['asset', ['drm'], true]);

    console.log('\n== another account ==');
    const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`encpol2-${tag}`]))!.id;
    const ou = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [other, `encpol2-${tag}@volt.test`]))!.id;
    const t2 = signAccess({ sub: ou, account_id: other, role: 'owner' } as any);
    const x = await fetch(`${base}/api/vod/${A}/encode`, { headers: { authorization: `Bearer ${t2}` } });
    check('another account cannot read the title\'s encode or policy', x.status, 404);
  } finally {
    srv.close();
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(1); });
