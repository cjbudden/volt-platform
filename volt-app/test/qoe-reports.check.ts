// ============================================================================
//  QOE COLLECTOR, VIEW ROWS, MINUTE SKETCHES, REPLAY AND THE FIRST REPORTS
//  (build queue 1.14e, QOE_REPORTING.md sections 3 to 9a).
//
//  Simulated viewers with planted startup times, stalls, failures, exits,
//  switches, pauses, backgrounding and seeks are sent through the real
//  collector (POST /api/cmcd) over HTTP. Then:
//    1. reports 1, 2, 3, 4, 10 and 12 give exactly the numbers the plan says
//       (p50/p95/p99 by nearest rank, affected sessions, rates);
//    2. a planted bad app release is isolated by its filters (app version,
//       device model, OS from the user agent, country from the edge) and is
//       the worst segment in the breakdown;
//    3. the minute sketches' percentiles are within 1 % of the exact ones;
//    4. deleting every derived row and replaying gives identical reports,
//       and replaying twice gives the same again;
//    5. with the analytics database refusing connections, reports are still
//       accepted (204), kept raw, the play gate still answers, and once it is
//       back nothing is missing (live equals replay);
//    6. the separate pool, the S3 raw path (stand-in client), the raw-first
//       order, the console routes' validation, the Terraform for the raw
//       archive (versioning, Object Lock, 30 d / 90 d / Deep Archive).
//
//  Usage: DATABASE_URL=... npx tsx test/qoe-reports.check.ts
// ============================================================================
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ROOT = resolve(__dirname, '..');
process.env.QOE_RAW_DIR = mkdtempSync(join(tmpdir(), 'qoe-raw-'));
process.env.TRUST_EDGE_GEO = 'true';
delete process.env.QOE_RAW_BUCKET;

/** Nearest-rank percentile, written here independently of the product. */
const nr = (vals: number[], q: number) => { const s = [...vals].sort((a, b) => a - b); return s.length ? s[Math.max(1, Math.ceil(q * s.length)) - 1] : null; };
const near = (a: number | null, b: number | null, rel = 0.01) => a != null && b != null && Math.abs(a - b) <= rel * Math.max(1, Math.abs(b));

