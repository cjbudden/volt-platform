// ============================================================================
//  BILLABLE USAGE, READ BACK.
//
//  The unit here is TIME, not money. Seconds of compute that a stream caused to
//  exist. A rate table is present and accruals carry a frozen rate, but nothing
//  in this module leads with a currency figure: an indicative dollar number
//  shown next to a real minute count gets quoted as though both were real, and
//  only one of them is.
//
//  ------------------------------------------------------------------------
//  ACCRUED plus PENDING, and they are reported separately.
//
//  The ledger only knows what the meter has written. A channel that started
//  four minutes ago has, at most, the last tick in the ledger and the rest
//  still running. Reporting only the ledger makes a live stream look like it
//  has barely used anything; silently adding the remainder makes it impossible
//  to tell a settled figure from a moving one.
//
//  So both are returned. `accrued` is what is written down and will not
//  change. `pending` is the time since each running task's mark, which is real
//  usage that has not been settled yet. Their sum is the answer to "how much
//  so far", and the split is the answer to "is this final".
//
//  Everything here is TENANT SCOPED at the query, not filtered afterwards. The
//  account is on the accrual row precisely so this cannot be got wrong.
// ============================================================================
import { query } from '../../db';

export type PeriodKind = 'day' | 'week' | 'month' | 'year';

const TRUNC: Record<PeriodKind, string> = {
  day: 'day', week: 'week', month: 'month', year: 'year',
};

/** Guard the interpolation into date_trunc. Never trust a query string here. */
function truncOf(p: PeriodKind): string {
  const t = TRUNC[p];
  if (!t) throw Object.assign(new Error(`unknown period: ${p}`), { status: 400 });
  return t;
}

export interface UsageBucket {
  periodStart: string;
  seconds: number;
  /** Distinct machines that carried this account's work in the period. */
  serversUsed: number;
  /** Distinct task runs, which is not the same as streams. */
  taskRuns: number;
  streams: number;
  byTaskKind: Record<string, number>;
}

/**
 * A time series of billable seconds for one account.
 *
 * `servers_used` counts DISTINCT hosts, which is the figure that answers "how
 * many servers did we use in March". Summing a per-day server count across a
 * month would multiply-count the machine that ran all month, so the monthly
 * figure has to be computed at monthly granularity rather than derived from
 * the daily one. That is why period_kind is a parameter here rather than
 * something the caller rolls up itself.
 */
export async function usageSeries(
  accountId: string,
  period: PeriodKind,
  limit = 30,
): Promise<UsageBucket[]> {
  const t = truncOf(period);
  const rows = await query<any>(
    `SELECT date_trunc('${t}', from_at) AS period_start,
            SUM(seconds)::bigint                                     AS seconds,
            COUNT(DISTINCT host_id)::int                             AS servers_used,
            COUNT(DISTINCT instance_id)::int                         AS task_runs,
            COUNT(DISTINCT stream_id)::int                           AS streams
       FROM usage_accruals a
      WHERE a.account_id = $1
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT $2`,
    [accountId, limit]
  );
  // The by-kind split is deliberately a SECOND query rather than an aggregate
  // folded in here. jsonb_object_agg over per-row values does not sum: it keeps
  // whichever value the planner emitted last for a repeated key, so a channel
  // with forty accruals in a day would report the duration of one of them.
  // Two clean GROUP BYs are correct where one clever one is not.
  const kinds = await usageByKind(accountId, period, limit);
  return rows.map((r) => {
    const b = shapeBucket(r);
    b.byTaskKind = kinds[b.periodStart] ?? {};
    return b;
  });
}

function shapeBucket(r: any): UsageBucket {
  return {
    periodStart: new Date(r.period_start).toISOString(),
    seconds: Number(r.seconds ?? 0),
    serversUsed: Number(r.servers_used ?? 0),
    taskRuns: Number(r.task_runs ?? 0),
    streams: Number(r.streams ?? 0),
    byTaskKind: {},
  };
}

/** Billable seconds per period, split by kind of work. */
export async function usageByKind(
  accountId: string,
  period: PeriodKind,
  limit = 30,
): Promise<Record<string, Record<string, number>>> {
  const t = truncOf(period);
  const rows = await query<any>(
    `SELECT date_trunc('${t}', from_at) AS period_start,
            COALESCE(task_kind, 'unknown') AS kind,
            SUM(seconds)::bigint AS seconds
       FROM usage_accruals
      WHERE account_id = $1
      GROUP BY 1, 2
      ORDER BY 1 DESC
      LIMIT $2`,
    [accountId, limit * 6]
  );
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const key = new Date(r.period_start).toISOString();
    (out[key] ??= {})[r.kind] = Number(r.seconds ?? 0);
  }
  return out;
}

export interface StreamUsage {
  id: string;
  kind: 'channel' | 'event';
  name: string | null;
  /** Radio stations are channels; the sub-kind matters for reporting. */
  channelKind: string | null;
  allTimeSeconds: number;
  todaySeconds: number;
  monthSeconds: number;
  /** Seconds since the last mark on anything still running for this stream. */
  pendingSeconds: number;
  runs: number;
  lastUsedAt: string | null;
}

/**
 * Per-stream usage: all time, today, and this month, in one pass.
 *
 * FILTER rather than three queries, because three queries against a growing
 * ledger is three scans, and because the three figures must agree with each
 * other. Computed from the same rows in the same statement, they cannot drift
 * the way separately-timed queries can when an accrual lands between them.
 *
 * "Today" and "this month" are UTC, matching the boundary the meter cuts
 * windows at. Any other boundary would need apportionment of the window that
 * straddles it, and the whole point of cutting at accrual time was to make
 * every reader a plain SUM.
 */
