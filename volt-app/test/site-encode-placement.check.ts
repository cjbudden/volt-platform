// ============================================================================
//  HYBRID SITES 4c: ENCODE AT SITE ON ON-PREM WATCHFOLDERS (build queue H4-3).
//
//  The real site agent (volt-agent siteWatch.ts and siteEncode.ts) against the
//  real API on a real database, with the real vod_encoder.py and ffmpeg (Shaka
//  when it is on PATH or PACKAGER_BIN, otherwise the stub site-encode.check.ts
//  uses):
//    - Encode at site can be chosen for an on-prem folder (it was refused);
//    - a video dropped there is REGISTERED, not uploaded: no upload session,
//      the same ingest on the facts the agent sent (the start of the file and
//      the probe from the site's encoder), the asset made with no cloud
//      original and its place at the site recorded, the encode queued in the
//      site's pool with that path, the item closed as in the library;
//    - the agent's encode worker then encodes it at the site and the asset is
//      ready, with the original still in the folder at the site;
//    - an image in the same folder is still uploaded, a video there cannot be;
//    - registering twice gives the first registration; changed content, an
//      upload folder, another site's host are refused;
//    - a content duplicate is held by the ingest rules with no encode; once a
//      person keeps it as a version, its encode goes to the site;
//    - metadata from facts: an ID3 title read from the head, the site's probe
//      in the shape the rules and the asset use.
//
//  Usage: DATABASE_URL=... npx tsx test/site-encode-placement.check.ts
// ============================================================================
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, chmodSync, mkdirSync, utimesSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };

