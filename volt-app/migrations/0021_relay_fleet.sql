-- ============================================================================
--  THE RELAY TIER JOINS THE FLEET.
--
--  Radio has one output that is not a file. HLS and DASH are segments a station
--  writes and a CDN serves; MP3 is a live PUSH to an Icecast relay that owns
--  listener fan-out. Until now that relay was a single ICECAST_HOST:PORT in the
--  environment, which meant three things were unanswerable:
--
--    WHICH relay is this station pointed at?   There was only one, by fiat.
--    HOW IS IT DOING?                          Nothing sampled it.
--    WHAT DOES IT COST?                        Nothing accrued for it, so the
--                                              fleet page implied it was free.
--
--  Everything needed already existed for encoders and was simply not pointed at
--  the relay: compute_hosts carries what a machine is and when it was first and
--  last seen; host_samples carries cpu, memory and NETWORK IN AND OUT; the rates
--  table carries prices that stay flagged `indicative` until somebody replaces
--  them with contracted ones. This migration attaches the relay to that
--  machinery rather than building a second one beside it.
--
--  WHY THE COST SHAPE FORCED NEW COLUMNS. An encoder's bill is hours: the task
--  costs the same whether one person or a million are watching, because it
--  serves none of them. A relay is the opposite -- nearly free until listeners
--  arrive, then proportional to them. A 128 kbps mount is 16 KB/s per listener,
--  so a thousand concurrent listeners is about 57 GB an hour, which at ordinary
--  cloud egress is far more than the instance underneath it. Accruing only the
--  hourly would have put two cents an hour on the invoice and missed what is
--  actually being spent. So rates gain an egress dimension, and the ledger gains
--  bytes.
-- ============================================================================

