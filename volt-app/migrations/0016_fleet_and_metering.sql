-- ============================================================================
--  THE FLEET, AND WHAT IT COSTS.
--
--  Two questions this schema could not answer, and the reason it could not.
--
--  1. "WHICH SERVERS ARE RUNNING MY STREAMS, AND ARE THEY COPING?"
--
--     `instances` is one row per TASK. It has always been that, despite the
--     name. It carries ec2_instance_id, instance_type and availability_zone
--     columns that nothing has ever written, and the only instance_type ever
--     set is a RECOMMENDATION from recommendInstance() rather than a record of
--     what AWS actually placed. So the schema appeared to describe machines
--     while describing nothing of the sort.
--
--     A machine is not a task. On EC2 capacity one machine carries several
--     tasks, which is the entire point of using it and the entire reason
--     "is this server coping" is a question worth asking. `compute_hosts` is
--     that missing row, and `instances.host_id` is the missing edge.
--
--  2. "WHAT IS THIS ACCOUNT BILLABLE FOR?"
--
--     `usage_records` has existed since 0001 with an index on
--     (account_id, period_start), and NOTHING HAS EVER READ OR WRITTEN IT.
--     Billing was `buildBilling()`: now minus launched_at, times an indicative
--     rate, computed fresh on every page load and discarded. When a run ended
--     its cost ceased to exist. A month's usage was not merely un-invoiced, it
--     was unrecoverable.
--
--     The fix is a LEDGER, not a bigger live calculation. usage_accruals is
--     append-and-advance: each instance carries `metered_through`, and a tick
--     accrues only the window between that mark and now. That single column is
--     what makes the meter safe in the two ways it must be:
--
--       - a tick that runs twice accrues zero the second time, because the
--         mark has already moved past the window;
--       - a control plane that was down for an hour accrues that hour on its
--         next tick, because the mark did not move while it was gone.
--
--     Neither property is available to anything that meters from now().
--
--  RATES ARE DATA. compute_rates replaces the hardcoded numbers in
--  services/billing.ts, which have always been labelled indicative and always
--  been unchangeable without a deploy. A row can be corrected; a constant in a
--  compiled bundle cannot. Rates are effective-dated so correcting one does
--  not silently rewrite last month's invoice.
-- ============================================================================

-- ---------- compute hosts ---------------------------------------------------
-- A MACHINE. Not a task, not a claim, not a recommendation: the thing that has
-- a CPU we can measure.
--
-- `kind` matters because the three are genuinely different animals and
-- pretending otherwise produces nonsense numbers:
--
--   ec2      real, shared. Several tasks land on it. CPU is the host's, so
--            "80% busy" is a fact about the machine and is the number that
--            tells you whether to add capacity.
--   fargate  a microVM carrying exactly one task. There is no host CPU to
--            read; the only honest metric is the task's own utilisation. A
--            fargate host therefore always has exactly one instance on it and
--            its "streams per server" is 1 by construction, which is a
--            property of the purchasing model rather than an observation.
--   local    an on-box deployment: the docker or local launcher, where the
--            host is the machine the control plane itself is running on.
--
-- `external_id` is the provider's own identifier (i-0abc… for ec2, the task
-- arn for fargate, a stable hostname for local) and is what makes the upsert
-- idempotent across restarts.
CREATE TABLE IF NOT EXISTS compute_hosts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind            TEXT NOT NULL CHECK (kind IN ('ec2', 'fargate', 'local')),
    external_id     TEXT NOT NULL,
    -- What the machine actually is, as reported by the provider. NULL means we
    -- have not been able to ask yet, which is different from "unknown type".
    instance_type   TEXT,
    region          TEXT,
    availability_zone TEXT,
    lifecycle       TEXT CHECK (lifecycle IN ('spot', 'on_demand')),
    vcpus           INTEGER,
    memory_mib      INTEGER,
    -- Observed, not assumed: 'up' while something is placed on it and the
    -- provider still describes it, 'gone' once it is not.
    state           TEXT NOT NULL DEFAULT 'up' CHECK (state IN ('up', 'gone')),
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Last time a metrics provider successfully returned a reading for this
    -- host. Separate from last_seen_at on purpose: a host we can see but
    -- cannot measure is a real and distinguishable state, and the UI must be
    -- able to say "no reading" rather than draw a zero.
    last_metric_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_compute_hosts_external
  ON compute_hosts (kind, external_id);
CREATE INDEX IF NOT EXISTS idx_compute_hosts_live
  ON compute_hosts (last_seen_at DESC) WHERE state = 'up';

