// ============================================================================
//  THE PLAYBACK EXPERIENCE REPORTS 1, 2, 3, 4, 10 AND 12 (QOE_REPORTING.md 5).
//
//  Read from the analytics database only (analyticsDb.ts), never the control
//  plane's: view rows for every figure, so any filter in section 6 applies to
//  any report, and minute aggregates for the trend lines.
//
//  Windows: experience reports (1 to 4, 12) count a view by when it ENDED,
//  engagement (10) by when it STARTED, as section 4 says. Percentiles are
//  nearest rank (percentile_disc) over the views, with the number of views
//  behind them and the distinct sessions affected. Viewers are sessions:
//  counting signed-in people is decision 3 in QOE_REPORTING.md section 11.
// ============================================================================
import { aquery } from './analyticsDb';
import * as sk from './sketch';
import { DEFINITIONS_VERSION } from './views';

/** The filters every report takes (section 6), each a column of qoe_views. */
export const FILTERS = ['content_id', 'stream_type', 'device_model', 'device_class', 'os', 'os_version', 'browser', 'browser_version',
  'app_name', 'app_version', 'sdk_version', 'player_version', 'codec', 'cdn', 'country', 'region', 'asn', 'network'] as const;
export type FilterName = (typeof FILTERS)[number];
/** The filters the minute aggregates carry, so the trend lines honour them. */
export const MINUTE_FILTERS: FilterName[] = ['content_id', 'stream_type', 'country', 'device_class', 'cdn'];

export interface ReportQuery { from: Date; to: Date; filters: Partial<Record<FilterName, string[]>> }

/** Read ?from&to (ISO) or ?hours / ?days, and the filters (comma separated values, `live`/`vod` for stream_type). */
export function parseQuery(q: Record<string, unknown>, now = Date.now()): ReportQuery {
  const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
  let to = q.to ? new Date(String(q.to)) : new Date(now);
  if (isNaN(+to)) to = new Date(now);
  let from: Date;
  if (q.from) from = new Date(String(q.from));
  else if (num(q.hours)) from = new Date(+to - Math.min(24 * 400, Math.max(1, num(q.hours)!)) * 3_600_000);
  else from = new Date(+to - Math.min(400, Math.max(1, num(q.days) ?? 1)) * 86_400_000);
  if (isNaN(+from) || from >= to) from = new Date(+to - 86_400_000);
  const filters: ReportQuery['filters'] = {};
  for (const f of FILTERS) {
    const raw = q[f];
    if (raw == null || raw === '') continue;
    let vals = (Array.isArray(raw) ? raw : String(raw).split(',')).map((x) => String(x).trim()).filter(Boolean).slice(0, 50);
    if (f === 'stream_type') vals = vals.flatMap((v) => (v === 'live' ? ['l', 'll'] : v === 'vod' ? ['v'] : [v]));
    if (vals.length) filters[f] = vals.map((v) => v.slice(0, 128));
  }
  return { from, to, filters };
}

/** WHERE for qoe_views: account, window (by end or start), filters. `__none` matches an unknown value. */
function where(acct: string, q: ReportQuery, by: 'ended_at' | 'started_at', p: unknown[]): string {
  p.push(acct, q.from.toISOString(), q.to.toISOString());
  const w = [`account_id = $1`, `${by} >= $2`, `${by} < $3`];
  for (const [f, vals] of Object.entries(q.filters)) {
    if (!(FILTERS as readonly string[]).includes(f) || !vals?.length) continue;
    const known = vals.filter((v) => v !== '__none');
    const parts: string[] = [];
    if (known.length) { p.push(known); parts.push(`${f} = ANY($${p.length}::text[])`); }
    if (vals.includes('__none')) parts.push(`${f} IS NULL`);
    w.push(`(${parts.join(' OR ')})`);
  }
  return w.join(' AND ');
}

const pct = (col: string) => `percentile_disc(0.5) WITHIN GROUP (ORDER BY ${col}) AS ${col}_p50,
  percentile_disc(0.95) WITHIN GROUP (ORDER BY ${col}) AS ${col}_p95,
  percentile_disc(0.99) WITHIN GROUP (ORDER BY ${col}) AS ${col}_p99`;
const n = (v: unknown) => (v == null ? null : Number(v));
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const trio = (r: any, col: string) => ({ p50: n(r[`${col}_p50`]), p95: n(r[`${col}_p95`]), p99: n(r[`${col}_p99`]) });

