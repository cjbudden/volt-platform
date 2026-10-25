// ============================================================================
//  FAST ACCESS FOLLOWS THE TV CHANNELS LEVELS (build queue 1.14-G1b).
//
//  A FAST channel is a TV channel with origin = 'playlist', and the console
//  shows FAST to TV channels: View. Before this, /api/fast was outside the
//  access catalogue: any signed-in user could read it and any operator-tier
//  role could create, change, activate and put FAST channels on air whatever
//  their TV channels level. Now:
//    view     every read, and a lineup preview (it plans and writes nothing)
//    operate  on/off air, activate a run order, decide a break for a test
//    manage   create a channel, run orders, ads, ad servers, prepare, apply
//  Ad breaks on any stream (/api/fast/streams/<kind>/<id>/breaks) belong to
//  that stream: TV channels, Radio or Events, view to list, operate to add
//  (Go to break) or cancel.
//
//  Every route on the FAST router is listed below with the level it needs, so
//  a new route without a decision fails this suite. Each is called over real
//  HTTP by a role without TV channels (403 each), and by view, operate and
//  manage roles (403 below the level, through at or above it).
//    DATABASE_URL=... npx tsx test/fast-access.check.ts
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};

type Lvl = 'view' | 'operate' | 'manage';
/** Every route on fastRouter and the TV channels level it needs. */
const NEED: Record<string, Lvl> = {
  'GET /channels': 'view',
  'POST /channels': 'manage',
  'GET /channels/:id': 'view',
  'GET /channels/:id/readiness': 'view',
  'POST /channels/:id/prepare': 'manage',
  'POST /channels/:id/on-air': 'operate',
  'GET /library': 'view',
  'POST /channels/:id/lineups': 'manage',
  'GET /lineups/:lid': 'view',
  'PUT /lineups/:lid': 'manage',
  'DELETE /lineups/:lid': 'manage',
  'POST /lineups/:lid/preview': 'view',
  'POST /lineups/:lid/activate': 'operate',
  'POST /lineups/:lid/apply': 'manage',
  'GET /channels/:id/ads': 'view',
  'PUT /channels/:id/ads': 'manage',
  'GET /ad-servers': 'view',
  'POST /ad-servers': 'manage',
  'PUT /ad-servers/:sid': 'manage',
  'DELETE /ad-servers/:sid': 'manage',
  'POST /ad-servers/:sid/test': 'manage',
  'GET /channels/:id/ad-report': 'view',
  'GET /streams/:kind/:id/breaks': 'view',
  'POST /streams/:kind/:id/breaks': 'operate',
  'DELETE /streams/:kind/:id/breaks/:bid': 'operate',
  'GET /channels/:id/breaks/:bid/beacons': 'view',
  'POST /channels/:id/breaks/:bid/decide': 'operate',
};
const RANK: Record<string, number> = { none: 0, view: 1, operate: 2, manage: 3 };

