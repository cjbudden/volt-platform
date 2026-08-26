/**
 * EPG / scheduling API. One canonical programme per OWNER (channel guide, or an
 * event's day schedule) with a time span; recurrence via materialized series;
 * soft conflict detection (overlaps shown, not blocked); now/next hot path.
 * Tenant-scoped via owner -> group -> account.
 *
 * A programme is more than a listing: per-slot GEO access (worldwide/allow/
 * block), an optional slot REPLACEMENT (slate / loop / vod instead of the live
 * feed for that period — enforcement lands with manifest-level playout, the
 * intent is stored and surfaced now), and POST-AIRING AUTOMATION (auto_vod:
 * the scheduler cuts a clip/VOD of the slot from the recording when it ends,
 * named from the programme with its metadata carried onto the asset).
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest } from '../util/http';
import { expandRrule, validateRrule } from '../services/epg';

export const epgRouter = Router();
epgRouter.use(requireAuth);

type OwnerKind = 'channel' | 'event';

/** Tenant check for a guide owner; returns the owner row id or null. */
async function ownOwner(kind: OwnerKind, id: string, account: string) {
  const sql = kind === 'channel'
    ? `SELECT c.id FROM channels c JOIN groups g ON g.id=c.group_id WHERE c.id=$1 AND g.account_id=$2`
    : `SELECT e.id FROM events e JOIN groups g ON g.id=e.group_id WHERE e.id=$1 AND g.account_id=$2`;
  return one<any>(sql, [id, account]);
}

/** Owner column/id from a request's query or body (channelId legacy-supported). */
function ownerOf(src: any): { kind: OwnerKind; id: string } | null {
  if (src.eventId) return { kind: 'event', id: String(src.eventId) };
  if (src.channelId) return { kind: 'channel', id: String(src.channelId) };
  if (src.ownerKind && src.ownerId) return { kind: src.ownerKind === 'event' ? 'event' : 'channel', id: String(src.ownerId) };
  return null;
}
const ownerCol = (k: OwnerKind) => (k === 'channel' ? 'channel_id' : 'event_id');

/**
 * The EPG section's LIST: every channel and event of the account with its
 * guide roll-up — programme count, coverage window, what's on next.
 */
