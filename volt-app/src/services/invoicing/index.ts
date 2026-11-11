// ============================================================================
//  BILLING: THE CHARGES LEDGER AND MONTHLY INVOICES (build queue B1, Christian,
//  11 Nov 2026). Migration 0169.
//
//  Three switches decide what happens:
//    * VOLT_BILLING, for the whole deployment: `off` (the default, and what a
//      plain Mac run gets: nothing is charged or invoiced), `contract`
//      (charges and invoices are worked out and shown, settled outside Volt)
//      or `automated` (as contract, and invoices are charged through Stripe).
//    * accounts.billing_handling, set by the System Admin: `automated` or
//      `contract`. A `contract` deployment treats every account as contract,
//      whatever the column says, so flipping the deployment never needs a
//      data change.
//    * VOLT_BILLING_TAX_RATE (a fraction, 0 by default) or the account's own
//      billing_tax_rate.
//
//  THE LEDGER IS THE TRUTH; INVOICES ARE READ FROM IT. Every charge is a row
//  with its price frozen on it (plan fee, metered usage at the price list,
//  a System Admin's manual charge or credit; add-ons and packs come with B2).
//  Rows are never edited, a correction is a new row. Closing a month turns
//  that month's rows into one numbered invoice per account. The draft is the
//  open month itself: the same lines worked out live and not yet written.
//
//  Charging an `automated` invoice in Stripe and its paid or failed webhook
//  are in stripe.ts (B1-2); the PDF in pdf.ts.
// ============================================================================
import type { PoolClient } from 'pg';
import { query, one, tx } from '../../db';
import { planByKey } from '../saasPlans';
import { ApiError } from '../../util/http';
import { writeAudit } from '../audit';

export type BillingMode = 'off' | 'contract' | 'automated';
export type Handling = 'automated' | 'contract';

export function billingMode(): BillingMode {
  const m = String(process.env.VOLT_BILLING ?? 'off').trim().toLowerCase();
  return m === 'contract' || m === 'automated' ? m : 'off';
}

/** How an account's invoices are settled, after the deployment has its say. */
export function effectiveHandling(stored: string | null | undefined): Handling {
  if (billingMode() === 'contract') return 'contract';
  return stored === 'contract' ? 'contract' : 'automated';
}

export function deploymentTaxRate(): number {
  const n = Number(process.env.VOLT_BILLING_TAX_RATE ?? 0);
  return Number.isFinite(n) && n >= 0 && n < 1 ? n : 0;
}

// ---- months (UTC calendar months, as 'YYYY-MM-01') ---------------------------

export function monthOf(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}
export function nextMonth(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  return monthOf(new Date(Date.UTC(y, mo, 1)));
}
export function previousMonth(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  return monthOf(new Date(Date.UTC(y, mo - 2, 1)));
}
export function parseMonth(s: string): string {
  const m = /^(\d{4})-(\d{2})(?:-01)?$/.exec(String(s ?? '').trim());
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new ApiError(400, 'month must look like 2026-10');
  return `${m[1]}-${m[2]}-01`;
}

const cents = (n: number) => Math.round(n * 100) / 100;
const iso = (d: any) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

// ---- the price list ---------------------------------------------------------

export interface Price { unitUsd: number; name: string; unit: string }

/**
 * The customer price for a unit in force at `at`. A row for the exact
 * instance type beats a row for any type. Null when nothing is priced: that
 * unit is then not charged, and the close lists it as unpriced, rather than
 * charging zero (which would read as "free") or guessing.
 */
export async function priceFor(unitKey: string, instanceType: string | null, at: string, c?: PoolClient): Promise<Price | null> {
  const sql = `SELECT unit_usd, name, unit FROM billing_prices
                WHERE unit_key = $1 AND (instance_type IS NULL OR instance_type = $2) AND effective_from <= $3::timestamptz
                ORDER BY (instance_type IS NULL), effective_from DESC LIMIT 1`;
  const p = [unitKey, instanceType, at];
  const r = c ? (await c.query(sql, p)).rows[0] : await one<any>(sql, p);
  return r ? { unitUsd: Number(r.unit_usd), name: r.name, unit: r.unit } : null;
}

// ---- what Volt charges by itself --------------------------------------------

