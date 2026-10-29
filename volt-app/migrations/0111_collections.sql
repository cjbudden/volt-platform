-- ============================================================================
--  0111: COLLECTIONS. Hand-made, nested groupings of library assets.
--
--  A collection is the operator's own shelf: "BEATLINE" with sub-collections
--  "Week 44: Monsoon Chill", "Week 45: Retro Malaysia"... An asset can sit in
--  any number of collections, and a collection keeps its own order (a week's
--  playlist is an ordered thing), so membership is a join row with a position.
--
--  Collections never own media. Deleting a collection (and with it, its
--  sub-collections) removes the groupings only; the assets stay in the
--  library. Deleting an asset drops it from every collection.
-- ============================================================================
CREATE TABLE IF NOT EXISTS collections (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  parent_id   UUID REFERENCES collections(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description TEXT,
  -- a swatch to tell collections apart in the tree (#rrggbb), optional
  color       TEXT CHECK (color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$'),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX IF NOT EXISTS idx_collections_account_parent ON collections(account_id, parent_id);
-- one name per level: two "Week 44" under BEATLINE would be ambiguous in a picker
CREATE UNIQUE INDEX IF NOT EXISTS uq_collections_name_per_level
  ON collections(account_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name)));

CREATE TABLE IF NOT EXISTS collection_items (
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  vod_asset_id  UUID NOT NULL REFERENCES vod_assets(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  added_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, vod_asset_id)
);
CREATE INDEX IF NOT EXISTS idx_collection_items_asset ON collection_items(vod_asset_id);
CREATE INDEX IF NOT EXISTS idx_collection_items_order ON collection_items(collection_id, position);