/** 1. Playback success: can viewers actually watch? */
export async function playbackSuccess(acct: string, q: ReportQuery) {
  const p: unknown[] = [];
  const w = where(acct, q, 'ended_at', p);
  const [t] = await aquery<any>(
    `SELECT count(*) AS attempts, count(DISTINCT sid) AS sessions,
       count(*) FILTER (WHERE outcome = 'started') AS started,
       count(*) FILTER (WHERE outcome = 'failed') AS failed,
       count(DISTINCT sid) FILTER (WHERE outcome = 'failed') AS failed_sessions,
       count(*) FILTER (WHERE outcome = 'exited') AS exited,
       count(*) FILTER (WHERE fatal_after_start) AS fatal_after,
       count(DISTINCT sid) FILTER (WHERE fatal_after_start) AS fatal_after_sessions,
       count(*) FILTER (WHERE outcome = 'exited' AND waited_ms < 2000) AS ebff_lt2,
       count(*) FILTER (WHERE outcome = 'exited' AND waited_ms >= 2000 AND waited_ms < 5000) AS ebff_2_5,
       count(*) FILTER (WHERE outcome = 'exited' AND waited_ms >= 5000 AND waited_ms < 10000) AS ebff_5_10,
       count(*) FILTER (WHERE outcome = 'exited' AND (waited_ms >= 10000 OR waited_ms IS NULL)) AS ebff_10
     FROM qoe_views WHERE ${w}`, p);
  const codes = await aquery<any>(
    `SELECT CASE WHEN outcome = 'failed' THEN 'before_start' ELSE 'after_start' END AS phase, error_step AS step, error_code AS code,
            count(*) AS views, count(DISTINCT sid) AS sessions
     FROM qoe_views WHERE ${w} AND (outcome = 'failed' OR fatal_after_start)
     GROUP BY 1, 2, 3 ORDER BY views DESC LIMIT 20`, p);
  const a = Number(t.attempts), s = Number(t.started);
  return {
    attempts: a, sessions: Number(t.sessions), started: s,
    startupSuccess: ratio(s, a),
    startupFailures: Number(t.failed), startupFailureRate: ratio(Number(t.failed), a), failedSessions: Number(t.failed_sessions),
    exitsBeforeFirstFrame: Number(t.exited), ebffRate: ratio(Number(t.exited), a),
    ebffByWait: { under2s: Number(t.ebff_lt2), from2to5s: Number(t.ebff_2_5), from5to10s: Number(t.ebff_5_10), over10s: Number(t.ebff_10) },
    fatalAfterStart: Number(t.fatal_after), failureAfterStartRate: ratio(Number(t.fatal_after), s), fatalAfterSessions: Number(t.fatal_after_sessions),
    errors: codes.map((c) => ({ phase: c.phase, step: c.step, code: c.code, views: Number(c.views), sessions: Number(c.sessions) })),
  };
}

/** 2. Startup performance: why does playback start slowly? */
export async function startupPerformance(acct: string, q: ReportQuery) {
  const p: unknown[] = [];
  const w = where(acct, q, 'ended_at', p) + ` AND outcome = 'started' AND startup_ms IS NOT NULL`;
  const spans = ['t_entitlement', 't_manifest', 't_drm', 't_segment', 't_decode', 't_other'];
  const [r] = await aquery<any>(
    `SELECT count(*) AS views, ${pct('startup_ms')}, ${spans.map((s) => `${pct(s)}, avg(${s}) AS ${s}_avg, count(${s}) AS ${s}_n`).join(', ')},
       count(DISTINCT sid) FILTER (WHERE startup_ms >= 2000) AS slow_sessions
     FROM qoe_views WHERE ${w}`, p);
  return {
    views: Number(r.views), startup: trio(r, 'startup_ms'), slowSessions: Number(r.slow_sessions),
    breakdown: spans.map((s) => ({ span: s.slice(2), views: Number(r[`${s}_n`]), avg: r[`${s}_avg`] == null ? null : Math.round(Number(r[`${s}_avg`])), ...trio(r, s) })),
  };
}

