// ============================================================================
//  COLLECTION ACCESS BY APP AND REGION (build queue C2,
//  services/collectionAccess.ts, modules/collections.ts, migrations 0158 and
//  0159, the collection layer in services/availability.ts onDemandAccess).
//
//  The pure parts first: validation, a level's scope and regions, most
//  restrictive across collections per app and region, per-app prices, an
//  unknown country never getting through, a child only tightening, the
//  rights cap. Then end to end through the API and the play gate: a package
//  answers 402 with its products for that app, buying it (a purchase, a
//  viewer session) unlocks it, a looser collection does not loosen it, a
//  child inherits and a parent's change reaches the child's titles, a move
//  and a removal compile the title again, the rights refuse a manual add
//  and cap the gate, View as, another account kept out, and a warm gate
//  with a package rule still makes no database read.
//    DATABASE_URL=... npx tsx test/collection-access.check.ts
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};

(async () => {
  const CA = await import('../src/services/collectionAccess');
  const term = (key: string, cents: number, extra: any = {}) => ({ productKey: key, kind: 'period', count: 1, unit: 'month', priceCents: cents, currency: 'GBP', ...extra });

  // ---- validation
  const bad = (raw: any, apps: string[] = ['app-web']) => { try { CA.validateAccess(raw, apps); return null; } catch (e: any) { return e.problems; } };
  check('the default (nothing sent) is All apps, Global, All access', CA.validateAccess({}, []), CA.ALL_ACCESS);
  check('a bad country code, a premium rule with no product and an unknown app are each named',
    bad({ apps: ['nope'], territories: { mode: 'allow', countries: ['GBR'] }, rules: [{ countries: ['GB'], access: 'premium' }] })?.length, 3);
  check('an allow list needs a territory', bad({ territories: { mode: 'allow', countries: [] } })?.[0], 'Name at least one territory the collection applies in.');
  check('prices for an app the collection does not apply to are refused',
    bad({ apps: ['app-web'], rules: [{ countries: ['GB'], access: 'premium', terms: [term('p', 499)], appTerms: { 'app-ios': [term('q', 599)] } }] }, ['app-web', 'app-ios'])?.[0],
    'Region rule 1: prices for an app the collection does not apply to.');
  const v = CA.validateAccess({ territories: { mode: 'allow', countries: ['gb', 'ie'] }, rules: [{ countries: ['gb'], access: 'premium', terms: [term('sport.m', 999, { currency: 'gbp' })] }] }, []);
  check('codes upper-cased, currency upper-cased, rule ids given', [v.territories.countries, v.rules[0].countries, v.rules[0].terms![0].currency, v.rules[0].id], [['GB', 'IE'], ['GB'], 'GBP', 'r1']);

  // ---- cells: most restrictive per app and region
  const L = (c: string, a: any) => ({ c, n: c.toUpperCase(), ...CA.ALL_ACCESS, ...a });
  const sport = L('sport', { rules: [{ id: 'r1', countries: ['GB'], access: 'premium', terms: [term('sport.web', 999)], appTerms: { ios: [term('sport.ios', 1099)] } }] });
  const free = L('free', { rules: [{ id: 'r1', countries: ['WORLD'], access: 'free' }] });
  const members = L('members', { apps: ['tv'], rules: [{ id: 'r1', countries: ['WORLD'], access: 'members' }] });
  const comp = { v: 1 as const, g: [{ c: 'sport', n: 'SPORT', levels: [sport] }, { c: 'free', n: 'FREE', levels: [free] }, { c: 'members', n: 'MEMBERS', levels: [members] }] };
  const cell = (app: string | null, cc: string | null) => { const x = CA.cellFor(comp, app, cc); return [x.access, x.packages.map((p) => p.id), x.terms.map((t) => t.productKey)]; };
  check('GB on the web: premium, the Sport package, its web price (the free collection does not loosen it)', cell('web', 'GB'), ['premium', ['sport'], ['sport.web']]);
  check('GB on the phone: the phone\'s own product', cell('ios', 'GB'), ['premium', ['sport'], ['sport.ios']]);
  check('FR on the web: free', cell('web', 'FR'), ['free', [], []]);
  check('FR on the TV app: members (the members collection applies to the TV app only)', cell('tv', 'FR'), ['members', [], []]);
  check('GB on the TV app: premium beats members', cell('tv', 'GB')[0], 'premium');
  check('an unknown country is treated as the strictest region', cell('web', null)[0], 'premium');
  check('nothing compiled: free', CA.cellFor(null, 'web', 'GB').access, 'free');
  const twoPkgs = { v: 1 as const, g: [{ c: 'sport', n: 'SPORT', levels: [sport] }, { c: 'films', n: 'FILMS', levels: [L('films', { rules: [{ id: 'r', countries: ['GB'], access: 'premium', terms: [term('films.m', 799)] }] })] }] };
  const two = CA.cellFor(twoPkgs, 'web', 'GB');
  check('two packages ask for it: either unlocks', [two.packages.map((p) => p.id), CA.holdsPackage({ entitlements: [{ grants: { collectionIds: ['films'] } }] } as any, two)], [['sport', 'films'], true]);
  check('a product key held unlocks it too; an expired one does not',
    [CA.holdsPackage({ entitlements: [{ grants: {}, productKey: 'sport.web' }] } as any, two), CA.holdsPackage({ entitlements: [{ grants: { collectionIds: ['sport'] }, validUntil: '2000-01-01' }] } as any, two)], [true, false]);
  // scope
  const ukOnly = { v: 1 as const, g: [{ c: 'uk', n: 'UK', levels: [L('uk', { territories: { mode: 'allow', countries: ['GB'] }, rules: [{ id: 'r', countries: ['WORLD'], access: 'members' }] })] }] };
  check('outside its territories a collection says nothing; inside it does; unknown counts as inside',
    [CA.cellFor(ukOnly, 'web', 'FR').access, CA.cellFor(ukOnly, 'web', 'GB').access, CA.cellFor(ukOnly, 'web', null).access], ['free', 'members', 'members']);
  // a chain: the child narrows where, the parent's premium still applies inside
  const kids = L('kids', { rules: [{ id: 'r', countries: ['WORLD'], access: 'members' }] });
  const chain = { v: 1 as const, g: [{ c: 'kids', n: 'KIDS', levels: [sport, kids] }] };
  check('a chain: the child\'s members everywhere, the parent\'s premium in GB with the parent as the package',
    [CA.cellFor(chain, 'web', 'FR').access, CA.cellFor(chain, 'web', 'GB').access, CA.cellFor(chain, 'web', 'GB').packages.map((p) => p.id)], ['members', 'premium', ['sport']]);
  // gate
  const g = (c: any, viewer: any, entitled = false) => { const x = CA.collectionGate(c, { appId: 'web', country: 'GB', viewer, entitled }); return x ? (x.allowed ? x.via : x.reason) : null; };
  check('gate: anonymous refused with payment_required, a holder let in as paying, a trusted assertion too, nothing for a free title',
    [g(comp, null), g(comp, { viewerId: 'v', entitlements: [{ grants: { collectionIds: ['sport'] } }] }), g(comp, null, true), g(null, null)],
    ['payment_required', 'entitlement', 'entitlement', null]);
  check('gate: members asks for a signed-in viewer', [g(ukOnly, null), g(ukOnly, { viewerId: 'v' })], ['members_only', 'members']);

  // ---- a child only tightens
  const parent = CA.validateAccess({ rules: [{ countries: ['GB'], access: 'premium', terms: [term('a', 1)] }, { countries: ['WORLD'], access: 'members' }] }, []);
  check('a child asking the same or more is fine', CA.looserThan(CA.validateAccess({ rules: [{ countries: ['WORLD'], access: 'premium', terms: [term('b', 1)] }] }, []), [parent]), []);
  const lo = CA.looserThan(CA.validateAccess({ rules: [{ countries: ['GB'], access: 'premium', terms: [term('b', 1)] }] }, []), [parent]);
  check('a child that is free outside GB is looser (members there in the parent)', lo, ['It asks for less than the parent in everywhere else. A child collection can only tighten its parent\'s access.']);
  check('a child on more apps or more territories than its parent is looser',
    [CA.looserThan(CA.validateAccess({ apps: 'all' }, []), [{ ...CA.ALL_ACCESS, apps: ['x'] }]).length,
      CA.looserThan(CA.validateAccess({ territories: { mode: 'allow', countries: ['GB', 'FR'] } }, []), [{ ...CA.ALL_ACCESS, territories: { mode: 'allow', countries: ['GB'] } }])],
    [1, ['Territories the parent does not apply in: FR.']]);
  check('no parent with access: anything goes', CA.looserThan(CA.ALL_ACCESS, []), []);

  // ---- the rights cap
  const open = { uses: ['on_demand'], from: null, until: null, territoryMode: 'all', territories: [], blockTerritories: [], appMode: 'all', appTypes: [], appIds: [], blockAppIds: [], accessTypes: ['free', 'members', 'subscription', 'ppv'] } as any;
  const apps = [{ id: 'web', name: 'Web', rightsType: 'web' as const }, { id: 'ios', name: 'Phone', rightsType: 'mobile' as const }];
  check('rights: open rights, no conflict', CA.rightsConflict([sport], open, apps), null);
  check('rights: free-only rights refuse a premium collection', CA.rightsConflict([sport], { ...open, accessTypes: ['free'] }, apps), 'The rights do not allow premium access, which this collection asks for.');
  check('rights: web-only rights refuse a phone-only collection', CA.rightsConflict([L('p', { apps: ['ios'] })], { ...open, appMode: 'allow', appTypes: ['web'] }, apps),
    'The rights do not allow this title in Phone, the apps this collection applies to.');
  check('rights: territories the rights exclude', CA.rightsConflict([L('uk', { territories: { mode: 'allow', countries: ['GB'] } })], { ...open, territoryMode: 'allow', territories: ['FR'] }, apps),
    'The rights do not allow this title in GB, the territories this collection applies to.');

  // ======================= end to end ========================================
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { signViewer } = await import('../src/auth/viewerTokens');
  const { invalidateTag } = await import('../src/scale/cache');
  const A = await import('../src/services/availability');
  const E = await import('../src/services/entitlements');
  const tag = Date.now().toString(36);
  const mk = async (n: string) => {
    const a = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`ca-${n}-${tag}`]))!.id;
    const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `ca-${n}-${tag}@volt.test`]))!.id;
    return { a, tok: signAccess({ sub: u, account_id: a, role: 'owner' }) };
  };
  const me = await mk('me'), them = await mk('them');
  const asset = async (title: string, profile: string | null = null) => {
    const id = (await one<any>(
      `INSERT INTO vod_assets(account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, media_state, rights_profile_id)
       VALUES ($1,'upload','clip',$2,'x',0,60000,60000,'ready',$3) RETURNING id`, [me.a, title, profile]))!.id;
    await query(`UPDATE vod_assets SET master_key = $2, formats = '{"hls":true}'::jsonb WHERE id = $1`, [id, `/clips/vod/${id}/master.m3u8`]);
    await A.publish(id, 'test');
    invalidateTag(`asset:${id}`);
    return id;
  };
  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const http = async (method: string, path: string, body?: any, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j: any = null; try { j = JSON.parse(t); } catch { j = t; }
    return { s: r.status, j };
  };
  const admin = (method: string, path: string, body?: any, who = me) => http(method, path, body, { authorization: `Bearer ${who.tok}` });
  const settle = async (ids: string[]) => { const CAq = await import('../src/services/collectionAccess'); while (await CAq.drainAccessRechecks()); for (const id of ids) invalidateTag(`asset:${id}`); };
  try {
    const webApp = (await admin('POST', '/api/apps', { name: 'Web', type: 'web' })).j;
    const iosApp = (await admin('POST', '/api/apps', { name: 'Phone', type: 'ios' })).j;
    const web = webApp.publishableKey.key, ios = iosApp.publishableKey.key;
    const gate = (id: string, key: string, geo: string, h: Record<string, string> = {}) =>
      http('POST', '/api/availability', { appKey: key, assetId: id, geo }, { origin: 'https://example.com', ...h });
    const freeOnly = (await one<any>(`INSERT INTO rights_profiles(account_id, name, access_types) VALUES ($1,'Free only',$2) RETURNING id`, [me.a, ['free']]))!.id;

    const final = await asset('Cup final'), semi = await asset('Cup semi'), news = await asset('News'), cartoon = await asset('Cartoon'), freeTitle = await asset('Free to air', freeOnly);
    const col = async (name: string, parentId: string | null = null) => (await admin('POST', '/api/collections', { name, parentId })).j.id;
    const sportC = await col('Sport'), kidsC = await col('Kids', sportC), picksC = await col('Free picks');
    await admin('POST', `/api/collections/${sportC}/items`, { assetIds: [final, semi] });
    await admin('POST', `/api/collections/${kidsC}/items`, { assetIds: [cartoon] });
    await admin('POST', `/api/collections/${picksC}/items`, { assetIds: [final, news] });
    await query(`INSERT INTO collection_items(collection_id, vod_asset_id) VALUES ($1,$2)`, [sportC, freeTitle]);   // there before the access, as by a rule
    check('before any access: the final plays in GB', (await gate(final, web, 'GB')).s, 200);

    const g0 = await admin('GET', `/api/collections/${sportC}/access`);
    check('GET access: none yet (inherits), the default, the account\'s apps, the titles counted', [g0.s, g0.j.access, g0.j.inherits, g0.j.apps.length, g0.j.items], [200, null, true, 2, 4]);
    const sportAccess = { apps: 'all', territories: { mode: 'world', countries: [] }, rules: [
      { countries: ['GB', 'IE'], access: 'premium', terms: [term(`sport.web.${tag}`, 999)], appTerms: { [iosApp.id]: [term(`sport.ios.${tag}`, 1099)] } }] };
    const p1 = await admin('PUT', `/api/collections/${sportC}/access`, { access: sportAccess });
    check('PUT access: saved, two products made, the titles here and below compiled', [p1.s, p1.j.products, p1.j.queued, p1.j.compiled >= 4], [200, 2, 4, true]);
    const prod = await one<any>(`SELECT grants, source_rule FROM products WHERE account_id = $1 AND key = $2`, [me.a, `sport.web.${tag}`]);
    check('the product grants the collection', [prod?.grants, prod?.source_rule], [{ collectionIds: [sportC] }, `collection:${sportC}`]);
    check('audited', Number((await one<any>(`SELECT count(*)::int AS n FROM audit_log WHERE entity_type = 'collection' AND entity_id = $1`, [sportC]))!.n), 1);
    const stored = await one<any>(`SELECT collection_access FROM vod_assets WHERE id = $1`, [final]);
    check('the title carries the compiled chain', [stored?.collection_access?.g?.length, stored?.collection_access?.g?.[0]?.c], [1, sportC]);
    check('a title in no collection with access carries nothing', (await one<any>(`SELECT collection_access FROM vod_assets WHERE id = $1`, [news]))!.collection_access, null);

    const w = await gate(final, web, 'GB');
    check('GB on the web: 402, the Sport package, the web product only', [w.s, w.j.mode, w.j.packages?.map((p: any) => p.name), w.j.products?.map((p: any) => p.productKey)],
      [402, 'paywall', ['Sport'], [`sport.web.${tag}`]]);
    const i = await gate(final, ios, 'GB');
    check('GB on the phone: the phone\'s own product and price', [i.s, i.j.products?.map((p: any) => [p.productKey, p.priceCents])], [402, [[`sport.ios.${tag}`, 1099]]]);
    check('IE too; FR plays (the Free picks collection does not loosen GB)', [(await gate(final, web, 'IE')).s, (await gate(final, web, 'FR')).s], [402, 200]);
    check('a title in no collection with access plays in GB', (await gate(news, web, 'GB')).s, 200);
    check('the child\'s title inherits the parent\'s premium in GB', (await gate(cartoon, web, 'GB')).s, 402);
    const fr = await gate(freeTitle, web, 'GB');
    check('rights cap: a free-only title already in Sport is refused in GB as rights, not offered for sale', [fr.s, fr.j.products], [451, undefined]);
    check('...and plays in FR, where Sport asks nothing', (await gate(freeTitle, web, 'FR')).s, 200);

    // buying it
    const viewer = await E.upsertViewer(me.a, `fan-${tag}`);
    const token = (ents: any[]) => signViewer({ id: viewer.id, accountId: me.a, appId: webApp.id, groups: [], entitlements: ents }).token;
    const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
    check('signed in without the package: still 402', (await gate(final, web, 'GB', bearer(token([])))).s, 402);
    const bought = await E.recordPurchase(me.a, { provider: 'manual', providerTxnId: `t-${tag}`, providerProductId: `sport.web.${tag}`, viewerExternalId: `fan-${tag}`, status: 'paid' });
    check('a purchase of the product grants the collection', bought.entitlement?.grants, { collectionIds: [sportC] });
    invalidateTag(`viewer:${viewer.id}`);   // the entitlements trigger's announcement, on this task
    const ents = await E.viewerEntitlements(viewer.id);
    const paid = await gate(final, web, 'GB', bearer(token(ents)));
    check('with the package in the session: plays', [paid.s, paid.j.mode], [200, 'play']);
    check('...the child\'s title too', (await gate(cartoon, web, 'GB', bearer(token(ents)))).s, 200);
    check('just bought (the session predates it): the gate looks once and plays', (await gate(semi, web, 'GB', bearer(token([])))).s, 200);

    // a child can only tighten; a parent's change reaches the child's titles
    const loose = await admin('PUT', `/api/collections/${kidsC}/access`, { access: { rules: [{ countries: ['WORLD'], access: 'free' }] } });
    check('a child asking less than its parent is refused 422, naming where', [loose.s, loose.j.code, /GB/.test(loose.j.error)], [422, 'looser_than_parent', true]);
    const tight = await admin('PUT', `/api/collections/${kidsC}/access`, { access: { rules: [{ countries: ['GB', 'IE'], access: 'premium', terms: [term(`kids.${tag}`, 499)] }, { countries: ['WORLD'], access: 'members' }] } });
    check('a child asking more is saved', tight.s, 200);
    check('the child\'s title: members in FR', [(await gate(cartoon, web, 'FR')).s, (await gate(cartoon, web, 'FR', bearer(token([])))).s], [403, 200]);
    const kp = await gate(cartoon, web, 'GB');
    check('...and in GB either package unlocks it (both offered)', kp.j.packages?.map((p: any) => p.name).sort(), ['Kids', 'Sport']);
    const clash = await admin('PUT', `/api/collections/${picksC}/access`, { access: { rules: [{ countries: ['GB'], access: 'premium', terms: [term(`sport.web.${tag}`, 1)] }] } });
    check('a product key another collection sells is refused 409', [clash.s, clash.j.code], [409, 'product_key_taken']);
    const invalid = await admin('PUT', `/api/collections/${picksC}/access`, { access: { rules: [{ countries: ['GB'], access: 'premium' }] } });
    check('invalid access answers 422 with the problems', [invalid.s, invalid.j.code, invalid.j.problems?.length], [422, 'invalid_access', 1]);
    const p2 = await admin('PUT', `/api/collections/${sportC}/access`, { access: { ...sportAccess, rules: [...sportAccess.rules, { countries: ['FR'], access: 'members' }] } });
    check('the parent asks members in FR now', p2.s, 200);
    check('the final in FR: sign in (403)', (await gate(final, web, 'FR')).s, 403);

    // removal and moves compile the title again
    await admin('POST', `/api/collections/${sportC}/items/remove`, { assetIds: [semi] });
    await settle([semi]);
    check('taken out of Sport: the semi plays in GB again', [(await gate(semi, web, 'GB')).s, (await one<any>(`SELECT collection_access FROM vod_assets WHERE id = $1`, [semi]))!.collection_access], [200, null]);
    const mv = await admin('PATCH', `/api/collections/${kidsC}`, { parentId: null });
    invalidateTag(`asset:${cartoon}`);
    check('Kids moved to the top: its title keeps only its own access (no Sport package now)', [mv.s, (await gate(cartoon, web, 'GB')).j.packages?.map((p: any) => p.name)], [200, ['Kids']]);
    await admin('PUT', `/api/collections/${kidsC}/access`, { access: null });
    invalidateTag(`asset:${cartoon}`);
    check('access cleared: the title plays', [(await gate(cartoon, web, 'GB')).s, (await one<any>(`SELECT collection_access FROM vod_assets WHERE id = $1`, [cartoon]))!.collection_access], [200, null]);

    // the rights cap on a manual add
    const other = await asset('Free to air 2', freeOnly);
    const add = await admin('POST', `/api/collections/${sportC}/items`, { assetIds: [other, news] });
    check('a manual add the rights rule out is refused with the reason; the rest are added',
      [add.s, add.j.added, add.j.refused?.map((r: any) => [r.assetId === other, r.reason])], [200, 1, [[true, 'The rights do not allow premium access, which this collection asks for.']]]);
    check('...and it is not in the collection', (await one<any>(`SELECT 1 AS x FROM collection_items WHERE collection_id = $1 AND vod_asset_id = $2`, [sportC, other])), null);
    check('a collection without access takes it', (await admin('POST', `/api/collections/${picksC}/items`, { assetIds: [other] })).j.added, 1);

    // view as
    const va = (q: string) => admin('GET', `/api/collections/${sportC}/access/view-as?${q}`);
    const anon = await va(`appId=${webApp.id}&country=GB`);
    const by = (x: any, id: string) => x.j.items.find((r: any) => r.assetId === id);
    check('View as anonymous on the web in GB: locked by Sport, the rights-blocked title named, counts',
      [anon.s, by(anon, final).outcome, by(anon, final).packages.map((p: any) => p.name), by(anon, freeTitle).outcome, [anon.j.counts.locked, anon.j.counts.blocked_by_rights, anon.j.counts.plays]], [200, 'locked', ['Sport'], 'blocked_by_rights', [2, 1, undefined]]);
    check('View as a member in FR: plays', by(await va(`appId=${webApp.id}&country=FR&viewer=member`), final).outcome, 'plays');
    check('View as anonymous in FR: sign in', by(await va(`appId=${webApp.id}&country=FR`), final).outcome, 'sign_in');
    check('View as holding the Sport package in GB: plays', by(await va(`appId=${webApp.id}&country=GB&viewer=package&packageId=${sportC}`), final).outcome, 'plays');
    check('View as with another account\'s app: refused', (await va(`appId=00000000-0000-0000-0000-000000000000&country=GB`)).s, 400);

    // tenancy
    check('another account cannot read or set the access', [(await admin('GET', `/api/collections/${sportC}/access`, undefined, them)).s,
      (await admin('PUT', `/api/collections/${sportC}/access`, { access: null }, them)).s], [404, 404]);
    check('apps of another account cannot be named', (await admin('PUT', `/api/collections/${picksC}/access`, { access: { apps: [webApp.id] } }, them)).s, 404);
    const themPicks = (await admin('POST', '/api/collections', { name: 'Theirs' }, them)).j.id;
    const foreign = await admin('PUT', `/api/collections/${themPicks}/access`, { access: { apps: [webApp.id] } }, them);
    check('...in their own collection, my app is not theirs (422)', [foreign.s, foreign.j.code], [422, 'invalid_access']);

    // a deleted collection frees its titles
    await admin('DELETE', `/api/collections/${sportC}`);
    await settle([final]);
    check('Sport deleted: the final plays in GB', (await gate(final, web, 'GB')).s, 200);

    // ---- scale: a warm gate with a package rule reads nothing
    const s2 = await col('Sport again');
    await admin('POST', `/api/collections/${s2}/items`, { assetIds: [semi] });
    await admin('PUT', `/api/collections/${s2}/access`, { access: { rules: [{ countries: ['GB'], access: 'premium', terms: [term(`s2.${tag}`, 999)] }] } });
    invalidateTag(`asset:${semi}`);
    await gate(semi, web, 'GB'); await gate(semi, web, 'FR');
    const orig = (pool as any).query.bind(pool);
    let reads = 0;
    (pool as any).query = (...q: any[]) => { reads++; return orig(...q); };
    const r1 = await gate(semi, web, 'GB'), r2 = await gate(semi, web, 'FR');
    (pool as any).query = orig;
    check('warm: a 402 and a 200 with no database read', [r1.s, r2.s, reads], [402, 200, 0]);
  } catch (e: any) {
    console.log('FAIL threw: ' + (e?.stack ?? e)); fail++;
  } finally {
    srv.close();
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
