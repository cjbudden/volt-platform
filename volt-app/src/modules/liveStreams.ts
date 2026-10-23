/**
 * THE STREAM AGGREGATE, read-only (services/streamModel.ts):
 *   GET /api/live-streams                             ONE list over channels, radio stations,
 *                                                     events and FAST channels (list standard)
 *   GET /api/live-streams/presets                     the presets (origin x lifecycle)
 *   GET /api/live-streams/:kind/:id                   production + distribution planes, preset, provider tiers
 *   GET /api/live-streams/:kind/:id/schema.org        VideoObject + BroadcastEvent (+ SportsEvent) JSON-LD
 *   GET /api/live-streams/:kind/:id/provider          the source-provider contract, per tier
 * kind is channel or event. Tenant-scoped: another account's id is a 404.
 */
import { Router } from 'express';
import { requireAuth, accountId } from '../auth/middleware';
import { can } from '../auth/roles';
import { query, one } from '../db';
import { asyncHandler, notFound, badRequest } from '../util/http';
import { defineList, parseList, whereSql, pageSql, finishPage, countWhereSql, countParams } from '../util/listQuery';
import { composeStream, presetOf, PRESETS } from '../services/streamModel';
import { liveRowsFor, type OwnerKind } from './monitoring';

export const liveStreamsRouter = Router();
liveStreamsRouter.use(requireAuth);

// ---------------------------------------------------------------------------
//  ONE LIST OVER EVERY STREAM (build queue 1.12).
//
//  Channels, radio stations, events and FAST channels live in two tables
//  (a station and a FAST channel are channel rows), and a client wanting
//  "everything I stream" used to fetch /api/channels, /api/events and
//  /api/fast/channels and merge them itself, each with its own paging. This
//  is the union, paged once with the list standard (util/listQuery.ts), so
//  q, filters, sort, cursors and count work across all of them.
//
//    kind    channel (live source + encoder), event, fast_channel (playlist)
//    medium  tv or radio (a station is a channel with medium radio)
//    preset  the streamModel preset key, the same one the aggregate carries
//
//  Each row names its aggregate (/api/live-streams/:kind/:id), its own
//  resource and its console page. health=true adds the live board's view of
//  each row on the page (modules/monitoring.ts liveRowsFor: five-gate health,
//  uptime, viewers), computed for that page only, which is what the Live
//  Streams page's List view reads.
// ---------------------------------------------------------------------------
const KINDS = ['channel', 'event', 'fast_channel'] as const;
const liveStreamList = defineList({
  path: '/api/live-streams',
  fields: {
    id: { sql: 's.id', type: 'uuid', notNull: true },
    kind: { sql: 's.kind', type: 'enum', values: KINDS, notNull: true, doc: 'channel (live source), event, or fast_channel (built from the library)' },
    medium: { sql: 's.medium', type: 'enum', values: ['tv', 'radio'], notNull: true, doc: 'tv or radio' },
    preset: { sql: 's.preset', type: 'enum', values: PRESETS.map((p) => p.key), notNull: true, doc: 'the stream preset (GET /api/live-streams/presets)' },
    name: { sql: 's.name', type: 'string' },
    status: { sql: 's.status', type: 'enum', values: ['scheduled', 'provisioning', 'testing', 'live', 'stopping', 'ended', 'error'] },
    on_air: { sql: 's.on_air', type: 'boolean', notNull: true, doc: 'published: a channel on air, an event live' },
    group_id: { sql: 's.group_id', type: 'uuid' },
    group_name: { sql: 's.group_name', type: 'string' },
    xmltv_id: { sql: 's.xmltv_id', type: 'string' },
    scheduled_start: { sql: 's.scheduled_start', type: 'timestamp', doc: 'events only' },
    scheduled_end: { sql: 's.scheduled_end', type: 'timestamp', doc: 'events only' },
    created_at: { sql: 's.created_at', type: 'timestamp', notNull: true },
    updated_at: { sql: 's.updated_at', type: 'timestamp' },
  },
  search: ['name', 'group_name', 'xmltv_id'],
  defaultSort: 'name',
  extraParams: ['health'],
});

// Both tables in one shape. A FAST channel is a channel row with origin
// playlist; on_air for an event is "live", as the aggregate reads it.
const UNION = `(
  SELECT c.id,
         CASE WHEN COALESCE(c.origin, 'live') = 'playlist' THEN 'fast_channel' ELSE 'channel' END AS kind,
         COALESCE(c.kind, 'tv') AS medium,
         CASE WHEN COALESCE(c.origin, 'live') = 'playlist' THEN 'fast_channel' ELSE 'live_channel' END AS preset,
         c.name, c.status, COALESCE(c.on_air, false) AS on_air, c.group_id, g.name AS group_name, c.xmltv_id,
         NULL::timestamptz AS scheduled_start, NULL::timestamptz AS scheduled_end, c.created_at, c.updated_at
    FROM channels c JOIN groups g ON g.id = c.group_id WHERE g.account_id = $1
  UNION ALL
  SELECT e.id, 'event', 'tv', 'live_event',
         e.name, e.status, (e.status = 'live'), e.group_id, g.name, e.xmltv_id,
         e.scheduled_start, e.scheduled_end, COALESCE(e.created_at, now()), e.updated_at
    FROM events e JOIN groups g ON g.id = e.group_id WHERE g.account_id = $1
) s`;

