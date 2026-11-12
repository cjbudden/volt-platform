// ============================================================================
//  LOCKED TITLES IN THE PUBLIC COLLECTION ANSWER (build queue C2-4,
//  modules/publicCollections.ts). A title a collection sells as a package in
//  an app and country is listed as premium with the packages that unlock it
//  and what the app can sell (the play gate's own answer, so the row and the
//  402 name the same package). Each app chooses upsell (listed, locked) or
//  hide (left out); members-only titles are listed either way. A rule
//  collection leaves out a title only its rules put there when another
//  collection sells it as a package there; one a person added stays, locked.
//  Cached per app and territory group, no database read when warm; an app's
//  switch to hide reaches the warm answer at once.
//    DATABASE_URL=... npx tsx test/public-collections-locked.check.ts
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${w}] got [${g}]`); fail++ }
};

(async () => {
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { refreshPublicStatus } = await import('../src/services/publicStatus');
  const { wireCacheInvalidation, invalidateTag } = await import('../src/scale/cache');
  const { publicCollectionStats } = await import('../src/modules/publicCollections');
  const { startListener, stopListener, listenerConnected } = await import('../src/scale/notify');
  wireCacheInvalidation(); await startListener();
  for (let i = 0; i < 50 && !listenerConnected(); i++) await new Promise((r) => setTimeout(r, 100));

  // the collection layer's refusals, as the gate words them (found by C2-4: a package read as an availability refusal)
  const { accessOf } = await import('../src/modules/publicCollections');
  check('accessOf: a collection package is premium', accessOf({ allowed: false, layer: 'on_demand', reason: 'Part of Sport. Buy it to watch.', rule: { reason: 'payment_required', layer: 'collection' } }), 'premium');
  check('accessOf: a collection sign-in is members', accessOf({ allowed: false, layer: 'on_demand', reason: 'Sign in to watch this.', rule: { reason: 'members_only', layer: 'collection' } }), 'members');

  const tag = Date.now().toString(36);
  const a = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`pcl-${tag}`]))!.id;
  const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `pcl-${tag}@volt.test`]))!.id;
  const tok = signAccess({ sub: u, account_id: a, role: 'owner' });
  const STAMP = (o: any = {}) => JSON.stringify({ targets: [{ kind: 'portal' }], access: 'free', geo: { mode: 'worldwide', countries: [] }, ...o });
  const mk = async (title: string, stamp: string) => {
    const id = (await one<any>(
      `INSERT INTO vod_assets(account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, formats, metadata)
       VALUES ($1,'upload','export',$2,0,0,600000,'{"hls":true}'::jsonb,$3::jsonb) RETURNING id`, [a, title, JSON.stringify({ title })]))!.id;
    await query(`UPDATE vod_assets SET master_key = $2, progressive_key = $3, media_state = 'ready', availability_state = 'available', published = true,
                        availability = $4::jsonb, available_from = now() - interval '1 day' WHERE id = $1`, [id, `vod/${id}/master.m3u8`, `vod/${id}/file.mp4`, stamp]);
    await refreshPublicStatus(id); invalidateTag(`asset:${id}`);
    return id as string;
  };
  const FINAL = await mk('Cup final', STAMP());
  const SEMI = await mk('Cup semi', STAMP());
  const OPEN = await mk('Harbour walk', STAMP());
  const MEMB = await mk('Cup members talk', STAMP({ accessRules: [{ id: 'm', for: { scopes: ['this', 'live', 'ondemand'] }, if: { geo: 'in', countries: ['WORLD'] }, then: { access: 'members' } }] }));

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const admin = async (method: string, path: string, body?: any) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json().catch(() => null) };
  };
  const pub = async (path: string, key: string) => {
    const r = await fetch(base + path + (path.includes('?') ? '&' : '?') + `appKey=${encodeURIComponent(key)}`);
    return { s: r.status, j: r.status === 200 ? await r.json() : null, etag: r.headers.get('etag') };
  };
  const ids = (j: any) => (j?.items ?? []).map((i: any) => i.id);
  const item = (j: any, id: string) => (j?.items ?? []).find((i: any) => i.id === id);
  const wait = async (f: () => Promise<boolean>) => { for (let i = 0; i < 40; i++) { if (await f()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
  const term = (key: string, cents: number) => ({ productKey: key, kind: 'period', count: 1, unit: 'month', priceCents: cents, currency: 'GBP' });

  try {
    // ---- the app's choice
    const webApp = (await admin('POST', '/api/apps', { name: 'Web', type: 'web' })).j;
    const tvApp = (await admin('POST', '/api/apps', { name: 'TV', type: 'tv', lockedTitles: 'hide' })).j;
    check('a new app lists locked titles (upsell) unless told otherwise; one made with hide keeps it', [webApp.locked_titles, tvApp.locked_titles], ['upsell', 'hide']);
    check('only upsell or hide', (await admin('PUT', `/api/apps/${webApp.id}`, { lockedTitles: 'maybe' })).s, 422);
    const web = webApp.publishableKey.key, tv = tvApp.publishableKey.key;

    // ---- Sport sells the final as a package in GB and IE; Picks (by hand) and Cup (rules) do not
    const col = async (name: string) => (await admin('POST', '/api/collections', { name })).j.id;
    const sportC = await col('Sport'), picksC = await col('Picks'), cupC = await col('Cup');
    await admin('POST', `/api/collections/${sportC}/items`, { assetIds: [FINAL] });
    await admin('POST', `/api/collections/${picksC}/items`, { assetIds: [FINAL, OPEN, MEMB] });
    const p = await admin('PUT', `/api/collections/${sportC}/access`, { access: { apps: 'all', territories: { mode: 'world', countries: [] },
      rules: [{ countries: ['GB', 'IE'], access: 'premium', terms: [term(`sport.${tag}`, 999)] }] } });
    check('Sport is premium in GB and IE', p.s, 200);
    await admin('PATCH', `/api/collections/${cupC}`, { rules: { match: 'all', conditions: [{ field: 'title', op: 'contains', value: 'Cup' }] } });
    const cupItems = await admin('GET', `/api/collections/${cupC}/items`);
    check('the Cup rules put the final, the semi and the members talk there', [FINAL, SEMI, MEMB].map((x) => cupItems.j.items.find((r: any) => r.id === x)?.source), ['rule', 'rule', 'rule']);

    // ---- upsell: listed locked, with the package and what can be bought
    const gb = await pub(`/api/public/collections/${picksC}?geo=GB`, web);
    check('web in GB, Picks: every title listed, the app says upsell', [gb.s, ids(gb.j), gb.j.lockedTitles], [200, [FINAL, OPEN, MEMB], 'upsell']);
    check('...the final is premium, unlocked by Sport, sold as the Sport product',
      [item(gb.j, FINAL).access, item(gb.j, FINAL).packages, item(gb.j, FINAL).products.map((t: any) => [t.productKey, t.priceCents])],
      ['premium', [{ id: sportC, name: 'Sport' }], [[`sport.${tag}`, 999]]]);
    check('...a free and a members-only title carry no packages', [item(gb.j, OPEN).access, item(gb.j, OPEN).packages, item(gb.j, MEMB).access, item(gb.j, MEMB).packages], ['free', undefined, 'members', undefined]);
    const gate = await fetch(`${base}/api/availability`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://example.com' }, body: JSON.stringify({ appKey: web, assetId: FINAL, geo: 'GB' }) });
    const gj: any = await gate.json();
    check('the play gate names the same package as the row', [gate.status, gj.packages], [402, item(gb.j, FINAL).packages]);
    const fr = await pub(`/api/public/collections/${picksC}?geo=FR`, web);
    check('web in FR, where Sport asks nothing: the final is free, no packages', [item(fr.j, FINAL).access, item(fr.j, FINAL).packages], ['free', undefined]);

    // ---- hide: what a viewer would have to buy is left out; members-only stays
    const tvGB = await pub(`/api/public/collections/${picksC}?geo=GB`, tv);
    check('TV (hide) in GB: the final is left out, the free and members-only titles stay', [ids(tvGB.j), tvGB.j.lockedTitles], [[OPEN, MEMB], 'hide']);
    check('TV in FR: the final is free there, so listed', ids((await pub(`/api/public/collections/${picksC}?geo=FR`, tv)).j), [FINAL, OPEN, MEMB]);

    // ---- a rule collection does not list another collection's package
    const cupGB = await pub(`/api/public/collections/${cupC}?geo=GB`, web);
    check('web in GB, Cup (rules): the final, locked by Sport, is left out; the semi and the members talk stay', ids(cupGB.j).sort(), [SEMI, MEMB].sort());
    check('web in IE too', ids((await pub(`/api/public/collections/${cupC}?geo=IE`, web)).j).includes(FINAL), false);
    const cupFR = await pub(`/api/public/collections/${cupC}?geo=FR`, web);
    check('web in FR, where Sport asks nothing: the final is in the Cup row, free', [ids(cupFR.j).includes(FINAL), item(cupFR.j, FINAL)?.access], [true, 'free']);
    check('GB and FR answers are different territory groups', cupGB.j.territoryGroup !== cupFR.j.territoryGroup, true);

    // ---- warm: no database read, nothing worked out again
    const computed = publicCollectionStats.computed;
    let reads = 0;
    const oq = pool.query.bind(pool), oc = pool.connect.bind(pool);
    (pool as any).query = (...x: any[]) => { reads++; return (oq as any)(...x); };
    (pool as any).connect = (...x: any[]) => { reads++; return (oc as any)(...x); };
    const warm = [await pub(`/api/public/collections/${picksC}?geo=GB`, web), await pub(`/api/public/collections/${picksC}?geo=GB`, tv), await pub(`/api/public/collections/${cupC}?geo=GB`, web)];
    (pool as any).query = oq; (pool as any).connect = oc;
    check('warm: the upsell, hide and rule answers read nothing from the database', reads, 0);
    check('...and work nothing out again', publicCollectionStats.computed - computed, 0);
    check('...with the same answers', warm.map((w) => w.j.territoryGroup), [gb.j.territoryGroup, tvGB.j.territoryGroup, cupGB.j.territoryGroup]);

    // ---- a person adds the final to Cup by hand: it stays, locked with the package
    await admin('POST', `/api/collections/${cupC}/items`, { assetIds: [FINAL] });
    check('added by hand to the rule collection: listed in GB, premium with Sport', await wait(async () => {
      const r = await pub(`/api/public/collections/${cupC}?geo=GB`, web);
      return item(r.j, FINAL)?.access === 'premium' && item(r.j, FINAL)?.packages?.[0]?.name === 'Sport';
    }), true);

    // ---- the app switches to hide: the warm answer follows at once
    const sw = await admin('PUT', `/api/apps/${webApp.id}`, { lockedTitles: 'hide' });
    check('PUT the app: hide saved', [sw.s, sw.j.locked_titles], [200, 'hide']);
    check('web in GB now leaves the final out of Picks', await wait(async () => {
      const r = await pub(`/api/public/collections/${picksC}?geo=GB`, web);
      return r.j?.lockedTitles === 'hide' && !ids(r.j).includes(FINAL) && ids(r.j).includes(OPEN);
    }), true);
    await admin('PUT', `/api/apps/${webApp.id}`, { lockedTitles: 'upsell' });
    check('and back to upsell lists it again', await wait(async () => ids((await pub(`/api/public/collections/${picksC}?geo=GB`, web)).j).includes(FINAL)), true);

    // ---- Sport stops selling it: the final is free in the rows
    await admin('PUT', `/api/collections/${sportC}/access`, { access: null });
    check('Sport\'s package removed: the final is free in GB on Picks', await wait(async () => item((await pub(`/api/public/collections/${picksC}?geo=GB`, web)).j, FINAL)?.access === 'free'), true);
  } finally {
    srv.close(); await stopListener(); await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
