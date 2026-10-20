/**
 * THE VOLT LIST STANDARD: search, filter, sort and page any collection the
 * same way. (Guideline: docs/API_STANDARDS.md, section "Lists".)
 *
 *   GET /api/jobs?q=transcode&state=failed,cancelled&created_at[gte]=2026-10-01
 *                &sort=-created_at,type&limit=50&cursor=<from the last page>
 *
 *   q             free-text search over the resource's searchable fields;
 *                 every word must match (AND), case-insensitive, partial
 *   <field>=v     equals; a comma list means "any of" (state=failed,cancelled)
 *   <field>[op]=v eq ne gt gte lt lte in nin contains starts exists
 *   sort          comma list of fields, "-" for descending; ties broken by id
 *   limit         page size (default 50, max 200 unless the resource says)
 *   cursor        opaque, from the previous page's Link rel="next" (or
 *                 "prev", "last"); bound to the same q, filters and sort, so
 *                 paging never changes view. Keyset in both directions: a
 *                 cursor reads after a row (next), before a row (prev) or
 *                 the final page (last)
 *   offset        alternative to cursor for tables that need page jumps
 *   count=true    also return the total that match (X-Total-Count)
 *
 * WHY ONE HELPER: the same definition (a ListSpec) builds the SQL, validates
 * the request, and is exported to the API reference, so the documented
 * filters are exactly the ones that work. Only fields named in the spec can
 * reach SQL, and their SQL is written by us, never taken from the request.
 *
 * Responses keep each endpoint's existing body shape (a bare array, or an
 * object such as { jobs: [...] }). Paging travels in headers, so adopting the
 * standard breaks no client:
 *   Link: <...&cursor=...>; rel="next"     (RFC 8288)
 *   Link: <...>; rel="first", rel="prev", rel="last" when they exist
 *   X-Next-Cursor, X-Total-Count (with count=true), X-Page-Limit
 */
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { ApiError } from './http';

export type FieldType = 'string' | 'number' | 'boolean' | 'timestamp' | 'uuid' | 'enum';
export type Op = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin' | 'contains' | 'starts' | 'exists';

export interface FieldSpec {
  /** Trusted SQL expression for the field (e.g. "j.created_at"). Never from input. */
  sql: string;
  type: FieldType;
  /** Allowed values for an enum (validated, and listed in the docs). */
  values?: readonly string[];
  /** Can be used in sort= (default true). */
  sort?: boolean;
  /** Can be used as a filter (default true). */
  filter?: boolean;
  /** Property on each returned row that holds the value (cursor). Default: the field name. */
  key?: string;
  /** One line for the API reference. */
  doc?: string;
  /**
   * The column is never NULL (NOT NULL in the schema). Sorting and paging then
   * use the plain column, so Postgres can use an index on it; nullable fields
   * are wrapped in COALESCE so NULLs sort consistently, which no index serves.
   */
  notNull?: boolean;
}

export interface ListSpec {
  /** The full route, e.g. "/api/jobs" (used for the API reference and errors). */
  path: string;
  method?: 'GET';
  fields: Record<string, FieldSpec>;
  /** Fields that q searches (names from `fields`, or raw trusted SQL expressions). */
  search?: string[];
  /** Default sort, e.g. "-created_at". */
  defaultSort: string;
  /** Unique, never-null tiebreak; must also be in `fields` (default "id"). */
  idField?: string;
  defaultLimit?: number;
  maxLimit?: number;
  /** Older parameter names still accepted: { channelId: 'channel_id' }. */
  aliases?: Record<string, string>;
  /** Other query parameters this endpoint handles itself (not filters). */
  extraParams?: string[];
  /** Offer offset paging (for UIs that jump to a page). Cursor is always offered. */
  allowOffset?: boolean;
  /**
   * COMPATIBILITY for a list that used to return every row: when the caller
   * sends no limit, cursor or offset, return up to this many (with Link next
   * beyond it) instead of defaultLimit, so existing screens keep their data.
   * Remove once the console pages that list on the server.
   */
  unpagedLimit?: number;
}

