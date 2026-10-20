// ============================================================================
//  TIMELINE GRID  (mounted at /api/timeline)
//
//  The Live Streams page's Timeline view: every stream the caller may see as one
//  row on a shared clock, with what went to air on the left of now, what is on
//  now across it, and what is scheduled on the right. TIMELINE_MODE.md is the
//  spec. Phase 1 (read-only rows), phase 2 (outage markers from the status
//  event log; GET /selection checks a dragged range before it becomes a clip)
//  and phase 3 (programme clashes on each row).
//
//  ONE CALL FOR THE WHOLE GRID. The data already exists per owner (/api/epg,
//  /api/channels/:id/coverage, /api/monitoring/live), and a grid of twenty
//  streams must not open sixty requests. So this composes those same services
//  on the server, in one pass:
//
//    status      loadChannelHealthLite, the function the Live board and the
//                detail pages roll the five gates up with. Never recomputed.
//    programmes  the programme rows /api/epg reads, as-run times preferred
//                over scheduled (as the channel timeline's lane 3 does), in ONE
//                `channel_id = ANY(...)` query for the page instead of one per
//                row. VOD state comes from the same shaping epgVod.ts uses.
//    media       resolveRange, the resolver /coverage uses: spans measured
//                from disk, never the recording rows' declared windows. Only
//                for the past part of the window; the future never touches disk.
//
//  Bounded twice: the window is capped at 48 hours and rows page at 50 with
//  the list standard's cursor, so neither a wide zoom nor a large fleet turns
//  into an unbounded scan. No thumbnails or waveforms here: those stay on the
//  per-stream endpoints, fetched only when someone looks.
// ============================================================================
import { Router, type Request } from 'express';
import { query } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { can } from '../auth/roles';
import { asyncHandler, badRequest } from '../util/http';
import { defineList, parseList, whereSql, pageSql, finishPage } from '../util/listQuery';
import { loadChannelHealthLite } from '../services/channelDetail';
import { resolveRange, assessRange, type Resolution } from '../services/clips/resolve';
import { isAudioOnly } from '../services/localRecordingIndex';
import { programmeVodShape } from '../services/epgVod';

export const timelineGridRouter = Router();
timelineGridRouter.use(requireAuth);

/** The widest window the grid answers for. */
export const GRID_MAX_WINDOW_MS = 48 * 3_600_000;
/** Rows per page: the list standard's default, and the most a page may ask for. */
const GRID_PAGE = 50;

export type GridKind = 'channel' | 'radio' | 'event' | 'loop';
const ALL_KINDS: GridKind[] = ['channel', 'radio', 'event', 'loop'];
/** The feature a role needs `view` on to see a row of this kind (as /api/monitoring/live). */
const FEATURE: Record<GridKind, string> = { channel: 'channels', radio: 'radio', event: 'events', loop: 'media' };

/** The same labels the console's PIPELINE_STATE map shows, so API readers get words too. */
const STATE_LABEL: Record<string, string> = {
  onair: 'On air', ready: 'Ready · private', starting: 'Starting', degraded: 'Degraded',
  error: 'Error', stopped: 'Stopped', idle: 'Idle',
};

const gridList = defineList({
  path: '/api/timeline/grid',
  fields: {
    id: { sql: 'o.id', type: 'uuid' },
    kind: { sql: 'o.kind', type: 'enum', values: ALL_KINDS, filter: false, doc: 'Use kinds= instead' },
    name: { sql: 'o.name', type: 'string', notNull: true },
    group_id: { sql: 'o.group_id', type: 'uuid', doc: 'Channel group (alias groupId)' },
    group_name: { sql: 'o.group_name', type: 'string', notNull: true },
  },
  search: ['name', 'group_name'],
  defaultSort: 'group_name,name',
  defaultLimit: GRID_PAGE,
  maxLimit: GRID_PAGE,
  aliases: { groupId: 'group_id' },
  // The window and the kinds are context, not filters.
  extraParams: ['from', 'to', 'kinds'],
});

