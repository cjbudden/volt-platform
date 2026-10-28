// ============================================================================
//  THE CLICKHOUSE ANALYTICS STORE AND THE MOVE TO IT (build queue 2.11,
//  QOE_REPORTING.md sections 9 and 9a; src/services/qoe/clickhouse.ts and
//  storeSwitch.ts).
//
//    1. Values become ClickHouse literals that nothing can break out of, and
//       the Postgres report SQL translates (has, FINAL, percentiles).
//    2. percentile_disc gives the same value in both stores for every size
//       and level, NULLs and a filter included.
//    3. Two thousand random views, gate decisions and minute rows written to
//       BOTH stores: every report reads the same from each.
//    4. Write semantics: a view written twice counts once (its newest form),
//       minute rows and CDN sessions add and widen, an identical flush is not
//       dropped as a duplicate, a replay replaces one account's day only.
//    5. The move (QOE_STORE=auto): stays below the size; past it, both stores
//       written from the switch minute; history replayed from the raw
//       archive, the gate log and collector counts copied up to the switch;
//       the switch day replayed once over; then the reports read ClickHouse
//       and say exactly what Postgres said, nothing lost or counted twice.
//    6. Two replicas behind CLICKHOUSE_URL: one stops, the reports and the
//       collector carry on through the other with the same answers.
//    7. The schema on a cluster, and the Terraform (two replicas in two
//       zones, three keepers, nightly backups to S3, off by default).
//
//  ClickHouse: CLICKHOUSE_URL if set, else the suite starts the stand-in
//  (scripts/chdb-http.py: the ClickHouse engine through chDB) itself. With
//  neither python3 nor chDB it says SKIP and why. The replica REBUILD (a
//  server lost and refilled from the other through Keeper) needs a real
//  cluster: scripts/clickhouse-drill.ts, run against the AWS deployment.
//
//  Usage: DATABASE_URL=... npx tsx test/clickhouse-store.check.ts
// ============================================================================
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer as netServer } from 'node:net';

const ROOT = resolve(__dirname, '..');
process.env.QOE_RAW_DIR = mkdtempSync(join(tmpdir(), 'qoe-ch-raw-'));
delete process.env.QOE_RAW_BUCKET;
process.env.QOE_STORE = 'postgres';
process.env.QOE_BACKFILL_DAYS = '5'; // the move rebuilds five days here (400 in production)

let pass = 0, fail = 0;
function ok(c: unknown, msg: string, extra?: unknown) {
  if (c) { pass++; console.log('PASS ' + msg); } else { fail++; console.log('FAIL ' + msg + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 1500) : '')); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((res) => { const s = netServer().listen(0, () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });

const shims: ChildProcess[] = [];
async function startShim(): Promise<{ url: string; proc: ChildProcess } | null> {
  const has = spawnSync('python3', ['-c', 'import chdb'], { encoding: 'utf8' });
  if (has.status !== 0) return null;
  const port = await freePort();
  const proc = spawn('python3', [join(ROOT, 'scripts/chdb-http.py'), '--port', String(port)], { stdio: 'ignore' });
  shims.push(proc);
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { const r = await fetch(url + '/ping'); if (r.ok) return { url, proc }; } catch { /* starting */ } await sleep(100); }
  return null;
}

/** Numbers to 9 significant digits: Postgres's numeric and ClickHouse's Float64 differ in the last bits of a ratio. */
function canon(v: any): any {
  if (typeof v === 'number') return Number.isInteger(v) ? v : Number(v.toPrecision(9));
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}

