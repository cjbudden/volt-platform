/**
 * THE PUBLIC API: /api/public/*. Everything a viewer (the audience) or an
 * anonymous visitor may call, and nothing else. See ACCESS_CONTROL.md.
 *
 * Mounted here (server.ts):
 *   /api/public/auth/*            viewer accounts: register, login, refresh, logout,
 *                                 password reset, token exchange for the client's own IdP
 *   /api/public/me/*              the signed-in viewer's own profile, password,
 *                                 entitlements, purchases, sessions, account deletion
 *   /api/public/availability      the play gate (GET anonymous + edge cached, POST any viewer)
 *   /api/public/access/check      access booleans, no token
 *   /api/public/player/*          embedded player handshake and telemetry
 *   /api/public/analytics/beacon  playback beacons
 *   /api/public/payments/verify   app store / provider receipt verification
 *
 * The routes predating this namespace (/api/availability, /api/access,
 * /api/player, /api/analytics/beacon, /api/payments/verify) keep working as
 * aliases of the same handlers.
 *
 * Every viewer route needs the app's publishable key (pk_...): it names the
 * client account and is checked against the app's restrictions (allowed web
 * origins etc.). A viewer is created in, and only ever sees, that account.
 * Credentials are rate limited per account+email and per address.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { one, query, tx } from '../db';
import { asyncHandler, badRequest, unauthorized, ApiError, notFound } from '../util/http';
import { verifyKey, checkRestrictions, appForKey, type ApiKeyRow } from '../services/apiKeys';
import { viewerEntitlements } from '../services/entitlements';
import { limit } from '../scale/ratelimit';
import {
  signViewer, verifyViewer, hashViewerPassword, verifyViewerPassword, DUMMY_VIEWER_HASH,
  newViewerRefresh, hashViewerRefresh, VIEWER_REFRESH_TTL, type ViewerClaims,
} from '../auth/viewerTokens';
import { securityRouter, loadPrincipal, challengeResponse, type Adapter } from '../auth/identity';

export const publicAuthRouter = Router();
export const publicMeRouter = Router();

// ---- helpers ---------------------------------------------------------------------

/** The app + account behind a publishable key, with its restrictions checked. */
async function appContext(req: Request, appKey: string): Promise<{ key: ApiKeyRow; appId: string }> {
  const key = await verifyKey(appKey);
  if (!key || key.kind !== 'publishable' || !key.app_id) throw new ApiError(401, 'invalid publishable key');
  const app = await appForKey(key);
  if (!app) throw new ApiError(401, 'app not found for key');
  const reason = checkRestrictions(app, { referrer: req.get('referer') || undefined, origin: req.get('origin') || undefined, ip: req.ip });
  if (reason) throw new ApiError(403, reason);
  return { key, appId: app.id };
}

/** Access + refresh pair for a viewer row; the refresh token is stored hashed. */
async function issueSession(v: { id: string; account_id: string; groups: string[] | null }, appId: string | null, req: Request, amr: string[] = ['pwd']) {
  const entitlements = await viewerEntitlements(v.id);
  const access = signViewer({ id: v.id, accountId: v.account_id, appId, groups: v.groups ?? [], entitlements });
  const { token: refresh, hash } = newViewerRefresh();
  await one(
    `INSERT INTO viewer_refresh_tokens(viewer_id, app_id, token_hash, expires_at, user_agent, amr)
     VALUES ($1,$2,$3, now() + make_interval(secs => $4), $5, $6)`,
    [v.id, appId, hash, VIEWER_REFRESH_TTL, (req.get('user-agent') || '').slice(0, 200), amr]);
  return { access: access.token, refresh, expiresIn: access.expiresIn, tokenType: 'Bearer' };
}

