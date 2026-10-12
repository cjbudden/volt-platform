// ============================================================================
//  WORKFLOWS + ADD-ONS API  (volt/WORKFLOWS.md)
//
//  /api/workflows        operators: the map, runs, traces, run-by-hand, cancel
//    GET  /map                      lanes, stages, hooks + what is attached + 24h counts
//    GET  /runs                     ?state&addonId&subjectType&subjectId&limit
//    GET  /runs/:id                 one run with its event log
//    POST /runs                     {addonId, subjectType, subjectId, options?}
//    POST /runs/:id/cancel
//    POST /runs/:id/retry           a NEW run with the same add-on, subject and options
//    GET  /trace                    ?subjectType&subjectId  hooks fired + runs, for the map
//    GET  /events                   recent hook events across the account
//
//  /api/addons           admins: services and triggers (reads open to operators,
//                        so the "Send to" menu can list them; secrets never returned)
//    GET/POST /             PATCH/DELETE /:id   POST /:id/rotate-secret   POST /:id/test
//    GET/POST /triggers     PATCH/DELETE /triggers/:id
//
//  /api/addon-callbacks  PUBLIC, per-run bearer token
//    POST /runs/:id         {state?, progress?, step?, message?, externalRef?, steps?, result?, error?}
// ============================================================================
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, badRequest, notFound, unauthorized } from '../util/http';
import { LANES, STAGES, EDGES, HOOKS, HOOK_IDS, MANUAL_SUBJECTS } from '../services/workflows/map';
import { resolveSubject } from '../services/workflows/subjects';
import { createRun, applyUpdate, authoriseCallback, cancelRun, pingAddon, newSecret } from '../services/workflows/runs';

const subjectType = z.enum(['channel', 'event', 'recording', 'vod_asset']);

// ===========================================================================
export const workflowsRouter = Router();
workflowsRouter.use(requireAuth);

workflowsRouter.get('/map', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const triggers = await query<any>(
    `SELECT t.id, t.hook, t.enabled, t.filter, a.id AS addon_id, a.name AS addon_name, a.category, a.enabled AS addon_enabled
       FROM addon_triggers t JOIN addon_services a ON a.id = t.addon_id WHERE t.account_id = $1 ORDER BY t.created_at`, [acct]);
  const runCounts = await query<any>(
    `SELECT hook, state, count(*)::int AS n FROM addon_runs
      WHERE account_id = $1 AND created_at > now() - interval '24 hours' GROUP BY hook, state`, [acct]);
  const hookCounts = await query<any>(
    `SELECT hook, count(*)::int AS n, max(created_at) AS last_at FROM workflow_events
      WHERE account_id = $1 AND created_at > now() - interval '24 hours' GROUP BY hook`, [acct]);
  res.json({
    lanes: LANES, stages: STAGES, edges: EDGES,
    hooks: HOOKS.map((h) => ({
      ...h,
      fired24h: hookCounts.find((c) => c.hook === h.id)?.n ?? 0,
      lastFiredAt: hookCounts.find((c) => c.hook === h.id)?.last_at ?? null,
      triggers: triggers.filter((t) => t.hook === h.id),
      runs24h: Object.fromEntries(runCounts.filter((c) => c.hook === h.id).map((c) => [c.state, c.n])),
    })),
    manualRuns24h: Object.fromEntries(runCounts.filter((c) => c.hook === 'manual').map((c) => [c.state, c.n])),
  });
}));

