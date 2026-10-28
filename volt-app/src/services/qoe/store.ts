// ============================================================================
//  WRITING THE DERIVED QOE DATA (QOE_REPORTING.md section 9a).
//
//  Batched, never per report: each write is one statement for many rows
//  (jsonb_populate_recordset), so the analytics database sees a few inserts
//  every 10 s whatever the audience. View rows replace by their deterministic
//  id; minute rows add (counts, sums and sketch bins), so several collector
//  processes and repeated flushes merge into the same minute.
//
//  Each of the four functions has a Postgres and a ClickHouse form (build
//  queue 2.11); storeSwitch.ts says which store, or both while moving.
// ============================================================================
import { analyticsPool } from './analyticsDb';
import { chExec, chInsert, lit } from './clickhouse';
import { forEachTarget, qoeChDatabase, type StoreKind } from './storeSwitch';
import type { MinuteRow, ViewRow } from './views';
import { DEFINITIONS_VERSION } from './views';

const iso = (ms: number) => new Date(ms).toISOString();

function viewJson(v: ViewRow) {
  return { ...v, started_at: iso(v.started_at), ended_at: iso(v.ended_at), app_id: v.app_id && /^[0-9a-f-]{36}$/i.test(v.app_id) ? v.app_id : null };
}
function minuteJson(m: MinuteRow) { return { ...m, minute: iso(m.minute), def_version: DEFINITIONS_VERSION }; }

const VIEW_COLS = [
  'account_id', 'view_id', 'day', 'def_version', 'sid', 'attempt', 'app_id', 'started_at', 'ended_at', 'ended_by', 'content_id', 'stream_type',
  'app_name', 'app_version', 'sdk_version', 'player_version', 'device_model', 'device_class', 'os', 'os_version', 'browser', 'browser_version',
  'codec', 'cdn', 'country', 'region', 'asn', 'network', 'outcome', 'waited_ms', 'startup_ms',
  't_entitlement', 't_manifest', 't_drm', 't_segment', 't_decode', 't_other', 'error_code', 'error_step', 'fatal_after_start', 'nonfatal_errors',
  'playing_ms', 'rebuffer_ms', 'stalls', 'first_stall_ms', 'seeks', 'seek_ms', 'paused_ms', 'background_ms', 'bitrate_ms', 'bitrate_kbps_ms', 'below_top_ms',
  'switches', 'oscillations', 'buffer_avg_ms', 'throughput_avg_kbps', 'dropped_frames', 'latency_avg_ms', 'exit_after_stall', 'exit_after_error',
  'events', 'sn_missing', 'no_sn', 'late_events', 'clock_skew_ms', 'unknown_keys',
  // definitions version 2 (reports 5, 7, 8 and 9)
  'decode_errors', 'hw_decode', 'key_system', 'licence_requests', 'licence_failures', 'licence_ms', 'licence_max_ms', 'token_errors',
  'latency_first_ms', 'latency_last_ms', 'latency_min_ms', 'latency_max_ms', 'rate_changes', 'catchup_ms', 'slowdown_ms',
  'ad_breaks', 'ad_breaks_ended', 'ad_ms', 'ad_playing_ms', 'ad_rebuffer_ms', 'ad_stalls', 'ad_errors',
  'ad_start_ms', 'ad_start_n', 'ad_start_max_ms', 'ad_return_ms', 'ad_return_n', 'ad_return_max_ms', 'ads_started', 'ads_ended', 'left_in_ad',
  // definitions version 3 (journey to play)
  'journey_id', 'app_session_id', 'entry_point', 'session_depth',
];
const MIN_KEY = ['account_id', 'minute', 'content_id', 'stream_type', 'country', 'device_class', 'cdn'];
const MIN_ADD = ['attempts', 'starts', 'failures', 'fatal_after', 'stalls', 'playing_ms', 'rebuffer_ms', 'switches'];

const CHUNK = 2000;

type Q = { query: (t: string, p: any[]) => Promise<any> };

/** Upsert closed (or provisionally closed) views. `client`: inside a Postgres transaction (replaceDay). */
export async function writeViews(views: ViewRow[], client?: Q, target?: StoreKind): Promise<void> {
  if (client) return pgWriteViews(views, client);
  await forEachTarget({
    clickhouse: () => chInsert('qoe_views', views.map(chView), qoeChDatabase(), { versioned: true }),
    postgres: () => pgWriteViews(views),
  }, target);
}

/** A view row for ClickHouse: the same columns (a later write of the same id wins on _v). */
function chView(v: ViewRow) { const j = viewJson(v); const o: Record<string, unknown> = {}; for (const k of VIEW_COLS) o[k] = (j as any)[k] ?? null; o.unknown_keys = (j as any).unknown_keys ?? {}; return o; }
function chMinute(m: MinuteRow) { const j = minuteJson(m) as any; const o: Record<string, unknown> = {}; for (const k of [...MIN_KEY, 'def_version', ...MIN_ADD, 'startup_sketch']) o[k] = j[k] ?? (MIN_KEY.includes(k) ? '' : null); o.startup_sketch = j.startup_sketch ?? {}; return o; }

async function pgWriteViews(views: ViewRow[], client?: Q): Promise<void> {
  const c = client ?? await analyticsPool();
  for (let i = 0; i < views.length; i += CHUNK) {
    const part = views.slice(i, i + CHUNK).map(viewJson);
    await c.query(
      `INSERT INTO qoe_views (${VIEW_COLS.join(',')})
       SELECT ${VIEW_COLS.join(',')} FROM jsonb_populate_recordset(NULL::qoe_views, $1::jsonb)
       ON CONFLICT (account_id, view_id) DO UPDATE SET ${VIEW_COLS.filter((k) => k !== 'account_id' && k !== 'view_id').map((k) => `${k} = EXCLUDED.${k}`).join(', ')}`,
      [JSON.stringify(part)]);
  }
}

