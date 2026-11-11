// ============================================================================
//  GLOBAL LISTS: platform-owned reference lists every account reads.
//  (docs/GLOBAL_LISTS.md; migration 0143; routes in modules/globalLists.ts)
//
//  A global list is reference data that is the same for every client and is
//  looked after by SaaS staff, not by each account: countries, timezones, and
//  later languages, currencies, regions. It differs from the account's own
//  pick lists (services/metadataLists.ts, Admin > Genres), which are a flat
//  list of words each client edits for itself.
//
//  THE SHAPE. A list declares its FIELDS; every item is a stable CODE plus a
//  VALUE object holding those fields, a position, a default flag and an
//  active flag:
//
//    list   countries  fields name, officialName, alpha2, alpha3, numeric, phoneCode
//    item   { code: "AU", value: { name: "Australia", officialName: "Commonwealth
//             of Australia", alpha2: "AU", alpha3: "AUS", numeric: "036",
//             phoneCode: "+61" }, position: 13, isDefault: false, active: true }
//
//  THE RULES that keep references safe (other records store the CODE):
//    * A code never changes underneath a record. Where the list has a code
//      field (countries: alpha2) the code follows that field, so it is set on
//      purpose or not at all; otherwise it is fixed when the item is made.
//    * Built-in (system) lists never hard-delete an item. It is retired:
//      still resolvable by code, no longer offered for new choices.
//    * A change to a list's fields is accepted only when every existing item
//      still passes the new definition, so the definition never lies.
//    * Every change bumps the list's version, which is the read API's ETag,
//      so CDN and browser caches turn over the moment a list changes.
//  Locale labels: any value key shaped like en_US / fr_FR that the list does
//  not declare is accepted as an optional translation of the label field.
// ============================================================================
import type { PoolClient } from 'pg';
import { one, query, tx } from '../db';
import { ApiError } from '../util/http';
import type { FieldSpec, ListSpec } from '../util/listQuery';

export type FieldType = 'string' | 'number' | 'boolean' | 'string[]';
export type Visibility = 'public' | 'tenant' | 'platform';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  /** No two items may share the value (case-insensitive). */
  unique?: boolean;
  /** A regular expression the whole value must match (strings, and each entry of string[]). */
  pattern?: string;
  maxLength?: number;
  /** Force letter case on save (country codes are upper case). */
  case?: 'upper' | 'lower';
  /** Sort and filter a string as a number (timezone offset "-6", "5.75"). */
  sortAs?: 'number';
  description?: string;
}

export interface ListDef {
  key: string;
  name: string;
  description: string | null;
  visibility: Visibility;
  /** Field the item code follows (countries: alpha2). Null: the code is set once, at creation. */
  codeField: string | null;
  /** Field shown as the item's label; translations live in locale keys (fr_FR...). */
  labelField: string;
  fields: FieldDef[];
}

export interface SeedItem { code: string; value: Record<string, unknown>; position?: number; isDefault?: boolean; active?: boolean }

export interface ListRow {
  id: string; key: string; name: string; description: string | null; visibility: Visibility; system: boolean;
  fields: FieldDef[]; code_field: string | null; label_field: string; version: number; seeded_version: number;
  archived_at: Date | null; created_at: Date; updated_at: Date;
}

export const LIST_KEY = /^[a-z][a-z0-9-]{1,40}$/;
export const FIELD_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
export const LOCALE_KEY = /^[a-z]{2}_[A-Z]{2}$/;
export const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
 * Query parameter names a field's bare key cannot also mean: the list
 * standard's own (the timezone list's `offset` field is not the paging
 * offset) and the item's top-level fields. Such a field is still filtered and
 * sorted as value.<key>; only the shorthand is skipped.
 */
const TAKEN_PARAMS = new Set(['q', 'sort', 'limit', 'cursor', 'offset', 'count', 'locale', 'id', 'code', 'position', 'isDefault', 'active', 'updatedAt']);
const TYPES: FieldType[] = ['string', 'number', 'boolean', 'string[]'];
const MAX_STRING = 500;
const MAX_ARRAY = 500;

