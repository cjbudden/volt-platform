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
import { query, one, tx } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest } from '../util/http';
import { defineList, parseList, whereSql, pageSql, finishPage, onlyIdParam } from '../util/listQuery';
import { expandRrule, validateRrule } from '../services/epg';
import { programmeVodStates, convertProgramme } from '../services/epgVod';
import { programmeFieldsFrom } from '../services/contentTypes';
import { usageStatusSql, usageStatusLabel, type UsageStatus } from '../services/assetReadiness';

/**
 * A BLACKOUT REPLACEMENT MUST PLAY. A VOD replacement is what a blocked viewer
 * gets instead of the programme, so an asset whose build failed, or that QC
 * could not decode, would turn a blackout into a broken player. Only ready
 * assets are accepted (services/assetReadiness.ts).
 */
async function assertReplacementUsable(kind: string | null | undefined, ref: string | null | undefined): Promise<void> {
  if (kind !== 'vod' || !ref) return;
  const id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(ref)?.[0];
  if (!id) return;
  const r = await one<{ title: string; usage_status: UsageStatus }>(
    `SELECT v.title, ${usageStatusSql('v')} AS usage_status FROM vod_assets v WHERE v.id = $1`, [id]);
  if (r && r.usage_status !== 'ready') {
    throw badRequest(`"${r.title}" cannot be used as a replacement: ${usageStatusLabel(r.usage_status).toLowerCase()}. Pick an asset that is ready.`);
  }
}
import { resolveEffectiveFields } from './metadataSchemas';
import {
  place, decide, summarise, fieldsOf, draftSeries, insertSeries, materialize, seriesCandidates, seriesOccursOn,
  horizonEnd, itemFromRow, applyItemChange, splitSeries, removeItem, removeRows, seriesInfo, normSeries,
  seriesRef, dateOnly, rowForStore, type Candidate, type Policy, type SeriesItem, type NewSeries,
} from '../services/epgPlace';
import {
  isDate, isTimeZone, addDays, diffDays, localDateOf, localTimeOf, localToUtc, localDayBounds, validateRule,
  describeRule, WEEKDAYS, type RepeatRule,
} from '../services/epgRepeat';

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
      `SELECT o.kind, o.id, o.name, o.status, o.icon_ref,
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
           -- A RADIO STATION IS ITS OWN KIND, and the column already says which.
           --
           -- This was the literal 'channel' for every row, so the EPG page's
           -- Channels filter swept up every radio station in the account and a
           -- twenty-one-station list buried the two television channels in it.
           -- channels.kind has been 'tv' | 'radio' since the first migration;
           -- the literal was classifying instead of the column.
           --
           -- 'radio' is emitted rather than 'tv' because the caller's vocabulary
           -- is channel / radio / event, and a kind called 'tv' would need
           -- translating at every consumer.
           SELECT CASE WHEN c.kind = 'radio' THEN 'radio' ELSE 'channel' END AS kind,
                  c.id, c.name, c.status::text,
                  -- The image the guide shows (services/guideIcon.ts): guide icon,
                  -- else the channel / station image, else a linked feed's icon.
                  COALESCE(c.guide_icon_ref, c.brand_ref,
                    (SELECT a.icon FROM epg_channel_aliases a WHERE a.channel_id = c.id AND a.icon <> ''
                      ORDER BY a.last_seen_at DESC NULLS LAST LIMIT 1)) AS icon_ref
             FROM channels c
             JOIN groups g ON g.id=c.group_id WHERE g.account_id=$1
           UNION ALL
           SELECT 'event', e.id, e.name, e.status::text, NULL::text FROM events e
             JOIN groups g ON g.id=e.group_id WHERE g.account_id=$1
         ) o
         LEFT JOIN programmes p ON (p.channel_id = o.id OR p.event_id = o.id)
        GROUP BY o.kind, o.id, o.name, o.status, o.icon_ref
        ORDER BY count(p.id) DESC, o.name`,
      [accountId(req)]
    );
    res.json(rows);
  })
);