export interface ParsedList {
  spec: ListSpec;
  /** Filter and search conditions (the view). */
  where: string[];
  /** The cursor's "after the last row" condition, kept apart so totals ignore it. */
  cursorWhere: string | null;
  /** How many SQL params the filters and search use (the cursor's come after). */
  filterParamCount: number;
  orderBy: string;
  limit: number;
  offset: number;
  count: boolean;
  /** Fields in sort order, with direction, ending in the id tiebreak. */
  sortKeys: { name: string; desc: boolean }[];
  fingerprint: string;
  /**
   * Which way this page was read. "after" (the default, and every cursor
   * issued before 20 Oct 2026), "before" (a prev cursor: rows before the
   * anchor, read in reverse and flipped back), "last" (the final page, read
   * in reverse). orderBy is already reversed for "before" and "last";
   * finishPage puts the rows back in view order.
   */
  direction: 'after' | 'before' | 'last';
  /** True when the request carried a cursor or offset (so a first page exists before it). */
  paged: boolean;
}

const RESERVED = new Set(['q', 'sort', 'limit', 'cursor', 'offset', 'count']);
const OPS_BY_TYPE: Record<FieldType, Op[]> = {
  string: ['eq', 'ne', 'in', 'nin', 'contains', 'starts', 'exists'],
  uuid: ['eq', 'ne', 'in', 'nin', 'exists'],
  enum: ['eq', 'ne', 'in', 'nin', 'exists'],
  boolean: ['eq', 'ne', 'exists'],
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'exists'],
  timestamp: ['eq', 'gt', 'gte', 'lt', 'lte', 'exists'],
};
export const opsFor = (f: FieldSpec): Op[] => OPS_BY_TYPE[f.type];

/** A 400 that says exactly what is allowed, so a developer can fix the call. */
function invalid(message: string, details: Record<string, unknown>): ApiError {
  const e: any = new ApiError(400, message);
  e.code = 'invalid_list_query';
  e.details = details;
  return e;
}

/**
 * Timestamps sort and page at MILLISECOND precision. Postgres stores
 * microseconds but a row reaches JavaScript as a Date (milliseconds), so the
 * cursor can only carry milliseconds. Comparing a microsecond column with a
 * millisecond cursor repeated the anchor row on every ascending page (a
 * client following next looped) and skipped rows in the anchor's millisecond
 * on descending pages (found 20 Oct 2026; rows written in one statement share
 * now()). Truncated on both sides, rows in one millisecond tie-break by id,
 * so the keyset is exact. `AT TIME ZONE 'UTC'` makes the expression
 * immutable, so an expression index can serve it:
 *   CREATE INDEX ... ON t (date_trunc('milliseconds', created_at AT TIME ZONE 'UTC') DESC, id)
 */
const msTs = (e: string) => `date_trunc('milliseconds', (${e})::timestamptz AT TIME ZONE 'UTC')`;

/** NULL-safe sort/compare expression: nulls sort as the smallest value, consistently. */
function sortExpr(f: FieldSpec): string {
  if (f.notNull) return f.type === 'enum' ? `(${f.sql})::text` : f.type === 'timestamp' ? msTs(f.sql) : `(${f.sql})`;
  switch (f.type) {
    case 'number': return `COALESCE((${f.sql})::float8, '-Infinity'::float8)`;
    case 'timestamp': return msTs(`COALESCE((${f.sql})::timestamptz, '-infinity'::timestamptz)`);
    case 'boolean': return `COALESCE((${f.sql})::int, -1)`;
    default: return `COALESCE((${f.sql})::text, '')`;
  }
}
const sqlCast = (t: FieldType) => (t === 'number' ? '::float8' : t === 'timestamp' ? '::timestamptz' : t === 'boolean' ? '::boolean' : t === 'uuid' ? '::uuid' : '::text');

