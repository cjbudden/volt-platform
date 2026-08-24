// ============================================================================
//  ANALYTICS RETENTION — seal the summaries, then age out the raw.
//
//  The requirement, plainly: reports keep working for as long as anyone wants to
//  look at them; what ages out is the raw event data they were computed from.
//
//  That is only safe under one ordering, and the ordering is the whole design:
//
//      RECOMPUTE  ->  SEAL  ->  PRUNE
//
//  Prune before sealing and the number is gone. There is no recovering it, and
//  the report does not go missing — it quietly becomes wrong, which is worse.
//  So the prune here is not allowed to touch a day whose rollup is not sealed,
//  and that is enforced in the query rather than trusted to call order.
//
//  A day is recomputed from raw sessions while its raw data still exists, which
//  makes the rollup authoritative rather than a running approximation. It is
//  sealed once the day is over AND out of the raw window, after which it is
//  never touched again.
//
//  UNIQUE VIEWS. The incremental path added one to total_views and one to
//  unique_views per session, so the two were always equal. Uniqueness cannot be
//  counted from a stream one event at a time — it needs the set. It is computed
//  here, from distinct viewers in the day, and frozen at the seal.
// ============================================================================
import { query, one } from '../db';

export interface SealResult {
  recomputed: number;
  sealed: number;
  /** Days that could not be sealed, and why. */
  skipped: { day: string; scope: string; reason: string }[];
}

export interface PruneResult {
  sessionsDeleted: number;
  accountsConsidered: number;
  /** Days whose raw data was left alone because their summary is not sealed.
   *  Counted rather than swallowed: this is the number that says the safety
   *  ordering is doing something. */
  heldForUnsealed: number;
}

/** How long an account keeps raw session rows. NULL means forever. */
async function rawWindowDays(accountId: string): Promise<number | null> {
  const a = await one<{ d: number | null }>(
    `SELECT analytics_raw_retention_days AS d FROM accounts WHERE id = $1`, [accountId]
  );
  return a?.d ?? null;
}

/**
 * Recompute a day's rollups from the raw sessions that produced them.
 *
 * Authoritative, unlike the incremental path: it counts what is there rather
 * than what has been added since the row was created. Both scopes are rebuilt —
 * the account total and each asset — from one pass over the day.
 */
