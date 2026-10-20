-- ============================================================================
--  0064  HTML GRAPHICS: templates, setups, assignments, live state, rundowns.
--  docs/REQ_graphics_overlays.md (section 12, decisions of 20 Oct 2026).
--
--  TEMPLATE        an HTML graphic (CasparCG / SPX / Loopic contract), owned by an
--                  account or shipped by the platform (account_id NULL).
--  VERSION         the files of a template. One mutable DRAFT per template;
--                  publishing freezes it as v1, v2 ... and a trigger refuses any
--                  change to a published version's files. On-air never changes
--                  because somebody saved.
--  FILE            the bytes of a version (index.html, fonts, images, scripts),
--                  served sandboxed from /gfx/<version>/<path>.
--  DATA SOURCE     a JSON or RSS feed the control plane polls, or a push target.
--  SETUP           a pinned version plus where each field gets its content
--                  (fixed text, Image Library, a data source path, the guide,
--                  the operator, the API), and position / size / layer.
--  ASSIGNMENT      a setup on a channel or an event, how it runs (always, rule,
--                  trigger, manual) and where it is shown (player, burned, both).
--  STATE           the live values and on-air flag of one assignment, plus the
--                  fields an operator has taken over from the feed. Every change
--                  is logged with actor, time, old and new value.
--  RUNDOWN ITEM    an event's ordered list of graphics: segment, setup, content,
--                  cue (manual, at a time, on a feed event, repeat) and status.
--
--  Video only. Radio stations are refused by the API (no video path).
-- ============================================================================

