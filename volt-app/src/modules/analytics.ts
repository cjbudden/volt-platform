/**
 * Analytics API. A public beacon feeds sessions (auth = playback token from
 * /availability, so it's bound to account/app/asset); the report endpoints are
 * tenant-scoped JWT reads matching the defined reports (realtime, per-program,
 * by-app/device/geo, usage).
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { qoeRouter } from './qoe';
import { asyncHandler, badRequest, ApiError } from '../util/http';
import { verifyPlaybackToken } from '../services/apiKeys';
import { retentionStatus, setRawRetention, sweepAnalytics } from '../services/analyticsRetention';
import { ingest, liveConcurrency } from '../services/analytics';

// ---- public beacon (playback-token auth) -----------------------------------
export const analyticsBeaconRouter = Router();

const beaconSchema = z.object({
  playbackToken: z.string(),
  sessionId: z.string().min(8),
  event: z.enum(['start', 'heartbeat', 'end']),
  // BOUNDED, because this endpoint is public and its numbers are billed from.
  // Unbounded, a single beacon could add two billion watch-seconds, and
  // negative values were accepted straight into `bytes = bytes + $6`.
  seconds: z.number().nonnegative().max(86_400).optional(),        // one day
  bitrateKbps: z.number().int().nonnegative().max(200_000).optional(),
  ttffMs: z.number().int().nonnegative().max(600_000).optional(),
  rebufferMs: z.number().int().nonnegative().max(86_400_000).optional(),
  bytes: z.number().int().nonnegative().max(1_000_000_000_000).optional(),
});

analyticsBeaconRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const b = beaconSchema.parse(req.body);
    let tok: any;
    try {
      tok = verifyPlaybackToken(b.playbackToken, { graceSec: 6 * 3600 });
    } catch {
      throw new ApiError(401, 'invalid playback token');
    }
    // An expired token may carry a session's heartbeats and its end, not begin
    // a new one. A share-link page is the exception: it holds one token for
    // the whole visit (re-resolving would count another view of the link), so
    // a viewer coming back to the tab starts a new session with it.
    if (b.event === 'start' && tok.src !== 'share' && Number(tok.exp) * 1000 < Date.now()) {
      throw new ApiError(401, 'playback token expired');
    }
    const r = await ingest(
      b.sessionId,
      b.event,
      {
        accountId: tok.aid,
        appId: tok.app ?? null,
        // The token now SAYS what the asset is. It used to be guessed from the
        // id's first characters, which no real uuid matches, so every channel
        // session was filed as 'vod' and channel concurrency read zero
        // everywhere. Tokens minted before this change carry no `kind`; they
        // expire in two minutes, and until they do they keep the old default.
        assetKind: tok.kind === 'channel' || tok.kind === 'event' || tok.kind === 'vod' ? tok.kind : 'vod',
        assetId: String(tok.asset),
        ua: req.get('user-agent') || undefined,
        referer: req.get('referer') || undefined,
        ip: req.ip,
        geo: tok.geo || undefined,
        // a share-link preview is filed as such, not as an anonymous web play
        ...(tok.src === 'share' ? { source: 'share' as const, clientApp: 'Share link' } : {}),
      },
      { seconds: b.seconds, bitrateKbps: b.bitrateKbps, ttffMs: b.ttffMs, rebufferMs: b.rebufferMs, bytes: b.bytes }
    );
    res.status(202).json(r);
  })
);

// ---- tenant reports (JWT) --------------------------------------------------
export const analyticsRouter = Router();
analyticsRouter.use(requireAuth);
// Playback experience (QoE) reports, from the separate analytics database (modules/qoe.ts).
analyticsRouter.use('/qoe', qoeRouter);

/**
 * DATA RETENTION — what is kept, and for how long.
 *
 * The distinction this endpoint exists to make plain: REPORTS are kept
 * indefinitely; the RAW event data they were computed from ages out. A day's
 * figures are sealed from complete raw data before that raw data is deleted, so
 * a report gives the same answer before and after the prune.
 */
analyticsRouter.get(
  '/retention',
  asyncHandler(async (req, res) => {
    res.json(await retentionStatus(accountId(req)));
  })
);

