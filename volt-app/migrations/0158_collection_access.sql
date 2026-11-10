-- ============================================================================
--  0158: COLLECTION ACCESS BY APP AND REGION (build queue C2, Publishing
--  Policies design, "Collections, packages and apps").
--
--  A collection can carry access: where it applies (all apps or chosen apps,
--  the world or chosen territories) and, region by region, what a viewer
--  needs there (free, members, or premium with the products that unlock it,
--  priced per app when the apps sell it differently). A collection that is
--  premium somewhere is a package there. A child collection inherits its
--  parent's access and can only tighten it.
--
--    collections.access             what the collection says, NULL: inherits
--    vod_assets.collection_access   what governs the title: the collections
--                                   it is in that ask for more than free,
--                                   each with its chain of ancestors,
--                                   compiled so the play gate reads it from
--                                   the cached availability row (no query)
--    collection_access_rechecks     titles to compile again
--
--  Most restrictive wins per app and region: the play gate takes the highest
--  requirement of every collection the title is in, and buying any of the
--  packages that ask for it unlocks it.
--
--  Add only: new nullable columns, a new table, a trigger.
-- ============================================================================
ALTER TABLE collections ADD COLUMN IF NOT EXISTS access jsonb;
COMMENT ON COLUMN collections.access IS
  'Access by app and region (build queue C2): { apps: "all" | [app ids], territories: { mode: world|allow|block, countries }, rules: [ { id, countries, access: free|members|premium, terms, appTerms } ] }. NULL: inherits the parent''s, else All apps, Global, All access.';

ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS collection_access jsonb;
COMMENT ON COLUMN vod_assets.collection_access IS
  'Compiled by services/collectionAccess.ts from the collections the title is in (build queue C2). NULL: no collection asks for more than free.';

CREATE TABLE IF NOT EXISTS collection_access_rechecks (
  vod_asset_id uuid PRIMARY KEY,
  queued_at    timestamptz NOT NULL DEFAULT now()
);

-- A title put into or taken out of a collection is compiled again. Only once
-- some collection carries access (an account without any pays one indexed
-- EXISTS), or when the title was governed before and may now be free.
CREATE OR REPLACE FUNCTION volt_collection_access_enqueue() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE aid uuid;
BEGIN
  aid := CASE WHEN TG_OP = 'DELETE' THEN OLD.vod_asset_id ELSE NEW.vod_asset_id END;
  IF EXISTS (SELECT 1 FROM collections WHERE access IS NOT NULL LIMIT 1)
     OR (TG_OP = 'DELETE' AND EXISTS (SELECT 1 FROM vod_assets WHERE id = aid AND collection_access IS NOT NULL)) THEN
    INSERT INTO collection_access_rechecks(vod_asset_id) VALUES (aid) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS collection_items_access_recheck ON collection_items;
CREATE TRIGGER collection_items_access_recheck AFTER INSERT OR DELETE ON collection_items
  FOR EACH ROW EXECUTE FUNCTION volt_collection_access_enqueue();
