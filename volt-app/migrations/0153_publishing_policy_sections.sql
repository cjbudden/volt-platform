-- Build queue P3: publishing policies, sections, locks and presets
-- (PUBLISHING_POLICIES.md, "What a policy contains" and "Where policies apply
-- and which wins").
-- Add only: three columns on publishing_rules, each nullable or defaulted, so
-- tasks on the release before this one keep reading and writing the table.
--
-- The new sections (protection, distribution, retention) live in the existing
-- `settings` JSONB like every other field of the ladder, so they need no
-- columns. What does need one is what is ABOUT a rung rather than a value on
-- it: which fields it locks for the rungs below, a name people can find it
-- by, and the preset it was started from.

-- Fields this rung locks: the rungs below it cannot change them, and the
-- resolver ignores what they say (services/publishingRules.ts resolveLadder).
-- Top-level keys ("geo") or section fields ("protection.drm").
ALTER TABLE publishing_rules ADD COLUMN IF NOT EXISTS locked_fields text[] NOT NULL DEFAULT '{}';
-- A name for the policy, shown with its scope ("Premium sport").
ALTER TABLE publishing_rules ADD COLUMN IF NOT EXISTS name text;
-- The preset it was started from (open, members, geo_locked, premium,
-- rights_managed), kept so the rights-managed checks know what the rule is
-- for even after it is edited. Null: built by hand.
ALTER TABLE publishing_rules ADD COLUMN IF NOT EXISTS preset_key text
  CHECK (preset_key IS NULL OR preset_key IN ('open', 'members', 'geo_locked', 'premium', 'rights_managed'));
