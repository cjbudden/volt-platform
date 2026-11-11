// ============================================================================
//  AUTOMATED INVOICES THROUGH STRIPE (build queue B1-2). Migration 0170.
//
//  Under VOLT_BILLING=automated, an `automated` account's invoice is sent to
//  Volt's own Stripe account (the one the promo site's Checkout uses,
//  SAAS_STRIPE_SECRET_KEY) once its month has closed: a Stripe invoice with
//  one item per Volt line, finalised with auto-advance, so Stripe charges the
//  card on file and retries a failure on its own schedule. Stripe's answers
//  come back on the same webhook as Checkout (POST /api/signup/webhooks/stripe):
//  invoice.paid marks the Volt invoice paid, invoice.payment_failed marks it
//  failed and tells the account's owners and admins. Nothing is suspended.
//
//  TAX IS SENT AS ITS OWN LINE, not as a Stripe tax rate, so the Stripe total
//  is Volt's total to the cent and no Stripe Tax set-up is needed; a later
//  move to Stripe Tax would replace that line, not the ledger.
//
//  Every call carries an idempotency key made from the Volt invoice, so a
//  pass that dies half way and runs again makes the same Stripe objects, not
//  a second invoice. Sending happens after the month's close has committed
//  and never inside it: Stripe being down delays the charge, never the
//  invoice. A failed send is kept on the invoice and tried again next pass.
// ============================================================================
import { query, one } from '../../db';
import { stripeConfigured } from '../stripeCheckout';
import { notifyAccountAdmins } from '../notifications';
import { writeAudit } from '../audit';
import { billingMode } from './index';

const MAX_ATTEMPTS = 10;

class StripeError extends Error { constructor(msg: string, readonly status: number) { super(msg); } }

function form(obj: Record<string, string | number | boolean | undefined | null>): string {
  return Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
}

async function stripe(path: string, body: Record<string, any> | null, idem?: string): Promise<any> {
  const base = (process.env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/+$/, '');
  const headers: Record<string, string> = { authorization: `Bearer ${process.env.SAAS_STRIPE_SECRET_KEY}` };
  if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
  if (idem) headers['idempotency-key'] = idem;
  const r = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers, body: body ? form(body) : undefined });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new StripeError(`Stripe ${path.split('/').slice(0, 3).join('/')} answered ${r.status}: ${j?.error?.message ?? 'no message'}`, r.status);
  return j;
}

const toCents = (usd: number) => Math.round(Number(usd) * 100);

/** The account's Stripe customer: remembered, from its sign-up, or made now. */
async function customerFor(accountId: string): Promise<string> {
  const a = await one<any>(`SELECT name, stripe_customer_id FROM accounts WHERE id = $1`, [accountId]);
  if (a?.stripe_customer_id) return a.stripe_customer_id;
  const s = await one<any>(`SELECT stripe_customer_id FROM saas_signups WHERE account_id = $1 AND stripe_customer_id IS NOT NULL ORDER BY activated_at DESC NULLS LAST LIMIT 1`, [accountId]);
  let id: string | null = s?.stripe_customer_id ?? null;
  if (!id) {
    const owner = await one<any>(`SELECT email::text AS email FROM users WHERE account_id = $1 AND role = 'owner' ORDER BY created_at LIMIT 1`, [accountId]);
    const c = await stripe('/v1/customers', { name: a?.name ?? 'Volt account', email: owner?.email ?? undefined, 'metadata[accountId]': accountId }, `volt-customer-${accountId}`);
    id = String(c.id);
  }
  await query(`UPDATE accounts SET stripe_customer_id = $2 WHERE id = $1 AND stripe_customer_id IS NULL`, [accountId, id]);
  return id;
}

/**
 * WHY ONLY FOR AUTOMATED ACCOUNTS ON AN AUTOMATED DEPLOYMENT: the card is kept
 * by Stripe, never by Volt, so the account changes it in Stripe's own customer
 * portal. A contract account pays its invoices outside Volt, and a deployment
 * that is off or contract never charges a card, so there is nothing to change.
 */
