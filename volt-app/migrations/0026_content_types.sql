-- ===========================================================================
--  CONTENT TYPES: a metadata schema IS a type, and standard ones are seeded.
--
--  Christian, 5 Sep: metadata is assigned BY TYPE. A radio station and a TV
--  channel each carry exactly one standard schema.org-based schema (editable,
--  but there is always one); an event must be given a type at setup, and there
--  are many event types (a town hall with speakers, a church service, a single
--  match, a multi-day multi-sport event) capturing different fields; the type
--  also decides which EPG fields the metadata lands in; and everything derived
--  from an owner (recordings, clips, auto-VOD) carries the owner's type.
--
--  metadata_schemas already has target_kind, domain and extends_id. What it
--  lacked was a way to tell a seeded standard from a client's own, a stable
--  key to seed idempotently, and the schema.org type the schema is based on.
--  The EPG mapping lives on the FIELDS (fields[].epg) rather than in a column,
--  because it is per field.
-- ===========================================================================
ALTER TABLE metadata_schemas ADD COLUMN IF NOT EXISTS is_standard     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE metadata_schemas ADD COLUMN IF NOT EXISTS standard_key    TEXT;
ALTER TABLE metadata_schemas ADD COLUMN IF NOT EXISTS schema_org_type TEXT;
-- Which owners the type is offered for: 'radio' | 'tv' | 'event' | 'vod'.
-- target_kind says what it may BIND to; applies_to says where it is OFFERED
-- (a radio station's type binds to the station and to everything derived
-- from it, so its target_kind is 'any' while applies_to is {radio}).
ALTER TABLE metadata_schemas ADD COLUMN IF NOT EXISTS applies_to      TEXT[] NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX IF NOT EXISTS idx_mdschema_standard_key
  ON metadata_schemas (account_id, standard_key) WHERE standard_key IS NOT NULL;
