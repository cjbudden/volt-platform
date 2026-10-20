// ============================================================================
//  RETENTION ON S3, against a real S3 API (moto, MinIO, LocalStack or AWS).
//
//  The S3 storage driver (src/services/media/s3Driver.ts) with the real AWS
//  SDK: upload a clip tree, size it, cool it (storage class change in place),
//  archive and restore it, and then the retention sweep itself deleting an
//  asset's S3 copy by rule and reclaiming an ownerless one, leaving tombstones.
//  Also the pure parts (URI and restore-header parsing) and the safety rule
//  that a location never reaches a sibling prefix.
//
//  Skips (passes) when no endpoint is given, so `npm run check` stays offline:
//    moto_server -p 5055 &
//    MEDIA_S3_TEST_BUCKET=volt-media AWS_ENDPOINT_URL_S3=http://127.0.0.1:5055 \
//    S3_FORCE_PATH_STYLE=1 AWS_ACCESS_KEY_ID=x AWS_SECRET_ACCESS_KEY=x \
//    DATABASE_URL=... npx tsx test/s3Retention.check.ts
// ============================================================================
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, extra = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (extra ? ` -- ${extra}` : '')); } };

async function pure() {
  const { parseS3Uri, parseRestoreHeader, STORAGE_CLASS } = await import('../src/services/media/s3Driver');
  ok(JSON.stringify(parseS3Uri('s3://b/clips/a/')) === JSON.stringify({ bucket: 'b', key: 'clips/a/', prefix: true }), 'parse: trailing slash is a prefix');
  ok(parseS3Uri('s3://b/clips/a.mp4')?.prefix === false, 'parse: no slash is one object');
  ok(parseS3Uri('s3://b/') === null && parseS3Uri('s3://b') === null, 'parse: the bucket root is never a location');
  ok(parseS3Uri('/var/clips/a') === null, 'parse: a local path is not S3');
  const r = parseRestoreHeader('ongoing-request="false", expiry-date="Fri, 23 Oct 2026 00:00:00 GMT"');
  ok(r?.ongoing === false && r?.expiresAt?.toISOString() === '2026-10-23T00:00:00.000Z', 'restore header: finished, with expiry');
  ok(parseRestoreHeader('ongoing-request="true"')?.ongoing === true, 'restore header: in progress');
  ok(parseRestoreHeader(undefined) === null, 'restore header: none');
  ok(STORAGE_CLASS.s3_glacier_ir === 'GLACIER_IR' && STORAGE_CLASS.s3_deep_archive === 'DEEP_ARCHIVE', 'tiers map to S3 storage classes');
}

function clipTree(): string {
  const d = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'volt-s3ret-'));
  mkdirSync(join(d, 'hls'));
  writeFileSync(join(d, 'hls', 'index.m3u8'), '#EXTM3U\n#EXT-X-ENDLIST\n');
  writeFileSync(join(d, 'hls', 'seg_1.m4s'), Buffer.alloc(1000, 1));
  writeFileSync(join(d, 'hls', 'seg_2.m4s'), Buffer.alloc(500, 2));
  writeFileSync(join(d, 'clip.mp4'), Buffer.alloc(2048, 3));
  return d;
}

