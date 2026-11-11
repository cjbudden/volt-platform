-- ============================================================================
--  0164: COPY-BEFORE-DELETE FOR ORIGINALS (build queue H3-5, decided by
--  Christian on 11 Nov 2026; HYBRID_SITES.md "Add-on: Mirror and Archive").
--
--  A retention rule can now remove an asset's ORIGINAL file from the cloud a
--  number of days after it landed, and only once a verified archive copy of
--  that very file is held at one of the account's storage targets. The
--  encoded renditions stay, so the title keeps playing; the original comes
--  back from the archive when it is needed for a re-encode.
--
--  include_uploads: an account-level rule now also reaches uploads and watch
--  folder files (assets with no channel or event) by the asset's own account.
--  Existing rules keep their reach (false); a rule created from this release
--  on starts with it switched on (services/media/retention.ts saveRule), so
--  nothing changes for existing accounts on release.
--
--  On the asset: when the original was removed, which file it was (for the
--  restore) and the copy that made it safe; and, while it waits, why, so the
--  console can say it.
--
--  Add only (RELEASING.md "Schema: add only"): nullable columns and a column
--  with a default.
-- ============================================================================
ALTER TABLE retention_rules ADD COLUMN IF NOT EXISTS original_after_days integer;
ALTER TABLE retention_rules ADD COLUMN IF NOT EXISTS include_uploads boolean NOT NULL DEFAULT false;

ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS original_removed_at  timestamptz;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS original_removed_key text;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS original_copy_id     uuid;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS original_wait_code   text;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS original_wait        text;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS original_checked_at  timestamptz;
