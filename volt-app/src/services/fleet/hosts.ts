// ============================================================================
//  THE HOST REGISTRY.
//
//  One row per machine, upserted from observations, never from intent.
//
//  WHY THIS IS NOT JUST MORE COLUMNS ON `instances`. The 0001 schema tried
//  exactly that: instances carries ec2_instance_id, instance_type and
//  availability_zone. It cannot work, and the reason is arithmetic rather than
//  taste. `instances` is one row per task; a shared EC2 host carries several
//  tasks; so host facts stored there are duplicated N ways and there is no row
//  to hang a CPU reading on. "Four channels are on one c6i.2xlarge at 91%" is
//  unrepresentable no matter how many columns get added, and that sentence is
//  the entire point of the feature.
//
//  IDEMPOTENCE IS THE WHOLE CONTRACT. upsertHost is called on every
//  orchestrator tick for every running task. It must converge, never
//  accumulate, and never overwrite a known fact with a null just because this
//  particular observation was thinner than the last one: COALESCE(excluded, …)
//  keeps what we already learned. A provider that briefly stops reporting an
//  instance type must not erase it.
// ============================================================================
import { query, one } from '../../db';
import type { Placement, HostKind } from './placement';
import { regionFromAz } from './placement';

export interface HostRow {
  id: string;
  kind: HostKind;
  external_id: string;
  instance_type: string | null;
  region: string | null;
  availability_zone: string | null;
  lifecycle: 'spot' | 'on_demand' | null;
  vcpus: number | null;
  memory_mib: number | null;
  state: 'up' | 'gone';
  first_seen_at: Date;
  last_seen_at: Date;
  last_metric_at: Date | null;
}

/**
 * Record that this machine exists and was seen just now. Returns its id.
 *
 * A host that had been marked `gone` and is seen again comes back `up`. That
 * is not a curiosity: an EC2 host drains to empty between events and is
 * legitimately reused, and a registry that could only ever retire a host would
 * grow a fresh row for the same physical machine every time the fleet went
 * quiet, destroying the "how many distinct servers this month" figure the
 * roll-up depends on.
 */
export async function upsertHost(p: Placement): Promise<string> {
  const region = p.region ?? regionFromAz(p.availabilityZone) ?? null;
  const row = await one<{ id: string }>(
    `INSERT INTO compute_hosts
       (kind, external_id, instance_type, region, availability_zone,
        lifecycle, vcpus, memory_mib, state, first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'up', now(), now())
     ON CONFLICT (kind, external_id) DO UPDATE SET
       -- Keep what we know. A thinner observation must not erase a richer one.
       instance_type     = COALESCE(EXCLUDED.instance_type, compute_hosts.instance_type),
       region            = COALESCE(EXCLUDED.region, compute_hosts.region),
       availability_zone = COALESCE(EXCLUDED.availability_zone, compute_hosts.availability_zone),
       lifecycle         = COALESCE(EXCLUDED.lifecycle, compute_hosts.lifecycle),
       vcpus             = COALESCE(EXCLUDED.vcpus, compute_hosts.vcpus),
       memory_mib        = COALESCE(EXCLUDED.memory_mib, compute_hosts.memory_mib),
       state             = 'up',
       last_seen_at      = now()
     RETURNING id`,
    [p.hostKind, p.externalId, p.instanceType ?? null, region, p.availabilityZone ?? null,
     p.lifecycle ?? null, p.vcpus ?? null, p.memoryMib ?? null]
  );
  return row!.id;
}

/**
 * Attach a task to its host and record what it reserved.
 *
 * Separate from upsertHost so a placement observed without a task (a host we
 * learned about some other way) and a task observed without placement (a
 * launcher that cannot tell us) are both expressible. Neither is an error.
 */
export async function attachInstanceToHost(
  instanceId: string,
  hostId: string,
  p: Placement,
): Promise<void> {
  await query(
    `UPDATE instances SET
       host_id                = $2,
       container_instance_arn = COALESCE($3, container_instance_arn),
       capacity_provider      = COALESCE($4, capacity_provider),
       instance_type          = COALESCE($5, instance_type),
       availability_zone      = COALESCE($6, availability_zone),
       ec2_instance_id        = COALESCE($7, ec2_instance_id),
       cpu_units              = COALESCE($8, cpu_units),
       memory_mib             = COALESCE($9, memory_mib)
     WHERE id = $1`,
    [instanceId, hostId, p.containerInstanceArn ?? null, p.capacityProvider ?? null,
     p.instanceType ?? null, p.availabilityZone ?? null,
     p.hostKind === 'ec2' ? p.externalId : null,
     p.cpuUnits ?? null, p.taskMemoryMib ?? null]
  );
}

/**
 * Retire hosts that carry nothing and have not been seen for a while.
 *
 * The grace period is the point. A host is not retired the instant it goes
 * empty, because "empty" is the normal state between one channel stopping and
 * the next starting, and retiring on emptiness would churn the registry once a
 * minute on a busy cluster. It is retired when it has been both empty AND
 * unseen, which only happens once the provider genuinely stopped listing it.
 *
 * Rows are never deleted. A retired host is still the host that ran last
 * Tuesday's event, and the usage ledger points at it.
 */
export async function retireStaleHosts(graceSeconds = 900): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE compute_hosts h SET state = 'gone'
      WHERE h.state = 'up'
        AND h.last_seen_at < now() - make_interval(secs => $1)
        AND NOT EXISTS (
          SELECT 1 FROM instances i
           WHERE i.host_id = h.id AND i.terminated_at IS NULL
        )
      RETURNING h.id`,
    [graceSeconds]
  );
  return rows.length;
}

/** Mark that a metrics provider actually got a reading for these hosts. */
export async function stampMetric(hostIds: string[]): Promise<void> {
  if (!hostIds.length) return;
  await query(`UPDATE compute_hosts SET last_metric_at = now() WHERE id = ANY($1::uuid[])`, [hostIds]);
}

/** Every host currently carrying at least one live task, with what it carries. */
export interface LiveHost extends HostRow {
  tasks: number;
  streams: number;
  task_kinds: string[];
}

export async function liveHosts(): Promise<LiveHost[]> {
  return query<LiveHost>(
    `SELECT h.*,
            COUNT(i.id)::int                                   AS tasks,
            -- A STREAM is not a task. One channel can carry an encoder and a
            -- captions add-on; counting tasks would report it twice and make
            -- a host look twice as loaded as it is.
            COUNT(DISTINCT COALESCE(i.channel_id, i.event_id))::int AS streams,
            COALESCE(ARRAY_AGG(DISTINCT i.task_kind) FILTER (WHERE i.task_kind IS NOT NULL), '{}') AS task_kinds
       FROM compute_hosts h
       JOIN instances i ON i.host_id = h.id AND i.terminated_at IS NULL
      WHERE h.state = 'up'
        -- COMPUTE ONLY. This feeds the TENANT fleet view, and relay hosts are
        -- shared platform infrastructure: one tenant seeing the relay carrying
        -- their stations sees the box carrying everyone else's, and its load is
        -- driven by an audience that is not theirs.
        --
        -- The inner join above already excludes relays today, because a relay
        -- has no per-stream instances row. That is an ACCIDENT of the current
        -- shape rather than a decision, and it would stop being true the moment
        -- anything gives a relay a task. Stated explicitly so the protection
        -- does not depend on a join that was written for another reason.
        -- The system-admin view is /api/platform/relays.
        AND h.role = 'compute'
      GROUP BY h.id
      ORDER BY h.kind, h.external_id`
  );
}
