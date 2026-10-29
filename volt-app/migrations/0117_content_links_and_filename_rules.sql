-- ============================================================================
--  0117: CONTENT LINKS, FILE-NAME RULES AND WHAT THE FILE NAME SAID
--  (docs/DESIGN_filename_metadata.md, services/contentLinks.ts,
--  services/ingest/filenameParse.ts and classify.ts).
--
--  1. CONTENT LINKS. One row per content-link field on an asset: a trailer's
--     "Trailer for" points at the film it promotes. A confirmed link names the
--     record by id (to_asset_id), never by a title string; a name nobody has
--     matched to a record is kept in to_name with to_asset_id NULL (an
--     "unresolved" link). The asset's metadata keeps a copy of the value
--     ({id, name} or {name}) so the metadata form, the EPG and schema.org read
--     it as before. The trigger below keeps the copy right when the target is
--     deleted (the link falls back to its name) or restored from the bin.
--     Why no stored "state" column: a deleted target sets to_asset_id NULL by
--     itself, and the bin restores rows as they were, so the state is read
--     from to_asset_id and never goes out of step.
--  2. FILE-NAME RULES. The account's IF/THEN rules on top of the built-in set
--     in classify.ts, and which built-in rules the account has switched off.
--  3. FILE-NAME SETTINGS. Title case style, the episode title template, and
--     whether a confident type or link is applied without asking.
--  4. vod_assets.filename_analysis: what the file name said, the type it
--     suggested and why, and the related records found, so a person can see
--     the reasoning and correct it.
--  5. The Trailer / promo type's "Trailer for" becomes a content-link field,
--     and existing text values are migrated: a value that is exactly the
--     title of one record in the same account becomes a link to it; anything
--     else is kept as an unresolved name. No value is lost.
-- ============================================================================

CREATE TABLE IF NOT EXISTS content_links (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  from_asset_id  UUID NOT NULL REFERENCES vod_assets(id) ON DELETE CASCADE,
  field_key      TEXT NOT NULL,
  -- services/contentLinks.ts RELATIONS: trailer_for (inverse: trailers), related.
  relation       TEXT NOT NULL,
  to_asset_id    UUID REFERENCES vod_assets(id) ON DELETE SET NULL,
  -- The name shown when there is no record yet, and the target's title when linked.
  to_name        TEXT NOT NULL,
  -- Who decided: a person, the automatic matcher, or this migration.
  source         TEXT NOT NULL CHECK (source IN ('person', 'auto', 'migration')),
  confidence     REAL,
  -- Why, in sentences: [{"text": "..."}]
  reasons        JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Records a person could choose from, when the matcher was not sure:
  -- [{"assetId", "title", "score", "reasons": [...]}]
  candidates     JSONB NOT NULL DEFAULT '[]'::jsonb,
  decided_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_asset_id, field_key),
  CHECK (to_asset_id IS NULL OR to_asset_id <> from_asset_id)
);
CREATE INDEX IF NOT EXISTS idx_content_links_to ON content_links(to_asset_id) WHERE to_asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_content_links_unresolved ON content_links(account_id, relation) WHERE to_asset_id IS NULL;

COMMENT ON TABLE content_links IS
  'Relationships between library records (services/contentLinks.ts). A confirmed link has to_asset_id; an unresolved one has only to_name. vod_assets.metadata keeps a copy of the value, kept in step by trg_content_links_mirror.';

-- Keep the asset's metadata copy in step when the target goes (deleted: the
-- value falls back to its name) or comes back (restored from the bin).
CREATE OR REPLACE FUNCTION content_links_mirror() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.to_asset_id IS DISTINCT FROM OLD.to_asset_id THEN
    UPDATE vod_assets
       SET metadata = jsonb_set(metadata, ARRAY[NEW.field_key],
             CASE WHEN NEW.to_asset_id IS NULL THEN jsonb_build_object('name', NEW.to_name)
                  ELSE jsonb_build_object('id', NEW.to_asset_id::text, 'name', NEW.to_name) END)
     WHERE id = NEW.from_asset_id AND metadata ? NEW.field_key;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_content_links_mirror ON content_links;
CREATE TRIGGER trg_content_links_mirror AFTER UPDATE OF to_asset_id ON content_links
  FOR EACH ROW EXECUTE FUNCTION content_links_mirror();

CREATE TABLE IF NOT EXISTS filename_rules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Set for a row that only switches a built-in rule off or on ('builtin:promo').
  builtin_id  TEXT,
  ordinal     INTEGER NOT NULL DEFAULT 0,
  name        TEXT NOT NULL DEFAULT '',
  enabled     BOOLEAN NOT NULL DEFAULT true,
  -- classify.ts RuleWhen / RuleThen
  "when"      JSONB,
  "then"      JSONB,
  confidence  REAL NOT NULL DEFAULT 0.8,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, builtin_id)
);
CREATE INDEX IF NOT EXISTS idx_filename_rules_account ON filename_rules(account_id, ordinal);

