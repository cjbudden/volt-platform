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
import { sendNotification, retryFailed, channelConfig, channelConfigForAccount, MAX_ATTEMPTS } from '../services/notifications';
import { seesServerSetup } from '../services/serverSetup';
import { defineList, parseList, whereSql, pageSql, finishPage } from '../util/listQuery';

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

// THE LIST STANDARD (util/listQuery.ts). The delivery counts are aggregates,
// so the list filters and sorts the grouped rows (a sub-select) and can ask,
// say, for every notification that still has a delivery retrying.
const notificationsList = defineList({
  path: '/api/notifications',
  fields: {
    id: { sql: 'x.id', type: 'uuid' },
    topic: { sql: 'x.topic', type: 'string', doc: 'e.g. event.reminder, alert, publish, expiry' },
    subject: { sql: 'x.subject', type: 'string' },
    body: { sql: 'x.body', type: 'string', sort: false },
    created_at: { sql: 'x.created_at', type: 'timestamp', notNull: true },
    deliveries: { sql: 'x.deliveries', type: 'number' },
    sent: { sql: 'x.sent', type: 'number' },
    retrying: { sql: 'x.retrying', type: 'number' },
    gave_up: { sql: 'x.gave_up', type: 'number' },
  },
  search: ['topic', 'subject', 'body'],
  defaultSort: '-created_at',
  // It always returned the newest 200; that stays the default page.
  defaultLimit: 200,
  maxLimit: 200,
});

notificationsRouter.get('/', asyncHandler(async (req, res) => {
  // With per-notification delivery counts, so the sent log can show at a glance
  // which ones reached everybody and which are still retrying or gave up.
  const inner = `SELECT n.*,
            count(d.id)::int AS deliveries,
            count(d.id) FILTER (WHERE d.status = 'sent')::int AS sent,
            count(d.id) FILTER (WHERE d.status = 'failed' AND d.gave_up_at IS NULL)::int AS retrying,
            count(d.id) FILTER (WHERE d.status = 'failed' AND d.gave_up_at IS NOT NULL)::int AS gave_up
       FROM notifications n LEFT JOIN notification_deliveries d ON d.notification_id = n.id
      WHERE n.account_id=$1
      GROUP BY n.id`;
  const params: unknown[] = [accountId(req)];
  const pl = parseList(notificationsList, req.query, params);
  const rows = await query(`SELECT * FROM (${inner}) x WHERE true${whereSql(pl)} ${pageSql(pl)}`, params);
  let total: number | undefined;
  if (pl.count) {
    const cp: unknown[] = [accountId(req)];
    const cpl = parseList(notificationsList, { ...req.query, cursor: undefined, offset: undefined }, cp);
    total = Number((await one<any>(`SELECT count(*)::int AS n FROM (${inner}) x WHERE true${whereSql(cpl)}`, cp))?.n ?? 0);
  }
  res.json(finishPage(req, res, pl, rows, total));
}));

/** Which channels can deliver here, and the retry policy. */
notificationsRouter.get('/config', asyncHandler(async (req, res) => {
  res.json({ channels: seesServerSetup(req) ? channelConfig() : channelConfigForAccount(), maxAttempts: MAX_ATTEMPTS, backoffMinutes: [1, 5, 15, 60] });
}));

/** Send a test to yourself on one channel. */
notificationsRouter.post('/test', asyncHandler(async (req, res) => {
  const b = z.object({ channel: z.enum(['email', 'in_app', 'push']) }).parse(req.body ?? {});
  const me = await one<any>(`SELECT email FROM users WHERE id=$1`, [req.auth!.sub]);
  if (!me?.email) throw forbidden('A test needs a signed-in user with an email address');
  const r = await sendNotification({
    accountId: accountId(req), topic: 'test', recipients: [me.email], channels: [b.channel],
    subject: 'Volt test notification', body: `This is a test ${b.channel === 'in_app' ? 'inbox' : b.channel} notification from Volt. If you can read it, ${b.channel} delivery works.`,
  });
  const d = await one<any>(`SELECT status, last_error, gave_up_at FROM notification_deliveries WHERE notification_id=$1`, [r.id]);
  res.status(201).json({ id: r.id, status: d?.status, error: d?.last_error ?? null, gaveUp: !!d?.gave_up_at });
}));

/** Retry one delivery now (ignores the backoff, keeps the cap). */
notificationsRouter.post('/deliveries/:id/retry', asyncHandler(async (req, res) => {
  const n = await retryFailed(accountId(req), req.params.id);
  if (!n) throw notFound('No retryable delivery with that id');
  const d = await one<any>(`SELECT status, attempts, last_error, gave_up_at, next_attempt_at FROM notification_deliveries WHERE id=$1`, [req.params.id]);
  res.json(d);
}));

