-- ============================================================================
--  0067  FAST PLAYOUTS IN PRODUCTION.  docs/DESIGN_fast_channels.md, section 10.
--
--  One row per FAST channel whose playout should be (or was) running: which
--  launcher started it and its task, and what the playout itself last said.
--
--  STATE IS KEPT HERE, NOT ON THE TASK. A playout's counters (media sequence,
--  discontinuity sequence, the part on air) must survive the task: a Spot
--  interruption or a redeploy starts a new task on another server with an empty
--  disk, and a channel whose media sequence started again from zero would stop
--  every player watching it. The playout sends its state with every heartbeat
--  and asks for it back when it starts.
--
--  last_seen_at is the liveness the public URL trusts: no heartbeat for 30 s and
--  the channel answers "no valid content" rather than a dead manifest.
--
--  vod_assets.encode_result.zeroStart (set by vod.encode from 20 Oct 2026) says
--  an asset's audio and video segments line up, so it can be cut at a break.
--  Assets without it are re-encoded by the fast.prepare job before they air.
-- ============================================================================

CREATE TABLE IF NOT EXISTS fast_playouts (
  channel_id      UUID PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  launcher        TEXT NOT NULL,
  task_ref        TEXT,
  status          TEXT NOT NULL DEFAULT 'starting' CHECK (status IN ('starting', 'running', 'stopped', 'failed')),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ,
  last_pdt        TIMESTAMPTZ,
  media_sequence  BIGINT,
  state           JSONB,
  unreadable      JSONB NOT NULL DEFAULT '[]'::jsonb,
  restarts        INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
