// ============================================================================
//  ACCESS RULES — FOR what, IF the viewer is where, THEN what access, under
//  which TERMS.
//
//  Christian's rules engine, carried into the ladder. A rule set is an ordered
//  list; the first rule whose FOR matches the content and whose IF matches
//  the viewer decides. Each rule:
//
//    FOR   which content it governs. Christian's definitions: 'this' is the
//          current channel, event or station itself (on an item's own rung,
//          the item); 'ondemand' is the linked items, every VOD or AOD asset
//          made from that owner's recordings; 'live' is reserved for live
//          streams linked to the owner (an event carried on a channel) once
//          that link exists. And/or named content types.
//    IF    where the viewer is: located in these countries, or NOT located in
//          them. 'WORLD' matches everywhere.
//    THEN  free | members (the viewer must be signed in to the client's app,
//          optionally in one of these groups) | premium (the viewer needs an
//          entitlement bought under one of the TERMS, optionally restricted to
//          user groups).
//    TERMS the purchasable packages: a period (1 month for 9.99 AUD + tax) or
//          the item's published dates (pay once for as long as it is up).
//
//  The evaluator is PURE. It is given the rules, what the content is, and
//  what is known about the viewer (country, groups, live entitlements), and
//  it answers allow / deny with a reason and, for premium, the products the
//  viewer could buy. The platform never talks to a payment provider here;
//  providers take the money, this decides what the money buys.
// ============================================================================

export type ForScope = 'this' | 'live' | 'ondemand';
export interface AccessTerm {
  /** Stable key: the product this term is sold as at every provider. */
  productKey: string;
  kind: 'period' | 'published_dates';
  count?: number;                       // period only
  unit?: 'day' | 'week' | 'month' | 'year';
  priceCents: number;
  currency: string;                     // ISO 4217
  taxPct?: number;
  name?: string;
}
export interface AccessRule {
  id: string;
  for: { scopes: ForScope[]; schemaIds?: string[] };
  if: { geo: 'in' | 'not_in'; countries: string[] };   // ['WORLD'] = everywhere
  then: {
    access: 'free' | 'members' | 'premium';
    userGroups?: string[];             // members / premium: restrict to these viewer groups
    terms?: AccessTerm[];              // premium: what can be bought
  };
}

export interface ContentRef {
  /** Is the thing being played the owner/asset the rule is on, or linked content? */
  relation: ForScope;
  schemaId?: string | null;
  assetId?: string | null;
  ownerId?: string | null;
}
export interface ViewerCtx {
  country?: string | null;            // ISO-3166 alpha-2
  /** null = anonymous (not signed in to the client's app). */
  viewerId?: string | null;
  groups?: string[];
  entitlements?: { grants: Grants; validUntil?: string | Date | null; productKey?: string | null }[];
}
export interface Grants {
  scopes?: ForScope[];
  ownerIds?: string[];
  schemaIds?: string[];
  assetIds?: string[];
  /** Which rule the product came from; a grant matches content the rule governs. */
  ruleId?: string;
  /** The owner or asset the rule was attached to (the meaning of 'this'). */
  anchorId?: string | null;
}

export type AccessOutcome =
  | { allowed: true; via: 'free' | 'members' | 'entitlement' | 'no_rule'; ruleId?: string }
  | { allowed: false; reason: 'geo' | 'members_only' | 'group' | 'payment_required' | 'no_rule_denies'; ruleId?: string; message: string; products?: AccessTerm[] };

const norm = (c?: string | null) => (c || '').trim().toUpperCase();

export function ruleMatchesContent(rule: AccessRule, content: ContentRef): boolean {
  const scopes = rule.for.scopes ?? [];
  const byScope = scopes.includes(content.relation);
  const bySchema = !!(rule.for.schemaIds?.length && content.schemaId && rule.for.schemaIds.includes(content.schemaId));
  // A rule with content types but no scopes governs those types anywhere; a
  // rule with scopes and types governs content that is both.
  if (rule.for.schemaIds?.length && scopes.length) return byScope && bySchema;
  if (rule.for.schemaIds?.length) return bySchema;
  return byScope;
}

export function ruleMatchesViewer(rule: AccessRule, viewer: ViewerCtx): boolean {
  const list = (rule.if.countries ?? []).map(norm);
  const world = list.includes('WORLD') || list.length === 0;
  const c = norm(viewer.country);
  const inList = world || (!!c && list.includes(c));
  return rule.if.geo === 'in' ? inList : !inList;
}

