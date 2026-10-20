// ============================================================================
//  PLAN VS AS-RUN (services/asRun.ts): what aired, from the encoder's own
//  channel.start / channel.stop and playout.splice events, against the guide.
//  Pure cases first, then real rows and the HTTP report.
//    DATABASE_URL=... npx tsx test/as-run.check.ts
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};
const M = 60_000;

(async () => {
  const ar = await import('../src/services/asRun');
  const T = 1_800_000_000_000;
  // ---- pure ----------------------------------------------------------------------------------
  const runs = ar.runsFrom([{ type: 'channel.start', ts: T - 60 * M }, { type: 'channel.stop', ts: T + 10 * M }, { type: 'channel.start', ts: T + 20 * M }], T + 90 * M);
  check('runs from start/stop, the open one runs to now', runs, [[T - 60 * M, T + 10 * M], [T + 20 * M, T + 90 * M]]);
  check('a start with no stop ends the previous run', ar.runsFrom([{ type: 'channel.start', ts: 0 }, { type: 'channel.start', ts: 10 }], 20), [[0, 10], [10, 20]]);
  const fill = ar.fillersFrom([{ type: 'playout.splice', ts: T + 30 * M, to: 'loop' }, { type: 'playout.splice', ts: T + 35 * M, to: 'live' }], T + 90 * M);
  check('filler stretches from the splice events', fill, [[T + 30 * M, T + 35 * M]]);
  let a = ar.asRunFor([T, T + 30 * M], runs, fill, T + 90 * M);
  check('programme across a 10 minute outage: actual start is the plan start', a.actualStart, T);
  check('...on air 20 of 30 minutes', a.onAirMs, 20 * M);
  check('...actual end is when it last aired', a.actualEnd, T + 30 * M);
  check('...aired', a.status, 'aired');
  a = ar.asRunFor([T + 30 * M, T + 60 * M], runs, fill, T + 90 * M);
  check('programme with 5 minutes of loop: filler counted', [a.onAirMs, a.fillerMs], [30 * M, 5 * M]);
  a = ar.asRunFor([T + 11 * M, T + 19 * M], runs, fill, T + 90 * M);
  check('programme entirely in the outage: nothing aired, stays scheduled', [a.status, a.actualStart, a.actualEnd], ['scheduled', null, null]);
  a = ar.asRunFor([T + 80 * M, T + 120 * M], runs, fill, T + 90 * M);
  check('programme on air now: live, started, no end yet', [a.status, a.actualStart, a.actualEnd], ['live', T + 80 * M, null]);
  a = ar.asRunFor([T + 2 * M, T + 15 * M], [[T + 5 * M, T + 50 * M]], [], T + 90 * M);
  check('channel came up late: actual start is when it came up', a.actualStart, T + 5 * M);

  // ---- database + HTTP -------------------------------------------------------------------------
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`ar-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`ar-o-${tag}`]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `ar-${tag}@volt.test`]))!.id;
  const otherUser = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [other, `ar-o-${tag}@volt.test`]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
  const g = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name, status) VALUES ($1,'AR News','live') RETURNING id`, [g]))!.id;
  const now = Date.now();
  const at = (min: number) => new Date(now + min * M);
  const prog = async (title: string, a0: number, b0: number) => (await one<any>(`INSERT INTO programmes(channel_id, title, starts_at, ends_at) VALUES ($1,$2,$3,$4) RETURNING id`, [ch, title, at(a0), at(b0)]))!.id;
  const pA = await prog('Breakfast', -120, -90);   // before the channel ran: missed
  const pB = await prog('Midday', -60, -30);        // across an outage and a loop
  const pC = await prog('Afternoon', -30, 30);      // on air now
  const pD = await prog('Evening', 60, 120);        // upcoming
  const ev = (type: string, min: number, detail: any = {}) => query(`INSERT INTO stream_events(channel_id, type, detail, ts) VALUES ($1,$2,$3,$4)`, [ch, type, JSON.stringify(detail), at(min)]);
  await ev('channel.start', -70); await ev('channel.stop', -50, { reason: 'exited rc=1' }); await ev('channel.start', -45);
  await ev('playout.splice', -40, { to: 'loop', at_ms: now - 40 * M }); await ev('playout.splice', -38, { to: 'live', at_ms: now - 38 * M });

  const changed = await ar.recordAsRun(ch, now - 6 * 3600_000, now);
  const row = async (id: string) => one<any>(`SELECT status, actual_start, actual_end FROM programmes WHERE id=$1`, [id]);
  const ms = (d: any) => (d ? new Date(d).getTime() : null);
  check('recorded: the two that aired or are airing changed', changed, 2);
  let r = await row(pA); check('missed programme stays scheduled, no actual times', [r.status, r.actual_start, r.actual_end], ['scheduled', null, null]);
  r = await row(pB); check('outage programme: aired', r.status, 'aired');
  check('...actual start at plan start, actual end at plan end', [ms(r.actual_start) === now - 60 * M, ms(r.actual_end) === now - 30 * M], [true, true]);
  r = await row(pC); check('programme on air now: live with an actual start', [r.status, ms(r.actual_start) === now - 30 * M, r.actual_end], ['live', true, null]);
  r = await row(pD); check('upcoming untouched', r.status, 'scheduled');
  check('a second pass with nothing new changes nothing', await ar.recordAsRun(ch, now - 6 * 3600_000, now), 0);

  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const get = async (path: string, tokUser = user, tokAcct = acct) => {
    const tok = signAccess({ sub: tokUser, account_id: tokAcct, role: 'owner' });
    const res = await fetch(base + path, { headers: { authorization: `Bearer ${tok}` } });
    return { s: res.status, j: await res.json() as any };
  };
  const rep = await get(`/api/epg/as-run?channelId=${ch}&from=${encodeURIComponent(at(-180).toISOString())}&to=${encodeURIComponent(at(180).toISOString())}`);
  check('report: 200', rep.s, 200);
  const by = Object.fromEntries((rep.j.rows ?? []).map((x: any) => [x.title, x]));
  check('report: Breakfast missed', by.Breakfast?.outcome, 'missed');
  check('report: Midday partial (5 min outage, 2 min loop)', [by.Midday?.outcome, by.Midday?.on_air_sec, by.Midday?.filler_sec, by.Midday?.source_sec], ['partial', 25 * 60, 120, 23 * 60]);
  check('report: Afternoon airing', by.Afternoon?.outcome, 'airing');
  check('report: Evening upcoming', by.Evening?.outcome, 'upcoming');
  check('report totals', [rep.j.totals?.missed, rep.j.totals?.partial], [1, 1]);
  check("another account's channel: 404", (await get(`/api/epg/as-run?channelId=${ch}`, otherUser, other)).s, 404);
  check('a window over 7 days: 400', (await get(`/api/epg/as-run?channelId=${ch}&from=2026-01-01&to=2026-02-01`)).s, 400);
  srv.close();
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
