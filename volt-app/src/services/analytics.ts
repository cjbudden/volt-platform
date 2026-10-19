/**
 * Analytics serving layer (Postgres). Player-agnostic: a viewing SESSION is
 * created at play start and kept alive by heartbeats (in production these come
 * from CloudFront real-time logs via Kinesis; here a beacon endpoint feeds the
 * same tables). Concurrency = distinct sessions seen in the last W seconds.
 * Historical numbers roll up per asset per day. Everything tenant-scoped.
 *
 * BUFFERED (scale). A beacon no longer touches the database. It updates memory
 * and the pipeline below writes in batches every ANALYTICS_FLUSH_SEC:
 *
 *   sessions     one multi-row upsert into play_sessions per flush
 *                (ANALYTICS_SESSIONS=postgres, the default), or none at all
 *                (=none: rollups are built straight from beacons and the raw
 *                beacons go to Firehose / S3 for the data lake)
 *   rollups      ended sessions folded in memory, one upsert per asset per flush
 *   concurrency  counted in Valkey (sorted set per asset) when REDIS_URL is
 *                set, else per process; written to stream_concurrency every
 *                ANALYTICS_CONCURRENCY_SEC by one process per asset
 *
 * The old path ran, per heartbeat: a SELECT, an INSERT or UPDATE, a count(*)
 * over every open session of the asset, and an upsert on one shared row. At a
 * million viewers that is ~3,000 seconds of database work every second.
 */
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { createRequire } from 'node:module';
import { query, one, pool } from '../db';
import { scaleConfig } from '../scale/config';
import { redis } from '../scale/redis';
import { cached } from '../scale/cache';

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
  /** Where the play came from when it is not an app ('share': a share-link preview). */
  source?: 'share';
  /** Overrides the player name read from the user agent (e.g. 'Share link'). */
  clientApp?: string;
}

/** Create-or-touch a session. event: start | heartbeat | end. Memory only; see the header. */
export async function ingest(sessionKey: string, event: string, ctx: Ctx, extra: { seconds?: number; bitrateKbps?: number; ttffMs?: number; rebufferMs?: number; bytes?: number; blocked?: boolean } = {}) {
  const now = Date.now();
  const ending = event === 'end';
  const assetKey = `${ctx.assetKind}|${ctx.assetId}`;
  trackConcurrency(assetKey, ctx.accountId, sessionKey, ending, now);
  mirrorToFirehose(sessionKey, event, ctx, extra, now);
  if (scaleConfig.analytics.sessions === 'postgres') bufferSession(sessionKey, ending, ctx, extra, now);
  else foldBeaconIntoRollup(sessionKey, event, ctx, extra);
  return { concurrent: lastConcurrency.get(assetKey) ?? 0 };
}

/** Distinct live sessions on a stream within the rolling window (from the published snapshot). */
export async function liveConcurrency(assetKind: string, assetId: string): Promise<number> {
  return cached<number>(`conc:${assetKind}:${assetId}`, { ttlSec: 2, tags: [] }, async () => {
    const r = await one<any>(
      `SELECT concurrent FROM stream_concurrency
        WHERE asset_kind=$1 AND asset_id=$2
          AND updated_at > now() - make_interval(secs => $3)`,
      [assetKind, assetId, Math.max(15, scaleConfig.analytics.concurrencySec * 3)]
    );
    return r?.concurrent ?? 0;
  });
}

// ============================================================================
//  Concurrency
// ============================================================================

const PROCESS_ID = `${hostname()}:${process.pid}`;
/** asset -> account, last beacon (ms). Assets this process has heard from. */
const activeAssets = new Map<string, { accountId: string; last: number }>();
/** asset -> session -> last seen (ms). Only used without Valkey. */
const localSessions = new Map<string, Map<string, number>>();
const lastConcurrency = new Map<string, number>();
/** asset -> highest concurrency computed today by this process (for rollups). */
const peakToday = new Map<string, number>();
let peakDay = new Date().toISOString().slice(0, 10);

function trackConcurrency(assetKey: string, accountId: string, sessionKey: string, ending: boolean, now: number) {
  activeAssets.set(assetKey, { accountId, last: now });
  const r = redis();
  if (r) {
    const k = `conc:${assetKey}`;
    try {
      (ending ? r.zrem(k, sessionKey) : r.zadd(k, now, sessionKey)).catch(() => {});
    } catch { /* counted locally below instead */ }
    if (!ending) return;
  }
  let m = localSessions.get(assetKey);
  if (!m) { m = new Map(); localSessions.set(assetKey, m); }
  if (ending) m.delete(sessionKey); else m.set(sessionKey, now);
}

