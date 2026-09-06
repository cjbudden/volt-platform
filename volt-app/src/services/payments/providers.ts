// ============================================================================
//  PAYMENT PROVIDERS — the adapters that turn a provider's event into ONE
//  shape the platform understands (a PurchaseEvent), so entitlements.ts never
//  knows which provider took the money.
//
//  Two paths into the platform, both ending in recordPurchase():
//    WEBHOOK  the provider tells us (Stripe events, App Store Server
//             Notifications v2, Google Play Real-time Developer Notifications
//             via Pub/Sub push). Verified with the provider's signing secret.
//    VERIFY   the client's app hands us a receipt / session id it holds and we
//             confirm it with the provider (App Store receipts, Play purchase
//             tokens, a Stripe checkout session). Needs the provider's API
//             credential from the secrets store.
//
//  WHAT IS REAL HERE AND WHAT IS NOT. The event parsing and the entitlement
//  side are complete. Cryptographic verification is implemented where it can
//  be done with the standard library (Stripe's HMAC signature, App Store's
//  JWS structure) and marked `verified: false` where it needs a provider SDK
//  or a server-side API call with a credential (Play purchase tokens, App
//  Store certificate chain). A `verified: false` event is recorded as
//  'pending' and grants nothing until confirmed; nothing is ever granted on
//  an unverified say-so.
// ============================================================================
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PurchaseEvent } from '../entitlements';

export type ProviderName = 'stripe' | 'appstore' | 'googleplay' | 'manual';

export interface ProviderConfig {
  /** Public settings: publishable key, bundle id, package name, price ids. */
  config: Record<string, any>;
  /** The signing / API secret, resolved from the secrets store by secret_ref. */
  secret?: string | null;
}

export interface ParsedEvents {
  events: PurchaseEvent[];
  /** Whether the message's origin was cryptographically confirmed. */
  verified: boolean;
  note?: string;
}

export interface PaymentProvider {
  name: ProviderName;
  /** Parse and verify a webhook body. `headers` are lower-cased. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | undefined>, cfg: ProviderConfig): ParsedEvents;
  /** Confirm a receipt or token the app holds. May need a provider API call. */
  verifyReceipt(payload: any, cfg: ProviderConfig): Promise<ParsedEvents>;
}

const asDate = (s: any): Date | null => { const n = typeof s === 'number' ? (s < 1e12 ? s * 1000 : s) : Date.parse(String(s ?? '')); return Number.isFinite(n) ? new Date(n) : null; };

