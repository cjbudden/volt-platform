// ============================================================================
//  RULE-BASED COLLECTIONS (build queue C1).
//
//  A collection's members are what its rules match, plus what a person added,
//  minus what a person left out. The rules are a small tree:
//
//    { match: 'all' | 'any', conditions: [ condition | group ] }
//    condition = { field, op, value }
//
//  Fields come from one catalogue (FIELDS, plus the account's content type
//  fields as `meta:<key>`), each with a type, and each type has its operators
//  (OPS). A rule set compiles to ONE SQL query over the account's library
//  (compile), so matching a whole collection is one INSERT ... SELECT and one
//  DELETE, and matching a batch of changed assets is the same query with an
//  id filter. Membership is stored in collection_items (source 'rule'), never
//  worked out per request.
//
//  When it runs:
//    - on saving rules, at once (recompute);
//    - when assets change: the vod_assets trigger (migration 0138) queues
//      them in collection_rechecks, and drainRechecks matches each batch
//      against the account's rule collections, every few seconds;
//    - every night, and whenever a collection is marked stale (a rights
//      profile's provider changed), the full re-check (recheckStale).
//  Several control plane tasks may run the passes at once: the queue is
//  taken with SKIP LOCKED and each collection's full match under its own
//  advisory lock.
// ============================================================================
import { query, one, tx } from '../db';
import { ORIGIN_SQL, ORIGINS, MEDIA_TYPE_SQL, MEDIA_TYPES } from './vodLibrary';

export type FieldType = 'text' | 'number' | 'date' | 'list' | 'ref' | 'tags' | 'boolean';
export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  /** Trusted SQL over `v` (vod_assets), `c`/`e` (channel, event), `rp` (rights profile), `ms` (content type). */
  sql: string;
  group: 'Asset' | 'Source' | 'Rights' | 'Dates' | 'Content type fields';
  /** list: the allowed values with labels. ref: what the ids name (the console fetches the choices). */
  values?: { value: string; label: string }[];
  ref?: 'content_type' | 'rights_profile' | 'channel' | 'event';
  /** A unit the console shows beside a number. */
  unit?: string;
}

export const OPS: Record<FieldType, { op: string; label: string; arity: 0 | 1 | 2 | 'list' | 'within' }[]> = {
  text: [
    { op: 'is', label: 'is', arity: 1 }, { op: 'is_not', label: 'is not', arity: 1 },
    { op: 'contains', label: 'contains', arity: 1 }, { op: 'not_contains', label: 'does not contain', arity: 1 },
    { op: 'starts_with', label: 'starts with', arity: 1 },
    { op: 'is_empty', label: 'is empty', arity: 0 }, { op: 'is_not_empty', label: 'is not empty', arity: 0 },
  ],
  number: [
    { op: 'eq', label: '=', arity: 1 }, { op: 'ne', label: '≠', arity: 1 },
    { op: 'lt', label: '<', arity: 1 }, { op: 'lte', label: '≤', arity: 1 },
    { op: 'gt', label: '>', arity: 1 }, { op: 'gte', label: '≥', arity: 1 },
    { op: 'between', label: 'between', arity: 2 },
    { op: 'is_empty', label: 'is empty', arity: 0 }, { op: 'is_not_empty', label: 'is not empty', arity: 0 },
  ],
  date: [
    { op: 'before', label: 'before', arity: 1 }, { op: 'after', label: 'after', arity: 1 },
    { op: 'between', label: 'between', arity: 2 },
    { op: 'within_last', label: 'within the last', arity: 'within' }, { op: 'not_within_last', label: 'not within the last', arity: 'within' },
    { op: 'is_empty', label: 'is empty', arity: 0 }, { op: 'is_not_empty', label: 'is not empty', arity: 0 },
  ],
  list: [
    { op: 'in', label: 'is any of', arity: 'list' }, { op: 'not_in', label: 'is none of', arity: 'list' },
    { op: 'is_empty', label: 'is empty', arity: 0 }, { op: 'is_not_empty', label: 'is not empty', arity: 0 },
  ],
  ref: [
    { op: 'in', label: 'is any of', arity: 'list' }, { op: 'not_in', label: 'is none of', arity: 'list' },
    { op: 'is_empty', label: 'is not set', arity: 0 }, { op: 'is_not_empty', label: 'is set', arity: 0 },
  ],
  tags: [
    { op: 'has_any', label: 'has any of', arity: 'list' }, { op: 'has_all', label: 'has all of', arity: 'list' },
    { op: 'has_none', label: 'has none of', arity: 'list' },
    { op: 'is_empty', label: 'is empty', arity: 0 }, { op: 'is_not_empty', label: 'is not empty', arity: 0 },
  ],
  boolean: [{ op: 'is_true', label: 'is yes', arity: 0 }, { op: 'is_false', label: 'is no', arity: 0 }],
};