function coerce(f: FieldSpec, name: string, raw: string): string | number | boolean {
  const v = raw.trim();
  switch (f.type) {
    case 'number': {
      const n = Number(v);
      if (v === '' || !Number.isFinite(n)) throw invalid(`${name} must be a number`, { field: name, value: raw });
      return n;
    }
    case 'boolean':
      if (v !== 'true' && v !== 'false') throw invalid(`${name} must be true or false`, { field: name, value: raw });
      return v === 'true';
    case 'timestamp': {
      const t = Date.parse(v);
      if (Number.isNaN(t)) throw invalid(`${name} must be a date or time (ISO 8601, e.g. 2026-10-18 or 2026-10-18T09:30:00Z)`, { field: name, value: raw });
      return new Date(t).toISOString();
    }
    case 'uuid':
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw invalid(`${name} must be an id (UUID)`, { field: name, value: raw });
      return v;
    case 'enum':
      if (f.values && !f.values.includes(v)) throw invalid(`${name} must be one of: ${f.values.join(', ')}`, { field: name, value: raw, allowed: f.values });
      return v;
    default:
      return v;
  }
}
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const str = (v: unknown): string => (Array.isArray(v) ? v.map(String).join(',') : String(v ?? ''));

/**
 * Parse req.query against the spec. `params` is the caller's SQL parameter
 * array (tenant id etc. already in it); placeholders continue from its length.
 */