(async () => {
  const { createServer } = await import('../src/server');
  const { fastRouter } = await import('../src/modules/fast');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { requirementFor } = await import('../src/auth/roles');

  // ---- the route list is complete
  const routes: string[] = (fastRouter as any).stack.filter((l: any) => l.route)
    .flatMap((l: any) => Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${l.route.path}`));
  check('every FAST route has a decided level in this suite', routes.filter((r) => !NEED[r]), []);
  check('...and the suite lists no route that is gone', Object.keys(NEED).filter((r) => !routes.includes(r)), []);

  // ---- the gate, without HTTP: what each route requires
  const kindOf = async (id: string) => (id === 'station' ? 'radio' : 'tv');
  const sub = (p: string) => '/api/fast' + p.replace(':kind', 'channel').replace(/:[a-z]+/g, '00000000-0000-0000-0000-000000000001');
  const reqs = await Promise.all(routes.map(async (r) => {
    const [m, p] = r.split(' ');
    const n = await requirementFor(m, sub(p), {}, kindOf);
    return `${r} -> ${n?.features.join('|')}:${n?.level}`;
  }));
  check('requirementFor: every FAST route maps to TV channels at its level', reqs, routes.map((r) => `${r} -> channels:${NEED[r]}`));
  const ev = await requirementFor('POST', '/api/fast/streams/event/x/breaks', {}, kindOf);
  check('requirementFor: Go to break on an event is Events: operate', [ev?.features, ev?.level], [['events'], 'operate']);
  const st = await requirementFor('DELETE', '/api/fast/streams/channel/station/breaks/b1', {}, kindOf);
  check('requirementFor: cancelling a break on a station is Radio: operate', [st?.features, st?.level], [['radio'], 'operate']);
  const evList = await requirementFor('GET', '/api/fast/streams/event/x/breaks', {}, kindOf);
  check('requirementFor: listing an event\'s breaks is Events: view', [evList?.features, evList?.level], [['events'], 'view']);
  const play = await requirementFor('POST', '/api/fast-playout/x/heartbeat', {}, kindOf);
  check('requirementFor: /api/fast-playout (ingest token) is not caught by the /api/fast prefix', play, null);

  // ---- real HTTP
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name, max_channels) VALUES ($1, 50) RETURNING id`, [`fa-${tag}`]))!.id;
  const mkUser = async (email: string, role: string) =>
    (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x',$3,'active') RETURNING id`, [acct, email, role]))!.id;
  const withRole = async (u: string, name: string, perms: any) => {
    const g = (await one<any>(`INSERT INTO user_groups(account_id, name, permissions) VALUES ($1,$2,$3::jsonb) RETURNING id`, [acct, `${name} ${tag}`, JSON.stringify(perms)]))!.id;
    await query(`INSERT INTO user_group_members(user_id, group_id) VALUES ($1,$2)`, [u, g]);
  };
  const users: Record<string, { id: string; tier: string }> = {};
  const person = async (key: string, tier: string, perms: any) => {
    const id = await mkUser(`fa-${key}-${tag}@volt.test`, tier);
    await withRole(id, key, perms);
    users[key] = { id, tier };
  };
  // A role without TV channels: everything else at manage.
  await person('none', 'operator', { radio: 'manage', events: 'manage', epg: 'manage', vod: 'manage', media: 'manage', monitoring: 'view' });
  await person('view', 'operator', { channels: 'view' });
  await person('operate', 'operator', { channels: 'operate' });
  await person('manage', 'operator', { channels: 'manage' });
  await person('viewerTier', 'viewer', { channels: 'manage' });   // capped at view
  await person('eventsOp', 'operator', { events: 'operate' });
  await person('radioOp', 'operator', { radio: 'operate' });
  const owner = await mkUser(`fa-owner-${tag}@volt.test`, 'owner');

  const g = (await one<any>(`INSERT INTO groups(account_id, name, max_channels) VALUES ($1,'Main',50) RETURNING id`, [acct]))!.id;
  const fast = (await one<any>(`INSERT INTO channels(group_id, name, origin) VALUES ($1,'Fa FAST','playlist') RETURNING id`, [g]))!.id;
  await query(`INSERT INTO channel_ads (channel_id) VALUES ($1) ON CONFLICT DO NOTHING`, [fast]);
  const lineup = (await one<any>(`INSERT INTO fast_lineups (channel_id, name, epoch, zone, status) VALUES ($1, 'Main lineup', now(), 'UTC', 'active') RETURNING id`, [fast]))!.id;
  const station = (await one<any>(`INSERT INTO channels(group_id, name, kind) VALUES ($1,'Fa FM','radio') RETURNING id`, [g]))!.id;
  const event = (await one<any>(`INSERT INTO events(group_id, name, status, scheduled_start, scheduled_end) VALUES ($1,'Fa Final','scheduled',now() + interval '1 day', now() + interval '1 day 2 hours') RETURNING id`, [g]))!.id;
  const server = (await one<any>(`INSERT INTO ad_servers (account_id, name, vendor, tag_template, timeout_ms, max_wrappers, enabled) VALUES ($1,'Stub','vast','http://127.0.0.1:9/vast',300,0,true) RETURNING id`, [acct]))!.id;
  const brk = (await one<any>(`INSERT INTO stream_breaks (channel_id, source, starts_at, duration_ms, position) VALUES ($1,'manual', now() + interval '1 hour', 30000, 'live') RETURNING id`, [fast]))!.id;

  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = (k: string) => signAccess({ sub: users[k].id, account_id: acct, role: users[k].tier });
  const call = async (method: string, path: string, t: string, body?: any) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const j = await res.json().catch(() => null) as any;
    return { s: res.status, code: j?.code ?? j?.error?.code ?? null, j };
  };
  // A body that gets past validation where that is easy, so "through" means the handler ran.
  const BODY: Record<string, any> = {
    'POST /channels': { name: `Fa new ${tag}`, groupId: g, zone: 'UTC' },
    'POST /channels/:id/on-air': { on: false },
    'POST /lineups/:lid/preview': { days: 1 },
    'PUT /lineups/:lid': { name: 'Main lineup' },
    'POST /ad-servers': { name: 'Stub 2', tagTemplate: 'http://127.0.0.1:9/vast' },
    'PUT /ad-servers/:sid': { name: 'Stub' },
    'POST /streams/:kind/:id/breaks': { durationSec: 30, startsAt: new Date(Date.now() + 7200_000).toISOString() },
  };
  const url = (r: string) => {
    const p = r.split(' ')[1].replace(':kind', 'channel').replace(':id', fast).replace(':lid', lineup).replace(':sid', server).replace(':bid', brk);
    return `/api/fast${p}${r === 'GET /library' ? `?channel=${fast}` : ''}`;
  };
  // Order matters only for writes that remove things: removals last.
  const ordered = [...routes.filter((r) => !r.startsWith('DELETE')), ...routes.filter((r) => r.startsWith('DELETE'))];

  try {
    // ---- a role without TV channels: 403 on every FAST route
    const none = await Promise.all(ordered.map(async (r) => { const x = await call(r.split(' ')[0], url(r), tok('none'), BODY[r]); return `${r} ${x.s} ${x.code}`; }));
    check('no TV channels: 403 forbidden_feature on every FAST route', none, ordered.map((r) => `${r} 403 forbidden_feature`));

    // ---- view, operate, manage: refused below the level, through at or above it
    for (const lvl of ['view', 'operate', 'manage'] as const) {
      const got: string[] = [], want: string[] = [];
      for (const r of ordered) {
        if (lvl !== 'manage' && r.startsWith('DELETE')) continue;   // keep the fixtures for the next level
        const x = await call(r.split(' ')[0], url(r), tok(lvl), BODY[r]);
        const allowed = RANK[lvl] >= RANK[NEED[r]];
        got.push(`${r} ${x.s === 403 ? 'refused' : 'through'}`);
        want.push(`${r} ${allowed ? 'through' : 'refused'}`);
      }
      check(`TV channels: ${lvl}: refused exactly where the level is not enough`, got, want);
    }

    // The handlers ran for the levels that may use them (spot checks).
    check('view: the list answers with the FAST channel', (await call('GET', '/api/fast/channels', tok('view'))).j?.items?.some((i: any) => i.id === fast), true);
    check('view: a preview plans a window (200)', (await call('POST', `/api/fast/lineups/${lineup}/preview`, tok('view'), { days: 1 })).s, 200);
    check('operate: off air answers 200', (await call('POST', `/api/fast/channels/${fast}/on-air`, tok('operate'), { on: false })).s, 200);
    check('operate: Go to break on the FAST channel (201)', (await call('POST', `/api/fast/streams/channel/${fast}/breaks`, tok('operate'), BODY['POST /streams/:kind/:id/breaks'])).s, 201);
    check('operate: may not create a FAST channel (403)', (await call('POST', '/api/fast/channels', tok('operate'), BODY['POST /channels'])).s, 403);
    check('manage: creates a FAST channel (201)', (await call('POST', '/api/fast/channels', tok('manage'), { ...BODY['POST /channels'], name: `Fa m ${tag}` })).s, 201);
    const me = await call('GET', '/api/auth/me', tok('operate'));
    const why = await call('POST', '/api/fast/channels', tok('operate'), BODY['POST /channels']);
    check('the 403 says which feature and level were missing', [why.j?.error, why.j?.feature, why.j?.level], ['Your role does not allow manage on TV channels', 'channels', 'manage']);
    check('/api/auth/me: TV channels operate for the operate role', me.j?.features?.channels, 'operate');

    // ---- viewer tier is capped at view whatever the role says
    check('viewer tier with a manage role: reads (200)', (await call('GET', `/api/fast/channels/${fast}`, tok('viewerTier'))).s, 200);
    check('viewer tier with a manage role: may not put it on air (403)', (await call('POST', `/api/fast/channels/${fast}/on-air`, tok('viewerTier'), { on: true })).s, 403);

    // ---- breaks belong to the stream they are on
    const evBreak = BODY['POST /streams/:kind/:id/breaks'];
    check('events operate, no TV channels: Go to break on an event (201)', (await call('POST', `/api/fast/streams/event/${event}/breaks`, tok('eventsOp'), evBreak)).s, 201);
    check('events operate: may not touch a FAST channel\'s breaks (403)', (await call('POST', `/api/fast/streams/channel/${fast}/breaks`, tok('eventsOp'), evBreak)).s, 403);
    check('TV channels manage: may not put a break on an event (403)', (await call('POST', `/api/fast/streams/event/${event}/breaks`, tok('manage'), evBreak)).s, 403);
    check('radio operate: Go to break on a station (201)', (await call('POST', `/api/fast/streams/channel/${station}/breaks`, tok('radioOp'), evBreak)).s, 201);
    check('TV channels manage: may not put a break on a station (403)', (await call('POST', `/api/fast/streams/channel/${station}/breaks`, tok('manage'), evBreak)).s, 403);
    check('TV channels view: may list a FAST channel\'s breaks (200)', (await call('GET', `/api/fast/streams/channel/${fast}/breaks`, tok('view'))).s, 200);
    check('TV channels view: may not add one (403)', (await call('POST', `/api/fast/streams/channel/${fast}/breaks`, tok('view'), evBreak)).s, 403);

    // ---- owners keep everything
    check('owner: creates a FAST channel (201)', (await call('POST', '/api/fast/channels', signAccess({ sub: owner, account_id: acct, role: 'owner' }), { ...BODY['POST /channels'], name: `Fa o ${tag}` })).s, 201);
  } finally {
    srv.close();
    await pool.end();
  }
  console.log(`\nfast-access: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