async function computeConcurrency(): Promise<void> {
  const now = Date.now();
  const windowMs = CONCURRENCY_WINDOW_SEC * 1000;
  const today = new Date().toISOString().slice(0, 10);
  if (today !== peakDay) { peakToday.clear(); peakDay = today; }
  const r = redis();
  const finals: { kind: string; id: string; acct: string; n: number }[] = [];
  const parts: { kind: string; id: string; acct: string; n: number }[] = [];
  for (const [assetKey, a] of [...activeAssets]) {
    if (now - a.last > windowMs * 2) { activeAssets.delete(assetKey); localSessions.delete(assetKey); lastConcurrency.delete(assetKey); continue; }
    const [kind, id] = assetKey.split('|');
    let n: number | null = null;
    if (r) {
      try {
        const k = `conc:${assetKey}`;
        const out = await r.multi()
          .zremrangebyscore(k, '-inf', now - windowMs)
          .zcard(k)
          .pexpire(k, windowMs * 2)
          .set(`concw:${assetKey}`, PROCESS_ID, 'PX', Math.max(1000, scaleConfig.analytics.concurrencySec * 1000 - 200), 'NX')
          .exec();
        n = Number(out?.[1]?.[1] ?? 0);
        // Only the process that won the per-asset writer slot publishes it.
        if (out?.[3]?.[1] === 'OK') finals.push({ kind, id, acct: a.accountId, n });
      } catch { n = null; }
    }
    if (n === null) {
      const m = localSessions.get(assetKey) ?? new Map();
      for (const [sk, t] of m) if (now - t > windowMs) m.delete(sk);
      n = m.size;
      parts.push({ kind, id, acct: a.accountId, n });
    }
    lastConcurrency.set(assetKey, n);
    peakToday.set(assetKey, Math.max(peakToday.get(assetKey) ?? 0, n));
  }
  if (finals.length) {
    await query(
      `INSERT INTO stream_concurrency(account_id, asset_kind, asset_id, concurrent, updated_at)
       SELECT * , now() FROM unnest($1::uuid[], $2::text[], $3::text[], $4::int[])
       ON CONFLICT (asset_kind, asset_id) DO UPDATE SET concurrent=EXCLUDED.concurrent, updated_at=now()`,
      [finals.map((f) => f.acct), finals.map((f) => f.kind), finals.map((f) => f.id), finals.map((f) => f.n)]
    );
  }
  if (parts.length) {
    // No Valkey: each process publishes its own count, and the asset's total is
    // the sum of the fresh parts. Exact on one box; approximate when several
    // processes see the same session (that is what Valkey is for).
    const fresh = Math.max(15, scaleConfig.analytics.concurrencySec * 3);
    await query(
      `WITH p AS (
         INSERT INTO stream_concurrency_parts(process_id, account_id, asset_kind, asset_id, concurrent, updated_at)
         SELECT $1, * , now() FROM unnest($2::uuid[], $3::text[], $4::text[], $5::int[])
         ON CONFLICT (asset_kind, asset_id, process_id) DO UPDATE SET concurrent=EXCLUDED.concurrent, updated_at=now()
         RETURNING asset_kind, asset_id)
       INSERT INTO stream_concurrency(account_id, asset_kind, asset_id, concurrent, updated_at)
       SELECT max(sp.account_id::text)::uuid, sp.asset_kind, sp.asset_id, sum(sp.concurrent)::int, now()
         FROM stream_concurrency_parts sp
        WHERE (sp.asset_kind, sp.asset_id) IN (SELECT asset_kind, asset_id FROM p)
          AND (sp.process_id = $1 OR sp.updated_at > now() - make_interval(secs => $6))
        GROUP BY sp.asset_kind, sp.asset_id
       ON CONFLICT (asset_kind, asset_id) DO UPDATE SET concurrent=EXCLUDED.concurrent, updated_at=now()`,
      [PROCESS_ID, parts.map((f) => f.acct), parts.map((f) => f.kind), parts.map((f) => f.id), parts.map((f) => f.n), fresh]
    );
  }
}

// ============================================================================
//  Sessions (ANALYTICS_SESSIONS=postgres)
// ============================================================================

