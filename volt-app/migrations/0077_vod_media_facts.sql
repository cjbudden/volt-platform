-- ============================================================================
--  0077 VOD MEDIA FACTS: what an asset's delivered files actually carry
--  (services/media/mediaFacts.ts)
--
--  Read with ffprobe from the asset's own init segments: per video rendition
--  the codec, profile and level; each audio track's codec, channels, sample
--  rate and language; any subtitle tracks. Written when a file encode finishes,
--  and for a recording-derived asset (including a package-only source, whose
--  codec Volt never chose) the first time its Encode tab is opened. The init
--  segments never change once written, so the answer is kept, not re-read.
--  NULL means not read yet, never "no tracks".
-- ============================================================================
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS media_facts JSONB;
COMMENT ON COLUMN vod_assets.media_facts IS
  'ffprobe of the delivered renditions: {how, at, video[{label,codec,profile,level,width,height,fps}], audio[{label,codec,channels,sampleRate,bitrateKbps,language}], subtitles[{codec,language}], run?, runs?}. NULL = not read yet.';
