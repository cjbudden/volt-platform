// ============================================================================
//  THE RELAY TIER: which relay a station pushes to, and what that tier costs.
//
//  A station is an Icecast SOURCE. It pushes MP3 to exactly one address, and the
//  relay owns listener fan-out. That makes the relay the one component whose
//  cost is driven by AUDIENCE rather than by how many streams are running, and
//  the one that until now existed only as ICECAST_HOST in the environment.
//
//  THREE QUESTIONS THIS FILE EXISTS TO ANSWER, all of which were unanswerable:
//
//    Which relay is this station pointed at?
//    How is that relay doing right now?
//    What is it costing, and how does that compare to the actual bill?
//
//  WHO MAY ASK. All three are SYSTEM ADMIN questions, not account admin ones.
//  The relay topology is shared infrastructure, and relay_accruals plus
//  cost_actuals are the platform's own COST BASIS -- showing a tenant what their
//  traffic costs us to serve tells them our margin. So everything here is
//  reached through /api/platform behind requirePlatform, never from the tenant
//  API. A tenant's own usage is a different question with a different answer:
//  usage_accruals is already account-scoped and stays where it is.
// ============================================================================
import { query, one } from '../../db';
import { config } from '../../config';

export interface RelayRow {
  id: string;
  name: string;
  host_id: string | null;
  source_host: string;
  source_port: number;
  source_user: string;
  tls: boolean;
  secret_ref: string | null;
  public_base: string | null;
  admin_base: string | null;
  max_listeners: number | null;
  state: 'active' | 'draining' | 'offline';
  region: string | null;
}

/** What a station needs in order to push, and what a listener needs in order to play. */
export interface RelayTarget {
  /** Null when this deployment has no relays registered and is using the env. */
  relayId: string | null;
  host: string;
  port: number;
  username: string;
  password: string;
  tls: boolean;
  /** The listener-facing base, or '' to fall back to host:port. */
  publicBase: string;
}

/**
 * THE SINGLE-RELAY FALLBACK, and why it is not a temporary shim.
 *
 * A deployment with no `relays` rows is not misconfigured: it is a development
 * machine, or a small install with one Icecast, and ICECAST_HOST describes it
 * completely. Requiring a row before a station can go on air would break every
 * existing setup to buy nothing, so an empty table means "use the environment"
 * and the assignment logic simply never runs.
 */
function envTarget(): RelayTarget {
  const ice = config.icecast;
  return {
    relayId: null,
    host: ice.host,
    port: ice.port,
    username: ice.sourceUser,
    password: ice.sourcePassword,
    tls: ice.tls,
    publicBase: ice.publicBase,
  };
}

/**
 * The source password for a relay.
 *
 * NOT A COLUMN, on purpose. `relays.secret_ref` names a secret; the value comes
 * from the environment (or, in a real deployment, a secret store keyed by that
 * name). A schema that has somewhere convenient to put a password will
 * eventually be given one, and then it is in every backup and every query log.
 */
function passwordFor(r: RelayRow): string {
  if (r.secret_ref) {
    const fromEnv = process.env[r.secret_ref];
    if (fromEnv) return fromEnv;
  }
  return config.icecast.sourcePassword;
}

export async function listRelays(): Promise<RelayRow[]> {
  return query<RelayRow>(`SELECT * FROM relays ORDER BY name`);
}

/**
 * Pick a relay for a station that has none.
 *
 * LEAST-LOADED BY ASSIGNED STATIONS, not by listeners. Listener counts move by
 * the minute and would make assignment flap between two relays as an audience
 * shifts; the number of stations pointed at a relay is stable, and a station is
 * assigned once and then stays. Ties break on the relay's name so the choice is
 * deterministic, which matters when two control-plane replicas start the same
 * station at the same moment and would otherwise choose differently.
 *
 * 'draining' relays are excluded: that state exists precisely so a relay can be
 * retired without taking the stations already on it off air.
 */
async function pickRelay(): Promise<RelayRow | null> {
  return one<RelayRow>(
    `SELECT r.* FROM relays r
      LEFT JOIN channels c ON c.relay_id = r.id
      WHERE r.state = 'active'
      GROUP BY r.id
      ORDER BY count(c.id) ASC, r.name ASC
      LIMIT 1`
  );
}

