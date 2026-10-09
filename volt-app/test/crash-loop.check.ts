// ============================================================================
//  THE CRASH LOOP.
//
//  Reported from a demo machine: a radio station that would not stay up, and
//  ninety run directories in the origin folder. The logs said the same four
//  lines over and over, twenty seconds apart:
//
//      Connection to tcp://localhost:8000 failed: Connection refused
//      Error opening output icecast://…  Connection refused
//      ffmpeg exited unexpectedly (rc=195)
//      channel.stop  reason: encoder exited rc=195
//
//  TWO SEPARATE DEFECTS, and it took both to produce that.
//
//  1. ONE FFMPEG CARRIES EVERY OUTPUT. It opens them all before encoding
//     anything, so a refused icecast:// connection did not cost the MP3 — it
//     killed the process, and HLS and DASH were never written either. A
//     deployment with no relay produced NOTHING. bin/radio.py now probes the
//     relay first and drops the MP3 output when it is unreachable, which is
//     what makes the config's long-standing claim ("HLS and DASH carry on
//     regardless") actually true. Covered by radio-relay.check.sh.
//
//  2. AUTO CONNECT COULD NOT SEE IT, which is what this suite is about.
//
//     The five-attempt give-up counted a start that THREW. Here the start
//     succeeded every time — the launcher launched the process quite happily —
//     so the bookkeeping reset resume_attempts to 0, and the crash a second
//     later was invisible to the counter. Zero, forever, at twenty-second
//     intervals.
//
//     The missing signal is DURATION. A run that dies within the flap window
//     never really started, and that is the signature of a broken
//     configuration rather than a transient fault: a source that is gone, a
//     relay that is not running, credentials that are wrong. Those must stop
//     being retried. A run that lasted hours and then failed is a real session
//     that ended badly and must STILL be recovered, however often it happens —
//     that asymmetry is the whole design and both halves are asserted here.
//
//  Usage: DATABASE_URL=... npx tsx test/crash-loop.check.ts
// ============================================================================
import { pool, query, one } from '../src/db';
import { Orchestrator } from '../src/services/orchestrator/service';
import { MockTaskLauncher } from '../src/services/orchestrator/launcher';
import { resumeOnce, expireStaleBudgets } from '../src/services/orchestrator/resume';
import { config } from '../src/config';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected truthy, got [${String(v)}]`));
const falsy = (m: string, v: unknown) => (!v ? ok(m) : bad(m, `expected falsy, got [${String(v)}]`));

const A = '00000000-0000-0000-0000-000009970001';
const P = '00000000-0000-0000-0000-000009970010';
const G = '00000000-0000-0000-0000-000009970011';
const FLAPPER = '00000000-0000-0000-0000-000009970021';
const LONG    = '00000000-0000-0000-0000-000009970022';
const LOOPER  = '00000000-0000-0000-0000-000009970023';

async function seed() {
  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'FlapCo')`, [A]);
  await query(
    `INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type,packaging,segment_dur,dvr_window_sec)
     VALUES ($1,$2,'p','[{"height":0,"bitrate_kbps":128}]','package_only','both',4,60)`, [P, A]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels)
               VALUES ($1,$2,'g',$3,20)`, [G, A, P]);
  // desired_state='running' because both stations HAVE been started: that is
  // what a real start records, and it is the state the fault path acts on.
  // Seeding only `status` would leave them ineligible for recovery and the
  // suite would pass for the wrong reason.
  await query(
    `INSERT INTO channels(id,group_id,name,status,kind,desired_state) VALUES
       ($1,$3,'Flapping FM','live','radio','running'),
       ($2,$3,'Steady FM','live','radio','running')`,
    [FLAPPER, LONG, G]
  );
  for (const id of [FLAPPER, LONG]) {
    await query(
      `INSERT INTO stream_inputs(channel_id, role, protocol, ingest_url)
       VALUES ($1,'primary','icecast','http://127.0.0.1:9999/x')`, [id]);
  }
}

/** A task that launched `secondsAgo` ago, as the fault path will find it. */
async function launched(channelId: string, secondsAgo: number) {
  await query(`UPDATE instances SET terminated_at=now(), state='terminated'
                WHERE channel_id=$1 AND terminated_at IS NULL`, [channelId]);
  await query(
    `INSERT INTO instances(channel_id, task_arn, is_gpu, lifecycle, role, task_kind, state, launched_at)
     VALUES ($1,$2,false,'on_demand','primary','radio','running', now() - make_interval(secs => $3))`,
    [channelId, `mock:radio:${channelId}:${Date.now()}${Math.random()}`, secondsAgo]
  );
}

const recovery = (id: string) =>
  one<any>(`SELECT desired_state, auto_connect, resume_attempts, resume_gave_up_at, resume_last_error
              FROM channels WHERE id=$1`, [id]);

(async () => {
  await seed();
  const orch = new Orchestrator(new MockTaskLauncher());
  try {
    console.log(`\n(flap window is ${config.orchestrator.resumeFlapSeconds}s, cap is ${config.orchestrator.resumeMaxAttempts} attempts)`);

    // ======================================================================
    console.log('\n== a fault still leaves the intent to run ==');
    //
    // Unchanged, and it must stay unchanged: recovering from a fault is what
    // auto connect is for. The brake bounds the retries; it does not disable
    // recovery.
    // ======================================================================
    await launched(FLAPPER, 1);
    await orch.stopStream('channel', FLAPPER, 'encoder exited rc=195', 'fault');
    const r1 = await recovery(FLAPPER);
    check('desired_state is still running', r1.desired_state, 'running');
    truthy('and the reason names the lifetime', /died after \d+s/.test(r1.resume_last_error ?? ''));
    truthy('including what actually failed', (r1.resume_last_error ?? '').includes('rc=195'));

    // ======================================================================
    console.log('\n== a crash records the reason; the RESTART spends the budget ==');
    //
    // WHO OWNS THE COUNTER. It used to be incremented in two places, once when
    // a run died young and again when a start threw, and the two together spent
    // the budget at twice the advertised rate: "five attempts" bought two and a
    // half relaunches.
    //
    // One attempt is one restart, so it is counted where restarts are made, in
    // the resume pass. A crash on its own changes nothing but the recorded
    // reason. That is not a technicality: nothing is retrying a stream that
    // dies while auto connect is off, or after it has given up, and charging it
    // attempts for crashes nobody responded to would write it off for a loop it
    // was never in.
    // ======================================================================
    for (let i = 0; i < config.orchestrator.resumeMaxAttempts + 3; i++) {
      await launched(FLAPPER, 1);
      await orch.stopStream('channel', FLAPPER, 'encoder exited rc=195', 'fault');
    }
    const r2 = await recovery(FLAPPER);
    check('eight crashes with nothing retrying spend nothing', r2.resume_attempts, 0);
    falsy('so it has not been written off', r2.resume_gave_up_at);
    check('the intent is still to run, so nothing was silently switched off',
          r2.desired_state, 'running');
    truthy('and the latest reason is the one on record',
           (r2.resume_last_error ?? '').includes('rc=195'));

    // ======================================================================
    console.log('\n== a LONG run that fails is NOT counted ==');
    //
    // The other half of the asymmetry, and the one that would be a serious
    // regression to get wrong. A station that plays for hours and then loses
    // its source must be recovered every time. Counting those would make a
    // busy, occasionally-flaky station give up after five incidents spread
    // over a week and stay off until somebody noticed.
    // ======================================================================
    await launched(LONG, config.orchestrator.resumeFlapSeconds + 300);
    await orch.stopStream('channel', LONG, 'source went away', 'fault');
    const r3 = await recovery(LONG);
    check('no attempt was spent', r3.resume_attempts, 0);
    falsy('nothing was recorded as an error', r3.resume_last_error);
    falsy('and it has not given up', r3.resume_gave_up_at);
    check('so it is still eligible to be resumed', r3.desired_state, 'running');

    // Ten more long failures change nothing.
    for (let i = 0; i < 10; i++) {
      await launched(LONG, config.orchestrator.resumeFlapSeconds + 300);
      await orch.stopStream('channel', LONG, 'source went away', 'fault');
    }
    check('ten long failures still spend nothing', (await recovery(LONG)).resume_attempts, 0);

    // ======================================================================
    console.log('\n== an operator stop is not a flap ==');
    //
    // Pressing Stop a second after starting is a decision, not a crash, and
    // must not consume the recovery budget of the next real start.
    // ======================================================================
    await query(`UPDATE channels SET resume_attempts=0, resume_gave_up_at=NULL,
                        resume_last_error=NULL, desired_state='running', status='live'
                  WHERE id=$1`, [LONG]);
    await launched(LONG, 1);
    await orch.stopStream('channel', LONG, 'api:operator', 'operator');
    const r4 = await recovery(LONG);
    check('the stop is recorded as intent', r4.desired_state, 'stopped');
    check('and no flap was counted', r4.resume_attempts, 0);

    // ======================================================================
    console.log('\n== THE WHOLE LOOP, driven the way it actually happens ==');
    //
    // Everything above calls stopStream directly, five times in a row. The real
    // loop does not look like that, and the difference is the entire bug this
    // section exists for. What actually happens is:
    //
    //     resume pass -> startStream SUCCEEDS -> task dies a second later
    //     -> stopStream(fault) -> twenty seconds -> resume pass -> ...
    //
    // The successful start was treated as a successful recovery and zeroed the
    // counter the crash had just incremented, so the count went 1, 1, 1, 1 for
    // ever and the cap was never reached. A demo machine ran exactly this every
    // twenty seconds and its log says "attempt 1 of 5" over and over.
    //
    // The suite passed anyway, because it never let a start happen between the
    // stops. So this one drives the loop instead of asserting the fix.
    // ======================================================================
    await query(
      // armed: this models a stream that once ran healthy and then started
      // crashing; only those are resumed at all (db5c6f0)
      `INSERT INTO channels(id,group_id,name,status,kind,desired_state,resume_armed_at)
       VALUES ($1,$2,'Looping FM','ended','radio','running',now())`, [LOOPER, G]);
    await query(
      `INSERT INTO stream_inputs(channel_id, role, protocol, ingest_url)
       VALUES ($1,'primary','icecast','http://127.0.0.1:9999/gone')`, [LOOPER]);

    const launcher = new MockTaskLauncher();
    const loopOrch = new Orchestrator(launcher);
    let starts = 0;
    for (let cycle = 1; cycle <= 12; cycle++) {
      const before = (await recovery(LOOPER)).resume_attempts;
      const r = await resumeOnce(loopOrch);
      if (r.outcomes.some((o) => o.id === LOOPER && o.result === 'started')) {
        starts++;
        // THE CRASH. Nobody stopped it: the source was never reachable and the
        // encoder exited on its own a beat after launch. Staging the arn dead
        // is what makes the next pass see a dead task rather than a live one.
        for (const arn of launcher.issued) launcher.deadArns.add(arn);
        await loopOrch.stopStream('channel', LOOPER, 'encoder exited rc=251', 'fault');
      }
      const after = (await recovery(LOOPER)).resume_attempts;
      if (cycle <= 3) console.log(`   cycle ${cycle}: attempts ${before} -> ${after}`);
      // The cooldown paces the real loop; a test cannot sit through it.
      await query(`UPDATE channels SET resume_last_attempt_at = NULL WHERE id=$1`, [LOOPER]);
    }

    const loop = await recovery(LOOPER);
    truthy('the loop is bounded: it eventually gives up', loop.resume_gave_up_at);
    check('after the cap, not before', loop.resume_attempts,
          config.orchestrator.resumeMaxAttempts);
    truthy(`it stopped launching (${starts} launches over 12 passes)`,
           starts <= config.orchestrator.resumeMaxAttempts);
    truthy('and the recorded reason names the crash',
           (loop.resume_last_error ?? '').includes('rc=251'));

    // ======================================================================
    console.log('\n== a start is not a recovery; STAYING UP is ==');
    //
    // Clearing the counter on a successful start was not an arbitrary slip, it
    // was answering the wrong question: "did we manage to launch it" rather
    // than "did it work". A run that outlives the flap window is the evidence
    // that it worked, and that is where the budget is handed back.
    // ======================================================================
    await query(`UPDATE channels SET resume_attempts=2, resume_gave_up_at=NULL,
                        resume_last_error=NULL, desired_state='running', status='live'
                  WHERE id=$1`, [LOOPER]);
    await launched(LOOPER, 1);
    await loopOrch.stopStream('channel', LOOPER, 'died young again', 'fault');
    const short = await recovery(LOOPER);
    check('a short run leaves the spent budget spent', short.resume_attempts, 2);
    truthy('and says what went wrong', (short.resume_last_error ?? '').includes('died young again'));

    await query(`UPDATE channels SET status='live', desired_state='running' WHERE id=$1`, [LOOPER]);
    await launched(LOOPER, config.orchestrator.resumeFlapSeconds + 300);
    await loopOrch.stopStream('channel', LOOPER, 'source went away', 'fault');
    check('but a run that proved itself hands the budget back',
          (await recovery(LOOPER)).resume_attempts, 0);

    // ======================================================================
    console.log('\n== a healthy stream is not adopted over and over ==');
    //
    // From the same demo log: "adopted Groove Salad -- its task never stopped",
    // once every twenty seconds, for the life of the process. Adoption is a
    // repair, and repairing something that is not broken is not free: it is a
    // launcher round trip and a write per stream per pass, and it is why that
    // machine's meter reported two hundred open tasks.
    //
    // Once a stream is confirmed on air, it must stop being a candidate.
    // ======================================================================
    await query(`UPDATE channels SET desired_state='running', status='ended',
                        resume_attempts=0, resume_gave_up_at=NULL,
                        resume_last_attempt_at=NULL WHERE id=$1`, [LONG]);
    const up = await orch.startStream('channel', LONG, 'operator');
    truthy('the stream is up', up.taskArn);

    await query(`UPDATE channels SET resume_last_attempt_at=NULL WHERE id=$1`, [LONG]);
    const pass1 = await resumeOnce(orch);
    await query(`UPDATE channels SET resume_last_attempt_at=NULL WHERE id=$1`, [LONG]);
    const pass2 = await resumeOnce(orch);
    falsy('the pass leaves an on-air stream alone',
          pass1.outcomes.some((o) => o.id === LONG));
    falsy('and does not come back for it on the next pass either',
          pass2.outcomes.some((o) => o.id === LONG));

    // ======================================================================
    console.log('\n== a give-up is not a life sentence ==');
    //
    // Reported after the cap started working: "when I restart the server and a
    // station was meant to auto start it does not." Both halves were true and
    // the second was caused by fixing the first. The counter lives in the
    // database and nothing reset it, so a station that reached five attempts
    // stayed given up across every restart, for ever, and auto connect never
    // touched it again.
    //
    // The budget belongs to a LOOP, not to the stream. Ten minutes of quiet is
    // far longer than the twenty second retry interval, so a real loop cannot
    // age out midway through itself; anything older is a different situation
    // and deserves a fresh five.
    // ======================================================================
    await query(`UPDATE channels SET desired_state='running', auto_connect=true,
                        status='ended', resume_attempts=$2, resume_gave_up_at=now(),
                        resume_last_error='encoder exited rc=251',
                        resume_last_attempt_at=now() - interval '30 seconds'
                  WHERE id=$1`, [LOOPER, config.orchestrator.resumeMaxAttempts]);
    check('a budget spent 30s ago is still spent', await expireStaleBudgets(), 0);
    truthy('so it stays given up during the loop',
           (await recovery(LOOPER)).resume_gave_up_at);

    await query(`UPDATE channels SET resume_last_attempt_at =
                        now() - make_interval(secs => $2 + 60) WHERE id=$1`,
                [LOOPER, config.orchestrator.resumeBudgetTtlSeconds]);
    truthy('but once the loop is long over it is freed', (await expireStaleBudgets()) >= 1);
    const freed = await recovery(LOOPER);
    falsy('the give-up is lifted', freed.resume_gave_up_at);
    check('with a full budget again', freed.resume_attempts, 0);
    truthy('and the reason it stopped is still on record, for the operator',
           (freed.resume_last_error ?? '').includes('rc=251'));

    // A stream an operator switched OFF is never freed: expiring its budget
    // would be the system overruling a person, which is the one thing auto
    // connect must never do.
    await query(`UPDATE channels SET desired_state='stopped', resume_attempts=$2,
                        resume_gave_up_at=now(),
                        resume_last_attempt_at=now() - interval '3 hours'
                  WHERE id=$1`, [LOOPER, config.orchestrator.resumeMaxAttempts]);
    await expireStaleBudgets();
    truthy('a stream switched off by hand keeps its give-up',
           (await recovery(LOOPER)).resume_gave_up_at);
    // Put the fixture back the way the next scenario expects to find it: given
    // up, but still INTENDED to run. Leaving it switched off would make the
    // next test assert against a stream nobody wants running, which is a
    // different question and would pass or fail for the wrong reason.
    await query(`UPDATE channels SET desired_state='running', status='ended'
                  WHERE id=$1`, [LOOPER]);

    // ======================================================================
    console.log('\n== an operator start clears a give-up ==');
    //
    // The escape hatch. Once the cause is fixed — the relay started, the
    // source restored — pressing Start must put the stream back under auto
    // connect, or a crash loop permanently disables recovery for that stream.
    // ======================================================================
    // LOOPER, not FLAPPER: the stream that was actually written off is the one
    // the driven loop above gave up on, which is the state a real operator
    // arrives at. Reaching for a stream put into that state by hand would be
    // testing the fixture rather than the escape hatch.
    await query(`UPDATE channels SET status='ended', resume_attempts=$2,
                        resume_gave_up_at=now() WHERE id=$1`,
                [LOOPER, config.orchestrator.resumeMaxAttempts]);
    const before = await recovery(LOOPER);
    truthy('it is currently given up', before.resume_gave_up_at);
    await orch.startStream('channel', LOOPER, 'operator');
    const after = await recovery(LOOPER);
    falsy('starting by hand clears the give-up', after.resume_gave_up_at);
    check('and the attempt count', after.resume_attempts, 0);
    check('with the intent to run recorded again', after.desired_state, 'running');
  } finally {
    await query(`DELETE FROM accounts WHERE id=$1`, [A]).catch(() => {});
  }

  console.log(`\ncrash-loop: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
