import { Router } from 'express';
import { z } from 'zod';
import { one, tx } from '../db';
import { hashPassword, verifyPassword } from './password';
import { signAccess, newRefreshToken, hashRefresh } from './jwt';
import { asyncHandler, badRequest, unauthorized } from '../util/http';
import { requireAuth } from './middleware';
import { config } from '../config';

export const authRouter = Router();

const registerSchema = z.object({
  accountName: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
});

/** Register creates an account + its first (owner) user. */
authRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
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
    res.status(201).json({ accountId: result.accountId, userId: result.userId });
  })
);

const loginSchema = z.object({ email: z.string().email(), password: z.string() });

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const user = await one<any>(
      `SELECT u.id, u.account_id, u.role, u.password_hash, u.status, a.status AS account_status
         FROM users u JOIN accounts a ON a.id = u.account_id WHERE u.email = $1`,
      [email]
    );
    if (!user || user.status === 'disabled') throw unauthorized('Invalid credentials');
    if (user.account_status === 'suspended') throw unauthorized('This account is suspended, contact support');
    if (!(await verifyPassword(user.password_hash, password))) throw unauthorized('Invalid credentials');

    const access = signAccess({ sub: user.id, account_id: user.account_id, role: user.role });
    const { token: refresh, hash } = newRefreshToken();
    await one(
      `INSERT INTO refresh_tokens(user_id, token_hash, expires_at)
       VALUES ($1,$2, now() + interval '14 days')`,
      [user.id, hash]
    );
    // expiresIn is the CONFIGURED ttl, not a repeated literal. It was 900 in
    // two places while ACCESS_TTL sat in config; raising the env var moved the
    // real expiry and left the console refreshing on the old schedule.
    res.json({ access, refresh, expiresIn: config.jwt.accessTtl });
  })
);

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
      `SELECT rt.id, rt.user_id, rt.expires_at, u.account_id, u.role,
              u.status AS user_status, a.status AS account_status
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

    const access = signAccess({ sub: row.user_id, account_id: row.account_id, role: row.role });

    // Rotate inside one transaction: a crash between the revoke and the insert
    // would otherwise leave the operator holding a token that no longer exists.
    const { token: next, hash } = newRefreshToken();
    await tx(async (c) => {
      await c.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, [row.id]);
      await c.query(
        `INSERT INTO refresh_tokens(user_id, token_hash, expires_at) VALUES ($1,$2,$3)`,
        [row.user_id, hash, row.expires_at]   // INHERITED, never reissued
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


/** WHO AM I — the session's user, role, effective feature access, and the
 *  access model description, so the UI gates nav and buttons exactly like the
 *  API enforces them. */
authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { one: oneQ } = await import('../db');
    const { resolveAccess, accessDescription } = await import('./roles');
    const u = await oneQ<any>(
      `SELECT u.id, u.email, u.role, u.status, u.platform_role, u.user_group_id,
              g.name AS user_group_name, a.id AS account_id, a.name AS account_name,
              a.plan_tier, a.status AS account_status
         FROM users u JOIN accounts a ON a.id=u.account_id
         LEFT JOIN user_groups g ON g.id=u.user_group_id
        WHERE u.id=$1`, [req.auth!.sub]);
    if (!u) {
      // api-key principal
      return res.json({ id: req.auth!.sub, role: 'admin', via: 'account_key',
        accountId: req.auth!.account_id, features: (await resolveAccess(String(req.auth!.sub), 'admin')).perms,
        model: accessDescription() });
    }
    const acc = await resolveAccess(u.id, u.role);
    res.json({
      id: u.id, email: u.email, role: acc.role, status: u.status,
      platformRole: u.platform_role ?? null,
      userGroupId: u.user_group_id, userGroupName: u.user_group_name,
      account: { id: u.account_id, name: u.account_name, plan: u.plan_tier, status: u.account_status },
      features: acc.perms,
      model: accessDescription(),
    });
  })
);
