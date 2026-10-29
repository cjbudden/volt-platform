-- ============================================================================
--  0094: "WHAT CHANGED SINCE" FOR THE MEDIA LIBRARY (GET /api/vod/changes).
--
--  The library grid asks every few seconds, while it is on screen, which
--  assets changed since its last answer (a new image, a title, availability)
--  and updates just those cards. With this index that is a short range scan
--  over the last few seconds of changes, whatever the size of the library.
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_vod_assets_updated_at ON vod_assets (updated_at);
