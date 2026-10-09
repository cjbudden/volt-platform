/**
 * Notifications API (admin, tenant-scoped). Send (optionally templated) →
 * per-recipient/channel deliveries with retry; list; detail with deliveries;
 * in-app inbox; templates CRUD.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, conflict, forbidden } from '../util/http';
import { ROLE_RANK, rankOf } from '../auth/roles';
import { sendNotification, retryFailed } from '../services/notifications';

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

const sendSchema = z.object({
  topic: z.string().min(1),
  recipients: z.array(z.string().min(1)).min(1),
  channels: z.array(z.enum(['email', 'in_app', 'push'])).min(1),
  subject: z.string().optional(),
  body: z.string().optional(),
  payload: z.record(z.any()).optional(),
  templateKey: z.string().optional(),
});

notificationsRouter.post('/', asyncHandler(async (req, res) => {
  const b = sendSchema.parse(req.body);
  const r = await sendNotification({ accountId: accountId(req), ...b });
  res.status(201).json(r);
}));

notificationsRouter.get('/', asyncHandler(async (req, res) => {
  const rows = await query(`SELECT * FROM notifications WHERE account_id=$1 ORDER BY created_at DESC LIMIT 200`, [accountId(req)]);
  res.json(rows);
}));

/** In-app inbox for a recipient (defaults to the current user's email). */
notificationsRouter.get('/inbox', asyncHandler(async (req, res) => {
  // YOUR inbox. `?recipient=` used to be honoured for anybody, scoped only by
  // account, so any member of a tenant could read a colleague's notification
  // subjects and bodies just by typing their address into the query string.
  // An admin may still read another user's inbox; nobody else may.
  const me = await one<any>(`SELECT email FROM users WHERE id=$1`, [req.auth!.sub]);
  const asked = typeof req.query.recipient === 'string' ? req.query.recipient : '';
  const mine = String(me?.email ?? '');
  if (asked && asked.toLowerCase() !== mine.toLowerCase() && rankOf(req.auth?.role) < ROLE_RANK.admin) {
    throw forbidden('You can only read your own inbox');
  }
  const recipient = asked || mine;
  const rows = await query(
    `SELECT d.id, d.status, d.read_at, d.created_at, n.topic, n.subject, n.body
       FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id
      WHERE d.account_id=$1 AND d.channel='in_app' AND d.recipient=$2
      ORDER BY d.created_at DESC LIMIT 200`,
    [accountId(req), recipient]
  );
  res.json({ recipient, unread: rows.filter((r: any) => !r.read_at).length, items: rows });
}));

notificationsRouter.post('/inbox/:id/read', asyncHandler(async (req, res) => {
  // Scoped to the caller's own delivery for the same reason as the read above:
  // account scope alone let one user mark another user's items read.
  const me = await one<any>(`SELECT email FROM users WHERE id=$1`, [req.auth!.sub]);
  const isAdmin = rankOf(req.auth?.role) >= ROLE_RANK.admin;
  const row = await one(
    `UPDATE notification_deliveries SET read_at=now()
      WHERE id=$1 AND account_id=$2 AND channel='in_app'
        AND ($3::boolean OR lower(recipient) = lower($4))
    RETURNING id`,
    [req.params.id, accountId(req), isAdmin, String(me?.email ?? '')]);
  if (!row) throw notFound('Inbox item not found');
  res.json({ ok: true });
}));

notificationsRouter.post('/retry', asyncHandler(async (req, res) => {
  res.json({ retried: await retryFailed(accountId(req)) });
}));

notificationsRouter.get('/:id', asyncHandler(async (req, res) => {
  const n = await one(`SELECT * FROM notifications WHERE id=$1 AND account_id=$2`, [req.params.id, accountId(req)]);
  if (!n) throw notFound('Notification not found');
  const deliveries = await query(`SELECT recipient, channel, status, attempts, last_error, sent_at FROM notification_deliveries WHERE notification_id=$1 ORDER BY recipient, channel`, [req.params.id]);
  res.json({ ...(n as any), deliveries });
}));

// ---- templates -------------------------------------------------------------
export const notificationTemplatesRouter = Router();
notificationTemplatesRouter.use(requireAuth);

notificationTemplatesRouter.get('/', asyncHandler(async (req, res) => {
  res.json(await query(`SELECT * FROM notification_templates WHERE account_id=$1 ORDER BY key`, [accountId(req)]));
}));

notificationTemplatesRouter.post('/', asyncHandler(async (req, res) => {
  const b = z.object({ key: z.string().min(1), subject: z.string().min(1), body: z.string().min(1) }).parse(req.body);
  const exists = await one(`SELECT id FROM notification_templates WHERE account_id=$1 AND key=$2`, [accountId(req), b.key]);
  if (exists) throw conflict(`Template "${b.key}" already exists`);
  const row = await one(
    `INSERT INTO notification_templates(account_id, key, subject, body) VALUES ($1,$2,$3,$4) RETURNING *`,
    [accountId(req), b.key, b.subject, b.body]
  );
  res.status(201).json(row);
}));
