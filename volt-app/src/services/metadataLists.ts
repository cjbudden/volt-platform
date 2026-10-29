// ============================================================================
//  METADATA LISTS: an account's own pick lists, starting with GENRES.
//
//  A client keeps one genre list (Admin > Genres). Every enum field of a
//  content type that carries `optionsList: 'genres'` takes its options from
//  it: the standard Radio station, TV channel, Broadcast event (and the event
//  types extending it), Song, Programme / episode and Movie types are linked
//  out of the box, and the Content Types editor can link any enum field.
//
//  HOW IT STAYS CONSISTENT. The list is copied INTO the linked fields
//  (options, and retiredOptions) whenever it or a type changes, so every
//  reader of metadata_schemas.fields (forms, validation, the EPG fill, the
//  library's completeness report, XMLTV) sees the account's list without
//  knowing lists exist. The list row is the source; the copies are derived
//  and rewritten on every save.
//
//  CHANGING A LIST WITHOUT BREAKING WHAT IS ALREADY TAGGED:
//   - add, reorder: free.
//   - retire: the value stays valid on everything that already carries it
//     and is no longer offered for new metadata. Restore brings it back.
//   - rename (or merge into another value): rewrites the value on every
//     channel, station, event and asset whose type links the list, in the
//     same transaction as the list save.
//   - remove: only a value nothing carries. A value in use is refused with
//     its count, so the client retires, renames or merges it instead.
//  EPG programmes already in the guide keep the categories they were given:
//  the guide is a record of what was announced.
// ============================================================================
import type { PoolClient } from 'pg';
import { query, tx } from '../db';
import { ApiError } from '../util/http';
import { mergeFields, type SchemaField } from './metadataValidator';

export const LIST_KEYS = ['genres'] as const;
export type ListKey = typeof LIST_KEYS[number];
export const isListKey = (k: string): k is ListKey => (LIST_KEYS as readonly string[]).includes(k);

export interface ListItem { value: string; retired?: boolean }

/** The platform default genres: what a new account starts with and what Reset restores. */
export const DEFAULT_GENRES = ['News', 'Talk', 'Sport', 'Music', 'Classical', 'Jazz', 'Rock', 'Pop', 'Dance', 'Community', 'Religious', 'Education', 'Entertainment', 'Drama', 'Documentary', 'Children', 'Other'];

export const STANDARD_LISTS: Record<ListKey, { name: string; description: string; defaults: string[] }> = {
  genres: {
    name: 'Genres',
    description: 'The genres your stations, channels, events and on-demand assets can be tagged with. They fill the guide category and schema.org genre.',
    defaults: DEFAULT_GENRES,
  },
};

export const MAX_ITEMS = 500;
export const MAX_VALUE_LEN = 80;

// ---- pure ------------------------------------------------------------------

const fold = (s: string) => s.trim().toLocaleLowerCase();

/** Clean and check a list as a client sent it. Throws 422 with a sentence a person can act on. */
export function normaliseItems(raw: unknown): ListItem[] {
  if (!Array.isArray(raw)) throw new ApiError(422, 'items must be a list');
  if (raw.length > MAX_ITEMS) throw new ApiError(422, `A list holds at most ${MAX_ITEMS} values.`);
  const seen = new Map<string, string>();
  const out: ListItem[] = [];
  for (const r of raw) {
    const value = String(typeof r === 'string' ? r : (r as any)?.value ?? '').replace(/\s+/g, ' ').trim();
    if (!value) throw new ApiError(422, 'A value cannot be empty.');
    if (value.length > MAX_VALUE_LEN) throw new ApiError(422, `"${value.slice(0, 30)}…" is longer than ${MAX_VALUE_LEN} characters.`);
    const prior = seen.get(fold(value));
    if (prior) throw new ApiError(422, `"${value}" is in the list twice${prior !== value ? ` (as "${prior}")` : ''}.`);
    seen.set(fold(value), value);
    out.push(typeof r === 'object' && (r as any)?.retired ? { value, retired: true } : { value });
  }
  if (!out.some((i) => !i.retired)) throw new ApiError(422, 'Keep at least one value that is not retired.');
  return out;
}

