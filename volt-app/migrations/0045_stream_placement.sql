-- ============================================================================
-- STREAM PLACEMENT + CONSOLIDATION ADVICE
--
-- Every launch now carries a LOAD ESTIMATE worked out from the stream's output
-- settings (services/fleet/streamLoad.ts) and a PLACEMENT DECISION
-- (services/fleet/placementPlanner.ts). Both are written onto the instance row
-- at launch, so:
--   * the next placement sees this task's load immediately, before telemetry
--     has caught up (otherwise two starts a second apart would both pick the
--     same "empty" server);
--   * the load_signature joins a run to every other run with the same
--     settings, which is how measured history replaces the estimate;
--   * the decision, with its per-host reasons, is there for anyone asking
--     "why is this channel on that server".
--
-- cpu_units / memory_mib already exist (0016) and now hold the reservation
-- actually requested, not only what placement capture observed.
-- ============================================================================

ALTER TABLE instances ADD COLUMN IF NOT EXISTS est_cpu_units      INTEGER;
ALTER TABLE instances ADD COLUMN IF NOT EXISTS est_memory_mib     INTEGER;
ALTER TABLE instances ADD COLUMN IF NOT EXISTS est_gpu_share      NUMERIC(6,3);
ALTER TABLE instances ADD COLUMN IF NOT EXISTS est_net_in_bps     BIGINT;
ALTER TABLE instances ADD COLUMN IF NOT EXISTS est_net_out_bps    BIGINT;
ALTER TABLE instances ADD COLUMN IF NOT EXISTS reserved_gpus      INTEGER;
-- 'estimate' (from settings) or 'observed' (calibrated from runs like it)
ALTER TABLE instances ADD COLUMN IF NOT EXISTS load_basis         TEXT;
ALTER TABLE instances ADD COLUMN IF NOT EXISTS load_signature     TEXT;
-- The host placement CHOSE, before the reconciler has observed where it landed.
ALTER TABLE instances ADD COLUMN IF NOT EXISTS assigned_host_id   UUID REFERENCES compute_hosts(id) ON DELETE SET NULL;
ALTER TABLE instances ADD COLUMN IF NOT EXISTS placement_decision JSONB;
-- Set by the (future) handoff when a stream is moved between servers; drives the cooldown.
ALTER TABLE instances ADD COLUMN IF NOT EXISTS moved_at           TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_instances_load_signature ON instances (load_signature) WHERE load_signature IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_instances_assigned_host  ON instances (assigned_host_id) WHERE terminated_at IS NULL;

-- One row per consolidation pass: what the planner would do, and why not.
CREATE TABLE IF NOT EXISTS fleet_plans (
    id                BIGSERIAL PRIMARY KEY,
    at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    kind              TEXT NOT NULL CHECK (kind IN ('consolidation')),
    plan              JSONB NOT NULL,
    servers_saved     INTEGER NOT NULL DEFAULT 0,
    hosts_considered  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_fleet_plans_kind_at ON fleet_plans (kind, at DESC);
