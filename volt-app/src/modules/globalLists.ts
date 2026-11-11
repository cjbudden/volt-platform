// ============================================================================
//  GLOBAL LISTS: platform reference lists (countries, timezones, ...).
//  Rules and shapes: services/globalLists.ts. Guide: docs/GLOBAL_LISTS.md.
//
//  READ (every client, the console, players, the promo site)
//    GET /api/global-lists                     the lists you can read
//    GET /api/global-lists/:key                one list and its items, with the
//                                              list standard: q, any field as a
//                                              filter (?value.alpha3=AUS, or just
//                                              ?alpha3=AUS; ?value.offset[gte]=8;
//                                              ?code=AU,NZ), sort (?sort=-value.offset),
//                                              paging. Retired items are left out
//                                              unless you filter on active.
//                                              ?locale=fr_FR picks each label's
//                                              translation when there is one.
//    GET /api/global-lists/:key/items/:code    one item by code (retired too)
//  Visibility: public lists need no sign-in; tenant lists need a session or an
//  account key; platform lists are read under /api/platform only. Reads carry
//  an ETag (the list's version) and a Cache-Control, so a CDN can serve them.
//
//  MANAGE (System Admin; GET needs read_only, changes need saas_admin)
//    GET    /api/platform/global-lists                        all lists, with counts
//    POST   /api/platform/global-lists                        { key, name, description?, visibility?, fields, labelField, codeField? }
//    GET    /api/platform/global-lists/:key                   the list
//    PATCH  /api/platform/global-lists/:key                   { name?, description?, visibility?, fields?, labelField?, codeField?, archived? }
//    GET    /api/platform/global-lists/:key/items             items, retired included (list standard)
//    POST   /api/platform/global-lists/:key/items             { code?, value, position?, isDefault?, active? }
//    PATCH  /api/platform/global-lists/:key/items/:ref        { code?, value?, position?, isDefault?, active? }  (ref: id or code)
//    DELETE /api/platform/global-lists/:key/items/:ref        custom lists only; built-in lists retire instead
//    PUT    /api/platform/global-lists/:key/order             { codes: [...] }  the new order (unlisted keep theirs, after)
//    POST   /api/platform/global-lists/:key/import            { items, mode: merge|replace, dryRun? }  all or nothing
//    GET    /api/platform/global-lists/:key/export            the definition and every item, as JSON
//    POST   /api/platform/global-lists/:key/restore           { overwrite? }  built-in lists: shipped values back
// ============================================================================
import { Router, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { one, query, tx } from '../db';
import { requireAuth } from '../auth/middleware';
import { requirePlatform } from '../auth/platform';
import { asyncHandler, ApiError, badRequest, conflict, notFound } from '../util/http';
import { parseList, pageSql, whereSql, countWhereSql, countParams, finishPage, defineList } from '../util/listQuery';
import { actor, writeAudit } from '../services/audit';
import {
  BUILT_IN, LIST_KEY, LOCALE_KEY, checkDefinition, checkValue, codeFor, defOf, listJson, itemJson, getList, bumpVersion,
  uniqueClashes, itemsFailing, itemSpec, itemSelect, restoreShipped, type ListRow, type Visibility,
} from '../services/globalLists';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COUNTS = `(SELECT count(*)::int FROM global_list_items i WHERE i.list_id = l.id) AS items,
                (SELECT count(*)::int FROM global_list_items i WHERE i.list_id = l.id AND i.active) AS active_items`;

const invalidItems = (message: string, errors: string[]) => {
  const e: any = new ApiError(400, message);
  e.code = 'invalid_global_list_item';
  e.details = { errors };
  return e;
};

const audit = (req: Request, action: 'create' | 'update' | 'delete', entityType: string, entityId: string, extra: { changes?: any; snapshot?: any } = {}) => {
  const { userId, label } = actor(req);
  return writeAudit(null, { accountId: null, userId, label: `${label} (System Admin)`, action, entityType, entityId, ...extra });
};

const localeOf = (req: Request) => {
  const l = String(req.query.locale ?? '');
  return LOCALE_KEY.test(l) ? l : null;
};

/** The paged item list for one list (shared by the read and the manage routes). */
async function listItems(req: Request, res: Response, list: ListRow, path: string, retiredByDefault: boolean) {
  const spec = itemSpec(list, path);
  const q: Record<string, any> = { ...req.query };
  const filtersActive = Object.keys(q).some((k) => k === 'active' || k.startsWith('active['));
  const params: unknown[] = [list.id];
  const pl = parseList(spec, q, params);
  const activeSql = !retiredByDefault && !filtersActive ? ' AND i.active' : '';
  const rows = await query<any>(
    `SELECT ${itemSelect(spec)} FROM global_list_items i WHERE i.list_id = $1${activeSql}${whereSql(pl)} ${pageSql(pl)}`, params);
  let total: number | undefined;
  if (pl.count) {
    total = Number((await one<any>(`SELECT count(*)::int AS n FROM global_list_items i WHERE i.list_id = $1${activeSql}${countWhereSql(pl)}`,
      countParams(pl, params)))?.n ?? 0);
  }
  const locale = localeOf(req);
  return finishPage(req, res, pl, rows, total).map((r) => itemJson(list, r, locale));
}

// For the API reference: the fields every list has. Each list adds its own
// fields by name (see GET /api/global-lists/:key -> fields).
defineList({
  path: '/api/global-lists/:key',
  fields: {
    id: { sql: 'i.id', type: 'uuid', notNull: true, sort: false },
    code: { sql: 'i.code', type: 'string', notNull: true, doc: 'The item\'s stable code. Every field the list declares filters and sorts as value.<key> (and as <key> where that name is free)' },
    position: { sql: 'i.position', type: 'number', notNull: true },
    isDefault: { sql: 'i.is_default', type: 'boolean', notNull: true },
    active: { sql: 'i.active', type: 'boolean', notNull: true, doc: 'Retired items (false) are left out unless you filter on active' },
    updatedAt: { sql: 'i.updated_at', type: 'timestamp', notNull: true },
  },
  search: ['code'], defaultSort: 'position', defaultLimit: 500, maxLimit: 1000, extraParams: ['locale'], allowOffset: true,
});

// ============================================================================
//  READ
// ============================================================================
export const globalListsRouter = Router();

/** Run requireAuth inside a handler (tenant lists need a session; public ones do not). */
const authenticate = (req: Request, res: Response) =>
  new Promise<void>((ok, fail) => { requireAuth(req, res, (e?: any) => (e ? fail(e) : ok())); });

async function readable(req: Request, res: Response, key: string): Promise<ListRow> {
  const list = LIST_KEY.test(key) ? await getList(key) : null;
  if (!list || list.archived_at || list.visibility === 'platform') throw notFound(`There is no global list "${key}".`);
  if (list.visibility === 'tenant') await authenticate(req, res);
  return list;
}

/** ETag from the list's version and the exact query, and a cache lifetime by visibility. */
function cacheable(req: Request, res: Response, list: ListRow): boolean {
  const tag = `W/"gl-${list.version}-${createHash('sha1').update(`${list.id}|${req.originalUrl}`).digest('base64url').slice(0, 16)}"`;
  res.setHeader('ETag', tag);
  res.setHeader('Cache-Control', list.visibility === 'public'
    ? 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400'
    : 'private, max-age=60');
  res.setHeader('Vary', 'Authorization');
  if (req.headers['if-none-match'] === tag) { res.status(304).end(); return true; }
  return false;
}

globalListsRouter.get('/', asyncHandler(async (req, res) => {
  const signedIn = !!req.headers.authorization || !!req.headers['x-volt-account-key'];
  if (signedIn) await authenticate(req, res);
  const vis: Visibility[] = signedIn ? ['public', 'tenant'] : ['public'];
  const rows = await query<any>(`SELECT l.*, ${COUNTS} FROM global_lists l WHERE l.archived_at IS NULL AND l.visibility = ANY($1) ORDER BY l.name`, [vis]);
  res.setHeader('Cache-Control', signedIn ? 'private, max-age=60' : 'public, max-age=300');
  res.json({ items: rows.map((r) => ({ ...listJson(r), href: `/api/global-lists/${r.key}` })) });
}));

globalListsRouter.get('/:key', asyncHandler(async (req, res) => {
  const list = await readable(req, res, req.params.key);
  if (cacheable(req, res, list)) return;
  const items = await listItems(req, res, list, '/api/global-lists/:key', false);
  const { id, key, name, description, labelField, codeField, fields, version, updatedAt } = listJson(list);
  res.json({ id, key, name, description, labelField, codeField, fields, version, updatedAt, items });
}));

globalListsRouter.get('/:key/items/:code', asyncHandler(async (req, res) => {
  const list = await readable(req, res, req.params.key);
  if (cacheable(req, res, list)) return;
  const r = await one<any>(`SELECT * FROM global_list_items WHERE list_id = $1 AND lower(code) = lower($2)`, [list.id, req.params.code]);
  if (!r) throw notFound(`${list.name} has no item "${req.params.code}".`);
  res.json(itemJson(list, r, localeOf(req)));
}));

// ============================================================================
//  MANAGE (System Admin)
// ============================================================================
export const platformGlobalListsRouter = Router();
const READ = requirePlatform('read_only');
const WRITE = requirePlatform('saas_admin');

async function managed(key: string): Promise<ListRow> {
  const list = LIST_KEY.test(key) ? await getList(key) : null;
  if (!list) throw notFound(`There is no global list "${key}".`);
  return list;
}

async function itemByRef(listId: string, ref: string) {
  return UUID.test(ref)
    ? one<any>(`SELECT * FROM global_list_items WHERE list_id = $1 AND id = $2`, [listId, ref])
    : one<any>(`SELECT * FROM global_list_items WHERE list_id = $1 AND lower(code) = lower($2)`, [listId, ref]);
}

const fieldSchema = z.object({
  key: z.string(), label: z.string().optional(), type: z.string(), required: z.boolean().optional(), unique: z.boolean().optional(),
  pattern: z.string().optional().nullable(), maxLength: z.number().int().optional().nullable(), case: z.enum(['upper', 'lower']).optional().nullable(),
  sortAs: z.enum(['number']).optional().nullable(), description: z.string().optional().nullable(),
}).passthrough();
const visibility = z.enum(['public', 'tenant', 'platform']);

platformGlobalListsRouter.get('/', ...READ, asyncHandler(async (_req, res) => {
  const rows = await query<any>(`SELECT l.*, ${COUNTS} FROM global_lists l ORDER BY l.archived_at NULLS FIRST, l.system DESC, l.name`);
  res.json({ items: rows.map(listJson) });
}));

const createSchema = z.object({
  key: z.string().trim().toLowerCase().regex(LIST_KEY, 'Use 2 to 41 lowercase letters, digits and dashes, starting with a letter'),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(400).optional().nullable(),
  visibility: visibility.default('tenant'),
  fields: z.array(fieldSchema).min(1).max(40),
  labelField: z.string(),
  codeField: z.string().optional().nullable(),
});
platformGlobalListsRouter.post('/', ...WRITE, asyncHandler(async (req, res) => {
  const b = createSchema.parse(req.body ?? {});
  const def = checkDefinition(b.fields, b.labelField, b.codeField);
  if (await getList(b.key)) throw conflict(`A global list with the key ${b.key} already exists.`);
  const { userId } = actor(req);
  const r = await one<any>(
    `INSERT INTO global_lists(key, name, description, visibility, fields, code_field, label_field, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [b.key, b.name, b.description ?? null, b.visibility, JSON.stringify(def.fields), def.codeField, def.labelField, userId]);
  await audit(req, 'create', 'global_list', r.id, { snapshot: { key: b.key, name: b.name, fields: def.fields.map((f) => f.key) } });
  res.status(201).json(listJson({ ...r, items: 0, active_items: 0 }));
}));

platformGlobalListsRouter.get('/:key', ...READ, asyncHandler(async (req, res) => {
  const list = await managed(req.params.key);
  const r = await one<any>(`SELECT l.*, ${COUNTS} FROM global_lists l WHERE l.id = $1`, [list.id]);
  res.json({ ...listJson(r), builtIn: BUILT_IN.some((b) => b.key === list.key) });
}));

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(400).optional().nullable(),
  visibility: visibility.optional(),
  fields: z.array(fieldSchema).min(1).max(40).optional(),
  labelField: z.string().optional(),
  codeField: z.string().optional().nullable(),
  archived: z.boolean().optional(),
});
platformGlobalListsRouter.patch('/:key', ...WRITE, asyncHandler(async (req, res) => {
  const list = await managed(req.params.key);
  const b = patchSchema.parse(req.body ?? {});
  if (b.archived && list.system) throw badRequest(`${list.name} is built in and cannot be archived. Set its visibility to platform to hide it from clients.`);
  const definitionChanged = b.fields !== undefined || b.labelField !== undefined || b.codeField !== undefined;
  let def = { fields: list.fields, labelField: list.label_field, codeField: list.code_field };
  if (definitionChanged) {
    def = checkDefinition(b.fields ?? list.fields, b.labelField ?? list.label_field, b.codeField === undefined ? list.code_field : b.codeField);
    if (list.system) {
      // Built-in lists can gain fields and change wording, never lose or retype one:
      // code and other services read these fields by name.
      for (const f of list.fields) {
        const next = def.fields.find((x) => x.key === f.key);
        if (!next) throw badRequest(`${f.key} is a built-in field of ${list.name} and cannot be removed.`);
        if (next.type !== f.type) throw badRequest(`${f.key} is a built-in field of ${list.name}; its type stays ${f.type}.`);
      }
      if (def.codeField !== list.code_field) throw badRequest(`The code field of ${list.name} is built in.`);
    }
    // The definition never lies: every item must pass it before it is saved.
    const failing = await itemsFailing(list.id, def);
    if (failing.length) throw Object.assign(invalidItems(`Existing items do not fit that definition (${failing.length >= 10 ? '10 or more' : failing.length} problems). Fix them first, or loosen the change.`, failing), { status: 409 });
    if (def.codeField && def.codeField !== list.code_field) {
      const mismatch = await one<any>(`SELECT code FROM global_list_items WHERE list_id = $1 AND code <> (value->>$2) LIMIT 1`, [list.id, def.codeField]);
      if (mismatch) throw conflict(`Item ${mismatch.code} has a code that differs from its ${def.codeField}; the code field can only be set when they already match.`);
    }
  }
  const { userId } = actor(req);
  const r = await one<any>(
    `UPDATE global_lists SET name = COALESCE($2, name), description = CASE WHEN $3::boolean THEN $4 ELSE description END,
       visibility = COALESCE($5, visibility), fields = $6, label_field = $7, code_field = $8,
       archived_at = CASE WHEN $9::boolean IS NULL THEN archived_at WHEN $9 THEN COALESCE(archived_at, now()) ELSE NULL END,
       version = version + 1, updated_at = now(), updated_by = $10
     WHERE id = $1 RETURNING *`,
    [list.id, b.name ?? null, b.description !== undefined, b.description ?? null, b.visibility ?? null,
      JSON.stringify(def.fields), def.labelField, def.codeField, b.archived ?? null, userId]);
  const changes: Record<string, { from: any; to: any }> = {};
  if (b.name !== undefined && b.name !== list.name) changes.name = { from: list.name, to: b.name };
  if (b.visibility && b.visibility !== list.visibility) changes.visibility = { from: list.visibility, to: b.visibility };
  if (definitionChanged) changes.fields = { from: list.fields.map((f) => f.key), to: def.fields.map((f) => f.key) };
  if (b.archived !== undefined && b.archived !== !!list.archived_at) changes.archived = { from: !!list.archived_at, to: b.archived };
  await audit(req, 'update', 'global_list', list.id, { changes, snapshot: { key: list.key } });
  const counted = await one<any>(`SELECT l.*, ${COUNTS} FROM global_lists l WHERE l.id = $1`, [r.id]);
  res.json(listJson(counted));
}));

platformGlobalListsRouter.get('/:key/items', ...READ, asyncHandler(async (req, res) => {
  const list = await managed(req.params.key);
  res.json({ items: await listItems(req, res, list, '/api/platform/global-lists/:key/items', true) });
}));

const itemSchema = z.object({
  code: z.string().trim().optional().nullable(),
  value: z.record(z.any()),
  position: z.number().int().min(0).max(1_000_000).optional(),
  isDefault: z.boolean().optional(),
  active: z.boolean().optional(),
});

platformGlobalListsRouter.post('/:key/items', ...WRITE, asyncHandler(async (req, res) => {
  const list = await managed(req.params.key);
  const b = itemSchema.parse(req.body ?? {});
  const { value, errors } = checkValue(list, b.value);
  if (errors.length) throw invalidItems(`That item does not fit ${list.name}: ${errors.join('; ')}`, errors);
  const code = codeFor(defOf(list), value, b.code);
  const { userId } = actor(req);
  const row = await tx(async (c) => {
    if ((await c.query(`SELECT 1 FROM global_list_items WHERE list_id = $1 AND lower(code) = lower($2)`, [list.id, code])).rowCount) {
      throw conflict(`${list.name} already has an item with the code ${code}.`);
    }
    const clashes = await uniqueClashes(c, list, value, null);
    if (clashes.length) throw conflict(clashes.join('; '));
    if (b.isDefault) await c.query(`UPDATE global_list_items SET is_default = false WHERE list_id = $1 AND is_default`, [list.id]);
    const pos = b.position ?? Number((await c.query(`SELECT COALESCE(max(position) + 1, 0) AS p FROM global_list_items WHERE list_id = $1`, [list.id])).rows[0].p);
    const r = (await c.query(
      `INSERT INTO global_list_items(list_id, code, value, position, is_default, active, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [list.id, code, JSON.stringify(value), pos, !!b.isDefault, b.active ?? true, userId])).rows[0];
    await bumpVersion(c, list.id, userId);
    return r;
  });
  await audit(req, 'create', 'global_list_item', row.id, { snapshot: { list: list.key, code, value } });
  res.status(201).json(itemJson(list, row));
}));