const runsQuery = z.object({
  state: z.string().optional(),
  addonId: z.string().uuid().optional(),
  subjectType: subjectType.optional(),
  subjectId: z.string().uuid().optional(),
  open: z.enum(['1', 'true']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const RUN_COLS = `r.id, r.addon_id, a.name AS addon_name, a.category, a.kind AS addon_kind, r.trigger_id, r.hook,
  r.subject_type, r.subject_id, r.subject_title, r.channel_id, r.event_id, r.state, r.progress_pct, r.step, r.steps,
  r.external_ref, r.error, r.created_by, r.created_at, r.dispatched_at, r.updated_at, r.finished_at, r.deadline_at`;

workflowsRouter.get('/runs', asyncHandler(async (req, res) => {
  const q = runsQuery.parse(req.query);
  const rows = await query(
    `SELECT ${RUN_COLS} FROM addon_runs r JOIN addon_services a ON a.id = r.addon_id
      WHERE r.account_id = $1
        AND ($2::text IS NULL OR r.state = $2)
        AND ($3::uuid IS NULL OR r.addon_id = $3)
        AND ($4::text IS NULL OR r.subject_type = $4)
        AND ($5::uuid IS NULL OR r.subject_id = $5)
        AND ($6::boolean IS NOT TRUE OR r.state IN ('queued','dispatched','running'))
      ORDER BY r.created_at DESC LIMIT $7`,
    [accountId(req), q.state ?? null, q.addonId ?? null, q.subjectType ?? null, q.subjectId ?? null, q.open ? true : null, q.limit]
  );
  res.json({ runs: rows });
}));

workflowsRouter.get('/runs/:id', asyncHandler(async (req, res) => {
  const run = await one<any>(
    `SELECT ${RUN_COLS}, r.result, r.options FROM addon_runs r JOIN addon_services a ON a.id = r.addon_id
      WHERE r.id = $1 AND r.account_id = $2`, [req.params.id, accountId(req)]);
  if (!run) throw notFound('Run not found');
  const events = await query(`SELECT id, ts, type, state, progress_pct, step, message FROM addon_run_events WHERE run_id = $1 ORDER BY id`, [run.id]);
  res.json({ ...run, events });
}));

const runBody = z.object({
  addonId: z.string().uuid(),
  subjectType: subjectType,
  subjectId: z.string().uuid(),
  options: z.record(z.any()).optional(),
});

workflowsRouter.post('/runs', asyncHandler(async (req, res) => {
  const b = runBody.parse(req.body ?? {});
  if (!MANUAL_SUBJECTS.includes(b.subjectType)) throw badRequest(`A ${b.subjectType} cannot be sent to an add-on by hand.`);
  const s = await resolveSubject(b.subjectType, b.subjectId);
  if (!s || s.accountId !== accountId(req)) throw notFound('Not found');
  try {
    const run = await createRun({ accountId: s.accountId, addonId: b.addonId, hook: 'manual', subject: s, options: b.options, createdBy: String(req.auth?.sub ?? 'user') });
    res.status(201).json(run);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
}));

workflowsRouter.post('/runs/:id/cancel', asyncHandler(async (req, res) => {
  const run = await cancelRun(accountId(req), req.params.id, String(req.auth?.sub ?? 'user'));
  if (!run) throw notFound('Run not found');
  res.json(run);
}));

workflowsRouter.post('/runs/:id/retry', asyncHandler(async (req, res) => {
  const old = await one<any>(`SELECT * FROM addon_runs WHERE id = $1 AND account_id = $2`, [req.params.id, accountId(req)]);
  if (!old) throw notFound('Run not found');
  const s = await resolveSubject(old.subject_type, old.subject_id);
  if (!s) throw notFound(`The ${old.subject_type} no longer exists`);
  const { hook: _h, ...opts } = old.options ?? {};
  try {
    const run = await createRun({ accountId: old.account_id, addonId: old.addon_id, triggerId: old.trigger_id, hook: old.hook, subject: s, options: opts, createdBy: `retry:${old.id}`, hookData: old.options?.hook });
    res.status(201).json(run);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
}));

workflowsRouter.get('/trace', asyncHandler(async (req, res) => {
  const q = z.object({ subjectType, subjectId: z.string().uuid() }).parse(req.query);
  const acct = accountId(req);
  const s = await resolveSubject(q.subjectType, q.subjectId);
  if (!s || s.accountId !== acct) throw notFound('Not found');
  // A recording's trace includes the hooks of the assets cut from it and of the
  // stream it came from, so the map lights the whole path, not one box.
  const related: Array<[string, string]> = [[s.type, s.id]];
  if (s.type === 'recording') {
    for (const v of await query<any>(`SELECT id FROM vod_assets WHERE recording_id = $1`, [s.id])) related.push(['vod_asset', v.id]);
  }
  if (s.type === 'vod_asset') {
    const v = await one<any>(`SELECT recording_id FROM vod_assets WHERE id = $1`, [s.id]);
    if (v?.recording_id) related.push(['recording', v.recording_id]);
  }
  const events = await query(
    `SELECT id, hook, subject_type, subject_id, title, data, created_at FROM workflow_events
      WHERE account_id = $1 AND (subject_type, subject_id::text) IN (SELECT * FROM unnest($2::text[], $3::text[]))
      ORDER BY id`,
    [acct, related.map((r) => r[0]), related.map((r) => r[1])]
  );
  const runs = await query(
    `SELECT ${RUN_COLS} FROM addon_runs r JOIN addon_services a ON a.id = r.addon_id
      WHERE r.account_id = $1 AND (r.subject_type, r.subject_id::text) IN (SELECT * FROM unnest($2::text[], $3::text[]))
      ORDER BY r.created_at`,
    [acct, related.map((r) => r[0]), related.map((r) => r[1])]
  );
  res.json({ subject: { type: s.type, id: s.id, title: s.title }, events, runs });
}));

workflowsRouter.get('/events', asyncHandler(async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const rows = await query(
    `SELECT id, hook, subject_type, subject_id, title, channel_id, event_id, data, created_at
       FROM workflow_events WHERE account_id = $1 ORDER BY id DESC LIMIT $2`, [accountId(req), limit]);
  res.json({ events: rows });
}));

// ===========================================================================
export const addonsRouter = Router();
addonsRouter.use(requireAuth);

const ADDON_COLS = `id, name, description, category, kind, endpoint_url, accepts, steps, timeout_sec, max_attempts, enabled, created_at, updated_at`;

addonsRouter.get('/', asyncHandler(async (req, res) => {
  const rows = await query<any>(
    `SELECT ${ADDON_COLS.split(', ').map((c) => 'a.' + c).join(', ')},
            (SELECT count(*)::int FROM addon_runs r WHERE r.addon_id = a.id AND r.state IN ('queued','dispatched','running')) AS open_runs,
            (SELECT count(*)::int FROM addon_runs r WHERE r.addon_id = a.id AND r.state = 'failed' AND r.created_at > now() - interval '24 hours') AS failed_24h,
            (SELECT max(created_at) FROM addon_runs r WHERE r.addon_id = a.id) AS last_run_at
       FROM addon_services a WHERE a.account_id = $1 ORDER BY a.created_at`, [accountId(req)]);
  res.json({ addons: rows });
}));

const addonBody = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).nullable().optional(),
  category: z.enum(['ai_agent', 'transcription', 'qc', 'metadata', 'distribution', 'other']).default('other'),
  kind: z.enum(['webhook', 'demo']).default('webhook'),
  endpointUrl: z.string().url().max(500).nullable().optional(),
  accepts: z.array(subjectType).min(1).default(['recording', 'vod_asset']),
  steps: z.array(z.string().min(1).max(60)).max(20).default([]),
  timeoutSec: z.number().int().min(30).max(86400).default(3600),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  enabled: z.boolean().default(true),
});

function checkEndpoint(kind: string, url: string | null | undefined) {
  if (kind !== 'webhook') return;
  if (!url) throw badRequest('A webhook add-on needs an endpoint URL.');
  const u = new URL(url);
  if (u.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1|host\.docker\.internal)$/.test(u.hostname)) {
    throw badRequest('Endpoints must be https (http is allowed only for localhost while developing).');
  }
}

