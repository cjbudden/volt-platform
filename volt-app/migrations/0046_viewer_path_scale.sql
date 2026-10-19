-- 0046  Viewer path at scale: cache change notifications, batched analytics, pre-warm.
--
-- 1. CHANGE NOTIFICATIONS. The API caches configuration the viewer path reads
--    (keys, apps, asset ownership, availability, rules, the current programme).
--    These triggers announce a changed row on the `volt_cache` channel as a tag
--    ('asset:<id>', 'app:<id>' ...) and every API process drops the entries
--    carrying it. They fire in the writing transaction, so a committed change
--    cannot go unannounced. See src/scale/cache.ts.
--
--    Deliberately NOT triggered: viewers (the cache writes it itself),
--    stream_status and play_sessions (high churn, read with short TTLs), and
--    api_keys.request_count / last_used_at (the usage flush would otherwise
--    invalidate every key every few seconds).
--
-- 2. jsonb_add: sum two {"key": n} maps, so a batch of N sessions folds into
--    a rollup in ONE upsert instead of N jsonb_bump calls on the same row.
--
-- 3. stream_concurrency_parts: per-process viewer counts when no Valkey is
--    configured; stream_concurrency stays the table every reader uses.
--
-- 4. expected_viewers on events and programmes: the scheduler raises the
--    viewer API's minimum capacity ahead of a big start (src/scale/prewarm.ts).

CREATE OR REPLACE FUNCTION volt_cache_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  i   int;
  pfx text;
  col text;
  v   text;
BEGIN
  -- TG_ARGV holds pairs: tag prefix, column name.
  FOR i IN 0 .. (TG_NARGS / 2 - 1) LOOP
    pfx := TG_ARGV[i * 2];
    col := TG_ARGV[i * 2 + 1];
    IF TG_OP <> 'INSERT' THEN
      EXECUTE format('SELECT ($1).%I::text', col) INTO v USING OLD;
      IF v IS NOT NULL THEN PERFORM pg_notify('volt_cache', pfx || ':' || v); END IF;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      EXECUTE format('SELECT ($1).%I::text', col) INTO v USING NEW;
      IF v IS NOT NULL THEN PERFORM pg_notify('volt_cache', pfx || ':' || v); END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_cache_api_keys ON api_keys;
CREATE TRIGGER trg_cache_api_keys
  AFTER INSERT OR DELETE OR UPDATE OF enabled, scopes, kind, app_id, key_hash, account_id ON api_keys
  FOR EACH ROW EXECUTE FUNCTION volt_cache_notify('keyhash', 'key_hash', 'key', 'id');

DROP TRIGGER IF EXISTS trg_cache_accounts ON accounts;
CREATE TRIGGER trg_cache_accounts
  AFTER DELETE OR UPDATE OF status ON accounts
  FOR EACH ROW EXECUTE FUNCTION volt_cache_notify('acct', 'id');

DROP TRIGGER IF EXISTS trg_cache_apps ON apps;
CREATE TRIGGER trg_cache_apps
  AFTER INSERT OR UPDATE OR DELETE ON apps
  FOR EACH ROW EXECUTE FUNCTION volt_cache_notify('app', 'id');

DROP TRIGGER IF EXISTS trg_cache_channels ON channels;
CREATE TRIGGER trg_cache_channels
  AFTER INSERT OR UPDATE OR DELETE ON channels
  FOR EACH ROW EXECUTE FUNCTION volt_cache_notify('asset', 'id');

DROP TRIGGER IF EXISTS trg_cache_events ON events;
CREATE TRIGGER trg_cache_events
  AFTER INSERT OR UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION volt_cache_notify('asset', 'id');

DROP TRIGGER IF EXISTS trg_cache_vod_assets ON vod_assets;
CREATE TRIGGER trg_cache_vod_assets
  AFTER INSERT OR UPDATE OR DELETE ON vod_assets
  FOR EACH ROW EXECUTE FUNCTION volt_cache_notify('asset', 'id');

DROP TRIGGER IF EXISTS trg_cache_programmes ON programmes;
CREATE TRIGGER trg_cache_programmes
  AFTER INSERT OR UPDATE OR DELETE ON programmes
  FOR EACH ROW EXECUTE FUNCTION volt_cache_notify('asset', 'channel_id', 'asset', 'event_id');

DROP TRIGGER IF EXISTS trg_cache_publishing_rules ON publishing_rules;
CREATE TRIGGER trg_cache_publishing_rules
  AFTER INSERT OR UPDATE OR DELETE ON publishing_rules
  FOR EACH ROW EXECUTE FUNCTION volt_cache_notify('rules', 'account_id');

DROP TRIGGER IF EXISTS trg_cache_output_profiles ON output_profiles;
CREATE TRIGGER trg_cache_output_profiles
  AFTER UPDATE OR DELETE ON output_profiles
  FOR EACH ROW EXECUTE FUNCTION volt_cache_notify('profile', 'id');

DROP TRIGGER IF EXISTS trg_cache_entitlements ON entitlements;
CREATE TRIGGER trg_cache_entitlements
  AFTER INSERT OR UPDATE OR DELETE ON entitlements
  FOR EACH ROW EXECUTE FUNCTION volt_cache_notify('viewer', 'viewer_id');

DROP TRIGGER IF EXISTS trg_cache_player_configs ON player_configs;
CREATE TRIGGER trg_cache_player_configs
  AFTER INSERT OR UPDATE OR DELETE ON player_configs
  FOR EACH ROW EXECUTE FUNCTION volt_cache_notify('playercfg', 'account_id');

-- {"a":1,"b":2} + {"a":3} = {"a":4,"b":2}
CREATE OR REPLACE FUNCTION jsonb_add(a jsonb, b jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb)
    FROM (
      SELECT k, SUM(v::numeric) AS v
        FROM (
          SELECT key AS k, value::text AS v FROM jsonb_each(COALESCE(a, '{}'::jsonb))
          UNION ALL
          SELECT key, value::text FROM jsonb_each(COALESCE(b, '{}'::jsonb))
        ) s
       GROUP BY k
    ) t
$$;

CREATE TABLE IF NOT EXISTS stream_concurrency_parts (
    process_id  TEXT NOT NULL,
    account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    asset_kind  TEXT NOT NULL,
    asset_id    TEXT NOT NULL,
    concurrent  INTEGER NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (asset_kind, asset_id, process_id)
);
CREATE INDEX IF NOT EXISTS idx_conc_parts_updated ON stream_concurrency_parts(updated_at);

ALTER TABLE events     ADD COLUMN IF NOT EXISTS expected_viewers INTEGER;
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS expected_viewers INTEGER;