// ---- Stripe ------------------------------------------------------------------
//  Webhook signature: Stripe-Signature: t=<ts>,v1=<hmac_sha256(secret, "<ts>.<body>")>
const stripe: PaymentProvider = {
  name: 'stripe',
  parseWebhook(raw, headers, cfg) {
    const sig = headers['stripe-signature'] ?? '';
    let verified = false;
    if (cfg.secret && sig) {
      const parts = Object.fromEntries(sig.split(',').map((kv) => kv.split('=') as [string, string]));
      const expected = createHmac('sha256', cfg.secret).update(`${parts.t}.${raw.toString('utf8')}`).digest('hex');
      const given = Buffer.from(parts.v1 ?? '', 'hex'), want = Buffer.from(expected, 'hex');
      verified = given.length === want.length && given.length > 0 && timingSafeEqual(given, want)
        && Math.abs(Date.now() / 1000 - Number(parts.t)) < 300;
    }
    const ev = JSON.parse(raw.toString('utf8'));
    const o = ev?.data?.object ?? {};
    const events: PurchaseEvent[] = [];
    const viewer = o.client_reference_id ?? o.metadata?.viewerId ?? o.customer_email ?? o.customer ?? null;
    const productId = o.metadata?.productKey ?? o.line_items?.data?.[0]?.price?.id ?? o.lines?.data?.[0]?.price?.id ?? o.metadata?.priceId ?? null;
    switch (ev.type) {
      case 'checkout.session.completed':
      case 'invoice.paid':
        if (viewer && productId) events.push({
          provider: 'stripe', providerTxnId: String(o.payment_intent ?? o.id), providerProductId: String(productId),
          viewerExternalId: String(viewer), status: 'paid',
          amountCents: o.amount_total ?? o.amount_paid ?? null, currency: (o.currency ?? '').toUpperCase() || null,
          purchasedAt: asDate(ev.created) ?? new Date(),
          periodStart: asDate(o.lines?.data?.[0]?.period?.start), periodEnd: asDate(o.lines?.data?.[0]?.period?.end), raw: ev,
        });
        break;
      case 'charge.refunded':
      case 'customer.subscription.deleted':
        if (viewer) events.push({
          provider: 'stripe', providerTxnId: String(o.payment_intent ?? o.id), providerProductId: String(productId ?? o.items?.data?.[0]?.price?.id ?? ''),
          viewerExternalId: String(viewer), status: ev.type === 'charge.refunded' ? 'refunded' : 'cancelled', raw: ev,
        });
        break;
    }
    return { events, verified, note: verified ? undefined : 'signature not verified: set the webhook signing secret' };
  },
  async verifyReceipt(payload, cfg) {
    // A checkout session id: confirming it needs the Stripe API with the secret
    // key. Recorded as pending until the webhook (which we verify) arrives.
    void cfg;
    return {
      events: payload?.sessionId && payload?.viewerExternalId && payload?.productKey ? [{
        provider: 'stripe', providerTxnId: String(payload.sessionId), providerProductId: String(payload.productKey),
        viewerExternalId: String(payload.viewerExternalId), status: 'pending', raw: payload,
      }] : [],
      verified: false, note: 'session reported by the app; awaiting the signed webhook',
    };
  },
};

// ---- App Store -----------------------------------------------------------------
//  Server Notifications v2: { signedPayload: <JWS> }. The payload is decoded;
//  certificate-chain verification against Apple's roots is the step that
//  needs the x5c chain check (marked unverified until wired).
function decodeJws(jws: string): any {
  const parts = String(jws).split('.');
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch { return null; }
}
const appstore: PaymentProvider = {
  name: 'appstore',
  parseWebhook(raw, _headers, cfg) {
    const body = JSON.parse(raw.toString('utf8'));
    const payload = decodeJws(body?.signedPayload);
    if (!payload) return { events: [], verified: false, note: 'no signedPayload' };
    const tx = decodeJws(payload?.data?.signedTransactionInfo) ?? {};
    const bundleOk = !cfg.config.bundleId || payload?.data?.bundleId === cfg.config.bundleId;
    const type = String(payload.notificationType ?? '');
    const status: PurchaseEvent['status'] | null =
      /SUBSCRIBED|DID_RENEW|ONE_TIME_CHARGE|OFFER_REDEEMED/.test(type) ? 'paid'
      : /REFUND/.test(type) ? 'refunded'
      : /EXPIRED|REVOKE|DID_FAIL_TO_RENEW/.test(type) ? 'cancelled' : null;
    const viewer = tx.appAccountToken ?? null;
    const events: PurchaseEvent[] = (status && viewer && tx.productId) ? [{
      provider: 'appstore', providerTxnId: String(tx.originalTransactionId ?? tx.transactionId), providerProductId: String(tx.productId),
      viewerExternalId: String(viewer), status,
      amountCents: tx.price != null ? Math.round(Number(tx.price) / 10) : null, currency: tx.currency ?? null,
      purchasedAt: asDate(tx.purchaseDate) ?? new Date(), periodStart: asDate(tx.purchaseDate), periodEnd: asDate(tx.expiresDate), raw: payload,
    }] : [];
    return { events, verified: false, note: bundleOk ? 'JWS decoded; certificate chain verification not yet wired' : 'bundle id mismatch' };
  },
  async verifyReceipt(payload) {
    // A signed transaction from StoreKit 2: same decode, same caveat.
    const tx = decodeJws(payload?.signedTransaction) ?? {};
    const viewer = payload?.viewerExternalId ?? tx.appAccountToken;
    return {
      events: viewer && tx.productId ? [{
        provider: 'appstore', providerTxnId: String(tx.originalTransactionId ?? tx.transactionId), providerProductId: String(tx.productId),
        viewerExternalId: String(viewer), status: 'pending', purchasedAt: asDate(tx.purchaseDate) ?? new Date(),
        periodStart: asDate(tx.purchaseDate), periodEnd: asDate(tx.expiresDate), raw: tx,
      }] : [],
      verified: false, note: 'awaiting App Store server verification',
    };
  },
};

