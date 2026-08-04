/**
 * Platform (SaaS-provider) authorization — a scope ABOVE tenant admins.
 * requirePlatform gates the /api/platform surface: the caller must be an
 * authenticated user whose `platform_role` is set. Roles: saas_admin (full),
 * support (read + tickets), read_only. Distinct from a tenant's own user roles.
 */
import { Request, Response, NextFunction } from 'express';
import { one } from '../db';
import { requireAuth, accountId } from './middleware';
import { forbidden, unauthorized } from '../util/http';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      platformRole?: string;
    }
  }
}

export function requirePlatform(minRole: 'saas_admin' | 'support' | 'read_only' = 'read_only') {
  const rank: Record<string, number> = { read_only: 1, support: 2, saas_admin: 3 };
  return [
    requireAuth,
    async (req: Request, _res: Response, next: NextFunction) => {
      try {
        if (!req.auth) return next(unauthorized());
        const u = await one<any>(`SELECT platform_role FROM users WHERE id=$1`, [req.auth.sub]);
        if (!u?.platform_role) return next(forbidden('platform access required'));
        if (rank[u.platform_role] < rank[minRole]) return next(forbidden(`requires ${minRole}`));
        req.platformRole = u.platform_role;
        next();
      } catch (e) {
        next(e);
      }
    },
  ];
}

export { accountId };
