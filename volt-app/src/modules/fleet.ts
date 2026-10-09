// ============================================================================
//  FLEET API  (mounted at /api/fleet)
//
//  Two questions, two endpoints, and the split is the same one monitoring.ts
//  makes for streams: what is running NOW, and what has been used OVER TIME.
//
//    /hosts   THE SERVERS. Every machine currently carrying live work, what it
//             is, where it is, what it is running, how many streams it carries
//             and its latest CPU/network reading.
//
//    /usage   BILLABLE TIME. Totals for today and this month, a per-period
//             series, and a per-stream breakdown of all-time / today / month.
//
//  THE UNIT IS TIME. There is a rate table and the ledger freezes a rate onto
//  every accrual, but no endpoint here leads with money: an indicative dollar
//  figure sitting next to a real minute count gets repeated as though both
//  were equally real. `costUsd` is present, flagged indicative, and is the last
//  field on the object rather than the first.
//
//  Everything is READ-ONLY and tenant-scoped in the query rather than filtered
//  afterwards. Nothing here can change what is running.
// ============================================================================
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, badRequest } from '../util/http';
import { liveHosts } from '../services/fleet/hosts';
import { usageTotals, usageSeries, usagePerStream, type PeriodKind } from '../services/fleet/usage';

export const fleetRouter = Router();
fleetRouter.use(requireAuth);

/**
 * The live fleet.
 *
 * SCOPING IS THE SUBTLE PART. A host is shared infrastructure and is not owned
 * by a tenant, so it cannot simply be filtered by account. What a tenant may
 * see is the host that is carrying THEIR work, and only their own streams on
 * it. A multi-tenant EC2 host therefore appears to each tenant with its true
 * capacity figures and only their own stream list, and `tasks`/`streams` are
 * reported twice: `total` for the machine (which is what "is it coping" needs)
 * and `yours` for the tenant (which is what "what am I running" needs).
 *
 * Reporting only `yours` would make a host at 95% CPU look idle to the tenant
 * whose single channel is on it, which is exactly backwards: that tenant is
 * the one about to be affected.
 */
fleetRouter.get('/hosts', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const hosts = await liveHosts();
  if (!hosts.length) return res.json({ hosts: [], sampledAt: null });

  const ids = hosts.map((h) => h.id);

  // This tenant's live tasks, per host.
  const mine = await query<any>(
    `SELECT i.host_id, i.id, i.task_arn, i.task_kind, i.role, i.launched_at,
            i.channel_id, i.event_id,
            COALESCE(c.name, e.name)  AS stream_name,
            c.kind                     AS channel_kind
       FROM instances i
       LEFT JOIN channels c ON c.id = i.channel_id
       LEFT JOIN groups   gc ON gc.id = c.group_id
       LEFT JOIN events   e ON e.id = i.event_id
       LEFT JOIN groups   ge ON ge.id = e.group_id
      WHERE i.terminated_at IS NULL
        AND i.host_id = ANY($1::uuid[])
        AND COALESCE(gc.account_id, ge.account_id) = $2
      ORDER BY i.launched_at`,
    [ids, acct]
  );

  // The newest reading per host. DISTINCT ON is the right tool: it is one
  // index scan over (host_id, at DESC), where a correlated subquery per host
  // would be one scan each.
  const samples = await query<any>(
    `SELECT DISTINCT ON (host_id)
            host_id, at, source, cpu_pct, mem_pct, net_in_bps, net_out_bps, tasks_on_host
       FROM host_samples
      WHERE host_id = ANY($1::uuid[])
        AND at > now() - interval '30 minutes'
      ORDER BY host_id, at DESC`,
    [ids]
  );
  const latest = new Map(samples.map((s) => [s.host_id, s]));

  const byHost = new Map<string, any[]>();
  for (const t of mine) {
    if (!byHost.has(t.host_id)) byHost.set(t.host_id, []);
    byHost.get(t.host_id)!.push(t);
  }

  const out = hosts
    // A tenant is shown hosts carrying their work. A host running only other
    // tenants' streams is not theirs to see.
    .filter((h) => byHost.has(h.id))
    .map((h) => {
      const s = latest.get(h.id);
      const ours = byHost.get(h.id)!;
      return {
        id: h.id,
        kind: h.kind,
        externalId: h.external_id,
        instanceType: h.instance_type,
        availabilityZone: h.availability_zone,
        region: h.region,
        lifecycle: h.lifecycle,
        vcpus: h.vcpus,
        memoryMib: h.memory_mib,
        firstSeenAt: h.first_seen_at,
        lastSeenAt: h.last_seen_at,
        // Machine-wide, which is what capacity questions need.
        tasksTotal: h.tasks,
        streamsTotal: h.streams,
        // This tenant's share.
        tasksYours: ours.length,
        streamsYours: new Set(ours.map((t) => t.channel_id ?? t.event_id)).size,
        taskKinds: h.task_kinds,
        // NULL means no reading, never idle. The UI must render it as such.
        metrics: s ? {
          at: s.at,
          source: s.source,
          cpuPct: s.cpu_pct == null ? null : Number(s.cpu_pct),
          memPct: s.mem_pct == null ? null : Number(s.mem_pct),
          netInBps: s.net_in_bps == null ? null : Number(s.net_in_bps),
          netOutBps: s.net_out_bps == null ? null : Number(s.net_out_bps),
          tasksAtSample: s.tasks_on_host,
        } : null,
        streams: ours.map((t) => ({
          instanceId: t.id,
          id: t.channel_id ?? t.event_id,
          type: t.channel_id ? (t.channel_kind === 'radio' ? 'radio' : 'channel') : 'event',
          name: t.stream_name,
          taskKind: t.task_kind,
          role: t.role,
          launchedAt: t.launched_at,
        })),
      };
    });

  res.json({ hosts: out });
}));