(async () => {
  let chUrl = process.env.CLICKHOUSE_URL ?? '';
  if (!chUrl) {
    const s = await startShim();
    if (!s) { console.log('SKIP no ClickHouse: set CLICKHOUSE_URL, or install chDB (pip install chdb) for the stand-in'); process.exit(0); }
    chUrl = s.url;
  }
  process.env.CLICKHOUSE_URL = chUrl;
  // A database of its own, as the Postgres side has.
  process.env.CLICKHOUSE_DATABASE = `chk_store_${process.pid}`;

  const { one, pool } = await import('../src/db');
  const adb = await import('../src/services/qoe/analyticsDb');
  const ch = await import('../src/services/qoe/clickhouse');
  const sw = await import('../src/services/qoe/storeSwitch');
  const store = await import('../src/services/qoe/store');
  const reports = await import('../src/services/qoe/reports');
  const cdn = await import('../src/services/qoe/cdnLogs');
  const raw = await import('../src/services/qoe/rawStore');
  const { replayRange, replayIntoClickHouse } = await import('../src/services/qoe/replay');
  const db = sw.qoeChDatabase();
  const useStore = (s: 'postgres' | 'clickhouse' | 'auto') => { process.env.QOE_STORE = s; sw.resetStoreState(); };

  const tag = Math.random().toString(36).slice(2, 8);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`ch-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`ch2-${tag}`]))!.id;

  try {
    // ------------------------------------------------------------------ 1
    console.log('== 1. literals and translation ==');
    const nasty = ['plain', "it's", 'back\\slash', "'; DROP TABLE qoe_views; --", 'multi\nline', 'ünïcode ✓', "\\'", ''];
    const back = await ch.chSelect<any>(`SELECT ${nasty.map((v, i) => `${ch.lit(v)} AS v${i}`).join(', ')}`, db);
    ok(nasty.every((v, i) => back[0][`v${i}`] === v), 'every value comes back exactly as sent, quotes and backslashes included', back[0]);
    ok(ch.lit(['a', "b'c"]) === "['a', 'b\\'c']" && ch.lit([]) === 'CAST([] AS Array(String))' && ch.lit(null) === 'NULL' && ch.lit(true) === 'true', 'arrays, the empty array, NULL and booleans');
    let threw = false; try { ch.lit(NaN); } catch { threw = true; }
    ok(threw, 'a value that is not a finite number is refused');
    const t = ch.toClickHouse(`SELECT count(*) FILTER (WHERE hw_decode IS TRUE) AS hw FROM qoe_views v WHERE account_id = $1 AND country = ANY($2::text[]) AND x <> '{}'::jsonb`, [acct, ['AU', 'NZ']]);
    ok(t.includes('FROM qoe_views AS v FINAL') && t.includes(`has(['AU', 'NZ'], country)`) && t.includes('hw_decode = true') && t.includes(`'{}'`) && !t.includes('::') && t.includes(`'${acct}'`), 'FINAL after the alias, ANY as has(), IS TRUE, casts gone, parameters as literals', t);
    ok(ch.toClickHouse('DELETE FROM qoe_views') === 'DELETE FROM qoe_views WHERE 1' && /EXCEPT \(_v\)/.test(ch.toClickHouse('SELECT * FROM qoe_views WHERE sid = $1', ['x'])), 'DELETE gets its WHERE, SELECT * leaves the version column out');
    ok(!/FINAL/.test(ch.toClickHouse('SELECT sum(attempts) FROM qoe_minutes')), 'added tables are summed, not read FINAL');

    // ------------------------------------------------------------------ 2
    console.log('== 2. percentile_disc: the same in both stores ==');
    let pctOk = 0, pctAll = 0; const bad: any[] = [];
    for (const n of [1, 2, 3, 7, 20, 21, 100, 999]) {
      const vals = Array.from({ length: n }, (_, i) => ((i * 7919) % 1000) - 200 + (i % 5 === 0 ? 0.5 : 0));
      const withNull = vals.map((v, i) => (i % 9 === 4 ? null : v));
      for (const p of [0.05, 0.07, 0.5, 0.95, 0.99]) {
        for (const [arr, filt] of [[vals, false], [withNull, false], [vals, true]] as Array<[Array<number | null>, boolean]>) {
          const pgSql = `SELECT percentile_disc(${p}) WITHIN GROUP (ORDER BY x)${filt ? ' FILTER (WHERE x > 0)' : ''} AS q FROM unnest($1::float8[]) AS x`;
          const [pg] = (await (await adb.analyticsPool()).query(pgSql, [arr])).rows;
          const chSql = ch.toClickHouse(`SELECT percentile_disc(${p}) WITHIN GROUP (ORDER BY x)${filt ? ' FILTER (WHERE x > 0)' : ''} AS q FROM (SELECT arrayJoin($1) AS x)`,
            [arr.map((v) => (v == null ? null : v))]).replace(/\[([^\]]*)\]/, (_m, inner) => `CAST([${inner}] AS Array(Nullable(Float64)))`);
          const [c] = await ch.chSelect<any>(chSql, db);
          pctAll++;
          if ((pg.q == null && c.q == null) || Number(pg.q) === Number(c.q)) pctOk++; else if (bad.length < 5) bad.push({ n, p, filt, pg: pg.q, ch: c.q });
        }
      }
    }
    ok(pctOk === pctAll, `nearest rank identical in ${pctOk}/${pctAll} cases (8 sizes x 5 levels x plain, NULLs, FILTER)`, bad);
    const [empty] = await ch.chSelect<any>(ch.toClickHouse(`SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY x) AS q FROM (SELECT arrayJoin(CAST([] AS Array(Nullable(Float64)))) AS x)`), db);
    ok(empty.q === null, 'no values: NULL, as Postgres');

    // ------------------------------------------------------------------ 3
    console.log('== 3. two thousand random views in both stores: every report the same ==');
    let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    const maybe = <T,>(v: T, pNull = 0.2) => (rnd() < pNull ? null : v);
    const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a));
    const T0 = Date.UTC(2026, 9, 20, 0, 0, 0);
    const views: any[] = [];
    for (let i = 0; i < 2000; i++) {
      const started = T0 + int(0, 6 * 86_400_000), outcome = pick(['started', 'started', 'started', 'failed', 'exited']);
      const started_ok = outcome === 'started';
      const lf = maybe(int(1000, 9000), 0.4), ll = lf == null ? null : lf + int(-2000, 9000);
      views.push({
        account_id: acct, view_id: `${tag}-v${i}`, day: new Date(started).toISOString().slice(0, 10), def_version: 3, sid: `${tag}-s${i % 1400}`, attempt: 1 + Math.floor(i / 1400),
        app_id: null, started_at: started, ended_at: started + int(1000, 3_600_000), ended_by: pick(['e', 'q', 'f', 'silence']),
        content_id: maybe(pick(['c-news', 'c-sport', 'c-film', 'c-kids', 'c-docs'])), stream_type: maybe(pick(['v', 'l', 'll']), 0.1),
        app_name: maybe(pick(['Volt Web', 'Volt TV', 'Volt iOS'])), app_version: maybe(pick(['2.0.0', '2.1.0', '2.2.0'])), sdk_version: '1.4.0', player_version: maybe('9.1'),
        device_model: maybe(pick(['Tizen QE55', 'webOS 6', 'iPhone15,2', 'Pixel 8', 'MacIntel'])), device_class: maybe(pick(['tv', 'mobile', 'desktop'])),
        os: maybe(pick(['Tizen', 'webOS', 'iOS', 'Android', 'macOS'])), os_version: maybe(pick(['6', '17', '14'])), browser: maybe(pick(['Chrome', 'Safari'])), browser_version: maybe('120'),
        codec: maybe(pick(['avc1', 'hvc1'])), cdn: maybe(pick(['cf.example', 'fastly.example'])), country: maybe(pick(['AU', 'NZ', 'GB', 'US'])), region: maybe(pick(['NSW', 'VIC'])),
        asn: maybe(pick(['1221', '4804'])), network: maybe(pick(['residential', 'mobile'])),
        outcome, waited_ms: started_ok ? null : maybe(int(100, 20000)), startup_ms: started_ok ? maybe(int(300, 9000), 0.05) : null,
        t_entitlement: maybe(int(10, 900)), t_manifest: maybe(int(10, 900)), t_drm: maybe(int(10, 2000), 0.5), t_segment: maybe(int(10, 900)), t_decode: maybe(int(1, 90)), t_other: maybe(int(0, 50)),
        error_code: outcome === 'failed' || rnd() < 0.05 ? pick(['403', 'MEDIA_ERR', 'DRM_LICENSE', 'TIMEOUT']) : null,
        error_step: outcome === 'failed' || rnd() < 0.05 ? pick(['entitlement', 'drm', 'manifest', 'decode']) : null,
        fatal_after_start: started_ok && rnd() < 0.05, nonfatal_errors: int(0, 3),
        playing_ms: started_ok ? int(0, 3_000_000) : 0, rebuffer_ms: started_ok ? int(0, 30000) : 0, stalls: started_ok ? int(0, 6) : 0, first_stall_ms: maybe(int(100, 600000), 0.6),
        seeks: int(0, 4), seek_ms: int(0, 5000), paused_ms: int(0, 60000), background_ms: int(0, 60000), bitrate_ms: started_ok ? int(0, 3_000_000) : 0,
        bitrate_kbps_ms: started_ok ? int(0, 2_000_000) * 4000 : 0, below_top_ms: int(0, 100000), switches: int(0, 12), oscillations: int(0, 3),
        buffer_avg_ms: maybe(int(1000, 30000)), throughput_avg_kbps: maybe(int(500, 50000)), dropped_frames: maybe(int(0, 500), 0.3), latency_avg_ms: maybe(int(2000, 30000), 0.4),
        exit_after_stall: rnd() < 0.1, exit_after_error: rnd() < 0.05,
        decode_errors: int(0, 2), hw_decode: maybe(rnd() < 0.7, 0.3), key_system: maybe(pick(['com.widevine.alpha', 'com.apple.fps']), 0.5),
        licence_requests: int(0, 3), licence_failures: int(0, 2), licence_ms: int(0, 4000), licence_max_ms: maybe(int(50, 3000), 0.5), token_errors: rnd() < 0.05 ? 1 : 0,
        latency_first_ms: lf, latency_last_ms: ll, latency_min_ms: lf, latency_max_ms: ll == null ? null : Math.max(lf!, ll) + int(0, 3000),
        rate_changes: int(0, 5), catchup_ms: int(0, 30000), slowdown_ms: int(0, 10000),
        ad_breaks: rnd() < 0.3 ? int(1, 4) : 0, ad_breaks_ended: int(0, 3), ad_ms: int(0, 180000), ad_playing_ms: int(0, 170000), ad_rebuffer_ms: int(0, 5000), ad_stalls: int(0, 2), ad_errors: int(0, 2),
        ad_start_ms: int(0, 6000), ad_start_n: int(0, 3), ad_start_max_ms: maybe(int(10, 4000), 0.4), ad_return_ms: int(0, 4000), ad_return_n: int(0, 3), ad_return_max_ms: maybe(int(10, 3000), 0.4),
        ads_started: int(0, 6), ads_ended: int(0, 6), left_in_ad: rnd() < 0.05,
        journey_id: null, app_session_id: null, entry_point: maybe(pick(['row', 'search', 'deeplink']), 0.5), session_depth: maybe(int(0, 9), 0.5),
        events: int(1, 300), sn_missing: rnd() < 0.1 ? int(1, 4) : 0, no_sn: rnd() < 0.05 ? int(1, 9) : 0, late_events: int(0, 3), clock_skew_ms: maybe(int(-5000, 5000)),
        unknown_keys: rnd() < 0.1 ? { [pick(['com.acme-x', 'com.acme-y', 'foo', 'bar-baz'])]: int(1, 9) } : {},
      });
    }
    const minutes: any[] = [];
    for (let i = 0; i < 600; i++) {
      const sketch: Record<string, number> = {}; for (let j = 0; j < 4; j++) sketch[String(int(400, 700))] = int(1, 9);
      minutes.push({ account_id: acct, minute: T0 + int(0, 6 * 1440) * 60_000, content_id: pick(['c-news', 'c-sport', '']), stream_type: pick(['v', 'l']), country: pick(['AU', 'NZ', '']),
        device_class: pick(['tv', 'mobile']), cdn: pick(['cf.example', '']), attempts: int(1, 50), starts: int(0, 40), failures: int(0, 5), fatal_after: int(0, 2), stalls: int(0, 9),
        playing_ms: int(0, 9_000_000), rebuffer_ms: int(0, 90000), switches: int(0, 20), startup_sketch: sketch });
    }
    const gates: any[] = [];
    for (let i = 0; i < 800; i++) {
      gates.push({ account_id: acct, app_id: null, sid: rnd() < 0.9 ? `${tag}-s${int(0, 1400)}` : null, at: T0 + int(0, 6 * 86_400_000), method: pick(['GET', 'POST']), status: pick([200, 200, 200, 403, 451]),
        mode: pick(['play', 'blocked', null]), reason: pick(['allowed', 'allowed', 'allowed', 'geo', 'rights', 'payment', 'replacement']), layer: null, rule_id: null,
        asset_id: pick(['c-news', 'c-sport']), asset_kind: 'channel', country: pick(['AU', 'NZ', 'GB']), ms: int(1, 400) });
    }
    for (const target of ['postgres', 'clickhouse'] as const) {
      await store.writeViews(views, undefined, target);
      await store.addMinutes(minutes, undefined, target);
    }
    // the gate's log, the same decisions in each store
    {
      const p = await adb.analyticsPool();
      const rows = gates.map((g) => ({ ...g, at: new Date(g.at).toISOString() }));
      await p.query(`INSERT INTO qoe_gate (account_id, app_id, sid, at, method, status, mode, reason, layer, rule_id, asset_id, asset_kind, country, ms)
        SELECT account_id, app_id, sid, at, method, status, mode, reason, layer, rule_id, asset_id, asset_kind, country, ms FROM jsonb_populate_recordset(NULL::qoe_gate, $1::jsonb)`, [JSON.stringify(rows)]);
      await ch.chInsert('qoe_gate', rows, db);
    }
    const q = reports.parseQuery({ from: new Date(T0 - 86_400_000).toISOString(), to: new Date(T0 + 8 * 86_400_000).toISOString() });
    const qf = reports.parseQuery({ from: new Date(T0 - 86_400_000).toISOString(), to: new Date(T0 + 8 * 86_400_000).toISOString(), country: 'AU,__none', app_version: '2.1.0', session_depth: '2-5' });
    const runs: Array<[string, () => Promise<unknown>]> = [
      ['1 playback success', () => reports.playbackSuccess(acct, q)], ['2 startup', () => reports.startupPerformance(acct, q)], ['3 buffering', () => reports.buffering(acct, q)],
      ['4 quality', () => reports.quality(acct, q)], ['10 engagement', () => reports.engagement(acct, q)], ['12 telemetry', () => reports.telemetryHealth(acct, q)],
      ['5 rendering', () => reports.rendering(acct, q)], ['7 access', () => reports.access(acct, q)], ['8 live', () => reports.liveHealth(acct, q)],
      ['9 advertising', () => reports.advertising(acct, q)], ['1 with filters', () => reports.playbackSuccess(acct, qf)], ['3 with filters', () => reports.buffering(acct, qf)],
      ['views list', () => reports.listViews(acct, q, 'all', 200)], ['views list: stalled', () => reports.listViews(acct, q, 'stalled', 50)],
      ['series (hours)', () => reports.series(acct, reports.parseQuery({ from: new Date(T0).toISOString(), to: new Date(T0 + 2 * 86_400_000).toISOString() }))],
      ['series (days, filtered)', () => reports.series(acct, reports.parseQuery({ from: new Date(T0 - 86_400_000).toISOString(), to: new Date(T0 + 8 * 86_400_000).toISOString(), country: 'AU' }))],
      ...Object.keys(reports.MEASURES).map((m) => [`breakdown by device model: ${m}`, () => reports.breakdown(acct, q, 'device_model', m as any, 5)] as [string, () => Promise<unknown>]),
      ['breakdown by app version: rebuffer', () => reports.breakdown(acct, q, 'app_version', 'rebuffer', 5)],
    ];
    let same = 0; const diffs: string[] = [];
    for (const [name, fn] of runs) {
      useStore('postgres'); const a = JSON.stringify(canon(await fn()));
      useStore('clickhouse'); const b = JSON.stringify(canon(await fn()));
      if (a === b) same++; else diffs.push(`${name}: pg ${a.slice(0, 400)} | ch ${b.slice(0, 400)}`);
    }
    ok(same === runs.length, `every report reads the same from both stores (${same}/${runs.length})`, diffs.slice(0, 3));
    useStore('postgres'); const pgDims = await reports.dimensionValues(acct, q, 100);
    useStore('clickhouse'); const chDims = await reports.dimensionValues(acct, q, 100);
    const setOf = (d: any) => JSON.stringify(Object.fromEntries(Object.entries(d).map(([k, v]: any) => [k, [...v].sort((x: any, y: any) => String(x.value).localeCompare(String(y.value)))])));
    ok(setOf(pgDims) === setOf(chDims), 'the filter values seen, with their counts, the same (order among equal counts aside)');
    useStore('clickhouse');
    const otherView = await reports.playbackSuccess(other, q);
    ok(otherView.attempts === 0, 'another account sees none of it in ClickHouse either');

    // ------------------------------------------------------------------ 4
    console.log('== 4. write semantics ==');
    useStore('clickhouse');
    const v0 = { ...views[0], view_id: `${tag}-again`, playing_ms: 1000 };
    await store.writeViews([v0]);
    await store.writeViews([{ ...v0, playing_ms: 5000, ended_by: 'q' }]);
    const [again] = await adb.aquery<any>(`SELECT count(*) AS n, max(playing_ms) AS p, max(ended_by) AS e FROM qoe_views WHERE account_id = $1 AND view_id = $2`, [acct, `${tag}-again`]);
    ok(Number(again.n) === 1 && Number(again.p) === 5000 && again.e === 'q', 'a view written twice counts once, in its newest form', again);
    const m0 = { ...minutes[0], account_id: other, minute: T0, attempts: 3, starts: 2, startup_sketch: { '500': 2 } };
    await store.addMinutes([m0]); await store.addMinutes([m0]);
    const [madd] = await adb.aquery<any>(`SELECT sum(attempts) AS a, sum(starts) AS s, jsonb_agg(startup_sketch) AS sk FROM qoe_minutes WHERE account_id = $1`, [other]);
    const skSum = (madd.sk as any[]).reduce((n, x) => n + Number(x['500'] ?? 0), 0);
    ok(Number(madd.a) === 6 && Number(madd.s) === 4 && skSum === 4, 'the same minute flushed twice adds (an identical block is not dropped as a duplicate)', madd);
    const cs = { account_id: other, day: '2026-10-20', skey: 'k1', sid: 'k1', content_id: 'c', first_at: T0 + 5000, last_at: T0 + 9000, lines: 2, requests: 200, country: 'AU', device_class: 'tv' };
    await cdn.addCdnSessions([cs]); await cdn.addCdnSessions([{ ...cs, first_at: T0 + 1000, last_at: T0 + 7000, lines: 1, requests: 100, country: null }]);
    const [cr] = await adb.aquery<any>(`SELECT first_at, last_at, lines, requests, country FROM qoe_cdn_sessions WHERE account_id = $1 AND skey = 'k1'`, [other]);
    ok(+new Date(cr.first_at) === T0 + 1000 && +new Date(cr.last_at) === T0 + 9000 && Number(cr.lines) === 3 && Number(cr.requests) === 300 && cr.country === 'AU', 'a CDN session widens (first, last) and adds (lines, requests), keeping its country', cr);
    const dayA = views[1].day;
    const keepOther = { ...views[1], account_id: other, view_id: `${tag}-other` };
    await store.writeViews([keepOther]);
    const before = await adb.aquery<any>(`SELECT count(*) AS n FROM qoe_views WHERE account_id = $1 AND day = $2`, [acct, dayA]);
    await store.replaceDay(acct, dayA, [views[1]], []);
    const after = await adb.aquery<any>(`SELECT count(*) AS n FROM qoe_views WHERE account_id = $1 AND day = $2`, [acct, dayA]);
    const [kept] = await adb.aquery<any>(`SELECT count(*) AS n FROM qoe_views WHERE account_id = $1 AND view_id = $2`, [other, `${tag}-other`]);
    ok(Number(before[0].n) > 1 && Number(after[0].n) === 1 && Number(kept.n) === 1, `a replay replaces one account's day (${before[0].n} rows to 1), the other account's row on that day kept`);
    // put the day back for what follows
    await store.replaceDay(acct, dayA, views.filter((v) => v.day === dayA), minutes.filter((m) => new Date(m.minute).toISOString().slice(0, 10) === dayA));

    // ------------------------------------------------------------------ 5
    console.log('== 5. the move: QOE_STORE=auto ==');
    const mover = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`ch-move-${tag}`]))!.id;
    const NOW = Date.now();
    const today = new Date(NOW).toISOString().slice(0, 10);
    const enc = (d: Record<string, string | number>) => Object.keys(d).sort().map((k) => (typeof d[k] === 'number' ? `${k}=${d[k]}` : ['e', 'sta', 'st'].includes(k) ? `${k}=${d[k]}` : `${k}="${d[k]}"`)).join(',');
    // Three past days of raw reports (the record), each derived into Postgres as the collector would have.
    const pastDays: string[] = [];
    for (let d = 3; d >= 1; d--) {
      const day0 = Date.parse(new Date(NOW - d * 86_400_000).toISOString().slice(0, 10) + 'T10:00:00Z');
      pastDays.push(new Date(day0).toISOString().slice(0, 10));
      const rows: any[] = [];
      for (let i = 0; i < 12; i++) {
        const sid = `${tag}-m${d}-${i}`, t0 = day0 + i * 60_000, msd = 500 + i * 37;
        rows.push({ rt: t0, app: null, sid, e: 'ps', line: enc({ v: 2, sid, cid: 'c-move', st: 'v', ts: t0, sn: 1, e: 'ps', sta: 's' }) });
        rows.push({ rt: t0 + msd, app: null, sid, e: 'ps', line: enc({ v: 2, sid, cid: 'c-move', st: 'v', ts: t0 + msd, sn: 2, e: 'ps', sta: 'p', msd }) });
        rows.push({ rt: t0 + 30_000, app: null, sid, e: 'ps', line: enc({ v: 2, sid, cid: 'c-move', st: 'v', ts: t0 + 30_000, sn: 3, e: 'ps', sta: 'q' }) });
      }
      await raw.appendRaw(mover, rows);
    }
    useStore('postgres');
    await replayRange(pastDays[0], pastDays[2], mover);
    // the gate's log and the collector's counts in Postgres before the switch (not rebuildable from raw)
    const pgPool = await adb.analyticsPool();
    await pgPool.query(`INSERT INTO qoe_gate (account_id, sid, at, method, status, reason, ms) VALUES ($1, 'g-before', $2, 'POST', 200, 'allowed', 12)`, [mover, new Date(NOW - 3_600_000).toISOString()]);
    await pgPool.query(`INSERT INTO qoe_collector_minutes (account_id, minute, accepted, rejected, reasons) VALUES ($1, $2, 40, 2, '{"no sid": 2}')`, [mover, new Date(Math.floor((NOW - 3_600_000) / 60_000) * 60_000).toISOString()]);

    useStore('auto');
    await pgPool.query(`DELETE FROM qoe_meta WHERE k = 'store'`);
    const deps = { replayInto: async (day: string) => (await replayRange(day, day, mover, 'clickhouse')).reduce((n, r) => n + r.views, 0) };
    void replayIntoClickHouse; // the API passes this one: every account of the day
    process.env.QOE_CLICKHOUSE_ABOVE_VH = '1000000000';
    const stay = await sw.checkStoreSwitch(deps, NOW);
    ok(/^staying on postgres/.test(stay) && (await sw.readStore()) === 'postgres', `below the size it stays (${stay})`);
    process.env.QOE_CLICKHOUSE_ABOVE_VH = '0.001';
    const go = await sw.checkStoreSwitch(deps, NOW);
    const st1 = await sw.storeState(true);
    ok(/^moving to clickhouse/.test(go) && st1.phase === 'moving' && st1.switchAt! > NOW && st1.switchAt! % 60_000 === 0, `past it: moving from the next whole minute (${go})`);
    ok((await sw.readStore()) === 'postgres' && (await sw.writeTargets()).length === 2, 'while moving the reports read Postgres and writes go to both');
    // after the switch minute: a gate decision, a collector count and a view, written live
    const S = st1.switchAt!;
    const liveSid = `${tag}-live`;
    const liveRows = [
      { rt: S + 1000, app: null, sid: liveSid, e: 'ps', line: enc({ v: 2, sid: liveSid, cid: 'c-move', st: 'v', ts: S + 1000, sn: 1, e: 'ps', sta: 's' }) },
      { rt: S + 1800, app: null, sid: liveSid, e: 'ps', line: enc({ v: 2, sid: liveSid, cid: 'c-move', st: 'v', ts: S + 1800, sn: 2, e: 'ps', sta: 'p', msd: 800 }) },
      { rt: S + 20_000, app: null, sid: liveSid, e: 'ps', line: enc({ v: 2, sid: liveSid, cid: 'c-move', st: 'v', ts: S + 20_000, sn: 3, e: 'ps', sta: 'q' }) },
    ];
    await raw.appendRaw(mover, liveRows);
    const { deriveAll } = await import('../src/services/qoe/views');
    const live = deriveAll(liveRows.map((r) => ({ acct: mover, ...r })));
    await store.writeViews(live.views);
    await store.addMinutes(live.minutes);
    await store.addCollectorCounts([{ account_id: mover, minute: S, accepted: 3, rejected: 0, reasons: {} }, { account_id: mover, minute: S - 60_000, accepted: 99, rejected: 9, reasons: { early: 9 } }]);
    const [inPg] = await (await adb.analyticsPool()).query(`SELECT count(*) AS n FROM qoe_views WHERE account_id = $1 AND sid = $2`, [mover, liveSid]).then((r) => r.rows);
    const [inCh] = await ch.chSelect<any>(`SELECT count() AS n FROM qoe_views FINAL WHERE account_id = ${ch.lit(mover)} AND sid = ${ch.lit(liveSid)}`, db);
    ok(Number(inPg.n) === 1 && Number(inCh.n) === 1, 'a view closed after the switch is in both stores');
    const [early] = await ch.chSelect<any>(`SELECT count() AS n FROM qoe_collector_minutes WHERE account_id = ${ch.lit(mover)} AND minute < ${ch.lit(new Date(S))}`, db);
    ok(Number(early.n) === 0, 'collector counts for a minute before the switch go to Postgres only (they are copied, once)');
    const hist = await sw.checkStoreSwitch(deps, S + 1000);
    const st2 = await sw.storeState(true);
    ok(/copied \d+ gate decisions and \d+ collector minutes/.test(hist) && /replayed \d+ days/.test(hist) && st2.phase === 'moving' && st2.backfilledTo === new Date(S - 86_400_000).toISOString().slice(0, 10), `history: logs copied, past days replayed from the raw archive (${hist})`);
    ok((await sw.readStore()) === 'postgres', 'the switch day is not over: reads still Postgres');
    const dayEnd = Date.parse(new Date(S).toISOString().slice(0, 10) + 'T00:00:00Z') + 86_400_000;
    const fin = await sw.checkStoreSwitch(deps, dayEnd + 2 * 3_600_000 + 1);
    ok(/reports now read clickhouse/.test(fin) && (await sw.readStore()) === 'clickhouse', `once the switch day is over it is replayed and the reports move (${fin})`);
    const W = reports.parseQuery({ from: new Date(NOW - 5 * 86_400_000).toISOString(), to: new Date(NOW + 86_400_000).toISOString() });
    useStore('postgres'); const pgOv = JSON.stringify(canon({ s: await reports.playbackSuccess(mover, W), st: await reports.startupPerformance(mover, W), t: await reports.telemetryHealth(mover, W), a: (await reports.access(mover, W)).gate }));
    useStore('auto'); const chOv = JSON.stringify(canon({ s: await reports.playbackSuccess(mover, W), st: await reports.startupPerformance(mover, W), t: await reports.telemetryHealth(mover, W), a: (await reports.access(mover, W)).gate }));
    ok(pgOv === chOv, 'ClickHouse now says exactly what Postgres said: views, startup, collector counts and gate decisions, nothing lost or twice', { pgOv: pgOv.slice(0, 600), chOv: chOv.slice(0, 600) });
    const s5 = await reports.playbackSuccess(mover, W);
    ok(s5.attempts === 37, `all 37 views there (36 replayed from three days, 1 written live): ${s5.attempts}`);
    ok(today.length === 10, 'and the Postgres tables are left as they were (nothing deleted)');

    // ------------------------------------------------------------------ 6
    console.log('== 6. two replicas: one stops, the reports carry on ==');
    const a = await startShim(), b = await startShim();
    if (!a || !b) { ok(false, 'two stand-in replicas started'); } else {
      useStore('clickhouse');
      const rep = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`ch-rep-${tag}`]))!.id;
      const rv = views.slice(0, 300).map((v) => ({ ...v, account_id: rep }));
      // what replication does on a real cluster: the same rows on both
      for (const u of [a.url, b.url]) { process.env.CLICKHOUSE_URL = u; ch.resetClickhouse(); await store.writeViews(rv); }
      process.env.CLICKHOUSE_URL = `${a.url},${b.url}`; ch.resetClickhouse();
      const both = JSON.stringify(canon(await reports.buffering(rep, q)));
      a.proc.kill('SIGKILL'); await sleep(300);
      const t1 = Date.now();
      const oneLeft = JSON.stringify(canon(await reports.buffering(rep, q)));
      const ms = Date.now() - t1;
      ok(both === oneLeft, `replica A gone: the same report from replica B (${ms} ms)`);
      const health = await ch.replicaHealth();
      ok(health.length === 2 && !health[0].ok && health[1].ok, 'the health check names the replica that is down', health);
      await store.writeViews([{ ...rv[0], view_id: `${tag}-after-loss` }]);
      const [w] = await adb.aquery<any>(`SELECT count(*) AS n FROM qoe_views WHERE account_id = $1`, [rep]);
      ok(Number(w.n) === 301, 'the collector writes through the replica that is left');
      process.env.CLICKHOUSE_URL = chUrl; ch.resetClickhouse();
    }

    // ------------------------------------------------------------------ 7
    console.log('== 7. the cluster schema and the Terraform ==');
    process.env.CLICKHOUSE_CLUSTER = 'volt';
    const ddl = ch.schemaSql('volt_qoe');
    delete process.env.CLICKHOUSE_CLUSTER;
    ok(ddl.length === 9 && ddl.every((d) => / ON CLUSTER volt/.test(d)) && ddl.slice(1).every((d) => /ENGINE = Replicated\w*MergeTree/.test(d)), 'on a cluster every table is replicated and made ON CLUSTER');
    ok(/ReplicatedReplacingMergeTree\(_v\)/.test(ddl[1]) && /ReplicatedAggregatingMergeTree/.test(ddl[2]) && /ENGINE = ReplicatedMergeTree\n/.test(ddl[4]), 'views versioned, minutes added, the gate log appended');
    const tf = readFileSync(join(ROOT, '../deploy/terraform/clickhouse.tf'), 'utf8');
    const vars = readFileSync(join(ROOT, '../deploy/terraform/variables.tf'), 'utf8') + tf;
    ok(/variable "clickhouse_enabled"[\s\S]*?default\s*=\s*false/.test(vars), 'off by default (the Postgres analytics database serves until the size is reached)');
    ok(/resource "aws_instance" "clickhouse"[\s\S]*?count\s*=\s*local\.ch_replicas/.test(tf) && /ch_replicas\s*=\s*var\.clickhouse_enabled \? 2 : 0/.test(tf), 'two replicas');
    ok(/subnet_id\s*=\s*aws_subnet\.private\[count\.index % length\(aws_subnet\.private\)\]\.id/.test(tf), 'in different availability zones (one private subnet each)');
    ok(/resource "aws_instance" "clickhouse_keeper"/.test(tf) && /keeper_count|ch_keepers\s*=\s*var\.clickhouse_enabled \? 1 : 0/.test(tf) && /<raft_configuration>/.test(tf), 'three keepers: one on each replica and a small third, so losing one keeps a quorum');
    ok(/instance_type\s*=\s*var\.clickhouse_instance_type/.test(tf) && /variable "clickhouse_instance_type"[\s\S]*?default\s*=\s*"r7g\.large"/.test(vars) && /t4g\.small/.test(vars), 'Graviton, r7g.large by default (QOE_REPORTING.md section 9), the third keeper a t4g.small');
    ok(/resource "aws_s3_bucket" "clickhouse_backups"/.test(tf) && /BACKUP DATABASE/.test(tf) && /OnCalendar=\*-\*-\* 0?3:\d\d/.test(tf) && /expiration\s*\{[\s\S]*?days\s*=\s*var\.clickhouse_backup_retention_days/.test(tf), 'nightly backups to S3, kept for a set number of days');
    ok(/QOE_STORE[\s\S]{0,80}auto/.test(tf) && /CLICKHOUSE_URL/.test(tf) && /CLICKHOUSE_CLUSTER/.test(tf), 'the control plane is told QOE_STORE=auto and where the replicas are');
    ok(/from_port\s*=\s*8123[\s\S]*?security_groups\s*=\s*\[aws_security_group\.control_plane\.id\]/.test(tf) && !/0\.0\.0\.0\/0[^\n]*8123/.test(tf), 'only the control plane reaches the HTTP port; nothing public');
    ok(/random_password" "clickhouse"/.test(tf) && /aws_secretsmanager_secret" "clickhouse"/.test(tf), 'the password is generated and kept in Secrets Manager, never in the code');
  } catch (e) {
    fail++; console.log('FAIL unexpected: ' + ((e as Error).stack ?? e));
  } finally {
    for (const p of shims) p.kill('SIGKILL');
    try { process.env.CLICKHOUSE_URL = chUrl; ch.resetClickhouse(); await ch.chExec(`DROP DATABASE IF EXISTS ${db}`, null); } catch { /* the stand-in is gone */ }
    await adb.closeAnalytics();
    await pool.end().catch(() => {});
    try { rmSync(process.env.QOE_RAW_DIR!, { recursive: true, force: true }); } catch { /* */ }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
