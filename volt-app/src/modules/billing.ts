// ============================================================================
//  BILLING ROUTES (build queue B1; services/invoicing).
//
//    /api/billing            the account's own: this month so far, invoices,
//                            an invoice's lines and its CSV. Account settings:
//                            View (auth/roles.ts), because an invoice is the
//                            account's business, not every operator's.
//    /api/platform/billing   the System Admin's: every account's handling and
//                            tax rate, open invoices, mark paid, manual
//                            charges and credits, the price list, closing a
//                            month by hand (the scheduler closes it on the 1st).
// ============================================================================
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { requirePlatform } from '../auth/platform';
import { asyncHandler, notFound, conflict } from '../util/http';
import { defineList, parseList, whereSql, pageSql, finishPage } from '../util/listQuery';
import { writeAudit } from '../services/audit';
import {
  billingMode, effectiveHandling, deploymentTaxRate, draftFor, invoiceView, invoiceWithLines, invoiceCsv,
  addManualCharge, closeMonth, markPaid, parseMonth, previousMonth, monthOf, invoiceAdminView,
} from '../services/invoicing';
import { invoicePdf } from '../services/invoicing/pdf';
import { sendInvoiceToStripe, paymentMethodState, portalSession } from '../services/invoicing/stripe';
import { consoleBase } from '../services/onboarding';
import { catalogue, accountAddons, setAddon, turnOffAddon, isLicence, addonsChanged } from '../services/invoicing/addons';

/** Send an invoice as a PDF download, named by its number. */
async function sendPdf(res: any, inv: any) {
  const a = await one<any>(`SELECT name FROM accounts WHERE id = $1`, [inv.accountId]);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${inv.number}.pdf"`);
  res.send(invoicePdf(inv, { accountName: a?.name ?? '' }));
}

export const billingRouter = Router();
billingRouter.use(requireAuth);

const invoiceList = defineList({
  path: '/api/billing/invoices',
  fields: {
    id: { sql: 'id', type: 'uuid' },
    number: { sql: 'number', type: 'string' },
    period_month: { sql: 'period_month', type: 'timestamp', notNull: true },
    status: { sql: 'status', type: 'enum', values: ['issued', 'paid', 'failed', 'void'] },
    total_usd: { sql: 'total_usd', type: 'number' },
    issued_at: { sql: 'issued_at', type: 'timestamp', notNull: true },
  },
  search: ['number'],
  defaultSort: '-period_month',
  unpagedLimit: 120,
  defaultLimit: 24,
  maxLimit: 120,
});

/** This month so far and the latest invoices, in one call for the Billing page. */
billingRouter.get('/', asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const acc = accountId(req);
  const mode = billingMode();
  const a = await one<any>(`SELECT billing_handling FROM accounts WHERE id = $1`, [acc]);
  const invoices = (await query<any>(`SELECT * FROM billing_invoices WHERE account_id = $1 ORDER BY period_month DESC LIMIT 12`, [acc])).map(invoiceView);
  res.json({
    mode, handling: effectiveHandling(a?.billing_handling), currency: 'USD',
    paymentMethod: paymentMethodState(mode, effectiveHandling(a?.billing_handling)),
    // Off: nothing is charged, so there is no month to show (earlier invoices still are).
    currentMonth: mode === 'off' ? null : await draftFor(acc),
    invoices,
    _links: { self: { href: '/api/billing' }, invoices: { href: '/api/billing/invoices' } },
  });
}));

/**
 * Open Stripe's customer portal to change the card (build queue B1-3). A POST,
 * so it needs Account settings: Manage (auth/roles.ts): seeing the invoices is
 * not the same as changing how they are paid.
 */
billingRouter.post('/portal', asyncHandler(async (req, res) => {
  const acc = accountId(req);
  const a = await one<any>(`SELECT billing_handling FROM accounts WHERE id = $1`, [acc]);
  const st = paymentMethodState(billingMode(), effectiveHandling(a?.billing_handling));
  if (!st.portal) throw conflict(st.reason ?? 'There is no card to change.');
  res.json({ url: await portalSession(acc, `${consoleBase()}/billing`) });
}));