export function parseList(spec: ListSpec, query: Request['query'], params: unknown[]): ParsedList {
  const idField = spec.idField ?? 'id';
  if (!spec.fields[idField]) throw new Error(`ListSpec ${spec.path}: idField "${idField}" is not a field`);
  // The id tiebreak is unique and never null by contract: sort on the plain column.
  const sortFields: Record<string, FieldSpec> = { ...spec.fields, [idField]: { ...spec.fields[idField], notNull: true } };
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const where: string[] = [];
  const filterable = Object.keys(spec.fields).filter((k) => spec.fields[k].filter !== false);
  const sortable = Object.keys(spec.fields).filter((k) => spec.fields[k].sort !== false);
  const extra = new Set(spec.extraParams ?? []);

  // ---- filters
  for (const [rawName, rawVal] of Object.entries(query)) {
    // "_" parameters are cache-busters some clients and proxies add (_=1718…):
    // never a filter, so they are ignored rather than refused.
    if (RESERVED.has(rawName) || extra.has(rawName) || rawName.startsWith('_')) continue;
    const name = spec.aliases?.[rawName] ?? rawName;
    const f = spec.fields[name];
    if (!f || f.filter === false) {
      throw invalid(`Unknown filter "${rawName}". Filter on: ${filterable.join(', ')}`, { parameter: rawName, filterable, reserved: [...RESERVED] });
    }
    const conds: [Op, string][] = rawVal && typeof rawVal === 'object' && !Array.isArray(rawVal)
      ? Object.entries(rawVal as Record<string, unknown>).map(([op, v]) => [op as Op, str(v)])
      : [[str(rawVal).includes(',') ? 'in' : 'eq', str(rawVal)]];
    for (const [op, val] of conds) {
      if (!opsFor(f).includes(op)) {
        throw invalid(`"${op}" is not available for ${name}. Use: ${opsFor(f).join(', ')}`, { field: name, op, allowed: opsFor(f) });
      }
      const col = `(${f.sql})`;
      if (op === 'exists') {
        const yes = coerce({ ...f, type: 'boolean' }, `${name}[exists]`, val);
        where.push(`${col} IS ${yes ? 'NOT ' : ''}NULL`);
      } else if (op === 'in' || op === 'nin') {
        const list = val.split(',').map((x) => x.trim()).filter(Boolean).map((x) => coerce(f, name, x));
        if (!list.length) throw invalid(`${name}[${op}] needs at least one value`, { field: name });
        if (list.length > 100) throw invalid(`${name}[${op}] takes at most 100 values`, { field: name });
        const arr = p(list.map(String));
        where.push(`${f.type === 'enum' || f.type === 'string' || f.type === 'uuid' ? `${col}::text` : col} ${op === 'in' ? '=' : '<>'} ${op === 'in' ? 'ANY' : 'ALL'}(${arr}::text[]${f.type === 'number' ? '::float8[]' : f.type === 'boolean' ? '::boolean[]' : f.type === 'timestamp' ? '::timestamptz[]' : ''})`);
      } else if (op === 'contains' || op === 'starts') {
        const pat = (op === 'contains' ? '%' : '') + likeEscape(String(coerce(f, name, val))) + '%';
        where.push(`${col}::text ILIKE ${p(pat)}`);
      } else {
        const sym = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op as 'eq'];
        const v = coerce(f, name, val);
        const lhs = f.type === 'enum' ? `${col}::text` : col;
        where.push(op === 'ne' ? `${lhs} IS DISTINCT FROM ${p(v)}${sqlCast(f.type === 'enum' ? 'string' : f.type)}` : `${lhs} ${sym} ${p(v)}${sqlCast(f.type === 'enum' ? 'string' : f.type)}`);
      }
    }
  }

  // ---- search
  const q = str(query.q).trim();
  if (q) {
    if (!spec.search?.length) throw invalid(`${spec.path} does not support q (search). Use filters: ${filterable.join(', ')}`, { filterable });
    const exprs = spec.search.map((s) => (spec.fields[s] ? `(${spec.fields[s].sql})::text` : s));
    const doc = `concat_ws(' ', ${exprs.map((e) => `COALESCE(${e}, '')`).join(', ')})`;
    const words = q.split(/\s+/).filter(Boolean).slice(0, 8);
    for (const w of words) where.push(`${doc} ILIKE ${p('%' + likeEscape(w) + '%')}`);
  }

  // ---- sort
  const sortRaw = str(query.sort).trim() || spec.defaultSort;
  const sortKeys = sortRaw.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const desc = s.startsWith('-');
    const name = spec.aliases?.[s.replace(/^[-+]/, '')] ?? s.replace(/^[-+]/, '');
    if (!spec.fields[name] || spec.fields[name].sort === false) {
      throw invalid(`Cannot sort by "${name}". Sort by: ${sortable.join(', ')} (prefix with - for descending)`, { sort: name, sortable });
    }
    return { name, desc };
  });
  if (sortKeys.length > 4) throw invalid('Sort by at most 4 fields', { sort: sortRaw });
  if (!sortKeys.some((k) => k.name === idField)) sortKeys.push({ name: idField, desc: false });
  const orderFor = (flip: boolean) => sortKeys.map((k) => `${sortExpr(sortFields[k.name])} ${k.desc !== flip ? 'DESC' : 'ASC'}`).join(', ');
  let orderBy = orderFor(false);

  // ---- size
  const maxLimit = spec.maxLimit ?? 200;
  const limitRaw = str(query.limit);
  const unpaged = !limitRaw && !str(query.cursor) && !str(query.offset);
  const limit = limitRaw ? Number(limitRaw) : unpaged && spec.unpagedLimit ? spec.unpagedLimit : (spec.defaultLimit ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || (limit > maxLimit && !(unpaged && limit === spec.unpagedLimit))) throw invalid(`limit must be 1 to ${maxLimit}`, { limit: limitRaw, max: maxLimit });

  // The view a cursor belongs to: same filters, search and sort.
  const view = JSON.stringify([Object.entries(query).filter(([k]) => !['cursor', 'offset', 'limit', 'count'].includes(k)).sort(), sortKeys]);
  const fingerprint = createHash('sha256').update(spec.path + view).digest('base64url').slice(0, 12);

  // ---- cursor (keyset) or offset
  let offset = 0;
  let cursorWhere: string | null = null;
  const filterParamCount = params.length;
  const cursorRaw = str(query.cursor);
  let direction: ParsedList['direction'] = 'after';
  if (cursorRaw) {
    let c: { f: string; v: unknown[]; d?: string };
    try { c = JSON.parse(Buffer.from(cursorRaw, 'base64url').toString('utf8')); } catch { throw invalid('cursor is not valid. Use the Link rel="next" from the previous page.', {}); }
    const d = c?.d ?? 'a';
    if (!c || c.f !== fingerprint || !['a', 'b', 'z'].includes(d) || (d !== 'z' && (!Array.isArray(c.v) || c.v.length !== sortKeys.length))) {
      throw invalid('cursor belongs to a different search, filter or sort. Start again without cursor.', {});
    }
    direction = d === 'b' ? 'before' : d === 'z' ? 'last' : 'after';
    if (direction !== 'after') orderBy = orderFor(true);
  }
  if (cursorRaw && direction !== 'last') {
    const c = JSON.parse(Buffer.from(cursorRaw, 'base64url').toString('utf8')) as { v: unknown[] };
    // "before" is the same keyset condition with every comparison turned round.
    const flip = direction === 'before';
    // (a,b,id) after (x,y,z), honouring each key's direction:
    // a>x OR (a=x AND b<y) OR (a=x AND b=y AND id>z) ...
    const ors: string[] = [];
    for (let i = 0; i < sortKeys.length; i++) {
      const parts: string[] = [];
      for (let j = 0; j < i; j++) {
        const f = sortFields[sortKeys[j].name];
        parts.push(`${sortExpr(f)} = ${sortExpr({ ...f, sql: `${p(c.v[j])}${sqlCast(f.type === 'enum' ? 'string' : f.type)}` })}`);
      }
      const f = sortFields[sortKeys[i].name];
      parts.push(`${sortExpr(f)} ${sortKeys[i].desc !== flip ? '<' : '>'} ${sortExpr({ ...f, sql: `${p(c.v[i])}${sqlCast(f.type === 'enum' ? 'string' : f.type)}` })}`);
      ors.push(`(${parts.join(' AND ')})`);
    }
    cursorWhere = `(${ors.join(' OR ')})`;
  } else if (!cursorRaw && str(query.offset)) {
    if (!spec.allowOffset) throw invalid(`${spec.path} pages with cursor, not offset`, {});
    offset = Number(str(query.offset));
    if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw invalid('offset must be 0 to 100000', {});
  }

  const paged = !!cursorRaw || offset > 0;
  return { spec, where, cursorWhere, filterParamCount, orderBy, limit, offset, count: str(query.count) === 'true', sortKeys, fingerprint, direction, paged };
}

