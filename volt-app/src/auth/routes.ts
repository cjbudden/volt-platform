import { Router } from 'express';
import { z } from 'zod';
import { one, tx } from '../db';
import { hashPassword, verifyPassword } from './password';
import { signAccess, newRefreshToken, hashRefresh, verifyAccess } from './jwt';
import { securityRouter, loadPrincipal, challengeResponse, methodsOf, type Principal } from './identity';
import { writeAudit } from '../services/audit';
import { asyncHandler, badRequest, unauthorized } from '../util/http';
import { requireAuth } from './middleware';
import { config } from '../config';
import { limit } from '../scale/ratelimit';

// argon2id hash of a random string: verified against when the user does not exist.
const DUMMY_HASH = '$argon2id$v=19$m=65536,t=3,p=4$eL6q5o0WKgB5aO6DOLe1aw$lB1UHTGgzSW5xk3DzObUpW2YY+mL3HMCaywzS2n5+8I';

export const authRouter = Router();

const registerSchema = z.object({
  accountName: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
});

/** Register creates an account + its first (owner) user, with a password and
 *  no email check. Kept for development, scripts and tests. In production it is
 *  closed unless ALLOW_DIRECT_REGISTER=1: public registration goes through
 *  /api/signup, which proves the mailbox before any password exists
 *  (docs/ONBOARDING.md). */
authRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DIRECT_REGISTER !== '1') {
      throw Object.assign(new (await import('../util/http')).ApiError(404, 'Not found'), { code: 'not_found' });
    }
    const { accountName, email, password } = registerSchema.parse(req.body);
    const existing = await one('SELECT id FROM users WHERE email = $1', [email]);
    if (existing) throw badRequest('Email already registered');
    const pwHash = await hashPassword(password);

    const result = await tx(async (c) => {
      const acc = (await c.query('INSERT INTO accounts(name) VALUES ($1) RETURNING id', [accountName])).rows[0];
      const user = (
        await c.query(
          `INSERT INTO users(account_id, email, password_hash, role, status)
           VALUES ($1,$2,$3,'owner','active') RETURNING id, role`,
          [acc.id, email, pwHash]
        )
      ).rows[0];
      return { accountId: acc.id, userId: user.id, role: user.role };
    });
    // Every new account starts with the default roles (auth/defaultRoles.ts),
    // and its owner holds Administrator so the user list says what they are.
    const { ensureDefaultRoles } = await import('./defaultRoles');
    await ensureDefaultRoles(result.accountId);
    await one(
      `INSERT INTO user_group_members(user_id, group_id)
       SELECT $1, id FROM user_groups WHERE account_id=$2 AND role_key='administrator' ON CONFLICT DO NOTHING`,
      [result.userId, result.accountId]);
    res.status(201).json({ accountId: result.accountId, userId: result.userId });
  })
);

const loginSchema = z.object({ email: z.string().email(), password: z.string() });

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    // Per email and per address: slows password guessing without a WAF.
    await limit(`admin-login:${email.toLowerCase()}`, 10, 300);
    await limit(`admin-login-ip:${req.ip}`, 50, 300);
    const user = await one<any>(
      `SELECT u.id, u.account_id, u.role, u.password_hash, u.status, a.status AS account_status, a.require_admin_mfa
         FROM users u JOIN accounts a ON a.id = u.account_id WHERE u.email = $1`,
      [email]
    );
    if (!user || user.status !== 'active') {
      // Same work as a real check, so response time does not reveal which
      // emails exist.
      await verifyPassword(DUMMY_HASH, password).catch(() => false);
      throw unauthorized('Invalid credentials');
    }
    if (user.account_status === 'suspended') throw unauthorized('This account is suspended, contact support');
    if (!(await verifyPassword(user.password_hash, password))) throw unauthorized('Invalid credentials');

    // Two-step sign-in: a person with a second step set up (or an account that
    // requires one) gets a challenge instead of tokens (auth/identity.ts).
    const p = await loadPrincipal('user', user.id);
    const step = p ? await challengeResponse(p, { required: !!user.require_admin_mfa }) : null;
    if (step) return res.json(step);
    res.json(await issueAdminSession(user.id, ['pwd']));
  })
);

/** Access + refresh pair for an admin user. `amr` records how they signed in. */
export async function issueAdminSession(userId: string, amr: string[]) {
  const u = await one<any>(`SELECT id, account_id, role FROM users WHERE id=$1`, [userId]);
  if (!u) throw unauthorized('Invalid credentials');
  const access = signAccess({ sub: u.id, account_id: u.account_id, role: u.role }, { amr });
  const { token: refresh, hash } = newRefreshToken();
  await one(
    `INSERT INTO refresh_tokens(user_id, token_hash, expires_at, amr)
     VALUES ($1,$2, now() + interval '14 days', $3)`,
    [u.id, hash, amr]
  );
  // expiresIn is the CONFIGURED ttl, not a repeated literal. It was 900 in
  // two places while ACCESS_TTL sat in config; raising the env var moved the
  // real expiry and left the console refreshing on the old schedule.
  return { access, refresh, expiresIn: config.jwt.accessTtl, amr };
}