const itemPatch = itemSchema.partial();
platformGlobalListsRouter.patch('/:key/items/:ref', ...WRITE, asyncHandler(async (req, res) => {
  const list = await managed(req.params.key);
  const ex = await itemByRef(list.id, req.params.ref);
  if (!ex) throw notFound(`${list.name} has no item "${req.params.ref}".`);
  const b = itemPatch.parse(req.body ?? {});
  let value = ex.value;
  if (b.value !== undefined) {
    const chk = checkValue(list, b.value);
    if (chk.errors.length) throw invalidItems(`That item does not fit ${list.name}: ${chk.errors.join('; ')}`, chk.errors);
    value = chk.value;
  }
  // The code follows the code field where the list has one; otherwise it moves only when asked.
  let code: string = ex.code;
  if (list.code_field) code = codeFor(defOf(list), value);
  else if (b.code && b.code !== ex.code) code = codeFor(defOf(list), value, b.code);
  if (code !== ex.code && list.system && !list.code_field) throw badRequest(`Codes in ${list.name} are fixed once made; other records store them.`);
  const { userId } = actor(req);
  const row = await tx(async (c) => {
    if (code.toLowerCase() !== String(ex.code).toLowerCase()
      && (await c.query(`SELECT 1 FROM global_list_items WHERE list_id = $1 AND lower(code) = lower($2)`, [list.id, code])).rowCount) {
      throw conflict(`${list.name} already has an item with the code ${code}.`);
    }
    const clashes = await uniqueClashes(c, list, value, ex.id);
    if (clashes.length) throw conflict(clashes.join('; '));
    if (b.isDefault) await c.query(`UPDATE global_list_items SET is_default = false WHERE list_id = $1 AND is_default AND id <> $2`, [list.id, ex.id]);
    const r = (await c.query(
      `UPDATE global_list_items SET code = $2, value = $3, position = COALESCE($4, position), is_default = COALESCE($5, is_default),
         active = COALESCE($6, active), updated_at = now(), updated_by = $7 WHERE id = $1 RETURNING *`,
      [ex.id, code, JSON.stringify(value), b.position ?? null, b.isDefault ?? null, b.active ?? null, userId])).rows[0];
    await bumpVersion(c, list.id, userId);
    return r;
  });
  const changes: Record<string, { from: any; to: any }> = {};
  for (const k of new Set([...Object.keys(ex.value ?? {}), ...Object.keys(value ?? {})])) {
    if (JSON.stringify(ex.value?.[k]) !== JSON.stringify(value?.[k])) changes[`value.${k}`] = { from: ex.value?.[k] ?? null, to: value?.[k] ?? null };
  }
  if (code !== ex.code) changes.code = { from: ex.code, to: code };
  for (const [k, col] of [['position', 'position'], ['isDefault', 'is_default'], ['active', 'active']] as const) {
    if ((b as any)[k] !== undefined && (b as any)[k] !== ex[col]) changes[k] = { from: ex[col], to: (b as any)[k] };
  }
  await audit(req, 'update', 'global_list_item', ex.id, { changes, snapshot: { list: list.key, code } });
  res.json(itemJson(list, row));
}));

