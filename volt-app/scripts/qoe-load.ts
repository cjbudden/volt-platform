// ============================================================================
//  THE COLLECTOR UNDER 100 000 CONCURRENT VIEWERS (build queue 2.11
//  acceptance: "load test at 100 k concurrent simulated sessions; collector
//  at about 50 % CPU at the modelled event rate").
//
//  This process runs the real API (createServer: POST /api/cmcd, the raw
//  store, the live derivation, the 10 s flush into the analytics store) and
//  measures its own CPU. A child process plays the viewers over HTTP:
//  --sessions viewers, each sending what QOE_REPORTING.md section 9 models,
//  220 reports per viewer hour (the 30 s heartbeat, state, bitrate and error
//  reports, and 1 in 50 requests as an rr report), in batches of 10, spread
//  evenly so the rate is steady from the first second.
//
//    DATABASE_URL=postgres://.../<a migrated database> npx tsx scripts/qoe-load.ts \
//      [--sessions 100000] [--seconds 240] [--store postgres|clickhouse]
//
//  Prints the reports a second it took, CPU microseconds per report, the
//  share of one vCPU at the modelled rate, how many collector vCPUs keep
//  that under 50 %, and the memory the live sessions hold.
// ============================================================================
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (name: string, d: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : d; };
const SESSIONS = Number(arg('--sessions', '100000'));
const SECONDS = Number(arg('--seconds', '240'));
const REPORTS_PER_VH = 220, BATCH = 10;
const PERIOD_S = 3600 * BATCH / REPORTS_PER_VH; // one POST per viewer every ~164 s

