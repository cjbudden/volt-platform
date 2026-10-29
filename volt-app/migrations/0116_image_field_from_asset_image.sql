-- ============================================================================
--  THE METADATA SHOWS THE ASSET'S IMAGE (services/media/assetImage.ts
--  syncImageField). An asset with an image (poster_key) whose content type has
--  a main image field (Image, Thumbnail, Cover, Artwork) left empty gets that
--  image in the field, marked as filled from the asset's image (provenance
--  source 'poster'), so the form shows what the asset already uses. Assets
--  picked from now on are kept in step by the code; this fills the ones that
--  already have an image. A field with a value is never touched.
-- ============================================================================
WITH target AS (
  SELECT v.id, (
           SELECT f->>'key' FROM jsonb_array_elements(s.fields) WITH ORDINALITY AS x(f, n)
            WHERE f->>'type' = 'image' AND f->>'key' IN ('image', 'artwork', 'picture', 'photo', 'thumbnail', 'cover')
            ORDER BY n LIMIT 1) AS k,
         '/' || v.poster_key AS ref
    FROM vod_assets v JOIN metadata_schemas s ON s.id = v.schema_id
   WHERE v.poster_key IS NOT NULL AND jsonb_typeof(s.fields) = 'array'
)
UPDATE vod_assets v
   SET metadata = COALESCE(v.metadata, '{}'::jsonb) || jsonb_build_object(t.k, t.ref),
       metadata_provenance = COALESCE(v.metadata_provenance, '{}'::jsonb) || jsonb_build_object(t.k, jsonb_build_object('source', 'poster', 'at', now()))
  FROM target t
 WHERE v.id = t.id AND t.k IS NOT NULL
   AND COALESCE(btrim(v.metadata->>t.k), '') = '';
