/**
 * COLLECTIONS: the operator's own nested groupings of library assets.
 * (migration 0111, docs/COLLECTIONS.md)
 *
 * Usage: group assets the way you program them, e.g. a "BEATLINE" collection
 * with a sub-collection per week's theme, then filter the Media Library by a
 * collection, or pull a whole collection into a FAST run order in its order.
 *
 *   GET    /api/collections                      every collection of the account, flat, with counts
 *   POST   /api/collections                      { name, parentId?, description?, color? }
 *   GET    /api/collections/:id                  one collection, its breadcrumb and children
 *   PATCH  /api/collections/:id                  { name?, parentId? (move), description?, color?, sortOrder? }
 *   DELETE /api/collections/:id                  removes it and its sub-collections (never the assets)
 *   GET    /api/collections/:id/items            its assets in collection order (?deep=true: with sub-collections')
 *   POST   /api/collections/:id/items            { assetIds } add (appended, duplicates ignored)
 *   POST   /api/collections/:id/items/remove     { assetIds } take out
 *   PUT    /api/collections/:id/items/order      { assetIds } the new order (all of them)
 *   GET    /api/collections/memberships?assetIds=a,b   which collections each asset is in
 *
 * The Media Library list filters by collection with
 * GET /api/vod?collection=<id>[&collection_deep=true] (modules/vod.ts).
 * Tenant-scoped throughout: a collection and every asset added to it belong
 * to the caller's account.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, one, tx } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest, conflict } from '../util/http';
import { actorId } from '../util/actor';

export const collectionsRouter = Router();
collectionsRouter.use(requireAuth);

/** How deep collections may nest: BEATLINE > 2026 > Week 44 > ... is plenty. */
export const MAX_DEPTH = 6;
const MAX_BATCH = 500;
const uuid = z.string().uuid();

async function own(req: Request, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Collection not found');
  const c = await one<any>(`SELECT * FROM collections WHERE id = $1 AND account_id = $2`, [id, accountId(req)]);
  if (!c) throw notFound('Collection not found');
  return c;
}

/** A collection and all its descendants (ids). */
export async function subtreeIds(collectionId: string): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `WITH RECURSIVE t AS (SELECT id FROM collections WHERE id = $1
       UNION ALL SELECT c.id FROM collections c JOIN t ON c.parent_id = t.id)
     SELECT id FROM t`, [collectionId]);
  return rows.map((r) => r.id);
}

/** The chain from the root down to this collection (for breadcrumbs). */
async function pathOf(id: string) {
  return query<{ id: string; name: string }>(
    `WITH RECURSIVE up AS (SELECT id, name, parent_id, 0 AS d FROM collections WHERE id = $1
       UNION ALL SELECT c.id, c.name, c.parent_id, up.d + 1 FROM collections c JOIN up ON c.id = up.parent_id)
     SELECT id, name FROM up ORDER BY d DESC`, [id]);
}
const depthOf = async (id: string | null) => (id ? (await pathOf(id)).length : 0);
/** How many levels a subtree spans (1 = a leaf). */
async function heightOf(id: string): Promise<number> {
  const r = await one<{ h: number }>(
    `WITH RECURSIVE t AS (SELECT id, 1 AS h FROM collections WHERE id = $1
       UNION ALL SELECT c.id, t.h + 1 FROM collections c JOIN t ON c.parent_id = t.id)
     SELECT max(h)::int AS h FROM t`, [id]);
  return r?.h ?? 1;
}

/** Assets of the account among `ids` (others silently out: no oracle across tenants). */
async function ownedAssets(account: string, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await query<{ id: string }>(
    `SELECT v.id FROM vod_assets v LEFT JOIN channels c ON c.id = v.channel_id LEFT JOIN events e ON e.id = v.event_id
       LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
      WHERE v.id = ANY($1::uuid[]) AND COALESCE(g.account_id, v.account_id) = $2`, [ids, account]);
  const ok = new Set(rows.map((r) => String(r.id)));
  return ids.filter((id) => ok.has(id));
}

const pgUnique = (e: any) => e?.code === '23505';

// ------------------------------------------------------------------ list / tree

/**
 * Every collection, flat, ordered for a tree (parent first, then sort_order,
 * then name). `itemCount` = assets directly in it; `totalCount` = distinct
 * assets in it and everything under it.
 */
collectionsRouter.get('/', asyncHandler(async (req, res) => {
  const rows = await query<any>(
    `WITH RECURSIVE c AS (SELECT * FROM collections WHERE account_id = $1),
       anc AS (SELECT id AS root, id FROM c UNION ALL SELECT anc.root, c.id FROM anc JOIN c ON c.parent_id = anc.id)
     SELECT c.id, c.parent_id AS "parentId", c.name, c.description, c.color, c.sort_order AS "sortOrder",
            c.created_at AS "createdAt", c.updated_at AS "updatedAt",
            (SELECT count(*)::int FROM collection_items i WHERE i.collection_id = c.id) AS "itemCount",
            (SELECT count(DISTINCT i.vod_asset_id)::int FROM anc JOIN collection_items i ON i.collection_id = anc.id WHERE anc.root = c.id) AS "totalCount",
            (SELECT COALESCE(sum(v.duration_ms), 0)::bigint FROM collection_items i JOIN vod_assets v ON v.id = i.vod_asset_id WHERE i.collection_id = c.id) AS "durationMs"
       FROM c ORDER BY c.parent_id NULLS FIRST, c.sort_order, lower(c.name)`, [accountId(req)]);
  res.json({ items: rows.map((r) => ({ ...r, durationMs: Number(r.durationMs) })), maxDepth: MAX_DEPTH });
}));