// ---- add-ons and packs (build queue B2, services/invoicing/addons.ts) ---------
// Reading them is Account settings: View; turning one on, changing its pack or
// turning it off is a POST/PUT/DELETE, so Account settings: Manage
// (auth/roles.ts): an account administrator, as Christian asked.

billingRouter.get('/addons', asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ mode: billingMode(), currency: 'USD', addons: await accountAddons(accountId(req)), _links: { self: { href: '/api/billing/addons' } } });
}));

const addonPut = z.object({ pack: z.string().trim().min(1).max(40).nullable().optional() }).strict();

billingRouter.put('/addons/:key', asyncHandler(async (req, res) => {
  const b = addonPut.parse(req.body ?? {});
  const r = await setAddon(accountId(req), String(req.params.key), b.pack ?? null, { userId: req.auth!.sub, label: 'account-admin' });
  res.json({ ...r, addon: (await accountAddons(accountId(req))).find((a) => a.key === r.addonKey) ?? null });
}));

billingRouter.delete('/addons/:key', asyncHandler(async (req, res) => {
  res.json(await turnOffAddon(accountId(req), String(req.params.key), { userId: req.auth!.sub, label: 'account-admin' }));
}));

billingRouter.get('/invoices', asyncHandler(async (req, res) => {
  const params: unknown[] = [accountId(req)];
  const pl = parseList(invoiceList, req.query, params);
  const rows = await query(`SELECT * FROM billing_invoices WHERE account_id = $1${whereSql(pl)} ${pageSql(pl)}`, params);
  let total: number | undefined;
  if (pl.count) {
    const cp: unknown[] = [accountId(req)];
    const cpl = parseList(invoiceList, { ...req.query, cursor: undefined, offset: undefined }, cp);
    total = Number((await one<any>(`SELECT count(*)::int AS n FROM billing_invoices WHERE account_id = $1${whereSql(cpl)}`, cp))?.n ?? 0);
  }
  const page = finishPage(req, res, pl, rows as any[], total);
  res.json(Array.isArray(page) ? page.map(invoiceView) : page);
}));

billingRouter.get('/invoices/:id', asyncHandler(async (req, res) => {
  const inv = await invoiceWithLines(String(req.params.id), accountId(req)).catch(() => null);
  if (!inv) throw notFound('Invoice not found');
  res.json({ ...inv, _links: { self: { href: `/api/billing/invoices/${inv.id}` }, csv: { href: `/api/billing/invoices/${inv.id}/csv` }, pdf: { href: `/api/billing/invoices/${inv.id}/pdf` } } });
}));

billingRouter.get('/invoices/:id/pdf', asyncHandler(async (req, res) => {
  const inv = await invoiceWithLines(String(req.params.id), accountId(req)).catch(() => null);
  if (!inv) throw notFound('Invoice not found');
  await sendPdf(res, inv);
}));

billingRouter.get('/invoices/:id/csv', asyncHandler(async (req, res) => {
  const inv = await invoiceWithLines(String(req.params.id), accountId(req)).catch(() => null);
  if (!inv) throw notFound('Invoice not found');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${inv.number}.csv"`);
  res.send(invoiceCsv(inv));
}));

// ---- the System Admin's side --------------------------------------------------

export const platformBillingRouter = Router();