epgRouter.get(
  '/owners',
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT o.kind, o.id, o.name, o.status,
              count(p.id)::int AS programme_count,
              min(p.starts_at) AS first_at,
              max(p.ends_at)   AS last_at,
              count(p.id) FILTER (WHERE p.auto_vod)::int AS auto_clip_count,
              (SELECT title FROM programmes n
                WHERE (n.channel_id = o.id OR n.event_id = o.id) AND n.starts_at > now()
                ORDER BY n.starts_at LIMIT 1) AS next_title,
              (SELECT starts_at FROM programmes n
                WHERE (n.channel_id = o.id OR n.event_id = o.id) AND n.starts_at > now()
                ORDER BY n.starts_at LIMIT 1) AS next_at
         FROM (
           SELECT 'channel'::text AS kind, c.id, c.name, c.status::text FROM channels c
             JOIN groups g ON g.id=c.group_id WHERE g.account_id=$1
           UNION ALL
           SELECT 'event', e.id, e.name, e.status::text FROM events e
             JOIN groups g ON g.id=e.group_id WHERE g.account_id=$1
         ) o
         LEFT JOIN programmes p ON (p.channel_id = o.id OR p.event_id = o.id)
        GROUP BY o.kind, o.id, o.name, o.status
        ORDER BY count(p.id) DESC, o.name`,
      [accountId(req)]
    );
    res.json(rows);
  })
);

/** List programmes overlapping [from,to] for an owner (the guide window). */
epgRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const owner = ownerOf(req.query);
    if (!owner) throw badRequest('channelId, eventId, or ownerKind+ownerId required');
    if (!(await ownOwner(owner.kind, owner.id, accountId(req)))) throw notFound('Owner not found');
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 3_600_000);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date(Date.now() + 24 * 3_600_000);
    const rows = await query(
      `SELECT * FROM programmes
        WHERE ${ownerCol(owner.kind)}=$1 AND span && tstzrange($2,$3,'[)')
        ORDER BY starts_at`,
      [owner.id, from.toISOString(), to.toISOString()]
    );
    res.json(rows);
  })
);

/** Now + next for an owner (O(1)-ish hot path). */
epgRouter.get(
  '/now-next',
  asyncHandler(async (req, res) => {
    const owner = ownerOf(req.query);
    if (!owner) throw badRequest('channelId, eventId, or ownerKind+ownerId required');
    if (!(await ownOwner(owner.kind, owner.id, accountId(req)))) throw notFound('Owner not found');
    const col = ownerCol(owner.kind);
    const now = await one(`SELECT * FROM programmes WHERE ${col}=$1 AND span @> now() ORDER BY starts_at LIMIT 1`, [owner.id]);
    const next = await one(`SELECT * FROM programmes WHERE ${col}=$1 AND starts_at > now() ORDER BY starts_at LIMIT 1`, [owner.id]);
    res.json({ now: now ?? null, next: next ?? null });
  })
);

/** Overlap/conflict report (soft — surfaced, not blocked). Optional window. */
epgRouter.get(
  '/conflicts',
  asyncHandler(async (req, res) => {
    const owner = ownerOf(req.query);
    if (!owner) throw badRequest('channelId, eventId, or ownerKind+ownerId required');
    if (!(await ownOwner(owner.kind, owner.id, accountId(req)))) throw notFound('Owner not found');
    const col = ownerCol(owner.kind);
    const win = req.query.from && req.query.to
      ? `AND a.span && tstzrange('${new Date(String(req.query.from)).toISOString()}','${new Date(String(req.query.to)).toISOString()}','[)')`
      : '';
    const rows = await query(
      `SELECT a.id AS a_id, a.title AS a_title, b.id AS b_id, b.title AS b_title,
              GREATEST(a.starts_at,b.starts_at) AS overlap_start,
              LEAST(a.ends_at,b.ends_at) AS overlap_end
         FROM programmes a JOIN programmes b
           ON a.${col}=b.${col} AND a.id < b.id AND a.span && b.span
        WHERE a.${col}=$1 ${win}
        ORDER BY overlap_start`,
      [owner.id]
    );
    res.json(rows);
  })
);

const programmeFields = {
  title: z.string().min(1),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().optional(), // omitted → resolved to next entry's start (or +1h)
  autoVod: z.boolean().optional(),
  geoMode: z.enum(['worldwide', 'allow', 'block']).optional(),
  geoCountries: z.array(z.string()).optional(),
  replacementKind: z.enum(['none', 'slate', 'loop', 'vod']).optional(),
  replacementRef: z.string().nullable().optional(),
  metadata: z.record(z.any()).optional(),
  sourceRef: z.string().optional(),
};
const createSchema = z.object({
  channelId: z.string().uuid().optional(),
  eventId: z.string().uuid().optional(),
  ...programmeFields,
});

/** Create a one-off programme. Resolves the effective end if omitted. */
epgRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const b = createSchema.parse(req.body);
    const owner = ownerOf(b);
    if (!owner) throw badRequest('channelId or eventId required');
    if (!(await ownOwner(owner.kind, owner.id, accountId(req)))) throw notFound('Owner not found');
    const col = ownerCol(owner.kind);
    let endsAt: string;
    if (b.endsAt) {
      endsAt = b.endsAt;
    } else {
      // end = the next programme's start; fall back to +1h if none follows
      const next = await one<any>(`SELECT starts_at FROM programmes WHERE ${col}=$1 AND starts_at > $2 ORDER BY starts_at LIMIT 1`, [owner.id, b.startsAt]);
      endsAt = next ? new Date(next.starts_at).toISOString() : new Date(Date.parse(b.startsAt) + 3_600_000).toISOString();
    }
    if (Date.parse(endsAt) <= Date.parse(b.startsAt)) throw badRequest('endsAt must be after startsAt');
    if ((b.replacementKind ?? 'none') !== 'none' && !b.replacementRef) throw badRequest('replacementRef required for a slot replacement');
    // the idempotent-import upsert must name the partial index predicate EXACTLY
    // (channel and event use different partial unique indexes)
    const conflict = owner.kind === 'channel'
      ? `ON CONFLICT (channel_id, source_ref) WHERE source_ref IS NOT NULL`
      : `ON CONFLICT (event_id, source_ref) WHERE source_ref IS NOT NULL AND event_id IS NOT NULL`;
    const row = await one(
      `INSERT INTO programmes(${col}, title, starts_at, ends_at, auto_vod, geo_mode, geo_countries,
                              replacement_kind, replacement_ref, metadata, source_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
       ${conflict}
       DO UPDATE SET title=EXCLUDED.title, starts_at=EXCLUDED.starts_at, ends_at=EXCLUDED.ends_at,
                     metadata=EXCLUDED.metadata, updated_at=now()
       RETURNING *`,
      [owner.id, b.title, b.startsAt, endsAt, b.autoVod ?? false, b.geoMode ?? 'worldwide', b.geoCountries ?? [],
       b.replacementKind ?? 'none', b.replacementRef ?? null, JSON.stringify(b.metadata ?? {}), b.sourceRef ?? null]
    );
    // surface overlaps (non-blocking)
    const conflicts = await query(
      `SELECT id, title FROM programmes WHERE ${col}=$1 AND id<>$2 AND span && tstzrange($3,$4,'[)')`,
      [owner.id, (row as any).id, b.startsAt, endsAt]
    );
    res.status(201).json({ ...(row as any), conflicts });
  })
);

/** Owned programme row (tenant-scoped through either owner). */
async function ownedProgramme(id: string, account: string) {
  return one<any>(
    `SELECT p.* FROM programmes p
       LEFT JOIN channels c ON c.id = p.channel_id
       LEFT JOIN events   e ON e.id = p.event_id
       JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
      WHERE p.id=$1 AND g.account_id=$2`,
    [id, account]
  );
}

const patchSchema = z.object({
  title: z.string().min(1).optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  autoVod: z.boolean().optional(),
  geoMode: z.enum(['worldwide', 'allow', 'block']).optional(),
  geoCountries: z.array(z.string()).optional(),
  replacementKind: z.enum(['none', 'slate', 'loop', 'vod']).optional(),
  replacementRef: z.string().nullable().optional(),
  metadata: z.record(z.any()).optional(),
});

/** Edit a programme (times, geo, replacement, auto-clip, metadata). */
epgRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const b = patchSchema.parse(req.body);
    const cur = await ownedProgramme(req.params.id, accountId(req));
    if (!cur) throw notFound('Programme not found');
    const startsAt = b.startsAt ?? new Date(cur.starts_at).toISOString();
    const endsAt = b.endsAt ?? new Date(cur.ends_at).toISOString();
    if (Date.parse(endsAt) <= Date.parse(startsAt)) throw badRequest('endsAt must be after startsAt');
    const has = (k: string) => Object.prototype.hasOwnProperty.call(req.body ?? {}, k);
    const row = await one(
      `UPDATE programmes SET
         title = COALESCE($2, title),
         starts_at = $3, ends_at = $4,
         auto_vod = COALESCE($5, auto_vod),
         geo_mode = COALESCE($6, geo_mode),
         geo_countries = COALESCE($7, geo_countries),
         replacement_kind = COALESCE($8, replacement_kind),
         replacement_ref = CASE WHEN $9 THEN $10 ELSE replacement_ref END,
         metadata = COALESCE($11::jsonb, metadata),
         updated_at = now()
       WHERE id=$1 RETURNING *`,
      [cur.id, b.title ?? null, startsAt, endsAt, b.autoVod ?? null, b.geoMode ?? null,
       has('geoCountries') ? b.geoCountries : null,
       b.replacementKind ?? null, has('replacementRef'), b.replacementRef ?? null,
       has('metadata') ? JSON.stringify(b.metadata) : null]
    );
    res.json(row);
  })
);

epgRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const cur = await ownedProgramme(req.params.id, accountId(req));
    if (!cur) throw notFound('Programme not found');
    await query('DELETE FROM programmes WHERE id=$1', [cur.id]);
    res.status(204).end();
  })
);

/**
 * COPY DAY: clone every programme overlapping [fromStart, fromEnd) shifted by
 * each day offset — "repeat Monday onto Tue..Fri" is offsets [1,2,3,4]. Clones
 * drop source_ref/series linkage (they are independent copies) and reset the
 * auto-clip bookkeeping. Overlaps at the target are soft, like everything else.
 */
const copySchema = z.object({
  channelId: z.string().uuid().optional(),
  eventId: z.string().uuid().optional(),
  fromStart: z.string().datetime(),
  fromEnd: z.string().datetime(),
  dayOffsets: z.array(z.number().int().min(-366).max(366)).min(1).max(62),
});
epgRouter.post(
  '/copy-day',
  asyncHandler(async (req, res) => {
    const b = copySchema.parse(req.body);
    const owner = ownerOf(b);
    if (!owner) throw badRequest('channelId or eventId required');
    if (!(await ownOwner(owner.kind, owner.id, accountId(req)))) throw notFound('Owner not found');
    if (Date.parse(b.fromEnd) <= Date.parse(b.fromStart)) throw badRequest('fromEnd must be after fromStart');
    const col = ownerCol(owner.kind);
    const src = await query<any>(
      `SELECT * FROM programmes WHERE ${col}=$1 AND span && tstzrange($2,$3,'[)') ORDER BY starts_at`,
      [owner.id, b.fromStart, b.fromEnd]
    );
    let created = 0;
    for (const off of b.dayOffsets) {
      if (off === 0) continue;
      const shift = off * 86_400_000;
      for (const p of src) {
        await query(
          `INSERT INTO programmes(${col}, title, starts_at, ends_at, auto_vod, geo_mode, geo_countries,
                                  replacement_kind, replacement_ref, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
          [owner.id, p.title,
           new Date(new Date(p.starts_at).getTime() + shift).toISOString(),
           new Date(new Date(p.ends_at).getTime() + shift).toISOString(),
           p.auto_vod, p.geo_mode, p.geo_countries, p.replacement_kind, p.replacement_ref,
           JSON.stringify(p.metadata ?? {})]
        );
        created++;
      }
    }
    res.status(201).json({ copied: src.length, created });
  })
);

/** CLEAR DAY: delete every programme fully inside [fromStart, fromEnd). */
const clearSchema = z.object({
  channelId: z.string().uuid().optional(),
  eventId: z.string().uuid().optional(),
  fromStart: z.string().datetime(),
  fromEnd: z.string().datetime(),
});
epgRouter.post(
  '/clear-day',
  asyncHandler(async (req, res) => {
    const b = clearSchema.parse(req.body);
    const owner = ownerOf(b);
    if (!owner) throw badRequest('channelId or eventId required');
    if (!(await ownOwner(owner.kind, owner.id, accountId(req)))) throw notFound('Owner not found');
    const col = ownerCol(owner.kind);
    const rows = await query<any>(
      `DELETE FROM programmes WHERE ${col}=$1 AND starts_at >= $2 AND starts_at < $3 RETURNING id`,
      [owner.id, b.fromStart, b.fromEnd]
    );
    res.json({ deleted: rows.length });
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
    if (!(await ownOwner('channel', b.channelId, accountId(req)))) throw notFound('Channel not found');
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
