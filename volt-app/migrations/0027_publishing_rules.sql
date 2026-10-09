-- ===========================================================================
--  PUBLISHING RULES AND AVAILABILITY (docs/DESIGN_media_library.md §4).
--
--  Christian, 5 Sep: a client-level default, overridden by a rule per content
--  type, overridden by a rule per channel / event / station, overridden by the
--  asset itself. Publishing points are only the client's registered apps and
--  its configured social accounts. Availability covers a window, geo, access
--  rights and a paywall, and content can have its access removed.
--
--  ONE TABLE, ONE ROW PER SCOPE. `settings` is a JSONB of the overridable
--  fields; a key that is absent means "inherit from the rung below". That is
--  what lets a station's rule be the two lines that differ from the account
--  default rather than a full copy. The resolver (services/publishingRules.ts)
--  walks account -> schema -> owner -> asset and records, per field, which
--  rung the value came from.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS publishing_rules (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    -- 'account' (scope_id NULL) | 'schema' (metadata_schemas.id) | 'owner' (channels.id or events.id)
    scope_kind  TEXT NOT NULL CHECK (scope_kind IN ('account', 'schema', 'owner')),
    scope_id    UUID,
    settings    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by  UUID, updated_by UUID,
    version     INT NOT NULL DEFAULT 1,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((scope_kind = 'account') = (scope_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pubrule_scope
  ON publishing_rules (account_id, scope_kind, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- What was decided for an asset, and where each decision came from.
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS availability_override JSONB NOT NULL DEFAULT '{}'::jsonb;  -- the asset's own rung
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS availability          JSONB;    -- resolved settings at publish
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS availability_sources  JSONB;    -- field -> rung it came from
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS availability_state    TEXT NOT NULL DEFAULT 'draft'
  CHECK (availability_state IN ('draft', 'scheduled', 'available', 'expired', 'withdrawn'));
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS available_from  TIMESTAMPTZ;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS available_until TIMESTAMPTZ;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS withdrawn_at    TIMESTAMPTZ;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS withdrawn_by    TEXT;
CREATE INDEX IF NOT EXISTS idx_vod_availability_window ON vod_assets (availability_state, available_until)
  WHERE availability_state IN ('scheduled', 'available');

-- Anything already published keeps working: it is available, worldwide, free.
UPDATE vod_assets SET availability_state = 'available', available_from = COALESCE(available_from, updated_at, created_at),
       availability = COALESCE(availability, '{"targets":[{"kind":"portal"}],"geo":{"mode":"worldwide","countries":[]},"access":"free","expire":{"mode":"never"}}'::jsonb)
 WHERE published = true AND availability_state = 'draft';

-- A registered app is a publishing point: a publication can name one.
ALTER TABLE publications ADD COLUMN IF NOT EXISTS app_id UUID REFERENCES apps(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
--  THE TWO ENUMS BECOME TEXT + CHECK.
--
--  This section replaced two statements that added a value to an existing enum
--  type, which the migration runner refuses on sight (services/migrate.ts:115)
--  and is right to:
--  Postgres cannot run that inside a transaction block, every migration here
--  runs inside one, and the failure would otherwise land on a production
--  database mid-deploy rather than on a laptop.
--
--  Adding the value is only half the trap anyway. An enum can never have a
--  value REMOVED and cannot be reordered, so every future change to this list
--  is a table rewrite in waiting. `publish_platform` in particular is a list of
--  third-party services, which is exactly the kind of list that keeps changing.
--
--  TEXT + CHECK is what the rest of this schema already does, including the
--  `availability_state` column added twenty lines above this one, and the
--  `scope_kind` column in the table this migration creates. It constrains the
--  same values, appears the same way to the application, and the next value is
--  an ordinary DDL statement instead of a special case.
--
--  The USING clause is a plain cast, so existing rows keep their values.
-- ---------------------------------------------------------------------------
ALTER TABLE publications    ALTER COLUMN status  DROP DEFAULT;
ALTER TABLE publications    ALTER COLUMN platform TYPE TEXT USING platform::text;
ALTER TABLE publications    ALTER COLUMN status   TYPE TEXT USING status::text;
ALTER TABLE publish_targets ALTER COLUMN platform TYPE TEXT USING platform::text;
ALTER TABLE publications    ALTER COLUMN status  SET DEFAULT 'pending';

ALTER TABLE publications DROP CONSTRAINT IF EXISTS publications_platform_check;
ALTER TABLE publications ADD CONSTRAINT publications_platform_check
  CHECK (platform IN ('portal', 'youtube', 'facebook', 'x', 'tiktok', 'dailymotion', 'app'));
ALTER TABLE publications DROP CONSTRAINT IF EXISTS publications_status_check;
ALTER TABLE publications ADD CONSTRAINT publications_status_check
  CHECK (status IN ('pending', 'published', 'failed', 'removed', 'withdrawn'));
ALTER TABLE publish_targets DROP CONSTRAINT IF EXISTS publish_targets_platform_check;
ALTER TABLE publish_targets ADD CONSTRAINT publish_targets_platform_check
  CHECK (platform IN ('portal', 'youtube', 'facebook', 'x', 'tiktok', 'dailymotion', 'app'));

-- The types are left in place rather than dropped: nothing references them now,
-- and dropping a type another migration or a running process still expects is a
-- bigger risk than an unused type sitting in the catalogue.

