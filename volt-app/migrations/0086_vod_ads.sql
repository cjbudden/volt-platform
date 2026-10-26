-- ============================================================================
--  0086 ON-DEMAND ADS (VOD SSAI, SSAI.md sections 5 to 7).
--
--  vod_ad_rules     where the breaks go in an on-demand asset and who fills
--                   them: one account default (schema_id NULL) and at most one
--                   rule per content type. A title opts out with metadata
--                   adRule = none (or only mid-rolls with no_mid), as on FAST.
--  vod_ad_sessions  one viewer's play of one asset with ads: its delivery
--                   (stitched or guided), its breaks and their pods. The id is
--                   the viewer's capability for its playlists, beacons and clicks.
--  vod_ad_breaks    one decision per break per session (fill, fallback, time),
--                   the record the on-demand ad report reads.
--  vod_ad_events    what was reported to the ad servers: impressions, quartiles,
--                   player events and clicks, each tracking URL claimed once.
--
--  FAST clicks use ad_beacons (event 'click'), so they need nothing here.
-- ============================================================================
CREATE TABLE IF NOT EXISTS vod_ad_rules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  schema_id     UUID REFERENCES metadata_schemas(id) ON DELETE CASCADE,
  -- off: no ads for this content. on: breaks planned by `policy`, filled by the ad server and house ads.
  mode          TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'on')),
  policy        JSONB NOT NULL DEFAULT '{}'::jsonb,
  ad_server_id  UUID REFERENCES ad_servers(id) ON DELETE SET NULL,
  -- [{assetId, weight}] in-house spots for unfilled time and ad server failures
  house_ads     JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vod_ad_rules_default ON vod_ad_rules(account_id) WHERE schema_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_vod_ad_rules_schema ON vod_ad_rules(account_id, schema_id) WHERE schema_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS vod_ad_sessions (
  id            TEXT PRIMARY KEY,
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  vod_asset_id  UUID NOT NULL REFERENCES vod_assets(id) ON DELETE CASCADE,
  app_id        UUID,
  -- the play attempt (CMCD sid), so the ads join the playback reports
  play_sid      TEXT,
  delivery      TEXT NOT NULL CHECK (delivery IN ('stitched', 'guided')),
  -- deciding: ad decisions in flight; ready: every break decided
  state         TEXT NOT NULL DEFAULT 'deciding' CHECK (state IN ('deciding', 'ready')),
  plan          JSONB NOT NULL DEFAULT '{}'::jsonb,
  ctx           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vod_ad_sessions_asset ON vod_ad_sessions(vod_asset_id, created_at);
CREATE INDEX IF NOT EXISTS idx_vod_ad_sessions_account ON vod_ad_sessions(account_id, created_at);

CREATE TABLE IF NOT EXISTS vod_ad_breaks (
  id            BIGSERIAL PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES vod_ad_sessions(id) ON DELETE CASCADE,
  account_id    UUID NOT NULL,
  vod_asset_id  UUID NOT NULL,
  break_index   INTEGER NOT NULL,
  position      TEXT NOT NULL CHECK (position IN ('pre', 'mid', 'post')),
  content_ms    INTEGER NOT NULL,
  break_ms      INTEGER NOT NULL,
  ad_ms         INTEGER NOT NULL DEFAULT 0,
  house_ms      INTEGER NOT NULL DEFAULT 0,
  ad_server_id  UUID,
  elapsed_ms    INTEGER,
  fallback      TEXT,
  problems      JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, break_index)
);
CREATE INDEX IF NOT EXISTS idx_vod_ad_breaks_account ON vod_ad_breaks(account_id, created_at);

CREATE TABLE IF NOT EXISTS vod_ad_events (
  id            BIGSERIAL PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES vod_ad_sessions(id) ON DELETE CASCADE,
  account_id    UUID NOT NULL,
  vod_asset_id  UUID NOT NULL,
  break_index   INTEGER NOT NULL,
  pod_index     INTEGER NOT NULL,
  ad_id         TEXT,
  creative_key  TEXT,
  -- impression, start, quartiles, complete, progress@<offset>, player events (pause, mute...), click
  event         TEXT NOT NULL,
  -- which tracking URL of the event (-1: an event with no URL to send, kept for the counts)
  url_index     INTEGER NOT NULL,
  url           TEXT,
  status        INTEGER,
  ok            BOOLEAN,
  error         TEXT,
  elapsed_ms    INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at       TIMESTAMPTZ,
  UNIQUE (session_id, break_index, pod_index, event, url_index)
);
CREATE INDEX IF NOT EXISTS idx_vod_ad_events_account ON vod_ad_events(account_id, created_at);