export interface ChargeLine {
  source: 'plan' | 'addon' | 'addon_pack' | 'usage' | 'manual';
  itemKey: string; description: string;
  quantity: number; unit: string; unitUsd: number; amountUsd: number;
  dedupeKey?: string | null;
}

export interface AutoResult { lines: ChargeLine[]; unpriced: { unitKey: string; instanceType: string | null; quantity: number; unit: string }[]; notes: string[] }

/**
 * The plan fee and metered usage for one account and month, worked out but
 * not written. The open month's draft shows these; the close writes them.
 */
export async function autoCharges(accountId: string, month: string, c?: PoolClient): Promise<AutoResult> {
  const q = async (sql: string, p: any[]) => (c ? (await c.query(sql, p)).rows : await query<any>(sql, p));
  const out: AutoResult = { lines: [], unpriced: [], notes: [] };
  const end = nextMonth(month);
  const acc = (await q(`SELECT id, plan_tier, subscription_fee_month, status, created_at FROM accounts WHERE id = $1`, [accountId]))[0];
  if (!acc) return out;

  // PLAN FEE. An account's own fee (an agreed contract figure) beats its plan's
  // list price. An account made after the month, or still waiting for its
  // first payment, owes nothing for it.
  const own = Number(acc.subscription_fee_month ?? 0);
  const plan = planByKey(acc.plan_tier);
  const fee = own > 0 ? own : plan?.monthlyUsd ?? 0;
  const subscribed = (await q(
    `SELECT 1 FROM saas_signups WHERE account_id = $1 AND status = 'active' AND stripe_subscription_id IS NOT NULL LIMIT 1`, [accountId]))[0];
  if (fee > 0 && acc.status !== 'pending' && new Date(acc.created_at) < new Date(`${end}T00:00:00Z`)) {
    if (subscribed && own <= 0) {
      // Collected by the Stripe subscription made at sign-up: billing it here
      // too would charge it twice.
      out.notes.push('The plan fee is collected by the Stripe subscription made at sign-up, so it is not on this invoice.');
    } else {
      out.lines.push({
        source: 'plan', itemKey: `plan:${acc.plan_tier}`,
        description: `${plan?.name ?? acc.plan_tier} plan, ${month.slice(0, 7)}`,
        quantity: 1, unit: 'month', unitUsd: fee, amountUsd: cents(fee),
        dedupeKey: `plan:${accountId}:${month}`,
      });
    }
  }

  // SERVER TIME, from the meter's own seconds (usage_accruals), per instance
  // type, at the customer price in force at the start of the month.
  const usage = await q(
    `SELECT instance_type, sum(seconds)::bigint AS s FROM usage_accruals
      WHERE account_id = $1 AND from_at >= $2::date AND from_at < $3::date
      GROUP BY instance_type ORDER BY instance_type NULLS LAST`, [accountId, month, end]);
  for (const u of usage) {
    const hours = Math.round((Number(u.s) / 3600) * 10000) / 10000;
    if (hours <= 0) continue;
    const price = await priceFor('server_hour', u.instance_type ?? null, `${month}T00:00:00Z`, c);
    if (!price) { out.unpriced.push({ unitKey: 'server_hour', instanceType: u.instance_type ?? null, quantity: hours, unit: 'hour' }); continue; }
    out.lines.push({
      source: 'usage', itemKey: `server_hour:${u.instance_type ?? 'any'}`,
      description: `${price.name}${u.instance_type ? ` (${u.instance_type})` : ''}`,
      quantity: hours, unit: price.unit, unitUsd: price.unitUsd, amountUsd: cents(hours * price.unitUsd),
      dedupeKey: `usage:server_hour:${u.instance_type ?? 'any'}:${accountId}:${month}`,
    });
  }
  return out;
}