/** Which collections each asset is in (for the asset panel and the bulk picker's ticks). Before '/:id'. */
collectionsRouter.get('/memberships', asyncHandler(async (req, res) => {
  const ids = String(req.query.assetIds ?? '').split(',').map((s) => s.trim()).filter((s) => /^[0-9a-f-]{36}$/i.test(s)).slice(0, MAX_BATCH);
  if (!ids.length) { res.json({ memberships: {} }); return; }
  const rows = await query<{ vod_asset_id: string; collection_id: string }>(
    `SELECT i.vod_asset_id, i.collection_id FROM collection_items i JOIN collections c ON c.id = i.collection_id
      WHERE c.account_id = $1 AND i.vod_asset_id = ANY($2::uuid[])`, [accountId(req), ids]);
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.vod_asset_id] ??= []).push(r.collection_id);
  res.json({ memberships: out });
}));

const createBody = z.object({
  name: z.string().trim().min(1).max(120),
  parentId: uuid.nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
});
collectionsRouter.post('/', asyncHandler(async (req, res) => {
  const b = createBody.parse(req.body ?? {});
  if (b.parentId) {
    await own(req, b.parentId);
    if ((await depthOf(b.parentId)) >= MAX_DEPTH) throw badRequest(`Collections nest at most ${MAX_DEPTH} levels deep.`);
  }
  const order = await one<{ n: number }>(`SELECT COALESCE(max(sort_order) + 1, 0)::int AS n FROM collections WHERE account_id = $1 AND parent_id IS NOT DISTINCT FROM $2`, [accountId(req), b.parentId ?? null]);
  try {
    const c = await one<any>(
      `INSERT INTO collections (account_id, parent_id, name, description, color, sort_order, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, parent_id AS "parentId", name, description, color, sort_order AS "sortOrder", created_at AS "createdAt"`,
      [accountId(req), b.parentId ?? null, b.name, b.description ?? null, b.color ?? null, order?.n ?? 0, actorId(req)]);
    res.status(201).json({ ...c, itemCount: 0, totalCount: 0, durationMs: 0 });
  } catch (e) {
    if (pgUnique(e)) throw conflict(`There is already a collection called "${b.name}" here.`);
    throw e;
  }
}));

collectionsRouter.get('/:id', asyncHandler(async (req, res) => {
  const c = await own(req, String(req.params.id));
  const children = await query<any>(
    `SELECT id, name, color, (SELECT count(*)::int FROM collection_items i WHERE i.collection_id = c.id) AS "itemCount"
       FROM collections c WHERE parent_id = $1 ORDER BY sort_order, lower(name)`, [c.id]);
  const itemCount = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM collection_items WHERE collection_id = $1`, [c.id]))?.n ?? 0;
  res.json({ id: c.id, parentId: c.parent_id, name: c.name, description: c.description, color: c.color, sortOrder: c.sort_order,
    createdAt: c.created_at, updatedAt: c.updated_at, itemCount, path: await pathOf(c.id), children });
}));

const patchBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  parentId: uuid.nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
});
collectionsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const c = await own(req, String(req.params.id));
  const b = patchBody.parse(req.body ?? {});
  if (b.parentId !== undefined && b.parentId !== c.parent_id) {
    // MOVE: never under itself or its own descendants, and not too deep
    if (b.parentId) {
      await own(req, b.parentId);
      if ((await subtreeIds(c.id)).includes(b.parentId)) throw badRequest('A collection cannot move inside itself or one of its own sub-collections.');
      if ((await depthOf(b.parentId)) + (await heightOf(c.id)) > MAX_DEPTH) throw badRequest(`Collections nest at most ${MAX_DEPTH} levels deep.`);
    }
  }
  try {
    const r = await one<any>(
      `UPDATE collections SET
         name = COALESCE($2, name),
         parent_id = CASE WHEN $3 THEN $4::uuid ELSE parent_id END,
         description = CASE WHEN $5 THEN $6 ELSE description END,
         color = CASE WHEN $7 THEN $8 ELSE color END,
         sort_order = COALESCE($9, sort_order),
         updated_at = now()
       WHERE id = $1 RETURNING id, parent_id AS "parentId", name, description, color, sort_order AS "sortOrder", updated_at AS "updatedAt"`,
      [c.id, b.name ?? null, b.parentId !== undefined, b.parentId ?? null, b.description !== undefined, b.description ?? null,
        b.color !== undefined, b.color ?? null, b.sortOrder ?? null]);
    res.json(r);
  } catch (e) {
    if (pgUnique(e)) throw conflict(`There is already a collection called "${b.name ?? c.name}" there.`);
    throw e;
  }
}));

/** Removes the collection and everything under it. The assets stay in the library. */
collectionsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const c = await own(req, String(req.params.id));
  const ids = await subtreeIds(c.id);
  const items = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM collection_items WHERE collection_id = ANY($1::uuid[])`, [ids]))?.n ?? 0;
  await query(`DELETE FROM collections WHERE id = $1`, [c.id]);
  res.json({ deleted: ids.length, links: items });
}));

