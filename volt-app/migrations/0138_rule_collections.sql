-- ============================================================================
--  0138: RULE-BASED COLLECTIONS (build queue C1, Publishing Policies design,
--  "Collections, packages and apps").
--
--  Collections are the one editorial grouping. A collection can now carry
--  rules as well as hand-picked media: its members are what the rules match,
--  plus what a person added, minus what a person left out.
--
--    collections.rules        the condition tree, NULL for a hand-made one
--    collections.order_by     manual, or a field to order by
--    collection_items.source  'manual' (a person added it) or 'rule'
--    collection_exclusions    media a person took out of a rule collection,
--                             so the rules do not put it back
--    collection_rechecks      assets changed since they were last matched
--
--  Membership is stored, never worked out per request. A change to an asset
--  queues it here (the trigger below, only once any rule collection exists);
--  the control plane drains the queue in batches and re-matches those assets.
--  Every rule collection is also matched in full each night and after its
--  rules change (rules_checked_at).
--
--  Add only: new columns with defaults, new tables, a trigger.
-- ============================================================================
ALTER TABLE collections ADD COLUMN IF NOT EXISTS rules jsonb;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS order_by text NOT NULL DEFAULT 'manual';
ALTER TABLE collections ADD COLUMN IF NOT EXISTS rules_checked_at timestamptz;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS rules_check_ms integer;
COMMENT ON COLUMN collections.rules IS
  'Rule-based membership (build queue C1): { match: all|any, conditions: [ {field, op, value} | {match, conditions} ] }. NULL: hand-made only.';

ALTER TABLE collection_items ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
DO $$ BEGIN
  ALTER TABLE collection_items ADD CONSTRAINT collection_items_source_ck CHECK (source IN ('manual', 'rule'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS collection_exclusions (
  collection_id uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  vod_asset_id  uuid NOT NULL REFERENCES vod_assets(id) ON DELETE CASCADE,
  excluded_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  excluded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, vod_asset_id)
);
CREATE INDEX IF NOT EXISTS idx_collection_exclusions_asset ON collection_exclusions(vod_asset_id);

CREATE TABLE IF NOT EXISTS collection_rechecks (
  vod_asset_id uuid PRIMARY KEY,
  queued_at    timestamptz NOT NULL DEFAULT now()
);
-- The index the trigger and the passes use to find rule collections is 0139 (built concurrently).

-- A changed asset is queued for re-matching. Only the columns a rule can
-- read count, and only once some account has a rule collection, so accounts
-- without rules pay one indexed EXISTS per insert or matching update.
CREATE OR REPLACE FUNCTION volt_collection_recheck_enqueue() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM collections WHERE rules IS NOT NULL LIMIT 1) THEN
    INSERT INTO collection_rechecks(vod_asset_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS vod_assets_collection_recheck_ins ON vod_assets;
CREATE TRIGGER vod_assets_collection_recheck_ins AFTER INSERT ON vod_assets
  FOR EACH ROW EXECUTE FUNCTION volt_collection_recheck_enqueue();

DROP TRIGGER IF EXISTS vod_assets_collection_recheck_upd ON vod_assets;
CREATE TRIGGER vod_assets_collection_recheck_upd AFTER UPDATE ON vod_assets
  FOR EACH ROW WHEN (
       OLD.title IS DISTINCT FROM NEW.title
    OR OLD.metadata IS DISTINCT FROM NEW.metadata
    OR OLD.schema_id IS DISTINCT FROM NEW.schema_id
    OR OLD.rights_profile_id IS DISTINCT FROM NEW.rights_profile_id
    OR OLD.duration_ms IS DISTINCT FROM NEW.duration_ms
    OR OLD.availability_state IS DISTINCT FROM NEW.availability_state
    OR OLD.review_state IS DISTINCT FROM NEW.review_state
    OR OLD.channel_id IS DISTINCT FROM NEW.channel_id
    OR OLD.event_id IS DISTINCT FROM NEW.event_id
    OR OLD.first_aired_at IS DISTINCT FROM NEW.first_aired_at
    OR OLD.available_from IS DISTINCT FROM NEW.available_from
    OR OLD.original_filename IS DISTINCT FROM NEW.original_filename
    OR OLD.source_kind IS DISTINCT FROM NEW.source_kind
    OR OLD.media_state IS DISTINCT FROM NEW.media_state)
  EXECUTE FUNCTION volt_collection_recheck_enqueue();

-- A date read from free-form metadata: NULL instead of an error when it is not a date.
CREATE OR REPLACE FUNCTION volt_try_timestamptz(t text) RETURNS timestamptz
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF t IS NULL OR t = '' THEN RETURN NULL; END IF;
  RETURN t::timestamptz;
EXCEPTION WHEN others THEN RETURN NULL;
END $$;
