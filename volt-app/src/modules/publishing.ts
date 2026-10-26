import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest, forbidden } from '../util/http';
import { publish, NotPublishable } from '../services/availability';
import { validateTargets, type Target } from '../services/publishingRules';
import { actorLabel } from '../util/actor';
import { defineList, parseList, whereSql, countWhereSql, countParams, pageSql, finishPage, onlyIdParam } from '../util/listQuery';

/**
 * Publishing & social distribution.
 *
 * publish_targets = the tenant's configured destinations (a linked social
 * account per platform). publications = a record per (asset, destination) we
 * pushed to, tracking the external id/url, status, and synced view count.
 *
 * The platform push, account linking (OAuth) and view sync are in
 * services/social and modules/social.ts (/api/social).
 */
const PLATFORMS = ['portal', 'youtube', 'facebook', 'x', 'tiktok', 'dailymotion', 'instagram', 'threads'] as const;

// ---- publish targets (config) -------------------------------------------
export const publishTargetsRouter = Router();
publishTargetsRouter.use(requireAuth);

const PUBLISH_TARGETS_LIST = defineList({
  path: '/api/publish-targets',
  fields: {
    id: { sql: 'id', type: 'uuid' },
    platform: { sql: 'platform', type: 'string', doc: 'portal, youtube, facebook, x, tiktok, dailymotion, instagram or threads' },
    name: { sql: 'name', type: 'string' },
    external_account: { sql: 'external_account', type: 'string' },
    enabled: { sql: 'enabled', type: 'boolean' },
    created_at: { sql: 'created_at', type: 'timestamp' },
  },
  search: ['name', 'external_account', 'platform'],
  defaultSort: 'platform,name',
  unpagedLimit: 1000,
});

publishTargetsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const params: unknown[] = [accountId(req)];
    const pl = parseList(PUBLISH_TARGETS_LIST, req.query, params);
    const where = `FROM publish_targets WHERE account_id=$1${whereSql(pl)}`;
    const whereCount = `FROM publish_targets WHERE account_id=$1${countWhereSql(pl)}`;  // totals ignore the cursor
    const rows = await query<any>(
      `SELECT id, platform, name, external_account, enabled, created_at ${where} ${pageSql(pl)}`, params);
    const total = pl.count ? Number((await one<any>(`SELECT count(*)::int AS n ${whereCount}`, countParams(pl, params)))?.n ?? 0) : undefined;
    res.json(finishPage(req, res, pl, rows, total));
  })
);

/**
 * One item by id: the canonical "self" link that the JSON-LD + Hydra layer
 * (services/hypermedia.ts) gives every member, so a deep link resolves.
 * Same tenant scoping as the list. (20 Oct 2026)
 */
publishTargetsRouter.get(
  '/:id',
  onlyIdParam,
  asyncHandler(async (req, res) => {
    const row = await one<any>(`SELECT id, platform, name, external_account, enabled, created_at FROM publish_targets WHERE id=$1 AND account_id=$2`, [req.params.id, accountId(req)]);
    if (!row) throw notFound('Publish target not found');
    res.json(row);
  })
);

const targetSchema = z.object({
  platform: z.enum(PLATFORMS),
  name: z.string().min(1),
  externalAccount: z.string().optional(),
  credentialsRef: z.string().optional(), // Secrets Manager ARN of the OAuth token
  enabled: z.boolean().default(true),
});

publishTargetsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const b = targetSchema.parse(req.body);
    if (b.platform === 'x') {
      const { xAccess, X_OFF } = await import('../services/social');
      if (!(await xAccess(accountId(req))).allowed) throw forbidden(X_OFF);
    }
    const row = await one(
      `INSERT INTO publish_targets(account_id, platform, name, external_account, credentials_ref, enabled)
       VALUES ($1,$2::text,$3,$4,$5,$6) RETURNING id, platform, name, external_account, enabled`,
      [accountId(req), b.platform, b.name, b.externalAccount ?? null, b.credentialsRef ?? null, b.enabled]
    );
    res.status(201).json(row);
  })
);

publishTargetsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const b = z.object({ name: z.string().optional(), externalAccount: z.string().optional(), enabled: z.boolean().optional() }).parse(req.body);
    const row = await one(
      `UPDATE publish_targets SET
         name=COALESCE($3,name), external_account=COALESCE($4,external_account),
         enabled=COALESCE($5,enabled), updated_at=now()
       WHERE id=$1 AND account_id=$2 RETURNING id, platform, name, external_account, enabled`,
      [req.params.id, accountId(req), b.name ?? null, b.externalAccount ?? null, b.enabled ?? null]
    );
    if (!row) throw notFound('Target not found');
    res.json(row);
  })
);

publishTargetsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await one(`DELETE FROM publish_targets WHERE id=$1 AND account_id=$2 RETURNING id`, [req.params.id, accountId(req)]);
    if (!row) throw notFound('Target not found');
    res.status(204).end();
  })
);

// ---- publications (publish an asset + track views) ----------------------
export const publicationsRouter = Router();
publicationsRouter.use(requireAuth);

// THE SAME OWNERSHIP RULE AS THE LIBRARY (vod.ts OWNER_ACCOUNT). An uploaded or
// watch-folder asset has no channel or event, so it belongs to its account
// directly. The inner join on groups made every such asset "not found" here:
// its publications could not be listed and it could not be published at all.
async function ownedAsset(assetId: string, acct: string) {
  return one<any>(
    `SELECT v.* FROM vod_assets v
       LEFT JOIN channels c ON c.id=v.channel_id
       LEFT JOIN events e ON e.id=v.event_id
       LEFT JOIN groups g ON g.id=COALESCE(c.group_id,e.group_id)
      WHERE v.id=$1 AND COALESCE(g.account_id, v.account_id)=$2`,
    [assetId, acct]
  );
}

