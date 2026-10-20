-- ============================================================================
--  0065  FAST / VOD-TO-LIVE CHANNELS: lineups, ad breaks, ad servers, house
--  ads, conditioned creatives, decision log.  docs/DESIGN_fast_channels.md
--
--  CHANNEL ORIGIN     a channel is fed by a live source ('live', every channel
--                     until now) or built from the library by a lineup
--                     ('playlist'). A playlist channel has no encoder: the
--                     FAST playout writes its playlists from packaged VOD.
--  LINEUP             the run order (slots) plus its controls. VERSIONED: an
--                     edit to an active lineup is a new version whose epoch
--                     carries the cycle and series pointers on, so nothing
--                     restarts. One active version per channel.
--  STREAM BREAKS      every ad break on every stream, whoever caused it: a
--                     FAST lineup, a live source's SCTE-35, an operator, the
--                     API. THE one signal graphics, the stitcher, the guide
--                     and reporting all read.
--  AD SERVERS         a commercial ad decision server, as a VAST tag template.
--  CHANNEL ADS        per channel: the break policy, the mode (off / markers
--                     only / stitched), the ad server, the house ads.
--  AD CREATIVES       the conditioning cache: an ad server's creative, keyed
--                     by its Universal Ad ID, packaged once to the ladder as a
--                     vod_asset, then reused by every break and every viewer.
--  AD DECISIONS       one row per decision, for fill rate and fallback reports.
-- ============================================================================

ALTER TABLE channels ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'live';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'channels_origin_ck') THEN
    ALTER TABLE channels ADD CONSTRAINT channels_origin_ck CHECK (origin IN ('live', 'playlist'));
  END IF;
END $$;

-- Editorial break points in an asset (chapter / act breaks), milliseconds.
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS break_cues_ms INTEGER[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS fast_lineups (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id    UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name          TEXT NOT NULL DEFAULT 'Lineup',
  version       INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  -- when pass `epoch_cycle` starts; series already consumed at that point
  epoch         TIMESTAMPTZ NOT NULL,
  epoch_cycle   INTEGER NOT NULL DEFAULT 0,
  -- where in the run order that pass starts (an edit continues mid-pass)
  epoch_slot    INTEGER NOT NULL DEFAULT 0,
  series_start  JSONB NOT NULL DEFAULT '{}'::jsonb,
  zone          TEXT NOT NULL DEFAULT 'UTC',
  slots         JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- cycleShift, anchor, gridMin, backfill, seed, horizonDays
  settings      JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- how far the guide has been written from this version
  applied_from  TIMESTAMPTZ,
  applied_until TIMESTAMPTZ,
  applied_at    TIMESTAMPTZ,
  previous_id   UUID REFERENCES fast_lineups(id) ON DELETE SET NULL,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fast_lineups_channel ON fast_lineups(channel_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fast_lineups_one_active ON fast_lineups(channel_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS stream_breaks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id    UUID REFERENCES channels(id) ON DELETE CASCADE,
  event_id      UUID REFERENCES events(id) ON DELETE CASCADE,
  programme_id  UUID REFERENCES programmes(id) ON DELETE CASCADE,
  source        TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('fast', 'scte35', 'manual', 'api')),
  source_ref    TEXT,
  starts_at     TIMESTAMPTZ NOT NULL,
  duration_ms   INTEGER NOT NULL CHECK (duration_ms > 0),
  -- 'mid' inside a programme, 'end' between programmes, 'live' on a live feed
  position      TEXT NOT NULL DEFAULT 'live' CHECK (position IN ('mid', 'end', 'live')),
  -- where the content pauses, for a FAST break (seconds into the asset)
  at_asset_ms   INTEGER,
  status        TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'aired', 'cancelled')),
  hide_graphics BOOLEAN NOT NULL DEFAULT true,
  scte_event_id BIGINT,
  meta          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((channel_id IS NOT NULL) <> (event_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_breaks_channel_start ON stream_breaks(channel_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_breaks_event_start   ON stream_breaks(event_id, starts_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_breaks_source_ref ON stream_breaks(channel_id, source_ref) WHERE source_ref IS NOT NULL;

-- A break edit reaches the graphics triggers' cache in every process, like a
-- programme edit does (0046).
DROP TRIGGER IF EXISTS trg_cache_stream_breaks ON stream_breaks;
CREATE TRIGGER trg_cache_stream_breaks
  AFTER INSERT OR UPDATE OR DELETE ON stream_breaks
  FOR EACH ROW EXECUTE FUNCTION volt_cache_notify('asset', 'channel_id', 'asset', 'event_id');

CREATE TABLE IF NOT EXISTS ad_servers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  -- a label for the console; every vendor is driven through its VAST tag
  vendor        TEXT NOT NULL DEFAULT 'vast'
                  CHECK (vendor IN ('vast', 'gam', 'freewheel', 'springserve', 'magnite', 'publica', 'beachfront', 'other')),
  tag_template  TEXT NOT NULL,
  timeout_ms    INTEGER NOT NULL DEFAULT 1500 CHECK (timeout_ms BETWEEN 200 AND 5000),
  max_wrappers  INTEGER NOT NULL DEFAULT 5 CHECK (max_wrappers BETWEEN 0 AND 10),
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ad_servers_account ON ad_servers(account_id);

CREATE TABLE IF NOT EXISTS channel_ads (
  channel_id    UUID PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  -- off: no breaks.  markers: breaks with SCTE-35 and house fill (a FAST
  -- platform does the ad insertion).  stitched: our stitcher asks the ad server.
  mode          TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'markers', 'stitched')),
  policy        JSONB NOT NULL DEFAULT '{}'::jsonb,
  ad_server_id  UUID REFERENCES ad_servers(id) ON DELETE SET NULL,
  -- [{assetId, weight}] in-house spots for unfilled time and ad server failures
  house_ads     JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- one decision per break for everyone ('channel') or per viewer ('session')
  decision_scope TEXT NOT NULL DEFAULT 'session' CHECK (decision_scope IN ('channel', 'session')),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ad_creatives (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  creative_key  TEXT NOT NULL,
  source_url    TEXT,
  ad_system     TEXT,
  title         TEXT,
  vod_asset_id  UUID REFERENCES vod_assets(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'conditioning', 'ready', 'error', 'rejected')),
  duration_ms   INTEGER,
  error         TEXT,
  plays         BIGINT NOT NULL DEFAULT 0,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, creative_key)
);

CREATE TABLE IF NOT EXISTS ad_decisions (
  id            BIGSERIAL PRIMARY KEY,
  channel_id    UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  break_id      UUID REFERENCES stream_breaks(id) ON DELETE SET NULL,
  session_id    TEXT,
  ad_server_id  UUID REFERENCES ad_servers(id) ON DELETE SET NULL,
  elapsed_ms    INTEGER,
  requests      INTEGER,
  break_ms      INTEGER NOT NULL,
  ad_ms         INTEGER NOT NULL DEFAULT 0,
  house_ms      INTEGER NOT NULL DEFAULT 0,
  slate_ms      INTEGER NOT NULL DEFAULT 0,
  fallback      TEXT,
  problems      JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ad_decisions_channel ON ad_decisions(channel_id, created_at);
