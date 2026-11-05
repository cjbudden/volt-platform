// ============================================================================
//  RIGHTS PROFILES: the cap nothing overrides (build queue R1,
//  services/rightsProfiles.ts, modules/rights.ts, migration 0133).
//
//  Pure: effective rights (profile plus a title's narrowing), the evaluation
//  by territory, app, use and window, the access-type mapping, and that a
//  narrowing can never widen. Then over real HTTP against a database: the
//  built-ins and the account default, the insert trigger and the backfill,
//  profile CRUD and its refusals, a title's narrowing, bulk assignment, the
//  agreement (private, Manage to read, audited), the play gate refusing
//  outside the rights (451, layer rights) and refusing an access type the
//  rights do not allow, publishing refused or clamped by the rights, the FAST
//  library leaving out what the rights keep off FAST, watchfolder and upload
//  inserts naming a profile, and another account seeing none of it.
//    DATABASE_URL=... npx tsx test/rights-profiles.check.ts
// ============================================================================
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};

(async () => {
  const R = await import('../src/services/rightsProfiles');

  // ---------------------------------------------------------------- pure
  const base: any = {
    id: 'p1', account_id: 'a', name: 'Pacific', builtin: null, provider: null, takedown_contact: null, agreement_ref: null,
    territory_mode: 'allow', territories: ['AU', 'NZ', 'FJ'], app_mode: 'allow', app_types: ['web', 'mobile'], app_ids: ['app-own'],
    uses: ['on_demand', 'fast', 'clips'], access_types: ['subscription', 'ppv'],
    window_kind: 'fixed', window_from: '2026-01-01T00:00:00Z', window_until: '2027-01-01T00:00:00Z',
    relative_count: null, relative_unit: null, relative_from: null, warn_days: 30, agreement: null,
  };
  const eff = R.effectiveRights(base, {});
  const at = new Date('2026-06-01T00:00:00Z');
  const ev = (o: any) => R.evaluateRights(eff, { use: 'on_demand', at, ...o });
  check('allowed in a listed territory on an allowed app type', ev({ country: 'AU', appType: 'web' }).allowed, true);
  check('refused outside the territories', ev({ country: 'US', appType: 'web' }).code, 'territory');
  check('refused with no country under an allow-list', ev({ country: null, appType: 'web' }).code, 'territory');
  check('refused on an app type the rights leave out', ev({ country: 'AU', appType: 'smart_tv' }).code, 'app');
  check('a named app is allowed whatever its type', ev({ country: 'AU', appType: 'smart_tv', appId: 'app-own' }).allowed, true);
  check('refused for a use the rights leave out', R.evaluateRights(eff, { use: 'social', country: 'AU', appType: 'web', at }).code, 'use');
  check('refused before the window', ev({ country: 'AU', appType: 'web', at: new Date('2025-12-31T00:00:00Z') }).code, 'window');
  check('refused after the window', ev({ country: 'AU', appType: 'web', at: new Date('2027-01-02T00:00:00Z') }).code, 'window');
  const blockP = { ...base, territory_mode: 'block', territories: ['US'], app_mode: 'block', app_types: ['partner'], app_ids: [] };
  const be = R.effectiveRights(blockP, {});
  check('block mode: everywhere but the list', [R.evaluateRights(be, { use: 'on_demand', country: 'GB', at, appType: 'web' }).allowed, R.evaluateRights(be, { use: 'on_demand', country: 'US', at, appType: 'web' }).code], [true, 'territory']);
  check('block mode apps: a blocked type is refused', R.evaluateRights(be, { use: 'on_demand', country: 'GB', at, appType: 'partner' }).code, 'app');
  const rel = R.effectiveRights({ ...base, window_kind: 'relative', relative_count: 12, relative_unit: 'month', relative_from: 'first_air' },
    { created_at: '2026-02-01T00:00:00Z', first_aired_at: '2026-03-15T00:00:00Z' });
  check('relative window runs from first air', [rel.from?.toISOString(), rel.until?.toISOString()], ['2026-03-15T00:00:00.000Z', '2027-03-15T00:00:00.000Z']);
  const relIngest = R.effectiveRights({ ...base, window_kind: 'relative', relative_count: 30, relative_unit: 'day', relative_from: 'ingest' }, { created_at: '2026-02-01T00:00:00Z' });
  check('or from ingest', relIngest.until?.toISOString(), '2026-03-03T00:00:00.000Z');
  const nar = R.effectiveRights(base, { rights_narrow: { territories: ['AU', 'NZ'], appTypes: ['web'], uses: ['on_demand'], until: '2026-09-01T00:00:00Z' } });
  check('narrowing: territories, app types, uses and end all shrink', [nar.territories, nar.appTypes, nar.uses, nar.until?.toISOString(), nar.narrowed],
    [['AU', 'NZ'], ['web'], ['on_demand'], '2026-09-01T00:00:00.000Z', true]);
  check('narrowing never adds: a narrowed territory list keeps only what the profile allows',
    R.effectiveRights(base, { rights_narrow: { territories: ['AU', 'US'] } }).territories, ['AU']);
  check('narrowed apps drop the profile\'s named apps', R.effectiveRights(base, { rights_narrow: { appTypes: ['web'] } }).appIds, ['app-own']);
  check('wider than the profile is refused, with each reason', R.wideningProblems(base, { territories: ['US'], appTypes: ['smart_tv'], uses: ['social'], until: '2028-01-01T00:00:00Z' }).length, 4);
  check('inside the profile is fine', R.wideningProblems(base, { territories: ['AU'], appTypes: ['web'], uses: ['fast'], until: '2026-12-01T00:00:00Z' }), []);
  check('app types of registered apps', ['web', 'ios', 'android', 'tv', 'roku', 'server'].map((t) => R.appTypeOf(t)),
    ['web', 'mobile', 'mobile', 'smart_tv', 'smart_tv', 'partner']);
  check('an embed or venue surface wins over the type', [R.appTypeOf('web', 'embed'), R.appTypeOf('tv', 'venue')], ['embed', 'venue']);
  check('access kinds: free rule, members rule, period and pay-once terms, simple paid',
    [R.accessKindsFor('free', undefined), R.accessKindsFor('members', undefined), R.accessKindsFor('entitlement', undefined, [{ kind: 'period' }]),
     R.accessKindsFor('entitlement', undefined, [{ kind: 'published_dates' }]), R.accessKindsFor(undefined, 'paid')],
    [['free'], ['members'], ['subscription'], ['ppv'], ['ppv', 'subscription']]);
  check('no profile is No restrictions', [R.effectiveRights(null, {}).uses.length, R.effectiveRights(null, {}).territoryMode], [6, 'worldwide']);

  // ---------------------------------------------------------------- database
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { requirementFor } = await import('../src/auth/roles');
  const tag = Date.now().toString(36);
  const mk = async (n: string) => {
    const a = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`rt-${n}-${tag}`]))!.id;
    const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `rt-${n}-${tag}@volt.test`]))!.id;
    const g = (await one<any>(`INSERT INTO groups(account_id, name, max_channels) VALUES ($1,'G',50) RETURNING id`, [a]))!.id;
    const ch = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'C') RETURNING id`, [g]))!.id;
    return { a, u, ch, tok: signAccess({ sub: u, account_id: a, role: 'owner' }) };
  };
  const me = await mk('me'), them = await mk('them');
  const asset = async (o: any, title: string, own: 'channel' | 'account' = 'account') => (await one<any>(
    own === 'channel'
      ? `INSERT INTO vod_assets(channel_id, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms) VALUES ($1,'clip',$2,'k',0,60000,60000) RETURNING id`
      : `INSERT INTO vod_assets(account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms) VALUES ($1,'upload','clip',$2,'k',0,60000,60000) RETURNING id`,
    [own === 'channel' ? o.ch : o.a, title]))!.id;
  const live = async (id: string, settings: any = { targets: [{ kind: 'portal' }], access: 'free' }) => {
    await query(`UPDATE vod_assets SET availability_state = 'available', availability = $2::jsonb, published = true, available_from = now() - interval '1 day' WHERE id = $1`, [id, JSON.stringify(settings)]);
    (await import('../src/scale/cache')).invalidateTag(`asset:${id}`);
  };

  const srv = createServer().listen(0);
  const base2 = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = async (method: string, path: string, body?: any, tok = me.tok, raw?: { buf: Buffer; type: string }) => {
    const r = await fetch(base2 + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': raw ? raw.type : 'application/json' },
      body: raw ? raw.buf : body ? JSON.stringify(body) : undefined });
    const txt = await r.text();
    let j: any = null; try { j = JSON.parse(txt); } catch { j = txt; }
    return { s: r.status, j, h: r.headers };
  };
  try {
    // ---- built-ins and the default
    const st = (await call('GET', '/api/rights/settings')).j;
    check('settings: both built-ins exist, and No restrictions is the default', [!!st.builtins.open, !!st.builtins.closed, st.defaultProfileId === st.builtins.open], [true, true, true]);
    const list0 = (await call('GET', '/api/rights/profiles')).j;
    check('the list shows the two built-ins', list0.map((p: any) => [p.name, p.builtin, p.isDefault]).sort(), [['All restricted', 'closed', false], ['No restrictions', 'open', true]]);
    const closed = list0.find((p: any) => p.builtin === 'closed');
    check('All restricted allows no use and no access', [closed.uses, closed.accessTypes], [[], []]);
    check('a built-in cannot be changed', (await call('PUT', `/api/rights/profiles/${st.builtins.open}`, { name: 'x' })).s, 409);
    check('or deleted', (await call('DELETE', `/api/rights/profiles/${st.builtins.closed}`)).s, 409);

    // ---- the insert trigger: every asset gets a profile
    const a1 = await asset(me, 'Upload one');
    const a2 = await asset(me, 'From a channel', 'channel');
    const rows = await query<any>(`SELECT id, rights_profile_id, rights_set_by FROM vod_assets WHERE id = ANY($1::uuid[]) ORDER BY title DESC`, [[a1, a2]]);
    check('an insert that names no profile gets the account default (account-owned and channel-owned)', rows.map((r) => [r.rights_profile_id === st.builtins.open, r.rights_set_by]),
      [[true, 'account default'], [true, 'account default']]);

    // ---- the backfill, as the migration runs it
    await query(`UPDATE vod_assets SET rights_profile_id = NULL, rights_set_by = NULL WHERE id = $1`, [a2]);
    const mig = readFileSync(join(__dirname, '..', 'migrations', '0133_rights_profiles.sql'), 'utf8');
    const backfill = mig.slice(mig.indexOf('UPDATE vod_assets v SET rights_profile_id'), mig.indexOf(';', mig.indexOf('UPDATE vod_assets v SET rights_profile_id')) + 1);
    await query(backfill);
    const bf = await one<any>(`SELECT rights_profile_id, rights_set_by FROM vod_assets WHERE id = $1`, [a2]);
    check('the backfill gives existing assets No restrictions', [bf.rights_profile_id === st.builtins.open, bf.rights_set_by], [true, 'backfill']);

    // ---- apps and keys for the play gate
    const mkApp = async (type: string, surface?: string) => { const r = (await call('POST', '/api/apps', { name: `${type} app`, type, surface })).j; return { id: r.id, key: r.publishableKey.key, surface: r.surface }; };
    const web = await mkApp('web'), tv = await mkApp('tv'), embed = await mkApp('web', 'embed');
    check('an app can be registered as an embed player', embed.surface, 'embed');
    const gate = async (assetId: string, appKey: string, geo?: string) => {
      const r = await fetch(`${base2}/api/availability`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appKey, assetId, geo }) });
      return { s: r.status, j: await r.json().catch(() => null) as any };
    };

    // ---- profile CRUD
    const pac = {
      name: 'Northstar Sports Pacific', provider: 'Northstar Sports', takedownContact: 'rights@northstar.example',
      territoryMode: 'allow', territories: ['au', 'NZ'], appMode: 'allow', appTypes: ['web', 'mobile'], appIds: [],
      uses: ['on_demand', 'clips'], accessTypes: ['free', 'subscription'], window: { kind: 'open' },
    };
    const bad1 = await call('POST', '/api/rights/profiles', { ...pac, territories: [] });
    check('an allow-list with no territories is refused', bad1.s, 400);
    check('an app of another account is refused', (await call('POST', '/api/rights/profiles', { ...pac, appIds: [web.id] }, them.tok)).s, 400);
    const p = (await call('POST', '/api/rights/profiles', pac));
    check('create a provider profile', [p.s, p.j.territories, p.j.assetCount], [201, ['AU', 'NZ'], 0]);
    check('the same name twice: 409', (await call('POST', '/api/rights/profiles', { ...pac, name: 'northstar sports pacific' })).s, 409);
    check('another account cannot read it', (await call('GET', `/api/rights/profiles/${p.j.id}`, undefined, them.tok)).s, 404);
    check('another account sees only its own built-ins', (await call('GET', '/api/rights/profiles', undefined, them.tok)).j.length, 2);

    // ---- the account default moves new assets
    check('set the default to the provider profile', (await call('PUT', '/api/rights/settings', { defaultProfileId: p.j.id })).j.defaultProfileId, p.j.id);
    const a3 = await asset(me, 'After the default changed');
    check('a new asset gets the new default', (await one<any>(`SELECT rights_profile_id FROM vod_assets WHERE id = $1`, [a3]))!.rights_profile_id, p.j.id);
    check('the default cannot be deleted', (await call('DELETE', `/api/rights/profiles/${p.j.id}`)).s, 409);
    check('another account cannot use it as a default', (await call('PUT', '/api/rights/settings', { defaultProfileId: p.j.id }, them.tok)).s, 404);
    await call('PUT', '/api/rights/settings', { defaultProfileId: st.builtins.open });

    // ---- the play gate
    await live(a3);
    let g = await gate(a3, web.key, 'AU');
    check('gate: inside the rights on a web app in AU plays', [g.s, g.j?.available], [200, true]);
    g = await gate(a3, web.key, 'US');
    check('gate: outside the territories is a 451', [g.s, g.j?.mode], [451, 'blocked']);
    g = await gate(a3, tv.key, 'AU');
    check('gate: an app type the rights leave out is a 451', g.s, 451);
    g = await gate(a3, embed.key, 'AU');
    check('gate: an embed player is refused when the rights allow web and mobile only', g.s, 451);
    const tvAsVenue = await call('PUT', `/api/apps/${tv.id}`, { surface: 'venue' });
    check('an app can be changed to venue screens', tvAsVenue.j?.surface, 'venue');
    (await import('../src/scale/cache')).invalidateTag(`app:${tv.id}`);
    await call('PUT', `/api/rights/profiles/${p.j.id}`, { ...pac, appTypes: ['web', 'mobile', 'venue'] });
    check('gate: the same app now plays as a venue screen the rights allow', (await gate(a3, tv.key, 'AU')).s, 200);
    await call('PUT', `/api/rights/profiles/${p.j.id}`, pac);
    g = await gate(a3, web.key);
    check('gate: no country under an allow-list is refused', g.s, 451);
    // The rights no longer allow free access: the free policy cannot let anyone in.
    await call('PUT', `/api/rights/profiles/${p.j.id}`, { ...pac, accessTypes: ['subscription'] });
    g = await gate(a3, web.key, 'AU');
    check('gate: a free policy under subscription-only rights is refused at once (cache dropped on save)', [g.s, /kind of access/.test(g.j?.reason ?? '')], [451, true]);
    // A paywall offers only what the rights allow to be sold.
    await live(a3, { targets: [{ kind: 'portal' }], accessRules: [{ id: 'r1', for: { scopes: ['this'] }, if: { geo: 'in', countries: ['WORLD'] },
      then: { access: 'premium', terms: [{ productKey: 'month', kind: 'period', count: 1, unit: 'month', priceCents: 999, currency: 'AUD' }, { productKey: 'once', kind: 'published_dates', priceCents: 299, currency: 'AUD' }] } }] });
    await query(`UPDATE vod_assets SET availability_sources = '{"accessRules":"asset"}'::jsonb WHERE id = $1`, [a3]);
    (await import('../src/scale/cache')).invalidateTag(`asset:${a3}`);
    g = await gate(a3, web.key, 'AU');
    check('gate: the paywall offers the subscription only, not the pay-once the rights rule out', [g.s, (g.j?.products ?? []).map((t: any) => t.productKey)], [402, ['month']]);
    await call('PUT', `/api/rights/profiles/${p.j.id}`, pac);
    await live(a3);

    // ---- a title's narrowing
    const wide = await call('PUT', `/api/rights/assets/${a3}`, { profileId: p.j.id, narrow: { territories: ['AU', 'US'], uses: ['social'] } });
    check('narrowing wider than the profile: 422 with the reasons', [wide.s, wide.j?.problems?.length], [422, 2]);
    const nr = await call('PUT', `/api/rights/assets/${a3}`, { profileId: p.j.id, narrow: { territories: ['AU'] } });
    check('narrowing inside the profile is kept', [nr.s, nr.j.effective.territories, nr.j.effective.narrowed], [200, ['AU'], true]);
    g = await gate(a3, web.key, 'NZ');
    check('gate: a territory the title dropped is refused at once', g.s, 451);
    check('rights check (View as): NZ refused for territory', (await call('POST', '/api/rights/check', { assetId: a3, country: 'NZ', appId: web.id })).j.code, 'territory');
    check('rights check: AU on the web app allowed', (await call('POST', '/api/rights/check', { assetId: a3, country: 'AU', appId: web.id })).j.allowed, true);
    check('another account cannot read an asset\'s rights', (await call('GET', `/api/rights/assets/${a3}`, undefined, them.tok)).s, 404);
    check('or assign its own asset to a foreign profile', (await call('PUT', `/api/rights/assets/${await asset(them, 'theirs')}`, { profileId: p.j.id }, them.tok)).s, 404);

    // ---- publishing
    const a4 = await asset(me, 'Held back');
    await call('PUT', `/api/rights/assets/${a4}`, { profileId: st.builtins.closed });
    const pub = await call('POST', `/api/vod/${a4}/publish`, {});
    check('publishing is refused under All restricted, with the reason', [pub.s, /do not allow this asset on demand/.test(JSON.stringify(pub.j))], [409, true]);
    const until = new Date(Date.now() + 10 * 86400_000).toISOString();
    const short = (await call('POST', '/api/rights/profiles', { ...pac, name: 'Short window', territoryMode: 'worldwide', territories: [], appMode: 'all', appTypes: [], window: { kind: 'fixed', until } })).j;
    await call('PUT', `/api/rights/assets/${a4}`, { profileId: short.id });
    const pub2 = await call('POST', `/api/vod/${a4}/publish`, {});
    const after = await one<any>(`SELECT available_until FROM vod_assets WHERE id = $1`, [a4]);
    check('publishing clamps the window to the rights window', [pub2.s, new Date(after.available_until).toISOString()], [201, until]);

    // ---- FAST
    const { libraryFor } = await import('../src/services/fast/store');
    const fastOk = await asset(me, 'Fast ok');
    await query(`UPDATE vod_assets SET rights_profile_id = $2 WHERE id = $1`, [a3, p.j.id]);   // pac: no 'fast'
    const lib = await libraryFor(me.a);
    check('FAST library: an asset whose rights leave out FAST is not there', [lib.has(fastOk), lib.has(a3)], [true, false]);

    // ---- bulk, counts, delete
    const theirs = await asset(them, 'Theirs too');
    const bulk = (await call('POST', '/api/rights/assign', { profileId: p.j.id, assetIds: [a1, a2, theirs] })).j;
    check('bulk: own assets assigned, another account\'s skipped', [bulk.assigned, bulk.skipped], [2, 1]);
    check('their asset kept its own profile', (await one<any>(`SELECT rights_profile_id = $2 AS same FROM vod_assets WHERE id = $1`, [theirs, p.j.id]))!.same, false);
    const detail = (await call('GET', `/api/rights/profiles/${p.j.id}`)).j;
    check('detail: asset count and how they got it', [detail.assetCount, detail.setBy.some((x: any) => /^bulk by/.test(x.how))], [3, true]);
    check('a profile in use cannot be deleted', (await call('DELETE', `/api/rights/profiles/${p.j.id}`)).s, 409);
    const spare = (await call('POST', '/api/rights/profiles', { ...pac, name: 'Unused' })).j;
    check('an unused one can', (await call('DELETE', `/api/rights/profiles/${spare.id}`)).s, 204);

    // ---- the agreement
    const pdf = Buffer.from('%PDF-1.4 agreement text');
    const up = await call('PUT', `/api/rights/agreements/${p.j.id}?name=NS-2026-014.pdf`, undefined, me.tok, { buf: pdf, type: 'application/pdf' });
    check('upload the agreement', [up.s, up.j.name, up.j.size], [200, 'NS-2026-014.pdf', pdf.length]);
    const dl = await fetch(`${base2}/api/rights/agreements/${p.j.id}`, { headers: { authorization: `Bearer ${me.tok}` } });
    check('download it back, private', [dl.status, Buffer.from(await dl.arrayBuffer()).equals(pdf), dl.headers.get('cache-control')], [200, true, 'private, no-store']);
    const aud = await one<any>(`SELECT count(*)::int AS n FROM audit_log WHERE entity_type = 'rights_agreement' AND entity_id = $1`, [p.j.id]);
    check('every read is in the audit log', aud.n, 1);
    check('another account cannot read it', (await fetch(`${base2}/api/rights/agreements/${p.j.id}`, { headers: { authorization: `Bearer ${them.tok}` } })).status, 404);
    const reqAg = await requirementFor('GET', `/api/rights/agreements/${p.j.id}`);
    const reqList = await requirementFor('GET', '/api/rights/profiles');
    const reqEdit = await requirementFor('PUT', `/api/rights/profiles/${p.j.id}`);
    const reqCheck = await requirementFor('POST', '/api/rights/check');
    check('permissions: reading an agreement is Rights: manage', [reqAg?.features, reqAg?.level], [['rights'], 'manage']);
    check('listing profiles is open (pickers), editing is Rights: manage, the check is view', [reqList?.level, reqEdit?.level, reqCheck?.level], ['none', 'manage', 'view']);

    // ---- other ways in name a profile
    const { pgVideoIngestStore } = await import('../src/services/watchfolder/videoIngest');
    const wf = await pgVideoIngestStore.createVodAsset({ accountId: me.a, title: 'From a folder', sourceKey: '/x.mp4', sourceBytes: 1, ladderGroupId: null, sourceKind: 'watchfolder', rightsProfileId: p.j.id });
    const wfRow = await one<any>(`SELECT rights_profile_id, rights_set_by FROM vod_assets WHERE id = $1`, [wf.id]);
    check('a watchfolder naming a profile gives it', [wfRow.rights_profile_id === p.j.id, wfRow.rights_set_by], [true, 'watchfolder']);
    const wf2 = await pgVideoIngestStore.createVodAsset({ accountId: them.a, title: 'Foreign profile', sourceKey: '/y.mp4', sourceBytes: 1, ladderGroupId: null, sourceKind: 'watchfolder', rightsProfileId: p.j.id });
    const wf2Row = await one<any>(`SELECT p.builtin FROM vod_assets v JOIN rights_profiles p ON p.id = v.rights_profile_id WHERE v.id = $1`, [wf2.id]);
    check('a profile from another account is ignored: the default applies', wf2Row.builtin, 'open');
    const upl = await call('POST', '/api/uploads', { purpose: 'vod', name: 'Upload with rights', filename: 'u.mp4', totalBytes: 10, rightsProfileId: p.j.id });
    const uRow = await one<any>(`SELECT v.rights_profile_id, v.rights_set_by FROM vod_assets v WHERE v.title = 'Upload with rights' AND v.account_id = $1`, [me.a]);
    check('an upload naming a profile gives it', [upl.s < 300, uRow?.rights_profile_id === p.j.id, uRow?.rights_set_by], [true, true, 'chosen at upload']);
    const wfApi = await call('POST', '/api/watchfolders', { name: `wf-${tag}`, kind: 'local', config: { path: '/tmp' }, rightsProfileId: p.j.id });
    check('a watchfolder can be given a profile', [wfApi.s, wfApi.j?.rights_profile_id === p.j.id], [201, true]);
    check('but not another account\'s', (await call('POST', '/api/watchfolders', { name: `wf2-${tag}`, kind: 'local', config: { path: '/tmp' }, rightsProfileId: p.j.id }, them.tok)).s, 400);

    // ---- the gate's report counts a rights refusal as rights (Rights demand)
    const { classifyGate } = await import('../src/services/qoe/gateLog');
    check('a refusal by the rights layer is reported as rights', classifyGate(451, { mode: 'blocked' }, { rights: { allowed: false, layer: 'rights' } } as any).reason, 'rights');
  } catch (e: any) {
    console.log('FAIL threw: ' + (e?.stack ?? e)); fail++;
  } finally {
    srv.close();
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
