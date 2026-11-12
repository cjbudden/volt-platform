-- ============================================================================
--  0174: PUBLIC COLLECTION ANSWERS FOLLOW THEIR COLLECTIONS (build queue C3-2).
--  modules/publicCollections.ts caches a collection's public answer per app
--  and territory group, tagged collection:<id>. These triggers announce a
--  change to a collection (name, order, parent, removal: the old and the new
--  parent too, whose sub-collections list changes) and to its members, on the
--  volt_cache channel, so every API process drops the answers at once
--  (volt_cache_notify() is defined in 0046). Adds triggers only.
-- ============================================================================
DROP TRIGGER IF EXISTS trg_cache_collections ON collections;
CREATE TRIGGER trg_cache_collections
  AFTER INSERT OR UPDATE OR DELETE ON collections
  FOR EACH ROW EXECUTE FUNCTION volt_cache_notify('collection', 'id', 'collection', 'parent_id');

DROP TRIGGER IF EXISTS trg_cache_collection_items ON collection_items;
CREATE TRIGGER trg_cache_collection_items
  AFTER INSERT OR UPDATE OR DELETE ON collection_items
  FOR EACH ROW EXECUTE FUNCTION volt_cache_notify('collection', 'collection_id');
