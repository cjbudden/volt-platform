// ============================================================================
//  SAAS PLANS: what the promo site offers and what a new account gets.
//
//  Billing follows the pricing model: server time plus bandwidth. A plan is
//  the entitlement (how many channels, how many run at once, ladder size) and
//  the monthly platform fee that Stripe collects at checkout. Metered usage
//  (server minutes, GB delivered) is reported separately by the usage reports
//  and is not part of checkout.
//
//  The catalogue below is the default. Override it whole with SAAS_PLANS_JSON
//  (a JSON array of the same shape), and connect each plan to Stripe with
//  SAAS_STRIPE_PRICE_<KEY> (for example SAAS_STRIPE_PRICE_STARTER=price_123).
//  A plan with no Stripe price cannot be bought online: the site shows
//  "Talk to us" for it instead.
// ============================================================================

export interface SaasPlan {
  key: string;
  name: string;
  tagline: string;
  /** What the site prints, e.g. "$99 per month". Null hides the price. */
  priceLabel: string | null;
  /** Small print under the price, e.g. "plus $0.12 per GB delivered". */
  priceNote: string | null;
  features: string[];
  maxChannels: number;
  maxConcurrent: number;
  maxRenditions: number;
  /** Talk to sales instead of buying online. */
  contactSales?: boolean;
  /** The plan the site draws attention to. */
  highlight?: boolean;
  trialDays?: number;
}

const DEFAULT_PLANS: SaasPlan[] = [
  {
    key: 'starter', name: 'Starter', tagline: 'One channel or a run of events, on air today.',
    priceLabel: '$99 per month', priceNote: 'Server time for events and $0.12 per GB delivered are billed on use',
    features: ['2 live channels or stations', '1 running at once', 'Live → VOD recordings and clips', 'Web player and share links', 'Email support'],
    maxChannels: 2, maxConcurrent: 1, maxRenditions: 4, trialDays: 14,
  },
  {
    key: 'pro', name: 'Pro', tagline: 'A small network: channels, events, radio and FAST.',
    priceLabel: '$490 per month', priceNote: 'Server time for events and $0.12 per GB delivered are billed on use',
    features: ['10 live channels or stations', '5 running at once', 'EPG, FAST and VOD → Live', 'Captions and translation add-ons', 'Analytics and operating reports', 'Priority support'],
    maxChannels: 10, maxConcurrent: 5, maxRenditions: 6, highlight: true, trialDays: 14,
  },
  {
    key: 'enterprise', name: 'Enterprise', tagline: 'Your own capacity, rights rules, DRM and single sign-on.',
    priceLabel: null, priceNote: 'Committed capacity and bandwidth, priced to your workload',
    features: ['Channels and concurrency to suit', 'DRM and geo rights at the edge', 'Single sign-on and sub-accounts', 'Dedicated servers on request', 'Named engineer'],
    maxChannels: 50, maxConcurrent: 20, maxRenditions: 8, contactSales: true,
  },
];

function loadCatalogue(): SaasPlan[] {
  const raw = process.env.SAAS_PLANS_JSON;
  if (raw) {
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v) && v.every((p) => p && typeof p.key === 'string' && typeof p.name === 'string')) return v;
      console.error('[signup] SAAS_PLANS_JSON is not an array of plans; using the default catalogue');
    } catch (e: any) { console.error('[signup] SAAS_PLANS_JSON does not parse; using the default catalogue', e?.message); }
  }
  return DEFAULT_PLANS;
}

export function stripePriceFor(key: string): string | null {
  return process.env[`SAAS_STRIPE_PRICE_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] || null;
}

export function plans(): SaasPlan[] { return loadCatalogue(); }
export function planByKey(key: string | null | undefined): SaasPlan | null {
  if (!key) return null;
  return loadCatalogue().find((p) => p.key === key) ?? null;
}

/** The public view: no Stripe ids, and whether each can be bought online right now. */
export function publicPlans(mode: SignupMode) {
  return loadCatalogue().map((p) => ({
    key: p.key, name: p.name, tagline: p.tagline, priceLabel: p.priceLabel, priceNote: p.priceNote,
    features: p.features, highlight: !!p.highlight, contactSales: !!p.contactSales,
    trialDays: mode === 'open' ? (p.trialDays ?? 0) : 0,
    purchasable: mode === 'paid' && !p.contactSales && !!stripePriceFor(p.key),
  }));
}

/**
 * SIGNUP_MODE decides what "Register" on the promo site does:
 *   waitlist  (default) store the lead and email a thank-you. Platform staff let people in later.
 *   open      make the account straight away (a trial) and email the welcome link.
 *   paid      Stripe Checkout first; the account is made pending and activated by the webhook.
 *   off       registration is closed (the site still shows the product).
 */
export type SignupMode = 'waitlist' | 'open' | 'paid' | 'off';
export function signupMode(): SignupMode {
  const m = (process.env.SIGNUP_MODE ?? 'waitlist').toLowerCase();
  return (['waitlist', 'open', 'paid', 'off'] as const).includes(m as SignupMode) ? (m as SignupMode) : 'waitlist';
}

/** Where the promo site is, for Stripe's return addresses. */
export function siteBase(): string {
  return (process.env.SITE_BASE_URL || 'http://localhost:4173').replace(/\/+$/, '');
}
