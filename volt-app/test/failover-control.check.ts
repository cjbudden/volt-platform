// ============================================================================
//  OPERATOR SOURCE CONTROL REACHES A REMOTE ENCODER (services/failoverControl.ts).
//
//  The Failover panel's choice (switch to backup, force slate or loop, back to
//  auto) is a stream event, and the encoder receives it on its timed-events
//  poll. Asserted against a real database and the HTTP routes: the POST records
//  it with who made it, the encoder's poll carries it, it belongs to the current
//  run only (a new channel.start is automatic again), another account cannot
//  touch it, a stopped channel is refused, and a bad mode is refused (422).
//    DATABASE_URL=... npx tsx test/failover-control.check.ts
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  if (got === want) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(want)}] got [${String(got)}]`); fail++ }
};

(async () => {
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { config } = await import('../src/config');
  const { currentFailoverControl } = await import('../src/services/failoverControl');

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`fc-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`fc-o-${tag}`]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `fc-${tag}@volt.test`]))!.id;
  const otherUser = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [other, `fc-o-${tag}@volt.test`]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
  const g = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name, status, input_failover_enabled) VALUES ($1,'FC News','live',true) RETURNING id`, [g]))!.id;
  const idle = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'FC Idle') RETURNING id`, [g]))!.id;
  await query(`INSERT INTO instances(channel_id, state) VALUES ($1,'running')`, [ch]);
  await query(`INSERT INTO stream_events(channel_id, type, detail, ts) VALUES ($1,'channel.start','{}', now() - interval '1 minute')`, [ch]);

  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' });
  const tokOther = signAccess({ sub: otherUser, account_id: other, role: 'owner' });
  const api = async (method: string, path: string, body?: any, token = tok) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j: any = null; try { j = JSON.parse(t); } catch { j = t; }
    return { s: r.status, j };
  };
  const poll = async (id: string) => {
    const r = await fetch(`${base}/api/streams/${id}/timed-events?kind=channel`, { headers: { 'X-Volt-Ingest-Token': config.ingestToken } });
    return { s: r.status, j: await r.json() as any };
  };

  try {
    let p = await poll(ch);
    check('encoder poll carries control, auto by default', p.j?.control?.failover?.mode, 'auto');
    let r = await api('POST', `/api/channels/${ch}/failover-test`, { mode: 'slate' });
    check('force slate accepted', r.s, 200);
    check('...and says who', r.j?.control?.by, user);
    p = await poll(ch);
    check('the encoder poll now says slate', p.j?.control?.failover?.mode, 'slate');
    r = await api('GET', `/api/channels/${ch}/failover-test`);
    check('the panel reads slate back from the stream event', r.j?.mode, 'slate');
    const ev = await one<any>(`SELECT detail FROM stream_events WHERE channel_id=$1 AND type='failover.control' ORDER BY id DESC LIMIT 1`, [ch]);
    check('it is in the stream log (QC shows it)', ev?.detail?.mode, 'slate');
    r = await api('POST', `/api/channels/${ch}/failover-test`, { mode: 'backup' });
    check('switch to backup', (await poll(ch)).j?.control?.failover?.mode, 'backup');
    r = await api('POST', `/api/channels/${ch}/failover-test`, { mode: 'auto' });
    check('back to auto', (await poll(ch)).j?.control?.failover?.mode, 'auto');
    await api('POST', `/api/channels/${ch}/failover-test`, { mode: 'loop' });
    await query(`INSERT INTO stream_events(channel_id, type, detail, ts) VALUES ($1,'channel.start','{}', now() + interval '1 second')`, [ch]);
    check('a new run starts automatic, whatever the last run was forced to', (await currentFailoverControl('channel', ch)).mode, 'auto');
    r = await api('POST', `/api/channels/${ch}/failover-test`, { mode: 'slate' }, tokOther);
    check("another account's operator gets 404", r.s, 404);
    check('...and changed nothing', (await poll(ch)).j?.control?.failover?.mode, 'auto');
    r = await api('POST', `/api/channels/${idle}/failover-test`, { mode: 'slate' });
    check('a channel that is not running is refused (409)', r.s, 409);
    r = await api('POST', `/api/channels/${ch}/failover-test`, { mode: 'explode' });
    check('an unknown mode is refused as invalid (422)', r.s, 422);
    const bad = await fetch(`${base}/api/streams/${ch}/timed-events?kind=channel`, { headers: { 'X-Volt-Ingest-Token': 'wrong' } });
    check('the poll needs the ingest token', bad.status, 401);
  } finally {
    srv.close();
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