// ---------------------------------------------------------------- the window
function parseInstant(raw: unknown, name: string): number | null {
  if (raw == null || raw === '') return null;
  const s = String(raw);
  // ISO 8601 is the documented form; epoch ms is accepted because every other
  // timeline endpoint takes it, and a client moving between them should not trip.
  const ms = /^\d{10,}$/.test(s) ? Number(s) : Date.parse(s);
  if (!Number.isFinite(ms)) throw badRequest(`${name} must be a date and time (ISO 8601, e.g. 2026-10-20T09:00:00Z)`);
  return ms;
}

/** The grid window: default two hours back and four ahead, never wider than 48 hours. */
export function parseWindow(q: Record<string, unknown>, nowMs: number): { from: number; to: number } {
  const from = parseInstant(q.from, 'from') ?? nowMs - 2 * 3_600_000;
  const to = parseInstant(q.to, 'to') ?? from + 6 * 3_600_000;
  if (to <= from) throw badRequest('`to` must be after `from`');
  if (to - from > GRID_MAX_WINDOW_MS) {
    const h = Math.round(((to - from) / 3_600_000) * 10) / 10;
    throw badRequest(`Window too wide: ${h} hours. The timeline grid answers up to ${GRID_MAX_WINDOW_MS / 3_600_000} hours at a time.`);
  }
  return { from, to };
}

/** kinds= narrowed to what the caller may view. Unknown names are a 400, not silently dropped. */
export function allowedKinds(raw: unknown, mayView: (k: GridKind) => boolean): GridKind[] {
  const asked = raw == null || raw === ''
    ? ALL_KINDS
    : String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  for (const k of asked) {
    if (!(ALL_KINDS as string[]).includes(k)) throw badRequest(`Unknown kind "${k}". Use: ${ALL_KINDS.join(', ')}`);
  }
  return (asked as GridKind[]).filter(mayView);
}

// ---------------------------------------------------------------- shaping
const iso = (ms: number) => new Date(ms).toISOString();

/** Run spans and gaps from a coverage resolution, as the grid draws them. */
export function mediaFrom(r: Resolution | null) {
  if (!r) return { runs: [], gaps: [], coveragePct: null as number | null };
  return {
    runs: r.blocks.map((b) => ({ start: iso(b.startMs), end: iso(b.endMs) })),
    gaps: r.gaps.map((g) => ({ start: iso(g.fromMs), end: iso(g.toMs), reason: g.reason })),
    coveragePct: r.coveragePct,
  };
}

/** One programme block: as-run times when known, scheduled times otherwise. */
export function programmeBlock(p: any, vodState: string | null) {
  return {
    id: p.id,
    title: p.title,
    start: iso(new Date(p.actual_start ?? p.starts_at).getTime()),
    end: iso(new Date(p.actual_end ?? p.ends_at).getTime()),
    scheduledStart: iso(new Date(p.starts_at).getTime()),
    scheduledEnd: iso(new Date(p.ends_at).getTime()),
    asRun: p.actual_start != null,
    status: p.status ?? null,
    vodState,
    source: 'epg' as const,
  };
}

/** An event is one programme-like block from its window; actual times win when known. */
export function eventBlock(e: any, nowMs: number) {
  const start = new Date(e.actual_start ?? e.scheduled_start).getTime();
  let end = new Date(e.actual_end ?? e.scheduled_end).getTime();
  // Started and still going past its planned end: the block reaches now.
  if (e.actual_start && !e.actual_end && e.status === 'live') end = Math.max(end, nowMs);
  return {
    id: e.id,
    title: e.name,
    start: iso(start),
    end: iso(end),
    scheduledStart: iso(new Date(e.scheduled_start).getTime()),
    scheduledEnd: iso(new Date(e.scheduled_end).getTime()),
    asRun: e.actual_start != null,
    status: e.status ?? null,
    vodState: null,
    source: 'event' as const,
  };
}

// ---------------------------------------------------------------- outages
export type OutageKind = 'source' | 'filler' | 'packager' | 'stopped';
export interface Outage { kind: OutageKind; start: string; end: string | null; label: string; reason: string | null }

/** A channel.stop that was not asked for: the encoder died, the source vanished for good. */
const UNEXPECTED_STOP = /exit|error|fail|rc=|crash|killed|unreachable|refused/i;
const PLANNED_STOP = /server_window_closed|stopped by|operator|requested|desired|source ended \(rc=0\)|schedule/i;