const label = (s: string) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
export const FIELDS: FieldDef[] = [
  { key: 'title', label: 'Title', type: 'text', sql: 'v.title', group: 'Asset' },
  { key: 'description', label: 'Description', type: 'text', sql: "(v.metadata->>'description')", group: 'Asset' },
  { key: 'original_filename', label: 'File name', type: 'text', sql: 'v.original_filename', group: 'Asset' },
  { key: 'tags', label: 'Tags', type: 'tags', sql: "(CASE WHEN jsonb_typeof(v.metadata->'tags') = 'array' THEN v.metadata->'tags' ELSE '[]'::jsonb END)", group: 'Asset' },
  { key: 'genre', label: 'Genre', type: 'text', sql: "(v.metadata->>'genre')", group: 'Asset' },
  { key: 'duration_min', label: 'Length', type: 'number', sql: '(v.duration_ms / 60000.0)', group: 'Asset', unit: 'minutes' },
  { key: 'content_type', label: 'Content type', type: 'ref', ref: 'content_type', sql: 'v.schema_id', group: 'Asset' },
  { key: 'media_type', label: 'Media type', type: 'list', sql: MEDIA_TYPE_SQL, group: 'Asset', values: MEDIA_TYPES.map((v) => ({ value: v, label: label(v) })) },
  { key: 'availability_state', label: 'Availability', type: 'list', sql: "COALESCE(v.availability_state, 'draft')", group: 'Asset',
    values: ['draft', 'scheduled', 'available', 'expired', 'withdrawn'].map((v) => ({ value: v, label: label(v) })) },
  { key: 'review_state', label: 'Review', type: 'list', sql: "COALESCE(v.review_state::text, 'draft')", group: 'Asset',
    values: ['draft', 'in_review', 'changes_requested', 'approved', 'rejected'].map((v) => ({ value: v, label: label(v) })) },
  { key: 'origin', label: 'How it was made', type: 'list', sql: ORIGIN_SQL, group: 'Source', values: ORIGINS.map((v) => ({ value: v, label: label(v) })) },
  { key: 'channel', label: 'Channel', type: 'ref', ref: 'channel', sql: 'v.channel_id', group: 'Source' },
  { key: 'event', label: 'Event', type: 'ref', ref: 'event', sql: 'v.event_id', group: 'Source' },
  { key: 'source_name', label: 'Channel or event name', type: 'text', sql: 'COALESCE(c.name, e.name)', group: 'Source' },
  { key: 'rights_profile', label: 'Rights profile', type: 'ref', ref: 'rights_profile', sql: 'v.rights_profile_id', group: 'Rights' },
  { key: 'provider', label: 'Provider', type: 'text', sql: 'rp.provider', group: 'Rights' },
  { key: 'created_at', label: 'Added to the library', type: 'date', sql: 'v.created_at', group: 'Dates' },
  { key: 'first_aired_at', label: 'First aired', type: 'date', sql: 'v.first_aired_at', group: 'Dates' },
  { key: 'available_from', label: 'Available from', type: 'date', sql: 'v.available_from', group: 'Dates' },
  { key: 'published', label: 'Published', type: 'boolean', sql: 'COALESCE(v.published, false)', group: 'Asset' },
];
const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