function viewerShape(v: any) {
  return {
    id: v.id, email: v.email, displayName: v.display_name ?? null, avatarRef: v.avatar_ref ?? null,
    profile: v.profile ?? {}, groups: v.groups ?? [], emailVerified: !!v.email_verified_at,
    phone: v.phone ?? null, phoneVerified: !!v.phone_verified_at,
    source: v.source, createdAt: v.created_at,
  };
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const emailSchema = z.string().email().max(254).transform((e) => e.trim().toLowerCase());
const passwordSchema = z.string().min(10, 'Use at least 10 characters').max(200);

/** Require a signed-in viewer (Authorization: Bearer <viewer access token>). */
export function viewerAuth(req: Request): ViewerClaims {
  const [scheme, token] = (req.headers.authorization ?? '').split(' ');
  if (scheme !== 'Bearer' || !token) throw unauthorized('Sign in required');
  try { return verifyViewer(token); } catch { throw unauthorized('Invalid or expired session'); }
}

/** The signed-in viewer, if a valid viewer token is present; null otherwise (never throws). */
export function optionalViewer(req: Request): ViewerClaims | null {
  const [scheme, token] = (req.headers.authorization ?? '').split(' ');
  if (scheme !== 'Bearer' || !token || token.startsWith('sk_') || token.startsWith('pk_')) return null;
  try { return verifyViewer(token); } catch { return null; }
}

// ---- auth ------------------------------------------------------------------------

publicAuthRouter.post('/register', asyncHandler(async (req, res) => {
  const b = z.object({ appKey: z.string().min(8), email: emailSchema, password: passwordSchema,
    displayName: z.string().max(120).optional() }).parse(req.body ?? {});
  const { key, appId } = await appContext(req, b.appKey);
  await limit(`viewer-register-ip:${req.ip}`, 20, 3600);
  const exists = await one(`SELECT id FROM viewers WHERE account_id=$1 AND lower(email)=$2 AND source='hosted' AND status<>'deleted'`, [key.account_id, b.email]);
  // Same answer either way: registration must not reveal who has an account.
  if (exists) throw badRequest('Could not create the account. If you already have one, sign in or reset your password.');
  const pw = await hashViewerPassword(b.password);
  const v = await one<any>(
    `WITH n AS (SELECT gen_random_uuid() AS id)
     INSERT INTO viewers(id, account_id, external_id, email, password_hash, display_name, source, status, last_seen_at, password_changed_at)
     SELECT n.id, $1, 'local:' || n.id, $2, $3, $4, 'hosted', 'active', now(), now() FROM n
     RETURNING *`,
    [key.account_id, b.email, pw, b.displayName ?? null]);
  res.status(201).json({ viewer: viewerShape(v), ...(await issueSession(v, appId, req)) });
}));

publicAuthRouter.post('/login', asyncHandler(async (req, res) => {
  const b = z.object({ appKey: z.string().min(8), email: emailSchema, password: z.string().max(200) }).parse(req.body ?? {});
  const { key, appId } = await appContext(req, b.appKey);
  await limit(`viewer-login:${key.account_id}:${b.email}`, 10, 300);
  await limit(`viewer-login-ip:${req.ip}`, 200, 300);
  const v = await one<any>(
    `SELECT * FROM viewers WHERE account_id=$1 AND lower(email)=$2 AND source='hosted' AND status='active'`, [key.account_id, b.email]);
  const ok = await verifyViewerPassword(v?.password_hash ?? DUMMY_VIEWER_HASH, b.password).catch(() => false);
  if (!v || !ok) throw unauthorized('Invalid email or password');
  await one(`UPDATE viewers SET last_seen_at=now() WHERE id=$1`, [v.id]);
  // Two-step sign-in, when the viewer turned it on (identity.ts).
  const p = await loadPrincipal('viewer', v.id);
  const step = p ? await challengeResponse(p, { required: false, app: appId }) : null;
  if (step) return res.json(step);
  res.json({ viewer: viewerShape(v), ...(await issueSession(v, appId, req)) });
}));

publicAuthRouter.post('/refresh', asyncHandler(async (req, res) => {
  const { refresh } = z.object({ refresh: z.string().min(10) }).parse(req.body ?? {});
  await limit(`viewer-refresh-ip:${req.ip}`, 600, 300);
  const row = await one<any>(
    `SELECT t.id, t.app_id, t.amr, v.id AS viewer_id, v.account_id, v.groups, v.status
       FROM viewer_refresh_tokens t JOIN viewers v ON v.id = t.viewer_id
      WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND t.expires_at > now()`, [hashViewerRefresh(refresh)]);
  if (!row || row.status !== 'active') throw unauthorized('Invalid refresh token');
  // Rotate: the old token dies with this use (a replayed one fails).
  const out = await tx(async (c) => {
    const r = await c.query(`UPDATE viewer_refresh_tokens SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING id`, [row.id]);
    if (!r.rowCount) throw unauthorized('Invalid refresh token');
    return true;
  });
  void out;
  res.json(await issueSession({ id: row.viewer_id, account_id: row.account_id, groups: row.groups }, row.app_id, req, row.amr ?? ['pwd']));
}));

publicAuthRouter.post('/logout', asyncHandler(async (req, res) => {
  const { refresh } = z.object({ refresh: z.string().optional() }).parse(req.body ?? {});
  if (refresh) await one(`UPDATE viewer_refresh_tokens SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL`, [hashViewerRefresh(refresh)]);
  res.status(204).end();
}));

publicAuthRouter.post('/password-reset', asyncHandler(async (req, res) => {
  const b = z.object({ appKey: z.string().min(8), email: emailSchema }).parse(req.body ?? {});
  const { key } = await appContext(req, b.appKey);
  await limit(`viewer-reset:${key.account_id}:${b.email}`, 3, 900);
  await limit(`viewer-reset-ip:${req.ip}`, 30, 900);
  const v = await one<any>(`SELECT id FROM viewers WHERE account_id=$1 AND lower(email)=$2 AND source='hosted' AND status='active'`, [key.account_id, b.email]);
  if (v) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await one(`UPDATE viewers SET reset_code_hash=$2, reset_expires_at=now() + interval '15 minutes' WHERE id=$1`, [v.id, sha(`${v.id}:${code}`)]);
    // Sent directly, not through the notifications service, which stores the
    // message body: a reset code must not be readable anywhere.
    try {
      const { sendSecurityEmail } = await import('../services/securityDelivery');
      await sendSecurityEmail(b.email, 'Your password reset code',
        `Your code to reset your password is: ${code}\n\nIt is valid for 15 minutes. If you did not ask for this, you can ignore this email.`);
    } catch { /* the answer is the same either way, so it reveals nothing */ }
  }
  res.json({ ok: true, note: 'If that address has an account, a reset code has been emailed to it.' });
}));

