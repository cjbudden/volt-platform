-- ============================================================================
--  LISTENER SESSIONS — the only place egress is a FACT rather than an estimate.
--
--  Relay cost is bytes served, and every figure we could produce for it until
--  now was inferred: bitrate multiplied by an assumed duration, or a host's
--  net_out_bps integrated across a window and then divided among the stations
--  that happened to be on that host. Both are estimates of an estimate.
--
--  The on-demand MP3 gateway (services/radio/mp3Gateway.ts) terminates the
--  listener connection itself, so it WROTE every byte it reports. One row per
--  listener, closed when they leave, with the measured count.
--
--  WHAT THIS MAKES ANSWERABLE, none of which it was before:
--    - how many people listened to this station, and for how long
--    - how many bytes that cost, per station and per ACCOUNT
--    - which accounts drive the relay bill, for pricing rather than guesswork
--
--  PRIVACY. There is no IP address here. `ip_hash` is a salted truncated hash,
--  which is enough to count uniques and spot abuse and not enough to identify
--  anybody, and it is the same posture play_sessions already takes for viewers.
-- ============================================================================

CREATE TABLE IF NOT EXISTS listener_sessions (
    id            BIGSERIAL PRIMARY KEY,
    channel_id    UUID REFERENCES channels(id) ON DELETE SET NULL,
    account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

    -- THE SAME IDENTITY WITHOUT THE FOREIGN KEY. Deleting a channel nulls
    -- channel_id above and would otherwise take its listening history with it,
    -- retroactively, for months already reported. A usage record must outlive
    -- the thing it records. Same reasoning as usage_accruals.stream_id.
    stream_ref    UUID,

    started_at    TIMESTAMPTZ NOT NULL,
    ended_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    seconds       INTEGER NOT NULL,

    -- MEASURED, not derived. This is the whole point of the table: the gateway
    -- counted these bytes as it wrote them, including the interleaved ICY
    -- metadata blocks, which are also egress somebody pays for.
    bytes         BIGINT NOT NULL DEFAULT 0,
    bitrate_kbps  INTEGER,

    -- Salted, truncated. Enough to count uniques, not enough to identify.
    ip_hash       TEXT,
    user_agent    TEXT,
    geo_country   TEXT,

    -- WHY IT ENDED, because the reasons are not equivalent and a platform that
    -- cannot tell them apart cannot tell a popular station from a broken one:
    --   client_closed   they stopped listening. Normal.
    --   too_slow        we dropped them: they could not keep up and were being
    --                   buffered. A rising count here is a capacity problem.
    --   feed_stopped    the transcode died under them.
    --   write_failed    the socket broke.
    --   shutdown        we were restarted.
    ended_reason  TEXT,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (ended_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_listener_sessions_channel
  ON listener_sessions (channel_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_listener_sessions_account_window
  ON listener_sessions (account_id, started_at);
-- For the monthly roll-up that turns sessions into an egress figure.
CREATE INDEX IF NOT EXISTS idx_listener_sessions_window
  ON listener_sessions (started_at);
