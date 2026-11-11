-- Build queue P2-2c: token-free titles at the edge (services/edgeTokens.ts
-- syncEdgeOpen). One row per "f:<asset id>" key the control plane has written
-- to the edge store, so a key that is no longer wanted can be found and
-- removed (the store cannot be listed). `value` is what the key holds: when
-- token-free play ends (epoch seconds), or 0 for no end.
-- Add only: a new table.
CREATE TABLE IF NOT EXISTS edge_open_assets (
  asset_id  uuid PRIMARY KEY,
  value     text NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now()
);