/** SQL tail for the page: ORDER BY + LIMIT (one extra row tells us there is a next page). */
export const pageSql = (pl: ParsedList) => `ORDER BY ${pl.orderBy} LIMIT ${pl.limit + 1}${pl.offset ? ` OFFSET ${pl.offset}` : ''}`;
/** " AND (…)" for the page query's WHERE: filters, search and the cursor. */
export const whereSql = (pl: ParsedList) => {
  const all = pl.cursorWhere ? [...pl.where, pl.cursorWhere] : pl.where;
  return all.length ? ` AND ${all.join(' AND ')}` : '';
};
/** " AND (…)" for a count=true total: filters and search only, so the total is
 *  the same on every page. Use with the same params array as the page query. */
export const countWhereSql = (pl: ParsedList) => (pl.where.length ? ` AND ${pl.where.join(' AND ')}` : '');
/** The params for that count: the page's params without the cursor's values. */
export const countParams = (pl: ParsedList, params: unknown[]) => params.slice(0, pl.filterParamCount);

/**
 * Trim the extra row, set the paging headers, and return this page's rows.
 * `total` is only used with count=true (run the count query only then).
 */
export function finishPage<T extends Record<string, any>>(req: Request, res: Response, pl: ParsedList, rows: T[], total?: number): T[] {
  const more = rows.length > pl.limit;
  const reversed = pl.direction !== 'after';
  // A reversed read comes back nearest-the-anchor first: trim, then flip to view order.
  const page = more ? rows.slice(0, pl.limit) : rows.slice();
  if (reversed) page.reverse();
  res.setHeader('X-Page-Limit', String(pl.limit));
  if (pl.count && typeof total === 'number') res.setHeader('X-Total-Count', String(total));

  const cursorAt = (row: T, d: 'a' | 'b' | 'z') => {
    const body: { f: string; v?: unknown[]; d?: string } = { f: pl.fingerprint };
    if (d !== 'z') {
      body.v = pl.sortKeys.map((k) => {
        const f = pl.spec.fields[k.name];
        const v = row[f.key ?? k.name];
        return v instanceof Date ? v.toISOString() : v ?? null;
      });
    }
    if (d !== 'a') body.d = d; // "after" cursors keep the original shape
    return Buffer.from(JSON.stringify(body)).toString('base64url');
  };
  const link = (cursor: string | null, rel: string) => {
    const u = new URL(req.originalUrl, 'http://x');
    u.searchParams.delete('offset');
    u.searchParams.delete('cursor');
    if (cursor) u.searchParams.set('cursor', cursor);
    // Keep the page size the caller is reading, so every page is the same size
    // (not a compatibility page above maxLimit, which a cursor may not ask for).
    if (!u.searchParams.has('limit') && pl.limit <= (pl.spec.maxLimit ?? 200)) u.searchParams.set('limit', String(pl.limit));
    res.append('Link', `<${u.pathname}${u.search}>; rel="${rel}"`);
  };

  // next: forward with more rows, or any "before" page (the anchor is after it).
  const hasNext = page.length > 0 && (pl.direction === 'after' ? more : pl.direction === 'before');
  // prev: a page read from a cursor or offset going forward, or a reversed read with more behind it.
  const hasPrev = page.length > 0 && (pl.direction === 'after' ? pl.paged : more);
  if (hasNext) {
    const cursor = cursorAt(page[page.length - 1], 'a');
    res.setHeader('X-Next-Cursor', cursor);
    link(cursor, 'next');
  }
  if (hasPrev) {
    const cursor = cursorAt(page[0], 'b');
    res.setHeader('X-Prev-Cursor', cursor);
    link(cursor, 'prev');
  }
  if (hasNext || hasPrev) {
    link(null, 'first');
    link(cursorAt(page[0], 'z'), 'last');
  }
  const exposed = 'Link, X-Next-Cursor, X-Prev-Cursor, X-Total-Count, X-Page-Limit';
  const prev = res.getHeader('Access-Control-Expose-Headers');
  res.setHeader('Access-Control-Expose-Headers', prev ? `${prev}, ${exposed}` : exposed);
  return page;
}