addonsRouter.post('/', asyncHandler(async (req, res) => {
  const b = addonBody.parse(req.body ?? {});
  checkEndpoint(b.kind, b.endpointUrl);
  const secret = newSecret();
  const row = await one<any>(
    `INSERT INTO addon_services (account_id, name, description, category, kind, endpoint_url, signing_secret, accepts, steps, timeout_sec, max_attempts, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12) RETURNING ${ADDON_COLS}`,
    [accountId(req), b.name, b.description ?? null, b.category, b.kind, b.kind === 'webhook' ? b.endpointUrl : null, secret,
     b.accepts, JSON.stringify(b.steps), b.timeoutSec, b.maxAttempts, b.enabled]);
  // The secret is returned ONCE. After this only rotate-secret shows a new one.
  res.status(201).json({ ...row, signingSecret: secret });
}));

addonsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const b = addonBody.partial().parse(req.body ?? {});
  const cur = await one<any>(`SELECT * FROM addon_services WHERE id = $1 AND account_id = $2`, [req.params.id, accountId(req)]);
  if (!cur) throw notFound('Add-on not found');
  const kind = b.kind ?? cur.kind;
  const endpoint = b.endpointUrl !== undefined ? b.endpointUrl : cur.endpoint_url;
  checkEndpoint(kind, endpoint);
  const row = await one<any>(
    `UPDATE addon_services SET name=$3, description=$4, category=$5, kind=$6, endpoint_url=$7, accepts=$8, steps=$9::jsonb,
            timeout_sec=$10, max_attempts=$11, enabled=$12, updated_at=now()
      WHERE id=$1 AND account_id=$2 RETURNING ${ADDON_COLS}`,
    [cur.id, cur.account_id, b.name ?? cur.name, b.description !== undefined ? b.description : cur.description,
     b.category ?? cur.category, kind, kind === 'webhook' ? endpoint : null, b.accepts ?? cur.accepts,
     JSON.stringify(b.steps ?? cur.steps), b.timeoutSec ?? cur.timeout_sec, b.maxAttempts ?? cur.max_attempts, b.enabled ?? cur.enabled]);
  res.json(row);
}));

addonsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const r = await one(`DELETE FROM addon_services WHERE id = $1 AND account_id = $2 RETURNING id`, [req.params.id, accountId(req)]);
  if (!r) throw notFound('Add-on not found');
  res.status(204).end();
}));

addonsRouter.post('/:id/rotate-secret', asyncHandler(async (req, res) => {
  const secret = newSecret();
  const r = await one(`UPDATE addon_services SET signing_secret = $3, updated_at = now() WHERE id = $1 AND account_id = $2 RETURNING id`, [req.params.id, accountId(req), secret]);
  if (!r) throw notFound('Add-on not found');
  res.json({ id: req.params.id, signingSecret: secret });
}));

