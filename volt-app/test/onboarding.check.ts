/**
 * ONBOARDING CHECK: admin invitation by email, the welcome link -> emailed code
 * -> set password flow, forgotten passwords, and self-service signup in all
 * three modes (waitlist, open trial, paid with a fake Stripe). docs/ONBOARDING.md
 *
 *   DATABASE_URL=postgres://… npx tsx test/onboarding.check.ts
 *
 * Runs the API with SECURITY_CODE_ECHO=1 (development only), so the emailed
 * codes and links come back in responses as devCode / devLink.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';

const DB = process.env.DATABASE_URL ?? 'postgres://volt:volt@localhost:5432/volt';
const ROOT = join(__dirname, '..');
const PW = 'VoltTest!2026';
const DOMAIN = `onb-${randomBytes(3).toString('hex')}.test`;
const procs: ChildProcess[] = [];
let failures = 0, passes = 0;

function ok(cond: boolean, what: string, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`);
  if (cond) passes++; else failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function start(port: number, extra: Record<string, string> = {}) {
  const p = spawn(join(ROOT, 'node_modules/.bin/tsx'), ['src/index.ts'], {
    cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: DB, PORT: String(port), ROLE: 'all', ORCH_LAUNCHER: 'mock', PREWARM_ENABLED: 'false',
      NODE_ENV: 'development', SECURITY_CODE_ECHO: '1', SMS_PROVIDER: 'log', SMTP_URL: '', NOTIFY_FROM: '',
      CONSOLE_BASE_URL: 'https://console.volt.test', SITE_BASE_URL: 'https://volt.test', ...extra },
  });
  p.stdout!.on('data', (d) => { if (process.env.VERBOSE) process.stdout.write(d); });
  p.stderr!.on('data', (d) => { if (process.env.VERBOSE) process.stderr.write(d); });
  procs.push(p);
}
async function ready(api: string) {
  for (let i = 0; i < 180; i++) {
    try { if ((await fetch(`${api}/health/ready`)).ok) return; } catch { /* starting */ }
    await sleep(500);
  }
  throw new Error(`API ${api} never became ready`);
}
function caller(api: string) {
  return async (method: string, path: string, token?: string | null, body?: any, headers: Record<string, string> = {}) => {
    const r = await fetch(api + path, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    let json: any = null;
    try { json = await r.json(); } catch { /* empty */ }
    return { status: r.status, json };
  };
}
const tokenOf = (link?: string) => (link ? new URL(link).hash.replace(/^#t=/, '') : '');

/** The three public steps. Returns the final response. */
async function walk(call: ReturnType<typeof caller>, token: string, password: string, displayName?: string, accountName?: string) {
  const sent = await call('POST', '/api/onboarding/code', null, { token });
  const v = await call('POST', '/api/onboarding/verify', null, { token, code: sent.json?.devCode });
  return call('POST', '/api/onboarding/complete', null, { setupToken: v.json?.setupToken, password, displayName, accountName });
}

async function main() {
  const API = 'http://localhost:18240';
  start(18240);
  await ready(API);
  const call = caller(API);
  const seed = spawnSync(join(ROOT, 'node_modules/.bin/tsx'), ['scripts/seed-access.ts'], {
    cwd: ROOT, env: { ...process.env, DATABASE_URL: DB, SEED_DOMAIN: DOMAIN, SEED_PASSWORD: PW }, encoding: 'utf8' });
  const acct = /Account ([0-9a-f-]{36})/.exec(seed.stdout)?.[1];
  ok(!!acct, 'test users seeded', acct ?? seed.stderr.slice(0, 200));
  if (!acct) return;
  const db = new Client({ connectionString: DB });
  await db.connect();
  try {
    const admin = (await call('POST', '/api/auth/login', null, { email: `admin@${DOMAIN}`, password: PW })).json?.access;
    ok(!!admin, 'owner signs in');
    const roles = (await call('GET', '/api/access-roles', admin)).json;
    const roleList: any[] = Array.isArray(roles) ? roles : roles?.items ?? roles?.member ?? [];
    const eventMgr = roleList.find((r) => r.key === 'event_manager' || r.role_key === 'event_manager' || r.roleKey === 'event_manager');
    const adminRole = roleList.find((r) => r.key === 'administrator' || r.role_key === 'administrator' || r.roleKey === 'administrator');
    ok(!!eventMgr && !!adminRole, 'roles listed', `${roleList.length} roles`);

    // ---- INVITE ------------------------------------------------------------------
    const newEmail = `new.person@${DOMAIN}`;
    const inv = await call('POST', '/api/users/invite', admin, { email: newEmail, displayName: 'Nina New', roleIds: [eventMgr.id] });
    ok(inv.status === 201 && inv.json?.status === 'invited', 'invite creates an invited user', `${inv.status} ${inv.json?.status ?? inv.json?.error}`);
    ok(inv.json?.invite?.sent === true && /^https:\/\/console\.volt\.test\/welcome#t=/.test(inv.json?.invite?.devLink ?? ''), 'welcome link points at the console, token in the fragment', inv.json?.invite?.devLink?.slice(0, 50));
    ok(inv.json?.invite?.sentTo?.startsWith('n') && inv.json.invite.sentTo.includes('•'), 'admin sees the address masked', inv.json?.invite?.sentTo);
    const uid = inv.json?.id;
    const token = tokenOf(inv.json?.invite?.devLink);
    const stored = (await db.query(`SELECT token_hash FROM user_access_links WHERE user_id=$1`, [uid])).rows[0];
    ok(!!stored && stored.token_hash !== token && stored.token_hash.length === 64, 'only a hash of the token is stored');
    ok((await call('POST', '/api/users/invite', admin, { email: newEmail })).status === 400, 'inviting the same address twice is refused');

    const detail = await call('GET', `/api/users/${uid}`, admin);
    ok(!!detail.json?.invite?.expiresAt && detail.json.invite.expired === false, 'user detail shows the open invitation');

    ok((await call('POST', '/api/auth/login', null, { email: newEmail, password: PW })).status === 401, 'an invited user cannot sign in');

    // escalation: an event manager may not invite an administrator
    const evTok = (await call('POST', '/api/auth/login', null, { email: `events@${DOMAIN}`, password: PW })).json?.access;
    const esc = await call('POST', '/api/users/invite', evTok, { email: `sneaky@${DOMAIN}`, roleIds: [adminRole.id] });
    ok(esc.status === 403, 'an operator cannot invite above their own access', String(esc.status));

    // ---- THE LINK -----------------------------------------------------------------
    const look = await call('POST', '/api/onboarding/link', null, { token });
    ok(look.status === 200 && look.json?.kind === 'invite' && look.json?.accountName === 'Volt Access Demo', 'link describes the invitation', JSON.stringify(look.json).slice(0, 120));
    ok(look.json?.email?.includes('•') && look.json?.invitedBy === 'Ada Administrator' && look.json?.founder === false, 'masked email and who invited them (not a founder)');
    const bad = await call('POST', '/api/onboarding/link', null, { token: token.slice(0, -4) + 'AAAA' });
    ok(bad.status === 410 && bad.json?.code === 'link_invalid', 'a wrong token gets the one generic answer', String(bad.status));
    ok((await call('POST', '/api/onboarding/verify', null, { token, code: '123456' })).status === 400, 'verify before any code is sent fails');

    const code = await call('POST', '/api/onboarding/code', null, { token });
    ok(code.status === 200 && /^\d{6}$/.test(code.json?.devCode ?? ''), 'a 6-digit code is emailed', code.json?.sentTo);
    const wrong = await call('POST', '/api/onboarding/verify', null, { token, code: code.json.devCode === '000000' ? '111111' : '000000' });
    ok(wrong.status === 400 && wrong.json?.code === 'invalid_code', 'a wrong code is refused (not a 401)', String(wrong.status));
    ok((await call('POST', '/api/onboarding/complete', null, { setupToken: 'x'.repeat(40), password: 'Good-Pass-2026!' })).status === 401, 'complete without a verified code is refused');
    const ver = await call('POST', '/api/onboarding/verify', null, { token, code: code.json.devCode });
    ok(ver.status === 200 && !!ver.json?.setupToken && ver.json?.expiresIn === 900, 'the right code gives a 15 minute setup token');
    ok((await call('GET', '/api/auth/me', ver.json?.setupToken)).status === 401, 'the setup token is not a session');
    ok((await call('GET', '/api/users', ver.json?.setupToken)).status === 401, 'nor does it open the admin API');
    const verified = (await db.query(`SELECT email_verified_at FROM users WHERE id=$1`, [uid])).rows[0];
    ok(!!verified?.email_verified_at, 'the email address is now verified');

    const weak = await call('POST', '/api/onboarding/complete', null, { setupToken: ver.json.setupToken, password: 'short' });
    ok(weak.status === 400 && weak.json?.code === 'weak_password', 'a short password is refused');
    const mine = await call('POST', '/api/onboarding/complete', null, { setupToken: ver.json.setupToken, password: 'new.person-2026' });
    ok(mine.status === 400, 'a password containing the email name is refused', mine.json?.error);
    const NEWPW = 'Signal-Path-Ready-77';
    const done = await call('POST', '/api/onboarding/complete', null, { setupToken: ver.json.setupToken, password: NEWPW, displayName: 'Nina N.' });
    ok(done.status === 200 && !!done.json?.access && !!done.json?.refresh && done.json?.next === null, 'setting the password signs them in', String(done.status));
    ok((await db.query(`SELECT name FROM accounts WHERE id=$1`, [acct])).rows[0]?.name === 'Volt Access Demo', 'an invited user cannot rename the client');
    const me = await call('GET', '/api/auth/me', done.json?.access);
    ok(me.json?.email === newEmail && me.json?.status === 'active' && me.json?.displayName === 'Nina N.' && me.json?.emailVerified === true, 'they are active, named and verified');
    ok(me.json?.roles?.some((r: any) => r.key === 'event_manager'), 'with the role they were invited with');
    ok((await call('POST', '/api/auth/login', null, { email: newEmail, password: NEWPW })).status === 200, 'and can sign in with the new password');
    ok((await call('POST', '/api/onboarding/link', null, { token })).status === 410, 'the link is spent');
    ok((await call('POST', '/api/onboarding/complete', null, { setupToken: ver.json.setupToken, password: 'Another-Pass-2026' })).status === 410, 'the setup token cannot be used twice');
    ok((await call('POST', `/api/users/${uid}/invite`, admin)).status === 400, 'an active user cannot be re-invited');

    // ---- RESEND AND WITHDRAW ----------------------------------------------------------
    const inv2 = await call('POST', '/api/users/invite', admin, { email: `second@${DOMAIN}`, roleIds: [eventMgr.id] });
    const t1 = tokenOf(inv2.json?.invite?.devLink);
    const re = await call('POST', `/api/users/${inv2.json?.id}/invite`, admin);
    const t2 = tokenOf(re.json?.devLink);
    ok(re.status === 200 && !!t2 && t2 !== t1, 'resend gives a new link');
    ok((await call('POST', '/api/onboarding/link', null, { token: t1 })).status === 410, 'the old link stops working');
    ok((await call('POST', '/api/onboarding/link', null, { token: t2 })).status === 200, 'the new one works');
    const wd = await call('DELETE', `/api/users/${inv2.json?.id}/invite`, admin);
    ok(wd.status === 200 && wd.json?.revoked === 1, 'withdraw the invitation');
    ok((await call('POST', '/api/onboarding/link', null, { token: t2 })).status === 410, 'a withdrawn link is dead');
    const det2 = await call('GET', `/api/users/${inv2.json?.id}`, admin);
    ok(det2.json?.invite === null && det2.json?.status === 'invited', 'the user stays invited with no open link');

    // A disabled invitee: the link dies with them.
    const inv3 = await call('POST', '/api/users/invite', admin, { email: `third@${DOMAIN}` });
    await call('PATCH', `/api/users/${inv3.json?.id}`, admin, { status: 'disabled' });
    ok((await call('POST', '/api/onboarding/link', null, { token: tokenOf(inv3.json?.invite?.devLink) })).status === 410, 'disabling an invited user kills their link');

    // ---- FORGOT PASSWORD ----------------------------------------------------------------
    const unknown = await call('POST', '/api/onboarding/forgot', null, { email: `nobody@${DOMAIN}` });
    const known = await call('POST', '/api/onboarding/forgot', null, { email: newEmail });
    ok(unknown.status === 202 && known.status === 202 && unknown.json?.message === known.json?.message, 'forgot password answers the same for any address');
    ok(!unknown.json?.devLink && /\/reset-password#t=/.test(known.json?.devLink ?? ''), 'only a real account gets a reset link');
    const before = (await call('POST', '/api/auth/login', null, { email: newEmail, password: NEWPW })).json;
    const reset = await walk(call, tokenOf(known.json.devLink), 'Fresh-Reset-Pass-31');
    ok(reset.status === 200 && !!reset.json?.access, 'reset sets the new password and signs in');
    ok((await call('POST', '/api/auth/login', null, { email: newEmail, password: NEWPW })).status === 401, 'the old password no longer works');
    ok((await call('POST', '/api/auth/refresh', null, { refresh: before?.refresh })).status === 401, 'sessions from before the reset are ended');
    const fInv = await call('POST', '/api/onboarding/forgot', null, { email: `second@${DOMAIN}` });
    ok(/\/welcome#t=/.test(fInv.json?.devLink ?? ''), 'forgot password for someone still invited sends a fresh welcome link');

    // ---- ACCOUNT REQUIRES TWO-STEP SIGN-IN ---------------------------------------------
    await db.query(`UPDATE accounts SET require_admin_mfa=true WHERE id=$1`, [acct]);
    const inv4 = await call('POST', '/api/users/invite', admin, { email: `mfa.person@${DOMAIN}`, roleIds: [eventMgr.id] });
    const mfaDone = await walk(call, tokenOf(inv4.json?.invite?.devLink), 'Two-Step-Ready-2026');
    ok(mfaDone.status === 200 && mfaDone.json?.mfaSetupRequired === true && !!mfaDone.json?.challenge && !mfaDone.json?.access, 'with the policy on they are taken to set up a second step, not given a session');
    await db.query(`UPDATE accounts SET require_admin_mfa=false WHERE id=$1`, [acct]);

    // ---- SIGNUP: waitlist (default mode) ---------------------------------------------------
    const cfg = await call('GET', '/api/signup/config');
    ok(cfg.json?.mode === 'waitlist' && cfg.json?.plans?.length >= 3 && cfg.json.plans.every((p: any) => p.purchasable === false), 'waitlist mode by default, nothing for sale', cfg.json?.mode);
    ok(!JSON.stringify(cfg.json).includes('price_'), 'no Stripe ids in the public config');
    const lead = await call('POST', '/api/signup', null, { email: `lead@${DOMAIN}`, name: 'Lee Lead', company: 'Lead Media', plan: 'pro', source: { utm_source: 'test' } });
    ok(lead.status === 202 && lead.json?.status === 'waitlist', 'register in waitlist mode');
    const leadRow = (await db.query(`SELECT * FROM saas_signups WHERE email=$1`, [`lead@${DOMAIN}`])).rows[0];
    ok(leadRow?.status === 'lead' && leadRow?.source?.utm_source === 'test' && !leadRow.account_id, 'stored as a lead, no account made');
    const bot = await call('POST', '/api/signup', null, { email: `bot@${DOMAIN}`, website: 'http://spam' });
    ok(bot.status === 202 && (await db.query(`SELECT 1 FROM saas_signups WHERE email=$1`, [`bot@${DOMAIN}`])).rowCount === 0, 'the honeypot drops bots quietly');
    ok((await call('GET', '/api/platform/signups', admin)).status === 403, 'the signup list is for platform staff only');

    // ---- SIGNUP: open (trial) ------------------------------------------------------------------
    const OPEN = 'http://localhost:18241';
    start(18241, { SIGNUP_MODE: 'open' });
    await ready(OPEN);
    const open = caller(OPEN);
    const ocfg = await open('GET', '/api/signup/config');
    ok(ocfg.json?.mode === 'open' && ocfg.json.plans.find((p: any) => p.key === 'starter')?.trialDays === 14, 'open mode offers trials');
    const trialEmail = `founder@trial-${DOMAIN}`;
    const noOrg = await open('POST', '/api/signup', null, { email: `noorg@${DOMAIN}`, name: 'No Org', plan: 'starter' });
    ok(noOrg.status === 400 && /organisation/i.test(noOrg.json?.error ?? ''), 'a trial needs the organisation (client) name', noOrg.json?.error);
    const tr = await open('POST', '/api/signup', null, { email: trialEmail, name: 'Fay Founder', company: 'Trial Broadcasting', plan: 'starter' });
    ok(tr.status === 202 && tr.json?.status === 'check_email' && /\/welcome#t=/.test(tr.json?.devLink ?? ''), 'open signup emails a welcome link', tr.json?.status);
    const trAcct = (await db.query(`SELECT a.* FROM accounts a JOIN users u ON u.account_id=a.id WHERE u.email=$1`, [trialEmail])).rows[0];
    ok(trAcct?.name === 'Trial Broadcasting' && trAcct?.plan_tier === 'starter' && trAcct?.max_channels === 2 && trAcct?.status === 'active', 'account made on the plan', `${trAcct?.plan_tier} ${trAcct?.max_channels}`);
    const look2 = await open('POST', '/api/onboarding/link', null, { token: tokenOf(tr.json.devLink) });
    ok(look2.json?.invitedBy === null && look2.json?.accountName === 'Trial Broadcasting' && look2.json?.founder === true, 'self-service link names the client and marks the founder');
    const trDone = await walk(open, tokenOf(tr.json.devLink), 'Trial-Owner-Pass-26', 'Fay Founder', 'Trial Broadcasting Ltd');
    ok(trDone.json?.next === 'invite_team', 'the founder is sent on to invite their team');
    const trMe = await open('GET', '/api/auth/me', trDone.json?.access);
    ok(trMe.json?.role === 'owner' && trMe.json?.roles?.some((r: any) => r.key === 'administrator') && trMe.json?.account?.name === 'Trial Broadcasting Ltd', 'the founder owns the client, holding Administrator, and renamed it');
    // From the client account, the founder invites a colleague: same flow, into the same client.
    const mate = await open('POST', '/api/users/invite', trDone.json?.access, { email: `colleague@trial-${DOMAIN}`, displayName: 'Cal Colleague' });
    ok(mate.status === 201 && mate.json?.invite?.sent === true, 'the founder invites a colleague', String(mate.status));
    const mLook = await open('POST', '/api/onboarding/link', null, { token: tokenOf(mate.json?.invite?.devLink) });
    ok(mLook.json?.accountName === 'Trial Broadcasting Ltd' && mLook.json?.invitedBy === 'Fay Founder' && mLook.json?.founder === false, 'the colleague sees the client and who invited them');
    const mDone = await walk(open, tokenOf(mate.json?.invite?.devLink), 'Studio-Gallery-2026');
    const mMe = await open('GET', '/api/auth/me', mDone.json?.access);
    ok(mMe.json?.account?.id === trMe.json?.account?.id && mMe.json?.account?.id !== acct, 'the colleague joins the founder\'s client, nobody else\'s');
    const trCount = (await db.query(`SELECT count(*)::int AS n FROM accounts WHERE name='Trial Broadcasting Ltd'`)).rows[0].n;
    const again = await open('POST', '/api/signup', null, { email: trialEmail, company: 'Again Co', plan: 'starter' });
    const count = (await db.query(`SELECT count(*)::int AS n FROM accounts WHERE name LIKE 'Trial Broadcasting%'`)).rows[0].n;
    ok(again.status === 202 && again.json?.status === 'check_email' && !again.json?.devLink && count === 1 && trCount === 1, 'registering a known address makes no second account and says nothing different');
    const ent = await open('POST', '/api/signup', null, { email: `big@${DOMAIN}`, company: 'Big Net', plan: 'enterprise' });
    ok(ent.json?.status === 'contact', 'enterprise is a talk-to-us lead even in open mode');

    // ---- SIGNUP: paid (fake Stripe) -------------------------------------------------------------
    const WHSEC = 'whsec_test_' + randomBytes(8).toString('hex');
    let lastStripeBody = '';
    const fakeStripe: Server = createServer((req, res) => {
      let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
        lastStripeBody = b;
        const ok2 = req.url === '/v1/checkout/sessions' && req.headers.authorization === 'Bearer sk_test_fake';
        res.writeHead(ok2 ? 200 : 401, { 'content-type': 'application/json' });
        res.end(JSON.stringify(ok2 ? { id: 'cs_test_' + randomBytes(6).toString('hex'), url: 'https://checkout.stripe.test/pay/abc' } : { error: { message: 'bad key' } }));
      });
    });
    await new Promise<void>((r) => fakeStripe.listen(18249, r));
    const PAID = 'http://localhost:18242';
    start(18242, { SIGNUP_MODE: 'paid', SAAS_STRIPE_SECRET_KEY: 'sk_test_fake', SAAS_STRIPE_PRICE_STARTER: 'price_starter_test', STRIPE_API_BASE: 'http://localhost:18249', SAAS_STRIPE_WEBHOOK_SECRET: WHSEC });
    await ready(PAID);
    const paid = caller(PAID);
    const pcfg = await paid('GET', '/api/signup/config');
    ok(pcfg.json?.onlinePurchase === true && pcfg.json.plans.find((p: any) => p.key === 'starter')?.purchasable === true && pcfg.json.plans.find((p: any) => p.key === 'pro')?.purchasable === false, 'only plans with a Stripe price can be bought');
    const buyer = `buyer@paid-${DOMAIN}`;
    const ps = await paid('POST', '/api/signup', null, { email: buyer, name: 'Bo Buyer', company: 'Paid Pictures', plan: 'starter' });
    ok(ps.status === 202 && ps.json?.status === 'checkout' && ps.json?.checkoutUrl === 'https://checkout.stripe.test/pay/abc', 'paid signup hands over to Stripe Checkout');
    const sp = new URLSearchParams(lastStripeBody);
    ok(sp.get('line_items[0][price]') === 'price_starter_test' && sp.get('customer_email') === buyer && sp.get('mode') === 'subscription' && (sp.get('success_url') ?? '').startsWith('https://volt.test/thanks.html'), 'the checkout session carries price, email and return pages');
    const row = (await db.query(`SELECT s.*, a.status AS acct_status, u.status AS user_status FROM saas_signups s JOIN accounts a ON a.id=s.account_id JOIN users u ON u.id=s.user_id WHERE s.email=$1`, [buyer])).rows[0];
    ok(row?.status === 'checkout' && row?.acct_status === 'pending' && row?.user_status === 'invited', 'account waits, pending, until payment');
    ok((await db.query(`SELECT 1 FROM user_access_links WHERE user_id=$1`, [row?.user_id])).rowCount === 0, 'no welcome link before payment');
    ok((await paid('POST', '/api/signup', null, { email: `x@${DOMAIN}`, plan: 'pro' })).status === 400, 'a plan without a Stripe price cannot be bought');
    const st1 = await paid('POST', '/api/signup/checkout-status', null, { sessionId: row.checkout_session_id });
    ok(st1.json?.status === 'pending', 'thank-you page sees pending before the webhook');

    const event = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: row.checkout_session_id, client_reference_id: row.id, payment_status: 'paid', customer: 'cus_1', subscription: 'sub_1' } } });
    const sig = (body: string, secret = WHSEC) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`; };
    const forged = await paid('POST', '/api/signup/webhooks/stripe', null, event, { 'stripe-signature': sig(event, 'whsec_wrong') });
    ok(forged.status === 400, 'a webhook with the wrong signature is refused');
    const wh = await paid('POST', '/api/signup/webhooks/stripe', null, event, { 'stripe-signature': sig(event) });
    ok(wh.status === 200 && wh.json?.outcome === 'activated', 'payment activates the account', wh.json?.outcome);
    const after = (await db.query(`SELECT s.status, a.status AS acct_status, s.stripe_subscription_id FROM saas_signups s JOIN accounts a ON a.id=s.account_id WHERE s.id=$1`, [row.id])).rows[0];
    ok(after?.status === 'active' && after?.acct_status === 'active' && after?.stripe_subscription_id === 'sub_1', 'signup and account active, subscription recorded');
    ok((await db.query(`SELECT 1 FROM user_access_links WHERE user_id=$1 AND kind='invite'`, [row.user_id])).rowCount === 1, 'the welcome link is sent after payment');
    ok((await paid('POST', '/api/signup/webhooks/stripe', null, event, { 'stripe-signature': sig(event) })).json?.outcome === 'already active', 'a retried webhook changes nothing');
    ok((await paid('POST', '/api/signup/checkout-status', null, { sessionId: row.checkout_session_id })).json?.status === 'active', 'thank-you page sees active');
    const cancel = JSON.stringify({ id: 'evt_2', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1' } } });
    const cw = await paid('POST', '/api/signup/webhooks/stripe', null, cancel, { 'stripe-signature': sig(cancel) });
    const susp = (await db.query(`SELECT status FROM accounts WHERE id=$1`, [row.account_id])).rows[0];
    ok(cw.json?.outcome === 'suspended' && susp?.status === 'suspended', 'a cancelled subscription suspends the account');
    fakeStripe.close();
  } finally {
    await db.end();
  }
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(() => {
    for (const p of procs) { try { process.kill(-p.pid!, 'SIGTERM'); } catch { /* gone */ } }
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  });
