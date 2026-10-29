// ============================================================================
//  THE PUBLIC GUIDE API (/api/public/epg, EPG_PUBLIC_API.md).
//  Pure now/next maths and the public shape first, then real rows over HTTP:
//  a FAST channel whose guide is the lineup's rows, a scheduled channel with a
//  gap, keys and tenancy, the window routes, and the cache dropping on a write.
//    DATABASE_URL=... npx tsx test/epg-public.check.ts
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};
const M = 60_000;
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

(async () => {
  const ep = await import('../src/services/epgPublic');

  // ---- pure ------------------------------------------------------------------------------------
  const T = Date.parse('2030-01-01T12:00:00Z');
  const mk = (id: string, a: number, b: number, md: any = {}, ref: string | null = null) =>
    ep.toPublicProgramme({ id, channel_id: 'c', title: id, starts_at: new Date(T + a * M), ends_at: new Date(T + b * M), source_ref: ref, metadata: md }, null, null);
  const L = [mk('A', -90, -60), mk('B', -60, -30), mk('C', -30, 30), mk('D', 30, 60), mk('E', 60, 90), mk('F', 90, 120)];
  let a = ep.aroundOf(L, T, 2, 3);
  check('now is the programme containing at', a.now?.id, 'C');
  check('previous, nearest first', a.previous.map((p) => p.id), ['B', 'A']);
  check('next, in order', a.next.map((p) => p.id), ['D', 'E', 'F']);
  check('next change is the end of now', a.nextChangeAt, T + 30 * M);
  a = ep.aroundOf(L, T + 30 * M, 1, 1);
  check('at a boundary: the new one is on ([start, end))', [a.now?.id, a.previous[0]?.id, a.next[0]?.id], ['D', 'C', 'E']);
  const gap = [mk('A', -60, -10), mk('B', 20, 60)];
  a = ep.aroundOf(gap, T, 1, 1);
  check('in a gap: no now, previous and next either side, change at the next start', [a.now, a.previous[0]?.id, a.next[0]?.id, a.nextChangeAt], [null, 'A', 'B', T + 20 * M]);
  const over = [mk('Long', -60, 60), mk('Over', -10, 20), mk('After', 60, 90)];
  check('overlap: the later start has the air', ep.aroundOf(over, T, 1, 1).now?.id, 'Over');
  const on = ep.answer(L[2], T);
  check('on-now progress', [on.state, on.progress?.elapsedSec, on.progress?.remainingSec, on.progress?.percent], ['on-now', 1800, 1800, 50]);
  check('aired / upcoming states', [ep.answer(L[0], T).state, ep.answer(L[3], T).state], ['aired', 'upcoming']);
  const fastP = ep.toPublicProgramme(
    { id: 'f', channel_id: 'c', title: 'Ep 3', starts_at: new Date(T), ends_at: new Date(T + 30 * M), source_ref: 'fast:l:v1:k', metadata: { kind: 'content', source: 'fast', lineupId: 'L', slotId: 'S', cycle: 1, vodAssetId: 'v', padSec: 12, series: 'Show', season: 2, episodeNumber: 3 } },
    { id: 'v', title: 'Ep 3', metadata: { description: 'From the asset', genre: 'Drama', rating: 'PG' }, poster_key: 'posters/v.jpg', published: true }, null);
  check('FAST row: origin fast, description and genre from the asset', [fastP.origin, fastP.description, fastP.categories, fastP.rating], ['fast', 'From the asset', ['Drama'], 'PG']);
  check('FAST row: series / season / episode, repeat on a later cycle, on demand', [fastP.series, fastP.season, fastP.episode, fastP.flags.repeat, fastP.onDemand?.assetId], ['Show', 2, 3, true, 'v']);
  check('FAST row: poster on the CDN', /\/posters\/v\.jpg$/.test(String(fastP.image)), true);
  const keys = Object.keys(fastP).sort().join(',');
  check('public shape is a whitelist (no lineup, slot, pad or geo)', /lineup|slot|pad|geo|metadata|source_ref/i.test(keys), false);
  check('slab start is aligned and a day back', ep.slabStartFor(T + 7 * 3600_000), T + 6 * 3600_000 - 86400_000);

  // ---- database + HTTP -------------------------------------------------------------------------
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { generateKey } = await import('../src/services/apiKeys');
  const { startListener, stopListener } = await import('../src/scale/notify');
  const { wireCacheInvalidation, cacheStats } = await import('../src/scale/cache');
  wireCacheInvalidation();
  await startListener();
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`ep-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`ep-o-${tag}`]))!.id;
  const g = (await one<any>(`INSERT INTO groups(account_id, name, max_channels) VALUES ($1,'G',50) RETURNING id`, [acct]))!.id;
  const og = (await one<any>(`INSERT INTO groups(account_id, name, max_channels) VALUES ($1,'O',50) RETURNING id`, [other]))!.id;
  const fast = (await one<any>(`INSERT INTO channels(group_id, name, origin, xmltv_id, tz) VALUES ($1,'Ep FAST','playlist',$2,'Australia/Brisbane') RETURNING id`, [g, `epfast.${tag}`]))!.id;
  const live = (await one<any>(`INSERT INTO channels(group_id, name, metadata) VALUES ($1,'Ep News','{"channelNumber":"7"}') RETURNING id`, [g]))!.id;
  const hidden = (await one<any>(`INSERT INTO channels(group_id, name, epg_enabled) VALUES ($1,'Ep Hidden',false) RETURNING id`, [g]))!.id;
  const foreign = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'Ep Foreign') RETURNING id`, [og]))!.id;
  const lineup = (await one<any>(`INSERT INTO fast_lineups (channel_id, name, epoch, zone, status) VALUES ($1,'Main',now(),'UTC','active') RETURNING id`, [fast]))!.id;
  const vod = (await one<any>(
    `INSERT INTO vod_assets(channel_id, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, metadata, poster_key, published)
     VALUES ($1,'clip','Pilot','k/master.m3u8',0,1800000,1800000,'{"description":"The first one","genre":"Drama"}','posters/pilot.jpg',true) RETURNING id`, [fast]))!.id;

  const now = Date.now();
  const at = (min: number) => new Date(now + min * M);
  // The FAST guide exactly as services/fast/store.ts applyLineup writes it.
  for (let i = -4; i < 12; i++) {
    await query(`INSERT INTO programmes (channel_id, source_ref, title, starts_at, ends_at, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [fast, `fast:${lineup}:v1:${i}`, `Pilot ${i}`, at(i * 30), at(i * 30 + 30),
        JSON.stringify({ kind: 'content', source: 'fast', lineupId: lineup, slotId: 's1', cycle: i < 0 ? 0 : 1, vodAssetId: vod, contentSec: 1790, padSec: 10, note: null })]);
  }
  // A scheduled channel with a gap now and a cancelled entry.
  await query(`INSERT INTO programmes (channel_id, title, starts_at, ends_at, metadata) VALUES ($1,'Morning',$2,$3,'{"description":"Desk"}'), ($1,'Evening',$4,$5,'{"live":true}'), ($1,'Dropped',$6,$7,'{}')`,
    [live, at(-120), at(-20), at(40), at(100), at(100), at(130)]);
  await query(`UPDATE programmes SET status='cancelled' WHERE channel_id=$1 AND title='Dropped'`, [live]);
  await query(`INSERT INTO programmes (channel_id, title, starts_at, ends_at) VALUES ($1,'Secret',$2,$3)`, [hidden, at(-10), at(10)]);
  await query(`INSERT INTO programmes (channel_id, title, starts_at, ends_at) VALUES ($1,'Theirs',$2,$3)`, [foreign, at(-10), at(10)]);

  const mkKey = async (account: string, restrictions: any = {}) => {
    const a = await one<any>(`INSERT INTO apps(account_id, name, type, restrictions) VALUES ($1,'Web','web',$2) RETURNING id`, [account, JSON.stringify(restrictions)]);
    const k = generateKey('publishable');
    await query(`INSERT INTO api_keys(account_id, app_id, kind, key_prefix, key_hash, scopes) VALUES ($1,$2,'publishable',$3,$4,'{playback}')`, [account, a!.id, k.prefix, k.hash]);
    return k.raw;
  };
  const pk = await mkKey(acct);
  const pkLocked = await mkKey(acct, { origins: ['tv.example.com'] });

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const get = async (path: string, key: string | null = pk, headers: Record<string, string> = {}) => {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(base + path + (key ? `${sep}appKey=${encodeURIComponent(key)}` : ''), { headers });
    return { s: res.status, j: res.status === 304 ? null : await res.json().catch(() => null) as any, h: res.headers };
  };

  try {
    // keys
    check('no key: 401', (await get('/api/public/epg/channels', null)).s, 401);
    check('bad key: 401', (await get('/api/public/epg/channels', 'pk_live_nope')).s, 401);
    check('web app restricted to another origin: 403', (await get('/api/public/epg/channels', pkLocked, { origin: 'https://evil.example' })).s, 403);
    check('...and its own origin: 200', (await get('/api/public/epg/channels', pkLocked, { origin: 'https://tv.example.com' })).s, 200);
    const hdr = await fetch(`${base}/api/public/epg/channels`, { headers: { 'x-volt-app-key': pk } });
    check('key in X-Volt-App-Key: 200', hdr.status, 200);

    // channels
    const chs = await get('/api/public/epg/channels');
    const names = chs.j.channels.map((c: any) => c.name);
    check('channels: own account, guide-enabled only', names, ['Ep FAST', 'Ep News']);
    const f = chs.j.channels.find((c: any) => c.id === fast);
    check('FAST channel flagged, xmltv id and zone', [f.fast, f.xmltvId, f.timezone], [true, `epfast.${tag}`, 'Australia/Brisbane']);
    check('channel number from metadata', chs.j.channels.find((c: any) => c.id === live).number, '7');

    // channel now
    const n = await get(`/api/public/epg/channels/${fast}/now?previous=2&next=3`);
    check('FAST now: 200, the slot on air', [n.s, n.j.now?.title, n.j.now?.state], [200, 'Pilot 0', 'on-now']);
    check('FAST now: previous nearest first, next in order', [n.j.previous.map((p: any) => p.title), n.j.next.map((p: any) => p.title)], [['Pilot -1', 'Pilot -2'], ['Pilot 1', 'Pilot 2', 'Pilot 3']]);
    check('FAST now: asset description, on demand, origin', [n.j.now.description, n.j.now.onDemand?.assetId === vod, n.j.now.origin], ['The first one', true, 'fast']);
    check('FAST now: no operator fields leak', JSON.stringify(n.j).includes('padSec') || JSON.stringify(n.j).includes(lineup), false);
    check('max-age stops at the next change', Number(/max-age=(\d+)/.exec(n.h.get('cache-control') ?? '')?.[1]) <= 30 * 60, true);
    const byXmltv = await get(`/api/public/epg/channels/epfast.${tag}/now`);
    check('channel addressed by XMLTV id', byXmltv.j?.channel?.id, fast);
    const past = await get(`/api/public/epg/channels/${fast}/now?at=${encodeURIComponent(at(-75).toISOString())}`);
    check('at= asks what was on then', past.j.now?.title, 'Pilot -3');

    // gap -> base entry
    const gn = await get(`/api/public/epg/channels/${live}/now?previous=1&next=2`);
    check('gap: no now, the channel itself as base', [gn.j.now, gn.j.nowIsBase, gn.j.base?.title], [null, true, 'Ep News']);
    check('gap: previous and next, cancelled left out', [gn.j.previous.map((p: any) => p.title), gn.j.next.map((p: any) => p.title)], [['Morning'], ['Evening']]);
    check('gap: next change at the next start', gn.j.nextChangeAt, at(40).toISOString());
    check('live flag carried', gn.j.next[0].flags.live, true);

    // tenancy and hidden
    check('another account\'s channel: 404', (await get(`/api/public/epg/channels/${foreign}/now`)).s, 404);
    check('a guide-disabled channel: 404', (await get(`/api/public/epg/channels/${hidden}/now`)).s, 404);

    // on now, many channels
    const all = await get('/api/public/epg/now?next=1');
    check('on now across channels', all.j.channels.map((c: any) => [c.channel.name, c.now?.title ?? null, c.next[0]?.title]), [['Ep FAST', 'Pilot 0', 'Pilot 1'], ['Ep News', null, 'Evening']]);
    check('on now, filtered by channels=', (await get(`/api/public/epg/now?channels=${live}`)).j.channels.length, 1);

    // schedule and grid
    const sch = await get(`/api/public/epg/channels/${fast}/schedule?from=${encodeURIComponent(at(-60).toISOString())}&to=${encodeURIComponent(at(60).toISOString())}`);
    check('schedule window: overlapping programmes with states', sch.j.programmes.map((p: any) => `${p.title}:${p.state}`), ['Pilot -2:aired', 'Pilot -1:aired', 'Pilot 0:on-now', 'Pilot 1:upcoming']);
    check('schedule: paging links', typeof sch.j.links?.next === 'string' && typeof sch.j.links?.previous === 'string', true);
    const day = await get(`/api/public/epg/channels/${fast}/schedule`);
    check('schedule default: today in the channel zone', [day.s, day.j.timezone], [200, 'Australia/Brisbane']);
    check('schedule: a 20 day window is refused', (await get(`/api/public/epg/channels/${fast}/schedule?from=2030-01-01T00:00:00Z&to=2030-01-21T00:00:00Z`)).s, 400);
    check('schedule: bad date 400', (await get(`/api/public/epg/channels/${fast}/schedule?date=2030-13-01`)).s, 400);
    const grid = await get(`/api/public/epg/grid?from=${encodeURIComponent(at(0).toISOString())}&to=${encodeURIComponent(at(60).toISOString())}`);
    check('grid: every guide channel with its window', grid.j.channels.map((c: any) => [c.channel.name, c.programmes.length]), [['Ep FAST', 2], ['Ep News', 1]]);
    check('grid: over 48 hours refused', (await get('/api/public/epg/grid?from=2030-01-01T00:00:00Z&to=2030-01-04T00:00:00Z')).s, 400);
    const far = await get(`/api/public/epg/channels/${fast}/schedule?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z`);
    check('a window outside the slab reads the table (empty here)', [far.s, far.j.programmes.length], [200, 0]);

    // programme
    const pid = n.j.now.id;
    const pr = await get(`/api/public/epg/programmes/${pid}`);
    check('programme with neighbours', [pr.j.programme.title, pr.j.previous?.title, pr.j.next?.title], ['Pilot 0', 'Pilot -1', 'Pilot 1']);
    const secret = (await one<any>(`SELECT id FROM programmes WHERE channel_id=$1`, [foreign]))!.id;
    check('another account\'s programme: 404', (await get(`/api/public/epg/programmes/${secret}`)).s, 404);

    // ETag / 304
    const e1 = await get(`/api/public/epg/channels/${live}/now`);
    const e2 = await get(`/api/public/epg/channels/${live}/now`, pk, { 'if-none-match': e1.h.get('etag') ?? '' });
    check('unchanged: 304 on If-None-Match', e2.s, 304);

    // the cache: served warm, and dropped by a write
    const before = cacheStats().hits;
    await get(`/api/public/epg/channels/${fast}/now`);
    check('a repeat read is served from the cache', cacheStats().hits > before, true);
    await query(`UPDATE programmes SET title = 'Pilot 0 (special)' WHERE id = $1`, [pid]);
    let seen = '';
    for (let i = 0; i < 40 && seen !== 'Pilot 0 (special)'; i++) { await sleep(25); seen = (await get(`/api/public/epg/channels/${fast}/now`)).j.now?.title; }
    check('an edit shows at once (trigger drops the slab)', seen, 'Pilot 0 (special)');
    await query(`UPDATE vod_assets SET metadata = metadata || '{"description":"Rewritten"}' WHERE id = $1`, [vod]);
    seen = '';
    for (let i = 0; i < 40 && seen !== 'Rewritten'; i++) { await sleep(25); seen = (await get(`/api/public/epg/channels/${fast}/now`)).j.now?.description; }
    check('editing the FAST title\'s asset shows in the guide too', seen, 'Rewritten');
    // A FAST re-apply: the scheduled future replaced in one statement.
    await query(`DELETE FROM programmes WHERE channel_id = $1 AND source_ref LIKE 'fast:%' AND starts_at > now()`, [fast]);
    await query(`INSERT INTO programmes (channel_id, source_ref, title, starts_at, ends_at, metadata) VALUES ($1,$2,'New lineup',$3,$4,'{"source":"fast"}')`, [fast, `fast:${lineup}:v2:a`, at(30), at(60)]);
    seen = '';
    for (let i = 0; i < 40 && seen !== 'New lineup'; i++) { await sleep(25); seen = (await get(`/api/public/epg/channels/${fast}/now?next=1`)).j.next?.[0]?.title; }
    check('a FAST re-apply replaces next at once', seen, 'New lineup');
  } finally {
    srv.close();
    await stopListener().catch(() => {});
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
