/**
 * EPG / scheduling API. One canonical programme per channel with a time span;
 * recurrence via materialized series; soft conflict detection (overlaps shown,
 * not blocked); now/next hot path. Tenant-scoped via channel -> group -> account.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest } from '../util/http';
import { expandRrule, validateRrule } from '../services/epg';

export const epgRouter = Router();
epgRouter.use(requireAuth);

async function ownChannel(channelId: string, account: string) {
  return one<any>(
    `SELECT c.id FROM channels c JOIN groups g ON g.id=c.group_id WHERE c.id=$1 AND g.account_id=$2`,
    [channelId, account]
  );
}

/** List programmes overlapping [from,to] for a channel (the guide window). */
epgRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const channelId = String(req.query.channelId ?? '');
    if (!channelId) throw badRequest('channelId required');
    if (!(await ownChannel(channelId, accountId(req)))) throw notFound('Channel not found');
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 3_600_000);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date(Date.now() + 24 * 3_600_000);
    const rows = await query(
      `SELECT * FROM programmes
        WHERE channel_id=$1 AND span && tstzrange($2,$3,'[)')
        ORDER BY starts_at`,
      [channelId, from.toISOString(), to.toISOString()]
    );
    res.json(rows);
  })
);

/** Now + next for a channel (O(1)-ish hot path). */
epgRouter.get(
  '/now-next',
  asyncHandler(async (req, res) => {
    const channelId = String(req.query.channelId ?? '');
    if (!channelId) throw badRequest('channelId required');
    if (!(await ownChannel(channelId, accountId(req)))) throw notFound('Channel not found');
    const now = await one(`SELECT * FROM programmes WHERE channel_id=$1 AND span @> now() ORDER BY starts_at LIMIT 1`, [channelId]);
    const next = await one(`SELECT * FROM programmes WHERE channel_id=$1 AND starts_at > now() ORDER BY starts_at LIMIT 1`, [channelId]);
    res.json({ now: now ?? null, next: next ?? null });
  })
);

/** Overlap/conflict report for a window (soft — surfaced, not blocked). */
epgRouter.get(
  '/conflicts',
  asyncHandler(async (req, res) => {
    const channelId = String(req.query.channelId ?? '');
    if (!channelId) throw badRequest('channelId required');
    if (!(await ownChannel(channelId, accountId(req)))) throw notFound('Channel not found');
    const rows = await query(
      `SELECT a.id AS a_id, a.title AS a_title, b.id AS b_id, b.title AS b_title,
              GREATEST(a.starts_at,b.starts_at) AS overlap_start,
              LEAST(a.ends_at,b.ends_at) AS overlap_end
         FROM programmes a JOIN programmes b
           ON a.channel_id=b.channel_id AND a.id < b.id AND a.span && b.span
        WHERE a.channel_id=$1
        ORDER BY overlap_start`,
      [channelId]
    );
    res.json(rows);
  })
);

const createSchema = z.object({
  channelId: z.string().uuid(),
  title: z.string().min(1),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().optional(), // omitted → resolved to next entry's start (or +1h)
  autoVod: z.boolean().optional(),
  geoMode: z.enum(['worldwide', 'allow', 'block']).optional(),
  geoCountries: z.array(z.string()).optional(),
  metadata: z.record(z.any()).optional(),
  sourceRef: z.string().optional(),
});

/** Create a one-off programme. Resolves the effective end if omitted. */
epgRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const b = createSchema.parse(req.body);
    if (!(await ownChannel(b.channelId, accountId(req)))) throw notFound('Channel not found');
    let endsAt: string;
    if (b.endsAt) {
      endsAt = b.endsAt;
    } else {
      // end = the next programme's start; fall back to +1h if none follows
      const next = await one<any>(`SELECT starts_at FROM programmes WHERE channel_id=$1 AND starts_at > $2 ORDER BY starts_at LIMIT 1`, [b.channelId, b.startsAt]);
      endsAt = next ? new Date(next.starts_at).toISOString() : new Date(Date.parse(b.startsAt) + 3_600_000).toISOString();
    }
    if (Date.parse(endsAt) <= Date.parse(b.startsAt)) throw badRequest('endsAt must be after startsAt');
    const row = await one(
      `INSERT INTO programmes(channel_id, title, starts_at, ends_at, auto_vod, geo_mode, geo_countries, metadata, source_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
       ON CONFLICT (channel_id, source_ref) WHERE source_ref IS NOT NULL
       DO UPDATE SET title=EXCLUDED.title, starts_at=EXCLUDED.starts_at, ends_at=EXCLUDED.ends_at,
                     metadata=EXCLUDED.metadata, updated_at=now()
       RETURNING *`,
      [b.channelId, b.title, b.startsAt, endsAt, b.autoVod ?? false, b.geoMode ?? 'worldwide', b.geoCountries ?? [], JSON.stringify(b.metadata ?? {}), b.sourceRef ?? null]
    );
    // surface overlaps (non-blocking)
    const conflicts = await query(
      `SELECT id, title FROM programmes WHERE channel_id=$1 AND id<>$2 AND span && tstzrange($3,$4,'[)')`,
      [b.channelId, (row as any).id, b.startsAt, endsAt]
    );
    res.status(201).json({ ...(row as any), conflicts });
  })
);

epgRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await one(
      `DELETE FROM programmes p USING channels c JOIN groups g ON g.id=c.group_id
        WHERE p.channel_id=c.id AND p.id=$1 AND g.account_id=$2 RETURNING p.id`,
      [req.params.id, accountId(req)]
    );
    if (!row) throw notFound('Programme not found');
    res.status(204).end();
  })
);

// ---- Recurring series -------------------------------------------------------
const seriesSchema = z.object({
  channelId: z.string().uuid(),
  title: z.string().min(1),
  rrule: z.string().min(3), // e.g. FREQ=DAILY;BYHOUR=16;BYMINUTE=30
  dtstart: z.string().datetime(),
  durationMs: z.number().int().positive(),
  template: z.record(z.any()).optional(),
  horizonDays: z.number().int().positive().max(400).default(90),
});

/** Create a recurring series and materialize its instances over the horizon. */
epgRouter.post(
  '/series',
  asyncHandler(async (req, res) => {
    const b = seriesSchema.parse(req.body);
    if (!(await ownChannel(b.channelId, accountId(req)))) throw notFound('Channel not found');
    const dt = new Date(b.dtstart);
    validateRrule(b.rrule, dt); // throws 500->caught as bad rule; validate explicitly
    const to = new Date(Date.now() + b.horizonDays * 86_400_000);
    const series = await one<any>(
      `INSERT INTO programme_series(channel_id, title, rrule, duration_ms, dtstart, template, materialized_until)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING *`,
      [b.channelId, b.title, b.rrule, b.durationMs, b.dtstart, JSON.stringify(b.template ?? {}), to.toISOString()]
    );
    const instances = expandRrule(b.rrule, dt, b.durationMs, dt, to);
    for (const inst of instances) {
      await one(
        `INSERT INTO programmes(channel_id, series_id, title, starts_at, ends_at, metadata, source_ref)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
         ON CONFLICT (channel_id, source_ref) WHERE source_ref IS NOT NULL DO NOTHING`,
        [b.channelId, series.id, b.title, inst.startsAt, inst.endsAt, JSON.stringify(b.template ?? {}), `series:${series.id}:${inst.startsAt}`]
      );
    }
    res.status(201).json({ series, materialized: instances.length });
  })
);
