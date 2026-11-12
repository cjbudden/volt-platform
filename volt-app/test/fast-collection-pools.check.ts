// ============================================================================
//  A COLLECTION AS A FAST POOL (build queue C3, services/fast/collectionPools.ts
//  and the `collection` slot in services/fast/lineup.ts).
//
//  The planner: a collection slot airs the next title of the collection each
//  time it plays, in the collection's order or shuffled without repeats, skips
//  a title outside its rights window, falls back to the backfill, and says so
//  when the collection is gone or has nothing that can air.
//  The channel: only the collection's titles (and its sub-collections') that
//  the FAST library holds, of the channel's media, seen somewhere the channel
//  reaches; the API refuses another account's collection; the guide follows
//  the collection at the next Apply; the titles are packaged ahead.
//    DATABASE_URL=... npx tsx test/fast-collection-pools.check.ts
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${w}] got [${g}]`); fail++ }
};

(async () => {
  const { planLineup, nominalLength } = await import('../src/services/fast/lineup');
  const { reachesChannel } = await import('../src/services/fast/collectionPools');

  // ------------------------------------------------------------ the planner (pure)
  const A = (id: string, min: number, extra: any = {}) => ({ id, title: id.toUpperCase(), durationSec: min * 60, ...extra });
  const assets = new Map<string, any>([['a', A('a', 30)], ['b', A('b', 30)], ['c', A('c', 30)], ['d', A('d', 60)], ['bf', A('bf', 30)]]);
  const epoch = new Date('2026-11-16T00:00:00Z');
  const lineup = (slots: any[], extra: any = {}) => ({ epoch, zone: 'UTC', slots, ads: { enabled: false } as any, ...extra });
  const titles = (p: any) => p.programmes.map((x: any) => x.assetId);
  const day = (h: number) => new Date(epoch.getTime() + h * 3600_000);

  let p = planLineup(lineup([{ id: 'c1', kind: 'collection', collectionId: 'K', order: 'sequential' }], { collections: { K: ['a', 'b', 'c'] } }), assets, epoch, day(3.5));
  check('sequential: each pass takes the next title, in the collection\'s order, round again', titles(p), ['a', 'b', 'c', 'a', 'b', 'c', 'a']);
  check('a pool of more than one is a rotation', p.programmes[0].note, 'rotation');

  p = planLineup(lineup([{ id: 'c1', kind: 'collection', collectionId: 'K', order: 'sequential', every: 2, phase: 1 }, { id: 't', kind: 'title', pool: [{ assetId: 'd' }] }], { collections: { K: ['a', 'b', 'c'] } }), assets, epoch, day(9));
  // the phase also turns the rotation on, as it does for a title slot's pool
  check('every 2 from pass 2: plays on odd passes only, still in order', [p.programmes.filter((x: any) => x.slotId === 'c1').every((x: any) => x.cycle % 2 === 1),
    titles(p).filter((x: string) => x !== 'd').slice(0, 3)], [true, ['b', 'c', 'a']]);

  p = planLineup(lineup([{ id: 'c1', kind: 'collection', collectionId: 'K', order: 'shuffle' }], { collections: { K: ['a', 'b', 'c'] } }), assets, epoch, day(3));
  const t6 = titles(p);
  check('shuffled: each time round the collection every title plays once', [t6.slice(0, 3).sort(), t6.slice(3, 6).sort()], [['a', 'b', 'c'], ['a', 'b', 'c']]);
  check('shuffled: no title twice in a row across the join', t6[2] !== t6[3], true);
  const again = titles(planLineup(lineup([{ id: 'c1', kind: 'collection', collectionId: 'K', order: 'shuffle' }], { collections: { K: ['a', 'b', 'c'] } }), assets, epoch, day(3)));
  check('shuffled: a re-plan gives the same order (deterministic)', again, t6);

  const late = new Map(assets); late.set('b', A('b', 30, { availableFrom: day(48) }));
  p = planLineup(lineup([{ id: 'c1', kind: 'collection', collectionId: 'K', order: 'sequential' }], { collections: { K: ['a', 'b', 'c'] } }), late, epoch, day(2));
  check('a title outside its rights window is passed over for the next one', titles(p), ['a', 'c', 'c', 'a']);
  check('and the planner says why', p.notices.some((n: any) => n.message === '"B" is outside its rights window.'), true);

  p = planLineup(lineup([{ id: 'c1', kind: 'collection', collectionId: 'GONE', order: 'sequential', label: 'Films' }], { collections: {}, backfill: ['bf'] }), assets, epoch, day(1));
  check('a collection that no longer exists: the backfill airs', titles(p), ['bf', 'bf']);
  check('with a notice naming the slot', p.notices[0]?.message, 'The collection in slot Films no longer exists.');
  p = planLineup(lineup([{ id: 'c1', kind: 'collection', collectionId: 'K', order: 'sequential', label: 'Films' }], { collections: { K: [] } }), assets, epoch, day(1));
  check('an empty pool: nothing airs, and it says the collection has nothing for this channel',
    [titles(p).length, p.notices.some((n: any) => n.message === 'The collection in slot Films has nothing that can air on this channel.')], [0, true]);
  p = planLineup(lineup([{ id: 'c1', kind: 'collection', collectionId: 'K', order: 'sequential' }], { collections: { K: ['zz', 'a'] } }), assets, epoch, day(1));
  check('an id the library does not hold is ignored', titles(p), ['a', 'a']);
  check('the pass length is a typical play: the mean of the pool', nominalLength(lineup([{ id: 'c1', kind: 'collection', collectionId: 'K', order: 'sequential' }], { collections: { K: ['a', 'd'] } }) as any, assets), 2700);

  check('region: a UK-only title does not reach an AU and NZ channel', reachesChannel({ mode: 'allow', countries: ['GB'] }, { mode: 'allow', countries: ['AU', 'NZ'] }), false);
  check('region: an AU-only title does', reachesChannel({ mode: 'allow', countries: ['AU'] }, { mode: 'allow', countries: ['AU', 'NZ'] }), true);
  check('region: blocked in AU and NZ does not reach an AU and NZ channel', reachesChannel({ mode: 'block', countries: ['AU', 'NZ'] }, { mode: 'allow', countries: ['AU', 'NZ'] }), false);
  check('region: blocked in AU still reaches it (NZ)', reachesChannel({ mode: 'block', countries: ['AU'] }, { mode: 'allow', countries: ['AU', 'NZ'] }), true);
  check('region: a channel everywhere but GB, a GB-only title', reachesChannel({ mode: 'allow', countries: ['GB'] }, { mode: 'block', countries: ['GB'] }), false);
  check('region: no limits on either side', [reachesChannel(null, { mode: 'allow', countries: ['AU'] }), reachesChannel({ mode: 'block', countries: ['FR'] }, null)], [true, true]);

  // ------------------------------------------------------------ the channel (database and API)
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { assetsInUse } = await import('../src/services/fast/prepare');
  const tag = Date.now().toString(36);
  const acct = async (n: string) => {
    const a = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`${n}-${tag}`]))!.id;
    const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `${n}-${tag}@volt.test`]))!.id;
    return { a, tok: signAccess({ sub: u, account_id: a, role: 'owner' }) };
  };
  const me = await acct('cp'), other = await acct('cpx');
  const g = (await one<any>(`INSERT INTO groups(account_id, name) VALUES ($1,'G') RETURNING id`, [me.a]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name, status, tz, kind, origin, fast_media, geo_mode, geo_countries)
    VALUES ($1,'Oceania Movies','ended','UTC','tv','playlist','video','allow',ARRAY['AU','NZ']) RETURNING id`, [g]))!.id;
  const asset = async (account: string, title: string, set = '') => {
    const id = (await one<any>(
      `INSERT INTO vod_assets(account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, encode_result, qc_state, top_height)
       VALUES ($1,'upload','export',$2,$3,0,0,1800000,'{"zeroStart":true,"segmentSeconds":4}'::jsonb,'pass',1080) RETURNING id`, [account, title, `/clips/vod/${title}/master.m3u8`]))!.id;
    if (set) await query(`UPDATE vod_assets SET ${set} WHERE id = $1`, [id]);
    return id as string;
  };
  const F1 = await asset(me.a, 'Reef');
  const F2 = await asset(me.a, 'Outback');
  const UK = await asset(me.a, 'Thames', `availability = '{"geo":{"mode":"allow","countries":["GB"]}}'::jsonb`);
  const AUD = await asset(me.a, 'Podcast', `top_height = NULL, export_mp3_key = 'x.mp3'`);
  const GONE = await asset(me.a, 'Pulled', `availability_state = 'withdrawn'`);
  const SUB = await asset(me.a, 'Kelp');
  const NEW = await asset(me.a, 'Dunes');

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = async (tok: string, method: string, path: string, body?: any) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const txt = await r.text(); let j: any = null; try { j = JSON.parse(txt); } catch { j = txt; }
    return { s: r.status, j };
  };
  const guide = async () => (await query<any>(
    `SELECT metadata->>'vodAssetId' AS a FROM programmes WHERE channel_id = $1 AND source_ref LIKE 'fast:%' ORDER BY starts_at`, [ch])).map((r) => r.a);

  try {
    let r = await call(me.tok, 'POST', '/api/collections', { name: 'Ocean films' });
    const K = r.j.id ?? r.j.collection?.id;
    r = await call(me.tok, 'POST', '/api/collections', { name: 'Shorts', parentId: K });
    const KS = r.j.id ?? r.j.collection?.id;
    check('a collection with a sub-collection', [!!K, !!KS], [true, true]);
    await call(me.tok, 'POST', `/api/collections/${K}/items`, { assetIds: [F1, UK, AUD, GONE, F2] });
    await call(me.tok, 'POST', `/api/collections/${KS}/items`, { assetIds: [SUB] });
    r = await call(other.tok, 'POST', '/api/collections', { name: 'Not yours' });
    const KX = r.j.id ?? r.j.collection?.id;

    const slot = (collectionId: string, extra: any = {}) => ({ id: 'films', kind: 'collection', collectionId, order: 'sequential', label: 'Films', ...extra });
    r = await call(me.tok, 'POST', `/api/fast/channels/${ch}/lineups`, { name: 'Bad', slots: [slot(KX)] });
    check('another account\'s collection is refused, as one that does not exist', [r.s, r.j.error], [400, 'A slot names a collection that does not exist.']);
    r = await call(me.tok, 'POST', `/api/fast/channels/${ch}/lineups`, { name: 'Main', slots: [slot(K)] });
    check('a run order whose slot is a collection is saved', r.s, 201);
    const lid = r.j.id ?? r.j.lineup?.id;
    const sorted = (o: any) => Object.fromEntries(Object.entries(o).sort(([x], [y]) => x.localeCompare(y)));
    check('the slot is kept as a collection slot', sorted((await one<any>(`SELECT slots FROM fast_lineups WHERE id = $1`, [lid]))!.slots[0]), sorted(slot(K)));

    r = await call(me.tok, 'POST', `/api/fast/lineups/${lid}/preview`, { days: 1 });
    check('preview: what the collection airs here, and why the rest does not', r.j.collections,
      [{ id: K, name: 'Ocean films', total: 6, airs: 3, left: { media: 1, notInLibrary: 1, region: 1 } }]);
    const firstFour = r.j.programmes.slice(0, 4).map((x: any) => x.assetId);
    check('preview: in the collection\'s order, the sub-collection after it, round again', firstFour, [F1, F2, SUB, F1]);
    check('preview: never the UK-only film, the audio title or the withdrawn one', r.j.programmes.some((x: any) => [UK, AUD, GONE].includes(x.assetId)), false);

    const use = await assetsInUse(ch);
    check('the titles it can air are packaged ahead, the rest are not', [F1, F2, SUB, UK, AUD].map((id) => use.get(id) ?? null), ['content', 'content', 'content', null, null]);

    r = await call(me.tok, 'POST', `/api/fast/lineups/${lid}/activate`);
    check('activated: its guide is written', r.s, 200);
    let gd = await guide();
    check('the guide airs only what the collection can air here', [gd.length > 0, gd.every((x) => [F1, F2, SUB].includes(x))], [true, true]);

    // the collection changes; the run order does not
    await call(me.tok, 'POST', `/api/collections/${K}/items`, { assetIds: [NEW] });
    r = await call(me.tok, 'POST', `/api/fast/lineups/${lid}/apply`, { days: 1 });
    gd = await guide();
    check('a title added to the collection reaches the guide at the next Apply, with no edit to the run order', [r.s, gd.includes(NEW)], [200, true]);
    await call(me.tok, 'POST', `/api/collections/${K}/items/remove`, { assetIds: [F2] });
    await call(me.tok, 'POST', `/api/fast/lineups/${lid}/apply`, { days: 1 });
    const ahead = (await query<any>(`SELECT metadata->>'vodAssetId' AS a FROM programmes WHERE channel_id = $1 AND source_ref LIKE 'fast:%' AND starts_at > now() + interval '1 hour'`, [ch])).map((x) => x.a);
    check('a title taken out leaves the guide ahead', [ahead.length > 0, ahead.includes(F2)], [true, false]);

    // a new version keeps the pass count across a collection slot
    r = await call(me.tok, 'POST', `/api/fast/channels/${ch}/lineups`, { name: 'Shuffled', slots: [slot(K, { order: 'shuffle' })] });
    const lid2 = r.j.id ?? r.j.lineup?.id;
    r = await call(me.tok, 'POST', `/api/fast/lineups/${lid2}/activate`);
    check('a shuffled version activates over it', r.s, 200);
    gd = await guide();
    check('and its guide is still only the collection\'s titles', gd.every((x) => [F1, SUB, NEW].includes(x)), true);
  } finally {
    srv.close(); await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
