// ============================================================================
//  HYBRID SITES 4e: A RE-ENCODE OF A SITE-KEPT ORIGINAL GOES TO ITS SITE
//  (build queue H4-5; services/fast/prepare.ts, services/sites/siteEncode.ts).
//
//  An asset made by Encode at site (H4-3) has no original in the cloud: its
//  place at the site is `ingest.siteSource`. When a FAST channel needs that
//  asset encoded again (splice-aligned, broadcast loudness, 1 s segments for
//  a slate or loop), the encode is queued at the site with requestSiteEncode,
//  never as a cloud vod.encode with no source:
//    - readiness says it needs preparing, and that the site does it;
//    - Prepare queues the probe in the site's pool with the site path and the
//      role's settings (loudness for a house spot, 1 s for a slate); no cloud
//      encode is queued; while it runs the asset reads as preparing and a
//      second Prepare queues nothing;
//    - a disabled site is said in the skipped list, nothing is queued;
//    - an asset with no original anywhere is still "no source";
//    - on a channel with a ladder, packaging to the ladder is not done at a
//      site: it is said, and it airs on its own encode;
//    - "Encode again" (retry) of a failed site encode stays in the site pool.
//  The carrying-over of a FAST channel's ladder packages when the site's new
//  package is swapped in is checked in site-encode.check.ts (it needs the
//  real encoder).
//
//  Needs Postgres (DATABASE_URL, migrations applied).
//  Usage: npx tsx test/site-reencode.check.ts
// ============================================================================
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };

const ROOT = mkdtempSync(join(tmpdir(), 'site-reencode-'));
process.env.CLIPS_DIR = join(ROOT, 'clips');
process.env.VOD_STORE = 'local';

