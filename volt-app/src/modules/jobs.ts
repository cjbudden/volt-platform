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
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest } from '../util/http';
import { cancel, retry } from '../services/jobs/queue';
import { defineList, parseList, whereSql, pageSql, finishPage } from '../util/listQuery';

export const jobsRouter = Router();
jobsRouter.use(requireAuth);

/**
 * Tenant scoping. A job carries a denormalised channel_id / event_id, and both
 * lead to an account through groups. A job about a library asset that has no
 * stream (an upload or a watch folder file being encoded) carries neither: it
 * names the asset in its payload, and the asset belongs to its account
 * directly (the same rule as the library, vod.ts OWNER_ACCOUNT). Without that
 * second route `GET /api/jobs/{id}` answered 404 for the very job id the
 * upload had just returned. A job with none of these is platform-internal and
 * is not exposed here at all.
 *
 * The payload is only used to FIND the asset; the account comes from the
 * asset row, never from the payload. The CASE guard keeps a payload that is
 * not a uuid from failing the cast for the whole query (AND does not
 * promise an order of evaluation; CASE does).
 */
const OWNED = `
  FROM jobs j
  LEFT JOIN channels c ON c.id = j.channel_id
  LEFT JOIN events   e ON e.id = j.event_id
  LEFT JOIN groups   g ON g.id = COALESCE(c.group_id, e.group_id)
  LEFT JOIN vod_assets va ON j.channel_id IS NULL AND j.event_id IS NULL
        AND va.id = CASE WHEN j.payload->>'vodAssetId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                         THEN (j.payload->>'vodAssetId')::uuid END
`;
/** The job's account, through its stream or through its library asset. */
const ACCOUNT = `COALESCE(g.account_id, va.account_id)`;

// THE LIST STANDARD (util/listQuery.ts): search, filter on any column below,
// sort, page. The console's old camelCase parameters still work as aliases.
const jobsList = defineList({
  path: '/api/jobs',
  fields: {
    id: { sql: 'j.id', type: 'uuid' },
    type: { sql: 'j.type', type: 'string', doc: 'Job type, e.g. clip.extract' },
    state: { sql: 'j.state', type: 'enum', values: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] },
    progress_pct: { sql: 'j.progress_pct', type: 'number' },
    attempts: { sql: 'j.attempts', type: 'number' },
    error_code: { sql: 'j.error_code', type: 'string' },
    last_error: { sql: 'j.last_error', type: 'string', sort: false },
    channel_id: { sql: 'j.channel_id', type: 'uuid' },
    event_id: { sql: 'j.event_id', type: 'uuid' },
    correlation_id: { sql: 'j.correlation_id', type: 'uuid' },
    source_name: { sql: 'COALESCE(c.name, e.name, va.title)', type: 'string', doc: 'Name of the channel or event, or the title of the library asset' },
    created_at: { sql: 'j.created_at', type: 'timestamp', notNull: true },
    started_at: { sql: 'j.started_at', type: 'timestamp' },
    finished_at: { sql: 'j.finished_at', type: 'timestamp' },
    run_after: { sql: 'j.run_after', type: 'timestamp' },
  },
  search: ['type', 'source_name', 'last_error', 'error_code'],
  defaultSort: '-created_at',
  defaultLimit: 50,
  maxLimit: 200,
  aliases: { channelId: 'channel_id', eventId: 'event_id', correlationId: 'correlation_id' },
});

jobsRouter.get('/', asyncHandler(async (req, res) => {
  const params: unknown[] = [accountId(req)];
  const pl = parseList(jobsList, req.query, params);
  const rows = await query(
    `SELECT j.id, j.type, j.state, j.progress_pct, j.progress_note,
            j.attempts, j.max_attempts, j.last_error, j.error_code,
            j.channel_id, j.event_id, j.correlation_id,
            j.created_at, j.started_at, j.finished_at, j.run_after,
            COALESCE(c.name, e.name, va.title) AS source_name
     ${OWNED}
     WHERE ${ACCOUNT} = $1${whereSql(pl)}
     ${pageSql(pl)}`,
    params
  );
  // Only count when asked: a count over every job is not free.
  // The total ignores the cursor, so it is the same on every page.
  let total: number | undefined;
  if (pl.count) {
    const cp: unknown[] = [accountId(req)];
    const cpl = parseList(jobsList, { ...req.query, cursor: undefined, offset: undefined }, cp);
    total = Number((await one<any>(`SELECT count(*)::int AS n ${OWNED} WHERE ${ACCOUNT} = $1${whereSql(cpl)}`, cp))?.n ?? 0);
  }
  res.json({ jobs: finishPage(req, res, pl, rows, total) });
}));

/** One job with its full attempt history — what you need when it failed twice. */
jobsRouter.get('/:id', asyncHandler(async (req, res) => {
  const job = await one<any>(
    `SELECT j.*, COALESCE(c.name, e.name, va.title) AS source_name ${OWNED}
      WHERE j.id = $1 AND ${ACCOUNT} = $2`,
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
  const job = await one<any>(`SELECT j.id, j.state ${OWNED} WHERE j.id=$1 AND ${ACCOUNT}=$2`,
    [req.params.id, accountId(req)]);
  if (!job) throw notFound('Job not found');
  const done = await retry(job.id);
  if (!done) throw badRequest(`A job in state '${job.state}' cannot be retried; only failed or cancelled jobs can.`);
  res.json({ ok: true, id: job.id, state: 'queued' });
}));

jobsRouter.post('/:id/cancel', asyncHandler(async (req, res) => {
  const job = await one<any>(`SELECT j.id, j.state ${OWNED} WHERE j.id=$1 AND ${ACCOUNT}=$2`,
    [req.params.id, accountId(req)]);
  if (!job) throw notFound('Job not found');
  const done = await cancel(job.id);
  if (!done) throw badRequest(`A job in state '${job.state}' is already finished.`);
  res.json({ ok: true, id: job.id, state: 'cancelled' });
}));
