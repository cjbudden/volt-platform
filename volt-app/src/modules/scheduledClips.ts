import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest } from '../util/http';
import { defineList, parseList, whereSql, countWhereSql, countParams, pageSql, finishPage, onlyIdParam } from '../util/listQuery';

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

const SCHEDULED_CLIPS_LIST = defineList({
  path: '/api/scheduled-clips',
  fields: {
    id: { sql: 'sc.id', type: 'uuid' },
    title: { sql: 'sc.title', type: 'string' },
    status: { sql: 'sc.status', type: 'enum', values: ['scheduled', 'firing', 'done', 'error', 'cancelled'] },
    output_kind: { sql: 'sc.output_kind', type: 'enum', values: ['manifest', 'progressive', 'both'] },
    channel_id: { sql: 'sc.channel_id', type: 'uuid' },
    event_id: { sql: 'sc.event_id', type: 'uuid' },
    source_name: { sql: 'COALESCE(c.name, e.name)', type: 'string' },
    vod_asset_id: { sql: 'sc.vod_asset_id', type: 'uuid' },
    start_epoch_ms: { sql: 'sc.start_epoch_ms', type: 'number' },
    end_epoch_ms: { sql: 'sc.end_epoch_ms', type: 'number', notNull: true },
    created_at: { sql: 'sc.created_at', type: 'timestamp' },
  },
  search: ['title', 'source_name'],
  defaultSort: '-end_epoch_ms',
  // The hypermedia links (services/hypermedia.ts) and the console use camelCase.
  aliases: { channelId: 'channel_id', eventId: 'event_id' },
  unpagedLimit: 1000,
});

scheduledClipsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const params: unknown[] = [accountId(req)];
    const pl = parseList(SCHEDULED_CLIPS_LIST, req.query, params);
    const where = `${OWNED} WHERE g.account_id = $1${whereSql(pl)}`;
    const whereCount = `${OWNED} WHERE g.account_id = $1${countWhereSql(pl)}`;  // totals ignore the cursor
    const rows = await query<any>(
      `SELECT sc.*, COALESCE(c.name, e.name) AS source_name ${where} ${pageSql(pl)}`, params);
    const total = pl.count ? Number((await one<any>(`SELECT count(*)::int AS n ${whereCount}`, countParams(pl, params)))?.n ?? 0) : undefined;
    res.json(finishPage(req, res, pl, rows, total));
  })
);

/**
 * One item by id: the canonical "self" link that the JSON-LD + Hydra layer
 * (services/hypermedia.ts) gives every member, so a deep link resolves.
 * Same tenant scoping as the list. (20 Oct 2026)
 */
scheduledClipsRouter.get(
  '/:id',
  onlyIdParam,
  asyncHandler(async (req, res) => {
    const row = await one<any>(`SELECT sc.*, COALESCE(c.name, e.name) AS source_name ${OWNED} WHERE sc.id=$1 AND g.account_id=$2`, [req.params.id, accountId(req)]);
    if (!row) throw notFound('Scheduled clip not found');
    res.json(row);
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