async function main() {
  const { query, one, pool } = await import('../src/db');
  const { readinessWithLadder, prepare } = await import('../src/services/fast/prepare');
  const Q = await import('../src/services/jobs/queue');

  const ACC = randomUUID(), GRP = randomUUID(), AUDIO = randomUUID(), VIDEO = randomUUID();
  await query(`INSERT INTO accounts(id,name,licences) VALUES ($1,'SiteCo','{hybrid_sites}')`, [ACC]);
  await query(`INSERT INTO groups(id,account_id,name) VALUES ($1,$2,'G')`, [GRP, ACC]);
  const SITE = (await one<any>(`INSERT INTO sites(account_id,name) VALUES ($1,'Main broadcast centre') RETURNING id`, [ACC])).id as string;
  await query(`INSERT INTO channels(id,group_id,name,status,tz,kind,origin,fast_media) VALUES ($1,$2,'Talk','ended','UTC','tv','playlist','audio')`, [AUDIO, GRP]);

  const atSite = (path: string) => ({ siteSource: { siteId: SITE, folderId: randomUUID(), sitePath: path, objectKey: path.split('/').pop() } });
  const asset = async (title: string, ingest: any, sourceKey: string | null = null) => (await one<any>(
    `INSERT INTO vod_assets(account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, master_key, source_key, encode_result, ingest, media_state)
     VALUES ($1,'watchfolder','export',$2,0,0,600000,$3,$4,$5::jsonb,$6::jsonb,'ready') RETURNING id`,
    [ACC, title, `/clips/vod/${title}/master.m3u8`, sourceKey, JSON.stringify({ zeroStart: false, segmentSeconds: 4 }), JSON.stringify(ingest)])).id as string;
  const K = await asset('kept', atSite('/mnt/news/drop/kept.mp4'));
  const H = await asset('house', atSite('/mnt/news/drop/house.mp4'));
  const S = await asset('slate', atSite('/mnt/news/drop/slate.mp4'));
  const N = await asset('nowhere', {});
  await query(`INSERT INTO fast_lineups(channel_id,name,epoch,zone,status,slots) VALUES ($1,'Main',now(),'UTC','draft',$2::jsonb)`,
    [AUDIO, JSON.stringify([{ id: 's1', kind: 'title', pool: [{ assetId: K }] }, { id: 's2', kind: 'title', pool: [{ assetId: N }] }])]);
  await query(`INSERT INTO channel_ads(channel_id, house_ads, policy) VALUES ($1,$2::jsonb,$3::jsonb)`, [AUDIO, JSON.stringify([{ assetId: H }]), JSON.stringify({ slateAssetId: S })]);

  console.log('== readiness: an original kept at a site ==');
  const r1 = await readinessWithLadder(AUDIO);
  const by = (id: string) => r1.items.find((x) => x.assetId === id)!;
  ok(r1.ladder === null, 'an audio channel has no ladder: each asset is encoded on its own');
  ok(by(K).state === 'needs-prepare' && /encoded again at the site that keeps the original/.test(String(by(K).why)), 'the site-kept asset needs preparing, and the site does it (it was "no source")', by(K));
  ok(by(N).state === 'no-source' && /not on this server/.test(String(by(N).why)), 'an asset with no original anywhere is still no source', by(N));

  console.log('== Prepare sends it to the site ==');
  const p1 = await prepare(AUDIO);
  ok([K, H, S].every((id) => p1.queued.includes(id)) && !p1.queued.includes(N), 'the three site-kept assets are queued, the one with no original is not', p1.queued);
  const jobs = await query<any>(`SELECT type, pool, payload FROM jobs WHERE payload->>'vodAssetId' = ANY($1::text[])`, [[K, H, S, N]]);
  const jobOf = (id: string) => jobs.filter((j) => j.payload.vodAssetId === id);
  ok(jobs.every((j) => j.type === 'site.vod-probe' && j.pool === Q.sitePool(SITE)), 'every job is a probe in the site pool; no cloud vod.encode', jobs.map((j) => [j.type, j.pool]));
  ok(jobOf(K).length === 1 && jobOf(K)[0].payload.sitePath === '/mnt/news/drop/kept.mp4' && jobOf(K)[0].payload.siteId === SITE, 'the probe names the file where the site keeps it', jobOf(K)[0]?.payload);
  ok(jobOf(K)[0]?.payload.loudnorm === false && jobOf(K)[0]?.payload.segmentSeconds === null, 'content: the channel default segments, no loudness pass', jobOf(K)[0]?.payload);
  ok(jobOf(H)[0]?.payload.loudnorm === true, 'a house spot: broadcast loudness', jobOf(H)[0]?.payload);
  ok(jobOf(S)[0]?.payload.segmentSeconds === 1, 'the slate: 1 s segments', jobOf(S)[0]?.payload);
  ok(jobOf(N).length === 0, 'nothing is queued for the asset with no original');
  const k = await one<any>(`SELECT media_state, encode_job_id, source_key FROM vod_assets WHERE id = $1`, [K]);
  ok(k.media_state === 'processing' && k.encode_job_id && k.source_key === null, 'the asset follows the site encode (Processing until the cloud verifies the package)', k);

  console.log('== while it runs ==');
  const r2 = await readinessWithLadder(AUDIO);
  ok(r2.items.find((x) => x.assetId === K)?.state === 'preparing' && r2.items.find((x) => x.assetId === K)?.why === 'encoding', 'a site encode in flight reads as preparing', r2.items.find((x) => x.assetId === K));
  const p2 = await prepare(AUDIO);
  const n2 = (await one<any>(`SELECT count(*)::int AS n FROM jobs WHERE payload->>'vodAssetId' = ANY($1::text[])`, [[K, H, S]])).n;
  ok(!p2.queued.length && n2 === 3, 'a second Prepare queues nothing more', [p2.queued, n2]);
  // the probe done, the encode queued at the site: still preparing
  await query(`UPDATE jobs SET state = 'succeeded' WHERE type = 'site.vod-probe' AND payload->>'vodAssetId' = $1`, [K]);
  const enc = await Q.enqueue({ type: 'site.vod-encode', pool: Q.sitePool(SITE), payload: { vodAssetId: K, accountId: ACC, siteId: SITE, sitePath: '/mnt/news/drop/kept.mp4' }, dedupeKey: `site.vod-encode:${K}` });
  ok((await readinessWithLadder(AUDIO)).items.find((x) => x.assetId === K)?.state === 'preparing', 'and so is the encode that follows the probe');

  console.log('== Encode again ==');
  await query(`UPDATE jobs SET state = 'failed', last_error = 'disk full at the site' WHERE id = $1`, [enc.id]);
  await query(`UPDATE vod_assets SET encode_job_id = $2, media_state = 'failed' WHERE id = $1`, [K, enc.id]);
  ok(await Q.retry(enc.id), 'the failed site encode can be retried (the asset page\'s Encode again)');
  const again = await one<any>(`SELECT state, pool, type FROM jobs WHERE id = $1`, [enc.id]);
  ok(again.state === 'queued' && again.pool === Q.sitePool(SITE) && again.type === 'site.vod-encode', 'it waits in the site pool again, not for a cloud worker', again);
  ok((await Q.claim(['site.vod-encode', 'site.vod-probe', 'vod.encode'], 'cloud-worker')) === null, 'no cloud worker takes it');

  console.log('== a site that cannot take it ==');
  const D = await asset('disabled', atSite('/mnt/news/drop/d.mp4'));
  await query(`UPDATE fast_lineups SET slots = slots || $2::jsonb WHERE channel_id = $1`, [AUDIO, JSON.stringify([{ id: 's3', kind: 'title', pool: [{ assetId: D }] }])]);
  await query(`UPDATE sites SET status = 'disabled' WHERE id = $1`, [SITE]);
  const p3 = await prepare(AUDIO);
  const sk = p3.skipped.find((x) => x.assetId === D);
  ok(!p3.queued.includes(D) && sk && /site that keeps the original cannot take it: This site is disabled/.test(String(sk.why)), 'a disabled site: said in the skipped list, not queued', sk);
  ok((await one<any>(`SELECT count(*)::int AS n FROM jobs WHERE payload->>'vodAssetId' = $1`, [D])).n === 0, 'and no job, in the cloud or the site');
  await query(`UPDATE sites SET status = 'active' WHERE id = $1`, [SITE]);

  console.log('== a channel with a ladder ==');
  const prof = async (h: number, kb: number) => (await one<any>(`INSERT INTO encode_profiles(account_id,name,height,bitrate_kbps) VALUES ($1,$2,$3,$4) RETURNING id`, [ACC, `${h}p`, h, kb])).id;
  const LG = (await one<any>(`INSERT INTO encode_ladder_groups(account_id,name,is_default,segment_dur,fps) VALUES ($1,'HD',true,4,25) RETURNING id`, [ACC])).id;
  for (const [i, [h, kb]] of [[1080, 6000], [720, 3000]].entries()) await query(`INSERT INTO encode_ladder_members(group_id,profile_id,ordinal) VALUES ($1,$2,$3)`, [LG, await prof(h, kb), i]);
  await query(`INSERT INTO channels(id,group_id,name,status,tz,kind,origin,fast_media) VALUES ($1,$2,'Movies','ended','UTC','tv','playlist','video')`, [VIDEO, GRP]);
  const V = await asset('film', { ...atSite('/mnt/news/drop/film.mp4'), probe: { video: { width: 1920, height: 1080, bitrateKbps: 8000 } } });
  await query(`INSERT INTO fast_lineups(channel_id,name,epoch,zone,status,slots) VALUES ($1,'Main',now(),'UTC','draft',$2::jsonb)`, [VIDEO, JSON.stringify([{ id: 's1', kind: 'title', pool: [{ assetId: V }] }])]);
  const r4 = await readinessWithLadder(VIDEO);
  const v = r4.items.find((x) => x.assetId === V)!;
  ok(r4.ladder?.groupName === 'HD' && v.state === 'no-source' && /kept at a site, which encodes it only to its own ladder, so it airs on its own encode/.test(String(v.why)), 'packaging to the channel ladder is not done at a site: said, and it airs on its own encode', v);
  const p4 = await prepare(VIDEO);
  ok(!p4.queued.length && (await one<any>(`SELECT count(*)::int AS n FROM jobs WHERE payload->>'vodAssetId' = $1`, [V])).n === 0, 'Prepare queues nothing for it (no vod.ladder without a source)', p4.queued);

  await pool.end();
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
