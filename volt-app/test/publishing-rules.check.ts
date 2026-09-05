// ============================================================================
//  PUBLISHING RULES — the ladder resolves per field, most specific wins.
//
//  Pure. Pins: the baseline when nothing is set; that an owner rung that
//  states one key takes only that key; that a schema rung sits under the
//  owner rung and over the account; that the asset rung beats all; that
//  `paywall: null` is an explicit clearing, not an inherit; that the source
//  of every field is named; and the window arithmetic.
//
//  Usage: npx tsx test/publishing-rules.check.ts
// ============================================================================
import { resolveLadder, windowFor, BASELINE } from '../src/services/publishingRules';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const j = (v: unknown) => JSON.stringify(v);

console.log('== nothing set: the baseline ==');
const none = resolveLadder([{ rung: 'account', settings: {} }, { rung: 'schema', settings: null }, { rung: 'owner', settings: undefined }, { rung: 'asset', settings: {} }]);
check('targets = portal', j(none.settings.targets), j(BASELINE.targets));
check('geo worldwide', none.settings.geo.mode, 'worldwide');
check('access free', none.settings.access, 'free');
check('every field is from the baseline', Object.values(none.sources).every((s) => s === 'baseline'), true);

console.log('\n== the account default ==');
const acc = { targets: [{ kind: 'portal' as const }, { kind: 'app' as const, appId: 'web' }], expire: { mode: 'days' as const, days: 30 }, gate: { requireReview: true, blockOnQcFail: true } };
const a = resolveLadder([{ rung: 'account', settings: acc }, { rung: 'schema', settings: {} }, { rung: 'owner', settings: {} }, { rung: 'asset', settings: {} }]);
check('account targets apply', j(a.settings.targets), j(acc.targets));
check('account expiry applies', j(a.settings.expire), j(acc.expire));
check('and is attributed to the account', a.sources.expire, 'account');
check('untouched fields stay baseline', a.sources.geo, 'baseline');

console.log('\n== content type over account, owner over type, per field ==');
const sch = { targets: [{ kind: 'portal' as const }, { kind: 'social' as const, targetId: 'yt', platform: 'youtube' }], geo: { mode: 'allow' as const, countries: ['AU', 'NZ'] } };
const own = { targets: [{ kind: 'app' as const, appId: 'tv' }] };   // states ONE key
const r = resolveLadder([{ rung: 'account', settings: acc }, { rung: 'schema', settings: sch }, { rung: 'owner', settings: own }, { rung: 'asset', settings: {} }]);
check('owner targets win', j(r.settings.targets), j(own.targets));
check('attributed to the owner', r.sources.targets, 'owner');
check('geo comes from the type (owner did not say)', r.settings.geo.mode, 'allow');
check('attributed to the schema', r.sources.geo, 'schema');
check('expiry still from the account', j(r.settings.expire), j(acc.expire));
check('gate still from the account', r.sources.gate, 'account');

console.log('\n== the asset beats everything ==');
const ast = { access: 'paid' as const, paywall: { tier: 'premium', priceCents: 499, currency: 'AUD' }, geo: { mode: 'worldwide' as const, countries: [] } };
const x = resolveLadder([{ rung: 'account', settings: acc }, { rung: 'schema', settings: sch }, { rung: 'owner', settings: own }, { rung: 'asset', settings: ast }]);
check('asset access', x.settings.access, 'paid');
check('asset paywall', x.settings.paywall?.tier, 'premium');
check('asset geo overrides the type', x.settings.geo.mode, 'worldwide');
check('attributed to the asset', x.sources.geo, 'asset');
check('owner targets still stand', r.sources.targets, 'owner');

console.log('\n== paywall: null clears, absent inherits ==');
const clear = resolveLadder([{ rung: 'account', settings: { access: 'paid', paywall: { tier: 'p' } } }, { rung: 'schema', settings: {} }, { rung: 'owner', settings: { paywall: null } }, { rung: 'asset', settings: {} }]);
check('null at the owner clears the paywall', clear.settings.paywall, null);
check('and is attributed to the owner', clear.sources.paywall, 'owner');
const inh = resolveLadder([{ rung: 'account', settings: { paywall: { tier: 'p' } } }, { rung: 'schema', settings: {} }, { rung: 'owner', settings: {} }, { rung: 'asset', settings: {} }]);
check('absent inherits', inh.settings.paywall?.tier, 'p');

console.log('\n== the window ==');
const now = new Date('2026-09-05T10:00:00Z');
const w1 = windowFor({ ...BASELINE }, now);
check('publish now, never expires: from = now', w1.from.toISOString(), now.toISOString());
check('until null', w1.until, null);
const w2 = windowFor({ ...BASELINE, expire: { mode: 'days', days: 7 } }, now);
check('7 days: until = from + 7d', w2.until?.toISOString(), '2026-09-12T10:00:00.000Z');
const w3 = windowFor({ ...BASELINE, availableFrom: { mode: 'at', at: '2026-10-01T00:00:00Z' }, expire: { mode: 'days', days: 1 } }, now);
check('scheduled: from is the set time', w3.from.toISOString(), '2026-10-01T00:00:00.000Z');
check('and days count from it, not from now', w3.until?.toISOString(), '2026-10-02T00:00:00.000Z');
const w4 = windowFor({ ...BASELINE, expire: { mode: 'at', at: '2026-12-31T00:00:00Z' } }, now);
check('a set end date', w4.until?.toISOString(), '2026-12-31T00:00:00.000Z');

console.log(`publishing-rules: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