// ---- Google Play ----------------------------------------------------------------
//  Real-time Developer Notifications arrive as a Pub/Sub push: { message: { data: base64(JSON) } }.
//  The purchase token must then be confirmed with the Play Developer API.
const googleplay: PaymentProvider = {
  name: 'googleplay',
  parseWebhook(raw, _headers, cfg) {
    const body = JSON.parse(raw.toString('utf8'));
    const data = body?.message?.data ? JSON.parse(Buffer.from(body.message.data, 'base64').toString('utf8')) : body;
    const pkgOk = !cfg.config.packageName || data?.packageName === cfg.config.packageName;
    const sub = data?.subscriptionNotification, otp = data?.oneTimeProductNotification;
    const n = sub ?? otp;
    if (!n) return { events: [], verified: false, note: 'no purchase notification in message' };
    const t = Number(n.notificationType);
    const status: PurchaseEvent['status'] = sub
      ? ([4, 2, 1, 7].includes(t) ? 'paid' : [12].includes(t) ? 'refunded' : [3, 13].includes(t) ? 'cancelled' : 'pending')
      : (t === 1 ? 'paid' : t === 2 ? 'cancelled' : 'pending');
    // The viewer is not in the notification: it is attached to the token by the
    // app's verify call (obfuscatedExternalAccountId), so the webhook records
    // the state and the verify call names the viewer.
    const events: PurchaseEvent[] = [{
      provider: 'googleplay', providerTxnId: String(n.purchaseToken), providerProductId: String(n.subscriptionId ?? n.sku),
      viewerExternalId: String(data.obfuscatedExternalAccountId ?? `token:${n.purchaseToken}`), status: status === 'paid' ? 'pending' : status, raw: data,
    }];
    return { events, verified: false, note: pkgOk ? 'purchase token must be confirmed with the Play Developer API' : 'package name mismatch' };
  },
  async verifyReceipt(payload) {
    return {
      events: payload?.purchaseToken && payload?.productId && payload?.viewerExternalId ? [{
        provider: 'googleplay', providerTxnId: String(payload.purchaseToken), providerProductId: String(payload.productId),
        viewerExternalId: String(payload.viewerExternalId), status: 'pending', raw: payload,
      }] : [],
      verified: false, note: 'awaiting Play Developer API confirmation',
    };
  },
};

// ---- Manual -----------------------------------------------------------------------
//  An operator recording a payment taken elsewhere (an invoice, a comp). Only
//  reachable through the authenticated management API, so it is "verified" by
//  the operator's credentials.
const manual: PaymentProvider = {
  name: 'manual',
  parseWebhook() { return { events: [], verified: false, note: 'manual has no webhook' }; },
  async verifyReceipt(payload) {
    return {
      events: payload?.viewerExternalId && payload?.productKey ? [{
        provider: 'manual', providerTxnId: String(payload.reference ?? `manual-${Date.now()}`), providerProductId: String(payload.productKey),
        viewerExternalId: String(payload.viewerExternalId), status: 'paid',
        amountCents: payload.amountCents ?? null, currency: payload.currency ?? null, raw: payload,
      }] : [],
      verified: true,
    };
  },
};

export const PROVIDERS: Record<ProviderName, PaymentProvider> = { stripe, appstore, googleplay, manual };
