-- ACCOUNT-WIDE GEO ACCESS (docs/ACCOUNT_SETTINGS.md): where anything of the
-- account may be watched, above every other rule: channels, events, stations,
-- on-demand assets and share links. {"mode":"block"|"allow","countries":["IL"]}
-- or NULL (no account-wide restriction).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS geo_access JSONB;

-- The play gate caches the account's restriction (tag acct:<id>); a change must
-- reach every API process at once, as a suspension already does.
DROP TRIGGER IF EXISTS trg_cache_accounts ON accounts;
CREATE TRIGGER trg_cache_accounts
  AFTER DELETE OR UPDATE OF status, geo_access ON accounts
  FOR EACH ROW EXECUTE FUNCTION volt_cache_notify('acct', 'id');