const refreshSchema = z.object({ refresh: z.string() });

/* ============================================================================
 *  REFRESH — the endpoint that existed, worked, and was never called.
 *
 *  The console threw `r.refresh` away at the login screen and signed the
 *  operator out on the first 401, so every session was capped at ACCESS_TTL of
 *  wall clock however hard somebody was working. That is fixed in api.ts. Two
 *  things here had to be true first.
 *
 *  1. A DISABLED USER MUST ACTUALLY BE SIGNED OUT. The old query joined `users`
 *     and read `account_id` and `role` off it without ever looking at
 *     `u.status`, so a disabled account kept minting fresh access tokens for
 *     the full fourteen days of its refresh token. The console's own Users page
 *     says "Disabling signs the user out (at the next token refresh)", which
 *     made this the more dangerous kind of bug: a claim in the interface that
 *     the code did not implement. Now the claim is true, and it is true HERE
 *     rather than at each call site, because refresh is the one choke point
 *     every long session goes through.
 *
 *  2. ROTATION MUST NOT EXTEND THE SESSION. Rotating the refresh token on use
 *     is what makes a stolen one short-lived, but the replacement inherits the
 *     ORIGINAL row's expires_at rather than getting a fresh fourteen days.
 *     Reissuing the window on every rotation would turn an absolute cap into a
 *     sliding one that never expires, which is the opposite of a cap. So an
 *     operator working continuously is signed out fourteen days after they
 *     logged in, exactly as before, and is never signed out mid-shift.
 * ========================================================================= */
authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const { refresh } = refreshSchema.parse(req.body);
    const row = await one<any>(
      `SELECT rt.id, rt.user_id, rt.expires_at, rt.amr, u.account_id, u.role,
              u.status AS user_status, a.status AS account_status, a.require_admin_mfa
         FROM refresh_tokens rt
         JOIN users u ON u.id = rt.user_id
         JOIN accounts a ON a.id = u.account_id
        WHERE rt.token_hash = $1 AND rt.revoked_at IS NULL AND rt.expires_at > now()`,
      [hashRefresh(refresh)]
    );
    if (!row) throw unauthorized('Invalid refresh token');
    // The same two gates login applies. A session may not outlive the standing
    // of the user holding it.
    if (row.user_status === 'disabled') throw unauthorized('This account has been disabled');
    if (row.account_status === 'suspended') throw unauthorized('This account is suspended, contact support');
    // An account that now requires two-step sign-in ends sessions that did
    // not use it, at their next refresh (within ACCESS_TTL).
    const amr: string[] = row.amr ?? ['pwd'];
    if (row.require_admin_mfa && !amr.includes('mfa')) {
      throw Object.assign(unauthorized('Your account now requires two-step sign-in. Sign in again to set it up.'), { code: 'mfa_required' });
    }

    const access = signAccess({ sub: row.user_id, account_id: row.account_id, role: row.role }, { amr });

    // Rotate inside one transaction: a crash between the revoke and the insert
    // would otherwise leave the operator holding a token that no longer exists.
    const { token: next, hash } = newRefreshToken();
    await tx(async (c) => {
      await c.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, [row.id]);
      await c.query(
        `INSERT INTO refresh_tokens(user_id, token_hash, expires_at, amr) VALUES ($1,$2,$3,$4)`,
        [row.user_id, hash, row.expires_at, amr]   // INHERITED, never reissued
      );
    });

    res.json({ access, refresh: next, expiresIn: config.jwt.accessTtl });
  })
);

authRouter.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { refresh } = req.body ?? {};
    if (refresh) await one('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1', [hashRefresh(refresh)]);
    res.status(204).end();
  })
);


/** WHO AM I: the user, their tier and roles, effective access per feature and
 *  the catalogue, so the console shows exactly what the API allows. */
authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { query: q } = await import('../db');
    const { accessDescription } = await import('./roles');
    const { seesServerSetup } = await import('../services/serverSetup');
    const acc = req.access!;
    const u = await one<any>(
      `SELECT u.id, u.email, u.display_name, u.role, u.status, u.platform_role,
              u.email_verified_at, u.phone_verified_at,
              a.id AS account_id, a.name AS account_name, a.plan_tier, a.status AS account_status, a.require_admin_mfa
         FROM users u JOIN accounts a ON a.id=u.account_id WHERE u.id=$1`, [req.auth!.sub]);
    if (!u) {
      // api-key principal
      return res.json({ id: req.auth!.sub, role: 'admin', tier: 'admin', via: 'account_key', kind: 'admin',
        accountId: req.auth!.account_id, features: acc.perms, permissions: acc.perms, roles: [], model: accessDescription() });
    }
    const roles = await q<any>(
      `SELECT g.id, g.name, g.role_key FROM user_group_members m JOIN user_groups g ON g.id=m.group_id WHERE m.user_id=$1 ORDER BY g.name`, [u.id]);
    res.json({
      kind: 'admin',
      id: u.id, email: u.email, displayName: u.display_name ?? null,
      emailVerified: !!u.email_verified_at,
      mfa: { methods: methodsOf((await loadPrincipal('user', u.id))!), required: !!u.require_admin_mfa },
      role: acc.role, tier: acc.role, status: u.status,
      platformRole: u.platform_role ?? null,
      // Whether pages may name the server's settings and machines (services/serverSetup.ts).
      seesServerSetup: seesServerSetup(req),
      roles: roles.map((r) => ({ id: r.id, name: r.name, key: r.role_key })),
      // legacy single-group fields
      userGroupId: roles[0]?.id ?? null, userGroupName: roles[0]?.name ?? null,
      account: { id: u.account_id, name: u.account_name, plan: u.plan_tier, status: u.account_status },
      // `permissions` is the contract; `features` is the same map under its old name.
      permissions: acc.perms, features: acc.perms,
      model: accessDescription(),
    });
  })
);

/** Own profile: display name. Access is never self-service. */
authRouter.patch(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const b = z.object({ displayName: z.string().max(120).nullable() }).parse(req.body ?? {});
    await one(`UPDATE users SET display_name=$2 WHERE id=$1`, [req.auth!.sub, b.displayName]);
    res.json({ ok: true });
  })
);

/** Change own password: needs the current one; ends every other session. */
authRouter.post(
  '/password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const b = z.object({ current: z.string(), next: z.string().min(10, 'Use at least 10 characters') }).parse(req.body ?? {});
    await limit(`admin-pw:${req.auth!.sub}`, 10, 300);
    const u = await one<any>(`SELECT password_hash FROM users WHERE id=$1`, [req.auth!.sub]);
    if (!u || !(await verifyPassword(u.password_hash, b.current))) throw unauthorized('Current password is wrong');
    await one(`UPDATE users SET password_hash=$2 WHERE id=$1`, [req.auth!.sub, await hashPassword(b.next)]);
    await one(`UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [req.auth!.sub]);
    res.status(204).end();
  })
);


/* ============================================================================
 *  EMAIL, MOBILE NUMBER AND TWO-STEP SIGN-IN for admin users (identity.ts):
 *    GET  /api/auth/security
 *    POST /api/auth/email/change {newEmail,password} -> /email/change/confirm {code}
 *    POST /api/auth/email/verify -> /email/verify/confirm {code}
 *    POST /api/auth/phone {phone,password} -> /phone/confirm {code};  DELETE /api/auth/phone
 *    POST /api/auth/mfa/{totp|email|sms}/start -> /confirm {code}
 *    DELETE /api/auth/mfa/:method {password};  POST /api/auth/mfa/backup-codes {password}
 *    POST /api/auth/mfa/challenge/send {challenge,method} -> /challenge/verify {challenge,method,code}
 * ========================================================================= */
authRouter.use(securityRouter('user', {
  async session(req) {
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token || token.startsWith('sk_') || token.startsWith('pk_')) return null;
    let c;
    try { c = verifyAccess(token); } catch { throw unauthorized('Invalid or expired session'); }
    return { id: c.sub, accountId: c.account_id };
  },
  async issue(p: Principal, amr: string[]) {
    const u = await one<any>(
      `SELECT u.status, a.status AS account_status FROM users u JOIN accounts a ON a.id=u.account_id WHERE u.id=$1`, [p.id]);
    if (!u || u.status !== 'active') throw unauthorized('Invalid credentials');
    if (u.account_status === 'suspended') throw unauthorized('This account is suspended, contact support');
    return issueAdminSession(p.id, amr);
  },
  verifyPassword: (p, pw) => verifyPassword(p.passwordHash!, pw).catch(() => false),
  async emailFree(p, email) {
    return !(await one(`SELECT 1 FROM users WHERE email=$1 AND id<>$2`, [email, p.id]));
  },
  async required(p) {
    const a = await one<any>(`SELECT require_admin_mfa FROM accounts WHERE id=$1`, [p.accountId]);
    return !!a?.require_admin_mfa;
  },
  async audit(p, action, detail) {
    await writeAudit(null, { accountId: p.accountId, userId: p.id, label: 'security', action: 'update', entityType: 'user', entityId: p.id, snapshot: { [action]: detail } }).catch(() => {});
  },
}));