const bad = (message: string, details?: Record<string, unknown>) => {
  const e: any = new ApiError(400, message);
  e.code = 'invalid_global_list';
  if (details) e.details = details;
  return e;
};

// ---- the shipped lists ------------------------------------------------------------------

export const BUILT_IN: (ListDef & { seed: () => Promise<{ SEED_VERSION: number; ITEMS: SeedItem[] }> })[] = [
  {
    key: 'countries', name: 'Countries',
    description: 'Countries and territories (ISO 3166-1): short and official names, 2 and 3 letter codes, numeric code and international calling code.',
    visibility: 'public', codeField: 'alpha2', labelField: 'name',
    fields: [
      { key: 'name', label: 'Name', type: 'string', required: true, maxLength: 120, description: 'Short English name, e.g. Australia' },
      { key: 'officialName', label: 'Official name', type: 'string', required: true, maxLength: 200, description: 'Long form, e.g. Commonwealth of Australia' },
      { key: 'alpha2', label: 'ISO alpha-2', type: 'string', required: true, unique: true, pattern: '^[A-Z]{2}$', case: 'upper', description: 'Two letter geo code, e.g. AU' },
      { key: 'alpha3', label: 'ISO alpha-3', type: 'string', required: true, unique: true, pattern: '^[A-Z]{3}$', case: 'upper', description: 'Three letter code, e.g. AUS' },
      { key: 'numeric', label: 'ISO numeric', type: 'string', unique: true, pattern: '^[0-9]{3}$', description: 'Three digit code, e.g. 036' },
      { key: 'phoneCode', label: 'Calling code', type: 'string', pattern: '^\\+[0-9]{1,4}$', description: 'International dialling code, e.g. +61' },
    ],
    seed: () => import('../data/globalLists/countries.seed'),
  },
  {
    key: 'timezones', name: 'Timezones',
    description: 'Display timezones with their abbreviation, UTC offset, daylight saving flag and the IANA zones each one covers.',
    visibility: 'public', codeField: null, labelField: 'en_US',
    fields: [
      { key: 'en_US', label: 'Name (en_US)', type: 'string', required: true, maxLength: 120, description: 'e.g. Central America Standard Time (-6)' },
      { key: 'abbr', label: 'Abbreviation', type: 'string', required: true, maxLength: 10, description: 'e.g. CAST' },
      { key: 'offset', label: 'UTC offset (hours)', type: 'string', required: true, pattern: '^[+-]?[0-9]{1,2}(\\.[0-9]{1,2})?$', sortAs: 'number', description: 'e.g. -6, 5.75' },
      { key: 'isdst', label: 'Daylight saving', type: 'boolean', required: true },
      { key: 'text', label: 'Display text', type: 'string', required: true, maxLength: 200, description: 'e.g. (UTC-06:00) Central America' },
      { key: 'utc', label: 'IANA zones', type: 'string[]', pattern: '^[A-Za-z0-9_+\\-/]{1,64}$', description: 'e.g. America/Belize, Etc/GMT+6' },
    ],
    seed: () => import('../data/globalLists/timezones.seed'),
  },
];

// ---- definitions --------------------------------------------------------------------------

