// ============================================================================
//  A RECORDING'S THUMBNAILS ON AWS READ THE RUN FOLDERS (build queue 2.3c;
//  services/media/s3RecordingSource.ts, Orchestrator.finalizeRecording).
//
//  On AWS each encoder run is under s3://<bucket>/<kind>/<id>/runs/<runId>/
//  (2.2), but the thumbnailer launched when a recording closes was pointed at
//  <master_key>/<rendition>/index.m3u8, the old layout nothing writes. Against
//  Postgres and a stand-in S3 client, this checks that:
//    - the recording's source playlist takes every run that started inside the
//      recording's window, in order, and no other: not a run before or after
//      it, not another channel's run with the same id, not a run without the
//      recording's rendition;
//    - it is a VOD playlist (ENDLIST) with each run's own init segment, a
//      discontinuity between runs, segments in numeric order (seg_10 after
//      seg_9), never thumbnails or the loop;
//    - it is put at thumbs/<recording>/source.m3u8 and the thumbnailer job
//      reads it there when the launcher is ECS and recordings are in the bucket;
//    - with nothing in the bucket no task is started and the recording says
//      error instead of "processing" for ever;
//    - the local launchers keep the job as before (they read the disk).
//
//  Usage: DATABASE_URL=... npx tsx test/s3-recording-source.check.ts
// ============================================================================
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(tmpdir(), `volt-s3rs-${Date.now().toString(36)}`);
process.env.ORIGIN_DIR = join(ROOT, 'origin');
process.env.CLIPS_DIR = join(ROOT, 'clips');
process.env.IMAGE_STORE_DIR = join(ROOT, 'image-store');
process.env.MEDIA_STORE_DRIVER = 's3';
process.env.S3_BUCKET = 'volt-origin-test';
process.env.ORCH_LAUNCHER = 'ecs';
const BUCKET = 'volt-origin-test';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };

// ---- the stand-in bucket ----------------------------------------------------
const bucket = new Map<string, { size: number; at: number; body: string; type?: string }>();
const calls: { op: string; key?: string; prefix?: string }[] = [];
const PAGE = 7;   // small pages, so every listing is paginated
const fake = {
  async send(cmd: any): Promise<any> {
    const op = cmd.constructor.name.replace(/Command$/, ''); const i = cmd.input ?? {};
    if (i.Bucket !== BUCKET) throw new Error(`wrong bucket ${i.Bucket}`);
    switch (op) {
      case 'ListObjectsV2': {
        calls.push({ op, prefix: i.Prefix });
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
          Contents: page.filter((x: any) => x.k).map((x: any) => ({ Key: x.k, Size: bucket.get(x.k)!.size, LastModified: new Date(bucket.get(x.k)!.at), StorageClass: 'STANDARD' })),
          CommonPrefixes: page.filter((x: any) => x.p).map((x: any) => ({ Prefix: x.p })),
          IsTruncated: more, NextContinuationToken: more ? String(start + PAGE) : undefined,
        };
      }
      case 'PutObject': {
        calls.push({ op, key: i.Key });
        bucket.set(i.Key, { size: String(i.Body).length, at: Date.now(), body: String(i.Body), type: i.ContentType });
        return {};
      }
      default: throw new Error(`stand-in S3 does not do ${op}`);
    }
  },
};
const put = (key: string, at = Date.now()) => bucket.set(key, { size: 100, at, body: 'x' });
const runIdAt = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
function layRun(root: string, runId: string, rends = ['720p', '360p'], segs = 3) {
  const run = `${root}runs/${runId}/`;
  put(`${run}master_cc.m3u8`);
  for (const r of rends) {
    put(`${run}${r}/init.mp4`);
    for (let s = 1; s <= segs; s++) put(`${run}${r}/seg_${s}.m4s`);
    put(`${run}${r}/index.m3u8`);
  }
  put(`${run}thumbs/t_1.jpg`);
  put(`${run}filler/loop_720p_init.mp4`);
  return run;
}
const uris = (text: string) => text.split('\n').filter((l) => l && !l.startsWith('#'));