// ------------------------------------------------------------- the viewers
async function viewers(url: string, key: string, sessions: number, seconds: number) {
  // Node's fetch keeps connections alive by default.
  const sn = new Uint32Array(sessions);
  const started = new Uint8Array(sessions);
  const t0 = Date.now(), end = t0 + seconds * 1000;
  let sent = 0, accepted = 0, failed = 0, inflight = 0, lateMs = 0;
  const kinds = ['t', 't', 't', 't', 't', 't', 'bc', 'rr', 'rr', 'rr', 'rr', 'rr', 'ps', 'b'];
  const line = (i: number, ts: number) => {
    const sid = `load-${i}`;
    const n = ++sn[i];
    if (!started[i]) { started[i] = 1; return `cid="c-${i % 500}",e=ps,sid="${sid}",sn=${n},st=l,sta=s,ts=${ts},v=2`; }
    if (started[i] === 1) { started[i] = 2; return `cid="c-${i % 500}",e=ps,msd=${600 + (i % 900)},sid="${sid}",sn=${n},st=l,sta=p,ts=${ts},v=2`; }
    const k = kinds[(i + n) % kinds.length];
    if (k === 'rr') return `e=rr,rc=200,sid="${sid}",sn=${n},ts=${ts},ttfb=${20 + (n % 80)},ttlb=${200 + (n % 300)},url="https://cdn.example/seg${n}.m4s",v=2`;
    if (k === 'bc') return `br=(${[800, 1800, 3500, 6000][n % 4]}),e=bc,sid="${sid}",sn=${n},ts=${ts},v=2`;
    if (k === 'ps') return `e=ps,sid="${sid}",sn=${n},sta=${n % 2 ? 'r' : 'p'},ts=${ts},v=2`;
    if (k === 'b') return `bg,e=b,sid="${sid}",sn=${n},ts=${ts},v=2`;
    return `bl=${8000 + (n % 20) * 500},br=(3500),e=t,ltc=${6000 + (n % 40) * 100},mtp=${9000 + (n % 50) * 100},pb=3500,sid="${sid}",sn=${n},ts=${ts},v=2`;
  };
  // Each viewer i posts at offset (i / sessions) of the period, then every period.
  const perMs = sessions / (PERIOD_S * 1000);
  let next = 0; // the next viewer due, counted across periods
  const post = async (i: number) => {
    const now = Date.now();
    const lines = Array.from({ length: BATCH }, (_, k) => line(i, now - (BATCH - 1 - k) * 16_000));
    inflight++; sent += BATCH;
    try {
      const r = await fetch(`${url}/api/cmcd?appKey=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'content-type': 'application/cmcd', 'user-agent': 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) Volt/2.4.0', 'cloudfront-viewer-country': 'AU' }, body: lines.join('\n') });
      if (r.status === 204) accepted += BATCH; else failed += BATCH;
      await r.arrayBuffer().catch(() => {});
    } catch { failed += BATCH; }
    inflight--;
  };
  while (Date.now() < end) {
    const due = Math.floor((Date.now() - t0) * perMs);
    if (next < due) lateMs = Math.max(lateMs, (due - next) / perMs);
    while (next < due && inflight < 2000) { void post(next % sessions); next++; }
    await new Promise((r) => setTimeout(r, 5));
  }
  while (inflight > 0) await new Promise((r) => setTimeout(r, 20));
  return { sent, accepted, failed, seconds: (Date.now() - t0) / 1000, behindMs: Math.round(lateMs), viewersReached: Math.min(sessions, next) };
}

if (process.argv.includes('--child')) {
  process.on('message', async (m: any) => { const r = await viewers(m.url, m.key, m.sessions, m.seconds); process.send!(r); process.exit(0); });
} else {
  (async () => {
    process.env.QOE_RAW_DIR = mkdtempSync(join(tmpdir(), 'qoe-load-raw-'));
    delete process.env.QOE_RAW_BUCKET;
    process.env.QOE_STORE = arg('--store', process.env.QOE_STORE ?? 'postgres');
    const { createServer } = await import('../src/server');
    const { one, query, pool } = await import('../src/db');
    const { generateKey } = await import('../src/services/apiKeys');
    const coll = await import('../src/services/qoe/collector');
    const tag = Math.random().toString(36).slice(2, 8);
    const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`load-${tag}`]))!.id;
    const app = await one<any>(`INSERT INTO apps(account_id, name, type, restrictions) VALUES ($1,'TV','web','{}') RETURNING id`, [acct]);
    const k = generateKey('publishable');
    await query(`INSERT INTO api_keys(account_id, app_id, kind, key_prefix, key_hash, scopes) VALUES ($1,$2,'publishable',$3,$4,'{playback}')`, [acct, app!.id, k.prefix, k.hash]);
    const srv = createServer().listen(0);
    const url = `http://127.0.0.1:${(srv.address() as any).port}`;
    const rate = SESSIONS * REPORTS_PER_VH / 3600;
    console.log(`${SESSIONS.toLocaleString()} viewers, ${rate.toFixed(0)} reports a second modelled (${(rate / BATCH).toFixed(0)} POSTs a second), ${SECONDS} s, store ${process.env.QOE_STORE}`);
    const child = fork(__filename, ['--child'], { execArgv: process.execArgv });
    const cpu0 = process.cpuUsage(), t0 = performance.now();
    let peakHeap = 0, peakRss = 0, peakSessions = 0;
    const mem = setInterval(() => { const m = process.memoryUsage(); peakHeap = Math.max(peakHeap, m.heapUsed); peakRss = Math.max(peakRss, m.rss); peakSessions = Math.max(peakSessions, coll.collectorState().sessions); }, 1000);
    const res: any = await new Promise((r) => { child.on('message', r); child.send({ url, key: k.raw, sessions: SESSIONS, seconds: SECONDS }); });
    await coll.flushQoe();
    const cpu = process.cpuUsage(cpu0), wall = (performance.now() - t0) / 1000;
    clearInterval(mem);
    const st = coll.collectorState();
    const cpuS = (cpu.user + cpu.system) / 1e6;
    const perReport = cpuS * 1e6 / Math.max(1, res.accepted);
    const share = rate * perReport / 1e6; // vCPU at the modelled rate
    const out = {
      viewers: SESSIONS, seconds: Math.round(wall), reportsAccepted: res.accepted, reportsFailed: res.failed, reportsPerSecond: Math.round(res.accepted / res.seconds),
      modelledPerSecond: Math.round(rate), generatorBehindMs: res.behindMs, viewersReached: res.viewersReached,
      collectorCpuSeconds: Math.round(cpuS * 10) / 10, cpuMicrosPerReport: Math.round(perReport * 10) / 10,
      vCpuAtModelledRate: Math.round(share * 1000) / 1000, vCpusForUnder50Percent: Math.max(1, Math.ceil(share / 0.5)),
      liveSessionsPeak: peakSessions, heapPeakMB: Math.round(peakHeap / 1048576), rssPeakMB: Math.round(peakRss / 1048576),
      viewsWritten: st.viewsWritten, minuteRowsWritten: st.minuteRowsWritten, flushFailures: st.flushFailures,
    };
    console.log(out);
    console.log(JSON.stringify(out));
    srv.close(); await pool.end().catch(() => {});
    try { rmSync(process.env.QOE_RAW_DIR!, { recursive: true, force: true }); } catch { /* */ }
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