/** Check a list's fields, label field and code field; returns them normalised. */
export function checkDefinition(fields: unknown, labelField: unknown, codeField: unknown): { fields: FieldDef[]; labelField: string; codeField: string | null } {
  if (!Array.isArray(fields) || fields.length === 0) throw bad('A list needs at least one field.');
  if (fields.length > 40) throw bad('A list can have at most 40 fields.');
  const out: FieldDef[] = [];
  const seen = new Set<string>();
  for (const raw of fields as any[]) {
    const key = String(raw?.key ?? '');
    if (!FIELD_KEY.test(key)) throw bad(`Field key "${key}" must start with a letter and use letters, digits and _ (up to 40).`);
    if (seen.has(key.toLowerCase())) throw bad(`Field "${key}" appears twice.`);
    seen.add(key.toLowerCase());
    if (!TYPES.includes(raw.type)) throw bad(`Field "${key}" has type "${raw.type}"; use one of ${TYPES.join(', ')}.`);
    const f: FieldDef = { key, label: String(raw.label ?? key).trim().slice(0, 80) || key, type: raw.type };
    if (raw.required) f.required = true;
    if (raw.unique) { if (raw.type === 'string[]' || raw.type === 'boolean') throw bad(`Field "${key}": unique applies to text and numbers only.`); f.unique = true; }
    if (raw.pattern != null && raw.pattern !== '') {
      if (raw.type !== 'string' && raw.type !== 'string[]') throw bad(`Field "${key}": a pattern applies to text only.`);
      const p = String(raw.pattern);
      if (p.length > 200) throw bad(`Field "${key}": the pattern is too long (200 characters at most).`);
      try { new RegExp(p); } catch { throw bad(`Field "${key}": "${p}" is not a valid regular expression.`); }
      f.pattern = p;
    }
    if (raw.maxLength != null) {
      const n = Number(raw.maxLength);
      if (!Number.isInteger(n) || n < 1 || n > MAX_STRING) throw bad(`Field "${key}": maxLength must be 1 to ${MAX_STRING}.`);
      f.maxLength = n;
    }
    if (raw.case === 'upper' || raw.case === 'lower') f.case = raw.case;
    if (raw.sortAs === 'number') { if (raw.type !== 'string') throw bad(`Field "${key}": sortAs number applies to text fields.`); f.sortAs = 'number'; }
    if (raw.description) f.description = String(raw.description).trim().slice(0, 300);
    out.push(f);
  }
  const label = String(labelField ?? '');
  const lf = out.find((f) => f.key === label);
  if (!lf || lf.type !== 'string' || !lf.required) throw bad('The label field must be one of the list\'s required text fields.');
  let code: string | null = null;
  if (codeField != null && codeField !== '') {
    code = String(codeField);
    const cf = out.find((f) => f.key === code);
    if (!cf || cf.type !== 'string' || !cf.required || !cf.unique) throw bad('The code field must be a required, unique text field.');
  }
  return { fields: out, labelField: label, codeField: code };
}

// ---- values -------------------------------------------------------------------------------

export interface Checked { value: Record<string, unknown>; errors: string[] }

/** Validate one item's value against the list; returns the cleaned value and every problem found. */
export function checkValue(list: Pick<ListDef, 'fields'>, raw: unknown): Checked {
  const errors: string[] = [];
  const value: Record<string, unknown> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { value, errors: ['value must be an object'] };
  const src = raw as Record<string, unknown>;
  const byKey = new Map(list.fields.map((f) => [f.key, f]));
  for (const k of Object.keys(src)) {
    if (byKey.has(k)) continue;
    if (LOCALE_KEY.test(k)) {
      const v = src[k];
      if (v == null || v === '') continue;
      if (typeof v !== 'string' || v.length > MAX_STRING) errors.push(`${k}: a translation must be text of ${MAX_STRING} characters or fewer`);
      else value[k] = v.trim();
      continue;
    }
    errors.push(`${k}: not a field of this list (fields: ${list.fields.map((f) => f.key).join(', ')})`);
  }
  for (const f of list.fields) {
    let v = src[f.key];
    if (typeof v === 'string' && f.type !== 'string') v = v.trim();
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0 && f.required);
    if (empty) {
      if (f.required) errors.push(`${f.key}: required`);
      else if (Array.isArray(v)) value[f.key] = [];
      continue;
    }
    const re = f.pattern ? new RegExp(f.pattern) : null;
    const text = (s: string, where = f.key): string | null => {
      let t = s.trim();
      if (f.case === 'upper') t = t.toUpperCase(); else if (f.case === 'lower') t = t.toLowerCase();
      if (t.length > (f.maxLength ?? MAX_STRING)) { errors.push(`${where}: ${f.maxLength ?? MAX_STRING} characters at most`); return null; }
      if (re && !re.test(t)) { errors.push(`${where}: "${t}" does not match ${f.pattern}`); return null; }
      return t;
    };
    switch (f.type) {
      case 'string': {
        const s = typeof v === 'number' ? String(v) : v;
        if (typeof s !== 'string') { errors.push(`${f.key}: must be text`); break; }
        const t = text(s);
        if (t !== null) { if (t === '' && f.required) errors.push(`${f.key}: required`); else if (t !== '') value[f.key] = t; }
        break;
      }
      case 'number': {
        const n = typeof v === 'string' ? Number(v) : v;
        if (typeof n !== 'number' || !Number.isFinite(n)) errors.push(`${f.key}: must be a number`); else value[f.key] = n;
        break;
      }
      case 'boolean': {
        const b = v === 'true' ? true : v === 'false' ? false : v;
        if (typeof b !== 'boolean') errors.push(`${f.key}: must be true or false`); else value[f.key] = b;
        break;
      }
      case 'string[]': {
        if (!Array.isArray(v)) { errors.push(`${f.key}: must be a list of text`); break; }
        if (v.length > MAX_ARRAY) { errors.push(`${f.key}: ${MAX_ARRAY} entries at most`); break; }
        const arr: string[] = [];
        v.forEach((x, i) => {
          if (typeof x !== 'string' || !x.trim()) { errors.push(`${f.key}[${i}]: must be text`); return; }
          const t = text(x, `${f.key}[${i}]`);
          if (t !== null && !arr.includes(t)) arr.push(t);
        });
        value[f.key] = arr;
        break;
      }
    }
  }
  return { value, errors };
}

