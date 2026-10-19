// ============================================================================
//  EVERY DELETE IS LOGGED: a net under every DELETE route in the admin API.
//
//  Some routes write their own audit row with a snapshot of what went (the
//  channel's name, the clips that went with it). Many did not, and a route
//  added tomorrow might not either. This middleware makes the rule hold for
//  all of them, now and later:
//
//    * a DELETE that succeeds and did NOT write its own "delete" row gets one
//      written here: who, what (from the path), when, the status;
//    * a DELETE that is REFUSED (400, 403, 409...) is logged as
//      "delete_refused" with the reason, because "someone tried to delete the
//      live channel" is exactly what an administrator reviewing the log wants
//      to see. 401 (not signed in), 404 (nothing there) and 428 (the "are you
//      sure?" step of a two-step delete) are not attempts and are not logged.
//
//  How a route's own row is noticed: the request runs inside an
//  AsyncLocalStorage context, and writeAudit() marks it when it records a
//  delete. Nothing else in a route has to change.
// ============================================================================
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { query } from '../db';

interface Ctx { deleteLogged: boolean; error?: string }
const als = new AsyncLocalStorage<Ctx>();

/** Called by writeAudit when a route records a delete itself. */
export function markDeleteLogged(): void {
  const c = als.getStore();
  if (c) c.deleteLogged = true;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_ATTEMPTS = new Set([401, 404, 428]);
const NOUN_ALIAS: Record<string, string> = { epg: 'programme', user_group: 'access_role' };

/** Entity type and id from an API path: /api/channels/<id> -> channel, <id>. */
export function entityFromPath(path: string): { type: string; id: string | null; key: string | null } {
  const segs = path.split('?')[0].split('/').filter(Boolean);
  if (segs[0] === 'api') segs.shift();
  const idIdx = segs.findIndex((s) => UUID.test(s));
  // the noun nearest the id, else the last word ("api-keys/keys/:keyId" -> key)
  const nounSegs = (idIdx >= 0 ? segs.slice(0, idIdx) : segs).filter((s) => !UUID.test(s) && !/^\d+$/.test(s));
  const noun = nounSegs[nounSegs.length - 1] ?? 'unknown';
  const singular = noun.replace(/ies$/, 'y').replace(/(s|x|ch|sh)es$/, '$1').replace(/s$/, '');
  const raw = singular.replace(/[^a-z0-9]+/gi, '_').toLowerCase() || 'unknown';
  // Some routes are named for their area, not the thing: /api/epg/<id> is a programme.
  const type = NOUN_ALIAS[raw] ?? raw;
  const id = idIdx >= 0 ? segs[idIdx] : null;
  // a non-uuid identifier ("/sources/feed-7") is kept as the key
  const key = idIdx < 0 && segs.length > 1 ? decodeURIComponent(segs[segs.length - 1]) : null;
  return { type, id, key };
}

export function auditDeletes() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'DELETE') return next();
    // Public users deleting their own account are not admin actions.
    if (req.originalUrl.startsWith('/api/public/')) return next();
    // The platform console writes its own cross-tenant audit rows (platform.ts).
    if (req.originalUrl.startsWith('/api/platform/')) return next();
    const ctx: Ctx = { deleteLogged: false };

    // Keep the refusal reason the route answered with.
    const json = res.json.bind(res);
    res.json = ((body: any) => {
      if (res.statusCode >= 400 && body && typeof body === 'object') {
        ctx.error = String(body.error ?? body.message ?? '').slice(0, 500) || undefined;
      }
      return json(body);
    }) as any;

    res.on('finish', () => {
      const status = res.statusCode;
      const ok = status >= 200 && status < 300;
      if (ok && ctx.deleteLogged) return;
      if (!ok && (NOT_ATTEMPTS.has(status) || status >= 500)) return;
      const auth = (req as any).auth as { account_id?: string; sub?: string; email?: string } | undefined;
      if (!auth) return;
      const { type, id, key } = entityFromPath(req.originalUrl);
      const label = (auth as any).email ?? String(auth.sub ?? 'unknown');
      const detail: Record<string, unknown> = {
        actor: label, method: 'DELETE', path: req.originalUrl.split('?')[0], status, logged_by: 'request',
      };
      if (key) detail.key = key;
      if (!ok && ctx.error) detail.reason = ctx.error;
      void query(
        `INSERT INTO audit_log(account_id, user_id, action, entity_type, entity_id, detail)
         VALUES ($1, (SELECT id FROM users WHERE id::text = $2), $3, $4, $5, $6::jsonb)`,
        [auth.account_id ?? null, String(auth.sub ?? ''), ok ? 'delete' : 'delete_refused', type, id, JSON.stringify(detail)],
      ).catch((e) => console.error('[audit] could not log a delete', req.originalUrl, e?.message ?? e));
    });

    als.run(ctx, () => next());
  };
}
