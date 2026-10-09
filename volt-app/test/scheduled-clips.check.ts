// ============================================================================
//  SCHEDULER-DRIVEN CLIPS ACTUALLY GET BUILT.
//
//  There are three ways a clip comes into existence, and until now only one of
//  them queued the work that turns the row into media:
//
//    /api/recordings/:id/clip     an operator cutting by hand      -> enqueued
//    EPG post-airing auto clip    the scheduler, unattended        -> NOT
//    scheduled_clips firing       the scheduler, unattended        -> NOT
//
//  So the two paths that exist precisely BECAUSE nobody is watching were the
//  two that silently produced nothing: an asset stuck at thumb_status
//  'processing', pointing at a manifest that would never be written, while the
//  programme row said `created` and the EPG page reported success. Nothing
//  errored. You would find out when someone tried to play it.
//
//  These assertions are about the JOB, not about the row, because the row was
//  never the part that was missing.
//
//  Usage: DATABASE_URL=... npx tsx test/scheduled-clips.check.ts
// ============================================================================
import { pool, query, one } from '../src/db';
import { Orchestrator } from '../src/services/orchestrator/service';
import { MockTaskLauncher } from '../src/services/orchestrator/launcher';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected truthy, got [${String(v)}]`));

const A = '00000000-0000-0000-0000-000009940001';
const P = '00000000-0000-0000-0000-000009940010';
const G = '00000000-0000-0000-0000-000009940011';
const CH = '00000000-0000-0000-0000-000009940021';
const REC = '00000000-0000-0000-0000-000009940031';
const PROG = '00000000-0000-0000-0000-000009940041';
const SC = '00000000-0000-0000-0000-000009940051';

// A window in the past, so both the programme and the scheduled clip are due.
const START = Date.now() - 3_600_000;
const END = START + 600_000;

async function seed() {
  await query(`DELETE FROM accounts WHERE id = $1`, [A]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'ClipCo')`, [A]);
  await query(
    `INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type)
     VALUES ($1,$2,'p','[]','package_only')`, [P, A]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id) VALUES ($1,$2,'g',$3)`, [G, A, P]);
  await query(`INSERT INTO channels(id,group_id,name,status) VALUES ($1,$2,'Clip Channel','live')`, [CH, G]);
  // A recording that COVERS the window, or neither path has anything to cut.
  await query(
    `INSERT INTO recordings(id,kind,channel_id,day_utc,status,start_epoch_ms,end_epoch_ms,master_key)
     VALUES ($1::uuid,'channel_day',$2::uuid,current_date,'complete',$3,$4,$5)`,
    [REC, CH, START - 60_000, END + 60_000, `channel/${CH}`]);
}

(async () => {
  await seed();
  const orch = new Orchestrator(new MockTaskLauncher());

  // ---- EPG post-airing auto clip -----------------------------------------
  await query(
    `INSERT INTO programmes(id,channel_id,title,starts_at,ends_at,auto_vod,clip_status,metadata)
     VALUES ($1,$2,'The Nine O''Clock Show', to_timestamp($3/1000.0), to_timestamp($4/1000.0),
             true,'none','{"genre":"news"}'::jsonb)`,
    [PROG, CH, START, END]);

  const fired = await orch.fireProgrammeClips();
  truthy('the programme fires', fired >= 1);

  const prog = await one<any>(`SELECT clip_status, clip_asset_id FROM programmes WHERE id=$1`, [PROG]);
  check('and is marked created', prog?.clip_status, 'created');
  truthy('with an asset attached', !!prog?.clip_asset_id);

  // THE POINT OF THE SUITE. `created` claimed the work was done; nothing had
  // been asked to do it.
  const epgJob = await one<any>(
    `SELECT id, payload FROM jobs
      WHERE type='clip.extract' AND payload->>'vodAssetId' = $1`, [prog?.clip_asset_id]);
  truthy('AND THE BUILD IS QUEUED', !!epgJob);
  check('for the programme’s own range',
    Number(epgJob?.payload?.fromMs), START);
  check('to its own end', Number(epgJob?.payload?.toMs), END);

  const asset = await one<any>(
    `SELECT thumb_status, metadata FROM vod_assets WHERE id=$1`, [prog?.clip_asset_id]);
  check('the asset is awaiting that build, not finished', asset?.thumb_status, 'processing');
  check('and it harvested the programme metadata', asset?.metadata?.genre, 'news');

  // Firing again must not queue a second build for the same cut: the status
  // compare-and-swap is what stops two ticks doubling up.
  await orch.fireProgrammeClips();
  const epgJobs = await one<any>(
    `SELECT count(*)::int n FROM jobs
      WHERE type='clip.extract' AND payload->>'vodAssetId' = $1`, [prog?.clip_asset_id]);
  check('a second tick does not queue it twice', epgJobs?.n, 1);

  // ---- scheduled clips ----------------------------------------------------
  await query(
    `INSERT INTO scheduled_clips(id,channel_id,title,start_epoch_ms,end_epoch_ms,output_kind,status)
     VALUES ($1,$2,'Booked Highlight',$3,$4,'both','scheduled')`,
    [SC, CH, START + 60_000, START + 180_000]);

  await orch.fireScheduledClips();
  const sc = await one<any>(`SELECT status, vod_asset_id FROM scheduled_clips WHERE id=$1`, [SC]);
  check('the scheduled clip is marked done', sc?.status, 'done');
  truthy('with an asset attached', !!sc?.vod_asset_id);

  const scJob = await one<any>(
    `SELECT id, payload FROM jobs
      WHERE type='clip.extract' AND payload->>'vodAssetId' = $1`, [sc?.vod_asset_id]);
  truthy('AND ITS BUILD IS QUEUED TOO', !!scJob);
  check('for the booked range', Number(scJob?.payload?.fromMs), START + 60_000);
  truthy('carrying the formats its output kind implies',
    Array.isArray(scJob?.payload?.formats) && scJob.payload.formats.includes('hls')
      && scJob.payload.formats.includes('mp4'));

  // ---- one implementation, not three -------------------------------------
  // Every path builds its dedupe key the same way, which is what stops a
  // re-cut being deduped against the build of the range it replaced.
  truthy('the dedupe key carries the range, not just the asset',
    String(scJob?.payload ? await one<any>(
      `SELECT dedupe_key FROM jobs WHERE id=$1`, [scJob.id]).then((r: any) => r?.dedupe_key) : '')
      .includes(`${START + 60_000}-${START + 180_000}`));

  await query(`DELETE FROM accounts WHERE id = $1`, [A]);
  console.log(`\nscheduled-clips: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
