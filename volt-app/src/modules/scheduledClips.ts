import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest } from '../util/http';

/**
 * Scheduled clips — a clipping window set on the live timeline. The orchestrator
 * cuts the range into a VOD asset when end_epoch_ms is reached (output_kind =
 * manifest / progressive / both).
 */
export const scheduledClipsRouter = Router();
scheduledClipsRouter.use(requireAuth);

const OWNED = `
  FROM scheduled_clips sc
  LEFT JOIN channels c ON c.id = sc.channel_id
  LEFT JOIN events   e ON e.id = sc.event_id
  JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
`;

scheduledClipsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const channelId = typeof req.query.channelId === 'string' ? req.query.channelId : null;
    const eventId = typeof req.query.eventId === 'string' ? req.query.eventId : null;
    const rows = await query(
      `SELECT sc.*, COALESCE(c.name, e.name) AS source_name ${OWNED}
        WHERE g.account_id = $1
          AND ($2::uuid IS NULL OR sc.channel_id = $2)
          AND ($3::uuid IS NULL OR sc.event_id = $3)
        ORDER BY sc.end_epoch_ms DESC`,
      [accountId(req), channelId, eventId]
    );
    res.json(rows);
  })
);

const createSchema = z
  .object({
    channelId: z.string().uuid().optional(),
    eventId: z.string().uuid().optional(),
    title: z.string().min(1),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    outputKind: z.enum(['manifest', 'progressive', 'both']).default('manifest'),
  })
  .refine((v) => !!v.channelId !== !!v.eventId, { message: 'exactly one of channelId / eventId' })
  .refine((v) => v.endMs > v.startMs, { message: 'endMs must be after startMs' });

scheduledClipsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const b = createSchema.parse(req.body);
    const kind = b.channelId ? 'channel' : 'event';
    const owned = await one(
      kind === 'channel'
        ? `SELECT c.id FROM channels c JOIN groups g ON g.id=c.group_id WHERE c.id=$1 AND g.account_id=$2`
        : `SELECT e.id FROM events e JOIN groups g ON g.id=e.group_id WHERE e.id=$1 AND g.account_id=$2`,
      [b.channelId ?? b.eventId, accountId(req)]
    );
    if (!owned) throw notFound(`${kind} not found`);
    const row = await one(
      `INSERT INTO scheduled_clips(channel_id, event_id, title, start_epoch_ms, end_epoch_ms, output_kind)
       VALUES ($1,$2,$3,$4,$5,$6::clip_output_kind) RETURNING *`,
      [b.channelId ?? null, b.eventId ?? null, b.title, b.startMs, b.endMs, b.outputKind]
    );
    res.status(201).json(row);
  })
);

scheduledClipsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    // cancel while still scheduled, tenant-scoped
    const cancelled = await one(
      `UPDATE scheduled_clips SET status='cancelled'
        WHERE id=$1 AND status='scheduled'
          AND (channel_id IN (SELECT c.id FROM channels c JOIN groups g ON g.id=c.group_id WHERE g.account_id=$2)
            OR event_id   IN (SELECT e.id FROM events e   JOIN groups g ON g.id=e.group_id WHERE g.account_id=$2))
        RETURNING id`,
      [req.params.id, accountId(req)]
    );
    if (!cancelled) throw badRequest('Not found or no longer scheduled');
    res.status(204).end();
  })
);
