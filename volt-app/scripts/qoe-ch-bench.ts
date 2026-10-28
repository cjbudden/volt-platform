// ============================================================================
//  DASHBOARDS OVER 13 MONTHS ON CLICKHOUSE (build queue 2.11 acceptance:
//  "dashboards under 1 s over 13 months").
//
//  Fills a ClickHouse database with 13 months of one account's view rows and
//  minute rows at a chosen audience (generated inside ClickHouse, so a
//  hundred million rows take minutes, not hours), then times every report
//  the console's playback page asks for, through the product's own report
//  code (services/qoe/reports.ts on QOE_STORE=clickhouse), over the whole 13
//  months and over the last day.
//
//    CLICKHOUSE_URL=http://host:8123 DATABASE_URL=postgres://... \
//      npx tsx scripts/qoe-ch-bench.ts [--vh-per-month 1000000] [--runs 3] [--keep]
//
//  Rows: QOE_REPORTING.md section 9 gives about 1.55 views per viewer hour
//  (600 view rows a second at 1 B viewer hours a month), so 1 M viewer hours
//  a month is about 1.55 M views a month, 20 M over 13 months. Each view's
//  values are drawn so filters and percentiles have real work to do (twenty
//  device models, five app versions, nulls where the product has them).
//  Postgres is only needed for the analytics database's qoe_meta (nothing
//  is written there).
// ============================================================================
process.env.QOE_STORE = 'clickhouse';

const arg = (name: string, d: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : d; };
const VH = Number(arg('--vh-per-month', '1000000'));
const RUNS = Number(arg('--runs', '3'));
const KEEP = process.argv.includes('--keep');
const MONTHS = 13;