export const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);

/** The code an item gets: its code field when the list has one, else what was given, else a slug of the label. */
export function codeFor(list: Pick<ListDef, 'codeField' | 'labelField'>, value: Record<string, unknown>, given?: string | null): string {
  const code = list.codeField ? String(value[list.codeField] ?? '') : (given?.trim() || slug(String(value[list.labelField] ?? '')));
  if (!CODE.test(code)) throw bad(`"${code}" is not a usable code: letters, digits, dot, dash and underscore, up to 64, starting with a letter or digit.`);
  return code;
}

// ---- rows ---------------------------------------------------------------------------------

export const defOf = (r: ListRow): ListDef => ({
  key: r.key, name: r.name, description: r.description, visibility: r.visibility,
  codeField: r.code_field, labelField: r.label_field, fields: r.fields,
});

export const listJson = (r: ListRow & { items?: number; active_items?: number }) => ({
  id: r.id, key: r.key, name: r.name, description: r.description, visibility: r.visibility, system: r.system,
  codeField: r.code_field, labelField: r.label_field, fields: r.fields,
  ...(r.items != null ? { itemCount: r.items, activeCount: r.active_items } : {}),
  version: r.version, archived: !!r.archived_at, updatedAt: r.updated_at,
});

/** An item as the API returns it; `label` is the locale's translation when there is one. */
export function itemJson(list: ListRow, r: any, locale?: string | null) {
  // Postgres stores jsonb keys in its own order; hand them back in the list's
  // field order (then any translations), so every item reads the same way.
  const raw = r.value ?? {};
  const v: Record<string, unknown> = {};
  for (const f of list.fields) if (f.key in raw) v[f.key] = raw[f.key];
  for (const k of Object.keys(raw).sort()) if (!(k in v)) v[k] = raw[k];
  const label = (locale && typeof v[locale] === 'string' && v[locale]) || v[list.label_field] || r.code;
  return {
    id: r.id, listId: list.id, listKey: list.key, code: r.code, label, value: v,
    position: r.position, isDefault: r.is_default, active: r.active, updatedAt: r.updated_at,
  };
}

export async function getList(key: string, c?: PoolClient): Promise<ListRow | null> {
  const sql = `SELECT * FROM global_lists WHERE key = $1`;
  return c ? ((await c.query(sql, [key])).rows[0] ?? null) : one<ListRow>(sql, [key]);
}

export async function bumpVersion(c: PoolClient, listId: string, userId: string | null) {
  await c.query(`UPDATE global_lists SET version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1`, [listId, userId]);
}