const periodSchema = z.enum(['day', 'week', 'month', 'year']);

/**
 * Billable usage.
 *
 * `accrued` and `pending` are returned separately rather than summed, because
 * they are different kinds of fact. Accrued is settled and will not change.
 * Pending is time a task has been running since the meter last wrote, which is
 * real usage but is still moving. Summing them silently would make a settled
 * month and a live minute indistinguishable.
 */
fleetRouter.get('/usage', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const p = periodSchema.safeParse(req.query.period ?? 'day');
  if (!p.success) throw badRequest('period must be day, week, month or year');
  const limit = Math.min(365, Math.max(1, Number(req.query.limit ?? 30) || 30));
  const now = new Date();

  const [totals, series, streams] = await Promise.all([
    usageTotals(acct, now),
    usageSeries(acct, p.data as PeriodKind, limit),
    usagePerStream(acct, now),
  ]);

  res.json({
    period: p.data,
    generatedAt: now.toISOString(),
    totals,
    series,
    streams,
    // Said out loud rather than left for the reader to work out. The meter
    // records seconds; the rate table is seeded with placeholder figures, so
    // any money derived from these numbers is an estimate and is not returned
    // by this endpoint at all.
    unit: 'seconds',
  });
}));

/** One stream's usage, for the detail pages. */
fleetRouter.get('/usage/stream/:id', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const all = await usagePerStream(acct, new Date());
  const row = all.find((s) => s.id === req.params.id);
  // A stream with no usage is not an error: it has never run. Zeros are the
  // correct answer here, unlike a metric, because "this ran for no seconds" is
  // something we actually know.
  res.json(row ?? {
    id: req.params.id, kind: 'channel', name: null, channelKind: null,
    allTimeSeconds: 0, todaySeconds: 0, monthSeconds: 0, pendingSeconds: 0,
    runs: 0, lastUsedAt: null,
  });
}));

/**
 * Recent telemetry for one host, for a sparkline.
 *
 * Ordered ascending because it is drawn left to right, and capped rather than
 * paginated because nobody scrolls a sparkline.
 */
fleetRouter.get('/hosts/:id/samples', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  // The tenant must have work on this host to read its telemetry.
  const owns = await query<{ n: string }>(
    `SELECT count(*) AS n FROM instances i
       LEFT JOIN channels c ON c.id = i.channel_id
       LEFT JOIN groups   gc ON gc.id = c.group_id
       LEFT JOIN events   e ON e.id = i.event_id
       LEFT JOIN groups   ge ON ge.id = e.group_id
      WHERE i.host_id = $1 AND i.terminated_at IS NULL
        AND COALESCE(gc.account_id, ge.account_id) = $2`,
    [req.params.id, acct]
  );
  if (Number(owns[0]?.n ?? 0) === 0) return res.json({ samples: [] });

  const rows = await query<any>(
    `SELECT at, source, cpu_pct, mem_pct, net_in_bps, net_out_bps, tasks_on_host
       FROM host_samples
      WHERE host_id = $1 AND at > now() - interval '6 hours'
      ORDER BY at ASC
      LIMIT 500`,
    [req.params.id]
  );
  res.json({
    samples: rows.map((r) => ({
      at: r.at, source: r.source,
      cpuPct: r.cpu_pct == null ? null : Number(r.cpu_pct),
      memPct: r.mem_pct == null ? null : Number(r.mem_pct),
      netInBps: r.net_in_bps == null ? null : Number(r.net_in_bps),
      netOutBps: r.net_out_bps == null ? null : Number(r.net_out_bps),
      tasks: r.tasks_on_host,
    })),
  });
}));
