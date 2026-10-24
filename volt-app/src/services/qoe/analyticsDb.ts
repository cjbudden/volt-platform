// ============================================================================
//  THE ANALYTICS DATABASE (QOE_REPORTING.md section 9a).
//
//  Playback reporting never shares the control plane's database pool. A slow
//  report, a replay or a backlog of view rows must not be able to delay a
//  stream start or a playback token, so the derived QoE data (view rows and
//  minute aggregates) lives in its own database with its own small pool and a
//  hard statement timeout:
//
//    ANALYTICS_DATABASE_URL   where it is. Unset: a second database on the
//                             same Postgres server as DATABASE_URL, named
//                             <that database>_qoe, created on first use.
//    ANALYTICS_POOL_MAX       connections (default 4; the control plane's own
//                             pool is untouched by anything here)
//    ANALYTICS_QUERY_MS       statement timeout for every query (default 10000)
//
//  On the Mac and for a pilot that second database is enough. Above about a
//  million viewer hours a month it becomes ClickHouse (build queue 2.11); the
//  collector and the reports only reach the store through this module and
//  services/qoe/store.ts, so that is a configuration change.
//
//  Nothing here is the record: the raw reports (rawStore.ts) are. Every table
//  below can be deleted and rebuilt with the replay (services/qoe/replay.ts).
// ============================================================================
import { Client, Pool } from 'pg';
import { config } from '../../config';

let pool: Pool | null = null;
let ready: Promise<void> | null = null;