async function insertCharge(c: PoolClient, accountId: string, month: string, l: ChargeLine, by: { label: string; userId?: string | null; reference?: string | null }) {
  const r = await c.query(
    `INSERT INTO billing_charges(account_id, period_month, source, item_key, description, quantity, unit, unit_usd, amount_usd, created_by, created_by_user, reference, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [accountId, month, l.source, l.itemKey, l.description, l.quantity, l.unit, l.unitUsd, l.amountUsd, by.label, by.userId ?? null, by.reference ?? null, l.dedupeKey ?? null]);
  return r.rows[0]?.id ?? null;
}

// ---- manual charges and credits ---------------------------------------------

/**
 * A System Admin's charge (positive) or credit (negative), on the open month
 * by default. A month already invoiced for the account is refused: the
 * correction goes on the next invoice as its own line.
 */
export async function addManualCharge(o: { accountId: string; amountUsd: number; description: string; reference?: string | null; month?: string; userId: string | null }) {
  if (billingMode() === 'off') throw new ApiError(409, 'Billing is off on this deployment (VOLT_BILLING), so nothing can be charged.');
  const month = o.month ?? monthOf();
  if (!(await one(`SELECT 1 FROM accounts WHERE id = $1`, [o.accountId]))) throw new ApiError(404, 'Account not found');
  return tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('billing:' || $1))`, [o.accountId]);
    const inv = (await c.query(`SELECT number FROM billing_invoices WHERE account_id = $1 AND period_month = $2`, [o.accountId, month])).rows[0];
    if (inv) throw new ApiError(409, `${month.slice(0, 7)} is already invoiced (${inv.number}). Add it to the current month instead.`);
    const amt = cents(o.amountUsd);
    const id = await insertCharge(c, o.accountId, month, {
      source: 'manual', itemKey: amt < 0 ? 'credit' : 'charge', description: o.description,
      quantity: 1, unit: 'item', unitUsd: amt, amountUsd: amt,
    }, { label: 'system-admin', userId: o.userId, reference: o.reference ?? null });
    return (await c.query(`SELECT * FROM billing_charges WHERE id = $1`, [id])).rows[0];
  });
}

// ---- the draft (the open month, live) -----------------------------------------

export async function draftFor(accountId: string, month = monthOf()) {
  const acc = await one<any>(`SELECT billing_handling, billing_tax_rate FROM accounts WHERE id = $1`, [accountId]);
  const written = await query<any>(
    `SELECT source, item_key, description, quantity, unit, unit_usd, amount_usd, dedupe_key FROM billing_charges
      WHERE account_id = $1 AND period_month = $2 AND invoice_id IS NULL ORDER BY id`, [accountId, month]);
  const auto = await autoCharges(accountId, month);
  const have = new Set(written.map((w) => w.dedupe_key).filter(Boolean));
  const lines = [
    ...auto.lines.filter((l) => !have.has(l.dedupeKey)).map((l) => ({ ...l, sofar: l.source === 'usage' })),
    ...written.map((w) => ({ source: w.source, itemKey: w.item_key, description: w.description, quantity: Number(w.quantity), unit: w.unit, unitUsd: Number(w.unit_usd), amountUsd: Number(w.amount_usd), sofar: false })),
  ];
  return { period: month.slice(0, 7), handling: effectiveHandling(acc?.billing_handling), ...totals(lines, acc), lines, unpriced: auto.unpriced, notes: auto.notes };
}

function totals(lines: { amountUsd: number }[], acc: any) {
  const subtotal = cents(lines.reduce((n, l) => n + Number(l.amountUsd), 0));
  const taxRate = acc?.billing_tax_rate != null ? Number(acc.billing_tax_rate) : deploymentTaxRate();
  const tax = cents(subtotal * taxRate);
  return { currency: 'USD', subtotalUsd: subtotal, taxRate, taxUsd: tax, totalUsd: cents(subtotal + tax) };
}

// ---- closing a month ----------------------------------------------------------

export interface CloseResult { month: string; issued: { accountId: string; invoiceId: string; number: string; totalUsd: number }[]; existing: number; nothingToBill: number; unpriced: { accountId: string; unitKey: string; instanceType: string | null; quantity: number }[]; off?: true }

/**
 * Close a finished month: write the plan fee and usage rows, then gather the
 * month's rows into one numbered invoice per account. Idempotent: an account
 * already invoiced for the month is left alone, and the automatic rows carry a
 * dedupe key, so running it twice (two tasks, a retry) never charges twice.
 */
