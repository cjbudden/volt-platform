// ============================================================================
//  ENTITLEMENTS — what a viewer may reach, and how it got that way.
//
//    a TERM on a premium rule  ->  a PRODUCT (one row per productKey)
//    a PRODUCT at a provider   ->  provider_ids (Stripe price, App Store
//                                  product id, Play SKU)
//    a verified PAYMENT        ->  a PURCHASE (idempotent on the provider's
//                                  transaction id)
//    a PURCHASE                ->  an ENTITLEMENT: the product's grants copied
//                                  onto the viewer with a validity window
//
//  Providers take the money. The platform decides what the money buys (the
//  rule the term came from, so the entitlement matches exactly the content
//  that rule governs) and for how long (the term's period, or the item's own
//  published dates).
// ============================================================================
import { query, one } from '../db';
import { type AccessRule, type AccessTerm, type Grants, grantsFor, termPeriodMs } from './accessRules';

/** Upsert the products behind every premium term in a rule set. */
export async function syncProductsFromRules(accountId: string, rules: AccessRule[], sourceRule: string, anchorId: string | null): Promise<void> {
  for (const rule of rules) {
    if (rule.then.access !== 'premium') continue;
    for (const t of rule.then.terms ?? []) {
      const name = t.name ?? describeTerm(t);
      await query(
        `INSERT INTO products(account_id, key, name, term, grants, source_rule)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)
         ON CONFLICT (account_id, key) DO UPDATE
           SET name = EXCLUDED.name, term = EXCLUDED.term, grants = EXCLUDED.grants, source_rule = EXCLUDED.source_rule, updated_at = now()`,
        [accountId, t.productKey, name, JSON.stringify(t), JSON.stringify(grantsFor(rule, anchorId)), sourceRule]);
    }
  }
}

export function describeTerm(t: AccessTerm): string {
  const price = `${(t.priceCents / 100).toFixed(2)} ${t.currency}`;
  if (t.kind === 'published_dates') return `Access while published · ${price}`;
  return `${t.count} ${t.unit}${(t.count ?? 1) === 1 ? '' : 's'} · ${price}`;
}

/** Find or create the viewer identity the client's app reported. */
export async function upsertViewer(accountId: string, externalId: string, opts: { email?: string | null; groups?: string[] } = {}) {
  return one<any>(
    `INSERT INTO viewers(account_id, external_id, email, groups, last_seen_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (account_id, external_id) DO UPDATE
       SET email = COALESCE(EXCLUDED.email, viewers.email),
           groups = CASE WHEN $5 THEN EXCLUDED.groups ELSE viewers.groups END,
           last_seen_at = now()
     RETURNING *`,
    [accountId, externalId, opts.email ?? null, opts.groups ?? [], opts.groups != null]);
}

/** The viewer's live entitlements, shaped for the evaluator. */
export async function viewerEntitlements(viewerId: string) {
  const rows = await query<any>(
    `SELECT e.grants, e.valid_until, p.key AS product_key
       FROM entitlements e LEFT JOIN products p ON p.id = e.product_id
      WHERE e.viewer_id = $1 AND e.revoked_at IS NULL AND (e.valid_until IS NULL OR e.valid_until > now())`, [viewerId]);
  return rows.map((r) => ({ grants: r.grants as Grants, validUntil: r.valid_until, productKey: r.product_key }));
}

export interface PurchaseEvent {
  provider: 'stripe' | 'appstore' | 'googleplay' | 'manual';
  providerTxnId: string;
  /** How the provider names the product: matched against products.provider_ids[provider], then products.key. */
  providerProductId: string;
  viewerExternalId: string;
  status: 'paid' | 'refunded' | 'cancelled' | 'pending';
  amountCents?: number | null;
  currency?: string | null;
  purchasedAt?: Date;
  /** Subscription period the provider reports, when it does. */
  periodStart?: Date | null;
  periodEnd?: Date | null;
  raw?: any;
}

