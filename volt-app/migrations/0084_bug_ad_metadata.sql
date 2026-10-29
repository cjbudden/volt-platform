-- BUGS IN THE IMAGE LIBRARY (25 Oct 2026). docs/GRAPHICS_TEMPLATE_STANDARD.md section 10.
-- A bug is an Image Library item of kind 'bug': a still or an alpha video
-- (metadata.motion, services/motionGraphics.ts) put on air by a graphics template such
-- as the Corner bug. Its advertising metadata lives in metadata.ad:
--   { "advertiser", "agency", "campaign", "adCode" }   (adCode: Ad-ID, key number or CAD number)
-- and is searchable: the search vector now includes them.
CREATE OR REPLACE FUNCTION media_files_search_refresh() RETURNS trigger AS $$
BEGIN
  NEW.search :=
      setweight(to_tsvector('simple', coalesce(NEW.name, '') || ' ' || coalesce(NEW.title, '')), 'A')
   || setweight(to_tsvector('simple', array_to_string(NEW.tags, ' ') || ' ' || array_to_string(NEW.keywords, ' ')), 'A')
   || setweight(to_tsvector('simple', coalesce(NEW.metadata->'ad'->>'advertiser', '') || ' ' || coalesce(NEW.metadata->'ad'->>'campaign', '')
        || ' ' || coalesce(NEW.metadata->'ad'->>'agency', '') || ' ' || coalesce(NEW.metadata->'ad'->>'adCode', '')), 'A')
   || setweight(to_tsvector('simple', coalesce(NEW.location, '') || ' ' || coalesce(NEW.metadata->>'programme', '')), 'B')
   || setweight(to_tsvector('simple', coalesce(NEW.description, '') || ' ' || coalesce(NEW.camera, '')
        || ' ' || coalesce(NEW.creator, '') || ' ' || coalesce(NEW.metadata->>'channel', '')), 'C')
   || setweight(to_tsvector('simple', regexp_replace(coalesce(NEW.path, ''), '[/_.-]+', ' ', 'g')), 'D');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