export async function recomputeDay(accountId: string, day: string): Promise<number> {
  // account scope
  await query(
    `INSERT INTO analytics_rollups
       (account_id, scope, scope_id, bucket_date, total_views, unique_views,
        peak_concurrent, watch_seconds, blocked_count, by_app, by_device, by_geo,
        sessions_counted, recomputed_at)
     SELECT $1, 'account', NULL, $2::date,
            count(*)::bigint,
            count(DISTINCT COALESCE(ip_hash, session_key))::bigint,
            0,
            COALESCE(sum(seconds_watched), 0)::bigint,
            count(*) FILTER (WHERE blocked)::bigint,
            -- The breakdowns are set by the statement below, as real aggregates.
            '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
            count(*)::bigint, now()
       FROM play_sessions s
      WHERE s.account_id = $1 AND s.started_at >= $2::date AND s.started_at < $2::date + 1
     ON CONFLICT (account_id, scope, scope_id, bucket_date) DO UPDATE SET
       total_views      = EXCLUDED.total_views,
       unique_views     = EXCLUDED.unique_views,
       watch_seconds    = EXCLUDED.watch_seconds,
       blocked_count    = EXCLUDED.blocked_count,
       sessions_counted = EXCLUDED.sessions_counted,
       recomputed_at    = EXCLUDED.recomputed_at
     WHERE analytics_rollups.sealed = false`,
    [accountId, day]
  );

  // The breakdowns, computed as real aggregates rather than accumulated counters.
  await query(
    `WITH d AS (
       SELECT * FROM play_sessions
        WHERE account_id = $1 AND started_at >= $2::date AND started_at < $2::date + 1
     )
     UPDATE analytics_rollups r SET
       by_app    = COALESCE((SELECT jsonb_object_agg(COALESCE(app_id::text,'none'), c)
                               FROM (SELECT app_id, count(*) c FROM d GROUP BY app_id) x), '{}'::jsonb),
       by_device = COALESCE((SELECT jsonb_object_agg(COALESCE(device_type,'Unknown'), c)
                               FROM (SELECT device_type, count(*) c FROM d GROUP BY device_type) y), '{}'::jsonb),
       by_geo    = COALESCE((SELECT jsonb_object_agg(COALESCE(geo_country,'ZZ'), c)
                               FROM (SELECT geo_country, count(*) c FROM d GROUP BY geo_country) z), '{}'::jsonb)
      WHERE r.account_id = $1 AND r.scope = 'account' AND r.scope_id IS NULL
        AND r.bucket_date = $2::date AND r.sealed = false`,
    [accountId, day]
  );

  // per-asset scope
  const assets = await query<{ asset_kind: string; asset_id: string }>(
    `SELECT DISTINCT asset_kind, asset_id FROM play_sessions
      WHERE account_id = $1 AND started_at >= $2::date AND started_at < $2::date + 1`,
    [accountId, day]
  );
  for (const a of assets) {
    await query(
      `INSERT INTO analytics_rollups
         (account_id, scope, scope_id, bucket_date, total_views, unique_views,
          peak_concurrent, watch_seconds, blocked_count, by_app, by_device, by_geo,
          sessions_counted, recomputed_at)
       SELECT $1, $3, $4, $2::date,
              count(*)::bigint,
              count(DISTINCT COALESCE(ip_hash, session_key))::bigint,
              0,
              COALESCE(sum(seconds_watched), 0)::bigint,
              count(*) FILTER (WHERE blocked)::bigint,
              '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
              count(*)::bigint, now()
         FROM play_sessions
        WHERE account_id = $1 AND asset_kind = $3 AND asset_id = $4
          AND started_at >= $2::date AND started_at < $2::date + 1
       ON CONFLICT (account_id, scope, scope_id, bucket_date) DO UPDATE SET
         total_views      = EXCLUDED.total_views,
         unique_views     = EXCLUDED.unique_views,
         watch_seconds    = EXCLUDED.watch_seconds,
         blocked_count    = EXCLUDED.blocked_count,
         sessions_counted = EXCLUDED.sessions_counted,
         recomputed_at    = EXCLUDED.recomputed_at
       WHERE analytics_rollups.sealed = false`,
      [accountId, day, a.asset_kind, a.asset_id]
    );
  }
  return assets.length + 1;
}

/**
 * Recompute and seal every day that is finished and out of the raw window.
 *
 * A day is sealed only when its raw data is COMPLETE — the day is over — and it
 * is about to leave the window. Sealing a day still accumulating would freeze a
 * partial number; sealing one still inside the window is harmless but pointless,
 * because it can still be recomputed.
 */
export async function sealDueDays(opts: { limit?: number } = {}): Promise<SealResult> {
  const res: SealResult = { recomputed: 0, sealed: 0, skipped: [] };
  const accounts = await query<{ id: string; d: number | null }>(
    `SELECT id, analytics_raw_retention_days AS d FROM accounts`
  );

  for (const acct of accounts) {
    // An account that keeps raw data forever never needs a seal: the summary can
    // always be recomputed from what is still there.
    if (acct.d == null) continue;

    const due = await query<{ day: string }>(
      `SELECT DISTINCT to_char(started_at::date, 'YYYY-MM-DD') AS day
         FROM play_sessions
        WHERE account_id = $1
          AND started_at < current_date                       -- the day is over
          AND started_at < current_date - ($2 || ' days')::interval
        ORDER BY 1
        LIMIT $3`,
      [acct.id, acct.d, opts.limit ?? 60]
    );

    for (const { day } of due) {
      // Recompute from complete raw data, THEN seal. Never the other way round.
      res.recomputed += await recomputeDay(acct.id, day);
      const sealed = await query<{ id: string }>(
        `UPDATE analytics_rollups
            SET sealed = true, sealed_at = now()
          WHERE account_id = $1 AND bucket_date = $2::date AND sealed = false
          RETURNING id`,
        [acct.id, day]
      );
      res.sealed += sealed.length;
    }
  }
  return res;
}

/**
 * Delete raw sessions whose day is sealed and out of the window.
 *
 * The `sealed` check is in the DELETE's own predicate rather than in the caller,
 * because this is the one place where getting the order wrong destroys data that
 * cannot be recovered. A day with no rollup at all is treated as unsealed and
 * held: raw data whose summary was never computed is not stale, it is unread.
 */
