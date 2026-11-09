// ============================================================================
//  HYBRID SITES 4f: A FAST CHANNEL'S LADDER VARIANT MADE AT A SITE
//  (build queue H4-6 (b); services/sites/siteEncode.ts, services/fast/prepare.ts,
//  services/jobs/handlers/vodLadder.ts).
//
//  An asset made by Encode at site keeps its original at the site
//  (`ingest.siteSource`). A FAST channel with a ladder needs every asset
//  packaged to that ladder (a variant beside the asset's own encode). Before
//  this item such an asset was "no source" and aired on its own encode; now
//  the variant is made at the site:
//    - readiness says it needs preparing, at the site;
//    - Prepare queues site.vod-probe in the site pool with `variant` (the
//      ladder, the role's segments and loudness); no cloud vod.ladder; the
//      variant's row is queued; the asset is NOT put into Processing;
//    - the probe judged in the cloud queues site.vod-encode with vod.ladder's
//      own settings: every rung, the 16:9 box, the ladder's frame rate, its
//      folder ladders/<group>/<seg>s[-loud]/<version>;
//    - while it runs the asset reads "packaging to <ladder>", and a second
//      Prepare queues nothing; the asset's own encode can run beside it;
//    - a package with the wrong number of renditions does not verify;
//    - a verified package lands in the variant folder, the row is ready with
//      its master, rungs, frame rate and notes; the asset's own master,
//      state and encode result are untouched; readiness says ready (variant);
//    - a failed last attempt fails the variant's row, never the asset;
//    - a disabled site is said in the skipped list.
//
//  Needs Postgres (DATABASE_URL, migrations applied). No encoder: the package
//  is written by the test.
//  Usage: npx tsx test/site-ladder-variant.check.ts
// ============================================================================
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };

const ROOT = mkdtempSync(join(tmpdir(), 'site-variant-'));
process.env.CLIPS_DIR = join(ROOT, 'clips');
process.env.VOD_STORE = 'local';

/** A finished HLS and DASH package with `rungs` renditions of `segs` segments. */
function packageFiles(rungs: number[], segs: number, packaging: string): Record<string, string> {
  const f: Record<string, string> = {};
  if (packaging !== 'dash') {
    f['master.m3u8'] = '#EXTM3U\n' + rungs.map((h) => `#EXT-X-STREAM-INF:BANDWIDTH=${h * 1000},RESOLUTION=${Math.round(h * 16 / 9)}x${h}\nv${h}/index.m3u8`).join('\n') + '\n';
    for (const h of rungs) {
      f[`v${h}/index.m3u8`] = `#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.mp4"\n` + Array.from({ length: segs }, (_, i) => `#EXTINF:4.0,\nseg_${i + 1}.m4s`).join('\n') + '\n#EXT-X-ENDLIST\n';
      f[`v${h}/init.mp4`] = `init ${h}`;
      for (let i = 1; i <= segs; i++) f[`v${h}/seg_${i}.m4s`] = `segment ${h} ${i}`;
    }
  }
  if (packaging !== 'hls') f['manifest.mpd'] = '<?xml version="1.0"?>\n<MPD type="static" mediaPresentationDuration="PT8S"></MPD>\n';
  return f;
}