/** List programmes overlapping [from,to] for an owner (the guide window). */
// The owner and window stay required, as before; the list standard
// (util/listQuery.ts) adds search, filters, sort and paging inside the window.
const programmeList = defineList({
  path: '/api/epg',
  fields: {
    id: { sql: 'p.id', type: 'uuid' },
    title: { sql: 'p.title', type: 'string' },
    starts_at: { sql: 'p.starts_at', type: 'timestamp', notNull: true },
    ends_at: { sql: 'p.ends_at', type: 'timestamp' },
    status: { sql: 'p.status', type: 'enum', values: ['scheduled', 'live', 'aired', 'cancelled'] },
    series_id: { sql: 'p.series_id', type: 'uuid' },
    source_ref: { sql: 'p.source_ref', type: 'string' },
    auto_vod: { sql: 'p.auto_vod', type: 'boolean' },
    geo_mode: { sql: 'p.geo_mode', type: 'string' },
    replacement_kind: { sql: 'p.replacement_kind', type: 'string' },
    clip_status: { sql: 'p.clip_status', type: 'string' },
    clip_asset_id: { sql: 'p.clip_asset_id', type: 'uuid' },
    actual_start: { sql: 'p.actual_start', type: 'timestamp' },
    actual_end: { sql: 'p.actual_end', type: 'timestamp' },
    expected_viewers: { sql: 'p.expected_viewers', type: 'number' },
    created_at: { sql: 'p.created_at', type: 'timestamp' },
    updated_at: { sql: 'p.updated_at', type: 'timestamp' },
  },
  search: ['title', "p.metadata->>'description'"],
  defaultSort: 'starts_at',
  defaultLimit: 50,
  maxLimit: 1000,
  unpagedLimit: 1000,
  aliases: { startsAt: 'starts_at', endsAt: 'ends_at', seriesId: 'series_id', autoVod: 'auto_vod' },
  // The owner and the window: required context, not filters.
  extraParams: ['channelId', 'eventId', 'ownerKind', 'ownerId', 'from', 'to'],
});

epgRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const owner = ownerOf(req.query);
    if (!owner) throw badRequest('channelId, eventId, or ownerKind+ownerId required');
    if (!(await ownOwner(owner.kind, owner.id, accountId(req)))) throw notFound('Owner not found');
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 3_600_000);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date(Date.now() + 24 * 3_600_000);
    const base: unknown[] = [owner.id, from.toISOString(), to.toISOString()];
    const params = [...base];
    const pl = parseList(programmeList, req.query, params);
    const where = `WHERE p.${ownerCol(owner.kind)}=$1 AND p.span && tstzrange($2,$3,'[)')${whereSql(pl)}`;
    const rows = await query<any>(`SELECT p.* FROM programmes p ${where} ${pageSql(pl)}`, params);
    const cParams = [...base];
    const cWhere = pl.count ? whereSql(parseList(programmeList, { ...req.query, cursor: undefined, offset: undefined }, cParams)) : '';
    const total = pl.count ? (await one<any>(`SELECT count(*)::int AS n FROM programmes p WHERE p.${ownerCol(owner.kind)}=$1 AND p.span && tstzrange($2,$3,'[)')${cWhere}`, cParams))?.n : undefined;
    res.json(finishPage(req, res, pl, rows, total));
  })
);

/**
 * PLAN VS AS-RUN for a channel's guide (services/asRun.ts): each programme's
 * planned and actual times, on-air, source and filler seconds, and whether it
 * aired, partly aired or was missed. Computed from the encoder's own run and
 * splice events, so it is current even between the scheduler's passes.
 * Window: `from` / `to` (default the last 24 hours), at most 7 days.
 */