platformBillingRouter.get('/', ...requirePlatform('read_only'), asyncHandler(async (_req, res) => {
  const accounts = await query<any>(
    `SELECT a.id, a.name, a.status, a.plan_tier, a.billing_handling, a.billing_tax_rate, a.subscription_fee_month,
            (SELECT count(*)::int FROM billing_invoices i WHERE i.account_id = a.id AND i.status IN ('issued','failed')) AS open_invoices,
            (SELECT COALESCE(sum(total_usd),0) FROM billing_invoices i WHERE i.account_id = a.id AND i.status IN ('issued','failed')) AS open_usd
       FROM accounts a ORDER BY a.name`);
  res.json({
    mode: billingMode(), taxRate: deploymentTaxRate(), currency: 'USD', openMonth: monthOf().slice(0, 7), lastClosable: previousMonth(monthOf()).slice(0, 7),
    accounts: accounts.map((a) => ({
      id: a.id, name: a.name, status: a.status, plan: a.plan_tier,
      handling: effectiveHandling(a.billing_handling), storedHandling: a.billing_handling,
      taxRate: a.billing_tax_rate == null ? null : Number(a.billing_tax_rate),
      ownFeeUsd: Number(a.subscription_fee_month) > 0 ? Number(a.subscription_fee_month) : null,
      openInvoices: a.open_invoices, openUsd: Number(a.open_usd),
    })),
  });
}));

platformBillingRouter.get('/accounts/:id', ...requirePlatform('read_only'), asyncHandler(async (req, res) => {
  const a = await one<any>(`SELECT id, name, billing_handling, billing_tax_rate FROM accounts WHERE id = $1`, [req.params.id]).catch(() => null);
  if (!a) throw notFound('Account not found');
  const invoices = (await query<any>(`SELECT * FROM billing_invoices WHERE account_id = $1 ORDER BY period_month DESC LIMIT 24`, [a.id])).map(invoiceView);
  res.json({ id: a.id, name: a.name, handling: effectiveHandling(a.billing_handling), storedHandling: a.billing_handling,
    taxRate: a.billing_tax_rate == null ? null : Number(a.billing_tax_rate),
    currentMonth: billingMode() === 'off' ? null : await draftFor(a.id), invoices });
}));

const accountPatch = z.object({
  handling: z.enum(['automated', 'contract']).optional(),
  taxRate: z.number().min(0).max(0.99).nullable().optional(),
}).strict();

platformBillingRouter.patch('/accounts/:id', ...requirePlatform('saas_admin'), asyncHandler(async (req, res) => {
  const b = accountPatch.parse(req.body ?? {});
  const cur = await one<any>(`SELECT id, billing_handling, billing_tax_rate FROM accounts WHERE id = $1`, [req.params.id]).catch(() => null);
  if (!cur) throw notFound('Account not found');
  const handling = b.handling ?? cur.billing_handling;
  const taxRate = b.taxRate === undefined ? cur.billing_tax_rate : b.taxRate;
  await query(`UPDATE accounts SET billing_handling = $2, billing_tax_rate = $3, updated_at = now() WHERE id = $1`, [cur.id, handling, taxRate]);
  await writeAudit(null, { accountId: cur.id, userId: req.auth!.sub, label: 'system-admin', action: 'update', entityType: 'account_billing', entityId: cur.id,
    changes: {
      ...(handling !== cur.billing_handling ? { handling: { from: cur.billing_handling, to: handling } } : {}),
      ...(String(taxRate) !== String(cur.billing_tax_rate) ? { taxRate: { from: cur.billing_tax_rate, to: taxRate } } : {}),
    } });
  res.json({ id: cur.id, handling: effectiveHandling(handling), storedHandling: handling, taxRate: taxRate == null ? null : Number(taxRate) });
}));

platformBillingRouter.get('/invoices', ...requirePlatform('read_only'), asyncHandler(async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const acc = typeof req.query.accountId === 'string' ? req.query.accountId : null;
  const rows = await query<any>(
    `SELECT i.*, a.name AS account_name FROM billing_invoices i JOIN accounts a ON a.id = i.account_id
      WHERE ($1::text IS NULL OR i.status = $1) AND ($2::text IS NULL OR i.account_id::text = $2)
      ORDER BY i.period_month DESC, i.number DESC LIMIT 500`, [status, acc]);
  res.json(rows.map((r) => ({ ...invoiceAdminView(r), accountName: r.account_name })));
}));

platformBillingRouter.get('/invoices/:id', ...requirePlatform('read_only'), asyncHandler(async (req, res) => {
  const inv = await invoiceWithLines(String(req.params.id), undefined, true).catch(() => null);
  if (!inv) throw notFound('Invoice not found');
  res.json(inv);
}));

