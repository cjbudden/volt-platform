-- ===========================================================================
--  WATCHFOLDER INGEST — WITH RULES, AND WITH A PLACE FOR WHAT DOES NOT BELONG.
--
--  The original design (docs/DESIGN_file_manager_watchfolder.md) had a folder, a
--  single `target_kind`, and an idempotency log. That is enough for a folder
--  where every file is the same thing, and no real drop folder is like that. An
--  operator drops slates, loops, posters and finished VOD into the same place,
--  named by whatever convention the edit suite uses, and something that is none
--  of those turns up every week: a project file, a `.DS_Store`, a half-copied
--  upload, a PDF somebody meant to email.
--
--  SO THE FOLDER GETS RULES, and the rules are ORDERED with first match winning.
--  That is not a detail. `*.png -> poster` and `slate_*.png -> slate` both match
--  `slate_open.png`, and a rule set without a defined order silently picks one of
--  them per implementation. Ordinal, first match, and a UI that shows the order.
--
--  AND IT GETS A QUARANTINE, which is the requirement that changes the shape of
--  the whole thing. A file that matches nothing must NOT be ingested as `other`
--  and must NOT be deleted:
--
--    INGESTING IT quietly fills the library with junk that somebody later has to
--    identify and remove, by which time nobody remembers what it was for.
--    DELETING IT destroys the one copy of a file whose only crime was being
--    named unexpectedly, and the operator finds out days later.
--
--  It is moved to a review path, a row is written saying WHY, and a person
--  decides: correct the rule and reprocess, reclassify this one item, or remove
--  it. `watchfolder_items` is that record, and it is also the idempotency log, so
--  a quarantined file cannot be re-quarantined on every scan.
--
--  THE REASON IS STORED, not recomputed. "No rule matched" today and "no rule
--  matched" after somebody edits the rules are different facts, and a QC queue
--  that re-derives the reason on read would silently rewrite its own history.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS watchfolders (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id          UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,

    -- 'local' = a path an agent or the desktop bridge watches; 's3' = bucket/prefix.
    kind                TEXT NOT NULL DEFAULT 'local' CHECK (kind IN ('local', 's3')),
    -- path/bucket/prefix, glob, credentials_ref, delete_after_ingest, min/max bytes
    config              JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- WHAT AN UNMATCHED FILE BECOMES, and NULL is the safe default on purpose:
    -- with no fallback rule an unrecognised file is quarantined rather than
    -- guessed at. A folder that genuinely wants "everything else is a source"
    -- says so explicitly.
    default_target_kind TEXT,

    -- Where a refused file is moved to. Relative to the watched root, so the
    -- review folder travels with the folder and an operator finds it beside the
    -- drop rather than somewhere central they have to be told about.
    quarantine_path     TEXT NOT NULL DEFAULT '_review',

    enabled             BOOLEAN NOT NULL DEFAULT true,
    last_scan_at        TIMESTAMPTZ,
    last_scan_error     TEXT,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    version             INTEGER NOT NULL DEFAULT 1,
    created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by          UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_watchfolders_account ON watchfolders (account_id, created_at DESC);

-- ---------------------------------------------------------------------------
--  RULES. Ordered, first match wins.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS watchfolder_rules (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    watchfolder_id UUID NOT NULL REFERENCES watchfolders(id) ON DELETE CASCADE,

    -- THE ORDER IS THE RULE SET. Two rules can match one filename and the
    -- operator must be able to see, and change, which one wins.
    ordinal        INTEGER NOT NULL,
    name           TEXT NOT NULL,

    -- 'glob' covers the conventions people actually use (`slate_*.png`).
    -- 'regex' is the escape hatch for the ones they do not.
    match_type     TEXT NOT NULL DEFAULT 'glob'
                   CHECK (match_type IN ('glob', 'regex', 'extension', 'prefix', 'suffix')),
    pattern        TEXT NOT NULL,

    -- What a match becomes in the library, and which workflow it is handed to.
    target_kind    TEXT NOT NULL,
    workflow       TEXT,

    -- A rule may also REFUSE: an explicit "these are never wanted here" that
    -- quarantines with a reason rather than letting the file fall through to a
    -- vaguer one at the bottom.
    action         TEXT NOT NULL DEFAULT 'accept' CHECK (action IN ('accept', 'reject')),
    reject_reason  TEXT,

    enabled        BOOLEAN NOT NULL DEFAULT true,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (watchfolder_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_watchfolder_rules_folder
    ON watchfolder_rules (watchfolder_id, ordinal);

-- ---------------------------------------------------------------------------
--  ITEMS. The idempotency log AND the QC queue, deliberately one table.
--
--  They are the same fact seen twice: "this object has been dealt with, and this
--  is how". Splitting them is how a quarantined file gets re-quarantined on the
--  next scan, because the dedupe log never heard about it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS watchfolder_items (
    id              BIGSERIAL PRIMARY KEY,
    watchfolder_id  UUID NOT NULL REFERENCES watchfolders(id) ON DELETE CASCADE,
    -- Snapshotted so the QC queue survives the folder being deleted, the same
    -- choice usage_accruals and air_sessions make.
    account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

    object_key      TEXT NOT NULL,          -- path relative to the watched root
    checksum        TEXT,                   -- etag or sha256; null until read
    size_bytes      BIGINT,

    status          TEXT NOT NULL DEFAULT 'seen' CHECK (status IN (
                        'seen',          -- noticed, not yet decided
                        'ingested',      -- matched a rule and is in the library
                        'quarantined',   -- refused, moved to the review path
                        'failed',        -- matched, but ingest itself broke
                        'reprocessed',   -- an operator corrected it and it went through
                        'removed'        -- an operator decided it was junk
                    )),

    matched_rule_id UUID REFERENCES watchfolder_rules(id) ON DELETE SET NULL,
    target_kind     TEXT,
    workflow        TEXT,
    media_file_id   UUID REFERENCES media_files(id) ON DELETE SET NULL,

    -- WHY, in words, stored at the moment of the decision. Recomputing it later
    -- against edited rules would rewrite the history the queue exists to hold.
    reason          TEXT,
    -- Where the file was moved to when refused, so an operator can find it.
    quarantine_key  TEXT,

    seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at     TIMESTAMPTZ,
    resolved_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    resolution_note TEXT
);

-- NOTHING IS INGESTED TWICE. Keyed on the content as well as the name, so a file
-- REPLACED under the same name is a new item rather than a silent no-op — which
-- is exactly how a corrected re-drop would otherwise be ignored.
CREATE UNIQUE INDEX IF NOT EXISTS uq_watchfolder_items_object
    ON watchfolder_items (watchfolder_id, object_key, COALESCE(checksum, ''));

CREATE INDEX IF NOT EXISTS idx_watchfolder_items_queue
    ON watchfolder_items (watchfolder_id, status, seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_watchfolder_items_account_open
    ON watchfolder_items (account_id, seen_at DESC) WHERE status = 'quarantined';

COMMENT ON TABLE watchfolder_items IS
  'One row per object seen in a watchfolder: the idempotency log and the QC queue in one table, because they are the same fact.';
