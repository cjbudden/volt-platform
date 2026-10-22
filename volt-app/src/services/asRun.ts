// ============================================================================
//  PLAN VS AS-RUN for channel guides (epg_scheduling.md: "actual_span +
//  status, clipping/VOD prefer actual_span").
//
//  The guide is the PLAN. What aired is decided from what the encoder
//  reported: a run is the time between a channel.start and the channel.stop
//  that follows it (or now, if it is still running), and while the playout
//  splice had the loop or slate on air (playout.splice to loop ... to live)
//  the channel was on air but not on its source. For each programme:
//
//    actual_start  the first moment of the programme on air
//    actual_end    the last moment on air (set once it has ended)
//    status        live while airing, aired when it ended with any air time;
//                  a programme that ended with none keeps 'scheduled' and no
//                  actual times, and the report calls it missed
//
//  recordAsRun() writes that onto programmes for a channel (only what
//  changed, so the guide caches are not invalidated for nothing); asRunReport()
//  compares plan and as-run row by row with on-air, source and filler seconds.
//  Radio stations have their own as-run from the stream's titles
//  (services/radio/icyMeta.ts) and are left alone here.
// ============================================================================
import { query } from '../db';

export type Span = [number, number];   // epoch ms, [from, to)

export interface AsRun {
  actualStart: number | null;
  actualEnd: number | null;
  onAirMs: number;
  fillerMs: number;
  status: 'scheduled' | 'live' | 'aired';
}

const overlap = (a: Span, b: Span) => Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));

/** Pure: one programme against the runs and filler stretches. */
export function asRunFor(plan: Span, runs: Span[], fillers: Span[], nowMs: number): AsRun {
  const until = Math.min(plan[1], nowMs);
  const window: Span = [plan[0], until];
  let first: number | null = null, last: number | null = null, onAir = 0;
  for (const r of runs) {
    const o = overlap(window, r);
    if (!o) continue;
    onAir += o;
    const s = Math.max(window[0], r[0]), e = Math.min(window[1], r[1]);
    first = first == null ? s : Math.min(first, s);
    last = last == null ? e : Math.max(last, e);
  }
  let filler = 0;
  for (const f of fillers) for (const r of runs) {
    const s = Math.max(window[0], r[0], f[0]), e = Math.min(window[1], r[1], f[1]);
    if (e > s) filler += e - s;
  }
  const ended = nowMs >= plan[1];
  const status = !onAir ? 'scheduled' : ended ? 'aired' : 'live';
  return { actualStart: first, actualEnd: ended ? last : null, onAirMs: onAir, fillerMs: filler, status };
}

/** Pure: runs from channel.start / channel.stop events (any order). */
export function runsFrom(events: { type: string; ts: number }[], nowMs: number): Span[] {
  const evs = [...events].sort((a, b) => a.ts - b.ts);
  const runs: Span[] = [];
  let open: number | null = null;
  for (const e of evs) {
    if (e.type === 'channel.start') {
      if (open != null) runs.push([open, e.ts]);   // a start with no stop: the old run ended here
      open = e.ts;
    } else if (e.type === 'channel.stop' && open != null) {
      runs.push([open, e.ts]);
      open = null;
    }
  }
  if (open != null) runs.push([open, nowMs]);
  return runs;
}

/** Pure: loop or slate stretches from playout.splice events. */
export function fillersFrom(events: { type: string; ts: number; to?: string }[], nowMs: number): Span[] {
  const evs = [...events].sort((a, b) => a.ts - b.ts);
  const out: Span[] = [];
  let open: number | null = null;
  for (const e of evs) {
    if (e.type === 'channel.start' || e.type === 'channel.stop') {
      if (open != null) { out.push([open, e.ts]); open = null; }
      continue;
    }
    if (e.to === 'loop' || e.to === 'slate') { if (open == null) open = e.ts; }
    else if (e.to === 'live' && open != null) { out.push([open, e.ts]); open = null; }
  }
  if (open != null) out.push([open, nowMs]);
  return out;
}

async function evidence(channelId: string, fromMs: number, toMs: number, nowMs: number) {
  // From well before the window: a run that started yesterday is on air now.
  const rows = await query<any>(
    `SELECT type, ts, detail FROM stream_events
      WHERE channel_id = $1 AND type IN ('channel.start', 'channel.stop', 'playout.splice')
        AND ts >= to_timestamp($2 / 1000.0) - interval '3 days' AND ts < to_timestamp($3 / 1000.0)
      ORDER BY ts, id`, [channelId, fromMs, toMs]);
  const evs = rows.map((r: any) => {
    const d = typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail ?? {};
    const at = r.type === 'playout.splice' && Number.isFinite(Number(d.at_ms)) ? Number(d.at_ms) : new Date(r.ts).getTime();
    return { type: r.type, ts: at, to: d.to };
  });
  return { runs: runsFrom(evs, nowMs), fillers: fillersFrom(evs, nowMs) };
}

/**
 * Write as-run onto a channel's programmes between `fromMs` and now. Returns
 * how many rows changed.
 */
