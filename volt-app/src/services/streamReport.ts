// ============================================================================
//  PER-STREAM OPERATING REPORT.  docs/REQ_stream_reporting.md
//
//  Every time a channel, station or event ran, how long for, how long it was on
//  air, why each run ended, and what the audience did. Read only: this file
//  writes nothing, it reads four ledgers that already exist.
//
//    runs        usage_accruals (durable, FK-free), enriched by `instances`
//                while the instance row still exists. A report that vanished
//                with the channel would not be a report.
//    on air      air_sessions (migration 0023) for channels and stations.
//                Events have no on-air switch: an event is public while it is
//                running inside its public window (publicLive.ts), so for an
//                event the air time is DERIVED from its runs and that window,
//                and the report says so in `air_basis`.
//    why ended   run_stops (migration 0059). A run with no row ended by a path
//                that never reached stopStream, and is reported as `unknown`.
//    audience    play_sessions for an exact per-run peak while the raw rows are
//                retained, analytics_rollups (daily, sealed, durable) after.
//
//  NULL MEANS "NOT KNOWN", NEVER ZERO. A run from four months ago whose raw
//  sessions were pruned reports `peak_concurrent: null` with
//  `peak_basis: 'not_retained'` and the day's rollup peak beside it. A
//  `Peak 0` there would invite exactly one conclusion and it would be wrong.
//
//  COST IS THE PLATFORM'S COST BASIS (usage_accruals.est_usd is our compute
//  estimate, not the customer's price), so it is only included when the caller
//  says the reader holds a platform role. See RELAY.md.
// ============================================================================
import { query, one } from '../db';

export type StreamKind = 'channel' | 'radio' | 'event';
export type StopKind = 'operator' | 'schedule' | 'fault' | 'internal' | 'unknown';
export type PeakBasis = 'exact' | 'not_retained' | 'no_viewers_recorded';

export interface Interval { from: number; to: number }   // epoch ms, to exclusive

// ---------------------------------------------------------------------------
//  Pure interval helpers (exported for the check suite)
// ---------------------------------------------------------------------------

/** Length of the overlap of two intervals, in whole seconds. */
export function overlapSeconds(a: Interval, b: Interval): number {
  const lo = Math.max(a.from, b.from), hi = Math.min(a.to, b.to);
  return hi > lo ? Math.round((hi - lo) / 1000) : 0;
}

/** Merge overlapping intervals, so a sum over them cannot exceed wall-clock time. */
export function mergeIntervals(xs: Interval[]): Interval[] {
  const s = xs.filter((x) => x.to > x.from).sort((p, q) => p.from - q.from);
  const out: Interval[] = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x.from <= last.to) last.to = Math.max(last.to, x.to);
    else out.push({ ...x });
  }
  return out;
}

/** Seconds of `a` covered by any of `windows`. Windows are merged first. */
export function coveredSeconds(a: Interval, windows: Interval[]): number {
  return mergeIntervals(windows).reduce((n, w) => n + overlapSeconds(a, w), 0);
}

/** Join back-to-back meter slices (gap under 5 s) into runs. */
export function chainSlices(rows: { from_at: any; to_at: any; task_kind?: any; instance_type?: any; lifecycle?: any; stream_name?: any }[]) {
  const out: { from: number; to: number; task_kind: any; instance_type: any; lifecycle: any; name: any }[] = [];
  for (const r of [...rows].sort((a, b) => new Date(a.from_at).getTime() - new Date(b.from_at).getTime())) {
    const f = new Date(r.from_at).getTime(), t = new Date(r.to_at).getTime();
    const last = out[out.length - 1];
    if (last && f - last.to <= 5000) last.to = Math.max(last.to, t);
    else out.push({ from: f, to: t, task_kind: r.task_kind ?? null, instance_type: r.instance_type ?? null, lifecycle: r.lifecycle ?? null, name: r.stream_name ?? null });
  }
  return out;
}

/** Planned stops are a decision; unplanned ones happened to the stream. */
export function isPlanned(k: StopKind): boolean { return k === 'operator' || k === 'schedule'; }

/**
 * Mean time to recovery: for each unplanned stop (a fault), the time until the
 * next run started. A fault with no later run is not recovered and is left out
 * of the mean (and counted in `unrecovered`), because averaging in "never"
 * produces a number nobody can use.
 */
