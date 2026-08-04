/**
 * Tenancy scoping helpers. An account may own SUB-ACCOUNTS
 * (accounts.parent_account_id). A parent-account admin can see its subtree; a
 * leaf sub-account sees only itself. accountSubtree resolves the descendant set
 * with a recursive CTE. (Per-query subtree wiring across every module is a
 * follow-up; auth still resolves a single account_id today.)
 */
import { query } from '../db';

/** All account ids in the subtree rooted at accountId (inclusive). */
export async function accountSubtree(accountId: string): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `WITH RECURSIVE sub AS (
       SELECT id FROM accounts WHERE id = $1
       UNION ALL
       SELECT a.id FROM accounts a JOIN sub ON a.parent_account_id = sub.id
     )
     SELECT id FROM sub`,
    [accountId]
  );
  return rows.map((r) => r.id);
}

/** True if `childId` is `parentId` or a descendant of it. */
export async function isInSubtree(parentId: string, childId: string): Promise<boolean> {
  if (parentId === childId) return true;
  const ids = await accountSubtree(parentId);
  return ids.includes(childId);
}
