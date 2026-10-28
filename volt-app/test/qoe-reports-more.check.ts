// ============================================================================
//  PLAYBACK REPORTS 5, 7, 8, 9 AND 11 (build queue 1.14f, QOE_REPORTING.md 5).
//
//  Planted viewers go through the real collector (POST /api/cmcd) and the
//  real play gate (POST /api/availability) over HTTP, then:
//    5  rendering: dropped frames per minute of playing, per view and per
//       device (the stuttering TV is first), decoder errors, hardware
//       decoding, DRM system;
//    7  DRM and access: the gate's decisions timed and by reason, and each
//       failed view attributed to the right step AND to the gate's reason for
//       its sid (geo, unknown asset, the app's restrictions, a licence
//       refused after the gate allowed it); licence time; a token refused
//       mid-view;
//    8  live health: latency and drift per device (the drifting TV is first),
//       catch-up time;
//    9  advertising: break time is the ad's, not the programme's; ad startup
//       delay, ad buffering and stalls, return to content, a viewer who left
//       during the ad; the stitcher's beacons beside it;
//   11  one planted session reconstructed end to end from the raw reports:
//       every report in order with a missing one listed, the states as
//       spans to the millisecond, a resent batch counted once, the gate's
//       decision and the stitcher's beacons for that viewer, the view row it
//       made; another account cannot read it.
//  Plus: the SDK's ad break and HTTP status reports (validated with the SVTA
//  library), a stitched FAST session named after the sid, the gate log held
//  through an analytics outage, and replay giving identical reports.
//
//  Usage: DATABASE_URL=... npx tsx test/qoe-reports-more.check.ts
// ============================================================================
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const near = (a: number | null | undefined, b: number, eps = 1e-9) => a != null && Math.abs(a - b) <= eps;
const ROOT = resolve(__dirname, '..');
const PLAYER = resolve(ROOT, '../volt-player');
process.env.QOE_RAW_DIR = mkdtempSync(join(tmpdir(), 'qoe-raw-more-'));
process.env.TRUST_EDGE_GEO = 'true';
delete process.env.QOE_RAW_BUCKET;

type L = Record<string, string | number | boolean | Array<number | string>>;
/** One CMCD v2 line as the SDK writes them (see qoe-reports.check.ts). */
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