(async () => {
  const root = mkdtempSync(join(tmpdir(), 'site-place-'));
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
  const E = await import('../src/services/sites/siteEncode');
  const SW = await import('../src/services/sites/siteWatchfolders');
  const P = await import('../src/services/ingest/pipeline');
  const M = await import('../src/services/ingest/metadata');
  const Wk = await import('../../volt-agent/src/siteWatch');
  const Enc = await import('../../volt-agent/src/siteEncode');

  // ---- the database, a site, an approved host ------------------------------------
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name, licences) VALUES ($1, '{hybrid_sites}') RETURNING id`, [`sp-${tag}`]))!.id;
  const owner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `sp-${tag}@example.com`]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type, codec_backend, packaging)
      VALUES ($1,'HD','[{"height":720,"bitrate_kbps":3000},{"height":360,"bitrate_kbps":800},{"height":240,"bitrate_kbps":400}]','transcode','x264','both') RETURNING id`, [acct]))!.id;
  const { ensureTrackingGroup } = await import('../src/services/encode/store');
  await ensureTrackingGroup(acct, prof, 'Same as live', { makeDefault: true });
  const tok = signAccess({ sub: owner, account_id: acct, role: 'owner' } as any);
  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: unknown, t: string | null = tok) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let b: any = null; try { b = text ? JSON.parse(text) : null; } catch { b = text; }
    return { status: r.status, body: b };
  };
  const facts = (hostname: string) => ({ hostname, cpuCores: 8, memoryBytes: 16 * 2 ** 30, gpus: [], diskFreeBytes: 1e12, diskTotalBytes: 2e12, os: 'Linux', arch: 'x64', agentVersion: '0.8.0', encoderVersion: null });
  const enrol = async (siteId: string, name: string) => {
    const tk = (await api('POST', `/api/sites/${siteId}/enrolment-tokens`, {})).body.token;
    const e = (await api('POST', '/api/site-agent/enrol', { token: tk, host: facts(name) }, null)).body;
    await api('POST', `/api/sites/${siteId}/hosts/${e.hostId}/approve`, {});
    return e.credential as string;
  };
  const site = (await api('POST', '/api/sites', { name: 'Main broadcast centre' })).body.id;
  const site2 = (await api('POST', '/api/sites', { name: 'Edit suite' })).body.id;
  const cred = await enrol(site, 'enc-01');
  const cred2 = await enrol(site2, 'edit-01');
  ok(!!cred && !!cred2, 'two sites, each with an approved host');

  console.log('== the placement ==');
  let r = await api('GET', '/api/watchfolders/site-options');
  ok(r.body.placements.find((p: any) => p.placement === 'encode_site')?.available === true, 'the form offers Encode at site', r.body.placements);
  const drop = join(root, 'nas', 'drop'); mkdirSync(drop, { recursive: true });
  r = await api('POST', '/api/watchfolders', { name: 'NAS encode', kind: 'site', siteId: site, placement: 'encode_site', config: { path: drop, min_age_ms: 1000 }, defaultRules: false });
  ok(r.status === 201 && r.body.placement === 'encode_site', 'an on-prem folder is created with Encode at site (refused with 422 before H4-3)', [r.status, r.body?.code]);
  const fid = r.body?.id;
  const upRoot = join(root, 'nas', 'upload'); mkdirSync(upRoot, { recursive: true });
  const fUp = (await api('POST', '/api/watchfolders', { name: 'NAS upload', kind: 'site', siteId: site, config: { path: upRoot, min_age_ms: 1000 }, defaultRules: false })).body.id;
  for (const f of [fid, fUp]) {
    await api('POST', `/api/watchfolders/${f}/rules`, { name: 'Video', matchType: 'extension', pattern: 'mp4', targetKind: 'vod' });
    await api('POST', `/api/watchfolders/${f}/rules`, { name: 'Posters', matchType: 'extension', pattern: 'png', targetKind: 'poster' });
  }

  // ---- drops ------------------------------------------------------------------------
  const old = (Date.now() - 60_000) / 1000;
  const src = join(drop, 'Evening News.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=640x360:r=25:d=6', '-f', 'lavfi', '-i', 'sine=f=440:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src], { stdio: 'ignore' });
  utimesSync(src, old, old);
  const srcSum = createHash('sha256').update(readFileSync(src)).digest('hex');
  writeFileSync(join(drop, 'poster.png'), Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), randomBytes(1500)])); utimesSync(join(drop, 'poster.png'), old, old);

  const realRunner = Enc.encoderRunner({ ...process.env, VOLT_ENCODER_IMAGE: '', VOLT_ENCODER_BIN: config.testStream.encoderBin, VOLT_PYTHON: config.testStream.pythonBin });
  const scratchDir = join(root, 'scratch');
  const logs: string[] = [];
  const mem = Wk.emptyMemory();
  const wctx = (credential = cred) => ({ server: base, credential: () => credential, memory: mem, log: (s: string) => logs.push(s), probe: Enc.siteProbe({ runner: realRunner, scratchDir }) });

  console.log('== a pass: registered, not uploaded ==');
  const folders = await Wk.siteFolders(wctx());
  const folder = folders.find((f) => f.id === fid)!;
  ok(folder?.placement === 'encode_site', 'the agent gets the folder with its placement', folder?.placement);
  const pass1 = await Wk.passFolder(wctx(), folder);
  ok(!pass1.error && pass1.registered.includes('Evening News.mp4'), 'the video is registered', [pass1.error, pass1.registered, pass1.uploadErrors]);
  ok(!pass1.uploaded.includes('Evening News.mp4'), 'the video is not uploaded', pass1.uploaded);
  ok(pass1.uploaded.includes('poster.png'), 'an image in the same folder is still uploaded', pass1.uploaded);
  const item = await one<any>(`SELECT * FROM watchfolder_items WHERE watchfolder_id = $1 AND object_key = 'Evening News.mp4'`, [fid]);
  ok(item?.status === 'ingested' && item.vod_asset_id && !item.upload_session_id && /registered at the site; in the Media Library as "Evening News", encoding at the site/.test(item.reason ?? ''), 'the item closes as in the library, encoding at the site', item && [item.status, item.reason, item.upload_session_id]);
  const A = item?.vod_asset_id;
  const sessions = await one<any>(`SELECT count(*)::int AS n FROM upload_sessions WHERE vod_asset_id = $1 OR id IN (SELECT upload_session_id FROM watchfolder_items WHERE id = $2 AND upload_session_id IS NOT NULL)`, [A, item?.id]);
  ok(sessions?.n === 0, 'no upload was opened for it', sessions);
  let a = await one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [A]);
  ok(a?.account_id === acct && a.source_kind === 'watchfolder' && a.source_key === null && Number(a.source_bytes) === statSync(src).size, 'a Media Library record of the account with no original in the cloud', a && [a.source_kind, a.source_key, a.source_bytes]);
  ok(a?.ingest?.siteSource?.siteId === site && a.ingest.siteSource.sitePath === src && a.ingest.siteSource.folderId === fid && a.ingest.siteSource.objectKey === 'Evening News.mp4', 'its original is recorded where it is kept: the site and the path there', a?.ingest?.siteSource);
  ok(a?.ingest?.status === 'ingested' && a.sha256 === srcSum && a.original_filename === 'Evening News.mp4' && a.mime === 'video/mp4', 'the ingest ran on the facts: status, checksum, name, the type sniffed from the first bytes', a && [a.ingest?.status, a.mime]);
  ok(Math.abs(Number(a?.ingest?.probe?.durationSec) - 6) < 0.5 && a.ingest.probe.video?.height === 360, "the site's probe is on the asset (6 s, 360 lines)", a?.ingest?.probe);
  ok(a?.media_state === 'processing', 'the asset reads Processing', a?.media_state);
  const probeJob = await one<any>(`SELECT * FROM jobs WHERE type = $1 AND payload->>'vodAssetId' = $2`, [E.SITE_VOD_PROBE, A]);
  ok(probeJob && a.encode_job_id === probeJob.id && probeJob.pool === `site:${site}` && probeJob.payload.sitePath === src, 'the encode is queued in the site\'s pool with the path at the site', probeJob && [probeJob.pool, probeJob.payload.sitePath]);
  ok(!(await one<any>(`SELECT 1 AS x FROM jobs WHERE type = 'vod.encode' AND payload->>'vodAssetId' = $1`, [A])), 'no cloud encode is queued');
  const poster = await one<any>(`SELECT * FROM watchfolder_items WHERE watchfolder_id = $1 AND object_key = 'poster.png'`, [fid]);
  ok(poster?.upload_session_id && !poster.vod_asset_id, 'the image went up on the upload path', poster && [poster.status, poster.reason]);

  console.log('== the encode at the site ==');
  logs.length = 0;
  const ran = await Enc.encodePass({ server: base, credential: () => cred, scratchDir, runner: realRunner, progressEveryMs: 200, hasGpu: false, log: (s: string) => logs.push(s) });
  a = await one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [A]);
  ok(ran === 2 && a.media_state === 'ready' && a.master_key === `/clips/vod/${A}/master.m3u8`, 'the site worker probes and encodes it; the asset is ready', [ran, a.media_state, a.media_error, logs.slice(-4)]);
  ok(a.encode_result?.encodedAt?.site === site && a.source_key === null && a.ingest?.siteSource?.sitePath === src, 'recorded as encoded at the site; the original is still only at the site', a.encode_result?.encodedAt);
  ok(existsSync(src) && createHash('sha256').update(readFileSync(src)).digest('hex') === srcSum, 'the original is untouched in the folder at the site');

  console.log('== registering again, and what is refused ==');
  r = await api('POST', `/api/site-agent/watchfolders/${fid}/registrations/${item.id}`, { sizeBytes: Number(item.size_bytes), checksum: item.checksum, head: '' }, cred);
  ok(r.status === 201 && r.body.vodAssetId === A && (await one<any>(`SELECT count(*)::int AS n FROM vod_assets WHERE account_id = $1`, [acct]))!.n === 1, 'registering twice gives the first registration, no second asset', r.body);
  r = await api('GET', `/api/site-agent/watchfolders/${fid}/registrations`, undefined, cred);
  ok(r.status === 200 && r.body.items.length === 0, 'nothing left to register', r.body);
  // a second file, reported but not registered yet
  const second = join(drop, 'Late Show.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', second], { stdio: 'ignore' });
  const sSum = createHash('sha256').update(readFileSync(second)).digest('hex');
  const sSize = statSync(second).size;
  r = await api('POST', `/api/site-agent/watchfolders/${fid}/items`, { objectKey: 'Late Show.mp4', checksum: sSum, sizeBytes: sSize, status: 'seen' }, cred);
  const sItem = r.body.itemId;
  r = await api('GET', `/api/site-agent/watchfolders/${fid}/registrations`, undefined, cred);
  ok(r.body.items.length === 1 && r.body.items[0].itemId === sItem && r.body.items[0].checksum === sSum, 'an accepted video waits in the registration list', r.body.items);
  r = await api('GET', `/api/site-agent/watchfolders/${fid}/uploads`, undefined, cred);
  ok(!r.body.items.some((u: any) => u.itemId === sItem), 'and not in the upload list', r.body.items);
  const head = readFileSync(second).subarray(0, 4096).toString('base64');
  r = await api('POST', `/api/site-agent/watchfolders/${fid}/registrations/${sItem}`, { sizeBytes: sSize + 1, checksum: sSum, head }, cred);
  ok(r.status === 409 && /changed since it was accepted/.test(r.body?.error ?? ''), 'a file that changed size is refused', r);
  r = await api('POST', `/api/site-agent/watchfolders/${fid}/registrations/${sItem}`, { sizeBytes: sSize, checksum: 'f'.repeat(64), head }, cred);
  ok(r.status === 409, 'a file whose content changed is refused', r.status);
  r = await api('POST', `/api/site-agent/watchfolders/${fid}/registrations/${sItem}`, { sizeBytes: sSize, checksum: sSum, head }, cred2);
  ok(r.status === 404, "another site's host cannot register into the folder", r.status);
  r = await api('POST', `/api/site-agent/watchfolders/${fid}/registrations/${sItem}`, { sizeBytes: sSize, checksum: sSum, head: Buffer.alloc(SW.SITE_HEAD_MAX_BYTES + 1).toString('base64') }, cred);
  ok(r.status === 400, 'a head over the limit is refused', r.status);
  const tusRes = await fetch(`${base}/api/site-agent/tus`, { method: 'POST', headers: { authorization: `Bearer ${cred}`, 'tus-resumable': '1.0.0', 'upload-length': String(sSize), 'upload-metadata': `itemId ${Buffer.from(String(sItem)).toString('base64')}` } });
  ok(tusRes.status === 409, 'a video in an Encode at site folder cannot be uploaded', tusRes.status);
  r = await api('POST', `/api/site-agent/watchfolders/${fid}/registrations/${sItem}`, { sizeBytes: sSize, checksum: sSum, head }, cred);
  ok(r.status === 201 && r.body.asset?.mediaState === 'processing' && r.body.asset?.encodeJobId, 'registered without a probe: still taken in, encode queued', r.body);
  const sA = await one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [r.body.vodAssetId]);
  ok(sA?.ingest?.probe === null && sA.mime === 'video/mp4', 'with no probe the type still comes from the first bytes', sA && [sA.ingest?.probe, sA.mime]);

  console.log('== an upload folder registers nothing ==');
  r = await api('GET', `/api/site-agent/watchfolders/${fUp}/registrations`, undefined, cred);
  ok(r.status === 200 && r.body.items.length === 0, 'an upload folder lists no registrations');
  r = await api('POST', `/api/site-agent/watchfolders/${fUp}/items`, { objectKey: 'clip.mp4', checksum: sSum, sizeBytes: sSize, status: 'seen' }, cred);
  const upItem = r.body.itemId;
  r = await api('POST', `/api/site-agent/watchfolders/${fUp}/registrations/${upItem}`, { sizeBytes: sSize, checksum: sSum, head }, cred);
  ok(r.status === 409 && /uploads its files/.test(r.body?.error ?? ''), 'and refuses one', r);
  r = await api('GET', `/api/site-agent/watchfolders/${fUp}/uploads`, undefined, cred);
  ok(r.body.items.some((u: any) => u.itemId === upItem), 'its video waits to be uploaded, as before');

  console.log('== a duplicate is held, then encoded at the site ==');
  copyFileSync(src, join(drop, 'Evening News copy.mp4')); utimesSync(join(drop, 'Evening News copy.mp4'), old, old);
  const pass2 = await Wk.passFolder(wctx(), folder);
  const dItem = await one<any>(`SELECT * FROM watchfolder_items WHERE watchfolder_id = $1 AND object_key = 'Evening News copy.mp4'`, [fid]);
  const D = dItem?.vod_asset_id;
  let d = await one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [D]);
  ok(pass2.registered.includes('Evening News copy.mp4') && d?.ingest?.status === 'duplicate' && d.ingest?.duplicate?.ofAssetId === A, 'the same content again is held as a duplicate of the first', d && [d.ingest?.status, d.ingest?.duplicate]);
  ok(!(await one<any>(`SELECT 1 AS x FROM jobs WHERE payload->>'vodAssetId' = $1`, [D])) && /held by the ingest rules \(duplicate\)/.test(dItem?.reason ?? ''), 'no encode while it is held; the item says so', dItem?.reason);
  await P.resolveDuplicate(acct, D, 'version');
  d = await one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [D]);
  const dJob = await one<any>(`SELECT * FROM jobs WHERE id = $1`, [d.encode_job_id]);
  ok(dJob?.type === E.SITE_VOD_PROBE && dJob.pool === `site:${site}` && dJob.payload.sitePath === join(drop, 'Evening News copy.mp4') && d.media_state === 'processing', 'kept as a version, its encode is queued at the site, not in the cloud', dJob && [dJob.type, dJob.pool]);
  ok(await P.queueEncodeFor(D) === d.encode_job_id, 'asking again joins the encode already queued');

  console.log('== metadata from facts ==');
  const id3 = (() => {
    const text = Buffer.concat([Buffer.from([3]), Buffer.from('Morning Song', 'latin1')]);
    const frame = Buffer.concat([Buffer.from('TIT2'), Buffer.from([0, 0, 0, text.length, 0, 0]), text]);
    const size = frame.length;
    const hdr = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
    return Buffer.concat([hdr, frame, Buffer.from([0xff, 0xfb, 0x90, 0x64]), randomBytes(400)]);
  })();
  const x = M.extractFromFacts(id3, { originalName: 'song.mp3', bytes: 10_000_000 }, 'audio/mpeg', { ok: true, hasVideo: false, hasAudio: true, durationMs: 185_000, audioCodec: 'mp3', audioTracks: [{ codec: 'mp3', channels: 2, language: null }] });
  ok(x.type.kind === 'audio' && x.id3?.title === 'Morning Song' && M.candidates(x).name === 'Morning Song', 'an ID3 title read from the head the agent sent', [x.type, x.id3]);
  ok(x.probe?.durationSec === 185 && x.probe?.hasVideo === false && x.probe?.video === null && x.probe?.audioTracks?.[0]?.channels === 2, "the site's probe in the shape the asset uses", x.probe);
  ok(M.probeFromSite({ ok: false, error: 'moov atom not found' }) === null && M.probeFromSite(null) === null, 'an unreadable probe is no probe');
  ok(SW.sitePathOf('/mnt/nas/drop/', 'news/a b.mp4') === '/mnt/nas/drop/news/a b.mp4' && SW.sitePathOf('D:\\Drop', 'news/a.mp4') === 'D:\\Drop\\news\\a.mp4', 'the path at the site, POSIX and Windows');

  console.log(`\nsite-encode-placement: ${pass}/${pass + fail} passed`);
  srv.close();
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
