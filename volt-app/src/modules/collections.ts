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
 * RULE-BASED COLLECTIONS (build queue C1, services/collectionRules.ts):
 *   GET    /api/collections/rules/fields         the fields and operators rules can use
 *   POST   /api/collections/rules/preview        { rules } how many assets they match now, with a sample
 *   PATCH  /api/collections/:id                  { rules (null: hand-made only), orderBy } (saving rules matches at once)
 *   POST   /api/collections/:id/recheck          match the rules in full now
 *   GET    /api/collections/:id/exclusions       media taken out of a rule collection
 *   POST   /api/collections/:id/exclusions/remove { assetIds } let them back in
 * Members are what the rules match, plus what a person added, minus what a
 * person took out. Each item says which (source: rule or manual).
 *
 * ACCESS BY APP AND REGION (build queue C2 to C2-3, services/collectionAccess.ts):
 *   GET    /api/collections/:id/access          its access, its parents', the apps (with ruledOut)
 *   PUT    /api/collections/:id/access          { access } (null: inherit)
 *   GET    /api/collections/:id/access/view-as  ?appId&country&viewer&packageId: each title's outcome,
 *                                               leftOut (rule titles a stricter collection locks here)
 *   GET    /api/collections/asset-access/:assetId  the same for one title, with its collections
 * Items carry lockedBy when another collection locks them more strictly.
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
import { fieldsFor, validateRules, RuleError, recompute, preview, matchAssets, OPS, ORDERS, type Group } from '../services/collectionRules';
import {
  validateAccess, AccessError, looserThan, ancestorsOf, levelsOf, enqueueCollections, drainFor, syncPackageProducts, productKeyClashes,
  appsOf, rightsConflict, cellFor, compileFor, holdsPackage, kindsFor, lockedElsewhere, governedElsewhere, ALL_ACCESS, type CollectionAccess,
  type Cell, type Compiled,
} from '../services/collectionAccess';
import { rightsForAsset, evaluateRights, appTypeOf, accessAllowed, appAllowed } from '../services/rightsProfiles';
import { actor, writeAudit } from '../services/audit';

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
            (c.rules IS NOT NULL) AS "hasRules", c.order_by AS "orderBy",
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

// ------------------------------------------------------------------ rules (C1)

/** The fields and operators rules can use in this account, with the choices for lists and references. */
collectionsRouter.get('/rules/fields', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const fields = await fieldsFor(acct);
  const [types, profiles, channels, events] = await Promise.all([
    query<any>(`SELECT id AS value, name AS label FROM metadata_schemas WHERE account_id = $1 ORDER BY lower(name)`, [acct]),
    query<any>(`SELECT id AS value, name AS label FROM rights_profiles WHERE account_id = $1 ORDER BY builtin NULLS LAST, lower(name)`, [acct]),
    query<any>(`SELECT c.id AS value, c.name AS label FROM channels c JOIN groups g ON g.id = c.group_id WHERE g.account_id = $1 ORDER BY lower(c.name) LIMIT 500`, [acct]),
    query<any>(`SELECT e.id AS value, e.name AS label FROM events e JOIN groups g ON g.id = e.group_id WHERE g.account_id = $1 ORDER BY e.created_at DESC LIMIT 500`, [acct]),
  ]);
  const refs: Record<string, any[]> = { content_type: types, rights_profile: profiles, channel: channels, event: events };
  res.json({
    fields: fields.map(({ sql: _sql, ...f }) => ({ ...f, ...(f.ref ? { values: refs[f.ref] ?? [] } : {}) })),
    operators: OPS,
    orders: Object.entries(ORDERS).map(([value, o]) => ({ value, label: o.label })),
  });
}));

