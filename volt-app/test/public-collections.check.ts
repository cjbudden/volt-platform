// ============================================================================
//  THE PUBLIC COLLECTIONS API (build queue C3-2, modules/publicCollections.ts):
//  a collection as an app's row or rail. Its titles in its order with its
//  sub-collection after it; only what is public, listed and allowed by its
//  publishing rule's Sitemap and schema.org; each with the access an anonymous
//  viewer of that app in that country gets (free, members, premium), a title
//  the rights or a geo rule keep from them left out. Countries with the same
//  answer share a territory group (the ETag); a warm request reads nothing
//  from the database; a membership or title change reaches the answer at once
//  through the database triggers (migration 0174).
//    DATABASE_URL=... npx tsx test/public-collections.check.ts
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${w}] got [${g}]`); fail++ }
};

(async () => {
  const { createServer } = await import('../src/server');
  const db = await import('../src/db');
  const { pool, one, query } = db;
  const { signAccess } = await import('../src/auth/jwt');
  const { generateKey } = await import('../src/services/apiKeys');
  const { refreshPublicStatus } = await import('../src/services/publicStatus');
  const { wireCacheInvalidation, invalidateTag } = await import('../src/scale/cache');
  const { publicCollectionStats, accessOf } = await import('../src/modules/publicCollections');
  const { startListener, stopListener, listenerConnected } = await import('../src/scale/notify');
  // as at boot (scale/boot.ts): the cache drops what the database triggers announce
  wireCacheInvalidation(); await startListener();
  for (let i = 0; i < 50 && !listenerConnected(); i++) await new Promise((r) => setTimeout(r, 100));

  check('accessOf: allowed is free', accessOf({ allowed: true }), 'free');
  check('accessOf: a paywall is premium', accessOf({ allowed: false, layer: 'on_demand', reason: 'payment required' }), 'premium');
  check('accessOf: members only is members', accessOf({ allowed: false, layer: 'rules', rule: { reason: 'members_only' } }), 'members');
  check('accessOf: geo and rights keep it out', [accessOf({ allowed: false, layer: 'on_demand', reason: 'This title is not available in FR' }), accessOf({ allowed: false, layer: 'rights' })], [null, null]);

  const tag = Date.now().toString(36);
  const mkAcct = async (n: string) => {
    const a = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`${n}-${tag}`]))!.id;
    const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `${n}-${tag}@volt.test`]))!.id;
    const app = (await one<any>(`INSERT INTO apps(account_id, name, type, restrictions) VALUES ($1,'Web','web','{}'::jsonb) RETURNING id`, [a]))!.id;
    const k = generateKey('publishable');
    await query(`INSERT INTO api_keys(account_id, app_id, kind, key_prefix, key_hash, scopes) VALUES ($1,$2,'publishable',$3,$4,'{playback}')`, [a, app, k.prefix, k.hash]);
    return { a, app, key: k.raw, tok: signAccess({ sub: u, account_id: a, role: 'owner' }) };
  };
  const me = await mkAcct('pc'), other = await mkAcct('pcx');
  const STAMP = (o: any = {}) => JSON.stringify({ targets: [{ kind: 'portal' }], access: 'free', geo: { mode: 'worldwide', countries: [] }, ...o });
  const mk = async (account: string, title: string, stamp: string | null, set = '') => {
    const id = (await one<any>(
      `INSERT INTO vod_assets(account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, formats, metadata)
       VALUES ($1,'upload','export',$2,0,0,600000,'{}'::jsonb,$3::jsonb) RETURNING id`, [account, title, JSON.stringify({ title, series: title === 'Episode' ? 'Coast' : undefined, season: title === 'Episode' ? 1 : undefined, episodeNumber: title === 'Episode' ? 2 : undefined })]))!.id;
    await query(`UPDATE vod_assets SET master_key = $2, progressive_key = $3, media_state = 'ready' WHERE id = $1`, [id, `vod/${id}/master.m3u8`, `vod/${id}/file.mp4`]);
    if (stamp) await query(`UPDATE vod_assets SET availability_state = 'available', published = true, availability = $2::jsonb, available_from = now() - interval '1 day' WHERE id = $1`, [id, stamp]);
    if (set) await query(`UPDATE vod_assets SET ${set} WHERE id = $1`, [id]);
    await refreshPublicStatus(id); invalidateTag(`asset:${id}`);
    return id as string;
  };
  const OPEN = await mk(me.a, 'Open', STAMP());
  const PAID = await mk(me.a, 'Paid', STAMP({ access: 'paid' }));
  const MEMB = await mk(me.a, 'Members', STAMP({ accessRules: [{ id: 'm', for: { scopes: ['this', 'live', 'ondemand'] }, if: { geo: 'in', countries: ['WORLD'] }, then: { access: 'members' } }] }));
  const AU = await mk(me.a, 'Australia only', STAMP({ geo: { mode: 'allow', countries: ['AU'] } }));
  const DRAFT = await mk(me.a, 'Draft', null);
  const UNL = await mk(me.a, 'Unlisted', STAMP(), `unlisted = true`);
  const NOSM = await mk(me.a, 'No sitemap', STAMP({ distribution: { sitemap: false } }));
  const EP = await mk(me.a, 'Episode', STAMP());
  const LATER = await mk(me.a, 'Later', STAMP());

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const admin = async (method: string, path: string, body?: any) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${me.tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json().catch(() => null) };
  };
  const pub = async (path: string, key = me.key, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path + (path.includes('?') ? '&' : '?') + `appKey=${encodeURIComponent(key)}`, { headers });
    return { s: r.status, j: r.status === 200 ? await r.json() : null, etag: r.headers.get('etag'), cc: r.headers.get('cache-control') };
  };
  const ids = (j: any) => (j?.items ?? []).map((i: any) => i.id);
  const wait = async (f: () => Promise<boolean>) => { for (let i = 0; i < 40; i++) { if (await f()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

  try {
    const K = (await admin('POST', '/api/collections', { name: 'Coast row', description: 'Along the coast' })).j.id;
    const KS = (await admin('POST', '/api/collections', { name: 'Coast extras', parentId: K })).j.id;
    await admin('POST', `/api/collections/${K}/items`, { assetIds: [OPEN, PAID, DRAFT, MEMB, UNL, AU, NOSM] });
    await admin('POST', `/api/collections/${KS}/items`, { assetIds: [EP] });
    const KX = (await (await fetch(base + '/api/collections', { method: 'POST', headers: { authorization: `Bearer ${other.tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Theirs' }) })).json()).id;

    check('no key: 401', (await fetch(`${base}/api/public/collections/${K}`)).status, 401);
    check('a key that does not exist: 401', (await pub(`/api/public/collections/${K}`, 'pk_live_nope')).s, 401);
    check('another account\'s collection: 404, as one that does not exist', (await pub(`/api/public/collections/${KX}`)).s, 404);
    check('not an id: 404', (await pub(`/api/public/collections/nope`)).s, 404);

    const fr = await pub(`/api/public/collections/${K}?geo=FR`);
    check('FR: the public, listed titles in the collection\'s order, the sub-collection after', ids(fr.j), [OPEN, PAID, MEMB, EP]);
    check('FR: what an anonymous viewer of this app gets', fr.j.items.map((i: any) => i.access), ['free', 'premium', 'members', 'free']);
    check('left out: a draft, an unlisted title, one whose rule turns Sitemap off, one cleared for AU only',
      [DRAFT, UNL, NOSM, AU].map((x) => ids(fr.j).includes(x)), [false, false, false, false]);
    check('the collection and its sub-collections', [fr.j.collection.name, fr.j.collection.description, fr.j.collection.children.map((c: any) => c.name)], ['Coast row', 'Along the coast', ['Coast extras']]);
    const ep = fr.j.items.find((i: any) => i.id === EP);
    check('an episode carries its series, season and episode', [ep.series, ep.season, ep.episode, ep.title, ep.status], ['Coast', 1, 2, 'Episode', 'available']);
    check('shared at the edge, with the territory group as its ETag', [/s-maxage=\d+/.test(fr.cc ?? ''), fr.etag], [true, `W/"pc-${fr.j.territoryGroup}"`]);

    const au = await pub(`/api/public/collections/${K}?geo=AU`);
    check('AU: the Australian title is in, where its rights allow', ids(au.j), [OPEN, PAID, MEMB, AU, EP]);
    check('AU is another territory group', au.j.territoryGroup !== fr.j.territoryGroup, true);
    const de = await pub(`/api/public/collections/${K}?geo=DE`);
    check('DE has the same answer as FR: the same territory group', [de.j.territoryGroup, de.etag], [fr.j.territoryGroup, fr.etag]);
    const r304 = await fetch(`${base}/api/public/collections/${K}?geo=DE&appKey=${encodeURIComponent(me.key)}`, { headers: { 'if-none-match': fr.etag! } });
    check('so a row fetched in FR answers 304 in DE', r304.status, 304);
    check('deep=false: only the collection\'s own titles', ids((await pub(`/api/public/collections/${K}?geo=FR&deep=false`)).j), [OPEN, PAID, MEMB]);

    // ---- warm: no database read, nothing worked out again
    const computed = publicCollectionStats.computed;
    let reads = 0;
    const origQuery = pool.query.bind(pool), origConnect = pool.connect.bind(pool);
    (pool as any).query = (...a: any[]) => { reads++; return (origQuery as any)(...a); };
    (pool as any).connect = (...a: any[]) => { reads++; return (origConnect as any)(...a); };
    const warm = [await pub(`/api/public/collections/${K}?geo=FR`), await pub(`/api/public/collections/${K}?geo=DE`), await pub(`/api/public/collections/${K}?geo=AU`)];
    (pool as any).query = origQuery; (pool as any).connect = origConnect;
    check('warm: FR, DE and AU again read nothing from the database', reads, 0);
    check('and work nothing out again', publicCollectionStats.computed - computed, 0);
    check('with the same answers', warm.map((w) => w.j.territoryGroup), [fr.j.territoryGroup, fr.j.territoryGroup, au.j.territoryGroup]);

    // ---- a change reaches the row at once (database triggers on collection_items and vod_assets)
    await admin('POST', `/api/collections/${K}/items`, { assetIds: [LATER] });
    check('a title added to the collection joins the row', await wait(async () => ids((await pub(`/api/public/collections/${K}?geo=FR`)).j).includes(LATER)), true);
    await admin('POST', `/api/collections/${KS}/items/remove`, { assetIds: [EP] });
    check('a title taken out of the sub-collection leaves it', await wait(async () => !ids((await pub(`/api/public/collections/${K}?geo=FR`)).j).includes(EP)), true);
    await query(`UPDATE vod_assets SET unlisted = true WHERE id = $1`, [OPEN]); await refreshPublicStatus(OPEN);
    check('a title made unlisted leaves the row', await wait(async () => !ids((await pub(`/api/public/collections/${K}?geo=FR`)).j).includes(OPEN)), true);
    await admin('PATCH', `/api/collections/${KS}`, { name: 'Coast bonus' });
    check('a sub-collection renamed is renamed in the row', await wait(async () => (await pub(`/api/public/collections/${K}?geo=FR`)).j.collection.children[0]?.name === 'Coast bonus'), true);
    await admin('DELETE', `/api/collections/${K}`);
    check('a deleted collection: 404', await wait(async () => (await pub(`/api/public/collections/${K}?geo=FR`)).s === 404), true);
  } finally {
    srv.close(); await stopListener(); await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