/** A content type field (`meta:<key>`) as a rule field, from the field's own type. */
export function metaField(key: string, def: { label?: string; type?: string; options?: string[]; multiple?: boolean }): FieldDef | null {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) return null;
  const k = key.replace(/'/g, "''");   // the pattern above already rules quotes out; belt and braces
  const raw = `(v.metadata->>'${k}')`;
  const base = { key: `meta:${key}`, label: def.label || label(key), group: 'Content type fields' as const };
  switch (def.type) {
    case 'number':
      return { ...base, type: 'number', sql: `(CASE WHEN ${raw} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN ${raw}::numeric END)` };
    case 'date':
      return { ...base, type: 'date', sql: `volt_try_timestamptz(${raw})` };
    case 'boolean':
      return { ...base, type: 'boolean', sql: `(${raw} = 'true')` };
    case 'tags':
      return { ...base, type: 'tags', sql: `(CASE WHEN jsonb_typeof(v.metadata->'${k}') = 'array' THEN v.metadata->'${k}' ELSE '[]'::jsonb END)` };
    case 'enum':
      if (def.multiple) return { ...base, type: 'tags', sql: `(CASE WHEN jsonb_typeof(v.metadata->'${k}') = 'array' THEN v.metadata->'${k}' ELSE '[]'::jsonb END)` };
      return { ...base, type: 'list', sql: raw, values: (def.options ?? []).map((o) => ({ value: o, label: o })) };
    case 'string': case 'text': case 'url': case undefined:
      return { ...base, type: 'text', sql: raw };
    default:
      return null;   // reference, image, content: not something a rule compares
  }
}

/** Every field a rule can use in this account: the catalogue plus its content type fields. */
export async function fieldsFor(accountId: string): Promise<FieldDef[]> {
  const rows = await query<{ fields: any }>(`SELECT fields FROM metadata_schemas WHERE account_id = $1`, [accountId]);
  const seen = new Set<string>();
  const meta: FieldDef[] = [];
  for (const r of rows) {
    for (const f of Array.isArray(r.fields) ? r.fields : []) {
      if (!f?.key || seen.has(f.key) || BY_KEY.has(f.key)) continue;
      const d = metaField(String(f.key), f);
      if (d) { seen.add(f.key); meta.push(d); }
    }
  }
  return [...FIELDS, ...meta.sort((a, b) => a.label.localeCompare(b.label))];
}

// ---------------------------------------------------------------------------
//  The rule tree, validated
// ---------------------------------------------------------------------------
export interface Condition { field: string; op: string; value?: any }
export interface Group { match: 'all' | 'any'; conditions: (Condition | Group)[] }
export const MAX_DEPTH = 3;
export const MAX_CONDITIONS = 50;
const isGroup = (x: any): x is Group => x && typeof x === 'object' && Array.isArray(x.conditions);
export class RuleError extends Error { constructor(msg: string, public path: string) { super(msg); } }

/**
 * Check a rule tree against the account's fields and return a clean copy
 * (values coerced to their types). Throws RuleError naming where it went wrong.
 */
export function validateRules(tree: unknown, fields: FieldDef[]): Group {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  let count = 0;
  const walk = (g: any, depth: number, path: string): Group => {
    if (!isGroup(g)) throw new RuleError('A rule group needs a list of conditions.', path);
    if (g.match !== 'all' && g.match !== 'any') throw new RuleError('A group matches all or any of its conditions.', path);
    if (depth > MAX_DEPTH) throw new RuleError(`Groups nest at most ${MAX_DEPTH} levels deep.`, path);
    if (!g.conditions.length) throw new RuleError('A group needs at least one condition.', path);
    return {
      match: g.match,
      conditions: g.conditions.map((c: any, i: number) => {
        const p = `${path}.conditions[${i}]`;
        if (isGroup(c)) return walk(c, depth + 1, p);
        if (++count > MAX_CONDITIONS) throw new RuleError(`At most ${MAX_CONDITIONS} conditions.`, p);
        const f = byKey.get(String(c?.field ?? ''));
        if (!f) throw new RuleError(`"${c?.field}" is not a field rules can use.`, p);
        const op = OPS[f.type].find((o) => o.op === c.op);
        if (!op) throw new RuleError(`"${c.op}" does not apply to ${f.label} (${f.type}).`, p);
        return { field: f.key, op: op.op, ...(op.arity === 0 ? {} : { value: coerce(f, op.arity, c.value, p) }) };
      }),
    };
  };
  return walk(tree, 1, 'rules');
}