// ------------------------------------------------------------------ items

/**
 * The collection's assets in its own order. deep=true adds the
 * sub-collections' assets after, depth first, each asset once.
 */
collectionsRouter.get('/:id/items', asyncHandler(async (req, res) => {
  const c = await own(req, String(req.params.id));
  const deep = req.query.deep === 'true' || req.query.deep === '1';
  const rows = await query<any>(
    `WITH RECURSIVE t AS (SELECT id, 0 AS d, ARRAY[sort_order] AS path FROM collections WHERE id = $1
        UNION ALL SELECT c.id, t.d + 1, t.path || c.sort_order FROM collections c JOIN t ON c.parent_id = t.id WHERE $2),
      ranked AS (
        SELECT i.vod_asset_id, i.collection_id, i.position, i.added_at, t.path,
               row_number() OVER (PARTITION BY i.vod_asset_id ORDER BY t.path, i.position) AS rn
          FROM t JOIN collection_items i ON i.collection_id = t.id)
     SELECT v.id, v.title, v.duration_ms AS "durationMs", v.poster_key AS "posterKey", v.metadata->>'series' AS series,
            v.metadata->>'genre' AS genre, r.collection_id AS "collectionId", r.position, r.added_at AS "addedAt"
       FROM ranked r JOIN vod_assets v ON v.id = r.vod_asset_id
      WHERE r.rn = 1
      ORDER BY r.path, r.position, r.added_at`, [c.id, deep]);
  res.json({ collection: { id: c.id, name: c.name }, deep, items: rows.map((r) => ({ ...r, durationMs: Number(r.durationMs ?? 0) })) });
}));

const idsBody = z.object({ assetIds: z.array(uuid).min(1).max(MAX_BATCH) });
collectionsRouter.post('/:id/items', asyncHandler(async (req, res) => {
  const c = await own(req, String(req.params.id));
  const b = idsBody.parse(req.body ?? {});
  const ids = await ownedAssets(accountId(req), [...new Set(b.assetIds)]);
  const added = await tx(async (cl) => {
    const start = Number((await cl.query(`SELECT COALESCE(max(position) + 1, 0) AS n FROM collection_items WHERE collection_id = $1`, [c.id])).rows[0].n);
    const r = await cl.query(
      `INSERT INTO collection_items (collection_id, vod_asset_id, position, added_by)
       SELECT $1, x.id, $2 + x.ord - 1, $4 FROM unnest($3::uuid[]) WITH ORDINALITY AS x(id, ord)
       ON CONFLICT DO NOTHING RETURNING vod_asset_id`, [c.id, start, ids, actorId(req)]);
    return r.rowCount ?? 0;
  });
  await query(`UPDATE collections SET updated_at = now() WHERE id = $1`, [c.id]);
  res.json({ added, already: ids.length - added, notFound: b.assetIds.length - ids.length });
}));

collectionsRouter.post('/:id/items/remove', asyncHandler(async (req, res) => {
  const c = await own(req, String(req.params.id));
  const b = idsBody.parse(req.body ?? {});
  const r = await query(`DELETE FROM collection_items WHERE collection_id = $1 AND vod_asset_id = ANY($2::uuid[]) RETURNING vod_asset_id`, [c.id, b.assetIds]);
  await query(`UPDATE collections SET updated_at = now() WHERE id = $1`, [c.id]);
  res.json({ removed: r.length });
}));

collectionsRouter.put('/:id/items/order', asyncHandler(async (req, res) => {
  const c = await own(req, String(req.params.id));
  const b = z.object({ assetIds: z.array(uuid).max(5000) }).parse(req.body ?? {});
  const cur = await query<{ vod_asset_id: string }>(`SELECT vod_asset_id FROM collection_items WHERE collection_id = $1`, [c.id]);
  const have = new Set(cur.map((r) => r.vod_asset_id));
  if (b.assetIds.length !== have.size || !b.assetIds.every((id) => have.has(id))) throw badRequest('Send every asset in the collection, once each, in the new order.');
  await query(
    `UPDATE collection_items i SET position = x.ord - 1 FROM unnest($2::uuid[]) WITH ORDINALITY AS x(id, ord)
      WHERE i.collection_id = $1 AND i.vod_asset_id = x.id`, [c.id, b.assetIds]);
  res.json({ ordered: b.assetIds.length });
}));
