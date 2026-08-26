// ============================================================================
//  JOBS API — visibility and control over long-running work.
//
//  Every long operation now returns a job id instead of blocking, so the UI
//  needs somewhere to watch it: progress while it runs, the REASON when it
//  fails, and a way to retry or cancel. None of that was possible before, when
//  a failure wrote `status='error'` with no message and a stranded claim was
//  invisible.
// ============================================================================
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest } from '../util/http';
import { cancel, retry } from '../services/jobs/queue';

export const jobsRouter = Router();
jobsRouter.use(requireAuth);

/**
 * Tenant scoping. A job carries a denormalised channel_id / event_id, and both
 * lead to an account through groups. A job with neither is platform-internal
 * and is not exposed here at all.
 */
const OWNED = `
  FROM jobs j
  LEFT JOIN channels c ON c.id = j.channel_id
  LEFT JOIN events   e ON e.id = j.event_id
  LEFT JOIN groups   g ON g.id = COALESCE(c.group_id, e.group_id)
`;

const listQuery = z.object({
  type: z.string().optional(),
  state: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']).optional(),
  channelId: z.string().uuid().optional(),
  correlationId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

jobsRouter.get('/', asyncHandler(async (req, res) => {
  const q = listQuery.parse(req.query);
  const rows = await query(
    `SELECT j.id, j.type, j.state, j.progress_pct, j.progress_note,
            j.attempts, j.max_attempts, j.last_error, j.error_code,
            j.channel_id, j.event_id, j.correlation_id,
            j.created_at, j.started_at, j.finished_at, j.run_after,
            COALESCE(c.name, e.name) AS source_name
     ${OWNED}
     WHERE g.account_id = $1
       AND ($2::text IS NULL OR j.type = $2)
       AND ($3::text IS NULL OR j.state::text = $3)
       AND ($4::uuid IS NULL OR j.channel_id = $4)
       AND ($5::uuid IS NULL OR j.correlation_id = $5)
     ORDER BY j.created_at DESC
     LIMIT $6`,
    [accountId(req), q.type ?? null, q.state ?? null, q.channelId ?? null,
     q.correlationId ?? null, q.limit]
  );
  res.json({ jobs: rows });
}));

/** One job with its full attempt history — what you need when it failed twice. */
jobsRouter.get('/:id', asyncHandler(async (req, res) => {
  const job = await one<any>(
    `SELECT j.*, COALESCE(c.name, e.name) AS source_name ${OWNED}
      WHERE j.id = $1 AND g.account_id = $2`,
    [req.params.id, accountId(req)]
  );
  if (!job) throw notFound('Job not found');
  const attempts = await query(
    `SELECT attempt, claimed_by, started_at, finished_at, outcome, error, error_code
       FROM job_attempts WHERE job_id = $1 ORDER BY attempt`, [job.id]
  );
  res.json({ ...job, attempts });
}));

jobsRouter.post('/:id/retry', asyncHandler(async (req, res) => {
  const job = await one<any>(`SELECT j.id, j.state ${OWNED} WHERE j.id=$1 AND g.account_id=$2`,
    [req.params.id, accountId(req)]);
  if (!job) throw notFound('Job not found');
  const done = await retry(job.id);
  if (!done) throw badRequest(`A job in state '${job.state}' cannot be retried; only failed or cancelled jobs can.`);
  res.json({ ok: true, id: job.id, state: 'queued' });
}));

jobsRouter.post('/:id/cancel', asyncHandler(async (req, res) => {
  const job = await one<any>(`SELECT j.id, j.state ${OWNED} WHERE j.id=$1 AND g.account_id=$2`,
    [req.params.id, accountId(req)]);
  if (!job) throw notFound('Job not found');
  const done = await cancel(job.id);
  if (!done) throw badRequest(`A job in state '${job.state}' is already finished.`);
  res.json({ ok: true, id: job.id, state: 'cancelled' });
}));