/**
 * Record a verified payment and grant (or revoke) what it buys. Idempotent on
 * (provider, transaction id): a webhook delivered twice changes nothing.
 */
export async function recordPurchase(accountId: string, ev: PurchaseEvent): Promise<{ purchase: any; entitlement: any | null; product: any }> {
  const product = await one<any>(
    `SELECT * FROM products WHERE account_id = $1 AND enabled
        AND (provider_ids ->> $2 = $3 OR key = $3) LIMIT 1`, [accountId, ev.provider, ev.providerProductId]);
  if (!product) throw new Error(`no product for ${ev.provider} id ${ev.providerProductId}`);
  const viewer = await upsertViewer(accountId, ev.viewerExternalId);
  const term: AccessTerm = product.term;
  const start = ev.periodStart ?? ev.purchasedAt ?? new Date();
  const periodMs = termPeriodMs(term, start);
  const end = ev.periodEnd ?? (periodMs != null ? new Date(start.getTime() + periodMs) : null);

  const existing = await one<any>(
    `SELECT * FROM purchases WHERE account_id = $1 AND provider = $2 AND provider_txn_id = $3`, [accountId, ev.provider, ev.providerTxnId]);
  const purchase = existing
    ? await one<any>(`UPDATE purchases SET status = $2, period_start = COALESCE($3, period_start), period_end = COALESCE($4, period_end), raw = COALESCE($5::jsonb, raw) WHERE id = $1 RETURNING *`,
        [existing.id, ev.status, ev.periodStart ?? null, ev.periodEnd ?? null, ev.raw ? JSON.stringify(ev.raw) : null])
    : await one<any>(
        `INSERT INTO purchases(account_id, viewer_id, product_id, provider, provider_txn_id, status, amount_cents, currency, purchased_at, period_start, period_end, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING *`,
        [accountId, viewer.id, product.id, ev.provider, ev.providerTxnId, ev.status, ev.amountCents ?? term.priceCents, ev.currency ?? term.currency,
         ev.purchasedAt ?? new Date(), start, end, ev.raw ? JSON.stringify(ev.raw) : null]);

  let entitlement: any | null = null;
  if (ev.status === 'paid') {
    entitlement = await one<any>(`SELECT * FROM entitlements WHERE purchase_id = $1 AND revoked_at IS NULL`, [purchase.id]);
    if (!entitlement) {
      entitlement = await one<any>(
        `INSERT INTO entitlements(account_id, viewer_id, purchase_id, product_id, grants, valid_from, valid_until)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING *`,
        [accountId, viewer.id, purchase.id, product.id, JSON.stringify(product.grants ?? {}), start, end]);
    } else if (end && (!entitlement.valid_until || new Date(entitlement.valid_until) < end)) {
      // A renewal extends the same entitlement.
      entitlement = await one<any>(`UPDATE entitlements SET valid_until = $2 WHERE id = $1 RETURNING *`, [entitlement.id, end]);
    }
  } else if (ev.status === 'refunded' || ev.status === 'cancelled') {
    await query(`UPDATE entitlements SET revoked_at = now(), note = $2 WHERE purchase_id = $1 AND revoked_at IS NULL`, [purchase.id, ev.status]);
  }
  return { purchase, entitlement, product };
}

/** A grant by hand (a comp, a fix): no purchase behind it. */
export async function grantManually(accountId: string, viewerExternalId: string, productKey: string, by: string, validUntil?: Date | null) {
  const product = await one<any>(`SELECT * FROM products WHERE account_id = $1 AND key = $2`, [accountId, productKey]);
  if (!product) throw new Error('product not found');
  const viewer = await upsertViewer(accountId, viewerExternalId);
  const periodMs = termPeriodMs(product.term);
  const until = validUntil ?? (periodMs != null ? new Date(Date.now() + periodMs) : null);
  return one<any>(
    `INSERT INTO entitlements(account_id, viewer_id, product_id, grants, valid_until, note)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING *`,
    [accountId, viewer.id, product.id, JSON.stringify(product.grants ?? {}), until, `granted by ${by}`]);
}