function coerce(f: FieldDef, arity: 1 | 2 | 'list' | 'within', v: any, p: string): any {
  const one = (x: any): any => {
    if (f.type === 'number') {
      const n = typeof x === 'number' ? x : Number(String(x ?? '').trim());
      if (!Number.isFinite(n) || String(x ?? '').trim() === '') throw new RuleError(`${f.label} needs a number.`, p);
      return n;
    }
    if (f.type === 'date') {
      const d = new Date(String(x ?? ''));
      if (!x || Number.isNaN(d.getTime())) throw new RuleError(`${f.label} needs a date.`, p);
      return d.toISOString();
    }
    const s = String(x ?? '').trim();
    if (!s) throw new RuleError(`${f.label} needs a value.`, p);
    if (s.length > 500) throw new RuleError(`${f.label}: the value is too long.`, p);
    return s;
  };
  if (arity === 1) return one(v);
  if (arity === 2) {
    if (!Array.isArray(v) || v.length !== 2) throw new RuleError(`${f.label} between needs two values.`, p);
    const [a, b] = [one(v[0]), one(v[1])];
    return (f.type === 'number' ? a > b : new Date(a) > new Date(b)) ? [b, a] : [a, b];
  }
  if (arity === 'within') {
    const n = Number(v?.count), unit = v?.unit;
    if (!Number.isInteger(n) || n < 1 || n > 3650) throw new RuleError(`${f.label}: a whole number of days, weeks or months.`, p);
    if (!['day', 'week', 'month'].includes(unit)) throw new RuleError(`${f.label}: days, weeks or months.`, p);
    return { count: n, unit };
  }
  const list = Array.isArray(v) ? v : [];
  if (!list.length) throw new RuleError(`${f.label} needs at least one value.`, p);
  if (list.length > 200) throw new RuleError(`${f.label}: at most 200 values.`, p);
  const out = [...new Set(list.map(one))];
  if (f.type === 'ref' && !out.every((x) => /^[0-9a-f-]{36}$/i.test(x))) throw new RuleError(`${f.label}: choose from the list.`, p);
  if (f.type === 'list' && f.values?.length && !out.every((x) => f.values!.some((o) => o.value === x))) throw new RuleError(`${f.label}: choose from the list.`, p);
  return out;
}

// ---------------------------------------------------------------------------
//  Compiling to SQL
// ---------------------------------------------------------------------------
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Pure: the WHERE clause for a validated tree, pushing its values into params. */
export function compileWhere(g: Group, fields: FieldDef[], params: unknown[]): string {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const $ = (v: unknown, cast = '') => { params.push(v); return `$${params.length}${cast}`; };
  const cond = (c: Condition): string => {
    const f = byKey.get(c.field)!;
    const x = f.sql, v = c.value;
    switch (f.type) {
      case 'text':
        switch (c.op) {
          case 'is': return `lower(${x}) = lower(${$(v)})`;
          case 'is_not': return `(${x} IS NULL OR lower(${x}) <> lower(${$(v)}))`;
          case 'contains': return `${x} ILIKE ${$(`%${likeEscape(v)}%`)}`;
          case 'not_contains': return `(${x} IS NULL OR ${x} NOT ILIKE ${$(`%${likeEscape(v)}%`)})`;
          case 'starts_with': return `${x} ILIKE ${$(`${likeEscape(v)}%`)}`;
          case 'is_empty': return `COALESCE(btrim(${x}), '') = ''`;
          case 'is_not_empty': return `COALESCE(btrim(${x}), '') <> ''`;
        }
        break;
      case 'number': {
        const opSql: Record<string, string> = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' };
        if (opSql[c.op]) return `${x} ${opSql[c.op]} ${$(v, '::numeric')}`;
        if (c.op === 'between') return `${x} BETWEEN ${$(v[0], '::numeric')} AND ${$(v[1], '::numeric')}`;
        if (c.op === 'is_empty') return `${x} IS NULL`;
        if (c.op === 'is_not_empty') return `${x} IS NOT NULL`;
        break;
      }
      case 'date': {
        const span = (w: any) => `${$(`${w.count} ${w.unit}s`, '::interval')}`;
        switch (c.op) {
          case 'before': return `${x} < ${$(v, '::timestamptz')}`;
          case 'after': return `${x} > ${$(v, '::timestamptz')}`;
          case 'between': return `${x} BETWEEN ${$(v[0], '::timestamptz')} AND ${$(v[1], '::timestamptz')}`;
          case 'within_last': return `${x} >= now() - ${span(v)}`;
          case 'not_within_last': return `(${x} IS NULL OR ${x} < now() - ${span(v)})`;
          case 'is_empty': return `${x} IS NULL`;
          case 'is_not_empty': return `${x} IS NOT NULL`;
        }
        break;
      }
      case 'list':
        switch (c.op) {
          case 'in': return `${x} = ANY(${$(v, '::text[]')})`;
          case 'not_in': return `(${x} IS NULL OR NOT (${x} = ANY(${$(v, '::text[]')})))`;
          case 'is_empty': return `COALESCE(${x}, '') = ''`;
          case 'is_not_empty': return `COALESCE(${x}, '') <> ''`;
        }
        break;
      case 'ref':
        switch (c.op) {
          case 'in': return `${x} = ANY(${$(v, '::uuid[]')})`;
          case 'not_in': return `(${x} IS NULL OR NOT (${x} = ANY(${$(v, '::uuid[]')})))`;
          case 'is_empty': return `${x} IS NULL`;
          case 'is_not_empty': return `${x} IS NOT NULL`;
        }
        break;
      case 'tags':
        switch (c.op) {
          case 'has_any': return `${x} ?| ${$(v, '::text[]')}`;
          case 'has_all': return `${x} ?& ${$(v, '::text[]')}`;
          case 'has_none': return `NOT (${x} ?| ${$(v, '::text[]')})`;
          case 'is_empty': return `jsonb_array_length(${x}) = 0`;
          case 'is_not_empty': return `jsonb_array_length(${x}) > 0`;
        }
        break;
      case 'boolean':
        return c.op === 'is_true' ? `${x} IS TRUE` : `${x} IS NOT TRUE`;
    }
    throw new RuleError(`Cannot compile ${c.field} ${c.op}.`, 'rules');
  };
  const group = (g2: Group): string => {
    const parts = g2.conditions.map((c) => (isGroup(c) ? group(c) : cond(c as Condition)));
    return `(${parts.join(g2.match === 'all' ? ' AND ' : ' OR ')})`;
  };
  return group(g);
}

