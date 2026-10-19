/**
 * IDENTITY SECURITY, one implementation for both kinds of user
 * (ACCESS_CONTROL.md section 12):
 *
 *   - verified email, and a change-of-email flow that proves the new address
 *   - a verified mobile number
 *   - two-step sign-in with any of: authenticator app (TOTP, RFC 6238),
 *     a code emailed to the verified address, a code texted to the verified
 *     number, and one-time backup codes
 *   - the sign-in challenge (password accepted, second step pending) and, when
 *     the account requires two-step sign-in, enrolment during sign-in
 *
 * `securityRouter(kind, adapter)` builds the routes. Admin users get them under
 * /api/auth, public users under /api/public/me (session routes) and
 * /api/public/auth (sign-in challenge). Each kind supplies how a session is
 * read and issued; everything else (codes, factors, limits) is shared.
 *
 * SECURITY PROPERTIES
 *   - Codes: 6 digits, single use, 10 minutes, 5 guesses, stored only as a
 *     keyed HMAC. A new code of the same purpose cancels the previous one.
 *   - Sends are limited per person and per destination, guesses per person,
 *     so neither SMS cost nor guessing can be run up.
 *   - Authenticator seeds are sealed (secretBox.ts) and a TOTP code cannot be
 *     replayed inside its window.
 *   - Changing the email, removing a factor and making new backup codes need
 *     the current password. Adding a factor from a signed-in session also
 *     needs it, so a borrowed session cannot lock the owner out.
 *   - Challenge tokens are audience `volt:mfa`, typ `mfa_challenge`, 10 minutes,
 *     single use once they produce a session. Admin access verification refuses
 *     any token whose typ is not `access`, so a challenge is never a session.
 *   - Nothing here runs on the playback path: it costs only at sign-in and in
 *     account settings, so it does not affect viewer-path scaling.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { createHmac, hkdfSync, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { one, query, tx } from '../db';
import { config } from '../config';
import { asyncHandler, ApiError, badRequest, unauthorized } from '../util/http';

/* A wrong password or code is NOT "signed out": answering 401 would make
 * clients (the console included) drop the session. 401 is kept for a missing,
 * expired or wrong session or challenge. */
const wrongCode = (m: string) => Object.assign(new ApiError(400, m), { code: 'invalid_code' });
const wrongPassword = () => Object.assign(new ApiError(403, 'Your password is not right'), { code: 'reauth_failed' });
import { limit, peek } from '../scale/ratelimit';
import { newSecret, verifyTotp } from '../services/totp';
import { seal, open } from './secretBox';
import { sendSecurityEmail, sendSecuritySms, echoCodes, emailAvailable, smsAvailable } from '../services/securityDelivery';

export type Kind = 'user' | 'viewer';
export type Method = 'totp' | 'email' | 'sms' | 'backup';

export interface Principal {
  kind: Kind;
  id: string;
  accountId: string;
  email: string | null;
  emailVerified: boolean;
  phone: string | null;
  phoneVerified: boolean;
  totpSecret: string | null;   // opened
  totpEnabled: boolean;
  mfaEmail: boolean;
  mfaSms: boolean;
  passwordHash: string | null;
  /** viewers only: 'hosted' or 'external' (signs in with the client's own IdP) */
  source?: string;
  status: string;
}

/* ---- storage, per kind ------------------------------------------------------- */

const T = {
  user: { table: 'users', totp: 'mfa_secret_ref', totpOn: 'mfa_enabled' },
  viewer: { table: 'viewers', totp: 'totp_secret', totpOn: 'totp_enabled' },
} as const;