-- ---------- 1. a host has a ROLE, not just a shape ---------------------------
--
-- `kind` is the provider shape (ec2 / fargate / local) and a relay is an EC2
-- instance like any other, so kind is not the place to say what it is FOR. A
-- fleet page that cannot separate the machines doing the encoding from the
-- machines doing the fan-out cannot answer either question about either group.
ALTER TABLE compute_hosts
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'compute';
DO $$ BEGIN
  ALTER TABLE compute_hosts ADD CONSTRAINT compute_hosts_role_check
    CHECK (role IN ('compute', 'relay'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_compute_hosts_role ON compute_hosts (role, state);

-- ---------- 2. the relays themselves -----------------------------------------
--
-- A relay is an ADDRESS a station pushes to plus, separately, an address a
-- LISTENER is given. Those are not the same and never were: the station reaches
-- the relay in-VPC, while the listener reaches whatever sits in front of it.
-- ICECAST_PUBLIC_BASE already expressed that split for the single-relay case;
-- here it becomes a per-relay column, because with more than one relay the
-- listener URL has to follow the assignment.
CREATE TABLE IF NOT EXISTS relays (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name           TEXT NOT NULL,
    -- The machine, so cost and telemetry come from the same place they do for
    -- encoders. NULL while a relay is configured but its host has not been
    -- identified yet, which is a real state and not an error.
    host_id        UUID REFERENCES compute_hosts(id) ON DELETE SET NULL,

    -- Where a STATION pushes. In-VPC, never shown to a listener.
    source_host    TEXT NOT NULL,
    source_port    INTEGER NOT NULL DEFAULT 8000,
    source_user    TEXT NOT NULL DEFAULT 'source',
    tls            BOOLEAN NOT NULL DEFAULT false,
    -- Deliberately NOT the password. Credentials stay in the environment or a
    -- secret store; this table holds topology, and a schema that invites a
    -- password into a queryable row will eventually receive one.
    secret_ref     TEXT,

    -- Where a LISTENER is sent: a CDN, a load balancer, or the relay itself.
    public_base    TEXT,

    -- The relay's own admin endpoint, for /admin/stats. That is the only source
    -- of a real concurrent-listener number per mount.
    admin_base     TEXT,
    admin_user     TEXT,

    -- CAPACITY IS A PLANNING NUMBER, NOT A LIMIT WE ENFORCE. Icecast fan-out is
    -- bounded by network and file descriptors rather than CPU, so the useful
    -- figure is how many concurrent listeners this relay is expected to carry.
    -- Recorded so the fleet page can show headroom; nothing rejects a station
    -- for exceeding it, because refusing to go on air is worse than being busy.
    max_listeners  INTEGER,

    -- 'draining' is why this is not a boolean: a relay being retired must stop
    -- taking NEW stations while the ones already on it keep broadcasting.
    state          TEXT NOT NULL DEFAULT 'active'
                   CHECK (state IN ('active', 'draining', 'offline')),
    region         TEXT,
    note           TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_relays_endpoint
  ON relays (source_host, source_port);
CREATE INDEX IF NOT EXISTS idx_relays_assignable
  ON relays (state) WHERE state = 'active';

-- ---------- 3. which relay a station is pointed at ---------------------------
--
-- ON THE CHANNEL, AND STICKY. A station is a SOURCE: it pushes to exactly one
-- address, so it cannot be spread across relays and the assignment has to be a
-- fact rather than a per-start decision. Sticky also means a restart does not
-- silently move a station to a different relay and change its listener URL --
-- and hardware receivers are configured once and never again.
--
-- NULL means "not yet assigned", which resolves at start time and is then
-- written back. It is not the same as "no relay": a deployment with no relays
-- registered at all falls back to the single ICECAST_HOST from the environment,
-- so an existing local setup keeps working untouched.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS relay_id UUID
  REFERENCES relays(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_channels_relay ON channels (relay_id)
  WHERE relay_id IS NOT NULL;

-- ---------- 4. rates gain an egress dimension --------------------------------
--
-- compute_rates answers "what does an hour of this instance type cost". For a
-- relay the dominant term is bytes out, and it is priced per GB rather than per
-- hour, so it does not fit in that table's grain: one relay has both, and they
-- are billed on different meters.
--
-- `indicative` carries the same meaning it does for compute rates, and for the
-- same reason: a number nobody has replaced with a contracted rate must keep
-- saying so all the way to the invoice line.
CREATE TABLE IF NOT EXISTS egress_rates (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    region         TEXT,                       -- NULL matches any region
    usd_per_gb     NUMERIC(10,5) NOT NULL,
    indicative     BOOLEAN NOT NULL DEFAULT true,
    effective_from TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
    note           TEXT
);
CREATE INDEX IF NOT EXISTS idx_egress_rates_lookup
  ON egress_rates (region, effective_from DESC);

INSERT INTO egress_rates (region, usd_per_gb, indicative, note)
SELECT NULL, 0.09000, true, 'seeded: common first-tier cloud egress, replace with the contracted rate'
WHERE NOT EXISTS (SELECT 1 FROM egress_rates);

-- A relay instance type needs an hourly like anything else. Seeded indicative,
-- and sized for fan-out rather than compute: network-optimised, small CPU.
INSERT INTO compute_rates (instance_type, lifecycle, usd_per_hour, indicative, note)
SELECT * FROM (VALUES
    ('c6in.large',  'on_demand', 0.11340, true, 'icecast relay, network-optimised, seeded'),
    ('c6in.large',  'spot',      0.03402, true, 'icecast relay, seeded, ~30% of on-demand'),
    ('t3.medium',   'on_demand', 0.04160, true, 'small icecast relay, seeded'),
    ('t3.medium',   'spot',      0.01248, true, 'small icecast relay, seeded, ~30%')
) AS v(instance_type, lifecycle, usd_per_hour, indicative, note)
WHERE NOT EXISTS (SELECT 1 FROM compute_rates WHERE instance_type = 'c6in.large');

-- ---------- 5. the relay usage ledger ----------------------------------------
--
-- APPEND ONLY, one row per metered window per relay, the same shape and the
-- same rules as usage_accruals: half-open [from, to) windows that cannot
-- overlap, and cost frozen at accrual time rather than recomputed on read,
-- because the rate that applied is the rate that applied.
--
-- SEPARATE FROM usage_accruals ON PURPOSE. That table's grain is one row per
-- TASK per window and every row is attributable to one stream and one account.
-- A relay is shared infrastructure: its hour belongs to no single station, and
-- its bytes belong to many. Forcing it into the same table would mean either a
-- fake account_id or a nullable one, and a nullable account on a billing ledger
-- is how "unattributed" quietly becomes "unbilled".
--
-- Attribution of the BYTES to stations is a separate question answered by
-- listener sessions; this ledger answers what the tier itself cost.
CREATE TABLE IF NOT EXISTS relay_accruals (
    id             BIGSERIAL PRIMARY KEY,
    relay_id       UUID REFERENCES relays(id) ON DELETE SET NULL,
    host_id        UUID REFERENCES compute_hosts(id) ON DELETE SET NULL,
    -- Carried without a foreign key, and with the name at the time, so deleting
    -- a relay cannot retroactively erase what it cost. Same reasoning as
    -- stream_id/stream_name on usage_accruals.
    relay_ref      UUID,
    relay_name     TEXT,
    instance_type  TEXT,
    lifecycle      TEXT,
    from_at        TIMESTAMPTZ NOT NULL,
    to_at          TIMESTAMPTZ NOT NULL,
    seconds        INTEGER NOT NULL,
    -- Integrated from host_samples.net_out_bps across the window. NULL means we
    -- could not measure, which is different from zero bytes served, and the two
    -- must never be shown as the same thing.
    bytes_out      BIGINT,
    peak_listeners INTEGER,
    usd_per_hour   NUMERIC(10,5),
    usd_per_gb     NUMERIC(10,5),
    est_compute_usd NUMERIC(12,6),
    est_egress_usd  NUMERIC(12,6),
    est_usd        NUMERIC(12,6),
    -- True when ANY rate used was indicative. One estimated input makes the
    -- whole line an estimate, and rolling that up as if it were a quote is how
    -- a demo number ends up in a board pack.
    indicative     BOOLEAN NOT NULL DEFAULT true,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (to_at > from_at)
);
CREATE INDEX IF NOT EXISTS idx_relay_accruals_relay ON relay_accruals (relay_id, from_at DESC);
CREATE INDEX IF NOT EXISTS idx_relay_accruals_window ON relay_accruals (from_at, to_at);

-- ---------- 6. what it ACTUALLY cost -----------------------------------------
--
-- THE POINT OF ALL THE ABOVE IS A COMPARISON, and the platform could only ever
-- produce one side of it. Every number in the fleet is an ESTIMATE built from
-- observed hours and a rate table; the invoice that arrives at the end of the
-- month is the other side, and without somewhere to put it the estimate can
-- never be checked and therefore never improves.
--
-- One row per period per category, entered by an admin or imported from a cost
-- report. Deliberately coarse: matching a cloud bill line-for-line to internal
-- accruals is a project, while "we estimated $X for relays in March and were
-- billed $Y" is one row and answers the question actually being asked.
CREATE TABLE IF NOT EXISTS cost_actuals (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- First day of the month it covers, UTC. A date rather than a range because
    -- cloud bills are monthly and pretending otherwise invites overlap.
    period_month  DATE NOT NULL,
    category      TEXT NOT NULL
                  CHECK (category IN ('compute', 'relay', 'egress', 'storage', 'other')),
    usd           NUMERIC(12,2) NOT NULL,
    source        TEXT,                        -- 'aws-cur', 'manual', an invoice id
    note          TEXT,
    entered_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cost_actuals_period
  ON cost_actuals (period_month, category);
