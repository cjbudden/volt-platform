/**
 * HYBRID SITES (build queue H1, HYBRID_SITES.md). Licensed add-on
 * `hybrid_sites`, off by default: without the licence every route here
 * refuses with 403 `licence_required` and the console offers no Sites page.
 *
 * Console (admin session or account secret key, account administrators):
 *   GET    /api/sites                                list, with health
 *   POST   /api/sites                                create a site
 *   GET    /api/sites/:id                            site, hosts, open enrolment tokens
 *   PATCH  /api/sites/:id                            rename, describe, disable or enable
 *   POST   /api/sites/:id/enrolment-tokens           one-time token for an agent (shown once)
 *   DELETE /api/sites/:id/enrolment-tokens/:tokenId  withdraw an unused token
 *   POST   /api/sites/:id/hosts/:hostId/approve      the host may take work
 *   POST   /api/sites/:id/hosts/:hostId/reject       the host is refused, its credential revoked
 *   POST   /api/sites/:id/hosts/:hostId/rotate-credential   new credential, handed over on the next heartbeat
 *
 * Site agent (a host credential, `Bearer vsite_...`; nothing else):
 *   POST   /api/site-agent/enrol       token + host facts -> host (pending) + its credential
 *   POST   /api/site-agent/heartbeat   host facts -> standing, config version, rotated credential
 *   GET    /api/site-agent/config      what the host should run
 *
 * On-prem watchfolders (H2; an APPROVED host of the folder's own site only):
 *   GET    /api/site-agent/watchfolders                        folders with their rules, as the scanner takes them
 *   POST   /api/site-agent/watchfolders/:id/known              { objectKey, checksum } -> { known }
 *   GET    /api/site-agent/watchfolders/:id/quarantine-keys    review folder names in use
 *   POST   /api/site-agent/watchfolders/:id/items              one decision (accepted, or refused and moved)
 *   GET    /api/site-agent/watchfolders/:id/uploads            accepted files still to upload, with their open upload
 *   GET    /api/site-agent/watchfolders/:id/returns            refused files an operator sent back
 *   POST   /api/site-agent/watchfolders/:id/returns/:itemId    { ok, error } the file was moved back, or not
 *   GET    /api/site-agent/watchfolders/:id/reviews            files the cloud sent to review, to move into the review folder (H2b-5)
 *   POST   /api/site-agent/watchfolders/:id/reviews/:itemId    { ok, error } the file was moved to review, or not
 *   POST   /api/site-agent/watchfolders/:id/scanned            { error } a pass finished
 *   /api/site-agent/tus                                        the upload itself (modules/siteTus.ts)
 *
 * The job lease (H3; an APPROVED host, its own site's pool only):
 *   POST   /api/site-agent/jobs/lease                  { types? } -> the next job of the site's pool, or 204
 *   POST   /api/site-agent/jobs/:id/progress           { leaseId, pct?, note? } extends the lease
 *   POST   /api/site-agent/jobs/:id/complete           { leaseId, result? }
 *   POST   /api/site-agent/jobs/:id/fail               { leaseId, error, code?, permanent? } retried with backoff unless permanent
 *   POST   /api/site-agent/jobs/:id/transfer-url       { leaseId, name } one URL for one object the job lists
 *   GET|PUT /api/site-agent/transfers/:token           a signed transfer of a file on this server (no credential: the URL is it)
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { requireMinRole } from '../auth/roles';
import { asyncHandler, notFound, badRequest, conflict } from '../util/http';
import { defineList, parseList, whereSql, pageSql, finishPage } from '../util/listQuery';
import { writeAudit, actor, patchEntity } from '../services/audit';
import { requireLicence } from '../services/sites/licences';
import * as S from '../services/sites/sites';
import * as W from '../services/sites/siteWatchfolders';
import * as J from '../services/sites/siteJobs';

export const sitesRouter = Router();
sitesRouter.use(requireAuth, requireMinRole('admin'), asyncHandler(async (req, _res, next) => {
  await requireLicence(accountId(req), 'hybrid_sites');
  next();
}));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ownedSite(req: any) {
  if (!UUID.test(req.params.id)) throw notFound('site not found');
  const s = await one<any>(`SELECT * FROM sites WHERE id = $1 AND account_id = $2`, [req.params.id, accountId(req)]);
  if (!s) throw notFound('site not found');
  return s;
}

async function hostsOf(siteIds: string[]) {
  if (!siteIds.length) return [];
  return query<any>(`SELECT * FROM site_hosts WHERE site_id = ANY($1::uuid[]) ORDER BY created_at`, [siteIds]);
}

const siteList = defineList({
  path: '/api/sites',
  fields: {
    id: { sql: 's.id', type: 'uuid', notNull: true },
    name: { sql: 's.name', type: 'string', notNull: true },
    status: { sql: 's.status', type: 'enum', values: ['active', 'disabled'], notNull: true, doc: 'active, or disabled (its agents are refused)' },
    created_at: { sql: 's.created_at', type: 'timestamp', notNull: true },
    updated_at: { sql: 's.updated_at', type: 'timestamp', notNull: true },
  },
  search: ['name', 's.description'],
  defaultSort: 'name',
  defaultLimit: 100,
  maxLimit: 500,
});

sitesRouter.get('/', asyncHandler(async (req, res) => {
  const params: unknown[] = [accountId(req)];
  const pl = parseList(siteList, req.query, params);
  const rows = await query<any>(`SELECT s.* FROM sites s WHERE s.account_id = $1${whereSql(pl)} ${pageSql(pl)}`, params);
  const page = finishPage(req, res, pl, rows);
  const hosts = await hostsOf(page.map((s) => s.id));
  const now = Date.now();
  res.json({ items: page.map((s) => S.siteView(s, hosts.filter((h) => h.site_id === s.id), now)) });
}));

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
});

sitesRouter.post('/', asyncHandler(async (req, res) => {
  const b = createSchema.parse(req.body ?? {});
  const who = actor(req);
  const dup = await one(`SELECT 1 FROM sites WHERE account_id = $1 AND lower(name) = lower($2)`, [accountId(req), b.name]);
  if (dup) throw conflict('A site with this name already exists');
  const row = await one<any>(
    `INSERT INTO sites(account_id, name, description, created_by, updated_by)
     VALUES ($1,$2,$3,(SELECT id FROM users WHERE id = $4),(SELECT id FROM users WHERE id = $4)) RETURNING *`,
    [accountId(req), b.name, b.description ?? null, who.userId]);
  await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label, action: 'create', entityType: 'site', entityId: row.id, snapshot: { name: b.name } });
  res.status(201).json(S.siteView(row, []));
}));

sitesRouter.get('/:id', asyncHandler(async (req, res) => {
  const s = await ownedSite(req);
  const hosts = await hostsOf([s.id]);
  const now = Date.now();
  const tokens = await query<any>(
    `SELECT id, prefix, expires_at, created_at FROM site_enrolment_tokens
      WHERE site_id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`, [s.id]);
  res.json({
    ...S.siteView(s, hosts, now),
    hostList: hosts.map((h) => S.hostView(h, now)),
    enrolmentTokens: tokens.map((t) => ({ id: t.id, prefix: t.prefix, expiresAt: t.expires_at, createdAt: t.created_at })),
    heartbeatSeconds: S.HEARTBEAT_SECONDS, staleAfterSeconds: S.STALE_AFTER_S, offlineAfterSeconds: S.OFFLINE_AFTER_S,
  });
}));

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  version: z.number().int().optional(),
});

sitesRouter.patch('/:id', asyncHandler(async (req, res) => {
  const s = await ownedSite(req);
  const b = patchSchema.parse(req.body ?? {});
  if (b.name && b.name.toLowerCase() !== s.name.toLowerCase()) {
    const dup = await one(`SELECT 1 FROM sites WHERE account_id = $1 AND lower(name) = lower($2) AND id <> $3`, [s.account_id, b.name, s.id]);
    if (dup) throw conflict('A site with this name already exists');
  }
  const who = actor(req);
  const { version, ...patch } = b;
  const { row, changed } = await patchEntity({
    table: 'sites', id: s.id, accountId: s.account_id, current: s, patch, allowed: ['name', 'description', 'status'],
    entityType: 'site', userId: who.userId, label: who.label, expectedVersion: version ?? null,
  });
  // The agents pick a change of name or standing up on their next heartbeat.
  let out = row;
  if (changed.length) out = await one<any>(`UPDATE sites SET config_version = config_version + 1 WHERE id = $1 RETURNING *`, [s.id]);
  res.json({ ...S.siteView(out, await hostsOf([s.id])), changed });
}));

const tokenSchema = z.object({ expiresInHours: z.number().int().min(1).max(24 * 7).optional() });

sitesRouter.post('/:id/enrolment-tokens', asyncHandler(async (req, res) => {
  const s = await ownedSite(req);
  if (s.status !== 'active') throw badRequest('Enable the site before enrolling hosts');
  const b = tokenSchema.parse(req.body ?? {});
  const who = actor(req);
  const t = await S.createEnrolmentToken(s.account_id, s.id, who.userId, who.label, b.expiresInHours ?? S.TOKEN_TTL_HOURS_DEFAULT);
  res.status(201).json(t);
}));

sitesRouter.delete('/:id/enrolment-tokens/:tokenId', asyncHandler(async (req, res) => {
  const s = await ownedSite(req);
  if (!UUID.test(req.params.tokenId)) throw notFound('token not found');
  const who = actor(req);
  const t = await one<any>(
    `UPDATE site_enrolment_tokens SET revoked_at = now() WHERE id = $1 AND site_id = $2 AND used_at IS NULL AND revoked_at IS NULL RETURNING id, prefix`,
    [req.params.tokenId, s.id]);
  if (!t) throw notFound('token not found, or already used or withdrawn');
  await writeAudit(null, { accountId: s.account_id, userId: who.userId, label: who.label, action: 'delete', entityType: 'site_enrolment_token', entityId: t.id, snapshot: { prefix: t.prefix } });
  res.status(204).end();
}));

for (const [verb, decision] of [['approve', 'approved'], ['reject', 'rejected']] as const) {
  sitesRouter.post(`/:id/hosts/:hostId/${verb}`, asyncHandler(async (req, res) => {
    const s = await ownedSite(req);
    if (!UUID.test(req.params.hostId)) throw notFound('host not found');
    const who = actor(req);
    const h = await S.decideHost(s.account_id, s.id, req.params.hostId, decision, who.userId, who.label);
    res.json(S.hostView(h));
  }));
}

sitesRouter.post('/:id/hosts/:hostId/rotate-credential', asyncHandler(async (req, res) => {
  const s = await ownedSite(req);
  if (!UUID.test(req.params.hostId)) throw notFound('host not found');
  const who = actor(req);
  res.status(201).json(await S.rotateCredential(s.account_id, s.id, req.params.hostId, who.userId, who.label));
}));

// ---- the site agent -------------------------------------------------------------

export const siteAgentRouter = Router();

siteAgentRouter.post('/enrol', asyncHandler(async (req, res) => {
  const b = req.body ?? {};
  res.status(201).json(await S.enrol(String(b.token ?? ''), b.host ?? {}));
}));

siteAgentRouter.post('/heartbeat', asyncHandler(async (req, res) => {
  const p = await S.authenticateSite(req.headers.authorization);
  const b = req.body ?? {};
  const held = Number.isInteger(b.configVersion) ? b.configVersion : null;
  res.json(await S.heartbeat(p, b.host ?? {}, held));
}));

siteAgentRouter.get('/config', asyncHandler(async (req, res) => {
  const p = await S.authenticateSite(req.headers.authorization);
  res.json(await S.siteConfig(p));
}));

// ---- on-prem watchfolders (H2) ----------------------------------------------------

siteAgentRouter.get('/watchfolders', asyncHandler(async (req, res) => {
  const p = await S.authenticateSite(req.headers.authorization);
  W.requireApprovedHost(p);
  res.json({ items: await W.foldersForSite(p) });
}));

siteAgentRouter.post('/watchfolders/:id/known', asyncHandler(async (req, res) => {
  const p = await S.authenticateSite(req.headers.authorization);
  res.json({ known: await W.isKnown(p, req.params.id, req.body?.objectKey, req.body?.checksum) });
}));

siteAgentRouter.get('/watchfolders/:id/quarantine-keys', asyncHandler(async (req, res) => {
  const p = await S.authenticateSite(req.headers.authorization);
  res.json({ items: await W.quarantineKeysInUse(p, req.params.id) });
}));

siteAgentRouter.post('/watchfolders/:id/items', asyncHandler(async (req, res) => {
  const p = await S.authenticateSite(req.headers.authorization);
  res.status(201).json(await W.recordDecision(p, req.params.id, req.body ?? {}));
}));

siteAgentRouter.get('/watchfolders/:id/uploads', asyncHandler(async (req, res) => {
  const p = await S.authenticateSite(req.headers.authorization);
  res.json({ items: await W.pendingUploads(p, req.params.id) });
}));

siteAgentRouter.get('/watchfolders/:id/returns', asyncHandler(async (req, res) => {
  const p = await S.authenticateSite(req.headers.authorization);
  res.json({ items: await W.pendingReturns(p, req.params.id) });
}));

siteAgentRouter.post('/watchfolders/:id/returns/:itemId', asyncHandler(async (req, res) => {
  const p = await S.authenticateSite(req.headers.authorization);
  res.json(await W.returned(p, req.params.id, req.params.itemId, req.body?.ok !== false, req.body?.error ?? null));
}));

siteAgentRouter.get('/watchfolders/:id/reviews', asyncHandler(async (req, res) => {
  const p = await S.authenticateSite(req.headers.authorization);
  res.json({ items: await W.pendingReviews(p, req.params.id) });
}));

siteAgentRouter.post('/watchfolders/:id/reviews/:itemId', asyncHandler(async (req, res) => {
  const p = await S.authenticateSite(req.headers.authorization);
  res.json(await W.reviewed(p, req.params.id, req.params.itemId, req.body?.ok !== false, req.body?.error ?? null));
}));

siteAgentRouter.post('/watchfolders/:id/scanned', asyncHandler(async (req, res) => {
  const p = await S.authenticateSite(req.headers.authorization);
  res.json(await W.scanReport(p, req.params.id, req.body?.error ?? null));
}));

// ---- the job lease (H3) ------------------------------------------------------------

siteAgentRouter.post('/jobs/lease', asyncHandler(async (req, res) => {
  const p = await S.authenticateSite(req.headers.authorization);
  const job = await J.lease(p, req.body?.types);
  if (!job) return res.status(204).end();
  res.json(job);
}));

siteAgentRouter.post('/jobs/:id/progress', asyncHandler(async (req, res) => {
  const p = await S.authenticateSite(req.headers.authorization);
  res.json(await J.progress(p, req.params.id, req.body ?? {}));
}));

siteAgentRouter.post('/jobs/:id/complete', asyncHandler(async (req, res) => {
  const p = await S.authenticateSite(req.headers.authorization);
  res.json(await J.complete(p, req.params.id, req.body ?? {}));
}));

siteAgentRouter.post('/jobs/:id/fail', asyncHandler(async (req, res) => {
  const p = await S.authenticateSite(req.headers.authorization);
  res.json(await J.failJob(p, req.params.id, req.body ?? {}));
}));

siteAgentRouter.post('/jobs/:id/transfer-url', asyncHandler(async (req, res) => {
  const p = await S.authenticateSite(req.headers.authorization);
  res.json(await J.transferUrl(p, req.params.id, req.body ?? {}));
}));

/**
 * Signed transfers of files on this server's own disk. Mounted before the
 * JSON parser (server.ts): an upload is raw bytes streamed to disk. The token
 * is the credential, checked against the job's current lease on every use.
 */
export const siteTransferRouter = Router();
siteTransferRouter.all('/:token', asyncHandler(async (req, res) => { await J.serveTransfer(req, res); }));