analyticsRouter.put(
  '/retention',
  asyncHandler(async (req, res) => {
    const b = z.object({
      // null means keep raw data forever. There is no zero: an account either
      // keeps raw events for at least a day or keeps them always.
      rawRetentionDays: z.number().int().min(1).nullable(),
    }).parse(req.body);
    await setRawRetention(accountId(req), b.rawRetentionDays);
    res.json(await retentionStatus(accountId(req)));
  })
);

/**
 * Seal what is due and prune what is safe, now.
 *
 * The same sweep the scheduler runs hourly, exposed so the effect of a retention
 * change can be seen rather than waited for.
 */
analyticsRouter.post(
  '/retention/sweep',
  asyncHandler(async (req, res) => {
    // The CALLER's account, and only theirs. This used to run the platform-wide
    // sweep: one tenant pressing "sweep now" irreversibly pruned every other
    // tenant's raw play sessions.
    res.json(await sweepAnalytics({ accountId: accountId(req) }));
  })
);

/**
 * OVERVIEW — one call for the analytics page.
 *
 * The audience endpoint merges a window into totals, which loses the shape: it
 * can say thirty thousand views and not whether that was steady or one spike.
 * This returns the DAILY SERIES alongside the totals, because the shape is the
 * part anyone actually reads.
 *
 * Read entirely from rollups, so it keeps answering after the raw events behind
 * it have been pruned. That is the whole promise of the retention split, and a
 * report that quietly reached into play_sessions would break it.
 */
analyticsRouter.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const days = Math.min(365, Math.max(1, Number(req.query.days ?? 30)));
    const daily = await query<any>(
      `SELECT to_char(bucket_date, 'YYYY-MM-DD') AS day,
              total_views, unique_views, peak_concurrent, watch_seconds,
              blocked_count, sealed
         FROM analytics_rollups
        WHERE account_id = $1 AND scope = 'account' AND scope_id IS NULL
          AND bucket_date > current_date - $2::int
        ORDER BY bucket_date`,
      [accountId(req), days]
    );

    // Per-asset totals over the window, so the page can say WHAT was watched
    // rather than only how much.
    const top = await query<any>(
      `SELECT r.scope AS kind, r.scope_id AS id,
              COALESCE(c.name, e.name, v.title, r.scope_id) AS name,
              sum(r.total_views)::bigint   AS views,
              sum(r.watch_seconds)::bigint AS watch_seconds,
              max(r.peak_concurrent)::int  AS peak_concurrent
         FROM analytics_rollups r
         LEFT JOIN channels   c ON c.id::text = r.scope_id
         LEFT JOIN events     e ON e.id::text = r.scope_id
         LEFT JOIN vod_assets v ON v.id::text = r.scope_id
        WHERE r.account_id = $1 AND r.scope <> 'account'
          AND r.bucket_date > current_date - $2::int
        GROUP BY r.scope, r.scope_id, c.name, e.name, v.title
        ORDER BY sum(r.total_views) DESC
        LIMIT 20`,
      [accountId(req), days]
    );

    const breakdowns = await query<any>(
      `SELECT by_app, by_device, by_geo FROM analytics_rollups
        WHERE account_id = $1 AND scope = 'account' AND scope_id IS NULL
          AND bucket_date > current_date - $2::int`,
      [accountId(req), days]
    );
    const merge = (key: 'by_app' | 'by_device' | 'by_geo') => {
      const acc: Record<string, number> = {};
      for (const r of breakdowns as any[]) {
        for (const [k, v] of Object.entries(r[key] || {})) acc[k] = (acc[k] || 0) + Number(v);
      }
      return acc;
    };

    const live = await query<any>(
      `SELECT asset_kind, asset_id, concurrent FROM stream_concurrency
        WHERE account_id = $1 AND updated_at > now() - interval '120 seconds'
        ORDER BY concurrent DESC`,
      [accountId(req)]
    );

    const sum = (k: string) => daily.reduce((a: number, r: any) => a + Number(r[k] ?? 0), 0);
    res.json({
      windowDays: days,
      daily: daily.map((d: any) => ({
        day: d.day,
        views: Number(d.total_views),
        uniques: Number(d.unique_views),
        peakConcurrent: d.peak_concurrent,
        watchSeconds: Number(d.watch_seconds),
        blocked: Number(d.blocked_count),
        // Whether this day's figures are final. A sealed day cannot change; an
        // open one still can, and a chart that does not say so invites someone
        // to quote today's half-day as a trend.
        sealed: d.sealed,
      })),
      totals: {
        views: sum('total_views'),
        uniques: sum('unique_views'),
        watchHours: Math.round(sum('watch_seconds') / 36) / 100,   // two decimals: a small test reads as 0.05, not 0
        blocked: sum('blocked_count'),
        peakConcurrent: daily.reduce((a: number, r: any) => Math.max(a, r.peak_concurrent ?? 0), 0),
      },
      liveConcurrent: live.reduce((a: number, r: any) => a + r.concurrent, 0),
      liveStreams: live,
      top: top.map((r: any) => ({
        kind: r.kind, id: r.id, name: r.name,
        views: Number(r.views), watchHours: Math.round(Number(r.watch_seconds) / 36) / 100,
        peakConcurrent: r.peak_concurrent,
      })),
      byApp: merge('by_app'),
      byDevice: merge('by_device'),
      byGeo: merge('by_geo'),
    });
  })
);

