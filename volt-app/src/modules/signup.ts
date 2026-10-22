/**
 * SELF-SERVICE SIGNUP from the promo site (volt-site/), docs/ONBOARDING.md.
 *
 *   PUBLIC (no session; the site may be on another origin, CORS_ORIGIN)
 *     GET  /api/signup/config            mode, plans, whether online purchase is on
 *     POST /api/signup                   {email, name?, company?, plan?, website (honeypot), source?}
 *     POST /api/signup/checkout-status   {sessionId}   the thank-you page asks how a payment went
 *
 *   STRIPE (verified by signature, raw body; mounted before the JSON parser)
 *     POST /api/signup/webhooks/stripe   checkout.session.completed -> activate + welcome email
 *                                        customer.subscription.deleted -> suspend the account
 *
 *   PLATFORM STAFF (SaaS admin)
 *     GET  /api/platform/signups               the registrations, newest first (?status=&q=)
 *     POST /api/platform/signups/:id/invite    let a waitlist lead in: make the account, send the welcome
 *
 * Whatever the mode, a new account's first user goes through exactly the same
 * welcome link -> emailed code -> choose a password path an invited admin user
 * does (services/onboarding.ts). Registration never takes a password, so the
 * site never handles one and an address cannot be claimed by someone who does
 * not hold the mailbox.
 *
 * Answers never reveal whether an address already has an account: a known
 * address gets the same "check your email" answer and an email pointing to
 * sign-in and password reset instead of a second account.
 */
import { Router, raw as rawBody } from 'express';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { one, query, tx } from '../db';
import { asyncHandler, badRequest, forbidden, notFound, ApiError } from '../util/http';
import { limit } from '../scale/ratelimit';
import { requirePlatform } from '../auth/platform';
import { writeAudit } from '../services/audit';
import { ensureDefaultRoles } from '../auth/defaultRoles';
import { sendTransactionalEmail, echoCodes } from '../services/securityDelivery';
import { alreadyRegisteredEmail, waitlistEmail } from '../services/mail/templates';
import { sendInvite, unusablePasswordHash, consoleBase } from '../services/onboarding';
import { plans as allPlans, publicPlans, planByKey, signupMode, stripePriceFor, siteBase, type SaasPlan } from '../services/saasPlans';
import { createCheckoutSession, stripeConfigured, verifyStripeSignature } from '../services/stripeCheckout';

export const signupRouter = Router();
export const signupWebhookRouter = Router();
export const platformSignupsRouter = Router();

signupRouter.get('/config', asyncHandler(async (_req, res) => {
  const mode = signupMode();
  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    mode,
    plans: publicPlans(mode),
    onlinePurchase: mode === 'paid' && stripeConfigured(),
    consoleUrl: consoleBase(),
    salesEmail: process.env.SALES_EMAIL || null,
    termsUrl: process.env.TERMS_URL || null,
    privacyUrl: process.env.PRIVACY_URL || null,
  });
}));

const signupSchema = z.object({
  email: z.string().trim().email().max(320),
  name: z.string().trim().max(120).optional().nullable(),
  company: z.string().trim().max(160).optional().nullable(),
  plan: z.string().trim().max(40).optional().nullable(),
  /** Honeypot: hidden on the form, so only a bot fills it in. */
  website: z.string().max(500).optional().nullable(),
  source: z.record(z.string().max(300)).optional(),
});

type Answer = { status: 'waitlist' | 'check_email' | 'checkout' | 'contact'; checkoutUrl?: string; message: string; devLink?: string };
const CHECK_EMAIL: Answer = { status: 'check_email', message: 'Check your email. We have sent a link to finish setting up your account.' };

/** A new tenant, its default roles and its first user (owner, invited, holding Administrator). */
async function createTenant(c: PoolClient, o: { accountName: string; plan: SaasPlan | null; status: 'active' | 'pending'; email: string; displayName: string | null }) {
  const p = o.plan;
  const acc = (await c.query(
    `INSERT INTO accounts(name, plan_tier, max_channels, max_concurrent_sources, max_renditions, status)
     VALUES ($1, $2, COALESCE($3, 5), COALESCE($4, 3), COALESCE($5, 5), $6) RETURNING id`,
    [o.accountName, p?.key ?? 'standard', p?.maxChannels ?? null, p?.maxConcurrent ?? null, p?.maxRenditions ?? null, o.status])).rows[0];
  const user = (await c.query(
    `INSERT INTO users(account_id, email, password_hash, role, status, display_name)
     VALUES ($1,$2,$3,'owner','invited',$4) RETURNING id`,
    [acc.id, o.email, await unusablePasswordHash(), o.displayName])).rows[0];
  return { accountId: acc.id as string, userId: user.id as string };
}

