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
import { asyncHandler, badRequest, ApiError } from '../util/http';
import { verifyPlaybackToken } from '../services/apiKeys';
import { ingest, liveConcurrency } from '../services/analytics';

// ---- public beacon (playback-token auth) -----------------------------------
export const analyticsBeaconRouter = Router();

const beaconSchema = z.object({
  playbackToken: z.string(),
  sessionId: z.string().min(8),
  event: z.enum(['start', 'heartbeat', 'end']),
  seconds: z.number().nonnegative().optional(),
  bitrateKbps: z.number().int().optional(),
  ttffMs: z.number().int().optional(),
  rebufferMs: z.number().int().optional(),
  bytes: z.number().int().optional(),
});

analyticsBeaconRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const b = beaconSchema.parse(req.body);
    let tok: any;
    try {
      tok = verifyPlaybackToken(b.playbackToken);
    } catch {
      throw new ApiError(401, 'invalid playback token');
    }
    const r = await ingest(
      b.sessionId,
      b.event,
      {
        accountId: tok.aid,
        appId: tok.app ?? null,
        assetKind: /^(chan|00000000)/.test(String(tok.asset)) ? 'channel' : tok.assetKind || 'vod',
        assetId: String(tok.asset),
        ua: req.get('user-agent') || undefined,
        referer: req.get('referer') || undefined,
        ip: req.ip,
        geo: tok.geo || undefined,
      },
      { seconds: b.seconds, bitrateKbps: b.bitrateKbps, ttffMs: b.ttffMs, rebufferMs: b.rebufferMs, bytes: b.bytes }
    );
    res.status(202).json(r);
  })
);

// ---- tenant reports (JWT) --------------------------------------------------
export const analyticsRouter = Router();
analyticsRouter.use(requireAuth);

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