interface PendingSession {
  acct: string; key: string; appId: string | null; kind: string; asset: string;
  device: string; clientApp: string; rclass: string; geo: string | null; ipHash: string;
  maxBitrate: number | null; ttff: number | null; blocked: boolean;
  seconds: number; rebuffer: number; bytes: number;
  lastSeen: number; endedAt: number | null;
}

let pending = new Map<string, PendingSession>();

function bufferSession(sessionKey: string, ending: boolean, ctx: Ctx, extra: { seconds?: number; bitrateKbps?: number; ttffMs?: number; rebufferMs?: number; bytes?: number; blocked?: boolean }, now: number) {
  const id = `${ctx.accountId}|${sessionKey}`;
  let p = pending.get(id);
  if (!p) {
    const dev = parseDevice(ctx.ua);
    p = {
      acct: ctx.accountId, key: sessionKey, appId: ctx.appId, kind: ctx.assetKind, asset: ctx.assetId,
      device: dev.device_type, clientApp: ctx.clientApp ?? dev.client_app, rclass: classifyReferrer(ctx.referer, ctx.ua),
      geo: ctx.geo ?? null, ipHash: ipHash(ctx.ip), maxBitrate: null, ttff: null, blocked: false,
      seconds: 0, rebuffer: 0, bytes: 0, lastSeen: now, endedAt: null,
    };
    pending.set(id, p);
  }
  // An `end` closes the session; anything after it in the same window only
  // refreshes last_seen, exactly as the single-row UPDATE used to.
  if (p.endedAt == null) {
    p.seconds += extra.seconds ?? 0;
    p.rebuffer += extra.rebufferMs ?? 0;
    p.bytes += extra.bytes ?? 0;
  }
  if (extra.bitrateKbps != null) p.maxBitrate = Math.max(p.maxBitrate ?? 0, extra.bitrateKbps);
  if (extra.ttffMs != null && p.ttff == null) p.ttff = extra.ttffMs;
  if (extra.blocked) p.blocked = true;
  p.lastSeen = now;
  if (ending && p.endedAt == null) p.endedAt = now;
  if (pending.size >= scaleConfig.analytics.maxBuffered) void flushSessions();
}

const SESSION_COLS = 18;

async function flushSessions(): Promise<void> {
  if (!pending.size) return;
  const batch = [...pending.values()];
  pending = new Map();
  const per = Math.min(scaleConfig.analytics.batchRows, Math.floor(60_000 / SESSION_COLS));
  for (let i = 0; i < batch.length; i += per) {
    const chunk = batch.slice(i, i + per);
    try {
      const closed = await upsertSessions(chunk);
      for (const row of closed) foldClosedSession(row);
    } catch (e) {
      console.error('[analytics] session flush failed, keeping rows for retry', (e as Error).message);
      for (const p of batch.slice(i)) mergeBack(p);
      return;
    }
  }
}

function mergeBack(p: PendingSession) {
  const id = `${p.acct}|${p.key}`;
  const cur = pending.get(id);
  if (!cur) { pending.set(id, p); return; }
  cur.seconds += p.seconds; cur.rebuffer += p.rebuffer; cur.bytes += p.bytes;
  cur.maxBitrate = Math.max(cur.maxBitrate ?? 0, p.maxBitrate ?? 0) || null;
  cur.ttff = cur.ttff ?? p.ttff; cur.blocked = cur.blocked || p.blocked;
  cur.endedAt = cur.endedAt ?? p.endedAt;
}

/**
 * One statement for a batch of sessions. Start, heartbeat and end all land
 * here; whichever process flushes first creates the row, later flushes add to
 * it, so a session's beacons may arrive at any process in any order.
 *
 * ENDING STAYS ONE-WAY AND SINGLE-SHOT. The conflict branch skips a row that
 * is already ended when the incoming delta is itself an end, so a replayed
 * `end` updates nothing and is not returned. A returned row whose input was an
 * end is therefore exactly a session closed by THIS flush, and only those are
 * folded into the rollup.
 */