-- ---------- telemetry -------------------------------------------------------
-- One row per successful reading. THERE IS NO ROW FOR A READING WE COULD NOT
-- TAKE, and no column here is nullable-as-zero: a provider that timed out
-- writes nothing, so an absent sample reads as absent and never as idle. This
-- is the same three-valued honesty the liveness check uses, applied to
-- numbers instead of states.
--
-- `source` records who took the reading, because a CloudWatch host average and
-- an on-box /proc read are not interchangeable evidence and a mixed series
-- would be a lie about precision.
CREATE TABLE IF NOT EXISTS host_samples (
    id            BIGSERIAL PRIMARY KEY,
    host_id       UUID NOT NULL REFERENCES compute_hosts(id) ON DELETE CASCADE,
    at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    source        TEXT NOT NULL CHECK (source IN ('cloudwatch', 'onbox', 'task_stats')),
    cpu_pct       NUMERIC(5,2),
    mem_pct       NUMERIC(5,2),
    net_in_bps    BIGINT,
    net_out_bps   BIGINT,
    -- How many tasks were placed on this host when the reading was taken, so a
    -- utilisation figure can be read against the load that produced it after
    -- the fact rather than only live.
    tasks_on_host INTEGER
);
CREATE INDEX IF NOT EXISTS idx_host_samples_host_at ON host_samples (host_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_host_samples_at ON host_samples (at);

-- ---------- placement facts on the task row ---------------------------------
-- These record WHAT HAPPENED. instance_type on this table has, until now, been
-- a recommendation; from here the recommendation stays where it belongs (in
-- the sizing advice) and the host row carries the truth.
ALTER TABLE instances ADD COLUMN IF NOT EXISTS host_id UUID REFERENCES compute_hosts(id) ON DELETE SET NULL;
ALTER TABLE instances ADD COLUMN IF NOT EXISTS container_instance_arn TEXT;
ALTER TABLE instances ADD COLUMN IF NOT EXISTS capacity_provider TEXT;
-- WHAT KIND OF WORK THIS TASK IS. The allocation question Christian asked is
-- "which stream type went where", and it cannot be answered from the existing
-- `role` column: role is primary/backup/captions, a redundancy concept. A
-- transcode and a package-only run are both 'primary' and cost an order of
-- magnitude apart.
ALTER TABLE instances ADD COLUMN IF NOT EXISTS task_kind TEXT
  CHECK (task_kind IN ('transcode', 'package_only', 'radio', 'captions', 'thumbnailer'));
-- Requested size, where the platform tells the scheduler what to reserve.
ALTER TABLE instances ADD COLUMN IF NOT EXISTS cpu_units INTEGER;
ALTER TABLE instances ADD COLUMN IF NOT EXISTS memory_mib INTEGER;
-- THE METER MARK. Everything up to and including this instant has been
-- accrued. NULL means nothing has been metered for this task yet, which for a
-- task that launched before this migration is exactly right: we cannot invent
-- the history we did not keep, so metering starts from the launch we can see
-- and no earlier.
ALTER TABLE instances ADD COLUMN IF NOT EXISTS metered_through TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_instances_host ON instances (host_id);
-- The meter's work queue: everything running, plus everything that stopped
-- with time still owed. Ordered by the mark so the least-recently-metered is
-- always reached first and no task can be starved by a busier one.
CREATE INDEX IF NOT EXISTS idx_instances_meter
  ON instances (metered_through NULLS FIRST)
  WHERE state <> 'terminated' OR metered_through IS NULL OR metered_through < terminated_at;

-- ---------- the rate table --------------------------------------------------
-- Effective-dated so a corrected rate applies from when it was corrected and
-- does not retroactively rewrite an accrual that has already been made at the
-- old figure. `indicative` is carried through rather than dropped, because a
-- number the operator has not replaced with a real contracted rate must keep
-- saying so all the way to the invoice line.
CREATE TABLE IF NOT EXISTS compute_rates (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_type  TEXT NOT NULL,
    lifecycle      TEXT NOT NULL DEFAULT 'on_demand' CHECK (lifecycle IN ('spot', 'on_demand')),
    region         TEXT,                       -- NULL matches any region
    usd_per_hour   NUMERIC(10,5) NOT NULL,
    indicative     BOOLEAN NOT NULL DEFAULT true,
    effective_from TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
    note           TEXT
);
CREATE INDEX IF NOT EXISTS idx_compute_rates_lookup
  ON compute_rates (instance_type, lifecycle, effective_from DESC);

-- The indicative figures that were hardcoded in services/billing.ts, moved
-- here so they can be corrected. Spot is entered at the customary ~70% of
-- on-demand and is flagged indicative like everything else; a deployment with
-- real pricing replaces these rows and clears the flag.
INSERT INTO compute_rates (instance_type, lifecycle, usd_per_hour, indicative, note)
SELECT * FROM (VALUES
    ('c6i.large',   'on_demand', 0.08500, true, 'seeded from services/billing.ts'),
    ('c6i.large',   'spot',      0.02550, true, 'seeded, ~30% of on-demand'),
    ('c6i.xlarge',  'on_demand', 0.17000, true, 'seeded from services/billing.ts'),
    ('c6i.xlarge',  'spot',      0.05100, true, 'seeded, ~30% of on-demand'),
    ('c6i.2xlarge', 'on_demand', 0.34000, true, 'seeded from services/billing.ts'),
    ('c6i.2xlarge', 'spot',      0.10200, true, 'seeded, ~30% of on-demand'),
    -- A station is ffmpeg alone with no packager and no video, so it is sized
    -- an order of magnitude below an encoder. See Dockerfile.radio.
    ('t3.small',    'on_demand', 0.02080, true, 'radio station, seeded'),
    ('t3.small',    'spot',      0.00624, true, 'radio station, seeded'),
    ('g4dn.xlarge', 'on_demand', 0.52600, true, 'captions add-on (GPU), seeded'),
    ('g4dn.xlarge', 'spot',      0.15780, true, 'captions add-on (GPU), seeded')
) AS v(instance_type, lifecycle, usd_per_hour, indicative, note)
WHERE NOT EXISTS (SELECT 1 FROM compute_rates);

-- ---------- the usage ledger ------------------------------------------------
-- APPEND ONLY, one row per metered window per task. The window is closed and
-- half-open: [from, to). Two rows for one instance can never overlap because
-- the next window always begins at the previous mark.
--
-- The account is denormalised onto the row on purpose. A channel can be moved
-- between groups and a group between accounts, and an invoice for March must
-- not change because of a reorganisation in April. Who was billable is a fact
-- about the moment the compute was consumed, so it is captured then.
--
-- Cost is likewise frozen at accrual time rather than recomputed on read: the
-- rate that applied is the rate that applied.
CREATE TABLE IF NOT EXISTS usage_accruals (
    id            BIGSERIAL PRIMARY KEY,
    account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    instance_id   UUID REFERENCES instances(id) ON DELETE SET NULL,
    channel_id    UUID REFERENCES channels(id) ON DELETE SET NULL,
    event_id      UUID REFERENCES events(id) ON DELETE SET NULL,
    host_id       UUID REFERENCES compute_hosts(id) ON DELETE SET NULL,
    -- THE SAME IDENTITY, WITHOUT THE FOREIGN KEY, AND ITS NAME AT THE TIME.
    --
    -- Deleting a channel cascades its instance rows away (migration 0013) and
    -- nulls the channel_id above. Without these two columns that would take
    -- the channel's usage history with it: the account total would survive but
    -- "which channel used those hours" would silently become "unknown", and it
    -- would become so retroactively, for months already reported.
    --
    -- A billing record must outlive the thing it bills for. So the id is
    -- carried a second time with no reference to enforce, and the name is
    -- snapshotted beside it. channel_id/event_id remain for joining to a
    -- channel that still exists; stream_id is what the roll-up groups on.
    stream_id     UUID,
    stream_name   TEXT,
    task_kind     TEXT,
    instance_type TEXT,
    lifecycle     TEXT,
    from_at       TIMESTAMPTZ NOT NULL,
    to_at         TIMESTAMPTZ NOT NULL,
    seconds       INTEGER NOT NULL CHECK (seconds >= 0),
    usd_per_hour  NUMERIC(10,5),
    est_usd       NUMERIC(12,6) NOT NULL DEFAULT 0,
    -- False only when a real contracted rate was found for this window.
    indicative    BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (to_at >= from_at)
);
CREATE INDEX IF NOT EXISTS idx_usage_accruals_account_period
  ON usage_accruals (account_id, from_at);
CREATE INDEX IF NOT EXISTS idx_usage_accruals_instance
  ON usage_accruals (instance_id, from_at);
CREATE INDEX IF NOT EXISTS idx_usage_accruals_stream
  ON usage_accruals (account_id, stream_id, from_at);

-- ---------- usage_records, finally used -------------------------------------
-- The period roll-up the 0001 schema declared and never populated. It gains
-- the compute columns it was missing: it could express egress and encode
-- minutes but had nowhere to put "how many distinct servers", which is half of
-- the question being asked.
--
-- `period_kind` and the unique key make the roll-up idempotent: recomputing a
-- period overwrites its row rather than appending a second one, so a re-run
-- after a fix does not double the month.
ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS period_kind TEXT
  NOT NULL DEFAULT 'day' CHECK (period_kind IN ('day', 'week', 'month', 'year'));
ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS compute_seconds BIGINT NOT NULL DEFAULT 0;
ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS servers_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS task_runs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS est_usd NUMERIC(12,4) NOT NULL DEFAULT 0;
ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS indicative BOOLEAN NOT NULL DEFAULT true;
-- Compute split by the kind of work, which is the allocation question in its
-- reporting form: how much of the month was transcode, how much was package
-- only, how much was radio.
ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS by_task_kind JSONB;
ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS computed_at TIMESTAMPTZ;

-- The roll-up is per account and period, NOT per channel: the existing
-- channel_id/event_id columns stay for a future per-stream roll-up and are
-- left NULL by the account roll-up. Partial-unique so both can coexist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_records_account_period
  ON usage_records (account_id, period_kind, period_start)
  WHERE channel_id IS NULL AND event_id IS NULL;
