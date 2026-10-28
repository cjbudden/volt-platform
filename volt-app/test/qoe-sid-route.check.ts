// ============================================================================
//  COLLECTOR SESSIONS ROUTED BY SID ACROSS TASKS (build queue 2.11b,
//  services/qoe/sidRoute.ts and nightly.ts).
//
//  Two real collector processes (test/fixtures/qoe-collector-node.ts: the
//  product's CMCD router on its own port) share one analytics database and
//  one raw folder, like two tasks behind the load balancer. Every session's
//  batches are sent alternately to both.
//    1. Without routing (QOE_ROUTE=off, the behaviour before): each process
//       writes its own partial view with the same id, so the live rows are
//       not what a replay gives, and each process holds every session.
//    2. With routing: both list themselves and agree on every owner; one
//       view row per session, identical to a replay of the raw reports; each
//       process holds only its share of the sessions.
//    3. The peer route refuses anything not signed by a task (no signature,
//       a stale one, a changed body).
//    4. An owner that dies: its forwards are derived where they arrived
//       (counted), and once it misses three heartbeats it is not a member.
//    5. The nightly replay: not before its hour, exactly once per day
//       however many tasks ask at once, and it makes yesterday's split
//       sessions exact.
//    6. Rendezvous hashing: a task leaving moves only its own sessions;
//       Terraform lets the control-plane tasks reach each other on 8080 and
//       turns routing on.
//
//  Usage: DATABASE_URL=... npx tsx test/qoe-sid-route.check.ts
// ============================================================================
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as netServer } from 'node:net';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ROOT = resolve(__dirname, '..');
const TF = resolve(ROOT, '../deploy/terraform');
process.env.QOE_RAW_DIR = mkdtempSync(join(tmpdir(), 'qoe-raw-route-'));
process.env.QOE_PEER_SECRET = process.env.QOE_PEER_SECRET || 'route-check-secret';
process.env.QOE_NIGHTLY_REPLAY = 'off'; // the suite drives it with its own clock
delete process.env.QOE_RAW_BUCKET;
delete process.env.QOE_STORE;

type L = Record<string, string | number | boolean>;
function enc(d: L): string {
  const TOK = new Set(['e', 'sta', 'st', 'ot', 'sf']);
  return Object.keys(d).sort().map((k) => {
    const v = d[k];
    if (v === true) return k;
    if (typeof v === 'number') return `${k}=${v}`;
    if (TOK.has(k)) return `${k}=${v}`;
    return `${k}="${String(v)}"`;
  }).join(',');
}

const freePort = () => new Promise<number>((res) => { const s = netServer().listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });

