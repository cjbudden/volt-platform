// ============================================================================
//  REFUSALS COUNTED AND THE RIGHTS DEMAND REPORT (build queue P2-3,
//  services/availabilityDemand.ts, the play gate in modules/apps.ts, the CDN
//  log reader in services/qoe/cdnLogs.ts, GET /api/analytics/rights-demand).
//
//  Over real HTTP against a database: 300 gate refusals make no database
//  write until the minute's flush, which writes them in two statements as a
//  handful of rollup rows; geo and rights refusals count as demand, allowed
//  answers as plays, a title asked for after its window as demand after the
//  window (still answered 404); the same session counted once, three
//  sessions three times, a signed-in viewer by their account; ids of another
//  account and unknown ids not counted; an edge 403 on a token asked for from
//  another country counted as demand (weighted by the sampling rate), a
//  segment 403 and an expired link not; the report's totals, countries,
//  titles with their window and territories, licensed flags for one title,
//  the trend, other refusals and the CSV; another account sees none of it;
//  flushes add up; a bad date is 400.
//    DATABASE_URL=... npx tsx test/rights-demand.check.ts
// ============================================================================
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.QOE_RAW_DIR = mkdtempSync(join(tmpdir(), 'qoe-raw-demand-'));
delete process.env.QOE_RAW_BUCKET;
process.env.DEMAND_FLUSH_MS = '3600000'; // the suite flushes by hand

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};

