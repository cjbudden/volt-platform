-- ============================================================================
--  0066  GRAPHICS IN THE PLAYER: what viewers' players draw, and proof they did.
--  docs/REQ_graphics_overlays.md section 13.
--
--  SNAPSHOTS. Values that change by the second (scores, clocks) do not go in
--  manifest triggers (DESIGN_stream_graphics_triggers.md). The player reads a
--  feed instead, and to stay in step with the PICTURE rather than the wall
--  clock it needs the state over time, not just now: a viewer 40 s behind live
--  must see the score change when the try is scored on their screen. The
--  scheduler leader records a snapshot of every live stream's player graphics
--  whenever it changes (at most once a second); the player applies the one in
--  force at its playhead's wall clock (PROGRAM-DATE-TIME). Kept 48 hours, which
--  also covers DVR and same-day replays.
--
--  IMPRESSIONS. One row each time a player graphic comes on screen for a
--  viewer (REQ FR-17).
-- ============================================================================

CREATE TABLE IF NOT EXISTS gfx_snapshots (
  id          BIGSERIAL PRIMARY KEY,
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  channel_id  UUID REFERENCES channels(id) ON DELETE CASCADE,
  event_id    UUID REFERENCES events(id) ON DELETE CASCADE,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- { "<assignmentId>": { "on": true, "v": { field: value } } }
  state       JSONB NOT NULL,
  CHECK ((channel_id IS NULL) <> (event_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_gfx_snap_channel ON gfx_snapshots(channel_id, at DESC) WHERE channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gfx_snap_event   ON gfx_snapshots(event_id, at DESC)   WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gfx_snap_at      ON gfx_snapshots(at);

CREATE TABLE IF NOT EXISTS gfx_impressions (
  id            BIGSERIAL PRIMARY KEY,
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  assignment_id UUID REFERENCES gfx_assignments(id) ON DELETE SET NULL,
  channel_id    UUID REFERENCES channels(id) ON DELETE SET NULL,
  event_id      UUID REFERENCES events(id) ON DELETE SET NULL,
  app_id        UUID REFERENCES apps(id) ON DELETE SET NULL,
  session_id    TEXT NOT NULL,
  origin        TEXT,
  shown_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  on_screen_ms  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_gfx_impr_assignment ON gfx_impressions(assignment_id, shown_at DESC);
CREATE INDEX IF NOT EXISTS idx_gfx_impr_account ON gfx_impressions(account_id, shown_at DESC);
