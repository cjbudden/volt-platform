-- ============================================================================
--  0133: RIGHTS PROFILES (build queue R1, Publishing Policies design, "Rights").
--
--  Rights are the cap nothing overrides. Every asset carries exactly one
--  profile: where it may be shown (territories), on which apps, for which
--  uses (on demand, FAST and linear, clips, social, downloads, ads), with
--  which access types, and inside which window. Collection access and the
--  publishing policy only ever work inside it.
--
--  Two built-in profiles per account, made on first use by
--  volt_rights_builtin(): 'open' ("No restrictions") and 'closed' ("All
--  restricted": nothing public, nothing in FAST). The account picks which one
--  (or a provider profile) new assets get.
--
--  Mandatory without touching any insert path: a BEFORE INSERT trigger fills
--  vod_assets.rights_profile_id from the account default when the insert did
--  not name one. That also covers the previous release during a rolling
--  deploy, whose inserts know nothing about rights. Existing assets are given
--  the account's "No restrictions" profile, so nothing that plays today stops.
--
--  Add only: new tables and nullable columns. apps.surface marks an app as an
--  embed player or a venue screen, so the rights can tell those apart from the
--  web, mobile and TV apps (an enum value would need its own transaction).
-- ============================================================================

ALTER TABLE apps ADD COLUMN IF NOT EXISTS surface text CHECK (surface IN ('embed', 'venue'));
COMMENT ON COLUMN apps.surface IS
  'What the app is used for when its type alone does not say: an embed player on other sites, or venue screens (build queue R1 rights).';

CREATE TABLE IF NOT EXISTS rights_profiles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name             text NOT NULL,
  -- 'open' = No restrictions, 'closed' = All restricted; NULL for the account's own.
  builtin          text CHECK (builtin IN ('open', 'closed')),
  provider         text,
  takedown_contact text,
  agreement_ref    text,
  -- worldwide | allow (only these) | block (everywhere except these)
  territory_mode   text NOT NULL DEFAULT 'worldwide' CHECK (territory_mode IN ('worldwide', 'allow', 'block')),
  territories      text[] NOT NULL DEFAULT '{}',
  -- all | allow (only these app types and apps) | block (all except these)
  app_mode         text NOT NULL DEFAULT 'all' CHECK (app_mode IN ('all', 'allow', 'block')),
  app_types        text[] NOT NULL DEFAULT '{}',
  app_ids          uuid[] NOT NULL DEFAULT '{}',
  uses             text[] NOT NULL DEFAULT '{on_demand,fast,clips,social,downloads,ads}',
  access_types     text[] NOT NULL DEFAULT '{free,members,subscription,ppv}',
  -- open | fixed (window_from..window_until) | relative (count unit from first air or ingest)
  window_kind      text NOT NULL DEFAULT 'open' CHECK (window_kind IN ('open', 'fixed', 'relative')),
  window_from      timestamptz,
  window_until     timestamptz,
  relative_count   integer CHECK (relative_count IS NULL OR relative_count > 0),
  relative_unit    text CHECK (relative_unit IN ('day', 'month', 'year')),
  relative_from    text CHECK (relative_from IN ('first_air', 'ingest')),
  warn_days        integer NOT NULL DEFAULT 30,
  -- The agreement file: { name, size, type, key, uploadedBy, uploadedAt }. Private.
  agreement        jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS rights_profiles_builtin_uq ON rights_profiles(account_id, builtin) WHERE builtin IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS rights_profiles_name_uq ON rights_profiles(account_id, lower(name));

COMMENT ON TABLE rights_profiles IS
  'Rights profiles (build queue R1): the cap on territories, apps, uses, access types and window that collection access and publishing policies work inside.';

-- Which profile new assets get. NULL means the account's "No restrictions".
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS default_rights_profile_id uuid;

-- ON DELETE SET NULL so an account's deletion (which removes its profiles and
-- its assets) is not blocked by the order the cascades run in. The API refuses
-- to delete a profile any asset still uses.
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS rights_profile_id uuid REFERENCES rights_profiles(id) ON DELETE SET NULL;
-- Per-title narrowing inside the profile, never wider (checked by the API):
-- { territories?: [..only these..], blockTerritories?: [..], appTypes?: [..],
--   blockAppIds?: [..], uses?: [..], from?: iso, until?: iso }
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS rights_narrow jsonb;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS rights_set_by text;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS rights_set_at timestamptz;
-- When the asset first went out (live, FAST or linear): the start of a window
-- relative to first air. Until something sets it, the asset's creation counts.
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS first_aired_at timestamptz;
-- The index for "which assets use this profile" is built concurrently in 0134.