async function upsertSessions(chunk: PendingSession[]): Promise<any[]> {
  const params: unknown[] = [];
  const casts = ['uuid', 'text', 'uuid', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'int', 'int', 'bool', 'int', 'int', 'bigint', 'timestamptz', 'timestamptz'];
  const values = chunk.map((p) => {
    const row = [p.acct, p.key, p.appId, p.kind, p.asset, p.device, p.clientApp, p.rclass, p.geo, p.ipHash,
      p.maxBitrate, p.ttff, p.blocked, Math.round(p.seconds), Math.round(p.rebuffer), Math.round(p.bytes),
      new Date(p.lastSeen), p.endedAt != null ? new Date(p.endedAt) : null];
    return '(' + row.map((v, j) => { params.push(v); return `$${params.length}::${casts[j]}`; }).join(',') + ')';
  }).join(',');
  const { rows } = await pool.query(
    `INSERT INTO play_sessions (account_id, session_key, app_id, asset_kind, asset_id, device_type, client_app,
         referrer_class, geo_country, ip_hash, max_bitrate_kbps, ttff_ms, blocked, seconds_watched, rebuffer_ms,
         bytes, last_seen_at, ended_at)
     VALUES ${values}
     ON CONFLICT (account_id, session_key) DO UPDATE SET
       last_seen_at     = GREATEST(play_sessions.last_seen_at, EXCLUDED.last_seen_at),
       seconds_watched  = CASE WHEN play_sessions.ended_at IS NULL THEN play_sessions.seconds_watched + EXCLUDED.seconds_watched ELSE play_sessions.seconds_watched END,
       rebuffer_ms      = CASE WHEN play_sessions.ended_at IS NULL THEN play_sessions.rebuffer_ms + EXCLUDED.rebuffer_ms ELSE play_sessions.rebuffer_ms END,
       bytes            = CASE WHEN play_sessions.ended_at IS NULL THEN play_sessions.bytes + EXCLUDED.bytes ELSE play_sessions.bytes END,
       max_bitrate_kbps = NULLIF(GREATEST(COALESCE(play_sessions.max_bitrate_kbps,0), COALESCE(EXCLUDED.max_bitrate_kbps,0)), 0),
       ttff_ms          = COALESCE(play_sessions.ttff_ms, EXCLUDED.ttff_ms),
       blocked          = play_sessions.blocked OR EXCLUDED.blocked,
       ended_at         = COALESCE(play_sessions.ended_at, EXCLUDED.ended_at)
     WHERE EXCLUDED.ended_at IS NULL OR play_sessions.ended_at IS NULL
     RETURNING account_id, session_key, app_id, asset_kind, asset_id, device_type, geo_country, blocked,
               seconds_watched, ended_at`,
    params
  );
  const endingKeys = new Set(chunk.filter((p) => p.endedAt != null).map((p) => `${p.acct}|${p.key}`));
  return rows.filter((r: any) => r.ended_at != null && endingKeys.has(`${r.account_id}|${r.session_key}`));
}

// ============================================================================
//  Rollups (batched)
// ============================================================================

interface Agg { acct: string; scope: string; scopeId: string | null; assetKey: string;
  views: number; seconds: number; blocked: number;
  byApp: Record<string, number>; byDevice: Record<string, number>; byGeo: Record<string, number> }

let aggs = new Map<string, Agg>();

function bump(m: Record<string, number>, k: string, n = 1) { m[k] = (m[k] ?? 0) + n; }

function aggFor(acct: string, scope: string, scopeId: string | null, assetKey: string): Agg {
  const id = `${acct}|${scope}|${scopeId ?? ''}`;
  let a = aggs.get(id);
  if (!a) { a = { acct, scope, scopeId, assetKey, views: 0, seconds: 0, blocked: 0, byApp: {}, byDevice: {}, byGeo: {} }; aggs.set(id, a); }
  // Account-scope peak follows the asset whose session last landed here, as
  // the single-row path did.
  a.assetKey = assetKey;
  return a;
}

/** A session closed by a flush: one view, its watch time, its dimensions. Same arithmetic as before. */
function foldClosedSession(s: any) {
  const assetKey = `${s.asset_kind}|${s.asset_id}`;
  for (const [scope, scopeId] of [['account', null], [s.asset_kind, s.asset_id]] as const) {
    const a = aggFor(s.account_id, scope, scopeId, assetKey);
    a.views += 1;
    a.seconds += Number(s.seconds_watched) || 0;
    a.blocked += s.blocked ? 1 : 0;
    bump(a.byApp, s.app_id || 'none');
    bump(a.byDevice, s.device_type || 'Unknown');
    bump(a.byGeo, s.geo_country || 'ZZ');
  }
}

