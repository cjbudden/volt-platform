import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { config } from '../config';

export interface AccessClaims {
  sub: string;        // user id
  account_id: string; // tenant
  role: string;
}

/**
 * EVERY TOKEN HERE IS SIGNED WITH THE SAME SECRET, so a valid signature proves
 * only that WE minted it — never what we minted it FOR. With no type check,
 * three different tokens all opened a full admin session:
 *
 *   - the platform login's PRE-MFA challenge token ({sub, typ:'mfa'}), issued
 *     after the password step and before the second factor. It carries the
 *     real user id, so requirePlatform re-read platform_role from the database
 *     and passed: TOTP could be skipped entirely, up to and including
 *     POST /api/platform/impersonate/:accountId.
 *   - the playback token ({typ:'playback', aid, asset}), which any member of
 *     the public receives from the availability gate and from a share page.
 *   - any purpose-built token added later, by default.
 *
 * One rule, in one place: a token is an access token if it says so, or says
 * nothing at all. `typ` is absent on tokens minted before this change and on
 * the ones the shell suites sign by hand, so absence stays valid; a token that
 * names a DIFFERENT purpose is refused. Requiring `sub` and `account_id`
 * closes the same door from the other side — a playback token has neither, and
 * String(undefined) was reaching the role check as the literal 'undefined'.
 */
export function signAccess(claims: AccessClaims): string {
  return jwt.sign({ ...claims, typ: 'access' }, config.jwt.accessSecret, { expiresIn: config.jwt.accessTtl });
}

export function verifyAccess(token: string): AccessClaims {
  const d = jwt.verify(token, config.jwt.accessSecret) as any;
  if (d?.typ != null && d.typ !== 'access') throw new Error(`not an access token (typ=${d.typ})`);
  if (typeof d?.sub !== 'string' || !d.sub) throw new Error('access token carries no subject');
  if (typeof d?.account_id !== 'string' || !d.account_id) throw new Error('access token carries no account');
  return d as AccessClaims;
}

/** Opaque refresh token: random string; only its SHA-256 hash is stored in the DB. */
export function newRefreshToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, hash };
}

export const hashRefresh = (token: string) =>
  crypto.createHash('sha256').update(token).digest('hex');