interface Node { name: string; port: number; url: string; proc: ChildProcess; log: string[] }
async function startNode(name: string, route: 'on' | 'off'): Promise<Node> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), QOE_PEER_HEARTBEAT_MS: '300' };
  if (route === 'on') { env.QOE_ROUTE = 'auto'; env.QOE_PEER_URL = url; } else { env.QOE_ROUTE = 'off'; delete env.QOE_PEER_URL; }
  // node itself with tsx loaded (not the tsx command, which runs a second process a kill would not reach)
  const proc = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'test/fixtures/qoe-collector-node.ts')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log: string[] = [];
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${name} did not start: ${log.join('')}`)), 60_000);
    const on = (b: Buffer) => { log.push(String(b)); if (String(b).includes('READY')) { clearTimeout(t); res(); } };
    proc.stdout!.on('data', on); proc.stderr!.on('data', (b) => log.push(String(b)));
    proc.on('exit', (c) => { clearTimeout(t); rej(new Error(`${name} exited ${c}: ${log.join('')}`)); });
  });
  proc.removeAllListeners('exit');
  return { name, port, url, proc, log };
}
const stopNode = async (n: Node, sig: NodeJS.Signals = 'SIGTERM') => { if (n.proc.exitCode != null || n.proc.signalCode != null) return; const done = new Promise((r) => n.proc.once('exit', r)); n.proc.kill(sig); await done; };
const state = async (n: Node) => (await fetch(`${n.url}/__test/state`)).json() as Promise<any>;
const drain = async (...ns: Node[]) => { for (const n of ns) await fetch(`${n.url}/__test/drain`, { method: 'POST' }); };
const flush = async (n: Node, now: number) => (await fetch(`${n.url}/__test/flush?now=${now}`, { method: 'POST' })).json() as Promise<any>;

(async () => {
  const { pool, one, query } = await import('../src/db');
  const { generateKey } = await import('../src/services/apiKeys');
  const adb = await import('../src/services/qoe/analyticsDb');
  const { replayDay } = await import('../src/services/qoe/replay');
  const sr = await import('../src/services/qoe/sidRoute');
  const nightly = await import('../src/services/qoe/nightly');
  const { config } = await import('../src/config');

  const aurl = adb.analyticsUrl();
  const aname = new URL(aurl).pathname.slice(1);
  { const { Client } = await import('pg'); const u = new URL(config.databaseUrl); u.pathname = '/postgres';
    const c = new Client({ connectionString: u.toString() }); await c.connect(); await c.query(`DROP DATABASE IF EXISTS "${aname}"`); await c.end(); }
  await adb.analyticsPool();

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`route-${tag}`]))!.id;
  const app = await one<any>(`INSERT INTO apps(account_id, name, type, restrictions) VALUES ($1,'Web','web','{}') RETURNING id`, [acct]);
  const k = generateKey('publishable');
  await query(`INSERT INTO api_keys(account_id, app_id, kind, key_prefix, key_hash, scopes) VALUES ($1,$2,'publishable',$3,$4,'{playback}')`, [acct, app!.id, k.prefix, k.hash]);

  const T0 = Date.now();
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
  /** One viewer's reports in four batches: start, first frame, a stall for some, heartbeats, quit. */
  const viewer = (sid: string, i: number): string[][] => {
    const b = { v: 2, sid, cid: i % 3 ? 'content-sport' : 'content-film', st: 'v' } as L;
    let sn = 0; const at = (t: number, d: L) => enc({ ...b, ts: T0 + t, sn: ++sn, ...d });
    const startup = 400 + (i * 37) % 900;
    const lines = [
      at(0, { e: 'ps', sta: 's', 'com.volt-app': 'Web', 'com.volt-appv': '2.0.0' }),
      at(startup, { e: 'ps', sta: 'p', msd: startup }),
      at(startup + 2000, { e: 'bc', br: 3000 }),
      at(startup + 5000, { e: 't', bl: 12000, pb: 3000 }),
      ...(i % 4 === 0 ? [at(startup + 8000, { e: 'ps', sta: 'r' }), at(startup + 8000 + 500 + i * 10, { e: 'ps', sta: 'p' })] : [at(startup + 8000, { e: 't', bl: 11000, pb: 3000 })]),
      at(startup + 15000, { e: 't', bl: 12000, pb: 3000 }),
      at(startup + 20000 + i * 100, { e: 'ps', sta: 'q' }),
    ];
    return [lines.slice(0, 2), lines.slice(2, 4), lines.slice(4, 6), lines.slice(6)];
  };
  const post = (n: Node, lines: string[]) => fetch(`${n.url}/api/cmcd?appKey=${encodeURIComponent(k.raw)}`, { method: 'POST', headers: { 'content-type': 'application/cmcd', 'user-agent': UA }, body: lines.join('\n') });
  /** Every viewer's batches, alternating between the nodes; drained after each so a forward lands before the next batch. */
  const sendAlternating = async (sids: string[], nodes: Node[]) => {
    let ok204 = 0, total = 0;
    for (const [i, sid] of sids.entries()) {
      for (const [j, batch] of viewer(sid, i).entries()) {
        const r = await post(nodes[(i + j) % nodes.length], batch); total++;
        if (r.status === 204) ok204++; else console.log('  post', r.status, await r.text());
        await drain(...nodes);
      }
    }
    return { ok204, total };
  };
  const rowsOf = async (sids: string[]) => (await adb.aquery(`SELECT * FROM qoe_views WHERE account_id = $1 AND sid = ANY($2) ORDER BY sid, attempt`, [acct, sids]))
    .map((r: any) => JSON.stringify(r));
  const day = new Date(T0).toISOString().slice(0, 10);
  const N = 40;
  const later = T0 + 10 * 60_000; // past every view's silence window

  const nodes: Node[] = [];
  try {
    console.log('== 1. two tasks without routing (the behaviour before) ==');
    const sOff = Array.from({ length: N }, (_, i) => `off-${tag}-${String(i).padStart(3, '0')}`);
    {
      const a = await startNode('A', 'off'), b = await startNode('B', 'off'); nodes.push(a, b);
      const s = await sendAlternating(sOff, [a, b]);
      ok(s.ok204 === s.total, `every batch accepted by one or the other (${s.ok204}/${s.total})`);
      const [sa, sb] = [await flush(a, later), await flush(b, later)];
      ok(sa.sessions === N && sb.sessions === N, `each task holds every session (${sa.sessions} and ${sb.sessions} of ${N})`, [sa.sessions, sb.sessions]);
      const live = await rowsOf(sOff);
      ok(live.length === N, `one row per view id (${live.length}), but written twice, once by each task`);
      await replayDay(acct, day);
      const replayed = await rowsOf(sOff);
      const same = live.filter((r, i) => r === replayed[i]).length;
      ok(same < N, `live rows differ from a replay of the raw reports (${N - same} of ${N} differ): each is half a session`, same);
      await stopNode(a); await stopNode(b); nodes.length = 0;
    }

    console.log('== 2. two tasks routing by sid ==');
    const sOn = Array.from({ length: N }, (_, i) => `on-${tag}-${String(i).padStart(3, '0')}`);
    const a = await startNode('A', 'on'), b = await startNode('B', 'on'); nodes.push(a, b);
    // A task joins with its first report: one throwaway report each, then the heartbeats see both.
    for (const n of [a, b]) await post(n, [enc({ v: 2, sid: `warm-${n.name}-${tag}`, ts: Date.now(), sn: 1, e: 'ps', sta: 's' })]);
    let sa: any, sb: any;
    for (let i = 0; i < 30; i++) { sa = await state(a); sb = await state(b); if (sa.route.members.length === 2 && sb.route.members.length === 2) break; await sleep(200); }
    ok(sa.route.members.length === 2 && JSON.stringify(sa.route.members) === JSON.stringify(sb.route.members), 'both tasks list the same two members', [sa.route.members, sb.route.members]);
    const members = sa.route.members.map((id: string) => ({ id, url: '' }));
    const owners = sOn.map((sid) => sr.ownerOf(acct, sid, members)!.id);
    const shareA = owners.filter((o) => o === sa.route.self).length;
    ok(shareA > N * 0.2 && shareA < N * 0.8, `the sessions spread over both owners (${shareA} and ${N - shareA})`);
    const s = await sendAlternating(sOn, [a, b]);
    ok(s.ok204 === s.total, `every batch accepted (${s.ok204}/${s.total})`);
    sa = await flush(a, later); sb = await flush(b, later);
    // Less the warm-up sessions: A took its own before B had joined; B's went to its owner.
    const warmBtoA = sr.ownerOf(acct, `warm-B-${tag}`, members)!.id === sa.route.self ? 1 : 0;
    const held = (st: any) => st.sessions - (st === sa ? 1 + warmBtoA : 1 - warmBtoA);
    ok(held(sa) + held(sb) === N && held(sa) === shareA && held(sb) === N - shareA, `each task holds only the sessions it owns (${held(sa)} + ${held(sb)} = ${N}; without routing ${N} each)`, [held(sa), held(sb)]);
    ok(sa.route.forwarded > 0 && sb.route.forwarded > 0 && sa.route.received > 0 && sb.route.received > 0 && sa.route.forwardFailed === 0 && sb.route.forwardFailed === 0,
      `forwards both ways, none failed (A sent ${sa.route.forwarded} received ${sa.route.received}; B sent ${sb.route.forwarded} received ${sb.route.received})`, [sa.route, sb.route]);
    const totalLines = sOn.reduce((n, sid, i) => n + viewer(sid, i).flat().length, 0);
    ok(sa.route.local + sa.route.received + sb.route.local + sb.route.received === totalLines + 2, `every report derived exactly once (${totalLines} + 2 warm-up)`);
    const live = await rowsOf(sOn);
    ok(live.length === N, `one view row per session (${live.length})`);
    await replayDay(acct, day);
    const replayed = await rowsOf(sOn);
    ok(live.length === replayed.length && live.every((r, i) => r === replayed[i]), 'every live row identical to a replay of the raw reports', live.find((r, i) => r !== replayed[i]));

    console.log('== 3. the peer route takes only signed forwards ==');
    const body = JSON.stringify({ from: 'x', batches: [{ acct, rows: [] }] });
    const peer = (h: Record<string, string>, b = body) => fetch(`${a.url}/api/cmcd/_peer`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: b });
    ok((await peer({})).status === 401, 'no signature: 401');
    ok((await peer({ 'x-volt-peer': sr.signPeer(body, Date.now() - 120_000) })).status === 401, 'a signature two minutes old: 401');
    ok((await peer({ 'x-volt-peer': sr.signPeer(body) }, body.replace('"x"', '"y"'))).status === 401, 'a changed body: 401');
    ok((await peer({ 'x-volt-peer': sr.signPeer(body) })).status === 204, 'signed with the task key: 204');
    ok(sr.verifyPeer(sr.signPeer('abc'), 'abc') && !sr.verifyPeer(sr.signPeer('abc'), 'abd'), 'sign and verify agree in this process too');

    console.log('== 4. an owner dies ==');
    const bId = sb.route.self;
    let orphan = '';
    for (let i = 0; !orphan; i++) { const sid = `orphan-${tag}-${i}`; if (sr.ownerOf(acct, sid, members)!.id === bId) orphan = sid; }
    await stopNode(b, 'SIGKILL');
    const before = await state(a);
    const r = await post(a, viewer(orphan, 1)[0]);
    await drain(a);
    const after = await state(a);
    ok(r.status === 204 && after.route.forwardFailed - before.route.forwardFailed === 2 && after.sessions === before.sessions + 1,
      'the dead owner\'s session: player still gets 204, the forward fails and is derived here (counted)', [r.status, after.route.forwardFailed, after.sessions - before.sessions]);
    let m1 = after.route.members.length;
    for (let i = 0; i < 20 && m1 > 1; i++) { await sleep(200); m1 = (await state(a)).route.members.length; }
    ok(m1 === 1, 'after three missed heartbeats the dead task is not a member');
    const l0 = (await state(a)).route.local;
    await post(a, viewer(orphan, 1)[1]); await drain(a);
    const st4 = await state(a);
    ok(st4.route.local - l0 === 2 && st4.route.forwardFailed === after.route.forwardFailed, 'its sessions are now this task\'s own: derived here, nothing forwarded');

    console.log('== 5. the nightly replay ==');
    // The rows of step 1 as the two unrouted tasks would have left them (wrong); the nightly replay must put them right.
    const tomorrow = Date.parse(day + 'T00:00:00Z') + 86_400_000;
    let calls = 0;
    const stub = async () => { calls++; await sleep(300); return [] as any[]; };
    ok((await nightly.nightlyReplay(tomorrow + 60 * 60_000, stub as any)) === null && calls === 0, 'before 02:30 UTC nothing is replayed');
    const liveOff = await rowsOf(sOff);
    await adb.aquery(`UPDATE qoe_views SET playing_ms = playing_ms + 1 WHERE account_id = $1 AND sid = ANY($2)`, [acct, sOff]); // as the split tasks had left them: wrong
    const got = await nightly.nightlyReplay(tomorrow + 3 * 3_600_000);
    ok(got === day && nightly.nightlyStats.lastViews >= 2 * N, `at 03:00 yesterday (${day}) is replayed from the raw reports (${nightly.nightlyStats.lastViews} views)`, [got, nightly.nightlyStats]);
    const fixed = await rowsOf(sOff);
    ok(fixed.length === N && fixed.every((x, i) => x === liveOff[i]), 'and the split sessions\' rows are exact again');
    ok((await nightly.nightlyReplay(tomorrow + 4 * 3_600_000, stub as any)) === null && calls === 0, 'asked again the same night: nothing (the marker)');
    const two = await Promise.all([nightly.nightlyReplay(tomorrow + 86_400_000 + 3 * 3_600_000, stub as any), nightly.nightlyReplay(tomorrow + 86_400_000 + 3 * 3_600_000, stub as any)]);
    ok(calls === 1 && two.filter(Boolean).length === 1, 'two tasks asking at the same moment: one replays, the other does nothing', [calls, two]);

    console.log('== 6. rendezvous hashing and Terraform ==');
    const ms = Array.from({ length: 4 }, (_, i) => ({ id: `task-${i}`, url: '' }));
    const sids = Array.from({ length: 4000 }, (_, i) => `s${i}`);
    const o4 = sids.map((x) => sr.ownerOf(acct, x, ms)!.id);
    const o3 = sids.map((x) => sr.ownerOf(acct, x, ms.filter((m) => m.id !== 'task-2'))!.id);
    const moved = sids.filter((_, i) => o4[i] !== o3[i]);
    ok(moved.length > 0 && sids.every((_, i) => o4[i] === 'task-2' || o4[i] === o3[i]), `a task leaving moves only its own sessions (${moved.length} of 4000, all task-2's)`);
    const counts = ms.map((m) => o4.filter((x) => x === m.id).length);
    ok(counts.every((c) => c > 800 && c < 1200), `four tasks share 4000 sessions evenly (${counts.join(', ')})`);
    const sec = readFileSync(join(TF, 'security.tf'), 'utf8');
    const cp = /resource "aws_security_group" "control_plane" \{([\s\S]*?)\n\}/.exec(sec)?.[1] ?? '';
    const selfRules = [...cp.matchAll(/ingress \{([\s\S]*?)\n  \}/g)].map((m) => m[1]).filter((x) => /self\s*=\s*true/.test(x));
    ok(selfRules.length === 1 && /from_port\s*=\s*8080/.test(selfRules[0]) && /to_port\s*=\s*8080/.test(selfRules[0]) && /protocol\s*=\s*"tcp"/.test(selfRules[0])
      && !/resource "aws_security_group_rule"/.test(sec), 'Terraform: control-plane tasks reach each other on 8080 only (inline, so the group\'s own rules are not overwritten)', selfRules);
    const raw = readFileSync(join(TF, 'qoe_raw.tf'), 'utf8');
    ok(/name = "QOE_ROUTE", value = "auto"/.test(raw), 'Terraform: routing on for the control-plane tasks (QOE_ROUTE=auto)');
  } finally {
    for (const n of nodes) await stopNode(n, 'SIGKILL').catch(() => {});
    rmSync(process.env.QOE_RAW_DIR!, { recursive: true, force: true });
    await adb.closeAnalytics();
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