/** Add minute aggregates into what is there. */
export async function addMinutes(rows: MinuteRow[], client?: Q, target?: StoreKind): Promise<void> {
  if (client) return pgAddMinutes(rows, client);
  await forEachTarget({
    clickhouse: () => chInsert('qoe_minutes', rows.map(chMinute), qoeChDatabase(), { additive: true }),
    postgres: () => pgAddMinutes(rows),
  }, target);
}

async function pgAddMinutes(rows: MinuteRow[], client?: Q): Promise<void> {
  const c = client ?? await analyticsPool();
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK).map(minuteJson);
    await c.query(
      `INSERT INTO qoe_minutes (${[...MIN_KEY, 'def_version', ...MIN_ADD, 'startup_sketch'].join(',')})
       SELECT ${[...MIN_KEY, 'def_version', ...MIN_ADD, 'startup_sketch'].join(',')} FROM jsonb_populate_recordset(NULL::qoe_minutes, $1::jsonb)
       ON CONFLICT (${MIN_KEY.join(',')}) DO UPDATE SET
         ${MIN_ADD.map((k) => `${k} = qoe_minutes.${k} + EXCLUDED.${k}`).join(', ')},
         startup_sketch = qoe_jsonb_add(qoe_minutes.startup_sketch, EXCLUDED.startup_sketch),
         def_version = EXCLUDED.def_version`,
      [JSON.stringify(part)]);
  }
}

/** The collector's own counts per minute: accepted and refused lines (report 12). */
export async function addCollectorCounts(rows: Array<{ account_id: string; minute: number; accepted: number; rejected: number; reasons: Record<string, number> }>): Promise<void> {
  if (!rows.length) return;
  await forEachTarget({
    // While moving, minutes before the switch are copied from Postgres (storeSwitch.ts), so only later ones are added here.
    clickhouse: (since) => chInsert('qoe_collector_minutes', rows.filter((r) => since == null || r.minute >= since).map((r) => ({ ...r, minute: iso(r.minute) })), qoeChDatabase(), { additive: true }),
    postgres: () => pgAddCollectorCounts(rows),
  });
}

async function pgAddCollectorCounts(rows: Array<{ account_id: string; minute: number; accepted: number; rejected: number; reasons: Record<string, number> }>): Promise<void> {
  const c = await analyticsPool();
  await c.query(
    `INSERT INTO qoe_collector_minutes (account_id, minute, accepted, rejected, reasons)
     SELECT account_id, minute, accepted, rejected, reasons FROM jsonb_populate_recordset(NULL::qoe_collector_minutes, $1::jsonb)
     ON CONFLICT (account_id, minute) DO UPDATE SET accepted = qoe_collector_minutes.accepted + EXCLUDED.accepted,
       rejected = qoe_collector_minutes.rejected + EXCLUDED.rejected, reasons = qoe_jsonb_add(qoe_collector_minutes.reasons, EXCLUDED.reasons)`,
    [JSON.stringify(rows.map((r) => ({ ...r, minute: iso(r.minute) })))]);
}

/**
 * REPLACE ONE DAY PARTITION of one account, in one transaction: the views
 * that started that day and the minutes of that day go, the rebuilt ones
 * come in. Readers see the old day or the new day, never half of each.
 */
export async function replaceDay(acct: string, day: string, views: ViewRow[], minutes: MinuteRow[], target?: StoreKind): Promise<void> {
  await forEachTarget({ clickhouse: () => chReplaceDay(acct, day, views, minutes), postgres: () => pgReplaceDay(acct, day, views, minutes) }, target);
}

/**
 * ClickHouse has no transactions: the day's rows of this account are
 * deleted (lightweight DELETE, synchronous) and the rebuilt ones inserted.
 * A report that runs in between sees part of the day, never a wrong total
 * afterwards; the other accounts' rows are never touched.
 */
async function chReplaceDay(acct: string, day: string, views: ViewRow[], minutes: MinuteRow[]): Promise<void> {
  const db = qoeChDatabase();
  const start = new Date(day + 'T00:00:00Z'), end = new Date(+start + 86_400_000);
  await chExec(`DELETE FROM qoe_views WHERE account_id = ${lit(acct)} AND day = toDate(${lit(day)})`, db);
  await chExec(`DELETE FROM qoe_minutes WHERE account_id = ${lit(acct)} AND minute >= ${lit(start)} AND minute < ${lit(end)}`, db);
  await chInsert('qoe_views', views.map(chView), db, { versioned: true });
  await chInsert('qoe_minutes', minutes.map(chMinute), db, { additive: true });
}

async function pgReplaceDay(acct: string, day: string, views: ViewRow[], minutes: MinuteRow[]): Promise<void> {
  const p = await analyticsPool();
  const c = await p.connect();
  try {
    await c.query('BEGIN');
    await c.query(`DELETE FROM qoe_views WHERE account_id = $1 AND day = $2::date`, [acct, day]);
    await c.query(`DELETE FROM qoe_minutes WHERE account_id = $1 AND minute >= ($2::date)::timestamp AT TIME ZONE 'UTC' AND minute < ($2::date + 1)::timestamp AT TIME ZONE 'UTC'`, [acct, day]);
    await pgWriteViews(views, c);
    await pgAddMinutes(minutes, c);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}