/** Roles live outside the transaction (ensureDefaultRoles uses the pool). */
async function finishTenant(accountId: string, userId: string) {
  await ensureDefaultRoles(accountId);
  await one(
    `INSERT INTO user_group_members(user_id, group_id)
     SELECT $1, id FROM user_groups WHERE account_id=$2 AND role_key='administrator' ON CONFLICT DO NOTHING`, [userId, accountId]);
  await query(`UPDATE users SET user_group_id=(SELECT id FROM user_groups WHERE account_id=$2 AND role_key='administrator') WHERE id=$1`, [userId, accountId]);
}

const accountNameFor = (b: { company?: string | null; name?: string | null; email: string }) =>
  (b.company?.trim() || (b.name?.trim() ? `${b.name.trim()}'s account` : b.email.split('@')[1] || 'New account')).slice(0, 160);

async function startCheckout(signupId: string, accountId: string, email: string, plan: SaasPlan): Promise<string> {
  const priceId = stripePriceFor(plan.key);
  if (!priceId) throw badRequest('That plan cannot be bought online. Talk to us instead.');
  const s = await createCheckoutSession({
    priceId, email, signupId, planKey: plan.key, accountId, trialDays: plan.trialDays,
    successUrl: `${siteBase()}/thanks.html?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${siteBase()}/register.html?plan=${encodeURIComponent(plan.key)}&cancelled=1`,
  });
  await query(`UPDATE saas_signups SET checkout_session_id=$2, updated_at=now() WHERE id=$1`, [signupId, s.id]);
  return s.url;
}