const reasonOf = (d: any): string | null => {
  if (!d || typeof d !== 'object') return null;
  const v = d.reason ?? d.detail ?? d.message ?? d.error ?? null;
  return v == null ? null : String(v).slice(0, 240);
};

/**
 * OUTAGES FROM THE STATUS EVENT LOG (stream_events, what the encoders report):
 *
 *   source     source.down  ->  source.up of the same source  (no input)
 *   filler     filler.engaged -> filler.cleared               (viewers saw the slate or loop)
 *   packager   packager.down -> packager.up                   (no output being made)
 *   stopped    channel.stop with a failure reason -> the next channel.start
 *
 * A channel.stop closes whatever was open: a stream that has ended is not "still
 * without a source". Something still open at the end runs to now (end null).
 * `events` must be in time order and should start a little before the window,
 * so an outage that began earlier is still drawn from the window's edge.
 */
export function outagesFrom(events: Array<{ type: string; detail: any; ts: number }>, from: number, to: number): Outage[] {
  const out: Array<{ kind: OutageKind; s: number; e: number | null; label: string; reason: string | null }> = [];
  const src = new Map<string, { s: number; reason: string | null }>();
  let filler: { s: number; reason: string | null } | null = null;
  let pack: { s: number; reason: string | null } | null = null;
  let stopped: { s: number; reason: string | null } | null = null;
  const srcLabel = (g: string) => (g === 'primary' || !g ? 'No source' : `No ${g} source`);
  for (const ev of events) {
    const d = ev.detail ?? {};
    switch (ev.type) {
      case 'source.down': {
        const g = String(d.source ?? 'primary');
        if (!src.has(g)) src.set(g, { s: ev.ts, reason: reasonOf(d) });
        break;
      }
      case 'source.up': {
        const g = String(d.source ?? 'primary');
        const o = src.get(g);
        if (o) { out.push({ kind: 'source', s: o.s, e: ev.ts, label: srcLabel(g), reason: o.reason }); src.delete(g); }
        break;
      }
      case 'filler.engaged': if (!filler) filler = { s: ev.ts, reason: reasonOf(d) }; break;
      case 'filler.cleared': if (filler) { out.push({ kind: 'filler', s: filler.s, e: ev.ts, label: 'On filler', reason: filler.reason }); filler = null; } break;
      case 'packager.down': if (!pack) pack = { s: ev.ts, reason: reasonOf(d) }; break;
      case 'packager.up': if (pack) { out.push({ kind: 'packager', s: pack.s, e: ev.ts, label: 'Packager down', reason: pack.reason }); pack = null; } break;
      case 'channel.stop': {
        for (const [g, o] of src) out.push({ kind: 'source', s: o.s, e: ev.ts, label: srcLabel(g), reason: o.reason });
        src.clear();
        if (filler) { out.push({ kind: 'filler', s: filler.s, e: ev.ts, label: 'On filler', reason: filler.reason }); filler = null; }
        if (pack) { out.push({ kind: 'packager', s: pack.s, e: ev.ts, label: 'Packager down', reason: pack.reason }); pack = null; }
        const why = reasonOf(d) ?? '';
        if (!stopped && UNEXPECTED_STOP.test(why) && !PLANNED_STOP.test(why)) stopped = { s: ev.ts, reason: why };
        break;
      }
      case 'channel.start':
        if (stopped) { out.push({ kind: 'stopped', s: stopped.s, e: ev.ts, label: 'Stopped unexpectedly', reason: stopped.reason }); stopped = null; }
        break;
      default: break;
    }
  }
  for (const [g, o] of src) out.push({ kind: 'source', s: o.s, e: null, label: srcLabel(g), reason: o.reason });
  if (filler) out.push({ kind: 'filler', s: filler.s, e: null, label: 'On filler', reason: filler.reason });
  if (pack) out.push({ kind: 'packager', s: pack.s, e: null, label: 'Packager down', reason: pack.reason });
  if (stopped) out.push({ kind: 'stopped', s: stopped.s, e: null, label: 'Stopped unexpectedly', reason: stopped.reason });
  return out
    .filter((o) => o.s < to && (o.e == null || o.e > from))
    .sort((a, b) => a.s - b.s)
    .map((o) => ({ kind: o.kind, start: iso(o.s), end: o.e == null ? null : iso(o.e), label: o.label, reason: o.reason }));
}

