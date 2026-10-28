// ============================================================================
//  THE CLICKHOUSE ANALYTICS STORE (build queue 2.11, QOE_REPORTING.md 9 and 9a).
//
//  Above about a million viewer hours a month the derived QoE data moves from
//  the Postgres analytics database to ClickHouse, where a filter on any
//  dimension over 13 months of view rows is a sub-second query. The raw
//  reports stay the record (rawStore.ts); everything here is rebuildable.
//
//  Reached over ClickHouse's own HTTP interface with fetch: no client
//  library, so nothing new to install on the Mac or in the image, and the
//  same code talks to a self-run cluster or to ClickHouse Cloud (decision 4
//  in QOE_REPORTING.md section 11 is a URL, not a rewrite).
//
//    CLICKHOUSE_URL        http(s)://[user:password@]host:8123, or several
//                          separated by commas (the replicas): a replica that
//                          does not answer is skipped, so losing one leaves
//                          the reports and the collector working
//    CLICKHOUSE_DATABASE   default: the Postgres analytics database's name,
//                          so each check suite and each install has its own
//    CLICKHOUSE_CLUSTER    the cluster name in the servers' remote_servers
//                          (deploy/terraform/clickhouse.tf: volt). Set: the
//                          tables are Replicated*MergeTree, made ON CLUSTER
//    CLICKHOUSE_QUERY_MS   time limit for one query (default 10000, as
//                          ANALYTICS_QUERY_MS)
//
//  WHY THESE ENGINES. The Postgres tables upsert (views, journeys, app
//  sessions) or add into a row (minutes, CDN sessions). ClickHouse does not
//  update rows; it merges them in the background:
//    - upserted tables are ReplacingMergeTree on a version (_v, the write
//      time), read with FINAL so a view written twice counts once;
//    - added tables are AggregatingMergeTree with SimpleAggregateFunction
//      columns (sum, min, max, sumMap for the sketch bins), so the 10 s
//      flushes and several collector tasks merge exactly as ON CONFLICT
//      DO UPDATE did; the reports sum them anyway, so they need no FINAL;
//    - the play gate's log is append only (MergeTree).
//  Partitions are months: 13 to 25 of them, never thousands.
//
//  THE SQL. The reports are written once, in Postgres SQL (reports.ts,
//  journeys.ts, cdnLogs.ts). toClickHouse() turns the constructs they use
//  into ClickHouse's: parameters become escaped literals, `= ANY($n)`
//  becomes has(), percentile_disc becomes the same nearest rank over the
//  sorted values (ceil(p x n), Postgres's own rule, so both stores give the
//  same number), casts go, FINAL is added where rows are versioned. The few
//  queries with no mechanical equivalent (LATERAL, jsonb_each_text, a
//  correlated EXISTS) carry their own ClickHouse text beside the Postgres one.
//  Settings make aggregates behave as Postgres's do: sum and avg of nothing
//  are NULL (aggregate_functions_null_for_empty), and an outer join leaves
//  NULLs (join_use_nulls).
// ============================================================================

let urls: string[] | null = null;
let preferred = 0;
const ready = new Map<string, Promise<void>>();
let seq = 0;

/** The replicas to try, in order. */
function chUrls(): string[] {
  if (!urls) urls = (process.env.CLICKHOUSE_URL ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return urls;
}
export function clickhouseConfigured(): boolean { return chUrls().length > 0; }

/** The database for the derived QoE tables (letters, digits and _ only). */
export function chDatabase(fallback = 'volt_qoe'): string {
  const raw = process.env.CLICKHOUSE_DATABASE || fallback;
  return raw.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 120) || 'volt_qoe';
}
const cluster = () => (process.env.CLICKHOUSE_CLUSTER ?? '').replace(/[^A-Za-z0-9_]/g, '');
const onCluster = () => (cluster() ? ` ON CLUSTER ${cluster()}` : '');

