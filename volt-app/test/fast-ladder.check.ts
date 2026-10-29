// ============================================================================
//  A FAST CHANNEL'S LADDER (services/fast/ladder.ts, prepare.ts, store.ts
//  timelineFor, jobs/handlers/vodLadder.ts; volt-encoder vod_encoder.py box
//  fitting and fast_playout.py tracks from the ladder).
//
//    * which sources can fill the top rung: by height, or by width for a film
//      wider than 16:9, and by bitrate; unmeasured is said, not hidden;
//    * an asset whose own encode is the ladder is used as is (and recorded);
//    * one that is not gets a variant queued (vod.ladder), per role: content
//      at the ladder's segments, a house spot at broadcast loudness, the slate
//      in 1 s segments; queuing twice does not queue twice;
//    * the timeline plays each asset's packaging for the ladder and hands the
//      playout the ladder; an asset not packaged yet keeps its own encode;
//    * the encoder boxes every rung to its 16:9 size; the playout's tracks and
//      master come from the ladder, not the first asset.
//
//  Needs Postgres (DATABASE_URL, migrations applied) and python3.
//  Usage: npx tsx test/fast-ladder.check.ts
// ============================================================================
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`));

const ROOT = mkdtempSync(join(tmpdir(), 'fast-ladder-'));
const ENC = join(__dirname, '..', '..', 'volt-encoder', 'bin');
// The handler runs a stand-in encoder (no packager here): it answers the probe as
// a 1920x800 scope film and, for the encode, writes a master and keeps the job file.
const FAKE = join(ROOT, 'bin');
process.env.ENCODER_BIN = FAKE;
process.env.CLIPS_DIR = join(ROOT, 'clips');
process.env.VOD_STORE = 'local';

async function main() {
  const L = await import('../src/services/fast/ladder');

  console.log('== the 16:9 box ==');
  check('rung widths', [1080, 720, 480, 360].map(L.boxWidth), [1920, 1280, 854, 640]);

  console.log('== which sources fill the top rung ==');
  const top = { height: 1080, width: 1920, bitrate_kbps: 6000 };
  check('1080p at 8 Mb/s', L.fitToTop({ width: 1920, height: 1080, kbps: 8000 }, top).fit, 'ok');
  check('a 2.39:1 film, 1920x800, is a 1080p source', L.fitToTop({ width: 1920, height: 800, kbps: 7000 }, top).fit, 'ok');
  check('720p is below', L.fitToTop({ width: 1280, height: 720, kbps: 9000 }, top), { fit: 'below', why: 'its picture, 1280x720, is smaller than the 1080p top rendition' });
  check('1080p at 3 Mb/s is below on bitrate', L.fitToTop({ width: 1920, height: 1080, kbps: 3000 }, top), { fit: 'below', why: 'its bitrate, 3 Mb/s, is below the 1080p top rendition\'s 6 Mb/s' });
  check('5.8 Mb/s measured against 6 is close enough', L.fitToTop({ width: 1920, height: 1080, kbps: 5800 }, top).fit, 'ok');
  check('VP9 is compared as H.264: 3.2 Mb/s VP9 is about 5.1 Mb/s, still below 6', L.fitToTop({ width: 1920, height: 1080, kbps: 3200, codec: 'vp9' }, top).why, 'its bitrate, 3.2 Mb/s VP9 (about 5.1 Mb/s as H.264), is below the 1080p top rendition\'s 6 Mb/s');
  check('4 Mb/s HEVC clears a 6 Mb/s H.264 rung', L.fitToTop({ width: 1920, height: 1080, kbps: 4000, codec: 'hevc' }, top).fit, 'ok');
  check('a ProRes master always clears the bitrate bar', L.fitToTop({ width: 1920, height: 1080, kbps: 1000, codec: 'prores' }, top).fit, 'ok');
  check('bitrate never measured: shown, and said', L.fitToTop({ width: 1920, height: 1080, kbps: null }, top).fit, 'unmeasured');
  check('the video bitrate from the container when the stream does not say', L.sourceQuality({ ingest: { probe: { bitrateKbps: 8128, video: { width: 1920, height: 1080 }, audioTracks: [{ bitrateKbps: 128 }] } } }), { width: 1920, height: 1080, kbps: 8000, codec: null });

  const { query, one, pool } = await import('../src/db');
  const { readinessWithLadder, prepare } = await import('../src/services/fast/prepare');
  const { timelineFor } = await import('../src/services/fast/store');

  const ACC = randomUUID(), GRP = randomUUID(), CH = randomUUID();
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'LadderCo')`, [ACC]);
  await query(`INSERT INTO groups(id,account_id,name) VALUES ($1,$2,'G')`, [GRP, ACC]);
  const prof = async (h: number, k: number) => (await one<any>(`INSERT INTO encode_profiles(account_id,name,height,bitrate_kbps) VALUES ($1,$2,$3,$4) RETURNING id`, [ACC, `${h}p`, h, k])).id;
  const LG = (await one<any>(`INSERT INTO encode_ladder_groups(account_id,name,is_default,segment_dur,fps) VALUES ($1,'HD',true,4,25) RETURNING id`, [ACC])).id;
  for (const [i, [h, k]] of [[1080, 6000], [720, 3000], [480, 1200]].entries()) await query(`INSERT INTO encode_ladder_members(group_id,profile_id,ordinal) VALUES ($1,$2,$3)`, [LG, await prof(h, k), i]);
  const HDR = [{ height: 1080, bitrate_kbps: 6000 }, { height: 720, bitrate_kbps: 3000 }, { height: 480, bitrate_kbps: 1200 }];
  await query(`INSERT INTO channels(id,group_id,name,status,tz,kind,origin,fast_media) VALUES ($1,$2,'Movies','ended','UTC','tv','playlist','video')`, [CH, GRP]);

  console.log('== the channel ladder ==');
  const lad = await L.channelLadder(CH);
  check('no ladder named: the account default', [lad?.groupName, lad?.inherited, lad?.rungs.map((r) => `${r.width}x${r.height}@${r.bitrate_kbps}`)], ['HD', true, ['1920x1080@6000', '1280x720@3000', '854x480@1200']]);

  const src = join(ROOT, 'film.mp4'); writeFileSync(src, 'not really a film');
  const asset = async (title: string, er: any, probe: any, sourceKey: string | null = src) => (await one<any>(
    `INSERT INTO vod_assets(account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, master_key, source_key, encode_result, ingest)
     VALUES ($1,'upload','export',$2,0,0,600000,$3,$4,$5::jsonb,$6::jsonb) RETURNING id`,
    [ACC, title, `/clips/vod/${title}/master.m3u8`, sourceKey, JSON.stringify(er), JSON.stringify({ probe })])).id as string;
  const fit = (w: number, h: number) => ({ video: { width: w, height: h, bitrateKbps: 8000 } });
  const A = await asset('a', { zeroStart: true, segmentSeconds: 4, fps: 25, kept: HDR }, fit(1920, 1080));
  // a scope film: its own encode dropped 1080 (height cap), so it cannot share the channel's tracks
  const B = await asset('b', { zeroStart: true, segmentSeconds: 4, fps: 25, kept: HDR.slice(1) }, fit(1920, 800));
  const C = await asset('c', { zeroStart: true, segmentSeconds: 4, fps: 25, kept: HDR, loudnorm: false }, fit(1920, 1080));
  const S = await asset('s', { zeroStart: true, segmentSeconds: 4, fps: 25, kept: HDR }, fit(1920, 1080));
  const N = await asset('n', { zeroStart: true, segmentSeconds: 4, fps: 25, kept: HDR.slice(1) }, fit(1280, 720), null);
  await query(`INSERT INTO fast_lineups(channel_id,name,epoch,zone,status,slots) VALUES ($1,'Main',now(),'UTC','draft',$2::jsonb)`,
    [CH, JSON.stringify([{ id: 's1', kind: 'title', pool: [{ assetId: A }] }, { id: 's2', kind: 'title', pool: [{ assetId: B }] }, { id: 's3', kind: 'title', pool: [{ assetId: N }] }])]);
  await query(`INSERT INTO channel_ads(channel_id, house_ads, policy) VALUES ($1,$2::jsonb,$3::jsonb)`, [CH, JSON.stringify([{ assetId: C }]), JSON.stringify({ slateAssetId: S })]);

  console.log('== readiness against the ladder ==');
  const r1 = await readinessWithLadder(CH);
  const by = (id: string) => r1.items.find((x) => x.assetId === id)!;
  check('a 16:9 asset already encoded to the ladder is ready as it is', [by(A).state, by(A).packaging], ['ready', 'main']);
  check('...and recorded against the ladder', (await one<any>(`SELECT origin, state, master_key FROM vod_asset_ladders WHERE vod_asset_id = $1`, [A])), { origin: 'main', state: 'ready', master_key: '/clips/vod/a/master.m3u8' });
  check('the scope film needs packaging to the ladder', [by(B).state, /1080p, 720p, 480p/.test(String(by(B).why))], ['needs-prepare', true]);
  check('the house spot needs broadcast loudness', [by(C).state, /broadcast loudness/.test(String(by(C).why))], ['needs-prepare', true]);
  check('the slate needs 1 s segments', [by(S).state, /1 s segments/.test(String(by(S).why))], ['needs-prepare', true]);
  check('no source: reported, and it airs on its own encode meanwhile', [by(N).state, /airs on its own encode/.test(String(by(N).why))], ['no-source', true]);

  console.log('== preparing ==');
  const p1 = await prepare(CH, { auto: true });
  check('three packagings queued, the one with no source skipped', [p1.queued.sort(), p1.skipped.map((x) => x.assetId)], [[B, C, S].sort(), [N]]);
  const jobs = await query<any>(`SELECT payload FROM jobs WHERE type = 'vod.ladder' AND payload->>'accountId' = $1 ORDER BY payload->>'vodAssetId'`, [ACC]);
  const pj = (id: string) => jobs.find((j) => j.payload.vodAssetId === id)?.payload;
  check('content at the ladder\'s segments', [pj(B)?.ladderGroupId, pj(B)?.segmentSeconds, pj(B)?.loudnorm], [LG, 4, false]);
  check('the house spot at broadcast loudness', [pj(C)?.segmentSeconds, pj(C)?.loudnorm], [4, true]);
  check('the slate in 1 s segments', [pj(S)?.segmentSeconds, pj(S)?.loudnorm], [1, false]);
  const p2 = await prepare(CH);
  check('preparing again queues nothing twice', [p2.queued.length, (await query<any>(`SELECT 1 FROM jobs WHERE type = 'vod.ladder' AND payload->>'accountId' = $1`, [ACC])).length], [0, 3]);
  check('they read as preparing', (await readinessWithLadder(CH)).items.filter((x) => x.state === 'preparing').map((x) => x.assetId).sort(), [B, C, S].sort());

  console.log('== a failed packaging is not retried on its own ==');
  await query(`DELETE FROM jobs WHERE type = 'vod.ladder' AND payload->>'vodAssetId' = $1`, [C]);
  await query(`UPDATE vod_asset_ladders SET state = 'failed', error = 'unreadable' WHERE vod_asset_id = $1`, [C]);
  check('the failure is shown', /failed: unreadable/.test(String((await readinessWithLadder(CH)).items.find((x) => x.assetId === C)?.why)), true);
  check('an automatic prepare leaves it', (await prepare(CH, { auto: true })).queued, []);
  check('the Prepare button retries it', (await prepare(CH)).queued, [C]);

  console.log('== the timeline ==');
  await query(`UPDATE vod_asset_ladders SET state = 'ready', master_key = '/clips/vod/b/ladders/x/4s/master.m3u8' WHERE vod_asset_id = $1`, [B]);
  const t0 = new Date(Date.now() - 60_000);
  for (const [i, id] of [A, B].entries()) {
    await query(`INSERT INTO programmes(channel_id,title,starts_at,ends_at,metadata) VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [CH, `P${i}`, new Date(t0.getTime() + i * 600_000).toISOString(), new Date(t0.getTime() + (i + 1) * 600_000).toISOString(), JSON.stringify({ vodAssetId: id, contentSec: 600 })]);
  }
  const tl: any = await timelineFor(CH, new Date(t0.getTime() - 1000), new Date(t0.getTime() + 1_300_000));
  const content = tl.items.filter((x: any) => x.kind === 'content');
  check('each asset plays its packaging for the ladder', content.map((x: any) => x.master), ['/clips/vod/a/master.m3u8', '/clips/vod/b/ladders/x/4s/master.m3u8']);
  check('the playout is handed the ladder', [tl.ladder?.groupId, tl.ladder?.rungs.map((r: any) => r.height)], [LG, [1080, 720, 480]]);

  console.log('== changing the ladder ==');
  const LG2 = (await one<any>(`INSERT INTO encode_ladder_groups(account_id,name,segment_dur,fps) VALUES ($1,'UHD',4,25) RETURNING id`, [ACC])).id;
  await query(`INSERT INTO encode_ladder_members(group_id,profile_id,ordinal) VALUES ($1,$2,0)`, [LG2, await prof(2160, 16000)]);
  await query(`UPDATE channels SET fast_ladder_group_id = $2 WHERE id = $1`, [CH, LG2]);
  const r2 = await readinessWithLadder(CH);
  check('the channel\'s own ladder wins', [r2.ladder?.groupName, r2.ladder?.inherited], ['UHD', false]);
  check('nothing is packaged to it yet, so nothing reads ready', r2.items.filter((x) => x.state === 'ready').length, 0);
  const tl2: any = await timelineFor(CH, new Date(t0.getTime() - 1000), new Date(t0.getTime() + 1_300_000));
  check('until it is, each asset keeps its own encode', tl2.items.filter((x: any) => x.kind === 'content').map((x: any) => x.master), ['/clips/vod/a/master.m3u8', '/clips/vod/b/master.m3u8']);
  check('an audio channel has no ladder', await (async () => { await query(`UPDATE channels SET fast_media = 'audio' WHERE id = $1`, [CH]); const l = await L.channelLadder(CH); await query(`UPDATE channels SET fast_media = 'video' WHERE id = $1`, [CH]); return l; })(), null);

  console.log('== the vod.ladder job ==');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(FAKE, { recursive: true });
  writeFileSync(join(FAKE, 'vod_encoder.py'), `import json, os, sys, shutil
cfg = json.load(open(sys.argv[1]))
if cfg.get("probe_only"):
    print(json.dumps({"ok": True, "width": 1920, "height": 800, "fps": 24, "durationMs": 600000, "hasVideo": True, "hasAudio": True}))
    sys.exit(0)
os.makedirs(cfg["out_dir"], exist_ok=True)
open(os.path.join(cfg["out_dir"], "master.m3u8"), "w").write("#EXTM3U\\n")
shutil.copy(sys.argv[1], os.path.join(os.path.dirname(cfg["out_dir"]), "seen-job.json"))
print("progress encode 50.0%")
print(json.dumps({"master": os.path.join(cfg["out_dir"], "master.m3u8"), "mpd": None, "zero_start": True}))
`);
  await query(`UPDATE channels SET fast_ladder_group_id = NULL WHERE id = $1`, [CH]);
  const { enqueue } = await import('../src/services/jobs/queue');
  const { handleVodLadder } = await import('../src/services/jobs/handlers/vodLadder');
  const job = await enqueue({ type: 'vod.ladder', payload: { vodAssetId: B, accountId: ACC, sourcePath: src, ladderGroupId: LG, segmentSeconds: 4, loudnorm: false }, dedupeKey: `t:${B}` });
  const pcts: number[] = [];
  const res: any = await handleVodLadder({ job: { ...job, attempts: 1 } as any, progress: async (n) => { pcts.push(n); }, isCancelled: () => false });
  const seen = JSON.parse(require('node:fs').readFileSync(join(ROOT, 'clips', 'vod', B, 'ladders', LG, '4s', 'seen-job.json'), 'utf8'));
  check('the encoder is asked for every rung, boxed, at the ladder\'s frame rate', [seen.fit, seen.fps, seen.segment_seconds, seen.ladder.map((r: any) => `${r.width}x${r.height}@${r.bitrate_kbps}`)],
    ['box', 25, 4, ['1920x1080@6000', '1280x720@3000', '854x480@1200']]);
  check('into its own folder beside the asset\'s encode, one per version of the ladder', /^\/clips\/vod\/[^/]+\/ladders\/[^/]+\/4s\/[0-9a-f]{8}\/master\.m3u8$/.test(res.master) && res.master.includes(`/${B}/ladders/${LG}/4s/`), true);
  const row = await one<any>(`SELECT state, origin, master_key, zero_start, notes FROM vod_asset_ladders WHERE vod_asset_id = $1 AND ladder_group_id = $2 AND segment_seconds = 4 AND NOT loudnorm`, [B, LG]);
  check('recorded against the asset', [row.state, row.origin, row.master_key, row.zero_start], ['ready', 'variant', res.master, true]);
  check('it says what it did to the picture and the frame rate', [row.notes.some((n: string) => /bars above and below/.test(n)), row.notes.some((n: string) => /25 fps/.test(n))], [true, true]);
  check('progress is reported', pcts[0], 2);
  check('the asset\'s own encode is untouched', (await one<any>(`SELECT master_key FROM vod_assets WHERE id = $1`, [B])).master_key, '/clips/vod/b/master.m3u8');
  await query(`DELETE FROM jobs WHERE type = 'vod.ladder' AND payload->>'vodAssetId' = $1`, [B]);   // the worker would have finished them
  check('and the scope film now reads ready', (await readinessWithLadder(CH)).items.find((x) => x.assetId === B)?.packaging, 'variant');

  console.log('== one ladder for ingest and FAST: fixed sizes ==');
  const E = await import('../src/services/encode/ladder');
  const base = { groupId: 'g', groupName: 'HD', rungs: HDR.map((r) => ({ ...r, fps: null })), segmentSeconds: 4, fps: 25, packaging: 'both' as const, codecBackend: 'x264' as const, capToSource: true, origin: { kind: 'members' as const } };
  const scaled = E.fitToSource({ ...base, frameMode: 'scale' }, { width: 1920, height: 800, fps: 24 });
  check('following the source, a scope film loses its 1080p rendition (what broke the channels)', scaled.kept.map((r) => r.height), [720, 480]);
  const boxed = E.fitToSource({ ...base, frameMode: 'box' }, { width: 1920, height: 800, fps: 24 });
  check('at fixed sizes it gets every rendition at its 16:9 size', [boxed.boxed, boxed.kept.map((r) => `${r.width}x${r.height}`), boxed.fps], [true, ['1920x1080', '1280x720', '854x480'], 25]);
  check('and says what it did', [boxed.notes.some((n) => /bars above and below/.test(n)), E.describeFit(boxed)], [true, '1080p, 720p, 480p (fixed sizes)']);
  const ladHD = (await L.channelLadder(CH))!;
  check('a title ingested at fixed sizes airs as it is, whatever its shape', L.mainMatches({ master_key: '/m.m3u8', encode_result: { zeroStart: true, segmentSeconds: 4, fps: 25, frame: 'box', kept: boxed.kept }, ingest: { probe: { video: { width: 1920, height: 800 } } } }, ladHD, { segmentSeconds: 4, loudnorm: false }), true);
  check('the same title scaled to its own shape does not', L.mainMatches({ master_key: '/m.m3u8', encode_result: { zeroStart: true, segmentSeconds: 4, fps: 25, kept: HDR }, ingest: { probe: { video: { width: 1920, height: 800 } } } }, ladHD, { segmentSeconds: 4, loudnorm: false }), false);
  check('the encoder is told to box the ingest encode', (await import('node:fs')).readFileSync(join(__dirname, '..', 'src', 'services', 'jobs', 'handlers', 'vodEncode.ts'), 'utf8').includes("fit.boxed ? { fit: 'box' }"), true);

  console.log('== the ladder changes ==');
  const onIt = await L.channelsOnLadder(ACC, LG);
  check('the channel is on the default ladder by default', onIt.map((c) => [c.name, c.inherited]), [['Movies', true]]);
  const vB = (await L.variantsOf([B], LG)).find((v) => Number(v.segment_seconds) === 4 && !v.loudnorm)!;
  check('a packaging made for the current renditions is current', L.isStale(vB, ladHD), false);
  check('a rendition changed: it is stale', L.isStale(vB, { ...ladHD, rungs: [{ height: 1080, width: 1920, bitrate_kbps: 8000 }, ...ladHD.rungs.slice(1)] }), true);
  check('the frame rate changed: stale', L.isStale(vB, { ...ladHD, fps: 50 }), true);
  await query(`UPDATE vod_asset_ladders SET rungs = '[{"height":1080,"width":1920,"bitrate_kbps":5000}]'::jsonb WHERE id = $1`, [vB.id]);
  check('readiness re-packages a stale one, and says why', /changed since it was packaged/.test(String((await readinessWithLadder(CH)).items.find((x) => x.assetId === B)?.why)), true);

  console.log('== the encoder and the playout ==');
  const py = (code: string) => { const r = spawnSync('python3', ['-c', code], { cwd: ENC, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : `ERR ${r.stderr.slice(-400)}`; };
  check('a boxed rung scales to fit and pads to 1920x1080', py(`
import vod_encoder as v
cmd, parts, _ = v.build_encode_cmd({"input":"x.mp4","segment_seconds":4,"fps":25,"fit":"box","has_audio":False,"ladder":[{"height":1080,"width":1920,"bitrate_kbps":6000},{"height":480,"width":854,"bitrate_kbps":1200}]}, "/tmp")
print([cmd[i+1] for i,c in enumerate(cmd) if c=="-vf"])`),
    "['scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1', 'scale=854:480:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=854:480:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1']");
  check('a main encode is not boxed', py(`
import vod_encoder as v
cmd, parts, _ = v.build_encode_cmd({"input":"x.mp4","segment_seconds":4,"fps":25,"has_audio":False,"ladder":[{"height":720,"bitrate_kbps":3000}]}, "/tmp")
print([cmd[i+1] for i,c in enumerate(cmd) if c=="-vf"])`), "['scale=-2:720']");
  check('the playout master takes a rung no asset has yet from the ladder, not the nearest rung', py(`
import fast_playout as f
class T: pass
class A:
    def track(self, n):
        t = T(); t.meta = {"height": 720, "width": 1280, "bandwidth": 3500000, "codecs": "avc1.64001f,mp4a.40.2"}; return t
lad = {"rungs": [{"height": 1080, "width": 1920, "bitrate_kbps": 6000}, {"height": 720, "width": 1280, "bitrate_kbps": 3000}]}
m = f.master_playlist(A(), ["v1080", "v720", "audio"], lad)
print([l.split(",RESOLUTION=")[1].split(",")[0] for l in m.splitlines() if l.startswith("#EXT-X-STREAM-INF")])`), "['1920x1080', '1280x720']");

  await query(`DELETE FROM jobs WHERE payload->>'accountId' = $1`, [ACC]);
  await query(`DELETE FROM programmes WHERE channel_id = $1`, [CH]);
  await query(`DELETE FROM accounts WHERE id = $1`, [ACC]);
  await pool.end();
  rmSync(ROOT, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