/** Does any live entitlement cover this content? */
export function entitled(viewer: ViewerCtx, content: ContentRef, rule: AccessRule, now = new Date()): boolean {
  for (const e of viewer.entitlements ?? []) {
    if (e.validUntil && new Date(e.validUntil) < now) continue;
    const g = e.grants ?? {};
    if (g.ruleId && g.ruleId === rule.id) return true;
    if (g.assetIds?.length && content.assetId && g.assetIds.includes(content.assetId)) return true;
    if (g.ownerIds?.length && content.ownerId && g.ownerIds.includes(content.ownerId)) return true;
    if (g.schemaIds?.length && content.schemaId && g.schemaIds.includes(content.schemaId)) return true;
    if (g.scopes?.length && g.scopes.includes(content.relation) && (!g.anchorId || g.anchorId === content.ownerId || g.anchorId === content.assetId)) return true;
  }
  return false;
}

/**
 * Evaluate an ordered rule set. First match decides; no match = allowed (the
 * simple geo/access fields on the same rung still apply, see availability).
 */
export function evaluateAccessRules(rules: AccessRule[] | undefined | null, content: ContentRef, viewer: ViewerCtx, now = new Date()): AccessOutcome {
  if (!rules?.length) return { allowed: true, via: 'no_rule' };
  let sawContentMatch = false;
  for (const rule of rules) {
    if (!ruleMatchesContent(rule, content)) continue;
    sawContentMatch = true;
    if (!ruleMatchesViewer(rule, viewer)) continue;
    const t = rule.then;
    if (t.access === 'free') return { allowed: true, via: 'free', ruleId: rule.id };
    const inGroup = !t.userGroups?.length || (viewer.groups ?? []).some((g) => t.userGroups!.includes(g));
    if (t.access === 'members') {
      if (!viewer.viewerId) return { allowed: false, reason: 'members_only', ruleId: rule.id, message: 'Sign in to watch this.' };
      if (!inGroup) return { allowed: false, reason: 'group', ruleId: rule.id, message: `Available to ${t.userGroups!.join(', ')} only.` };
      return { allowed: true, via: 'members', ruleId: rule.id };
    }
    // premium
    if (entitled(viewer, content, rule, now)) return { allowed: true, via: 'entitlement', ruleId: rule.id };
    if (t.userGroups?.length && viewer.viewerId && !inGroup) return { allowed: false, reason: 'group', ruleId: rule.id, message: `Available to ${t.userGroups.join(', ')} only.` };
    return { allowed: false, reason: 'payment_required', ruleId: rule.id, message: 'This is premium content.', products: t.terms ?? [] };
  }
  // Rules exist for this content but none matched the viewer's location: the
  // content is governed and the viewer is outside every allowed region.
  if (sawContentMatch) return { allowed: false, reason: 'geo', message: 'Not available in your region.' };
  return { allowed: true, via: 'no_rule' };
}

/** Length of a period term in ms from a start; null for published_dates (the item's own window). */
export function termPeriodMs(term: AccessTerm, from = new Date()): number | null {
  if (term.kind !== 'period' || !term.count || !term.unit) return null;
  const d = new Date(from);
  // Month and year steps clamp to the last day of the target month: a month
  // bought on 31 January ends on 28 February, not 3 March.
  const addMonths = (n: number) => {
    const day = d.getUTCDate();
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  };
  switch (term.unit) {
    case 'day': d.setUTCDate(d.getUTCDate() + term.count); break;
    case 'week': d.setUTCDate(d.getUTCDate() + 7 * term.count); break;
    case 'month': addMonths(term.count); break;
    case 'year': addMonths(12 * term.count); break;
  }
  return d.getTime() - from.getTime();
}

/** What a product made from this rule's term grants. */
export function grantsFor(rule: AccessRule, anchorId: string | null): Grants {
  return { ruleId: rule.id, scopes: rule.for.scopes, schemaIds: rule.for.schemaIds ?? [], anchorId };
}

/** Price including tax, in cents, for display. */
export function grossCents(t: AccessTerm): number {
  return Math.round(t.priceCents * (1 + (t.taxPct ?? 0) / 100));
}