platformBillingRouter.get('/invoices/:id/csv', ...requirePlatform('read_only'), asyncHandler(async (req, res) => {
  const inv = await invoiceWithLines(String(req.params.id)).catch(() => null);
  if (!inv) throw notFound('Invoice not found');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${inv.number}.csv"`);
  res.send(invoiceCsv(inv));
}));

platformBillingRouter.get('/invoices/:id/pdf', ...requirePlatform('read_only'), asyncHandler(async (req, res) => {
  const inv = await invoiceWithLines(String(req.params.id)).catch(() => null);
  if (!inv) throw notFound('Invoice not found');
  await sendPdf(res, inv);
}));

/** Send (or send again) an automated invoice to Stripe now, rather than on the next pass. */
platformBillingRouter.post('/invoices/:id/stripe', ...requirePlatform('saas_admin'), asyncHandler(async (req, res) => {
  const r = await one<any>(`SELECT * FROM billing_invoices WHERE id = $1`, [req.params.id]).catch(() => null);
  if (!r) throw notFound('Invoice not found');
  if (r.handling !== 'automated') throw conflict('A contract invoice is settled outside Volt; it is not sent to Stripe.');
  if (billingMode() !== 'automated') throw conflict('Invoices go to Stripe only when the deployment bills automatically (VOLT_BILLING=automated).');
  await sendInvoiceToStripe(r.id);
  res.json(invoiceAdminView(await one<any>(`SELECT * FROM billing_invoices WHERE id = $1`, [r.id])));
}));

platformBillingRouter.post('/invoices/:id/paid', ...requirePlatform('saas_admin'), asyncHandler(async (req, res) => {
  const b = z.object({ reference: z.string().trim().min(1).max(200) }).parse(req.body ?? {});
  const before = await one<any>(`SELECT account_id, number FROM billing_invoices WHERE id = $1`, [req.params.id]).catch(() => null);
  if (!before) throw notFound('Invoice not found');
  const inv = await markPaid(String(req.params.id), b.reference, req.auth!.sub);
  await writeAudit(null, { accountId: before.account_id, userId: req.auth!.sub, label: 'system-admin', action: 'update', entityType: 'invoice', entityId: inv.id,
    changes: { status: { from: 'issued', to: 'paid' } }, snapshot: { number: before.number, reference: b.reference } });
  res.json(inv);
}));

const chargeBody = z.object({
  accountId: z.string().uuid(),
  amountUsd: z.number().refine((n) => n !== 0 && Math.abs(n) <= 1_000_000, 'amountUsd must be a non-zero amount (negative for a credit)'),
  description: z.string().trim().min(1).max(300),
  reference: z.string().trim().max(200).optional(),
  month: z.string().optional(),
});

platformBillingRouter.post('/charges', ...requirePlatform('saas_admin'), asyncHandler(async (req, res) => {
  const b = chargeBody.parse(req.body ?? {});
  const month = b.month ? parseMonth(b.month) : undefined;
  const row = await addManualCharge({ accountId: b.accountId, amountUsd: b.amountUsd, description: b.description, reference: b.reference ?? null, month, userId: req.auth!.sub });
  await writeAudit(null, { accountId: b.accountId, userId: req.auth!.sub, label: 'system-admin', action: 'create', entityType: 'billing_charge', entityId: b.accountId,
    // The audit log keys entities by uuid; a ledger row's id is a number, so it rides in the snapshot.
    snapshot: { chargeId: String(row.id), amountUsd: Number(row.amount_usd), description: row.description, month: String(row.period_month instanceof Date ? row.period_month.toISOString() : row.period_month).slice(0, 7) } });
  res.status(201).json({ id: String(row.id), accountId: row.account_id, source: row.source, description: row.description, amountUsd: Number(row.amount_usd), reference: row.reference });
}));