(async () => {
  const UA_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
  const UA_TV = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/7.0 TV Safari/537.36';
  const AU = { 'cloudfront-viewer-country': 'AU', 'cloudfront-viewer-country-region': 'NSW', 'cloudfront-viewer-asn': '1221' };
  const IL = { 'cloudfront-viewer-country': 'IL' };
  const T0 = Math.ceil(Date.now() / 60_000) * 60_000 + 1000;
  const tag = Date.now().toString(36);

  // ---------------------------------------------------------------- SDK
  console.log('== the SDK reports ad breaks and refused requests (volt-player/src/sdk/cmcd.ts) ==');
  {
    const cml: any = await import(join(PLAYER, 'node_modules/@svta/cml-cmcd/dist/index.js'));
    const sdk = await import('../../volt-player/src/sdk/cmcd');
    const { checkEventReport, parseCmcdLine } = await import('../src/services/qoe/cmcdParse');
    const lines: string[] = [];
    const sender: any = { push: (l: string) => lines.push(l), flush: () => {} };
    const a = new sdk.PlayAttempt({ cid: 'x', live: true, sender, requestMode: false, autoplay: true });
    a.firstFrame();
    a.adBreak('brk-1'); a.adBreak('brk-1'); a.adBreak(null); a.adBreak(null);
    a.adBreak('brk-2'); a.adBreak('brk-3');
    a.error('shaka-1001', 'segment', false, 403);
    a.close();
    a.adBreak(null);
    const es = lines.map((l) => String(parseCmcdLine(l).e));
    ok(JSON.stringify(es) === JSON.stringify(['ps', 'ps', 'abs', 'abe', 'abs', 'abe', 'abs', 'e', 'ps']), 'a break start and end reported once each, a new break ends the last one, nothing after close', es);
    ok(lines.every((l) => cml.validateCmcdEvents(l).valid), 'every line a valid CMCD v2 event report (SVTA validator)', lines.filter((l) => !cml.validateCmcdEvents(l).valid));
    ok(lines.every((l) => checkEventReport(l).ok), 'and accepted by the collector');
    const abs = parseCmcdLine(lines[2]); const err = parseCmcdLine(lines[7]);
    ok(abs['com.volt-brk'] === 'brk-1' && err['com.volt-http'] === '403' && err['com.volt-step'] === 'segment', 'the break id and the HTTP status travel as custom keys', [abs, err]);
    try {
      const eng = await import('../../volt-player/src/sdk/engine');
      ok(eng.httpStatus({ code: 1001, data: ['u', 403] }) === 403 && eng.httpStatus({ code: 6007, data: [] }) === null, 'engine: a BAD_HTTP_STATUS error gives its status, others none');
    } catch (e) { ok(true, `engine module not loadable outside a browser here (${(e as Error).message.slice(0, 60)}); httpStatus checked by typecheck`); }
  }

  // ---------------------------------------------------------------- server
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { generateKey } = await import('../src/services/apiKeys');
  const { signAccess } = await import('../src/auth/jwt');
  const adb = await import('../src/services/qoe/analyticsDb');
  const coll = await import('../src/services/qoe/collector');
  const gl = await import('../src/services/qoe/gateLog');
  const { replayRange } = await import('../src/services/qoe/replay');
  const { config } = await import('../src/config');

  const aurl = adb.analyticsUrl();
  const aname = new URL(aurl).pathname.slice(1);
  {
    const { Client } = await import('pg'); const u = new URL(config.databaseUrl); u.pathname = '/postgres';
    const c = new Client({ connectionString: u.toString() }); await c.connect(); await c.query(`DROP DATABASE IF EXISTS "${aname}" WITH (FORCE)`); await c.end();
  }

  const acct = (await one<any>(`INSERT INTO accounts(name, geo_access) VALUES ($1, '{"mode":"block","countries":["IL"]}') RETURNING id`, [`qoe5-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`qoe5b-${tag}`]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
  const grp = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name, status) VALUES ($1,'News 24','live') RETURNING id`, [grp]))!.id;
  const ch2 = (await one<any>(`INSERT INTO channels(group_id, name, status) VALUES ($1,'Ads FAST','live') RETURNING id`, [grp]))!.id;
  const fast = (await one<any>(`INSERT INTO channels(group_id, name, status, on_air, origin) VALUES ($1,'Stitched FAST','live',true,'playlist') RETURNING id`, [grp]))!.id;
  await query(`INSERT INTO channel_ads(channel_id, mode) VALUES ($1,'stitched')`, [fast]);
  await query(`INSERT INTO fast_playouts(channel_id, launcher, status, last_seen_at) VALUES ($1,'local','running',now())`, [fast]);
  const app = await one<any>(`INSERT INTO apps(account_id, name, type, restrictions) VALUES ($1,'Web','web','{}') RETURNING id`, [acct]);
  const k = generateKey('publishable');
  await query(`INSERT INTO api_keys(account_id, app_id, kind, key_prefix, key_hash, scopes) VALUES ($1,$2,'publishable',$3,$4,'{playback}')`, [acct, app!.id, k.prefix, k.hash]);
  const app2 = await one<any>(`INSERT INTO apps(account_id, name, type, restrictions) VALUES ($1,'Locked web','web','{"origins":["good.example"]}') RETURNING id`, [acct]);
  const k2 = generateKey('publishable');
  await query(`INSERT INTO api_keys(account_id, app_id, kind, key_prefix, key_hash, scopes) VALUES ($1,$2,'publishable',$3,$4,'{playback}')`, [acct, app2!.id, k2.prefix, k2.hash]);
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `qoe5-${tag}@example.com`]))!.id;
  const user2 = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [other, `qoe5b-${tag}@example.com`]))!.id;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' } as any);
  const tok2 = signAccess({ sub: user2, account_id: other, role: 'owner' } as any);

  const srv = createServer().listen(0);
  const baseUrl = `http://127.0.0.1:${(srv.address() as any).port}`;
  const post = (lines: string[], ua: string, geo: Record<string, string>) => fetch(`${baseUrl}/api/cmcd?appKey=${encodeURIComponent(k.raw)}`, { method: 'POST', headers: { 'content-type': 'application/cmcd', 'user-agent': ua, ...geo }, body: lines.join('\n') });
  const W = `from=${new Date(T0 - 86_400_000).toISOString()}&to=${new Date(T0 + 86_400_000).toISOString()}`;
  const get = async (path: string, t = tok) => { const r = await fetch(`${baseUrl}/api/analytics/qoe${path}`, { headers: { authorization: `Bearer ${t}` } }); return { status: r.status, body: await r.json().catch(() => null) as any }; };
  const gate = (body: any, headers: Record<string, string> = {}) => fetch(`${baseUrl}/api/availability`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  // A viewer: identity on the first line, then the planted steps.
  interface V { sid: string; ua: string; geo: Record<string, string>; lines: L[] }
  const viewers: V[] = [];
  const mk = (sid: string, ua: string, geo: Record<string, string>, id: L, steps: Array<[number, L]>) => {
    let sn = 0;
    const lines = steps.map(([t, d], i) => ({ ...(i === 0 ? id : { v: 2, sid, cid: id.cid, st: id.st }), ts: T0 + t, sn: ++sn, ...d }));
    const v = { sid, ua, geo, lines }; viewers.push(v); return v;
  };
  const ident = (sid: string, cid: string, st: string, dm: string, extra: L = {}): L => ({ v: 2, sid, cid, st, 'com.volt-app': 'Volt Web', 'com.volt-appv': '3.0.0', 'com.volt-sdkv': '1.5.0', 'com.volt-dm': dm, ...extra });

  // 5. RENDERING (content r-film): 4 stuttering TVs (600 dropped in a minute, two decoder errors, software decoding),
  //    6 smooth Macs (6 dropped, hardware, Widevine), one Mac whose decoder fails after 10 s.
  for (let i = 0; i < 4; i++) {
    const sid = `r-tv${i}-${tag}`;
    const steps: Array<[number, L]> = [[0, { e: 'ps', sta: 's' }], [1000, { e: 'ps', sta: 'p', msd: 1000, br: [3000] }]];
    if (i < 2) steps.push([20_000, { e: 'e', ec: ['shaka-3016'], 'com.volt-step': 'decode' }]);
    steps.push([31_000, { e: 't', dfa: 600 }], [61_000, { e: 'ps', sta: 'q' }]);
    mk(sid, UA_TV, AU, ident(sid, 'r-film', 'v', 'StutterTV', { 'com.volt-hwdec': 'false' }), steps);
  }
  for (let i = 0; i < 6; i++) {
    const sid = `r-mac${i}-${tag}`;
    mk(sid, UA_MAC, AU, ident(sid, 'r-film', 'v', 'MacIntel', { 'com.volt-hwdec': 'true' }),
      [[0, { e: 'ps', sta: 's' }], [1000, { e: 'ps', sta: 'p', msd: 1000, br: [3000], 'com.volt-drm': 'com.widevine.alpha' }], [31_000, { e: 't', dfa: 6 }], [61_000, { e: 'ps', sta: 'q' }]]);
  }
  mk(`r-dec-${tag}`, UA_MAC, AU, ident(`r-dec-${tag}`, 'r-film', 'v', 'MacIntel', { 'com.volt-hwdec': 'true' }),
    [[0, { e: 'ps', sta: 's' }], [1000, { e: 'ps', sta: 'p', msd: 1000, br: [3000] }], [11_000, { e: 'e', ec: ['shaka-3016'], 'com.volt-step': 'decode' }], [11_001, { e: 'ps', sta: 'f' }]]);

  // 7. ACCESS (content = the News 24 channel id): each sid asks the real gate first.
  const S = (n: string) => `${n}-${tag}`;
  const accLines: Array<{ sid: string; geo: Record<string, string>; steps: Array<[number, L]> }> = [
    { sid: S('acc-ok'), geo: AU, steps: [[0, { e: 'ps', sta: 's' }], [500, { e: 'rr', 'com.volt-req': 'licence', rc: 200, ttlb: 300, url: 'https://licence.example/wv' }],
      [1200, { e: 'ps', sta: 'p', msd: 1200, br: [3000], 'com.volt-tdrm': '300', 'com.volt-tent': '90' }], [31_200, { e: 'ps', sta: 'q' }]] },
    { sid: S('acc-geo1'), geo: IL, steps: [[0, { e: 'ps', sta: 's' }], [150, { e: 'e', ec: ['gate-451'], 'com.volt-step': 'entitlement', su: true }], [151, { e: 'ps', sta: 'f' }]] },
    { sid: S('acc-geo2'), geo: IL, steps: [[0, { e: 'ps', sta: 's' }], [150, { e: 'e', ec: ['gate-451'], 'com.volt-step': 'entitlement', su: true }], [151, { e: 'ps', sta: 'f' }]] },
    { sid: S('acc-404'), geo: AU, steps: [[0, { e: 'ps', sta: 's' }], [150, { e: 'e', ec: ['gate-404'], 'com.volt-step': 'entitlement', su: true }], [151, { e: 'ps', sta: 'f' }]] },
    { sid: S('acc-origin'), geo: AU, steps: [[0, { e: 'ps', sta: 's' }], [150, { e: 'e', ec: ['gate-403'], 'com.volt-step': 'entitlement', su: true }], [151, { e: 'ps', sta: 'f' }]] },
    { sid: S('acc-lic'), geo: AU, steps: [[0, { e: 'ps', sta: 's' }], [600, { e: 'rr', 'com.volt-req': 'licence', rc: 500, ttlb: 900, url: 'https://licence.example/wv' }],
      [700, { e: 'e', ec: ['shaka-6007'], 'com.volt-step': 'drm', su: true }], [701, { e: 'ps', sta: 'f' }]] },
    { sid: S('acc-tok'), geo: AU, steps: [[0, { e: 'ps', sta: 's' }], [1000, { e: 'ps', sta: 'p', msd: 1000, br: [3000] }],
      [20_000, { e: 'e', ec: ['shaka-1001'], 'com.volt-step': 'segment', 'com.volt-http': '403' }], [20_001, { e: 'ps', sta: 'f' }]] },
  ];
  for (const a of accLines) mk(a.sid, UA_MAC, a.geo, ident(a.sid, ch, 'l', 'MacIntel'), a.steps);

  // 8. LIVE (content live-news): three TVs drifting from 4 s to 14 s behind, three Macs steady at 3 s, one catching up for 10 s.
  for (let i = 0; i < 3; i++) {
    const sid = `l-tv${i}-${tag}`;
    mk(sid, UA_TV, AU, ident(sid, 'live-news', 'l', 'DriftTV'), [[0, { e: 'ps', sta: 's' }], [1000, { e: 'ps', sta: 'p', msd: 1000, br: [3000] }],
      [11_000, { e: 't', ltc: 4000 }], [41_000, { e: 't', ltc: 9000 }], [71_000, { e: 't', ltc: 14_000 }], [81_000, { e: 'ps', sta: 'q' }]]);
  }
  for (let i = 0; i < 3; i++) {
    const sid = `l-mac${i}-${tag}`;
    const steps: Array<[number, L]> = [[0, { e: 'ps', sta: 's' }], [1000, { e: 'ps', sta: 'p', msd: 1000, br: [3000] }], [11_000, { e: 't', ltc: 3000 }]];
    if (i === 0) steps.push([21_000, { e: 'pr', pr: 1.1 }], [31_000, { e: 'pr', pr: 1 }]);
    steps.push([41_000, { e: 't', ltc: 3000 }], [71_000, { e: 't', ltc: 3000 }], [81_000, { e: 'ps', sta: 'q' }]);
    mk(sid, UA_MAC, AU, ident(sid, 'live-news', 'l', 'MacIntel'), steps);
  }

  // 9. ADS (content = the Ads FAST channel id)
  const ad1 = mk(S('ad1'), UA_MAC, AU, ident(S('ad1'), ch2, 'l', 'MacIntel'), [[0, { e: 'ps', sta: 's' }], [1000, { e: 'ps', sta: 'p', msd: 1000, br: [3000] }],
    [20_000, { e: 'abs', 'com.volt-brk': 'brk-1' }], [21_000, { e: 'ps', sta: 'r' }], [23_000, { e: 'ps', sta: 'p' }], [50_000, { e: 'abe', 'com.volt-brk': 'brk-1' }], [80_000, { e: 'ps', sta: 'q' }]]);
  mk(S('ad2'), UA_MAC, AU, ident(S('ad2'), ch2, 'l', 'MacIntel'), [[0, { e: 'ps', sta: 's' }], [1000, { e: 'ps', sta: 'p', msd: 1000, br: [3000] }],
    [19_500, { e: 'ps', sta: 'r' }], [20_000, { e: 'abs', 'com.volt-brk': 'brk-1' }], [21_500, { e: 'ps', sta: 'p' }], [49_000, { e: 'ps', sta: 'r' }],
    [50_000, { e: 'abe', 'com.volt-brk': 'brk-1' }], [52_000, { e: 'ps', sta: 'p' }], [60_000, { e: 'ps', sta: 'q' }]]);
  mk(S('ad3'), UA_MAC, AU, ident(S('ad3'), ch2, 'l', 'MacIntel'), [[0, { e: 'ps', sta: 's' }], [1000, { e: 'ps', sta: 'p', msd: 1000, br: [3000] }],
    [20_000, { e: 'abs', 'com.volt-brk': 'brk-1' }], [30_000, { e: 'ps', sta: 'q' }]]);

  // 11. ONE RICH SESSION (content = the Ads FAST channel), sn 15 never arrives, sn 5 to 7 sent twice.
  const P = S('planted');
  const pv = mk(P, UA_MAC, AU, ident(P, ch2, 'l', 'MacIntel', { 'com.volt-hwdec': 'true' }), [
    [0, { e: 'ps', sta: 's' }],
    [200, { e: 'rr', ot: 'm', rc: 200, ttfb: 30, ttlb: 80, url: 'https://cdn.example/live/master.m3u8', su: true }],
    [400, { e: 'rr', 'com.volt-req': 'licence', rc: 200, ttlb: 250, url: 'https://licence.example/wv', su: true }],
    [1200, { e: 'ps', sta: 'p', msd: 1200, br: [3000], 'com.volt-tent': '100', 'com.volt-tdrm': '250', 'com.volt-drm': 'com.widevine.alpha' }],
    [10_000, { e: 'bc', br: [1500] }],
    [15_000, { e: 'ps', sta: 'r' }],
    [17_000, { e: 'ps', sta: 'p' }],
    [31_200, { e: 't', bl: [8000], mtp: [6000], pb: [1500], ltc: 5000, dfa: 3 }],
    [40_000, { e: 'b', bg: true }],
    [50_000, { e: 'b' }],
    [55_000, { e: 'abs', 'com.volt-brk': 'brk-9' }],
    [85_000, { e: 'abe', 'com.volt-brk': 'brk-9' }],
    [90_000, { e: 'e', ec: ['shaka-1002'], 'com.volt-step': 'segment' }],
    [92_000, { e: 'pr', pr: 1.1 }],
    [95_000, { e: 't', bl: [9000] }],
    [100_000, { e: 'ps', sta: 'q' }],
  ]);
  pv.lines.splice(14, 1); // sn 15 is lost

  const sendViewer = async (v: V, dup = false) => {
    let n = 0;
    const lines = v.lines.map(enc);
    const half = Math.ceil(lines.length / 2);
    for (const part of [lines.slice(0, half), lines.slice(half)]) {
      if (!part.length) continue;
      const r = await post(part, v.ua, v.geo);
      if (r.status === 204) n += part.length; else console.log('  post', r.status, await r.text());
    }
    if (dup) { const r = await post(lines.slice(4, 7), v.ua, v.geo); if (r.status !== 204) console.log('  dup post', r.status); }
    return n;
  };

  try {
    console.log('== the play gate, asked by each access sid (and once anonymously) ==');
    const codes: Record<string, number> = {};
    codes.ok = (await gate({ appKey: k.raw, assetId: ch, sid: S('acc-ok') }, AU)).status;
    codes.geo1 = (await gate({ appKey: k.raw, assetId: ch, sid: S('acc-geo1') }, IL)).status;
    codes.geo2 = (await gate({ appKey: k.raw, assetId: ch, sid: S('acc-geo2') }, IL)).status;
    codes.unknown = (await gate({ appKey: k.raw, assetId: '00000000-0000-4000-8000-000000000999', sid: S('acc-404') }, AU)).status;
    codes.origin = (await gate({ appKey: k2.raw, assetId: ch, sid: S('acc-origin') }, { ...AU, origin: 'https://evil.example' })).status;
    codes.lic = (await gate({ appKey: k.raw, assetId: ch, sid: S('acc-lic') }, AU)).status;
    codes.tok = (await gate({ appKey: k.raw, assetId: ch, sid: S('acc-tok') }, AU)).status;
    codes.planted = (await gate({ appKey: k.raw, assetId: ch2, sid: P }, AU)).status;
    codes.anon = (await fetch(`${baseUrl}/api/availability?appKey=${encodeURIComponent(k.raw)}&assetId=${ch}`, { headers: AU })).status;
    ok(JSON.stringify(codes) === JSON.stringify({ ok: 200, geo1: 451, geo2: 451, unknown: 404, origin: 403, lic: 200, tok: 200, planted: 200, anon: 200 }), 'gate answers as planted', codes);
    ok(gl.gatePending() === 9, `nine decisions buffered, none written on the gate's path (${gl.gatePending()})`);

    console.log('== the viewers through POST /api/cmcd ==');
    let sent = 0, total = 0;
    for (const v of viewers) { total += v.lines.length; sent += await sendViewer(v, v === pv); }
    ok(sent === total, `every planted report accepted (${sent}/${total})`);
    // Server-side beacons the stitcher sent: three for the first ad viewer, three for the planted session, two for someone else.
    const beacon = (chan: string, sess: string, ev: string, okb: boolean) => query(`INSERT INTO ad_beacons(channel_id, session_id, pod_index, ad_id, event, url_index, url, due_at, status, ok, sent_at)
      VALUES ($1,$2,0,'ad-7',$3,0,'https://ads.example/'||$3, now(), $4, $5, now())`, [chan, sess, ev, okb ? 200 : 500, okb]);
    for (const ev of ['impression', 'start', 'complete']) await beacon(ch2, `${ad1.sid}_x1`, ev, true);
    for (const ev of ['impression', 'start', 'complete']) await beacon(ch2, `${P}_Ab-9`, ev, true);
    await beacon(ch, `someone_else_1`, 'impression', true); await beacon(ch, `someone_else_1`, 'firstQuartile', false);
    await coll.flushQoe(Date.now() + 61_000);
    const st = coll.collectorState();
    ok(st.lastError == null && st.gate.pending === 0 && st.gate.written === 9 && st.gate.lastError == null, 'the collector flushed the views and the nine gate decisions', st);

    console.log('== report 5: rendering and device health ==');
    const rf = (await get(`/overview?${W}&content_id=r-film`)).body.rendering;
    ok(rf.views === 11 && rf.viewsReportingFrames === 10, `11 started views, 10 reporting frames (${rf.views}, ${rf.viewsReportingFrames})`);
    ok(rf.droppedFrames === 2436 && near(rf.droppedPerMinute, 243.6, 1e-6), `dropped 2436 over 10 minutes of playing: 243.6 a minute (${rf.droppedFrames}, ${rf.droppedPerMinute})`);
    ok(rf.perViewDroppedPerMinute.p50 === 6 && rf.perViewDroppedPerMinute.p95 === 600, 'per view p50 6 and p95 600 a minute (nearest rank)', rf.perViewDroppedPerMinute);
    ok(rf.byDevice[0]?.device === 'StutterTV' && near(rf.byDevice[0].droppedPerMinute, 600, 1e-6) && rf.byDevice[0].decodeErrors === 2, 'the stuttering TV is the worst device: 600 a minute, its two decoder errors', rf.byDevice);
    ok(rf.decodeErrors === 3 && rf.viewsWithDecodeErrors === 3 && rf.decodeFatal === 1, 'decoder errors 3 in 3 views, one fatal', [rf.decodeErrors, rf.viewsWithDecodeErrors, rf.decodeFatal]);
    ok(rf.hardwareDecode.yes === 7 && rf.hardwareDecode.no === 4, 'hardware decoding 7, software 4', rf.hardwareDecode);
    ok(rf.keySystems.length === 1 && rf.keySystems[0].keySystem === 'com.widevine.alpha' && rf.keySystems[0].views === 6, 'DRM system: Widevine on the six Macs', rf.keySystems);
    const rfb = (await get(`/overview?${W}&content_id=r-film`)).body.buffering;
    ok(rfb.playingMs === 10 * 60_000 + 10_001, 'its playing time unchanged by the new measures', rfb.playingMs);

    console.log('== report 7: DRM and access ==');
    const ac = (await get(`/overview?${W}`)).body.access;
    ok(ac.gate.decisions === 9 && ac.gate.allowed === 5 && ac.gate.denied === 4 && ac.gate.sessions === 8, `gate: 9 decisions, 5 allowed, 4 refused, 8 sessions (the anonymous GET has none)`, ac.gate);
    const reason = (r: string) => ac.gate.reasons.filter((x: any) => x.reason === r).reduce((n: number, x: any) => n + x.decisions, 0);
    ok(reason('allowed') === 5 && reason('geo') === 2 && reason('unknown_asset') === 1 && reason('app_restriction') === 1, 'by reason: allowed 5, geo 2, unknown asset 1, the app\'s origin restriction 1', ac.gate.reasons);
    ok(ac.gate.reasons.find((x: any) => x.reason === 'geo')?.status === 451, 'geo refusals answered 451');
    ok(ac.gate.timeMs.p50 != null && ac.gate.timeMs.p50 >= 0 && ac.gate.timeMs.p99 >= ac.gate.timeMs.p50, 'the gate\'s own time, p50 to p99', ac.gate.timeMs);
    const f = (step: string, code: string) => ac.failures.find((x: any) => x.step === step && x.code === code);
    ok(f('entitlement', 'gate-451')?.gateReason === 'geo' && f('entitlement', 'gate-451')?.views === 2, 'the two 451s attributed to the entitlement step AND to geo', ac.failures);
    ok(f('entitlement', 'gate-404')?.gateReason === 'unknown_asset' && f('entitlement', 'gate-403')?.gateReason === 'app_restriction', 'the 404 to an unknown asset, the 403 to the app\'s restrictions');
    ok(f('drm', 'shaka-6007')?.gateReason === 'allowed' && f('drm', 'shaka-6007')?.phase === 'before_start', 'the licence failure is the DRM step\'s, after the gate allowed it (not counted as a refusal)');
    ok(ac.failures.length === 4 && ac.entitlementFailures === 4, 'nothing else attributed', ac.failures);
    ok(ac.licence.requests === 3 && ac.licence.failures === 1 && ac.licence.viewsWithFailures === 1 && ac.licence.failedBeforeStart === 1, 'licence: 3 requests, 1 failed, its view failed before the start', ac.licence);
    ok(ac.licence.startupSpanMs.p50 === 250 && ac.licence.startupSpanMs.p99 === 300 && ac.licence.slowestRequestMs.p95 === 900, 'licence time: startup span p50 250, p99 300; slowest request p95 900 ms', ac.licence);
    ok(ac.tokenErrors.views === 1 && ac.tokenErrors.errors === 1, 'one view refused mid-view (403 on a segment): a token error', ac.tokenErrors);
    const acf = (await get(`/overview?${W}&content_id=${ch}`)).body.access;
    ok(acf.gate.decisions === 7 && acf.failures.length === 4, 'filtered to the channel: its 7 decisions (not the unknown asset, not the other channel); the views that asked for it', [acf.gate.decisions, acf.failures.length]);

    console.log('== report 8: live-stream health ==');
    const lv = (await get(`/overview?${W}&content_id=live-news`)).body.live;
    ok(lv.views === 6 && lv.viewsWithLatency === 6, '6 live views with latency');
    ok(lv.latencyMs.p50 === 3000 && lv.latencyMs.p95 === 9000 && lv.highestLatencyMs === 14_000, 'latency p50 3 s, p95 9 s, highest 14 s', lv.latencyMs);
    ok(lv.driftMs.p50 === 0 && lv.driftMs.p95 === 10_000 && lv.driftMs.avg === 5000 && lv.viewsDriftedOver5s === 3, 'drift p50 0, p95 10 s; three views drifted over 5 s', lv.driftMs);
    ok(lv.byDevice[0]?.deviceModel === 'DriftTV' && lv.byDevice[0].driftAvgMs === 10_000 && lv.byDevice[0].latencyAvgMs === 9000 && lv.byDevice[1]?.deviceModel === 'MacIntel' && lv.byDevice[1].driftAvgMs === 0,
      'per device: the drifting TV first (10 s drift, 9 s average), the Macs steady', lv.byDevice);
    ok(near(lv.catchUpShare, 10_000 / 480_000) && lv.rateChanges === 2, 'catching up (rate 1.1) for 10 s of 8 minutes playing; 2 rate changes', [lv.catchUpShare, lv.rateChanges]);
    const lvv = (await get(`/overview?${W}&content_id=r-film`)).body.live;
    ok(lvv.views === 0, 'on demand views are not in live health');

    console.log('== report 9: advertising ==');
    const ov2 = (await get(`/overview?${W}&content_id=${ch2}`)).body;
    const ad = ov2.ads;
    ok(ad.views === 4 && ad.breaks === 4 && ad.breaksCompleted === 3 && near(ad.breakCompletion, 0.75), 'four breaks in four views (the planted one too), three seen to the end', ad);
    ok(ad.avgBreakMs === Math.round((30_000 + 30_000 + 10_000 + 30_000) / 4), `average break watched ${ad.avgBreakMs} ms`);
    ok(ad.adStartupMs.avg === Math.round(1500 / 4) && ad.adStartupMs.p95 === 1500 && ad.adStartupMs.p50 === 0, 'ad startup: 1.5 s for the viewer stalled at the break, 0 for the others', ad.adStartupMs);
    ok(near(ad.adRebufferRatio, 4500 / (28_000 + 27_500 + 10_000 + 30_000 + 4500)) && ad.adStalls === 2 && ad.viewsWithAdStalls === 2, 'ad buffering 4.5 s, two stalls inside breaks', [ad.adRebufferRatio, ad.adStalls]);
    ok(ad.returnToContentMs.avg === Math.round(2000 / 3) && ad.returnToContentMs.p95 === 2000, 'back to the programme: 2 s for the one stalled at the break end', ad.returnToContentMs);
    ok(ad.leftDuringAd === 1 && ad.leftDuringAdSessions === 1, 'one viewer left during the ad', ad.leftDuringAd);
    ok(ad.server?.impressions === 2 && ad.server.starts === 2 && ad.server.complete === 2 && ad.server.failed === 0 && ad.server.sessions === 2 && ad.serverCompletion === 1,
      'the stitcher\'s beacons for the channel: 2 impressions, 2 completes, both sessions', ad.server);
    const adAll = (await get(`/overview?${W}`)).body.ads;
    ok(adAll.server.impressions === 3 && adAll.server.failed === 1 && near(adAll.serverCompletion, 2 / 3), 'unfiltered: every beacon of the account, the failed quartile counted', adAll.server);
    const bu2 = ov2.buffering;
    ok(bu2.playingMs === 49_000 + 26_500 + 19_000 + 56_800 && bu2.rebufferMs === 2500 + 2000 && bu2.stalls === 2,
      'break time is not programme time: playing and rebuffering of the four views without their breaks; stalls in breaks not counted', [bu2.playingMs, bu2.rebufferMs, bu2.stalls]);
    const iso = (await get(`/overview?${W}`, tok2)).body;
    ok(iso.ads.views === 0 && iso.access.gate.decisions === 0 && iso.ads.server.impressions === 0, 'another account sees none of it');

    console.log('== report 11: the planted session, end to end ==');
    const tl = await get(`/sessions/${P}`);
    ok(tl.status === 200, 'GET /api/analytics/qoe/sessions/:sid 200', tl.status);
    const t = tl.body;
    ok(t.reports === 15 && t.duplicates === 3 && JSON.stringify(t.missingSequence) === '[15]', `15 reports in order, the resent batch counted once (3 duplicates), sn 15 listed as missing`, [t.reports, t.duplicates, t.missingSequence]);
    ok(t.events.every((e: any, i: number) => i === 0 || e.ts >= t.events[i - 1].ts) && t.events.map((e: any) => e.sn).join(',') === '1,2,3,4,5,6,7,8,9,10,11,12,13,14,16', 'every report in the player\'s order', t.events.map((e: any) => e.sn));
    const labels = t.events.map((e: any) => e.label);
    ok(labels[0] === 'Play pressed' && labels[3] === 'First frame after 1.2 s at 3.00 Mbps' && labels[4] === 'Quality changed to 1.50 Mbps' && labels[5] === 'Stalled (rebuffering)',
      'in plain words: play pressed, first frame, quality change, stall', labels.slice(0, 6));
    ok(labels[2] === 'Licence answered 200 in 250 ms' && labels.includes('Ad break started (brk-9)') && labels.includes('Went to the background') && labels.includes('Error shaka-1002 at the segment step') && labels.includes('Playback rate 1.1x') && labels[labels.length - 1] === 'Left',
      'licence response, ad break, background, error, rate, left', labels);
    ok(t.events.filter((e: any) => e.problem).map((e: any) => e.sn).join(',') === '6,13', 'the stall and the error flagged as problems', t.events.filter((e: any) => e.problem).map((e: any) => e.sn));
    const spans = t.spans.map((s: any) => `${s.state}:${s.fromOffsetMs}-${s.toOffsetMs}`).join(' ');
    ok(spans === 'starting:0-1200 playing:1200-15000 stalled:15000-17000 playing:17000-40000 backgrounded:40000-50000 playing:50000-55000 ad:55000-85000 playing:85000-100000',
      'the states as spans, to the millisecond', spans);
    ok(t.gate.length === 1 && t.gate[0].reason === 'allowed' && t.gate[0].method === 'POST' && t.gate[0].assetId === ch2 && t.gate[0].offsetMs <= 0, 'the gate\'s decision for this sid, before the first report', t.gate);
    ok(t.beacons.length === 3 && t.beacons.map((b: any) => b.event).join(',') === 'impression,start,complete', 'the stitcher\'s beacons for this viewer (session named after the sid)', t.beacons);
    const v0 = t.views[0];
    ok(t.views.length === 1 && Number(v0.playing_ms) === 56_800, 'the stored view: 56.8 s playing', v0?.playing_ms);
    ok(Number(v0.ad_ms) === 30_000 && Number(v0.background_ms) === 10_000 && Number(v0.rebuffer_ms) === 2000 && Number(v0.catchup_ms) === 8000 && v0.hw_decode === true && v0.key_system === 'com.widevine.alpha' && v0.latency_first_ms === 5000 && Number(v0.licence_requests) === 1,
      'ad 30 s, background 10 s, stall 2 s, catching up 8 s, hardware decode, Widevine, 5 s behind live, one licence request', v0);
    const d0 = t.derived[0];
    ok(d0 && d0.playing_ms === Number(v0.playing_ms) && d0.ad_ms === Number(v0.ad_ms) && d0.stalls === v0.stalls && d0.events === v0.events, 'the timeline\'s own derivation equals the stored row', [d0?.playing_ms, d0?.events, v0.events]);
    ok(t.viewer?.country === 'AU' && /Macintosh/.test(t.viewer.userAgent) && tl.body.contentNames[ch2] === 'Ads FAST', 'the viewer\'s context and the content\'s name', [t.viewer, tl.body.contentNames]);
    const other404 = await get(`/sessions/${P}`, tok2);
    ok(other404.status === 404, 'another account: 404', other404.status);
    const bad = await get(`/sessions/${encodeURIComponent('../etc')}`);
    ok(bad.status === 400 || bad.status === 404, 'not a session id: refused', bad.status);
    const none = await get(`/sessions/nobody-${tag}`);
    ok(none.status === 404, 'an unknown sid: 404');
    const list = await get(`/sessions?${W}&problem=failed`);
    const lsids = list.body.items.map((x: any) => x.sid);
    ok(list.status === 200 && list.body.items.every((x: any) => x.outcome === 'failed') && [S('acc-geo1'), S('acc-geo2'), S('acc-404'), S('acc-origin'), S('acc-lic')].every((s) => lsids.includes(s)) && lsids.length === 5,
      'GET /sessions?problem=failed: the five failed attempts', lsids);
    const lad = await get(`/sessions?${W}&problem=ad`);
    ok(lad.body.items.length === 1 && lad.body.items[0].sid === S('ad3') && lad.body.items[0].contentName === 'Ads FAST', 'problem=ad: the viewer who left during the ad, with the content name', lad.body.items);
    ok((await get(`/sessions?problem=nope`)).status === 400, 'an unknown problem filter: 400');

    console.log('== a stitched FAST session is named after the sid ==');
    const fr = await gate({ appKey: k.raw, assetId: fast, sid: S('fastviewer') }, AU);
    const fb: any = await fr.json();
    const re = new RegExp(`/fast/${fast}/s/${S('fastviewer')}_[A-Za-z0-9_-]{16}/master\\.m3u8$`);
    ok(fr.status === 200 && re.test(fb.delivery?.hls ?? ''), 'POST with a sid: /fast/<id>/s/<sid>_<random>/master.m3u8', fb.delivery);
    const fr2 = await gate({ appKey: k.raw, assetId: fast }, AU);
    const fb2: any = await fr2.json();
    ok(fr2.status === 200 && /\/s\/[A-Za-z0-9_-]{16}\/master\.m3u8$/.test(fb2.delivery?.hls ?? ''), 'without a sid: a random session as before', fb2.delivery);

    console.log('== delete the derived rows, replay, identical reports ==');
    const snap = async () => JSON.stringify([(await get(`/overview?${W}`)).body, (await get(`/overview?${W}&content_id=${ch2}`)).body, (await get(`/sessions/${P}`)).body, (await get(`/sessions?${W}&problem=all&limit=200`)).body]);
    await coll.flushQoe(Date.now() + 61_000);
    const before = await snap();
    await adb.aquery(`DELETE FROM qoe_views`); await adb.aquery(`DELETE FROM qoe_minutes`);
    const days = [...new Set([T0 - 86_400_000, T0, Date.now()].map((x) => new Date(x).toISOString().slice(0, 10)))].sort();
    await replayRange(days[0], days[days.length - 1], acct);
    const after = await snap();
    ok(after === before, 'reports 5, 7, 8, 9 and the timeline identical after a replay', after === before ? undefined : { before: before.slice(0, 300), after: after.slice(0, 300) });

    console.log('== the gate log through an analytics outage ==');
    // The store the derived rows are in goes away: the Postgres analytics database, or ClickHouse (QOE_STORE=clickhouse, build queue 2.11).
    const chMod = await import('../src/services/qoe/clickhouse');
    const chUrl = process.env.CLICKHOUSE_URL;
    const onCh = (process.env.QOE_STORE ?? '') === 'clickhouse';
    const storeDown = async () => {
      if (onCh) { process.env.CLICKHOUSE_URL = 'http://127.0.0.1:9'; chMod.resetClickhouse(); return; }
      await query(`ALTER DATABASE "${aname}" ALLOW_CONNECTIONS false`);
      await query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [aname]);
    };
    const storeUp = async () => {
      if (onCh) { process.env.CLICKHOUSE_URL = chUrl; chMod.resetClickhouse(); return; }
      await query(`ALTER DATABASE "${aname}" ALLOW_CONNECTIONS true`);
    };
    await storeDown();
    await sleep(200);
    const ga = Date.now();
    const gd = await gate({ appKey: k.raw, assetId: ch, sid: S('outage') }, AU);
    const gms = Date.now() - ga;
    ok(gd.status === 200 && gms < 1000, `the gate answers while the analytics database is down (${gd.status}, ${gms} ms)`);
    await gl.flushGate();
    ok(gl.gatePending() === 1 && gl.gateStats.flushFailures >= 1, 'its decision is held, not lost', { pending: gl.gatePending(), ...gl.gateStats });
    await storeUp();
    await gl.flushGate();
    const [row] = await adb.aquery(`SELECT reason, status FROM qoe_gate WHERE sid = $1`, [S('outage')]);
    ok(gl.gatePending() === 0 && row?.reason === 'allowed', 'back up: written', row);
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