export async function loadPrincipal(kind: Kind, id: string): Promise<Principal | null> {
  const t = T[kind];
  const r = await one<any>(
    `SELECT id, account_id, email::text AS email, email_verified_at, phone, phone_verified_at,
            ${t.totp} AS totp, ${t.totpOn} AS totp_on, mfa_email_enabled, mfa_sms_enabled, password_hash, status
            ${kind === 'viewer' ? ', source' : ''}
       FROM ${t.table} WHERE id=$1`, [id]);
  if (!r) return null;
  let secret: string | null = null;
  try { secret = open(r.totp); } catch { secret = null; }
  return {
    kind, id: r.id, accountId: r.account_id, email: r.email ?? null, emailVerified: !!r.email_verified_at,
    phone: r.phone ?? null, phoneVerified: !!r.phone_verified_at,
    totpSecret: secret, totpEnabled: !!r.totp_on && !!secret,
    mfaEmail: !!r.mfa_email_enabled, mfaSms: !!r.mfa_sms_enabled,
    passwordHash: r.password_hash ?? null, source: r.source, status: r.status,
  };
}

async function setCols(p: Principal, cols: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(cols);
  const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(', ');
  await query(`UPDATE ${T[p.kind].table} SET ${sets} WHERE id=$1`, [p.id, ...keys.map((k) => cols[k])]);
  // A viewer's stateless access token is revoked by the 0047 trigger on
  // password_changed_at; security changes do not need that (the token carries
  // no email or factor), so it is left alone here.
}

/** Second steps this person can use right now. */
export function methodsOf(p: Principal): Method[] {
  const m: Method[] = [];
  if (p.totpEnabled) m.push('totp');
  if (p.mfaEmail && p.email && p.emailVerified) m.push('email');
  if (p.mfaSms && p.phone && p.phoneVerified) m.push('sms');
  return m;
}

export const hasMfa = (p: Principal) => methodsOf(p).length > 0;

async function backupRemaining(p: Principal): Promise<number> {
  const r = await one<any>(`SELECT count(*)::int AS n FROM mfa_backup_codes WHERE principal_kind=$1 AND principal_id=$2 AND used_at IS NULL`, [p.kind, p.id]);
  return r?.n ?? 0;
}

/* ---- masking ------------------------------------------------------------------- */

export function maskEmail(e: string | null): string | null {
  if (!e) return null;
  const [u, d] = e.split('@');
  return `${u.slice(0, 1)}${'•'.repeat(Math.max(1, Math.min(6, u.length - 1)))}@${d}`;
}
export function maskPhone(p: string | null): string | null {
  return p ? `${p.slice(0, 3)}${'•'.repeat(Math.max(0, p.length - 5))}${p.slice(-2)}` : null;
}

/* ---- one-time codes -------------------------------------------------------------- */

let codeKey: Buffer | null = null;
const hmac = (s: string) => {
  codeKey ??= Buffer.from(hkdfSync('sha256', config.jwt.accessSecret, 'volt', 'security-codes-v1', 32));
  return createHmac('sha256', codeKey).update(s).digest('hex');
};
const codeHash = (p: Principal, purpose: string, code: string) => hmac(`${p.kind}:${p.id}:${purpose}:${code}`);
const CODE_TTL_MIN = 10;
const MAX_GUESSES = 5;

type Purpose = 'email_change' | 'email_verify' | 'phone_verify' | 'mfa_login' | 'mfa_enrol_email' | 'mfa_enrol_sms';

const MESSAGES: Record<Purpose, { subject: string; line: string }> = {
  email_change: { subject: 'Confirm your new email address', line: 'Use this code to confirm this as the new email address for your account' },
  email_verify: { subject: 'Verify your email address', line: 'Use this code to verify your email address' },
  phone_verify: { subject: '', line: 'Your Volt code to verify this number is' },
  mfa_login: { subject: 'Your sign-in code', line: 'Your sign-in code is' },
  mfa_enrol_email: { subject: 'Turn on sign-in codes by email', line: 'Use this code to turn on two-step sign-in by email' },
  mfa_enrol_sms: { subject: '', line: 'Your Volt code to turn on two-step sign-in by text is' },
};