/** How far back the log is read so an outage that began before the window still shows. */
const OUTAGE_LOOKBACK_MS = 24 * 3_600_000;

// ---------------------------------------------------------------- clashes
export interface Clash { start: string; end: string; a: { id: string; title: string }; b: { id: string; title: string } }

function retentionMsOf(o: any): number | null {
  if (o.recording_retention_sec != null) return Number(o.recording_retention_sec) * 1000;
  if (o.recording_retention_days != null) return Number(o.recording_retention_days) * 86_400_000;
  return null;
}

function linksFor(o: any, from: number, to: number) {
  const w = `from=${encodeURIComponent(iso(from))}&to=${encodeURIComponent(iso(to))}`;
  const wMs = `from=${from}&to=${to}`;
  if (o.kind === 'event') {
    return {
      self: `/api/events/${o.id}`,
      detail: '/events',
      workbench: `/recordings/source/${o.id}`,
      epg: `/epg/event/${o.id}`,
      programmes: `/api/epg?eventId=${o.id}&${w}`,
    };
  }
  const radio = o.kind === 'radio';
  return {
    self: radio ? `/api/radio/${o.id}` : `/api/channels/${o.id}`,
    detail: radio ? `/radio/${o.id}` : `/channels/${o.id}`,
    workbench: `/recordings/source/${o.id}`,
    epg: `/epg/${radio ? 'radio' : 'channel'}/${o.id}`,
    programmes: `/api/epg?channelId=${o.id}&${w}`,
    coverage: `/api/channels/${o.id}/coverage?${wMs}`,
    timeline: `/api/channels/${o.id}/timeline?${wMs}`,
  };
}

/** Group rows by an owner column without a second pass per row. */
function byOwner<T>(rows: T[], key: (r: T) => string | null | undefined): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    (m.get(k) ?? m.set(k, []).get(k)!).push(r);
  }
  return m;
}

