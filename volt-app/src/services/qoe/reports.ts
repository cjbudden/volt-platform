// ============================================================================
//  THE PLAYBACK EXPERIENCE REPORTS 1 TO 10 AND 12 (QOE_REPORTING.md 5).
//  Report 11, one session's timeline, is timeline.ts.
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
  'app_name', 'app_version', 'sdk_version', 'player_version', 'codec', 'cdn', 'country', 'region', 'asn', 'network',
  // journey to play (build queue 1.14g): where the viewer came from, and how many screens before the play
  'entry_point', 'session_depth'] as const;
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

/**
 * session_depth is a number: its filter values are a depth (`2`), a range
 * (`3-5`) or an open end (`6+`); anything else is ignored.
 */
function depthPart(vals: string[], p: unknown[]): string[] {
  const parts: string[] = [];
  for (const v of vals) {
    let m: RegExpMatchArray | null;
    if ((m = v.match(/^(\d{1,4})$/))) { p.push(Number(m[1])); parts.push(`session_depth = $${p.length}`); }
    else if ((m = v.match(/^(\d{1,4})-(\d{1,4})$/))) { p.push(Number(m[1]), Number(m[2])); parts.push(`session_depth BETWEEN $${p.length - 1} AND $${p.length}`); }
    else if ((m = v.match(/^(\d{1,4})\+$/))) { p.push(Number(m[1])); parts.push(`session_depth >= $${p.length}`); }
  }
  return parts;
}

