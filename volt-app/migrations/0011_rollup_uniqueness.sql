-- ============================================================================
--  The account-scope rollup had no uniqueness at all.
--
--  analytics_rollups is keyed UNIQUE (account_id, scope, scope_id, bucket_date),
--  and the account-wide scope stores scope_id as NULL. In a standard unique
--  constraint Postgres treats NULLs as DISTINCT FROM EACH OTHER, so any number
--  of rows with scope_id NULL are allowed — the constraint simply does not apply
--  to them.
--
--  The consequence is worse than a duplicate row. Every upsert of the account
--  total carried `ON CONFLICT (account_id, scope, scope_id, bucket_date) DO
--  UPDATE`, and that conflict never fired, so each write INSERTED instead of
--  accumulating. A day's account figures were spread across one row per write,
--  and any report summing them double-counted while any report reading the first
--  row under-reported. Per-asset rows were fine, because their scope_id is never
--  null — which is exactly why this stayed invisible.
--
--  Postgres 15 added NULLS NOT DISTINCT for precisely this, and it keeps the key
--  readable rather than smuggling a sentinel string into a nullable column.
-- ============================================================================

-- Fold any existing duplicates into one row per key before the constraint can
-- refuse them. The surviving row is the oldest; the figures are summed, because
-- every duplicate was a write that should have accumulated into it.
WITH merged AS (
  SELECT account_id, scope, scope_id, bucket_date,
         min(id::text)::uuid                 AS keep_id,
         sum(total_views)                    AS total_views,
         sum(unique_views)                   AS unique_views,
         max(peak_concurrent)                AS peak_concurrent,
         sum(watch_seconds)                  AS watch_seconds,
         sum(blocked_count)                  AS blocked_count,
         count(*)                            AS n
    FROM analytics_rollups
   GROUP BY account_id, scope, scope_id, bucket_date
  HAVING count(*) > 1
)
UPDATE analytics_rollups r SET
  total_views     = m.total_views,
  unique_views    = m.unique_views,
  peak_concurrent = m.peak_concurrent,
  watch_seconds   = m.watch_seconds,
  blocked_count   = m.blocked_count
FROM merged m
WHERE r.id = m.keep_id;

DELETE FROM analytics_rollups r
 USING (
   SELECT account_id, scope, scope_id, bucket_date, min(id::text)::uuid AS keep_id
     FROM analytics_rollups
    GROUP BY account_id, scope, scope_id, bucket_date
   HAVING count(*) > 1
 ) m
 WHERE r.account_id = m.account_id
   AND r.scope = m.scope
   AND r.scope_id IS NOT DISTINCT FROM m.scope_id
   AND r.bucket_date = m.bucket_date
   AND r.id <> m.keep_id;

ALTER TABLE analytics_rollups
  DROP CONSTRAINT IF EXISTS analytics_rollups_account_id_scope_scope_id_bucket_date_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_analytics_rollups_key
  ON analytics_rollups (account_id, scope, scope_id, bucket_date)
  NULLS NOT DISTINCT;