export const activeValues = (items: ListItem[]) => items.filter((i) => !i.retired).map((i) => i.value);
export const retiredValues = (items: ListItem[]) => items.filter((i) => i.retired).map((i) => i.value);
export const defaultItems = (key: ListKey): ListItem[] => STANDARD_LISTS[key].defaults.map((value) => ({ value }));

/** Copy the lists into the fields that link them. Fields without a link, or linking a list not given, are returned as they are. */
export function linkFields(fields: SchemaField[], lists: Partial<Record<string, ListItem[]>>): SchemaField[] {
  return fields.map((f) => {
    if (!f.optionsList) return f;
    const items = lists[f.optionsList];
    if (!items) return f;
    const { retiredOptions: _drop, ...rest } = f;
    const retired = retiredValues(items);
    return { ...rest, type: 'enum', options: activeValues(items), ...(retired.length ? { retiredOptions: retired } : {}) };
  });
}

export interface Rename { from: string; to: string }

/**
 * What a save would do. `renames` move a value to another (a new name, or an
 * existing value to merge into). Returns the values that leave the list
 * without being renamed (removed), and those of them still carried by
 * something (blocked, with counts).
 */
export function planSave(before: ListItem[], after: ListItem[], renames: Rename[], usage: Record<string, number>):
  { removed: string[]; blocked: { value: string; count: number }[]; renames: Rename[] } {
  const afterSet = new Set(after.map((i) => i.value));
  const clean: Rename[] = [];
  for (const r of renames) {
    const from = String(r.from ?? '').trim(), to = String(r.to ?? '').trim();
    if (!from || !to || from === to) continue;
    if (!afterSet.has(to)) throw new ApiError(422, `"${from}" is renamed to "${to}", which is not in the list.`);
    clean.push({ from, to });
  }
  const renamed = new Set(clean.map((r) => r.from));
  const removed = before.map((i) => i.value).filter((v) => !afterSet.has(v) && !renamed.has(v));
  const blocked = removed.map((value) => ({ value, count: usage[value] ?? 0 })).filter((b) => b.count > 0);
  return { removed, blocked, renames: clean };
}

/** A stored metadata value with one list value renamed: strings and arrays, duplicates folded, order kept. */
export function renameIn(v: unknown, from: string, to: string): unknown {
  if (typeof v === 'string') return v === from ? to : v;
  if (!Array.isArray(v)) return v;
  const out: unknown[] = [];
  for (const x of v) { const y = x === from ? to : x; if (!out.includes(y)) out.push(y); }
  return out;
}

/**
 * Which field keys link the list, per type, using each type's EFFECTIVE fields
 * (a type extending Broadcast event inherits its linked Category unless it
 * overrides the key). Returns fieldKey -> schema ids.
 */
export function linkedKeys(schemas: { id: string; extends_id: string | null; fields: SchemaField[] }[], key: string): Map<string, string[]> {
  const byId = new Map(schemas.map((s) => [s.id, s]));
  const effective = (id: string) => {
    const chain: typeof schemas = []; const seen = new Set<string>();
    let cur = byId.get(id);
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); chain.push(cur); cur = cur.extends_id ? byId.get(cur.extends_id) : undefined; }
    let fields: SchemaField[] = [];
    for (const s of chain.reverse()) fields = mergeFields(fields, Array.isArray(s.fields) ? s.fields : []);
    return fields;
  };
  const out = new Map<string, string[]>();
  for (const s of schemas) for (const f of effective(s.id)) {
    if (f.optionsList !== key) continue;
    out.set(f.key, [...(out.get(f.key) ?? []), s.id]);
  }
  return out;
}

// ---- database ----------------------------------------------------------------