export function mttr(runs: { start: number; end: number | null; stop: StopKind }[]): { seconds: number | null; recovered: number; unrecovered: number } {
  const byStart = [...runs].sort((a, b) => a.start - b.start);
  const gaps: number[] = [];
  let unrecovered = 0;
  for (let i = 0; i < byStart.length; i++) {
    const r = byStart[i];
    if (r.end == null || r.stop !== 'fault') continue;
    const next = byStart.slice(i + 1).find((n) => n.start >= r.end!);
    if (next) gaps.push((next.start - r.end) / 1000); else unrecovered++;
  }
  return {
    seconds: gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null,
    recovered: gaps.length, unrecovered,
  };
}

// ---------------------------------------------------------------------------
//  Identity
// ---------------------------------------------------------------------------

export interface StreamIdentity {
  id: string;
  kind: StreamKind;
  name: string;
  /** False when the stream has been deleted and the report is read from the ledgers alone. */
  exists: boolean;
  /** The analytics asset kind the player beacons with: stations are channels. */
  assetKind: 'channel' | 'event';
  publicStart: Date | null;
  publicEnd: Date | null;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  /** When the stream came into being, so availability is not counted against days before it existed. */
  createdAt: Date | null;
}

export async function resolveStream(accountId: string, id: string): Promise<StreamIdentity | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const ch = await one<any>(
    `SELECT c.id, c.name, c.kind, c.created_at FROM channels c JOIN groups g ON g.id = c.group_id
      WHERE c.id = $1 AND g.account_id = $2`, [id, accountId]);
  if (ch) {
    return { id, kind: ch.kind === 'radio' ? 'radio' : 'channel', name: ch.name, exists: true, assetKind: 'channel',
      publicStart: null, publicEnd: null, scheduledStart: null, scheduledEnd: null, createdAt: ch.created_at ?? null };
  }
  const ev = await one<any>(
    `SELECT e.id, e.name, e.public_start, e.public_end, e.scheduled_start, e.scheduled_end
       FROM events e JOIN groups g ON g.id = e.group_id
      WHERE e.id = $1 AND g.account_id = $2`, [id, accountId]);
  if (ev) {
    return { id, kind: 'event', name: ev.name, exists: true, assetKind: 'event',
      publicStart: ev.public_start, publicEnd: ev.public_end, scheduledStart: ev.scheduled_start, scheduledEnd: ev.scheduled_end, createdAt: null };
  }
  // DELETED. The ledgers keep a snapshot of the identity precisely for this.
  const snap = await one<any>(
    `SELECT name, kind, (SELECT min(from_at) FROM usage_accruals WHERE account_id = $1 AND stream_id = $2) AS first_at FROM (
       SELECT stream_name AS name, stream_kind AS kind, from_at AS at FROM air_sessions WHERE account_id = $1 AND stream_id = $2
       UNION ALL
       SELECT stream_name, stream_kind, stopped_at FROM run_stops WHERE account_id = $1 AND stream_id = $2
       UNION ALL
       SELECT stream_name, CASE WHEN event_id IS NOT NULL THEN 'event' ELSE NULL END, from_at
         FROM usage_accruals WHERE account_id = $1 AND stream_id = $2
     ) s ORDER BY (kind IS NULL), at DESC LIMIT 1`, [accountId, id]);
  if (!snap) return null;
  const kind: StreamKind = snap.kind === 'radio' ? 'radio' : snap.kind === 'event' ? 'event' : 'channel';
  return { id, kind, name: snap.name ?? '(deleted)', exists: false, assetKind: kind === 'event' ? 'event' : 'channel',
    publicStart: null, publicEnd: null, scheduledStart: null, scheduledEnd: null, createdAt: snap.first_at ?? null };
}

// ---------------------------------------------------------------------------
//  The report
// ---------------------------------------------------------------------------

export interface RunRow {
  instance_id: string;
  /** The stream's name when this run was metered. A rename later does not rewrite it. */
  name_at_run: string;
  started_at: string;
  ended_at: string | null;            // null while running
  running: boolean;
  /** The whole run, wherever it falls. */
  duration_seconds: number;
  /** The part of the run inside the report period. Totals sum this. */
  seconds_in_period: number;
  on_air_seconds: number;
  stop: StopKind | null;              // null while running
  planned_stop: boolean | null;
  stop_detail: string | null;
  task_kind: string | null;
  instance_type: string | null;
  lifecycle: string | null;
  audience: {
    peak_concurrent: number | null;
    peak_at: string | null;
    peak_basis: PeakBasis;
    /** Offered when the per-run peak is not retained: the highest daily peak on the run's days. */
    day_peak_concurrent: number | null;
    views: number | null;
    unique_viewers: number | null;
    watch_seconds: number | null;
  };
  /** Stations only: the MP3 relay path, which is a different delivery with a different cost. */
  listeners?: { sessions: number; listen_seconds: number; bytes: number; peak_concurrent: number; peak_at: string | null } | null;
  cost_basis_usd?: number | null;
}