(async () => {
  if (!process.env.CLICKHOUSE_URL) { console.error('set CLICKHOUSE_URL'); process.exit(2); }
  process.env.CLICKHOUSE_DATABASE ||= `qoe_bench_${Math.round(VH / 1000)}k`;
  const ch = await import('../src/services/qoe/clickhouse');
  const reports = await import('../src/services/qoe/reports');
  const sw = await import('../src/services/qoe/storeSwitch');
  const db = sw.qoeChDatabase();
  const acct = '00000000-0000-4000-8000-00000000b11c';
  const end = Date.UTC(2026, 9, 28), start = end - MONTHS * 30.44 * 86_400_000;
  const views = Math.round(VH * 1.55 * MONTHS);
  const minuteRows = Math.round(MONTHS * 30.44 * 1440 * 12); // about a dozen dimension mixes a minute

  await ch.ensureSchema(db);
  const [{ n: have }] = await ch.chSelect<any>(`SELECT count() AS n FROM qoe_views WHERE account_id = ${ch.lit(acct)}`, db);
  if (Number(have) < views * 0.99) {
    console.log(`filling ${views.toLocaleString()} views and ${minuteRows.toLocaleString()} minute rows (${VH.toLocaleString()} viewer hours a month, ${MONTHS} months)`);
    await ch.chExec(`TRUNCATE TABLE IF EXISTS qoe_views`, db);
    await ch.chExec(`TRUNCATE TABLE IF EXISTS qoe_minutes`, db);
    const span = Math.round((end - start) / 1000);
    const pick = (list: string[], salt: number) => `[${list.map((x) => ch.lit(x)).join(',')}][1 + (cityHash64(number, ${salt}) % ${list.length})]`;
    const nul = (expr: string, salt: number, pct: number) => `if(cityHash64(number, ${salt}) % 100 < ${pct}, NULL, ${expr})`;
    const r = (salt: number, mod: number) => `(cityHash64(number, ${salt}) % ${mod})`;
    const models = Array.from({ length: 20 }, (_, i) => `model-${i}`);
    const chunk = 2_000_000;
    const t0 = Date.now();
    for (let off = 0; off < views; off += chunk) {
      const n = Math.min(chunk, views - off);
      await ch.chExec(`INSERT INTO qoe_views (account_id, view_id, day, def_version, sid, attempt, started_at, ended_at, ended_by, content_id, stream_type,
          app_name, app_version, device_model, device_class, os, browser, codec, cdn, country, asn, network, outcome, waited_ms, startup_ms,
          t_entitlement, t_manifest, t_drm, t_segment, t_decode, error_code, error_step, fatal_after_start, playing_ms, rebuffer_ms, stalls, first_stall_ms,
          bitrate_ms, bitrate_kbps_ms, below_top_ms, switches, oscillations, buffer_avg_ms, throughput_avg_kbps, dropped_frames, latency_avg_ms,
          latency_first_ms, latency_last_ms, latency_max_ms, exit_after_stall, exit_after_error, events, sn_missing, clock_skew_ms, decode_errors, hw_decode,
          key_system, licence_requests, ad_breaks, ad_ms, ad_playing_ms, ads_started, ads_ended, entry_point, session_depth, _v)
        SELECT ${ch.lit(acct)}, toString(number), toDate(st), 3, concat('s', toString(intDiv(number, 2))), 1 + number % 2, st, st + toIntervalMillisecond(${r(1, 5_400_000)}),
          ${pick(['e', 'q', 'q', 'silence', 'f'], 2)}, ${pick(Array.from({ length: 50 }, (_, i) => `c-${i}`), 3)}, ${pick(['v', 'l', 'l', 'll'], 4)},
          ${pick(['Volt Web', 'Volt TV', 'Volt iOS', 'Volt Android'], 5)}, ${pick(['2.0.0', '2.1.0', '2.2.0', '2.3.0', '2.4.0'], 6)}, ${pick(models, 7)}, ${pick(['tv', 'mobile', 'desktop', 'tablet'], 8)},
          ${pick(['Tizen', 'webOS', 'iOS', 'Android', 'macOS', 'Windows'], 9)}, ${nul(pick(['Chrome', 'Safari', 'Firefox'], 10), 11, 30)}, ${pick(['avc1', 'hvc1'], 12)},
          ${pick(['cf.example', 'fastly.example'], 13)}, ${pick(['AU', 'NZ', 'GB', 'US', 'DE', 'FR', 'JP', 'BR'], 14)}, toString(${r(15, 400)}), ${pick(['residential', 'mobile', 'business'], 16)},
          o, if(o = 'started', NULL, toInt32(${r(17, 20000)})), if(o = 'started', toInt32(300 + ${r(18, 6000)}), NULL),
          toInt32(${r(19, 800)}), toInt32(${r(20, 900)}), ${nul(`toInt32(${r(21, 2000)})`, 22, 60)}, toInt32(${r(23, 1500)}), toInt32(${r(24, 90)}),
          if(o = 'failed', ${pick(['403', 'MEDIA_ERR', 'DRM_LICENSE', 'TIMEOUT'], 25)}, NULL), if(o = 'failed', ${pick(['entitlement', 'drm', 'manifest', 'segment'], 26)}, NULL),
          o = 'started' AND ${r(27, 100)} < 2, if(o = 'started', ${r(28, 5_400_000)}, 0), if(o = 'started', ${r(29, 40_000)}, 0), if(o = 'started', toInt32(${r(30, 6)}), 0),
          ${nul(`toInt32(${r(31, 600000)})`, 32, 70)}, if(o = 'started', ${r(33, 5_000_000)}, 0), if(o = 'started', ${r(34, 5_000_000)} * (500 + ${r(35, 7000)}), 0), ${r(36, 100000)},
          toInt32(${r(37, 15)}), toInt32(${r(38, 3)}), toInt32(1000 + ${r(39, 30000)}), toInt32(500 + ${r(40, 50000)}), ${nul(`toInt32(${r(41, 900)})`, 42, 30)},
          ${nul(`toInt32(2000 + ${r(43, 30000)})`, 44, 40)}, ${nul(`toInt32(2000 + ${r(45, 20000)})`, 46, 40)}, ${nul(`toInt32(2000 + ${r(47, 25000)})`, 48, 40)}, ${nul(`toInt32(5000 + ${r(49, 30000)})`, 50, 40)},
          ${r(51, 100)} < 8, ${r(52, 100)} < 3, toInt32(20 + ${r(53, 400)}), toInt32(if(${r(54, 100)} < 5, 1 + ${r(55, 4)}, 0)), ${nul(`toInt32(${r(56, 10000)}) - 5000`, 57, 10)},
          toInt32(if(${r(58, 100)} < 3, 1, 0)), ${nul(`${r(59, 100)} < 80`, 60, 20)}, ${nul(pick(['com.widevine.alpha', 'com.apple.fps.1_0', 'com.microsoft.playready'], 61), 62, 50)},
          toInt32(${r(63, 3)}), toInt32(if(${r(64, 100)} < 30, 1 + ${r(65, 3)}, 0)), ${r(66, 180000)}, ${r(67, 170000)}, toInt32(${r(68, 6)}), toInt32(${r(69, 6)}),
          ${nul(pick(['row', 'search', 'deeplink', 'continue'], 70), 71, 50)}, ${nul(`toInt32(${r(72, 9)})`, 73, 50)}, 1
        FROM (SELECT number, toDateTime64(${start / 1000} + (cityHash64(number, 0) % ${span}), 3, 'UTC') AS st,
                     ['started','started','started','started','started','started','started','started','failed','exited'][1 + cityHash64(number, 99) % 10] AS o
              FROM numbers(${off}, ${n}))`, db, { max_execution_time: 3600, max_insert_threads: 2 });
      process.stdout.write(`  ${(off + n).toLocaleString()} views (${Math.round((Date.now() - t0) / 1000)} s)\r`);
    }
    await ch.chExec(`INSERT INTO qoe_minutes (account_id, minute, content_id, stream_type, country, device_class, cdn, def_version, attempts, starts, failures, fatal_after, stalls, playing_ms, rebuffer_ms, switches, startup_sketch)
      SELECT ${ch.lit(acct)}, toDateTime64(${Math.floor(start / 60000) * 60} + intDiv(number, 12) * 60, 3, 'UTC'), ${pick(Array.from({ length: 50 }, (_, i) => `c-${i}`), 3)}, ${pick(['v', 'l'], 4)},
        ${pick(['AU', 'NZ', 'GB', 'US'], 14)}, ${pick(['tv', 'mobile', 'desktop'], 8)}, ${pick(['cf.example', 'fastly.example'], 13)}, 3,
        ${r(80, 40)}, ${r(81, 35)}, ${r(82, 3)}, ${r(83, 2)}, ${r(84, 5)}, ${r(85, 9_000_000)}, ${r(86, 90_000)}, ${r(87, 20)},
        map(toString(700 + ${r(88, 40)}), toFloat64(1 + ${r(89, 9)}), toString(760 + ${r(90, 40)}), toFloat64(1 + ${r(91, 4)}))
      FROM numbers(${minuteRows})`, db, { max_execution_time: 3600 });
    await ch.chExec(`OPTIMIZE TABLE qoe_views FINAL`, db, { max_execution_time: 3600 }).catch(() => { /* merges continue in the background */ });
    console.log(`\nfilled in ${Math.round((Date.now() - t0) / 1000)} s`);
  } else console.log(`using the ${Number(have).toLocaleString()} views already there`);

  const [size] = await ch.chSelect<any>(`SELECT formatReadableSize(sum(data_compressed_bytes)) AS disk, sum(rows) AS rows FROM system.parts WHERE database = ${ch.lit(db)} AND table = 'qoe_views' AND active`, db).catch(() => [{ disk: '?', rows: '?' }]);
  console.log(`qoe_views: ${Number(size.rows).toLocaleString()} rows, ${size.disk} on disk`);

  const windows = {
    '13 months': reports.parseQuery({ from: new Date(start).toISOString(), to: new Date(end).toISOString() }),
    'last day': reports.parseQuery({ from: new Date(end - 86_400_000).toISOString(), to: new Date(end).toISOString() }),
    'last 31 days': reports.parseQuery({ from: new Date(end - 31 * 86_400_000).toISOString(), to: new Date(end).toISOString() }),
    'last 90 days': reports.parseQuery({ from: new Date(end - 90 * 86_400_000).toISOString(), to: new Date(end).toISOString() }),
    '13 months, filtered (country, app version, device class)': reports.parseQuery({ from: new Date(start).toISOString(), to: new Date(end).toISOString(), country: 'AU,NZ', app_version: '2.3.0', device_class: 'tv' }),
  };
  const list: Array<[string, (q: any) => Promise<unknown>]> = [
    ['1 playback success', (q) => reports.playbackSuccess(acct, q)], ['2 startup', (q) => reports.startupPerformance(acct, q)],
    ['3 buffering', (q) => reports.buffering(acct, q)], ['4 quality', (q) => reports.quality(acct, q)], ['5 rendering', (q) => reports.rendering(acct, q)],
    ['7 access', (q) => reports.access(acct, q)], ['8 live', (q) => reports.liveHealth(acct, q)], ['9 advertising', (q) => reports.advertising(acct, q)],
    ['10 engagement', (q) => reports.engagement(acct, q)], ['12 telemetry', (q) => reports.telemetryHealth(acct, q)],
    ['trend (series)', (q) => reports.series(acct, q)], ['worst device models', (q) => reports.breakdown(acct, q, 'device_model', 'rebuffer', 20)],
  ];
  const out: Record<string, Record<string, number>> = {};
  for (const [wname, q] of Object.entries(windows)) {
    out[wname] = {};
    for (const [name, fn] of list) {
      const times: number[] = [];
      for (let i = 0; i < RUNS; i++) { const t = performance.now(); await fn(q); times.push(performance.now() - t); }
      times.sort((a, b) => a - b);
      out[wname][name] = Math.round(times[Math.floor(times.length / 2)]);
      console.log(`  ${wname}: ${name} ${out[wname][name]} ms`);
    }
    const t = performance.now();
    try { await reports.overview(acct, q); out[wname]['whole page (overview, all reports)'] = Math.round(performance.now() - t); }
    catch (e) { console.log(`  ${wname}: whole page failed after ${Math.round(performance.now() - t)} ms: ${(e as Error).message}`); out[wname]['whole page (overview, all reports)'] = -1; }
  }
  for (const [w, rows] of Object.entries(out)) {
    console.log(`\n${w} (median of ${RUNS} runs, ms):`);
    for (const [k, v] of Object.entries(rows)) console.log(`  ${k.padEnd(40)} ${String(v).padStart(6)}${v >= 1000 ? '  over 1 s' : ''}`);
  }
  const worst = Math.max(...Object.values(out['13 months']).slice(0, list.length));
  console.log(`\nslowest single report over 13 months: ${worst} ms`);
  console.log(JSON.stringify({ vhPerMonth: VH, views, minuteRows, results: out }));
  if (!KEEP) await ch.chExec(`DROP DATABASE IF EXISTS ${db}`, null);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
