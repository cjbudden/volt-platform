// ============================================================================
//  JOB SYSTEM CHECKS — against a real Postgres, not a mock.
//
//  These test the three properties the old optimistic-status-claim design could
//  not provide, and which everything downstream in the recording/clip/VOD brief
//  depends on:
//
//    1. a job claimed by a worker that dies comes BACK (lease + reaper);
//    2. a job that exhausts its attempts fails WITH A REASON;
//    3. two workers polling the same table never claim the same row.
//
//  Run: DATABASE_URL=... npx tsx test/jobs.check.ts
// ============================================================================
import { pool, query, one } from '../src/db';
import { migrate } from '../src/services/migrate';
import {
  enqueue, claim, heartbeat, succeed, fail, cancel, retry,
  reapExpiredLeases, getJob, backoffSeconds, type JobRow,
} from '../src/services/jobs/queue';

let pass = 0, failed = 0;
const ok = (name: string) => { console.log(`PASS ${name}`); pass++; };
const bad = (name: string, detail: string) => { console.log(`FAIL ${name} -- ${detail}`); failed++; };
function check(name: string, actual: unknown, expected: unknown) {
  if (Object.is(actual, expected)) ok(name);
  else bad(name, `expected [${String(expected)}] got [${String(actual)}]`);
}
function truthy(name: string, v: unknown) { v ? ok(name) : bad(name, `expected truthy, got [${String(v)}]`); }

const TYPE = `test.job.${Date.now()}`;

async function cleanup() {
  await query(`DELETE FROM jobs WHERE type LIKE 'test.job.%'`);
}

