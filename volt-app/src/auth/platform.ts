/**
 * Platform (SaaS-provider) authorization — a scope ABOVE tenant admins.
 *
 * requirePlatform gates the /api/platform surface. The caller must present a
 * PLATFORM session: a token with audience volt:platform, which is only minted
 * after the TOTP step (POST /api/platform/auth/mfa, or /step-up from a signed-in
 * admin session). An ordinary admin session is refused with
 * code platform_mfa_required, even for a user who has a platform_role: before
 * this, a password-only login reached the cross-tenant surface and MFA could
 * be skipped entirely.
 *
 * Roles: saas_admin (full), support (read + tickets), read_only. The role is
 * read from the cached access record (auth/roles.ts), so it is current
 * without a database query per request.
 *
 * PLATFORM_REQUIRE_MFA=false accepts ordinary admin sessions (local dev only).
 */
import { Request, Response, NextFunction } from 'express';
import { verifyAccess, AUD_PLATFORM, AUD_ADMIN } from './jwt';
import { resolveAccess } from './roles';
import { accountId } from './middleware';
import { forbidden, unauthorized } from '../util/http';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      platformRole?: string;
    }
  }
}

const RANK: Record<string, number> = { read_only: 1, support: 2, saas_admin: 3 };

export function platformMfaRequired(): boolean {
  return !/^(0|false|no|off)$/i.test(process.env.PLATFORM_REQUIRE_MFA ?? 'true');
}

export function requirePlatform(minRole: 'saas_admin' | 'support' | 'read_only' = 'read_only') {
  return [
    async (req: Request, _res: Response, next: NextFunction) => {
      try {
        const [scheme, token] = (req.headers.authorization ?? '').split(' ');
        if (scheme !== 'Bearer' || !token) return next(unauthorized('Missing bearer token'));
        const audiences = platformMfaRequired() ? [AUD_PLATFORM] : [AUD_PLATFORM, AUD_ADMIN];
        try {
          req.auth = verifyAccess(token, audiences);
          req.authVia = 'session';
        } catch (e: any) {
          if (/not this API/.test(String(e?.message))) {
            return next(Object.assign(forbidden('Platform access needs a verified platform session (authenticator code)'),
              { code: 'platform_mfa_required' }));
          }
          return next(unauthorized('Invalid or expired token'));
        }
        const access = await resolveAccess(String(req.auth.sub), String(req.auth.role));
        req.access = access;
        if (!access.platformRole) return next(forbidden('platform access required'));
        if ((RANK[access.platformRole] ?? 0) < RANK[minRole]) return next(forbidden(`requires ${minRole}`));
        req.platformRole = access.platformRole;
        next();
      } catch (e) {
        next(e);
      }
    },
  ];
}

export { accountId };
