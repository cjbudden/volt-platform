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
ALTER TYPE publish_platform ADD VALUE IF NOT EXISTS 'app';
ALTER TABLE publications ADD COLUMN IF NOT EXISTS app_id UUID REFERENCES apps(id) ON DELETE CASCADE;
ALTER TYPE publication_status ADD VALUE IF NOT EXISTS 'withdrawn';
