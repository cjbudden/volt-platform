// ============================================================================
//  GRAPHICS DEFAULT SETS: which of Volt's own templates a client account can use.
//
//  Volt templates (account_id NULL) belong to a set (News, General, Sport scores, or one a
//  SaaS admin makes). A set is on for an account when the account's own choice says so,
//  or, with no choice of its own, when the set's default says so. Archived sets and retired
//  templates are off everywhere.
//
//  "Usable" (can start a new setup or be duplicated) and "visible" (listed in the library)
//  differ on purpose: a template the account already has setups on stays visible after its
//  set is turned off, so nothing on air or in a rundown breaks and the setups can still be
//  opened and moved between versions. Setups themselves are per account and never shared.
//  docs/GRAPHICS_TEMPLATE_STANDARD.md section 9.
// ============================================================================
import { query } from '../../db';

/** SQL: the Volt template `t` belongs to a set that is on for `acct` (a placeholder such as $2). */
export const setOnSql = (t: string, acct: string) => `(${t}.set_id IS NULL OR EXISTS (
  SELECT 1 FROM gfx_template_sets gs_ LEFT JOIN gfx_account_sets ga_ ON ga_.set_id = gs_.id AND ga_.account_id = ${acct}
   WHERE gs_.id = ${t}.set_id AND gs_.archived_at IS NULL AND COALESCE(ga_.enabled, gs_.default_enabled)))`;

/** SQL: `acct` may start new setups from (or duplicate) template `t`. Always true or false, never NULL. */
export const usableSql = (t: string, acct: string) =>
  `(COALESCE(${t}.account_id = ${acct}, false) OR (${t}.account_id IS NULL AND ${t}.retired_at IS NULL AND ${setOnSql(t, acct)}))`;

/** SQL: template `t` is listed for `acct`: usable, or a Volt template the account already has setups on. */
export const visibleSql = (t: string, acct: string) =>
  `(${usableSql(t, acct)} OR (${t}.account_id IS NULL AND EXISTS (SELECT 1 FROM gfx_setups su_ WHERE su_.template_id = ${t}.id AND su_.account_id = ${acct})))`;

export interface AccountSet {
  id: string; key: string; name: string; description: string | null; defaultEnabled: boolean; archived: boolean;
  /** The account's own choice; null follows the set's default. */
  override: boolean | null;
  enabled: boolean;
  templates: number;
  /** Setups this account has on the set's templates (they keep working when the set is off). */
  setupsInUse: number;
}

export async function setsForAccount(acct: string): Promise<AccountSet[]> {
  const rows = await query<any>(`
    SELECT gs.*, ga.enabled AS override,
      (SELECT count(*)::int FROM gfx_templates t WHERE t.set_id = gs.id AND t.account_id IS NULL AND t.archived_at IS NULL AND t.retired_at IS NULL) AS templates,
      (SELECT count(*)::int FROM gfx_setups s JOIN gfx_templates t ON t.id = s.template_id WHERE t.set_id = gs.id AND s.account_id = $1) AS in_use
      FROM gfx_template_sets gs LEFT JOIN gfx_account_sets ga ON ga.set_id = gs.id AND ga.account_id = $1
     ORDER BY gs.archived_at NULLS FIRST, gs.sort, gs.name`, [acct]);
  return rows.map((r) => ({
    id: r.id, key: r.key, name: r.name, description: r.description, defaultEnabled: r.default_enabled, archived: !!r.archived_at,
    override: r.override ?? null, enabled: !r.archived_at && (r.override ?? r.default_enabled), templates: r.templates, setupsInUse: r.in_use,
  }));
}
