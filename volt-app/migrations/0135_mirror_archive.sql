-- ============================================================================
--  0135: MIRROR AND ARCHIVE, first part (build queue H3-2, HYBRID_SITES.md
--  "Add-on: Mirror and Archive to external storage").
--
--  A STORAGE TARGET is a place the account owns at one of its sites where
--  Volt keeps extra copies: today a folder on the site's server or NAS. The
--  site agent writes there; the cloud never reaches into the site.
--
--  An ARCHIVE COPY is one file copied to one target, with the checksum the
--  target holds and when it was last confirmed. Nothing is "verified" until
--  the agent has read the copy back from the target and the cloud has
--  matched it against what it sent.
--
--  LICENSED, OFF BY DEFAULT: `mirror_archive` in accounts.licences. Without
--  it nothing below is reachable.
--
--  Add only (RELEASING.md "Schema: add only"): two new tables. Kinds and
--  states are checked in code, not with CHECK constraints, so the next kinds
--  (an on-prem S3-compatible store) need no constraint to be dropped.
-- ============================================================================
CREATE TABLE IF NOT EXISTS archive_targets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  site_id        uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name           text NOT NULL,
  -- 'path': a folder on the site's server, a mounted NAS share or local disk.
  kind           text NOT NULL DEFAULT 'path',
  path           text NOT NULL,
  -- Copies to this target never go faster than this (megabits per second),
  -- so an archive copy never competes with live contribution. NULL: no cap.
  bandwidth_mbps integer,
  -- disabled: no new copies are queued to it; copies already there are kept.
  status         text NOT NULL DEFAULT 'active',
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, name)
);
CREATE INDEX IF NOT EXISTS idx_archive_targets_site ON archive_targets (site_id);

CREATE TABLE IF NOT EXISTS archive_copies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  target_id       uuid NOT NULL REFERENCES archive_targets(id) ON DELETE CASCADE,
  vod_asset_id    uuid REFERENCES vod_assets(id) ON DELETE SET NULL,
  -- What was copied: 'source' (the asset's original file) for now.
  what            text NOT NULL DEFAULT 'source',
  source_uri      text NOT NULL,
  file_name       text NOT NULL,
  -- Where it ended up, relative to the target's folder (a name that was
  -- already taken gets -2, -3 added).
  stored_path     text,
  bytes           bigint,
  -- The checksum the copy must have (the source's, when the cloud knows it)
  -- and the one the target holds, as read back from the target.
  expected_sha256 text,
  sha256          text,
  -- queued, copying, verified, failed, corrupt (the copy no longer matches),
  -- missing (the copy is gone from the target).
  state           text NOT NULL DEFAULT 'queued',
  job_id          uuid,
  verify_job_id   uuid,
  error           text,
  error_code      text,
  copied_at       timestamptz,
  verified_at     timestamptz,
  checked_at      timestamptz,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- One copy of one thing per target: copying again reuses the row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_archive_copies_what ON archive_copies (target_id, vod_asset_id, what);
CREATE INDEX IF NOT EXISTS idx_archive_copies_account ON archive_copies (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_archive_copies_asset ON archive_copies (vod_asset_id) WHERE vod_asset_id IS NOT NULL;