type Q = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };
const run = async (c: Q | null, text: string, params: any[]) => c ? (await c.query(text, params)).rows : await query(text, params);

export interface StoredList { id: string | null; key: ListKey; items: ListItem[]; isDefault: boolean; version: number; updatedAt: string | null }

export async function getList(account: string, key: ListKey, c: Q | null = null): Promise<StoredList> {
  const row = (await run(c, `SELECT id, items, version, updated_at FROM metadata_lists WHERE account_id = $1 AND list_key = $2`, [account, key]))[0];
  if (!row) return { id: null, key, items: defaultItems(key), isDefault: true, version: 0, updatedAt: null };
  return { id: row.id, key, items: Array.isArray(row.items) ? row.items : defaultItems(key), isDefault: false, version: row.version, updatedAt: row.updated_at };
}

/** Fill the linked fields of a type from the account's lists (for a type being created or saved). */
export async function applyAccountLists(account: string, fields: SchemaField[]): Promise<SchemaField[]> {
  const keys = [...new Set(fields.map((f) => f.optionsList).filter((k): k is string => !!k))];
  const lists: Record<string, ListItem[]> = {};
  for (const k of keys) {
    if (!isListKey(k)) throw new ApiError(422, `There is no list "${k}". Lists: ${LIST_KEYS.join(', ')}.`);
    lists[k] = (await getList(account, k)).items;
  }
  return linkFields(fields, lists);
}

async function accountSchemas(account: string, c: Q | null) {
  return run(c, `SELECT id, extends_id, fields FROM metadata_schemas WHERE account_id = $1`, [account]) as Promise<{ id: string; extends_id: string | null; fields: SchemaField[] }[]>;
}

const OWNERS = [
  { table: 'vod_assets', from: `vod_assets t`, where: `t.account_id = $1` },
  { table: 'channels', from: `channels t JOIN groups g ON g.id = t.group_id`, where: `g.account_id = $1` },
  { table: 'events', from: `events t JOIN groups g ON g.id = t.group_id`, where: `g.account_id = $1` },
];
const VALUES_OF = `CASE jsonb_typeof(t.metadata -> $3) WHEN 'array' THEN t.metadata -> $3 WHEN 'string' THEN jsonb_build_array(t.metadata -> $3) ELSE '[]'::jsonb END`;

/** How many channels, stations, events and assets carry each value, through any type that links the list. */
export async function listUsage(account: string, key: ListKey, c: Q | null = null): Promise<Record<string, number>> {
  const linked = linkedKeys(await accountSchemas(account, c), key);
  const out: Record<string, number> = {};
  for (const [fieldKey, ids] of linked) for (const o of OWNERS) {
    const rows = await run(c,
      `SELECT v AS value, count(DISTINCT t.id)::int AS n FROM ${o.from}
         CROSS JOIN LATERAL jsonb_array_elements_text(${VALUES_OF}) AS v
        WHERE ${o.where} AND t.schema_id = ANY($2::uuid[]) GROUP BY v`, [account, ids, fieldKey]);
    for (const r of rows) out[r.value] = (out[r.value] ?? 0) + Number(r.n);
  }
  return out;
}

/** The types and fields that take their options from the list. */
export async function listLinks(account: string, key: ListKey): Promise<{ schemaId: string; schemaName: string; fieldKey: string; label: string }[]> {
  const rows = await query<any>(`SELECT id, name, fields FROM metadata_schemas WHERE account_id = $1 ORDER BY is_standard DESC, name`, [account]);
  return rows.flatMap((s) => (Array.isArray(s.fields) ? s.fields as SchemaField[] : [])
    .filter((f) => f.optionsList === key).map((f) => ({ schemaId: s.id, schemaName: s.name, fieldKey: f.key, label: f.label || f.key })));
}

