-- ============================================================================
--  0073: SONG LOOKUPS FROM MORE THAN ONE PROVIDER (services/media/musicLookup.ts).
--
--  MusicBrainz first, then any provider the deployment has switched on
--  (config.trackMeta.providers). The cache remembers which provider answered,
--  where its cover is and its page, and which providers were tried, so a miss
--  recorded when only MusicBrainz was on is looked up again once another
--  provider is enabled.
-- ============================================================================
ALTER TABLE music_lookups ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE music_lookups ADD COLUMN IF NOT EXISTS cover_url TEXT;
ALTER TABLE music_lookups ADD COLUMN IF NOT EXISTS link TEXT;
ALTER TABLE music_lookups ADD COLUMN IF NOT EXISTS providers_tried TEXT;

-- ============================================================================
--  IMAGE FIELDS. Content types get a field type `image`: an Image Library
--  reference, or a web address that is downloaded into the library on save
--  (services/media/libraryImages.ts). The standard types' logo, image,
--  thumbnail, artwork and poster fields were `url` and become `image`; values
--  already saved are web addresses, which an image field still accepts.
--  Custom types are left alone: their owners choose.
-- ============================================================================
UPDATE metadata_schemas s
   SET fields = (SELECT jsonb_agg(CASE WHEN f->>'type' = 'url' AND f->>'key' IN ('logo','image','thumbnail','artwork','poster')
                                       THEN jsonb_set(f, '{type}', '"image"') ELSE f END ORDER BY ord)
                   FROM jsonb_array_elements(s.fields) WITH ORDINALITY AS t(f, ord)),
       updated_at = now()
 WHERE s.is_standard AND jsonb_typeof(s.fields) = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.fields) f WHERE f->>'type' = 'url' AND f->>'key' IN ('logo','image','thumbnail','artwork','poster'));

-- ============================================================================
--  ONE RATE BUDGET FOR THE WHOLE PLATFORM (services/rateGate.ts).
--  MusicBrainz limits calls per IP, not per process: two workers each keeping
--  their own one-a-second gate make two a second and get the IP blocked for
--  everyone. Each call reserves the next free slot here, atomically.
-- ============================================================================
CREATE TABLE IF NOT EXISTS rate_gates (
  name     TEXT PRIMARY KEY,
  next_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  calls    BIGINT NOT NULL DEFAULT 0,
  day      DATE NOT NULL DEFAULT current_date,
  day_calls INTEGER NOT NULL DEFAULT 0
);