publicAuthRouter.post('/password-reset/confirm', asyncHandler(async (req, res) => {
  const b = z.object({ appKey: z.string().min(8), email: emailSchema, code: z.string().regex(/^\d{6}$/), password: passwordSchema }).parse(req.body ?? {});
  const { key } = await appContext(req, b.appKey);
  await limit(`viewer-reset-confirm:${key.account_id}:${b.email}`, 5, 900);
  const v = await one<any>(
    `SELECT id, reset_code_hash FROM viewers WHERE account_id=$1 AND lower(email)=$2 AND source='hosted' AND status='active'
        AND reset_expires_at > now()`, [key.account_id, b.email]);
  const want = v?.reset_code_hash ? Buffer.from(v.reset_code_hash, 'hex') : Buffer.alloc(32);
  const got = Buffer.from(sha(`${v?.id ?? 'x'}:${b.code}`), 'hex');
  if (!v || want.length !== got.length || !timingSafeEqual(want, got)) throw unauthorized('Invalid or expired code');
  await tx(async (c) => {
    await c.query(`UPDATE viewers SET password_hash=$2, reset_code_hash=NULL, reset_expires_at=NULL, password_changed_at=now() WHERE id=$1`,
      [v.id, await hashViewerPassword(b.password)]);
    await c.query(`UPDATE viewer_refresh_tokens SET revoked_at=now() WHERE viewer_id=$1 AND revoked_at IS NULL`, [v.id]);
  });
  res.status(204).end();
}));

/**
 * TOKEN EXCHANGE for clients with their own identity provider. The client's
 * SERVER (holding the account secret key) vouches for a viewer it has
 * authenticated and receives Volt viewer tokens to hand to its app:
 *   POST /api/public/auth/token-exchange   Authorization: Bearer sk_live_...
 *     {externalId, email?, displayName?, groups?, appId?}
 * This is the secure replacement for an app asserting `viewer` and `entitled`
 * in the play request body.
 */
