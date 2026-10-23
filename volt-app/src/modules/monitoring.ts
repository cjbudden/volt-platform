// ============================================================================
//  MONITORING API  (mounted at /api/monitoring)
//
//  Two views of one fleet, and the split between them is the whole design.
//
//    /live      WHAT IS RUNNING. Every channel, station and event with a
//               pipeline up, each carrying the SAME five-gate health the
//               detail page computes. An operator reads this to answer "is
//               everything on air".
//
//    /overview  WHAT NEEDS ATTENTION. Not a second list of streams: a list of
//               PROBLEMS, ranked, drawn from every subsystem that can quietly
//               go wrong — gates, jobs, media that has become unreadable, QC
//               failures waiting on a human, publications gone stale, uploads
//               abandoned mid-flight, capacity about to bite.
//
//  Why one endpoint each rather than letting the page fan out: an operator
//  with forty channels would otherwise open forty requests to draw one screen,
//  and every one of them would recompute the same health from the same tables.
//  The fan-out belongs on the server, where it is one connection and one pass.
//
//  Everything here is READ-ONLY and tenant-scoped. Nothing in this module can
//  change the fleet; the actions the pages offer are the existing start/stop
//  and air endpoints, which already carry their own guards.
// ============================================================================
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { can } from '../auth/roles';
import { asyncHandler } from '../util/http';
import { defineList, parseList, whereSql, pageSql, finishPage } from '../util/listQuery';
import { loadChannelHealthLite } from '../services/channelDetail';
import { liveConcurrency } from '../services/analytics';
import type { PipelineHealth } from '../services/pipelineHealth';

export const monitoringRouter = Router();
monitoringRouter.use(requireAuth);

export type OwnerKind = 'tv' | 'radio' | 'event';

export interface LiveRow {
  id: string;
  kind: OwnerKind;
  name: string;
  groupName: string | null;
  status: string;
  onAir: boolean;
  /** The five-gate roll-up. One definition, shared with the detail pages. */
  overall: PipelineHealth['overall'];
  gates: PipelineHealth['gates'];
  primaryError: PipelineHealth['primaryError'];
  /** ms since the encoder for THIS run was launched. Null unless the SERVER
   *  gate agrees something is actually up: an instance row outlives a crash. */
  uptimeMs: number | null;
  /** An instance is recorded as provisioned but the gates say nothing is up. */
  orphanedInstance: boolean;
  /** Viewers on this stream right now, from the concurrency table. */
  concurrent: number;
  activeSource: string | null;
  fallbackInUse: boolean;
  fillerInUse: boolean;
  /** ms since the encoder last reported. Stale telemetry is itself a signal. */
  reportAgeMs: number | null;
  /**
   * OUTPUTS THE RUNNING ENCODER REFUSED, as {output: reason}.
   *
   * A SECOND KIND OF DEGRADED, and the board was only counting the first.
   *
   * The five gates describe the PIPELINE: source arriving, encoder up,
   * packager advancing. Every one of them is legitimately green for a station
   * whose MP3 was dropped, because HLS and DASH really are being written. So
   * `overall` is 'ready' or 'onair' and the Degraded tile counts zero, beside a
   * station whose MP3 URL does not serve. The number is defending its own
   * definition and telling the operator the wrong thing.
   *
   * Only MP3 can land here today, and only in the relay topology: HLS and DASH
   * are files the encoder writes itself, while MP3 is a push to a second piece
   * of infrastructure that can be absent while everything else is perfect.
   *
   * Cleared on channel.start, so this always describes the CURRENT run.
   */
  degradedOutputs: Record<string, string>;
  href: string;
  /** The ORIGIN manifest, not the public URL. Multiview is a confidence
   *  monitor of what the encoder is producing, and an operator needs to see
   *  that whether or not the channel has been published. */
  previewUrl: string;
  /** Radio has no picture: a video tile for it would render a black square. */
  audioOnly: boolean;
}