export interface StreamReport {
  stream: { id: string; kind: StreamKind; name: string; deleted: boolean };
  period: { from: string; to: string };
  air_basis: 'ledger' | 'public_window' | 'none';
  /** The on-air windows, merged and clipped to the period, for drawing. */
  air_windows: { from: string; to: string }[];
  notes: string[];
  totals: {
    runs: number;
    run_seconds: number;
    on_air_seconds: number;
    /** On-air seconds over the expected window, as a percentage. Null when there is no expected window. */
    availability_pct: number | null;
    availability_window: 'period' | 'public_window' | 'scheduled_window' | null;
    stops: { planned: number; unplanned: number; internal: number; unknown: number };
    mttr_seconds: number | null;
    unrecovered_faults: number;
    peak_concurrent: number | null;
    peak_at: string | null;
    peak_basis: 'exact' | 'daily' | 'none';
    views: number | null;
    unique_viewers_daily_sum: number | null;
    watch_seconds: number | null;
    cost_basis_usd?: number | null;
  };
  runs: RunRow[];
}

const MAX_RUNS = 1000;

/** Peak concurrent viewers in [a, b) from raw play sessions, by sweeping their intervals. */
async function sweepPeak(accountId: string, assetKind: string, assetId: string, a: Date, b: Date) {
  const r = await one<any>(
    `WITH s AS (
       SELECT GREATEST(started_at, $4::timestamptz) AS f,
              LEAST(COALESCE(ended_at, last_seen_at, started_at), $5::timestamptz) AS t,
              ip_hash, seconds_watched, started_at
         FROM play_sessions
        WHERE account_id = $1 AND asset_kind = $2 AND asset_id = $3
          AND started_at < $5::timestamptz
          AND COALESCE(ended_at, last_seen_at, started_at) > $4::timestamptz
          AND NOT blocked
     ), ev AS (
       SELECT f AS at, 1 AS d FROM s WHERE t > f
       UNION ALL
       SELECT t, -1 FROM s WHERE t > f
     ), run AS (
       -- leaves before arrivals at the same instant, so a hand-over is not a peak
       SELECT at, sum(d) OVER (ORDER BY at, d ROWS UNBOUNDED PRECEDING) AS c FROM ev
     )
     SELECT (SELECT max(c) FROM run)::int AS peak,
            (SELECT at FROM run ORDER BY c DESC, at LIMIT 1) AS peak_at,
            (SELECT count(*) FROM s WHERE started_at >= $4::timestamptz)::int AS views,
            (SELECT count(DISTINCT ip_hash) FROM s)::int AS uniq,
            (SELECT COALESCE(sum(seconds_watched), 0) FROM s WHERE started_at >= $4::timestamptz)::bigint AS watch`,
    [accountId, assetKind, assetId, a.toISOString(), b.toISOString()]);
  return {
    peak: r?.peak == null ? 0 : Number(r.peak),
    peakAt: r?.peak_at ? new Date(r.peak_at).toISOString() : null,
    views: Number(r?.views ?? 0), uniq: Number(r?.uniq ?? 0), watch: Number(r?.watch ?? 0),
  };
}

/**
 * Are the raw sessions for [a, b] still here? They are pruned per account,
 * only once a day is both out of the raw window AND sealed (analyticsRetention).
 * So the window is not enough on its own: a day held back because its summary
 * was never sealed is still complete, and still exact.
 */
async function rawRetained(accountId: string, a: Date, b: Date): Promise<boolean> {
  const r = await one<any>(
    `SELECT a.analytics_raw_retention_days AS d,
            EXISTS (
              SELECT 1 FROM analytics_rollups r
               WHERE r.account_id = a.id AND r.scope = 'account' AND r.scope_id IS NULL AND r.sealed
                 AND r.bucket_date BETWEEN $2::date AND $3::date
                 AND a.analytics_raw_retention_days IS NOT NULL
                 AND r.bucket_date < current_date - (a.analytics_raw_retention_days || ' days')::interval
            ) AS pruned
       FROM accounts a WHERE a.id = $1`, [accountId, a.toISOString(), b.toISOString()]);
  if (!r) return false;
  return !r.pruned;
}

async function dayPeak(accountId: string, assetKind: string, id: string, a: Date, b: Date): Promise<number | null> {
  const r = await one<any>(
    `SELECT max(peak_concurrent)::int AS p FROM analytics_rollups
      WHERE account_id = $1 AND scope = $2 AND scope_id = $3 AND bucket_date BETWEEN $4::date AND $5::date`,
    [accountId, assetKind, id, a.toISOString(), b.toISOString()]);
  return r?.p == null ? null : Number(r.p);
}