/**
 * Route guard for an item route declared as '/:id' on a router that also has
 * named sub-paths ('/owners', '/series/:id'): a non-id falls through to the
 * next route instead of being read as an id, so the item route shadows nothing.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function onlyIdParam(req: Request, _res: Response, next: (arg?: 'route') => void) {
  return UUID_RE.test(String(req.params.id ?? '')) ? next() : next('route');
}

/* ---------- registry: the API reference documents exactly what parses ---------- */
const registry: ListSpec[] = [];
/** Declare a list endpoint's spec (call at module load, next to the route). */
export function defineList(spec: ListSpec): ListSpec {
  registry.push(spec);
  return spec;
}
/** The spec registered for a route pattern ("/api/status/:kind/:id/events"), if any. */
export function findListSpec(path: string): ListSpec | undefined {
  return registry.find((s) => s.path === path);
}
/** Plain-JSON form of every registered spec, for the API reference generator. */
export function listSpecsForDocs() {
  return registry.map((s) => ({
    method: s.method ?? 'GET',
    path: s.path,
    search: (s.search ?? []).filter((x) => !!s.fields[x]),
    defaultSort: s.defaultSort,
    defaultLimit: s.defaultLimit ?? 50,
    maxLimit: s.maxLimit ?? 200,
    allowOffset: !!s.allowOffset,
    unpagedLimit: s.unpagedLimit ?? null,
    aliases: s.aliases ?? {},
    fields: Object.fromEntries(Object.entries(s.fields).map(([k, f]) => [k, {
      type: f.type, values: f.values, sort: f.sort !== false, filter: f.filter !== false, ops: f.filter === false ? [] : opsFor(f), doc: f.doc,
    }])),
  })).sort((a, b) => a.path.localeCompare(b.path));
}
