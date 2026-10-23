// ============================================================================
//  ONE LIST OVER EVERY STREAM: GET /api/live-streams (modules/liveStreams.ts,
//  build queue 1.12). Channels, radio stations, events and FAST channels in
//  one list-standard collection: filters, search, sort, cursor paging and
//  totals across both tables; tenancy and per-feature visibility; each row's
//  aggregate, resource and console links; health=true matching the live
//  board; hypermedia. Also: the loop preset is gone (a loop is a filler asset,
//  not a kind of stream). Real rows, real HTTP.
//    DATABASE_URL=... npx tsx test/live-streams-list.check.ts
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};

(async () => {
  const sm = await import('../src/services/streamModel');
  check('presets: no loop preset (a loop is a filler asset, not a stream)', sm.PRESETS.map((p) => p.key), ['live_channel', 'live_event', 'fast_channel', 'vod_premiere']);
  check('presets: no preset has a loop origin', sm.PRESETS.some((p) => (p.origin as string) === 'loop'), false);
  check("presetOf: an unknown origin is a live channel, never 'loop'", sm.presetOf('channel', { origin: 'loop' }).key, 'live_channel');

  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`ls-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`ls-o-${tag}`]))!.id;
  const mkUser = async (a: string, email: string, role: string) =>
    (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x',$3,'active') RETURNING id`, [a, email, role]))!.id;
  const owner = await mkUser(acct, `ls-${tag}@volt.test`, 'owner');
  const otherOwner = await mkUser(other, `ls-o-${tag}@volt.test`, 'owner');
  const radioOnly = await mkUser(acct, `ls-r-${tag}@volt.test`, 'operator');
  const eventsOnly = await mkUser(acct, `ls-e-${tag}@volt.test`, 'operator');
  const monOnly = await mkUser(acct, `ls-m-${tag}@volt.test`, 'operator');
  const noMon = await mkUser(acct, `ls-n-${tag}@volt.test`, 'operator');
  const role = async (u: string, name: string, perms: any) => {
    const g = (await one<any>(`INSERT INTO user_groups(account_id, name, permissions) VALUES ($1,$2,$3::jsonb) RETURNING id`, [acct, name, JSON.stringify(perms)]))!.id;
    await query(`INSERT INTO user_group_members(user_id, group_id) VALUES ($1,$2)`, [u, g]);
  };
  await role(radioOnly, 'Radio desk', { monitoring: 'view', radio: 'view' });
  await role(eventsOnly, 'Events desk', { monitoring: 'view', events: 'view' });
  await role(monOnly, 'Wall', { monitoring: 'view' });
  await role(noMon, 'Channels only', { channels: 'view' });

  const g = (await one<any>(`INSERT INTO groups(account_id, name) VALUES ($1,'News') RETURNING id`, [acct]))!.id;
  const og = (await one<any>(`INSERT INTO groups(account_id, name) VALUES ($1,'Other') RETURNING id`, [other]))!.id;
  const ch = async (grp: string, name: string, extra: Record<string, any> = {}) => {
    const cols = ['group_id', 'name', ...Object.keys(extra)];
    const vals = [grp, name, ...Object.values(extra)];
    return (await one<any>(`INSERT INTO channels(${cols.join(',')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, vals))!.id;
  };
  const tv = await ch(g, 'Alpha News', { status: 'live', on_air: true, xmltv_id: 'alpha.news' });
  const fm = await ch(g, 'Beta FM', { kind: 'radio' });
  const fast = await ch(g, 'Gamma FAST', { origin: 'playlist' });
  const now = Date.now();
  const evLive = (await one<any>(`INSERT INTO events(group_id, name, status, scheduled_start, scheduled_end) VALUES ($1,'Delta Final','live',$2,$3) RETURNING id`, [g, new Date(now - 600_000), new Date(now + 3600_000)]))!.id;
  const evLater = (await one<any>(`INSERT INTO events(group_id, name, status, scheduled_start, scheduled_end) VALUES ($1,'Epsilon Cup','scheduled',$2,$3) RETURNING id`, [g, new Date(now + 86_400_000), new Date(now + 90_000_000)]))!.id;
  const otherCh = await ch(og, 'Zeta Elsewhere');

  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const T = (u: string, a: string, r: string) => signAccess({ sub: u, account_id: a, role: r });
  const get = async (path: string, tok = T(owner, acct, 'owner'), accept?: string) => {
    const res = await fetch(base + path, { headers: { authorization: `Bearer ${tok}`, ...(accept ? { accept } : {}) } });
    return { s: res.status, h: res.headers, j: await res.json().catch(() => null) as any };
  };
  const names = (j: any) => (Array.isArray(j) ? j.map((r: any) => r.name) : j);
  try {
    // ---- the whole list
    let r = await get('/api/live-streams');
    check('owner: 200', r.s, 200);
    check('...all four kinds of stream, own account only, by name', names(r.j), ['Alpha News', 'Beta FM', 'Delta Final', 'Epsilon Cup', 'Gamma FAST']);
    const by = new Map<string, any>((r.j ?? []).map((x: any) => [x.name, x]));
    check('kind / medium / preset per row', ['Alpha News', 'Beta FM', 'Gamma FAST', 'Delta Final'].map((n) => [by.get(n)?.kind, by.get(n)?.medium, by.get(n)?.preset]),
      [['channel', 'tv', 'live_channel'], ['channel', 'radio', 'live_channel'], ['fast_channel', 'tv', 'fast_channel'], ['event', 'tv', 'live_event']]);
    check('preset labels', ['Alpha News', 'Gamma FAST', 'Epsilon Cup'].map((n) => by.get(n)?.preset_label), ['Live channel', 'FAST channel', 'Live event']);
    check('on_air: a channel on air and an event that is live', (r.j ?? []).filter((x: any) => x.on_air).map((x: any) => x.name), ['Alpha News', 'Delta Final']);
    check('events carry their schedule, channels do not', [!!by.get('Delta Final')?.scheduled_start, by.get('Alpha News')?.scheduled_start], [true, null]);
    check('group name on every row', (r.j ?? []).every((x: any) => x.group_name === 'News'), true);
    check('links: console pages', ['Alpha News', 'Beta FM', 'Gamma FAST', 'Delta Final'].map((n) => by.get(n)?.console),
      [`/channels/${tv}`, `/radio/${fm}`, `/fast/${fast}`, `/events/${evLive}`]);
    check('links: own resources', ['Alpha News', 'Beta FM', 'Gamma FAST', 'Delta Final'].map((n) => by.get(n)?.resource),
      [`/api/channels/${tv}`, `/api/radio/${fm}`, `/api/fast/channels/${fast}`, `/api/events/${evLive}`]);
    // Every row's aggregate answers, with the same preset the list gave.
    const aggs = await Promise.all((r.j ?? []).map(async (x: any) => { const a = await get(x.aggregate); return [a.s, a.j?.preset?.key === x.preset, a.j?.id === x.id]; }));
    check('every aggregate link answers with the same preset and id', aggs, (r.j ?? []).map(() => [200, true, true]));
    const res = await Promise.all(['Alpha News', 'Beta FM', 'Gamma FAST', 'Delta Final'].map(async (n) => (await get(by.get(n).resource)).s));
    check('every resource link answers', res, [200, 200, 200, 200]);

    // ---- filters and search
    check('kind=event', names((await get('/api/live-streams?kind=event')).j), ['Delta Final', 'Epsilon Cup']);
    check('kind=fast_channel', names((await get('/api/live-streams?kind=fast_channel')).j), ['Gamma FAST']);
    check('kind=channel&medium=radio', names((await get('/api/live-streams?kind=channel&medium=radio')).j), ['Beta FM']);
    check('kind=channel,fast_channel (any of)', names((await get('/api/live-streams?kind=channel,fast_channel')).j), ['Alpha News', 'Beta FM', 'Gamma FAST']);
    check('preset=live_event', names((await get('/api/live-streams?preset=live_event')).j), ['Delta Final', 'Epsilon Cup']);
    check('status=live', names((await get('/api/live-streams?status=live')).j), ['Alpha News', 'Delta Final']);
    check('on_air=false', names((await get('/api/live-streams?on_air=false')).j), ['Beta FM', 'Epsilon Cup', 'Gamma FAST']);
    check('q searches names', names((await get('/api/live-streams?q=final')).j), ['Delta Final']);
    check('q searches XMLTV ids', names((await get('/api/live-streams?q=alpha.news')).j), ['Alpha News']);
    check('scheduled_start[gt]=now: the later event only', names((await get(`/api/live-streams?scheduled_start[gt]=${new Date(now + 3600_000).toISOString()}`)).j), ['Epsilon Cup']);
    check('group_id filter', (await get(`/api/live-streams?group_id=${g}`)).j?.length, 5);
    check('sort=-name', names((await get('/api/live-streams?sort=-name')).j), ['Gamma FAST', 'Epsilon Cup', 'Delta Final', 'Beta FM', 'Alpha News']);
    check('sort=kind,name', names((await get('/api/live-streams?sort=kind,name')).j), ['Alpha News', 'Beta FM', 'Delta Final', 'Epsilon Cup', 'Gamma FAST']);
    check('unknown filter: 400 naming the filters', [(await get('/api/live-streams?colour=red')).s, (await get('/api/live-streams?colour=red')).j?.code], [400, 'invalid_list_query']);
    check('bad kind: 400', (await get('/api/live-streams?kind=loop')).s, 400);
    check('bad health value: 400', (await get('/api/live-streams?health=yes')).s, 400);

    // ---- paging across both tables
    const seen: string[] = []; let path = '/api/live-streams?limit=2'; let pages = 0; let firstLink = '';
    while (path && pages < 6) {
      const p = await get(path); pages++;
      if (pages === 1) firstLink = p.h.get('link') ?? '';
      seen.push(...names(p.j));
      const next = p.h.get('x-next-cursor');
      path = next ? `/api/live-streams?limit=2&cursor=${encodeURIComponent(next)}` : '';
    }
    check('limit=2: three pages, every stream once, in order', [pages, seen], [3, ['Alpha News', 'Beta FM', 'Delta Final', 'Epsilon Cup', 'Gamma FAST']]);
    check('...first page carries a Link rel="next"', /rel="next"/.test(firstLink), true);
    r = await get('/api/live-streams?count=true&limit=1');
    check('count=true: X-Total-Count over both tables', [r.h.get('x-total-count'), r.j?.length], ['5', 1]);
    r = await get('/api/live-streams?count=true&kind=event&limit=1');
    check('count=true with a filter', r.h.get('x-total-count'), '2');
    const p1 = await get('/api/live-streams?kind=event&limit=1');
    const p2 = await get(`/api/live-streams?kind=event&limit=1&cursor=${encodeURIComponent(p1.h.get('x-next-cursor') ?? '')}`);
    check('a cursor keeps its filter', [names(p1.j), names(p2.j), p2.h.get('x-next-cursor')], [['Delta Final'], ['Epsilon Cup'], null]);
    const bad = await get(`/api/live-streams?kind=channel&limit=1&cursor=${encodeURIComponent(p1.h.get('x-next-cursor') ?? '')}`);
    check('a cursor from another view: 400', bad.s, 400);

    // ---- tenancy and visibility
    r = await get('/api/live-streams', T(otherOwner, other, 'owner'));
    check("another account sees only its own", [names(r.j), (r.j ?? []).some((x: any) => x.id === tv)], [['Zeta Elsewhere'], false]);
    check('...and our aggregate is a 404 to it', (await get(`/api/live-streams/channel/${tv}`, T(otherOwner, other, 'owner'))).s, 404);
    check('our account never lists theirs', (await get(`/api/live-streams?q=zeta`)).j?.length, 0);
    check('a Radio role sees stations only', names((await get('/api/live-streams', T(radioOnly, acct, 'operator'))).j), ['Beta FM']);
    check('an Events role sees events only', names((await get('/api/live-streams', T(eventsOnly, acct, 'operator'))).j), ['Delta Final', 'Epsilon Cup']);
    r = await get('/api/live-streams?count=true', T(radioOnly, acct, 'operator'));
    check('...and its total counts only what it may see', r.h.get('x-total-count'), '1');
    r = await get('/api/live-streams', T(monOnly, acct, 'operator'));
    check('monitoring alone: 200 and nothing listed', [r.s, r.j?.length], [200, 0]);
    check('no monitoring: 403', (await get('/api/live-streams', T(noMon, acct, 'operator'))).s, 403);

    // ---- health=true: the board's reading, for the page
    r = await get('/api/live-streams?health=true');
    const board = await get('/api/monitoring/live');
    const bmap = new Map<string, any>((board.j?.streams ?? []).map((s: any) => [s.id, s]));
    check('health=true: every row has the board fields', (r.j ?? []).every((x: any) => x.live && typeof x.live.overall === 'string' && Array.isArray(x.live.gates) && typeof x.live.concurrent === 'number' && 'uptimeMs' in x.live), true);
    check('...and the same overall, gates and viewers as the live board', (r.j ?? []).map((x: any) => {
      const b = bmap.get(x.id); return !!b && b.overall === x.live.overall && JSON.stringify(b.gates) === JSON.stringify(x.live.gates) && b.concurrent === x.live.concurrent;
    }), (r.j ?? []).map(() => true));
    check('...radio is audio only', (r.j ?? []).find((x: any) => x.id === fm)?.live?.audioOnly, true);
    check('without health=true there is no live block', (await get('/api/live-streams')).j?.some((x: any) => 'live' in x), false);
    check('board: an event opens its own page, a FAST channel its FAST page', [bmap.get(evLive)?.href, bmap.get(fast)?.href, bmap.get(tv)?.href, bmap.get(fm)?.href],
      [`/events/${evLive}`, `/fast/${fast}`, `/channels/${tv}`, `/radio/${fm}`]);
    check('board still lists the whole fleet of the account', board.j?.streams?.length, 5);

    // ---- hypermedia
    r = await get('/api/live-streams?limit=2', undefined, 'application/ld+json');
    const members = r.j?.member ?? r.j?.['hydra:member'] ?? [];
    check('JSON-LD: a hydra:Collection', r.j?.['@type'], 'hydra:Collection');
    check('...members are LiveStreams whose @id is the aggregate', members.map((m: any) => [m['@type'], m['@id']]),
      [['volt:LiveStream', `${base}/api/live-streams/channel/${tv}`], ['volt:LiveStream', `${base}/api/live-streams/channel/${fm}`]]);
    check('...with a resource link to the row itself', members[1]?.resource, `${base}/api/radio/${fm}`);
    const entry = await get('/api', undefined, 'application/ld+json');
    check('entry point links the collection', JSON.stringify(entry.j ?? {}).includes('/api/live-streams"'), true);
    check('presets endpoint lists four', (await get('/api/live-streams/presets')).j?.length, 4);
    void evLater; void otherCh;
  } finally {
    srv.close();
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
