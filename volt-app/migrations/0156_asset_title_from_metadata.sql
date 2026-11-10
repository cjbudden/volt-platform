-- ============================================================================
--  0156: an asset's title is the Title in its metadata.
--
--  Saving the metadata form now names the asset after its Title field
--  (modules/vod.ts, PUT /vod/:id), as the file-name reader, the EPG fill and
--  the ingest form already did. Assets saved before that kept the name their
--  file arrived with ("Caminandes Episode 2" with a Title of "Episode 2"), so
--  bring those into line once. Only assets with a content type and a Title.
-- ============================================================================
UPDATE vod_assets
   SET title = btrim(metadata->>'title')
 WHERE schema_id IS NOT NULL
   AND NULLIF(btrim(metadata->>'title'), '') IS NOT NULL
   AND title IS DISTINCT FROM btrim(metadata->>'title');