/** 3. Buffering and interruptions: how often is viewing interrupted? */
export async function buffering(acct: string, q: ReportQuery) {
  const p: unknown[] = [];
  const w = where(acct, q, 'ended_at', p) + ` AND outcome = 'started'`;
  const [r] = await aquery<any>(
    `SELECT count(*) AS views, count(*) FILTER (WHERE stalls > 0) AS stalled, count(DISTINCT sid) FILTER (WHERE stalls > 0) AS stalled_sessions,
       COALESCE(sum(stalls), 0) AS stalls, COALESCE(sum(rebuffer_ms), 0) AS rebuffer_ms, COALESCE(sum(playing_ms), 0) AS playing_ms,
       COALESCE(sum(seeks), 0) AS seeks, COALESCE(sum(seek_ms), 0) AS seek_ms,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY first_stall_ms) AS first_stall_ms_p50,
       percentile_disc(0.95) WITHIN GROUP (ORDER BY first_stall_ms) AS first_stall_ms_p95,
       percentile_disc(0.99) WITHIN GROUP (ORDER BY first_stall_ms) AS first_stall_ms_p99,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY rebuffer_ms::numeric / NULLIF(playing_ms + rebuffer_ms, 0)) AS ratio_p50,
       percentile_disc(0.95) WITHIN GROUP (ORDER BY rebuffer_ms::numeric / NULLIF(playing_ms + rebuffer_ms, 0)) AS ratio_p95,
       percentile_disc(0.99) WITHIN GROUP (ORDER BY rebuffer_ms::numeric / NULLIF(playing_ms + rebuffer_ms, 0)) AS ratio_p99
     FROM qoe_views WHERE ${w}`, p);
  const views = Number(r.views), stalls = Number(r.stalls), reb = Number(r.rebuffer_ms), play = Number(r.playing_ms);
  return {
    views, viewsWithStalls: Number(r.stalled), viewsWithStallsRate: ratio(Number(r.stalled), views), stalledSessions: Number(r.stalled_sessions),
    stalls, rebufferMs: reb, playingMs: play,
    rebufferRatio: ratio(reb, play + reb), stallsPerHour: ratio(stalls, play / 3_600_000), avgStallMs: stalls ? Math.round(reb / stalls) : null,
    rebufferRatioPerView: trio(r, 'ratio'), timeToFirstStall: trio(r, 'first_stall_ms'),
    seeks: Number(r.seeks), avgSeekMs: Number(r.seeks) ? Math.round(Number(r.seek_ms) / Number(r.seeks)) : null,
  };
}

/** 4. Video quality and ABR: is the player choosing a sustainable quality? */
export async function quality(acct: string, q: ReportQuery) {
  const p: unknown[] = [];
  const w = where(acct, q, 'ended_at', p) + ` AND outcome = 'started'`;
  const twb = `(bitrate_kbps_ms::numeric / NULLIF(bitrate_ms, 0))`;
  const [r] = await aquery<any>(
    `SELECT count(*) AS views, COALESCE(sum(bitrate_kbps_ms), 0) AS kbps_ms, COALESCE(sum(bitrate_ms), 0) AS br_ms, COALESCE(sum(playing_ms), 0) AS playing_ms,
       COALESCE(sum(below_top_ms), 0) AS below_ms, COALESCE(sum(switches), 0) AS switches, COALESCE(sum(oscillations), 0) AS osc,
       avg(buffer_avg_ms) AS buffer, avg(throughput_avg_kbps) AS mtp,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY ${twb}) AS twb_p50, percentile_disc(0.95) WITHIN GROUP (ORDER BY ${twb}) AS twb_p95,
       percentile_disc(0.99) WITHIN GROUP (ORDER BY ${twb}) AS twb_p99,
       percentile_disc(0.05) WITHIN GROUP (ORDER BY ${twb}) AS twb_p05,
       COALESCE(sum(bitrate_ms) FILTER (WHERE ${twb} < 1000), 0) AS b1, COALESCE(sum(bitrate_ms) FILTER (WHERE ${twb} >= 1000 AND ${twb} < 3000), 0) AS b2,
       COALESCE(sum(bitrate_ms) FILTER (WHERE ${twb} >= 3000 AND ${twb} < 6000), 0) AS b3, COALESCE(sum(bitrate_ms) FILTER (WHERE ${twb} >= 6000), 0) AS b4
     FROM qoe_views WHERE ${w}`, p);
  const brMs = Number(r.br_ms), play = Number(r.playing_ms), hours = play / 3_600_000;
  return {
    views: Number(r.views), playingMs: play,
    timeWeightedKbps: brMs ? Math.round(Number(r.kbps_ms) / brMs) : null,
    perViewKbps: { p05: n(r.twb_p05) && Math.round(n(r.twb_p05)!), p50: n(r.twb_p50) && Math.round(n(r.twb_p50)!), p95: n(r.twb_p95) && Math.round(n(r.twb_p95)!), p99: n(r.twb_p99) && Math.round(n(r.twb_p99)!) },
    timeAtBitrate: brMs ? [
      { band: 'under 1 Mbps', share: Number(r.b1) / brMs }, { band: '1 to 3 Mbps', share: Number(r.b2) / brMs },
      { band: '3 to 6 Mbps', share: Number(r.b3) / brMs }, { band: '6 Mbps and over', share: Number(r.b4) / brMs },
    ] : [],
    belowScreenShare: ratio(Number(r.below_ms), brMs),
    switches: Number(r.switches), switchesPerHour: ratio(Number(r.switches), hours),
    oscillations: Number(r.osc), oscillationsPerHour: ratio(Number(r.osc), hours),
    avgBufferMs: r.buffer == null ? null : Math.round(Number(r.buffer)), avgThroughputKbps: r.mtp == null ? null : Math.round(Number(r.mtp)),
  };
}

