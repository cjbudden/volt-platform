// ============================================================================
//  TIMELINE GRID  (mounted at /api/timeline)
//
//  The Live Streams page's Timeline view: every stream the caller may see as one
//  row on a shared clock, with what went to air on the left of now, what is on
//  now across it, and what is scheduled on the right. TIMELINE_MODE.md is the
//  spec; this is phase 1 (read-only).
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
import { resolveRange, type Resolution } from '../services/clips/resolve';
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

export const __testing = { parseWindow, allowedKinds, mediaFrom, programmeBlock, eventBlock, GRID_MAX_WINDOW_MS };