/** Unique fields already held by another item in the list. */
export async function uniqueClashes(c: PoolClient | null, list: ListRow, value: Record<string, unknown>, exceptId: string | null): Promise<string[]> {
  const out: string[] = [];
  for (const f of list.fields) {
    if (!f.unique || value[f.key] == null) continue;
    const sql = `SELECT code FROM global_list_items WHERE list_id = $1 AND lower(value->>$2) = lower($3) AND ($4::uuid IS NULL OR id <> $4::uuid) LIMIT 1`;
    const params = [list.id, f.key, String(value[f.key]), exceptId];
    const hit = c ? (await c.query(sql, params)).rows[0] : await one<any>(sql, params);
    if (hit) out.push(`${f.key}: "${value[f.key]}" is already used by ${hit.code}`);
  }
  return out;
}

/** Every existing item checked against a proposed definition; the first problems found. */
export async function itemsFailing(listId: string, def: Pick<ListDef, 'fields'>, limit = 10): Promise<string[]> {
  const rows = await query<any>(`SELECT code, value FROM global_list_items WHERE list_id = $1 ORDER BY position, code`, [listId]);
  const out: string[] = [];
  const seen = new Map<string, Map<string, string>>();
  for (const r of rows) {
    const { errors } = checkValue(def, r.value);
    for (const e of errors) { out.push(`${r.code}: ${e}`); if (out.length >= limit) return out; }
    for (const f of def.fields) {
      if (!f.unique || r.value?.[f.key] == null) continue;
      const m = seen.get(f.key) ?? new Map<string, string>(); seen.set(f.key, m);
      const k = String(r.value[f.key]).toLowerCase();
      if (m.has(k)) { out.push(`${r.code}: ${f.key} "${r.value[f.key]}" is also used by ${m.get(k)}`); if (out.length >= limit) return out; }
      else m.set(k, r.code);
    }
  }
  return out;
}

// ---- the list query standard over a list's own fields --------------------------------------

/**
 * A ListSpec for one list's items, built from its fields, so q / filters /
 * sort work on every field: value.<key> always (?value.offset[gte]=8,
 * ?sort=-value.offset), and the bare key as shorthand where it is free
 * (?alpha3=AUS, ?sort=name).
 * Field keys are validated against FIELD_KEY before they are ever stored, so
 * they are safe to place in SQL as JSON keys.
 */
export function itemSpec(list: ListRow, path: string): ListSpec {
  const fields: Record<string, FieldSpec> = {
    id: { sql: 'i.id', type: 'uuid', notNull: true, sort: false },
    code: { sql: 'i.code', type: 'string', notNull: true, doc: 'The item\'s stable code' },
    position: { sql: 'i.position', type: 'number', notNull: true },
    isDefault: { sql: 'i.is_default', type: 'boolean', notNull: true, key: 'is_default' },
    active: { sql: 'i.active', type: 'boolean', notNull: true, doc: 'false: retired (still resolvable by code)' },
    updatedAt: { sql: 'i.updated_at', type: 'timestamp', notNull: true, key: 'updated_at' },
  };
  const search = ['i.code'];
  const aliases: Record<string, string> = {};
  for (const f of list.fields) {
    if (!FIELD_KEY.test(f.key)) continue;
    const json = `i.value->>'${f.key}'`;
    const name = `value.${f.key}`;
    if (!TAKEN_PARAMS.has(f.key)) aliases[f.key] = name;
    if (f.type === 'number' || f.sortAs === 'number') {
      // A text value that is not a number reads as NULL instead of failing the query.
      fields[name] = { sql: f.type === 'number' ? `(${json})::float8` : `(CASE WHEN ${json} ~ '^[+-]?[0-9]+(\\.[0-9]+)?$' THEN (${json})::float8 END)`, type: 'number', key: `vf_${f.key}`, doc: f.label };
    } else if (f.type === 'boolean') {
      fields[name] = { sql: `(${json})::boolean`, type: 'boolean', key: `vf_${f.key}`, doc: f.label };
    } else if (f.type === 'string[]') {
      fields[name] = { sql: json, type: 'string', sort: false, key: `vf_${f.key}`, doc: `${f.label} (contains matches any entry)` };
      search.push(json);
    } else {
      fields[name] = { sql: json, type: 'string', key: `vf_${f.key}`, doc: f.label };
      search.push(json);
    }
  }
  return {
    path, fields, search, aliases, defaultSort: `position,value.${list.label_field}`,
    defaultLimit: 500, maxLimit: 1000, extraParams: ['locale'], allowOffset: true,
  };
}

