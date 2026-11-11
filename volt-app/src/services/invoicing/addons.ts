// ============================================================================
//  ADD-ONS AND PACKS AS BILLABLE ITEMS (build queue B2, Christian, 11 Nov
//  2026). Migration 0171. The ledger and invoices are in ./index.ts (B1).
//
//  Christian's rules:
//    * charged MONTHLY;
//    * turning an add-on on, or moving it to a bigger pack, charges the FULL
//      monthly price for the current month (no proration);
//    * reducing or turning off takes effect AT ONCE with NO REFUND;
//    * the allowance RESETS ON THE 1ST, with NO CARRY OVER.
//
//  How that is kept true:
//    * Every charge is a ledger row with a dedupe key per account, add-on (or
//      pack) and month. Turning an add-on off and on again in one month, or
//      going down a pack and back up, does not charge that month a second
//      time: the customer already paid for it and nothing was refunded.
//    * Before any change, this month's renewal rows are written for what the
//      account had, so a change on the 1st can never skip the month's charge.
//      The scheduler pass (closeDue in index.ts) writes them for everyone.
//    * A reduce or an off writes no row and lowers the allowance at once.
//    * Usage is one row per account, add-on and month (addon_usage): a new
//      month starts at zero, whatever was left.
//
//  The allowance check on a warm path reads no database: the account's
//  add-ons and this month's usage sit in the shared read-through cache
//  (scale/cache.ts) under the tag `addons:<account>`, dropped on every change
//  and on every process through the volt_cache channel.
// ============================================================================
import type { PoolClient } from 'pg';
import { query, one, tx } from '../../db';
import { ApiError } from '../../util/http';
import { writeAudit } from '../audit';
import { cached, invalidateTag } from '../../scale/cache';
import { notify } from '../../scale/notify';
import { LICENCES } from '../sites/licences';
import { billingMode, monthOf } from './index';

const cents = (n: number) => Math.round(n * 100) / 100;
const num = (v: any) => Number(v ?? 0);

export interface AddonPack { key: string; name: string; extraQuantity: number; monthlyUsd: number; active: boolean }
export interface Addon {
  key: string; name: string; description: string | null; monthlyUsd: number; includedQuantity: number; unit: string;
  licence: string | null; active: boolean; packs: AddonPack[];
}

export function isLicence(v: unknown): boolean { return v == null || (LICENCES as readonly string[]).includes(String(v)); }

// ---- the catalogue ------------------------------------------------------------

export async function catalogue(o: { activeOnly?: boolean } = {}, c?: PoolClient): Promise<Addon[]> {
  const q = async (sql: string, p: any[] = []) => (c ? (await c.query(sql, p)).rows : await query<any>(sql, p));
  const addons = await q(`SELECT * FROM billing_addons ${o.activeOnly ? 'WHERE active' : ''} ORDER BY name`);
  const packs = await q(`SELECT * FROM billing_addon_packs ${o.activeOnly ? 'WHERE active' : ''} ORDER BY extra_quantity, key`);
  return addons.map((a: any) => ({
    key: a.key, name: a.name, description: a.description ?? null, monthlyUsd: num(a.monthly_usd), includedQuantity: num(a.included_quantity),
    unit: a.unit, licence: a.licence ?? null, active: !!a.active,
    packs: packs.filter((p: any) => p.addon_key === a.key)
      .map((p: any) => ({ key: p.key, name: p.name, extraQuantity: num(p.extra_quantity), monthlyUsd: num(p.monthly_usd), active: !!p.active })),
  }));
}

export async function addonByKey(key: string, c?: PoolClient): Promise<Addon | null> {
  return (await catalogue({}, c)).find((a) => a.key === key) ?? null;
}

// ---- the cache ------------------------------------------------------------------

/** Drop an account's add-on state here and on every other process. */
export async function addonsChanged(accountId: string): Promise<void> {
  invalidateTag(`addons:${accountId}`);
  try { await notify('volt_cache', `addons:${accountId}`); } catch { /* the TTL is the backstop */ }
}

interface Held { addonKey: string; packKey: string | null; startedAt: string; allowance: number; used: number; month: string }

