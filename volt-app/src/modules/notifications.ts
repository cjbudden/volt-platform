/**
 * Notifications API (admin, tenant-scoped). Send (optionally templated) →
 * per-recipient/channel deliveries with retry; list; detail with deliveries;
 * in-app inbox; templates CRUD.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, conflict } from '../util/http';
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
  let recipient = typeof req.query.recipient === 'string' ? req.query.recipient : '';
  if (!recipient) {
    const u = await one<any>(`SELECT email FROM users WHERE id=$1`, [req.auth!.sub]);
    recipient = u?.email ?? '';
  }
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
  const row = await one(`UPDATE notification_deliveries SET read_at=now() WHERE id=$1 AND account_id=$2 AND channel='in_app' RETURNING id`, [req.params.id, accountId(req)]);
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
