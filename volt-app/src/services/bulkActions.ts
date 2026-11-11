// ============================================================================
//  BULK ACTIONS, AND MANAGEMENT CONFIRMATION FOR THEM (Christian 9 Nov).
//  docs/BULK_ACTIONS.md.
//
//  A bulk action is registered here once: what it is called, what it would do
//  to each item (impact, with a reason where an item cannot be taken), and how
//  to run it. Every route goes through run(), so the confirmation rule cannot
//  be skipped by calling the action some other way.
//
//  MANAGEMENT CONFIRMATION (accounts.bulk_needs_approval, off by default).
//  When it is on, a bulk action asked for by someone below administrator is
//  not run: it becomes a request (bulk_requests) that an administrator or
//  owner, never the person who asked, approves or rejects. Administrators and
//  owners are the management, so their own bulk actions run at once after the
//  usual confirmation. A request nobody decides expires after 7 days.
//
//  Approving runs the action as it is NOW: an item that has since gone, or is
//  now blocked (put into a FAST lineup meanwhile), is refused with its reason,
//  and the rest go ahead. What happened is kept on the request.
// ============================================================================
import { one, query } from '../db';
import { writeAudit } from './audit';

export interface BulkActor { userId: string | null; label: string; rank: number }
export interface ImpactItem { id: string; name: string; blocker: string | null }
export interface RunOutcome {
  done: { id: string; name: string; bin?: string | null; purgeAfter?: string | null }[];
  refused: { id: string; name: string; why: string }[];
}
interface BulkAction {
  label: string;
  /** Past tense for messages: "removed". */
  did: string;
  impact(accountId: string, ids: string[]): Promise<ImpactItem[]>;
  run(accountId: string, ids: string[], by: BulkActor): Promise<RunOutcome>;
}

export const MAX_BULK = 500;
/** Administrator and above (auth/roles.ts ROLE_RANK). */
const ADMIN_RANK = 3;

// ---------------------------------------------------------------- the actions

const vodRemove: BulkAction = {
  label: 'Remove from the Media Library',
  did: 'removed',
  async impact(accountId, ids) {
    const { assetDeleteImpact } = await import('../modules/vod');
    const out: ImpactItem[] = [];
    for (const id of ids) {
      try { const i = await assetDeleteImpact(id, accountId); out.push({ id, name: i.name, blocker: i.blocker }); }
      catch { out.push({ id, name: 'Not found', blocker: 'This asset is not in this account (or was already removed).' }); }
    }
    return out;
  },
  async run(accountId, ids, by) {
    const { assetDeleteImpact } = await import('../modules/vod');
    const { removeVodAsset } = await import('./vodRemove');
    const res: RunOutcome = { done: [], refused: [] };
    for (const id of ids) {
      let name = 'Not found';
      try {
        const i = await assetDeleteImpact(id, accountId);
        name = i.name;
        if (i.blocker) { res.refused.push({ id, name, why: i.blocker }); continue; }
        const bin = await removeVodAsset(id, { reason: `removed in bulk from the Media Library by ${by.label}`, by: by.label });
        const held = bin ? await one<{ purge_after: string }>(`SELECT purge_after FROM trash_items WHERE id = $1`, [bin]) : null;
        await writeAudit(null, { accountId, userId: by.userId, label: by.label, action: 'delete', entityType: 'vod_asset', entityId: id,
          snapshot: { title: name, bin, bulk: true } }).catch(() => {});
        res.done.push({ id, name, bin, purgeAfter: held?.purge_after ?? null });
      } catch (e: any) {
        res.refused.push({ id, name, why: e?.status === 404 ? 'This asset is not in this account (or was already removed).' : String(e?.message ?? e).slice(0, 300) });
      }
    }
    return res;
  },
};

export const BULK_ACTIONS: Record<string, BulkAction> = { 'vod.remove': vodRemove };

// ---------------------------------------------------------------- the rule