/**
 * Where this station pushes, assigning it a relay the first time and keeping it
 * there afterwards.
 *
 * STICKY, AND THAT IS THE WHOLE POINT. mountFor() derives the mount from the
 * channel id specifically so a renamed station keeps its listener URL; choosing
 * a relay afresh on every start would move the HOST in that URL instead and
 * undo it. Hardware receivers and car head units are configured once and never
 * again, so a URL that changes on a restart is a URL that is simply broken.
 *
 * A station whose assigned relay has since gone offline is REASSIGNED rather
 * than left unable to start: an unusable assignment is not worth honouring, and
 * a station that cannot go on air is worse than one whose URL changed.
 */
export async function resolveRelayFor(channelId: string): Promise<RelayTarget> {
  const assigned = await one<RelayRow>(
    `SELECT r.* FROM relays r JOIN channels c ON c.relay_id = r.id WHERE c.id = $1`,
    [channelId]
  );
  if (assigned && assigned.state !== 'offline') return targetOf(assigned);

  const picked = await pickRelay();
  if (!picked) {
    // No relays registered at all. Not an error: see envTarget.
    if (assigned) {
      console.warn(`[relays] ${channelId} is assigned to an offline relay and there is no replacement; using the environment`);
    }
    return envTarget();
  }
  await query(`UPDATE channels SET relay_id = $2 WHERE id = $1`, [channelId, picked.id]);
  if (assigned) {
    console.log(`[relays] ${channelId} moved off offline relay ${assigned.name} to ${picked.name}`);
  } else {
    console.log(`[relays] ${channelId} assigned to relay ${picked.name}`);
  }
  return targetOf(picked);
}

function targetOf(r: RelayRow): RelayTarget {
  return {
    relayId: r.id,
    host: r.source_host,
    port: r.source_port,
    username: r.source_user,
    password: passwordFor(r),
    tls: r.tls,
    publicBase: r.public_base ?? '',
  };
}

/**
 * The listener-facing base for a station, following its assignment.
 *
 * With one relay this was a single environment variable. With several, the
 * public base has to follow the assignment or half the stations are advertised
 * on a relay they do not push to.
 */
export async function publicBaseFor(channelId: string): Promise<string> {
  const r = await one<{ public_base: string | null }>(
    `SELECT r.public_base FROM relays r JOIN channels c ON c.relay_id = r.id WHERE c.id = $1`,
    [channelId]
  );
  return r?.public_base || config.icecast.publicBase || '';
}

// ---------------------------------------------------------------------------
//  What the tier is doing, and what it costs
// ---------------------------------------------------------------------------

export interface RelayHealth {
  relay: RelayRow;
  /** Stations currently pointed at this relay. */
  stations: number;
  /** Of those, how many are live right now. */
  stationsLive: number;
  /** Seconds since the host was first seen, or null when there is no host row. */
  uptimeSeconds: number | null;
  /** The most recent sample, or null. NEVER a zero standing in for "no reading". */
  sample: {
    at: string; cpuPct: number | null; memPct: number | null;
    netOutBps: number | null; netInBps: number | null; source: string;
  } | null;
  /** True when the host exists but has not been measured recently. */
  stale: boolean;
}

const STALE_AFTER_SECONDS = 300;

/**
 * Relay health for the system-admin fleet view.
 *
 * A HOST WE CAN SEE BUT CANNOT MEASURE IS A DISTINCT STATE. host_samples writes
 * no row for a reading that failed, so an absent sample reads as absent; this
 * returns null rather than zero, and `stale` rather than pretending the last
 * reading is current. A relay drawn at 0% CPU because nothing has reported in an
 * hour is worse than one drawn as unknown: the first invites a conclusion.
 */