/** SELECT list for itemSpec: the row plus each field's sort value (the cursor reads vf_*). */
export function itemSelect(spec: ListSpec): string {
  const extra = Object.values(spec.fields).filter((f) => f.key?.startsWith('vf_')).map((f) => `${f.sql} AS "${f.key}"`);
  return ['i.*', ...extra].join(', ');
}

// ---- seeding ------------------------------------------------------------------------------

/**
 * Create the built-in lists and add their shipped items (boot, inside the boot
 * lock). A list is created once with its shipped definition; after that its
 * definition is the System Admin's. Shipped items are ADDED by code when a
 * seed's SEED_VERSION is newer than the database's; an item that already
 * exists is never overwritten (restoreShipped does that, when asked).
 */
export async function ensureGlobalListSeeds(): Promise<number> {
  let added = 0;
  for (const b of BUILT_IN) {
    const { SEED_VERSION, ITEMS } = await b.seed();
    added += await tx(async (c) => {
      await c.query(
        `INSERT INTO global_lists(key, name, description, visibility, system, fields, code_field, label_field)
         VALUES ($1,$2,$3,$4,true,$5,$6,$7) ON CONFLICT (key) DO NOTHING`,
        [b.key, b.name, b.description, b.visibility, JSON.stringify(b.fields), b.codeField, b.labelField]);
      const list = (await c.query(`SELECT * FROM global_lists WHERE key = $1 FOR UPDATE`, [b.key])).rows[0] as ListRow;
      if (list.seeded_version >= SEED_VERSION) return 0;
      let n = 0;
      for (const it of ITEMS) {
        const r = await c.query(
          `INSERT INTO global_list_items(list_id, code, value, position, is_default, active) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (list_id, lower(code)) DO NOTHING`,
          [list.id, it.code, JSON.stringify(it.value), it.position ?? 0, !!it.isDefault, it.active ?? true]);
        n += r.rowCount ?? 0;
      }
      await c.query(`UPDATE global_lists SET seeded_version = $2${n ? ', version = version + 1, updated_at = now()' : ''} WHERE id = $1`, [list.id, SEED_VERSION]);
      return n;
    });
  }
  return added;
}

/** Put shipped items back: add missing ones, and with overwrite reset shipped items to shipped values. */
export async function restoreShipped(c: PoolClient, list: ListRow, overwrite: boolean): Promise<{ added: number; reset: number }> {
  const b = BUILT_IN.find((x) => x.key === list.key);
  if (!b) throw bad('Only built-in lists have shipped values.');
  const { ITEMS } = await b.seed();
  let added = 0, reset = 0;
  for (const it of ITEMS) {
    const ex = (await c.query(`SELECT id, value, active FROM global_list_items WHERE list_id = $1 AND lower(code) = lower($2)`, [list.id, it.code])).rows[0];
    if (!ex) {
      await c.query(`INSERT INTO global_list_items(list_id, code, value, position) VALUES ($1,$2,$3,$4)`,
        [list.id, it.code, JSON.stringify(it.value), it.position ?? 0]);
      added++;
    } else if (overwrite) {
      // Keep translations an admin added; shipped fields go back to shipped values.
      const locales = Object.fromEntries(Object.entries(ex.value ?? {}).filter(([k]) => LOCALE_KEY.test(k) && !(k in it.value)));
      const next = { ...locales, ...it.value };
      if (JSON.stringify(next) !== JSON.stringify(ex.value) || !ex.active) {
        await c.query(`UPDATE global_list_items SET value = $2, active = true, updated_at = now() WHERE id = $1`, [ex.id, JSON.stringify(next)]);
        reset++;
      }
    }
  }
  return { added, reset };
}
