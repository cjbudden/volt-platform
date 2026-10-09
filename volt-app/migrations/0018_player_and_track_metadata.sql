-- ============================================================================
--  THE EMBEDDABLE PLAYER, AND WHAT IT PUTS ON THE SCREEN.
--
--  Three tables, and each exists because of one specific way this goes wrong.
--
--  ------------------------------------------------------------------------
--  1. track_metadata — THE CACHE THAT MAKES THE LOOKUP LEGAL.
--
--  A station's ICY metadata gives a string: "Fleetwood Mac - Dreams". Turning
--  that into an album and a cover means asking MusicBrainz, and MusicBrainz
--  permits ONE REQUEST PER SECOND per application, enforced by IP blocking.
--
--  Without a cache that is not merely slow, it is a breach. One station
--  changes track every three minutes, which is fine; a hundred stations with
--  every player instance triggering its own lookup is thousands of requests a
--  minute from one address, and the address gets blocked for every tenant at
--  once. So the lookup is server-side, once per distinct track, and the result
--  is kept.
--
--  MISSES ARE CACHED TOO, and that is the half people forget. MusicBrainz does
--  not know every track — live edits, station idents, local repertoire, a
--  brand-new single. An un-cached miss is retried on every poll for as long as
--  that track is playing, which is the worst offender of all because it never
--  succeeds and never stops. `state` distinguishes a hit from a miss from a
--  transient failure, and each gets its own retry rule.
--
--  ------------------------------------------------------------------------
--  2. player_configs — THE SKIN, SAVED.
--
--  Keyed to a channel, so a station's player looks the same wherever it is
--  embedded and can be restyled without anyone re-editing the embed code on
--  the sites carrying it. Colours are stored as plain hex rather than a theme
--  name because the point is that a customer matches their own brand.
--
--  ------------------------------------------------------------------------
--  3. player_events — REPORTING, AT PLAYER GRANULARITY.
--
--  Deliberately NOT play_sessions. That table answers "how many people are
--  watching", which is an audience question aggregated per asset. This answers
--  "is the player working", which is an engineering question about one embed
--  on one site: did the bundle load, did the manifest resolve, did it error,
--  did the listener press play. Mixing them would corrupt the audience figures
--  with events that are not viewing, and would lose the diagnostic detail in
--  an aggregate nobody can debug from.
--
--  It carries the ORIGIN the event came from, because "the player errors, but
--  only on one of the four sites it is embedded on" is the commonest support
--  question and is unanswerable without it.
-- ============================================================================

-- ---------- the track metadata cache ---------------------------------------
CREATE TABLE IF NOT EXISTS track_metadata (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The NORMALISED lookup key: lowercased, punctuation and bracketed
    -- suffixes stripped, artist and title joined. Normalisation is what makes
    -- the cache actually hit: the same song arrives as "Fleetwood Mac -
    -- Dreams", "FLEETWOOD MAC - DREAMS (2004 Remaster)" and
    -- "Fleetwood Mac  -  Dreams" from three different stations, and three
    -- cache misses for one track is three times the rate-limit budget spent.
    norm_key      TEXT NOT NULL,
    -- What was parsed out of the ICY string, kept so a bad parse is visible.
    artist        TEXT,
    title         TEXT,
    -- What the provider said.
    album         TEXT,
    release_group_mbid TEXT,
    recording_mbid     TEXT,
    artwork_url   TEXT,
    year          INTEGER,
    provider      TEXT,
    -- hit      the provider knew it; artwork_url may still be null, because a
    --          release with no uploaded cover is a real and common outcome
    -- miss     the provider does not know this track. Do not keep asking.
    -- error    the lookup failed for a reason that might not recur (timeout,
    --          503, rate limit). Retried, unlike a miss.
    state         TEXT NOT NULL DEFAULT 'hit' CHECK (state IN ('hit', 'miss', 'error')),
    attempts      INTEGER NOT NULL DEFAULT 1,
    looked_up_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The raw ICY string that produced this, for diagnosing a parse that went
    -- wrong. One example is enough; it is overwritten on each refresh.
    raw_sample    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_track_metadata_key ON track_metadata (norm_key);
CREATE INDEX IF NOT EXISTS idx_track_metadata_retry
  ON track_metadata (looked_up_at) WHERE state = 'error';

-- ---------- saved player configurations -------------------------------------
CREATE TABLE IF NOT EXISTS player_configs (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    -- The station this player is for. A config with no channel is an account
    -- level DEFAULT, applied to any station that has not been given its own.
    channel_id     UUID REFERENCES channels(id) ON DELETE CASCADE,
    name           TEXT NOT NULL DEFAULT 'Default',
    layout         TEXT NOT NULL DEFAULT 'card' CHECK (layout IN ('card', 'bar', 'hero')),
    -- Plain hex, because the point is matching a customer's own brand rather
    -- than choosing from a set of themes we invented.
    primary_color   TEXT NOT NULL DEFAULT '#3f7bff',
    secondary_color TEXT NOT NULL DEFAULT '#0f1218',
    -- Everything else the layouts read: artwork on/off, show the track title,
    -- autoplay, preferred delivery format, custom CSS hook. JSONB because the
    -- set grows with each layout and a column per option would not.
    options        JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- What the player shows when there is no track metadata. Falls back to the
    -- channel's own name when null, which is the common case.
    fallback_title TEXT,
    fallback_text  TEXT,
    fallback_artwork_url TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One config per station. A second one for the same station would leave the
-- embed code ambiguous about which it gets.
CREATE UNIQUE INDEX IF NOT EXISTS idx_player_configs_channel
  ON player_configs (channel_id) WHERE channel_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_player_configs_account_default
  ON player_configs (account_id) WHERE channel_id IS NULL;

-- ---------- player telemetry ------------------------------------------------
CREATE TABLE IF NOT EXISTS player_events (
    id           BIGSERIAL PRIMARY KEY,
    account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    channel_id   UUID REFERENCES channels(id) ON DELETE SET NULL,
    app_id       UUID REFERENCES apps(id) ON DELETE SET NULL,
    -- A player instance, generated client side. Lets one embed's events be
    -- read as a sequence (loaded -> manifest -> play -> error) rather than as
    -- unrelated rows, which is the difference between a log and a diagnosis.
    session_id   TEXT NOT NULL,
    event        TEXT NOT NULL,
    -- WHERE it was embedded. The commonest support question is "it works on
    -- one of our sites and not the other", and nothing else here can answer it.
    origin       TEXT,
    layout       TEXT,
    -- Error code / manifest URL / position, per event type.
    detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
    at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_player_events_account_at ON player_events (account_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_player_events_channel_at ON player_events (channel_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_player_events_session ON player_events (session_id, at);
-- Swept like the other telemetry; this is diagnostics, not a billable record.
CREATE INDEX IF NOT EXISTS idx_player_events_at ON player_events (at);