/**
 * Which rows this caller may see, by the feature that owns each kind: the
 * same split the live board applies (a Radio Manager sees stations only).
 * Fixed SQL, nothing from the request.
 */
function visibleSql(req: any): string {
  const parts: string[] = [];
  if (can(req, 'channels', 'view')) parts.push(`(s.kind = 'fast_channel' OR (s.kind = 'channel' AND s.medium = 'tv'))`);
  if (can(req, 'radio', 'view')) parts.push(`(s.kind = 'channel' AND s.medium = 'radio')`);
  if (can(req, 'events', 'view')) parts.push(`s.kind = 'event'`);
  return parts.length ? `(${parts.join(' OR ')})` : 'FALSE';
}

/** Where a row lives: its aggregate, its own API resource, its console page (pure). */
export function streamLinks(r: { id: string; kind: string; medium: string }) {
  const agg = r.kind === 'event' ? 'event' : 'channel';
  return {
    aggregate: `/api/live-streams/${agg}/${r.id}`,
    resource: r.kind === 'event' ? `/api/events/${r.id}`
      : r.kind === 'fast_channel' ? `/api/fast/channels/${r.id}`
      : r.medium === 'radio' ? `/api/radio/${r.id}`
      : `/api/channels/${r.id}`,
    console: r.kind === 'event' ? `/events/${r.id}`
      : r.kind === 'fast_channel' ? `/fast/${r.id}`
      : r.medium === 'radio' ? `/radio/${r.id}`
      : `/channels/${r.id}`,
  };
}

liveStreamsRouter.get('/', asyncHandler(async (req, res) => {
  const h = req.query.health;
  if (h != null && h !== 'true' && h !== 'false') throw badRequest('health must be true or false');
  const params: unknown[] = [accountId(req)];
  const pl = parseList(liveStreamList, req.query, params);
  const vis = visibleSql(req);
  const fetched = await query<any>(`SELECT s.* FROM ${UNION} WHERE ${vis}${whereSql(pl)} ${pageSql(pl)}`, params);
  const total = pl.count
    ? (await one<any>(`SELECT count(*)::int AS n FROM ${UNION} WHERE ${vis}${countWhereSql(pl)}`, countParams(pl, params)))?.n
    : undefined;
  const rows = finishPage(req, res, pl, fetched, total).map((r: any) => {
    const p = presetOf(r.kind === 'event' ? 'event' : 'channel', { origin: r.kind === 'fast_channel' ? 'playlist' : 'live' });
    return { ...r, preset_label: p.label, ...streamLinks(r) };
  });
  if (h !== 'true') { res.json(rows); return; }
  // The board's reading of each row, for this page only.
  const board = await liveRowsFor(rows.map((r: any) => ({
    // The board reads on_air from channels only (an event's "on air" is its
    // status, which the health already reads), so pass it the same way.
    id: r.id, name: r.name, status: r.status, on_air: r.kind === 'event' ? null : r.on_air, group_name: r.group_name,
    origin: r.kind === 'fast_channel' ? 'playlist' : 'live',
    kind: (r.kind === 'event' ? 'event' : r.medium === 'radio' ? 'radio' : 'tv') as OwnerKind,
  })));
  const byId = new Map(board.map((b) => [b.id, b]));
  res.json(rows.map((r: any) => {
    const b: any = byId.get(r.id);
    if (!b) return r;
    const { id: _i, kind: _k, name: _n, groupName: _g, status: _s, onAir: _o, href: _h, ...live } = b;
    return { ...r, live };
  }));
}));

liveStreamsRouter.get('/presets', (_req, res) => { res.json(PRESETS); });

const kindOf = (k: string) => {
  if (k !== 'channel' && k !== 'event') throw badRequest('kind must be channel or event');
  return k as 'channel' | 'event';
};
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function load(req: any) {
  const kind = kindOf(String(req.params.kind));
  if (!ID.test(String(req.params.id))) throw notFound('Stream not found');
  const s = await composeStream(kind, String(req.params.id), accountId(req));
  if (!s) throw notFound('Stream not found');
  return s;
}

liveStreamsRouter.get('/:kind/:id', asyncHandler(async (req, res) => { res.json(await load(req)); }));
liveStreamsRouter.get('/:kind/:id/schema.org', asyncHandler(async (req, res) => {
  res.type('application/ld+json').json((await load(req)).distribution.video_object);
}));
liveStreamsRouter.get('/:kind/:id/provider', asyncHandler(async (req, res) => { res.json((await load(req)).provider); }));