// ---------------------------------------------------------------- the plan
type L = Record<string, string | number | boolean | Array<number | string>>;
/** One CMCD v2 line, the way the SDK writes them: tokens bare, strings quoted, lists in brackets. */
function enc(d: L): string {
  const TOK = new Set(['e', 'sta', 'st', 'ot', 'sf']);
  return Object.keys(d).sort().map((k) => {
    const v = d[k];
    if (v === true) return k;
    if (Array.isArray(v)) return `${k}=(${v.map((x) => (typeof x === 'number' ? x : `"${x}"`)).join(' ')})`;
    if (typeof v === 'number') return `${k}=${v}`;
    if (TOK.has(k)) return `${k}=${v}`;
    return `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }).join(',');
}

interface Viewer { sid: string; ua: string; geo: Record<string, string>; lines: L[]; plan: { group: string; startup?: number; outcome: 'started' | 'failed' | 'exited'; stalls?: number; rebuffer?: number; playing?: number; fatalAfter?: boolean; firstStall?: number } }

(async () => {
  const UA_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
  const UA_TV = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/7.0 TV Safari/537.36';
  const T0 = Math.ceil(Date.now() / 60_000) * 60_000 + 1000; // next minute: every report is "early", none late
  const tag = Date.now().toString(36);
  const viewers: Viewer[] = [];
  const base = (sid: string, app: string, appv: string, dm: string, cid: string): L => ({ v: 2, sid, cid, st: 'v', 'com.volt-app': app, 'com.volt-appv': appv, 'com.volt-sdkv': '1.4.0', 'com.volt-dm': dm });
  const mk = (sid: string, ua: string, geo: Record<string, string>, steps: Array<[number, L]>, id: L, plan: Viewer['plan']) => {
    let sn = 0;
    const lines = steps.map(([t, d], i) => ({ ...(i === 0 ? id : { v: 2, sid, cid: id.cid, st: id.st }), ts: T0 + t, sn: ++sn, ...d }));
    viewers.push({ sid, ua, geo, lines, plan });
  };
  const AU = { 'cloudfront-viewer-country': 'AU', 'cloudfront-viewer-country-region': 'NSW', 'cloudfront-viewer-asn': '1221' };
  const MY = { 'cloudfront-viewer-country': 'MY', 'cloudfront-viewer-country-region': '14', 'cloudfront-viewer-asn': '4788' };
  const spans = (msd: number) => ({ 'com.volt-tent': '100', 'com.volt-tman': '50', 'com.volt-tseg': '100', 'com.volt-tdec': '50', 'com.volt-toth': String(msd - 300) });

  // A: 100 good viewers on 2.0.0. Startup 500..1490 ms; every tenth stalls 2 s at 20 s; every twentieth switches down and back within 5 s.
  for (let i = 0; i < 100; i++) {
    const sid = `a${String(i).padStart(3, '0')}-${tag}`;
    const msd = 500 + 10 * i;
    const steps: Array<[number, L]> = [[i * 10, { e: 'ps', sta: 's' }], [i * 10 + 300, { e: 'rr', url: 'https://cdn.volt.example/v/seg1.m4s', rc: 200, ttfb: 40, ttlb: 90, su: true, 'com.volt-cfid': 'cf-' + i }],
      [i * 10 + msd, { e: 'ps', sta: 'p', msd, br: [3000], ...spans(msd) }]];
    const f = i * 10 + msd;
    let playing = 60_000, stalls = 0, reb = 0;
    if (i % 10 === 0) { steps.push([f + 20_000, { e: 'ps', sta: 'r' }], [f + 22_000, { e: 'ps', sta: 'p' }]); playing -= 2000; stalls = 1; reb = 2000; }
    steps.push([f + 30_000, { e: 't', bl: [12000], mtp: [20000], pb: [3000], tpb: [3000], dfa: 2 }]);
    if (i % 20 === 0) steps.push([f + 40_000, { e: 'bc', br: [1500] }], [f + 45_000, { e: 'bc', br: [3000] }]);
    steps.push([f + 60_000, { e: 'ps', sta: 'q' }]);
    mk(sid, UA_MAC, AU, steps, base(sid, 'Volt Web', '2.0.0', 'MacIntel', 'content-sport'), { group: 'A', startup: msd, outcome: 'started', stalls, rebuffer: reb, playing, firstStall: stalls ? 20_000 : undefined });
  }
  // B: the bad release 2.1.0 on a TV model in MY. 10 fail at the licence, 5 leave after 4 s, 5 start slowly and stall 10 s.
  for (let i = 0; i < 20; i++) {
    const sid = `b${String(i).padStart(3, '0')}-${tag}`;
    const id = base(sid, 'Volt TV', '2.1.0', 'BadTV QN90', 'content-film');
    id.st = 'v';
    if (i < 10) mk(sid, UA_TV, MY, [[i * 10, { e: 'ps', sta: 's' }], [i * 10 + 800, { e: 'e', ec: ['shaka-6007'], 'com.volt-step': 'drm', su: true }], [i * 10 + 801, { e: 'ps', sta: 'f' }]], id, { group: 'B', outcome: 'failed' });
    else if (i < 15) mk(sid, UA_TV, MY, [[i * 10, { e: 'ps', sta: 's' }], [i * 10 + 4000, { e: 'ps', sta: 'q' }]], id, { group: 'B', outcome: 'exited' });
    else {
      const f = i * 10 + 4000;
      mk(sid, UA_TV, MY, [[i * 10, { e: 'ps', sta: 's' }], [f, { e: 'ps', sta: 'p', msd: 4000, br: [1200], ...spans(4000) }], [f + 5000, { e: 'ps', sta: 'r' }], [f + 15_000, { e: 'ps', sta: 'p' }], [f + 20_000, { e: 'ps', sta: 'q' }]],
        id, { group: 'B', startup: 4000, outcome: 'started', stalls: 1, rebuffer: 10_000, playing: 10_000, firstStall: 5000 });
    }
  }
  // C: two fatal errors after the start, a backgrounded viewer, a paused one, a seeker, one that goes quiet, a preload that never plays, a sequence gap.
  const cid = (n: string) => base(`${n}-${tag}`, 'Volt Web', '2.0.0', 'MacIntel', 'content-sport');
  for (const n of ['c1', 'c2']) mk(`${n}-${tag}`, UA_MAC, AU, [[0, { e: 'ps', sta: 's' }], [1000, { e: 'ps', sta: 'p', msd: 1000, br: [3000], ...spans(1000) }], [6000, { e: 'e', ec: ['http-404'], 'com.volt-step': 'segment' }], [11_000, { e: 'ps', sta: 'f' }]],
    cid(n), { group: 'C', startup: 1000, outcome: 'started', playing: 10_000, fatalAfter: true });
  mk(`bg-${tag}`, UA_MAC, AU, [[0, { e: 'ps', sta: 's' }], [1000, { e: 'ps', sta: 'p', msd: 1000, br: [3000], ...spans(1000) }], [11_000, { e: 'b', bg: true }], [41_000, { e: 'b' }], [61_000, { e: 'ps', sta: 'q' }]],
    cid('bg'), { group: 'C', startup: 1000, outcome: 'started', playing: 30_000 });
  mk(`pa-${tag}`, UA_MAC, AU, [[0, { e: 'ps', sta: 's' }], [1000, { e: 'ps', sta: 'p', msd: 1000, br: [3000], ...spans(1000) }], [11_000, { e: 'ps', sta: 'a' }], [21_000, { e: 'ps', sta: 'p' }], [31_000, { e: 'ps', sta: 'q' }]],
    cid('pa'), { group: 'C', startup: 1000, outcome: 'started', playing: 20_000 });
  mk(`sk-${tag}`, UA_MAC, AU, [[0, { e: 'ps', sta: 's' }], [1000, { e: 'ps', sta: 'p', msd: 1000, br: [3000], ...spans(1000) }], [11_000, { e: 'ps', sta: 'k' }], [12_000, { e: 'ps', sta: 'p' }], [21_000, { e: 'ps', sta: 'q' }]],
    cid('sk'), { group: 'C', startup: 1000, outcome: 'started', playing: 19_000 });
  mk(`qu-${tag}`, UA_MAC, AU, [[0, { e: 'ps', sta: 's' }], [1000, { e: 'ps', sta: 'p', msd: 1000, br: [3000], ...spans(1000) }], [31_000, { e: 't', bl: [9000], xyz: 1 }]],
    cid('qu'), { group: 'C', startup: 1000, outcome: 'started', playing: 30_000 });
  mk(`pre-${tag}`, UA_MAC, AU, [[0, { e: 'ps', sta: 'd' }]], cid('pre'), { group: 'none', outcome: 'exited' });
  // the sequence gap: sn 3 never arrives
  mk(`gap-${tag}`, UA_MAC, AU, [[0, { e: 'ps', sta: 's' }], [1000, { e: 'ps', sta: 'p', msd: 1000, br: [3000], ...spans(1000) }], [5000, { e: 't' }], [11_000, { e: 'ps', sta: 'q' }]],
    cid('gap'), { group: 'C', startup: 1000, outcome: 'started', playing: 10_000 });
  viewers[viewers.length - 1].lines.splice(2, 1);
  // A late one: made five minutes ago, left before the first frame.
  {
    const sid = `late-${tag}`; const t = Date.now() - 5 * 60_000;
    viewers.push({ sid, ua: UA_MAC, geo: AU, lines: [{ ...cid('late'), sid, ts: t, sn: 1, e: 'ps', sta: 's' }, { v: 2, sid, cid: 'content-sport', st: 'v', ts: t + 3000, sn: 2, e: 'ps', sta: 'q' }], plan: { group: 'C', outcome: 'exited' } });
  }
  const counted = viewers.filter((v) => v.plan.group !== 'none');
  const started = counted.filter((v) => v.plan.outcome === 'started');

  // ---------------------------------------------------------------- server
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { generateKey } = await import('../src/services/apiKeys');
  const { signAccess } = await import('../src/auth/jwt');
  const adb = await import('../src/services/qoe/analyticsDb');
  const coll = await import('../src/services/qoe/collector');
  const raw = await import('../src/services/qoe/rawStore');
  const sk = await import('../src/services/qoe/sketch');
  const { replayRange } = await import('../src/services/qoe/replay');
  const { config } = await import('../src/config');

  // a fresh analytics database for this run
  const aurl = adb.analyticsUrl();
  const aname = new URL(aurl).pathname.slice(1);
  await query(`DROP DATABASE IF EXISTS "${aname}"`).catch(async () => {
    const { Client } = await import('pg'); const u = new URL(config.databaseUrl); u.pathname = '/postgres';
    const c = new Client({ connectionString: u.toString() }); await c.connect(); await c.query(`DROP DATABASE IF EXISTS "${aname}"`); await c.end();
  });

  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`qoe-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`qoe2-${tag}`]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
  const grp = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name, status) VALUES ($1,'Sport 1','live') RETURNING id`, [grp]))!.id;
  const app = await one<any>(`INSERT INTO apps(account_id, name, type, restrictions) VALUES ($1,'Web','web','{}') RETURNING id`, [acct]);
  const k = generateKey('publishable');
  await query(`INSERT INTO api_keys(account_id, app_id, kind, key_prefix, key_hash, scopes) VALUES ($1,$2,'publishable',$3,$4,'{playback}')`, [acct, app!.id, k.prefix, k.hash]);
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `qoe-${tag}@example.com`]))!.id;
  const user2 = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [other, `qoe2-${tag}@example.com`]))!.id;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' } as any);
  const tok2 = signAccess({ sub: user2, account_id: other, role: 'owner' } as any);

  const srv = createServer().listen(0);
  const baseUrl = `http://127.0.0.1:${(srv.address() as any).port}`;
  const post = (lines: string[], ua: string, geo: Record<string, string>) => fetch(`${baseUrl}/api/cmcd?appKey=${encodeURIComponent(k.raw)}`, { method: 'POST', headers: { 'content-type': 'application/cmcd', 'user-agent': ua, ...geo }, body: lines.join('\n') });
  const W = `from=${new Date(T0 - 86_400_000).toISOString()}&to=${new Date(T0 + 86_400_000).toISOString()}`;
  const get = async (path: string, t = tok) => { const r = await fetch(`${baseUrl}/api/analytics/qoe${path}`, { headers: { authorization: `Bearer ${t}` } }); return { status: r.status, body: await r.json().catch(() => null) as any }; };
  const sendAll = async (vs: Viewer[]) => {
    let accepted = 0;
    for (const v of vs) {
      const lines = v.lines.map(enc);
      const half = Math.ceil(lines.length / 2); // two POSTs per viewer, as a batching player would
      for (const part of [lines.slice(0, half), lines.slice(half)]) {
        if (!part.length) continue;
        const r = await post(part, v.ua, v.geo);
        if (r.status === 204) accepted += part.length; else console.log('  post', r.status, await r.text());
      }
    }
    return accepted;
  };

  try {
    console.log('== the analytics database is its own ==');
    ok(aname.endsWith('_qoe') && aname !== new URL(config.databaseUrl).pathname.slice(1), `separate database: ${aname}`);

    console.log('== simulated viewers through POST /api/cmcd ==');
    const total = viewers.reduce((n, v) => n + v.lines.length, 0);
    const accepted = await sendAll(viewers);
    ok(accepted === total, `every planted report accepted (${accepted}/${total})`);
    const bad = await post([`e=t,sn=1,ts=${Date.now()},v=2`, enc({ v: 2, sid: `x-${tag}`, e: 't', ts: Date.now(), sn: 1 })], UA_MAC, AU);
    ok(bad.status === 204, 'a POST with one report missing its sid: the valid one kept (204)');
    const rawLines = readdirSync(join(process.env.QOE_RAW_DIR!, acct)).flatMap((d) => readdirSync(join(process.env.QOE_RAW_DIR!, acct, d)).flatMap((f) => readFileSync(join(process.env.QOE_RAW_DIR!, acct, d, f), 'utf8').split('\n').filter(Boolean)));
    ok(rawLines.length === total + 1, `raw first: every accepted line is in the raw store (${rawLines.length})`);
    const firstRaw = JSON.parse(rawLines.find((l) => l.includes(`a000-${tag}`))!);
    ok(firstRaw.ctx?.cc === 'AU' && firstRaw.ctx?.asn === '1221' && /Macintosh/.test(firstRaw.ctx?.ua) && !JSON.stringify(firstRaw).includes('127.0.0.1'), 'raw rows carry the viewer context (user agent, country, ASN) and no IP', firstRaw.ctx);

    // views that went quiet are closed after 60 s of silence: move the collector's clock on
    await coll.flushQoe(Date.now() + 61_000);
    const st = coll.collectorState();
    ok(st.lastError == null && st.flushFailures === 0, 'the collector flushed to the analytics database', st);

    console.log('== report 1: playback success ==');
    const ov1 = await get(`/overview?${W}`);
    ok(ov1.status === 200, 'GET /api/analytics/qoe/overview 200', ov1.status);
    const s1 = ov1.body.success;
    const nStarted = started.length, nFailed = counted.filter((v) => v.plan.outcome === 'failed').length, nExited = counted.filter((v) => v.plan.outcome === 'exited').length;
    ok(s1.attempts === counted.length, `attempts ${s1.attempts} = ${counted.length} (a preload that never played is not a view)`);
    ok(s1.started === nStarted && s1.startupFailures === nFailed && s1.exitsBeforeFirstFrame === nExited, `started ${s1.started}/${nStarted}, failed ${s1.startupFailures}/${nFailed}, EBFF ${s1.exitsBeforeFirstFrame}/${nExited}`);
    ok(near(s1.startupSuccess, nStarted / counted.length, 1e-9) && near(s1.startupFailureRate, nFailed / counted.length, 1e-9), 'startup success and failure rates per attempt');
    ok(s1.fatalAfterStart === 2 && near(s1.failureAfterStartRate, 2 / nStarted, 1e-9), `failure after start per STARTED view: 2/${nStarted}`, [s1.fatalAfterStart, s1.failureAfterStartRate]);
    ok(s1.ebffByWait.from2to5s === 6 && s1.ebffByWait.from2to5s + s1.ebffByWait.under2s + s1.ebffByWait.from5to10s + s1.ebffByWait.over10s === nExited, 'EBFF split by how long they waited (5 TVs left after 4 s, the late one after 3 s)', s1.ebffByWait);
    const drm = s1.errors.find((e: any) => e.code === 'shaka-6007');
    ok(drm && drm.step === 'drm' && drm.phase === 'before_start' && drm.views === 10 && drm.sessions === 10, 'the licence failures: code, step drm, before start, 10 views, 10 sessions', s1.errors);
    ok(s1.errors.some((e: any) => e.code === 'http-404' && e.step === 'segment' && e.phase === 'after_start' && e.views === 2), 'the fatal segment errors after start');

    console.log('== report 2: startup ==');
    const su = ov1.body.startup;
    const ups = started.map((v) => v.plan.startup!);
    ok(su.views === ups.length, `startup over started views only (${su.views})`);
    ok(su.startup.p50 === nr(ups, 0.5) && su.startup.p95 === nr(ups, 0.95) && su.startup.p99 === nr(ups, 0.99), `play-to-first-frame p50/p95/p99 ${su.startup.p50}/${su.startup.p95}/${su.startup.p99} = ${nr(ups, 0.5)}/${nr(ups, 0.95)}/${nr(ups, 0.99)}`);
    const ent = su.breakdown.find((b: any) => b.span === 'entitlement'), oth = su.breakdown.find((b: any) => b.span === 'other');
    ok(ent.p50 === 100 && ent.views === ups.length && oth.p99 === nr(ups.map((x) => x - 300), 0.99), 'startup breakdown: entitlement 100 ms, other = the rest', [ent, oth]);
    ok(su.slowSessions === 5, 'sessions that waited 2 s or more for the first frame: the 5 slow TVs', su.slowSessions);

    console.log('== report 3: buffering ==');
    const bu = ov1.body.buffering;
    const stalled = started.filter((v) => (v.plan.stalls ?? 0) > 0);
    const reb = started.reduce((n, v) => n + (v.plan.rebuffer ?? 0), 0), play = started.reduce((n, v) => n + (v.plan.playing ?? 0), 0);
    ok(bu.viewsWithStalls === stalled.length && bu.stalls === stalled.length, `views with stalls ${bu.viewsWithStalls} = ${stalled.length}`);
    ok(bu.rebufferMs === reb && bu.playingMs === play, `rebuffering ${bu.rebufferMs} = ${reb} ms, playing ${bu.playingMs} = ${play} ms (paused, backgrounded, seeking and startup left out)`);
    ok(near(bu.rebufferRatio, reb / (play + reb), 1e-9), `rebuffer ratio ${bu.rebufferRatio?.toFixed(5)}`);
    const tfs = stalled.map((v) => v.plan.firstStall!);
    ok(bu.timeToFirstStall.p50 === nr(tfs, 0.5) && bu.timeToFirstStall.p95 === nr(tfs, 0.95), 'time to first stall p50/p95', bu.timeToFirstStall);
    ok(bu.seeks === 1 && bu.avgSeekMs === 1000, 'the seek is a seek (1, 1 s), not a stall', [bu.seeks, bu.avgSeekMs]);
    ok(bu.stalledSessions === stalled.length, 'affected sessions', bu.stalledSessions);

    console.log('== report 4: quality and ABR ==');
    const qu = ov1.body.quality;
    ok(qu.switches === 10 && qu.oscillations === 5, `switches 10 and oscillations 5 (down then back within 10 s, five viewers): ${qu.switches}/${qu.oscillations}`);
    // time-weighted bitrate, by the plan: every started viewer at 3000 except the switchers' 5 s at 1500 and the TVs at 1200
    let kms = 0, ms = 0;
    for (const v of started) {
      const p = v.plan.playing!;
      if (v.plan.group === 'B') { kms += 1200 * p; ms += p; continue; }
      const sw = v.sid.startsWith('a') && Number(v.sid.slice(1, 4)) % 20 === 0;
      kms += 3000 * (p - (sw ? 5000 : 0)) + (sw ? 1500 * 5000 : 0); ms += p;
    }
    ok(qu.timeWeightedKbps === Math.round(kms / ms), `time-weighted bitrate ${qu.timeWeightedKbps} = ${Math.round(kms / ms)} kbps`);
    ok(qu.belowScreenShare != null && qu.belowScreenShare > 0 && qu.belowScreenShare < 0.01, 'time under what the screen can use: the switchers\' 5 s', qu.belowScreenShare);

    console.log('== report 10: engagement ==');
    const en = ov1.body.engagement;
    ok(en.views === counted.length && Math.abs(en.playingHours - play / 3_600_000) < 1e-9, `views by start ${en.views}, playing hours ${en.playingHours.toFixed(4)}`);
    ok(en.exitAfterStall === 5 && en.exitAfterError === 0, 'left within 30 s of a stall: the 5 TVs (the A stalls were 38 s before the end)', [en.exitAfterStall, en.exitAfterError]);
    ok(en.byContent[0]?.contentId === 'content-sport' && en.byContent.some((c: any) => c.contentId === 'content-film'), 'per content', en.byContent.map((c: any) => c.contentId));

    console.log('== report 12: telemetry health ==');
    const te = ov1.body.telemetry;
    const evs = counted.reduce((n, v) => n + v.lines.length, 0);
    ok(te.reports === evs && te.missingReports === 1 && te.viewsWithLoss === 1, `reports ${te.reports}/${evs}, the missing sn found (${te.missingReports})`);
    ok(near(te.eventLoss, 1 / (evs + 1), 1e-9), 'event loss = missing / expected', te.eventLoss);
    ok(te.lateReports === 2, 'the two late reports (made 5 minutes before they arrived)', te.lateReports);
    ok(te.unknownKeys.some((x: any) => x.key === 'xyz' && x.reports === 1), 'unknown keys counted', te.unknownKeys);
    ok(te.collector.rejected === 1 && te.collector.reasons['sid missing'] === 1 && te.collector.accepted === total + 1, 'the collector\'s refusal counted with its reason', te.collector);

    console.log('== the bad release, isolated by its filters ==');
    const fb = await get(`/overview?${W}&app_version=2.1.0`);
    ok(fb.body.success.attempts === 20 && fb.body.success.startupFailureRate === 0.5 && fb.body.success.ebffRate === 0.25, 'app_version=2.1.0: 20 attempts, half fail, a quarter leave', fb.body.success);
    const fg = await get(`/overview?${W}&app_version=2.0.0`);
    ok(fg.body.success.startupFailures === 0 && fg.body.startup.startup.p95 === nr(started.filter((v) => v.plan.group !== 'B').map((v) => v.plan.startup!), 0.95), 'app_version=2.0.0: no failures, its own p95', [fg.body.success.startupFailures, fg.body.startup.startup.p95]);
    const fd = await get(`/overview?${W}&device_model=BadTV%20QN90`);
    const fo = await get(`/overview?${W}&os=Tizen`);
    const fc = await get(`/overview?${W}&country=MY&device_class=TV`);
    ok(fd.body.success.attempts === 20 && fo.body.success.attempts === 20 && fc.body.success.attempts === 20, 'device model, OS (Tizen, from the user agent) and country with device class each isolate it', [fd.body.success.attempts, fo.body.success.attempts, fc.body.success.attempts]);
    const fl = await get(`/overview?${W}&stream_type=live`);
    ok(fl.body.success.attempts === 0, 'stream_type=live: none (all on demand)');
    const bd = await get(`/breakdown?${W}&by=app_version&measure=failure&minViews=10`);
    ok(bd.status === 200 && bd.body.rows[0]?.value === '2.1.0' && bd.body.rows[0].measure === 0.5 && bd.body.rows[0].affected === 20, 'breakdown by app version, ranked by failure rate: 2.1.0 is the worst segment', bd.body.rows);
    const bs = await get(`/breakdown?${W}&by=browser&measure=startup_p95&minViews=10`);
    ok(bs.body.rows.length === 2 && bs.body.rows[0].value === null && bs.body.rows[0].measure === 4000, 'breakdown by browser on startup p95: the TV (no browser parsed) first at 4000 ms', bs.body.rows);
    const bdx = await get(`/breakdown?${W}&by=password&measure=failure`);
    ok(bdx.status === 400, 'an unknown dimension is refused (400)', bdx.status);
    const dims = await get(`/dimensions?${W}`);
    ok(dims.body.app_version?.length === 2 && dims.body.os?.some((x: any) => x.value === 'macOS') && dims.body.country?.some((x: any) => x.value === 'MY'), 'the filter values seen', { a: dims.body.app_version, os: dims.body.os });
    const iso = await get(`/overview?${W}`, tok2);
    ok(iso.body.success.attempts === 0, 'another account sees none of it');

    console.log('== minute sketches ==');
    const se = await get(`/series?${W}`);
    const startsSum = se.body.points.reduce((n: number, p: any) => n + p.starts, 0);
    ok(startsSum === nStarted && se.body.points.reduce((n: number, p: any) => n + p.attempts, 0) === counted.length, `the minute aggregates add up to the views (${startsSum} starts)`);
    const withStarts = se.body.points.filter((p: any) => p.starts > 0);
    ok(withStarts.length === 1 && near(withStarts[0].startupP50, nr(ups, 0.5)) && near(withStarts[0].startupP95, nr(ups, 0.95)) && near(withStarts[0].startupP99, nr(ups, 0.99)),
      `sketch p50/p95/p99 ${withStarts[0]?.startupP50}/${withStarts[0]?.startupP95}/${withStarts[0]?.startupP99} within 1 % of exact ${nr(ups, 0.5)}/${nr(ups, 0.95)}/${nr(ups, 0.99)}`);
    {
      const s: any = {}, s2: any = {}, s3: any = {}; const vals: number[] = [];
      for (let i = 0; i < 20000; i++) { const x = Math.round(Math.exp(Math.random() * 10)); vals.push(x); sk.add(i % 2 ? s2 : s3, x); sk.add(s, x); }
      sk.merge(s2, s3);
      ok([0.5, 0.95, 0.99].every((q) => near(sk.quantile(s, q), nr(vals, q)) && sk.quantile(s2, q) === sk.quantile(s, q)), 'DDSketch: 20 000 values over four decades within 1 %, and two merged halves answer exactly as one');
    }
    const seCountry = await get(`/series?${W}&country=MY&app_version=2.1.0`);
    ok(seCountry.body.points.reduce((n: number, p: any) => n + p.attempts, 0) === 20 && seCountry.body.ignoredFilters.includes('app_version'), 'series honours the minute dimensions and says which filters it left out');

    console.log('== delete the derived rows, replay, identical reports ==');
    const snap = async () => JSON.stringify([(await get(`/overview?${W}`)).body, (await get(`/series?${W}`)).body, (await get(`/breakdown?${W}&by=app_version&measure=failure&minViews=1`)).body, (await get(`/overview?${W}&os=Tizen`)).body]);
    const before = await snap();
    await adb.aquery(`DELETE FROM qoe_views`); await adb.aquery(`DELETE FROM qoe_minutes`);
    ok((await get(`/overview?${W}`)).body.success.attempts === 0, 'derived rows deleted: the reports are empty');
    const days = [...new Set([T0 - 86_400_000, T0, Date.now() - 5 * 60_000].map((t) => new Date(t).toISOString().slice(0, 10)))].sort();
    const rr = await replayRange(days[0], days[days.length - 1], acct);
    ok(rr.reduce((n, r) => n + r.views, 0) === counted.length, `replay rebuilt ${rr.reduce((n, r) => n + r.views, 0)} views from ${rr.reduce((n, r) => n + r.rawReports, 0)} raw reads`, rr);
    const after = await snap();
    ok(after === before, 'every report identical after the replay', after === before ? undefined : { before: before.slice(0, 400), after: after.slice(0, 400) });
    await replayRange(days[0], days[days.length - 1], acct);
    ok((await snap()) === before, 'and identical after replaying a second time (idempotent)');
    const pr = await fetch(`${baseUrl}/api/analytics/qoe/replay`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ day: days[days.length - 1] }) });
    const prb: any = await pr.json();
    ok(pr.status === 200 && prb.results?.[0]?.account === acct && (await snap()) === before, 'POST /replay (the console) does the same, for the caller\'s account only', [pr.status, prb]);
    const [{ v: defv }] = await adb.aquery(`SELECT min(def_version) || '-' || max(def_version) AS v FROM qoe_views`);
    ok(defv === '1-1', 'every row stamped with the definitions version', defv);

    console.log('== the analytics database goes away mid-run ==');
    await query(`ALTER DATABASE "${aname}" ALLOW_CONNECTIONS false`);
    await query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [aname]);
    await sleep(200);
    const more: Viewer[] = [];
    for (let i = 0; i < 10; i++) {
      const sid = `d${i}-${tag}`; const msd = 700 + i;
      more.push({ sid, ua: UA_MAC, geo: AU, plan: { group: 'D', startup: msd, outcome: 'started', playing: 20_000 },
        lines: [{ ...base(sid, 'Volt Web', '2.0.0', 'MacIntel', 'content-sport'), ts: T0 + 100, sn: 1, e: 'ps', sta: 's' }, { v: 2, sid, cid: 'content-sport', st: 'v', ts: T0 + 100 + msd, sn: 2, e: 'ps', sta: 'p', msd, br: [3000] }, { v: 2, sid, cid: 'content-sport', st: 'v', ts: T0 + 100 + msd + 20_000, sn: 3, e: 'ps', sta: 'q' }] });
    }
    const t1 = Date.now();
    const acc2 = await sendAll(more);
    ok(acc2 === 30, `reports still accepted while it is down (${acc2}/30, 204 each)`);
    const ga = Date.now();
    const gate = await fetch(`${baseUrl}/api/availability`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appKey: k.raw, assetId: ch }) });
    const gateMs = Date.now() - ga;
    ok(gate.status === 200 && gateMs < 1000, `the play gate answers while it is down (${gate.status}, ${gateMs} ms): stream starts unaffected`);
    await coll.flushQoe(Date.now() + 61_000);
    const down = coll.collectorState();
    ok(down.flushFailures >= 1 && down.pendingViews >= 10, 'the flush failed and the views are held, not dropped', down);
    const downReport = await get(`/overview?${W}`);
    ok(downReport.status >= 500, `the reports say they cannot answer (${downReport.status}) rather than answer wrong`);
    await query(`ALTER DATABASE "${aname}" ALLOW_CONNECTIONS true`);
    await coll.flushQoe(Date.now() + 62_000);
    const up = coll.collectorState();
    ok(up.pendingViews === 0 && up.lastError == null, 'back up: the held writes went in', up);
    const ovAfter = (await get(`/overview?${W}`)).body;
    ok(ovAfter.success.attempts === counted.length + 10 && ovAfter.success.started === nStarted + 10, `nothing lost: ${ovAfter.success.attempts} attempts (${counted.length} + 10)`);
    const live = await snap();
    await replayRange(days[0], days[days.length - 1], acct);
    ok((await snap()) === live, 'and what the collector wrote after the outage equals a replay of the raw reports');
    ok(Date.now() - t1 < 30_000, 'the outage drill took under 30 s');

    console.log('== the S3 raw path (stand-in client) ==');
    {
      const objects = new Map<string, Buffer>();
      const s3 = { send: async (c: any) => {
        const n = c.constructor.name, i = c.input;
        if (n === 'PutObjectCommand') { objects.set(i.Key, Buffer.from(i.Body)); return {}; }
        if (n === 'ListObjectsV2Command') {
          if (i.Delimiter) { const ps = new Set<string>(); for (const key of objects.keys()) if (key.startsWith(i.Prefix)) ps.add(i.Prefix + key.slice(i.Prefix.length).split('/')[0] + '/'); return { CommonPrefixes: [...ps].map((p) => ({ Prefix: p })) }; }
          return { Contents: [...objects.keys()].filter((key) => key.startsWith(i.Prefix)).map((Key) => ({ Key })) };
        }
        if (n === 'GetObjectCommand') { const b = objects.get(i.Key)!; return { Body: { transformToByteArray: async () => new Uint8Array(b) } }; }
        throw new Error('unexpected ' + n);
      } };
      raw.setRawS3Client(s3);
      process.env.QOE_RAW_BUCKET = 'volt-qoe-raw-test';
      const now = Date.now();
      await raw.appendRaw(acct, [{ rt: now, app: null, sid: 's3-a', e: 't', line: 'e=t,sid="s3-a",sn=1,ts=1,v=2' }]);
      await raw.appendRaw(acct, [{ rt: now, app: null, sid: 's3-b', e: 't', line: 'e=t,sid="s3-b",sn=1,ts=1,v=2' }]);
      ok(objects.size === 0, 'appendRaw buffers: no PUT per POST');
      await raw.flushRawS3();
      const keys = [...objects.keys()];
      const day = new Date(now).toISOString().slice(0, 10);
      ok(keys.length === 1 && keys[0].startsWith(`qoe-raw/${acct}/${day}/`) && keys[0].endsWith('.ndjson.gz'), 'one gzipped object for the partition', keys);
      const body = gunzipSync(objects.get(keys[0])!).toString('utf8').trim().split('\n');
      ok(body.length === 2 && JSON.parse(body[1]).sid === 's3-b', 'holding both lines, whole');
      const back = await raw.readDay(acct, day);
      const accts = await raw.accountsOnDay(day);
      ok(back.length === 2 && accts.includes(acct), 'read back by day partition (what a replay reads)');
      delete process.env.QOE_RAW_BUCKET; raw.setRawS3Client(null);
    }

    console.log('== Terraform: the raw archive ==');
    {
      const tf = readFileSync(join(ROOT, '../deploy/terraform/qoe_raw.tf'), 'utf8');
      ok(/object_lock_enabled\s*=\s*true/.test(tf) && /mode\s*=\s*"GOVERNANCE"/.test(tf), 'Object Lock on, governance mode');
      ok(/aws_s3_bucket_versioning"[\s\S]*?status\s*=\s*"Enabled"/.test(tf), 'versioning on');
      ok(/days\s*=\s*30[\s\S]*?storage_class\s*=\s*"GLACIER_IR"[\s\S]*?days\s*=\s*90[\s\S]*?storage_class\s*=\s*"DEEP_ARCHIVE"/.test(tf), 'lifecycle: 30 days to Glacier Instant Retrieval, 90 days to Deep Archive');
      ok(/expiration\s*\{[\s\S]*?days\s*=\s*var\.qoe_raw_retention_days/.test(tf) && /block_public_acls\s*=\s*true/.test(tf), 'expiry from a variable (25 months by default); no public access');
      const vars = readFileSync(join(ROOT, '../deploy/terraform/variables.tf'), 'utf8');
      ok(/variable "qoe_raw_retention_days"[\s\S]*?default\s*=\s*760/.test(vars), 'the retention default is 760 days');
    }
  } catch (e) {
    fail++; console.log('FAIL unexpected: ' + ((e as Error).stack ?? e));
  } finally {
    srv.close();
    await adb.closeAnalytics();
    await query(`ALTER DATABASE "${aname}" ALLOW_CONNECTIONS true`).catch(() => {});
    await pool.end().catch(() => {});
    try {
      const { Client } = await import('pg'); const u = new URL(config.databaseUrl); u.pathname = '/postgres';
      const c = new Client({ connectionString: u.toString() }); await c.connect(); await c.query(`DROP DATABASE IF EXISTS "${aname}" WITH (FORCE)`); await c.end();
    } catch { /* left for inspection */ }
  }
  try { rmSync(process.env.QOE_RAW_DIR!, { recursive: true, force: true }); } catch { /* */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