/**
 * ANALYTICS_SESSIONS=none: no per-session rows. A view is counted at `start`
 * (not at `end`), watch time as it is reported. A replayed `start` is caught by
 * a Valkey SET NX on the session for six hours; without Valkey, by this
 * process's memory only. Session-level detail lives in the Firehose stream.
 */
const seenStarts = new Map<string, number>();
function foldBeaconIntoRollup(sessionKey: string, event: string, ctx: Ctx, extra: { seconds?: number; blocked?: boolean }) {
  const assetKey = `${ctx.assetKind}|${ctx.assetId}`;
  const addSeconds = (n: number) => {
    for (const [scope, scopeId] of [['account', null], [ctx.assetKind, ctx.assetId]] as const) aggFor(ctx.accountId, scope, scopeId, assetKey).seconds += n;
  };
  if (extra.seconds) addSeconds(extra.seconds);
  if (event !== 'start') return;
  const countView = () => {
    const dev = parseDevice(ctx.ua);
    for (const [scope, scopeId] of [['account', null], [ctx.assetKind, ctx.assetId]] as const) {
      const a = aggFor(ctx.accountId, scope, scopeId, assetKey);
      a.views += 1;
      a.blocked += extra.blocked ? 1 : 0;
      bump(a.byApp, ctx.appId || (ctx.source === 'share' ? 'share' : 'none'));
      bump(a.byDevice, dev.device_type || 'Unknown');
      bump(a.byGeo, ctx.geo || 'ZZ');
    }
  };
  const id = `${ctx.accountId}|${sessionKey}`;
  if (seenStarts.has(id)) return;
  seenStarts.set(id, Date.now());
  if (seenStarts.size > 500_000) for (const k of seenStarts.keys()) { seenStarts.delete(k); if (seenStarts.size < 400_000) break; }
  const r = redis();
  if (!r) return countView();
  r.set(`sess:${id}`, '1', 'EX', 6 * 3600, 'NX').then((ok: string | null) => { if (ok === 'OK') countView(); }).catch(() => countView());
}

async function flushRollups(): Promise<void> {
  if (!aggs.size) return;
  const batch = [...aggs.values()];
  aggs = new Map();
  const params: unknown[] = [];
  const casts = ['uuid', 'text', 'text', 'bigint', 'int', 'bigint', 'bigint', 'jsonb', 'jsonb', 'jsonb'];
  const values = batch.map((a) => {
    const row = [a.acct, a.scope, a.scopeId, a.views, peakToday.get(a.assetKey) ?? lastConcurrency.get(a.assetKey) ?? 0,
      Math.round(a.seconds), a.blocked, JSON.stringify(a.byApp), JSON.stringify(a.byDevice), JSON.stringify(a.byGeo)];
    const ph = row.map((v, j) => { params.push(v); return `$${params.length}::${casts[j]}`; });
    // views twice: total_views and unique_views, as the single-row path did.
    return `(${ph[0]},${ph[1]},${ph[2]},current_date,${ph[3]},${ph[3]},${ph[4]},${ph[5]},${ph[6]},${ph[7]},${ph[8]},${ph[9]})`;
  }).join(',');
  try {
    await pool.query(
      `INSERT INTO analytics_rollups(account_id, scope, scope_id, bucket_date, total_views, unique_views, peak_concurrent, watch_seconds, blocked_count, by_app, by_device, by_geo)
       VALUES ${values}
       ON CONFLICT (account_id, scope, scope_id, bucket_date) DO UPDATE SET
         total_views     = analytics_rollups.total_views + EXCLUDED.total_views,
         unique_views    = analytics_rollups.unique_views + EXCLUDED.unique_views,
         peak_concurrent = GREATEST(analytics_rollups.peak_concurrent, EXCLUDED.peak_concurrent),
         watch_seconds   = analytics_rollups.watch_seconds + EXCLUDED.watch_seconds,
         blocked_count   = analytics_rollups.blocked_count + EXCLUDED.blocked_count,
         by_app          = jsonb_add(analytics_rollups.by_app, EXCLUDED.by_app),
         by_device       = jsonb_add(analytics_rollups.by_device, EXCLUDED.by_device),
         by_geo          = jsonb_add(analytics_rollups.by_geo, EXCLUDED.by_geo)`,
      params
    );
  } catch (e) {
    console.error('[analytics] rollup flush failed, keeping for retry', (e as Error).message);
    for (const a of batch) {
      const cur = aggFor(a.acct, a.scope, a.scopeId, a.assetKey);
      cur.views += a.views; cur.seconds += a.seconds; cur.blocked += a.blocked;
      for (const [k, n] of Object.entries(a.byApp)) bump(cur.byApp, k, n);
      for (const [k, n] of Object.entries(a.byDevice)) bump(cur.byDevice, k, n);
      for (const [k, n] of Object.entries(a.byGeo)) bump(cur.byGeo, k, n);
    }
  }
}