async function main() {
  await pure();
  const BUCKET = process.env.MEDIA_S3_TEST_BUCKET;
  if (!BUCKET || !(process.env.AWS_ENDPOINT_URL_S3 || process.env.AWS_ENDPOINT_URL)) {
    console.log('PASS skipped the S3 part: set MEDIA_S3_TEST_BUCKET and AWS_ENDPOINT_URL_S3 to run against S3');
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
  process.env.MEDIA_STORE_DRIVER = 's3';
  process.env.MEDIA_ARCHIVE_ENABLED = 'true';
  process.env.S3_BUCKET = BUCKET;

  const { S3Client, CreateBucketCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const { S3Driver, uploadTree, mediaS3Client } = await import('../src/services/media/s3Driver');
  const { storageDriver, capabilities } = await import('../src/services/media/storage');
  const region = process.env.AWS_REGION ?? 'ap-southeast-1';
  const s3 = new S3Client({ region, endpoint: process.env.AWS_ENDPOINT_URL_S3 || process.env.AWS_ENDPOINT_URL, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === '1' });
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET, CreateBucketConfiguration: { LocationConstraint: region as any } })).catch(() => { /* exists */ });
  const keys = async (prefix: string) => ((await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }))).Contents ?? []).map((o) => o.Key!).sort();
  const cls = async (key: string) => (await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))).StorageClass ?? 'STANDARD';

  ok(capabilities().driver === 's3' && capabilities().archiveEnabled, 'capabilities: S3 with archive');
  const drv = storageDriver();
  ok(drv.kind === 's3', 'storageDriver() is the S3 router on MEDIA_STORE_DRIVER=s3 (it used to be local whatever the setting)');

  // ---- upload + stat ---------------------------------------------------------
  const run = Date.now().toString(36);
  const dir = clipTree();
  const up = await uploadTree(await mediaS3Client(region), dir, BUCKET, `clips/t-${run}`);
  ok(up.uri === `s3://${BUCKET}/clips/t-${run}/` && up.files === 4 && up.bytes === 1000 + 500 + 2048 + 23, `uploadTree: 4 files, ${up.bytes} bytes, prefix URI`);
  const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: `clips/t-${run}/hls/index.m3u8` }));
  ok(head.ContentType === 'application/vnd.apple.mpegurl' && head.CacheControl === 'no-cache', 'manifest uploaded with its type and no-cache');
  const segHead = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: `clips/t-${run}/hls/seg_1.m4s` }));
  ok(/immutable/.test(segHead.CacheControl ?? ''), 'segment uploaded immutable');
  ok((await drv.stat(up.uri))?.bytes === up.bytes, 'stat sums the prefix');
  ok((await drv.stat(`s3://${BUCKET}/clips/t-${run}/clip.mp4`))?.bytes === 2048, 'stat of one object');
  ok((await drv.stat(`s3://${BUCKET}/clips/nothing-${run}/`)) === null, 'stat of nothing is null');

  // a sibling whose name starts the same must never be reached
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `clips/t-${run}x/keep.mp4`, Body: 'keep' }));

  // ---- cool, archive, restore -----------------------------------------------
  await drv.transition(up.uri, 's3_glacier_ir');
  ok(await cls(`clips/t-${run}/hls/seg_2.m4s`) === 'GLACIER_IR' && await cls(`clips/t-${run}/clip.mp4`) === 'GLACIER_IR', 'to_cold: every object now GLACIER_IR, same keys');
  await drv.transition(up.uri, 's3_glacier_flexible');
  ok(await cls(`clips/t-${run}/clip.mp4`) === 'GLACIER', 'to_archive: GLACIER');
  let refused = '';
  try { await drv.transition(up.uri, 's3_standard'); } catch (e: any) { refused = e.message; }
  ok(/restore it before/.test(refused), 'moving an archived object without a restore is refused with the reason', refused);
  const rs = await drv.requestRestore(up.uri, 'bulk');
  ok(typeof rs.ready === 'boolean', `restore requested (ready=${rs.ready})`);
  const st = await drv.restoreStatus(up.uri);
  ok(st.ready === true || st.ready === false, `restore status readable (ready=${st.ready}, expires ${st.expiresAt?.toISOString() ?? 'n/a'})`);
  await drv.requestRestore(up.uri, 'bulk').then(() => ok(true, 'asking again while restoring is not an error'), (e) => ok(false, 'asking again while restoring is not an error', e.message));

  // ---- remove ------------------------------------------------------------------
  await drv.remove(up.uri);
  ok((await keys(`clips/t-${run}/`)).length === 0, 'remove: the prefix is empty');
  ok((await keys(`clips/t-${run}x/`)).length === 1, 'remove: a sibling prefix with the same start is untouched');
  await drv.remove(up.uri).then(() => ok(true, 'remove is idempotent'), (e) => ok(false, 'remove is idempotent', e.message));
  let rootRefused = false;
  try { await drv.remove(`s3://${BUCKET}/`); } catch { rootRefused = true; }
  ok(rootRefused && (await keys(`clips/t-${run}x/`)).length === 1, 'remove of the bucket root is refused');
  // a local path still goes to the local driver
  const localDir = clipTree();
  await drv.remove(localDir);
  ok(!require('node:fs').existsSync(localDir), 'a local path is removed by the local driver through the router');

  // ---- the sweep, with the database ---------------------------------------------
  if (!process.env.DATABASE_URL) {
    console.log('PASS skipped the sweep part: set DATABASE_URL');
  } else {
    const { query, one } = await import('../src/db');
    const { registerObject } = await import('../src/services/media/objects');
    const { saveRule, sweep } = await import('../src/services/media/retention');
    const A = '00000000-0000-0000-0000-00000000e5a1', G = '00000000-0000-0000-0000-00000000e5b1', D = '00000000-0000-0000-0000-00000000e5d1';
    const C = '00000000-0000-0000-0000-00000000e5c1', V = '00000000-0000-0000-0000-00000000e5e1';
    await query(`INSERT INTO accounts(id,name) VALUES ($1,'S3 retention') ON CONFLICT DO NOTHING`, [A]);
    await query(`INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ($1,$2,'p','[{"height":720,"bitrate_kbps":2000}]','transcode') ON CONFLICT DO NOTHING`, [D, A]);
    await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels,max_concurrent) VALUES ($1,$2,'g',$3,5,5) ON CONFLICT DO NOTHING`, [G, A, D]);
    await query(`INSERT INTO channels(id,group_id,name,status) VALUES ($1,$2,'s3-ret','scheduled') ON CONFLICT DO NOTHING`, [C, G]);
    await query(`INSERT INTO vod_assets(id,channel_id,title,master_key,start_epoch_ms,end_epoch_ms,duration_ms) VALUES ($1,$2,'Old clip','x',0,1000,1000) ON CONFLICT DO NOTHING`, [V, C]);

    // A clip with a local copy and an S3 copy, as clip.extract now registers it.
    const ldir = clipTree();
    const sup = await uploadTree(await mediaS3Client(region), ldir, BUCKET, `clips/${V}-${run}`);
    const o1 = await registerObject({ vodAssetId: V, channelId: C, logicalKey: `clips/${V}`, kind: 'clip_output', tier: 'local', uri: ldir, bytes: sup.bytes });
    const o2 = await registerObject({ vodAssetId: V, channelId: C, logicalKey: `clips/${V}`, kind: 'clip_output', tier: 's3_standard', uri: sup.uri, bytes: sup.bytes });
    ok(o1.id === o2.id, 'local and S3 copies are two locations of one media object');
    await query(`UPDATE media_objects SET state='available', created_at = now() - interval '40 days' WHERE id=$1`, [o1.id]);

    // Cooling: a 30-day cold rung moves the S3 copy of the mixed object (its
    // local copy cannot cool and is left for the delete rung), and an
    // S3-only object.
    const cdir = clipTree();
    const cup = await uploadTree(await mediaS3Client(region), cdir, BUCKET, `clips/cool-${run}`);
    const oc = await registerObject({ vodAssetId: V, channelId: C, logicalKey: `clips/cool-${run}`, kind: 'clip_output', tier: 's3_standard', uri: cup.uri, bytes: cup.bytes });
    await query(`UPDATE media_objects SET state='available', created_at = now() - interval '40 days' WHERE id=$1`, [oc.id]);

    await saveRule({ actingAccountId: A, channelId: C, name: 'Cool at 30, delete at 365', appliesTo: 'asset',
      stages: [{ afterDays: 30, action: 'to_cold' }, { afterDays: 365, action: 'delete' }] });
    const r1 = await sweep({ actor: 'test', accountId: A });
    ok(await cls(`clips/cool-${run}/clip.mp4`) === 'GLACIER_IR', `sweep cooled the S3-only clip in place (cooled=${r1.cooled}, failed=${r1.failed})`);
    ok(await cls(`clips/${V}-${run}/clip.mp4`) === 'GLACIER_IR' && r1.failed === 0, `and the S3 copy of the clip that also has a local copy, with no failure (failed=${r1.failed})`);
    ok(require('node:fs').existsSync(ldir), 'the local copy is left where it is');
    const coolLoc = await one<any>(`SELECT tier, uri, present FROM media_locations WHERE object_id=$1 AND present`, [oc.id]);
    ok(coolLoc?.tier === 's3_glacier_ir' && coolLoc?.uri === cup.uri, 'its location now says s3_glacier_ir at the same URI');

    // Now old enough to delete.
    await query(`UPDATE media_objects SET created_at = now() - interval '400 days' WHERE id = ANY($1)`, [[o1.id, oc.id]]);
    const r2 = await sweep({ actor: 'test', accountId: A });
    ok((await keys(`clips/${V}-${run}/`)).length === 0, `sweep deleted the S3 copy by rule (deleted=${r2.deleted}, failed=${r2.failed})`);
    ok(!require('node:fs').existsSync(ldir), 'and the local copy');
    ok((await keys(`clips/cool-${run}/`)).length === 0, 'and the cooled clip, from GLACIER_IR');
    const tomb = await one<any>(`SELECT state FROM media_objects WHERE id=$1`, [o1.id]);
    ok(tomb?.state === 'deleted', 'the media object stays as a tombstone (deleted)');
    const gone = await one<any>(`SELECT count(*)::int AS n FROM media_locations WHERE object_id=$1 AND present`, [o1.id]);
    ok(gone?.n === 0, 'no location still claims to be present');

    // Ownerless media in S3 (its asset was deleted): reclaimed after the grace period.
    const odir = clipTree();
    const oup = await uploadTree(await mediaS3Client(region), odir, BUCKET, `clips/orphan-${run}`);
    const oo = await registerObject({ channelId: C, logicalKey: `clips/orphan-${run}`, kind: 'clip_output', tier: 's3_standard', uri: oup.uri, bytes: oup.bytes });
    await query(`UPDATE media_objects SET state='available', channel_id=NULL, event_id=NULL, recording_id=NULL, vod_asset_id=NULL, updated_at = now() - interval '2 days' WHERE id=$1`, [oo.id]);
    const r3 = await sweep({ actor: 'test' });
    ok((await keys(`clips/orphan-${run}/`)).length === 0, `ownerless S3 media is reclaimed (orphaned=${r3.orphaned})`);
    ok((await keys(`clips/t-${run}x/`)).length === 1, 'the unrelated sibling prefix survived every sweep');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
