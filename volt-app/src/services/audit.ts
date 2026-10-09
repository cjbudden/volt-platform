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
  // user_id is resolved through a lookup rather than inserted straight, because
  // audit_log.user_id is a FK to users.id and the acting subject is not always a
  // user row: a service token, a platform token, or a user deleted mid-request
  // all produce a well-formed UUID that has no user behind it. Inserting it
  // directly raised 23503 AFTER the work had already committed, so the caller
  // saw a 500 for a delete that had in fact succeeded, which is the worst of
  // both answers. The subquery yields NULL in that case and the row still
  // records who acted, in detail.actor.
  const sql = `INSERT INTO audit_log(account_id, user_id, action, entity_type, entity_id, detail)
               VALUES ($1, (SELECT id FROM users WHERE id = $2), $3,$4,$5,$6::jsonb)`;
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

    /* ------------------------------------------------------------------
     *  TELL THE OTHER ADMINS. This is the whole of "live updates" on the
     *  server side, and it belongs HERE rather than at each call site for
     *  the same reason the audit write does: there is exactly one function
     *  that changes a record, so there is exactly one place that can be
     *  certain a change happened and what changed.
     *
     *  A caller that had to remember to publish would forget, the way four
     *  call sites forgot to record `on_air` before airSessions.ts took the
     *  column away from them.
     *
     *  ONLY THE SHAPE OF THE CHANGE TRAVELS, never the values. A second
     *  admin is told that `name` and `dvr_sec` moved, by whom, and what the
     *  version is now; they re-read through their own credential to see the
     *  content. So the SSE frame cannot leak a field the recipient is not
     *  allowed to read, and the fan-out stays small enough to be free.
     *
     *  Fire-and-forget on purpose: the hub is in-process and best-effort,
     *  and a notification failure must never roll back a committed edit.
     * ---------------------------------------------------------------- */
    if (o.accountId) {
      try {
        const { publish } = await import('./statusHub');
        publish(o.accountId, 'record', {
          kind: o.entityType,
          id: o.id,
          changed: cols,
          version: Number(row.version),
          by: o.userId ?? null,
          label: o.label ?? null,
        });
      } catch { /* telemetry must never break a write */ }
    }
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
