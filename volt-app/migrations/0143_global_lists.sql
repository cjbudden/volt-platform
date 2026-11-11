-- ============================================================================
--  0143 GLOBAL LISTS: platform-owned reference lists (docs/GLOBAL_LISTS.md).
--
--  Reference data that is the same for every client and is kept by SaaS
--  staff (System Admin > Global lists): countries, timezones, and later
--  languages, currencies, regions. Not the account's own pick lists
--  (metadata_lists, Admin > Genres).
--
--  global_lists        one row per list. `fields` declares what each item's
--                      value holds ([{key,label,type,required,unique,pattern,
--                      ...}]); `code_field` is the field an item's code follows
--                      (countries: alpha2), NULL when the code is fixed at
--                      creation; `label_field` names the display label.
--                      `version` bumps on every change (the read API's ETag).
--                      `seeded_version` is the shipped seed already applied.
--  global_list_items   code (stable, what other records store) + value (jsonb)
--                      + position + is_default (one per list) + active
--                      (false = retired: resolvable, no longer offered).
--
--  The rows themselves are created at boot from src/data/globalLists/*.seed.ts
--  (services/globalLists.ts ensureGlobalListSeeds), so the definitions and
--  values live in one place.
-- ============================================================================
CREATE TABLE IF NOT EXISTS global_lists (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key             TEXT NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9-]{1,40}$'),
  name            TEXT NOT NULL,
  description     TEXT,
  visibility      TEXT NOT NULL DEFAULT 'tenant' CHECK (visibility IN ('public', 'tenant', 'platform')),
  system          BOOLEAN NOT NULL DEFAULT false,
  fields          JSONB NOT NULL DEFAULT '[]'::jsonb,
  code_field      TEXT,
  label_field     TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  seeded_version  INTEGER NOT NULL DEFAULT 0,
  archived_at     TIMESTAMPTZ,
  updated_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS global_list_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id     UUID NOT NULL REFERENCES global_lists(id) ON DELETE CASCADE,
  code        TEXT NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  value       JSONB NOT NULL DEFAULT '{}'::jsonb,
  position    INTEGER NOT NULL DEFAULT 0,
  is_default  BOOLEAN NOT NULL DEFAULT false,
  active      BOOLEAN NOT NULL DEFAULT true,
  updated_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Codes are unique per list regardless of case (AU and au are the same country).
CREATE UNIQUE INDEX IF NOT EXISTS global_list_items_code ON global_list_items (list_id, lower(code));
-- At most one default item per list.
CREATE UNIQUE INDEX IF NOT EXISTS global_list_items_one_default ON global_list_items (list_id) WHERE is_default;
-- The default read order (position, then id as the list standard's tiebreak).
CREATE INDEX IF NOT EXISTS global_list_items_order ON global_list_items (list_id, position, id);