platformBillingRouter.get('/charges', ...requirePlatform('read_only'), asyncHandler(async (req, res) => {
  const acc = z.string().uuid().parse(req.query.accountId);
  const month = typeof req.query.month === 'string' ? parseMonth(req.query.month) : null;
  const rows = await query<any>(
    `SELECT * FROM billing_charges WHERE account_id = $1 AND ($2::date IS NULL OR period_month = $2::date) ORDER BY id DESC LIMIT 1000`, [acc, month]);
  res.json(rows.map((r) => ({ id: String(r.id), period: String(r.period_month instanceof Date ? r.period_month.toISOString() : r.period_month).slice(0, 7),
    source: r.source, itemKey: r.item_key, description: r.description, quantity: Number(r.quantity), unit: r.unit, unitUsd: Number(r.unit_usd),
    amountUsd: Number(r.amount_usd), createdBy: r.created_by, reference: r.reference, invoiceId: r.invoice_id, createdAt: r.created_at })));
}));

platformBillingRouter.post('/close', ...requirePlatform('saas_admin'), asyncHandler(async (req, res) => {
  const b = z.object({ month: z.string().optional(), accountId: z.string().uuid().optional() }).parse(req.body ?? {});
  if (billingMode() === 'off') throw conflict('Billing is off on this deployment (VOLT_BILLING), so there is nothing to close.');
  const month = b.month ? parseMonth(b.month) : previousMonth(monthOf());
  res.json(await closeMonth(month, { accountId: b.accountId, userId: req.auth!.sub }));
}));

platformBillingRouter.get('/prices', ...requirePlatform('read_only'), asyncHandler(async (_req, res) => {
  const rows = await query<any>(`SELECT * FROM billing_prices ORDER BY unit_key, instance_type NULLS FIRST, effective_from DESC`);
  res.json(rows.map((r) => ({ id: r.id, unitKey: r.unit_key, instanceType: r.instance_type, name: r.name, unit: r.unit, unitUsd: Number(r.unit_usd), effectiveFrom: r.effective_from })));
}));

const priceBody = z.object({
  unitKey: z.enum(['server_hour', 'gb_delivered']),
  instanceType: z.string().trim().min(1).max(60).nullable().optional(),
  name: z.string().trim().min(1).max(120),
  unit: z.string().trim().min(1).max(20),
  unitUsd: z.number().min(0).max(100000),
  effectiveFrom: z.string().datetime({ offset: true }).optional(),
});

/** Prices are added, never edited: a new row with a later effective date replaces one. */
platformBillingRouter.post('/prices', ...requirePlatform('saas_admin'), asyncHandler(async (req, res) => {
  const b = priceBody.parse(req.body ?? {});
  const r = await one<any>(
    `INSERT INTO billing_prices(unit_key, instance_type, name, unit, unit_usd, effective_from, created_by)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz, now()),(SELECT id FROM users WHERE id = $7)) RETURNING *`,
    [b.unitKey, b.unitKey === 'server_hour' ? b.instanceType ?? null : null, b.name, b.unit, b.unitUsd, b.effectiveFrom ?? null, req.auth!.sub]);
  await writeAudit(null, { accountId: null, userId: req.auth!.sub, label: 'system-admin', action: 'create', entityType: 'billing_price', entityId: r.id,
    snapshot: { unitKey: r.unit_key, instanceType: r.instance_type, unitUsd: Number(r.unit_usd), effectiveFrom: r.effective_from } });
  res.status(201).json({ id: r.id, unitKey: r.unit_key, instanceType: r.instance_type, name: r.name, unit: r.unit, unitUsd: Number(r.unit_usd), effectiveFrom: r.effective_from });
}));

// ---- the add-on catalogue (build queue B2) ---------------------------------------
// Held as data, edited here. Prices on charges already in the ledger never
// change; a new price applies from the next charge (a turn-on, an upgrade or
// the next 1st). An add-on or pack set inactive is no longer offered; accounts
// that have it keep it, and it renews, until they turn it off.