(async () => {
  const { pool, one } = await import('../src/db');
  const S = await import('../src/services/media/s3Runs');
  S.setS3RunsApi(fake);
  const { buildRecordingSource, writeRecordingSource, recordingSourceKey } = await import('../src/services/media/s3RecordingSource');
  const { Orchestrator } = await import('../src/services/orchestrator/service');
  const { config } = await import('../src/config');

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`s3rs-${tag}`]))!.id as string;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
  const grp = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id as string;
  const mkChannel = async (name: string) => (await one<any>(`INSERT INTO channels(group_id, name, tz) VALUES ($1,$2,'UTC') RETURNING id`, [grp, name]))!.id as string;
  const ch = await mkChannel('Bucket TV');
  const other = await mkChannel('Other TV');
  const root = `channel/${ch}/`;

  // A day: a run the day before, two runs inside the recording (the second one
  // with 12 segments, so seg_10 must sort after seg_9), one inside without the
  // recording's rendition, one after it ends; another channel with the same run id.
  const day = Date.UTC(2026, 10, 12, 0, 0, 0);
  const before = runIdAt(day - 3600_000), r1 = runIdAt(day + 3600_000), r2 = runIdAt(day + 5 * 3600_000);
  const audioOnly = runIdAt(day + 3 * 3600_000), after = runIdAt(day + 20 * 3600_000);
  layRun(root, before); layRun(root, r1); layRun(root, r2, ['720p', '360p'], 12);
  layRun(root, audioOnly, ['audio']); layRun(root, after);
  layRun(`channel/${other}/`, r1);
  put(`${root}runs/not-a-run-id/720p/seg_1.m4s`);
  put(`${root}current_run.txt`); put(`${root}720p/index.m3u8`);

  const rec = await one<any>(
    `INSERT INTO recordings(kind, channel_id, day_utc, status, hi_res_rendition, master_key, start_epoch_ms, end_epoch_ms, duration_ms, thumb_status)
     VALUES ('channel_day', $1, '2026-11-12', 'complete', '720p', $2, $3, $4, $5, 'processing') RETURNING *`,
    [ch, `channel/${ch}/2026-11-12`, day + 3600_000 - 2000, day + 10 * 3600_000, 9 * 3600_000 + 2000]);

  // ---- the playlist ----------------------------------------------------------
  const built = await buildRecordingSource(rec);
  ok(built, 'a playlist is built from the bucket');
  const text = built?.text ?? '';
  ok(JSON.stringify(built?.runs) === JSON.stringify([r1, r2]), 'only the runs that started inside the recording, in order', built?.runs);
  ok(built?.segments === 15, '3 + 12 segments of the recorded rendition', built?.segments);
  const u = uris(text);
  ok(u.length === 15 && u.every((x) => x.startsWith(`s3://${BUCKET}/${root}runs/`)), 'every address is an s3:// key under this channel\'s runs');
  ok(u.every((x) => x.includes('/720p/seg_')), 'only the hi-res rendition, never thumbs, the loop or 360p');
  ok(!text.includes(before) && !text.includes(after) && !text.includes(audioOnly), 'not the run before, after, or one without the rendition');
  ok(!text.includes(`channel/${other}/`), 'not another channel\'s run with the same id');
  ok(!text.includes('not-a-run-id') && !text.includes('current_run.txt'), 'not a folder the encoder did not name, not the stream root');
  const r2segs = u.filter((x) => x.includes(r2)).map((x) => Number(/seg_(\d+)/.exec(x)![1]));
  ok(JSON.stringify(r2segs) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), 'segments in numeric order', r2segs);
  ok(text.startsWith('#EXTM3U') && text.includes('#EXT-X-PLAYLIST-TYPE:VOD') && text.trim().endsWith('#EXT-X-ENDLIST'), 'a VOD playlist that ends (ffmpeg would wait on a live one)');
  ok((text.match(/#EXT-X-DISCONTINUITY/g) ?? []).length === 1, 'one discontinuity, between the two runs');
  const maps = [...text.matchAll(/#EXT-X-MAP:URI="([^"]+)"/g)].map((m) => m[1]);
  ok(maps.length === 2 && maps[0].endsWith(`runs/${r1}/720p/init.mp4`) && maps[1].endsWith(`runs/${r2}/720p/init.mp4`), 'each run its own init segment', maps);
  ok(text.indexOf('#EXT-X-DISCONTINUITY') < text.indexOf(maps[1]), 'the second init comes after the discontinuity');
  ok((text.match(/#EXTINF:4\.000,/g) ?? []).length === 15, 'a duration per segment');

  // An open recording reaches to now.
  const open = await buildRecordingSource({ ...rec, end_epoch_ms: null }, { now: day + 21 * 3600_000 });
  ok(open?.runs.includes(after), 'an open recording takes runs up to now');
  // Nothing in the window.
  const empty = await buildRecordingSource({ ...rec, start_epoch_ms: day + 11 * 3600_000, end_epoch_ms: day + 12 * 3600_000 });
  ok(empty === null, 'no run in the window: no playlist');
  ok(await buildRecordingSource({ ...rec, hi_res_rendition: '../x' }) === null, 'a rendition name that is not a folder name is refused');

  // ---- written to the bucket -------------------------------------------------
  const n0 = calls.length;
  const w = await writeRecordingSource(rec);
  ok(w?.uri === `s3://${BUCKET}/thumbs/${rec.id}/source.m3u8` && recordingSourceKey(rec.id) === `thumbs/${rec.id}/source.m3u8`, 'kept beside the recording\'s thumbnails', w);
  ok(bucket.get(`thumbs/${rec.id}/source.m3u8`)?.body === text, 'the same playlist is put');
  ok(bucket.get(`thumbs/${rec.id}/source.m3u8`)?.type === 'application/vnd.apple.mpegurl', 'as a playlist');
  ok(calls.slice(n0).filter((c) => c.op === 'PutObject').length === 1, 'one put');
  ok(calls.slice(n0).every((c) => c.op !== 'ListObjectsV2' || c.prefix!.startsWith(root)), 'only this channel is listed');

  // ---- the thumbnailer job on ECS -------------------------------------------
  const jobs: any[] = [];
  const launcher: any = { launchThumbnailer: async (j: any) => { jobs.push(j); return { taskArn: 't', lifecycle: 'on_demand' }; } };
  const orch: any = new Orchestrator(launcher);
  await orch.finalizeRecording(rec);
  ok(jobs.length === 1, 'the thumbnailer is started');
  ok(jobs[0]?.source === `s3://${BUCKET}/thumbs/${rec.id}/source.m3u8`, 'it reads the recording\'s playlist, not the old master_key path', jobs[0]?.source);
  ok(jobs[0]?.out_s3 === `s3://${BUCKET}/thumbs/${rec.id}`, 'outputs where they always went');

  const lost = await one<any>(
    `INSERT INTO recordings(kind, channel_id, day_utc, status, hi_res_rendition, master_key, start_epoch_ms, end_epoch_ms, duration_ms, thumb_status)
     VALUES ('channel_day', $1, '2026-11-13', 'complete', '720p', 'x', $2, $3, 3600000, 'processing') RETURNING *`,
    [ch, day + 30 * 3600_000, day + 31 * 3600_000]);
  jobs.length = 0;
  await orch.finalizeRecording(lost);
  ok(jobs.length === 0, 'nothing in the bucket: no task started (it could only fail)');
  ok((await one<any>(`SELECT thumb_status FROM recordings WHERE id = $1`, [lost.id]))?.thumb_status === 'error', 'and the recording says error, not processing for ever');

  // ---- the local launchers keep the old job ----------------------------------
  (config.orchestrator as any).launcher = 'local';
  jobs.length = 0;
  const p0 = calls.filter((c) => c.op === 'PutObject').length;
  await orch.finalizeRecording(rec);
  ok(jobs[0]?.source === `s3://${BUCKET}/channel/${ch}/2026-11-12/720p/index.m3u8` && jobs[0]?.stream_id === ch, 'the local launcher gets the job as before (it reads the disk by stream id)', jobs[0]);
  ok(calls.filter((c) => c.op === 'PutObject').length === p0, 'and nothing is written to the bucket');

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
