// ============================================================================
//  ONBOARDING: welcome links, password reset links, and the three steps that
//  turn either into a working password (docs/ONBOARDING.md).
//
//    1. LINK   An administrator invites someone (or someone asks to reset a
//              password, or registers on the promo site). They get an email
//              with a one-time link: <console>/welcome#t=<token>.
//    2. CODE   Opening the link shows who the invite is for and a "Send me a
//              code" button. The code (6 digits, 10 minutes, 5 guesses) goes to
//              the same address. Entering it proves the person holds that
//              mailbox NOW, not just that the link reached someone once.
//    3. SET    The verified link is exchanged for a 15 minute setup token, and
//              that token sets the password. Then the person is signed in, or
//              taken through two-step sign-in when their account requires it.
//
//  WHY THE CODE STEP. A link on its own is a bearer secret that travels: it is
//  forwarded, pasted into tickets, opened by mail scanners that follow every
//  link, and kept in browser history. Requiring a fresh code sent to the same
//  mailbox means a leaked link is not enough to take the account, and a mail
//  scanner opening the page changes nothing (nothing happens on page load).
//
//  SECURITY PROPERTIES
//    - The token is 256 random bits. Only its SHA-256 is stored.
//    - It sits in the URL FRAGMENT, which browsers never send to a server, so
//      it does not land in access logs, proxies or Referer headers.
//    - A newer link of the same kind revokes the older one. Using a link
//      revokes every other open link for that person.
//    - Invites last INVITE_TTL_HOURS (default 7 days). Reset links last
//      RESET_TTL_MINUTES (default 60). Codes use the shared security code
//      store (auth/identity.ts): hashed, single use, rate limited.
//    - Every public answer for a bad, used, revoked or expired link is the
//      same, so the endpoints cannot be used to test which tokens exist.
//    - Asking for a reset never says whether the address has an account.
// ============================================================================
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { PoolClient } from 'pg';
import { one, query, tx } from '../db';
import { config } from '../config';
import { ApiError, badRequest } from '../util/http';
import { hashPassword } from '../auth/password';
import { loadPrincipal, issueCode, useCode, maskEmail } from '../auth/identity';
import { sendTransactionalEmail, echoCodes } from './securityDelivery';
import { welcomeEmail, resetEmail } from './mail/templates';

export type LinkKind = 'invite' | 'password_reset';

const INVITE_TTL_MS = () => Number(process.env.INVITE_TTL_HOURS ?? 168) * 3_600_000;
const RESET_TTL_MS = () => Number(process.env.RESET_TTL_MINUTES ?? 60) * 60_000;
const SETUP_TTL_SEC = 900;
const AUD_ONBOARD = 'volt:onboard';