async function main() {
  const { query, one, pool } = await import('../src/db');
  const { readinessWithLadder, prepare } = await import('../src/services/fast/prepare');
  const Q = await import('../src/services/jobs/queue');
  const E = await import('../src/services/sites/siteEncode');
  const { outDirFor } = await import('../src/services/jobs/handlers/vodEncode');

  const ACC = randomUUID(), GRP = randomUUID(), CH = randomUUID();
  await query(`INSERT INTO accounts(id,name,licences) VALUES ($1,'SiteCo','{hybrid_sites}')`, [ACC]);
  await query(`INSERT INTO groups(id,account_id,name) VALUES ($1,$2,'G')`, [GRP, ACC]);
  const SITE = (await one<any>(`INSERT INTO sites(account_id,name) VALUES ($1,'Main broadcast centre') RETURNING id`, [ACC])).id as string;
  const prof = async (h: number, kb: number) => (await one<any>(`INSERT INTO encode_profiles(account_id,name,height,bitrate_kbps) VALUES ($1,$2,$3,$4) RETURNING id`, [ACC, `${h}p`, h, kb])).id;
  const LG = (await one<any>(`INSERT INTO encode_ladder_groups(account_id,name,is_default,segment_dur,fps) VALUES ($1,'HD',true,4,25) RETURNING id`, [ACC])).id as string;
  for (const [i, [h, kb]] of [[1080, 6000], [720, 3000]].entries()) await query(`INSERT INTO encode_ladder_members(group_id,profile_id,ordinal) VALUES ($1,$2,$3)`, [LG, await prof(h, kb), i]);
  await query(`INSERT INTO channels(id,group_id,name,status,tz,kind,origin,fast_media) VALUES ($1,$2,'Movies','ended','UTC','tv','playlist','video')`, [CH, GRP]);

  const atSite = (path: string) => ({ siteSource: { siteId: SITE, folderId: randomUUID(), sitePath: path, objectKey: path.split('/').pop() }, probe: { video: { width: 2048, height: 858, bitrateKbps: 9000 } } });
  const asset = async (title: string, ingest: any, sourceKey: string | null = null) => (await one<any>(
    `INSERT INTO vod_assets(account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, master_key, source_key, encode_result, ingest, media_state)
     VALUES ($1,'watchfolder','export',$2,0,0,8000,$3,$4,$5::jsonb,$6::jsonb,'ready') RETURNING id`,
    [ACC, title, `/clips/vod/${title}/master.m3u8`, sourceKey, JSON.stringify({ zeroStart: true, segmentSeconds: 6, kept: [{ height: 858, bitrate_kbps: 5000 }] }), JSON.stringify(ingest)])).id as string;
  const F = await asset('film', atSite('/mnt/news/drop/film.mxf'));
  const H = await asset('spot', atSite('/mnt/news/drop/spot.mxf'));
  const N = await asset('nowhere', {});
  await query(`INSERT INTO fast_lineups(channel_id,name,epoch,zone,status,slots) VALUES ($1,'Main',now(),'UTC','draft',$2::jsonb)`,
    [CH, JSON.stringify([{ id: 's1', kind: 'title', pool: [{ assetId: F }] }, { id: 's2', kind: 'title', pool: [{ assetId: N }] }])]);
  await query(`INSERT INTO channel_ads(channel_id, house_ads, policy) VALUES ($1,$2::jsonb,'{}'::jsonb)`, [CH, JSON.stringify([{ assetId: H }])]);

  console.log('== readiness: a site-kept original on a channel with a ladder ==');
  const r1 = await readinessWithLadder(CH);
  const by = (r: typeof r1, id: string) => r.items.find((x) => x.assetId === id)!;
  ok(r1.ladder?.groupName === 'HD', 'the channel has the HD ladder');
  ok(by(r1, F).state === 'needs-prepare' && /not yet packaged to the channel's ladder/.test(String(by(r1, F).why)) && /packaged at the site that keeps the original/.test(String(by(r1, F).why)), 'the site-kept film needs packaging, and the site does it (it was "no source")', by(r1, F));
  ok(by(r1, N).state === 'no-source' && /not on this server/.test(String(by(r1, N).why)), 'an asset with no original anywhere is still no source', by(r1, N));

  console.log('== Prepare sends the variant to the site ==');
  const p1 = await prepare(CH);
  ok(p1.queued.includes(F) && p1.queued.includes(H) && !p1.queued.includes(N), 'the two site-kept assets are queued, the one with no original is not', p1.queued);
  const jobs = await query<any>(`SELECT id, type, pool, payload, dedupe_key, channel_id FROM jobs WHERE payload->>'vodAssetId' = ANY($1::text[])`, [[F, H, N]]);
  const jf = jobs.find((j) => j.payload.vodAssetId === F), jh = jobs.find((j) => j.payload.vodAssetId === H);
  ok(jobs.length === 2 && jobs.every((j) => j.type === 'site.vod-probe' && j.pool === Q.sitePool(SITE)), 'two probes in the site pool; no cloud vod.ladder or vod.encode', jobs.map((j) => [j.type, j.pool]));
  ok(jf?.payload.variant?.ladderGroupId === LG && jf.payload.variant.segmentSeconds === 4 && jf.payload.variant.loudnorm === false && jf.payload.sitePath === '/mnt/news/drop/film.mxf', 'the film\'s probe carries the variant: the HD ladder, 4 s, no loudness pass, and the site path', jf?.payload);
  ok(jh?.payload.variant?.loudnorm === true, 'the house spot\'s variant asks for broadcast loudness', jh?.payload.variant);
  ok(jf?.channel_id === CH && /:ladders\//.test(String(jf?.dedupe_key)), 'the job is the channel\'s, keyed per variant (beside the asset\'s own encode)', [jf?.channel_id, jf?.dedupe_key]);
  const row1 = await one<any>(`SELECT state, job_id, origin FROM vod_asset_ladders WHERE vod_asset_id = $1 AND ladder_group_id = $2`, [F, LG]);
  ok(row1?.state === 'queued' && row1.job_id === jf?.id && row1.origin === 'variant', 'the variant\'s row is queued with the site job', row1);
  const a1 = await one<any>(`SELECT media_state, encode_job_id, master_key FROM vod_assets WHERE id = $1`, [F]);
  ok(a1.media_state === 'ready' && a1.encode_job_id === null && a1.master_key === '/clips/vod/film/master.m3u8', 'the asset is not put into Processing: it keeps playing its own encode', a1);

  console.log('== while it runs ==');
  const r2 = await readinessWithLadder(CH);
  ok(by(r2, F).state === 'preparing' && /packaging to HD/.test(String(by(r2, F).why)), 'the asset reads as packaging to the ladder', by(r2, F));
  const p2 = await prepare(CH);
  ok(!p2.queued.length && (await one<any>(`SELECT count(*)::int AS n FROM jobs WHERE payload->>'vodAssetId' = ANY($1::text[])`, [[F, H]])).n === 2, 'a second Prepare queues nothing more', p2.queued);
  // the asset's own encode at the site can be queued beside the variant
  const own = await E.requestSiteEncode({ vodAssetId: H, accountId: ACC, siteId: SITE, sitePath: '/mnt/news/drop/spot.mxf' });
  ok(own.type === 'site.vod-probe' && own.id !== jh?.id && !own.payload.variant, 'the asset\'s own site encode is a job of its own, not deduplicated into the variant', own.payload);
  await query(`DELETE FROM jobs WHERE id = $1`, [own.id]);
  await query(`UPDATE vod_assets SET media_state = 'ready', encode_job_id = NULL WHERE id = $1`, [H]);

  console.log('== the probe, planned in the cloud ==');
  const probe = { ok: true, width: 2048, height: 858, fps: 24, durationMs: 8000, hasVideo: true, hasAudio: true, videoCodec: 'h264' };
  await query(`UPDATE jobs SET state = 'running', attempts = 1 WHERE id = $1`, [jf.id]);
  const probeJob = (await Q.getJob(jf.id))!;
  const v1 = await E.judgeSiteEncode(probeJob, { probe });
  ok(v1.ok === true, 'the probe is accepted', v1);
  if (v1.ok) await v1.apply();
  await query(`UPDATE jobs SET state = 'succeeded' WHERE id = $1`, [jf.id]);
  const enc0 = await one<any>(`SELECT * FROM jobs WHERE type = 'site.vod-encode' AND payload->>'vodAssetId' = $1`, [F]);
  const st = enc0?.payload?.encoder ?? {};
  ok(enc0 && enc0.pool === Q.sitePool(SITE) && enc0.channel_id === CH, 'the encode is queued in the site pool, for the channel', enc0 && [enc0.pool, enc0.channel_id]);
  ok(st.fit === 'box' && st.fps === 25 && st.segment_seconds === 4 && st.loudnorm === false, 'vod.ladder\'s settings: the 16:9 box, the ladder\'s 25 fps (source 24), 4 s', st);
  ok(Array.isArray(st.ladder) && st.ladder.map((x: any) => `${x.width}x${x.height}@${x.bitrate_kbps}`).join(',') === '1920x1080@6000,1280x720@3000', 'every rung of the ladder at its own size (not fitted to the 858-line source)', st.ladder);
  ok(!('input' in st) && !('out_dir' in st) && !('work_dir' in st), 'no paths in the settings: the site fills those in');
  const vv = enc0?.payload?.variant ?? {};
  ok(/^ladders\/[0-9a-f-]{36}\/4s\/[0-9a-f]{8}$/.test(String(vv.rel)) && String(vv.rel).startsWith(`ladders/${LG}/4s/`), 'the variant\'s folder is vod.ladder\'s: ladders/<group>/4s/<version>', vv.rel);
  ok(Array.isArray(vv.notes) && vv.notes.some((n: string) => /not 16:9/.test(n)) && vv.notes.some((n: string) => /24 fps/.test(n)), 'the notes say the picture is boxed and the frame rate changed', vv.notes);
  ok(!enc0?.payload?.plan, 'no asset encode plan in a variant job');
  const row2 = await one<any>(`SELECT state, job_id FROM vod_asset_ladders WHERE vod_asset_id = $1 AND ladder_group_id = $2`, [F, LG]);
  ok(row2?.state === 'encoding' && row2.job_id === enc0?.id, 'the row follows the encode job', row2);
  ok(by(await readinessWithLadder(CH), F).state === 'preparing', 'still packaging while the site encodes');

  // a probe of a file with no picture fails the variant for good
  await query(`UPDATE jobs SET state = 'running', attempts = 1 WHERE id = $1`, [jh.id]);
  const v2 = await E.judgeSiteEncode((await Q.getJob(jh.id))!, { probe: { ...probe, hasVideo: false } });
  ok(v2.ok === false && v2.code === 'no_video' && v2.permanent === true, 'an audio-only file cannot go on a video ladder: refused for good', v2);

  console.log('== the package ==');
  const packaging = String(st.packaging ?? 'both');
  const stageIt = async (attempt: number, rungs: number[]) => {
    await query(`UPDATE jobs SET state = 'running', attempts = $2, payload = payload - 'declared' - 'staging' WHERE id = $1`, [enc0.id, attempt]);
    const j = (await Q.getJob(enc0.id))!;
    const files = packageFiles(rungs, 2, packaging);
    const list = Object.entries(files).map(([path, body]) => ({ path, bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') }));
    const d = E.declareOutputs(j, list);
    for (const [path, body] of Object.entries(files)) { const t = join(d.staging, ...path.split('/')); mkdirSync(dirname(t), { recursive: true }); writeFileSync(t, body); }
    await query(`UPDATE jobs SET payload = payload || jsonb_build_object('declared', $2::jsonb, 'staging', $3::text) WHERE id = $1`, [enc0.id, JSON.stringify(d.declared), d.staging]);
    return { job: (await Q.getJob(enc0.id))!, staging: d.staging };
  };
  const bad = await stageIt(1, [1080]);
  const v3 = await E.judgeSiteEncode(bad.job, { encoder: { zero_start: true } });
  ok(v3.ok === false && v3.code === 'verification_failed' && /lists 1 rendition\(s\); the plan has 2/.test(v3.message), 'one rendition where the ladder has two: does not verify, and says so', v3);
  ok(!existsSync(bad.staging), 'the refused upload is discarded');

  const good = await stageIt(2, [1080, 720]);
  const v4 = await E.judgeSiteEncode(good.job, { encoder: { zero_start: true } });
  ok(v4.ok === true, 'the full ladder verifies', v4);
  if (v4.ok) await v4.apply();
  const outDir = join(outDirFor(F), ...String(vv.rel).split('/'));
  ok(existsSync(join(outDir, packaging === 'dash' ? 'manifest.mpd' : 'master.m3u8')) && !existsSync(good.staging), 'the package is in the variant\'s folder under the asset, the staging folder gone', outDir);
  if (packaging !== 'dash') ok(readFileSync(join(outDir, 'v720/seg_2.m4s'), 'utf8') === 'segment 720 2', 'the bytes are the ones the site uploaded');
  const row3 = await one<any>(`SELECT * FROM vod_asset_ladders WHERE vod_asset_id = $1 AND ladder_group_id = $2 AND segment_seconds = 4 AND loudnorm = false`, [F, LG]);
  ok(row3?.state === 'ready' && row3.origin === 'variant' && row3.zero_start === true && row3.job_id === enc0.id, 'the variant\'s row is ready, splice-aligned, from the site job', row3 && [row3.state, row3.origin, row3.zero_start]);
  ok(packaging === 'dash' || row3?.master_key === `/clips/vod/${F}/${vv.rel}/master.m3u8`, 'its master is the variant folder\'s playlist', row3?.master_key);
  ok(Array.isArray(row3?.rungs) && row3.rungs.length === 2 && Number(row3.fps) === 25 && (row3.notes ?? []).some((n: string) => /packaged at the site/.test(n)), 'rungs, frame rate and a note that the site made it are recorded', row3 && [row3.rungs, row3.fps, row3.notes]);
  const a2 = await one<any>(`SELECT media_state, master_key, encode_result, encode_job_id FROM vod_assets WHERE id = $1`, [F]);
  ok(a2.media_state === 'ready' && a2.master_key === '/clips/vod/film/master.m3u8' && Number(a2.encode_result?.segmentSeconds) === 6 && !a2.encode_result?.encodedAt && a2.encode_job_id === null, 'the asset\'s own encode, state and encode result are untouched', a2);
  // siteJobs.complete marks the job succeeded once apply() has run
  await query(`UPDATE jobs SET state = 'succeeded' WHERE id = $1`, [enc0.id]);
  const r3 = await readinessWithLadder(CH);
  ok(by(r3, F).state === 'ready' && by(r3, F).packaging === 'variant', 'readiness: ready, from the variant', by(r3, F));

  console.log('== a failed last attempt ==');
  const Gid = await asset('doc', atSite('/mnt/news/drop/doc.mxf'));
  await query(`UPDATE fast_lineups SET slots = slots || $2::jsonb WHERE channel_id = $1`, [CH, JSON.stringify([{ id: 's3', kind: 'title', pool: [{ assetId: Gid }] }])]);
  const p3 = await prepare(CH);
  ok(p3.queued.includes(Gid), 'a third asset is queued at the site');
  const jg = (await one<any>(`SELECT * FROM jobs WHERE payload->>'vodAssetId' = $1`, [Gid]));
  await E.siteEncodeAttemptFailed(jg, 'disk full at the site', 'encoder_failed', true);
  const row4 = await one<any>(`SELECT state, error FROM vod_asset_ladders WHERE vod_asset_id = $1`, [Gid]);
  ok(row4?.state === 'failed' && /packaging at the site failed: disk full at the site/.test(String(row4.error)), 'the variant\'s row fails with the reason', row4);
  const a3 = await one<any>(`SELECT media_state, media_error FROM vod_assets WHERE id = $1`, [Gid]);
  ok(a3.media_state === 'ready' && a3.media_error === null, 'the asset does not fail: it still airs nothing broken and keeps its own encode', a3);
  await query(`UPDATE jobs SET state = 'failed' WHERE id = $1`, [jg.id]);
  const r4 = await readinessWithLadder(CH);
  ok(by(r4, Gid).state === 'needs-prepare' && by(r4, Gid).failed === true && /failed: packaging at the site failed/.test(String(by(r4, Gid).why)), 'readiness says the packaging failed, and Prepare may try again', by(r4, Gid));
  const p4 = await prepare(CH, { auto: true });
  ok(!p4.queued.includes(Gid), 'an automatic Prepare does not retry a failed variant on its own');

  console.log('== a site that cannot take it ==');
  await query(`UPDATE sites SET status = 'disabled' WHERE id = $1`, [SITE]);
  const p5 = await prepare(CH);
  const sk = p5.skipped.find((x) => x.assetId === Gid);
  ok(!p5.queued.includes(Gid) && sk && /site that keeps the original cannot take it: This site is disabled/.test(String(sk.why)), 'a disabled site: said in the skipped list, not queued', sk);

  await pool.end();
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