export function paymentMethodState(mode: string, handling: string): { portal: boolean; reason: string | null } {
  if (mode !== 'automated') return { portal: false, reason: 'Invoices on this deployment are not charged to a card.' };
  if (handling !== 'automated') return { portal: false, reason: 'This account pays its invoices under a contract, outside Volt.' };
  if (!stripeConfigured()) return { portal: false, reason: 'Card payments are not set up on this deployment yet.' };
  return { portal: true, reason: null };
}

/** A one-off link into Stripe's customer portal, where the account changes its card. */
export async function portalSession(accountId: string, returnUrl: string): Promise<string> {
  const customer = await customerFor(accountId);
  // No idempotency key: every session is new and short-lived by design.
  const s = await stripe('/v1/billing_portal/sessions', { customer, return_url: returnUrl });
  return String(s.url);
}

/** Send one issued automated invoice to Stripe. Returns the Stripe invoice id, or null with the reason kept on the invoice. */
export async function sendInvoiceToStripe(invoiceId: string): Promise<string | null> {
  const inv = await one<any>(`SELECT * FROM billing_invoices WHERE id = $1`, [invoiceId]);
  if (!inv || inv.handling !== 'automated' || inv.stripe_invoice_id) return inv?.stripe_invoice_id ?? null;
  if (!stripeConfigured()) {
    await query(`UPDATE billing_invoices SET stripe_error = $2, updated_at = now() WHERE id = $1`, [invoiceId, 'Stripe is not set up on this deployment (SAAS_STRIPE_SECRET_KEY).']);
    return null;
  }
  try {
    const customer = await customerFor(inv.account_id);
    const period = String(inv.period_month instanceof Date ? inv.period_month.toISOString() : inv.period_month).slice(0, 7);
    const si = await stripe('/v1/invoices', {
      customer, collection_method: 'charge_automatically', auto_advance: 'true', currency: 'usd',
      description: `Volt ${period} (${inv.number})`, pending_invoice_items_behavior: 'exclude',
      'metadata[voltInvoiceId]': inv.id, 'metadata[voltNumber]': inv.number, 'metadata[accountId]': inv.account_id,
    }, `volt-invoice-${inv.id}`);
    const lines = await query<any>(`SELECT id, description, quantity, unit, amount_usd FROM billing_charges WHERE invoice_id = $1 ORDER BY id`, [inv.id]);
    const items = lines.map((l) => ({ key: `item-${l.id}`, cents: toCents(l.amount_usd), description: Number(l.quantity) === 1 && l.unit !== 'hour' ? l.description : `${l.description} (${Number(l.quantity)} ${l.unit})` }));
    if (Number(inv.tax_usd) !== 0) items.push({ key: 'tax', cents: toCents(inv.tax_usd), description: `Tax (${+(Number(inv.tax_rate) * 100).toFixed(2)}%)` });
    for (const it of items) {
      await stripe('/v1/invoiceitems', { customer, invoice: si.id, amount: it.cents, currency: 'usd', description: it.description }, `volt-invoice-${inv.id}-${it.key}`);
    }
    const fin = await stripe(`/v1/invoices/${si.id}/finalize`, { auto_advance: 'true' }, `volt-invoice-${inv.id}-finalize`);
    // Stripe adds up the items itself: a different total means a line was lost on the way.
    const mismatch = fin?.total != null && Number(fin.total) !== toCents(inv.total_usd)
      ? `Stripe's total (${(Number(fin.total) / 100).toFixed(2)}) differs from the invoice (${Number(inv.total_usd).toFixed(2)}).` : null;
    await query(`UPDATE billing_invoices SET stripe_invoice_id = $2, stripe_sent_at = now(), stripe_error = $3, stripe_attempts = stripe_attempts + 1, updated_at = now() WHERE id = $1`,
      [inv.id, si.id, mismatch]);
    if (mismatch) console.error(`[billing] ${inv.number}: ${mismatch}`);
    return si.id;
  } catch (e) {
    await query(`UPDATE billing_invoices SET stripe_error = $2, stripe_attempts = stripe_attempts + 1, updated_at = now() WHERE id = $1`, [invoiceId, (e as Error).message.slice(0, 500)]);
    console.error(`[billing] ${inv.number} not sent to Stripe, tried again next pass:`, (e as Error).message);
    return null;
  }
}

