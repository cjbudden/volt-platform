-- ============================================================================
--  0089 METADATA LISTS: the account's own pick lists (docs/DESIGN_media_library.md §3.5).
--
--  The first is the GENRE list. Until now the genres a station, a channel, an
--  event, a song, an episode and a movie could carry were a fixed platform
--  list copied into each standard type. A client now keeps one list of its
--  own (Admin > Genres): add, rename, reorder, retire. Every content type
--  field that says `"optionsList": "genres"` takes its options from it.
--
--  items   ordered [{ "value": "News" }, { "value": "Talk", "retired": true }]
--          A retired value stays valid on whatever already carries it but is
--          no longer offered for new metadata.
--  An account with no row uses the platform default list (services/metadataLists.ts).
-- ============================================================================
CREATE TABLE IF NOT EXISTS metadata_lists (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  list_key    TEXT NOT NULL,
  items       JSONB NOT NULL DEFAULT '[]'::jsonb,
  version     INTEGER NOT NULL DEFAULT 1,
  updated_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, list_key)
);

-- Link the genre fields of the standard types that still carry the platform
-- list unchanged. A field a client already edited by hand keeps its own
-- options and stays unlinked; the Content Types editor can link it later.
UPDATE metadata_schemas ms
   SET fields = (
     SELECT jsonb_agg(CASE
              WHEN f->>'type' = 'enum' AND f->>'key' IN ('genre', 'category') AND NOT (f ? 'optionsList')
               AND f->'options' = '["News","Talk","Sport","Music","Classical","Jazz","Rock","Pop","Dance","Community","Religious","Education","Entertainment","Drama","Documentary","Children","Other"]'::jsonb
              THEN f || '{"optionsList":"genres"}'::jsonb ELSE f END ORDER BY ord)
       FROM jsonb_array_elements(ms.fields) WITH ORDINALITY AS e(f, ord)),
       updated_at = now()
 WHERE ms.is_standard
   AND jsonb_typeof(ms.fields) = 'array'
   AND jsonb_array_length(ms.fields) > 0
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(ms.fields) f
                WHERE f->>'type' = 'enum' AND f->>'key' IN ('genre', 'category') AND NOT (f ? 'optionsList')
                  AND f->'options' = '["News","Talk","Sport","Music","Classical","Jazz","Rock","Pop","Dance","Community","Religious","Education","Entertainment","Drama","Documentary","Children","Other"]'::jsonb);
