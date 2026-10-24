/**
 * SCALE CONFIGURATION.
 *
 * Everything that changes how Volt behaves under load is read here, from the
 * environment, and nowhere else. Every setting has a default that keeps a
 * single-box dev run working exactly as before: no Valkey, one process doing
 * everything, analytics sessions stored in Postgres (batched).
 *
 * The same image runs in three shapes, chosen by environment alone:
 *
 *   dev        ROLE=all, no REDIS_URL           one process, one box
 *   staging    ROLE per service, REDIS_URL set  docker compose, nginx edge
 *   AWS        ROLE per ECS service, ElastiCache, CloudFront in front
 *
 * See SCALING.md at the repository root for what each setting is for.
 */

export type Role = 'all' | 'api' | 'api-public' | 'api-admin' | 'scheduler' | 'worker';

const ROLES: Role[] = ['all', 'api', 'api-public', 'api-admin', 'scheduler', 'worker'];

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got '${v}'`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

function role(): Role {
  const r = (process.env.ROLE ?? 'all').trim() as Role;
  if (!ROLES.includes(r)) throw new Error(`ROLE must be one of ${ROLES.join(', ')}, got '${r}'`);
  return r;
}

export const scaleConfig = {
  /** What this process does. See roles.ts. */
  role: role(),

  /**
   * Valkey / Redis. Optional. When unset, every cache is per-process only and
   * concurrency is counted per process (exact on one box, approximate with
   * several processes and no Valkey). redis:// or rediss:// (TLS, ElastiCache).
   */
  redisUrl: process.env.REDIS_URL || null,

  /**
   * The connection used for LISTEN. LISTEN holds a session, which RDS Proxy
   * handles by pinning: harmless for one connection per task, but cleaner to
   * point this at the database directly. Falls back to DATABASE_URL.
   */
  listenUrl: process.env.DATABASE_LISTEN_URL || process.env.DATABASE_URL || 'postgres://volt:volt@localhost:5432/volt',

  /** Connections per process in the main pool (was hard-coded to 10). */
  dbPoolMax: num('DB_POOL_MAX', 10),

  cache: {
    /** Master switch. Off = every lookup goes to the database, as before. */
    enabled: bool('VIEWER_CACHE', true),
    /** Keys, apps, account status. */
    keyTtlSec: num('CACHE_KEY_TTL_SEC', 60),
    /** Asset ownership and kind. Only changes on delete. */
    assetTtlSec: num('CACHE_ASSET_TTL_SEC', 300),
    /** Availability rows, publishing rules, channel on-air state. */
    rulesTtlSec: num('CACHE_RULES_TTL_SEC', 30),
    /** The current EPG programme. Also capped at the programme's own end time. */
    programmeTtlSec: num('CACHE_PROGRAMME_TTL_SEC', 60),
    /** A viewer's identity row: how long before last_seen_at is written again. */
    viewerTouchSec: num('CACHE_VIEWER_TOUCH_SEC', 900),
    /** A viewer's entitlements. Purchases invalidate immediately regardless. */
    entitlementTtlSec: num('CACHE_ENTITLEMENT_TTL_SEC', 60),
    /** Upper bound on entries held in each process. */
    maxEntries: num('CACHE_MAX_ENTRIES', 100_000),
  },

  keyUsage: {
    /** How often per-key request counts are written. */
    flushSec: num('KEY_USAGE_FLUSH_SEC', 10),
  },

  edge: {
    /**
     * Trust CloudFront-Viewer-Country (or X-Viewer-Country from the staging
     * nginx) over the geo a client puts in the body. Only turn on when every
     * request reaches the API through that edge: a client could otherwise set
     * the header itself.
     */
    trustGeoHeader: bool('TRUST_EDGE_GEO', false),
    /**
     * When set, the geo header is trusted only on requests that also carry
     * X-Volt-Edge with this value. CloudFront adds it as an origin custom
     * header (and the staging nginx sets it), so a client that reaches the
     * load balancer directly cannot choose its own country.
     */
    sharedSecret: process.env.EDGE_SHARED_SECRET || null,
    /** Header names checked, in order, when trustGeoHeader is on. */
    geoHeaders: (process.env.EDGE_GEO_HEADERS ?? 'cloudfront-viewer-country,x-viewer-country')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    /** Longest an anonymous availability answer may be cached at the edge. */
    availabilityMaxAgeSec: num('EDGE_AVAILABILITY_MAX_AGE', 15),
    /** Cache lifetime of the /live manifest redirect. */
    liveRedirectMaxAgeSec: num('EDGE_LIVE_REDIRECT_MAX_AGE', 2),
  },

  analytics: {
    /**
     * Where per-session rows go.
     *   postgres  batched upserts into play_sessions (default; fine to ~100k viewers)
     *   none      no per-session rows; rollups are built straight from beacons,
     *             raw beacons go to Firehose for the data lake (AWS at 1M scale)
     */
    sessions: (process.env.ANALYTICS_SESSIONS ?? 'postgres') as 'postgres' | 'none',
    /** Optional Kinesis Data Firehose stream that receives every raw beacon. */
    firehoseStream: process.env.ANALYTICS_FIREHOSE_STREAM || null,
    /** How often buffered sessions and rollups are written. */
    flushSec: num('ANALYTICS_FLUSH_SEC', 5),
    /** How often concurrency is recomputed and published. */
    concurrencySec: num('ANALYTICS_CONCURRENCY_SEC', 5),
    /** Rows per INSERT / UPDATE statement. */
    batchRows: num('ANALYTICS_BATCH_ROWS', 500),
    /** Safety valve: beyond this many buffered sessions, flush early. */
    maxBuffered: num('ANALYTICS_MAX_BUFFERED', 50_000),
  },

  prewarm: {
    /** Scale the viewer API up ahead of scheduled events with expected_viewers. */
    enabled: bool('PREWARM_ENABLED', true),
    /** 'log' only reports what it would do; 'aws' sets ECS min capacity. */
    mode: (process.env.PREWARM_MODE ?? 'log') as 'log' | 'aws',
    /** Start scaling this long before the event. Fargate needs ~1-2 min per step. */
    leadMinutes: num('PREWARM_LEAD_MIN', 20),
    /** Keep the raised floor this long after the event starts. */
    holdMinutes: num('PREWARM_HOLD_MIN', 30),
    /** The window most viewers arrive in. 1M in 90 s = 11k starts/s. */
    rampSeconds: num('PREWARM_RAMP_SEC', 90),
    /** Measured starts/s one api-public task sustains. Load test, then set. */
    startsPerTask: num('PREWARM_STARTS_PER_TASK', 1500),
    /** Fraction of starts that reach the origin (the rest the edge answers). */
    originFraction: num('PREWARM_ORIGIN_FRACTION', 1),
    baseMin: num('PREWARM_BASE_MIN', 2),
    maxTasks: num('PREWARM_MAX_TASKS', 60),
    /** ECS service ids, `service/<cluster>/<service>`. */
    ecsResourceIds: (process.env.PREWARM_ECS_RESOURCE_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    tickSec: num('PREWARM_TICK_SEC', 60),
  },

  metrics: {
    /** Publish queue depth etc. to CloudWatch (namespace below) for autoscaling. */
    cloudwatch: bool('CLOUDWATCH_METRICS', false),
    namespace: process.env.CLOUDWATCH_NAMESPACE ?? 'Volt',
    service: process.env.METRICS_SERVICE_NAME ?? 'volt',
    periodSec: num('METRICS_PERIOD_SEC', 30),
  },

  /**
   * api-public serves only these path prefixes; anything else is 404. The edge
   * already routes admin paths elsewhere, so this is a second line, not the
   * first. Override with PUBLIC_PATH_PREFIXES (comma separated). A prefix
   * ending in '/' matches below it; one without also matches itself.
   * Not here on purpose: /radio/:id/stream.mp3 and /origin are the PRIVATE
   * previews; the public radio URL is /live/:id/stream.mp3. /fast/ is the
   * FAST ad stitcher's per-viewer playlists (modules/fast.ts fastPublicRouter).
   * /channel/ and /event/ carry only the variant manifests the CDN sends
   * replaced viewers to (/<kind>/<id>/v/<key>/, services/variantManifest.ts).
   */
  publicPrefixes: (process.env.PUBLIC_PATH_PREFIXES ??
    '/health,/live/,/share/,/api/share/,/xmltv/,/img/,/library/,/player,/clips/,/gfx/,/fast/,/channel/,/event/,' +
    '/api/public/,/api/availability,/api/access,/api/player/,/api/analytics/beacon,/api/cmcd,/api/payments/verify')
    .split(',').map((s) => s.trim()).filter(Boolean),
};

/** Does this process serve HTTP traffic (beyond health checks)? */
export const servesApi = (r: Role = scaleConfig.role) =>
  r === 'all' || r === 'api' || r === 'api-public' || r === 'api-admin';
/** Does this process compete for the scheduler leadership? */
export const runsScheduler = (r: Role = scaleConfig.role) => r === 'all' || r === 'scheduler';
/** Does this process claim jobs from the queue? */
export const runsWorker = (r: Role = scaleConfig.role) => r === 'all' || r === 'worker';