export async function needsApproval(accountId: string, by: BulkActor): Promise<boolean> {
  if (by.rank >= ADMIN_RANK) return false;
  const a = await one<{ bulk_needs_approval: boolean }>(`SELECT bulk_needs_approval FROM accounts WHERE id = $1`, [accountId]);
  return !!a?.bulk_needs_approval;
}

function actionOf(key: string): BulkAction {
  const a = BULK_ACTIONS[key];
  if (!a) throw Object.assign(new Error(`Unknown bulk action ${key}`), { status: 400 });
  return a;
}

export function cleanIds(ids: unknown): string[] {
  const list = Array.isArray(ids) ? [...new Set(ids.map(String).filter((x) => x.length > 0 && x.length <= 64))] : [];
  if (!list.length) throw Object.assign(new Error('Choose at least one item'), { status: 400 });
  if (list.length > MAX_BULK) throw Object.assign(new Error(`At most ${MAX_BULK} items at a time`), { status: 400 });
  return list;
}

export async function impactOf(accountId: string, key: string, ids: string[], by: BulkActor) {
  const items = await actionOf(key).impact(accountId, ids);
  return { action: key, label: actionOf(key).label, items, ready: items.filter((i) => !i.blocker).length, needsApproval: await needsApproval(accountId, by) };
}

/**
 * Run a bulk action, or turn it into a request when the account wants a
 * manager to confirm it. `confirm` must be the number of items: the console
 * asks the person to type it, and an API caller has to say it too.
 */
export async function runOrRequest(accountId: string, key: string, ids: string[], confirm: unknown, by: BulkActor, note?: string | null):
  Promise<{ ran: true; outcome: RunOutcome } | { ran: false; request: any }> {
  const action = actionOf(key);
  if (Number(confirm) !== ids.length) {
    throw Object.assign(new Error(`Confirm with the number of items (${ids.length}) to ${action.label.toLowerCase()}.`), { status: 400 });
  }
  if (await needsApproval(accountId, by)) {
    const items = (await action.impact(accountId, ids)).map((i) => ({ id: i.id, name: i.name }));
    const r = await one<any>(
      `INSERT INTO bulk_requests (account_id, action, item_ids, items, note, requested_by, requested_label)
       VALUES ($1, $2, $3::text[], $4::jsonb, $5, $6, $7) RETURNING *`,
      [accountId, key, ids, JSON.stringify(items), note ?? null, by.userId, by.label]);
    await writeAudit(null, { accountId, userId: by.userId, label: by.label, action: 'create', entityType: 'bulk_request', entityId: r.id,
      snapshot: { action: key, items: ids.length } }).catch(() => {});
    return { ran: false, request: view(r) };
  }
  return { ran: true, outcome: await action.run(accountId, ids, by) };
}

// ---------------------------------------------------------------- requests

export function view(r: any) {
  const a = BULK_ACTIONS[r.action];
  return {
    id: r.id, action: r.action, label: a?.label ?? r.action, count: (r.item_ids ?? []).length, items: r.items ?? [],
    note: r.note ?? null, state: r.state, requestedBy: r.requested_label ?? null, requestedById: r.requested_by ?? null,
    decidedBy: r.decided_label ?? null, decidedAt: r.decided_at ?? null, decisionNote: r.decision_note ?? null,
    result: r.result ?? null, createdAt: r.created_at, expiresAt: r.expires_at,
  };
}

async function expire(accountId: string) {
  await query(`UPDATE bulk_requests SET state = 'expired' WHERE account_id = $1 AND state = 'pending' AND expires_at < now()`, [accountId]);
}

export async function listRequests(accountId: string, opts: { pendingOnly?: boolean } = {}) {
  await expire(accountId);
  const rows = await query<any>(
    `SELECT * FROM bulk_requests WHERE account_id = $1 ${opts.pendingOnly ? `AND state = 'pending'` : `AND (state = 'pending' OR created_at > now() - interval '14 days')`}
      ORDER BY created_at DESC LIMIT 100`, [accountId]);
  return rows.map(view);
}

const fail = (status: number, m: string) => Object.assign(new Error(m), { status });