/** For tests: forget the URLs read from the environment and the schemas made. */
export function resetClickhouse(): void { urls = null; preferred = 0; ready.clear(); }

/** The statement-level settings every request carries. */
function settings(extra: Record<string, string | number> = {}): Record<string, string> {
  const ms = Math.max(1000, Number(process.env.CLICKHOUSE_QUERY_MS ?? process.env.ANALYTICS_QUERY_MS ?? 10_000));
  const s: Record<string, string | number> = {
    max_execution_time: Math.ceil(ms / 1000),
    aggregate_functions_null_for_empty: 1,
    join_use_nulls: 1,
    // `sum(stalls) AS stalls` beside `FILTER (WHERE stalls > 0)`: in Postgres the WHERE means the column
    prefer_column_name_to_alias: 1,
    date_time_input_format: 'best_effort',
    input_format_skip_unknown_fields: 1,
    input_format_null_as_default: 1,
    // a dashboard over 13 months reads month partitions; versions never cross months (the day is in the key)
    do_not_merge_across_partitions_select_final: 1,
    ...extra,
  };
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, String(v)]));
}

export class ClickHouseError extends Error { constructor(msg: string, public status = 0) { super(msg); } }

/**
 * Send one statement. A replica that refuses the connection, times out or
 * answers 502/503 is skipped and the next one tried; a SQL error is thrown
 * at once (it would fail the same way everywhere).
 */
async function send(sql: string, opts: { database?: string | null; extra?: Record<string, string | number>; body?: string } = {}): Promise<string> {
  const list = chUrls();
  if (!list.length) throw new ClickHouseError('CLICKHOUSE_URL is not set');
  // A statement given its own time limit (a bulk insert, OPTIMIZE) is waited for that long.
  const limitS = Number(opts.extra?.max_execution_time ?? 0);
  const timeout = Math.max(Math.max(1000, Number(process.env.CLICKHOUSE_QUERY_MS ?? process.env.ANALYTICS_QUERY_MS ?? 10_000)), limitS * 1000) + 5000;
  let last: unknown = null;
  for (let i = 0; i < list.length; i++) {
    const idx = (preferred + i) % list.length;
    const u = new URL(list[idx]);
    const headers: Record<string, string> = { 'content-type': 'text/plain; charset=utf-8' };
    if (u.username) {
      headers['X-ClickHouse-User'] = decodeURIComponent(u.username);
      headers['X-ClickHouse-Key'] = decodeURIComponent(u.password);
      u.username = ''; u.password = '';
    }
    const qs = new URLSearchParams(settings(opts.extra));
    if (opts.database) qs.set('database', opts.database);
    let res: Response;
    try {
      res = await fetch(`${u.origin}${u.pathname.replace(/\/$/, '')}/?${qs}`, {
        method: 'POST', headers, body: opts.body != null ? sql + '\n' + opts.body : sql, signal: AbortSignal.timeout(timeout),
      });
    } catch (e) { last = e; continue; } // not reachable: the next replica
    const text = await res.text();
    if (res.status === 502 || res.status === 503) { last = new ClickHouseError(text.slice(0, 500), res.status); continue; }
    if (!res.ok) throw new ClickHouseError(text.slice(0, 2000), res.status);
    preferred = idx;
    return text;
  }
  throw last instanceof Error ? last : new ClickHouseError('no ClickHouse replica answered');
}

/** Columns that hold JSON text in ClickHouse and objects in Postgres's jsonb. */
const JSON_TEXT = new Set(['plays', 'details', 'played']);

/** Make a value read from ClickHouse look like what node-postgres returns for the same column. */
function fromCh(type: string, v: any): any {
  if (v == null) return null;
  const t = type.replace(/^LowCardinality\((.*)\)$/, '$1').replace(/^Nullable\((.*)\)$/, '$1');
  if (t.startsWith('DateTime')) return new Date(String(v).replace(' ', 'T') + 'Z');
  if (t === 'Date' || t === 'Date32') { const [y, m, d] = String(v).split('-').map(Number); return new Date(y, m - 1, d); }
  return v;
}

