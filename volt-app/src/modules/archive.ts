/**
 * MIRROR AND ARCHIVE (build queue H3-2, HYBRID_SITES.md). Licensed add-on
 * `mirror_archive`, off by default: without it every route here refuses with
 * 403 `licence_required`.
 *
 * Account administrators (admin session or account secret key):
 *   GET    /api/archive/targets              storage targets, list standard
 *   POST   /api/archive/targets              { name, siteId, path, bandwidthMbps?, recheckDays? } a folder at a site,
 *                                            or { name, siteId, kind: 's3', s3: { endpoint, bucket, prefix?, region?,
 *                                            pathStyle?, credentialRef? } } an S3-compatible store at a site (H3-4;
 *                                            no keys: they stay on the agent host under credentialRef)
 *   GET    /api/archive/targets/:id
 *   PATCH  /api/archive/targets/:id          { name?, path?, s3?, bandwidthMbps?, recheckDays?, status? }
 *   GET    /api/archive/copies               archive copies, list standard (target_id, vod_asset_id, state)
 *   POST   /api/archive/copies               { targetId, vodAssetId } copy an asset's original to a target
 *   GET    /api/archive/copies/:id
 *   POST   /api/archive/copies/:id/verify    read the copy back from the target now
 *
 * The copies themselves are jobs in the site's pool, leased by the site agent
 * through /api/site-agent/jobs (modules/sites.ts); the result is judged in
 * services/archive/archive.ts before it counts.
 */
import { Router } from 'express';
import { query } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { requireMinRole } from '../auth/roles';
import { asyncHandler } from '../util/http';
import { defineList, parseList, whereSql, pageSql, finishPage } from '../util/listQuery';
import { writeAudit, actor } from '../services/audit';
import { requireLicence } from '../services/sites/licences';
import * as A from '../services/archive/archive';

export const archiveRouter = Router();
archiveRouter.use(requireAuth, requireMinRole('admin'), asyncHandler(async (req, _res, next) => {
  await requireLicence(accountId(req), 'mirror_archive');
  next();
}));

const targetList = defineList({
  path: '/api/archive/targets',
  fields: {
    id: { sql: 't.id', type: 'uuid', notNull: true },
    name: { sql: 't.name', type: 'string', notNull: true },
    site_id: { sql: 't.site_id', type: 'uuid', notNull: true, doc: 'the site whose agent writes the copies' },
    kind: { sql: 't.kind', type: 'enum', values: [...A.TARGET_KINDS], notNull: true, doc: 'path: a folder on the site\'s server or NAS; s3: an S3-compatible store at the site (MinIO and similar), written by the agent' },
    status: { sql: 't.status', type: 'enum', values: ['active', 'disabled'], notNull: true },
    created_at: { sql: 't.created_at', type: 'timestamp', notNull: true },
    updated_at: { sql: 't.updated_at', type: 'timestamp', notNull: true },
  },
  search: ['name', 't.path'],
  defaultSort: 'name',
  defaultLimit: 100,
  maxLimit: 500,
});

archiveRouter.get('/targets', asyncHandler(async (req, res) => {
  const params: unknown[] = [accountId(req)];
  const pl = parseList(targetList, req.query, params);
  const rows = await query<any>(
    `SELECT t.*, s.name AS site_name FROM archive_targets t JOIN sites s ON s.id = t.site_id
      WHERE t.account_id = $1${whereSql(pl)} ${pageSql(pl)}`, params);
  res.json({ items: finishPage(req, res, pl, rows).map(A.targetView) });
}));

archiveRouter.post('/targets', asyncHandler(async (req, res) => {
  const who = actor(req);
  const t = await A.createTarget(accountId(req), who.userId, req.body ?? {});
  await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label, action: 'create', entityType: 'archive_target', entityId: t.id,
    snapshot: { name: t.name, siteId: t.site_id, kind: t.kind, path: t.path, s3: t.s3 ?? undefined, bandwidthMbps: t.bandwidth_mbps } });
  res.status(201).json(A.targetView(t));
}));

archiveRouter.get('/targets/:id', asyncHandler(async (req, res) => {
  res.json(A.targetView(await A.ownedTarget(accountId(req), req.params.id)));
}));

archiveRouter.patch('/targets/:id', asyncHandler(async (req, res) => {
  const who = actor(req);
  const { target, changes } = await A.updateTarget(accountId(req), req.params.id, req.body ?? {});
  if (Object.keys(changes).length) {
    await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label, action: 'update', entityType: 'archive_target', entityId: target.id, changes });
  }
  res.json({ ...A.targetView(target), changed: Object.keys(changes) });
}));

const copyList = defineList({
  path: '/api/archive/copies',
  fields: {
    id: { sql: 'c.id', type: 'uuid', notNull: true },
    target_id: { sql: 'c.target_id', type: 'uuid', notNull: true },
    vod_asset_id: { sql: 'c.vod_asset_id', type: 'uuid', doc: 'the Media Library asset whose original was copied' },
    state: { sql: 'c.state', type: 'enum', values: [...A.COPY_STATES], notNull: true, doc: 'queued (shown as copying while a host runs it), verified, failed, corrupt, missing' },
    created_at: { sql: 'c.created_at', type: 'timestamp', notNull: true },
    updated_at: { sql: 'c.updated_at', type: 'timestamp', notNull: true },
  },
  search: ['c.file_name', 'c.stored_path'],
  defaultSort: '-created_at',
  defaultLimit: 100,
  maxLimit: 500,
});

archiveRouter.get('/copies', asyncHandler(async (req, res) => {
  const params: unknown[] = [accountId(req)];
  const pl = parseList(copyList, req.query, params);
  const rows = await query<any>(`${A.COPY_SELECT} WHERE c.account_id = $1${whereSql(pl)} ${pageSql(pl)}`, params);
  res.json({ items: finishPage(req, res, pl, rows).map(A.copyView) });
}));

archiveRouter.post('/copies', asyncHandler(async (req, res) => {
  const who = actor(req);
  const { copy, created } = await A.requestCopy(accountId(req), who.userId, req.body ?? {});
  if (created) {
    await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label, action: 'create', entityType: 'archive_copy', entityId: copy.id,
      snapshot: { targetId: copy.target_id, vodAssetId: copy.vod_asset_id, fileName: copy.file_name } });
  }
  res.status(created ? 202 : 200).json(A.copyView(copy));
}));

archiveRouter.get('/copies/:id', asyncHandler(async (req, res) => {
  res.json(A.copyView(await A.ownedCopy(accountId(req), req.params.id)));
}));

archiveRouter.post('/copies/:id/verify', asyncHandler(async (req, res) => {
  const who = actor(req);
  const { copy, created } = await A.requestVerify(accountId(req), who.userId, req.params.id);
  res.status(created ? 202 : 200).json(A.copyView(copy));
}));