publicAuthRouter.post('/token-exchange', asyncHandler(async (req, res) => {
  const header = req.headers.authorization ?? '';
  const sk = (req.headers['x-volt-account-key'] as string) || (header.startsWith('Bearer sk_') ? header.slice(7) : '');
  const key = sk ? await verifyKey(sk) : null;
  if (!key || key.kind !== 'secret' || !key.scopes.includes('management')) throw unauthorized('An account secret key is required');
  const b = z.object({
    externalId: z.string().min(1).max(200), email: emailSchema.optional(), displayName: z.string().max(120).optional(),
    groups: z.array(z.string().max(80)).max(50).optional(), appId: z.string().uuid().optional(),
  }).parse(req.body ?? {});
  if (b.appId && !(await one(`SELECT id FROM apps WHERE id=$1 AND account_id=$2`, [b.appId, key.account_id]))) throw badRequest('Unknown app');
  const v = await one<any>(
    `INSERT INTO viewers(account_id, external_id, email, display_name, groups, source, status, last_seen_at)
     VALUES ($1,$2,$3,$4,COALESCE($5::text[], '{}'),'external','active',now())
     ON CONFLICT (account_id, external_id) DO UPDATE
       SET email = COALESCE(EXCLUDED.email, viewers.email),
           display_name = COALESCE(EXCLUDED.display_name, viewers.display_name),
           groups = CASE WHEN $5::text[] IS NULL THEN viewers.groups ELSE EXCLUDED.groups END,
           last_seen_at = now()
     RETURNING *`,
    [key.account_id, b.externalId, b.email ?? null, b.displayName ?? null, b.groups ?? null]);
  if (v.status !== 'active') throw new ApiError(403, 'This viewer is disabled');
  res.json({ viewer: viewerShape(v), ...(await issueSession(v, b.appId ?? null, req)) });
}));

// ---- the signed-in viewer --------------------------------------------------------

async function me(req: Request) {
  const c = viewerAuth(req);
  const v = await one<any>(`SELECT * FROM viewers WHERE id=$1 AND account_id=$2 AND status='active'`, [c.sub, c.acct]);
  if (!v) throw unauthorized('Invalid or expired session');
  return { c, v };
}

publicMeRouter.get('/', asyncHandler(async (req, res) => {
  const { v } = await me(req);
  res.json(viewerShape(v));
}));

publicMeRouter.patch('/', asyncHandler(async (req, res) => {
  const { v } = await me(req);
  const b = z.object({
    displayName: z.string().max(120).nullable().optional(),
    avatarRef: z.string().max(500).nullable().optional(),
    // Free-form preferences (language, notifications). Never access: groups
    // and entitlements are not editable by the viewer.
    profile: z.record(z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).optional()
      .refine((p) => !p || Object.keys(p).length <= 50, 'At most 50 profile fields'),
  }).parse(req.body ?? {});
  const body = req.body ?? {};
  const row = await one<any>(
    `UPDATE viewers SET
       display_name = CASE WHEN $2 THEN $3 ELSE display_name END,
       avatar_ref   = CASE WHEN $4 THEN $5 ELSE avatar_ref END,
       profile      = CASE WHEN $6 THEN profile || $7::jsonb ELSE profile END,
       updated_at = now()
     WHERE id=$1 RETURNING *`,
    [v.id, 'displayName' in body, b.displayName ?? null, 'avatarRef' in body, b.avatarRef ?? null,
     'profile' in body, JSON.stringify(b.profile ?? {})]);
  res.json(viewerShape(row));
}));

publicMeRouter.post('/password', asyncHandler(async (req, res) => {
  const { v } = await me(req);
  const b = z.object({ current: z.string().max(200), next: passwordSchema }).parse(req.body ?? {});
  await limit(`viewer-pw:${v.id}`, 10, 900);
  if (v.source !== 'hosted' || !v.password_hash || !(await verifyViewerPassword(v.password_hash, b.current))) throw unauthorized('Current password is wrong');
  await tx(async (c) => {
    await c.query(`UPDATE viewers SET password_hash=$2, password_changed_at=now() WHERE id=$1`, [v.id, await hashViewerPassword(b.next)]);
    await c.query(`UPDATE viewer_refresh_tokens SET revoked_at=now() WHERE viewer_id=$1 AND revoked_at IS NULL`, [v.id]);
  });
  // Every session, including this one, is ended: sign in again with the new password.
  res.status(204).end();
}));