export async function streamReport(
  accountId: string,
  stream: StreamIdentity,
  fromD: Date,
  toD: Date,
  opts: { includeCost?: boolean; now?: Date } = {},
): Promise<StreamReport> {
  const nowMs = (opts.now ?? new Date()).getTime();
  const period: Interval = { from: fromD.getTime(), to: Math.min(toD.getTime(), nowMs) };
  const notes: string[] = [];

  // ---- runs: the accrual ledger, enriched by instances while they exist ----
  // The run key is instance_ref (FK-free, migration 0059), falling back to
  // instance_id for rows the backfill could still reach.
  const acc = await query<any>(
    `WITH hit AS (
       SELECT DISTINCT COALESCE(instance_ref, instance_id) AS k FROM usage_accruals
        WHERE account_id = $1 AND stream_id = $2
          AND from_at < $4::timestamptz AND to_at > $3::timestamptz
          AND COALESCE(task_kind, '') <> 'captions'
          AND COALESCE(instance_ref, instance_id) IS NOT NULL
     )
     SELECT h.k AS instance_id, min(u.from_at) AS first_at, max(u.to_at) AS last_at,
            max(u.task_kind) AS task_kind, (array_agg(u.stream_name ORDER BY u.from_at))[1] AS name_at_run,
            max(u.instance_type) AS instance_type, max(u.lifecycle) AS lifecycle,
            sum(CASE WHEN u.from_at < $4::timestamptz AND u.to_at > $3::timestamptz AND u.seconds > 0
                     THEN u.est_usd * EXTRACT(EPOCH FROM (LEAST(u.to_at, $4::timestamptz) - GREATEST(u.from_at, $3::timestamptz))) / u.seconds
                     ELSE 0 END) AS usd_in_period
       FROM usage_accruals u JOIN hit h ON h.k = COALESCE(u.instance_ref, u.instance_id)
      WHERE u.account_id = $1 AND u.stream_id = $2
      GROUP BY h.k
      LIMIT ${MAX_RUNS}`,
    [accountId, stream.id, fromD.toISOString(), toD.toISOString()]);

  // KEYLESS ROWS: accruals whose instance was deleted before 0059 gave them an
  // instance_ref. The run identity is gone, so they are re-assembled by
  // contiguity: the meter writes back-to-back slices (it advances a mark), so a
  // gap between slices is a gap between runs. Their stop reason is unknown.
  const keyless = await query<any>(
    `SELECT from_at, to_at, task_kind, instance_type, lifecycle, stream_name, seconds, est_usd
       FROM usage_accruals
      WHERE account_id = $1 AND stream_id = $2 AND instance_ref IS NULL AND instance_id IS NULL
        AND COALESCE(task_kind, '') <> 'captions'
        AND from_at < $4::timestamptz + interval '2 days' AND to_at > $3::timestamptz - interval '2 days'
      ORDER BY from_at LIMIT 20000`,
    [accountId, stream.id, fromD.toISOString(), toD.toISOString()]);
  for (const chain of chainSlices(keyless)) {
    if (chain.to <= fromD.getTime() || chain.from >= toD.getTime()) continue;
    acc.push({ instance_id: `legacy-${chain.from}`, first_at: new Date(chain.from), last_at: new Date(chain.to),
      task_kind: chain.task_kind, name_at_run: chain.name, instance_type: chain.instance_type, lifecycle: chain.lifecycle,
      usd_in_period: null, legacy: true });
  }

  const inst = await query<any>(
    `SELECT id, launched_at, terminated_at, task_kind, instance_type, lifecycle
       FROM instances
      WHERE COALESCE(channel_id, event_id) = $1
        AND COALESCE(task_kind, '') <> 'captions'
        AND launched_at IS NOT NULL
        AND launched_at < $3::timestamptz AND COALESCE(terminated_at, now()) > $2::timestamptz
      LIMIT ${MAX_RUNS}`,
    [stream.id, fromD.toISOString(), toD.toISOString()]);

  type Draft = { id: string; start: number; end: number | null; running: boolean;
    task_kind: string | null; instance_type: string | null; lifecycle: string | null; usd: number | null; name: string | null };
  const drafts = new Map<string, Draft>();
  for (const a of acc) {
    drafts.set(a.instance_id, { id: a.instance_id, start: new Date(a.first_at).getTime(), end: new Date(a.last_at).getTime(),
      running: false, task_kind: a.task_kind, instance_type: a.instance_type, lifecycle: a.lifecycle,
      usd: a.usd_in_period == null ? null : Number(a.usd_in_period), name: a.name_at_run ?? null });
  }
  for (const i of inst) {
    const d = drafts.get(i.id);
    const start = new Date(i.launched_at).getTime();
    const end = i.terminated_at ? new Date(i.terminated_at).getTime() : null;
    if (d) { d.start = start; d.end = end; d.running = end == null; }
    else {
      // Not metered yet (the meter runs on the fleet pass): a run all the same.
      drafts.set(i.id, { id: i.id, start, end, running: end == null, task_kind: i.task_kind,
        instance_type: i.instance_type, lifecycle: i.lifecycle, usd: null, name: null });
    }
  }
  if (keyless.length) notes.push('Some runs predate the run identity that survives deletion, so they are re-assembled from the usage meter and their stop reason is unknown.');
  if (!acc.length && !inst.length) notes.push('No runs in this period. Runs are read from the usage meter, which only records where the fleet pass has run.');

  // ---- why each run ended ---------------------------------------------------
  const ids = [...drafts.keys()].filter((k) => !k.startsWith('legacy-'));
  const stops = new Map<string, any>();
  if (ids.length) {
    for (const s of await query<any>(`SELECT instance_id, intent, origin FROM run_stops WHERE instance_id = ANY($1::uuid[])`, [ids])) {
      stops.set(s.instance_id, s);
    }
  }

  // ---- on air ---------------------------------------------------------------
  const ledger = await query<any>(
    `SELECT from_at, to_at FROM air_sessions
      WHERE account_id = $1 AND stream_id = $2
        AND from_at < $4::timestamptz AND COALESCE(to_at, now()) > $3::timestamptz`,
    [accountId, stream.id, fromD.toISOString(), toD.toISOString()]);
  let airWindows: Interval[] = ledger.map((r) => ({ from: new Date(r.from_at).getTime(), to: r.to_at ? new Date(r.to_at).getTime() : nowMs }));
  let airBasis: StreamReport['air_basis'] = 'ledger';
  if (stream.kind === 'event' && !airWindows.length) {
    if (stream.exists) {
      // publicLive.ts: public while running inside [public_start, public_end], an unset bound being open.
      const pw: Interval = { from: stream.publicStart ? new Date(stream.publicStart).getTime() : -Infinity,
                             to: stream.publicEnd ? new Date(stream.publicEnd).getTime() : Infinity };
      airWindows = [...drafts.values()].map((d) => ({ from: Math.max(d.start, pw.from), to: Math.min(d.end ?? nowMs, pw.to) }))
        .filter((w) => w.to > w.from);
      airBasis = 'public_window';
      notes.push('Events have no on-air switch. On-air time is the run time inside the event\'s public window, the rule the public player applies.');
    } else {
      airBasis = 'none';
      notes.push('This event has been deleted and its public window with it, so on-air time cannot be derived.');
    }
  }

  // ---- audience, per run ----------------------------------------------------
  const runs: RunRow[] = [];
  const sorted = [...drafts.values()].sort((a, b) => b.start - a.start);
  let notRetained = 0;
  for (const d of sorted) {
    const span: Interval = { from: d.start, to: d.end ?? nowMs };
    const inPeriod: Interval = { from: Math.max(span.from, period.from), to: Math.min(span.to, period.to) };
    const s = stops.get(d.id);
    const stop: StopKind | null = d.running ? null : (s?.intent ?? 'unknown');
    const a = new Date(span.from), b = new Date(span.to);
    let audience: RunRow['audience'];
    if (await rawRetained(accountId, a, b)) {
      const p = await sweepPeak(accountId, stream.assetKind, stream.id, a, b);
      audience = { peak_concurrent: p.peak, peak_at: p.peakAt, peak_basis: p.views || p.peak ? 'exact' : 'no_viewers_recorded',
        day_peak_concurrent: null, views: p.views, unique_viewers: p.uniq, watch_seconds: p.watch };
    } else {
      notRetained++;
      audience = { peak_concurrent: null, peak_at: null, peak_basis: 'not_retained',
        day_peak_concurrent: await dayPeak(accountId, stream.assetKind, stream.id, a, b),
        views: null, unique_viewers: null, watch_seconds: null };
    }
    const row: RunRow = {
      instance_id: d.id,
      name_at_run: d.name ?? stream.name,
      started_at: new Date(d.start).toISOString(),
      ended_at: d.end == null ? null : new Date(d.end).toISOString(),
      running: d.running,
      duration_seconds: Math.max(0, Math.round((span.to - span.from) / 1000)),
      seconds_in_period: overlapSeconds(span, period),
      on_air_seconds: coveredSeconds(inPeriod, airWindows),
      stop, planned_stop: stop == null ? null : isPlanned(stop),
      stop_detail: s?.origin ?? null,
      task_kind: d.task_kind, instance_type: d.instance_type, lifecycle: d.lifecycle,
      audience,
    };
    if (stream.kind === 'radio') row.listeners = await listenerBlock(stream.id, a, b);
    if (opts.includeCost) row.cost_basis_usd = d.usd == null ? null : Math.round(d.usd * 1e4) / 1e4;
    runs.push(row);
  }
  if (notRetained) notes.push(`${notRetained} run(s) are older than the account's raw analytics window, so their exact peak is not retained. The highest daily peak on those days is shown instead.`);

  // ---- totals ---------------------------------------------------------------
  const runSeconds = runs.reduce((n, r) => n + r.seconds_in_period, 0);
  // Air time over the PERIOD, not per run: the ledger is the authority, and a
  // window that outlived a run (an encoder restart while on air) is still air.
  const onAir = coveredSeconds(period, airWindows);
  let expected: Interval | null = null;
  let availabilityWindow: StreamReport['totals']['availability_window'] = null;
  if (stream.kind !== 'event') {
    // A 24x7 stream is expected on air for the period, but not before it existed:
    // counting a channel created on the 20th against the 1st to the 19th would
    // report an outage that never happened.
    // Never later than its first recorded run or air window, whatever created_at says.
    const firstSeen = Math.min(...[...drafts.values()].map((d) => d.start), ...airWindows.map((w) => w.from), Infinity);
    const born = Math.min(stream.createdAt ? new Date(stream.createdAt).getTime() : Infinity, firstSeen);
    expected = { from: Math.max(period.from, born), to: period.to };
    availabilityWindow = 'period';
  }
  else if (stream.publicStart || stream.publicEnd) {
    expected = { from: stream.publicStart ? new Date(stream.publicStart).getTime() : (stream.scheduledStart ? new Date(stream.scheduledStart).getTime() : NaN),
                 to: stream.publicEnd ? new Date(stream.publicEnd).getTime() : (stream.scheduledEnd ? new Date(stream.scheduledEnd).getTime() : NaN) };
    availabilityWindow = 'public_window';
  } else if (stream.scheduledStart && stream.scheduledEnd) {
    expected = { from: new Date(stream.scheduledStart).getTime(), to: new Date(stream.scheduledEnd).getTime() };
    availabilityWindow = 'scheduled_window';
  }
  let availability: number | null = null;
  if (expected && Number.isFinite(expected.from) && Number.isFinite(expected.to)) {
    const exp = overlapSeconds(expected, period);
    availability = exp > 0 ? Math.round((coveredSeconds({ from: Math.max(expected.from, period.from), to: Math.min(expected.to, period.to) }, airWindows) / exp) * 10000) / 100 : null;
  }
  if (availability == null) availabilityWindow = null;

  const stopCounts = { planned: 0, unplanned: 0, internal: 0, unknown: 0 };
  for (const r of runs) {
    if (r.stop == null) continue;
    if (isPlanned(r.stop)) stopCounts.planned++;
    else if (r.stop === 'fault') stopCounts.unplanned++;
    else if (r.stop === 'internal') stopCounts.internal++;
    else stopCounts.unknown++;
  }
  const rec = mttr(runs.map((r) => ({ start: Date.parse(r.started_at), end: r.ended_at ? Date.parse(r.ended_at) : null, stop: (r.stop ?? 'unknown') as StopKind })));

  // Period audience. Exact when every day of the period is still raw, otherwise
  // the durable daily rollups, and the basis says which.
  const pa = new Date(period.from), pb = new Date(Math.max(period.from, period.to));
  let peak: number | null = null, peakAt: string | null = null, peakBasis: StreamReport['totals']['peak_basis'] = 'none';
  if (await rawRetained(accountId, pa, pb)) {
    const p = await sweepPeak(accountId, stream.assetKind, stream.id, pa, pb);
    peak = p.peak; peakAt = p.peakAt; peakBasis = 'exact';
  } else {
    peak = await dayPeak(accountId, stream.assetKind, stream.id, pa, pb);
    peakBasis = peak == null ? 'none' : 'daily';
  }
  const roll = await one<any>(
    `SELECT sum(total_views)::bigint AS views, sum(unique_views)::bigint AS uniq, sum(watch_seconds)::bigint AS watch, count(*)::int AS days
       FROM analytics_rollups
      WHERE account_id = $1 AND scope = $2 AND scope_id = $3 AND bucket_date BETWEEN $4::date AND $5::date`,
    [accountId, stream.assetKind, stream.id, pa.toISOString(), pb.toISOString()]);
  const hasRoll = Number(roll?.days ?? 0) > 0;

  const totals: StreamReport['totals'] = {
    runs: runs.length,
    run_seconds: runSeconds,
    on_air_seconds: onAir,
    availability_pct: availability,
    availability_window: availabilityWindow,
    stops: stopCounts,
    mttr_seconds: rec.seconds,
    unrecovered_faults: rec.unrecovered,
    peak_concurrent: peak,
    peak_at: peakAt,
    peak_basis: peakBasis,
    views: hasRoll ? Number(roll.views) : (peakBasis === 'exact' ? 0 : null),
    unique_viewers_daily_sum: hasRoll ? Number(roll.uniq) : (peakBasis === 'exact' ? 0 : null),
    watch_seconds: hasRoll ? Number(roll.watch) : (peakBasis === 'exact' ? 0 : null),
  };
  if (opts.includeCost) {
    const known = runs.map((r) => r.cost_basis_usd).filter((v): v is number => v != null);
    totals.cost_basis_usd = known.length ? Math.round(known.reduce((a, b) => a + b, 0) * 1e4) / 1e4 : null;
  }
  if (drafts.size >= MAX_RUNS) notes.push(`Only the first ${MAX_RUNS} runs are listed. Narrow the period for the rest.`);

  return {
    stream: { id: stream.id, kind: stream.kind, name: stream.name, deleted: !stream.exists },
    period: { from: new Date(period.from).toISOString(), to: new Date(period.to).toISOString() },
    air_basis: airBasis,
    air_windows: mergeIntervals(airWindows.map((w) => ({ from: Math.max(w.from, period.from), to: Math.min(w.to, period.to) })))
      .map((w) => ({ from: new Date(w.from).toISOString(), to: new Date(w.to).toISOString() })),
    notes,
    totals,
    runs,
  };
}

