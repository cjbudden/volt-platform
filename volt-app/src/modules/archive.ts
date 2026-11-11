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
 *   GET    /api/archive/originals            originals a retention rule removed from the cloud, or that wait
 *                                            for their archive copy, with why (H3-5), list standard
 *   GET    /api/archive/originals/:assetId   where one asset's original is and what retention will do with it
 *   POST   /api/archive/originals/:assetId/restore  bring a removed original back from its archive copy (H3-5b)
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
import { originalStatus, requestRestore } from '../services/archive/originals';
import { notFound } from '../util/http';

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
    stream_id: { sql: 'c.stream_id', type: 'uuid', doc: 'the channel or event whose recording was copied (recording copies)' },
    what: { sql: 'c.what', type: 'enum', values: ['source', 'recording', 'recording-sidecar'], notNull: true, doc: "source (an asset's original), recording (a programme's or an hour's recording, one file) or recording-sidecar (its metadata)" },
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

// ---------------------------------------------------------------- originals
// Copy-before-delete (H3-5): a retention rule removes an asset's original from
// the cloud only once a verified archive copy of it is held. This list is what
// it removed and what is waiting, with the reason the pass wrote.
const originalList = defineList({
  path: '/api/archive/originals',
  fields: {
    id: { sql: 'v.id', type: 'uuid', notNull: true, doc: 'the Media Library asset' },
    title: { sql: 'v.title', type: 'string' },
    state: { sql: "(CASE WHEN v.original_removed_at IS NOT NULL THEN 'removed' ELSE 'waiting' END)", type: 'enum', values: ['waiting', 'removed'], notNull: true,
      doc: 'removed: the original left the cloud and its archive copy is verified; waiting: a rule is due and the copy is not there yet (see waitCode)' },
    wait_code: { sql: 'v.original_wait_code', type: 'string', doc: 'why it waits: no_licence, no_copy, copy_pending, copy_failed, copy_corrupt, copy_missing, copy_stale, copy_unchecked, in_use, not_removable' },
    removed_at: { sql: 'v.original_removed_at', type: 'timestamp' },
    checked_at: { sql: 'v.original_checked_at', type: 'timestamp' },
  },
  search: ['v.title'],
  defaultSort: '-checked_at',
  defaultLimit: 100,
  maxLimit: 500,
});

archiveRouter.get('/originals', asyncHandler(async (req, res) => {
  const params: unknown[] = [accountId(req)];
  const pl = parseList(originalList, req.query, params);
  const rows = await query<any>(
    `SELECT v.id, v.title, v.original_removed_at, v.original_wait_code, v.original_wait, v.original_checked_at,
            v.original_copy_id, t.name AS target_name, ac.stored_path, ac.state AS copy_state,
            v.original_restore_error, rj.state AS restore_state
       FROM vod_assets v
       LEFT JOIN jobs rj ON rj.id = v.original_restore_job_id
       LEFT JOIN channels c ON c.id = v.channel_id
       LEFT JOIN events e ON e.id = v.event_id
       LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
       LEFT JOIN archive_copies ac ON ac.id = v.original_copy_id
       LEFT JOIN archive_targets t ON t.id = ac.target_id
      WHERE COALESCE(g.account_id, v.account_id) = $1
        AND (v.original_removed_at IS NOT NULL OR v.original_wait_code IS NOT NULL)${whereSql(pl)} ${pageSql(pl)}`, params);
  res.json({ items: finishPage(req, res, pl, rows).map((r: any) => ({
    vodAssetId: r.id, title: r.title, state: r.original_removed_at ? 'removed' : 'waiting',
    waitCode: r.original_wait_code, why: r.original_wait, removedAt: r.original_removed_at, checkedAt: r.original_checked_at,
    copy: r.original_copy_id ? { id: r.original_copy_id, targetName: r.target_name, storedPath: r.stored_path, state: r.copy_state } : null,
    // Restore (H3-5b): in flight, or the last attempt's reason.
    restoring: r.restore_state === 'queued' || r.restore_state === 'running',
    restoreError: r.restore_state === 'queued' || r.restore_state === 'running' ? null : (r.original_restore_error ?? null),
  })) });
}));

archiveRouter.get('/originals/:assetId', asyncHandler(async (req, res) => {
  const s = /^[0-9a-f-]{36}$/i.test(req.params.assetId) ? await originalStatus(accountId(req), req.params.assetId) : null;
  if (!s) throw notFound('asset not found');
  res.json(s);
}));

archiveRouter.post('/originals/:assetId/restore', asyncHandler(async (req, res) => {
  const who = actor(req);
  const r = await requestRestore(accountId(req), who.userId, req.params.assetId);
  if (r.created) {
    await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label, action: 'update', entityType: 'vod_original', entityId: req.params.assetId,
      snapshot: { restoreRequested: true, jobId: r.jobId } });
  }
  res.status(r.created ? 202 : 200).json({ ...(await originalStatus(accountId(req), req.params.assetId)), jobId: r.jobId });
}));