const qty = z.number().min(0).max(1e9);
const usd = z.number().min(0).max(1_000_000);
const addonBody = z.object({
  key: z.string().regex(/^[a-z0-9_]{2,40}$/, 'key: 2 to 40 lower-case letters, digits or _'),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  monthlyUsd: usd,
  includedQuantity: qty.default(0),
  unit: z.string().trim().min(1).max(40),
  licence: z.string().nullable().optional().refine(isLicence, 'licence must be one of the platform licences'),
  active: z.boolean().optional(),
}).strict();
const packBody = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,40}$/, 'key: 1 to 40 lower-case letters, digits or _'),
  name: z.string().trim().min(1).max(120),
  extraQuantity: z.number().gt(0).max(1e9),
  monthlyUsd: usd,
  active: z.boolean().optional(),
}).strict();

const auditCatalogue = (req: any, action: 'create' | 'update', snapshot: any, changes?: any) =>
  writeAudit(null, { accountId: null, userId: req.auth!.sub, label: 'system-admin', action, entityType: 'billing_addon', entityId: '00000000-0000-0000-0000-000000000000', snapshot, changes });

platformBillingRouter.get('/addons', ...requirePlatform('read_only'), asyncHandler(async (_req, res) => {
  const held = await query<any>(`SELECT addon_key, count(*)::int AS n FROM account_addons GROUP BY addon_key`);
  const n = new Map(held.map((h) => [h.addon_key, h.n]));
  res.json((await catalogue()).map((a) => ({ ...a, accounts: n.get(a.key) ?? 0 })));
}));