/** MP3 listeners for a station over [a, b), from the relay's own session log. */
async function listenerBlock(channelId: string, a: Date, b: Date) {
  const r = await one<any>(
    `WITH s AS (
       SELECT GREATEST(started_at, $2::timestamptz) AS f,
              LEAST(COALESCE(ended_at, now()), $3::timestamptz) AS t, seconds, bytes, started_at
         FROM listener_sessions
        WHERE (channel_id = $1 OR stream_ref = $1)
          AND started_at < $3::timestamptz AND COALESCE(ended_at, now()) > $2::timestamptz
     ), ev AS (
       SELECT f AS at, 1 AS d FROM s WHERE t > f UNION ALL SELECT t, -1 FROM s WHERE t > f
     ), run AS (SELECT at, sum(d) OVER (ORDER BY at, d ROWS UNBOUNDED PRECEDING) AS c FROM ev)
     SELECT (SELECT count(*) FROM s)::int AS n,
            (SELECT COALESCE(sum(seconds), 0) FROM s)::bigint AS secs,
            (SELECT COALESCE(sum(bytes), 0) FROM s)::bigint AS bytes,
            (SELECT COALESCE(max(c), 0) FROM run)::int AS peak,
            (SELECT at FROM run ORDER BY c DESC, at LIMIT 1) AS peak_at`,
    [channelId, a.toISOString(), b.toISOString()]);
  return { sessions: Number(r?.n ?? 0), listen_seconds: Number(r?.secs ?? 0), bytes: Number(r?.bytes ?? 0),
    peak_concurrent: Number(r?.peak ?? 0), peak_at: r?.peak_at ? new Date(r.peak_at).toISOString() : null };
}

