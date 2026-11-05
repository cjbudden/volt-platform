// ============================================================================
//  AUDIO ASSETS (build queue H2b-4, first part): a file with no picture is
//  taken into the Media Library and encoded to its sound alone, instead of
//  being refused ("no video track") or sent to review.
//
//  Through the real API, the real job handler and the real vod_encoder.py on a
//  real database:
//    - the probe tells sound from picture, and cover art in an mp3 is not a
//      picture (vod_encoder.py and the ingest's interpretProbe agree);
//    - the encode of an mp3 runs ffmpeg with no video outputs, one AAC track
//      (128 kb/s stereo 48 kHz), and packages that one track for HLS and DASH;
//    - the asset ends ready, kind 'audio', no rungs, the probe saying no
//      picture, no MP4, no stills, sprites, frame index or social formats
//      queued, QC queued; the API says audioOnly and the library list says
//      audio_only and media_kind 'audio';
//    - a file with neither picture nor sound is refused with the reason;
//    - a fresh watch folder's default rules take an mp3 into the Media Library
//      with its encode queued; a rule may send audio to the Media Library but
//      not to Loops & Fillers.
//
//  THE PACKAGER. With Shaka on PATH (or PACKAGER_BIN) the packaging is real
//  and the manifests are read back. Without it (the cloud container) a stub
//  stands in for the packager only: it records the arguments it was given and
//  writes the files Shaka would, so everything around it is still real. On
//  the Mac run it with PACKAGER_BIN=../packager-osx-arm64/packager.
//
//  Usage: DATABASE_URL=... npx tsx test/vod-audio-asset.check.ts
// ============================================================================
import { mkdtemp, mkdir, writeFile, utimes, readFile, chmod } from 'node:fs/promises';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
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
  const root = await mkdtemp(join(tmpdir(), 'vod-audio-'));
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
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { config } = await import('../src/config');
  const { interpretProbe } = await import('../src/services/ingest/metadata');

  const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'ignore' });
  const work = join(root, 'work'); await mkdir(work, { recursive: true });
  // An mp3 with cover art: the common case, and the one that looks like video.
  const cover = join(work, 'cover.png');
  ff(['-f', 'lavfi', '-i', 'color=c=orange:s=300x300', '-frames:v', '1', cover]);
  const mp3 = join(work, 'Theme Tune.mp3');
  ff(['-f', 'lavfi', '-i', 'sine=f=440:d=3:sample_rate=44100', '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-b:a', '96k',
      '-c:v', 'png', '-disposition:v', 'attached_pic', '-metadata', 'title=Theme Tune', mp3]);
  const mp4 = join(work, 'picture.mp4');
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=1', '-f', 'lavfi', '-i', 'sine=d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', mp4]);
  const srt = join(work, 'x.srt'); await writeFile(srt, '1\n00:00:00,000 --> 00:00:01,000\nHello\n');
  const subsOnly = join(work, 'subs-only.mkv');
  ff(['-i', srt, '-c:s', 'srt', subsOnly]);

  // ---- the probes ----------------------------------------------------------------
  console.log('== sound or picture ==');
  const probeJson = (p: string) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', p]).toString());
  const ip = interpretProbe(probeJson(mp3));
  check('the ingest probe: an mp3 with cover art has no picture, and has sound', [ip.hasVideo, ip.hasAudio, ip.video], [false, true, null]);
  check('the ingest probe: an mp4 has both', [interpretProbe(probeJson(mp4)).hasVideo, interpretProbe(probeJson(mp4)).hasAudio], [true, true]);
  const encProbe = (p: string) => {
    const j = join(work, 'probe-job.json');
    writeFileSync(j, JSON.stringify({ input: p, out_dir: join(work, 'probe-out'), probe_only: true }));
    const r = spawnSync(config.testStream.pythonBin, [join(config.testStream.encoderBin, 'vod_encoder.py'), j]);
    return JSON.parse(String(r.stdout).trim().split('\n').pop() || '{}');
  };
  const ep = encProbe(mp3);
  check('vod_encoder.py agrees: no picture, sound, the length', [ep.hasVideo, ep.hasAudio, Math.round((ep.durationMs ?? 0) / 1000)], [false, true, 3]);

  // ---- the database --------------------------------------------------------------
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`aud-${tag}`]))!.id;
  const owner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `aud-${tag}@volt.test`]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type, codec_backend, packaging)
      VALUES ($1,'HD','[{"height":720,"bitrate_kbps":3000},{"height":360,"bitrate_kbps":800}]','transcode','x264','both') RETURNING id`, [acct]))!.id;
  const { ensureTrackingGroup } = await import('../src/services/encode/store');
  await ensureTrackingGroup(acct, prof, 'Same as live', { makeDefault: true });
  const newAsset = async (title: string) => (await one<any>(
    `INSERT INTO vod_assets(account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, metadata)
     VALUES ($1,'upload','export',$2,0,0,0,'{}'::jsonb) RETURNING id`, [acct, title]))!.id;

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = signAccess({ sub: owner, account_id: acct, role: 'owner' } as any);
  const call = async (method: string, path: string, body?: any) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json().catch(() => null) as any };
  };

  try {
    // ---- the encode --------------------------------------------------------------
    console.log('\n== an mp3 encoded as an audio asset ==');
    const { handleVodEncode, outDirFor } = await import('../src/services/jobs/handlers/vodEncode');
    const A = await newAsset('Theme Tune');
    let err: any = null;
    try {
      await handleVodEncode({ job: { payload: { vodAssetId: A, accountId: acct, sourcePath: mp3 } } as any, progress: async () => {}, isCancelled: () => false } as any);
    } catch (e) { err = e; }
    check('the encode succeeds (it used to be refused: no video track)', err ? String(err?.message ?? err) : null, null);
    const job = JSON.parse(await readFile(join(outDirFor(A), 'encode-job.json'), 'utf8'));
    check('the job asks for sound only, with no rungs', [job.audio_only, job.ladder, job.has_audio], [true, [], true]);
    const row = await one<any>(`SELECT master_key, progressive_key, media_state, encode_result, formats, media_facts, ingest FROM vod_assets WHERE id = $1`, [A]);
    check('the asset is ready with an HLS master', [row.media_state, /\/master\.m3u8$/.test(row.master_key ?? '')], ['ready', true]);
    check('HLS and DASH, no MP4', row.formats, { hls: true, dash: true, progressive: false });
    check('the encode says audio, no rungs, no picture', [row.encode_result?.kind, row.encode_result?.kept, row.encode_result?.probe?.hasVideo, row.encode_result?.summary],
      ['audio', [], false, 'sound only, AAC 128 kb/s']);
    check('one AAC track, 128 kb/s stereo 48 kHz', row.encode_result?.audio?.map((a: any) => [a.codec, a.bitrateKbps, a.channels, a.sampleRate]), [['AAC', 128, 2, 48000]]);
    check('the source facts kept say no picture', [row.ingest?.probe?.hasVideo, row.ingest?.probe?.hasAudio], [false, true]);
    const facts = row.media_facts;
    check('what was packaged, read back: no video, one AAC track at 48 kHz stereo',
      [facts?.video?.length ?? 0, facts?.audio?.length, facts?.audio?.[0]?.sampleRate, facts?.audio?.[0]?.channels], [0, 1, 48000, 2]);
    const dirs = readdirSync(outDirFor(A)).filter((d) => !d.startsWith('.') && !d.includes('.'));
    check('only an audio rendition on disk', dirs.sort(), ['audio']);
    if (!realPackager) {
      const args: string[] = JSON.parse(await readFile(argLog, 'utf8'));
      const ins = args.filter((a) => a.startsWith('in='));
      check('the packager is given one stream, the sound', [ins.length, ins.every((a) => /stream=audio/.test(a)), ins.some((a) => /stream=video/.test(a))], [1, true, false]);
      check('and asked for both manifests, as video is', [args.includes('--hls_master_playlist_output'), args.includes('--mpd_output'), args.includes('VOD')], [true, true, true]);
    } else {
      const master = await readFile(join(outDirFor(A), 'master.m3u8'), 'utf8');
      check('the real master names the AAC track and no video', [/mp4a\.40/.test(master), /avc1/.test(master)], [true, false]);
      const mpd = await readFile(join(outDirFor(A), 'manifest.mpd'), 'utf8');
      check('the real MPD is static and audio only', [/type="static"/.test(mpd), /contentType="audio"|mimeType="audio\/mp4"/.test(mpd), /mimeType="video/.test(mpd)], [true, true, false]);
    }
    const jobs = await query<any>(`SELECT type FROM jobs WHERE payload::text LIKE $1 ORDER BY type`, [`%${A}%`]);
    const types = jobs.map((j) => j.type);
    check('QC is queued', types.includes('qc.run'), true);
    check('nothing that needs a picture is queued (frame index, social formats, asset image)', types.filter((t) => /frame|reframe|vod\.image/.test(t)), []);
    check('no stills were cut', existsSync(join(outDirFor(A), 'sprites')), false);

    console.log('\n== what the API and the library say ==');
    const d = await call('GET', `/api/vod/${A}`);
    check('the asset says audioOnly, so the page puts up the audio player', [d.s, d.j?.audioOnly], [200, true]);
    const lst = await call('GET', `/api/vod?limit=50`);
    const li = (lst.j?.items ?? lst.j?.data ?? lst.j ?? []).find?.((x: any) => x.id === A);
    check('the library list says audio', [li?.audio_only, li?.media_kind], [true, 'audio']);
    const enc = await call('GET', `/api/vod/${A}/encode`);
    check('the Encode tab offers HLS and DASH as audio only, and no MP4', [enc.s, (enc.j?.deliveries ?? []).map((x: any) => x.label).filter((l: string) => /HLS|DASH|MP4 \(/.test(l))],
      [200, ['HLS (audio only)', 'DASH (audio only)']]);

    console.log('\n== a video is still a video ==');
    const V = await newAsset('Picture');
    await handleVodEncode({ job: { payload: { vodAssetId: V, accountId: acct, sourcePath: mp4 } } as any, progress: async () => {}, isCancelled: () => false } as any);
    const vr = await one<any>(`SELECT encode_result FROM vod_assets WHERE id = $1`, [V]);
    check('an mp4 gets its rungs and kind video', [vr.encode_result?.kind, (vr.encode_result?.kept ?? []).length > 0, vr.encode_result?.probe?.hasVideo], ['video', true, true]);
    check('and the API says not audio', (await call('GET', `/api/vod/${V}`)).j?.audioOnly, false);

    console.log('\n== nothing to encode ==');
    const N = await newAsset('Subtitles only');
    let nerr: any = null;
    try { await handleVodEncode({ job: { payload: { vodAssetId: N, accountId: acct, sourcePath: subsOnly } } as any, progress: async () => {}, isCancelled: () => false } as any); }
    catch (e) { nerr = e; }
    check('a file with neither picture nor sound is refused, permanently, with the reason', [nerr?.code ?? nerr?.reason ?? null, /neither picture nor sound/.test(String(nerr?.message))], ['no_media', true]);

    // ---- the watch folder ----------------------------------------------------------
    console.log('\n== an mp3 dropped into a fresh watch folder ==');
    const drop = join(root, 'drop'); await mkdir(drop, { recursive: true });
    const made = await call('POST', '/api/watchfolders', { name: 'Radio drop', kind: 'local', config: { path: drop, min_age_ms: 1000 } });
    check('created with the audio default among its rules', [made.s, made.j?.rules?.find((r: any) => r.builtin === 'audio')?.target_kind], [201, 'vod']);
    const F = made.j.id;
    const dropped = join(drop, 'Morning Jingle.mp3');
    await writeFile(dropped, await readFile(mp3));
    const old = new Date(Date.now() - 60_000); await utimes(dropped, old, old);
    const sc = await call('POST', `/api/watchfolders/${F}/scan`);
    check('the scan ran', sc.s, 200);
    const item = await one<any>(`SELECT status, target_kind FROM watchfolder_items WHERE watchfolder_id = $1 AND object_key = 'Morning Jingle.mp3'`, [F]);
    check('the mp3 went to the Media Library, not review', [item?.status, item?.target_kind], ['ingested', 'vod']);
    const wa = await one<any>(`SELECT id FROM vod_assets WHERE account_id = $1 AND source_kind = 'watchfolder'`, [acct]);
    const wj = wa ? await one<any>(`SELECT type FROM jobs WHERE type = 'vod.encode' AND payload::text LIKE $1`, [`%${wa.id}%`]) : null;
    check('as an asset with its encode queued', [!!wa, wj?.type], [true, 'vod.encode']);

    console.log('\n== where a rule may send audio ==');
    const toLoop = await call('POST', `/api/watchfolders/${F}/rules`, { name: 'Bad', matchType: 'glob', pattern: '*.mp3', targetKind: 'loop' });
    check('audio to Loops & Fillers is refused, pointing to the Media Library', [toLoop.s, toLoop.j?.code ?? null, /Media Library/.test(toLoop.j?.error ?? toLoop.j?.message ?? '')], [400, 'target_does_not_fit_type', true]);
    const toImg = await call('POST', `/api/watchfolders/${F}/rules`, { name: 'Bad', matchType: 'extension', pattern: 'wav', targetKind: 'image' });
    check('audio to the Image Library is refused', toImg.s, 400);
    const toVod = await call('POST', `/api/watchfolders/${F}/rules`, { name: 'Interviews', matchType: 'glob', pattern: 'interview_*.wav', targetKind: 'vod' });
    check('audio to the Media Library is accepted', toVod.s, 201);
  } finally {
    srv.close();
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
