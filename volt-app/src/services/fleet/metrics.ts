// ============================================================================
//  IS THE SERVER COPING?
//
//  Three providers behind one interface, chosen by how the fleet is actually
//  deployed rather than configured independently: CloudWatch when tasks run on
//  ECS, the on-box readers when they run here, nothing when neither applies.
//
//  ------------------------------------------------------------------------
//  THE ONE RULE: A MISSING READING IS NOT A ZERO.
//
//  Every field on a Reading is independently nullable and every provider
//  returns null rather than a number it did not obtain. This is not fussiness.
//  A capacity screen that draws 0% for a host it could not reach shows an idle
//  fleet at the exact moment the fleet is in trouble, and an operator who has
//  learned to read the graph will act on it. Absent must look absent.
//
//  Nothing is stored for a null reading either: host_samples has no row for a
//  sample that failed, so history is sparse where measurement was sparse and a
//  later average is not dragged toward zero by the gaps.
//
//  ------------------------------------------------------------------------
//  CLOUDWATCH LAGS, AND THAT IS FINE HERE. EC2 basic monitoring publishes at
//  five-minute resolution and detailed monitoring at one minute, so the newest
//  point is minutes old. That is acceptable for "is this server coping", which
//  is a question about a trend. It would not be acceptable for a control loop,
//  and nothing in this system uses these numbers to make a decision: they are
//  shown to a person.
//
//  This is also why Cost Explorer is not used anywhere in this feature. It lags
//  by hours to a day, so it cannot answer "what is running right now", which is
//  the question actually being asked.
// ============================================================================
import { config } from '../../config';
import { query } from '../../db';
import { stampMetric } from './hosts';
import { sampleOnbox } from './onbox';

export interface Reading {
  hostId: string;
  cpuPct: number | null;
  memPct: number | null;
  netInBps: number | null;
  netOutBps: number | null;
  source: 'cloudwatch' | 'onbox' | 'task_stats';
}

export interface MetricsProvider {
  readonly name: string;
  /** Readings for the given hosts. May return fewer than asked for. */
  sample(hosts: MetricHost[]): Promise<Reading[]>;
}

export interface MetricHost {
  id: string;
  kind: 'ec2' | 'fargate' | 'local';
  external_id: string;
  region: string | null;
}

/** A deployment with no telemetry source. Honest about it. */
export class NoMetricsProvider implements MetricsProvider {
  readonly name = 'none';
  async sample(): Promise<Reading[]> { return []; }
}

/**
 * The box the control plane runs on. Applies to `local` hosts only.
 *
 * There is exactly one such host per control plane, so this reads /proc once
 * regardless of how many hosts it is handed, and attributes the reading to
 * every local host it was asked about — of which there is one.
 */
export class OnboxMetricsProvider implements MetricsProvider {
  readonly name = 'onbox';
  async sample(hosts: MetricHost[]): Promise<Reading[]> {
    const local = hosts.filter((h) => h.kind === 'local');
    if (!local.length) return [];
    const r = await sampleOnbox();
    // The first sample after start-up has no interval to divide by, so cpu and
    // network are null. Storing that row would be storing "we do not know",
    // which the absence of a row already says more clearly.
    if (r.cpuPct == null && r.memPct == null && r.netInBps == null) return [];
    return local.map((h) => ({
      hostId: h.id, source: 'onbox' as const,
      cpuPct: r.cpuPct, memPct: r.memPct, netInBps: r.netInBps, netOutBps: r.netOutBps,
    }));
  }
}