(async () => {
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { signViewer } = await import('../src/auth/viewerTokens');
  const { invalidateTag } = await import('../src/scale/cache');
  const P = await import('../src/services/publicStatus');
  const D = await import('../src/services/availabilityDemand');
  const cl = await import('../src/services/qoe/cdnLogs');
  const { mintEdgeToken } = await import('../src/services/edgeTokens');
  const { closeAnalytics } = await import('../src/services/qoe/analyticsDb');
  const tag = Date.now().toString(36);
  const acct = async (n: string, geo: string | null = null) => (await one<any>(`INSERT INTO accounts(name, geo_access) VALUES ($1, $2::jsonb) RETURNING id`, [`${n}-${tag}`, geo]))!.id;
  const user = async (a: string, role: string) => {
    const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x',$3,'active') RETURNING id`, [a, `${role}-${a.slice(0, 8)}-${tag}@volt.test`, role]))!.id;
    return signAccess({ sub: u, account_id: a, role });
  };
  const me = await acct('rd', '{"mode":"block","countries":["NZ"]}');
  const them = await acct('rd-them');
  const otok = await user(me, 'owner'), ttok = await user(them, 'owner');
  const LIVE = `availability_state = 'available', published = true, availability = '{"targets":[{"kind":"portal"}],"access":"free"}'::jsonb, available_from = now() - interval '1 day'`;
  const asset = async (a: string, title: string, set = LIVE) => {
    const id = (await one<any>(
      `INSERT INTO vod_assets(account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms)
       VALUES ($1,'upload','clip',$2,'x',0,60000,60000) RETURNING id`, [a, title]))!.id;
    await query(`UPDATE vod_assets SET master_key = $2, formats = '{"hls":true}'::jsonb, ${set} WHERE id = $1`, [id, `/clips/vod/${id}/master.m3u8`]);
    await P.refreshPublicStatus(id);
    invalidateTag(`asset:${id}`);
    return id;
  };
  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const http = async (method: string, path: string, body?: any, auth?: string) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j: any = null; try { j = JSON.parse(t); } catch { j = t; }
    return { s: r.status, j, ct: r.headers.get('content-type') ?? '' };
  };
  try {
    const dp = await D.demandPool();
    const rows = async (a = me) => Number((await dp.query(`SELECT COUNT(*) AS n FROM availability_events WHERE account_id = $1`, [a])).rows[0].n);
    check('the rollup tables exist in the analytics database', (await dp.query(`SELECT to_regclass('availability_events') IS NOT NULL AND to_regclass('availability_viewers') IS NOT NULL AS ok`)).rows[0].ok, true);

    const pk = (await http('POST', '/api/apps', { name: 'Web', type: 'web' }, otok)).j.publishableKey.key;
    const tpk = (await http('POST', '/api/apps', { name: 'Theirs', type: 'web' }, ttok)).j.publishableKey.key;
    const gate = (id: string, geo: string, sid?: string, auth?: string, key = pk) => http('POST', '/api/availability', { appKey: key, assetId: id, geo, ...(sid ? { sid } : {}) }, auth);

    const film = await asset(me, 'Film');                       // NZ blocked by the account's geo
    const prof = await http('POST', '/api/rights/profiles', { name: `AU only ${tag}`, territoryMode: 'allow', territories: ['AU'] }, otok);
    const aus = await asset(me, 'AU rights');
    await http('PUT', `/api/rights/assets/${aus}`, { profileId: prof.j.id }, otok);
    invalidateTag(`asset:${aus}`);
    const gone = await asset(me, 'Gone', `${LIVE}, available_until = now() - interval '1 hour'`);
    const theirs = await asset(them, 'Theirs');
    D.resetDemand();

    // ---- 300 refusals: nothing written on the way
    let codes = new Set<number>();
    for (let i = 0; i < 300; i++) codes.add((await gate(film, 'NZ', `sess-nz-${i % 3}xx`)).s);
    check('300 refusals from New Zealand: all 451', [...codes], [451]);
    check('...not one statement to the analytics database and no row yet', [D.demandStats.statements, await rows()], [0, 0]);
    check('...held as one counter in memory', D.demandPending(), 1);

    // ---- every kind of answer
    check('rights: 451 from the US', (await gate(aus, 'US', 'sess-us-1xx')).s, 451);
    for (let i = 0; i < 4; i++) check(`plays: 200 from Australia (${i + 1})`, (await gate(aus, 'AU', `sess-au-${i}xx`)).s, 200);
    check('a title past its window: 404 as unknown (nothing leaks)', (await gate(gone, 'AU', 'sess-gone-1')).s, 404);
    check('an unknown id: 404', (await gate('00000000-0000-4000-8000-00000000abcd', 'AU', 'sess-unk-1')).s, 404);
    check('another account\'s title with my key: 404', (await gate(theirs, 'AU', 'sess-oth-1')).s, 404);
    const vt = signViewer({ id: '11111111-2222-4333-8444-555555555555', accountId: me, appId: null, groups: [], entitlements: [] }).token;
    check('a signed-in viewer refused twice from NZ, with two sessions', [(await gate(film, 'NZ', 'sess-v-1xxx', vt)).s, (await gate(film, 'NZ', 'sess-v-2xxx', vt)).s], [451, 451]);
    check('the anonymous GET gate refused from NZ', (await http('GET', `/api/availability?appKey=${encodeURIComponent(pk)}&assetId=${film}&geo=NZ`)).s, 451);

    await D.flushDemand();
    const st = D.demandStats.statements;
    check('the flush: two statements (counts and viewers)', st, 2);
    const ev = (await dp.query(`SELECT asset_id, country, reason, source, requests FROM availability_events WHERE account_id = $1 ORDER BY asset_id, reason, country`, [me])).rows
      .map((r: any) => `${r.asset_id === film ? 'film' : r.asset_id === aus ? 'aus' : r.asset_id === gone ? 'gone' : r.asset_id}|${r.country}|${r.reason}|${r.source}|${r.requests}`).sort();
    check('rollup rows: film NZ geo 303, AU rights US, AU plays 4, Gone after its window; nothing for unknown or other ids',
      ev, ['aus|AU|allowed|gate|4', 'aus|US|rights|gate|1', 'film|NZ|geo|gate|303', 'gone|AU|expired|gate|1'].sort());
    check('another account: nothing counted for my key asking for its title', await rows(them), 0);
    const vv = (await dp.query(`SELECT COUNT(*) AS n FROM availability_viewers WHERE account_id = $1 AND asset_id = $2 AND reason = 'geo'`, [me, film])).rows[0].n;
    check('unique viewers for Film from NZ: 3 sessions, 1 signed-in viewer (two sessions), 1 anonymous GET', Number(vv), 5);
    const raw = (await dp.query(`SELECT vh FROM availability_viewers WHERE account_id = $1 LIMIT 50`, [me])).rows.map((r: any) => r.vh);
    check('viewers kept only as 16-character hashes (no session id, no address)', raw.every((h: string) => /^[0-9a-f]{16}$/.test(h)), true);

    // ---- the edge
    const at = Date.now();
    const tok = mintEdgeToken({ assetId: aus, prefix: `/clips/vod/${aus}/`, country: 'AU', policyClass: 'rights', sid: 'sess-edge-1x' }).token;
    const old = mintEdgeToken({ assetId: aus, prefix: `/clips/vod/${aus}/`, country: 'AU', policyClass: 'rights', nowSec: Math.floor(at / 1000) - 90_000 }).token;
    const F = cl.CDN_LOG_FIELDS.length;
    const rec = (path: string, status: number, cc: string) => {
      const f = new Array(F).fill('-');
      const set = (k: string, v: string) => { f[cl.CDN_LOG_FIELDS.indexOf(k as any)] = v; };
      set('timestamp', (at / 1000).toFixed(3)); set('c-ip', '198.51.100.7'); set('sc-status', String(status)); set('sc-bytes', '120'); set('cs-uri-stem', path);
      set('c-country', cc); set('cs-user-agent', 'Mozilla%2F5.0'); set('time-taken', '0.004'); set('x-edge-request-id', 'r' + Math.random());
      return f.join('\t');
    };
    await cl.handleCdnLines([
      rec(`/t/${tok}/clips/vod/${aus}/master.m3u8`, 403, 'JP'),
      rec(`/t/${tok}/clips/vod/${aus}/master.m3u8`, 403, 'JP'),
      rec(`/t/${tok}/clips/vod/${aus}/seg_00001.m4s`, 403, 'JP'),
      rec(`/t/${old}/clips/vod/${aus}/master.m3u8`, 403, 'AU'),
      rec(`/t/${tok}/clips/vod/${aus}/master.m3u8`, 200, 'AU'),
    ], 50, { accountOf: async (id) => (id === aus ? me : null) });
    await D.flushDemand();
    const edge = (await dp.query(`SELECT country, reason, requests FROM availability_events WHERE account_id = $1 AND source = 'edge'`, [me])).rows;
    check('edge: the two manifest 403s from Japan on an AU token, as geo demand, weighted x2 (logged at 50 %); segment, expired link and 200 not counted',
      edge.map((r: any) => `${r.country}|${r.reason}|${r.requests}`), ['JP|geo|4']);
    const ev2 = Number((await dp.query(`SELECT COUNT(DISTINCT vh) AS n FROM availability_viewers WHERE account_id = $1 AND asset_id = $2 AND country = 'JP'`, [me, aus])).rows[0].n);
    check('...one viewer (the token\'s session)', ev2, 1);

    // ---- flushes add up
    await gate(film, 'NZ', 'sess-nz-0xx');
    await D.flushDemand();
    check('a later flush adds to the day\'s row (304), the known session not counted again', [
      Number((await dp.query(`SELECT requests FROM availability_events WHERE account_id = $1 AND asset_id = $2 AND reason = 'geo' AND source = 'gate'`, [me, film])).rows[0].requests),
      Number((await dp.query(`SELECT COUNT(*) AS n FROM availability_viewers WHERE account_id = $1 AND asset_id = $2 AND reason = 'geo'`, [me, film])).rows[0].n)], [304, 5]);

    // ---- the report
    const r = await http('GET', '/api/analytics/rights-demand', undefined, otok);
    check('report: 200, the last 30 days', [r.s, r.j.to, r.j.from <= r.j.to], [200, new Date().toISOString().slice(0, 10), true]);
    check('totals: blocked viewers 7 (5 for Film, US and JP for AU rights), requests 309, plays 4, after the window 1',
      r.j.totals, { blockedViewers: 7, blockedRequests: 309, plays: 4, afterWindowRequests: 1 });
    check('by country, most blocked viewers first', r.j.byCountry.map((c: any) => `${c.country}:${c.blockedViewers}/${c.blockedRequests}/${c.plays}/${c.afterWindowRequests}`),
      ['NZ:5/304/0/0', 'JP:1/4/0/0', 'US:1/1/0/0', 'AU:0/0/4/1']);
    const ft = r.j.byTitle.find((t: any) => t.assetId === film), at2 = r.j.byTitle.find((t: any) => t.assetId === aus), gt = r.j.byTitle.find((t: any) => t.assetId === gone);
    check('by title: Film first with its name, kind and an open window', [r.j.byTitle[0].assetId === film, ft.title, ft.kind, ft.blockedViewers, ft.window?.state, ft.window?.territoryMode],
      [true, 'Film', 'vod', 5, 'open', 'worldwide']);
    check('...AU rights: 2 blocked viewers beside 4 plays, its territories', [at2.blockedViewers, at2.blockedRequests, at2.plays, at2.window?.territoryMode, at2.window?.territories], [2, 5, 4, 'allow', ['AU']]);
    check('...Gone: asked for after its window, which shows as expired with its end date', [gt.afterWindowRequests, gt.window?.state, gt.window?.status, !!gt.window?.until], [1, 'expired', 'expired', true]);
    check('trend: today', r.j.trend.map((d: any) => [d.day, d.blockedViewers, d.blockedRequests, d.plays]), [[new Date().toISOString().slice(0, 10), 7, 309, 4]]);
    check('other refusals by reason', r.j.otherRefusals, [{ reason: 'expired', requests: 1 }]);

    const one1 = await http('GET', `/api/analytics/rights-demand?assetId=${aus}`, undefined, otok);
    check('one title: each country says whether it is licensed (AU yes, JP and US no)',
      one1.j.byCountry.map((c: any) => `${c.country}:${c.licensed}:${c.blockedViewers}:${c.plays}`).sort(), ['AU:true:0:4', 'JP:false:1:0', 'US:false:1:0']);
    check('filter by country and kind', [(await http('GET', '/api/analytics/rights-demand?country=nz', undefined, otok)).j.totals.blockedRequests,
      (await http('GET', '/api/analytics/rights-demand?kind=channel', undefined, otok)).j.totals.blockedRequests], [304, 0]);
    const past = await http('GET', '/api/analytics/rights-demand?from=2020-01-01&to=2020-01-31', undefined, otok);
    check('a period with nothing: zeros, empty lists', [past.j.totals.blockedViewers, past.j.byCountry.length, past.j.byTitle.length], [0, 0, 0]);
    check('a bad date: 400', (await http('GET', '/api/analytics/rights-demand?from=last-week', undefined, otok)).s, 400);
    check('signed out: 401', (await http('GET', '/api/analytics/rights-demand')).s, 401);

    const csv = await http('GET', '/api/analytics/rights-demand?format=csv', undefined, otok);
    const lines = String(csv.j).trim().split('\n');
    check('CSV: a spreadsheet by title and country', [csv.s, csv.ct.startsWith('text/csv'), lines[0], lines.length], [200, true, 'from,to,asset_id,title,kind,country,blocked_viewers,blocked_requests,plays,after_window_requests', 6]);
    check('...Film from NZ', lines.some((l) => l.includes(`${film},Film,vod,NZ,5,304,0,0`)), true);

    const tr = await http('GET', '/api/analytics/rights-demand', undefined, ttok);
    check('another account: none of it', [tr.s, tr.j.totals, tr.j.byTitle.length], [200, { blockedViewers: 0, blockedRequests: 0, plays: 0, afterWindowRequests: 0 }, 0]);
    check('...nor by naming my title', (await http('GET', `/api/analytics/rights-demand?assetId=${film}`, undefined, ttok)).j.totals.blockedRequests, 0);

    // ---- off
    process.env.VOLT_DEMAND_LOG = 'off';
    D.resetDemand();
    await gate(film, 'NZ', 'sess-off-1');
    check('VOLT_DEMAND_LOG=off: nothing held', D.demandPending(), 0);
    delete process.env.VOLT_DEMAND_LOG;
    void tpk;
  } catch (e) {
    console.log('FAIL threw', (e as Error).stack); fail++;
  } finally {
    srv.close();
    await closeAnalytics().catch(() => {});
    await pool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
