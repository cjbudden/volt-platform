// ============================================================================
//  GLOBAL LISTS (modules/globalLists.ts, services/globalLists.ts, migration 0143).
//    DATABASE_URL=... npx tsx test/global-lists.check.ts
//  Seeds the built-in lists, then checks the read API (public, list standard,
//  caching), the System Admin API (items, rules that protect codes, definition
//  changes, import, order, restore) and who may do what.
// ============================================================================
process.env.PLATFORM_REQUIRE_MFA = 'false';
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};

(async () => {
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { migrate } = await import('../src/services/migrate');
  const { signAccess } = await import('../src/auth/jwt');
  const { ensureGlobalListSeeds, checkValue, BUILT_IN } = await import('../src/services/globalLists');
  await migrate();
  await ensureGlobalListSeeds();
  check('seeding twice adds nothing the second time', await ensureGlobalListSeeds(), 0);

  const tag = Date.now().toString(36);
  const mkUser = async (role: string | null) => {
    const a = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`gl-${tag}-${role}`]))!.id;
    const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status${role ? ', platform_role' : ''}) VALUES ($1,$2,'x','owner','active'${role ? ', $3' : ''}) RETURNING id`,
      role ? [a, `gl-${tag}-${role}@volt.test`, role] : [a, `gl-${tag}-client@volt.test`]))!.id;
    return signAccess({ sub: u, account_id: a, role: 'owner' });
  };
  const admin = await mkUser('saas_admin'), viewer = await mkUser('read_only'), client = await mkUser(null);

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = async (method: string, path: string, body?: any, tok: string | null = admin, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, h: r.headers, j: await r.json().catch(() => null) as any };
  };
  const P = '/api/platform/global-lists';
  try {
    // ---- seed content
    const tzSample = BUILT_IN.find((b) => b.key === 'timezones')!;
    const cast = (await call('GET', '/api/global-lists/timezones/items/central-america-standard-time', undefined, null)).j;
    check('timezone seed matches the sample shape exactly', cast?.value, {
      en_US: 'Central America Standard Time (-6)', abbr: 'CAST', offset: '-6', isdst: false, text: '(UTC-06:00) Central America',
      utc: ['America/Belize', 'America/Costa_Rica', 'America/El_Salvador', 'America/Guatemala', 'America/Managua', 'America/Tegucigalpa', 'Etc/GMT+6', 'Pacific/Galapagos'],
    });
    const seedErrors = [];
    for (const b of BUILT_IN) for (const it of (await b.seed()).ITEMS) { const e = checkValue(b, it.value).errors; if (e.length) seedErrors.push(`${b.key}/${it.code}: ${e}`); }
    check('every shipped item passes its own list definition', seedErrors, []);
    void tzSample;

    // ---- public read
    const lists = await call('GET', '/api/global-lists', undefined, null);
    check('lists are readable without signing in', [lists.s, lists.j.items.map((l: any) => l.key).sort().join(',')], [200, 'countries,timezones']);
    const all = await call('GET', '/api/global-lists/countries', undefined, null);
    check('all countries in one call, in name order', [all.s, all.j.items.length, all.j.items[0].value.name], [200, 250, 'Afghanistan']);
    const au = all.j.items.find((i: any) => i.code === 'AU');
    check('a country carries both names, both codes and its calling code', au.value, { name: 'Australia', officialName: 'Commonwealth of Australia', alpha2: 'AU', alpha3: 'AUS', numeric: '036', phoneCode: '+61' });
    check('the list says what its fields are', all.j.fields.map((f: any) => f.key), ['name', 'officialName', 'alpha2', 'alpha3', 'numeric', 'phoneCode']);
    check('filter on a list field by name', (await call('GET', '/api/global-lists/countries?alpha3=NZL', undefined, null)).j.items.map((i: any) => i.code), ['NZ']);
    check('look several up by code', (await call('GET', '/api/global-lists/countries?code=AU,NZ,PH&sort=code', undefined, null)).j.items.map((i: any) => i.code), ['AU', 'NZ', 'PH']);
    check('search across fields', (await call('GET', '/api/global-lists/countries?q=commonwealth%20australia', undefined, null)).j.items.map((i: any) => i.code), ['AU']);
    check('search a timezone by an IANA zone it covers', (await call('GET', '/api/global-lists/timezones?q=Brisbane', undefined, null)).j.items.map((i: any) => i.value.abbr), ['EAST']);
    const east = await call('GET', '/api/global-lists/timezones?value.offset[gte]=9.5&sort=-value.offset&limit=3', undefined, null);
    check('offset filters and sorts as a number', east.j.items.map((i: any) => Number(i.value.offset)).every((n: number, k: number, a: number[]) => n >= 9.5 && (k === 0 || a[k - 1] >= n)), true);
    check('the shorthand works where the name is free', (await call('GET', '/api/global-lists/countries?sort=-alpha3&limit=1', undefined, null)).j.items[0].code, 'ZW');
    check('offset stays the paging offset', (await call('GET', '/api/global-lists/countries?offset=10&limit=1', undefined, null)).j.items[0].value.name, all.j.items[10].value.name);
    check('paging follows the list standard', [east.j.items.length, /rel="next"/.test(east.h.get('link') ?? '')], [3, true]);
    check('an unknown filter is a 400 that names the fields', (await call('GET', '/api/global-lists/countries?colour=red', undefined, null)).s, 400);
    const one1 = await call('GET', '/api/global-lists/countries/items/au', undefined, null);
    check('one item by code, any case', [one1.s, one1.j.code, one1.j.label], [200, 'AU', 'Australia']);
    check('a missing item is a 404', (await call('GET', '/api/global-lists/countries/items/QQ', undefined, null)).s, 404);
    check('a missing list is a 404', (await call('GET', '/api/global-lists/planets', undefined, null)).s, 404);

    // ---- caching
    const etag = all.h.get('etag')!;
    check('public reads are cacheable at the CDN', /public/.test(all.h.get('cache-control') ?? '') && !!etag, true);
    check('the same ETag answers 304', (await call('GET', '/api/global-lists/countries', undefined, null, { 'if-none-match': etag })).s, 304);

    // ---- who may change things
    check('a client user cannot reach the admin API', (await call('GET', P, undefined, client)).s, 403);
    check('read-only staff can read the admin API', (await call('GET', P, undefined, viewer)).s, 200);
    check('read-only staff cannot add an item', (await call('POST', `${P}/countries/items`, { value: {} }, viewer)).s, 403);

    // ---- items
    const bad = await call('POST', `${P}/countries/items`, { value: { name: 'Atlantis', officialName: 'Kingdom of Atlantis', alpha2: 'ATL', alpha3: 'ATL', colour: 'blue' } });
    check('an item that breaks the definition says every problem', [bad.s, bad.j.details.errors.length >= 2], [400, true]);
    const dup = await call('POST', `${P}/countries/items`, { value: { name: 'Fake', officialName: 'Fake', alpha2: 'QQ', alpha3: 'AUS' } });
    check('a unique field already used: 409', [dup.s, /alpha3: "AUS" is already used by AU/.test(dup.j.error)], [409, true]);
    const zz = await call('POST', `${P}/countries/items`, { value: { name: 'Testland', officialName: 'Republic of Testland', alpha2: 'zz', alpha3: 'zzt', fr_FR: 'Pays de test' } });
    check('add a country: the code follows alpha-2, upper-cased', [zz.s, zz.j.code, zz.j.value.alpha3], [201, 'ZZ', 'ZZT']);
    check('a translation is used for ?locale', (await call('GET', '/api/global-lists/countries/items/ZZ?locale=fr_FR', undefined, null)).j.label, 'Pays de test');
    check('a change shows on the read API at once (new ETag)', (await call('GET', '/api/global-lists/countries', undefined, null, { 'if-none-match': etag })).s, 200);
    check('a built-in list never hard-deletes', (await call('DELETE', `${P}/countries/items/ZZ`)).s, 409);
    const ret = await call('PATCH', `${P}/countries/items/ZZ`, { active: false });
    check('retire instead', [ret.s, ret.j.active], [200, false]);
    check('a retired item is no longer offered', (await call('GET', '/api/global-lists/countries?code=ZZ', undefined, null)).j.items.length, 0);
    check('but still resolves by code', (await call('GET', '/api/global-lists/countries/items/ZZ', undefined, null)).j.active, false);
    const d1 = await call('PATCH', `${P}/timezones/items/central-america-standard-time`, { isDefault: true });
    const d2 = await call('PATCH', `${P}/timezones/items/gmt-standard-time`, { isDefault: true });
    const defaults = await query<any>(`SELECT i.code FROM global_list_items i JOIN global_lists l ON l.id = i.list_id WHERE l.key = 'timezones' AND i.is_default`);
    check('one default per list: setting a new one moves it', [d1.s, d2.s, defaults.map((r) => r.code)], [200, 200, ['gmt-standard-time']]);
    check('timezone codes are fixed once made', (await call('PATCH', `${P}/timezones/items/gmt-standard-time`, { code: 'london' })).s, 400);

    // ---- definitions
    check('a built-in field cannot be removed', (await call('PATCH', `${P}/countries`, { fields: all.j.fields.filter((f: any) => f.key !== 'phoneCode') })).s, 400);
    const needCap = await call('PATCH', `${P}/countries`, { fields: [...all.j.fields, { key: 'capital', label: 'Capital', type: 'string', required: true }] });
    check('a new required field is refused while items lack it', [needCap.s, needCap.j.details.errors.length > 0], [409, true]);
    const addCap = await call('PATCH', `${P}/countries`, { fields: [...all.j.fields, { key: 'capital', label: 'Capital', type: 'string' }] });
    check('an optional field can be added', [addCap.s, addCap.j.fields.length], [200, 7]);

    // ---- a custom list, import, order
    const mk = await call('POST', P, { key: `currencies-${tag}`, name: 'Currencies', visibility: 'tenant', labelField: 'name', codeField: 'iso',
      fields: [{ key: 'iso', label: 'ISO 4217', type: 'string', required: true, unique: true, pattern: '^[A-Z]{3}$', case: 'upper' }, { key: 'name', label: 'Name', type: 'string', required: true }, { key: 'decimals', label: 'Decimals', type: 'number' }] });
    check('create a custom list', mk.s, 201);
    const key = `currencies-${tag}`;
    const imp1 = await call('POST', `${P}/${key}/import`, { items: [{ value: { iso: 'aud', name: 'Australian dollar', decimals: 2 } }, { value: { iso: 'NZD', name: 'New Zealand dollar', decimals: 2 } }, { value: { iso: 'JPY', name: 'Yen', decimals: 0 } }] });
    check('import adds items', [imp1.s, imp1.j.created], [200, 3]);
    const impBad = await call('POST', `${P}/${key}/import`, { items: [{ value: { iso: 'EUR', name: 'Euro' } }, { value: { iso: 'EURO', name: 'Bad' } }] });
    const eur = await one<any>(`SELECT 1 FROM global_list_items i JOIN global_lists l ON l.id = i.list_id WHERE l.key = $1 AND i.code = 'EUR'`, [key]);
    check('an import with one bad row writes nothing', [impBad.s, !!eur], [400, false]);
    const dry = await call('POST', `${P}/${key}/import`, { mode: 'replace', dryRun: true, items: [{ value: { iso: 'AUD', name: 'Australian dollar', decimals: 2 } }, { value: { iso: 'USD', name: 'US dollar', decimals: 2 } }] });
    check('a dry run reports without writing', [dry.j.created, dry.j.retired, dry.j.dryRun, (await call('GET', `/api/global-lists/${key}`, undefined, client)).j.items.length], [1, 2, true, 3]);
    check('a tenant list needs a session', (await call('GET', `/api/global-lists/${key}`, undefined, null)).s, 401);
    const rep = await call('POST', `${P}/${key}/import`, { mode: 'replace', items: [{ value: { iso: 'AUD', name: 'Australian dollar', decimals: 2 } }, { value: { iso: 'USD', name: 'US dollar', decimals: 2 } }] });
    check('replace retires what the file no longer has (never deletes)', [rep.j.created, rep.j.unchanged, rep.j.retired], [1, 1, 2]);
    await call('PUT', `${P}/${key}/order`, { codes: ['USD'] });
    check('order: the named codes come first', (await call('GET', `/api/global-lists/${key}`, undefined, client)).j.items.map((i: any) => i.code), ['USD', 'AUD']);
    check('a custom list can hard-delete', (await call('DELETE', `${P}/${key}/items/JPY`)).s, 204);
    const exp = await call('GET', `${P}/${key}/export`);
    check('export holds the definition and every item', [exp.j.list.codeField, exp.j.items.length], ['iso', 3]);
    check('a platform-only list is not on the read API', [(await call('PATCH', `${P}/${key}`, { visibility: 'platform' })).s, (await call('GET', `/api/global-lists/${key}`, undefined, client)).s], [200, 404]);
    check('a built-in list cannot be archived', (await call('PATCH', `${P}/countries`, { archived: true })).s, 400);

    // ---- restore shipped values
    await call('PATCH', `${P}/countries/items/AU`, { value: { ...au.value, name: 'Oz' } });
    const r1 = await call('POST', `${P}/countries/restore`, {});
    check('restore without overwrite keeps edits', [r1.j.reset, (await call('GET', '/api/global-lists/countries/items/AU', undefined, null)).j.label], [0, 'Oz']);
    const r2 = await call('POST', `${P}/countries/restore`, { overwrite: true });
    check('restore with overwrite puts shipped values back', [r2.j.reset >= 1, (await call('GET', '/api/global-lists/countries/items/AU', undefined, null)).j.label], [true, 'Australia']);
  } catch (e) {
    console.log('FAIL the run stopped:', e); fail++;
  } finally {
    // Leave the built-in lists as shipped for whoever runs next.
    await query(`DELETE FROM global_lists WHERE key LIKE 'currencies-%'`);
    await query(`DELETE FROM global_list_items WHERE code = 'ZZ'`);
    await query(`UPDATE global_list_items SET is_default = false WHERE is_default`);
    await query(`UPDATE global_lists SET fields = (SELECT jsonb_agg(f) FROM jsonb_array_elements(fields) f WHERE f->>'key' <> 'capital') WHERE key = 'countries'`);
    srv.close();
    console.log(`\nglobal-lists: ${pass} passed, ${fail} failed`);
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(1); });