signupRouter.post('/', asyncHandler(async (req, res) => {
  const mode = signupMode();
  if (mode === 'off') throw Object.assign(forbidden('Registration is closed at the moment.'), { code: 'signup_closed' });
  await limit(`signup-ip:${req.ip}`, 10, 3600, 'Too many registrations from this network. Try again later.');
  const b = signupSchema.parse(req.body ?? {});
  const email = b.email.toLowerCase();
  const ip = String(req.ip ?? '').slice(0, 64);
  const ua = String(req.headers['user-agent'] ?? '').slice(0, 300);
  const source = b.source ?? {};
  const fake = (): Answer => (mode === 'waitlist' ? { status: 'waitlist', message: 'Thanks. You are on the list and we will be in touch.' } : CHECK_EMAIL);

  // A bot that filled the hidden field gets a normal-looking answer and nothing else.
  if (b.website && b.website.trim()) return res.status(202).json(fake());
  // Per address: silent, for the same reason as forgotten passwords.
  try { await limit(`signup-email:${email}`, 3, 3600); } catch { return res.status(202).json(fake()); }

  const plan = planByKey(b.plan ?? null);
  if (b.plan && !plan) throw badRequest('Unknown plan');

  // Enterprise and other talk-to-us plans are leads in every mode.
  if (plan?.contactSales || mode === 'waitlist') {
    const existingLead = await one<any>(`SELECT id FROM saas_signups WHERE email=$1 AND status='lead' ORDER BY created_at DESC LIMIT 1`, [email]);
    if (existingLead) {
      await query(`UPDATE saas_signups SET name=COALESCE($2,name), company=COALESCE($3,company), plan_key=COALESCE($4,plan_key), updated_at=now() WHERE id=$1`,
        [existingLead.id, b.name || null, b.company || null, plan?.key ?? null]);
    } else {
      await query(`INSERT INTO saas_signups(email, name, company, plan_key, mode, status, source, ip, user_agent) VALUES ($1,$2,$3,$4,$5,'lead',$6,$7,$8)`,
        [email, b.name || null, b.company || null, plan?.key ?? null, mode === 'waitlist' ? 'waitlist' : mode, source, ip, ua]);
      sendTransactionalEmail(email, waitlistEmail({ name: b.name ?? null })).catch((e) => console.error('[signup] waitlist email', e?.message));
    }
    const a: Answer = plan?.contactSales && mode !== 'waitlist'
      ? { status: 'contact', message: 'Thanks. Someone from Volt will contact you within one working day.' }
      : { status: 'waitlist', message: 'Thanks. You are on the list and we will be in touch.' };
    return res.status(202).json(a);
  }

  if (!plan) throw badRequest('Choose a plan');
  // A trial or paid registration makes the CLIENT (the account) as well as the
  // person: the organisation name is that client's name. The founder can
  // correct it when they set their password.
  if (!b.company || b.company.trim().length < 2) throw badRequest('Enter your organisation name');

  // Already has an account?
  const existing = await one<any>(
    `SELECT u.id, u.status, a.id AS account_id, a.status AS account_status FROM users u JOIN accounts a ON a.id=u.account_id WHERE u.email=$1`, [email]);
  if (existing) {
    // Came back to finish paying: a fresh checkout for the account already made.
    if (mode === 'paid' && existing.account_status === 'pending') {
      const s = await one<any>(`SELECT id FROM saas_signups WHERE user_id=$1 AND status='checkout' ORDER BY created_at DESC LIMIT 1`, [existing.id]);
      if (s) {
        await query(`UPDATE saas_signups SET plan_key=$2, updated_at=now() WHERE id=$1`, [s.id, plan.key]);
        await query(`UPDATE accounts SET plan_tier=$2, max_channels=$3, max_concurrent_sources=$4, max_renditions=$5 WHERE id=$1`,
          [existing.account_id, plan.key, plan.maxChannels, plan.maxConcurrent, plan.maxRenditions]);
        return res.status(202).json({ status: 'checkout', checkoutUrl: await startCheckout(s.id, existing.account_id, email, plan), message: 'Continue to payment.' } satisfies Answer);
      }
    }
    sendTransactionalEmail(email, alreadyRegisteredEmail({ signInUrl: `${consoleBase()}/`, resetUrl: `${consoleBase()}/forgot-password` }))
      .catch((e) => console.error('[signup] already-registered email', e?.message));
    return res.status(202).json(CHECK_EMAIL);
  }

  const status = mode === 'paid' ? 'pending' : 'active';
  const made = await tx(async (c) => {
    const t = await createTenant(c, { accountName: accountNameFor(b), plan, status, email, displayName: b.name || null });
    const s = (await c.query(
      `INSERT INTO saas_signups(email, name, company, plan_key, mode, status, account_id, user_id, source, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [email, b.name || null, b.company || null, plan.key, mode, mode === 'paid' ? 'checkout' : 'invited', t.accountId, t.userId, source, ip, ua])).rows[0];
    return { ...t, signupId: s.id as string };
  });
  await finishTenant(made.accountId, made.userId);
  await writeAudit(null, { accountId: made.accountId, userId: null, label: 'account', action: 'create', entityType: 'account', entityId: made.accountId, snapshot: { signup: mode, plan: plan.key, email } }).catch(() => {});

  if (mode === 'paid') {
    const url = await startCheckout(made.signupId, made.accountId, email, plan);
    return res.status(202).json({ status: 'checkout', checkoutUrl: url, message: 'Continue to payment.' } satisfies Answer);
  }
  const sent = await sendInvite(made.userId, { selfService: true });
  if (!sent.sent) console.error('[signup] welcome email failed', sent.error);
  res.status(202).json({ ...CHECK_EMAIL, ...(echoCodes() && sent.devLink ? { devLink: sent.devLink } : {}) });
}));

/** The thank-you page: has the payment been confirmed yet? Says nothing about anyone else. */
signupRouter.post('/checkout-status', asyncHandler(async (req, res) => {
  await limit(`signup-status-ip:${req.ip}`, 60, 600);
  const b = z.object({ sessionId: z.string().min(8).max(300) }).parse(req.body ?? {});
  const s = await one<any>(`SELECT status FROM saas_signups WHERE checkout_session_id=$1`, [b.sessionId]);
  if (!s) throw notFound('Unknown checkout');
  res.set('Cache-Control', 'no-store');
  res.json({ status: s.status === 'active' ? 'active' : s.status === 'cancelled' ? 'cancelled' : 'pending' });
}));

/* ---- Stripe webhook ------------------------------------------------------------ */

async function activateFromCheckout(o: any): Promise<string> {
  const signupId = o.client_reference_id ?? o.metadata?.signupId;
  if (!signupId || !/^[0-9a-f-]{36}$/i.test(String(signupId))) return 'no signup reference';
  const s = await one<any>(`SELECT id, status, account_id, user_id FROM saas_signups WHERE id=$1`, [signupId]);
  if (!s) return 'unknown signup';
  if (s.status === 'active') return 'already active';            // Stripe retries: idempotent
  if (s.status !== 'checkout' || !s.account_id || !s.user_id) return `ignored in status ${s.status}`;
  if (o.payment_status && !['paid', 'no_payment_required'].includes(o.payment_status)) return `payment ${o.payment_status}`;
  await tx(async (c) => {
    await c.query(`UPDATE saas_signups SET status='active', activated_at=now(), updated_at=now(), checkout_session_id=COALESCE(checkout_session_id,$2),
                          stripe_customer_id=$3, stripe_subscription_id=$4 WHERE id=$1`,
      [s.id, o.id ?? null, o.customer ?? null, o.subscription ?? null]);
    await c.query(`UPDATE accounts SET status='active', updated_at=now() WHERE id=$1 AND status='pending'`, [s.account_id]);
  });
  await writeAudit(null, { accountId: s.account_id, userId: null, label: 'account', action: 'update', entityType: 'account', entityId: s.account_id, snapshot: { subscription: 'paid', stripeSession: o.id } }).catch(() => {});
  const sent = await sendInvite(s.user_id, { selfService: true });
  if (!sent.sent) console.error('[signup] welcome email after payment failed', sent.error);
  return 'activated';
}

async function cancelSubscription(o: any): Promise<string> {
  const s = await one<any>(`SELECT id, account_id FROM saas_signups WHERE stripe_subscription_id=$1`, [o.id]);
  if (!s) return 'unknown subscription';
  await query(`UPDATE saas_signups SET status='cancelled', updated_at=now() WHERE id=$1`, [s.id]);
  if (s.account_id) {
    await query(`UPDATE accounts SET status='suspended', updated_at=now() WHERE id=$1`, [s.account_id]);
    await query(`UPDATE refresh_tokens SET revoked_at=now() WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE account_id=$1)`, [s.account_id]);
    await writeAudit(null, { accountId: s.account_id, userId: null, label: 'account', action: 'update', entityType: 'account', entityId: s.account_id, snapshot: { subscription: 'cancelled', status: 'suspended' } }).catch(() => {});
  }
  return 'suspended';
}

signupWebhookRouter.post('/stripe', rawBody({ type: '*/*', limit: '1mb' }), asyncHandler(async (req, res) => {
  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!verifyStripeSignature(raw, req.headers['stripe-signature'] as string | undefined, process.env.SAAS_STRIPE_WEBHOOK_SECRET)) {
    throw Object.assign(new ApiError(400, 'Signature check failed'), { code: 'bad_signature' });
  }
  let ev: any;
  try { ev = JSON.parse(raw.toString('utf8')); } catch { throw badRequest('Not JSON'); }
  const o = ev?.data?.object ?? {};
  let outcome = 'ignored';
  if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') outcome = await activateFromCheckout(o);
  else if (ev.type === 'customer.subscription.deleted') outcome = await cancelSubscription(o);
  res.json({ received: true, outcome });
}));

/* ---- Platform staff ---------------------------------------------------------------- */

platformSignupsRouter.use(...requirePlatform('read_only'));

platformSignupsRouter.get('/', asyncHandler(async (req, res) => {
  const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : null;
  const q = typeof req.query.q === 'string' && req.query.q.trim() ? `%${req.query.q.trim()}%` : null;
  const rows = await query<any>(
    `SELECT s.id, s.email::text AS email, s.name, s.company, s.plan_key AS plan, s.mode, s.status, s.account_id AS "accountId",
            a.name AS "accountName", s.source, s.created_at AS "createdAt", s.activated_at AS "activatedAt"
       FROM saas_signups s LEFT JOIN accounts a ON a.id=s.account_id
      WHERE ($1::text IS NULL OR s.status=$1) AND ($2::text IS NULL OR s.email::text ILIKE $2 OR s.company ILIKE $2 OR s.name ILIKE $2)
      ORDER BY s.created_at DESC LIMIT 500`, [status, q]);
  res.json({ mode: signupMode(), plans: allPlans().map((p) => p.key), signups: rows });
}));

platformSignupsRouter.post('/:id/invite', ...requirePlatform('support'), asyncHandler(async (req, res) => {
  const b = z.object({ plan: z.string().max(40).optional(), accountName: z.string().max(160).optional() }).parse(req.body ?? {});
  const s = await one<any>(`SELECT * FROM saas_signups WHERE id=$1`, [req.params.id]);
  if (!s) throw notFound('Signup not found');
  if (s.status !== 'lead') throw badRequest('Only a waitlist lead can be let in this way');
  const plan = planByKey(b.plan ?? s.plan_key) ?? allPlans()[0] ?? null;
  if (await one(`SELECT 1 FROM users WHERE email=$1`, [s.email])) throw badRequest('That email already has an account');
  const made = await tx(async (c) => {
    const t = await createTenant(c, { accountName: (b.accountName?.trim() || accountNameFor({ company: s.company, name: s.name, email: s.email })), plan, status: 'active', email: String(s.email).toLowerCase(), displayName: s.name });
    await c.query(`UPDATE saas_signups SET status='invited', plan_key=$2, account_id=$3, user_id=$4, updated_at=now(), activated_at=now() WHERE id=$1`,
      [s.id, plan?.key ?? null, t.accountId, t.userId]);
    return t;
  });
  await finishTenant(made.accountId, made.userId);
  await writeAudit(null, { accountId: made.accountId, userId: req.auth!.sub, label: 'account', action: 'create', entityType: 'account', entityId: made.accountId, snapshot: { fromWaitlist: s.id, plan: plan?.key } }).catch(() => {});
  const sent = await sendInvite(made.userId, { selfService: true });
  res.status(201).json({ accountId: made.accountId, userId: made.userId, invite: sent });
}));