epgRouter.get(
  '/as-run',
  asyncHandler(async (req, res) => {
    const id = String(req.query.channelId ?? req.query.channel_id ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw badRequest('channelId required');
    if (!(await ownOwner('channel', id, accountId(req)))) throw notFound('Channel not found');
    const now = Date.now();
    const t = (v: unknown, d: number) => { const x = v ? Date.parse(String(v)) : NaN; return Number.isFinite(x) ? x : d; };
    const from = t(req.query.from, now - 24 * 3600_000), to = t(req.query.to, now);
    if (!(to > from) || to - from > 7 * 86400_000) throw badRequest('window must be positive and at most 7 days');
    const { asRunReport } = await import('../services/asRun');
    res.json(await asRunReport(id, from, to, now));
  })
);

/**
 * One item by id: the canonical "self" link that the JSON-LD + Hydra layer
 * (services/hypermedia.ts) gives every member, so a deep link resolves.
 * Same tenant scoping as the list. (20 Oct 2026)
 */
epgRouter.get(
  '/:id',
  onlyIdParam,
  asyncHandler(async (req, res) => {
    const row = await one<any>(`SELECT p.* FROM programmes p WHERE p.id=$1`, [req.params.id]);
    const owner = row ? (row.event_id ? { kind: 'event' as OwnerKind, id: row.event_id } : row.channel_id ? { kind: 'channel' as OwnerKind, id: row.channel_id } : null) : null;
    if (!row || !owner || !(await ownOwner(owner.kind, owner.id, accountId(req)))) throw notFound('Programme not found');
    res.json(row);
  })
);

/**
 * THE VOD LIFECYCLE OF A WINDOW'S PROGRAMMES.
 *
 * Kept OFF `GET /api/epg` deliberately. That endpoint returns raw programme
 * rows and is read by things that only want the listing; this one measures the
 * archive on disk, and making every guide read pay for a filesystem scan to
 * satisfy one screen would be the wrong trade. The builder asks for both.
 *
 * Returned as a keyed map rather than an array so the client joins by id and
 * cannot silently mis-pair by index when the two responses disagree about how
 * many programmes are in the window, which they can if one is edited between
 * the two requests.
 */
epgRouter.get(
  '/vod-status',
  asyncHandler(async (req, res) => {
    const owner = ownerOf(req.query);
    if (!owner) throw badRequest('channelId, eventId, or ownerKind+ownerId required');
    if (!(await ownOwner(owner.kind, owner.id, accountId(req)))) throw notFound('Owner not found');
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 3_600_000);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date(Date.now() + 24 * 3_600_000);
    const rows = await programmeVodStates(owner.kind, owner.id, from.toISOString(), to.toISOString());
    const byId: Record<string, typeof rows[number]> = {};
    for (const r of rows) byId[r.id] = r;
    res.json({ programmes: byId });
  })
);

/**
 * CONVERT THIS SLOT NOW.
 *
 * The action behind the `convertible` and `failed` states. It runs the SAME
 * conversion the scheduler runs, from services/epgVod.ts, rather than a second
 * implementation that agrees with it today.
 *
 * A slot that is already converted or mid-conversion answers 409 with what it
 * is doing instead. That is not pedantry: the failure it prevents is an
 * operator pressing the button twice on a slow conversion and getting two
 * assets cut from the same span, which nothing downstream would flag as odd.
 */
epgRouter.post(
  '/:id/convert',
  asyncHandler(async (req, res) => {
    const p = await one<any>(`SELECT * FROM programmes WHERE id=$1`, [req.params.id]);
    if (!p) throw notFound('Programme not found');
    const kind: OwnerKind = p.channel_id ? 'channel' : 'event';
    const ownerId = p.channel_id ?? p.event_id;
    if (!(await ownOwner(kind, ownerId, accountId(req)))) throw notFound('Programme not found');
    if (new Date(p.actual_end ?? p.ends_at).getTime() > Date.now()) {
      throw badRequest('This programme has not finished airing yet');
    }
    // allowRetry lets a failed slot be tried again; a converted one is still
    // refused, because the fix for a bad asset is to delete it, not to make a
    // second one beside it.
    const out = await convertProgramme(p.id, { allowRetry: true });
    if ('skipped' in out) {
      res.status(409).json({ error: out.skipped });
      return;
    }
    res.status(201).json({ assetId: out.assetId });
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
    // THE BASE ENTRY. With no programme on, the owner's own type metadata is
    // what is on: a station's identity, an event's name and description. It
    // is returned in the same EPG shape a programme would give, so a guide
    // client never has an empty "now".
    const base = await ownerBaseEntry(owner.kind, owner.id, accountId(req));
    res.json({ now: now ?? null, next: next ?? null, base, nowIsBase: !now && !!base });
  })
);