CREATE TABLE IF NOT EXISTS gfx_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID REFERENCES accounts(id) ON DELETE CASCADE,   -- NULL = platform default
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'other'
                    CHECK (kind IN ('scorebug','lower_third','ticker','bug','full_frame','other')),
  source          TEXT NOT NULL DEFAULT 'paste'
                    CHECK (source IN ('volt','upload','paste','duplicate')),
  duplicated_from UUID REFERENCES gfx_templates(id) ON DELETE SET NULL,
  archived_at     TIMESTAMPTZ,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gfx_templates_account ON gfx_templates(account_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS gfx_template_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id   UUID NOT NULL REFERENCES gfx_templates(id) ON DELETE CASCADE,
  version       INTEGER,                         -- NULL while a draft
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  manifest      JSONB NOT NULL DEFAULT '{}'::jsonb,  -- name, canvas, fps, bbox, fields, sample, contract
  checks        JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{id, level: ok|warn|error, title, detail}]
  size_bytes    BIGINT NOT NULL DEFAULT 0,
  file_count    INTEGER NOT NULL DEFAULT 0,
  note          TEXT,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at  TIMESTAMPTZ,
  published_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  CHECK ((status = 'draft') = (version IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_gfx_version_number ON gfx_template_versions(template_id, version) WHERE version IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_gfx_one_draft ON gfx_template_versions(template_id) WHERE status = 'draft';

CREATE TABLE IF NOT EXISTS gfx_files (
  version_id    UUID NOT NULL REFERENCES gfx_template_versions(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  content       BYTEA NOT NULL,
  PRIMARY KEY (version_id, path)
);

-- A PUBLISHED VERSION NEVER CHANGES. Its row may only gain nothing; its files may
-- not be inserted, replaced or removed (deleting the whole template still works,
-- through the cascade, because the template row goes first).
CREATE OR REPLACE FUNCTION gfx_frozen_version() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'gfx_template_versions' THEN
    IF OLD.status = 'published' AND (NEW.manifest IS DISTINCT FROM OLD.manifest
        OR NEW.version IS DISTINCT FROM OLD.version OR NEW.status IS DISTINCT FROM OLD.status
        OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes) THEN
      RAISE EXCEPTION 'gfx: version % is published and cannot change', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- gfx_files
  IF EXISTS (SELECT 1 FROM gfx_template_versions v
              WHERE v.id = COALESCE(NEW.version_id, OLD.version_id) AND v.status = 'published') THEN
    RAISE EXCEPTION 'gfx: files of a published version cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_gfx_version_frozen ON gfx_template_versions;
CREATE TRIGGER trg_gfx_version_frozen BEFORE UPDATE ON gfx_template_versions
  FOR EACH ROW EXECUTE FUNCTION gfx_frozen_version();
DROP TRIGGER IF EXISTS trg_gfx_files_frozen ON gfx_files;
CREATE TRIGGER trg_gfx_files_frozen BEFORE INSERT OR UPDATE ON gfx_files
  FOR EACH ROW EXECUTE FUNCTION gfx_frozen_version();
-- DELETE of a published version's files is allowed only by the cascade from the
-- template (the version row is already gone by then, so the EXISTS finds nothing).
DROP TRIGGER IF EXISTS trg_gfx_files_frozen_del ON gfx_files;
CREATE TRIGGER trg_gfx_files_frozen_del BEFORE DELETE ON gfx_files
  FOR EACH ROW EXECUTE FUNCTION gfx_frozen_version();

CREATE TABLE IF NOT EXISTS gfx_data_sources (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('json','rss','push')),
  url           TEXT,
  every_sec     INTEGER NOT NULL DEFAULT 5 CHECK (every_sec BETWEEN 1 AND 3600),
  on_stale      TEXT NOT NULL DEFAULT 'hold' CHECK (on_stale IN ('hold','hide')),
  stale_after_sec INTEGER NOT NULL DEFAULT 60,
  payload       JSONB,                 -- last good body (JSON) or {items:[...]} (RSS)
  last_ok_at    TIMESTAMPTZ,
  last_error    TEXT,
  last_polled_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind = 'push' OR url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_gfx_sources_account ON gfx_data_sources(account_id);

CREATE TABLE IF NOT EXISTS gfx_setups (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  note          TEXT,
  template_id   UUID NOT NULL REFERENCES gfx_templates(id) ON DELETE RESTRICT,
  version_id    UUID NOT NULL REFERENCES gfx_template_versions(id) ON DELETE RESTRICT,
  -- { "<fieldId>": { "source": "text"|"image"|"feed"|"guide"|"operator"|"api",
  --                  "value": ..., "imageId": uuid, "sourceId": uuid, "path": "a.b.0",
  --                  "guide": "now_title"|"next_title"|"now_subtitle"|"next_start" } }
  fields        JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- { "anchor": "top_left"..."bottom_right", "x": px, "y": px, "scale": 1.0, "layer": 2 }
  placement     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gfx_setups_account ON gfx_setups(account_id);
CREATE INDEX IF NOT EXISTS idx_gfx_setups_version ON gfx_setups(version_id);

CREATE TABLE IF NOT EXISTS gfx_assignments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  setup_id      UUID NOT NULL REFERENCES gfx_setups(id) ON DELETE CASCADE,
  channel_id    UUID REFERENCES channels(id) ON DELETE CASCADE,
  event_id      UUID REFERENCES events(id) ON DELETE CASCADE,
  targets       TEXT NOT NULL DEFAULT 'player' CHECK (targets IN ('player','burn','both')),
  run_mode      TEXT NOT NULL DEFAULT 'manual' CHECK (run_mode IN ('always','rule','trigger','manual')),
  -- rule:    { "genre": "News", "titleContains": "...", "days": [1..7], "from": "HH:MM", "to": "HH:MM" }
  -- trigger: { "at": "programme_start"|"programme_end", "offsetSec": 10, "durationSec": 8 }
  rule          JSONB NOT NULL DEFAULT '{}'::jsonb,
  clear_in_ads  BOOLEAN NOT NULL DEFAULT true,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((channel_id IS NULL) <> (event_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_gfx_assign_channel ON gfx_assignments(channel_id) WHERE channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gfx_assign_event   ON gfx_assignments(event_id)   WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gfx_assign_setup   ON gfx_assignments(setup_id);

CREATE TABLE IF NOT EXISTS gfx_state (
  assignment_id UUID PRIMARY KEY REFERENCES gfx_assignments(id) ON DELETE CASCADE,
  values        JSONB NOT NULL DEFAULT '{}'::jsonb,   -- operator / API values
  overrides     TEXT[] NOT NULL DEFAULT '{}',         -- feed fields taken over by hand
  on_air        BOOLEAN NOT NULL DEFAULT false,
  rundown_item_id UUID,                               -- the rundown item that put it on air, if any
  off_at        TIMESTAMPTZ,                          -- auto take-off (rundown "stays 8 s")
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    TEXT
);

CREATE TABLE IF NOT EXISTS gfx_state_log (
  id            BIGSERIAL PRIMARY KEY,
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  assignment_id UUID REFERENCES gfx_assignments(id) ON DELETE CASCADE,
  event_id      UUID REFERENCES events(id) ON DELETE CASCADE,
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor         TEXT NOT NULL,
  action        TEXT NOT NULL,          -- set | on | off | release | take | take_off | feed
  field         TEXT,
  old_value     JSONB,
  new_value     JSONB
);
CREATE INDEX IF NOT EXISTS idx_gfx_log_assignment ON gfx_state_log(assignment_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_gfx_log_event ON gfx_state_log(event_id, at DESC) WHERE event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS gfx_rundown_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event_id      UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  segment       TEXT NOT NULL DEFAULT '',
  title         TEXT NOT NULL,
  setup_id      UUID NOT NULL REFERENCES gfx_setups(id) ON DELETE RESTRICT,
  values        JSONB NOT NULL DEFAULT '{}'::jsonb,   -- this item's content, over the setup's
  -- { "kind": "manual" } | { "kind": "time", "at": iso } | { "kind": "offset", "fromStartSec": n }
  -- | { "kind": "feed", "event": "try" } | { "kind": "repeat", "everySec": 600 }
  cue           JSONB NOT NULL DEFAULT '{"kind":"manual"}'::jsonb,
  stays_sec     INTEGER,                              -- NULL = until taken off
  status        TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','on_air','done','skipped')),
  taken_at      TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gfx_rundown_event ON gfx_rundown_items(event_id, position);
