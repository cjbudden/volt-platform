// ============================================================================
//  RECORDINGS RETENTION IN THE BUCKET (build queue 2.3; services/media/s3Runs.ts,
//  services/media/reconcile.ts, services/media/retention.ts).
//
//  On AWS each encoder run is under s3://<bucket>/<kind>/<id>/runs/<runId>/
//  (2.2) and nothing of it is on the control plane's disk. Against Postgres
//  and a stand-in S3 client (an in-memory bucket that answers the SDK's own
//  commands and records every one), this checks that:
//    - reconcile registers each rendition folder of each closed run as a media
//      object on its own prefix, a running run as `writing`, and not the
//      run's thumbnails or loop; a closed run is listed in full once only, and
//      the tick passes a stream at most every few minutes;
//    - cool, archive, restore and delete act on exactly the keys under the
//      run's renditions: never the stream root (stable playlists and
//      current_run.txt), never the running run, never another channel's run
//      with the same run id;
//    - deleting a recording's run takes the whole run folder (thumbnails, loop,
//      playlists) and tombstones its objects; a run clips were cut from keeps
//      those segments, one either side, and its init and playlists, on hold;
//    - a stream-keyed run deleted rendition by rendition takes its leftovers
//      with the last one, but never the run the pointer names;
//    - a run removed behind Volt's back is marked missing, then deleted.
//
//  Usage: DATABASE_URL=... npx tsx test/s3-recordings-retention.check.ts
// ============================================================================
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(tmpdir(), `volt-s3rr-${Date.now().toString(36)}`);
process.env.ORIGIN_DIR = join(ROOT, 'origin');
process.env.CLIPS_DIR = join(ROOT, 'clips');
process.env.IMAGE_STORE_DIR = join(ROOT, 'image-store');
process.env.VOLT_TRASH_DIR = join(ROOT, 'trash');
process.env.MEDIA_STORE_DRIVER = 's3';
process.env.MEDIA_ARCHIVE_ENABLED = 'true';
process.env.S3_BUCKET = 'volt-origin-test';
process.env.MEDIA_S3_RECONCILE_MS = '600000';
const BUCKET = 'volt-origin-test';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };

// ---- the stand-in bucket ----------------------------------------------------
interface Obj { size: number; cls: string; at: number; body: string; restore?: string }
const bucket = new Map<string, Obj>();
const calls: { op: string; key?: string; prefix?: string; delim?: string; cls?: string }[] = [];
const PAGE = 7;   // small pages, so every listing is paginated
const notFound = (name: string) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });
const fake = {
  async send(cmd: any): Promise<any> {
    const op = cmd.constructor.name.replace(/Command$/, ''); const i = cmd.input ?? {};
    if (i.Bucket !== BUCKET) throw new Error(`wrong bucket ${i.Bucket}`);
    switch (op) {
      case 'ListObjectsV2': {
        calls.push({ op, prefix: i.Prefix, delim: i.Delimiter });
        const keys = [...bucket.keys()].filter((k) => k.startsWith(i.Prefix ?? '')).sort();
        const contents: string[] = []; const prefixes = new Set<string>();
        for (const k of keys) {
          const rest = k.slice((i.Prefix ?? '').length);
          if (i.Delimiter && rest.includes(i.Delimiter)) prefixes.add((i.Prefix ?? '') + rest.slice(0, rest.indexOf(i.Delimiter) + 1));
          else contents.push(k);
        }
        const items = [...contents.map((k) => ({ k })), ...[...prefixes].sort().map((p) => ({ p }))];
        const start = Number(i.ContinuationToken ?? 0); const page = items.slice(start, start + PAGE);
        const more = start + PAGE < items.length;
        return {
          Contents: page.filter((x: any) => x.k).map((x: any) => ({ Key: x.k, Size: bucket.get(x.k)!.size, LastModified: new Date(bucket.get(x.k)!.at), StorageClass: bucket.get(x.k)!.cls })),
          CommonPrefixes: page.filter((x: any) => x.p).map((x: any) => ({ Prefix: x.p })),
          IsTruncated: more, NextContinuationToken: more ? String(start + PAGE) : undefined,
        };
      }
      case 'HeadObject': {
        const o = bucket.get(i.Key); if (!o) throw notFound('NotFound');
        return { ContentLength: o.size, StorageClass: o.cls === 'STANDARD' ? undefined : o.cls, Restore: o.restore };
      }
      case 'GetObject': {
        calls.push({ op, key: i.Key });
        const o = bucket.get(i.Key); if (!o) throw notFound('NoSuchKey');
        return { Body: { transformToString: async () => o.body } };
      }
      case 'CopyObject': {
        calls.push({ op, key: i.Key, cls: i.StorageClass });
        const o = bucket.get(i.Key); if (!o) throw notFound('NoSuchKey');
        if ((o.cls === 'GLACIER' || o.cls === 'DEEP_ARCHIVE') && !/ongoing-request="false"/.test(o.restore ?? '')) throw Object.assign(new Error('InvalidObjectState'), { name: 'InvalidObjectState' });
        o.cls = i.StorageClass ?? 'STANDARD'; o.restore = undefined; return {};
      }
      case 'RestoreObject': {
        calls.push({ op, key: i.Key });
        const o = bucket.get(i.Key); if (!o) throw notFound('NoSuchKey');
        o.restore = 'ongoing-request="true"'; return {};
      }
      case 'DeleteObjects': {
        for (const d of i.Delete.Objects) { calls.push({ op, key: d.Key }); bucket.delete(d.Key); }
        return { Errors: [] };
      }
      default: throw new Error(`stand-in S3 does not do ${op}`);
    }
  },
};
const put = (key: string, at: number, size = 100, body = 'x') => bucket.set(key, { size, cls: 'STANDARD', at, body });
const runIdAt = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
/** A run of `rends` renditions with `segs` segments each, written at time t0, plus playlists, thumbs and the loop. */
function layRun(root: string, runId: string, t0: number, rends = ['720p', '360p', 'audio'], segs = 10) {
  const run = `${root}runs/${runId}/`;
  put(`${run}master_cc.m3u8`, t0 + segs * 4000, 300);
  for (const r of rends) {
    put(`${run}${r}/init.mp4`, t0, 800);
    for (let s = 1; s <= segs; s++) put(`${run}${r}/seg_${s}.m4s`, t0 + s * 4000, 1000 + s);
    put(`${run}${r}/index.m3u8`, t0 + segs * 4000, 200);
  }
  put(`${run}thumbs/t_1.jpg`, t0 + 5000, 50);
  put(`${run}filler/loop_720p_init.mp4`, t0, 70);
  return run;
}
const keysUnder = (p: string) => [...bucket.keys()].filter((k) => k.startsWith(p)).sort();
const mutated = (since: number, op: string) => calls.slice(since).filter((c) => c.op === op).map((c) => c.key!);

