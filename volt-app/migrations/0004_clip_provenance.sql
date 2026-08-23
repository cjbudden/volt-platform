-- ============================================================================
--  CLIP PROVENANCE — what a VOD asset was actually built from.
--
--  A vod_assets row says "this clip covers 14:05 to 14:20 on channel X". That is
--  a claim about intent, not a record of fact, and the two come apart the moment
--  anything downstream needs to be trusted: which capture runs contributed, which
--  broadcast days it crossed, whether the source media still exists, whether the
--  ends were trimmed or taken whole. Rights, takedowns, re-cuts and audits all
--  ask questions of that shape, and none of them can be answered from a pair of
--  timestamps.
--
--  So the chain is stored, one row per contiguous block of source media, in the
--  order the block appears in the finished clip:
--
--    channel/event -> recording_container (broadcast day)
--                  -> recording           (the capture row)
--                  -> run + rendition     (the media on disk)
--                  -> segment seq range   (the physical files)
--                  -> the clip            (offset and trim within it)
--
--  Deliberately ON DELETE SET NULL for the sources and ON DELETE CASCADE for the
--  asset. Retention will eventually take the source recording away, and when it
--  does the provenance must SURVIVE, with the link gone but the run id, segment
--  range and times still readable. A chain that disappears the moment the media
--  is pruned answers questions only while nobody needs to ask them. The asset
--  going away is different: its provenance is meaningless without it.
--
--  Granularity is the contiguous block, not the individual segment. A block is
--  contiguous by construction (see clips/resolve.ts), so a first and last
--  sequence number describes it exactly, and an hour-long clip records a handful
--  of rows instead of nine hundred.
-- ============================================================================

CREATE TABLE IF NOT EXISTS clip_segments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vod_asset_id      uuid NOT NULL REFERENCES vod_assets(id) ON DELETE CASCADE,

  -- Position of this block within the finished clip, from 0.
  ordinal           int  NOT NULL,

  -- The chain back to the capture. Nullable because retention outlives them.
  recording_id      uuid REFERENCES recordings(id) ON DELETE SET NULL,
  container_id      uuid REFERENCES recording_containers(id) ON DELETE SET NULL,

  -- The media itself, named so it stays meaningful with the rows above gone.
  run_id            text NOT NULL,
  block_index       int  NOT NULL DEFAULT 0,
  rendition         text NOT NULL,
  first_seq         int  NOT NULL,
  last_seq          int  NOT NULL,
  segment_count     int  NOT NULL,

  -- Wall clock of the source media used, and where it lands in the clip.
  source_from_ms    bigint NOT NULL,
  source_to_ms      bigint NOT NULL,
  clip_offset_ms    bigint NOT NULL,
  duration_ms       bigint NOT NULL,

  -- Whether the ends were cut inside a segment. A block with neither flag set
  -- was taken whole, which is what makes a re-cut cheap and a claim verifiable.
  partial_head      boolean NOT NULL DEFAULT false,
  partial_tail      boolean NOT NULL DEFAULT false,

  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT clip_segments_ordinal_unique UNIQUE (vod_asset_id, ordinal),
  CONSTRAINT clip_segments_seq_order      CHECK (last_seq >= first_seq),
  CONSTRAINT clip_segments_time_order     CHECK (source_to_ms > source_from_ms)
);

CREATE INDEX IF NOT EXISTS idx_clip_segments_asset     ON clip_segments (vod_asset_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_clip_segments_recording ON clip_segments (recording_id);
CREATE INDEX IF NOT EXISTS idx_clip_segments_container ON clip_segments (container_id);
-- "What was cut from this run?" is the question a takedown or a re-encode asks.
CREATE INDEX IF NOT EXISTS idx_clip_segments_run       ON clip_segments (run_id, first_seq);

-- ---------------------------------------------------------------------------
--  Counts on the asset itself.
--
--  Derivable from clip_segments, and stored anyway, because these are the
--  numbers a list view sorts and filters on and a per-row aggregate over a
--  provenance table is the wrong shape for that. Written once when extraction
--  finishes, from the same resolution the media was built from, so they cannot
--  drift from what was actually done.
-- ---------------------------------------------------------------------------
ALTER TABLE vod_assets
  ADD COLUMN IF NOT EXISTS source_block_count     int,
  ADD COLUMN IF NOT EXISTS source_run_count       int,
  ADD COLUMN IF NOT EXISTS source_container_count int,
  ADD COLUMN IF NOT EXISTS source_segment_count   int,
  ADD COLUMN IF NOT EXISTS source_gap_ms          bigint,
  ADD COLUMN IF NOT EXISTS source_coverage_pct    numeric(5,1),
  -- Which strategy actually produced the media, so a frame-accuracy claim can be
  -- checked later rather than assumed.
  ADD COLUMN IF NOT EXISTS build_strategy         text,
  ADD COLUMN IF NOT EXISTS built_at               timestamptz;

-- A clip that crosses a broadcast day is the normal case for late-night
-- programming, and the list view needs to say so without a join.
CREATE INDEX IF NOT EXISTS idx_vod_assets_multi_day
  ON vod_assets (source_container_count)
  WHERE source_container_count > 1;