// ---- devices: the management app registers its push token per signed-in user
notificationsRouter.get('/devices', asyncHandler(async (req, res) => {
  res.json(await query(`SELECT id, platform, label, created_at, last_seen_at, left(token, 12) AS token_prefix
                          FROM user_devices WHERE user_id=$1 ORDER BY last_seen_at DESC`, [req.auth!.sub]));
}));
notificationsRouter.post('/devices', asyncHandler(async (req, res) => {
  const b = z.object({ token: z.string().min(16).max(4096), platform: z.enum(['ios', 'android', 'web']), label: z.string().max(120).optional() }).parse(req.body ?? {});
  const row = await one<any>(
    `INSERT INTO user_devices(account_id, user_id, platform, token, label) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (token) DO UPDATE SET account_id=EXCLUDED.account_id, user_id=EXCLUDED.user_id, platform=EXCLUDED.platform,
                                       label=COALESCE(EXCLUDED.label, user_devices.label), last_seen_at=now()
     RETURNING id, platform, label, created_at, last_seen_at`,
    [accountId(req), req.auth!.sub, b.platform, b.token, b.label ?? null]);
  res.status(201).json(row);
}));
notificationsRouter.delete('/devices/:id', asyncHandler(async (req, res) => {
  const row = await one(`DELETE FROM user_devices WHERE id=$1 AND user_id=$2 RETURNING id`, [req.params.id, req.auth!.sub]);
  if (!row) throw notFound('Device not found');
  res.status(204).end();
}));

// THE LIST STANDARD (util/listQuery.ts) for the inbox: filter unread with
// read_at[exists]=false, search subjects and bodies, page back.
const inboxList = defineList({
  path: '/api/notifications/inbox',
  fields: {
    id: { sql: 'd.id', type: 'uuid' },
    status: { sql: 'd.status', type: 'enum', values: ['pending', 'sent', 'failed'] },
    read_at: { sql: 'd.read_at', type: 'timestamp' },
    created_at: { sql: 'd.created_at', type: 'timestamp', notNull: true },
    topic: { sql: 'n.topic', type: 'string' },
    subject: { sql: 'n.subject', type: 'string' },
    body: { sql: 'n.body', type: 'string', sort: false },
  },
  search: ['topic', 'subject', 'body'],
  defaultSort: '-created_at',
  defaultLimit: 200,
  maxLimit: 200,
  extraParams: ['recipient'],
});

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
  const params: unknown[] = [accountId(req), recipient];
  const pl = parseList(inboxList, req.query, params);
  const rows = finishPage(req, res, pl, await query(
    `SELECT d.id, d.status, d.read_at, d.created_at, n.topic, n.subject, n.body
       FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id
      WHERE d.account_id=$1 AND d.channel='in_app' AND d.recipient=$2${whereSql(pl)}
      ${pageSql(pl)}`,
    params
  ));
  // `unread` counts the rows on this page, as it always did (one page of 200).
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

notificationsRouter.post('/inbox/read-all', asyncHandler(async (req, res) => {
  const me = await one<any>(`SELECT email FROM users WHERE id=$1`, [req.auth!.sub]);
  const rows = await query(
    `UPDATE notification_deliveries SET read_at=now()
      WHERE account_id=$1 AND channel='in_app' AND read_at IS NULL AND lower(recipient)=lower($2) RETURNING id`,
    [accountId(req), String(me?.email ?? '')]);
  res.json({ read: rows.length });
}));

notificationsRouter.post('/retry', asyncHandler(async (req, res) => {
  res.json({ retried: await retryFailed(accountId(req)) });
}));

notificationsRouter.get('/:id', asyncHandler(async (req, res) => {
  const n = await one(`SELECT * FROM notifications WHERE id=$1 AND account_id=$2`, [req.params.id, accountId(req)]);
  if (!n) throw notFound('Notification not found');
  const deliveries = await query(`SELECT id, recipient, channel, status, attempts, last_error, sent_at, next_attempt_at, gave_up_at FROM notification_deliveries WHERE notification_id=$1 ORDER BY recipient, channel`, [req.params.id]);
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

notificationTemplatesRouter.patch('/:id', asyncHandler(async (req, res) => {
  const b = z.object({ subject: z.string().min(1).optional(), body: z.string().min(1).optional() }).parse(req.body ?? {});
  const row = await one(
    `UPDATE notification_templates SET subject=COALESCE($3,subject), body=COALESCE($4,body) WHERE id=$1 AND account_id=$2 RETURNING *`,
    [req.params.id, accountId(req), b.subject ?? null, b.body ?? null]);
  if (!row) throw notFound('Template not found');
  res.json(row);
}));

notificationTemplatesRouter.delete('/:id', asyncHandler(async (req, res) => {
  const row = await one(`DELETE FROM notification_templates WHERE id=$1 AND account_id=$2 RETURNING id`, [req.params.id, accountId(req)]);
  if (!row) throw notFound('Template not found');
  res.status(204).end();
}));
