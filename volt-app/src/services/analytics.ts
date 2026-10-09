/**
 * Analytics serving layer (Postgres). Player-agnostic: a viewing SESSION is
 * created at play start and kept alive by heartbeats (in production these come
 * from CloudFront real-time logs via Kinesis; here a beacon endpoint feeds the
 * same tables). Concurrency = distinct sessions seen in the last W seconds.
 * Historical numbers roll up per asset per day. Everything tenant-scoped.
 */
import { createHash } from 'node:crypto';
import { query, one } from '../db';

export const CONCURRENCY_WINDOW_SEC = 90; // ~2-3x target segment duration

export function parseDevice(ua = ''): { device_type: string; client_app: string } {
  const u = ua.toLowerCase();
  let device = 'Unknown';
  if (/smart-tv|smarttv|tizen|web0s|webos|appletv|crkey|roku|bravia|aft|googletv|android tv/.test(u)) device = 'TV';
  else if (/ipad|tablet/.test(u)) device = 'Tablet';
  else if (/mobile|iphone|android/.test(u)) device = 'Mobile';
  else if (/mozilla|chrome|safari|firefox|edge/.test(u)) device = 'Desktop';
  let app = 'Unknown';
  if (/roku/.test(u)) app = 'Roku';
  else if (/tizen/.test(u)) app = 'Samsung Tizen';
  else if (/web0s|webos/.test(u)) app = 'LG webOS';
  else if (/exoplayer/.test(u)) app = 'ExoPlayer';
  else if (/avplayer|cfnetwork|ios/.test(u)) app = 'AVPlayer/iOS';
  else if (/edg\//.test(u)) app = 'Edge';
  else if (/chrome/.test(u)) app = 'Chrome';
  else if (/safari/.test(u)) app = 'Safari';
  else if (/firefox/.test(u)) app = 'Firefox';
  return { device_type: device, client_app: app };
}

/** No-referrer is normal for native apps — classify, never block on it alone. */
export function classifyReferrer(referer: string | undefined, ua = ''): string {
  if (referer) return 'web';
  const u = ua.toLowerCase();
  if (/roku|tizen|web0s|webos|exoplayer|avplayer|cfnetwork|android tv|appletv/.test(u)) return 'native-app';
  if (/curl|wget|python|go-http|okhttp|node-fetch/.test(u)) return 'datacenter-vpn';
  return 'unknown';
}

export const ipHash = (ip = '') => createHash('sha256').update('volt:' + ip).digest('hex').slice(0, 24);

export interface Ctx {
  accountId: string;
  appId: string | null;
  assetKind: string;
  assetId: string;
  ua?: string;
  referer?: string;
  ip?: string;
  geo?: string;
}

/** Create-or-touch a session. event: start | heartbeat | end. */
export async function ingest(sessionKey: string, event: string, ctx: Ctx, extra: { seconds?: number; bitrateKbps?: number; ttffMs?: number; rebufferMs?: number; bytes?: number; blocked?: boolean } = {}) {
  const dev = parseDevice(ctx.ua);
  const rclass = classifyReferrer(ctx.referer, ctx.ua);
  const existing = await one<any>(
    `SELECT id, seconds_watched, ended_at FROM play_sessions WHERE account_id=$1 AND session_key=$2`,
    [ctx.accountId, sessionKey]
  );
  // Whether THIS call is the one that closed the session. Only that call may
  // fold it into the rollup.
  let endedNow = false;
  if (!existing) {
    await query(
      `INSERT INTO play_sessions(account_id, session_key, app_id, asset_kind, asset_id, device_type, client_app, referrer_class, geo_country, ip_hash, max_bitrate_kbps, ttff_ms, blocked)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (account_id, session_key) DO NOTHING`,
      [ctx.accountId, sessionKey, ctx.appId, ctx.assetKind, ctx.assetId, dev.device_type, dev.client_app, rclass, ctx.geo ?? null, ipHash(ctx.ip), extra.bitrateKbps ?? null, extra.ttffMs ?? null, extra.blocked ?? false]
    );
  } else {
    // ENDING IS A ONE-WAY TRANSITION, AND THE ROW IS THE RECORD OF IT.
    //
    // This beacon is PUBLIC — a playback token is by definition in the hands
    // of every viewer. `ended_at = CASE WHEN $7 THEN now()` re-stamped an
    // already-ended session on every replay and the caller rolled it up again:
    // another view, another unique viewer, another helping of watch seconds,
    // as many times as the request was resent. A player that fires `end` on
    // both pause and beforeunload did the same thing by accident. These are
    // the numbers /analytics/usage bills from.
    //
    // Close only a session that is still open, and count only the call that
    // did the closing. A replay now updates nothing that matters and folds
    // nothing: the UPDATE's own predicate is what makes it single-shot, so two
    // simultaneous `end` calls cannot both win it.
    const closed = await one<any>(
      `UPDATE play_sessions SET last_seen_at=now(),
         seconds_watched = CASE WHEN ended_at IS NULL THEN seconds_watched + $3 ELSE seconds_watched END,
         max_bitrate_kbps = GREATEST(COALESCE(max_bitrate_kbps,0), COALESCE($4,0)),
         rebuffer_ms = CASE WHEN ended_at IS NULL THEN rebuffer_ms + $5 ELSE rebuffer_ms END,
         bytes = CASE WHEN ended_at IS NULL THEN bytes + $6 ELSE bytes END,
         ended_at = CASE WHEN $7 AND ended_at IS NULL THEN now() ELSE ended_at END
       WHERE id=$1 AND account_id=$2 AND ($7 = false OR ended_at IS NULL)
       RETURNING id`,
      [existing.id, ctx.accountId, extra.seconds ?? 0, extra.bitrateKbps ?? null, extra.rebufferMs ?? 0, extra.bytes ?? 0, event === 'end']
    );
    endedNow = event === 'end' && !!closed;
  }
  // refresh the realtime concurrency snapshot for this stream
  const c = await liveConcurrency(ctx.assetKind, ctx.assetId);
  await query(
    `INSERT INTO stream_concurrency(account_id, asset_kind, asset_id, concurrent, updated_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (asset_kind, asset_id) DO UPDATE SET concurrent=EXCLUDED.concurrent, updated_at=now()`,
    [ctx.accountId, ctx.assetKind, ctx.assetId, c]
  );
  if (endedNow) await rollupSession(ctx, sessionKey);
  return { concurrent: c };
}

/** Distinct live sessions on a stream within the rolling window. */
export async function liveConcurrency(assetKind: string, assetId: string): Promise<number> {
  const r = await one<any>(
    `SELECT count(*)::int AS n FROM play_sessions
      WHERE asset_kind=$1 AND asset_id=$2 AND ended_at IS NULL
        AND last_seen_at > now() - ($3 || ' seconds')::interval`,
    [assetKind, assetId, String(CONCURRENCY_WINDOW_SEC)]
  );
  return r?.n ?? 0;
}

/** Fold an ended session into the per-asset/day rollup (idempotent-ish upsert). */
async function rollupSession(ctx: Ctx, sessionKey: string) {
  const s = await one<any>(`SELECT * FROM play_sessions WHERE account_id=$1 AND session_key=$2`, [ctx.accountId, sessionKey]);
  if (!s) return;
  const peak = await one<any>(`SELECT concurrent FROM stream_concurrency WHERE asset_kind=$1 AND asset_id=$2`, [ctx.assetKind, ctx.assetId]);
  for (const [scope, scopeId] of [['account', null], [ctx.assetKind, ctx.assetId]] as const) {
    await query(
      `INSERT INTO analytics_rollups(account_id, scope, scope_id, bucket_date, total_views, unique_views, peak_concurrent, watch_seconds, blocked_count, by_app, by_device, by_geo)
       VALUES ($1,$2,$3,current_date,1,1,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)
       ON CONFLICT (account_id, scope, scope_id, bucket_date) DO UPDATE SET
         total_views = analytics_rollups.total_views + 1,
         unique_views = analytics_rollups.unique_views + 1,
         peak_concurrent = GREATEST(analytics_rollups.peak_concurrent, EXCLUDED.peak_concurrent),
         watch_seconds = analytics_rollups.watch_seconds + EXCLUDED.watch_seconds,
         blocked_count = analytics_rollups.blocked_count + EXCLUDED.blocked_count,
         by_app = jsonb_bump(analytics_rollups.by_app, $10),
         by_device = jsonb_bump(analytics_rollups.by_device, $11),
         by_geo = jsonb_bump(analytics_rollups.by_geo, $12)`,
      [
        ctx.accountId, scope, scopeId, peak?.concurrent ?? 0, s.seconds_watched, s.blocked ? 1 : 0,
        JSON.stringify(s.app_id ? { [s.app_id]: 1 } : {}),
        JSON.stringify({ [s.device_type || 'Unknown']: 1 }),
        JSON.stringify({ [s.geo_country || 'ZZ']: 1 }),
        s.app_id || 'none', s.device_type || 'Unknown', s.geo_country || 'ZZ',
      ]
    );
  }
}