/** Approve (runs it now) or reject. An administrator or owner, never the person who asked. */
export async function decide(accountId: string, id: string, approve: boolean, by: BulkActor, note?: string | null) {
  await expire(accountId);
  if (by.rank < ADMIN_RANK) throw fail(403, 'An account administrator or owner confirms bulk actions.');
  const cur = await one<any>(`SELECT * FROM bulk_requests WHERE id = $1 AND account_id = $2`, [id, accountId]);
  if (!cur) throw fail(404, 'No such request');
  if (cur.state !== 'pending') throw fail(409, `This request is already ${cur.state}.`);
  if (cur.requested_by && by.userId && cur.requested_by === by.userId) throw fail(403, 'Someone other than the person who asked confirms it.');
  // Claim it first, so two managers pressing Approve at once run it once.
  const claimed = await one<any>(
    `UPDATE bulk_requests SET state = $3, decided_by = $4, decided_label = $5, decided_at = now(), decision_note = $6
      WHERE id = $1 AND account_id = $2 AND state = 'pending' RETURNING *`,
    [id, accountId, approve ? 'approved' : 'rejected', by.userId, by.label, note ?? null]);
  if (!claimed) throw fail(409, 'Someone else decided this request just now.');
  await writeAudit(null, { accountId, userId: by.userId, label: by.label, action: 'update', entityType: 'bulk_request', entityId: id,
    changes: { state: { from: 'pending', to: claimed.state } } }).catch(() => {});
  if (!approve) return { request: view(claimed), outcome: null };
  // Run as the person who approved it (the audit names them), on the items as they are now.
  const outcome = await actionOf(claimed.action).run(accountId, claimed.item_ids, by);
  const state = outcome.done.length || !outcome.refused.length ? 'approved' : 'failed';
  const done = await one<any>(`UPDATE bulk_requests SET result = $2::jsonb, state = $3 WHERE id = $1 RETURNING *`, [id, JSON.stringify(outcome), state]);
  return { request: view(done), outcome };
}

/** The person who asked can withdraw it while it waits. */
export async function cancel(accountId: string, id: string, by: BulkActor) {
  const cur = await one<any>(`SELECT * FROM bulk_requests WHERE id = $1 AND account_id = $2`, [id, accountId]);
  if (!cur) throw fail(404, 'No such request');
  if (cur.requested_by !== by.userId && by.rank < ADMIN_RANK) throw fail(403, 'Only the person who asked, or an administrator, withdraws a request.');
  const r = await one<any>(`UPDATE bulk_requests SET state = 'cancelled', decided_by = $3, decided_label = $4, decided_at = now()
     WHERE id = $1 AND account_id = $2 AND state = 'pending' RETURNING *`, [id, accountId, by.userId, by.label]);
  if (!r) throw fail(409, `This request is already ${cur.state}.`);
  return view(r);
}

/** Undo a bulk remove: every asset's latest bin item goes back. */
export async function restoreMany(accountId: string, ids: string[], by: BulkActor) {
  const { restoreItem } = await import('./media/trash');
  const res: { restored: { id: string; name: string }[]; missed: { id: string; why: string }[] } = { restored: [], missed: [] };
  for (const id of ids) {
    const item = await one<any>(
      `SELECT id, label FROM trash_items WHERE kind = 'vod_asset' AND subject_id::text = $1 AND account_id = $2 AND state = 'held'
        ORDER BY created_at DESC LIMIT 1`, [id, accountId]);
    if (!item) { res.missed.push({ id, why: 'not in the bin (already back, or purged)' }); continue; }
    try {
      await restoreItem(item.id, { accountId, by: by.label });
      await writeAudit(null, { accountId, userId: by.userId, label: by.label, action: 'update', entityType: 'vod_asset', entityId: id,
        changes: { restored: { from: false, to: true } }, snapshot: { title: item.label, bin: item.id, bulk: true } }).catch(() => {});
      res.restored.push({ id, name: item.label });
    } catch (e: any) { res.missed.push({ id, why: String(e?.message ?? e).slice(0, 200) }); }
  }
  return res;
}
