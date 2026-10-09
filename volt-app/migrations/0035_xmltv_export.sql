-- ===========================================================================
--  XMLTV EXPORT: per-channel XMLTV ids and partner guide feeds.
--
--  xmltv_id is the id a partner sees in <channel id=…> and every programme's
--  channel attribute. NULL means "use our uuid", so nothing has to be set for
--  the export to work. Uniqueness is per ACCOUNT (two tenants may both call a
--  channel "news.example"), enforced by the API since the account is two joins
--  away from the channel.
--
--  An epg_feed is a revocable, read-only, polled URL: what a PVR, an IPTV
--  middleware or a guide aggregator is given. It carries its own scope (which
--  channels, how far back and forward, which time basis), so a partner gets
--  exactly the guide they were meant to and nothing else, and revoking one
--  partner does not disturb another. The raw token is shown once; only its
--  sha256 is kept, same as api_keys and share_links.
-- ===========================================================================
ALTER TABLE channels ADD COLUMN IF NOT EXISTS xmltv_id TEXT;
ALTER TABLE events   ADD COLUMN IF NOT EXISTS xmltv_id TEXT;

CREATE TABLE IF NOT EXISTS epg_feeds (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    token_prefix   TEXT NOT NULL,
    token_hash     TEXT NOT NULL UNIQUE,
    -- scope: NULL channel_ids = every guide-enabled channel of the account,
    -- including ones created after the feed.
    channel_ids    UUID[],
    include_events BOOLEAN NOT NULL DEFAULT false,
    past_days      INTEGER NOT NULL DEFAULT 1  CHECK (past_days BETWEEN 0 AND 31),
    future_days    INTEGER NOT NULL DEFAULT 7  CHECK (future_days BETWEEN 1 AND 62),
    time_basis     TEXT NOT NULL DEFAULT 'scheduled' CHECK (time_basis IN ('scheduled', 'asrun')),
    tz_mode        TEXT NOT NULL DEFAULT 'local' CHECK (tz_mode IN ('local', 'utc')),
    lang           TEXT,
    enabled        BOOLEAN NOT NULL DEFAULT true,
    last_polled_at TIMESTAMPTZ,
    poll_count     BIGINT NOT NULL DEFAULT 0,
    created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_epg_feeds_account ON epg_feeds (account_id);