/** 10. Engagement and abandonment: how does quality relate to retention? Counted by when views started. */
export async function engagement(acct: string, q: ReportQuery, names?: (ids: string[]) => Promise<Record<string, string>>) {
  const p: unknown[] = [];
  const w = where(acct, q, 'started_at', p);
  const [r] = await aquery<any>(
    `SELECT count(*) AS views, count(DISTINCT sid) AS sessions, count(*) FILTER (WHERE outcome = 'started') AS started,
       count(*) FILTER (WHERE outcome = 'exited') AS ebff, COALESCE(sum(playing_ms), 0) AS playing_ms,
       count(*) FILTER (WHERE exit_after_stall) AS after_stall, count(*) FILTER (WHERE exit_after_error) AS after_error,
       count(*) FILTER (WHERE outcome = 'started' AND stalls > 0) AS stalled,
       count(*) FILTER (WHERE outcome = 'started' AND stalls > 0 AND exit_after_stall) AS stalled_left,
       count(*) FILTER (WHERE ended_by = 'e') AS ended
     FROM qoe_views WHERE ${w}`, p);
  const top = await aquery<any>(
    `SELECT content_id, count(*) AS views, count(*) FILTER (WHERE outcome = 'started') AS started, COALESCE(sum(playing_ms), 0) AS playing_ms,
       count(*) FILTER (WHERE outcome = 'started' AND stalls > 0) AS stalled, count(*) FILTER (WHERE exit_after_stall OR exit_after_error) AS left_after_problem
     FROM qoe_views WHERE ${w} GROUP BY content_id ORDER BY playing_ms DESC, views DESC LIMIT 20`, p);
  const nm = names ? await names(top.map((t) => t.content_id).filter(Boolean)) : {};
  const views = Number(r.views), started = Number(r.started), play = Number(r.playing_ms);
  return {
    views, sessions: Number(r.sessions), started, playingHours: play / 3_600_000, avgPlayingMs: started ? Math.round(play / started) : null,
    ebffRate: ratio(Number(r.ebff), views), exitAfterStall: Number(r.after_stall), exitAfterError: Number(r.after_error),
    // Of the views that stalled, how many the viewer left within 30 s of a stall: the link between quality and retention.
    leftAfterStallShare: ratio(Number(r.stalled_left), Number(r.stalled)), endedNaturally: Number(r.ended),
    completion: null as null, // needs the playhead and duration in the reports (not sent by the SDK yet)
    byContent: top.map((t) => ({ contentId: t.content_id, name: t.content_id ? nm[t.content_id] ?? null : null, views: Number(t.views), started: Number(t.started),
      playingHours: Number(t.playing_ms) / 3_600_000, stalledShare: ratio(Number(t.stalled), Number(t.started)), leftAfterProblem: Number(t.left_after_problem) })),
  };
}