export async function recordAsRun(channelId: string, fromMs: number, nowMs = Date.now()): Promise<number> {
  const progs = await query<any>(
    `SELECT id, starts_at, ends_at, status, actual_start, actual_end FROM programmes
      WHERE channel_id = $1 AND status <> 'cancelled'
        AND ends_at > to_timestamp($2 / 1000.0) AND starts_at < to_timestamp($3 / 1000.0)
      ORDER BY starts_at`, [channelId, fromMs, nowMs]);
  if (!progs.length) return 0;
  const { runs, fillers } = await evidence(channelId, fromMs, nowMs, nowMs);
  let changed = 0;
  for (const p of progs) {
    const a = asRunFor([new Date(p.starts_at).getTime(), new Date(p.ends_at).getTime()], runs, fillers, nowMs);
    const same = p.status === a.status
      && (p.actual_start ? new Date(p.actual_start).getTime() : null) === a.actualStart
      && (p.actual_end ? new Date(p.actual_end).getTime() : null) === a.actualEnd;
    if (same) continue;
    await query(
      `UPDATE programmes SET status = $2::programme_status,
              actual_start = CASE WHEN $3::float8 IS NULL THEN NULL ELSE to_timestamp($3::float8 / 1000.0) END,
              actual_end   = CASE WHEN $4::float8 IS NULL THEN NULL ELSE to_timestamp($4::float8 / 1000.0) END
        WHERE id = $1`, [p.id, a.status, a.actualStart, a.actualEnd]);
    changed++;
  }
  return changed;
}

/** Every TV channel that ran in the last `lookbackMs` (radio has its own as-run). */
export async function asRunPass(lookbackMs = 6 * 3600_000, nowMs = Date.now()): Promise<{ channels: number; changed: number }> {
  const chans = await query<any>(
    `SELECT DISTINCT c.id FROM channels c
      WHERE c.kind <> 'radio'   -- radio is channels.kind, there is no audio_only column
        AND (c.status = 'live' OR EXISTS (SELECT 1 FROM stream_events e WHERE e.channel_id = c.id AND e.type = 'channel.stop' AND e.ts > to_timestamp($1 / 1000.0)))`,
    [nowMs - lookbackMs]);
  let changed = 0;
  for (const c of chans) changed += await recordAsRun(c.id, nowMs - lookbackMs, nowMs);
  return { channels: chans.length, changed };
}

export interface AsRunRow {
  id: string; title: string;
  planned_start: string; planned_end: string;
  actual_start: string | null; actual_end: string | null;
  start_delta_sec: number | null; end_delta_sec: number | null;
  on_air_sec: number; source_sec: number; filler_sec: number;
  outcome: 'aired' | 'partial' | 'missed' | 'airing' | 'upcoming' | 'cancelled';
}

/** Plan against as-run for a window, computed now (not only what was stored). */
export async function asRunReport(channelId: string, fromMs: number, toMs: number, nowMs = Date.now()) {
  const progs = await query<any>(
    `SELECT id, title, starts_at, ends_at, status FROM programmes
      WHERE channel_id = $1 AND ends_at > to_timestamp($2 / 1000.0) AND starts_at < to_timestamp($3 / 1000.0)
      ORDER BY starts_at LIMIT 2000`, [channelId, fromMs, toMs]);
  const { runs, fillers } = await evidence(channelId, fromMs, Math.max(toMs, nowMs), nowMs);
  const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
  const rows: AsRunRow[] = progs.map((p: any) => {
    const plan: Span = [new Date(p.starts_at).getTime(), new Date(p.ends_at).getTime()];
    const a = asRunFor(plan, runs, fillers, nowMs);
    const dur = plan[1] - plan[0];
    let outcome: AsRunRow['outcome'];
    if (p.status === 'cancelled') outcome = 'cancelled';
    else if (nowMs < plan[0]) outcome = 'upcoming';
    else if (nowMs < plan[1]) outcome = 'airing';
    else if (!a.onAirMs) outcome = 'missed';
    else outcome = a.onAirMs - a.fillerMs >= dur - 1000 ? 'aired' : 'partial';
    return {
      id: p.id, title: p.title, planned_start: iso(plan[0])!, planned_end: iso(plan[1])!,
      actual_start: iso(a.actualStart), actual_end: iso(a.actualEnd),
      start_delta_sec: a.actualStart == null ? null : Math.round((a.actualStart - plan[0]) / 1000),
      end_delta_sec: a.actualEnd == null ? null : Math.round((a.actualEnd - plan[1]) / 1000),
      on_air_sec: Math.round(a.onAirMs / 1000), source_sec: Math.round((a.onAirMs - a.fillerMs) / 1000), filler_sec: Math.round(a.fillerMs / 1000),
      outcome,
    };
  });
  const total = (k: 'on_air_sec' | 'source_sec' | 'filler_sec') => rows.reduce((n, r) => n + r[k], 0);
  const count = (o: AsRunRow['outcome']) => rows.filter((r) => r.outcome === o).length;
  return {
    channel_id: channelId, from: iso(fromMs), to: iso(toMs), generated_at: iso(nowMs),
    totals: { programmes: rows.length, aired: count('aired'), partial: count('partial'), missed: count('missed'), cancelled: count('cancelled'),
      on_air_sec: total('on_air_sec'), source_sec: total('source_sec'), filler_sec: total('filler_sec') },
    rows,
  };
}
