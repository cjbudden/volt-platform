// ============================================================================
//  STRIPE CHECKOUT for Volt's OWN subscriptions (the promo site), separate from
//  services/payments which takes money on behalf of a tenant from its viewers.
//
//  No SDK: one form-encoded POST to create a Checkout Session, and the webhook
//  signature check (HMAC-SHA256 over "<t>.<raw body>", 5 minute tolerance).
//
//    SAAS_STRIPE_SECRET_KEY       sk_live_… / sk_test_…  (Secrets Manager in AWS)
//    SAAS_STRIPE_WEBHOOK_SECRET   whsec_…  for POST /api/signup/webhooks/stripe
//    STRIPE_API_BASE              tests only: point at a fake Stripe
// ============================================================================
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../util/http';

export const stripeConfigured = () => !!process.env.SAAS_STRIPE_SECRET_KEY;

function form(obj: Record<string, string | number | undefined>): string {
  return Object.entries(obj).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
}

export async function createCheckoutSession(o: {
  priceId: string; email: string; signupId: string; planKey: string; accountId: string;
  successUrl: string; cancelUrl: string; trialDays?: number;
}): Promise<{ id: string; url: string }> {
  const key = process.env.SAAS_STRIPE_SECRET_KEY;
  if (!key) throw new ApiError(503, 'Online purchase is not set up on this deployment yet.');
  const base = (process.env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/+$/, '');
  const body = form({
    mode: 'subscription',
    'line_items[0][price]': o.priceId,
    'line_items[0][quantity]': 1,
    customer_email: o.email,
    client_reference_id: o.signupId,
    'metadata[signupId]': o.signupId,
    'metadata[plan]': o.planKey,
    'metadata[accountId]': o.accountId,
    'subscription_data[metadata][signupId]': o.signupId,
    'subscription_data[metadata][accountId]': o.accountId,
    'subscription_data[trial_period_days]': o.trialDays && o.trialDays > 0 ? o.trialDays : undefined,
    allow_promotion_codes: 'true',
    billing_address_collection: 'required',
    'tax_id_collection[enabled]': 'true',
    success_url: o.successUrl,
    cancel_url: o.cancelUrl,
  });
  let r: Response;
  try {
    r = await fetch(`${base}/v1/checkout/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': `signup-${o.signupId}-${o.priceId}` },
      body,
    });
  } catch (e: any) {
    console.error('[signup] Stripe unreachable', e?.message);
    throw new ApiError(502, 'The payment page could not be opened. Try again in a moment.');
  }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j?.url) {
    console.error('[signup] Stripe refused the checkout session', r.status, j?.error?.message);
    throw new ApiError(502, 'The payment page could not be opened. Try again in a moment.');
  }
  return { id: j.id, url: j.url };
}

/** True when the Stripe-Signature header matches the raw body under the secret. */
export function verifyStripeSignature(raw: Buffer, header: string | undefined, secret: string | undefined, nowSec = Date.now() / 1000): boolean {
  if (!secret || !header) return false;
  const parts: Record<string, string[]> = {};
  for (const kv of header.split(',')) {
    const [k, v] = kv.split('=');
    if (k && v) (parts[k.trim()] ??= []).push(v.trim());
  }
  const t = Number(parts.t?.[0]);
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > 300) return false;
  const want = Buffer.from(createHmac('sha256', secret).update(`${t}.${raw.toString('utf8')}`).digest('hex'), 'hex');
  // Stripe may send more than one v1 during a secret roll: any match is enough.
  return (parts.v1 ?? []).some((sig) => {
    const got = Buffer.from(sig, 'hex');
    return got.length === want.length && timingSafeEqual(got, want);
  });
}
