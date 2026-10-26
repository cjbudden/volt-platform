// ============================================================================
//  JOURNEY TO PLAY (build queue 1.14g, QOE_REPORTING.md section 13).
//
//  The SDK side (volt-player/src/sdk/journey.ts): consent off sends and
//  forwards nothing; screens, a select from a row and the play carry the
//  journey into the play attempt's first CMCD report and play_intent; the
//  GA4 pass-through gets the same events; custom event names are capped; a
//  search query is left out unless hashing is asked for.
//
//  The server side: simulated app sessions go through the real collector
//  (POST /api/journey) and their plays through POST /api/cmcd, then
//    28  the funnel from app open to first frame has the right counts at
//        every step, a planted drop-off at the paywall (three viewers told to
//        pay, none bought) and the right times;
//    29  plays, watch time and completion split by entry point and by row;
//        a detail page viewed and never played;
//        and a QoE view row carries its journey, entry point and depth, so
//        reports 1 to 10 filter by them.
//  Plus: what may not be kept is dropped (an e-mail field, a plain search
//  query), the collector's refusals (415, 410, 400), another account sees
//  nothing, and a replay of the raw events gives identical reports.
//
//  Usage: DATABASE_URL=... npx tsx test/journey.check.ts
// ============================================================================
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };
const ROOT = resolve(__dirname, '..');
process.env.QOE_RAW_DIR = mkdtempSync(join(tmpdir(), 'qoe-raw-journey-'));
process.env.TRUST_EDGE_GEO = 'true';
delete process.env.QOE_RAW_BUCKET;

type L = Record<string, string | number | boolean | Array<number | string>>;
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
function walk(dir: string): string[] { const out: string[] = []; for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) out.push(...walk(p)); else out.push(p); } return out; }

