// ============================================================================
//  THE METADATA-RULE RUNG (build queue P3-3, PUBLISHING_POLICIES.md).
//
//    account < content type < owner < METADATA RULE < asset
//
//  An ordered list of rules, each a condition tree over a title's metadata,
//  tags, collections or source (the condition builder of rule collections,
//  services/collectionRules.ts) and the policy it chooses. The FIRST rule
//  that matches applies; the rest are not consulted. It sits above the owner
//  rung (Christian, 11 Nov): rights and commercial terms follow the content,
//  not the channel it came from. A title's own override still beats it, and a
//  field locked lower down still holds.
//
//  Matching is SQL, as for collections: every rule of the account compiles
//  into ONE query with a CASE that answers the position of the first rule a
//  title meets, for one title or a batch. Nothing is matched per request:
//  the result is part of the stamp a published title carries
//  (services/availability.ts), and a change to the rules or to a published
//  title's metadata marks it for the restamp sweep (migration 0160).
// ============================================================================
import { query } from '../db';
import {
  fieldsFor, validateRules, compileWhere, RuleError,
  type FieldDef, type Group,
} from './collectionRules';
import type { RuleSettings } from './publishingRules';

export interface MetadataRule {
  id: string;
  account_id: string;
  position: number;
  name: string;
  conditions: Group;
  settings: RuleSettings;
  locked_fields: string[];
  preset_key: string | null;
  enabled: boolean;
  version: number;
}

/**
 * Fields a rule may not read: they are what a policy decides (whether a
 * title is published and from when), so a rule on them would change the
 * answer that chose it.
 */
const CIRCULAR = new Set(['availability_state', 'published', 'available_from']);

/** Collection membership as a list of ids, so "is in any of" reads like tags. */
export const COLLECTION_FIELD: FieldDef = {
  key: 'collection', label: 'Collection', type: 'tags', group: 'Asset',
  sql: `(SELECT COALESCE(jsonb_agg(ci.collection_id::text), '[]'::jsonb) FROM collection_items ci WHERE ci.vod_asset_id = v.id)`,
};

/** The fields a metadata rule can use in this account. */
export async function policyFieldsFor(accountId: string): Promise<FieldDef[]> {
  const all = (await fieldsFor(accountId)).filter((f) => !CIRCULAR.has(f.key));
  const at = all.findIndex((f) => f.key === 'tags');
  all.splice(at + 1, 0, COLLECTION_FIELD);
  return all;
}

/** Validate a condition tree for a metadata rule; throws RuleError. */
export function validateConditions(tree: unknown, fields: FieldDef[]): Group {
  return validateRules(tree, fields);
}

/** The account's rules, first checked first. */
export async function loadRules(accountId: string, opts: { enabledOnly?: boolean } = {}): Promise<MetadataRule[]> {
  return query<MetadataRule>(
    `SELECT id, account_id, position, name, conditions, settings, locked_fields, preset_key, enabled, version
       FROM publishing_metadata_rules WHERE account_id = $1 ${opts.enabledOnly ? 'AND enabled' : ''}
      ORDER BY position, created_at`, [accountId]);
}

/**
 * Pure: the SQL that answers, per title, the index (in `rules`) of the first
 * rule it meets, or NULL. A rule whose conditions no longer validate (a field
 * removed from a content type) is passed over, never matched.
 */
export function firstMatchSql(accountId: string, rules: Pick<MetadataRule, 'conditions'>[], fields: FieldDef[], assetIds: string[] | null): { sql: string; params: unknown[]; skipped: number[] } {
  const params: unknown[] = [accountId];
  const whens: string[] = [];
  const skipped: number[] = [];
  rules.forEach((r, i) => {
    let tree: Group;
    try { tree = validateRules(r.conditions, fields); }
    catch (e) { if (e instanceof RuleError) { skipped.push(i); return; } throw e; }
    whens.push(`WHEN ${compileWhere(tree, fields, params)} THEN ${i}`);
  });
  const pick = whens.length ? `CASE ${whens.join(' ')} END` : 'NULL::int';
  let only = '';
  if (assetIds) { params.push(assetIds); only = ` AND v.id = ANY($${params.length}::uuid[])`; }
  return {
    sql: `SELECT v.id, ${pick} AS rule_index FROM vod_assets v
            LEFT JOIN channels c ON c.id = v.channel_id
            LEFT JOIN events e ON e.id = v.event_id
            LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
            LEFT JOIN rights_profiles rp ON rp.id = v.rights_profile_id
            LEFT JOIN metadata_schemas ms ON ms.id = v.schema_id
           WHERE COALESCE(g.account_id, v.account_id) = $1${only}`,
    params, skipped,
  };
}

/**
 * The rule each title meets first: asset id -> the rule (absent: none). One
 * query for the batch, whatever the number of rules. The impact preview
 * passes the list as it would be after a save.
 */
export async function firstMatches<R extends Pick<MetadataRule, 'conditions'>>(accountId: string, assetIds: string[] | null, rules: R[], fields?: FieldDef[]): Promise<Map<string, R>> {
  const out = new Map<string, R>();
  if (!rules.length || (assetIds && !assetIds.length)) return out;
  const f = fields ?? await policyFieldsFor(accountId);
  const q = firstMatchSql(accountId, rules, f, assetIds);
  const rows = await query<{ id: string; rule_index: number | null }>(q.sql, q.params);
  for (const r of rows) if (r.rule_index !== null && r.rule_index !== undefined) out.set(r.id, rules[r.rule_index]);
  return out;
}

/** The first enabled rule one title meets, or null. */
export async function matchFor(accountId: string, assetId: string): Promise<MetadataRule | null> {
  const rules = await loadRules(accountId, { enabledOnly: true });
  if (!rules.length) return null;
  return (await firstMatches(accountId, [assetId], rules)).get(assetId) ?? null;
}

/** The ladder input for a matched rule (services/publishingRules.ts resolveLadder). */
export function rungOf(r: Pick<MetadataRule, 'id' | 'name' | 'settings' | 'locked_fields' | 'preset_key'> | null | undefined) {
  if (!r) return { rung: 'metadata' as const, id: null, scopeId: null, settings: {} };
  return { rung: 'metadata' as const, id: r.id, scopeId: r.id, settings: r.settings ?? {}, lockedFields: r.locked_fields ?? [], name: r.name, presetKey: r.preset_key ?? null };
}