(async () => {
  const { pool, one, query } = await import('../src/db');
  const { setStorageDriver, localDriver } = await import('../src/services/media/storage');
  const { S3Driver, RoutingDriver } = await import('../src/services/media/s3Driver');
  setStorageDriver(new RoutingDriver(new S3Driver(async () => fake), localDriver()));
  const S = await import('../src/services/media/s3Runs');
  S.setS3RunsApi(fake);
  const { reconcileStream, reconcileAll } = await import('../src/services/media/reconcile');
  const { sweep, saveRule } = await import('../src/services/media/retention');
  const { requestRestore, pollRestores } = await import('../src/services/media/objects');

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`s3rr-${tag}`]))!.id as string;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
  const grp = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id as string;
  const mkChannel = async (name: string) => (await one<any>(`INSERT INTO channels(group_id, name, tz) VALUES ($1,$2,'UTC') RETURNING id`, [grp, name]))!.id as string;
  const ch = await mkChannel('Bucket TV');
  const other = await mkChannel('Other TV');
  const root = `channel/${ch}/`;
  const objOf = (logical: string) => one<any>(`SELECT o.*, (SELECT array_agg(uri ORDER BY tier) FROM media_locations l WHERE l.object_id = o.id AND l.present) AS uris,
      (SELECT array_agg(tier::text) FROM media_locations l WHERE l.object_id = o.id AND l.present) AS tiers
      FROM media_objects o WHERE (o.channel_id = $1 OR o.recording_id IN (SELECT id FROM recordings WHERE channel_id = $1)) AND o.logical_key = $2`, [ch, logical]);
  const setRule = async (stages: any[]) => {
    await query(`DELETE FROM retention_rules WHERE channel_id = $1`, [ch]);
    await saveRule({ actingAccountId: acct, channelId: ch, name: 'Bucket rule', appliesTo: 'recording', stages } as any);
  };

  try {
    const now = Date.now(), DAY = 86_400_000;
    // R1: ten days old, recorded. R2: running now, the pointer names it.
    const t1 = now - 10 * DAY, R1 = runIdAt(t1);
    const t2 = now - 60_000, R2 = runIdAt(t2);
    const run1 = layRun(root, R1, t1);
    const run2 = layRun(root, R2, t2, ['720p', 'audio'], 3);
    put(`${run2}master_cc.m3u8`, now - 2000, 300);
    put(`${root}current_run.txt`, now - 2000, 16, R2);
    put(`${root}master_cc.m3u8`, now - 2000, 300);
    // Another channel with a run of the SAME id.
    const otherRun = layRun(`channel/${other}/`, R1, t1, ['720p'], 4);
    const otherKeys = keysUnder(`channel/${other}/`);
    const rec1 = (await one<any>(`INSERT INTO recordings(kind, channel_id, title, day_utc, status, start_epoch_ms, end_epoch_ms)
       VALUES ('channel_day', $1, 'Ten days old', $2, 'complete', $3, $4) RETURNING id`, [ch, new Date(t1).toISOString().slice(0, 10), t1 - 1000, t1 + 45_000]))!.id as string;

    console.log('== bucket -> rows ==');
    ok(S.runStartMs('20261112T201500Z') === Date.UTC(2026, 10, 12, 20, 15, 0) && S.runStartMs('nope') === null, 'a run id reads as its start time');
    ok(S.runFolderOf(`s3://${BUCKET}/${run1}720p/`)?.runId === R1 && S.runFolderOf(`s3://${BUCKET}/${root}master_cc.m3u8`) === null
      && S.runFolderOf(`s3://${BUCKET}/${root}runs/`) === null, 'a rendition location names its run; the root and the runs folder do not');
    let c0 = calls.length;
    let r = await reconcileStream(ch, { actor: 'test' });
    ok(r.registered === 5, 'five renditions registered (three of the closed run, two of the running run)', r);
    const o720 = await objOf(`run/${R1}/720p`), o360 = await objOf(`run/${R1}/360p`), oAud = await objOf(`run/${R1}/audio`);
    ok(o720?.state === 'available' && o720.recording_id === rec1 && o720.uris?.[0] === `s3://${BUCKET}/${run1}720p/` && o720.tiers?.[0] === 's3_standard',
      'the closed run: available, on its recording, located at its own prefix in S3 Standard', o720);
    const want720 = 800 + 200 + Array.from({ length: 10 }, (_, s) => 1001 + s).reduce((a, b) => a + b, 0);
    ok(Number(o720.bytes) === want720 && o720.segment_count === 10, `sized from the bucket: ${want720} bytes, 10 segments`, { bytes: o720.bytes, n: o720.segment_count });
    ok(Number(o720.duration_ms) >= 39_000 && Number(o720.duration_ms) <= 41_000, 'its length runs from the run id to the last segment', o720.duration_ms);
    ok(o360?.state === 'available' && oAud?.state === 'available', 'every rendition of the run is governed, not just the top one');
    ok(!(await objOf(`run/${R1}/thumbs`)) && !(await objOf(`run/${R1}/filler`)), 'thumbnails and the loop are not renditions');
    const live720 = await objOf(`run/${R2}/720p`);
    ok(live720?.state === 'writing', 'the running run is `writing`, so the sweep does not look at it', live720?.state);
    ok(!calls.slice(c0).some((c) => c.op !== 'ListObjectsV2'), 'reconcile only lists: it changes nothing in the bucket');
    ok(!calls.slice(c0).some((c) => c.prefix?.startsWith(`channel/${other}/`)), "reconcile lists only this stream's folder");

    c0 = calls.length;
    r = await reconcileStream(ch, { actor: 'test' });
    const relisted = calls.slice(c0).filter((c) => c.op === 'ListObjectsV2' && c.prefix?.startsWith(run1));
    ok(relisted.length === 0, 'a closed run is not listed again', relisted);
    ok(r.registered === 0, 'nothing new on a second pass', r);
    c0 = calls.length;
    await reconcileAll({ actor: 'tick' });
    const n1 = calls.length - c0;
    await reconcileAll({ actor: 'tick' });
    ok(calls.length - c0 === n1, 'the tick passes a stream at most every MEDIA_S3_RECONCILE_MS', { first: n1, both: calls.length - c0 });

    console.log('== cool ==');
    await setRule([{ afterDays: 1, action: 'to_cold' }]);
    c0 = calls.length;
    let s = await sweep({ accountId: acct, actor: 'test' });
    let copied = mutated(c0, 'CopyObject');
    const r1Media = [...keysUnder(`${run1}720p/`), ...keysUnder(`${run1}360p/`), ...keysUnder(`${run1}audio/`)];
    ok(s.cooled === 3, 'three renditions cooled', s);
    ok(copied.length === r1Media.length && copied.every((k) => r1Media.includes(k)), `exactly the ${r1Media.length} keys under the three rendition prefixes were copied`, copied.filter((k) => !r1Media.includes(k)));
    ok(r1Media.every((k) => bucket.get(k)!.cls === 'GLACIER_IR'), 'they are in Glacier Instant Retrieval now');
    ok(bucket.get(`${run1}thumbs/t_1.jpg`)!.cls === 'STANDARD' && bucket.get(`${run1}master_cc.m3u8`)!.cls === 'STANDARD', "the run's thumbnails and playlists were not touched");
    ok(keysUnder(run2).every((k) => bucket.get(k)!.cls === 'STANDARD') && bucket.get(`${root}current_run.txt`)!.cls === 'STANDARD', 'the running run and the stream root were not touched');
    ok(otherKeys.every((k) => bucket.get(k)?.cls === 'STANDARD'), 'the other channel\'s run with the same id was not touched');
    let o = await objOf(`run/${R1}/720p`);
    ok(o.state === 'available' && o.tiers?.length === 1 && o.tiers[0] === 's3_glacier_ir', 'the object stays readable, its one copy now in the cold tier', o.tiers);
    c0 = calls.length;
    s = await sweep({ accountId: acct, actor: 'test' });
    ok(mutated(c0, 'CopyObject').length === 0 && s.cooled === 0, 'a second sweep does nothing (each rung fires once)', s);
    c0 = calls.length;
    await reconcileStream(ch, { actor: 'test' });
    o = await objOf(`run/${R1}/720p`);
    ok(o.tiers?.length === 1 && o.tiers[0] === 's3_glacier_ir', 'reconcile does not put a cooled object back in S3 Standard', o.tiers);

    console.log('== archive ==');
    await setRule([{ afterDays: 1, action: 'to_cold' }, { afterDays: 5, action: 'to_archive' }]);
    c0 = calls.length;
    s = await sweep({ accountId: acct, actor: 'test' });
    copied = mutated(c0, 'CopyObject');
    ok(s.archived === 3 && copied.length === r1Media.length && copied.every((k) => r1Media.includes(k)), 'archived: the same keys and no others', { s, extra: copied.filter((k) => !r1Media.includes(k)) });
    ok(r1Media.every((k) => bucket.get(k)!.cls === 'GLACIER'), 'they are in Glacier Flexible Retrieval now');
    o = await objOf(`run/${R1}/720p`);
    ok(o.state === 'archived' && o.tiers?.[0] === 's3_glacier_flexible', 'the object is archived', o);

    console.log('== restore ==');
    c0 = calls.length;
    const rr = await requestRestore(o.id, 'standard', 'test');
    const restored = mutated(c0, 'RestoreObject');
    const want = keysUnder(`${run1}720p/`);
    ok(rr.ok && restored.length === want.length && restored.every((k) => want.includes(k)), 'restore asks for exactly the 720p keys', { rr, extra: restored.filter((k) => !want.includes(k)) });
    ok(keysUnder(`${run1}360p/`).every((k) => !bucket.get(k)!.restore), 'the other renditions were not restored');
    let p = await pollRestores();
    ok(p.landed === 0 && (await objOf(`run/${R1}/720p`)).state === 'restoring', 'while S3 is still restoring, the object waits');
    for (const k of want) bucket.get(k)!.restore = `ongoing-request="false", expiry-date="${new Date(now + 7 * DAY).toUTCString()}"`;
    p = await pollRestores();
    ok(p.landed === 1 && (await objOf(`run/${R1}/720p`)).state === 'restored', 'once it lands the 720p is readable again', p);

    console.log('== delete a recorded run ==');
    await setRule([{ afterDays: 7, action: 'delete' }]);
    const r1All = keysUnder(run1);
    const r2Before = keysUnder(run2);
    c0 = calls.length;
    s = await sweep({ accountId: acct, actor: 'test' });
    const deleted = mutated(c0, 'DeleteObjects');
    ok(s.deleted >= 1, 'the delete rung fired', s);
    ok(keysUnder(run1).length === 0 && deleted.length === r1All.length && deleted.every((k) => r1All.includes(k)),
      `the whole run folder went (${r1All.length} keys: renditions, thumbnails, loop, playlists) and nothing else`, deleted.filter((k) => !r1All.includes(k)));
    ok(JSON.stringify(keysUnder(run2)) === JSON.stringify(r2Before) && bucket.has(`${root}current_run.txt`) && bucket.has(`${root}master_cc.m3u8`), 'the running run and the stream root are all still there');
    ok(otherKeys.every((k) => bucket.has(k)), "the other channel's run with the same id is all still there");
    const tomb = await query<any>(`SELECT state FROM media_objects WHERE recording_id = $1`, [rec1]);
    ok(tomb.length === 3 && tomb.every((t: any) => t.state === 'deleted'), 'its three objects are tombstones', tomb);
    ok((await one<any>(`SELECT storage_state FROM recordings WHERE id = $1`, [rec1]))!.storage_state === 'deleted', 'the recording is marked removed');
    const log = await one<any>(`SELECT outcome, removed FROM recording_removals WHERE recording_id = $1 ORDER BY created_at DESC LIMIT 1`, [rec1]).catch(() => null);
    ok(!log || log.outcome === 'removed', 'the removal record says removed', log);

    console.log('== a run clips were cut from ==');
    const t3 = now - 9 * DAY, R3 = runIdAt(t3);
    const run3 = layRun(root, R3, t3, ['720p', 'audio'], 12);
    const rec3 = (await one<any>(`INSERT INTO recordings(kind, channel_id, title, day_utc, status, start_epoch_ms, end_epoch_ms)
       VALUES ('channel_day', $1, 'Clipped', $2, 'complete', $3, $4) RETURNING id`, [ch, new Date(t3).toISOString().slice(0, 10), t3 - 1000, t3 + 50_000]))!.id as string;
    const clip = (await one<any>(`INSERT INTO vod_assets(channel_id, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms) VALUES ($1, 'clip', 'Goal', 'clips/x', $2, $3, 8000) RETURNING id`, [ch, t3 + 20_000, t3 + 28_000]))!.id;
    await query(`INSERT INTO clip_segments (vod_asset_id, ordinal, recording_id, run_id, rendition, first_seq, last_seq,
                   segment_count, source_from_ms, source_to_ms, clip_offset_ms, duration_ms)
                 VALUES ($1, 0, $2, $3, '720p', 5, 6, 2, $4, $5, 0, 8000)`, [clip, rec3, R3, t3 + 20_000, t3 + 28_000]);
    await reconcileStream(ch, { actor: 'test' });
    ok((await objOf(`run/${R3}/720p`))?.state === 'available', 'the clipped run is registered');
    c0 = calls.length;
    s = await sweep({ accountId: acct, actor: 'test' });
    const keptSegs = keysUnder(run3).filter((k) => /seg_\d+\.m4s$/.test(k)).map((k) => k.slice(run3.length)).sort();
    ok(JSON.stringify(keptSegs) === JSON.stringify(['720p/seg_4.m4s', '720p/seg_5.m4s', '720p/seg_6.m4s', '720p/seg_7.m4s', 'audio/seg_4.m4s', 'audio/seg_5.m4s', 'audio/seg_6.m4s', 'audio/seg_7.m4s']),
      'the segments the clip used, one either side, stay in every rendition', keptSegs);
    ok(bucket.has(`${run3}720p/init.mp4`) && bucket.has(`${run3}audio/init.mp4`) && bucket.has(`${run3}720p/index.m3u8`) && bucket.has(`${run3}master_cc.m3u8`), 'with their init segments and playlists');
    ok(mutated(c0, 'DeleteObjects').length === 16, 'the other 16 segments went', mutated(c0, 'DeleteObjects').length);
    const held = await query<any>(`SELECT state, hold, hold_reason FROM media_objects WHERE recording_id = $1`, [rec3]);
    ok(held.length === 2 && held.every((h: any) => h.hold && h.state !== 'deleted' && /kept 8 segments that 1 clip were cut from/.test(h.hold_reason)), 'its objects stay, on hold, saying why', held);

    console.log('== a run with no recording, deleted rendition by rendition ==');
    // R4 belongs to no recording and is the run the pointer names (the channel stopped
    // long ago); R5 belongs to no recording and is not.
    await query(`DELETE FROM retention_rules WHERE channel_id = $1`, [ch]);
    await saveRule({ actingAccountId: acct, channelId: ch, name: 'Bucket rule', appliesTo: 'recording', stages: [{ afterDays: 7, action: 'delete' }] } as any);
    const t5 = now - 20 * DAY - 7200_000, R5 = runIdAt(t5);
    const t4 = now - 20 * DAY, R4 = runIdAt(t4);
    const run5 = layRun(root, R5, t5, ['720p'], 3);
    const run4 = layRun(root, R4, t4, ['720p'], 3);
    // The running run stops and the pointer moves back to nothing newer: say R4.
    for (const k of keysUnder(run2)) bucket.delete(k);
    put(`${root}current_run.txt`, t4 + 20_000, 16, R4);
    await reconcileStream(ch, { actor: 'test' });
    const o4 = await objOf(`run/${R4}/720p`), o5 = await objOf(`run/${R5}/720p`);
    ok(o4?.state === 'available' && !o4.recording_id && o5?.state === 'available' && !o5.recording_id, 'both registered on the stream, with no recording');
    // Created long ago: the rule ages a stream-keyed object from its creation.
    await query(`UPDATE media_objects SET created_at = now() - interval '20 days' WHERE id = ANY($1)`, [[o4.id, o5.id]]);
    s = await sweep({ accountId: acct, actor: 'test' });
    ok(keysUnder(run5).length === 0, 'R5: the rendition went, and with the last one its playlists, thumbnails and loop', keysUnder(run5));
    ok(keysUnder(`${run4}720p/`).length === 0 && bucket.has(`${run4}master_cc.m3u8`) && bucket.has(`${run4}thumbs/t_1.jpg`),
      'R4: the rendition went, but the run the pointer names keeps the rest', keysUnder(run4));
    ok(s.sidecarBytes > 0, 'the leftovers are counted', s.sidecarBytes);

    console.log('== bucket -> rows: a run removed behind our back ==');
    const t6 = now - 3 * DAY, R6 = runIdAt(t6);
    const run6 = layRun(root, R6, t6, ['720p'], 2);
    await reconcileStream(ch, { actor: 'test' });
    ok((await objOf(`run/${R6}/720p`))?.state === 'available', 'R6 registered');
    for (const k of keysUnder(run6)) bucket.delete(k);
    r = await reconcileStream(ch, { actor: 'test' });
    const o6 = await objOf(`run/${R6}/720p`);
    const ev = await one<any>(`SELECT count(*)::int AS n FROM media_events WHERE object_id = $1 AND action = 'missing'`, [o6.id]);
    ok(r.missing === 1 && o6.state === 'deleted' && !o6.uris && ev.n >= 1, 'it is marked missing, then deleted, with no copy left', { r, o6 });
    ok(otherKeys.every((k) => bucket.has(k)), "the other channel's run is still all there at the end");
  } catch (e) {
    fail++; console.log('FAIL threw', e);
  } finally {
    console.log(`\n${pass} passed, ${fail} failed`);
    await pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