/**
 * THE MATCHING QUERY: the ids of the account's assets that meet the rules.
 * One query over the account's library (its own index on account_id, and the
 * library's indexes on schema, duration, created_at and the rest).
 */
export function matchQuery(accountId: string, g: Group, fields: FieldDef[], onlyIds?: string[]): { sql: string; params: unknown[] } {
  const params: unknown[] = [accountId];
  const where = compileWhere(g, fields, params);
  let extra = '';
  if (onlyIds) { params.push(onlyIds); extra = ` AND v.id = ANY($${params.length}::uuid[])`; }
  return {
    sql: `SELECT v.id FROM vod_assets v
            LEFT JOIN channels c ON c.id = v.channel_id
            LEFT JOIN events e ON e.id = v.event_id
            LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
            LEFT JOIN rights_profiles rp ON rp.id = v.rights_profile_id
            LEFT JOIN metadata_schemas ms ON ms.id = v.schema_id
           WHERE COALESCE(g.account_id, v.account_id) = $1
             AND COALESCE(v.metadata->>'fastFiller', '') <> 'true'${extra}
             AND ${where}`,
    params,
  };
}

// ---------------------------------------------------------------------------
//  Matching
// ---------------------------------------------------------------------------
export interface MatchResult { added: number; removed: number; members: number; ms: number }