export async function closeMonth(month: string, o: { accountId?: string; userId?: string | null } = {}): Promise<CloseResult> {
  const res: CloseResult = { month: month.slice(0, 7), issued: [], existing: 0, nothingToBill: 0, unpriced: [] };
  if (billingMode() === 'off') return { ...res, off: true };
  if (month >= monthOf()) throw new ApiError(409, `${month.slice(0, 7)} has not finished yet; a month closes once it is over.`);
  const accounts = o.accountId
    ? await query<any>(`SELECT id FROM accounts WHERE id = $1`, [o.accountId])
    : await query<any>(`SELECT id FROM accounts WHERE created_at < $1::date ORDER BY created_at`, [nextMonth(month)]);
  for (const a of accounts) {
    const r = await tx(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('billing:' || $1))`, [a.id]);
      if ((await c.query(`SELECT 1 FROM billing_invoices WHERE account_id = $1 AND period_month = $2`, [a.id, month])).rows[0]) return 'existing' as const;
      const auto = await autoCharges(a.id, month, c);
      for (const u of auto.unpriced) res.unpriced.push({ accountId: a.id, unitKey: u.unitKey, instanceType: u.instanceType, quantity: u.quantity });
      for (const l of auto.lines) await insertCharge(c, a.id, month, l, { label: 'volt' });
      const rows = (await c.query(
        `SELECT id, amount_usd FROM billing_charges WHERE account_id = $1 AND period_month = $2 AND invoice_id IS NULL ORDER BY id`, [a.id, month])).rows;
      if (!rows.length) return 'none' as const;
      const acc = (await c.query(`SELECT billing_handling, billing_tax_rate FROM accounts WHERE id = $1`, [a.id])).rows[0];
      const t = totals(rows.map((x: any) => ({ amountUsd: Number(x.amount_usd) })), acc);
      const seq = (await c.query(`SELECT nextval('billing_invoice_number') AS n`)).rows[0].n;
      const number = `V${month.slice(0, 4)}${month.slice(5, 7)}-${String(seq).padStart(6, '0')}`;
      const inv = (await c.query(
        `INSERT INTO billing_invoices(account_id, period_month, number, status, handling, subtotal_usd, tax_rate, tax_usd, total_usd)
         VALUES ($1,$2,$3,'issued',$4,$5,$6,$7,$8) RETURNING id`,
        [a.id, month, number, effectiveHandling(acc?.billing_handling), t.subtotalUsd, t.taxRate, t.taxUsd, t.totalUsd])).rows[0];
      await c.query(`UPDATE billing_charges SET invoice_id = $1 WHERE id = ANY($2::bigint[])`, [inv.id, rows.map((x: any) => x.id)]);
      await writeAudit(c, { accountId: a.id, userId: o.userId ?? null, label: o.userId ? 'system-admin' : 'volt', action: 'create', entityType: 'invoice', entityId: inv.id,
        snapshot: { number, month: month.slice(0, 7), totalUsd: t.totalUsd } });
      return { accountId: a.id, invoiceId: inv.id, number, totalUsd: t.totalUsd };
    });
    if (r === 'existing') res.existing++;
    else if (r === 'none') res.nothingToBill++;
    else res.issued.push(r);
  }
  return res;
}

// ---- reading invoices ----------------------------------------------------------

export function invoiceView(r: any) {
  return {
    id: r.id, accountId: r.account_id, number: r.number, period: iso(r.period_month).slice(0, 7), status: r.status, handling: r.handling,
    currency: r.currency, subtotalUsd: Number(r.subtotal_usd), taxRate: Number(r.tax_rate), taxUsd: Number(r.tax_usd), totalUsd: Number(r.total_usd),
    issuedAt: r.issued_at, paidAt: r.paid_at, paidReference: r.paid_reference, failedAt: r.failed_at ?? null,
  };
}

/** The System Admin's view adds where the invoice stands with Stripe. */
export function invoiceAdminView(r: any) {
  return { ...invoiceView(r), stripeInvoiceId: r.stripe_invoice_id ?? null, stripeSentAt: r.stripe_sent_at ?? null, stripeError: r.stripe_error ?? null, stripeAttempts: Number(r.stripe_attempts ?? 0) };
}

export async function invoiceWithLines(id: string, accountId?: string, admin = false) {
  const r = await one<any>(`SELECT * FROM billing_invoices WHERE id = $1 ${accountId ? 'AND account_id = $2' : ''}`, accountId ? [id, accountId] : [id]);
  if (!r) return null;
  const lines = await query<any>(
    `SELECT source, item_key, description, quantity, unit, unit_usd, amount_usd, reference, created_by, created_at FROM billing_charges WHERE invoice_id = $1 ORDER BY id`, [id]);
  return {
    ...(admin ? invoiceAdminView(r) : invoiceView(r)),
    lines: lines.map((l) => ({ source: l.source, itemKey: l.item_key, description: l.description, quantity: Number(l.quantity), unit: l.unit, unitUsd: Number(l.unit_usd), amountUsd: Number(l.amount_usd), reference: l.reference })),
  };
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  // A leading = + - @ would run as a formula in a spreadsheet; a quote stops it.
  const safe = /^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function invoiceCsv(inv: NonNullable<Awaited<ReturnType<typeof invoiceWithLines>>>): string {
  const rows: unknown[][] = [['invoice', 'period', 'description', 'quantity', 'unit', 'unit_usd', 'amount_usd']];
  for (const l of inv.lines) rows.push([inv.number, inv.period, l.description, l.quantity, l.unit, l.unitUsd.toFixed(6).replace(/0{1,4}$/, ''), l.amountUsd.toFixed(2)]);
  rows.push([inv.number, inv.period, 'Subtotal', '', '', '', inv.subtotalUsd.toFixed(2)]);
  rows.push([inv.number, inv.period, `Tax (${(inv.taxRate * 100).toFixed(2).replace(/\.?0+$/, '')}%)`, '', '', '', inv.taxUsd.toFixed(2)]);
  rows.push([inv.number, inv.period, 'Total (USD)', '', '', '', inv.totalUsd.toFixed(2)]);
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// ---- settling a contract invoice ------------------------------------------------

export async function markPaid(id: string, reference: string, userId: string | null) {
  const r = await one<any>(`SELECT * FROM billing_invoices WHERE id = $1`, [id]);
  if (!r) throw new ApiError(404, 'Invoice not found');
  if (r.handling !== 'contract') throw new ApiError(409, 'This invoice is settled through Stripe; it is marked paid when Stripe says so.');
  if (r.status === 'paid') throw new ApiError(409, `Already marked paid (${r.paid_reference ?? 'no reference'}).`);
  if (r.status === 'void') throw new ApiError(409, 'This invoice is void.');
  const u = await one<any>(
    `UPDATE billing_invoices SET status = 'paid', paid_at = now(), paid_reference = $2, paid_by = $3, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, reference, userId]);
  return invoiceView(u);
}