async function main() {
  await migrate();

  // ---------------------------------------------------------------- enqueue
  const j1 = await enqueue({ type: TYPE, payload: { n: 1 } });
  check('enqueue returns a queued job', j1.state, 'queued');
  check('a new job starts at zero attempts', j1.attempts, 0);

  // ---------------------------------------------------------------- dedupe
  const key = `dedupe-${Date.now()}`;
  const a = await enqueue({ type: TYPE, dedupeKey: key });
  const b = await enqueue({ type: TYPE, dedupeKey: key });
  check('a duplicate enqueue returns the SAME job, not a second one', b.id, a.id);
  const dupCount = await one<{ n: string }>(
    `SELECT count(*)::text AS n FROM jobs WHERE dedupe_key=$1`, [key]);
  check('only one row exists for the dedupe key', dupCount!.n, '1');

  // ---------------------------------------------------------------- claiming
  const c1 = await claim([TYPE], 'worker-A');
  truthy('a worker can claim a queued job', c1);
  check('claiming sets state to running', c1!.state, 'running');
  check('claiming increments attempts', c1!.attempts, 1);
  truthy('claiming takes a lease', c1!.lease_until);

  // PROPERTY 3: no double-claim. Claim everything available with two workers
  // and assert no id comes back twice.
  const seen = new Set<string>([c1!.id]);
  let collision = false;
  for (let i = 0; i < 6; i++) {
    const worker = i % 2 === 0 ? 'worker-A' : 'worker-B';
    const got = await claim([TYPE], worker);
    if (!got) break;
    if (seen.has(got.id)) collision = true;
    seen.add(got.id);
  }
  check('two workers never claim the same job', collision, false);

  // ---------------------------------------------------------------- progress
  await heartbeat(c1!.id, 42, 'halfway');
  const beat = await getJob(c1!.id);
  check('heartbeat records progress', beat!.progress_pct, 42);
  check('heartbeat records a note', beat!.progress_note, 'halfway');
  truthy('heartbeat extends the lease', new Date(beat!.lease_until!).getTime() > Date.now());

  // ---------------------------------------------------------------- success
  await succeed(c1!.id, { produced: 'thing' });
  const done = await getJob(c1!.id);
  check('a succeeded job is terminal', done!.state, 'succeeded');
  check('a succeeded job reads 100%', done!.progress_pct, 100);
  check('a succeeded job keeps its result', done!.result.produced, 'thing');
  truthy('a succeeded job releases its lease', done!.lease_until === null);

  // -------------------------------------------- PROPERTY 2: failure has a reason
  const j2 = await enqueue({ type: TYPE, maxAttempts: 2 });
  await claim([TYPE], 'worker-A');   // may claim j2 or an earlier queued row
  const c2 = (await getJob(j2.id))!.state === 'running'
    ? await getJob(j2.id)
    : await claimSpecific(j2.id, 'worker-A');
  await fail(c2!.id, new Error('ffmpeg exited 1'), { code: 'encode_failed' });
  const after1 = await getJob(j2.id);
  check('a failure with attempts left requeues', after1!.state, 'queued');
  check('the reason is recorded on requeue', after1!.last_error, 'ffmpeg exited 1');
  check('the error code is recorded', after1!.error_code, 'encode_failed');
  truthy('backoff pushes run_after into the future',
    new Date(after1!.run_after).getTime() > Date.now());

  // exhaust it
  await query(`UPDATE jobs SET run_after = now() WHERE id=$1`, [j2.id]);
  const c2b = await claimSpecific(j2.id, 'worker-A');
  await fail(c2b!.id, new Error('ffmpeg exited 1 again'), { code: 'encode_failed' });
  const after2 = await getJob(j2.id);
  check('attempts exhausted becomes terminal failed', after2!.state, 'failed');
  check('the terminal failure keeps its reason', after2!.last_error, 'ffmpeg exited 1 again');

  // permanent errors skip retries entirely
  const j3 = await enqueue({ type: TYPE, maxAttempts: 5 });
  const c3 = await claimSpecific(j3.id, 'worker-A');
  await fail(c3!.id, new Error('source recording is missing'), { code: 'missing_source', permanent: true });
  const after3 = await getJob(j3.id);
  check('a permanent error fails immediately despite attempts left', after3!.state, 'failed');
  check('a permanent error keeps its code', after3!.error_code, 'missing_source');

  // ------------------------------------- PROPERTY 1: a dead worker's job comes back
  const j4 = await enqueue({ type: TYPE, maxAttempts: 3 });
  const c4 = await claimSpecific(j4.id, 'worker-that-dies');
  check('the job is running before the worker dies', c4!.state, 'running');
  // simulate death: the worker stops heartbeating and its lease lapses
  await query(`UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id=$1`, [j4.id]);
  const reaped = await reapExpiredLeases();
  truthy('the reaper found the expired lease', reaped >= 1);
  const after4 = await getJob(j4.id);
  check('a dead worker\'s job returns to the queue', after4!.state, 'queued');
  check('the reaper says why', after4!.error_code, 'lease_expired');
  truthy('the job is immediately claimable again',
    new Date(after4!.run_after).getTime() <= Date.now() + 1000);
  const c4b = await claimSpecific(j4.id, 'worker-B');
  truthy('another worker picks it up', c4b);
  check('the retry counts as a further attempt', c4b!.attempts, 2);

  // a reaped job with no attempts left fails rather than looping forever
  await query(`UPDATE jobs SET attempts = max_attempts, lease_until = now() - interval '1 second'
                WHERE id=$1`, [j4.id]);
  await reapExpiredLeases();
  const after4b = await getJob(j4.id);
  check('a reaped job with attempts spent fails', after4b!.state, 'failed');

  // ---------------------------------------------------------------- attempts log
  const attempts = await query<{ attempt: number; outcome: string }>(
    `SELECT attempt, outcome FROM job_attempts WHERE job_id=$1 ORDER BY attempt`, [j4.id]);
  truthy('every attempt is recorded', attempts.length >= 2);
  truthy('the expired attempt is labelled',
    attempts.some((a) => a.outcome === 'lease_expired'));

  // ---------------------------------------------------------------- cancel / retry
  const j5 = await enqueue({ type: TYPE });
  check('a queued job can be cancelled', await cancel(j5.id), true);
  check('a cancelled job is terminal', (await getJob(j5.id))!.state, 'cancelled');
  check('a cancelled job can be retried', await retry(j5.id), true);
  const after5 = await getJob(j5.id);
  check('retry requeues it', after5!.state, 'queued');
  check('retry resets attempts', after5!.attempts, 0);
  check('retry clears the old error', after5!.last_error, null);

  // ---------------------------------------------------------------- backoff shape
  truthy('backoff grows', backoffSeconds(1) < backoffSeconds(3));
  check('backoff is capped at an hour', backoffSeconds(20), 3600);

  // ---------------------------------------------------------------- claim scoping
  const other = await claim(['some.other.type'], 'worker-A');
  check('a worker never claims a type it does not handle', other, null);

  await cleanup();
  console.log(`\njobs: ${pass} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

/** Claim one specific job, so a test is not at the mercy of queue ordering. */
async function claimSpecific(id: string, worker: string): Promise<JobRow | null> {
  const rows = await query<JobRow>(
    `UPDATE jobs SET state='running', attempts=attempts+1, claimed_by=$2, claimed_at=now(),
            lease_until=now() + interval '120 seconds', started_at=COALESCE(started_at, now())
      WHERE id=$1 AND state='queued' RETURNING *`, [id, worker]);
  const job = rows[0] ?? null;
  if (job) {
    await query(`INSERT INTO job_attempts (job_id, attempt, claimed_by) VALUES ($1,$2,$3)`,
      [job.id, job.attempts, worker]);
  }
  return job;
}

main().catch(async (e) => {
  console.error('THREW', e);
  await cleanup().catch(() => {});
  await pool.end();
  process.exit(1);
});
