-- ============================================================================
--  0148: PUBLISHING POLICIES 1: lifecycle and public status (build queue P1,
--  PUBLISHING_POLICIES.md "Lifecycle model").
--
--  People set intent (draft, published, archived, the dates); Volt computes
--  what a viewer gets now (services/publicStatus.ts). The new columns:
--
--    listed_from    when a Scheduled title appears in browse and search as a
--                   teaser (no playable URL). NULL: when it becomes available.
--    unlisted       playable by link or API, never in browse and search.
--    archived_at/by the Archived editorial state: off the catalogue, not
--                   playable, media kept, restorable.
--    public_status, status_reason, status_until, status_at
--                   the computed answer, stored so a public list can filter on
--                   it in SQL; status_until is the next moment it can change.
--                   NULL until the availability sweep first computes a row
--                   (it fills every existing asset within minutes, 500 a tick).
--
--  Add only (RELEASING.md "Schema: add only"): nullable columns and one with a
--  default, which old tasks never read. The index on status_until is built
--  concurrently in 0149.
-- ============================================================================
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS listed_from   timestamptz;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS unlisted      boolean NOT NULL DEFAULT false;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS archived_at   timestamptz;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS archived_by   text;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS public_status text
  CHECK (public_status IS NULL OR public_status IN ('draft', 'in_review', 'changes_requested', 'rejected', 'processing',
                                                    'scheduled', 'available', 'restricted', 'expired', 'archived'));
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS status_reason text;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS status_until  timestamptz;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS status_at     timestamptz;

COMMENT ON COLUMN vod_assets.public_status IS
  'What a viewer gets now, computed by services/publicStatus.ts from the editorial state, dates, media and rights. Only available (and scheduled past listed_from) is public. Build queue P1.';
COMMENT ON COLUMN vod_assets.status_until IS
  'The next moment public_status can change on its own; the availability sweep recomputes the row then.';
