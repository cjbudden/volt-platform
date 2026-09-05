-- ===========================================================================
--  AUDIO EXPORTS ARE AUDIO FILES.
--
--  A radio recording exported for download came out as clip.mp4: an MP4
--  container with nothing but an AAC track in it, offered under a button that
--  said "Download MP4". The extractor was already writing an MP3 beside it for
--  audio sources, and nothing recorded where. So the one file a radio operator
--  actually wants was produced and then lost.
--
--  Two keys, because the two formats serve different people: MP3 plays
--  anywhere and is what gets emailed; M4A is the AAC exactly as broadcast,
--  with no second encode.
-- ===========================================================================
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS export_mp3_key TEXT;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS export_m4a_key TEXT;