publicMeRouter.get('/entitlements', asyncHandler(async (req, res) => {
  const { v } = await me(req);
  res.json(await viewerEntitlements(v.id));
}));

publicMeRouter.get('/purchases', asyncHandler(async (req, res) => {
  const { v } = await me(req);
  res.json(await query(
    `SELECT p.id, p.status, p.amount_cents, p.currency, p.purchased_at, p.period_start, p.period_end, pr.name AS product, pr.key AS product_key
       FROM purchases p LEFT JOIN products pr ON pr.id = p.product_id
      WHERE p.viewer_id=$1 ORDER BY p.purchased_at DESC LIMIT 200`, [v.id]));
}));

publicMeRouter.get('/sessions', asyncHandler(async (req, res) => {
  const { v } = await me(req);
  res.json(await query(
    `SELECT id, created_at, expires_at, user_agent FROM viewer_refresh_tokens
      WHERE viewer_id=$1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 50`, [v.id]));
}));

publicMeRouter.post('/sign-out-everywhere', asyncHandler(async (req, res) => {
  const { v } = await me(req);
  await tx(async (c) => {
    await c.query(`UPDATE viewer_refresh_tokens SET revoked_at=now() WHERE viewer_id=$1 AND revoked_at IS NULL`, [v.id]);
    // bumping password_changed_at fires the revocation notice for access tokens too
    await c.query(`UPDATE viewers SET password_changed_at=now() WHERE id=$1`, [v.id]);
  });
  res.status(204).end();
}));

/** Delete my account: personal data scrubbed, purchases kept for the client's records. */
publicMeRouter.delete('/', asyncHandler(async (req, res) => {
  const { v } = await me(req);
  if (v.source === 'hosted') {
    const b = z.object({ password: z.string().max(200) }).parse(req.body ?? {});
    if (!(await verifyViewerPassword(v.password_hash, b.password))) throw unauthorized('Password is wrong');
  }
  await tx(async (c) => {
    await c.query(
      `UPDATE viewers SET status='deleted', email=NULL, display_name=NULL, avatar_ref=NULL, profile='{}'::jsonb,
              password_hash=NULL, reset_code_hash=NULL, external_id='deleted:' || id, updated_at=now()
        WHERE id=$1`, [v.id]);
    await c.query(`UPDATE viewer_refresh_tokens SET revoked_at=now() WHERE viewer_id=$1 AND revoked_at IS NULL`, [v.id]);
  });
  res.status(204).end();
}));

/* ---- email, mobile number and two-step sign-in (identity.ts) -------------------------
 *   /api/public/me/security, /me/email/change(+confirm), /me/email/verify(+confirm),
 *   /me/phone(+confirm), /me/mfa/{totp|email|sms}/start|confirm, DELETE /me/mfa/:method,
 *   /me/mfa/backup-codes
 *   /api/public/auth/mfa/challenge/send and /verify   (second sign-in step)
 * Two-step sign-in is optional for public users; the client app decides
 * whether to offer it. */
const viewerSecurity: Adapter = {
  async session(req) {
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) return null;
    const c = viewerAuth(req);
    return { id: c.sub, accountId: c.acct };
  },
  async issue(p, amr, ch, req) {
    const v = await one<any>(`SELECT * FROM viewers WHERE id=$1 AND status='active'`, [p.id]);
    if (!v) throw unauthorized('Invalid email or password');
    return { viewer: viewerShape(v), ...(await issueSession(v, ch.app ?? null, req, amr)) };
  },
  verifyPassword: (p, pw) => verifyViewerPassword(p.passwordHash!, pw).catch(() => false),
  async emailFree(p, email) {
    return !(await one(`SELECT 1 FROM viewers WHERE account_id=$1 AND lower(email)=$2 AND source='hosted' AND status<>'deleted' AND id<>$3`,
      [p.accountId, email, p.id]));
  },
  required: async () => false,
};
publicMeRouter.use(securityRouter('viewer', viewerSecurity, 'account'));
publicAuthRouter.use(securityRouter('viewer', viewerSecurity, 'challenge'));

export { notFound };