/**
 * CloudWatch, for EC2 container instances.
 *
 * GetMetricData rather than GetMetricStatistics: one call carries up to 500
 * queries, so a fleet of forty hosts is one request instead of a hundred and
 * twenty, and it is the request that gets throttled when a fleet is large.
 *
 * FARGATE HOSTS ARE SKIPPED, deliberately and not as an oversight. There is no
 * AWS/EC2 metric for a Fargate microVM; task-level CPU lives in the
 * ECS/ContainerInsights namespace and only exists if Container Insights is
 * enabled on the cluster, which is an opt-in that costs money. Returning
 * nothing for Fargate is truthful. Inventing a host utilisation for a
 * single-task microVM would be worse than useless, because "80% of one task's
 * reservation" and "80% of a shared machine" mean opposite things about
 * whether to add capacity.
 *
 * NETWORK IS CONVERTED TO BITS PER SECOND. NetworkIn/NetworkOut are SUMS of
 * BYTES over the period, so the raw statistic depends on the period length and
 * two graphs at different resolutions would not be comparable. Dividing by the
 * period and multiplying by eight gives a rate, which is the thing an operator
 * actually compares against a link.
 */
export class CloudWatchMetricsProvider implements MetricsProvider {
  readonly name = 'cloudwatch';
  private clients = new Map<string, any>();
  /** Seconds of aggregation. 300 matches EC2 basic monitoring. */
  constructor(private periodSeconds = 300) {}

  private async client(region: string) {
    if (!this.clients.has(region)) {
      const { CloudWatchClient } = await import('@aws-sdk/client-cloudwatch');
      this.clients.set(region, new CloudWatchClient({ region }));
    }
    return this.clients.get(region);
  }

  async sample(hosts: MetricHost[]): Promise<Reading[]> {
    const ec2 = hosts.filter((h) => h.kind === 'ec2' && /^i-/.test(h.external_id));
    if (!ec2.length) return [];

    // Grouped by region because a metric query is region-scoped and a fleet
    // can straddle regions. Sending one region's instance ids to another
    // region's endpoint returns empty results rather than an error, which
    // would look exactly like a quiet fleet.
    const byRegion = new Map<string, MetricHost[]>();
    for (const h of ec2) {
      const r = h.region ?? config.aws.region;
      if (!byRegion.has(r)) byRegion.set(r, []);
      byRegion.get(r)!.push(h);
    }

    const out: Reading[] = [];
    for (const [region, group] of byRegion) {
      try {
        out.push(...await this.sampleRegion(region, group));
      } catch (e) {
        // One region failing must not lose the others.
        console.warn('[fleet] cloudwatch sample failed for', region, e);
      }
    }
    return out;
  }

  /** The query id ↔ host mapping. `m<n>_<metric>` because ids must match /^[a-z]/. */
  buildQueries(group: MetricHost[]): any[] {
    const q: any[] = [];
    group.forEach((h, i) => {
      const dim = [{ Name: 'InstanceId', Value: h.external_id }];
      for (const [suffix, metric, stat] of [
        ['cpu', 'CPUUtilization', 'Average'],
        ['nin', 'NetworkIn', 'Sum'],
        ['nout', 'NetworkOut', 'Sum'],
      ] as const) {
        q.push({
          Id: `m${i}_${suffix}`,
          MetricStat: {
            Metric: { Namespace: 'AWS/EC2', MetricName: metric, Dimensions: dim },
            Period: this.periodSeconds,
            Stat: stat,
          },
          ReturnData: true,
        });
      }
    });
    return q;
  }

  private async sampleRegion(region: string, group: MetricHost[]): Promise<Reading[]> {
    const { GetMetricDataCommand } = await import('@aws-sdk/client-cloudwatch');
    const cw = await this.client(region);
    const end = new Date();
    // Two periods back, so there is at least one complete bucket even when the
    // current one has not been published yet.
    const start = new Date(end.getTime() - this.periodSeconds * 2000);
    const res: any = await cw.send(new GetMetricDataCommand({
      StartTime: start, EndTime: end,
      MetricDataQueries: this.buildQueries(group),
      ScanBy: 'TimestampDescending',
    }) as any);
    return this.readResults(res.MetricDataResults ?? [], group);
  }