/** Create, store (hashed) and send a code. Returns devCode when SECURITY_CODE_ECHO is on outside production. */
async function issueCode(p: Principal, purpose: Purpose, channel: 'email' | 'sms', target: string): Promise<{ sentTo: string; devCode?: string }> {
  await limit(`sec-send:${p.kind}:${p.id}`, 10, 900, 'Too many codes requested. Wait a few minutes and try again.');
  await limit(`sec-send-to:${target.toLowerCase()}`, 10, 900, 'Too many codes requested. Wait a few minutes and try again.');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await tx(async (c) => {
    await c.query(`UPDATE security_codes SET consumed_at=now() WHERE principal_kind=$1 AND principal_id=$2 AND purpose=$3 AND consumed_at IS NULL`, [p.kind, p.id, purpose]);
    await c.query(
      `INSERT INTO security_codes(principal_kind, principal_id, purpose, channel, target, code_hash, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(mins => $7))`,
      [p.kind, p.id, purpose, channel, target, codeHash(p, purpose, code), CODE_TTL_MIN]);
  });
  const m = MESSAGES[purpose];
  if (channel === 'email') {
    await sendSecurityEmail(target, m.subject,
      `${m.line}:\n\n    ${code}\n\nIt expires in ${CODE_TTL_MIN} minutes. If you did not ask for this, ignore this email and consider changing your password.`);
  } else {
    await sendSecuritySms(target, `${m.line} ${code}. It expires in ${CODE_TTL_MIN} minutes. Never share this code.`);
  }
  return { sentTo: channel === 'email' ? maskEmail(target)! : maskPhone(target)!, ...(echoCodes() ? { devCode: code } : {}) };
}

/** Check and consume a code. Returns the target it was sent to. */
async function useCode(p: Principal, purpose: Purpose, code: string): Promise<string> {
  await limit(`sec-guess:${p.kind}:${p.id}`, 20, 900, 'Too many wrong codes. Wait a few minutes and try again.');
  const row = await one<any>(
    `UPDATE security_codes SET attempts = attempts + 1
      WHERE id = (SELECT id FROM security_codes
                   WHERE principal_kind=$1 AND principal_id=$2 AND purpose=$3 AND consumed_at IS NULL AND expires_at > now()
                   ORDER BY created_at DESC LIMIT 1)
      RETURNING id, code_hash, attempts, target`, [p.kind, p.id, purpose]);
  if (!row) throw wrongCode('That code has expired. Ask for a new one.');
  const want = Buffer.from(row.code_hash, 'hex');
  const got = Buffer.from(codeHash(p, purpose, code.trim()), 'hex');
  const ok = want.length === got.length && timingSafeEqual(want, got);
  if (!ok) {
    if (row.attempts >= MAX_GUESSES) await query(`UPDATE security_codes SET consumed_at=now() WHERE id=$1`, [row.id]);
    throw wrongCode(row.attempts >= MAX_GUESSES ? 'Too many wrong codes. Ask for a new one.' : 'That code is not right.');
  }
  await query(`UPDATE security_codes SET consumed_at=now() WHERE id=$1`, [row.id]);
  return row.target;
}

/** A TOTP code, refused if it was already used in its window (replay). */
async function useTotp(p: Principal, secret: string | null, code: string): Promise<void> {
  await limit(`sec-guess:${p.kind}:${p.id}`, 20, 900, 'Too many wrong codes. Wait a few minutes and try again.');
  if (!secret || !verifyTotp(secret, code.trim(), { nowSec: Math.floor(Date.now() / 1000), window: 1 })) throw wrongCode('That code is not right.');
  await limit(`totp-used:${p.kind}:${p.id}:${code.trim()}`, 1, 120, 'That code was just used. Wait for the next one.');
}

/* ---- backup codes ----------------------------------------------------------------- */