/** 12. Telemetry health: can we trust the other reports? */
export async function telemetryHealth(acct: string, q: ReportQuery) {
  const p: unknown[] = [];
  const w = where(acct, q, 'ended_at', p);
  const [r] = await aquery<any>(
    `SELECT count(*) AS views, COALESCE(sum(events), 0) AS events, COALESCE(sum(sn_missing), 0) AS missing,
       count(*) FILTER (WHERE sn_missing > 0) AS views_with_loss, count(*) FILTER (WHERE no_sn > 0) AS views_no_sn,
       COALESCE(sum(late_events), 0) AS late, count(*) FILTER (WHERE app_name IS NULL) AS no_identity,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY abs(clock_skew_ms)) AS skew_p50,
       percentile_disc(0.95) WITHIN GROUP (ORDER BY abs(clock_skew_ms)) AS skew_p95,
       percentile_disc(0.99) WITHIN GROUP (ORDER BY abs(clock_skew_ms)) AS skew_p99
     FROM qoe_views WHERE ${w}`, p);
  const keys = await aquery<any>(
    `SELECT k AS key, sum(v::int) AS n FROM qoe_views, jsonb_each_text(unknown_keys) AS u(k, v) WHERE ${w} GROUP BY k ORDER BY n DESC LIMIT 20`, p);
  const [c] = await aquery<any>(
    `SELECT COALESCE(sum(accepted), 0) AS accepted, COALESCE(sum(rejected), 0) AS rejected,
       COALESCE((SELECT jsonb_object_agg(k, s) FROM (SELECT k, sum(v::int) AS s FROM qoe_collector_minutes m2, jsonb_each_text(m2.reasons) AS x(k, v)
                  WHERE m2.account_id = $1 AND m2.minute >= $2 AND m2.minute < $3 GROUP BY k) z), '{}'::jsonb) AS reasons
     FROM qoe_collector_minutes WHERE account_id = $1 AND minute >= $2 AND minute < $3`, [acct, q.from.toISOString(), q.to.toISOString()]);
  const events = Number(r.events), missing = Number(r.missing);
  return {
    views: Number(r.views), reports: events, eventLoss: ratio(missing, events + missing), missingReports: missing,
    viewsWithLoss: Number(r.views_with_loss), viewsWithoutSequence: Number(r.views_no_sn), viewsWithoutAppIdentity: Number(r.no_identity),
    lateReports: Number(r.late), lateShare: ratio(Number(r.late), events),
    clockSkewMs: trio(r, 'skew'),
    unknownKeys: keys.map((k) => ({ key: k.key, reports: Number(k.n) })),
    collector: { accepted: Number(c.accepted), rejected: Number(c.rejected), rejectedShare: ratio(Number(c.rejected), Number(c.accepted) + Number(c.rejected)), reasons: c.reasons ?? {} },
    // views with telemetry / sessions seen at the CDN needs the CDN logs (build queue 2.9)
    coverage: null as null,
  };
}

/** All six at once, for the console page. */
export async function overview(acct: string, q: ReportQuery, names?: (ids: string[]) => Promise<Record<string, string>>) {
  const [success, startup, buf, qual, eng, telemetry] = await Promise.all([
    playbackSuccess(acct, q), startupPerformance(acct, q), buffering(acct, q), quality(acct, q), engagement(acct, q, names), telemetryHealth(acct, q),
  ]);
  return { definitions: DEFINITIONS_VERSION, from: q.from.toISOString(), to: q.to.toISOString(), filters: q.filters, success, startup, buffering: buf, quality: qual, engagement: eng, telemetry };
}

/** The measures a breakdown can rank by. */
export const MEASURES = {
  failure: { label: 'Startup failure rate', sql: `count(*) FILTER (WHERE outcome = 'failed')::numeric / NULLIF(count(*), 0)` },
  ebff: { label: 'Exit before first frame', sql: `count(*) FILTER (WHERE outcome = 'exited')::numeric / NULLIF(count(*), 0)` },
  fatal: { label: 'Failure after start', sql: `count(*) FILTER (WHERE fatal_after_start)::numeric / NULLIF(count(*) FILTER (WHERE outcome = 'started'), 0)` },
  stalls: { label: 'Views with stalls', sql: `count(*) FILTER (WHERE outcome = 'started' AND stalls > 0)::numeric / NULLIF(count(*) FILTER (WHERE outcome = 'started'), 0)` },
  rebuffer: { label: 'Rebuffer ratio', sql: `sum(rebuffer_ms)::numeric / NULLIF(sum(playing_ms + rebuffer_ms), 0)` },
  startup_p95: { label: 'Startup time p95 (ms)', sql: `percentile_disc(0.95) WITHIN GROUP (ORDER BY startup_ms)` },
  bitrate: { label: 'Time-weighted bitrate (kbps)', sql: `sum(bitrate_kbps_ms)::numeric / NULLIF(sum(bitrate_ms), 0)` },
} as const;
export type Measure = keyof typeof MEASURES;

/**
 * THE WORST SEGMENTS (section 7): each value of one dimension, ranked by a
 * measure, over at least `minViews` views, so a bad TV model or app release
 * stands out instead of being averaged away.
 */
