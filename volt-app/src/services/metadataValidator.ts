import { ApiError } from '../util/http';

/**
 * Validate a VOD asset's metadata values against its assigned schema.
 *
 * A schema is a list of typed fields (stored in metadata_schemas.fields):
 *   { key, label?, type, required?, options?, multiple? }
 * Supported types: string | text | number | boolean | date | enum | url | tags | image.
 *
 * Validation is strict: required fields must be present, values must match their
 * declared type, enums must be within options, and unknown keys are rejected —
 * so "custom schema" stays structured rather than drifting into free-form soup.
 * Returns a cleaned values object (only known keys, coerced where safe).
 */
export interface SchemaField {
  key: string;
  label?: string;
  /** image: an Image Library reference (/library/<account>/<path>) or a web address, downloaded into the library on save. */
  type: 'string' | 'text' | 'number' | 'boolean' | 'date' | 'enum' | 'url' | 'tags' | 'reference' | 'image';
  required?: boolean;
  options?: string[];
  multiple?: boolean;
  refDomain?: string; // for type 'reference': the entity domain (e.g. 'sports-team')
  /** The EPG slot this value lands in when a programme is made from the owner:
   *  title | sub-title | description | category | episode | language | icon |
   *  credits.<role> | custom:<name>. See services/contentTypes.ts. */
  epg?: string;
  /** The schema.org property this field maps to in JSON-LD output. */
  schemaOrg?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T.*)?$/;

/**
 * Merge an inherited (extends) field list with a child's, child overriding by
 * key. Enables schema COMPOSITION — e.g. a base "Sports Event" schema extended
 * by "Soccer" (teams/players/matchday). Parent order preserved; child adds/overrides.
 */
export function mergeFields(parent: SchemaField[], child: SchemaField[]): SchemaField[] {
  const byKey = new Map<string, SchemaField>();
  for (const f of parent) byKey.set(f.key, f);
  for (const f of child) byKey.set(f.key, f);
  return [...byKey.values()];
}

export function validateSchemaFields(fields: unknown): SchemaField[] {
  if (!Array.isArray(fields)) throw new ApiError(422, 'schema fields must be an array');
  const seen = new Set<string>();
  const okTypes = ['string', 'text', 'number', 'boolean', 'date', 'enum', 'url', 'image', 'tags', 'reference'];
  for (const f of fields as SchemaField[]) {
    if (!f || typeof f.key !== 'string' || !f.key)
      throw new ApiError(422, 'each field needs a non-empty key');
    if (seen.has(f.key)) throw new ApiError(422, `duplicate field key: ${f.key}`);
    seen.add(f.key);
    if (!okTypes.includes(f.type)) throw new ApiError(422, `bad field type: ${f.type} (${f.key})`);
    if (f.type === 'enum' && (!Array.isArray(f.options) || f.options.length === 0))
      throw new ApiError(422, `enum field ${f.key} needs options[]`);
    if (f.epg != null && !/^(title|sub-title|description|category|episode|language|icon|credits\.[a-z-]+|custom:[a-zA-Z0-9_-]+)$/.test(String(f.epg)))
      throw new ApiError(422, `bad epg slot on ${f.key}: ${f.epg}`);
  }
  return fields as SchemaField[];
}

function checkOne(field: SchemaField, value: any): any {
  switch (field.type) {
    case 'string':
    case 'text':
    case 'url':
      if (typeof value !== 'string') throw new ApiError(422, `${field.key} must be a string`);
      if (field.type === 'url' && value && !/^https?:\/\//i.test(value))
        throw new ApiError(422, `${field.key} must be a URL`);
      return value;
    case 'image':
      if (typeof value !== 'string') throw new ApiError(422, `${field.key} must be an image`);
      if (value && !/^https?:\/\//i.test(value) && !/^\/library\/[0-9a-f-]{36}\/.+/i.test(value))
        throw new ApiError(422, `${field.key} must be an image from the Image Library or a web address`);
      return value;
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value))
        throw new ApiError(422, `${field.key} must be a number`);
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') throw new ApiError(422, `${field.key} must be a boolean`);
      return value;
    case 'date':
      if (typeof value !== 'string' || !ISO_DATE.test(value))
        throw new ApiError(422, `${field.key} must be an ISO date`);
      return value;
    case 'tags':
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))
        throw new ApiError(422, `${field.key} must be an array of strings`);
      return value;
    case 'enum': {
      const opts = field.options ?? [];
      const vals = field.multiple ? value : [value];
      if (field.multiple && !Array.isArray(value))
        throw new ApiError(422, `${field.key} must be an array`);
      for (const v of vals) {
        if (!opts.includes(v)) throw new ApiError(422, `${field.key}: ${v} not in options`);
      }
      return value;
    }
    case 'reference': {
      // Entity link (team/player/competition…): {id, name?} or a bare string id.
      const one = (v: any) => {
        if (typeof v === 'string') return { id: v };
        if (v && typeof v === 'object' && typeof v.id === 'string') return v;
        throw new ApiError(422, `${field.key} must be a reference {id,...} or an id string`);
      };
      if (field.multiple) {
        if (!Array.isArray(value)) throw new ApiError(422, `${field.key} must be an array of references`);
        return value.map(one);
      }
      return one(value);
    }
    default:
      throw new ApiError(422, `unhandled field type for ${field.key}`);
  }
}

export type UnknownKeyPolicy = 'reject' | 'keep';

/**
 * Validate a metadata object against a type's fields.
 *
 * `unknown` decides what happens to keys the type does not define. Assets
 * (clips, recordings, uploads) reject them, because the metadata form is the
 * only writer. Owners (channels, events, stations) KEEP them untouched: their
 * metadata column predates content types and carries provenance written by
 * other code paths (seed scripts, ICY capture, probes) that the type has no
 * business deleting. A station seeded with { seeded: 'scripts/seed-radio.ts' }
 * must still be savable from the Settings drawer.
 */
export function validateMetadata(
  fields: SchemaField[],
  values: Record<string, any>,
  unknown: UnknownKeyPolicy = 'reject'
): Record<string, any> {
  const known = new Map(fields.map((f) => [f.key, f]));
  const clean: Record<string, any> = {};
  for (const k of Object.keys(values ?? {})) {
    if (known.has(k)) continue;
    if (unknown === 'reject') throw new ApiError(422, `unknown metadata field: ${k}`);
    clean[k] = values[k];
  }
  for (const field of fields) {
    const present = values && Object.prototype.hasOwnProperty.call(values, field.key);
    if (!present || values[field.key] === null || values[field.key] === '') {
      if (field.required) throw new ApiError(422, `missing required field: ${field.key}`);
      continue;
    }
    clean[field.key] = checkOne(field, values[field.key]);
  }
  return clean;
}
