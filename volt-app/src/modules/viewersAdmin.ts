/**
 * PUBLIC USERS, AS THE CLIENT'S ADMIN SEES THEM: /api/viewers (feature
 * `viewers`). Find a viewer, see their entitlements and purchases, disable or
 * re-enable them, sign them out everywhere, change their groups, delete them.
 *
 *   GET    /api/viewers?q=&status=&limit=&offset=   viewers:view
 *   GET    /api/viewers/:id                          viewers:view
 *   PATCH  /api/viewers/:id {status?, groups?, displayName?}   viewers:manage
 *   POST   /api/viewers/:id/sign-out                 viewers:operate
 *   DELETE /api/viewers/:id                          viewers:manage
 *   POST   /api/viewers/:id/mfa/reset                viewers:manage  turn off two-step sign-in (lost phone)
 *
 * Granting access (entitlements) stays in /api/payments/grants (payments).
 * Disabling or signing out ends the viewer's sessions at once on every API
 * process (refresh tokens revoked + revocation notice, migration 0047).
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, one, tx } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound } from '../util/http';
import { viewerEntitlements } from '../services/entitlements';
import { writeAudit } from '../services/audit';
import { clearMfa, securitySummary } from '../auth/identity';

export const viewersAdminRouter = Router();
viewersAdminRouter.use(requireAuth);

const shape = (v: any) => ({
  id: v.id, email: v.email, displayName: v.display_name ?? null, externalId: v.external_id, source: v.source,
  status: v.status, groups: v.groups ?? [], emailVerified: !!v.email_verified_at,
  mfa: (!!v.totp_enabled && !!v.totp_secret) || (!!v.mfa_email_enabled && !!v.email_verified_at) || (!!v.mfa_sms_enabled && !!v.phone_verified_at),
  createdAt: v.created_at, lastSeenAt: v.last_seen_at,
});

viewersAdminRouter.get('/', asyncHandler(async (req, res) => {
  const q = z.object({
    q: z.string().max(200).optional(), status: z.enum(['active', 'disabled', 'deleted']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0),
  }).parse(req.query);
  const like = q.q ? `%${q.q.replace(/[%_]/g, (m) => '\\' + m)}%` : null;
  const rows = await query<any>(
    `SELECT *, count(*) OVER() AS total FROM viewers
      WHERE account_id=$1 AND ($2::text IS NULL OR email ILIKE $2 OR display_name ILIKE $2 OR external_id ILIKE $2)
        AND ($3::text IS NULL OR status=$3)
      ORDER BY created_at DESC LIMIT $4 OFFSET $5`,
    [accountId(req), like, q.status ?? null, q.limit, q.offset]);
  res.json({ total: Number(rows[0]?.total ?? 0), items: rows.map(shape) });
}));

viewersAdminRouter.get('/:id', asyncHandler(async (req, res) => {
  const v = await one<any>(`SELECT * FROM viewers WHERE id=$1 AND account_id=$2`, [req.params.id, accountId(req)]);
  if (!v) throw notFound('Viewer not found');
  const purchases = await query(
    `SELECT p.id, p.status, p.amount_cents, p.currency, p.purchased_at, pr.name AS product
       FROM purchases p LEFT JOIN products pr ON pr.id=p.product_id WHERE p.viewer_id=$1 ORDER BY p.purchased_at DESC LIMIT 100`, [v.id]);
  const sessions = await one<any>(`SELECT count(*)::int AS n FROM viewer_refresh_tokens WHERE viewer_id=$1 AND revoked_at IS NULL AND expires_at > now()`, [v.id]);
  res.json({ ...shape(v), entitlements: await viewerEntitlements(v.id), purchases, activeSessions: sessions?.n ?? 0,
    security: await securitySummary('viewer', v.id) });
}));

viewersAdminRouter.post('/:id/mfa/reset', asyncHandler(async (req, res) => {
  const v = await one<any>(`SELECT id FROM viewers WHERE id=$1 AND account_id=$2 AND status<>'deleted'`, [req.params.id, accountId(req)]);
  if (!v) throw notFound('Viewer not found');
  await clearMfa('viewer', v.id);
  await tx(async (c) => {
    await c.query(`UPDATE viewer_refresh_tokens SET revoked_at=now() WHERE viewer_id=$1 AND revoked_at IS NULL`, [v.id]);
    await c.query(`UPDATE viewers SET password_changed_at=now() WHERE id=$1`, [v.id]);
  });
  await writeAudit(null, { accountId: accountId(req), userId: req.auth!.sub, label: 'viewer', action: 'update', entityType: 'viewer', entityId: v.id, snapshot: { mfa: 'reset' } }).catch(() => {});
  res.status(204).end();
}));

viewersAdminRouter.patch('/:id', asyncHandler(async (req, res) => {
  const b = z.object({
    status: z.enum(['active', 'disabled']).optional(),
    groups: z.array(z.string().max(80)).max(50).optional(),
    displayName: z.string().max(120).nullable().optional(),
  }).parse(req.body ?? {});
  const body = req.body ?? {};
  const v = await tx(async (c) => {
    const r = (await c.query(
      `UPDATE viewers SET status=COALESCE($3, status), groups=COALESCE($4::text[], groups),
              display_name=CASE WHEN $5 THEN $6 ELSE display_name END, updated_at=now()
        WHERE id=$1 AND account_id=$2 AND status<>'deleted' RETURNING *`,
      [req.params.id, accountId(req), b.status ?? null, b.groups ?? null, 'displayName' in body, b.displayName ?? null])).rows[0];
    if (r && (b.status === 'disabled' || b.groups)) {
      await c.query(`UPDATE viewer_refresh_tokens SET revoked_at=now() WHERE viewer_id=$1 AND revoked_at IS NULL`, [r.id]);
      // groups live in the access token: end it so the next one carries the change
      if (b.groups && b.status !== 'disabled') await c.query(`UPDATE viewers SET password_changed_at=now() WHERE id=$1`, [r.id]);
    }
    return r;
  });
  if (!v) throw notFound('Viewer not found');
  await writeAudit(null, { accountId: accountId(req), userId: req.auth!.sub, label: 'viewer', action: 'update', entityType: 'viewer', entityId: v.id, snapshot: b }).catch(() => {});
  res.json(shape(v));
}));

viewersAdminRouter.post('/:id/sign-out', asyncHandler(async (req, res) => {
  const v = await one<any>(`SELECT id FROM viewers WHERE id=$1 AND account_id=$2`, [req.params.id, accountId(req)]);
  if (!v) throw notFound('Viewer not found');
  await tx(async (c) => {
    await c.query(`UPDATE viewer_refresh_tokens SET revoked_at=now() WHERE viewer_id=$1 AND revoked_at IS NULL`, [v.id]);
    await c.query(`UPDATE viewers SET password_changed_at=now() WHERE id=$1`, [v.id]);
  });
  res.status(204).end();
}));

viewersAdminRouter.delete('/:id', asyncHandler(async (req, res) => {
  const v = await one<any>(
    `UPDATE viewers SET status='deleted', email=NULL, display_name=NULL, avatar_ref=NULL, profile='{}'::jsonb,
            password_hash=NULL, external_id='deleted:' || id, updated_at=now()
      WHERE id=$1 AND account_id=$2 RETURNING id`, [req.params.id, accountId(req)]);
  if (!v) throw notFound('Viewer not found');
  await query(`UPDATE viewer_refresh_tokens SET revoked_at=now() WHERE viewer_id=$1 AND revoked_at IS NULL`, [v.id]);
  await writeAudit(null, { accountId: accountId(req), userId: req.auth!.sub, label: 'viewer', action: 'delete', entityType: 'viewer', entityId: v.id, snapshot: {} }).catch(() => {});
  res.status(204).end();
}));