// ---------------------------------------------------------------- the route
timelineGridRouter.get('/grid', asyncHandler(async (req: Request, res) => {
  const nowMs = Date.now();
  const { from, to } = parseWindow(req.query as any, nowMs);
  // Rows a role cannot view are ABSENT, not empty: the same per-kind rule the
  // Live board applies, but in the SQL, so paging counts only visible rows.
  const kinds = allowedKinds(req.query.kinds, (k) => can(req, FEATURE[k], 'view'));
  const acct = accountId(req);

  // Every stream-like owner of the account, as one relation the list standard
  // can sort, search, filter and page. Loops are a kind in the vocabulary but
  // not yet a stream entity (slates and loops are filler assets), so phase 1
  // yields no loop rows; FAST rows are omitted until FAST playout exists.
  const params: unknown[] = [acct, iso(from), iso(to), kinds];
  const pl = parseList(gridList, req.query, params);
  const rows = kinds.length === 0 ? [] : await query<any>(
    `SELECT o.* FROM (
       SELECT CASE WHEN c.kind = 'radio' THEN 'radio' ELSE 'channel' END AS kind,
              c.id, c.name, c.status::text AS status, c.on_air, c.group_id, g.name AS group_name,
              c.recording_retention_days, c.recording_retention_sec,
              NULL::timestamptz AS scheduled_start, NULL::timestamptz AS scheduled_end,
              NULL::timestamptz AS actual_start, NULL::timestamptz AS actual_end
         FROM channels c JOIN groups g ON g.id = c.group_id
        WHERE g.account_id = $1
       UNION ALL
       SELECT 'event', e.id, e.name, e.status::text, false, e.group_id, g.name,
              e.recording_retention_days, e.recording_retention_sec,
              e.scheduled_start, e.scheduled_end, e.actual_start, e.actual_end
         FROM events e JOIN groups g ON g.id = e.group_id
        WHERE g.account_id = $1
          -- An event is a row only when its window touches the grid window, or
          -- it is running now: a fleet's finished and far-future events would
          -- otherwise fill the grid with empty rows.
          AND (e.status = 'live'
               OR tstzrange(COALESCE(e.actual_start, e.scheduled_start),
                            GREATEST(COALESCE(e.actual_end, e.scheduled_end), COALESCE(e.actual_start, e.scheduled_start)),
                            '[]') && tstzrange($2::timestamptz, $3::timestamptz, '[)'))
     ) o
     WHERE o.kind = ANY($4::text[])${whereSql(pl)}
     ${pageSql(pl)}`,
    params
  );
  const page = finishPage(req, res, pl, rows);
  const next = (res.getHeader('X-Next-Cursor') as string | undefined) ?? null;

  const channelIds = page.filter((o) => o.kind !== 'event').map((o) => o.id);
  const eventIds = page.filter((o) => o.kind === 'event').map((o) => o.id);
  const allIds = page.map((o) => o.id);
  const pastTo = Math.min(to, nowMs);
  const hasPast = from < nowMs;

  // ---- programmes: ONE query for every channel and station on the page.
  // The /api/epg row, plus the asset columns epgVod.ts shapes VOD state from.
  const progs = channelIds.length === 0 ? [] : await query<any>(
    `SELECT p.*, v.title AS asset_title, v.thumb_status::text AS asset_state
       FROM programmes p
       LEFT JOIN vod_assets v ON v.id = p.clip_asset_id
      WHERE p.channel_id = ANY($1::uuid[])
        AND p.span && tstzrange($2::timestamptz, $3::timestamptz, '[)')
      ORDER BY p.starts_at
      LIMIT 5000`,
    [channelIds, iso(from), iso(to)]
  );
  const progsBy = byOwner(progs, (p) => p.channel_id);

  // ---- clip ticks: cheap (one indexed query, no media work), so included.
  const clips = allIds.length === 0 ? [] : await query<any>(
    `SELECT id, channel_id, event_id, title, start_epoch_ms, end_epoch_ms
       FROM vod_assets
      WHERE kind = 'clip'
        AND (channel_id = ANY($1::uuid[]) OR event_id = ANY($1::uuid[]))
        AND start_epoch_ms < $3 AND end_epoch_ms > $2
      ORDER BY start_epoch_ms
      LIMIT 2000`,
    [allIds, from, to]
  );
  const clipsBy = byOwner(clips, (c) => c.channel_id ?? c.event_id);

  // ---- recordings: which capture holds a past instant, so a click on the past
  // opens the workbench at that moment. Declared windows are fine HERE: this
  // only picks which capture to open, the media lane itself is measured.
  const recs = !hasPast || allIds.length === 0 ? [] : await query<any>(
    `SELECT id, channel_id, event_id, start_epoch_ms, end_epoch_ms
       FROM recordings
      WHERE (channel_id = ANY($1::uuid[]) OR event_id = ANY($1::uuid[]))
        AND start_epoch_ms < $3 AND COALESCE(end_epoch_ms, $4) > $2
      ORDER BY start_epoch_ms
      LIMIT 2000`,
    [allIds, from, pastTo, nowMs]
  );
  const recsBy = byOwner(recs, (r) => r.channel_id ?? r.event_id);

  // ---- outages (phase 2): the status event log for the whole page in ONE
  // query, read from a day before the window so a long outage still shows.
  // Past only: the future has no events.
  const evs = !hasPast || allIds.length === 0 ? [] : await query<any>(
    `SELECT channel_id, event_id, type, detail, ts
       FROM stream_events
      WHERE (channel_id = ANY($1::uuid[]) OR event_id = ANY($1::uuid[]))
        AND type IN ('source.down','source.up','filler.engaged','filler.cleared','packager.down','packager.up','channel.stop','channel.start')
        AND ts >= $2::timestamptz AND ts < $3::timestamptz
      ORDER BY ts
      LIMIT 20000`,
    [allIds, iso(from - OUTAGE_LOOKBACK_MS), iso(pastTo)]
  );
  const evsBy = byOwner(evs, (e) => e.channel_id ?? e.event_id);

  // ---- clashes (phase 3): overlapping programmes on one owner, the overlap
  // /api/epg/conflicts reports, for every channel on the page in ONE query.
  const clashRows = channelIds.length === 0 ? [] : await query<any>(
    `SELECT a.channel_id, a.id AS a_id, a.title AS a_title, b.id AS b_id, b.title AS b_title,
            GREATEST(a.starts_at, b.starts_at) AS overlap_start, LEAST(a.ends_at, b.ends_at) AS overlap_end
       FROM programmes a JOIN programmes b
         ON a.channel_id = b.channel_id AND a.id < b.id AND a.span && b.span
      WHERE a.channel_id = ANY($1::uuid[])
        AND a.span && tstzrange($2::timestamptz, $3::timestamptz, '[)')
        AND b.span && tstzrange($2::timestamptz, $3::timestamptz, '[)')
      ORDER BY overlap_start
      LIMIT 2000`,
    [channelIds, iso(from), iso(to)]
  );
  const clashesBy = byOwner(clashRows, (c) => c.channel_id);

  const out = await Promise.all(page.map(async (o) => {
    const ownerKind = o.kind === 'event' ? 'event' : 'channel';
    const health = await loadChannelHealthLite(
      { id: o.id, status: o.status, on_air: o.on_air === true }, nowMs, ownerKind
    );

    // Media for the PAST part of the window only, measured from disk.
    let resolution: Resolution | null = null;
    if (hasPast) {
      try {
        const mediaKind = o.kind === 'radio' || isAudioOnly(o.id) ? 'audio' : 'video';
        resolution = resolveRange(o.id, from, pastTo, mediaKind);
      } catch (e) {
        // Unknown is not "nothing recorded": left null, the row draws no lane.
        console.warn('[timeline-grid] coverage failed for', o.id, e);
      }
    }

    const retention = retentionMsOf(o);
    const programmes = o.kind === 'event'
      ? [eventBlock(o, nowMs)]
      : (progsBy.get(o.id) ?? []).map((p) => programmeBlock(p, programmeVodShape(p, resolution, retention, nowMs).state));

    return {
      kind: o.kind as GridKind,
      id: o.id,
      name: o.name,
      groupId: o.group_id,
      groupName: o.group_name,
      status: { state: health.overall, label: STATE_LABEL[health.overall] ?? health.overall },
      onAir: o.on_air === true,
      programmes,
      media: mediaFrom(resolution),
      clips: (clipsBy.get(o.id) ?? []).map((c) => ({
        id: c.id, title: c.title ?? null, start: iso(Number(c.start_epoch_ms)), end: iso(Number(c.end_epoch_ms)),
      })),
      recordings: (recsBy.get(o.id) ?? []).map((r) => ({
        id: r.id, start: iso(Number(r.start_epoch_ms)), end: r.end_epoch_ms == null ? null : iso(Number(r.end_epoch_ms)),
      })),
      outages: outagesFrom((evsBy.get(o.id) ?? []).map((e) => ({ type: e.type, detail: e.detail, ts: new Date(e.ts).getTime() })), from, pastTo + 1),
      clashes: (clashesBy.get(o.id) ?? []).map((c): Clash => ({
        start: iso(new Date(c.overlap_start).getTime()), end: iso(new Date(c.overlap_end).getTime()),
        a: { id: c.a_id, title: c.a_title }, b: { id: c.b_id, title: c.b_title },
      })),
      links: linksFor(o, from, to),
    };
  }));

  const selfUrl = new URL(req.originalUrl, 'http://x');
  const nextUrl = next ? (() => { const u = new URL(req.originalUrl, 'http://x'); u.searchParams.set('cursor', next); return u.pathname + u.search; })() : null;
  res.json({
    window: { from: iso(from), to: iso(to), now: iso(nowMs) },
    kinds,
    rows: out,
    next,
    links: {
      self: selfUrl.pathname + selfUrl.search,
      next: nextUrl,
      live: '/api/monitoring/live',
      status: '/api/status/stream',
    },
  });
}));