/** Every issued automated invoice not yet in Stripe (the scheduler pass). */
export async function sendPendingToStripe(): Promise<{ sent: number; failed: number }> {
  if (billingMode() !== 'automated' || !stripeConfigured()) return { sent: 0, failed: 0 };
  const rows = await query<any>(
    `SELECT id FROM billing_invoices WHERE handling = 'automated' AND status = 'issued' AND stripe_invoice_id IS NULL AND stripe_attempts < $1 ORDER BY issued_at LIMIT 200`, [MAX_ATTEMPTS]);
  let sent = 0, failed = 0;
  for (const r of rows) ((await sendInvoiceToStripe(r.id)) ? sent++ : failed++);
  return { sent, failed };
}

/**
 * invoice.paid and invoice.payment_failed from Stripe. Invoices Stripe makes
 * for the Checkout subscription carry no Volt id and are left alone.
 */
export async function handleStripeInvoiceEvent(type: string, o: any): Promise<string> {
  const voltId = o?.metadata?.voltInvoiceId;
  const inv = await one<any>(
    `SELECT * FROM billing_invoices WHERE stripe_invoice_id = $1 OR ($2::text IS NOT NULL AND id::text = $2) LIMIT 1`, [String(o?.id ?? ''), voltId ?? null]);
  if (!inv) return 'not a Volt invoice';
  if (type === 'invoice.paid') {
    if (inv.status === 'paid') return 'already paid';
    if (inv.status === 'void') return 'void';
    await query(`UPDATE billing_invoices SET status = 'paid', paid_at = now(), paid_reference = $2, stripe_invoice_id = COALESCE(stripe_invoice_id, $3), updated_at = now() WHERE id = $1`,
      [inv.id, `Stripe ${o?.number ?? o?.id}`, o?.id ?? null]);
    await writeAudit(null, { accountId: inv.account_id, userId: null, label: 'stripe', action: 'update', entityType: 'invoice', entityId: inv.id, changes: { status: { from: inv.status, to: 'paid' } } }).catch(() => {});
    return 'paid';
  }
  if (type === 'invoice.payment_failed') {
    if (inv.status === 'paid' || inv.status === 'void') return `ignored, ${inv.status}`;
    await query(`UPDATE billing_invoices SET status = 'failed', failed_at = now(), updated_at = now() WHERE id = $1`, [inv.id]);
    // Told once, when it first fails; Stripe's retries of the same invoice do not repeat it.
    if (inv.status !== 'failed') {
      await writeAudit(null, { accountId: inv.account_id, userId: null, label: 'stripe', action: 'update', entityType: 'invoice', entityId: inv.id, changes: { status: { from: inv.status, to: 'failed' } } }).catch(() => {});
      const next = o?.next_payment_attempt ? ` Stripe will try again on ${new Date(Number(o.next_payment_attempt) * 1000).toISOString().slice(0, 10)}.` : '';
      await notifyAccountAdmins(inv.account_id, 'billing.payment_failed', `Payment for Volt invoice ${inv.number} failed`,
        `The card on file was not charged for invoice ${inv.number} (${Number(inv.total_usd).toFixed(2)} USD).${next} Check the payment method under Billing. Your service carries on meanwhile.`,
        { invoiceId: inv.id, number: inv.number });
    }
    return 'failed';
  }
  return 'ignored';
}
