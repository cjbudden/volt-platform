import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { config } from '../config';

export interface AccessClaims {
  sub: string;        // user id
  account_id: string; // tenant
  role: string;
  /** Audience (RFC 7519 `aud`): which API this token is for. */
  aud?: string;
  /** Authentication methods (RFC 8176 `amr`): ['pwd'] or ['pwd','otp']. */
  amr?: string[];
}

/**
 * TOKEN AUDIENCES. Admin and platform sessions are both signed with the
 * access secret but say which API they are for. A platform session exists only
 * after the TOTP step and is the only thing /api/platform accepts, so a
 * password-only admin login can no longer reach the cross-tenant surface.
 * Viewer (public) tokens use a different key and audience entirely
 * (viewerTokens.ts) and can never verify here.
 */
export const AUD_ADMIN = 'volt:admin';
export const AUD_PLATFORM = 'volt:platform';

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
export function signAccess(claims: AccessClaims, opts: { aud?: string; amr?: string[]; ttlSec?: number } = {}): string {
  const { aud: _a, amr: _m, ...rest } = claims as any;
  return jwt.sign(
    { ...rest, typ: 'access', aud: opts.aud ?? AUD_ADMIN, amr: opts.amr ?? ['pwd'] },
    config.jwt.accessSecret,
    { expiresIn: opts.ttlSec ?? config.jwt.accessTtl });
}

/**
 * Verify an admin-side token. `audiences` defaults to admin and platform (a
 * platform session also works on its own account's admin API). Tokens minted
 * before audiences existed carry none and are treated as admin, so sessions
 * in flight at upgrade keep working until they expire (<= ACCESS_TTL).
 */
export function verifyAccess(token: string, audiences: string[] = [AUD_ADMIN, AUD_PLATFORM]): AccessClaims {
  const d = jwt.verify(token, config.jwt.accessSecret) as any;
  if (d?.typ != null && d.typ !== 'access') throw new Error(`not an access token (typ=${d.typ})`);
  const aud = d?.aud ?? AUD_ADMIN;
  if (!audiences.includes(aud)) throw new Error(`token is for ${aud}, not this API`);
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