/** Where the console is: the links in emails point here. */
export function consoleBase(): string {
  return (process.env.CONSOLE_BASE_URL || process.env.PUBLIC_BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
}

export const linkPath = (kind: LinkKind) => (kind === 'invite' ? '/welcome' : '/reset-password');

const hashToken = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

/** One answer for every link that cannot be used. */
export const linkInvalid = () =>
  Object.assign(new ApiError(410, 'This link is no longer valid. It may have expired or already been used. Ask for a new one.'), { code: 'link_invalid' });

/** A password hash nobody knows: an invited user cannot sign in until they set their own. */
export async function unusablePasswordHash(): Promise<string> {
  return hashPassword(randomBytes(32).toString('hex'));
}

/* ---- password rules ------------------------------------------------------- */

const COMMON = new Set([
  'password', 'password1', 'password123', '1234567890', '12345678910', 'qwertyuiop', 'iloveyou12', 'letmein123',
  'welcome123', 'volt123456', 'voltstreaming', 'administrator', 'changeme123', 'passw0rd123', 'qwerty12345',
]);

/** Why a password is not acceptable, or null. The console shows the same rules as it types. */
export function passwordProblem(pw: string, email?: string | null): string | null {
  if (typeof pw !== 'string' || pw.length < 10) return 'Use at least 10 characters.';
  if (pw.length > 256) return 'Use 256 characters or fewer.';
  if (/^(.)\1+$/.test(pw)) return 'Use more than one repeated character.';
  const lower = pw.toLowerCase();
  if (COMMON.has(lower)) return 'That password is too common. Choose another.';
  if (email) {
    const local = email.toLowerCase().split('@')[0];
    if (lower === email.toLowerCase() || (local.length >= 4 && lower.includes(local))) return 'Do not use your email address in your password.';
  }
  return null;
}

/* ---- links ------------------------------------------------------------------- */

interface NewLink { id: string; token: string; expiresAt: Date; url: string }

/** Make a link, revoking any older open link of the same kind for this person. */
export async function createLink(c: PoolClient | null, o: { kind: LinkKind; userId: string; accountId: string; createdBy?: string | null; ttlMs?: number }): Promise<NewLink> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + (o.ttlMs ?? (o.kind === 'invite' ? INVITE_TTL_MS() : RESET_TTL_MS())));
  const run = async (cl: PoolClient) => {
    await cl.query(`UPDATE user_access_links SET revoked_at=now() WHERE user_id=$1 AND kind=$2 AND consumed_at IS NULL AND revoked_at IS NULL`, [o.userId, o.kind]);
    const r = await cl.query(
      `INSERT INTO user_access_links(kind, user_id, account_id, token_hash, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [o.kind, o.userId, o.accountId, hashToken(token), expiresAt, o.createdBy && /^[0-9a-f-]{36}$/i.test(o.createdBy) ? o.createdBy : null]);
    return r.rows[0].id as string;
  };
  const id = c ? await run(c) : await tx(run);
  return { id, token, expiresAt, url: `${consoleBase()}${linkPath(o.kind)}#t=${token}` };
}

export interface SendResult { sent: boolean; error?: string; expiresAt: string; sentTo: string | null; devLink?: string }

/** Create a welcome link for an invited user and email it. Never throws for a mail failure: the caller reports it. */
export async function sendInvite(userId: string, o: { createdBy?: string | null; selfService?: boolean } = {}): Promise<SendResult> {
  const u = await one<any>(
    `SELECT u.id, u.email::text AS email, u.display_name, u.status, u.account_id, a.name AS account_name,
            (SELECT COALESCE(NULLIF(i.display_name,''), i.email::text) FROM users i WHERE i.id::text = $2) AS inviter
       FROM users u JOIN accounts a ON a.id = u.account_id WHERE u.id = $1`, [userId, o.createdBy ?? '']);
  if (!u) throw badRequest('User not found');
  if (u.status !== 'invited') throw badRequest('This user has already set up their account');
  const link = await createLink(null, { kind: 'invite', userId, accountId: u.account_id, createdBy: o.createdBy });
  const mail = welcomeEmail({ accountName: u.account_name, inviter: u.inviter, name: u.display_name, link: link.url, expiresAt: link.expiresAt, selfService: o.selfService });
  const base: SendResult = { sent: true, expiresAt: link.expiresAt.toISOString(), sentTo: maskEmail(u.email), ...(echoCodes() ? { devLink: link.url } : {}) };
  try { await sendTransactionalEmail(u.email, mail); }
  catch (e: any) { return { ...base, sent: false, error: e?.message ?? 'The email could not be sent' }; }
  return base;
}

/** Email a reset link. Silent about whether anything happened (the caller always answers the same). */
export async function sendReset(userId: string): Promise<{ devLink?: string }> {
  const u = await one<any>(`SELECT id, email::text AS email, display_name, account_id FROM users WHERE id=$1 AND status='active'`, [userId]);
  if (!u) return {};
  const link = await createLink(null, { kind: 'password_reset', userId, accountId: u.account_id });
  await sendTransactionalEmail(u.email, resetEmail({ name: u.display_name, link: link.url, expiresAt: link.expiresAt }));
  return echoCodes() ? { devLink: link.url } : {};
}

/** Latest open invite for a user, for the admin console. */
export async function inviteState(userId: string): Promise<{ sentAt: string; expiresAt: string; expired: boolean; verified: boolean } | null> {
  const r = await one<any>(
    `SELECT created_at, expires_at, verified_at FROM user_access_links
      WHERE user_id=$1 AND kind='invite' AND consumed_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [userId]);
  if (!r) return null;
  return { sentAt: new Date(r.created_at).toISOString(), expiresAt: new Date(r.expires_at).toISOString(), expired: new Date(r.expires_at) < new Date(), verified: !!r.verified_at };
}

/** Withdraw every open invite link for a user. */
export async function revokeInvites(userId: string): Promise<number> {
  const r = await query<any>(`UPDATE user_access_links SET revoked_at=now() WHERE user_id=$1 AND kind='invite' AND consumed_at IS NULL AND revoked_at IS NULL RETURNING id`, [userId]);
  return r.length;
}

/* ---- the three public steps ------------------------------------------------- */

interface LinkRow { id: string; kind: LinkKind; user_id: string; account_id: string; expires_at: Date; verified_at: Date | null; email: string; display_name: string | null; user_status: string; account_name: string; account_status: string; inviter: string | null; founder: boolean }

async function openLink(token: string): Promise<LinkRow> {
  if (typeof token !== 'string' || token.length < 30 || token.length > 100) throw linkInvalid();
  const r = await one<LinkRow>(
    `SELECT l.id, l.kind, l.user_id, l.account_id, l.expires_at, l.verified_at,
            u.email::text AS email, u.display_name, u.status AS user_status, a.name AS account_name, a.status AS account_status,
            (SELECT COALESCE(NULLIF(i.display_name,''), i.email::text) FROM users i WHERE i.id = l.created_by) AS inviter,
            ${FOUNDER_SQL} AS founder
       FROM user_access_links l JOIN users u ON u.id = l.user_id JOIN accounts a ON a.id = l.account_id
      WHERE l.token_hash = $1 AND l.consumed_at IS NULL AND l.revoked_at IS NULL AND l.expires_at > now()`, [hashToken(token)]);
  if (!r) throw linkInvalid();
  // The person's standing can change after the email went out.
  if (r.kind === 'invite' && r.user_status !== 'invited') throw linkInvalid();
  if (r.kind === 'password_reset' && r.user_status !== 'active') throw linkInvalid();
  if (r.account_status === 'suspended') throw Object.assign(new ApiError(403, 'This account is suspended, contact support'), { code: 'account_suspended' });
  return r;
}

/** The person who registered the client on the promo site: its first owner, still setting up. */
const FOUNDER_SQL = `(l.kind = 'invite' AND u.role = 'owner' AND EXISTS (SELECT 1 FROM saas_signups s WHERE s.user_id = u.id AND s.account_id = a.id))`;

const purposeOf = (k: LinkKind): 'invite_accept' | 'password_reset' => (k === 'invite' ? 'invite_accept' : 'password_reset');

/** Step 1: what the page shows. Nothing is sent or changed by opening a link. */
export async function describeLink(token: string) {
  const l = await openLink(token);
  return {
    kind: l.kind,
    email: maskEmail(l.email),
    displayName: l.display_name,
    accountName: l.account_name,
    invitedBy: l.kind === 'invite' ? l.inviter : null,
    // The founder of a client registered on the promo site names (or confirms) the client here.
    founder: !!l.founder,
    expiresAt: new Date(l.expires_at).toISOString(),
    passwordRules: { minLength: 10 },
  };
}

/** Step 2a: send the code to the address the link was issued for. */
export async function sendLinkCode(token: string) {
  const l = await openLink(token);
  const p = await loadPrincipal('user', l.user_id);
  if (!p?.email) throw linkInvalid();
  return issueCode(p, purposeOf(l.kind), 'email', p.email);
}

/** Step 2b: check the code; answer with a short-lived setup token. */
export async function verifyLinkCode(token: string, code: string) {
  const l = await openLink(token);
  const p = await loadPrincipal('user', l.user_id);
  if (!p) throw linkInvalid();
  await useCode(p, purposeOf(l.kind), String(code ?? ''));
  await query(`UPDATE user_access_links SET verified_at=now() WHERE id=$1`, [l.id]);
  // The code reached their mailbox, so the address is proven.
  await query(`UPDATE users SET email_verified_at=COALESCE(email_verified_at, now()) WHERE id=$1`, [l.user_id]);
  const setupToken = jwt.sign({ typ: 'onboard_setup', sub: l.user_id, lid: l.id, kind: l.kind, jti: randomUUID() },
    config.jwt.accessSecret, { audience: AUD_ONBOARD, expiresIn: SETUP_TTL_SEC });
  return { setupToken, expiresIn: SETUP_TTL_SEC, kind: l.kind };
}

/** Step 3: set the password. Returns who it was for; the route signs them in. */
export async function completeLink(setupToken: string, password: string, displayName?: string | null, accountName?: string | null): Promise<{ userId: string; accountId: string; kind: LinkKind; email: string; founder: boolean }> {
  let d: any;
  try { d = jwt.verify(String(setupToken ?? ''), config.jwt.accessSecret, { audience: AUD_ONBOARD }); }
  catch { throw Object.assign(new ApiError(401, 'This step has expired. Open the link from your email again.'), { code: 'setup_expired' }); }
  if (d?.typ !== 'onboard_setup' || !d.lid || !d.sub) throw Object.assign(new ApiError(401, 'Not a setup token'), { code: 'setup_expired' });

  return tx(async (c) => {
    // Locked, so two tabs racing to set a password cannot both win.
    const l = (await c.query(
      `SELECT l.id, l.kind, l.user_id, l.account_id, l.verified_at, l.consumed_at, l.revoked_at, u.email::text AS email, u.status,
              ${FOUNDER_SQL} AS founder
         FROM user_access_links l JOIN users u ON u.id=l.user_id JOIN accounts a ON a.id=l.account_id WHERE l.id=$1 FOR UPDATE OF l`, [d.lid])).rows[0];
    if (!l || l.user_id !== d.sub || l.consumed_at || l.revoked_at || !l.verified_at) throw linkInvalid();
    if (l.kind === 'invite' && l.status !== 'invited') throw linkInvalid();
    if (l.kind === 'password_reset' && l.status !== 'active') throw linkInvalid();
    const problem = passwordProblem(password, l.email);
    if (problem) throw Object.assign(badRequest(problem), { code: 'weak_password' });

    const hash = await hashPassword(password);
    const name = typeof displayName === 'string' ? displayName.trim().slice(0, 120) : null;
    await c.query(
      `UPDATE users SET password_hash=$2, status='active', email_verified_at=COALESCE(email_verified_at, now()),
              display_name = CASE WHEN $3::text IS NOT NULL AND $3::text <> '' THEN $3::text ELSE display_name END
        WHERE id=$1`, [l.user_id, hash, name]);
    const clientName = typeof accountName === 'string' ? accountName.trim().slice(0, 160) : '';
    if (l.founder && clientName.length >= 2) await c.query(`UPDATE accounts SET name=$2, updated_at=now() WHERE id=$1`, [l.account_id, clientName]);
    await c.query(`UPDATE user_access_links SET consumed_at=now() WHERE id=$1`, [l.id]);
    // Every other open link for this person is now pointless.
    await c.query(`UPDATE user_access_links SET revoked_at=now() WHERE user_id=$1 AND id<>$2 AND consumed_at IS NULL AND revoked_at IS NULL`, [l.user_id, l.id]);
    // A new password ends every existing session.
    await c.query(`UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [l.user_id]);
    return { userId: l.user_id, accountId: l.account_id, kind: l.kind, email: l.email, founder: !!l.founder };
  });
}
