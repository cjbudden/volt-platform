-- ============================================================================
--  0078 AD BEACONS: the impression and tracking pixels the stitcher sent for
--  each paid ad it put in a viewer's break (services/fast/beaconSender.ts).
--
--  One row per URL per event per ad per viewer session. The row is written
--  BEFORE the request goes out and the unique key is the claim, so two API
--  tasks answering the same viewer's playlists never send a pixel twice.
--  status / ok / error say what the ad server's tracker answered; ok NULL
--  means it is being sent now (or the process died sending it).
--  Kept as the record of what was reported to the ad server, per break.
-- ============================================================================
CREATE TABLE IF NOT EXISTS ad_beacons (
  id            BIGSERIAL PRIMARY KEY,
  channel_id    UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  break_id      UUID REFERENCES stream_breaks(id) ON DELETE SET NULL,
  session_id    TEXT NOT NULL,
  -- the item's position in the pod, house spots and slate counted
  pod_index     INTEGER NOT NULL,
  ad_id         TEXT,
  creative_key  TEXT,
  -- impression, creativeView, start, firstQuartile, midpoint, thirdQuartile, complete, progress@<offset>
  event         TEXT NOT NULL,
  url_index     INTEGER NOT NULL,
  url           TEXT NOT NULL,
  -- the moment in the stream (PROGRAM-DATE-TIME) the event fell due
  due_at        TIMESTAMPTZ NOT NULL,
  status        INTEGER,
  ok            BOOLEAN,
  error         TEXT,
  elapsed_ms    INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at       TIMESTAMPTZ,
  UNIQUE (session_id, break_id, pod_index, event, url_index)
);
CREATE INDEX IF NOT EXISTS idx_ad_beacons_channel ON ad_beacons(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ad_beacons_break ON ad_beacons(break_id);
