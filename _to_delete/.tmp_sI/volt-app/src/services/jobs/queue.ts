// ============================================================================
//  JOB QUEUE — durable, leased, retryable.
//
//  The contract, in one paragraph: a caller enqueues work and gets a job id
//  back immediately. A worker claims the oldest ready job of a type it handles,
//  holding a LEASE rather than a flag. While it works it reports progress. When
//  it finishes the job is terminal; when it throws the job is either requeued
//  with backoff or, once attempts are exhausted, failed WITH A REASON. If the
//  worker dies without doing either, the lease expires and the reaper puts the
//  job back — which is the case the old optimistic status claim could not
//  handle, and why rows could sit in 'firing' forever.
//
//  Claiming uses `FOR UPDATE SKIP LOCKED`, so N workers can poll the same table
//  concurrently and never collide: each takes a row the others have skipped.
// ============================================================================
import { query, one } from '../../db';

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface JobRow {
  id: string;
  type: string;
  state: JobState;
  priority: number;
  payload: any;
  result: any;
  progress_pct: number;
  progress_note: string | null;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  error_code: string | null;
  correlation_id: string | null;
  channel_id: string | null;
  event_id: string | null;
  claimed_by: string | null;
  lease_until: string | null;
  run_after: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  dedupe_key: string | null;
}

export interface EnqueueOpts {
  type: string;
  payload?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  correlationId?: string | null;
  channelId?: string | null;
  eventId?: string | null;
  createdBy?: string | null;
  runAfter?: Date;
  /** Same key while queued or running returns the existing job instead of a duplicate. */
  dedupeKey?: string | null;
}

/** How long a worker may hold a job before the reaper assumes it died. */
export const LEASE_SECONDS = 120;
/** Backoff before a failed attempt becomes eligible again: 30s, 2m, 8m, 32m… */
export function backoffSeconds(attempt: number): number {
  return Math.min(30 * Math.pow(4, Math.max(0, attempt - 1)), 3600);
}

/**
 * Queue work. Idempotent when `dedupeKey` is given: a second call while the
 * first is still queued or running returns that job rather than a new one, so a
 * double-clicked button cannot produce two clips.
 */