/** Everything with a pipeline that could be up: channels, stations, events. */
async function liveBoard(acct: string): Promise<LiveRow[]> {
  const now = Date.now();

  const channels = await query<any>(
    `SELECT c.id, c.name, c.status, c.on_air, COALESCE(c.kind, 'tv') AS kind, c.origin, g.name AS group_name
       FROM channels c JOIN groups g ON g.id = c.group_id
      WHERE g.account_id = $1
      ORDER BY c.name`,
    [acct]
  );
  const events = await query<any>(
    `SELECT e.id, e.name, e.status, g.name AS group_name
       FROM events e JOIN groups g ON g.id = e.group_id
      WHERE g.account_id = $1
      ORDER BY e.name`,
    [acct]
  );

  const rows = await liveRowsFor([
    ...channels.map((c: any) => ({ ...c, kind: (c.kind === 'radio' ? 'radio' : 'tv') as OwnerKind })),
    ...events.map((e: any) => ({ ...e, kind: 'event' as OwnerKind })),
  ], now);

  // Trouble first, then what is actually on air, then the rest. An operator
  // scanning top-down should never have to hunt for the broken one.
  const RANK: Record<string, number> = {
    error: 0, degraded: 1, starting: 2, onair: 3, ready: 4, stopped: 5, idle: 6,
  };
  return rows.sort((a, b) =>
    (RANK[a.overall] ?? 9) - (RANK[b.overall] ?? 9)
    || b.concurrent - a.concurrent
    || a.name.localeCompare(b.name)
  );
}

/**
 * The board's row for each stream given: the five-gate health, uptime, viewers
 * and the encoder's last report. Shared by the board and by
 * GET /api/live-streams?health=true (modules/liveStreams.ts), so a paged list
 * and the board can never say different things about one stream.
 */
export async function liveRowsFor(
  streams: Array<{ id: string; name: string; status: string; on_air?: boolean | null; group_name?: string | null; origin?: string | null; kind: OwnerKind }>,
  now = Date.now(),
): Promise<LiveRow[]> {
  if (!streams.length) return [];
  const ids = streams.map((s) => s.id);
  // One query for launch times rather than one per stream.
  const insts = await query<any>(
    `SELECT channel_id, event_id, min(launched_at) AS since
       FROM instances WHERE terminated_at IS NULL AND (channel_id = ANY($1) OR event_id = ANY($1))
      GROUP BY channel_id, event_id`, [ids]
  );
  const since = new Map<string, number>();
  for (const i of insts) {
    const key = i.channel_id ?? i.event_id;
    if (key && i.since) since.set(key, new Date(i.since).getTime());
  }

  // Same again for the last encoder report: telemetry that has stopped arriving
  // is a fault the gates cannot always see, so the age is surfaced directly.
  const reports = await query<any>(
    `SELECT channel_id, event_id, active_source, fallback_in_use, filler_in_use,
            degraded_outputs, updated_at
       FROM stream_status WHERE channel_id = ANY($1) OR event_id = ANY($1)`, [ids]
  );
  const report = new Map<string, any>();
  for (const r of reports) {
    const key = r.channel_id ?? r.event_id;
    if (key) report.set(key, r);
  }

  const build = async (row: any, kind: OwnerKind): Promise<LiveRow> => {
    const health = await loadChannelHealthLite(
      { id: row.id, status: row.status, on_air: row.on_air === true },
      now,
      kind === 'event' ? 'event' : 'channel'
    );
    const st = report.get(row.id);
    const launched = since.get(row.id) ?? null;
    const runAgeMs = launched != null ? now - launched : null;
    const reportAgeMs = st?.updated_at ? now - new Date(st.updated_at).getTime() : null;

    // An instance row with no terminated_at is a CLAIM that something is
    // running, not proof of it: a crashed encoder leaves the row behind, and
    // for a channel the SERVER gate is derived from that same row, so asking
    // the gate is asking the claim to vouch for itself. It cannot disagree.
    //
    // The encoder reports every few seconds while it lives. Silence past
    // REPORT_DEAD_MS, on a run old enough to have finished booting, is the one
    // signal that does not come from the row. Before this, a channel dead for
    // twenty hours reported twenty hours of uptime and raised nothing.
    const REPORT_DEAD_MS = 120_000;
    const BOOT_GRACE_MS = 180_000;
    const reporting = reportAgeMs != null && reportAgeMs < REPORT_DEAD_MS;
    const stillBooting = runAgeMs != null && runAgeMs < BOOT_GRACE_MS;
    const serverUp = launched != null && (reporting || stillBooting);
    return {
      id: row.id,
      kind,
      name: row.name,
      groupName: row.group_name ?? null,
      status: row.status,
      onAir: row.on_air === true,
      overall: health.overall,
      gates: health.gates,
      primaryError: health.primaryError,
      uptimeMs: serverUp ? runAgeMs : null,
      /** The instance row survives a crash. When it disagrees with the gates,
       *  something is still recorded as provisioned that is not running. */
      orphanedInstance: !serverUp && launched != null,
      concurrent: await liveConcurrency(kind === 'event' ? 'event' : 'channel', row.id),
      activeSource: st?.active_source ?? null,
      fallbackInUse: !!st?.fallback_in_use,
      fillerInUse: !!st?.filler_in_use,
      reportAgeMs,
      // Only while something is actually up. The row is cleared on start, so a
      // stale entry is not expected -- but reporting a dropped output for a
      // stream that is not running would describe a run that has ended, which
      // is the same mistake as trusting the instance row.
      degradedOutputs: serverUp ? (st?.degraded_outputs ?? {}) : {},
      // An event has its own page since 22 Oct (it used to open the list), and
      // a FAST channel is managed on its FAST page, not the channel page.
      href:
        kind === 'radio' ? `/radio/${row.id}`
        : kind === 'event' ? `/events/${row.id}`
        : row.origin === 'playlist' ? `/fast/${row.id}`
        : `/channels/${row.id}`,
      previewUrl: `/origin/${row.id}/live/master.m3u8`,
      audioOnly: kind === 'radio',
    };
  };

  return Promise.all(streams.map((s) => build(s, s.kind)));
}