/** What an account has on and this month's usage, cached (no database read when warm). */
export function heldAddons(accountId: string): Promise<Held[]> {
  const month = monthOf();
  return cached<Held[]>(`addons:${accountId}:${month}`, { ttlSec: 60, tags: [`addons:${accountId}`] }, async () => {
    const rows = await query<any>(
      `SELECT h.addon_key, h.pack_key, h.started_at, a.included_quantity, COALESCE(p.extra_quantity, 0) AS extra, COALESCE(u.used, 0) AS used
         FROM account_addons h JOIN billing_addons a ON a.key = h.addon_key
         LEFT JOIN billing_addon_packs p ON p.addon_key = h.addon_key AND p.key = h.pack_key
         LEFT JOIN addon_usage u ON u.account_id = h.account_id AND u.addon_key = h.addon_key AND u.period_month = $2
        WHERE h.account_id = $1`, [accountId, month]);
    return rows.map((r) => ({ addonKey: r.addon_key, packKey: r.pack_key ?? null, startedAt: new Date(r.started_at).toISOString(),
      allowance: num(r.included_quantity) + num(r.extra), used: num(r.used), month }));
  });
}

// ---- charges ----------------------------------------------------------------------

async function charge(c: PoolClient, accountId: string, month: string, l: { source: 'addon' | 'addon_pack'; itemKey: string; description: string; unitUsd: number; dedupeKey: string }, by: { label: string; userId?: string | null }) {
  if (l.unitUsd <= 0) return false;
  const r = await c.query(
    `INSERT INTO billing_charges(account_id, period_month, source, item_key, description, quantity, unit, unit_usd, amount_usd, created_by, created_by_user, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,1,'month',$6,$6,$7,$8,$9) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [accountId, month, l.source, l.itemKey, l.description, cents(l.unitUsd), by.label, by.userId ?? null, l.dedupeKey]);
  return !!r.rows[0];
}

const baseLine = (accountId: string, a: Addon, month: string) => ({
  source: 'addon' as const, itemKey: `addon:${a.key}`, description: `${a.name}, ${month.slice(0, 7)}`, unitUsd: a.monthlyUsd,
  dedupeKey: `addon:${accountId}:${a.key}:${month}`,
});
const packLine = (accountId: string, a: Addon, p: AddonPack, month: string) => ({
  source: 'addon_pack' as const, itemKey: `addon_pack:${a.key}:${p.key}`, description: `${a.name}: ${p.name} (+${p.extraQuantity} ${a.unit}), ${month.slice(0, 7)}`,
  unitUsd: p.monthlyUsd, dedupeKey: `addon_pack:${accountId}:${a.key}:${p.key}:${month}`,
});

/**
 * The month's charge for every add-on an account had on before the month
 * began, at the catalogue's price now (written on the 1st, so that is the
 * price in force at the start of the month). Idempotent through the dedupe
 * keys. Called by the scheduler pass for every account, and before any change
 * for the account changing.
 */
export async function renewAddons(month = monthOf(), o: { accountId?: string; c?: PoolClient } = {}): Promise<number> {
  if (billingMode() === 'off') return 0;
  const run = async (c: PoolClient) => {
    const cat = new Map((await catalogue({}, c)).map((a) => [a.key, a]));
    const held = (await c.query(
      `SELECT account_id, addon_key, pack_key FROM account_addons WHERE started_at < $1::date ${o.accountId ? 'AND account_id = $2' : ''}`,
      o.accountId ? [month, o.accountId] : [month])).rows;
    let n = 0;
    for (const h of held) {
      const a = cat.get(h.addon_key); if (!a) continue;
      if (await charge(c, h.account_id, month, baseLine(h.account_id, a, month), { label: 'volt' })) n++;
      const p = a.packs.find((x) => x.key === h.pack_key);
      if (p && await charge(c, h.account_id, month, packLine(h.account_id, a, p, month), { label: 'volt' })) n++;
    }
    return n;
  };
  return o.c ? run(o.c) : tx(run);
}

// ---- the account's view ---------------------------------------------------------------

export async function accountAddons(accountId: string) {
  const month = monthOf();
  const [cat, held, charged] = await Promise.all([
    catalogue(),
    heldAddons(accountId),
    query<any>(`SELECT item_key, amount_usd FROM billing_charges WHERE account_id = $1 AND period_month = $2 AND source IN ('addon','addon_pack')`, [accountId, month]),
  ]);
  const paid = new Set(charged.map((c) => c.item_key));
  return cat
    .filter((a) => a.active || held.some((h) => h.addonKey === a.key))
    .map((a) => {
      const h = held.find((x) => x.addonKey === a.key) ?? null;
      return {
        key: a.key, name: a.name, description: a.description, monthlyUsd: a.monthlyUsd, includedQuantity: a.includedQuantity, unit: a.unit,
        licence: a.licence, offered: a.active,
        packs: a.packs.filter((p) => p.active || p.key === h?.packKey).map((p) => ({ ...p, paidThisMonth: paid.has(`addon_pack:${a.key}:${p.key}`) })),
        on: !!h, pack: h?.packKey ?? null, since: h?.startedAt ?? null,
        paidThisMonth: paid.has(`addon:${a.key}`),
        allowance: h ? { period: month.slice(0, 7), included: h.allowance, used: h.used, left: Math.max(0, cents(h.allowance - h.used)), resets: nextFirst() } : null,
      };
    });
}

function nextFirst(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

// ---- turning on, changing the pack, turning off --------------------------------------------

export interface ChangeResult { addonKey: string; on: boolean; pack: string | null; charged: { itemKey: string; amountUsd: number }[]; change: 'on' | 'upgrade' | 'reduce' | 'same' | 'off' }

/**
 * Turn an add-on on, or move it to another pack (null: no pack). On, or a
 * bigger pack, charges the full monthly price for this month unless this
 * month is already paid for that item; a smaller pack, or none, is at once
 * and charges nothing.
 */
export async function setAddon(accountId: string, addonKey: string, packKey: string | null, who: { userId: string | null; label: string }): Promise<ChangeResult> {
  if (billingMode() === 'off') throw new ApiError(409, 'Billing is off on this deployment, so add-ons are switched on by the System Admin.');
  const month = monthOf();
  const r = await tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('billing:' || $1))`, [accountId]);
    const a = await addonByKey(addonKey, c);
    if (!a) throw new ApiError(404, 'Add-on not found');
    const cur = (await c.query(`SELECT * FROM account_addons WHERE account_id = $1 AND addon_key = $2`, [accountId, addonKey])).rows[0];
    if (!cur && !a.active) throw new ApiError(409, `${a.name} is no longer offered.`);
    const pack = packKey == null ? null : a.packs.find((p) => p.key === packKey);
    if (packKey != null && !pack) throw new ApiError(404, 'Pack not found');
    if (pack && !pack.active && cur?.pack_key !== pack.key) throw new ApiError(409, `${pack.name} is no longer offered.`);

    // Whatever the account had before this month began is charged for this
    // month first, so a change made on the 1st cannot skip it.
    await renewAddons(month, { accountId, c });

    const charged: ChangeResult['charged'] = [];
    const by = { label: who.label, userId: who.userId };
    const was = cur ? a.packs.find((p) => p.key === cur.pack_key) ?? null : null;
    let change: ChangeResult['change'];
    if (!cur) {
      change = 'on';
      const l = baseLine(accountId, a, month);
      if (await charge(c, accountId, month, l, by)) charged.push({ itemKey: l.itemKey, amountUsd: cents(l.unitUsd) });
      let granted = false;
      if (a.licence) {
        const lic = (await c.query(`SELECT licences FROM accounts WHERE id = $1 FOR UPDATE`, [accountId])).rows[0]?.licences ?? [];
        if (!lic.includes(a.licence)) {
          granted = true;
          await c.query(`UPDATE accounts SET licences = array_append(COALESCE(licences, '{}'), $2), updated_at = now() WHERE id = $1`, [accountId, a.licence]);
        }
      }
      await c.query(`INSERT INTO account_addons(account_id, addon_key, pack_key, granted_licence) VALUES ($1,$2,$3,$4)`, [accountId, addonKey, pack?.key ?? null, granted]);
    } else {
      const before = was?.extraQuantity ?? 0, after = pack?.extraQuantity ?? 0;
      change = (pack?.key ?? null) === (cur.pack_key ?? null) ? 'same' : after > before ? 'upgrade' : 'reduce';
      if (change !== 'same') await c.query(`UPDATE account_addons SET pack_key = $3, updated_at = now() WHERE account_id = $1 AND addon_key = $2`, [accountId, addonKey, pack?.key ?? null]);
    }
    if (pack && (change === 'on' || change === 'upgrade')) {
      const l = packLine(accountId, a, pack, month);
      if (await charge(c, accountId, month, l, by)) charged.push({ itemKey: l.itemKey, amountUsd: cents(l.unitUsd) });
    }
    if (change !== 'same') {
      await writeAudit(c, { accountId, userId: who.userId, label: who.label, action: change === 'on' ? 'create' : 'update', entityType: 'account_addon', entityId: accountId,
        changes: change === 'on' ? undefined : { pack: { from: cur?.pack_key ?? null, to: pack?.key ?? null } },
        snapshot: { addon: addonKey, change, pack: pack?.key ?? null, charged } });
    }
    return { addonKey, on: true, pack: pack?.key ?? null, charged, change };
  });
  await addonsChanged(accountId);
  return r;
}

