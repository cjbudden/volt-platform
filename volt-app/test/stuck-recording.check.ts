// ============================================================================
//  THE STATION THAT RECORDS FOREVER.
//
//  Reported from a real machine: three radio stations shown as RECORDING with
//  nothing started, and no amount of starting and stopping them cleared it.
//
//  It was a deadlock between three pieces that are each individually correct.
//
//    1. reconcileStreamStatus() works from a list of owners whose status is
//       'live'. Right for correcting a status; wrong for reaping a claim.
//    2. reconcileOrphanRecordings() refuses to close a recording while an
//       un-terminated instance row exists for that owner. Right, because an
//       open instance means something may still be writing.
//    3. run-on-mac.sh sets every live channel to 'ended' BEFORE the API boots,
//       so the list is truthful on a fresh start. Also right.
//
//  Together: the owner is 'ended', so (1) never visits it, so its instance row
//  is never closed, so (2) never closes the recording, so it reads as
//  recording forever. Nothing in the product could break the cycle, because
//  pressing Start finds the open instance row and reports the stream as
//  already running.
//
//  A SECOND, INDEPENDENT CAUSE OF THE SAME SYMPTOM. MockTaskLauncher used to
//  answer 'alive' for any arn it had not been told about. Every arn is unknown
//  to a freshly started process, so after any restart the mock vouched for
//  every instance row in the database, including rows the previous run left
//  open. Both are fixed and both are asserted here, because either one alone
//  reproduces the report.
//
//  THE ASSERTIONS ARE ABOUT ESCAPE, NOT ABOUT TIDINESS. What made this bad was
//  not the wrong badge; it was that there was no way out of the state. So the
//  suite checks that the state clears, and that it clears WITHOUT anyone
//  touching the database.
//
//  Usage: DATABASE_URL=... npx tsx test/stuck-recording.check.ts
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

const A = '00000000-0000-0000-0000-000009950001';
const P = '00000000-0000-0000-0000-000009950010';
const G = '00000000-0000-0000-0000-000009950011';
const S1 = '00000000-0000-0000-0000-000009950021';
const S2 = '00000000-0000-0000-0000-000009950022';
const S3 = '00000000-0000-0000-0000-000009950023';
const LIVE = '00000000-0000-0000-0000-000009950024';

async function seed() {
  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'StuckCo')`, [A]);
  await query(
    `INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type,packaging,segment_dur,dvr_window_sec)
     VALUES ($1,$2,'p','[{"height":0,"bitrate_kbps":128}]','package_only','both',4,60)`, [P, A]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels)
               VALUES ($1,$2,'g',$3,20)`, [G, A, P]);
  // Three stations in the reported state, plus one genuinely live channel that
  // must NOT be disturbed: a reaper that tidies the fleet by tearing down a
  // running stream is a far worse bug than the one being fixed.
  await query(
    `INSERT INTO channels(id,group_id,name,status,kind) VALUES
       ($1,$5,'Jazz FM','ended','radio'),
       ($2,$5,'Talk FM','ended','radio'),
       ($3,$5,'Rock FM','ended','radio'),
       ($4,$5,'On Air TV','live','tv')`,
    [S1, S2, S3, LIVE, G]
  );
}

/** The state run-on-mac.sh leaves behind: owner ended, claim still open. */
async function stick(channelId: string, arn: string, startedMinsAgo = 90) {
  await query(
    `INSERT INTO instances(channel_id, task_arn, is_gpu, lifecycle, role, task_kind, state, launched_at)
     VALUES ($1,$2,false,'on_demand','primary','radio','running', now() - make_interval(mins => $3))`,
    [channelId, arn, startedMinsAgo]
  );
  await query(
    `INSERT INTO recordings(kind, channel_id, title, status, hi_res_rendition, master_key,
                            start_epoch_ms, day_utc, retention_days)
     VALUES ('channel_day', $1, 'day', 'recording', 'audio', $2,
             (extract(epoch from now())*1000)::bigint - $3, current_date, 7)`,
    [channelId, `channel/${channelId}`, startedMinsAgo * 60_000]
  );
}

const openInstances = async (id: string) =>
  (await query(`SELECT id FROM instances WHERE channel_id=$1 AND terminated_at IS NULL`, [id])).length;
const openRecordings = async (id: string) =>
  (await query(`SELECT id FROM recordings WHERE channel_id=$1 AND status='recording'`, [id])).length;

