-- ============================================================================
--  0085 X ACCESS (build queue 1.14h).
--
--  X charges for its API per post and per read (its pay-per-use API since
--  6 Feb 2026), so it is no longer offered to every account. Two ways in:
--   x_enabled           the platform's own switch, off by default, set by a
--                       system administrator (or the owner of a Volt they run
--                       themselves): X runs on the deployment's X app.
--   x_client_id/_enc    the account's own X developer app: X bills the
--                       customer directly, so it may use X without the switch.
--                       The secret is sealed like social tokens (AES-GCM) and
--                       never returned by the API.
--  With neither, X is not shown or offered; linked X accounts are kept, not
--  deleted, and listed as off.
-- ============================================================================
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS x_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS x_client_id text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS x_client_secret_enc text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS x_app_updated_at timestamptz;