/** Rewrite the linked fields of every type of the account from the list. Returns how many types changed. */
export async function syncSchemas(account: string, key: ListKey, items: ListItem[], c: Q | null = null): Promise<number> {
  let n = 0;
  for (const s of await accountSchemas(account, c)) {
    const fields = Array.isArray(s.fields) ? s.fields : [];
    if (!fields.some((f) => f.optionsList === key)) continue;
    const next = linkFields(fields, { [key]: items });
    if (JSON.stringify(next) === JSON.stringify(fields)) continue;
    await run(c, `UPDATE metadata_schemas SET fields = $2::jsonb, updated_at = now() WHERE id = $1`, [s.id, JSON.stringify(next)]);
    n++;
  }
  return n;
}

async function applyRenames(account: string, key: ListKey, renames: Rename[], c: Q): Promise<number> {
  if (!renames.length) return 0;
  const linked = linkedKeys(await accountSchemas(account, c), key);
  let changed = 0;
  for (const [fieldKey, ids] of linked) for (const o of OWNERS) {
    const froms = renames.map((r) => r.from);
    const rows = await run(c,
      `SELECT t.id, t.metadata FROM ${o.from}
        WHERE ${o.where} AND t.schema_id = ANY($2::uuid[])
          AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(${VALUES_OF}) v WHERE v = ANY($4::text[]))`,
      [account, ids, fieldKey, froms]);
    for (const r of rows) {
      let v = r.metadata[fieldKey];
      for (const rn of renames) v = renameIn(v, rn.from, rn.to);
      await run(c, `UPDATE ${o.table} SET metadata = jsonb_set(metadata, ARRAY[$2::text], $3::jsonb), updated_at = now() WHERE id = $1`,
        [r.id, fieldKey, JSON.stringify(v)]);
      changed++;
    }
  }
  return changed;
}

export interface SaveResult { list: StoredList; renamed: number; typesUpdated: number; removed: string[] }

/**
 * Save the whole list (order matters), renaming as asked, in one transaction.
 * `expectedVersion` (optional) refuses a save made from a stale copy.
 */
export async function saveList(account: string, key: ListKey, rawItems: unknown, renames: Rename[], userId: string | null, expectedVersion?: number | null): Promise<SaveResult> {
  const items = normaliseItems(rawItems);
  return tx(async (c: PoolClient) => {
    const before = await getList(account, key, c);
    if (expectedVersion != null && expectedVersion !== before.version)
      throw new ApiError(409, 'Someone else changed this list since you opened it. Reload to see their changes.');
    const usage = await listUsage(account, key, c);
    const plan = planSave(before.items, items, renames, usage);
    if (plan.blocked.length)
      throw new ApiError(409, `${plan.blocked.map((b) => `"${b.value}" is used by ${b.count} item${b.count === 1 ? '' : 's'}`).join('; ')}. Retire it, or rename or merge it into another value, instead of removing it.`);
    const renamed = await applyRenames(account, key, plan.renames, c);
    const row = (await c.query(
      `INSERT INTO metadata_lists(account_id, list_key, items, updated_by) VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (account_id, list_key) DO UPDATE SET items = EXCLUDED.items, updated_by = EXCLUDED.updated_by,
         version = metadata_lists.version + 1, updated_at = now()
       RETURNING id, items, version, updated_at`, [account, key, JSON.stringify(items), userId])).rows[0];
    const typesUpdated = await syncSchemas(account, key, items, c);
    return { list: { id: row.id, key, items: row.items, isDefault: false, version: row.version, updatedAt: row.updated_at }, renamed, typesUpdated, removed: plan.removed };
  });
}

/** The platform defaults back, keeping (retired) any value of the account's that something still carries. */
export function resetItems(key: ListKey, current: ListItem[], usage: Record<string, number>): ListItem[] {
  const base = defaultItems(key);
  const have = new Set(base.map((i) => fold(i.value)));
  const keep = current.filter((i) => !have.has(fold(i.value)) && (usage[i.value] ?? 0) > 0).map((i) => ({ value: i.value, retired: true }));
  return [...base, ...keep];
}