/** Turn an add-on off: at once, no refund, and the licence it gave goes with it. */
export async function turnOffAddon(accountId: string, addonKey: string, who: { userId: string | null; label: string }): Promise<ChangeResult> {
  if (billingMode() === 'off') throw new ApiError(409, 'Billing is off on this deployment, so add-ons are switched on by the System Admin.');
  const r = await tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('billing:' || $1))`, [accountId]);
    const cur = (await c.query(`SELECT * FROM account_addons WHERE account_id = $1 AND addon_key = $2`, [accountId, addonKey])).rows[0];
    if (!cur) throw new ApiError(404, 'This add-on is not on for the account.');
    // Charged for this month before it goes, if it was on when the month began.
    await renewAddons(monthOf(), { accountId, c });
    const a = await addonByKey(addonKey, c);
    await c.query(`DELETE FROM account_addons WHERE account_id = $1 AND addon_key = $2`, [accountId, addonKey]);
    if (cur.granted_licence && a?.licence) {
      await c.query(`UPDATE accounts SET licences = array_remove(licences, $2), updated_at = now() WHERE id = $1`, [accountId, a.licence]);
    }
    await writeAudit(c, { accountId, userId: who.userId, label: who.label, action: 'delete', entityType: 'account_addon', entityId: accountId,
      snapshot: { addon: addonKey, change: 'off', pack: cur.pack_key ?? null, licenceRemoved: cur.granted_licence && a?.licence ? a.licence : null } });
    return { addonKey, on: false, pack: null, charged: [], change: 'off' as const };
  });
  await addonsChanged(accountId);
  return r;
}

// ---- usage against the allowance ----------------------------------------------------------

export class AllowanceExceeded extends ApiError {
  code = 'allowance_exceeded';
  constructor(public addon: string, public left: number, unit: string) {
    super(409, `The ${addon} allowance for this month is used up (${left} ${unit} left). Move to a bigger pack, or wait for the 1st.`);
  }
}

/** How much of an add-on's allowance is left this month; null when the account does not have it. Warm: no database read. */
export async function allowanceLeft(accountId: string, addonKey: string): Promise<number | null> {
  const h = (await heldAddons(accountId)).find((x) => x.addonKey === addonKey);
  return h ? Math.max(0, cents(h.allowance - h.used)) : null;
}

/**
 * Count `quantity` against this month's allowance. Over the allowance it is
 * refused (nothing counted). The cached state turns away an account already
 * over without touching the database; the write itself is guarded in SQL, so
 * two processes racing for the last unit cannot both have it.
 */
export async function useAllowance(accountId: string, addonKey: string, quantity: number): Promise<{ used: number; left: number }> {
  if (!(quantity > 0)) throw new ApiError(400, 'quantity must be more than zero');
  const month = monthOf();
  const held = (await heldAddons(accountId)).find((x) => x.addonKey === addonKey);
  const a = await addonByKey(addonKey);
  if (!held || !a) throw Object.assign(new ApiError(403, `This account does not have the ${a?.name ?? addonKey} add-on.`), { code: 'addon_required' });
  const enforce = billingMode() !== 'off';
  if (enforce && held.used + quantity > held.allowance) throw new AllowanceExceeded(a.name, Math.max(0, cents(held.allowance - held.used)), a.unit);
  const r = await one<any>(
    `INSERT INTO addon_usage(account_id, addon_key, period_month, used) SELECT $1,$2,$3::date,$4::numeric WHERE (NOT $6::boolean) OR $4::numeric <= $5::numeric
     ON CONFLICT (account_id, addon_key, period_month) DO UPDATE SET used = addon_usage.used + EXCLUDED.used, updated_at = now()
       WHERE (NOT $6::boolean) OR addon_usage.used + EXCLUDED.used <= $5::numeric
     RETURNING used`, [accountId, addonKey, month, quantity, held.allowance, enforce]);
  await addonsChanged(accountId);
  if (!r) {
    const now = await one<any>(`SELECT used FROM addon_usage WHERE account_id = $1 AND addon_key = $2 AND period_month = $3`, [accountId, addonKey, month]);
    throw new AllowanceExceeded(a.name, Math.max(0, cents(held.allowance - num(now?.used))), a.unit);
  }
  return { used: num(r.used), left: Math.max(0, cents(held.allowance - num(r.used))) };
}