/** The analytics database's connection string. */
export function analyticsUrl(): string {
  if (process.env.ANALYTICS_DATABASE_URL) return process.env.ANALYTICS_DATABASE_URL;
  const u = new URL(config.databaseUrl);
  const base = decodeURIComponent(u.pathname.replace(/^\//, '')) || 'volt';
  // Postgres names are at most 63 bytes; the check runner's suite names are long.
  u.pathname = '/' + base.slice(0, 59) + '_qoe';
  return u.toString();
}

function dbName(url: string): string { return decodeURIComponent(new URL(url).pathname.replace(/^\//, '')); }

/** Bump when the schema below changes shape (the tables are rebuildable, so a bump may drop them). */
export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS qoe_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

-- Adds two JSON objects of numbers key by key: the minute sketches merge this way.
CREATE OR REPLACE FUNCTION qoe_jsonb_add(a JSONB, b JSONB) RETURNS JSONB LANGUAGE SQL IMMUTABLE AS $$
  SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb) FROM (
    SELECT k, SUM(v::numeric) AS v FROM (
      SELECT key AS k, value::text AS v FROM jsonb_each(COALESCE(a, '{}'::jsonb))
      UNION ALL
      SELECT key, value::text FROM jsonb_each(COALESCE(b, '{}'::jsonb))
    ) x GROUP BY k
  ) y
$$;

-- ONE ROW PER VIEW (play attempt), written when the view closes. The id is
-- deterministic (sid and attempt number), so a replay writes the same rows.
CREATE TABLE IF NOT EXISTS qoe_views (
  account_id     UUID NOT NULL,
  view_id        TEXT NOT NULL,
  day            DATE NOT NULL,             -- UTC day the view started: the replay partition
  def_version    INT  NOT NULL,             -- the definitions it was computed with
  sid            TEXT NOT NULL,
  attempt        INT  NOT NULL,
  app_id         UUID,
  started_at     TIMESTAMPTZ NOT NULL,
  ended_at       TIMESTAMPTZ NOT NULL,
  ended_by       TEXT NOT NULL,             -- e ended, q quit, f fatal, silence
  content_id     TEXT,
  stream_type    TEXT,                      -- v on demand, l live, ll low latency
  app_name       TEXT, app_version TEXT, sdk_version TEXT, player_version TEXT,
  device_model   TEXT, device_class TEXT,
  os             TEXT, os_version TEXT, browser TEXT, browser_version TEXT,
  codec          TEXT, cdn TEXT, country TEXT, region TEXT, asn TEXT, network TEXT,
  outcome        TEXT NOT NULL,             -- started | failed | exited (before the first frame)
  waited_ms      INT,                       -- not started: how long the viewer waited
  startup_ms     INT,                       -- play pressed to the first frame
  t_entitlement  INT, t_manifest INT, t_drm INT, t_segment INT, t_decode INT, t_other INT,
  error_code     TEXT, error_step TEXT,
  fatal_after_start BOOLEAN NOT NULL DEFAULT false,
  nonfatal_errors INT NOT NULL DEFAULT 0,
  playing_ms     BIGINT NOT NULL DEFAULT 0,
  rebuffer_ms    BIGINT NOT NULL DEFAULT 0,
  stalls         INT NOT NULL DEFAULT 0,
  first_stall_ms INT,
  seeks          INT NOT NULL DEFAULT 0,
  seek_ms        BIGINT NOT NULL DEFAULT 0,
  paused_ms      BIGINT NOT NULL DEFAULT 0,
  background_ms  BIGINT NOT NULL DEFAULT 0,
  bitrate_ms     BIGINT NOT NULL DEFAULT 0,  -- playing ms with a known bitrate
  bitrate_kbps_ms BIGINT NOT NULL DEFAULT 0, -- sum of kbps x ms: time-weighted bitrate = this / bitrate_ms
  below_top_ms   BIGINT NOT NULL DEFAULT 0,  -- playing ms under what the screen can use (tpb)
  switches       INT NOT NULL DEFAULT 0,
  oscillations   INT NOT NULL DEFAULT 0,
  buffer_avg_ms  INT, throughput_avg_kbps INT,
  dropped_frames INT, latency_avg_ms INT,
  exit_after_stall BOOLEAN NOT NULL DEFAULT false,
  exit_after_error BOOLEAN NOT NULL DEFAULT false,
  events         INT NOT NULL DEFAULT 0,
  sn_missing     INT NOT NULL DEFAULT 0,     -- gaps in the sequence numbers
  no_sn          INT NOT NULL DEFAULT 0,     -- reports without sn (third-party players)
  late_events    INT NOT NULL DEFAULT 0,     -- arrived more than 60 s after they were made
  clock_skew_ms  INT,                        -- device clock minus ours, at the first report
  unknown_keys   JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (account_id, view_id)
);
CREATE INDEX IF NOT EXISTS qoe_views_day ON qoe_views (account_id, day);
CREATE INDEX IF NOT EXISTS qoe_views_ended ON qoe_views (account_id, ended_at);

-- MINUTE AGGREGATES for the live charts, on the few dimensions they need.
-- Counts and sums add; the sketches are DDSketch bins (sketch.ts) that add too,
-- so several collectors (and a 10 s flush) merge into one row.
CREATE TABLE IF NOT EXISTS qoe_minutes (
  account_id   UUID NOT NULL,
  minute       TIMESTAMPTZ NOT NULL,
  content_id   TEXT NOT NULL DEFAULT '',
  stream_type  TEXT NOT NULL DEFAULT '',
  country      TEXT NOT NULL DEFAULT '',
  device_class TEXT NOT NULL DEFAULT '',
  cdn          TEXT NOT NULL DEFAULT '',
  def_version  INT NOT NULL,
  attempts     INT NOT NULL DEFAULT 0,
  starts       INT NOT NULL DEFAULT 0,
  failures     INT NOT NULL DEFAULT 0,
  fatal_after  INT NOT NULL DEFAULT 0,
  stalls       INT NOT NULL DEFAULT 0,
  playing_ms   BIGINT NOT NULL DEFAULT 0,
  rebuffer_ms  BIGINT NOT NULL DEFAULT 0,
  switches     INT NOT NULL DEFAULT 0,
  startup_sketch JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (account_id, minute, content_id, stream_type, country, device_class, cdn)
);

-- What the collector refused, by reason, per minute (report 12). Not
-- rebuildable: a refused line is not kept raw, so a replay leaves this alone.
CREATE TABLE IF NOT EXISTS qoe_collector_minutes (
  account_id UUID NOT NULL,
  minute     TIMESTAMPTZ NOT NULL,
  accepted   INT NOT NULL DEFAULT 0,
  rejected   INT NOT NULL DEFAULT 0,
  reasons    JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (account_id, minute)
);
`;

async function createIfMissing(url: string): Promise<void> {
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try { await c.connect(); await c.end(); return; }
  catch (e: any) {
    try { await c.end(); } catch { /* */ }
    if (e?.code !== '3D000') throw e; // only "database does not exist" is ours to fix
  }
  const admin = new URL(url); admin.pathname = '/postgres';
  const a = new Client({ connectionString: admin.toString(), connectionTimeoutMillis: 3000 });
  await a.connect();
  try { await a.query(`CREATE DATABASE "${dbName(url).replace(/"/g, '')}"`); }
  catch (e: any) { if (e?.code !== '42P04') throw e; } // created by another process meanwhile
  finally { await a.end(); }
}

/** The pool, created (and the database and schema made) on first use. */
export async function analyticsPool(): Promise<Pool> {
  if (!ready) {
    ready = (async () => {
      const url = analyticsUrl();
      await createIfMissing(url);
      pool = new Pool({
        connectionString: url,
        max: Math.max(1, Number(process.env.ANALYTICS_POOL_MAX ?? 4)),
        connectionTimeoutMillis: 3000,
        statement_timeout: Math.max(1000, Number(process.env.ANALYTICS_QUERY_MS ?? 10_000)),
        idleTimeoutMillis: 30_000,
      } as any);
      pool.on('error', (e) => console.error('[qoe] analytics database', e.message));
      // Two processes starting together: one creates, the other waits on the lock.
      const c = await pool.connect();
      try {
        await c.query(`SELECT pg_advisory_lock(72010001)`);
        await c.query(SCHEMA);
        await c.query(`INSERT INTO qoe_meta(k, v) VALUES ('schema', $1) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [String(SCHEMA_VERSION)]);
      } finally { await c.query(`SELECT pg_advisory_unlock(72010001)`).catch(() => {}); c.release(); }
    })().catch((e) => { ready = null; const p = pool; pool = null; p?.end().catch(() => {}); throw e; });
  }
  await ready;
  return pool!;
}

export async function aquery<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const p = await analyticsPool();
  return (await p.query(text, params)).rows as T[];
}

/** Close the pool (tests; shutdown). The next call opens it again. */
export async function closeAnalytics(): Promise<void> {
  const p = pool; pool = null; ready = null;
  if (p) await p.end().catch(() => {});
}