/** WHAT IS RUNNING. */
monitoringRouter.get(
  '/live',
  asyncHandler(async (req, res) => {
    // Only the kinds the caller may see (a Radio Manager's board is stations).
    const featureOf = (k: string) => (k === 'radio' ? 'radio' : k === 'event' ? 'events' : 'channels');
    const rows = (await liveBoard(accountId(req))).filter((r: any) => can(req, featureOf(r.kind), 'view'));
    const counts = rows.reduce<Record<string, number>>((a, r) => {
      a[r.overall] = (a[r.overall] ?? 0) + 1;
      return a;
    }, {});
    // DEGRADED IS TWO CONDITIONS, and the board must count both: a failed or
    // degraded GATE (the pipeline is not right) and a dropped OUTPUT (the
    // pipeline is fine and we are not delivering everything we promised).
    // Computed here rather than in the page so the API and the console cannot
    // drift apart on what the word means.
    const degraded = rows.filter(
      (r) => r.overall === 'degraded' || Object.keys(r.degradedOutputs).length > 0
    ).length;
    res.json({
      streams: rows,
      counts,
      running: rows.filter(r => r.uptimeMs != null).length,
      onAir: rows.filter(r => r.onAir).length,
      degraded,
      concurrent: rows.reduce((a, r) => a + r.concurrent, 0),
    });
  })
);

// ---------------------------------------------------------------------------
//  Alerts
// ---------------------------------------------------------------------------

type Severity = 'critical' | 'serious' | 'warning';

interface Alert {
  id: string;
  severity: Severity;
  /** Which subsystem raised it. The page groups by this. */
  source: 'pipeline' | 'jobs' | 'media' | 'qc' | 'publishing' | 'uploads' | 'capacity';
  title: string;
  detail: string;
  /** Where to go to do something about it. Null when there is nowhere useful. */
  href: string | null;
  at: string | null;
}