(async () => {
  await seed();
  try {
    // ======================================================================
    console.log('\n== the mock no longer vouches for a task it never launched ==');
    //
    // Cause number two, on its own. A fresh process has issued no arns, so an
    // arn from the previous run must read as dead. Answering 'alive' is what
    // made every leftover row un-reapable across a restart.
    // ======================================================================
    {
      const fresh = new MockTaskLauncher();
      check('an arn from a previous process is dead',
            await fresh.isRunning('mock:radio:someone-else:1'), 'dead');
      const res = await fresh.launchRadio(S1, {});
      check('an arn it just issued is alive', await fresh.isRunning(res.taskArn), 'alive');
      await fresh.stopTask(res.taskArn, 'test');
      check('and is dead once stopped', await fresh.isRunning(res.taskArn), 'dead');
      // The three-valued contract survives: a launcher that cannot tell must
      // still be able to say so, or the reaper starts tearing down healthy
      // streams on a network blip.
      fresh.unknownArns.add('mock:radio:unreachable:9');
      check('and "cannot tell" is still expressible',
            await fresh.isRunning('mock:radio:unreachable:9'), 'unknown');
    }

    // ======================================================================
    console.log('\n== the reported state: three stations recording, none running ==');
    // ======================================================================
    await stick(S1, 'mock:radio:jazz:1');
    await stick(S2, 'mock:radio:talk:1');
    await stick(S3, 'mock:radio:rock:1');

    check('Jazz FM has an open claim', await openInstances(S1), 1);
    check('and an open recording', await openRecordings(S1), 1);
    check('while the channel itself says ended',
          (await one<any>(`SELECT status FROM channels WHERE id=$1`, [S1]))?.status, 'ended');

    // A fresh orchestrator, exactly as a restarted control plane has.
    const orch = new Orchestrator(new MockTaskLauncher());

    // ----------------------------------------------------------------------
    // THE OLD BEHAVIOUR, DEMONSTRATED. The status reconciler is the pass that
    // was supposed to catch this, and it cannot: its work list is owners whose
    // status is 'live', and these are 'ended'.
    // ----------------------------------------------------------------------
    await orch.reconcileStreamStatus();
    check('the status reconciler cannot see an ended owner\'s open claim',
          await openInstances(S1), 1);
    await orch.reconcileOrphanRecordings();
    check('so the recording sweep is still blocked by that claim',
          await openRecordings(S1), 1);

    // ----------------------------------------------------------------------
    // THE FIX.
    // ----------------------------------------------------------------------
    const reaped = await orch.reapOrphanInstances();
    check('reaping from the claims closes all three', reaped, 3);
    check('Jazz FM has no open claim left', await openInstances(S1), 0);
    check('nor Talk FM', await openInstances(S2), 0);
    check('nor Rock FM', await openInstances(S3), 0);

    const closed = await orch.reconcileOrphanRecordings();
    check('and the recordings can now close', closed, 3);
    check('Jazz FM is no longer recording', await openRecordings(S1), 0);
    check('nor Talk FM', await openRecordings(S2), 0);
    check('nor Rock FM', await openRecordings(S3), 0);

    const rec = await one<any>(
      `SELECT status, end_epoch_ms, duration_ms FROM recordings WHERE channel_id=$1`, [S1]);
    check('it is marked complete, the same word a clean stop writes', rec.status, 'complete');
    truthy('with an end time', rec.end_epoch_ms != null);
    truthy('and a positive duration, not a negative one from a bad clock',
           Number(rec.duration_ms) > 0);

    // ======================================================================
    console.log('\n== a running stream is not touched ==');
    //
    // The failure mode of the fix. A reaper that works from claims rather than
    // from live owners could, done carelessly, close the claim of something
    // that is actually on air. `On Air TV` is live with a task the launcher
    // has issued, and it must survive every pass above.
    // ======================================================================
    const live = new MockTaskLauncher();
    const liveRes = await live.launchEncoder(LIVE, {});
    await query(
      `INSERT INTO instances(channel_id, task_arn, is_gpu, lifecycle, role, task_kind, state, launched_at)
       VALUES ($1,$2,false,'on_demand','primary','transcode','running', now())`,
      [LIVE, liveRes.taskArn]);
    await query(
      `INSERT INTO recordings(kind, channel_id, title, status, hi_res_rendition, master_key,
                              start_epoch_ms, day_utc, retention_days)
       VALUES ('channel_day', $1, 'day', 'recording', '720p', $2,
               (extract(epoch from now())*1000)::bigint - 60000, current_date, 7)`,
      [LIVE, `channel/${LIVE}`]);

    const orchLive = new Orchestrator(live);
    await orchLive.reapOrphanInstances();
    check('a live channel keeps its claim', await openInstances(LIVE), 1);
    await orchLive.reconcileOrphanRecordings();
    check('and keeps recording', await openRecordings(LIVE), 1);

    // ======================================================================
    console.log('\n== "cannot tell" never reaps ==');
    //
    // The rule the whole liveness design rests on: only a definite `dead`
    // reconciles. A launcher that cannot reach its control plane must leave
    // everything exactly where it is, or one network blip clears the fleet.
    // ======================================================================
    await query(`UPDATE channels SET status='ended' WHERE id=$1`, [LIVE]);
    const blind = new MockTaskLauncher();
    blind.unknownArns.add(liveRes.taskArn);
    const orchBlind = new Orchestrator(blind);
    check('an unreachable launcher reaps nothing', await orchBlind.reapOrphanInstances(), 0);
    check('the claim survives', await openInstances(LIVE), 1);
    check('and so does the recording',
          await orchBlind.reconcileOrphanRecordings().then(() => openRecordings(LIVE)), 1);

    // ======================================================================
    console.log('\n== and the whole thing clears itself on a tick ==');
    //
    // The assertion that actually matters to the person who reported it: no
    // manual step, no SQL. Put the state back and let the ordinary tick run.
    // ======================================================================
    // Re-stuck by REOPENING the same day's recording rather than inserting a
    // second one: channel-day recordings are unique per (channel, day), which
    // is itself part of why this state was so persistent — you cannot simply
    // start a fresh day's recording alongside the stuck one.
    await query(
      `INSERT INTO instances(channel_id, task_arn, is_gpu, lifecycle, role, task_kind, state, launched_at)
       VALUES ($1,'mock:radio:jazz:2',false,'on_demand','primary','radio','running', now() - interval '90 minutes')`,
      [S1]);
    await query(
      `UPDATE recordings SET status='recording', end_epoch_ms=NULL, duration_ms=NULL WHERE channel_id=$1`,
      [S1]);
    check('stuck again', await openRecordings(S1), 1);
    check('with a fresh open claim', await openInstances(S1), 1);
    await new Orchestrator(new MockTaskLauncher()).tick();
    check('one tick clears the claim', await openInstances(S1), 0);
    check('and the recording with it', await openRecordings(S1), 0);
  } finally {
    await query(`DELETE FROM accounts WHERE id=$1`, [A]).catch(() => {});
  }

  console.log(`\nstuck-recording: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