/** Match one rule collection in full: add what the rules now match, drop rule rows they no longer do. */
export async function recompute(collectionId: string, fieldsCache?: FieldDef[]): Promise<MatchResult | null> {
  const t0 = Date.now();
  const col = await one<any>(`SELECT id, account_id, rules FROM collections WHERE id = $1`, [collectionId]);
  if (!col) return null;
  if (!col.rules) {
    // Rules taken off: what they had put in goes; what people added stays.
    const r = await query(`DELETE FROM collection_items WHERE collection_id = $1 AND source = 'rule' RETURNING vod_asset_id`, [collectionId]);
    await query(`UPDATE collections SET rules_checked_at = now(), rules_check_ms = $2 WHERE id = $1`, [collectionId, Date.now() - t0]);
    return { added: 0, removed: r.length, members: 0, ms: Date.now() - t0 };
  }
  const fields = fieldsCache ?? await fieldsFor(col.account_id);
  let tree: Group;
  try { tree = validateRules(col.rules, fields); }
  catch (e) {
    // A field the rules used has gone (a content type field removed): keep
    // the members as they are and say so, rather than emptying the collection.
    console.warn(`[collections] rules of ${collectionId} no longer valid: ${(e as Error).message}`);
    await query(`UPDATE collections SET rules_checked_at = now() WHERE id = $1`, [collectionId]);
    return null;
  }
  const m = matchQuery(col.account_id, tree, fields);
  const out = await tx(async (cl) => {
    // One full match at a time per collection, across every control plane task.
    await cl.query(`SELECT pg_advisory_xact_lock(hashtext('collection-rules'), hashtext($1))`, [collectionId]);
    const n = m.params.length;
    const removed = await cl.query(
      `DELETE FROM collection_items i WHERE i.collection_id = $${n + 1} AND i.source = 'rule'
         AND NOT EXISTS (SELECT 1 FROM (${m.sql}) mm WHERE mm.id = i.vod_asset_id)`, [...m.params, collectionId]);
    const added = await cl.query(
      `INSERT INTO collection_items (collection_id, vod_asset_id, position, source)
       SELECT $${n + 1}, mm.id, (SELECT COALESCE(max(position) + 1, 0) FROM collection_items WHERE collection_id = $${n + 1}) + row_number() OVER () - 1, 'rule'
         FROM (${m.sql}) mm
        WHERE NOT EXISTS (SELECT 1 FROM collection_exclusions x WHERE x.collection_id = $${n + 1} AND x.vod_asset_id = mm.id)
       ON CONFLICT (collection_id, vod_asset_id) DO NOTHING`, [...m.params, collectionId]);
    const members = await cl.query(`SELECT count(*)::int AS n FROM collection_items WHERE collection_id = $1 AND source = 'rule'`, [collectionId]);
    await cl.query(`UPDATE collections SET rules_checked_at = now(), rules_check_ms = $2 WHERE id = $1`, [collectionId, Date.now() - t0]);
    return { added: added.rowCount ?? 0, removed: removed.rowCount ?? 0, members: Number(members.rows[0].n) };
  });
  return { ...out, ms: Date.now() - t0 };
}

/** Match some assets against every rule collection of their accounts. */
export async function matchAssets(assetIds: string[]): Promise<{ added: number; removed: number }> {
  if (!assetIds.length) return { added: 0, removed: 0 };
  const owners = await query<{ id: string; account_id: string }>(
    `SELECT v.id, COALESCE(g.account_id, v.account_id) AS account_id FROM vod_assets v
       LEFT JOIN channels c ON c.id = v.channel_id LEFT JOIN events e ON e.id = v.event_id
       LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
      WHERE v.id = ANY($1::uuid[])`, [assetIds]);
  const byAccount = new Map<string, string[]>();
  for (const o of owners) if (o.account_id) (byAccount.get(o.account_id) ?? byAccount.set(o.account_id, []).get(o.account_id)!).push(o.id);
  let added = 0, removed = 0;
  for (const [acct, ids] of byAccount) {
    const cols = await query<any>(`SELECT id, rules FROM collections WHERE account_id = $1 AND rules IS NOT NULL`, [acct]);
    if (!cols.length) continue;
    const fields = await fieldsFor(acct);
    for (const col of cols) {
      let tree: Group;
      try { tree = validateRules(col.rules, fields); } catch { continue; }
      const m = matchQuery(acct, tree, fields, ids);
      const n = m.params.length;
      const r = await tx(async (cl) => {
        const del = await cl.query(
          `DELETE FROM collection_items i WHERE i.collection_id = $${n + 1} AND i.source = 'rule' AND i.vod_asset_id = ANY($${n + 2}::uuid[])
             AND NOT EXISTS (SELECT 1 FROM (${m.sql}) mm WHERE mm.id = i.vod_asset_id)`, [...m.params, col.id, ids]);
        const ins = await cl.query(
          `INSERT INTO collection_items (collection_id, vod_asset_id, position, source)
           SELECT $${n + 1}, mm.id, (SELECT COALESCE(max(position) + 1, 0) FROM collection_items WHERE collection_id = $${n + 1}) + row_number() OVER () - 1, 'rule'
             FROM (${m.sql}) mm
            WHERE NOT EXISTS (SELECT 1 FROM collection_exclusions x WHERE x.collection_id = $${n + 1} AND x.vod_asset_id = mm.id)
           ON CONFLICT (collection_id, vod_asset_id) DO NOTHING`, [...m.params, col.id]);
        return { a: ins.rowCount ?? 0, d: del.rowCount ?? 0 };
      });
      added += r.a; removed += r.d;
    }
  }
  return { added, removed };
}