/** Run a SELECT and get rows as node-postgres would give them. */
export async function chSelect<T = any>(sql: string, database: string): Promise<T[]> {
  await ensureSchema(database);
  const text = await send(sql.replace(/;\s*$/, '') + '\nFORMAT JSON', { database });
  const out = JSON.parse(text) as { meta: Array<{ name: string; type: string }>; data: any[] };
  const types = new Map(out.meta.map((m) => [m.name, m.type]));
  for (const row of out.data) {
    for (const [key, v] of Object.entries(row)) {
      const t = types.get(key) ?? '';
      let k = key;
      if (k.endsWith(ALIAS_MARK)) { delete row[k]; k = k.slice(0, -ALIAS_MARK.length); row[k] = v; }
      if (JSON_TEXT.has(k) && typeof v === 'string') { try { row[k] = JSON.parse(v); } catch { /* left as text */ } continue; }
      row[k] = fromCh(t, v);
    }
  }
  return out.data as T[];
}

/** A statement with no rows back (DELETE, DDL). */
export async function chExec(sql: string, database: string | null, extra?: Record<string, string | number>): Promise<void> {
  if (database) await ensureSchema(database);
  await send(sql, { database, extra });
}

/**
 * Insert rows as JSONEachRow, in chunks. Versioned tables get _v (the write
 * time in microseconds plus a counter, so a later write always wins).
 * `additive`: the rows add into what is there, so the block must never be
 * dropped as a duplicate of an identical earlier one (insert_deduplicate).
 */
export async function chInsert(table: string, rows: object[], database: string, opts: { versioned?: boolean; additive?: boolean } = {}): Promise<void> {
  if (!rows.length) return;
  await ensureSchema(database);
  for (let i = 0; i < rows.length; i += 5000) {
    const lines = rows.slice(i, i + 5000).map((r) => {
      const o: Record<string, unknown> = { ...r };
      for (const k of JSON_TEXT) if (k in o && typeof o[k] !== 'string') o[k] = JSON.stringify(o[k] ?? null);
      if (opts.versioned) o._v = Date.now() * 1000 + (seq++ % 1000);
      return JSON.stringify(o);
    });
    await send(`INSERT INTO ${table} FORMAT JSONEachRow`, { database, body: lines.join('\n'), extra: opts.additive ? { insert_deduplicate: 0 } : {} });
  }
}

// --------------------------------------------------------------- literals

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
function dt64(d: Date): string {
  return `toDateTime64('${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}', 3, 'UTC')`;
}

/** A value as a ClickHouse literal: strings escaped (backslash and quote), so nothing in a value can end the literal. */
export function lit(v: unknown): string {
  if (v == null) return 'NULL';
  if (v instanceof Date) return dt64(v);
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('not a finite number'); return String(v); }
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    if (!v.length) return 'CAST([] AS Array(String))';
    return '[' + v.map(lit).join(', ') + ']';
  }
  if (typeof v === 'object') return lit(JSON.stringify(v));
  const s = String(v);
  if (ISO.test(s)) return dt64(new Date(s));
  return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

// ------------------------------------------------------------ translation

/** Tables whose rows are versioned: read with FINAL so the newest write of a row counts once. */
const FINAL_TABLES = ['qoe_views', 'qoe_app_sessions', 'qoe_journeys', 'qoe_cdn_sessions'];
const VERSIONED = new Set(['qoe_views', 'qoe_app_sessions', 'qoe_journeys']);

/** The text inside the parentheses that open at `open` (s[open] === '('), and the index after the closing one. */
function balanced(s: string, open: number): { inner: string; end: number } {
  let depth = 0, q = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && s[i - 1] !== '\\') q = !q;
    if (q) continue;
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return { inner: s.slice(open + 1, i), end: i + 1 }; }
  }
  throw new Error('unbalanced parentheses in report SQL');
}