platformGlobalListsRouter.delete('/:key/items/:ref', ...WRITE, asyncHandler(async (req, res) => {
  const list = await managed(req.params.key);
  const ex = await itemByRef(list.id, req.params.ref);
  if (!ex) throw notFound(`${list.name} has no item "${req.params.ref}".`);
  if (list.system) throw conflict(`${list.name} is built in: retire the item instead (active: false), so records that store ${ex.code} still resolve.`);
  const { userId } = actor(req);
  await tx(async (c) => {
    await c.query(`DELETE FROM global_list_items WHERE id = $1`, [ex.id]);
    await bumpVersion(c, list.id, userId);
  });
  await audit(req, 'delete', 'global_list_item', ex.id, { snapshot: { list: list.key, code: ex.code, value: ex.value } });
  res.status(204).end();
}));

const orderSchema = z.object({ codes: z.array(z.string()).min(1).max(5000) });
platformGlobalListsRouter.put('/:key/order', ...WRITE, asyncHandler(async (req, res) => {
  const list = await managed(req.params.key);
  const { codes } = orderSchema.parse(req.body ?? {});
  const { userId } = actor(req);
  const moved = await tx(async (c) => {
    const rows = (await c.query(`SELECT id, code FROM global_list_items WHERE list_id = $1 ORDER BY position, code`, [list.id])).rows as { id: string; code: string }[];
    const byCode = new Map(rows.map((r) => [r.code.toLowerCase(), r]));
    const unknown = codes.filter((x) => !byCode.has(x.toLowerCase()));
    if (unknown.length) throw badRequest(`Not in ${list.name}: ${unknown.slice(0, 10).join(', ')}`);
    const named = new Set(codes.map((x) => x.toLowerCase()));
    const order = [...codes.map((x) => byCode.get(x.toLowerCase())!), ...rows.filter((r) => !named.has(r.code.toLowerCase()))];
    await c.query(
      `UPDATE global_list_items i SET position = o.pos - 1, updated_at = now() FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, pos)
        WHERE i.id = o.id AND i.list_id = $1 AND i.position <> o.pos - 1`,
      [list.id, order.map((r) => r.id)]);
    await bumpVersion(c, list.id, userId);
    return order.length;
  });
  await audit(req, 'update', 'global_list', list.id, { changes: { order: { from: null, to: `${codes.length} items placed first` } }, snapshot: { key: list.key } });
  res.json({ ordered: moved });
}));