/** Realtime: current concurrency across the tenant's streams + total. */
analyticsRouter.get(
  '/realtime',
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT asset_kind, asset_id, concurrent, updated_at FROM stream_concurrency
        WHERE account_id=$1 AND updated_at > now() - interval '120 seconds' ORDER BY concurrent DESC`,
      [accountId(req)]
    );
    const total = rows.reduce((a: number, r: any) => a + r.concurrent, 0);
    res.json({ total_concurrent: total, streams: rows });
  })
);

/** Per-program / per-asset: rollup + live concurrency. */
analyticsRouter.get(
  '/asset',
  asyncHandler(async (req, res) => {
    const kind = String(req.query.kind ?? '');
    const id = String(req.query.id ?? '');
    if (!kind || !id) throw badRequest('kind & id required');
    const roll = await query(
      `SELECT bucket_date, total_views, unique_views, peak_concurrent, watch_seconds, blocked_count, by_app, by_device, by_geo
         FROM analytics_rollups WHERE account_id=$1 AND scope=$2 AND scope_id=$3 ORDER BY bucket_date DESC LIMIT 90`,
      [accountId(req), kind, id]
    );
    res.json({ live_concurrent: await liveConcurrency(kind, id), daily: roll });
  })
);

/** Audience: by app (authoritative), device, geo — merged over a window. */
analyticsRouter.get(
  '/audience',
  asyncHandler(async (req, res) => {
    const days = Math.min(365, Number(req.query.days ?? 30));
    const rows = await query(
      `SELECT by_app, by_device, by_geo, total_views, watch_seconds FROM analytics_rollups
        WHERE account_id=$1 AND scope='account' AND bucket_date > current_date - $2::int`,
      [accountId(req), days]
    );
    const merge = (key: 'by_app' | 'by_device' | 'by_geo') => {
      const acc: Record<string, number> = {};
      for (const r of rows as any[]) for (const [k, v] of Object.entries(r[key] || {})) acc[k] = (acc[k] || 0) + Number(v);
      return acc;
    };
    res.json({
      window_days: days,
      total_views: (rows as any[]).reduce((a, r) => a + Number(r.total_views), 0),
      watch_hours: Math.round((rows as any[]).reduce((a, r) => a + Number(r.watch_seconds), 0) / 3600),
      by_app: merge('by_app'),
      by_device: merge('by_device'),
      by_geo: merge('by_geo'),
    });
  })
);

/** Usage: per-app metering (from api_keys) → billing feed. */
analyticsRouter.get(
  '/usage',
  asyncHandler(async (req, res) => {
    const perApp = await query(
      `SELECT a.id AS app_id, a.name, a.type, COALESCE(SUM(k.request_count),0)::bigint AS requests
         FROM apps a LEFT JOIN api_keys k ON k.app_id=a.id
        WHERE a.account_id=$1 GROUP BY a.id ORDER BY requests DESC`,
      [accountId(req)]
    );
    const watch = await one<any>(
      `SELECT COALESCE(SUM(watch_seconds),0)::bigint AS s, COALESCE(SUM(total_views),0)::bigint AS v
         FROM analytics_rollups WHERE account_id=$1 AND scope='account' AND bucket_date > current_date - 30`,
      [accountId(req)]
    );
    res.json({ per_app: perApp, watch_hours_30d: Math.round(Number(watch?.s ?? 0) / 3600), views_30d: Number(watch?.v ?? 0) });
  })
);