platformBillingRouter.post('/addons', ...requirePlatform('saas_admin'), asyncHandler(async (req, res) => {
  const b = addonBody.parse(req.body ?? {});
  if (await one(`SELECT 1 FROM billing_addons WHERE key = $1`, [b.key])) throw conflict(`An add-on with the key ${b.key} already exists.`);
  await query(`INSERT INTO billing_addons(key, name, description, monthly_usd, included_quantity, unit, licence, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [b.key, b.name, b.description ?? null, b.monthlyUsd, b.includedQuantity, b.unit, b.licence ?? null, b.active ?? true]);
  await auditCatalogue(req, 'create', { addon: b.key, monthlyUsd: b.monthlyUsd, includedQuantity: b.includedQuantity, unit: b.unit, licence: b.licence ?? null });
  res.status(201).json((await catalogue()).find((a) => a.key === b.key));
}));

platformBillingRouter.patch('/addons/:key', ...requirePlatform('saas_admin'), asyncHandler(async (req, res) => {
  const b = addonBody.omit({ key: true }).partial().strict().parse(req.body ?? {});
  const cur = await one<any>(`SELECT * FROM billing_addons WHERE key = $1`, [req.params.key]);
  if (!cur) throw notFound('Add-on not found');
  const cols: Record<string, [string, unknown]> = {
    name: ['name', b.name], description: ['description', b.description], monthlyUsd: ['monthly_usd', b.monthlyUsd],
    includedQuantity: ['included_quantity', b.includedQuantity], unit: ['unit', b.unit], licence: ['licence', b.licence], active: ['active', b.active],
  };
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const sets: string[] = []; const params: unknown[] = [cur.key];
  for (const [k, [col, v]] of Object.entries(cols)) {
    if (v === undefined) continue;
    params.push(v); sets.push(`${col} = $${params.length}`);
    if (String(cur[col]) !== String(v)) changes[k] = { from: cur[col], to: v };
  }
  if (sets.length) await query(`UPDATE billing_addons SET ${sets.join(', ')}, updated_at = now() WHERE key = $1`, params);
  if (Object.keys(changes).length) await auditCatalogue(req, 'update', { addon: cur.key }, changes);
  // The allowance of every account that has it may have moved.
  for (const h of await query<any>(`SELECT account_id FROM account_addons WHERE addon_key = $1`, [cur.key])) await addonsChanged(h.account_id);
  res.json((await catalogue()).find((a) => a.key === cur.key));
}));

platformBillingRouter.post('/addons/:key/packs', ...requirePlatform('saas_admin'), asyncHandler(async (req, res) => {
  const b = packBody.parse(req.body ?? {});
  if (!(await one(`SELECT 1 FROM billing_addons WHERE key = $1`, [req.params.key]))) throw notFound('Add-on not found');
  if (await one(`SELECT 1 FROM billing_addon_packs WHERE addon_key = $1 AND key = $2`, [req.params.key, b.key])) throw conflict(`A pack with the key ${b.key} already exists.`);
  await query(`INSERT INTO billing_addon_packs(addon_key, key, name, extra_quantity, monthly_usd, active) VALUES ($1,$2,$3,$4,$5,$6)`,
    [req.params.key, b.key, b.name, b.extraQuantity, b.monthlyUsd, b.active ?? true]);
  await auditCatalogue(req, 'create', { addon: req.params.key, pack: b.key, extraQuantity: b.extraQuantity, monthlyUsd: b.monthlyUsd });
  res.status(201).json((await catalogue()).find((a) => a.key === req.params.key));
}));

platformBillingRouter.patch('/addons/:key/packs/:pack', ...requirePlatform('saas_admin'), asyncHandler(async (req, res) => {
  const b = packBody.omit({ key: true }).partial().strict().parse(req.body ?? {});
  const cur = await one<any>(`SELECT * FROM billing_addon_packs WHERE addon_key = $1 AND key = $2`, [req.params.key, req.params.pack]);
  if (!cur) throw notFound('Pack not found');
  const cols: Record<string, [string, unknown]> = { name: ['name', b.name], extraQuantity: ['extra_quantity', b.extraQuantity], monthlyUsd: ['monthly_usd', b.monthlyUsd], active: ['active', b.active] };
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const sets: string[] = []; const params: unknown[] = [cur.addon_key, cur.key];
  for (const [k, [col, v]] of Object.entries(cols)) {
    if (v === undefined) continue;
    params.push(v); sets.push(`${col} = $${params.length}`);
    if (String(cur[col]) !== String(v)) changes[k] = { from: cur[col], to: v };
  }
  if (sets.length) await query(`UPDATE billing_addon_packs SET ${sets.join(', ')}, updated_at = now() WHERE addon_key = $1 AND key = $2`, params);
  if (Object.keys(changes).length) await auditCatalogue(req, 'update', { addon: cur.addon_key, pack: cur.key }, changes);
  for (const h of await query<any>(`SELECT account_id FROM account_addons WHERE addon_key = $1 AND pack_key = $2`, [cur.addon_key, cur.key])) await addonsChanged(h.account_id);
  res.json((await catalogue()).find((a) => a.key === cur.addon_key));
}));

/** An account's add-ons as the account sees them, and the System Admin changing them for it. */
platformBillingRouter.get('/accounts/:id/addons', ...requirePlatform('read_only'), asyncHandler(async (req, res) => {
  if (!(await one(`SELECT 1 FROM accounts WHERE id = $1`, [req.params.id]).catch(() => null))) throw notFound('Account not found');
  res.json(await accountAddons(String(req.params.id)));
}));

platformBillingRouter.put('/accounts/:id/addons/:key', ...requirePlatform('saas_admin'), asyncHandler(async (req, res) => {
  const b = addonPut.parse(req.body ?? {});
  if (!(await one(`SELECT 1 FROM accounts WHERE id = $1`, [req.params.id]).catch(() => null))) throw notFound('Account not found');
  res.json(await setAddon(String(req.params.id), String(req.params.key), b.pack ?? null, { userId: req.auth!.sub, label: 'system-admin' }));
}));

platformBillingRouter.delete('/accounts/:id/addons/:key', ...requirePlatform('saas_admin'), asyncHandler(async (req, res) => {
  if (!(await one(`SELECT 1 FROM accounts WHERE id = $1`, [req.params.id]).catch(() => null))) throw notFound('Account not found');
  res.json(await turnOffAddon(String(req.params.id), String(req.params.key), { userId: req.auth!.sub, label: 'system-admin' }));
}));