// ---------------------------------------------------------------- selection
/**
 * A RANGE DRAGGED ON A ROW, checked before it becomes a clip (phase 2).
 *
 * The same question the workbench asks (resolveRange + assessRange: media
 * measured from disk, gaps named), plus what the grid needs to offer the clip
 * flow: the one recording that holds the whole range (the clip API cuts from a
 * recording), and a title from the programme that fills most of it.
 */
const SELECTION_MAX_MS = 6 * 3_600_000;
timelineGridRouter.get('/selection', asyncHandler(async (req: Request, res) => {
  const kind = String(req.query.kind ?? '');
  const id = String(req.query.id ?? '');
  if (!(ALL_KINDS as string[]).includes(kind) || kind === 'loop') throw badRequest('kind must be channel, radio or event');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw badRequest('id must be a uuid');
  // A stream the role cannot view is absent here, as it is from the grid.
  if (!can(req, FEATURE[kind as GridKind], 'view')) return res.status(404).json({ error: 'Not found' });
  const nowMs = Date.now();
  const from = parseInstant(req.query.from, 'from'), toRaw = parseInstant(req.query.to, 'to');
  if (from == null || toRaw == null) throw badRequest('from and to are required');
  const to = Math.min(toRaw, nowMs);
  if (to <= from) throw badRequest('The range must end after it starts, and before now: only what has aired can be clipped.');
  if (to - from > SELECTION_MAX_MS) throw badRequest(`A selection is at most ${SELECTION_MAX_MS / 3_600_000} hours.`);

  const owner = (await query<any>(
    kind === 'event'
      ? `SELECT e.id, e.name FROM events e JOIN groups g ON g.id = e.group_id WHERE e.id = $1 AND g.account_id = $2`
      : `SELECT c.id, c.name FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id = $1 AND g.account_id = $2`,
    [id, accountId(req)]))[0];
  if (!owner) return res.status(404).json({ error: 'Not found' });

  const mediaKind = kind === 'radio' || isAudioOnly(id) ? 'audio' : 'video';
  const resolution = resolveRange(id, from, to, mediaKind);
  const verdict = assessRange(resolution);
  const col = kind === 'event' ? 'event_id' : 'channel_id';
  const recs = await query<any>(
    `SELECT id, start_epoch_ms, end_epoch_ms FROM recordings
      WHERE ${col} = $1 AND start_epoch_ms < $3 AND COALESCE(end_epoch_ms, $4) > $2
      ORDER BY start_epoch_ms LIMIT 50`, [id, from, to, nowMs]);
  const holder = recs.find((r) => Number(r.start_epoch_ms) <= from && (r.end_epoch_ms == null ? nowMs : Number(r.end_epoch_ms)) >= to) ?? null;
  const progs = await query<any>(
    `SELECT id, title, COALESCE(actual_start, starts_at) AS s, COALESCE(actual_end, ends_at) AS e
       FROM programmes WHERE ${col} = $1 AND span && tstzrange($2::timestamptz, $3::timestamptz, '[)')
      ORDER BY starts_at LIMIT 200`, [id, iso(from), iso(to)]);
  let best: any = null, bestMs = 0;
  for (const p of progs) {
    const ov = Math.min(to, new Date(p.e).getTime()) - Math.max(from, new Date(p.s).getTime());
    if (ov > bestMs) { bestMs = ov; best = p; }
  }
  const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
  res.json({
    kind, id, name: owner.name,
    range: { from: iso(from), to: iso(to), ms: to - from, clampedToNow: toRaw > nowMs },
    coveragePct: resolution.coveragePct,
    coveredMs: resolution.coveredMs,
    gaps: resolution.gaps.map((g) => ({ start: iso(g.fromMs), end: iso(g.toMs), ms: g.ms, reason: g.reason })),
    clippable: verdict.ok,
    reason: verdict.ok ? null : { code: verdict.code, message: verdict.message },
    recording: holder ? { id: holder.id, start: iso(Number(holder.start_epoch_ms)), end: holder.end_epoch_ms == null ? null : iso(Number(holder.end_epoch_ms)) } : null,
    recordingCount: recs.length,
    suggestedTitle: best ? best.title : `${owner.name} ${hhmm(from)}`,
    programmes: progs.map((p) => ({ id: p.id, title: p.title, start: iso(new Date(p.s).getTime()), end: iso(new Date(p.e).getTime()) })),
    links: {
      clip: holder ? `/api/recordings/${holder.id}/clip` : null,
      workbench: holder ? `/recordings/${holder.id}?from=${from}&to=${to}` : `/recordings/source/${id}`,
    },
  });
}));

export const __testing = { parseWindow, allowedKinds, mediaFrom, programmeBlock, eventBlock, outagesFrom, GRID_MAX_WINDOW_MS };