const importSchema = z.object({
  items: z.array(itemSchema).max(5000),
  mode: z.enum(['merge', 'replace']).default('merge'),
  dryRun: z.boolean().optional(),
});
platformGlobalListsRouter.post('/:key/import', ...WRITE, asyncHandler(async (req, res) => {
  const list = await managed(req.params.key);
  const b = importSchema.parse(req.body ?? {});
  const def = defOf(list);
  // Validate everything first, so an import is all or nothing.
  const errors: string[] = [];
  const incoming: { code: string; value: Record<string, unknown>; position?: number; isDefault?: boolean; active?: boolean }[] = [];
  const seenCodes = new Map<string, number>();
  const seenUnique = new Map<string, Map<string, string>>();
  b.items.forEach((it, n) => {
    const { value, errors: e } = checkValue(list, it.value);
    let code = '';
    if (!e.length) { try { code = codeFor(def, value, it.code); } catch (x: any) { e.push(x.message); } }
    if (e.length) { errors.push(...e.map((m) => `item ${n + 1}${code ? ` (${code})` : ''}: ${m}`)); return; }
    const k = code.toLowerCase();
    if (seenCodes.has(k)) { errors.push(`item ${n + 1} (${code}): the same code as item ${seenCodes.get(k)! + 1}`); return; }
    seenCodes.set(k, n);
    for (const f of list.fields) {
      if (!f.unique || value[f.key] == null) continue;
      const m = seenUnique.get(f.key) ?? new Map<string, string>(); seenUnique.set(f.key, m);
      const v = String(value[f.key]).toLowerCase();
      if (m.has(v)) errors.push(`item ${n + 1} (${code}): ${f.key} "${value[f.key]}" is also on ${m.get(v)}`); else m.set(v, code);
    }
    incoming.push({ code, value, position: it.position, isDefault: it.isDefault, active: it.active });
  });
  if (incoming.filter((i) => i.isDefault).length > 1) errors.push('More than one item is marked as the default.');
  if (errors.length) throw invalidItems(`The import was not applied: ${errors.length} problem${errors.length === 1 ? '' : 's'}.`, errors.slice(0, 200));

  const { userId } = actor(req);
  const summary = await tx(async (c) => {
    const existing = (await c.query(`SELECT * FROM global_list_items WHERE list_id = $1 FOR UPDATE`, [list.id])).rows as any[];
    const byCode = new Map(existing.map((r) => [String(r.code).toLowerCase(), r]));
    // Unique values must not collide with items the import leaves untouched.
    const kept = existing.filter((r) => !seenCodes.has(String(r.code).toLowerCase()));
    for (const f of list.fields) {
      if (!f.unique) continue;
      const theirs = new Map(kept.filter((r) => r.value?.[f.key] != null).map((r) => [String(r.value[f.key]).toLowerCase(), r.code]));
      for (const it of incoming) {
        const v = it.value[f.key];
        if (v != null && theirs.has(String(v).toLowerCase())) errors.push(`${it.code}: ${f.key} "${v}" is already used by ${theirs.get(String(v).toLowerCase())}`);
      }
    }
    if (errors.length) throw invalidItems(`The import was not applied: ${errors.length} problem${errors.length === 1 ? '' : 's'}.`, errors.slice(0, 200));
    let created = 0, updated = 0, unchanged = 0, retired = 0;
    let nextPos = existing.reduce((m, r) => Math.max(m, r.position + 1), 0);
    if (incoming.some((i) => i.isDefault)) await c.query(`UPDATE global_list_items SET is_default = false WHERE list_id = $1 AND is_default`, [list.id]);
    for (const it of incoming) {
      const ex = byCode.get(it.code.toLowerCase());
      if (!ex) {
        await c.query(`INSERT INTO global_list_items(list_id, code, value, position, is_default, active, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [list.id, it.code, JSON.stringify(it.value), it.position ?? nextPos++, !!it.isDefault, it.active ?? true, userId]);
        created++;
      } else {
        const same = JSON.stringify(ex.value) === JSON.stringify(it.value) && (it.position === undefined || it.position === ex.position)
          && (it.active === undefined || it.active === ex.active) && !it.isDefault;
        if (same) { unchanged++; continue; }
        await c.query(`UPDATE global_list_items SET value = $2, position = COALESCE($3, position), is_default = COALESCE($4, is_default),
                         active = COALESCE($5, active), updated_at = now(), updated_by = $6 WHERE id = $1`,
          [ex.id, JSON.stringify(it.value), it.position ?? null, it.isDefault ? true : null, it.active ?? null, userId]);
        updated++;
      }
    }
    if (b.mode === 'replace') {
      // Replace retires what the file no longer has; it never deletes (records may store those codes).
      const gone = kept.filter((r) => r.active).map((r) => r.id);
      if (gone.length) {
        await c.query(`UPDATE global_list_items SET active = false, is_default = false, updated_at = now(), updated_by = $2 WHERE id = ANY($1::uuid[])`, [gone, userId]);
        retired = gone.length;
      }
    }
    const result = { created, updated, unchanged, retired, dryRun: !!b.dryRun };
    if (b.dryRun) { const e: any = new Error('dry run'); e.dryRun = result; throw e; }
    if (created || updated || retired) await bumpVersion(c, list.id, userId);
    return result;
  }).catch((e) => { if (e?.dryRun) return e.dryRun; throw e; });
  if (!summary.dryRun) await audit(req, 'update', 'global_list', list.id, { changes: { import: { from: null, to: `${b.mode}: ${summary.created} added, ${summary.updated} updated, ${summary.retired} retired` } }, snapshot: { key: list.key } });
  res.json(summary);
}));

platformGlobalListsRouter.get('/:key/export', ...READ, asyncHandler(async (req, res) => {
  const list = await managed(req.params.key);
  const rows = await query<any>(`SELECT * FROM global_list_items WHERE list_id = $1 ORDER BY position, code`, [list.id]);
  res.setHeader('Content-Disposition', `attachment; filename="volt-global-list-${list.key}-v${list.version}.json"`);
  res.json({
    list: { key: list.key, name: list.name, description: list.description, visibility: list.visibility, labelField: list.label_field, codeField: list.code_field, fields: list.fields, version: list.version },
    items: rows.map((r) => ({ code: r.code, value: r.value, position: r.position, isDefault: r.is_default, active: r.active })),
    exportedAt: new Date().toISOString(),
  });
}));

platformGlobalListsRouter.post('/:key/restore', ...WRITE, asyncHandler(async (req, res) => {
  const list = await managed(req.params.key);
  const overwrite = !!req.body?.overwrite;
  const { userId } = actor(req);
  const r = await tx(async (c) => {
    const out = await restoreShipped(c, list, overwrite);
    if (out.added || out.reset) await bumpVersion(c, list.id, userId);
    return out;
  });
  await audit(req, 'update', 'global_list', list.id, { changes: { restore: { from: null, to: `shipped values: ${r.added} added, ${r.reset} reset` } }, snapshot: { key: list.key } });
  res.json(r);
}));
