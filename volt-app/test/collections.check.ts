// ============================================================================
//  COLLECTIONS (modules/collections.ts, migration 0111) and the library's
//  collection filter (GET /api/vod?collection=...).
//    DATABASE_URL=... npx tsx test/collections.check.ts
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};

(async () => {
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const tag = Date.now().toString(36);
  const mk = async (n: string) => {
    const a = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`col-${n}-${tag}`]))!.id;
    const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `col-${n}-${tag}@volt.test`]))!.id;
    const g = (await one<any>(`INSERT INTO groups(account_id, name, max_channels) VALUES ($1,'G',50) RETURNING id`, [a]))!.id;
    const ch = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'C') RETURNING id`, [g]))!.id;
    return { a, u, ch, tok: signAccess({ sub: u, account_id: a, role: 'owner' }) };
  };
  const me = await mk('me'), them = await mk('them');
  const asset = async (o: any, title: string, sec: number) => (await one<any>(
    `INSERT INTO vod_assets(channel_id, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms) VALUES ($1,'clip',$2,'k',0,$3,$3) RETURNING id`, [o.ch, title, sec * 1000]))!.id;
  const songs: string[] = [];
  for (const [t, d] of [['Kota Neon', 214], ['Zapin Moden', 241], ['Hujan Di Bukit', 305], ['Lagu Pelabuhan', 228], ['Rentak Jalanan', 199]] as const) songs.push(await asset(me, t, d));
  const theirs = await asset(them, 'Their song', 200);

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = async (method: string, path: string, body?: any, tok = me.tok) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json().catch(() => null) as any };
  };
  try {
    // ---- tree
    const bl = (await call('POST', '/api/collections', { name: 'BEATLINE', color: '#ff4d6d' })).j;
    check('create a top-level collection', [bl.name, bl.parentId, bl.color], ['BEATLINE', null, '#ff4d6d']);
    const w44 = (await call('POST', '/api/collections', { name: 'Week 44: Monsoon Chill', parentId: bl.id })).j;
    const w45 = (await call('POST', '/api/collections', { name: 'Week 45: Retro Malaysia', parentId: bl.id })).j;
    check('sub-collections under it, in creation order', [w44.parentId === bl.id, w44.sortOrder, w45.sortOrder], [true, 0, 1]);
    check('the same name twice at one level: 409', (await call('POST', '/api/collections', { name: 'week 44: monsoon chill', parentId: bl.id })).s, 409);
    check('the same name at another level is fine', (await call('POST', '/api/collections', { name: 'Week 44: Monsoon Chill' })).s, 201);
    check('a parent in another account: 404', (await call('POST', '/api/collections', { name: 'x', parentId: bl.id }, them.tok)).s, 404);
    let p = bl.id; let deepStatus = 0;
    for (let i = 2; i <= 7; i++) { const r = await call('POST', '/api/collections', { name: `L${i}`, parentId: p }); deepStatus = r.s; if (r.s !== 201) break; p = r.j.id; }
    check('nesting stops at 6 levels', deepStatus, 400);

    // ---- items
    const add = await call('POST', `/api/collections/${w44.id}/items`, { assetIds: [songs[0], songs[1], songs[2], theirs] });
    check('add: own assets in, another account\'s ignored', [add.j.added, add.j.notFound], [3, 1]);
    check('add again: duplicates ignored', (await call('POST', `/api/collections/${w44.id}/items`, { assetIds: [songs[1], songs[3]] })).j, { added: 1, already: 1, notFound: 0 });
    await call('POST', `/api/collections/${w45.id}/items`, { assetIds: [songs[4], songs[0]] });
    await call('POST', `/api/collections/${bl.id}/items`, { assetIds: [songs[2]] });
    const items = (await call('GET', `/api/collections/${w44.id}/items`)).j.items.map((i: any) => i.title);
    check('items in collection order', items, ['Kota Neon', 'Zapin Moden', 'Hujan Di Bukit', 'Lagu Pelabuhan']);
    check('reorder must name every item', (await call('PUT', `/api/collections/${w44.id}/items/order`, { assetIds: [songs[0]] })).s, 400);
    await call('PUT', `/api/collections/${w44.id}/items/order`, { assetIds: [songs[3], songs[2], songs[1], songs[0]] });
    check('reordered', (await call('GET', `/api/collections/${w44.id}/items`)).j.items.map((i: any) => i.title), ['Lagu Pelabuhan', 'Hujan Di Bukit', 'Zapin Moden', 'Kota Neon']);
    const deep = (await call('GET', `/api/collections/${bl.id}/items?deep=true`)).j.items.map((i: any) => i.title);
    check('deep items: its own first, then sub-collections in order, each asset once', deep, ['Hujan Di Bukit', 'Lagu Pelabuhan', 'Zapin Moden', 'Kota Neon', 'Rentak Jalanan']);

    const list = (await call('GET', '/api/collections')).j.items;
    const row = (id: string) => list.find((c: any) => c.id === id);
    check('list: direct and total counts', [row(bl.id).itemCount, row(bl.id).totalCount, row(w44.id).itemCount], [1, 5, 4]);
    check('list: durations of direct items', row(w45.id).durationMs, 199_000 + 214_000);
    check('another account sees none of them', (await call('GET', '/api/collections', undefined, them.tok)).j.items.length, 0);
    check('another account cannot read items: 404', (await call('GET', `/api/collections/${w44.id}/items`, undefined, them.tok)).s, 404);
    const one1 = (await call('GET', `/api/collections/${w44.id}`)).j;
    check('one collection: breadcrumb path', one1.path.map((x: any) => x.name), ['BEATLINE', 'Week 44: Monsoon Chill']);
    const mem = (await call('GET', `/api/collections/memberships?assetIds=${songs[0]},${songs[4]}`)).j.memberships;
    check('memberships per asset', [mem[songs[0]].length, mem[songs[4]].length], [2, 1]);

    // ---- library filter
    const lib = async (qs: string) => (await call('GET', `/api/vod?${qs}`)).j.map((r: any) => r.title).sort();
    check('library: in a collection', await lib(`collection=${w45.id}`), ['Kota Neon', 'Rentak Jalanan']);
    check('library: in a collection and its sub-collections', (await lib(`collection=${bl.id}&collection_deep=true`)).length, 5);
    check('library: the collection alone (not deep)', await lib(`collection=${bl.id}`), ['Hujan Di Bukit']);
    check('library: not yet in a collection', await lib(`not_in_collection=${w44.id}`), ['Rentak Jalanan']);
    check('library: collection with other filters', await lib(`collection=${w44.id}&duration_ms[gte]=230000`), ['Hujan Di Bukit', 'Zapin Moden']);
    check('library: another account\'s collection matches nothing', (await call('GET', `/api/vod?collection=${w44.id}`, undefined, them.tok)).j.length, 0);
    const facets = (await call('GET', `/api/vod/facets?collection=${w44.id}`)).j;
    check('facets follow the collection', facets.total, 4);
    check('a bad collection id: 400', (await call('GET', '/api/vod?collection=nope')).s, 400);

    // ---- move, remove, delete
    check('move inside its own child: 400', (await call('PATCH', `/api/collections/${bl.id}`, { parentId: w44.id })).s, 400);
    const top = (await call('POST', '/api/collections', { name: 'Archive' })).j;
    const mv = await call('PATCH', `/api/collections/${w45.id}`, { parentId: top.id, name: 'Week 45 (aired)' });
    check('move and rename', [mv.s, mv.j.parentId === top.id, mv.j.name], [200, true, 'Week 45 (aired)']);
    check('remove items', (await call('POST', `/api/collections/${w44.id}/items/remove`, { assetIds: [songs[0], songs[4]] })).j.removed, 1);
    const del = await call('DELETE', `/api/collections/${bl.id}`);
    check('delete takes the sub-collections with it', [del.s, del.j.deleted >= 2], [200, true]);
    check('...the assets stay in the library', Number((await one<any>(`SELECT count(*)::int AS n FROM vod_assets WHERE id = ANY($1::uuid[])`, [songs]))!.n), 5);
    check('...the moved collection is untouched', (await call('GET', `/api/collections/${w45.id}/items`)).j.items.length, 2);
    await query(`DELETE FROM vod_assets WHERE id = $1`, [songs[4]]);
    check('deleting an asset drops it from collections', (await call('GET', `/api/collections/${w45.id}/items`)).j.items.length, 1);
  } finally {
    srv.close();
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