const SEV_RANK: Record<Severity, number> = { critical: 0, serious: 1, warning: 2 };

/** A duration a person reads. "1169 minutes" is a number nobody converts. */
function humanFor(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 90) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hours`;
  return `${Math.round(h / 24)} days`;
}

/** WHAT NEEDS ATTENTION. */
monitoringRouter.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const acct = accountId(req);
    const alerts: Alert[] = [];
    const streams = await liveBoard(acct);

    // ---- pipeline ---------------------------------------------------------
    // A failed gate on a running stream is the most urgent thing in the system:
    // it means viewers are affected right now.
    for (const s of streams) {
      if (s.overall === 'error') {
        alerts.push({
          id: `pipeline:${s.id}`, severity: 'critical', source: 'pipeline',
          title: `${s.name} is down`,
          detail: s.primaryError ? `${s.primaryError.label}: ${s.primaryError.message}` : 'A pipeline gate has failed.',
          href: s.href, at: null,
        });
      } else if (s.overall === 'degraded') {
        alerts.push({
          id: `pipeline:${s.id}`, severity: 'serious', source: 'pipeline',
          title: `${s.name} is degraded`,
          detail: s.fallbackInUse ? 'Running on the backup source.'
            : s.fillerInUse ? 'Playing filler: no usable input.'
            : s.primaryError ? `${s.primaryError.label}: ${s.primaryError.message}`
            : 'On air but not right.',
          href: s.href, at: null,
        });
      }
      // Telemetry that stopped arriving while the run is still up. The gates
      // read the manifest on disk and can look fine while the reporter is dead.
      // Only raised when nothing louder is already saying so: an operator does
      // not need two lines about the same broken stream.
      if (s.overall !== 'error' && s.overall !== 'degraded'
          && s.uptimeMs != null && s.reportAgeMs != null && s.reportAgeMs > 120_000) {
        alerts.push({
          id: `telemetry:${s.id}`, severity: 'warning', source: 'pipeline',
          title: `${s.name} has stopped reporting`,
          detail: `Last encoder report ${Math.round(s.reportAgeMs / 1000)}s ago.`,
          href: s.href, at: null,
        });
      }
      // "Starting" is a state something passes THROUGH. A pipeline that has
      // been warming up for ten minutes is not warming up: it is wedged, and
      // nothing in the model will ever move it to failed on its own.
      if (s.overall === 'starting' && s.uptimeMs != null && s.uptimeMs > 10 * 60_000) {
        alerts.push({
          id: `stuck:${s.id}`, severity: 'serious', source: 'pipeline',
          title: `${s.name} has been starting for ${humanFor(s.uptimeMs)}`,
          detail: 'Warm-up is a transition, not a resting state. The pipeline is almost certainly wedged.',
          href: s.href, at: null,
        });
      }
      // A provisioned instance with nothing running is a billing hazard as much
      // as an operational one: the row is what "billable" is counted from.
      if (s.orphanedInstance) {
        alerts.push({
          id: `instance:${s.id}`, severity: 'warning', source: 'capacity',
          title: `${s.name} has a stranded encoder record`,
          detail: 'An instance is recorded as provisioned but the pipeline is not running. Stop the stream to clear it.',
          href: s.href, at: null,
        });
      }
    }

    // ---- jobs -------------------------------------------------------------
    const failedJobs = await query<any>(
      `SELECT j.id, j.type, j.last_error, j.error_code,
              COALESCE(j.finished_at, j.created_at) AS at,
              COALESCE(c.name, e.name) AS owner_name
         FROM jobs j
         LEFT JOIN channels c ON c.id = j.channel_id
         LEFT JOIN events   e ON e.id = j.event_id
         JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
        WHERE g.account_id = $1 AND j.state = 'failed'
          AND COALESCE(j.finished_at, j.created_at) > now() - interval '7 days'
        ORDER BY 5 DESC LIMIT 25`,
      [acct]
    );
    // Collapsed by job type. Ten copies of the same failure are one problem,
    // and an alert list that repeats itself stops being read.
    const byType = new Map<string, { n: number; first: any }>();
    for (const j of failedJobs) {
      const e = byType.get(j.type);
      if (e) e.n += 1;
      else byType.set(j.type, { n: 1, first: j });
    }
    for (const [type, { n, first }] of byType) {
      alerts.push({
        id: `job:${type}`, severity: 'serious', source: 'jobs',
        title: n === 1
          ? `${type} failed${first.owner_name ? ` on ${first.owner_name}` : ''}`
          : `${type} failed ${n} times`,
        detail: first.last_error || first.error_code || 'No reason recorded.',
        href: '/recordings', at: first.at,
      });
    }

    // A job stuck past its lease is not failed and not running: nothing will
    // move it on its own, and nothing else in the UI would ever show it.
    const stuck = await one<any>(
      `SELECT count(*)::int AS n FROM jobs j
         LEFT JOIN channels c ON c.id = j.channel_id
         LEFT JOIN events   e ON e.id = j.event_id
         JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
        WHERE g.account_id = $1 AND j.state = 'running'
          AND j.lease_until IS NOT NULL AND j.lease_until < now() - interval '5 minutes'`,
      [acct]
    );
    if ((stuck?.n ?? 0) > 0) {
      alerts.push({
        id: 'job:stranded', severity: 'warning', source: 'jobs',
        title: `${stuck.n} job${stuck.n === 1 ? '' : 's'} stranded`,
        detail: 'Claimed by a worker that stopped reporting; the lease has expired.',
        href: null, at: null,
      });
    }

    // ---- media ------------------------------------------------------------
    // The catalogue and the bytes are separate records on purpose, which means
    // they can disagree. An object the catalogue calls available with no
    // present location anywhere is the dangerous disagreement: nothing looks
    // wrong until somebody asks for a clip built from it.
    // Media has no account column: it belongs to a channel or an event, and the
    // account is reached through the owning group like everywhere else.
    const MEDIA_OWNED = `
      FROM media_objects m
      LEFT JOIN channels c ON c.id = m.channel_id
      LEFT JOIN events   e ON e.id = m.event_id
      JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)`;

    const orphaned = await one<any>(
      `SELECT count(*)::int AS n ${MEDIA_OWNED}
        WHERE g.account_id = $1 AND m.state IN ('available', 'restored')
          AND NOT EXISTS (
            SELECT 1 FROM media_locations l WHERE l.object_id = m.id AND l.present)`,
      [acct]
    );
    if ((orphaned?.n ?? 0) > 0) {
      alerts.push({
        id: 'media:orphaned', severity: 'serious', source: 'media',
        title: `${orphaned.n} media object${orphaned.n === 1 ? '' : 's'} have no bytes`,
        detail: 'Catalogued as readable but not present in any location.',
        href: '/storage', at: null,
      });
    }
    // A transition is a state something passes THROUGH. One that has not moved
    // in a day is not in transition, it is stuck, and nothing retries it.
    const stalled = await query<any>(
      `SELECT m.state, count(*)::int AS n ${MEDIA_OWNED}
        WHERE g.account_id = $1 AND m.state IN ('writing', 'archiving', 'restoring', 'deleting')
          AND m.updated_at < now() - interval '24 hours'
        GROUP BY m.state`,
      [acct]
    );
    for (const r of stalled) {
      alerts.push({
        id: `media:stalled:${r.state}`, severity: 'warning', source: 'media',
        title: `${r.n} media object${r.n === 1 ? '' : 's'} stuck ${r.state}`,
        detail: 'No progress for over a day. A transition state is not a resting state.',
        href: '/storage', at: null,
      });
    }

    // ---- QC and review ----------------------------------------------------
    const qcFailed = await one<any>(
      `SELECT count(*)::int AS n FROM vod_assets v
         LEFT JOIN channels c ON c.id = v.channel_id
         LEFT JOIN events   e ON e.id = v.event_id
         LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
        WHERE COALESCE(g.account_id, v.account_id) = $1 AND v.qc_state = 'failed'`,
      [acct]
    );
    if ((qcFailed?.n ?? 0) > 0) {
      alerts.push({
        id: 'qc:failed', severity: 'serious', source: 'qc',
        title: `${qcFailed.n} asset${qcFailed.n === 1 ? '' : 's'} failed QC`,
        detail: 'Automated quality control found errors. These cannot publish without an override.',
        href: '/review', at: null,
      });
    }
    const awaiting = await one<any>(
      `SELECT count(*)::int AS n FROM vod_assets v
         LEFT JOIN channels c ON c.id = v.channel_id
         LEFT JOIN events   e ON e.id = v.event_id
         LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
        WHERE COALESCE(g.account_id, v.account_id) = $1 AND v.review_state IN ('in_review', 'changes_requested')`,
      [acct]
    );
    if ((awaiting?.n ?? 0) > 0) {
      alerts.push({
        id: 'qc:queue', severity: 'warning', source: 'qc',
        title: `${awaiting.n} asset${awaiting.n === 1 ? '' : 's'} awaiting review`,
        detail: 'Nothing is wrong; these are waiting on a person.',
        href: '/review', at: null,
      });
    }

    // ---- publishing -------------------------------------------------------
    // A stale publication is the quiet one: the portal is still serving the
    // OLD build of an asset that has since been rebuilt.
    const stale = await one<any>(
      `SELECT count(*)::int AS n FROM publications p
         JOIN vod_assets v ON v.id = p.vod_asset_id
         LEFT JOIN channels c ON c.id = v.channel_id
         LEFT JOIN events   e ON e.id = v.event_id
         JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
        WHERE g.account_id = $1 AND p.stale`,
      [acct]
    );
    if ((stale?.n ?? 0) > 0) {
      alerts.push({
        id: 'publishing:stale', severity: 'warning', source: 'publishing',
        title: `${stale.n} publication${stale.n === 1 ? '' : 's'} out of date`,
        detail: 'The published build is older than the asset it points at.',
        href: '/vod', at: null,
      });
    }

    // ---- uploads ----------------------------------------------------------
    const abandoned = await one<any>(
      `SELECT count(*)::int AS n FROM upload_sessions
        WHERE account_id = $1 AND state IN ('open', 'assembling')
          AND updated_at < now() - interval '24 hours'`,
      [acct]
    );
    if ((abandoned?.n ?? 0) > 0) {
      alerts.push({
        id: 'uploads:abandoned', severity: 'warning', source: 'uploads',
        title: `${abandoned.n} upload${abandoned.n === 1 ? '' : 's'} unfinished`,
        detail: 'Started over a day ago and never completed; the parts are still held.',
        href: '/loops', at: null,
      });
    }

    // ---- capacity ---------------------------------------------------------
    const caps = await query<any>(
      `SELECT g.id, g.name, g.max_channels,
              (SELECT count(*)::int FROM channels c WHERE c.group_id = g.id) AS used
         FROM groups g WHERE g.account_id = $1`,
      [acct]
    );
    for (const g of caps) {
      if (!g.max_channels) continue;
      const headroom = g.max_channels - g.used;
      if (headroom < 0) {
        // Over the limit, not at it. The limit is enforced on creation, so a
        // group past it was raised and then lowered, or seeded around the API.
        alerts.push({
          id: `capacity:${g.id}`, severity: 'serious', source: 'capacity',
          title: `${g.name} is over its channel limit`,
          detail: `${g.used} channels against a limit of ${g.max_channels}. The limit was lowered after these were created; nothing new can be added.`,
          href: '/channels', at: null,
        });
      } else if (headroom === 0) {
        alerts.push({
          id: `capacity:${g.id}`, severity: 'serious', source: 'capacity',
          title: `${g.name} is at its channel limit`,
          detail: `${g.used} of ${g.max_channels} used. No new channel can be created here.`,
          href: '/channels', at: null,
        });
      } else if (headroom === 1) {
        alerts.push({
          id: `capacity:${g.id}`, severity: 'warning', source: 'capacity',
          title: `${g.name} has one channel left`,
          detail: `${g.used} of ${g.max_channels} used.`,
          href: '/channels', at: null,
        });
      }
    }

    alerts.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);

    // ---- the fleet event feed --------------------------------------------
    // Not alerts: the running commentary, so an operator can see what the fleet
    // has been doing even when nothing is wrong.
    const feed = await query<any>(
      `SELECT ev.id, ev.type, ev.detail, ev.ts,
              COALESCE(c.name, e.name) AS name,
              COALESCE(c.id::text, e.id::text) AS owner_id,
              CASE WHEN ev.event_id IS NOT NULL THEN 'event'
                   ELSE COALESCE(c.kind, 'tv') END AS kind
         FROM stream_events ev
         LEFT JOIN channels c ON c.id = ev.channel_id
         LEFT JOIN events   e ON e.id = ev.event_id
         JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
        WHERE g.account_id = $1
        ORDER BY ev.ts DESC LIMIT 60`,
      [acct]
    );

    res.json({
      generatedAt: new Date().toISOString(),
      fleet: {
        total: streams.length,
        running: streams.filter(s => s.uptimeMs != null).length,
        onAir: streams.filter(s => s.onAir).length,
        error: streams.filter(s => s.overall === 'error').length,
        degraded: streams.filter(s => s.overall === 'degraded').length,
        concurrent: streams.reduce((a, s) => a + s.concurrent, 0),
      },
      alerts,
      counts: {
        critical: alerts.filter(a => a.severity === 'critical').length,
        serious: alerts.filter(a => a.severity === 'serious').length,
        warning: alerts.filter(a => a.severity === 'warning').length,
      },
      feed: feed.map((f: any) => ({
        id: String(f.id),
        ts: f.ts,
        type: f.type,
        name: f.name,
        kind: f.kind,
        ownerId: f.owner_id,
        detail: typeof f.detail === 'string' ? f.detail : JSON.stringify(f.detail ?? {}),
      })),
    });
  })
);

/** The fleet event feed on its own, for polling without recomputing health. */
// THE LIST STANDARD (util/listQuery.ts): filter by event type or stream, search
// the names, page back through history with the cursor.
const feedList = defineList({
  path: '/api/monitoring/feed',
  fields: {
    id: { sql: 'ev.id', type: 'number' },
    type: { sql: 'ev.type', type: 'string', doc: 'e.g. source.down, failover.switch' },
    ts: { sql: 'ev.ts', type: 'timestamp', notNull: true },
    name: { sql: 'COALESCE(c.name, e.name)', type: 'string', doc: 'Channel or event name' },
    channel_id: { sql: 'ev.channel_id', type: 'uuid', sort: false },
    event_id: { sql: 'ev.event_id', type: 'uuid', sort: false },
  },
  search: ['type', 'name'],
  defaultSort: '-ts',
  defaultLimit: 60,
  maxLimit: 200,
  aliases: { channelId: 'channel_id', eventId: 'event_id' },
});

monitoringRouter.get(
  '/feed',
  asyncHandler(async (req, res) => {
    const from = `FROM stream_events ev
         LEFT JOIN channels c ON c.id = ev.channel_id
         LEFT JOIN events   e ON e.id = ev.event_id
         JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
        WHERE g.account_id = $1`;
    const params: unknown[] = [accountId(req)];
    const pl = parseList(feedList, req.query, params);
    const rows = await query<any>(
      `SELECT ev.id, ev.type, ev.detail, ev.ts, COALESCE(c.name, e.name) AS name ${from}${whereSql(pl)} ${pageSql(pl)}`, params);
    let total: number | undefined;
    if (pl.count) {
      const cp: unknown[] = [accountId(req)];
      const cpl = parseList(feedList, { ...req.query, cursor: undefined, offset: undefined }, cp);
      total = Number((await one<any>(`SELECT count(*)::int AS n ${from}${whereSql(cpl)}`, cp))?.n ?? 0);
    }
    res.json(finishPage(req, res, pl, rows, total));
  })
);
