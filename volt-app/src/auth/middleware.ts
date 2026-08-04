import { Request, Response, NextFunction } from 'express';
import { verifyAccess, AccessClaims } from './jwt';
import { unauthorized } from '../util/http';
import { verifyKey } from '../services/apiKeys';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AccessClaims;
      authVia?: 'session' | 'account_key';
    }
  }
}

/**
 * Admin authentication. Accepts EITHER:
 *   - an admin SESSION token (JWT from interactive login), OR
 *   - the account's SECRET KEY (sk_live…, management scope) for server-to-server —
 *     the "account API access token".
 * Both resolve to exactly one account_id, so EVERY downstream query is filtered to
 * that tenant and content can never cross accounts. Publishable keys (pk_…,
 * playback scope) are REJECTED here — they are for the public play surface only.
 * The account key can be sent as `Authorization: Bearer sk_live_…` or
 * `X-Volt-Account-Key: sk_live_…`.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  const accountKey = (req.headers['x-volt-account-key'] as string) || (scheme === 'Bearer' && token?.startsWith('sk_') ? token : '');

  // Path 1: account secret key (server-to-server admin).
  if (accountKey) {
    try {
      const key = await verifyKey(accountKey);
      if (!key || key.kind !== 'secret' || !key.scopes.includes('management')) {
        return next(unauthorized('Account key must be a secret key with management scope'));
      }
      req.auth = { sub: `apikey:${key.id}`, account_id: key.account_id, role: 'admin' };
      req.authVia = 'account_key';
      return next();
    } catch (e) {
      return next(e);
    }
  }

  // Path 2: admin session JWT.
  if (scheme !== 'Bearer' || !token) return next(unauthorized('Missing bearer token'));
  try {
    req.auth = verifyAccess(token);
    req.authVia = 'session';
    next();
  } catch {
    next(unauthorized('Invalid or expired token'));
  }
}

/** The tenant (account) id for the current request. Every query must be scoped by this. */
export function accountId(req: Request): string {
  if (!req.auth) throw unauthorized();
  return req.auth.account_id;
}