/**
 * An owner's type metadata rendered through its type's EPG mapping: title,
 * sub-title, description, categories, credits, icon. The fallback for now/next
 * and the prefill for a new programme on that owner.
 */
export async function ownerBaseEntry(kind: 'channel' | 'event', id: string, account: string) {
  const table = kind === 'channel' ? 'channels' : 'events';
  const row = await one<any>(`SELECT name, schema_id, metadata FROM ${table} WHERE id = $1`, [id]);
  if (!row) return null;
  const resolved = row.schema_id ? await resolveEffectiveFields(row.schema_id, account) : null;
  const mapped = resolved ? programmeFieldsFrom(resolved.fields, row.metadata ?? {}) : { categories: [], credits: [], custom: {} };
  return {
    title: mapped.title ?? row.name,
    subTitle: mapped.subTitle ?? null,
    description: mapped.description ?? null,
    categories: mapped.categories,
    episode: mapped.episode ?? null,
    language: mapped.language ?? null,
    icon: mapped.icon ?? null,
    credits: mapped.credits,
    custom: mapped.custom,
    schemaId: row.schema_id ?? null,
  };
}

/** The prefill for "Add programme" on an owner: its base entry. */
epgRouter.get(
  '/owner-defaults',
  asyncHandler(async (req, res) => {
    const owner = ownerOf(req.query);
    if (!owner) throw badRequest('channelId, eventId, or ownerKind+ownerId required');
    if (!(await ownOwner(owner.kind, owner.id, accountId(req)))) throw notFound('Owner not found');
    res.json(await ownerBaseEntry(owner.kind, owner.id, accountId(req)));
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
    await assertReplacementUsable(b.replacementKind, b.replacementRef);
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
  /** For a repeat occurrence: this one (default), this and following, or every future one. */
  scope: z.enum(['this', 'following', 'series']).optional(),
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
    await assertReplacementUsable(b.replacementKind ?? cur.replacement_kind, b.replacementRef);
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
    // REPEATS. "This one" marks the occurrence as individually edited so a
    // later "all repeats" change leaves it alone. "This and following" splits
    // the repeat here and changes the new part; "all" changes the item for
    // every future occurrence. The stored item takes the local time, so the
    // change lands at the same wall-clock time on every date.
    let repeat: any = undefined;
    if (cur.series_id && cur.series_key) {
      const scope = b.scope ?? 'this';
      if (scope === 'this') {
        await query('UPDATE programmes SET series_detached = true WHERE id=$1', [cur.id]);
      } else {
        const s = normSeries(await one<any>('SELECT * FROM programme_series WHERE id=$1', [cur.series_id]));
        const date = dateOnly(cur.series_date)!;
        const patch: Partial<SeriesItem> = {};
        if (b.title) patch.title = b.title;
        if (b.startsAt || b.endsAt) { patch.at = localTimeOf(startsAt, s.tz); patch.durationMs = Date.parse(endsAt) - Date.parse(startsAt); }
        if (b.autoVod !== undefined) patch.autoVod = b.autoVod;
        if (b.geoMode) patch.geoMode = b.geoMode;
        if (has('geoCountries')) patch.geoCountries = b.geoCountries ?? [];
        if (b.replacementKind) patch.replacementKind = b.replacementKind;
        if (has('replacementRef')) patch.replacementRef = b.replacementRef ?? null;
        if (has('metadata')) patch.metadata = b.metadata ?? {};
        repeat = await tx(async (c) => {
          const sid = scope === 'following' ? await splitSeries(c, cur.series_id, date) : cur.series_id;
          const from = scope === 'following' ? date : localDateOf(new Date(), s.tz);
          await c.query('UPDATE programmes SET series_detached = false WHERE id=$1', [cur.id]);
          return { scope, seriesId: sid, ...(await applyItemChange(c, sid, cur.series_key, patch, from)) };
        });
      }
    }
    const fresh = repeat ? await one('SELECT * FROM programmes WHERE id=$1', [cur.id]) : row;
    res.json(repeat ? { ...(fresh as any), repeat } : fresh);
  })
);

epgRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const cur = await ownedProgramme(req.params.id, accountId(req));
    if (!cur) throw notFound('Programme not found');
    const scope = String(req.query.scope ?? 'this');
    if (cur.series_id && cur.series_key && (scope === 'following' || scope === 'series')) {
      const date = dateOnly(cur.series_date)!;
      const out = await tx(async (c) => {
        await c.query('DELETE FROM programmes WHERE id=$1 AND starts_at > now()', [cur.id]);
        const sid = scope === 'following' ? await splitSeries(c, cur.series_id, date) : cur.series_id;
        return removeItem(c, sid, cur.series_key, scope === 'following' ? date : null);
      });
      res.json({ scope, ...out });
      return;
    }
    // A single occurrence of a repeat is remembered as removed, so the
    // rolling top-up does not put it back.
    await tx((c) => removeRows(c, [cur]));
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
  asyncHandler(async (req, res, next) => {
    // The day-based form (sourceDate) is the current one: wall-clock dates in
    // a zone, a rule for what is already there, a preview, and an undo. The
    // offset form below is kept for existing API clients and keeps its old
    // behaviour (keep both).
    if (req.body && req.body.sourceDate) return copyDayV2(req, res);
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
    // Recorded as a batch so Clear day can be undone, and repeat occurrences
    // it removes are written to their repeat's exdates so the top-up does not
    // quietly refill the day that was just cleared.
    const out = await tx(async (c) => {
      const rows = (await c.query(`SELECT * FROM programmes WHERE ${col}=$1 AND starts_at >= $2 AND starts_at < $3`, [owner.id, b.fromStart, b.fromEnd])).rows;
      const ex = await removeRows(c, rows);
      let batchId: string | null = null;
      if (rows.length) {
        const r = await c.query(
          `INSERT INTO epg_batches(account_id, owner_kind, owner_id, action, label, removed, exdates_added)
           VALUES ($1,$2,$3,'clear',$4,$5::jsonb,$6::jsonb) RETURNING id`,
          [accountId(req), owner.kind, owner.id, `Cleared ${rows.length} programme(s)`, JSON.stringify(rows.map(rowForStore)), JSON.stringify(ex)]);
        batchId = r.rows[0].id;
      }
      return { deleted: rows.length, batchId };
    });
    res.json(out);
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


// ===================================================== copy, repeat, undo
//
// Copy day and Repeat share services/epgPlace.ts: the same rule for what is
// already there (replace / skip / keep), the same protected programmes, the
// same preview (dryRun) and the same undo. A repeated DAY and a repeated
// PROGRAMME are one mechanism with one or many items, so the two can be used
// together: whichever is applied later meets the other through those rules.

const policySchema = z.enum(['replace', 'skip', 'keep']).default('replace');
const ruleSchema = z.object({
  freq: z.enum(['daily', 'weekdays', 'weekly']),
  interval: z.number().int().min(1).max(52).optional(),
  byDay: z.array(z.enum(WEEKDAYS as [string, ...string[]])).optional(),
});
const dateStr = z.string().refine(isDate, 'expected YYYY-MM-DD');

/** The zone wall-clock times are read in: the caller's, else the channel's, else UTC. */
async function resolveTz(kind: OwnerKind, id: string, asked?: string): Promise<string> {
  if (isTimeZone(asked)) return asked;
  if (kind === 'channel') {
    const r = await one<any>('SELECT tz FROM channels WHERE id=$1', [id]);
    if (isTimeZone(r?.tz)) return r.tz;
  }
  return 'UTC';
}

function userUuid(req: any): string | null {
  const sub = req.auth?.sub;
  return typeof sub === 'string' && /^[0-9a-f-]{36}$/i.test(sub) ? sub : null;
}

function shape(r: { outcomes: any[]; summary: any; batchId?: string | null }, extra: Record<string, unknown> = {}) {
  return { summary: r.summary, outcomes: r.outcomes, batchId: r.batchId ?? null, ...extra };
}

const copyV2Schema = z.object({
  channelId: z.string().uuid().optional(),
  eventId: z.string().uuid().optional(),
  sourceDate: dateStr,
  tz: z.string().optional(),
  /** Independent copies onto these dates. */
  dates: z.array(dateStr).max(120).optional(),
  /** Or a linked repeat of the whole day. */
  repeat: z.object({ rule: ruleSchema, until: dateStr.nullable().optional() }).optional(),
  policy: policySchema,
  dryRun: z.boolean().optional(),
});

async function copyDayV2(req: any, res: any) {
  const b = copyV2Schema.parse(req.body);
  const owner = ownerOf(b);
  if (!owner) throw badRequest('channelId or eventId required');
  if (!(await ownOwner(owner.kind, owner.id, accountId(req)))) throw notFound('Owner not found');
  if (!b.dates?.length && !b.repeat) throw badRequest('Choose dates to copy to, or a repeat');
  const tz = await resolveTz(owner.kind, owner.id, b.tz);
  const col = ownerCol(owner.kind);
  const { start, end } = localDayBounds(b.sourceDate, tz);
  // Programmes that START on the source day. A programme that began the night
  // before and runs past midnight belongs to the previous day; taking every
  // overlapping programme (as the offset form does) copied it twice.
  const src = await query<any>(
    `SELECT * FROM programmes WHERE ${col}=$1 AND starts_at >= $2 AND starts_at < $3 AND status <> 'cancelled'
        AND (source_ref IS NULL OR source_ref NOT LIKE 'icy:%') ORDER BY starts_at`,
    [owner.id, start, end]);
  if (!src.length) throw badRequest('There is nothing on that day to copy');

  if (b.repeat) {
    const err = validateRule(b.repeat.rule as RepeatRule);
    if (err) throw badRequest(err);
    const until = b.repeat.until ?? null;
    const startDate = addDays(b.sourceDate, 1);
    if (until && until < startDate) throw badRequest('The repeat must end after the day being repeated');
    const n: NewSeries = {
      owner, kind: 'day', rule: b.repeat.rule as RepeatRule, tz, startDate, untilDate: until, policy: b.policy,
      sourceDate: b.sourceDate, items: src.map((r, i) => itemFromRow(r, `d${i}`, tz)),
    };
    const describe = describeRule(n.rule, until);
    if (b.dryRun) {
      const d = draftSeries(n);
      const r = await place(owner, seriesCandidates(d, startDate, horizonEnd(d, tz)), b.policy, { dryRun: true });
      res.json(shape(r, { tz, describe, openEnded: !until, horizonDays: until ? null : 60, sourceCount: src.length }));
      return;
    }
    const out = await tx(async (c) => {
      const s = await insertSeries(c, n);
      const r = await materialize(c, s, startDate, horizonEnd(s, tz), {
        batch: { accountId: accountId(req), action: 'repeat', label: `Repeated ${b.sourceDate}: ${describe}`, userId: userUuid(req), seriesId: s.id },
      });
      return { ...r, seriesId: s.id };
    });
    res.status(201).json(shape(out, { tz, describe, seriesId: out.seriesId, sourceCount: src.length }));
    return;
  }

  const dates = [...new Set(b.dates!)].filter((d) => d !== b.sourceDate).sort();
  if (!dates.length) throw badRequest('Choose at least one date other than the day being copied');
  // A programme that is itself part of a repeat is skipped on a date its
  // repeat already covers: copying it would put it there twice.
  const seriesIds = [...new Set(src.map((r) => r.series_id).filter(Boolean))];
  const series = new Map<string, any>();
  for (const id of seriesIds) {
    const raw = await one<any>('SELECT * FROM programme_series WHERE id=$1', [id]);
    if (raw && raw.rule) series.set(id, normSeries(raw));
  }
  const cands: Candidate[] = [];
  for (const date of dates) {
    for (const r of src) {
      const startsAt = localToUtc(date, localTimeOf(r.starts_at, tz), tz);
      const s = r.series_id ? series.get(r.series_id) : null;
      cands.push({
        title: r.title, startsAt, endsAt: new Date(Date.parse(startsAt) + (Date.parse(r.ends_at) - Date.parse(r.starts_at))).toISOString(),
        date, ...fieldsOf(r),
        ...(s && seriesOccursOn(s, date, r.series_key) ? { skipReason: 'already on that day from its repeat' } : {}),
      });
    }
  }
  const r = await place(owner, cands, b.policy, {
    dryRun: !!b.dryRun,
    batch: { accountId: accountId(req), action: 'copy', label: `Copied ${b.sourceDate} to ${dates.length} day(s)`, userId: userUuid(req) },
  });
  res.status(b.dryRun ? 200 : 201).json(shape(r, { tz, sourceCount: src.length }));
}

/**
 * REPEAT ONE PROGRAMME. From an existing programme (programmeId), or, for the
 * preview while adding one, from the fields in the body. The existing
 * programme becomes the first occurrence; the rest follow the rule.
 */
const repeatSchema = z.object({
  programmeId: z.string().uuid().optional(),
  channelId: z.string().uuid().optional(),
  eventId: z.string().uuid().optional(),
  title: z.string().optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  rule: ruleSchema,
  until: dateStr.nullable().optional(),
  policy: policySchema,
  tz: z.string().optional(),
  dryRun: z.boolean().optional(),
});
epgRouter.post(
  '/repeat',
  asyncHandler(async (req, res) => {
    const b = repeatSchema.parse(req.body);
    const err = validateRule(b.rule as RepeatRule);
    if (err) throw badRequest(err);
    let row: any;
    let owner: { kind: OwnerKind; id: string } | null;
    if (b.programmeId) {
      row = await ownedProgramme(b.programmeId, accountId(req));
      if (!row) throw notFound('Programme not found');
      owner = row.channel_id ? { kind: 'channel', id: row.channel_id } : { kind: 'event', id: row.event_id };
      if (row.series_id && row.series_key) throw badRequest('This programme already repeats. Edit it and choose "All repeats" to change the repeat.');
      if (row.source_ref && !row.source_ref.startsWith('series:')) throw badRequest('This programme comes from an imported guide feed, so it repeats when the feed says so. Copy it instead.');
    } else {
      owner = ownerOf(b);
      if (!owner) throw badRequest('programmeId, or channelId/eventId with the programme fields, required');
      if (!(await ownOwner(owner.kind, owner.id, accountId(req)))) throw notFound('Owner not found');
      if (!b.title || !b.startsAt || !b.endsAt) throw badRequest('title, startsAt and endsAt required');
      if (!b.dryRun) throw badRequest('Save the programme first, then repeat it by id');
      row = { title: b.title, starts_at: b.startsAt, ends_at: b.endsAt };
    }
    const tz = await resolveTz(owner.kind, owner.id, b.tz);
    const date = localDateOf(row.starts_at, tz);
    const until = b.until ?? null;
    if (until && until <= date) throw badRequest('The repeat must end after the first programme');
    const n: NewSeries = {
      owner, kind: 'programme', rule: b.rule as RepeatRule, tz, startDate: date, untilDate: until, policy: b.policy,
      sourceDate: date, items: [itemFromRow(row, 'p0', tz)],
    };
    const describe = describeRule(n.rule, until);
    const from = addDays(date, 1);
    if (b.dryRun) {
      const d = draftSeries(n);
      const r = await place(owner, seriesCandidates(d, from, horizonEnd(d, tz)), b.policy, { dryRun: true });
      res.json(shape(r, { tz, describe, openEnded: !until }));
      return;
    }
    const out = await tx(async (c) => {
      const s = await insertSeries(c, n);
      // The programme itself is the first occurrence.
      await c.query(`UPDATE programmes SET series_id=$2, series_key='p0', series_date=$3, source_ref=$4, series_detached=false WHERE id=$1`,
        [row.id, s.id, date, seriesRef(s.id, date, 'p0')]);
      const r = await materialize(c, s, from, horizonEnd(s, tz), {
        batch: { accountId: accountId(req), action: 'repeat', label: `"${row.title}": ${describe}`, userId: userUuid(req), seriesId: s.id },
      });
      return { ...r, seriesId: s.id };
    });
    res.status(201).json(shape(out, { tz, describe, seriesId: out.seriesId }));
  })
);

/** What a repeat is, for the drawer: "Every Tuesday until 15 Dec, 8 upcoming". */
epgRouter.get(
  '/series/:id',
  asyncHandler(async (req, res) => {
    const info = await seriesInfo(req.params.id);
    if (!info) throw notFound('Repeat not found');
    const owned = info.channelId ? await ownOwner('channel', info.channelId, accountId(req)) : await ownOwner('event', info.eventId!, accountId(req));
    if (!owned) throw notFound('Repeat not found');
    res.json(info);
  })
);

/** Stop a repeat from a date: occurrences from then on that have not started are removed. */
epgRouter.post(
  '/series/:id/end',
  asyncHandler(async (req, res) => {
    const b = z.object({ from: dateStr }).parse(req.body);
    const info = await seriesInfo(req.params.id);
    if (!info) throw notFound('Repeat not found');
    const owned = info.channelId ? await ownOwner('channel', info.channelId, accountId(req)) : await ownOwner('event', info.eventId!, accountId(req));
    if (!owned) throw notFound('Repeat not found');
    const out = await tx(async (c) => {
      const del = await c.query(`DELETE FROM programmes WHERE series_id=$1 AND series_date >= $2 AND starts_at > now() AND clip_asset_id IS NULL RETURNING id`, [req.params.id, b.from]);
      if (b.from <= info.startDate) await c.query('DELETE FROM programme_series WHERE id=$1', [req.params.id]);
      else await c.query(`UPDATE programme_series SET until_date=$2::date - 1, updated_at=now() WHERE id=$1`, [req.params.id, b.from]);
      return { deleted: del.rowCount ?? 0 };
    });
    res.json(out);
  })
);

/**
 * UNDO a copy, repeat or clear: delete what it created (not anything that has
 * since started or been cut to VOD), restore what it removed, take back the
 * exdates it wrote, and drop a repeat it made.
 */
epgRouter.post(
  '/batches/:id/undo',
  asyncHandler(async (req, res) => {
    const bt = await one<any>('SELECT * FROM epg_batches WHERE id=$1 AND account_id=$2', [req.params.id, accountId(req)]);
    if (!bt) throw notFound('Nothing to undo');
    if (bt.undone_at) { res.status(409).json({ error: 'Already undone' }); return; }
    const out = await tx(async (c) => {
      const del = await c.query(
        `DELETE FROM programmes WHERE id = ANY($1::uuid[]) AND starts_at > now() AND clip_asset_id IS NULL RETURNING id`, [bt.created_ids]);
      let restored = 0;
      const removed: any[] = bt.removed ?? [];
      if (removed.length) {
        const cols = (await c.query(
          `SELECT column_name FROM information_schema.columns WHERE table_name='programmes' AND is_generated='NEVER' AND table_schema = current_schema()`)).rows
          .map((r: any) => r.column_name as string);
        const list = cols.map((x) => `"${x}"`).join(', ');
        const r = await c.query(
          `INSERT INTO programmes(${list}) SELECT ${list} FROM jsonb_populate_recordset(NULL::programmes, $1::jsonb)
           ON CONFLICT DO NOTHING RETURNING id`, [JSON.stringify(removed)]);
        restored = r.rowCount ?? 0;
      }
      for (const e of (bt.exdates_added ?? []) as { seriesId: string; value: string }[]) {
        await c.query('UPDATE programme_series SET exdates = array_remove(exdates, $2) WHERE id=$1', [e.seriesId, e.value]);
      }
      if (bt.series_id) {
        await c.query(`UPDATE programmes SET source_ref=NULL, series_key=NULL, series_date=NULL, series_id=NULL
                        WHERE series_id=$1 AND NOT (id = ANY($2::uuid[]))`, [bt.series_id, bt.created_ids]);
        await c.query('DELETE FROM programme_series WHERE id=$1', [bt.series_id]);
      }
      await c.query('UPDATE epg_batches SET undone_at=now() WHERE id=$1', [bt.id]);
      return { removed: del.rowCount ?? 0, restored, keptStarted: (bt.created_ids?.length ?? 0) - (del.rowCount ?? 0) };
    });
    res.json(out);
  })
);
