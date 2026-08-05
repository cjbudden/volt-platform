/**
 * Edit + audit foundation.
 *
 * - actor(req)      : resolve the acting principal (user id, or 'apikey:<id>' / 'system').
 * - writeAudit()    : append one audit_log row (create/update/delete + diff).
 * - patchEntity()   : versioned, audited PARTIAL update. Applies only the fields that
 *                     actually changed, bumps `version`, stamps `updated_by`/`updated_at`,
 *                     and writes the field-level diff. Optimistic concurrency via
 *                     expectedVersion (If-Match) so concurrent editors can't clobber.
 *
 * Callers first load the row scoped to the tenant (so ownership is verified), then hand
 * that `current` row here. Column names come from a caller-provided allow-list (our own
 * constants, never user input); values are parameterised.
 */
import { query, tx } from '../db';
import type { PoolClient } from 'pg';
import type { Request } from 'express';

const IDENT = /^[a-z_][a-z0-9_]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the acting principal. userId is set ONLY for a real user UUID (it's a FK
 * to users.id); an API-key, system, or non-UUID/test principal records userId=null
 * and keeps its identity in the audit label instead.
 */
export function actor(req: Request): { userId: string | null; label: string } {
  const sub = (req as any).auth?.sub as string | undefined;
  if (!sub) return { userId: null, label: 'system' };
  if (!UUID.test(sub)) return { userId: null, label: sub };   // apikey:<id>, service/test tokens, etc.
  return { userId: sub, label: sub };
}

export class VersionConflict extends Error {
  status = 409;
  constructor(public currentVersion: number) { super('version conflict: the record was changed by someone else'); }
}

function isJson(v: any) { return v !== null && typeof v === 'object'; }

/** Diff a patch against the current row, restricted to allowed columns. null clears. */
export function diff(current: Record<string, any>, patch: Record<string, any>, allowed: string[]) {
  const changes: Record<string, { from: any; to: any }> = {};
  const set: Record<string, any> = {};
  for (const k of allowed) {
    if (!(k in patch)) continue;            // absent = leave unchanged
    const to = patch[k];
    const from = current[k];
    if (JSON.stringify(from ?? null) !== JSON.stringify(to ?? null)) { changes[k] = { from, to }; set[k] = to; }
  }
  return { changes, set };
}

export async function writeAudit(c: PoolClient | null, o: {
  accountId: string | null; userId: string | null; label: string;
  action: 'create' | 'update' | 'delete'; entityType: string; entityId: string;
  changes?: Record<string, { from: any; to: any }>; snapshot?: any;
}): Promise<void> {
  const detail: any = { actor: o.label };
  if (o.changes && Object.keys(o.changes).length) detail.changes = o.changes;
  if (o.snapshot) detail.snapshot = o.snapshot;
  const sql = `INSERT INTO audit_log(account_id, user_id, action, entity_type, entity_id, detail)
               VALUES ($1,$2,$3,$4,$5,$6::jsonb)`;
  const params = [o.accountId, o.userId, o.action, o.entityType, o.entityId, JSON.stringify(detail)];
  if (c) await c.query(sql, params); else await query(sql, params);
}

/**
 * Versioned, audited partial update. Returns the updated row + which columns changed
 * (empty when nothing changed = a no-op that neither bumps version nor audits).
 */
export async function patchEntity(o: {
  table: string; id: string; accountId: string | null;
  current: Record<string, any>; patch: Record<string, any>; allowed: string[];
  entityType: string; userId: string | null; label: string; expectedVersion?: number | null;
  arrayColumns?: string[]; // columns that are native SQL arrays (text[]), NOT jsonb
}): Promise<{ row: any; changed: string[] }> {
  if (!IDENT.test(o.table)) throw new Error(`bad table name: ${o.table}`);
  if (o.expectedVersion != null && Number(o.current.version) !== Number(o.expectedVersion)) {
    throw new VersionConflict(Number(o.current.version));
  }
  const { changes, set } = diff(o.current, o.patch, o.allowed);
  const cols = Object.keys(set);
  if (!cols.length) return { row: o.current, changed: [] };
  for (const c of cols) if (!IDENT.test(c)) throw new Error(`bad column name: ${c}`);

  return tx(async (client) => {
    const params: any[] = [];
    const arrayCols = o.arrayColumns ?? [];
    const assignments = cols.map((col) => {
      const v = set[col];
      // native SQL array (text[]) — let node-pg serialize the JS array to an array literal
      if (arrayCols.includes(col)) { params.push(v ?? []); return `"${col}"=$${params.length}`; }
      if (isJson(v)) { params.push(JSON.stringify(v)); return `"${col}"=$${params.length}::jsonb`; }
      params.push(v); return `"${col}"=$${params.length}`;
    });
    params.push(o.id);
    let where = `id=$${params.length}`;
    if (o.expectedVersion != null) { params.push(o.expectedVersion); where += ` AND version=$${params.length}`; }
    params.push(o.userId);
    const sql = `UPDATE "${o.table}" SET ${assignments.join(', ')}, version=version+1,
                 updated_by=$${params.length}, updated_at=now() WHERE ${where} RETURNING *`;
    const r = await client.query(sql, params);
    const row = r.rows[0];
    if (!row) throw new VersionConflict(Number(o.current.version)); // lost a concurrent race
    await writeAudit(client, { accountId: o.accountId, userId: o.userId, label: o.label,
      action: 'update', entityType: o.entityType, entityId: o.id, changes });
    return { row, changed: cols };
  });
}

/** Read the change history for one entity (account-scoped), newest first. */
export async function entityHistory(accountId: string, entityType: string, entityId: string, limit = 50) {
  return query(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.detail, a.created_at,
            a.user_id, u.email AS user_email, u.display_name AS user_name
       FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.account_id=$1 AND a.entity_type=$2 AND a.entity_id=$3
      ORDER BY a.created_at DESC LIMIT $4`,
    [accountId, entityType, entityId, limit]
  );
}