CREATE TABLE IF NOT EXISTS filename_settings (
  account_id        UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  title_case        TEXT NOT NULL DEFAULT 'every' CHECK (title_case IN ('every', 'headline')),
  episode_template  TEXT NOT NULL DEFAULT 'Episode {episode} (S{season})',
  -- Apply a confident type, and a single clear link, without asking.
  auto_type         BOOLEAN NOT NULL DEFAULT true,
  auto_link         BOOLEAN NOT NULL DEFAULT true,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS filename_analysis JSONB;
COMMENT ON COLUMN vod_assets.filename_analysis IS
  'What the original file name said (services/ingest/filenameApply.ts): signals with reasons, the suggested type and why, what was applied, and related records found.';

-- ---- 5. "Trailer for" becomes a content-link field -------------------------
UPDATE metadata_schemas ms
   SET fields = (
     SELECT jsonb_agg(CASE WHEN f->>'key' = 'trailerFor' AND f->>'type' = 'string'
                           THEN f || '{"type": "content", "relation": "trailer_for"}'::jsonb ELSE f END ORDER BY ord)
       FROM jsonb_array_elements(ms.fields) WITH ORDINALITY AS x(f, ord))
 WHERE jsonb_typeof(ms.fields) = 'array' AND ms.fields @> '[{"key": "trailerFor", "type": "string"}]'::jsonb;

-- Existing text values: one exact title match in the same account becomes a
-- link, anything else is kept as a name.
WITH owned AS (
  SELECT v.id, COALESCE(g.account_id, v.account_id) AS acct, v.title, v.metadata
    FROM vod_assets v
    LEFT JOIN channels c ON c.id = v.channel_id
    LEFT JOIN events   e ON e.id = v.event_id
    LEFT JOIN groups   g ON g.id = COALESCE(c.group_id, e.group_id)
), src AS (
  SELECT o.id, o.acct, btrim(o.metadata->>'trailerFor') AS name
    FROM owned o
   WHERE jsonb_typeof(o.metadata->'trailerFor') = 'string' AND btrim(o.metadata->>'trailerFor') <> ''
), hits AS (
  SELECT s.id, s.acct, s.name, count(DISTINCT t.id) AS n, (array_agg(DISTINCT t.id::text))[1]::uuid AS target
    FROM src s
    LEFT JOIN owned t ON t.acct = s.acct AND t.id <> s.id AND (
         lower(btrim(t.title)) = lower(s.name)
      OR lower(btrim(t.metadata->>'title')) = lower(s.name)
      OR lower(btrim(regexp_replace(t.title, '\s*[(\[]\s*(19|20)[0-9]{2}\s*[)\]]\s*$', ''))) = lower(s.name))
   GROUP BY s.id, s.acct, s.name
), ins AS (
  INSERT INTO content_links (account_id, from_asset_id, field_key, relation, to_asset_id, to_name, source, confidence, reasons)
  SELECT h.acct, h.id, 'trailerFor', 'trailer_for', CASE WHEN h.n = 1 THEN h.target END, h.name, 'migration',
         CASE WHEN h.n = 1 THEN 1.0 END,
         jsonb_build_array(jsonb_build_object('text', CASE
           WHEN h.n = 1 THEN 'Moved from the old text field: one record in the library has exactly this title.'
           WHEN h.n = 0 THEN 'Moved from the old text field and kept as a name: no record in the library has this title yet.'
           ELSE 'Moved from the old text field and kept as a name: ' || h.n || ' records have this title, so a person chooses.' END))
    FROM hits h
   WHERE h.acct IS NOT NULL
  ON CONFLICT (from_asset_id, field_key) DO NOTHING
  RETURNING from_asset_id, to_asset_id, to_name
)
UPDATE vod_assets v
   SET metadata = jsonb_set(v.metadata, '{trailerFor}',
         CASE WHEN ins.to_asset_id IS NULL THEN jsonb_build_object('name', ins.to_name)
              ELSE jsonb_build_object('id', ins.to_asset_id::text, 'name', ins.to_name) END)
  FROM ins
 WHERE v.id = ins.from_asset_id;

-- An asset with no account (should not exist) still gets the new shape.
UPDATE vod_assets SET metadata = jsonb_set(metadata, '{trailerFor}', jsonb_build_object('name', btrim(metadata->>'trailerFor')))
 WHERE jsonb_typeof(metadata->'trailerFor') = 'string' AND btrim(metadata->>'trailerFor') <> '';
UPDATE vod_assets SET metadata = metadata - 'trailerFor'
 WHERE jsonb_typeof(metadata->'trailerFor') = 'string';