/**
 * List publications for an asset (with live-ish view counts). assetId stays
 * required: this is the asset's own list, not a cross-library search.
 */
const PUBLICATIONS_LIST = defineList({
  path: '/api/publications',
  fields: {
    id: { sql: 'p.id', type: 'uuid' },
    platform: { sql: 'p.platform', type: 'string' },
    status: { sql: 'p.status', type: 'enum', values: ['pending', 'published', 'failed', 'removed', 'withdrawn'] },
    stage: { sql: 'p.stage', type: 'string' },
    target_id: { sql: 'p.target_id', type: 'uuid' },
    target_name: { sql: 't.name', type: 'string' },
    app_id: { sql: 'p.app_id', type: 'uuid' },
    external_url: { sql: 'p.external_url', type: 'string', sort: false },
    stale: { sql: 'p.stale', type: 'boolean', doc: 'The asset has changed since this copy went out' },
    views: { sql: 'p.views', type: 'number' },
    attempts: { sql: 'p.attempts', type: 'number' },
    published_at: { sql: 'p.published_at', type: 'timestamp' },
    last_synced_at: { sql: 'p.last_synced_at', type: 'timestamp' },
    created_at: { sql: 'p.created_at', type: 'timestamp', notNull: true },
  },
  search: ['platform', 'target_name', 'external_url'],
  defaultSort: '-created_at',
  extraParams: ['assetId'],
  unpagedLimit: 1000,
});

publicationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const assetId = typeof req.query.assetId === 'string' ? req.query.assetId : null;
    if (!assetId) throw badRequest('assetId required');
    if (!(await ownedAsset(assetId, accountId(req)))) throw notFound('Asset not found');
    const params: unknown[] = [assetId];
    const pl = parseList(PUBLICATIONS_LIST, req.query, params);
    const where = `FROM publications p
         LEFT JOIN publish_targets t ON t.id=p.target_id
        WHERE p.vod_asset_id=$1${whereSql(pl)}`;
    const whereCount = `FROM publications p
         LEFT JOIN publish_targets t ON t.id=p.target_id
        WHERE p.vod_asset_id=$1${countWhereSql(pl)}`;  // totals ignore the cursor
    const rows = await query<any>(`SELECT p.*, t.name AS target_name ${where} ${pageSql(pl)}`, params);
    const total = pl.count ? Number((await one<any>(`SELECT count(*)::int AS n ${whereCount}`, countParams(pl, params)))?.n ?? 0) : undefined;
    res.json(finishPage(req, res, pl, rows, total));
  })
);

/**
 * One item by id: the canonical "self" link that the JSON-LD + Hydra layer
 * (services/hypermedia.ts) gives every member, so a deep link resolves.
 * Same tenant scoping as the list. (20 Oct 2026)
 */
publicationsRouter.get(
  '/:id',
  onlyIdParam,
  asyncHandler(async (req, res) => {
    const row = await one<any>(`SELECT p.*, t.name AS target_name FROM publications p LEFT JOIN publish_targets t ON t.id=p.target_id WHERE p.id=$1`, [req.params.id]);
    // Owned through its asset, as the list is (an unowned id reads as not found).
    if (!row || !(await ownedAsset(row.vod_asset_id, accountId(req)))) throw notFound('Publication not found');
    res.json(row);
  })
);

const publishSchema = z.object({
  platform: z.enum([...PLATFORMS, 'app'] as any),
  targetId: z.string().uuid().optional(), // a social account (publish_targets) or an app (apps)
});

/**
 * Publish an asset to ONE point: the portal, a registered app, or a social
 * account. The same door as the library's Publish (services/availability):
 * the ladder's gate, window and geo apply, and only this one target is sent.
 */
publicationsRouter.post(
  '/vod/:id/publish',
  asyncHandler(async (req, res) => {
    const b = publishSchema.parse(req.body);
    const asset = await ownedAsset(req.params.id, accountId(req));
    if (!asset) throw notFound('Asset not found');
    const who = await actorLabel(req);
    let target: Target;
    if (b.platform === 'portal') target = { kind: 'portal' };
    else if (b.platform === 'app') {
      if (!b.targetId) throw badRequest('targetId (a registered app) is required');
      target = { kind: 'app', appId: b.targetId };
    } else {
      if (!b.targetId) throw badRequest('targetId (a configured account) is required for social platforms');
      target = { kind: 'social', targetId: b.targetId, platform: String(b.platform) };
    }
    let targets: Target[];
    try { targets = (await validateTargets(accountId(req), [target]))!; }
    catch (e: any) { throw badRequest(e.message); }
    try {
      const out = await publish(asset.id, who, { targets });
      res.status(201).json(out.publications[0] ?? { state: out.state });
    } catch (e: any) {
      if (e instanceof NotPublishable) throw badRequest(e.message);
      throw e;
    }
  })
);

/** Sync view counts from each platform now (services/social). */
publicationsRouter.post(
  '/sync-views',
  asyncHandler(async (req, res) => {
    const { syncViews } = await import('../services/social');
    res.json({ synced: await syncViews({ accountId: accountId(req), force: true }) });
  })
);