export async function breakdown(acct: string, q: ReportQuery, by: FilterName, measure: Measure, minViews = 20) {
  if (!(FILTERS as readonly string[]).includes(by)) throw new Error('unknown dimension');
  const m = MEASURES[measure];
  if (!m) throw new Error('unknown measure');
  const p: unknown[] = [];
  const w = where(acct, q, 'ended_at', p);
  p.push(Math.max(1, minViews));
  const rows = await aquery<any>(
    `SELECT ${by} AS value, count(*) AS views, count(DISTINCT sid) AS sessions,
       count(DISTINCT sid) FILTER (WHERE outcome <> 'started' OR stalls > 0 OR fatal_after_start) AS affected, ${m.sql} AS measure
     FROM qoe_views WHERE ${w} GROUP BY ${by} HAVING count(*) >= $${p.length}
     ORDER BY measure DESC NULLS LAST, views DESC LIMIT 50`, p);
  return { by, measure, label: m.label, minViews, rows: rows.map((r) => ({ value: r.value, views: Number(r.views), sessions: Number(r.sessions), affected: Number(r.affected), measure: n(r.measure) })) };
}

/** The values seen for each filter in the window, most views first (the console's filter lists). */
export async function dimensionValues(acct: string, q: ReportQuery, limit = 30) {
  const out: Record<string, Array<{ value: string | null; views: number }>> = {};
  for (const f of FILTERS) {
    const p: unknown[] = [];
    const w = where(acct, { ...q, filters: {} }, 'ended_at', p);
    out[f] = (await aquery<any>(`SELECT ${f} AS value, count(*) AS views FROM qoe_views WHERE ${w} GROUP BY 1 ORDER BY 2 DESC LIMIT ${Math.min(100, limit)}`, p))
      .map((r) => ({ value: r.value, views: Number(r.views) }));
  }
  return out;
}

/**
 * The trend lines, from the minute aggregates: attempts, starts, failures,
 * stalls and startup percentiles (merged sketches) per bucket. Only the
 * minute dimensions filter it; the response says which filters were left out.
 */
export async function series(acct: string, q: ReportQuery) {
  const span = +q.to - +q.from;
  const bucketMs = span <= 6 * 3_600_000 ? 60_000 : span <= 3 * 86_400_000 ? 3_600_000 : 86_400_000;
  const p: unknown[] = [acct, q.from.toISOString(), q.to.toISOString()];
  const w = [`account_id = $1`, `minute >= $2`, `minute < $3`];
  const ignored: string[] = [];
  for (const [f, vals] of Object.entries(q.filters)) {
    if (!vals?.length) continue;
    if (!MINUTE_FILTERS.includes(f as FilterName)) { ignored.push(f); continue; }
    p.push(vals.map((v) => (v === '__none' ? '' : v))); w.push(`${f} = ANY($${p.length}::text[])`);
  }
  const rows = await aquery<any>(
    `SELECT floor(extract(epoch FROM minute) * 1000 / ${bucketMs})::bigint * ${bucketMs} AS b, sum(attempts) AS attempts, sum(starts) AS starts, sum(failures) AS failures,
       sum(fatal_after) AS fatal_after, sum(stalls) AS stalls, sum(playing_ms) AS playing_ms, sum(rebuffer_ms) AS rebuffer_ms, sum(switches) AS switches,
       jsonb_agg(startup_sketch) AS sketches
     FROM qoe_minutes WHERE ${w.join(' AND ')} GROUP BY 1 ORDER BY 1`, p);
  return {
    bucketMs, ignoredFilters: ignored,
    points: rows.map((r) => {
      const s: sk.Sketch = {};
      for (const x of r.sketches ?? []) sk.merge(s, x);
      const play = Number(r.playing_ms), reb = Number(r.rebuffer_ms);
      return {
        at: new Date(Number(r.b)).toISOString(), attempts: Number(r.attempts), starts: Number(r.starts), failures: Number(r.failures), fatalAfter: Number(r.fatal_after),
        stalls: Number(r.stalls), playingMs: play, rebufferRatio: ratio(reb, play + reb), switches: Number(r.switches),
        startupP50: round(sk.quantile(s, 0.5)), startupP95: round(sk.quantile(s, 0.95)), startupP99: round(sk.quantile(s, 0.99)),
      };
    }),
  };
}
const round = (x: number | null) => (x == null ? null : Math.round(x));