-- The account's built-in profile of a kind, made the first time it is needed.
CREATE OR REPLACE FUNCTION volt_rights_builtin(acct uuid, kind text) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE pid uuid;
BEGIN
  SELECT id INTO pid FROM rights_profiles WHERE account_id = acct AND builtin = kind;
  IF pid IS NOT NULL THEN RETURN pid; END IF;
  INSERT INTO rights_profiles(account_id, name, builtin, provider, uses, access_types, territory_mode, app_mode)
  VALUES (acct,
          CASE kind WHEN 'open' THEN 'No restrictions' ELSE 'All restricted' END,
          kind, 'Volt default',
          CASE kind WHEN 'open' THEN '{on_demand,fast,clips,social,downloads,ads}'::text[] ELSE '{}'::text[] END,
          CASE kind WHEN 'open' THEN '{free,members,subscription,ppv}'::text[] ELSE '{}'::text[] END,
          CASE kind WHEN 'open' THEN 'worldwide' ELSE 'allow' END,
          CASE kind WHEN 'open' THEN 'all' ELSE 'allow' END)
  ON CONFLICT DO NOTHING
  RETURNING id INTO pid;
  IF pid IS NULL THEN
    SELECT id INTO pid FROM rights_profiles WHERE account_id = acct AND builtin = kind;
  END IF;
  RETURN pid;
END $$;

-- Fill an insert's rights from its account's default. The account comes from
-- the asset itself (uploads, watch folders) or through its channel or event.
CREATE OR REPLACE FUNCTION volt_vod_rights_default() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE acct uuid; def uuid;
BEGIN
  IF NEW.rights_profile_id IS NOT NULL THEN RETURN NEW; END IF;
  acct := NEW.account_id;
  IF acct IS NULL AND NEW.channel_id IS NOT NULL THEN
    SELECT g.account_id INTO acct FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id = NEW.channel_id;
  END IF;
  IF acct IS NULL AND NEW.event_id IS NOT NULL THEN
    SELECT g.account_id INTO acct FROM events e JOIN groups g ON g.id = e.group_id WHERE e.id = NEW.event_id;
  END IF;
  IF acct IS NULL THEN RETURN NEW; END IF;
  SELECT a.default_rights_profile_id INTO def FROM accounts a
    JOIN rights_profiles p ON p.id = a.default_rights_profile_id AND p.account_id = a.id
   WHERE a.id = acct;
  NEW.rights_profile_id := COALESCE(def, volt_rights_builtin(acct, 'open'));
  NEW.rights_set_by := COALESCE(NEW.rights_set_by, 'account default');
  NEW.rights_set_at := COALESCE(NEW.rights_set_at, now());
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS vod_assets_rights_default ON vod_assets;
CREATE TRIGGER vod_assets_rights_default BEFORE INSERT ON vod_assets
  FOR EACH ROW EXECUTE FUNCTION volt_vod_rights_default();

-- Existing assets: "No restrictions", so nothing that plays today stops.
UPDATE vod_assets v SET rights_profile_id = volt_rights_builtin(x.acct, 'open'),
       rights_set_by = 'backfill', rights_set_at = now()
  FROM (SELECT v2.id, COALESCE(v2.account_id, g.account_id) AS acct
          FROM vod_assets v2
          LEFT JOIN channels c ON c.id = v2.channel_id
          LEFT JOIN events e ON e.id = v2.event_id
          LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
         WHERE v2.rights_profile_id IS NULL) x
 WHERE v.id = x.id AND x.acct IS NOT NULL;

-- A watchfolder can name the profile everything it brings in gets (NULL: the
-- account default, through the trigger above).
ALTER TABLE watchfolders ADD COLUMN IF NOT EXISTS rights_profile_id uuid REFERENCES rights_profiles(id) ON DELETE SET NULL;