/** WHERE for qoe_views: account, window (by end or start), filters. `__none` matches an unknown value. */
function where(acct: string, q: ReportQuery, by: 'ended_at' | 'started_at', p: unknown[]): string {
  p.push(acct, q.from.toISOString(), q.to.toISOString());
  const w = [`account_id = $1`, `${by} >= $2`, `${by} < $3`];
  for (const [f, vals] of Object.entries(q.filters)) {
    if (!(FILTERS as readonly string[]).includes(f) || !vals?.length) continue;
    const known = vals.filter((v) => v !== '__none');
    const parts: string[] = [];
    if (f === 'session_depth') parts.push(...depthPart(known, p));
    else if (known.length) { p.push(known); parts.push(`${f} = ANY($${p.length}::text[])`); }
    if (vals.includes('__none')) parts.push(`${f} IS NULL`);
    if (parts.length) w.push(`(${parts.join(' OR ')})`);
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

/**
 * 5. Rendering and device health: does it look smooth even when delivery is
 * fine? Dropped frames per minute of playing (the SDK reports the dropped
 * total, not decoded frames, so the ratio to decoded frames waits for that
 * key), decoder errors, hardware decoding and DRM system where the player
 * says. Backgrounded time is not playing time, so hidden tabs do not count.
 */
export async function rendering(acct: string, q: ReportQuery) {
  const p: unknown[] = [];
  const w = where(acct, q, 'ended_at', p) + ` AND outcome = 'started'`;
  const dpm = `(COALESCE(dropped_frames, 0)::numeric * 60000 / NULLIF(playing_ms, 0))`;
  const [r] = await aquery<any>(
    `SELECT count(*) AS views, count(dropped_frames) AS reported, COALESCE(sum(dropped_frames), 0) AS dropped, COALESCE(sum(playing_ms) FILTER (WHERE dropped_frames IS NOT NULL), 0) AS playing_ms,
       count(*) FILTER (WHERE dropped_frames > 0) AS with_drops, count(DISTINCT sid) FILTER (WHERE dropped_frames > 0) AS drop_sessions,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY ${dpm}) FILTER (WHERE dropped_frames IS NOT NULL) AS dpm_p50,
       percentile_disc(0.95) WITHIN GROUP (ORDER BY ${dpm}) FILTER (WHERE dropped_frames IS NOT NULL) AS dpm_p95,
       percentile_disc(0.99) WITHIN GROUP (ORDER BY ${dpm}) FILTER (WHERE dropped_frames IS NOT NULL) AS dpm_p99,
       COALESCE(sum(decode_errors), 0) AS decode_errors, count(*) FILTER (WHERE decode_errors > 0) AS decode_views,
       count(*) FILTER (WHERE error_step = 'decode' AND fatal_after_start) AS decode_fatal,
       count(*) FILTER (WHERE hw_decode IS TRUE) AS hw, count(*) FILTER (WHERE hw_decode IS FALSE) AS sw
     FROM qoe_views WHERE ${w}`, p);
  const byDevice = await aquery<any>(
    `SELECT COALESCE(device_model, device_class) AS device, count(*) AS views, COALESCE(sum(dropped_frames), 0) AS dropped,
       COALESCE(sum(playing_ms) FILTER (WHERE dropped_frames IS NOT NULL), 0) AS playing_ms, COALESCE(sum(decode_errors), 0) AS decode_errors
     FROM qoe_views WHERE ${w} GROUP BY 1 ORDER BY (COALESCE(sum(dropped_frames), 0)::numeric / NULLIF(sum(playing_ms) FILTER (WHERE dropped_frames IS NOT NULL), 0)) DESC NULLS LAST, views DESC, 1 LIMIT 20`, p);
  const keys = await aquery<any>(`SELECT key_system, count(*) AS views FROM qoe_views WHERE ${w} AND key_system IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`, p);
  const play = Number(r.playing_ms);
  return {
    views: Number(r.views), viewsReportingFrames: Number(r.reported),
    droppedFrames: Number(r.dropped), droppedPerMinute: play ? Number(r.dropped) * 60_000 / play : null,
    perViewDroppedPerMinute: { p50: n(r.dpm_p50), p95: n(r.dpm_p95), p99: n(r.dpm_p99) },
    viewsWithDrops: Number(r.with_drops), dropSessions: Number(r.drop_sessions),
    decodeErrors: Number(r.decode_errors), viewsWithDecodeErrors: Number(r.decode_views), decodeFatal: Number(r.decode_fatal),
    hardwareDecode: { yes: Number(r.hw), no: Number(r.sw) },
    keySystems: keys.map((k) => ({ keySystem: k.key_system, views: Number(k.views) })),
    byDevice: byDevice.map((d) => ({ device: d.device, views: Number(d.views), droppedPerMinute: Number(d.playing_ms) ? Number(d.dropped) * 60_000 / Number(d.playing_ms) : null, decodeErrors: Number(d.decode_errors) })),
    // Not measured yet: freezes (a picture that stops while playing), A/V sync on the player, and the
    // encoder's own A/V check beside it (output_check.py, in pipelineHealth.ts).
    notMeasured: ['freezes', 'player A/V sync', 'stream-side A/V check'],
  };
}

/**
 * 7. DRM and access: are protection or access checks blocking playback?
 * The play gate's own log (qoe_gate, timed, by sid) says why it answered as
 * it did; a view that failed at the entitlement step is joined to it by sid
 * so the refusal is attributed to geo, rights, payment, sign in and so on.
 * Licence timing and failures are the player's (the startup span and its
 * reports on licence requests). Token errors: refused mid-view (401/403).
 */
export async function access(acct: string, q: ReportQuery) {
  const p: unknown[] = [];
  const w = where(acct, q, 'ended_at', p);
  // The gate's decisions in the window. Content filters apply (asset), viewer dimensions cannot (the gate has none).
  const gp: unknown[] = [acct, q.from.toISOString(), q.to.toISOString()];
  const gw = [`account_id = $1`, `at >= $2`, `at < $3`];
  if (q.filters.content_id?.length) { gp.push(q.filters.content_id); gw.push(`asset_id = ANY($${gp.length}::text[])`); }
  if (q.filters.country?.length) { gp.push(q.filters.country); gw.push(`country = ANY($${gp.length}::text[])`); }
  const [g] = await aquery<any>(
    `SELECT count(*) AS decisions, count(*) FILTER (WHERE reason IN ('allowed', 'replacement')) AS allowed,
       count(*) FILTER (WHERE reason NOT IN ('allowed', 'replacement')) AS denied, count(DISTINCT sid) AS sessions,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY ms) AS ms_p50, percentile_disc(0.95) WITHIN GROUP (ORDER BY ms) AS ms_p95,
       percentile_disc(0.99) WITHIN GROUP (ORDER BY ms) AS ms_p99
     FROM qoe_gate WHERE ${gw.join(' AND ')}`, gp);
  const reasons = await aquery<any>(
    `SELECT reason, status, count(*) AS decisions, count(DISTINCT sid) AS sessions FROM qoe_gate WHERE ${gw.join(' AND ')}
     GROUP BY 1, 2 ORDER BY 3 DESC, 1, 2 LIMIT 30`, gp);
  // Every view that ended in a fatal error at the entitlement or DRM step, with the gate's reason for that sid.
  const failures = await aquery<any>(
    `SELECT v.error_step AS step, v.error_code AS code, COALESCE(g.reason, CASE WHEN v.error_step = 'entitlement' THEN 'not in the gate log' END) AS gate_reason,
       CASE WHEN v.outcome = 'failed' THEN 'before_start' ELSE 'after_start' END AS phase, count(*) AS views, count(DISTINCT v.sid) AS sessions
     FROM (SELECT account_id, sid, outcome, fatal_after_start, error_step, error_code FROM qoe_views
           WHERE ${w} AND (outcome = 'failed' OR fatal_after_start) AND error_step IN ('entitlement', 'drm')) v
     LEFT JOIN LATERAL (SELECT reason FROM qoe_gate g WHERE g.account_id = v.account_id AND g.sid = v.sid ORDER BY g.at DESC LIMIT 1) g ON true
     GROUP BY 1, 2, 3, 4 ORDER BY views DESC, step, code, gate_reason, phase LIMIT 30`, p);
  const [l] = await aquery<any>(
    `SELECT count(*) FILTER (WHERE licence_requests > 0 OR t_drm IS NOT NULL OR error_step = 'drm') AS drm_views,
       COALESCE(sum(licence_requests), 0) AS licence_requests, COALESCE(sum(licence_failures), 0) AS licence_failures,
       count(*) FILTER (WHERE licence_failures > 0) AS views_licence_failed,
       count(*) FILTER (WHERE outcome = 'failed' AND error_step = 'drm') AS drm_failed, count(*) FILTER (WHERE fatal_after_start AND error_step = 'drm') AS drm_fatal_after,
       count(*) FILTER (WHERE outcome = 'failed' AND error_step = 'entitlement') AS ent_failed,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY t_drm) AS t_drm_p50, percentile_disc(0.95) WITHIN GROUP (ORDER BY t_drm) AS t_drm_p95,
       percentile_disc(0.99) WITHIN GROUP (ORDER BY t_drm) AS t_drm_p99,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY licence_max_ms) AS lic_p50, percentile_disc(0.95) WITHIN GROUP (ORDER BY licence_max_ms) AS lic_p95,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY t_entitlement) AS t_ent_p50, percentile_disc(0.95) WITHIN GROUP (ORDER BY t_entitlement) AS t_ent_p95,
       COALESCE(sum(token_errors), 0) AS token_errors, count(*) FILTER (WHERE token_errors > 0) AS token_views, count(DISTINCT sid) FILTER (WHERE token_errors > 0) AS token_sessions
     FROM qoe_views WHERE ${w}`, p);
  return {
    gate: {
      decisions: Number(g.decisions), allowed: Number(g.allowed), denied: Number(g.denied), sessions: Number(g.sessions),
      deniedShare: ratio(Number(g.denied), Number(g.decisions)), timeMs: { p50: n(g.ms_p50), p95: n(g.ms_p95), p99: n(g.ms_p99) },
      reasons: reasons.map((x) => ({ reason: x.reason, status: Number(x.status), decisions: Number(x.decisions), sessions: Number(x.sessions) })),
    },
    entitlementFailures: Number(l.ent_failed),
    failures: failures.map((f) => ({ step: f.step, code: f.code, gateReason: f.gate_reason, phase: f.phase, views: Number(f.views), sessions: Number(f.sessions) })),
    playerEntitlementMs: { p50: n(l.t_ent_p50), p95: n(l.t_ent_p95) },
    licence: {
      views: Number(l.drm_views), requests: Number(l.licence_requests), failures: Number(l.licence_failures), viewsWithFailures: Number(l.views_licence_failed),
      failedBeforeStart: Number(l.drm_failed), failedAfterStart: Number(l.drm_fatal_after),
      startupSpanMs: { p50: n(l.t_drm_p50), p95: n(l.t_drm_p95), p99: n(l.t_drm_p99) },
      slowestRequestMs: { p50: n(l.lic_p50), p95: n(l.lic_p95) },
    },
    tokenErrors: { errors: Number(l.token_errors), views: Number(l.token_views), sessions: Number(l.token_sessions) },
    // Volt has no licence proxy of its own yet (Axinom is waiting on its tenant): licence timing is the player's.
    // Output-protection (HDCP) failures are not told apart from other DRM errors by the players yet.
    notMeasured: ['licence proxy log', 'output protection'],
  };
}

/**
 * 8. Live-stream health: are viewers live, stable and close to target
 * latency? From the player: latency behind the live edge (ltc) at the start
 * and end of each view (drift = end minus start), the highest, and time spent
 * catching up (rate above 1). Per device, so a model that drifts stands out.
 */
export async function liveHealth(acct: string, q: ReportQuery) {
  const p: unknown[] = [];
  const w = where(acct, q, 'ended_at', p) + ` AND outcome = 'started' AND stream_type IN ('l', 'll')`;
  const drift = `(latency_last_ms - latency_first_ms)`;
  const [r] = await aquery<any>(
    `SELECT count(*) AS views, count(latency_avg_ms) AS with_latency, count(DISTINCT sid) AS sessions,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_avg_ms) AS lat_p50, percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_avg_ms) AS lat_p95,
       percentile_disc(0.99) WITHIN GROUP (ORDER BY latency_avg_ms) AS lat_p99,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY ${drift}) AS drift_p50, percentile_disc(0.95) WITHIN GROUP (ORDER BY ${drift}) AS drift_p95,
       avg(${drift}) AS drift_avg, max(latency_max_ms) AS lat_max,
       count(*) FILTER (WHERE ${drift} > 5000) AS drifted, count(DISTINCT sid) FILTER (WHERE ${drift} > 5000) AS drifted_sessions,
       COALESCE(sum(catchup_ms), 0) AS catchup_ms, COALESCE(sum(slowdown_ms), 0) AS slowdown_ms, COALESCE(sum(playing_ms), 0) AS playing_ms,
       COALESCE(sum(rate_changes), 0) AS rate_changes
     FROM qoe_views WHERE ${w}`, p);
  const byDevice = await aquery<any>(
    `SELECT device_class, device_model, count(*) AS views, avg(latency_avg_ms) AS lat_avg,
       percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_avg_ms) AS lat_p95, avg(${drift}) AS drift_avg, max(latency_max_ms) AS lat_max,
       COALESCE(sum(catchup_ms), 0) AS catchup_ms, COALESCE(sum(playing_ms), 0) AS playing_ms
     FROM qoe_views WHERE ${w} AND latency_avg_ms IS NOT NULL GROUP BY 1, 2 ORDER BY avg(${drift}) DESC NULLS LAST, views DESC, 1, 2 LIMIT 30`, p);
  const play = Number(r.playing_ms);
  const rnd = (x: unknown) => (x == null ? null : Math.round(Number(x)));
  return {
    views: Number(r.views), viewsWithLatency: Number(r.with_latency), sessions: Number(r.sessions),
    latencyMs: { p50: n(r.lat_p50), p95: n(r.lat_p95), p99: n(r.lat_p99) }, highestLatencyMs: n(r.lat_max),
    driftMs: { p50: n(r.drift_p50), p95: n(r.drift_p95), avg: rnd(r.drift_avg) },
    viewsDriftedOver5s: Number(r.drifted), driftedSessions: Number(r.drifted_sessions),
    catchUpShare: ratio(Number(r.catchup_ms), play), slowDownShare: ratio(Number(r.slowdown_ms), play), rateChanges: Number(r.rate_changes),
    byDevice: byDevice.map((d) => ({ deviceClass: d.device_class, deviceModel: d.device_model, views: Number(d.views), latencyAvgMs: rnd(d.lat_avg), latencyP95Ms: n(d.lat_p95),
      driftAvgMs: rnd(d.drift_avg), highestLatencyMs: n(d.lat_max), catchUpShare: ratio(Number(d.catchup_ms), Number(d.playing_ms)) })),
    // The stream side (manifest freshness, missing segments, discontinuities from output_check.py and the
    // five gates) lives in pipelineHealth.ts and joins here by content in a later step.
    notMeasured: ['stream side: manifest freshness, missing segments, discontinuities'],
  };
}

/** What the stitcher's server-side beacons recorded (1.11), read by the module from the control plane. */
export interface BeaconSummary { impressions: number; starts: number; firstQuartile: number; midpoint: number; thirdQuartile: number; complete: number; failed: number; sessions: number }

/**
 * 9. Advertising: are ads hurting playback or revenue? The player's side:
 * breaks, ad startup delay (break start to the ad playing), buffering and
 * stalls inside breaks, errors in breaks, viewers who left during an ad, and
 * how long it took to get back to the programme. The server's side: the
 * beacons the stitcher sent for the same period.
 */
export async function advertising(acct: string, q: ReportQuery, beacons?: () => Promise<BeaconSummary | null>) {
  const p: unknown[] = [];
  const w = where(acct, q, 'ended_at', p) + ` AND ad_breaks > 0`;
  const [r] = await aquery<any>(
    `SELECT count(*) AS views, count(DISTINCT sid) AS sessions, COALESCE(sum(ad_breaks), 0) AS breaks, COALESCE(sum(ad_breaks_ended), 0) AS breaks_ended,
       COALESCE(sum(ad_ms), 0) AS ad_ms, COALESCE(sum(ad_playing_ms), 0) AS ad_playing_ms, COALESCE(sum(ad_rebuffer_ms), 0) AS ad_rebuffer_ms,
       COALESCE(sum(ad_stalls), 0) AS ad_stalls, count(*) FILTER (WHERE ad_stalls > 0) AS views_ad_stalls, COALESCE(sum(ad_errors), 0) AS ad_errors,
       COALESCE(sum(ad_start_ms), 0) AS start_ms, COALESCE(sum(ad_start_n), 0) AS start_n,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY ad_start_max_ms) AS start_p50, percentile_disc(0.95) WITHIN GROUP (ORDER BY ad_start_max_ms) AS start_p95,
       COALESCE(sum(ad_return_ms), 0) AS return_ms, COALESCE(sum(ad_return_n), 0) AS return_n,
       percentile_disc(0.95) WITHIN GROUP (ORDER BY ad_return_max_ms) AS return_p95,
       count(*) FILTER (WHERE left_in_ad) AS left_in_ad, count(DISTINCT sid) FILTER (WHERE left_in_ad) AS left_in_ad_sessions,
       COALESCE(sum(ads_started), 0) AS ads_started, COALESCE(sum(ads_ended), 0) AS ads_ended
     FROM qoe_views WHERE ${w}`, p);
  const breaks = Number(r.breaks), adPlay = Number(r.ad_playing_ms), adReb = Number(r.ad_rebuffer_ms);
  const server = beacons ? await beacons().catch(() => null) : null;
  return {
    views: Number(r.views), sessions: Number(r.sessions), breaks, breaksCompleted: Number(r.breaks_ended),
    breakCompletion: ratio(Number(r.breaks_ended), breaks), avgBreakMs: breaks ? Math.round(Number(r.ad_ms) / breaks) : null,
    adStartupMs: { avg: Number(r.start_n) ? Math.round(Number(r.start_ms) / Number(r.start_n)) : null, p50: n(r.start_p50), p95: n(r.start_p95) },
    adRebufferRatio: ratio(adReb, adPlay + adReb), adStalls: Number(r.ad_stalls), viewsWithAdStalls: Number(r.views_ad_stalls), adErrors: Number(r.ad_errors),
    returnToContentMs: { avg: Number(r.return_n) ? Math.round(Number(r.return_ms) / Number(r.return_n)) : null, p95: n(r.return_p95) },
    leftDuringAd: Number(r.left_in_ad), leftDuringAdSessions: Number(r.left_in_ad_sessions),
    adsStarted: Number(r.ads_started), adsEnded: Number(r.ads_ended),
    // Ads in a break watched to their end (an ad the viewer left during has no end).
    adCompletion: ratio(Number(r.ads_ended), Number(r.ads_started)),
    server,
    serverCompletion: server && server.impressions ? server.complete / server.impressions : null,
  };
}

/**
 * The views behind the numbers, newest first, to open one as a timeline
 * (report 11). `problem`: failed (before the first frame), error (any fatal),
 * stalled, ad (left during an ad), or all.
 */
export async function listViews(acct: string, q: ReportQuery, problem = 'all', limit = 50) {
  const p: unknown[] = [];
  let w = where(acct, q, 'ended_at', p);
  if (problem === 'failed') w += ` AND outcome = 'failed'`;
  else if (problem === 'error') w += ` AND (outcome = 'failed' OR fatal_after_start)`;
  else if (problem === 'stalled') w += ` AND stalls > 0`;
  else if (problem === 'ad') w += ` AND left_in_ad`;
  else if (problem === 'exited') w += ` AND outcome = 'exited'`;
  p.push(Math.min(200, Math.max(1, limit)));
  const rows = await aquery<any>(
    `SELECT sid, attempt, started_at, ended_at, ended_by, content_id, stream_type, device_class, device_model, os, browser, app_name, app_version, country,
       outcome, startup_ms, error_code, error_step, fatal_after_start, stalls, rebuffer_ms, playing_ms, ad_breaks, ads_started, ads_ended, left_in_ad, latency_avg_ms
     FROM qoe_views WHERE ${w} ORDER BY ended_at DESC, sid, attempt LIMIT $${p.length}`, p);
  return rows.map((v) => ({
    sid: v.sid, attempt: Number(v.attempt), startedAt: new Date(v.started_at).toISOString(), endedAt: new Date(v.ended_at).toISOString(), endedBy: v.ended_by,
    contentId: v.content_id, streamType: v.stream_type, device: v.device_model ?? v.device_class, os: v.os, browser: v.browser, app: v.app_name, appVersion: v.app_version,
    country: v.country, outcome: v.outcome, startupMs: v.startup_ms, errorCode: v.error_code, errorStep: v.error_step, fatalAfterStart: v.fatal_after_start,
    stalls: Number(v.stalls), rebufferMs: Number(v.rebuffer_ms), playingMs: Number(v.playing_ms), adBreaks: Number(v.ad_breaks), adsStarted: Number(v.ads_started), adsEnded: Number(v.ads_ended), leftInAd: v.left_in_ad, latencyAvgMs: v.latency_avg_ms,
  }));
}

/** Reports 1 to 10 and 12 at once, for the console page. */
export async function overview(acct: string, q: ReportQuery, names?: (ids: string[]) => Promise<Record<string, string>>, beacons?: () => Promise<BeaconSummary | null>) {
  const [success, startup, buf, qual, eng, telemetry, rend, acc, live, ads] = await Promise.all([
    playbackSuccess(acct, q), startupPerformance(acct, q), buffering(acct, q), quality(acct, q), engagement(acct, q, names), telemetryHealth(acct, q),
    rendering(acct, q), access(acct, q), liveHealth(acct, q), advertising(acct, q, beacons),
  ]);
  return { definitions: DEFINITIONS_VERSION, from: q.from.toISOString(), to: q.to.toISOString(), filters: q.filters, success, startup, buffering: buf, quality: qual, engagement: eng, telemetry,
    rendering: rend, access: acc, live, ads };
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
