-- Build queue P2: the edge revocation set for on-demand play tokens
-- (services/edgeTokens.ts). A title that stops being public before its window
-- ends gets a row; the edge refuses its tokens issued up to revoked_at. Kept
-- until expires_at (the longest a token can live), then dropped by the sync.
-- Add only: a new table.
CREATE TABLE IF NOT EXISTS edge_revocations (
  asset_id   uuid PRIMARY KEY,
  revoked_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  reason     text
);
CREATE INDEX IF NOT EXISTS idx_edge_revocations_expires ON edge_revocations (expires_at);