// ============================================================================
//  Firehose mirror (optional)
// ============================================================================

let fhQueue: string[] = [];
let fhClient: any | null | undefined;

function firehose(): any | null {
  if (fhClient !== undefined) return fhClient;
  if (!scaleConfig.analytics.firehoseStream) return (fhClient = null);
  try {
    const { FirehoseClient } = createRequire(__filename)('@aws-sdk/client-firehose');
    fhClient = new FirehoseClient({});
  } catch {
    console.error('[analytics] ANALYTICS_FIREHOSE_STREAM is set but @aws-sdk/client-firehose is not installed');
    fhClient = null;
  }
  return fhClient;
}

function mirrorToFirehose(sessionKey: string, event: string, ctx: Ctx, extra: Record<string, unknown>, now: number) {
  if (!scaleConfig.analytics.firehoseStream) return;
  const dev = parseDevice(ctx.ua);
  fhQueue.push(JSON.stringify({
    ts: new Date(now).toISOString(), event, session: sessionKey, account: ctx.accountId, app: ctx.appId,
    kind: ctx.assetKind, asset: ctx.assetId, device: dev.device_type, client: ctx.clientApp ?? dev.client_app,
    referrer: classifyReferrer(ctx.referer, ctx.ua), geo: ctx.geo ?? null, ip: ipHash(ctx.ip), ...extra,
  }) + '\n');
  if (fhQueue.length > 200_000) fhQueue.splice(0, fhQueue.length - 200_000);
}

async function flushFirehose(): Promise<void> {
  const c = firehose();
  if (!c || !fhQueue.length) return;
  const { PutRecordBatchCommand } = createRequire(__filename)('@aws-sdk/client-firehose');
  while (fhQueue.length) {
    const take = fhQueue.splice(0, 500);
    try {
      const out = await c.send(new PutRecordBatchCommand({
        DeliveryStreamName: scaleConfig.analytics.firehoseStream,
        Records: take.map((d) => ({ Data: Buffer.from(d) })),
      }));
      if (out.FailedPutCount) {
        const failed = (out.RequestResponses ?? []).map((r: any, i: number) => (r.ErrorCode ? take[i] : null)).filter(Boolean);
        fhQueue.unshift(...failed);
        return;
      }
    } catch (e) {
      fhQueue.unshift(...take);
      console.error('[analytics] firehose put failed', (e as Error).message);
      return;
    }
  }
}

// ============================================================================
//  Lifecycle
// ============================================================================

let timers: NodeJS.Timeout[] = [];

export function startAnalyticsPipeline(): void {
  if (timers.length) return;
  const every = (sec: number, fn: () => Promise<void>, name: string) => {
    let busy = false;
    const t = setInterval(async () => {
      if (busy) return;
      busy = true;
      try { await fn(); } catch (e) { console.error(`[analytics] ${name} failed`, (e as Error).message); } finally { busy = false; }
    }, sec * 1000);
    t.unref();
    timers.push(t);
  };
  every(scaleConfig.analytics.flushSec, async () => { await flushSessions(); await flushRollups(); }, 'flush');
  every(scaleConfig.analytics.concurrencySec, computeConcurrency, 'concurrency');
  every(1, flushFirehose, 'firehose');
}

export async function stopAnalyticsPipeline(): Promise<void> {
  for (const t of timers) clearInterval(t);
  timers = [];
  await flushSessions().catch(() => {});
  await flushRollups().catch(() => {});
  await flushFirehose().catch(() => {});
}

export function analyticsStats() {
  return {
    sessionsMode: scaleConfig.analytics.sessions,
    bufferedSessions: pending.size,
    bufferedRollups: aggs.size,
    activeAssets: activeAssets.size,
    firehoseQueued: fhQueue.length,
  };
}

/** Test hooks. */
export const _analyticsInternals = { flushSessions, flushRollups, computeConcurrency, pending: () => pending, aggs: () => aggs };