/** How many assets these rules match now, with a few of them: the builder's live count. */
collectionsRouter.post('/rules/preview', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const fields = await fieldsFor(acct);
  let tree: Group;
  try { tree = validateRules(req.body?.rules, fields); }
  catch (e) { if (e instanceof RuleError) throw badRequest(`${e.message} (${e.path})`); throw e; }
  res.json(await preview(acct, tree, fields));
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
  const counts = await one<any>(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE source = 'rule')::int AS rule, count(*) FILTER (WHERE source = 'manual')::int AS manual,
            (SELECT count(*)::int FROM collection_exclusions x WHERE x.collection_id = $1) AS excluded
       FROM collection_items WHERE collection_id = $1`, [c.id]);
  res.json({ id: c.id, parentId: c.parent_id, name: c.name, description: c.description, color: c.color, sortOrder: c.sort_order,
    createdAt: c.created_at, updatedAt: c.updated_at, itemCount: counts?.n ?? 0, path: await pathOf(c.id), children,
    rules: c.rules ?? null, orderBy: c.order_by, rulesCheckedAt: c.rules_checked_at, rulesCheckMs: c.rules_check_ms,
    access: c.access ?? null,
    counts: { rule: counts?.rule ?? 0, manual: counts?.manual ?? 0, excluded: counts?.excluded ?? 0 } });
}));

const patchBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  parentId: uuid.nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  /** Rule-based membership (build queue C1). null: hand-made only (what the rules added goes, what people added stays). */
  rules: z.any().optional(),
  orderBy: z.enum(Object.keys(ORDERS) as [string, ...string[]]).optional(),
});
collectionsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const c = await own(req, String(req.params.id));
  const b = patchBody.parse(req.body ?? {});
  // RULES first: refused whole when they do not make sense, before anything is saved.
  let rules: Group | null | undefined;
  if (b.rules !== undefined) {
    if (b.rules === null) rules = null;
    else {
      try { rules = validateRules(b.rules, await fieldsFor(accountId(req))); }
      catch (e) { if (e instanceof RuleError) throw badRequest(`${e.message} (${e.path})`); throw e; }
    }
  }
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
         rules = CASE WHEN $10 THEN $11::jsonb ELSE rules END,
         rules_checked_at = CASE WHEN $10 THEN NULL ELSE rules_checked_at END,
         order_by = COALESCE($12, order_by),
         updated_at = now()
       WHERE id = $1 RETURNING id, parent_id AS "parentId", name, description, color, sort_order AS "sortOrder", updated_at AS "updatedAt",
                 rules, order_by AS "orderBy"`,
      [c.id, b.name ?? null, b.parentId !== undefined, b.parentId ?? null, b.description !== undefined, b.description ?? null,
        b.color !== undefined, b.color ?? null, b.sortOrder ?? null, rules !== undefined, rules === undefined ? null : JSON.stringify(rules), b.orderBy ?? null]);
    // Saved rules are matched at once, so the collection the person sees is already the new one.
    const matched = rules !== undefined ? await recompute(c.id) : null;
    // Moved under another parent: it inherits other access now (build queue C2).
    if (b.parentId !== undefined && b.parentId !== c.parent_id && (await enqueueCollections(await subtreeIds(c.id)))) await drainFor(2000);
    res.json({ ...r, ...(matched ? { matched } : {}) });
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
        SELECT i.vod_asset_id, i.collection_id, i.position, i.added_at, i.source, t.path,
               row_number() OVER (PARTITION BY i.vod_asset_id ORDER BY t.path, i.position) AS rn
          FROM t JOIN collection_items i ON i.collection_id = t.id)
     SELECT v.id, v.title, v.duration_ms AS "durationMs", v.poster_key AS "posterKey", v.metadata->>'series' AS series,
            v.metadata->>'genre' AS genre, r.collection_id AS "collectionId", r.position, r.added_at AS "addedAt", r.source,
            v.collection_access AS ca
       FROM ranked r JOIN vod_assets v ON v.id = r.vod_asset_id
      WHERE r.rn = 1
      ORDER BY r.path, ${(ORDERS[c.order_by] ?? ORDERS.manual).sql.replace('i.position', 'r.position')}, r.position, r.added_at`, [c.id, deep]);
  // A title another collection locks more strictly than this one (any app or
  // region) is marked with the package that governs it (build queue C2-3):
  // a person added it, so it stays; a rule put it here, so the public answers
  // and View as leave it out where it is locked.
  const ownIds = new Set(deep ? await subtreeIds(c.id) : [c.id]);
  res.json({ collection: { id: c.id, name: c.name }, deep, items: rows.map(({ ca, ...r }) => {
    const g = governedElsewhere(ca as Compiled | null, ownIds);
    return { ...r, durationMs: Number(r.durationMs ?? 0), ...(g ? { lockedBy: g } : {}) };
  }) });
}));

const idsBody = z.object({ assetIds: z.array(uuid).min(1).max(MAX_BATCH) });
collectionsRouter.post('/:id/items', asyncHandler(async (req, res) => {
  const c = await own(req, String(req.params.id));
  const b = idsBody.parse(req.body ?? {});
  const owned = await ownedAssets(accountId(req), [...new Set(b.assetIds)]);
  // THE RIGHTS CAP (build queue C2): a collection with access cannot be given
  // a title the rights rule out for every app or territory it applies to, or
  // for the access it asks for. Refused with the reason; the rest are added.
  const refused = await rightsRefusals(accountId(req), c.id, owned);
  const ids = owned.filter((id) => !refused.some((r) => r.assetId === id));
  const added = await tx(async (cl) => {
    const start = Number((await cl.query(`SELECT COALESCE(max(position) + 1, 0) AS n FROM collection_items WHERE collection_id = $1`, [c.id])).rows[0].n);
    const r = await cl.query(
      `INSERT INTO collection_items (collection_id, vod_asset_id, position, added_by, source)
       SELECT $1, x.id, $2 + x.ord - 1, $4, 'manual' FROM unnest($3::uuid[]) WITH ORDINALITY AS x(id, ord)
       ON CONFLICT DO NOTHING RETURNING vod_asset_id`, [c.id, start, ids, actorId(req)]);
    // Added by hand: it stays even when the rules stop matching it, and a
    // person who left it out earlier has now asked for it back.
    await cl.query(`UPDATE collection_items SET source = 'manual', added_by = COALESCE(added_by, $3)
                     WHERE collection_id = $1 AND vod_asset_id = ANY($2::uuid[]) AND source = 'rule'`, [c.id, ids, actorId(req)]);
    await cl.query(`DELETE FROM collection_exclusions WHERE collection_id = $1 AND vod_asset_id = ANY($2::uuid[])`, [c.id, ids]);
    return r.rowCount ?? 0;
  });
  await query(`UPDATE collections SET updated_at = now() WHERE id = $1`, [c.id]);
  res.json({ added, already: ids.length - added, notFound: b.assetIds.length - owned.length, ...(refused.length ? { refused } : {}) });
}));

collectionsRouter.post('/:id/items/remove', asyncHandler(async (req, res) => {
  const c = await own(req, String(req.params.id));
  const b = idsBody.parse(req.body ?? {});
  const r = await query(`DELETE FROM collection_items WHERE collection_id = $1 AND vod_asset_id = ANY($2::uuid[]) RETURNING vod_asset_id`, [c.id, b.assetIds]);
  // In a rule collection, taking something out is a decision the rules must
  // respect: it is left out until a person lets it back in.
  if (c.rules && r.length) {
    await query(`INSERT INTO collection_exclusions (collection_id, vod_asset_id, excluded_by)
                 SELECT $1, x, $3 FROM unnest($2::uuid[]) x ON CONFLICT DO NOTHING`, [c.id, r.map((x: any) => x.vod_asset_id), actorId(req)]);
  }
  await query(`UPDATE collections SET updated_at = now() WHERE id = $1`, [c.id]);
  res.json({ removed: r.length, leftOut: c.rules ? r.length : 0 });
}));

/** Match the rules in full now (they also run on every change and nightly). */
collectionsRouter.post('/:id/recheck', asyncHandler(async (req, res) => {
  const c = await own(req, String(req.params.id));
  if (!c.rules) throw badRequest('This collection has no rules to check.');
  res.json(await recompute(c.id));
}));

/** What people took out of this rule collection. */
collectionsRouter.get('/:id/exclusions', asyncHandler(async (req, res) => {
  const c = await own(req, String(req.params.id));
  const rows = await query<any>(
    `SELECT v.id, v.title, x.excluded_at AS "excludedAt", u.email AS "excludedBy"
       FROM collection_exclusions x JOIN vod_assets v ON v.id = x.vod_asset_id LEFT JOIN users u ON u.id = x.excluded_by
      WHERE x.collection_id = $1 ORDER BY x.excluded_at DESC LIMIT 500`, [c.id]);
  res.json({ items: rows });
}));

/** Let left-out media back in: the rules decide again at once. */
collectionsRouter.post('/:id/exclusions/remove', asyncHandler(async (req, res) => {
  const c = await own(req, String(req.params.id));
  const b = idsBody.parse(req.body ?? {});
  const r = await query(`DELETE FROM collection_exclusions WHERE collection_id = $1 AND vod_asset_id = ANY($2::uuid[]) RETURNING vod_asset_id`, [c.id, b.assetIds]);
  const back = r.length ? await matchAssets(r.map((x: any) => x.vod_asset_id)) : { added: 0, removed: 0 };
  res.json({ letBackIn: r.length, matched: back.added });
}));

collectionsRouter.put('/:id/items/order', asyncHandler(async (req, res) => {
  const c = await own(req, String(req.params.id));
  const b = z.object({ assetIds: z.array(uuid).max(5000) }).parse(req.body ?? {});
  if (c.order_by !== 'manual') throw badRequest(`This collection is ordered by ${ORDERS[c.order_by]?.label.toLowerCase() ?? c.order_by}. Switch it to By hand to order it yourself.`);
  const cur = await query<{ vod_asset_id: string }>(`SELECT vod_asset_id FROM collection_items WHERE collection_id = $1`, [c.id]);
  const have = new Set(cur.map((r) => r.vod_asset_id));
  if (b.assetIds.length !== have.size || !b.assetIds.every((id) => have.has(id))) throw badRequest('Send every asset in the collection, once each, in the new order.');
  await query(
    `UPDATE collection_items i SET position = x.ord - 1 FROM unnest($2::uuid[]) WITH ORDINALITY AS x(id, ord)
      WHERE i.collection_id = $1 AND i.vod_asset_id = x.id`, [c.id, b.assetIds]);
  res.json({ ordered: b.assetIds.length });
}));

// ------------------------------------------------------------------ access (build queue C2)

/** Why the rights keep each of these titles out of a collection with access. */
async function rightsRefusals(acct: string, collectionId: string, assetIds: string[]): Promise<{ assetId: string; reason: string }[]> {
  if (!assetIds.length) return [];
  const levels = await levelsOf(collectionId);
  if (!levels.length) return [];
  const apps = (await appsOf(acct)).map((a) => ({ id: a.id, name: a.name, rightsType: appTypeOf(a.type, a.surface) }));
  const rows = await query<any>(`SELECT id, title, rights_profile_id, rights_narrow, created_at, first_aired_at FROM vod_assets WHERE id = ANY($1::uuid[])`, [assetIds]);
  const out: { assetId: string; reason: string }[] = [];
  for (const r of rows) {
    const why = rightsConflict(levels, await rightsForAsset(r), apps);
    if (why) out.push({ assetId: String(r.id), reason: why });
  }
  return out;
}

const accessView = (a: CollectionAccess | null) => a ?? null;

/**
 * For the access editor (build queue C2-2): per app, how many of the titles
 * here (and in sub-collections) the rights keep out of that app, with a few
 * of their names. When the rights keep every title out, the editor greys the
 * app with the reason; choosing it would only ever answer "blocked by
 * rights". Read from the first 500 titles, as View as is.
 */
async function appsRuledOut(collectionId: string, apps: { id: string; name: string; type: string; surface: string | null }[]) {
  const out = new Map<string, { count: number; of: number; titles: string[] }>();
  const rows = await query<any>(
    `SELECT DISTINCT ON (v.id) v.id, v.title, v.rights_profile_id, v.rights_narrow, v.created_at, v.first_aired_at
       FROM collection_items i JOIN vod_assets v ON v.id = i.vod_asset_id
      WHERE i.collection_id = ANY($1::uuid[]) ORDER BY v.id LIMIT 500`, [await subtreeIds(collectionId)]);
  const rights = await Promise.all(rows.map((r) => rightsForAsset(r)));
  for (const a of apps) {
    const t = appTypeOf(a.type, a.surface);
    const titles: string[] = [];
    let count = 0;
    rows.forEach((r, i) => { if (!appAllowed(rights[i], t, a.id)) { count++; if (titles.length < 3) titles.push(r.title || 'Untitled'); } });
    out.set(a.id, { count, of: rows.length, titles });
  }
  return out;
}

/**
 * The collection's access: its own (null: it says nothing and inherits), what
 * its ancestors say (root first), and the account's apps to choose from.
 */
collectionsRouter.get('/:id/access', asyncHandler(async (req, res) => {
  const c = await own(req, String(req.params.id));
  const ancestors = await ancestorsOf(c.id, c.parent_id);
  const apps = await appsOf(accountId(req));
  const items = (await one<{ n: number }>(`SELECT count(DISTINCT vod_asset_id)::int AS n FROM collection_items WHERE collection_id = ANY($1::uuid[])`, [await subtreeIds(c.id)]))?.n ?? 0;
  const ruledOut = await appsRuledOut(c.id, apps);
  // The countries the access governing the titles here names (their other
  // collections' too), so View as's matrix shows where a title is locked by
  // another collection even when this one sets nothing (build queue C2-3).
  const named = await query<{ cc: string }>(
    `SELECT DISTINCT cc FROM (SELECT v.collection_access AS ca FROM collection_items i JOIN vod_assets v ON v.id = i.vod_asset_id
       WHERE i.collection_id = ANY($1::uuid[]) AND v.collection_access IS NOT NULL LIMIT 500) t,
       jsonb_array_elements(t.ca->'g') g, jsonb_array_elements(g->'levels') l, jsonb_array_elements(l->'rules') r, jsonb_array_elements_text(r->'countries') cc
      WHERE cc <> 'WORLD' ORDER BY cc LIMIT 12`, [await subtreeIds(c.id)]);
  res.json({ id: c.id, access: accessView(c.access), inherits: !c.access, ancestors, default: ALL_ACCESS,
    apps: apps.map((a) => ({ id: a.id, name: a.name, type: a.type, ruledOut: ruledOut.get(a.id)! })), items, titleRegions: named.map((r) => r.cc) });
}));

/**
 * Set or clear (null) the collection's access. A child can only tighten its
 * parent's (422 naming where it would loosen). Premium products are made or
 * updated, the collection's titles (and its sub-collections') compiled again.
 */
collectionsRouter.put('/:id/access', asyncHandler(async (req, res) => {
  const c = await own(req, String(req.params.id));
  const acct = accountId(req);
  const raw = req.body?.access === undefined ? req.body : req.body.access;
  let next: CollectionAccess | null = null;
  if (raw !== null) {
    try { next = validateAccess(raw, (await appsOf(acct)).map((a) => a.id)); }
    catch (e) { if (e instanceof AccessError) { res.status(422).json({ error: e.message, code: 'invalid_access', problems: e.problems }); return; } throw e; }
    const anc = await ancestorsOf(c.id, c.parent_id);
    const looser = looserThan(next, anc.map((a) => a.access));
    if (looser.length) { res.status(422).json({ error: looser[0], code: 'looser_than_parent', problems: looser, parents: anc.map((a) => ({ id: a.id, name: a.name })) }); return; }
    const clash = await productKeyClashes(acct, c.id, next);
    if (clash.length) { res.status(409).json({ error: `Another collection or rule already sells ${clash.join(', ')}. Give this package its own product keys.`, code: 'product_key_taken', keys: clash }); return; }
  }
  await query(`UPDATE collections SET access = $2::jsonb, updated_at = now() WHERE id = $1`, [c.id, next ? JSON.stringify(next) : null]);
  const products = await syncPackageProducts(acct, c.id, next);
  const who = actor(req);
  await writeAudit(null, { accountId: acct, userId: who.userId, label: who.label, action: 'update', entityType: 'collection', entityId: c.id,
    changes: { access: { from: c.access ?? null, to: next } } });
  // Every title here and below is compiled again; the first batches now, so
  // the play gate answers by the new access when this returns.
  const queued = await enqueueCollections(await subtreeIds(c.id));
  const compiled = queued ? await drainFor(3000) : 0;
  res.json({ id: c.id, access: next, products, queued, compiled });
}));

type AppRowT = { id: string; name: string; type: string; surface: string | null };
const viewAsViewer = (kind: string, packageId: string | null) => ({ viewerId: kind === 'anonymous' ? null : 'view-as', groups: [] as string[],
  entitlements: kind === 'package' && packageId ? [{ grants: { collectionIds: [packageId] } }] : [] });

/** One title as View as sees it: the rights cap first, then the collections' cell, then the viewer. */
async function viewAsItem(r: any, comp: Compiled | null | undefined, viewer: ReturnType<typeof viewAsViewer>, app: AppRowT | null, appId: string | null, country: string | null) {
  const rights = await rightsForAsset(r);
  const capped = evaluateRights(rights, { country, appType: app ? appTypeOf(app.type, app.surface) : null, appId, use: 'on_demand' });
  const cell: Cell = cellFor(comp, appId, country);
  let outcome: string;
  if (!capped.allowed) outcome = 'blocked_by_rights';
  else if (cell.access !== 'free' && !accessAllowed(rights, kindsFor(cell))) outcome = 'blocked_by_rights';
  else if (cell.access === 'members') outcome = viewer.viewerId ? 'plays' : 'sign_in';
  else if (cell.access === 'premium') outcome = holdsPackage(viewer as any, cell) ? 'plays' : 'locked';
  else outcome = 'plays';
  return { assetId: r.id, title: r.title, outcome, access: cell.access, reason: !capped.allowed ? capped.reason : undefined,
    packages: cell.packages, products: outcome === 'locked' ? cell.terms : undefined, decidedBy: cell.decidedBy };
}

/**
 * THE ASSET PAGE'S BREAKDOWN (build queue C2-3): the same answer as a
 * collection's View as, for one title. The collections it is in (with what
 * each asks), the regions those name plus one no rule names, and what a
 * viewer in an app and a country gets. The console asks once per cell to
 * build the apps by regions matrix, as it does for a collection.
 */
collectionsRouter.get('/asset-access/:assetId', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const assetId = String(req.params.assetId);
  if (!uuid.safeParse(assetId).success) throw notFound('Asset not found');
  const r = await one<any>(`SELECT id, title, rights_profile_id, rights_narrow, created_at, first_aired_at FROM vod_assets WHERE id = $1 AND account_id = $2`, [assetId, acct]);
  if (!r) throw notFound('Asset not found');
  const appId = typeof req.query.appId === 'string' && req.query.appId ? req.query.appId : null;
  const country = typeof req.query.country === 'string' && /^[A-Za-z]{2}$/.test(req.query.country) ? req.query.country.toUpperCase() : null;
  const kind = req.query.viewer === 'member' || req.query.viewer === 'package' ? String(req.query.viewer) : 'anonymous';
  const packageId = typeof req.query.packageId === 'string' ? req.query.packageId : null;
  const apps = await appsOf(acct);
  const app = appId ? apps.find((a) => a.id === appId) : null;
  if (appId && !app) throw badRequest('Not an app of this account.');
  const comp = (await compileFor([assetId])).get(assetId) ?? null;
  const inCols = await query<any>(
    `SELECT c.id, c.name, (c.rules IS NOT NULL) AS "hasRules", bool_and(coalesce(i.source, 'manual') = 'rule') AS "byRule"
       FROM collection_items i JOIN collections c ON c.id = i.collection_id
      WHERE i.vod_asset_id = $1 AND c.account_id = $2 GROUP BY c.id ORDER BY c.name`, [assetId, acct]);
  const chainOf = new Map((comp?.g ?? []).map((g) => [g.c, g]));
  const collections = inCols.map((c) => {
    const g = chainOf.get(c.id);
    return { id: c.id, name: c.name, hasRules: c.hasRules, source: c.byRule ? 'rule' : 'manual',
      // root first: what each level of its chain asks, where
      asks: (g?.levels ?? []).map((l) => ({ id: l.c, name: l.n, apps: l.apps, territories: l.territories, rules: l.rules.map((x) => ({ countries: x.countries, access: x.access })) })) };
  });
  const named = [...new Set((comp?.g ?? []).flatMap((g) => g.levels.flatMap((l) => [...l.rules.flatMap((x) => x.countries), ...l.territories.countries])))].filter((x) => x !== 'WORLD');
  const elsewhere = ['US', 'FR', 'DE', 'JP', 'BR'].find((x) => !named.includes(x)) ?? 'US';
  const packages = [...new Map((comp?.g ?? []).flatMap((g) => g.levels.filter((l) => l.rules.some((x) => x.access === 'premium')).map((l) => [l.c, { id: l.c, name: l.n }] as const))).values()];
  const result = await viewAsItem(r, comp, viewAsViewer(kind, packageId), app ?? null, appId, country);
  res.json({ assetId, title: r.title, app: app ? { id: app.id, name: app.name } : null, country, viewer: kind, packageId,
    apps: apps.map((a) => ({ id: a.id, name: a.name, type: a.type })), regions: [...named.slice(0, 5), elsewhere], packages, collections, result });
}));

/**
 * VIEW AS: what a viewer in an app and a country gets for each title here.
 * viewer = anonymous | member | package (with packageId: holding that
 * collection's package). plays, sign_in, locked (with the packages),
 * blocked_by_rights, and which collections decided. The console's View as
 * panel and the asset page read the same answer.
 */
collectionsRouter.get('/:id/access/view-as', asyncHandler(async (req, res) => {
  const c = await own(req, String(req.params.id));
  const acct = accountId(req);
  const appId = typeof req.query.appId === 'string' && req.query.appId ? req.query.appId : null;
  const country = typeof req.query.country === 'string' && /^[A-Za-z]{2}$/.test(req.query.country) ? req.query.country.toUpperCase() : null;
  const kind = req.query.viewer === 'member' || req.query.viewer === 'package' ? String(req.query.viewer) : 'anonymous';
  const packageId = typeof req.query.packageId === 'string' ? req.query.packageId : null;
  const apps = await appsOf(acct);
  const app = appId ? apps.find((a) => a.id === appId) : null;
  if (appId && !app) throw badRequest('Not an app of this account.');
  const ids = await subtreeIds(c.id);
  const rows = await query<any>(
    `SELECT v.id, v.title, v.rights_profile_id, v.rights_narrow, v.created_at, v.first_aired_at,
            bool_and(coalesce(i.source, 'manual') = 'rule') AS by_rule
       FROM collection_items i JOIN vod_assets v ON v.id = i.vod_asset_id
      WHERE i.collection_id = ANY($1::uuid[]) GROUP BY v.id ORDER BY v.id LIMIT 500`, [ids]);
  // From the collections as they stand now (not the stored compile), so a
  // person checking a change sees it before the queue has caught up.
  const compiled = await compileFor(rows.map((r) => String(r.id)));
  const viewer = viewAsViewer(kind, packageId);
  const ownIds = new Set(ids);
  const items = [];
  for (const r of rows) {
    const comp = compiled.get(String(r.id));
    const it: any = await viewAsItem(r, comp, viewer, app ?? null, appId, country);
    // Another collection locks it here more strictly than this one: a rule
    // put it here, so it is left out for this app and region; a person
    // added it, so it stays, marked with the governing package (C2-3).
    const el = lockedElsewhere(comp, ownIds, appId, country);
    if (el) { it.lockedBy = el; if (r.by_rule) it.leftOut = true; }
    items.push(it);
  }
  const counts: Record<string, number> = {};
  for (const i of items) counts[i.outcome] = (counts[i.outcome] ?? 0) + 1;
  const out = items.filter((i) => i.leftOut);
  const leftOut = { count: out.length, reason: out.length
    ? `${out.length === 1 ? 'A title the rules put here is' : `${out.length} titles the rules put here are`} locked by ${[...new Set(out.flatMap((i) => i.lockedBy.packages.map((p: any) => p.name)))].join(' or ')}, a package this collection does not ask for here, so ${out.length === 1 ? 'it is' : 'they are'} left out for this app and region.`
    : null };
  res.json({ app: app ? { id: app.id, name: app.name } : null, country, viewer: kind, packageId, counts, leftOut, items });
}));
