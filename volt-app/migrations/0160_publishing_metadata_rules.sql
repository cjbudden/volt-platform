-- ============================================================================
--  0160: THE METADATA-RULE RUNG (build queue P3-3, PUBLISHING_POLICIES.md).
--
--  An ordered list of conditions on a title's metadata, tags, collections or
--  source, each choosing a policy. The first rule that matches applies, and it
--  sits above the owner rung (Christian, 11 Nov):
--
--    account < content type < owner < metadata rule < asset
--
--  so an EPL match is treated the same from a channel, an event or an upload,
--  and a title's own override still beats it. Locks from a lower rung hold.
--
--  Its own table rather than a fourth scope_kind in publishing_rules: a rule
--  here has an order and conditions, and a release still running beside this
--  one lists every publishing_rules row as a channel or event rule.
--
--  A change to what a rule can read on a published title marks it for the
--  restamp sweep (services/availability.ts restampStale), so the title takes
--  up the rule it now matches within about a minute. Only accounts with a
--  metadata rule pay for it: the triggers check that first.
--
--  Add only: a new table, new functions and triggers.
-- ============================================================================
CREATE TABLE IF NOT EXISTS publishing_metadata_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- 0 is checked first.
  position      int NOT NULL DEFAULT 0,
  name          text NOT NULL,
  -- The condition tree of collection rules (services/collectionRules.ts).
  conditions    jsonb NOT NULL,
  -- A policy, as a publishing_rules row holds it.
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  locked_fields text[] NOT NULL DEFAULT '{}',
  preset_key    text,
  enabled       boolean NOT NULL DEFAULT true,
  version       int NOT NULL DEFAULT 1,
  created_by    uuid,
  updated_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pub_meta_rules_account ON publishing_metadata_rules(account_id, position);

-- A published title whose metadata, tags, type or source changed is stamped
-- again. BEFORE UPDATE, so it is the same write. The restamp itself writes
-- only availability columns, which are not watched, so it cannot loop.
CREATE OR REPLACE FUNCTION volt_metadata_rule_mark() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.availability_state IN ('scheduled', 'available')
     AND EXISTS (SELECT 1 FROM publishing_metadata_rules LIMIT 1) THEN
    NEW.policy_stale_at := COALESCE(NEW.policy_stale_at, now());
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS vod_assets_metadata_rule_mark ON vod_assets;
CREATE TRIGGER vod_assets_metadata_rule_mark BEFORE UPDATE ON vod_assets
  FOR EACH ROW WHEN (
       OLD.title IS DISTINCT FROM NEW.title
    OR OLD.metadata IS DISTINCT FROM NEW.metadata
    OR OLD.schema_id IS DISTINCT FROM NEW.schema_id
    OR OLD.rights_profile_id IS DISTINCT FROM NEW.rights_profile_id
    OR OLD.duration_ms IS DISTINCT FROM NEW.duration_ms
    OR OLD.review_state IS DISTINCT FROM NEW.review_state
    OR OLD.channel_id IS DISTINCT FROM NEW.channel_id
    OR OLD.event_id IS DISTINCT FROM NEW.event_id
    OR OLD.first_aired_at IS DISTINCT FROM NEW.first_aired_at
    OR OLD.original_filename IS DISTINCT FROM NEW.original_filename
    OR OLD.source_kind IS DISTINCT FROM NEW.source_kind)
  EXECUTE FUNCTION volt_metadata_rule_mark();

-- Going into or out of a collection can change the rule a title matches.
CREATE OR REPLACE FUNCTION volt_metadata_rule_mark_member() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE aid uuid;
BEGIN
  aid := CASE WHEN TG_OP = 'DELETE' THEN OLD.vod_asset_id ELSE NEW.vod_asset_id END;
  IF EXISTS (SELECT 1 FROM publishing_metadata_rules LIMIT 1) THEN
    UPDATE vod_assets SET policy_stale_at = now()
     WHERE id = aid AND availability_state IN ('scheduled', 'available') AND policy_stale_at IS NULL;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS collection_items_metadata_rule_mark ON collection_items;
CREATE TRIGGER collection_items_metadata_rule_mark AFTER INSERT OR DELETE ON collection_items
  FOR EACH ROW EXECUTE FUNCTION volt_metadata_rule_mark_member();