const B32 = 'abcdefghijkmnpqrstuvwxyz23456789'; // no 0/o, 1/l
function backupCode(): string {
  const b = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += B32[b[i] % B32.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
const normBackup = (c: string) => c.toLowerCase().replace(/[^a-z0-9]/g, '');

async function newBackupCodes(p: Principal): Promise<string[]> {
  const codes = Array.from({ length: 10 }, backupCode);
  await tx(async (c) => {
    await c.query(`DELETE FROM mfa_backup_codes WHERE principal_kind=$1 AND principal_id=$2`, [p.kind, p.id]);
    for (const code of codes) {
      await c.query(`INSERT INTO mfa_backup_codes(principal_kind, principal_id, code_hash) VALUES ($1,$2,$3)`,
        [p.kind, p.id, hmac(`backup:${p.kind}:${p.id}:${normBackup(code)}`)]);
    }
  });
  return codes;
}

async function useBackup(p: Principal, code: string): Promise<void> {
  await limit(`sec-guess:${p.kind}:${p.id}`, 20, 900, 'Too many wrong codes. Wait a few minutes and try again.');
  const r = await one<any>(
    `UPDATE mfa_backup_codes SET used_at=now()
      WHERE principal_kind=$1 AND principal_id=$2 AND code_hash=$3 AND used_at IS NULL RETURNING id`,
    [p.kind, p.id, hmac(`backup:${p.kind}:${p.id}:${normBackup(code)}`)]);
  if (!r) throw wrongCode('That backup code is not right or was already used.');
}

/** Turn every second step off (admin reset, or the person removing the last one). */
export async function clearMfa(kind: Kind, id: string): Promise<void> {
  const t = T[kind];
  await tx(async (c) => {
    await c.query(`UPDATE ${t.table} SET ${t.totp}=NULL, ${t.totpOn}=false, mfa_email_enabled=false, mfa_sms_enabled=false WHERE id=$1`, [id]);
    await c.query(`DELETE FROM mfa_backup_codes WHERE principal_kind=$1 AND principal_id=$2`, [kind, id]);
    await c.query(`UPDATE security_codes SET consumed_at=now() WHERE principal_kind=$1 AND principal_id=$2 AND consumed_at IS NULL`, [kind, id]);
  });
}

/* ---- sign-in challenge ------------------------------------------------------------- */

const AUD_MFA = 'volt:mfa';
export interface Challenge { sub: string; acct: string; pk: Kind; setup: boolean; app?: string | null; jti: string }

export function signChallenge(c: Omit<Challenge, 'jti'>): string {
  return jwt.sign({ ...c, typ: 'mfa_challenge', jti: randomUUID() }, config.jwt.accessSecret, { audience: AUD_MFA, expiresIn: 600 });
}

export function verifyChallenge(token: string, kind: Kind): Challenge {
  let d: any;
  try { d = jwt.verify(token, config.jwt.accessSecret, { audience: AUD_MFA }); }
  catch { throw unauthorized('The sign-in step has expired. Sign in again.'); }
  if (d?.typ !== 'mfa_challenge' || d.pk !== kind) throw unauthorized('Not a sign-in challenge');
  return d as Challenge;
}

/** What the login endpoint answers instead of tokens when a second step is due. */
export async function challengeResponse(p: Principal, opts: { required: boolean; app?: string | null }) {
  const methods = methodsOf(p);
  if (methods.length) {
    const backup = await backupRemaining(p);
    return {
      mfaRequired: true,
      challenge: signChallenge({ sub: p.id, acct: p.accountId, pk: p.kind, setup: false, app: opts.app ?? null }),
      methods: [...methods, ...(backup ? ['backup' as const] : [])],
      email: methods.includes('email') ? maskEmail(p.email) : null,
      phone: methods.includes('sms') ? maskPhone(p.phone) : null,
    };
  }
  if (opts.required) {
    return {
      mfaSetupRequired: true,
      challenge: signChallenge({ sub: p.id, acct: p.accountId, pk: p.kind, setup: true, app: opts.app ?? null }),
      available: availableMethods(p),
      email: maskEmail(p.email),
    };
  }
  return null;
}

function availableMethods(p: Principal): Method[] {
  const a: Method[] = ['totp'];
  if (p.email && emailAvailable()) a.push('email');
  if (smsAvailable()) a.push('sms');
  return a;
}

const amrFor = (m: Method) => ['pwd', 'mfa', m === 'totp' ? 'otp' : m === 'sms' ? 'sms' : m === 'email' ? 'email' : 'backup'];

/* ---- the routes ----------------------------------------------------------------------- */

export interface Adapter {
  /** The signed-in person (from the Authorization header), or null. Must throw for a bad token. */
  session(req: Request): Promise<{ id: string; accountId: string } | null>;
  /** Issue a full session after the second step. */
  issue(p: Principal, amr: string[], ch: Challenge, req: Request): Promise<Record<string, unknown>>;
  verifyPassword(p: Principal, password: string): Promise<boolean>;
  /** Is this email free for this person? */
  emailFree(p: Principal, email: string): Promise<boolean>;
  /** Does policy forbid removing the last factor? */
  required(p: Principal): Promise<boolean>;
  /** Written to the audit log (admin users); optional. */
  audit?(p: Principal, action: string, detail: Record<string, unknown>): Promise<void>;
}

const phoneSchema = z.string().trim().regex(/^\+[1-9]\d{6,14}$/, 'Enter the number in international format, for example +61412345678');
const codeSchema = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code');
const emailSchema = z.string().trim().toLowerCase().email().max(254);

/**
 * `part`: 'all' (admin users, everything under /api/auth), 'account' (the
 * signed-in person's settings, public users under /api/public/me) or
 * 'challenge' (the second sign-in step, public users under /api/public/auth).
 */
export function securityRouter(kind: Kind, a: Adapter, part: 'all' | 'account' | 'challenge' = 'all'): Router {
  const r = Router();
  const account = Router();
  const challenge = Router();
  if (part !== 'challenge') r.use(account);
  if (part !== 'account') r.use(challenge);

  const fromSession = async (req: Request): Promise<Principal> => {
    const s = await a.session(req);
    if (!s) throw unauthorized('Sign in required');
    const p = await loadPrincipal(kind, s.id);
    if (!p || p.status !== 'active') throw unauthorized('Sign in required');
    if (kind === 'viewer' && p.source !== 'hosted') throw badRequest('This account signs in through the app provider, which manages its email and sign-in security.');
    return p;
  };
  /** Session, or (for enrolment) the setup challenge issued at sign-in. */
  const fromEither = async (req: Request): Promise<{ p: Principal; ch: Challenge | null }> => {
    const token = (req.body ?? {}).challenge;
    if (typeof token === 'string' && token) {
      const ch = verifyChallenge(token, kind);
      if (!ch.setup) throw badRequest('Finish signing in first');
      if ((await peek(`mfa-ch:${ch.jti}`)) > 0) throw unauthorized('This sign-in step was already completed. Sign in again.');
      const p = await loadPrincipal(kind, ch.sub);
      if (!p || p.status !== 'active') throw unauthorized('Sign in again');
      return { p, ch };
    }
    return { p: await fromSession(req), ch: null };
  };
  const needPassword = async (p: Principal, pw: unknown) => {
    await limit(`sec-pw:${p.kind}:${p.id}`, 20, 900);
    if (typeof pw !== 'string' || !pw || !p.passwordHash || !(await a.verifyPassword(p, pw))) throw wrongPassword();
  };
  /** After the first factor is added: backup codes, and for sign-in enrolment, the session. */
  const afterEnrol = async (p: Principal, ch: Challenge | null, method: Method, req: Request) => {
    // A setup challenge completes sign-in once.
    if (ch) await limit(`mfa-ch:${ch.jti}`, 1, 900, 'This sign-in step was already completed. Sign in again.');
    const fresh = (await loadPrincipal(kind, p.id))!;
    const first = methodsOf(fresh).length === 1 && (await backupRemaining(fresh)) === 0;
    const backupCodes = first ? await newBackupCodes(fresh) : undefined;
    await a.audit?.(fresh, 'mfa_enable', { method });
    const session = ch ? await a.issue(fresh, amrFor(method), ch, req) : undefined;
    return { ok: true, methods: methodsOf(fresh), ...(backupCodes ? { backupCodes } : {}), ...(session ?? {}) };
  };

  // ---- summary ------------------------------------------------------------------------
  account.get('/security', asyncHandler(async (req, res) => {
    const p = await fromSession(req);
    res.json({
      email: p.email, emailVerified: p.emailVerified,
      phone: p.phone, phoneVerified: p.phoneVerified,
      methods: methodsOf(p),
      totp: { enabled: p.totpEnabled },
      emailCodes: { enabled: p.mfaEmail && p.emailVerified, available: emailAvailable() },
      smsCodes: { enabled: p.mfaSms && p.phoneVerified, available: smsAvailable() },
      backupCodesRemaining: await backupRemaining(p),
      required: await a.required(p),
    });
  }));

  // ---- email ----------------------------------------------------------------------------
  account.post('/email/change', asyncHandler(async (req, res) => {
    const p = await fromSession(req);
    const b = z.object({ newEmail: emailSchema, password: z.string().max(200) }).parse(req.body ?? {});
    await needPassword(p, b.password);
    if (b.newEmail === (p.email ?? '').toLowerCase()) throw badRequest('That is already your email address');
    if (!(await a.emailFree(p, b.newEmail))) throw badRequest('That email address cannot be used. Choose another.');
    const out = await issueCode(p, 'email_change', 'email', b.newEmail);
    res.json({ ok: true, ...out });
  }));

  account.post('/email/change/confirm', asyncHandler(async (req, res) => {
    const p = await fromSession(req);
    const { code } = z.object({ code: codeSchema }).parse(req.body ?? {});
    const next = await useCode(p, 'email_change', code);
    if (!(await a.emailFree(p, next))) throw badRequest('That email address was taken in the meantime. Choose another.');
    const old = p.email;
    try { await setCols(p, { email: next, email_verified_at: new Date() }); }
    catch (e: any) { if (e?.code === '23505') throw badRequest('That email address cannot be used. Choose another.'); throw e; }
    await a.audit?.(p, 'email_change', { from: maskEmail(old), to: maskEmail(next) });
    // Tell the OLD address: the standard defence against a hijacked session.
    if (old) {
      sendSecurityEmail(old, 'Your email address was changed',
        `The email address on your account was changed to ${maskEmail(next)}.\n\nIf you did not do this, reset your password straight away and contact your administrator.`)
        .catch(() => {});
    }
    res.json({ ok: true, email: next, emailVerified: true });
  }));

  account.post('/email/verify', asyncHandler(async (req, res) => {
    const p = await fromSession(req);
    if (!p.email) throw badRequest('There is no email address on this account');
    if (p.emailVerified) return res.json({ ok: true, alreadyVerified: true });
    res.json({ ok: true, ...(await issueCode(p, 'email_verify', 'email', p.email)) });
  }));

  account.post('/email/verify/confirm', asyncHandler(async (req, res) => {
    const p = await fromSession(req);
    const { code } = z.object({ code: codeSchema }).parse(req.body ?? {});
    const target = await useCode(p, 'email_verify', code);
    if (target.toLowerCase() !== (p.email ?? '').toLowerCase()) throw badRequest('The email address changed since the code was sent');
    await setCols(p, { email_verified_at: new Date() });
    res.json({ ok: true, emailVerified: true });
  }));

  // ---- mobile number --------------------------------------------------------------------
  account.post('/phone', asyncHandler(async (req, res) => {
    const p = await fromSession(req);
    const b = z.object({ phone: phoneSchema, password: z.string().max(200) }).parse(req.body ?? {});
    await needPassword(p, b.password);
    res.json({ ok: true, ...(await issueCode(p, 'phone_verify', 'sms', b.phone)) });
  }));

  account.post('/phone/confirm', asyncHandler(async (req, res) => {
    const p = await fromSession(req);
    const { code } = z.object({ code: codeSchema }).parse(req.body ?? {});
    const phone = await useCode(p, 'phone_verify', code);
    await setCols(p, { phone, phone_verified_at: new Date() });
    await a.audit?.(p, 'phone_change', { to: maskPhone(phone) });
    res.json({ ok: true, phone, phoneVerified: true });
  }));

  account.delete('/phone', asyncHandler(async (req, res) => {
    const p = await fromSession(req);
    await needPassword(p, (req.body ?? {}).password);
    if (p.mfaSms && methodsOf(p).length === 1 && (await a.required(p))) {
      throw badRequest('Your account requires two-step sign-in. Add another method before removing this number.');
    }
    await setCols(p, { phone: null, phone_verified_at: null, mfa_sms_enabled: false });
    res.status(204).end();
  }));

  // ---- authenticator app ------------------------------------------------------------------
  account.post('/mfa/totp/start', asyncHandler(async (req, res) => {
    const { p, ch } = await fromEither(req);
    if (!ch) await needPassword(p, (req.body ?? {}).password);
    if (p.totpEnabled) throw badRequest('An authenticator app is already set up. Remove it first to set up a new one.');
    const s = newSecret(p.email ?? p.id);
    await setCols(p, { [T[kind].totp]: seal(s.secret), [T[kind].totpOn]: false });
    // The console draws the QR code from otpauthUri itself (volt-web/src/qr.ts).
    res.json({ secret: s.secret, otpauthUri: s.otpauthUri });
  }));

  account.post('/mfa/totp/confirm', asyncHandler(async (req, res) => {
    const { p, ch } = await fromEither(req);
    const { code } = z.object({ code: codeSchema }).parse(req.body ?? {});
    if (p.totpEnabled) throw badRequest('An authenticator app is already set up');
    await useTotp(p, p.totpSecret, code);
    await setCols(p, { [T[kind].totpOn]: true });
    res.json(await afterEnrol(p, ch, 'totp', req));
  }));

  // ---- codes by email ----------------------------------------------------------------------
  account.post('/mfa/email/start', asyncHandler(async (req, res) => {
    const { p, ch } = await fromEither(req);
    if (!ch) await needPassword(p, (req.body ?? {}).password);
    if (!p.email) throw badRequest('Add an email address first');
    res.json({ ok: true, ...(await issueCode(p, 'mfa_enrol_email', 'email', p.email)) });
  }));

  account.post('/mfa/email/confirm', asyncHandler(async (req, res) => {
    const { p, ch } = await fromEither(req);
    const { code } = z.object({ code: codeSchema }).parse(req.body ?? {});
    const target = await useCode(p, 'mfa_enrol_email', code);
    if (target.toLowerCase() !== (p.email ?? '').toLowerCase()) throw badRequest('The email address changed since the code was sent');
    // Receiving the code proves the address, so it is verified too.
    await setCols(p, { mfa_email_enabled: true, email_verified_at: new Date() });
    res.json(await afterEnrol(p, ch, 'email', req));
  }));

  // ---- codes by text message ----------------------------------------------------------------
  account.post('/mfa/sms/start', asyncHandler(async (req, res) => {
    const { p, ch } = await fromEither(req);
    const b = z.object({ phone: phoneSchema.optional(), password: z.string().max(200).optional() }).parse(req.body ?? {});
    if (!ch) await needPassword(p, b.password);
    const phone = b.phone ?? (p.phoneVerified ? p.phone : null);
    if (!phone) throw badRequest('Enter the mobile number to send codes to');
    res.json({ ok: true, ...(await issueCode(p, 'mfa_enrol_sms', 'sms', phone)) });
  }));

  account.post('/mfa/sms/confirm', asyncHandler(async (req, res) => {
    const { p, ch } = await fromEither(req);
    const { code } = z.object({ code: codeSchema }).parse(req.body ?? {});
    const phone = await useCode(p, 'mfa_enrol_sms', code);
    await setCols(p, { phone, phone_verified_at: new Date(), mfa_sms_enabled: true });
    res.json(await afterEnrol(p, ch, 'sms', req));
  }));

  // ---- remove a method, new backup codes ------------------------------------------------------
  account.delete('/mfa/:method', asyncHandler(async (req, res) => {
    const p = await fromSession(req);
    const method = z.enum(['totp', 'email', 'sms']).parse(req.params.method);
    await needPassword(p, (req.body ?? {}).password);
    const left = methodsOf(p).filter((m) => m !== method);
    if (!left.length && (await a.required(p))) {
      throw badRequest('Your account requires two-step sign-in. Add another method before removing this one.');
    }
    if (method === 'totp') await setCols(p, { [T[kind].totp]: null, [T[kind].totpOn]: false });
    if (method === 'email') await setCols(p, { mfa_email_enabled: false });
    if (method === 'sms') await setCols(p, { mfa_sms_enabled: false });
    if (!left.length) await clearMfa(kind, p.id);
    await a.audit?.(p, 'mfa_disable', { method });
    res.json({ ok: true, methods: left });
  }));

  account.post('/mfa/backup-codes', asyncHandler(async (req, res) => {
    const p = await fromSession(req);
    await needPassword(p, (req.body ?? {}).password);
    if (!hasMfa(p)) throw badRequest('Turn on two-step sign-in first');
    await a.audit?.(p, 'mfa_backup_codes', {});
    res.json({ backupCodes: await newBackupCodes(p) });
  }));

  // ---- the sign-in challenge ---------------------------------------------------------------------
  challenge.post('/mfa/challenge/send', asyncHandler(async (req, res) => {
    const b = z.object({ challenge: z.string(), method: z.enum(['email', 'sms']) }).parse(req.body ?? {});
    const ch = verifyChallenge(b.challenge, kind);
    const p = await loadPrincipal(kind, ch.sub);
    if (!p || p.status !== 'active' || ch.setup) throw unauthorized('Sign in again');
    if (!methodsOf(p).includes(b.method)) throw badRequest('That method is not set up');
    res.json({ ok: true, ...(await issueCode(p, 'mfa_login', b.method, b.method === 'email' ? p.email! : p.phone!)) });
  }));

  challenge.post('/mfa/challenge/verify', asyncHandler(async (req, res) => {
    const b = z.object({ challenge: z.string(), method: z.enum(['totp', 'email', 'sms', 'backup']), code: z.string().trim().min(6).max(12) }).parse(req.body ?? {});
    const ch = verifyChallenge(b.challenge, kind);
    // Checked BEFORE any code is looked at, so replaying a finished challenge
    // cannot spend a backup code or an emailed code.
    if ((await peek(`mfa-ch:${ch.jti}`)) > 0) throw Object.assign(new ApiError(429, 'This sign-in step was already completed. Sign in again.'), { code: 'rate_limited' });
    const p = await loadPrincipal(kind, ch.sub);
    if (!p || p.status !== 'active' || ch.setup) throw unauthorized('Sign in again');
    if (b.method === 'backup') await useBackup(p, b.code);
    else {
      if (!methodsOf(p).includes(b.method)) throw badRequest('That method is not set up');
      if (b.method === 'totp') await useTotp(p, p.totpSecret, b.code);
      else await useCode(p, 'mfa_login', b.code);
    }
    // A challenge produces one session.
    await limit(`mfa-ch:${ch.jti}`, 1, 900, 'This sign-in step was already completed. Sign in again.');
    if (b.method === 'backup') await a.audit?.(p, 'mfa_backup_used', { remaining: await backupRemaining(p) });
    res.json({ ...(await a.issue(p, amrFor(b.method), ch, req)), backupCodesRemaining: b.method === 'backup' ? await backupRemaining(p) : undefined });
  }));

  return r;
}

/** Summary for admin screens (user drawer, public user detail). */
export async function securitySummary(kind: Kind, id: string) {
  const p = await loadPrincipal(kind, id);
  if (!p) return null;
  return {
    emailVerified: p.emailVerified, phone: maskPhone(p.phone), phoneVerified: p.phoneVerified,
    methods: methodsOf(p), backupCodesRemaining: await backupRemaining(p),
  };
}

export { ApiError };