(async () => {
  // ---------------------------------------------------------------- SDK
  console.log('== the SDK (volt-player/src/sdk/journey.ts) ==');
  {
    const j = await import('../../volt-player/src/sdk/journey');
    const cm = await import('../../volt-player/src/sdk/cmcd');
    const { parseCmcdLine } = await import('../src/services/qoe/cmcdParse');
    const { checkJourneyEvent } = await import('../src/services/qoe/journeys');
    const sent: string[] = [];
    const sink = { push: (l: string) => { sent.push(l); }, flush: () => {} };
    const ga: unknown[][] = [];
    const gtag = (...a: unknown[]) => { ga.push(a); };
    const fwd: any[] = [];
    let clock = 1_000_000;
    const jr = new j.VoltJourney({ appKey: 'pk_x', app: 'Volt TV', appVersion: '4.2.0', consent: false, listen: false, sink, now: () => clock, forward: [j.ga4Forward(gtag), (e) => fwd.push(e)] });
    jr.screen('home', { type: 'home' }); jr.select('c1', { entry: 'row:Trending', position: 3 }); jr.playIntent('sid-0', 'c1'); jr.track('trailer_play');
    ok(sent.length === 0 && jr.log.length === 0 && ga.length === 0 && fwd.length === 0, 'consent off: nothing sent, nothing kept, nothing forwarded', { sent: sent.length, ga: ga.length });
    ok(Object.keys(jr.attemptKeys()).length === 0, 'consent off: a play attempt carries no journey keys');
    jr.setConsent(true);
    ok(sent.length === 1 && JSON.parse(sent[0]).e === 'app_open' && JSON.parse(sent[0]).app === 'Volt TV', 'consent given: the app session opens', sent[0]);
    clock += 1000; jr.screen('Home', { type: 'home' });
    clock += 2000; const jid = jr.select('c1', { entry: 'row:Trending', position: 3 });
    clock += 500; jr.screen('Detail', { type: 'detail', contentId: 'c1' });
    const keys = jr.attemptKeys();
    ok(keys['com.volt-jid'] === jid && keys['com.volt-entry'] === 'row' && keys['com.volt-depth'] === 2 && keys['com.volt-asid'] === jr.appSessionId, 'the attempt keys: journey, row, two screens before the play', keys);
    const lines: string[] = [];
    const a = new cm.PlayAttempt({ cid: 'c1', live: false, sender: { push: (l: string) => lines.push(l), flush: () => {} } as any, requestMode: false, autoplay: false,
      identity: { ...cm.identityKeys({ app: 'Volt TV' }), ...keys }, onPlay: (sid) => jr.playIntent(sid, 'c1') });
    const before = sent.length;
    a.playRequested();
    const first = parseCmcdLine(lines[0]);
    ok(first['com.volt-jid'] === jid && first['com.volt-entry'] === 'row' && first['com.volt-depth'] === '2', 'the attempt\'s first CMCD report carries the journey (depth as a string, CTA-5004-B)', lines[0]);
    const pi = JSON.parse(sent[before] ?? '{}');
    ok(sent.length === before + 1 && pi.e === 'play_intent' && pi.sid === a.sid && pi.jid === jid, 'play pressed: play_intent with the attempt\'s sid and the journey', pi);
    a.playRequested();
    ok(sent.length === before + 1, 'play_intent once per attempt');
    const sel = JSON.parse(sent.find((l) => JSON.parse(l).e === 'content_select')!);
    ok(sel.entry === 'row' && sel.ed === 'Trending' && sel.pos === 3 && sel.cid === 'c1', 'select: entry row, row name and position', sel);
    jr.search(5, 'secret words');
    const se = JSON.parse(sent[sent.length - 1]);
    ok(se.e === 'search' && se.n === 5 && !('qh' in se) && !JSON.stringify(se).includes('secret'), 'search: the query is left out by default', se);
    for (let i = 0; i < 25; i++) jr.track(`ev_${i}`, { n: i });
    jr.track('Bad Name');
    ok(jr.log.filter((e) => e.e === 'track').length === 20, 'custom events: at most 20 names an app session, names checked');
    const all = sent.map((l) => checkJourneyEvent(JSON.parse(l), clock));
    ok(all.every((c) => c.ok && !c.dropped?.length), 'every event the SDK makes is valid for the collector, with nothing to drop', all.filter((c) => !c.ok || c.dropped?.length));
    ok(fwd.length === jr.log.length && ga.length === jr.log.length, `GA4 pass-through: the same ${jr.log.length} events`, { ga: ga.length, fwd: fwd.length, log: jr.log.length });
    const names = ga.map((x) => x[1]);
    ok(names.includes('screen_view') && names.includes('select_content') && names.includes('volt_play') && names.includes('search') && names.includes('volt_app_open'), 'GA4 names: screen_view, select_content, search, volt_play, volt_app_open', [...new Set(names)]);
    const gsel = ga.find((x) => x[1] === 'select_content')![2] as any;
    ok(gsel.content_id === 'c1' && gsel.item_list_name === 'Trending' && gsel.index === 3 && gsel.volt_journey === jid, 'GA4 select_content carries the row, position and journey', gsel);
    jr.setConsent(false);
    const n0 = sent.length, g0 = ga.length;
    jr.screen('x'); jr.select('c2');
    ok(sent.length === n0 && ga.length === g0, 'consent withdrawn: nothing more is sent or forwarded');
    // Background over 30 minutes: a new app session.
    const jr2 = new j.VoltJourney({ appKey: 'pk_x', listen: false, sink: { push: () => {}, flush: () => {} }, now: () => clock });
    const as1 = jr2.appSessionId; jr2.background(); clock += 31 * 60_000; jr2.foreground();
    ok(jr2.appSessionId !== as1 && jr2.log[jr2.log.length - 1].e === 'app_open', 'back after 30 minutes in the background: a new app session');
    ok(j.parseEntry('row:Kids: new').kind === 'row' && j.parseEntry('row:Kids: new').detail === 'Kids: new' && j.parseEntry('weird').kind === 'other', 'entry parsing');
  }

  // ---------------------------------------------------------------- server
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { generateKey } = await import('../src/services/apiKeys');
  const { signAccess } = await import('../src/auth/jwt');
  const adb = await import('../src/services/qoe/analyticsDb');
  const coll = await import('../src/services/qoe/collector');
  const jn = await import('../src/services/qoe/journeys');
  const { replayRange } = await import('../src/services/qoe/replay');
  const { config } = await import('../src/config');
  const aurl = adb.analyticsUrl();
  const aname = new URL(aurl).pathname.slice(1);
  {
    const { Client } = await import('pg'); const u = new URL(config.databaseUrl); u.pathname = '/postgres';
    const c = new Client({ connectionString: u.toString() }); await c.connect(); await c.query(`DROP DATABASE IF EXISTS "${aname}" WITH (FORCE)`); await c.end();
  }
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`jrn-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`jrnb-${tag}`]))!.id;
  const app = await one<any>(`INSERT INTO apps(account_id, name, type, restrictions) VALUES ($1,'TV app','web','{}') RETURNING id`, [acct]);
  const k = generateKey('publishable');
  await query(`INSERT INTO api_keys(account_id, app_id, kind, key_prefix, key_hash, scopes) VALUES ($1,$2,'publishable',$3,$4,'{playback}')`, [acct, app!.id, k.prefix, k.hash]);
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `jrn-${tag}@example.com`]))!.id;
  const user2 = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [other, `jrnb-${tag}@example.com`]))!.id;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' } as any);
  const tok2 = signAccess({ sub: user2, account_id: other, role: 'owner' } as any);
  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const UA = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/7.0 TV Safari/537.36';
  const jpost = (body: string, type = 'application/x-ndjson', key = k.raw) => fetch(`${base}/api/journey?appKey=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'content-type': type, 'user-agent': UA, 'cloudfront-viewer-country': 'AU' }, body });
  const cpost = (lines: string[]) => fetch(`${base}/api/cmcd?appKey=${encodeURIComponent(k.raw)}`, { method: 'POST', headers: { 'content-type': 'application/cmcd', 'user-agent': UA, 'cloudfront-viewer-country': 'AU' }, body: lines.join('\n') });
  const T0 = Date.now() - 40 * 60_000;
  const W = `from=${new Date(T0 - 3_600_000).toISOString()}&to=${new Date(Date.now() + 3_600_000).toISOString()}`;
  const get = async (path: string, t = tok) => { const r = await fetch(`${base}/api/analytics/qoe${path}`, { headers: { authorization: `Bearer ${t}` } }); return { status: r.status, body: await r.json().catch(() => null) as any }; };

  try {
    // ------------------------------------------------------ refusals
    console.log('== the collector refuses what is not a journey event ==');
    ok((await jpost('{}', 'text/plain')).status === 415, '415 for another content type');
    ok((await jpost(JSON.stringify({ v: 1, e: 'screen', ts: Date.now(), asid: 'abcdefgh-1' }), 'application/x-ndjson', 'pk_nope')).status === 410, '410 for an unknown key');
    const bad = await jpost([JSON.stringify({ v: 1, e: 'nonsense', ts: Date.now(), asid: 'abcdefgh-1' }), JSON.stringify({ v: 1, e: 'content_select', ts: Date.now(), asid: 'abcdefgh-1', cid: 'x' }), 'not json'].join('\n'));
    ok(bad.status === 400, '400 when nothing is valid (an unknown event, a select without a journey id, a line that is not JSON)', bad.status);

    // ------------------------------------------------------ the planted app sessions
    // Each: [ms after T0, event] lines for one app session, and the plays' CMCD lines.
    let n = 0;
    const sessions: Array<{ asid: string; evs: any[] }> = [];
    const views: string[][] = [];
    const S = (name: string) => `${name}-${tag}`.padEnd(8, '0');
    function session(name: string, offset: number, steps: Array<[number, any]>) {
      const asid = S('as-' + name);
      let sn = 0;
      const evs = steps.map(([t, e]) => ({ v: 1, ts: T0 + offset + t, asid, sn: ++sn, ...(sn === 1 ? { app: 'Volt TV', appv: '4.2.0' } : {}), ...e }));
      sessions.push({ asid, evs });
      return asid;
    }
    /** A play's CMCD view, its first report carrying the journey. outcome: started (with startup and playing ms, ended or quit), or refused for payment. */
    function view(sid: string, cid: string, at: number, jk: L, how: { startup?: number; play?: number; end?: 'e' | 'q'; pay?: boolean }) {
      let sn = 0;
      const id: L = { v: 2, sid, cid, st: 'v', 'com.volt-app': 'Volt TV', 'com.volt-appv': '4.2.0', ...jk };
      const L2 = (t: number, d: L) => enc({ ...(sn === 0 ? id : { v: 2, sid, cid, st: 'v' }), ts: T0 + at + t, sn: ++sn, ...d });
      const out = [L2(0, { e: 'ps', sta: 's' })];
      if (how.pay) { out.push(L2(200, { e: 'e', ec: ['gate-402'], 'com.volt-step': 'entitlement', su: true })); out.push(L2(201, { e: 'ps', sta: 'f' })); }
      else {
        out.push(L2(how.startup!, { e: 'ps', sta: 'p', msd: how.startup!, br: [3000], 'com.volt-tent': '100' }));
        out.push(L2(how.startup! + how.play!, { e: 'ps', sta: how.end! }));
      }
      views.push(out);
    }
    const jk = (asid: string, jid: string, entry: string, depth: number): L => ({ 'com.volt-asid': asid, 'com.volt-jid': jid, 'com.volt-entry': entry, 'com.volt-depth': String(depth) });
    // A: four viewers from the Trending row, position 3: home, select, detail, play at 6 s, first frame 1 s later; two watch to the end.
    for (let i = 0; i < 4; i++) {
      const jid = S(`j-a${i}`), sid = S(`v-a${i}`), off = i * 60_000;
      const asid = session(`a${i}`, off, [[0, { e: 'app_open', launch: 'icon', cold: true }], [1000, { e: 'screen', name: 'Home', type: 'home' }],
        [4000, { e: 'content_select', jid, cid: 'film-1', entry: 'row', ed: 'Trending', pos: 3 }], [4500, { e: 'screen', jid, name: 'Detail', type: 'detail', cid: 'film-1' }],
        [6000, { e: 'play_intent', jid, sid, cid: 'film-1' }]]);
      view(sid, 'film-1', off + 6000, jk(asid, jid, 'row', 2), { startup: 1000, play: 60_000, end: i < 2 ? 'e' : 'q' });
    }
    // B: three viewers from the Premium row press play and are asked to pay; one cancels, two just leave. The planted drop-off.
    for (let i = 0; i < 3; i++) {
      const jid = S(`j-b${i}`), sid = S(`v-b${i}`), off = 300_000 + i * 60_000;
      const steps: Array<[number, any]> = [[0, { e: 'app_open', launch: 'icon' }], [1000, { e: 'screen', name: 'Home', type: 'home' }],
        [3000, { e: 'content_select', jid, cid: 'film-p', entry: 'row', ed: 'Premium', pos: 1 }], [3500, { e: 'screen', jid, name: 'Detail', type: 'detail', cid: 'film-p' }],
        [5000, { e: 'play_intent', jid, sid, cid: 'film-p' }], [5400, { e: 'paywall_show', jid, product: 'monthly' }]];
      if (i === 0) steps.push([9000, { e: 'purchase', jid, product: 'monthly', outcome: 'cancelled' }]);
      steps.push([12_000, { e: 'app_close' }]);
      const asid = session(`b${i}`, off, steps);
      view(sid, 'film-p', off + 5000, jk(asid, jid, 'row', 2), { pay: true });
    }
    // C: a deep link straight to a detail page.
    { const jid = S('j-c'), sid = S('v-c'), off = 600_000;
      const asid = session('c', off, [[0, { e: 'app_open', launch: 'deeplink', jid, cid: 'film-2' }], [800, { e: 'screen', jid, name: 'Detail', type: 'detail', cid: 'film-2' }], [2000, { e: 'play_intent', jid, sid, cid: 'film-2' }]]);
      view(sid, 'film-2', off + 2000, jk(asid, jid, 'deeplink', 1), { startup: 2000, play: 30_000, end: 'e' }); }
    // D: search, then the detail page and a play.
    { const jid = S('j-d'), sid = S('v-d'), off = 660_000;
      const asid = session('d', off, [[0, { e: 'app_open', launch: 'icon' }], [1000, { e: 'screen', name: 'Search', type: 'search' }], [3000, { e: 'search', n: 5, q: 'my private words' }],
        [5000, { e: 'content_select', jid, cid: 'film-3', entry: 'search', pos: 0, email: 'viewer@example.com' }], [5500, { e: 'screen', jid, name: 'Detail', type: 'detail', cid: 'film-3' }],
        [8000, { e: 'play_intent', jid, sid, cid: 'film-3' }]]);
      view(sid, 'film-3', off + 8000, jk(asid, jid, 'search', 2), { startup: 1500, play: 20_000, end: 'q' }); }
    // E: opened, looked at home, left.  F: picked a title from Trending, read its page, never played it.
    session('e', 720_000, [[0, { e: 'app_open', launch: 'icon' }], [1000, { e: 'screen', name: 'Home', type: 'home' }], [4000, { e: 'background' }], [10_000, { e: 'foreground' }], [12_000, { e: 'app_close' }]]);
    { const jid = S('j-f');
      session('f', 780_000, [[0, { e: 'app_open', launch: 'icon' }], [1000, { e: 'screen', name: 'Home', type: 'home' }], [2000, { e: 'content_select', jid, cid: 'film-x', entry: 'row', ed: 'Trending', pos: 7 }],
        [2500, { e: 'screen', jid, name: 'Detail', type: 'detail', cid: 'film-x' }], [20_000, { e: 'app_close' }]]); }

    // Send: two sessions per POST as NDJSON, one as a JSON array, the plays to the CMCD collector.
    let dropped = 0, status: number[] = [];
    for (let i = 0; i < sessions.length; i += 2) {
      const evs = sessions.slice(i, i + 2).flatMap((s) => s.evs);
      const r = i === 2 ? await jpost(JSON.stringify(evs), 'application/json') : await jpost(evs.map((e) => JSON.stringify(e)).join('\n'));
      status.push(r.status); dropped += Number(r.headers.get('x-journey-dropped-fields') ?? 0);
    }
    ok(status.every((s) => s === 204), `${sessions.length} app sessions accepted (NDJSON and a JSON array)`, status);
    // The same batch again (a retry after a lost answer) counts once.
    const r2 = await jpost(sessions[0].evs.map((e) => JSON.stringify(e)).join('\n'));
    ok(r2.status === 204, 'a resent batch is accepted');
    for (const v of views) ok((await cpost(v)).status === 204 || false, `play ${++n} reported to the CMCD collector`);
    ok(dropped === 2, 'two fields not kept: the plain search query and an e-mail address', dropped);
    const rawFiles = walk(join(process.env.QOE_RAW_DIR!, 'journey'));
    const raw = rawFiles.map((f) => readFileSync(f, 'utf8')).join('');
    ok(rawFiles.length > 0 && raw.includes('app_open') && !raw.includes('viewer@example.com') && !raw.includes('private words'), 'kept raw first, in the journey stream, without them', rawFiles.length);
    ok(!readdirSync(process.env.QOE_RAW_DIR!).filter((d) => /^[0-9a-f-]{36}$/.test(d)).some((d) => walk(join(process.env.QOE_RAW_DIR!, d)).some((f) => readFileSync(f, 'utf8').includes('app_open'))), 'and never in the CMCD stream');

    await jn.flushJourneys();
    await coll.flushQoe(Date.now() + 5 * 60_000);

    // ------------------------------------------------------ 28
    console.log('== 28. journey to play ==');
    const f = await get(`/journeys?${W}`);
    const st = Object.fromEntries((f.body?.steps ?? []).map((x: any) => [x.step, x]));
    ok(f.status === 200 && f.body.sessions === 11, '11 app sessions', f.body?.sessions);
    const want: Record<string, number> = { open: 11, browse: 11, detail: 10, play: 9, entitled: 9, paid: 6, first_frame: 6 };
    for (const [k2, v] of Object.entries(want)) ok(st[k2]?.sessions === v, `${k2}: ${v}`, st[k2]);
    ok(st.paid?.dropOff === 3 && st.paid?.fromPrevious === 6 / 9, 'the planted drop-off: 3 of 9 lost between allowed to watch and paid', st.paid);
    ok(st.play?.dropOff === 1 && st.detail?.dropOff === 1, 'one left after the detail page, one after the home screen', { play: st.play?.dropOff, detail: st.detail?.dropOff });
    ok(f.body.paywall.shown === 3 && f.body.paywall.purchased === 0 && f.body.paywall.abandoned === 3, 'paywall: shown 3, bought 0', f.body.paywall);
    // first frame after open: A 6000+1000 = 7000 (x4), C 2000+2000 = 4000, D 8000+1500 = 9500 -> nearest rank p50 of [4000,7000,7000,7000,7000,9500] = 7000
    ok(f.body.openToFirstFrame.p50 === 7000 && f.body.openToFirstFrame.p95 === 9500 && f.body.openToFirstFrame.n === 6, 'app open to first frame: p50 7 s, p95 9.5 s', f.body.openToFirstFrame);
    ok(st.play?.msSinceOpen.p50 === 6000 && st.detail?.msSinceOpen.p50 === 3500, 'time at each step: play pressed at 6 s, the detail page at 3.5 s (p50)', { play: st.play?.msSinceOpen, detail: st.detail?.msSinceOpen });
    const fr = await get(`/journeys?${W}&entry_point=row`);
    const sr = Object.fromEntries((fr.body?.steps ?? []).map((x: any) => [x.step, x.sessions]));
    ok(fr.body.sessions === 8 && sr.play === 7 && sr.first_frame === 4 && sr.paid === 4, 'filtered to the rows: 8 sessions, 7 plays, 4 first frames', sr);

    // ------------------------------------------------------ 29
    console.log('== 29. discovery attribution ==');
    const d = await get(`/discovery?${W}`);
    const by = Object.fromEntries((d.body?.rows ?? []).map((r: any) => [r.entry, r]));
    ok(d.status === 200 && d.body.journeys === 10, '10 journeys (8 from rows, a deep link, a search)', d.body?.journeys);
    ok(by.row?.journeys === 8 && by.row?.plays === 7 && by.row?.started === 4 && by.row?.completion === 0.5, 'rows: 8 journeys, 7 played, 4 started, half watched to the end', by.row);
    ok(by.row?.watchMs === 240_000 && by.deeplink?.watchMs === 30_000 && by.search?.watchMs === 20_000, 'watch time by entry point: rows 4 min, deep link 30 s, search 20 s', { row: by.row?.watchMs, dl: by.deeplink?.watchMs, s: by.search?.watchMs });
    ok(by.deeplink?.completion === 1 && by.search?.completion === 0 && by.row?.startupP50 === 1000 && by.deeplink?.startupP50 === 2000, 'completion and startup by entry point', { dl: by.deeplink, s: by.search });
    ok(by.row?.startupFailureRate === 3 / 7, 'QoE by entry point: 3 of the 7 row plays never started (asked to pay)', by.row?.startupFailureRate);
    const dd = await get(`/discovery?${W}&by=detail`);
    const rows = Object.fromEntries((dd.body?.rows ?? []).map((r: any) => [`${r.entry}:${r.detail ?? ''}`, r]));
    ok(rows['row:Trending']?.journeys === 5 && rows['row:Trending']?.started === 4 && rows['row:Premium']?.journeys === 3 && rows['row:Premium']?.started === 0, 'by row: Trending 5 journeys and 4 started, Premium 3 and none', { t: rows['row:Trending'], p: rows['row:Premium'] });
    ok(rows['row:Trending']?.positionP50 === 3, 'the position in the row (p50 3)', rows['row:Trending']?.positionP50);
    const np = (d.body?.neverPlayed ?? []).find((x: any) => x.contentId === 'film-x');
    ok(np && np.detailViews === 1 && np.neverPlayed === 1 && d.body.neverPlayed[0].contentId === 'film-x', 'viewed, never played: film-x first', d.body?.neverPlayed);
    ok((d.body?.neverPlayed ?? []).find((x: any) => x.contentId === 'film-1')?.neverPlayed === 0, 'a title viewed and played is not counted as never played');

    // ------------------------------------------------------ the view rows carry the journey
    console.log('== a QoE view row carries its journey ==');
    const [vr] = await adb.aquery<any>(`SELECT journey_id, app_session_id, entry_point, session_depth, def_version FROM qoe_views WHERE account_id = $1 AND sid = $2`, [acct, S('v-a0')]);
    ok(vr?.journey_id === S('j-a0') && vr?.app_session_id === S('as-a0') && vr?.entry_point === 'row' && vr?.session_depth === 2 && vr?.def_version === 3, 'journey id, app session, entry point and depth on the view (definitions version 3)', vr);
    const ov = await get(`/overview?${W}&entry_point=search`);
    ok(ov.body?.success?.attempts === 1 && ov.body?.success?.started === 1, 'reports 1 to 10 filter by entry point: one search play', ov.body?.success);
    const od = await get(`/overview?${W}&session_depth=1`);
    ok(od.body?.success?.attempts === 1, 'and by session depth: one play after a single screen (the deep link)', od.body?.success?.attempts);
    const od2 = await get(`/overview?${W}&session_depth=2-5`);
    ok(od2.body?.success?.attempts === 8, 'a depth range: 8 plays after 2 to 5 screens', od2.body?.success?.attempts);
    const bd = await get(`/breakdown?${W}&by=entry_point&measure=failure&minViews=1`);
    ok(bd.status === 200 && bd.body.rows[0]?.value === 'row', 'worst segments by entry point: the rows (asked to pay) first', bd.body?.rows);
    const dims = await get(`/dimensions?${W}`);
    ok((dims.body?.entry_point ?? []).length === 3, 'the filter lists know the entry points', dims.body?.entry_point);

    // ------------------------------------------------------ tenancy
    const f2 = await get(`/journeys?${W}`, tok2), d2 = await get(`/discovery?${W}`, tok2);
    ok(f2.body?.sessions === 0 && d2.body?.journeys === 0, 'another account sees none of it');

    // ------------------------------------------------------ replay
    console.log('== replay gives identical reports ==');
    const before = JSON.stringify([f.body.steps, f.body.openToFirstFrame, d.body.rows, d.body.neverPlayed, dd.body.rows]);
    await adb.aquery(`DELETE FROM qoe_app_sessions WHERE account_id = $1`, [acct]);
    await adb.aquery(`DELETE FROM qoe_journeys WHERE account_id = $1`, [acct]);
    const gone = await get(`/journeys?${W}`);
    ok(gone.body.sessions === 0, 'derived rows deleted');
    const days = [...new Set([new Date(T0).toISOString().slice(0, 10), new Date().toISOString().slice(0, 10)])].sort();
    const res = await replayRange(days[0], days[days.length - 1], acct);
    ok(res.reduce((a, r) => a + r.appSessions, 0) === 11 && res.reduce((a, r) => a + r.journeys, 0) === 10, 'replay rebuilt 11 app sessions and 10 journeys from the raw events', res);
    const f3 = await get(`/journeys?${W}`), d3 = await get(`/discovery?${W}`), dd3 = await get(`/discovery?${W}&by=detail`);
    const after = JSON.stringify([f3.body.steps, f3.body.openToFirstFrame, d3.body.rows, d3.body.neverPlayed, dd3.body.rows]);
    ok(after === before, 'reports 28 and 29 identical after the replay', after === before ? undefined : { before, after });
    const col = await get('/collector');
    ok(col.body?.journeys?.ingested >= 40, 'the collector panel counts the journey events', col.body?.journeys);
  } catch (e) {
    fail++; console.log('FAIL unexpected: ' + ((e as Error).stack ?? e));
  } finally {
    srv.close();
    await adb.closeAnalytics();
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
