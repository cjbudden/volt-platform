/* ============================================================================
 *  THE CONSOLE'S REFRESH TOKEN, IN A COOKIE THE PAGE CANNOT READ.
 *
 *  The console kept both tokens in memory only, so any page load ended the
 *  session: pressing reload, opening a link in a new tab, or the dev server
 *  reloading after a file changed. An operator could be working continuously
 *  and still land on the sign-in form several times an hour.
 *
 *  The refresh token now also travels as an HttpOnly cookie, scoped to
 *  /api/auth so it is sent to nothing else. Script on the page (including an
 *  injected one) cannot read it, which is why it is safe to persist where
 *  localStorage would not be. SameSite=Strict keeps other sites from making
 *  the browser present it. On load, the console asks /api/auth/refresh with
 *  the cookie and carries on signed in.
 *
 *  The JSON body still carries `refresh` on login, for scripts and API
 *  clients that hold it themselves. Nothing changes for them.
 * ========================================================================= */
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config';

export const REFRESH_COOKIE = 'volt_rt';
const PATH = '/api/auth';

/** Secure on https (the ALB sets x-forwarded-proto; trust proxy is on).
 *  Plain http is only the local dev server, where a Secure cookie on a
 *  non-localhost address (the LAN IP) would be dropped. */
function secure(req: Request) {
  return req.secure || req.protocol === 'https';
}

export function setRefreshCookie(req: Request, res: Response, token: string, expiresAt?: Date | string | null) {
  const exp = expiresAt ? new Date(expiresAt).getTime() : Date.now() + config.jwt.refreshTtl * 1000;
  const maxAge = Math.max(0, exp - Date.now());
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true, sameSite: 'strict', secure: secure(req), path: PATH, maxAge,
  });
}

export function clearRefreshCookie(req: Request, res: Response) {
  res.clearCookie(REFRESH_COOKIE, { httpOnly: true, sameSite: 'strict', secure: secure(req), path: PATH });
}

export function readRefreshCookie(req: Request): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === REFRESH_COOKIE) {
      try { return decodeURIComponent(part.slice(i + 1).trim()) || undefined; } catch { return undefined; }
    }
  }
  return undefined;
}

/** Every route that signs someone in answers with `{ access, refresh, ... }`
 *  (password, two-step, SSO, onboarding). Rather than remember the cookie at
 *  each of them, and miss the next one added, this sets it on the way out. */
export function sessionCookies(req: Request, res: Response, next: NextFunction) {
  const json = res.json.bind(res);
  res.json = (body?: any) => {
    if (body && typeof body === 'object' && typeof body.access === 'string' && typeof body.refresh === 'string'
        && res.statusCode < 400 && !res.headersSent) {
      setRefreshCookie(req, res, body.refresh, body.refreshExpiresAt);
    }
    return json(body);
  };
  next();
}
