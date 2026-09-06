// ============================================================================
//  ACCESS RULES — FOR / IF / THEN / TERMS, evaluated.
//
//  Pure. The rule set in these fixtures is the one from Christian's mock:
//    1. FOR this channel                    IF in Australia   THEN free
//    2. FOR linked live                     IF in Australia   THEN free
//    3. FOR linked on-demand + linked live  IF in Australia   THEN members only
//    4. FOR linked on-demand + linked live  IF in World       THEN premium, site users, terms
//
//  Usage: npx tsx test/access-rules.check.ts
// ============================================================================
import { evaluateAccessRules, termPeriodMs, grossCents, type AccessRule, type ViewerCtx } from '../src/services/accessRules';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);

const month = { productKey: 'prem-1m', kind: 'period' as const, count: 1, unit: 'month' as const, priceCents: 999, currency: 'AUD', taxPct: 10 };
const pubDates = { productKey: 'prem-pub', kind: 'published_dates' as const, priceCents: 499, currency: 'USD' };
const RULES: AccessRule[] = [
  { id: 'r1', for: { scopes: ['this'] }, if: { geo: 'in', countries: ['AU'] }, then: { access: 'free' } },
  { id: 'r2', for: { scopes: ['live'] }, if: { geo: 'in', countries: ['AU'] }, then: { access: 'free' } },
  { id: 'r3', for: { scopes: ['ondemand', 'live'] }, if: { geo: 'in', countries: ['AU'] }, then: { access: 'members' } },
  { id: 'r4', for: { scopes: ['ondemand', 'live'] }, if: { geo: 'in', countries: ['WORLD'] }, then: { access: 'premium', userGroups: ['site-users'], terms: [month, pubDates] } },
];
const anon = (c: string): ViewerCtx => ({ country: c, viewerId: null, groups: [], entitlements: [] });
const member = (c: string, groups = ['site-users']): ViewerCtx => ({ country: c, viewerId: 'v1', groups, entitlements: [] });

console.log('== first matching rule decides ==');
check('the channel itself, in Australia: free (rule 1)', evaluateAccessRules(RULES, { relation: 'this' }, anon('AU')).allowed, true);
check('  attributed to r1', (evaluateAccessRules(RULES, { relation: 'this' }, anon('AU')) as any).ruleId, 'r1');
check('linked live in Australia: free (rule 2 beats rule 3, order matters)', (evaluateAccessRules(RULES, { relation: 'live' }, anon('AU')) as any).ruleId, 'r2');
const od = evaluateAccessRules(RULES, { relation: 'ondemand', assetId: 'a1', ownerId: 'ch' }, anon('AU'));
check('linked on-demand in Australia, anonymous: members only', od.allowed, false);
check('  reason', (od as any).reason, 'members_only');
check('  signed-in viewer is let through', evaluateAccessRules(RULES, { relation: 'ondemand' }, member('AU')).allowed, true);

console.log('\n== the world rule: premium ==');
const uk = evaluateAccessRules(RULES, { relation: 'ondemand', assetId: 'a1', ownerId: 'ch' }, anon('GB'));
check('on-demand from the UK: payment required', (uk as any).reason, 'payment_required');
check('  the terms are offered', (uk as any).products?.length, 2);
check('  attributed to r4', (uk as any).ruleId, 'r4');
const ukNotSite = evaluateAccessRules(RULES, { relation: 'ondemand' }, member('GB', ['guests']));
check('signed in but not a site user: group refusal', (ukNotSite as any).reason, 'group');

console.log('\n== an entitlement from the rule\'s product opens it ==');
const bought: ViewerCtx = { ...member('GB'), entitlements: [{ grants: { ruleId: 'r4', scopes: ['ondemand', 'live'] }, validUntil: new Date(Date.now() + 86400e3).toISOString() }] };
check('bought the month: allowed', evaluateAccessRules(RULES, { relation: 'ondemand' }, bought).allowed, true);
check('  via entitlement', (evaluateAccessRules(RULES, { relation: 'ondemand' }, bought) as any).via, 'entitlement');
const lapsed: ViewerCtx = { ...member('GB'), entitlements: [{ grants: { ruleId: 'r4' }, validUntil: new Date(Date.now() - 1000).toISOString() }] };
check('an expired entitlement does not', (evaluateAccessRules(RULES, { relation: 'ondemand' }, lapsed) as any).reason, 'payment_required');
const byAsset: ViewerCtx = { ...member('GB'), entitlements: [{ grants: { assetIds: ['a1'] } }] };
check('a grant naming the asset also opens it', evaluateAccessRules(RULES, { relation: 'ondemand', assetId: 'a1' }, byAsset).allowed, true);
check('  but not another asset', evaluateAccessRules(RULES, { relation: 'ondemand', assetId: 'a2' }, byAsset).allowed, false);

console.log('\n== geo ==');
const only = [{ id: 'g', for: { scopes: ['this' as const] }, if: { geo: 'in' as const, countries: ['AU', 'NZ'] }, then: { access: 'free' as const } }];
check('governed content, viewer outside every region: geo refusal', (evaluateAccessRules(only, { relation: 'this' }, anon('US')) as any).reason, 'geo');
check('NZ is in', evaluateAccessRules(only, { relation: 'this' }, anon('nz')).allowed, true);
const notIn = [{ id: 'n', for: { scopes: ['this' as const] }, if: { geo: 'not_in' as const, countries: ['CN'] }, then: { access: 'free' as const } }];
check('not located in: China refused', (evaluateAccessRules(notIn, { relation: 'this' }, anon('CN')) as any).reason, 'geo');
check('  everyone else free', evaluateAccessRules(notIn, { relation: 'this' }, anon('FR')).allowed, true);
check('unknown country with an allow-list: refused', evaluateAccessRules(only, { relation: 'this' }, anon('')).allowed, false);

console.log('\n== content types in FOR ==');
const typed = [{ id: 't', for: { scopes: [], schemaIds: ['sports'] }, if: { geo: 'in' as const, countries: ['WORLD'] }, then: { access: 'premium' as const, terms: [month] } }];
check('a type rule governs any content of that type', (evaluateAccessRules(typed, { relation: 'ondemand', schemaId: 'sports' }, anon('AU')) as any).reason, 'payment_required');
check('  and nothing else (no rule = allowed)', evaluateAccessRules(typed, { relation: 'ondemand', schemaId: 'talk' }, anon('AU')).allowed, true);
check('no rules at all: allowed via no_rule', (evaluateAccessRules([], { relation: 'this' }, anon('AU')) as any).via, 'no_rule');

console.log('\n== terms ==');
const from = new Date('2026-01-31T00:00:00Z');
check('one month from 31 Jan ends on 28 Feb (clamped, not 3 March)', new Date(from.getTime() + termPeriodMs(month, from)!).toISOString().slice(0, 10), '2026-02-28');
check('one year from 29 Feb 2028 ends 28 Feb 2029', new Date(new Date('2028-02-29T00:00:00Z').getTime() + termPeriodMs({ ...month, count: 1, unit: 'year' }, new Date('2028-02-29T00:00:00Z'))!).toISOString().slice(0, 10), '2029-02-28');
check('7 days', termPeriodMs({ ...month, count: 7, unit: 'day' }, from), 7 * 86400e3);
check('published dates has no period of its own', termPeriodMs(pubDates), null);
check('gross price with tax', grossCents(month), 1099);

console.log(`access-rules: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