export async function pruneRawSessions(opts: { limit?: number } = {}): Promise<PruneResult> {
  const res: PruneResult = { sessionsDeleted: 0, accountsConsidered: 0, heldForUnsealed: 0 };
  const accounts = await query<{ id: string; d: number | null }>(
    `SELECT id, analytics_raw_retention_days AS d FROM accounts WHERE analytics_raw_retention_days IS NOT NULL`
  );

  for (const acct of accounts) {
    res.accountsConsidered++;

    const held = await query<{ day: string }>(
      `SELECT DISTINCT to_char(s.started_at::date, 'YYYY-MM-DD') AS day
         FROM play_sessions s
        WHERE s.account_id = $1
          AND s.started_at < current_date - ($2 || ' days')::interval
          AND NOT EXISTS (
            SELECT 1 FROM analytics_rollups r
             WHERE r.account_id = s.account_id AND r.scope = 'account'
               AND r.scope_id IS NULL AND r.bucket_date = s.started_at::date
               AND r.sealed)`,
      [acct.id, acct.d]
    );
    res.heldForUnsealed += held.length;

    const gone = await query<{ id: string }>(
      `DELETE FROM play_sessions s
        WHERE s.account_id = $1
          AND s.started_at < current_date - ($2 || ' days')::interval
          AND EXISTS (
            SELECT 1 FROM analytics_rollups r
             WHERE r.account_id = s.account_id AND r.scope = 'account'
               AND r.scope_id IS NULL AND r.bucket_date = s.started_at::date
               AND r.sealed)
          AND s.id IN (
            SELECT id FROM play_sessions
             WHERE account_id = $1
               AND started_at < current_date - ($2 || ' days')::interval
             LIMIT $3)
        RETURNING s.id`,
      [acct.id, acct.d, opts.limit ?? 20000]
    );
    res.sessionsDeleted += gone.length;
  }
  return res;
}

/** Seal what is due, then prune what is safe. The order is the point. */
export async function sweepAnalytics(): Promise<{ seal: SealResult; prune: PruneResult }> {
  const seal = await sealDueDays();
  const prune = await pruneRawSessions();
  if (seal.sealed || prune.sessionsDeleted || prune.heldForUnsealed) {
    console.log(
      `[analytics] sealed ${seal.sealed} rollup(s), pruned ${prune.sessionsDeleted} raw session(s)` +
      (prune.heldForUnsealed ? `, held ${prune.heldForUnsealed} day(s) whose summary is not sealed` : '')
    );
  }
  return { seal, prune };
}

/** What retention looks like for one account, for the settings screen. */
export async function retentionStatus(accountId: string) {
  const acct = await one<any>(
    `SELECT analytics_raw_retention_days AS days FROM accounts WHERE id = $1`, [accountId]
  );
  const raw = await one<any>(
    `SELECT count(*)::bigint AS sessions,
            to_char(min(started_at), 'YYYY-MM-DD') AS oldest,
            to_char(max(started_at), 'YYYY-MM-DD') AS newest
       FROM play_sessions WHERE account_id = $1`, [accountId]
  );
  const rollups = await one<any>(
    `SELECT count(*)::bigint AS rows,
            count(*) FILTER (WHERE sealed)::bigint AS sealed,
            to_char(min(bucket_date), 'YYYY-MM-DD') AS oldest
       FROM analytics_rollups WHERE account_id = $1`, [accountId]
  );
  return {
    rawRetentionDays: acct?.days ?? null,
    raw: {
      sessions: Number(raw?.sessions ?? 0),
      oldest: raw?.oldest ?? null,
      newest: raw?.newest ?? null,
    },
    reports: {
      days: Number(rollups?.rows ?? 0),
      sealed: Number(rollups?.sealed ?? 0),
      oldest: rollups?.oldest ?? null,
    },
    // Said explicitly because it is the promise being made: reports outlive the
    // events they were computed from.
    note: acct?.days == null
      ? 'Raw session data is kept indefinitely for this account.'
      : `Raw session data is kept for ${acct.days} days. Reports are kept indefinitely, ` +
        `and each day's figures are sealed before its raw data is deleted.`,
  };
}

export async function setRawRetention(accountId: string, days: number | null): Promise<void> {
  if (days != null && (!Number.isInteger(days) || days < 1)) {
    throw Object.assign(new Error('Raw retention must be at least one day, or unset for forever.'),
      { status: 400 });
  }
  await query(`UPDATE accounts SET analytics_raw_retention_days = $2 WHERE id = $1`, [accountId, days]);
}