export async function enqueue(opts: EnqueueOpts): Promise<JobRow> {
  const row = await one<JobRow>(
    `INSERT INTO jobs (type, payload, priority, max_attempts, correlation_id,
                       channel_id, event_id, created_by, run_after, dedupe_key)
     VALUES ($1,$2::jsonb,$3,$4,$5,$6,$7,$8,COALESCE($9, now()),$10)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [opts.type, JSON.stringify(opts.payload ?? {}), opts.priority ?? 100,
     opts.maxAttempts ?? 3, opts.correlationId ?? null, opts.channelId ?? null,
     opts.eventId ?? null, opts.createdBy ?? null, opts.runAfter ?? null,
     opts.dedupeKey ?? null]
  );
  if (row) return row;
  // The unique partial index rejected it: an equivalent job is already in flight.
  const existing = await one<JobRow>(
    `SELECT * FROM jobs WHERE dedupe_key = $1 AND state IN ('queued','running')
      ORDER BY created_at DESC LIMIT 1`, [opts.dedupeKey]
  );
  if (existing) return existing;
  throw new Error('enqueue failed and no in-flight job matched the dedupe key');
}

/**
 * Claim the next ready job of any of `types`.
 *
 * SKIP LOCKED is what makes this safe with several workers: each transaction
 * takes the best row not already locked by a sibling, so there is no contention
 * and no double-claim, without a separate lock table or an advisory lock per id.
 */
export async function claim(types: string[], workerId: string): Promise<JobRow | null> {
  if (!types.length) return null;
  const rows = await query<JobRow>(
    `UPDATE jobs j SET
        state       = 'running',
        attempts    = j.attempts + 1,
        claimed_by  = $2,
        claimed_at  = now(),
        lease_until = now() + make_interval(secs => $3),
        started_at  = COALESCE(j.started_at, now())
      WHERE j.id = (
        SELECT id FROM jobs
         WHERE state = 'queued' AND type = ANY($1) AND run_after <= now()
         ORDER BY priority, run_after, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
      RETURNING j.*`,
    [types, workerId, LEASE_SECONDS]
  );
  const job = rows[0] ?? null;
  if (job) {
    await query(
      `INSERT INTO job_attempts (job_id, attempt, claimed_by) VALUES ($1,$2,$3)`,
      [job.id, job.attempts, workerId]
    );
  }
  return job;
}

/** Extend the lease and report progress. A long job MUST call this or be reaped. */
export async function heartbeat(jobId: string, progressPct?: number, note?: string): Promise<void> {
  await query(
    `UPDATE jobs SET
       lease_until   = now() + make_interval(secs => $2),
       progress_pct  = COALESCE($3, progress_pct),
       progress_note = COALESCE($4, progress_note)
     WHERE id = $1 AND state = 'running'`,
    [jobId, LEASE_SECONDS, progressPct ?? null, note ?? null]
  );
}

export async function succeed(jobId: string, result?: Record<string, unknown>): Promise<void> {
  await query(
    `UPDATE jobs SET state='succeeded', progress_pct=100, result=$2::jsonb,
            finished_at=now(), lease_until=NULL, last_error=NULL, error_code=NULL
      WHERE id=$1 AND state='running'`,
    [jobId, JSON.stringify(result ?? {})]
  );
  await closeAttempt(jobId, 'succeeded');
}

/**
 * Record a failure. Requeued with backoff while attempts remain; terminal after
 * that — and either way the REASON is stored, which the previous scheduled-clip
 * path never did.
 *
 * `permanent` short-circuits retries for errors that cannot succeed on a second
 * try (a missing source, an invalid range): retrying those just wastes a worker
 * and delays the operator learning what is wrong.
 */
export async function fail(
  jobId: string, err: unknown, opts: { code?: string; permanent?: boolean } = {}
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const job = await one<JobRow>(`SELECT * FROM jobs WHERE id=$1`, [jobId]);
  if (!job) return;
  const exhausted = opts.permanent === true || job.attempts >= job.max_attempts;
  if (exhausted) {
    await query(
      `UPDATE jobs SET state='failed', last_error=$2, error_code=$3,
              finished_at=now(), lease_until=NULL
        WHERE id=$1 AND state='running'`,
      [jobId, message.slice(0, 2000), opts.code ?? null]
    );
  } else {
    await query(
      `UPDATE jobs SET state='queued', last_error=$2, error_code=$3,
              lease_until=NULL, claimed_by=NULL, claimed_at=NULL,
              run_after = now() + make_interval(secs => $4)
        WHERE id=$1 AND state='running'`,
      [jobId, message.slice(0, 2000), opts.code ?? null, backoffSeconds(job.attempts)]
    );
  }
  await closeAttempt(jobId, 'failed', message, opts.code);
}

export async function cancel(jobId: string): Promise<boolean> {
  const row = await one<{ id: string }>(
    `UPDATE jobs SET state='cancelled', finished_at=now(), lease_until=NULL
      WHERE id=$1 AND state IN ('queued','running') RETURNING id`, [jobId]
  );
  if (row) await closeAttempt(jobId, 'cancelled');
  return !!row;
}

/** Put a terminally failed job back at the front of the queue, attempts reset. */
export async function retry(jobId: string): Promise<boolean> {
  const row = await one<{ id: string }>(
    `UPDATE jobs SET state='queued', attempts=0, run_after=now(),
            last_error=NULL, error_code=NULL, progress_pct=0, progress_note=NULL,
            finished_at=NULL, lease_until=NULL, claimed_by=NULL, claimed_at=NULL
      WHERE id=$1 AND state IN ('failed','cancelled') RETURNING id`, [jobId]
  );
  return !!row;
}

/**
 * THE REAPER. A worker that dies mid-job leaves a row 'running' with a lease
 * that stops being extended. This returns those to the queue (or fails them if
 * their attempts are spent) so no job is ever stranded.
 *
 * This is the specific hole in the old design: `UPDATE … SET status='firing'`
 * had nothing equivalent, so a crash between the claim and the terminal write
 * left the row unrecoverable and invisible.
 */
export async function reapExpiredLeases(): Promise<number> {
  const expired = await query<JobRow>(
    `SELECT * FROM jobs WHERE state='running' AND lease_until IS NOT NULL AND lease_until < now()`
  );
  for (const job of expired) {
    const exhausted = job.attempts >= job.max_attempts;
    await query(
      exhausted
        ? `UPDATE jobs SET state='failed', last_error=$2, error_code='lease_expired',
                  finished_at=now(), lease_until=NULL WHERE id=$1 AND state='running'`
        : `UPDATE jobs SET state='queued', last_error=$2, error_code='lease_expired',
                  lease_until=NULL, claimed_by=NULL, claimed_at=NULL,
                  run_after=now() WHERE id=$1 AND state='running'`,
      [job.id, `worker ${job.claimed_by ?? 'unknown'} stopped reporting; lease expired`]
    );
    await closeAttempt(job.id, 'lease_expired', 'lease expired', 'lease_expired');
  }
  if (expired.length) console.log(`[jobs] reaped ${expired.length} expired lease(s)`);
  return expired.length;
}

async function closeAttempt(jobId: string, outcome: string, error?: string, code?: string) {
  await query(
    `UPDATE job_attempts SET finished_at=now(), outcome=$2, error=$3, error_code=$4
      WHERE id = (SELECT id FROM job_attempts WHERE job_id=$1 ORDER BY attempt DESC LIMIT 1)
        AND finished_at IS NULL`,
    [jobId, outcome, error?.slice(0, 2000) ?? null, code ?? null]
  );
}

export async function getJob(jobId: string): Promise<JobRow | null> {
  return one<JobRow>(`SELECT * FROM jobs WHERE id=$1`, [jobId]);
}