  /**
   * Kept separate from the AWS call so the parsing is unit-testable without a
   * network. The newest value wins; an empty Values array means the metric
   * exists but has not published in the window, which is null, not zero.
   */
  readResults(results: any[], group: MetricHost[]): Reading[] {
    const byHost = new Map<string, Reading>();
    for (const h of group) {
      byHost.set(h.id, {
        hostId: h.id, source: 'cloudwatch',
        cpuPct: null, memPct: null, netInBps: null, netOutBps: null,
      });
    }
    for (const r of results) {
      const m = /^m(\d+)_(cpu|nin|nout)$/.exec(String(r?.Id ?? ''));
      if (!m) continue;
      const host = group[Number(m[1])];
      if (!host) continue;
      const v = r.Values?.[0];
      if (v == null || !Number.isFinite(Number(v))) continue;
      const reading = byHost.get(host.id)!;
      if (m[2] === 'cpu') {
        reading.cpuPct = Math.round(Number(v) * 100) / 100;
      } else {
        // Sum of BYTES over the period -> bits per second.
        const bps = Math.round((Number(v) * 8) / this.periodSeconds);
        if (m[2] === 'nin') reading.netInBps = bps; else reading.netOutBps = bps;
      }
    }
    // Drop hosts we learned nothing about, so an unreachable host is absent
    // rather than a row of nulls that looks like a measured idle.
    return [...byHost.values()].filter(
      (r) => r.cpuPct != null || r.netInBps != null || r.netOutBps != null
    );
  }
}

/**
 * Which provider this deployment has.
 *
 * Derived from the launcher rather than configured separately, because the two
 * cannot legitimately disagree: tasks running on ECS are measured by
 * CloudWatch and tasks running here are measured here. A separate setting
 * would only ever be a way to configure it wrongly.
 */
export function makeMetricsProvider(): MetricsProvider {
  switch (config.orchestrator.launcher) {
    case 'ecs':    return new CloudWatchMetricsProvider();
    case 'local':
    case 'docker': return new OnboxMetricsProvider();
    default:       return new NoMetricsProvider();
  }
}

/** Take a reading for every live host and store what came back. */
export async function sampleFleet(provider: MetricsProvider = makeMetricsProvider()): Promise<number> {
  if (provider.name === 'none') return 0;
  const hosts = await query<MetricHost & { tasks: number }>(
    `SELECT h.id, h.kind, h.external_id, h.region,
            COUNT(i.id) FILTER (WHERE i.terminated_at IS NULL)::int AS tasks
       FROM compute_hosts h
       LEFT JOIN instances i ON i.host_id = h.id
      WHERE h.state = 'up'
      GROUP BY h.id`
  );
  if (!hosts.length) return 0;

  const readings = await provider.sample(hosts);
  if (!readings.length) return 0;

  const loadAt = new Map(hosts.map((h) => [h.id, h.tasks]));
  for (const r of readings) {
    await query(
      `INSERT INTO host_samples (host_id, source, cpu_pct, mem_pct, net_in_bps, net_out_bps, tasks_on_host)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [r.hostId, r.source, r.cpuPct, r.memPct, r.netInBps, r.netOutBps, loadAt.get(r.hostId) ?? null]
    );
  }
  await stampMetric(readings.map((r) => r.hostId));
  return readings.length;
}

/**
 * Keep telemetry from growing without bound.
 *
 * Samples are the one table here that grows with time rather than with the
 * fleet: a hundred hosts at one sample a minute is 144,000 rows a day. The
 * usage ledger is deliberately NOT swept — that is the billable record and
 * must outlive everything — but a CPU reading from March answers no question
 * anyone asks.
 */
export async function pruneSamples(keepDays = 14): Promise<number> {
  const rows = await query<{ id: string }>(
    `DELETE FROM host_samples WHERE at < now() - make_interval(days => $1) RETURNING id`,
    [keepDays]
  );
  return rows.length;
}
