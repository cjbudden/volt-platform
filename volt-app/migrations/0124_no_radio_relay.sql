-- ============================================================================
--  No radio relay (build queue 2.1c-2, Christian 3 Nov 2026).
--
--  Stations no longer push MP3 to an Icecast relay. MP3 for listeners is made
--  on demand from the station's HLS by the control plane, and only for an
--  account that has it switched on (by the system admin, while it is decided
--  whether to offer it as a compatibility feed). Off by default.
--
--  The relay tables (relays, relay_accruals, channels.relay_id) are left in
--  place and no longer read: nothing is dropped (rolling deploys run old and
--  new tasks side by side, and no data is deleted).
-- ============================================================================
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS mp3_feed_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN accounts.mp3_feed_enabled IS
  'MP3 for radio listeners, made on demand from the HLS (services/radio/mp3Feed.ts). Off by default (build queue 2.1c-2).';