/**
 * THE QUEUE PASS: take a batch of changed assets (each task its own batch:
 * SKIP LOCKED) and re-match them. Returns how many were taken.
 */
export async function drainRechecks(batch = 500): Promise<number> {
  const taken = await query<{ vod_asset_id: string }>(
    `DELETE FROM collection_rechecks WHERE vod_asset_id IN (
       SELECT vod_asset_id FROM collection_rechecks ORDER BY queued_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING vod_asset_id`, [batch]);
  if (!taken.length) return 0;
  await matchAssets(taken.map((t) => t.vod_asset_id));
  return taken.length;
}

/**
 * THE FULL RE-CHECK: rule collections not matched in full for a day (the
 * nightly pass), or marked stale (rules_checked_at NULL), a bounded number
 * per pass so one pass never runs long.
 */
export async function recheckStale(limit = 20): Promise<{ checked: number; ms: number }> {
  const t0 = Date.now();
  const due = await query<{ id: string }>(
    `SELECT id FROM collections WHERE rules IS NOT NULL
        AND (rules_checked_at IS NULL OR rules_checked_at < now() - interval '1 day')
      ORDER BY rules_checked_at NULLS FIRST LIMIT $1`, [limit]);
  for (const c of due) {
    try { await recompute(c.id); } catch (e: any) { console.error(`[collections] re-check of ${c.id} failed:`, e?.message ?? e); }
  }
  return { checked: due.length, ms: Date.now() - t0 };
}

/** Mark rule collections that read a field for a full re-check soon (a profile's provider changed). */
export async function markStale(accountId: string, fieldKeys: string[]): Promise<number> {
  const rows = await query(
    `UPDATE collections SET rules_checked_at = NULL
      WHERE account_id = $1 AND rules IS NOT NULL
        AND EXISTS (SELECT 1 FROM jsonb_path_query(rules, '$.**.field') f WHERE f #>> '{}' = ANY($2::text[]))
      RETURNING id`, [accountId, fieldKeys]);
  return rows.length;
}

/** How many assets a rule tree matches now, with a sample, for the builder's live count. */
export async function preview(accountId: string, tree: Group, fields: FieldDef[], sample = 12): Promise<{ count: number; sample: { id: string; title: string }[]; ms: number }> {
  const t0 = Date.now();
  const m = matchQuery(accountId, tree, fields);
  const count = await one<{ n: number }>(`SELECT count(*)::int AS n FROM (${m.sql}) mm`, m.params);
  const rows = await query<{ id: string; title: string }>(
    `SELECT v.id, v.title FROM vod_assets v WHERE v.id IN (${m.sql}) ORDER BY v.created_at DESC LIMIT ${Math.max(1, Math.min(sample, 50))}`, m.params);
  return { count: count?.n ?? 0, sample: rows, ms: Date.now() - t0 };
}

/** The orders a collection can have: by hand, or by a field. */
export const ORDERS: Record<string, { label: string; sql: string }> = {
  manual: { label: 'By hand', sql: 'i.position' },
  title: { label: 'Title, A to Z', sql: 'lower(v.title) ASC NULLS LAST' },
  '-title': { label: 'Title, Z to A', sql: 'lower(v.title) DESC NULLS LAST' },
  '-created_at': { label: 'Newest in the library first', sql: 'v.created_at DESC' },
  created_at: { label: 'Oldest in the library first', sql: 'v.created_at ASC' },
  '-first_aired_at': { label: 'Most recently aired first', sql: 'v.first_aired_at DESC NULLS LAST' },
  first_aired_at: { label: 'First aired, oldest first', sql: 'v.first_aired_at ASC NULLS LAST' },
  '-available_from': { label: 'Most recently available first', sql: 'v.available_from DESC NULLS LAST' },
  duration: { label: 'Shortest first', sql: 'v.duration_ms ASC NULLS LAST' },
  '-duration': { label: 'Longest first', sql: 'v.duration_ms DESC NULLS LAST' },
};