/**
 * percentile_disc(p) WITHIN GROUP (ORDER BY e) [FILTER (WHERE c)] as
 * Postgres computes it: the value at rank ceil(p x n) of the n non-null
 * values in order, NULL when there are none.
 */
function percentiles(sql: string): string {
  let out = '', i = 0;
  const re = /percentile_disc\(\s*([0-9.]+)\s*\)\s*WITHIN\s+GROUP\s*\(\s*ORDER\s+BY\s+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const start = m.index;
    const groupOpen = sql.lastIndexOf('(', m.index + m[0].length - 1);
    const { inner, end } = balanced(sql, groupOpen);
    const expr = inner.replace(/^\s*ORDER\s+BY\s+/i, '').trim();
    let after = end, cond = '';
    const f = /^\s*FILTER\s*\(\s*WHERE\s+/i.exec(sql.slice(end));
    if (f) {
      const fOpen = sql.indexOf('(', end);
      const b = balanced(sql, fOpen);
      cond = b.inner.replace(/^\s*WHERE\s+/i, '').trim();
      after = b.end;
    }
    const keep = `(${expr}) IS NOT NULL${cond ? ` AND (${cond})` : ''}`;
    const p = Number(m[1]);
    out += sql.slice(i, start) +
      `if(countIf(${keep}) = 0, NULL, arrayElement(arraySort(groupArrayIf(${expr}, ${keep})), toUInt64(greatest(1, ceil(${p} * countIf(${keep}))))))`;
    i = after;
    re.lastIndex = after;
  }
  return out + sql.slice(i);
}

let columnNames: Set<string> | null = null;
/** Every column name of the derived tables. */
function columns(): Set<string> {
  if (!columnNames) {
    columnNames = new Set();
    for (const t of tables()) for (const c of t.cols.split(',\n')) { const m = /^\s*([a-z_][a-z0-9_]*)\s/.exec(c); if (m && !/^INDEX$/i.test(m[1])) columnNames.add(m[1]); }
  }
  return columnNames;
}
const ALIAS_MARK = '__pga';

/**
 * Postgres and ClickHouse read a name that is both a column and an output
 * alias differently: `sum(playing_ms) AS playing_ms ... ORDER BY playing_ms`
 * sorts by the sum in Postgres (ORDER BY prefers output names) while
 * `FILTER (WHERE stalls > 0)` beside `sum(stalls) AS stalls` means the column
 * (only input columns exist there). ClickHouse picks one rule for all. So an
 * alias that is also a column is renamed, ORDER BY is pointed at the new name,
 * every other place keeps the column, and chSelect gives the rows their
 * Postgres names back.
 */
function aliases(sql: string): string {
  const cols = columns();
  const renamed = new Set<string>();
  let s = sql.replace(/\bAS\s+([a-z_][a-z0-9_]*)\b(?!\s*\()/gi, (m, name: string) => {
    if (!cols.has(name)) return m;
    renamed.add(name);
    return `AS ${name}${ALIAS_MARK}`;
  });
  if (!renamed.size) return s;
  s = s.replace(/\bORDER\s+BY\s+([\s\S]*?)(?=\bLIMIT\b|\)|$)/gi, (m, list: string) => {
    const fixed = list.replace(/(^|[^.\w])([a-z_][a-z0-9_]*)\b(?!\s*\()/gi, (mm, pre: string, name: string) => (renamed.has(name) ? `${pre}${name}${ALIAS_MARK}` : mm));
    return m.slice(0, m.length - list.length) + fixed;
  });
  return s;
}

/**
 * Postgres report SQL with $n parameters to ClickHouse SQL with literals.
 * Only the constructs the QoE queries use; anything else passes through and
 * ClickHouse says if it cannot run it (the check suites run every report on
 * both stores).
 */
export function toClickHouse(sql: string, params: unknown[] = []): string {
  let s = sql;
  // col = ANY($n) / ANY($n::text[])  ->  has([...], col)
  s = s.replace(/([A-Za-z_][\w.]*)\s*=\s*ANY\(\s*\$(\d+)(?:::text\[\])?\s*\)/g, (_m, col, n) => `has(${lit(params[Number(n) - 1] ?? [])}, ${col})`);
  // $n::date
  s = s.replace(/\$(\d+)::date\b/g, (_m, n) => `toDate(${lit(String(params[Number(n) - 1]).slice(0, 10))})`);
  // casts and Postgres spellings, before any value is put in the text
  s = s.replace(/'([^']*)'::jsonb/g, "'$1'");
  s = s.replace(/::(numeric|float8|double precision|bigint|int|text\[\]|text)\b/g, '');
  s = s.replace(/\bIS\s+TRUE\b/gi, '= true').replace(/\bIS\s+FALSE\b/gi, '= false');
  // jsonb_agg over sketch columns: the merge is done here (sumMap adds the bins,
  // as sketch.ts merge does), so a 13-month trend sends one sketch per bucket,
  // not every minute's; the caller still gets a list to merge.
  s = s.replace(/\bjsonb_agg\(\s*([a-z_]+)\s*\)/g, '[sumMap($1)]');
  // parameters, in one pass ($10 is read as 10, and a value is never read again)
  s = s.replace(/\$(\d+)/g, (_m, n) => lit(params[Number(n) - 1]));
  s = percentiles(s);
  s = aliases(s);
  // DELETE FROM t (no WHERE): ClickHouse wants one
  s = s.replace(/^\s*DELETE\s+FROM\s+(qoe_\w+)\s*$/i, 'DELETE FROM $1 WHERE 1');
  if (!/^\s*DELETE\b/i.test(s)) {
    const t = FINAL_TABLES.join('|');
    s = s.replace(new RegExp(`\\b(FROM|JOIN)\\s+(${t})\\b(?:\\s+(?:AS\\s+)?(?!(?:WHERE|GROUP|ORDER|LIMIT|LEFT|RIGHT|INNER|JOIN|ON|FINAL|UNION|HAVING|ARRAY|SAMPLE|PREWHERE)\\b)([A-Za-z_]\\w*))?`, 'g'),
      (_m, kw, table, alias) => `${kw} ${table}${alias ? ` AS ${alias}` : ''} FINAL`);
    s = s.replace(/SELECT\s+\*\s+FROM\s+(qoe_\w+)/g, (m, table) => (VERSIONED.has(table) ? `SELECT * EXCEPT (_v) FROM ${table}` : m));
  }
  return s;
}

// ------------------------------------------------------------------ schema

/** The derived tables, as ClickHouse sees them. Columns and nullability follow analyticsDb.ts. */
function tables(): Array<{ name: string; cols: string; engine: string; order: string; partition: string; extra?: string }> {
  const T = 'Nullable(String)', LC = 'LowCardinality(Nullable(String))', I = 'Nullable(Int32)', TS = "DateTime64(3, 'UTC')";
  const sumI = 'SimpleAggregateFunction(sum, Int64)', sumF = 'SimpleAggregateFunction(sum, Float64)', sk = 'SimpleAggregateFunction(sumMap, Map(String, Float64))';
  const views = [
    'account_id LowCardinality(String)', 'view_id String', 'day Date', 'def_version Int32', 'sid String', 'attempt Int32', `app_id ${T}`,
    `started_at ${TS}`, `ended_at ${TS}`, 'ended_by LowCardinality(String)', `content_id ${T}`, `stream_type ${LC}`,
    `app_name ${LC}`, `app_version ${LC}`, `sdk_version ${LC}`, `player_version ${LC}`, `device_model ${LC}`, `device_class ${LC}`,
    `os ${LC}`, `os_version ${LC}`, `browser ${LC}`, `browser_version ${LC}`, `codec ${LC}`, `cdn ${LC}`, `country ${LC}`, `region ${LC}`, `asn ${T}`, `network ${LC}`,
    'outcome LowCardinality(String)', `waited_ms ${I}`, `startup_ms ${I}`,
    `t_entitlement ${I}`, `t_manifest ${I}`, `t_drm ${I}`, `t_segment ${I}`, `t_decode ${I}`, `t_other ${I}`, `error_code ${LC}`, `error_step ${LC}`,
    'fatal_after_start Bool DEFAULT false', 'nonfatal_errors Int32 DEFAULT 0',
    'playing_ms Int64 DEFAULT 0', 'rebuffer_ms Int64 DEFAULT 0', 'stalls Int32 DEFAULT 0', `first_stall_ms ${I}`, 'seeks Int32 DEFAULT 0', 'seek_ms Int64 DEFAULT 0',
    'paused_ms Int64 DEFAULT 0', 'background_ms Int64 DEFAULT 0', 'bitrate_ms Int64 DEFAULT 0', 'bitrate_kbps_ms Int64 DEFAULT 0', 'below_top_ms Int64 DEFAULT 0',
    'switches Int32 DEFAULT 0', 'oscillations Int32 DEFAULT 0', `buffer_avg_ms ${I}`, `throughput_avg_kbps ${I}`, `dropped_frames ${I}`, `latency_avg_ms ${I}`,
    'exit_after_stall Bool DEFAULT false', 'exit_after_error Bool DEFAULT false',
    'events Int32 DEFAULT 0', 'sn_missing Int32 DEFAULT 0', 'no_sn Int32 DEFAULT 0', 'late_events Int32 DEFAULT 0', `clock_skew_ms ${I}`,
    'unknown_keys Map(String, Float64)',
    'decode_errors Int32 DEFAULT 0', 'hw_decode Nullable(Bool)', `key_system ${LC}`, 'licence_requests Int32 DEFAULT 0', 'licence_failures Int32 DEFAULT 0',
    'licence_ms Int64 DEFAULT 0', `licence_max_ms ${I}`, 'token_errors Int32 DEFAULT 0',
    `latency_first_ms ${I}`, `latency_last_ms ${I}`, `latency_min_ms ${I}`, `latency_max_ms ${I}`, 'rate_changes Int32 DEFAULT 0', 'catchup_ms Int64 DEFAULT 0', 'slowdown_ms Int64 DEFAULT 0',
    'ad_breaks Int32 DEFAULT 0', 'ad_breaks_ended Int32 DEFAULT 0', 'ad_ms Int64 DEFAULT 0', 'ad_playing_ms Int64 DEFAULT 0', 'ad_rebuffer_ms Int64 DEFAULT 0',
    'ad_stalls Int32 DEFAULT 0', 'ad_errors Int32 DEFAULT 0', 'ad_start_ms Int64 DEFAULT 0', 'ad_start_n Int32 DEFAULT 0', `ad_start_max_ms ${I}`,
    'ad_return_ms Int64 DEFAULT 0', 'ad_return_n Int32 DEFAULT 0', `ad_return_max_ms ${I}`, 'ads_started Int32 DEFAULT 0', 'ads_ended Int32 DEFAULT 0', 'left_in_ad Bool DEFAULT false',
    `journey_id ${T}`, `app_session_id ${T}`, `entry_point ${LC}`, `session_depth ${I}`,
    '_v UInt64',
    // engagement windows by start, the others by end; a timeline or the CDN join looks a sid up
    'INDEX ended_mm ended_at TYPE minmax GRANULARITY 1', 'INDEX started_mm started_at TYPE minmax GRANULARITY 1', 'INDEX sid_bf sid TYPE bloom_filter GRANULARITY 4',
  ];
  return [
    { name: 'qoe_views', cols: views.join(',\n  '), engine: 'ReplacingMergeTree(_v)', partition: 'toYYYYMM(day)', order: '(account_id, day, view_id)' },
    {
      name: 'qoe_minutes', engine: 'AggregatingMergeTree', partition: 'toYYYYMM(minute)', order: '(account_id, minute, content_id, stream_type, country, device_class, cdn)',
      cols: ['account_id LowCardinality(String)', `minute ${TS}`, 'content_id String', 'stream_type LowCardinality(String)', 'country LowCardinality(String)',
        'device_class LowCardinality(String)', 'cdn LowCardinality(String)', 'def_version SimpleAggregateFunction(max, Int32)',
        ...['attempts', 'starts', 'failures', 'fatal_after', 'stalls', 'playing_ms', 'rebuffer_ms', 'switches'].map((c) => `${c} ${sumI}`), `startup_sketch ${sk}`].join(',\n  '),
    },
    {
      name: 'qoe_collector_minutes', engine: 'AggregatingMergeTree', partition: 'toYYYYMM(minute)', order: '(account_id, minute)',
      cols: ['account_id LowCardinality(String)', `minute ${TS}`, `accepted ${sumI}`, `rejected ${sumI}`, `reasons ${sk}`].join(',\n  '),
    },
    {
      name: 'qoe_gate', engine: 'MergeTree', partition: 'toYYYYMM(at)', order: '(account_id, at)',
      cols: ['account_id LowCardinality(String)', `app_id ${T}`, `sid ${T}`, `at ${TS}`, 'method LowCardinality(String)', 'status Int32', `mode ${LC}`,
        'reason LowCardinality(String)', `layer ${LC}`, `rule_id ${T}`, `asset_id ${T}`, `asset_kind ${LC}`, `country ${LC}`, 'ms Int32',
        'INDEX sid_bf sid TYPE bloom_filter GRANULARITY 4'].join(',\n  '),
    },
    {
      name: 'qoe_app_sessions', engine: 'ReplacingMergeTree(_v)', partition: 'toYYYYMM(day)', order: '(account_id, day, asid)',
      cols: ['account_id LowCardinality(String)', 'asid String', 'day Date', `app_id ${T}`, `app_name ${LC}`, `app_version ${LC}`, `sdk_version ${LC}`, `launch ${LC}`, 'cold Nullable(Bool)',
        `os ${LC}`, `browser ${LC}`, `device_class ${LC}`, `country ${LC}`, `started_at ${TS}`, `ended_at ${TS}`, 'ended_by LowCardinality(String)',
        'screens Int32 DEFAULT 0', 'journeys Int32 DEFAULT 0', 'searches Int32 DEFAULT 0', 'background_ms Int64 DEFAULT 0',
        `browse_ms ${I}`, `detail_ms ${I}`, `play_ms ${I}`, `paywall_ms ${I}`, `purchase_ms ${I}`, 'purchase_ok Bool DEFAULT false',
        "plays String DEFAULT '[]'", "details String DEFAULT '{}'", "played String DEFAULT '[]'", '_v UInt64',
        'INDEX started_mm started_at TYPE minmax GRANULARITY 1'].join(',\n  '),
    },
    {
      name: 'qoe_journeys', engine: 'ReplacingMergeTree(_v)', partition: 'toYYYYMM(day)', order: '(account_id, day, journey_id)',
      cols: ['account_id LowCardinality(String)', 'journey_id String', 'asid String', 'day Date', `app_id ${T}`, `app_name ${LC}`, `app_version ${LC}`,
        `os ${LC}`, `browser ${LC}`, `device_class ${LC}`, `country ${LC}`, `started_at ${TS}`, 'entry LowCardinality(String)', `entry_detail ${T}`, `position ${I}`,
        `content_id ${T}`, 'depth Int32 DEFAULT 0', `since_open_ms ${I}`, `detail_ms ${I}`, `play_ms ${I}`, 'paywall Bool DEFAULT false', `purchase ${LC}`,
        "plays String DEFAULT '[]'", '_v UInt64', 'INDEX started_mm started_at TYPE minmax GRANULARITY 1', 'INDEX asid_bf asid TYPE bloom_filter GRANULARITY 4'].join(',\n  '),
    },
    {
      name: 'qoe_cdn_minutes', engine: 'AggregatingMergeTree', partition: 'toYYYYMM(minute)', order: '(account_id, minute, content_id, ot, country, result)',
      cols: ['account_id LowCardinality(String)', `minute ${TS}`, 'content_id String', 'ot LowCardinality(String)', 'country LowCardinality(String)', 'result LowCardinality(String)',
        `lines ${sumI}`, ...['requests', 'errors_4xx', 'errors_5xx', 'bytes', 'shield_hits', 'starved', 'with_cmcd', 'with_sid'].map((c) => `${c} ${sumF}`),
        ...['ttfb_sketch', 'time_sketch', 'origin_sketch', 'kbps_sketch'].map((c) => `${c} ${sk}`), `joined ${sumI}`, `last_mile_sketch ${sk}`].join(',\n  '),
    },
    {
      name: 'qoe_cdn_sessions', engine: 'AggregatingMergeTree', partition: 'toYYYYMM(day)', order: '(account_id, day, skey)',
      cols: ['account_id LowCardinality(String)', 'day Date', 'skey String', 'sid SimpleAggregateFunction(any, Nullable(String))', 'content_id SimpleAggregateFunction(any, Nullable(String))',
        `first_at SimpleAggregateFunction(min, ${TS})`, `last_at SimpleAggregateFunction(max, ${TS})`, `lines ${sumI}`, `requests ${sumF}`,
        'country SimpleAggregateFunction(any, Nullable(String))', 'device_class SimpleAggregateFunction(any, Nullable(String))'].join(',\n  '),
    },
  ];
}

/** The engine on a cluster: the replicated form (paths from the servers' default_replica_path and macros). */
function engineFor(engine: string): string {
  if (!cluster()) return engine;
  return engine.replace(/^(\w*MergeTree)/, 'Replicated$1');
}

/** The DDL, for the docs and for tests. */
export function schemaSql(database: string): string[] {
  const out = [`CREATE DATABASE IF NOT EXISTS ${database}${onCluster()}`];
  for (const t of tables()) {
    out.push(`CREATE TABLE IF NOT EXISTS ${database}.${t.name}${onCluster()} (\n  ${t.cols}\n) ENGINE = ${engineFor(t.engine)}\nPARTITION BY ${t.partition}\nORDER BY ${t.order}`);
  }
  return out;
}

/** Make the database and tables once per process (IF NOT EXISTS, so several processes may race). */
export async function ensureSchema(database: string): Promise<void> {
  let p = ready.get(database);
  if (!p) {
    p = (async () => { for (const stmt of schemaSql(database)) await send(stmt, { database: null }); })();
    p.catch(() => ready.delete(database));
    ready.set(database, p);
  }
  return p;
}

/** Each replica that answers ping, for the health panel and the drill (scripts/clickhouse-drill.ts). */
export async function replicaHealth(): Promise<Array<{ url: string; ok: boolean; error?: string }>> {
  const out: Array<{ url: string; ok: boolean; error?: string }> = [];
  for (const raw of chUrls()) {
    const u = new URL(raw); u.username = ''; u.password = '';
    try { const r = await fetch(`${u.origin}/ping`, { signal: AbortSignal.timeout(3000) }); out.push({ url: u.origin, ok: r.ok }); }
    catch (e) { out.push({ url: u.origin, ok: false, error: (e as Error).message }); }
  }
  return out;
}
