/**
 * Support tickets. Clients file + view their own (tenant-scoped, JWT). SaaS
 * staff triage across tenants via the platform overview + PATCH here (platform-auth).
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { requirePlatform } from '../auth/platform';
import { asyncHandler, notFound } from '../util/http';

// ---- client-facing (tenant-scoped) -----------------------------------------
export const ticketsRouter = Router();
ticketsRouter.use(requireAuth);

ticketsRouter.get('/', asyncHandler(async (req, res) => {
  const rows = await query(`SELECT * FROM support_tickets WHERE account_id=$1 ORDER BY created_at DESC`, [accountId(req)]);
  res.json(rows);
}));

const createSchema = z.object({
  subject: z.string().min(1),
  body: z.string().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
});

ticketsRouter.post('/', asyncHandler(async (req, res) => {
  const b = createSchema.parse(req.body);
  const row = await one(
    `INSERT INTO support_tickets(account_id, opened_by, subject, body, priority)
     VALUES ($1,$2,$3,$4,$5::ticket_priority) RETURNING *`,
    [accountId(req), req.auth!.sub, b.subject, b.body ?? null, b.priority]
  );
  res.status(201).json(row);
}));

ticketsRouter.get('/:id', asyncHandler(async (req, res) => {
  const row = await one(`SELECT * FROM support_tickets WHERE id=$1 AND account_id=$2`, [req.params.id, accountId(req)]);
  if (!row) throw notFound('Ticket not found');
  res.json(row);
}));

// ---- platform triage (SaaS staff, cross-tenant) ----------------------------
export const platformTicketsRouter = Router();

platformTicketsRouter.get('/', ...requirePlatform('support'), asyncHandler(async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const rows = await query(
    `SELECT t.*, a.name AS account_name FROM support_tickets t JOIN accounts a ON a.id=t.account_id
      ${status ? 'WHERE t.status=$1::ticket_status' : ''} ORDER BY t.priority DESC, t.created_at DESC LIMIT 200`,
    status ? [status] : []
  );
  res.json(rows);
}));

platformTicketsRouter.patch('/:id', ...requirePlatform('support'), asyncHandler(async (req, res) => {
  const b = z.object({
    status: z.enum(['open', 'pending', 'resolved', 'closed']).optional(),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    assigneeId: z.string().uuid().nullable().optional(),
  }).parse(req.body);
  const row = await one(
    `UPDATE support_tickets SET
       status=COALESCE($2::ticket_status,status),
       priority=COALESCE($3::ticket_priority,priority),
       assignee_id=CASE WHEN $4 THEN $5 ELSE assignee_id END,
       updated_at=now()
     WHERE id=$1 RETURNING *`,
    [req.params.id, b.status ?? null, b.priority ?? null, 'assigneeId' in b, b.assigneeId ?? null]
  );
  if (!row) throw notFound('Ticket not found');
  res.json(row);
}));