// ---- the close on the 1st ---------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null;
let closedThrough: string | null = null;
export const closeStats = { runs: 0, lastMonth: null as string | null, lastIssued: 0, lastError: null as string | null };

/** One pass: close last month if this process has not seen it closed yet. */
export async function closeDue(): Promise<CloseResult | null> {
  if (billingMode() === 'off') return null;
  const due = previousMonth(monthOf());
  // Automated invoices still to reach Stripe (a fresh close, or a send that failed last pass).
  const pushPending = async () => { try { await (await import('./stripe')).sendPendingToStripe(); } catch (e) { console.error('[billing] sending to Stripe failed', (e as Error).message); } };
  if (closedThrough === due) { await pushPending(); return null; }
  const r = await closeMonth(due);
  closedThrough = due;
  await pushPending();
  closeStats.runs++; closeStats.lastMonth = due.slice(0, 7); closeStats.lastIssued = r.issued.length; closeStats.lastError = null;
  if (r.issued.length) console.log(`[billing] closed ${due.slice(0, 7)}: ${r.issued.length} invoice(s) issued`);
  return r;
}

/** Started by the scheduler leader (index.ts). Checks every ten minutes. */
export function startInvoiceClose(): () => void {
  if (timer) return () => {};
  const run = () => { closeDue().catch((e) => { closeStats.lastError = (e as Error).message; console.error('[billing] month close failed, tried again in ten minutes', (e as Error).message); }); };
  setTimeout(run, 30_000).unref?.();
  timer = setInterval(run, 10 * 60_000); timer.unref?.();
  return () => { if (timer) clearInterval(timer); timer = null; };
}