addonsRouter.post('/:id/test', asyncHandler(async (req, res) => {
  const a = await one<any>(`SELECT * FROM addon_services WHERE id = $1 AND account_id = $2`, [req.params.id, accountId(req)]);
  if (!a) throw notFound('Add-on not found');
  res.json(await pingAddon(a));
}));

// ---- triggers -------------------------------------------------------------
const triggerBody = z.object({
  addonId: z.string().uuid(),
  hook: z.string().refine((h) => HOOK_IDS.has(h), 'Unknown hook'),
  filter: z.object({
    channelIds: z.array(z.string().uuid()).optional(),
    eventIds: z.array(z.string().uuid()).optional(),
    groupIds: z.array(z.string().uuid()).optional(),
  }).default({}),
  options: z.record(z.any()).default({}),
  enabled: z.boolean().default(true),
});

addonsRouter.get('/triggers', asyncHandler(async (req, res) => {
  const rows = await query(
    `SELECT t.*, a.name AS addon_name FROM addon_triggers t JOIN addon_services a ON a.id = t.addon_id
      WHERE t.account_id = $1 ORDER BY t.created_at`, [accountId(req)]);
  res.json({ triggers: rows });
}));

addonsRouter.post('/triggers', asyncHandler(async (req, res) => {
  const b = triggerBody.parse(req.body ?? {});
  const acct = accountId(req);
  const a = await one<any>(`SELECT accepts FROM addon_services WHERE id = $1 AND account_id = $2`, [b.addonId, acct]);
  if (!a) throw notFound('Add-on not found');
  const hook = HOOKS.find((h) => h.id === b.hook)!;
  const hookSubjects = hook.id.startsWith('stream.') ? ['channel', 'event'] : [hook.subject];
  if (!hookSubjects.some((t) => (a.accepts as string[]).includes(t))) {
    throw badRequest(`${hook.label} is about a ${hookSubjects.join(' or ').replace('_', ' ')}, which this add-on does not accept.`);
  }
  const row = await one(
    `INSERT INTO addon_triggers (account_id, addon_id, hook, filter, options, enabled) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6) RETURNING *`,
    [acct, b.addonId, b.hook, JSON.stringify(b.filter), JSON.stringify(b.options), b.enabled]);
  res.status(201).json({ ...row, live: hook.live });
}));

addonsRouter.patch('/triggers/:id', asyncHandler(async (req, res) => {
  const b = triggerBody.partial().parse(req.body ?? {});
  const cur = await one<any>(`SELECT * FROM addon_triggers WHERE id = $1 AND account_id = $2`, [req.params.id, accountId(req)]);
  if (!cur) throw notFound('Trigger not found');
  const row = await one(
    `UPDATE addon_triggers SET hook=$3, filter=$4::jsonb, options=$5::jsonb, enabled=$6 WHERE id=$1 AND account_id=$2 RETURNING *`,
    [cur.id, cur.account_id, b.hook ?? cur.hook, JSON.stringify(b.filter ?? cur.filter), JSON.stringify(b.options ?? cur.options), b.enabled ?? cur.enabled]);
  res.json(row);
}));

addonsRouter.delete('/triggers/:id', asyncHandler(async (req, res) => {
  const r = await one(`DELETE FROM addon_triggers WHERE id = $1 AND account_id = $2 RETURNING id`, [req.params.id, accountId(req)]);
  if (!r) throw notFound('Trigger not found');
  res.status(204).end();
}));

// ===========================================================================
//  Public callback. The bearer token was issued for THIS run only, so a leaked
//  token can report on one run and nothing else.
// ===========================================================================
export const addonCallbacksRouter = Router();

const callbackBody = z.object({
  state: z.enum(['running', 'succeeded', 'failed']).optional(),
  progress: z.number().min(0).max(100).optional(),
  step: z.string().max(120).optional(),
  message: z.string().max(1000).optional(),
  externalRef: z.string().max(200).optional(),
  steps: z.array(z.string().max(60)).max(30).optional(),
  result: z.any().optional(),
  error: z.string().max(2000).optional(),
});

addonCallbacksRouter.post('/runs/:id', asyncHandler(async (req, res) => {
  const auth = String(req.headers.authorization ?? '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!(await authoriseCallback(req.params.id, token))) throw unauthorized('Callback token not valid for this run');
  const b = callbackBody.parse(req.body ?? {});
  if (b.result !== undefined && JSON.stringify(b.result).length > 256_000) throw badRequest('result is larger than 256 KB; store it and return a link');
  const out = await applyUpdate(req.params.id, b, 'callback');
  if (!out.run) throw notFound('Run not found');
  res.status(out.applied ? 200 : 409).json({ applied: out.applied, reason: out.reason ?? null, state: out.run.state });
}));