export async function usagePerStream(accountId: string, now: Date = new Date()): Promise<StreamUsage[]> {
  const rows = await query<any>(
    `WITH acc AS (
       -- stream_id, NOT channel_id. The FK'd column is nulled when a channel
       -- is deleted; stream_id has no FK precisely so a deleted channel's
       -- usage history stays attributable. stream_name is the snapshot taken
       -- at accrual time, used only when the live row is gone.
       SELECT a.stream_id                                           AS sid,
              CASE WHEN a.event_id IS NOT NULL THEN 'event' ELSE 'channel' END AS skind,
              a.stream_name, a.seconds, a.from_at, a.instance_id
         FROM usage_accruals a
        WHERE a.account_id = $1
          AND a.stream_id IS NOT NULL
     )
     SELECT sid AS id, skind AS kind,
            (ARRAY_AGG(stream_name ORDER BY from_at DESC) FILTER (WHERE stream_name IS NOT NULL))[1] AS snapshot_name,
            SUM(seconds)::bigint AS all_time,
            SUM(seconds) FILTER (WHERE from_at >= date_trunc('day',   $2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::bigint AS today,
            SUM(seconds) FILTER (WHERE from_at >= date_trunc('month', $2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::bigint AS month,
            COUNT(DISTINCT instance_id)::int AS runs,
            MAX(from_at) AS last_used_at
       FROM acc
      GROUP BY 1, 2`,
    [accountId, now]
  );

  // Names come from the owning tables rather than being denormalised onto the
  // ledger: a renamed channel should read under its current name in a usage
  // report, unlike its account, which must not move.
  const ids = rows.map((r) => r.id);
  const names = new Map<string, { name: string; kind: string | null }>();
  if (ids.length) {
    for (const c of await query<any>(`SELECT id, name, kind FROM channels WHERE id = ANY($1::uuid[])`, [ids])) {
      names.set(c.id, { name: c.name, kind: c.kind });
    }
    for (const e of await query<any>(`SELECT id, name FROM events WHERE id = ANY($1::uuid[])`, [ids])) {
      names.set(e.id, { name: e.name, kind: null });
    }
  }

  const pending = await pendingPerStream(accountId, now);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    // The live name wins: a renamed channel should read under its current
    // name. The snapshot is the fallback for a channel that no longer exists.
    name: names.get(r.id)?.name ?? r.snapshot_name ?? null,
    channelKind: names.get(r.id)?.kind ?? null,
    allTimeSeconds: Number(r.all_time ?? 0),
    todaySeconds: Number(r.today ?? 0),
    monthSeconds: Number(r.month ?? 0),
    pendingSeconds: pending.get(r.id) ?? 0,
    runs: Number(r.runs ?? 0),
    lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
  })).sort((a, b) => b.allTimeSeconds - a.allTimeSeconds);
}

/**
 * Time running but not yet in the ledger, per stream.
 *
 * This is the honest half of a live figure. It is derived from the same mark
 * the meter uses, so `accrued + pending` can never double count: the mark is
 * the exact boundary between them.
 */
export async function pendingPerStream(accountId: string, now: Date = new Date()): Promise<Map<string, number>> {
  const rows = await query<{ sid: string; secs: string }>(
    `SELECT COALESCE(i.channel_id, i.event_id) AS sid,
            SUM(GREATEST(0, EXTRACT(EPOCH FROM ($2::timestamptz - COALESCE(i.metered_through, i.launched_at)))))::bigint AS secs
       FROM instances i
       LEFT JOIN channels c ON c.id = i.channel_id
       LEFT JOIN groups   gc ON gc.id = c.group_id
       LEFT JOIN events   e ON e.id = i.event_id
       LEFT JOIN groups   ge ON ge.id = e.group_id
      WHERE i.terminated_at IS NULL
        AND i.launched_at IS NOT NULL
        AND COALESCE(gc.account_id, ge.account_id) = $1
        AND COALESCE(i.channel_id, i.event_id) IS NOT NULL
      GROUP BY 1`,
    [accountId, now]
  );
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.sid, Number(r.secs ?? 0));
  return m;
}

export interface UsageTotals {
  todaySeconds: number;
  monthSeconds: number;
  allTimeSeconds: number;
  pendingSeconds: number;
  serversToday: number;
  serversMonth: number;
  streamsToday: number;
}

/** The headline figures for one account. */
export async function usageTotals(accountId: string, now: Date = new Date()): Promise<UsageTotals> {
  const r = await query<any>(
    `SELECT
       SUM(seconds)::bigint AS all_time,
       SUM(seconds) FILTER (WHERE from_at >= date_trunc('day',   $2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::bigint AS today,
       SUM(seconds) FILTER (WHERE from_at >= date_trunc('month', $2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::bigint AS month,
       COUNT(DISTINCT host_id) FILTER (WHERE from_at >= date_trunc('day',   $2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS servers_today,
       COUNT(DISTINCT host_id) FILTER (WHERE from_at >= date_trunc('month', $2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS servers_month,
       COUNT(DISTINCT stream_id) FILTER (WHERE from_at >= date_trunc('day', $2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS streams_today
     FROM usage_accruals WHERE account_id = $1`,
    [accountId, now]
  );
  const row = r[0] ?? {};
  const pending = await pendingPerStream(accountId, now);
  let pendingSeconds = 0;
  for (const v of pending.values()) pendingSeconds += v;
  return {
    allTimeSeconds: Number(row.all_time ?? 0),
    todaySeconds: Number(row.today ?? 0),
    monthSeconds: Number(row.month ?? 0),
    pendingSeconds,
    serversToday: Number(row.servers_today ?? 0),
    serversMonth: Number(row.servers_month ?? 0),
    streamsToday: Number(row.streams_today ?? 0),
  };
}
