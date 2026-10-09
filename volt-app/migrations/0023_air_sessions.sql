-- ===========================================================================
--  HOW LONG WAS IT ON AIR? THE ONE QUESTION THE SYSTEM COULD NOT ANSWER.
--
--  `channels.on_air` is a boolean. It says what is true now and nothing about
--  how it got there, so "total hours on air" -- the figure a client with an SLA
--  actually asks for -- had no source at all:
--
--    * a CHANNEL going on or off air ran `UPDATE channels SET on_air = $1` and
--      left no trace whatsoever;
--    * a RADIO station wrote a channel.air / channel.off_air event, which is
--      better, except stream_events has no retention rule and an operator can
--      now clear it from the station page with one button. A metric a Clear
--      button can destroy is not a metric;
--    * an EVENT carries public_start / public_end, but those are a PLAN written
--      at creation. Nothing observes them, so they say what was intended rather
--      than what happened.
--
--  So: a ledger, one row per window of public delivery, closed when it ends.
--
--  IDENTITY IS SNAPSHOTTED AND CARRIES NO FOREIGN KEY, for the same reason
--  usage_accruals does it (migration 0016). Deleting a channel must not delete
--  the record that it was on air for 300 hours last quarter, and renaming one
--  must not retroactively rewrite whose airtime it was. `channel_id` stays for
--  joining to a channel that still exists; `stream_id` and `stream_name` are
--  what the report groups and labels on.
--
--  `to_at IS NULL` MEANS ON AIR RIGHT NOW, so one table answers the live
--  question and the historical one, and the reconciler that already corrects a
--  stale `status` can close a window whose stream is demonstrably not running.
--  Without that, a control plane killed mid-broadcast would leave a window open
--  for ever and the totals would grow on their own.
--
--  THE PARTIAL UNIQUE INDEX IS THE INVARIANT, not a nicety. Two open windows on
--  one stream would overlap, and overlapping windows DOUBLE-COUNT: the sum over
--  a period would exceed the period, which is the kind of wrong that survives
--  review because every individual row looks fine.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS air_sessions (
    id           BIGSERIAL PRIMARY KEY,
    account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

    -- 'channel' | 'radio' | 'event'. Radio is its own kind rather than a
    -- flavour of channel, because that is the vocabulary the console, the
    -- routes and every other report already speak.
    stream_kind  TEXT NOT NULL CHECK (stream_kind IN ('channel', 'radio', 'event')),
    stream_id    UUID NOT NULL,          -- deliberately no FK: outlives the row it names
    stream_name  TEXT NOT NULL,          -- snapshot at the time, so a rename does not rewrite history

    -- Kept for joining while the owner still exists. Nulled by the cascade, at
    -- which point stream_id and stream_name are what is left, which is the point.
    channel_id   UUID REFERENCES channels(id) ON DELETE SET NULL,
    event_id     UUID REFERENCES events(id)   ON DELETE SET NULL,

    from_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    to_at        TIMESTAMPTZ,            -- NULL = still on air
    -- Written at close rather than computed on read: the report sums this
    -- across thousands of rows, and an expression per row is a table scan.
    seconds      INTEGER,

    opened_by    TEXT,                   -- operator label, 'schedule', 'api'
    closed_by    TEXT,
    -- WHY IT ENDED, because "off air" covers an operator finishing a broadcast
    -- and a stream falling over, and a report that cannot tell those apart
    -- cannot produce an availability figure anybody would sign.
    close_reason TEXT,                   -- operator | stream stopped | schedule | fault | reconciled

    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (to_at IS NULL OR to_at >= from_at)
);

-- AT MOST ONE OPEN WINDOW PER STREAM. See the header: overlapping windows make
-- the totals exceed wall-clock time, and every row still looks correct.
CREATE UNIQUE INDEX IF NOT EXISTS uq_air_sessions_open
    ON air_sessions (stream_id) WHERE to_at IS NULL;

-- The report's access path: one stream over a period.
CREATE INDEX IF NOT EXISTS idx_air_sessions_stream
    ON air_sessions (stream_id, from_at DESC);

-- The account-wide monthly summary.
CREATE INDEX IF NOT EXISTS idx_air_sessions_account_period
    ON air_sessions (account_id, from_at DESC);

COMMENT ON TABLE air_sessions IS
  'One row per window of public delivery. to_at NULL means on air now. Identity is snapshotted and FK-free so the record outlives the stream it describes.';