export async function relayHealth(): Promise<RelayHealth[]> {
  const relays = await listRelays();
  const out: RelayHealth[] = [];
  for (const r of relays) {
    const counts = await one<{ stations: string; live: string }>(
      `SELECT count(*)::text AS stations,
              count(*) FILTER (WHERE status = 'live')::text AS live
         FROM channels WHERE relay_id = $1`, [r.id]);
    const host = r.host_id
      ? await one<any>(`SELECT first_seen_at, last_metric_at FROM compute_hosts WHERE id = $1`, [r.host_id])
      : null;
    const s = r.host_id
      ? await one<any>(
          `SELECT at, cpu_pct, mem_pct, net_out_bps, net_in_bps, source
             FROM host_samples WHERE host_id = $1 ORDER BY at DESC LIMIT 1`, [r.host_id])
      : null;
    const ageSec = s?.at ? (Date.now() - new Date(s.at).getTime()) / 1000 : null;
    out.push({
      relay: r,
      stations: Number(counts?.stations ?? 0),
      stationsLive: Number(counts?.live ?? 0),
      uptimeSeconds: host?.first_seen_at
        ? Math.max(0, Math.round((Date.now() - new Date(host.first_seen_at).getTime()) / 1000))
        : null,
      sample: s ? {
        at: new Date(s.at).toISOString(),
        cpuPct: s.cpu_pct == null ? null : Number(s.cpu_pct),
        memPct: s.mem_pct == null ? null : Number(s.mem_pct),
        netOutBps: s.net_out_bps == null ? null : Number(s.net_out_bps),
        netInBps: s.net_in_bps == null ? null : Number(s.net_in_bps),
        source: s.source,
      } : null,
      stale: !!r.host_id && (ageSec == null || ageSec > STALE_AFTER_SECONDS),
    });
  }
  return out;
}

export interface CostComparison {
  periodMonth: string;
  category: string;
  estimatedUsd: number;
  actualUsd: number | null;
  varianceUsd: number | null;
  variancePct: number | null;
  /** True when any rate feeding the estimate was still indicative. */
  indicative: boolean;
}

/**
 * ESTIMATED AGAINST ACTUAL, which is the entire reason for accruing anything.
 *
 * Every figure the fleet produces is an estimate: observed seconds multiplied by
 * a rate somebody typed in. The invoice at the end of the month is the other
 * side, and without both in one place the estimate can never be checked and
 * therefore never improves. A platform that has been quietly 40% under for six
 * months should be able to discover that in one screen.
 *
 * `actualUsd` is null when nobody has entered the bill yet. That is honestly
 * different from a variance of zero, and the two must never render the same.
 */
export async function costComparison(months = 6): Promise<CostComparison[]> {
  const est = await query<any>(
    `SELECT date_trunc('month', from_at)::date AS period_month,
            'relay' AS category,
            COALESCE(sum(est_usd), 0) AS est,
            bool_or(indicative) AS indicative
       FROM relay_accruals
      WHERE from_at >= date_trunc('month', now()) - make_interval(months => $1)
      GROUP BY 1
      UNION ALL
     SELECT date_trunc('month', from_at)::date, 'compute',
            COALESCE(sum(est_usd), 0), bool_or(indicative)
       FROM usage_accruals
      WHERE from_at >= date_trunc('month', now()) - make_interval(months => $1)
      GROUP BY 1`,
    [months]
  );
  const actuals = await query<any>(
    `SELECT period_month, category, usd FROM cost_actuals
      WHERE period_month >= date_trunc('month', now())::date - make_interval(months => $1)`,
    [months]
  );
  const key = (p: any, c: string) => `${new Date(p).toISOString().slice(0, 10)}|${c}`;
  const actualBy = new Map(actuals.map((a) => [key(a.period_month, a.category), Number(a.usd)]));

  return est.map((e) => {
    const estimated = Number(e.est);
    const actual = actualBy.get(key(e.period_month, e.category)) ?? null;
    return {
      periodMonth: new Date(e.period_month).toISOString().slice(0, 10),
      category: e.category,
      estimatedUsd: estimated,
      actualUsd: actual,
      varianceUsd: actual == null ? null : Number((actual - estimated).toFixed(2)),
      // Guarded: an estimate of zero with a real bill against it is an infinite
      // percentage, which is true and useless. Null says "no meaningful ratio".
      variancePct: actual == null || estimated === 0
        ? null
        : Number((((actual - estimated) / estimated) * 100).toFixed(1)),
      indicative: !!e.indicative,
    };
  }).sort((a, b) => (a.periodMonth === b.periodMonth
    ? a.category.localeCompare(b.category)
    : b.periodMonth.localeCompare(a.periodMonth)));
}
