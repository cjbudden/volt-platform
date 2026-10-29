-- GRAPHICS DEFAULT SETS (25 Oct 2026). docs/GRAPHICS_TEMPLATE_STANDARD.md section 9.
--
-- Volt's own templates (gfx_templates.account_id NULL) belong to a set: News, General,
-- Sport scores, or one a SaaS admin makes. A set is on or off for each client account:
-- default_enabled decides for every account that has no choice of its own, and a row in
-- gfx_account_sets overrides it for one account. Turning a set off hides its templates from
-- new use in that account; setups already made from them keep working and stay listed.
-- Setups always belong to one account, so an account only ever sees its own.

CREATE TABLE IF NOT EXISTS gfx_template_sets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key              TEXT NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name             TEXT NOT NULL,
  description      TEXT,
  default_enabled  BOOLEAN NOT NULL DEFAULT true,
  shipped          BOOLEAN NOT NULL DEFAULT false,      -- made by Volt at boot (services/graphics/defaults.ts)
  sort             INT NOT NULL DEFAULT 100,
  archived_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gfx_account_sets (
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  set_id      UUID NOT NULL REFERENCES gfx_template_sets(id) ON DELETE CASCADE,
  enabled     BOOLEAN NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (account_id, set_id)
);
CREATE INDEX IF NOT EXISTS gfx_account_sets_set ON gfx_account_sets(set_id);

-- Only Volt templates have a set. A retired Volt template is hidden from new use everywhere;
-- setups already on it keep running.
ALTER TABLE gfx_templates ADD COLUMN IF NOT EXISTS set_id UUID REFERENCES gfx_template_sets(id) ON DELETE SET NULL;
ALTER TABLE gfx_templates ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS gfx_templates_set ON gfx_templates(set_id) WHERE account_id IS NULL;