// ---------------------------------------------------------------------------
//  Account period summary: one row per stream that ran or was on air
// ---------------------------------------------------------------------------

export async function streamsInPeriod(accountId: string, from: Date, to: Date): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT DISTINCT stream_id AS id FROM (
       SELECT stream_id FROM usage_accruals
        WHERE account_id = $1 AND stream_id IS NOT NULL AND from_at < $3::timestamptz AND to_at > $2::timestamptz
          AND COALESCE(task_kind, '') <> 'captions'
       UNION ALL
       SELECT stream_id FROM air_sessions
        WHERE account_id = $1 AND from_at < $3::timestamptz AND COALESCE(to_at, now()) > $2::timestamptz
       UNION ALL
       SELECT COALESCE(i.channel_id, i.event_id) FROM instances i
         LEFT JOIN channels c ON c.id = i.channel_id LEFT JOIN events e ON e.id = i.event_id
         JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
        WHERE g.account_id = $1 AND i.launched_at < $3::timestamptz AND COALESCE(i.terminated_at, now()) > $2::timestamptz
          AND COALESCE(i.task_kind, '') <> 'captions'
     ) s LIMIT 2000`, [accountId, from.toISOString(), to.toISOString()]);
  return rows.map((r) => r.id).filter(Boolean);
}

// ---------------------------------------------------------------------------
//  CSV
// ---------------------------------------------------------------------------

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;   // never let a spreadsheet run a cell as a formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const hours = (s: number | null | undefined) => (s == null ? null : Math.round((s / 3600) * 1000) / 1000);

/** One row per run, then a TOTAL row in the same columns, so it sums in a spreadsheet. */
export function streamReportCsv(r: StreamReport, includeCost: boolean): string {
  const cols = ['row', 'stream', 'kind', 'started_at', 'ended_at', 'hours_run', 'hours_on_air', 'stop', 'planned',
    'stop_detail', 'peak_concurrent', 'peak_at', 'peak_basis', 'day_peak_if_not_retained', 'views', 'unique_viewers', 'watch_hours',
    ...(r.stream.kind === 'radio' ? ['mp3_listeners', 'mp3_listen_hours', 'mp3_peak'] : []),
    ...(includeCost ? ['cost_basis_usd'] : [])];
  const lines = [cols.join(',')];
  for (const x of r.runs) {
    lines.push([
      'run', x.name_at_run, r.stream.kind, x.started_at, x.ended_at ?? 'running', hours(x.seconds_in_period), hours(x.on_air_seconds),
      x.stop ?? '', x.planned_stop == null ? '' : x.planned_stop ? 'yes' : 'no', x.stop_detail,
      x.audience.peak_concurrent ?? (x.audience.peak_basis === 'not_retained' ? 'not retained' : ''),
      x.audience.peak_at, x.audience.peak_basis, x.audience.day_peak_concurrent, x.audience.views, x.audience.unique_viewers,
      hours(x.audience.watch_seconds),
      ...(r.stream.kind === 'radio' ? [x.listeners?.sessions, hours(x.listeners?.listen_seconds), x.listeners?.peak_concurrent] : []),
      ...(includeCost ? [x.cost_basis_usd] : []),
    ].map(csvCell).join(','));
  }
  const t = r.totals;
  lines.push([
    'total', r.stream.name, r.stream.kind, r.period.from, r.period.to, hours(t.run_seconds), hours(t.on_air_seconds),
    `planned ${t.stops.planned} / unplanned ${t.stops.unplanned} / unknown ${t.stops.unknown}`, '',
    t.availability_pct == null ? '' : `availability ${t.availability_pct}%`,
    t.peak_concurrent ?? '', t.peak_at, t.peak_basis, '', t.views, t.unique_viewers_daily_sum, hours(t.watch_seconds),
    ...(r.stream.kind === 'radio' ? ['', '', ''] : []),
    ...(includeCost ? [t.cost_basis_usd] : []),
  ].map(csvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}

export interface SummaryRow {
  stream_id: string; name: string; kind: StreamKind; deleted: boolean;
  runs: number; hours_run: number; hours_on_air: number; availability_pct: number | null;
  planned_stops: number; unplanned_stops: number; unknown_stops: number; mttr_seconds: number | null;
  peak_concurrent: number | null; peak_basis: string; views: number | null; watch_hours: number | null;
  cost_basis_usd?: number | null;
}

export function summaryRow(r: StreamReport, includeCost: boolean): SummaryRow {
  const t = r.totals;
  const row: SummaryRow = {
    stream_id: r.stream.id, name: r.stream.name, kind: r.stream.kind, deleted: r.stream.deleted,
    runs: t.runs, hours_run: hours(t.run_seconds)!, hours_on_air: hours(t.on_air_seconds)!, availability_pct: t.availability_pct,
    planned_stops: t.stops.planned, unplanned_stops: t.stops.unplanned, unknown_stops: t.stops.unknown, mttr_seconds: t.mttr_seconds,
    peak_concurrent: t.peak_concurrent, peak_basis: t.peak_basis, views: t.views, watch_hours: hours(t.watch_seconds),
  };
  if (includeCost) row.cost_basis_usd = t.cost_basis_usd ?? null;
  return row;
}

export function summaryCsv(rows: SummaryRow[], includeCost: boolean): string {
  const cols = ['stream_id', 'name', 'kind', 'deleted', 'runs', 'hours_run', 'hours_on_air', 'availability_pct', 'planned_stops',
    'unplanned_stops', 'unknown_stops', 'mttr_seconds', 'peak_concurrent', 'peak_basis', 'views', 'watch_hours',
    ...(includeCost ? ['cost_basis_usd'] : [])];
  return [cols.join(',')].concat(rows.map((r) => cols.map((c) => csvCell((r as any)[c])).join(','))).join('\r\n') + '\r\n';
}
