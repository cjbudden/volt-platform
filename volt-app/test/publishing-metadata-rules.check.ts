// ============================================================================
//  THE METADATA-RULE RUNG (build queue P3-3, services/publishingMetadataRules.ts,
//  services/publishingRules.ts, migration 0160, PUBLISHING_POLICIES.md).
//
//  Decided 11 Nov: account < content type < owner < metadata rule < asset.
//  Pure: the rung's place in the ladder (it beats the owner, the title's own
//  override beats it, a lock lower down still holds). Then over real HTTP
//  against a database: the migration; the fields a rule can use (collections
//  in, the fields a policy decides out); the FIRST matching rule applies, in
//  the order set, and a new order changes it; a disabled rule is passed over;
//  a match beats the channel the title came from; the title's override beats
//  the match; a field the account locked is refused on save and ignored at
//  resolve; the test box names the rule and which others match; conditions on
//  tags and collections; the dry run counts what a rule governs; published
//  titles take up a new rule, a metadata edit and a collection change through
//  the restamp sweep; removing a rule hands its titles on; validation,
//  another account's rules and titles out of reach; the audit entries.
//    DATABASE_URL=... npx tsx test/publishing-metadata-rules.check.ts
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const R = await import('../src/services/publishingRules');
  const M = await import('../src/services/publishingMetadataRules');

  // ---------------------------------------------------------------- pure: the rung's place
  check('the ladder order: owner, then metadata rule, then the title', R.RUNG_ORDER, ['baseline', 'account', 'schema', 'owner', 'metadata', 'asset']);
  const L = (own: any, meta: any, ast: any = {}, locks: { acc?: string[]; own?: string[] } = {}) => R.resolveLadder([
    { rung: 'account', settings: {}, lockedFields: locks.acc }, { rung: 'schema', settings: {} },
    { rung: 'owner', settings: own, lockedFields: locks.own }, { rung: 'metadata', id: 'r1', name: 'EPL', settings: meta }, { rung: 'asset', settings: ast }]);
  const au = { geo: { mode: 'allow', countries: ['AU', 'NZ'] } };
  const a1 = L({ geo: { mode: 'block', countries: ['US'] }, access: 'free' }, { ...au, access: 'paid' });
  check('a metadata rule beats the channel the title came from', [a1.settings.geo.countries, a1.sources.geo, a1.settings.access, a1.sources.access], [['AU', 'NZ'], 'metadata', 'paid', 'metadata']);
  const a2 = L({}, au, { geo: { mode: 'worldwide', countries: [] } });
  check('the title\'s own override beats the metadata rule', [a2.settings.geo.mode, a2.sources.geo], ['worldwide', 'asset']);
  const a3 = L({ access: 'free' }, { access: 'paid' }, {}, { own: ['access'] });
  check('a lock on the owner rung still holds over the metadata rule', [a3.settings.access, a3.sources.access, a3.ignored.map((i) => `${i.rung}:${i.field}:${i.lockedBy}`)], ['free', 'owner', ['metadata:access:owner']]);
  const a4 = L({}, { protection: { drm: true } }, {}, {});
  check('a section field set by the rule is attributed to it', [a4.settings.protection.drm, a4.fieldSources['protection.drm']], [true, 'metadata']);
  check('the rung carries the rule\'s name, for the title to show', a1.rungs.find((r) => r.rung === 'metadata')?.name, 'EPL');
  const lockedMeta = R.resolveLadder([{ rung: 'metadata', settings: { access: 'paid' }, lockedFields: ['access'] }, { rung: 'asset', settings: { access: 'free' } }]);
  check('a lock on a metadata rule binds the title', [lockedMeta.settings.access, lockedMeta.locks.access], ['paid', 'metadata']);
  const fields = [{ key: 'title', label: 'Title', type: 'text', sql: 'v.title', group: 'Asset' }] as any;
  const q = M.firstMatchSql('acct', [{ conditions: { match: 'all', conditions: [{ field: 'gone', op: 'is', value: 'x' }] } } as any, { conditions: { match: 'all', conditions: [{ field: 'title', op: 'is', value: 'x' }] } } as any], fields, null);
  check('a rule whose field has gone is passed over, never matched', [q.skipped, /THEN 1/.test(q.sql), /THEN 0/.test(q.sql)], [[0], true, false]);

  // ---------------------------------------------------------------- database
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const A = await import('../src/services/availability');
  const tag = Date.now().toString(36);
  const mk = async (n: string) => {
    const a = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`mr-${n}-${tag}`]))!.id;
    const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `mr-${n}-${tag}@volt.test`]))!.id;
    return { a, u, tok: signAccess({ sub: u, account_id: a, role: 'owner' }) };
  };
  const me = await mk('me'), them = await mk('them');
  const sport = (await one<any>(`INSERT INTO metadata_schemas(account_id, name, target_kind, fields) VALUES ($1,'Match','vod',$2::jsonb) RETURNING id`, [me.a, JSON.stringify([
    { key: 'competition', label: 'Competition', type: 'string' }])]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [me.a]))!.id;
  const grp = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [me.a, prof]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name, status) VALUES ($1,'Sport One','live') RETURNING id`, [grp]))!.id;
  const asset = async (a: string, title: string, meta: any, extra: { channel?: string } = {}) => (await one<any>(
    `INSERT INTO vod_assets(account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, schema_id, media_state, metadata, channel_id)
     VALUES ($1,$6,'clip',$2,'/clips/x/master.m3u8',0,60000,60000,$3,'ready',$4::jsonb,$5) RETURNING id`,
    [extra.channel ? null : a, title, a === me.a ? sport : null, JSON.stringify(meta), extra.channel ?? null, extra.channel ? 'recording' : 'upload']))!.id;
  const row = (id: string) => one<any>(`SELECT availability, availability_sources, availability_state, policy_stale_at FROM vod_assets WHERE id = $1`, [id]);

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = async (method: string, path: string, body?: any, tok = me.tok) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const txt = await r.text(); let j: any = null; try { j = JSON.parse(txt); } catch { j = txt; }
    return { s: r.status, j };
  };
  const until = async (fn: () => Promise<boolean>, ms = 10_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return Date.now() - t0; await sleep(50); } return -1; };
  const P = '/api/publishing-rules/metadata-rules';
  // Saves start a restamp in the background: let it finish before a check reads a mark.
  const settle = () => until(async () => !(await one<any>(`SELECT 1 FROM vod_assets WHERE account_id = $1 AND policy_stale_at IS NOT NULL LIMIT 1`, [me.a])));
  const resolve = async (id: string) => (await call('GET', `/api/publishing-rules/resolve?assetId=${id}`)).j;
  try {
    const tbl = await one<any>(`SELECT to_regclass('publishing_metadata_rules') AS t`);
    const trg = await query<any>(`SELECT tgname FROM pg_trigger WHERE tgname IN ('vod_assets_metadata_rule_mark', 'collection_items_metadata_rule_mark') ORDER BY tgname`);
    check('migration 0160: the table and its two triggers', [!!tbl?.t, trg.map((t) => t.tgname)], [true, ['collection_items_metadata_rule_mark', 'vod_assets_metadata_rule_mark']]);

    // The owner rung says worldwide but not the US; the account says free.
    await call('PUT', `/api/publishing-rules/owner/${ch}`, { settings: { geo: { mode: 'block', countries: ['US'] } } });
    const epl = await asset(me.a, 'Arsenal v Spurs', { competition: 'EPL', tags: ['derby'] }, { channel: ch });
    const eplUp = await asset(me.a, 'EPL highlights', { competition: 'EPL', tags: ['embargoed'] });
    const liga = await asset(me.a, 'Clasico', { competition: 'LaLiga', tags: ['embargoed'] });
    const plain = await asset(me.a, 'Training', { competition: 'Friendly' });
    const other = await asset(them.a, 'Their EPL', { competition: 'EPL' });
    // Published before any rule exists: the rules must reach them afterwards.
    for (const id of [epl, plain]) await A.publish(id, 'test');
    check('before any rule: the channel title is stamped with the owner\'s geo', (await row(epl)).availability.geo.countries, ['US']);

    // ---- the fields a rule can use
    const f = await call('GET', `${P}/fields`);
    const keys = f.j.fields.map((x: any) => x.key);
    check('fields: the content type\'s fields, tags, collections and the source', [f.s, keys.includes('meta:competition'), keys.includes('tags'), keys.includes('collection'), keys.includes('channel')], [200, true, true, true, true]);
    check('fields: not what a policy decides (availability, published, available from)', ['availability_state', 'published', 'available_from'].some((k) => keys.includes(k)), false);
    check('the channel choices are the account\'s own', f.j.fields.find((x: any) => x.key === 'channel').values.map((v: any) => v.label), ['Sport One']);

    // ---- validation
    check('a field rules cannot use is refused with where', [(await call('POST', P, { name: 'X', conditions: { match: 'all', conditions: [{ field: 'nope', op: 'is', value: 'a' }] } })).s], [400]);
    check('a rule needs a name', (await call('POST', P, { name: '', conditions: { match: 'all', conditions: [{ field: 'title', op: 'is', value: 'a' }] } })).s, 422);
    check('a policy that is not a policy is refused', (await call('POST', P, { name: 'X', conditions: { match: 'all', conditions: [{ field: 'title', op: 'is', value: 'a' }] }, settings: { geo: 'AU' } })).s, 422);

    // ---- two rules: EPL first, Embargoed second
    const eplCond = { match: 'all', conditions: [{ field: 'meta:competition', op: 'is', value: 'EPL' }] };
    const embCond = { match: 'all', conditions: [{ field: 'tags', op: 'has_any', value: ['embargoed'] }] };
    const dry = await call('POST', `${P}?dryRun=1`, { name: 'EPL', conditions: eplCond, settings: { ...au, access: 'entitled' } });
    check('dry run: the titles it would govern, the published one among them, nothing saved',
      [dry.s, dry.j.impact.assets, dry.j.impact.published, dry.j.impact.publishedChanged, (await query(`SELECT 1 FROM publishing_metadata_rules WHERE account_id = $1`, [me.a])).length], [200, 2, 1, 1, 0]);
    const r1 = await call('POST', P, { name: 'EPL', conditions: eplCond, settings: { ...au, access: 'entitled' } });
    check('created first, with its place and its restamp', [r1.s, r1.j.position, r1.j.name, r1.j.restamp.marked], [201, 0, 'EPL', 2]);
    const r2 = await call('POST', P, { name: 'Embargoed', conditions: embCond, settings: { distribution: { shareLinks: false }, geo: { mode: 'allow', countries: ['GB'] } } });
    check('the second goes after it', [r2.s, r2.j.position], [201, 1]);

    let res = await resolve(eplUp);
    check('EPL and embargoed: the FIRST rule applies (EPL), not the second',
      [res.settings.geo.countries, res.sources.geo, res.settings.distribution.shareLinks, res.rungs.find((x: any) => x.rung === 'metadata')?.name], [['AU', 'NZ'], 'metadata', true, 'EPL']);
    res = await resolve(liga);
    check('only embargoed: the second rule applies', [res.settings.geo.countries, res.settings.distribution.shareLinks, res.rungs.find((x: any) => x.rung === 'metadata')?.name], [['GB'], false, 'Embargoed']);
    res = await resolve(plain);
    check('no rule met: the rungs below decide, no metadata rung named', [res.settings.geo.mode, res.rungs.find((x: any) => x.rung === 'metadata')?.id ?? null], ['worldwide', null]);
    res = await resolve(epl);
    check('a match beats the channel it came from (US block replaced by AU and NZ)', [res.settings.geo.mode, res.settings.geo.countries, res.sources.geo, res.settings.access], ['allow', ['AU', 'NZ'], 'metadata', 'entitled']);

    // ---- the published title takes up the new rule
    const took = await until(async () => JSON.stringify((await row(epl)).availability?.geo?.countries) === '["AU","NZ"]');
    check(`the published channel title takes up the rule without publishing again (${took} ms)`, [took >= 0, (await row(epl)).availability_sources.geo], [true, 'metadata']);
    check('the play gate answers by it: AU allowed to an entitled viewer, GB refused', [(await A.onDemandAccess(epl, 'AU', null, true))?.allowed, (await A.onDemandAccess(epl, 'GB', null, true))?.allowed], [true, false]);
    check('a published title no rule meets is left as it was', (await row(plain)).availability.geo.mode, 'worldwide');

    // ---- the list, the test box
    const list = await call('GET', P);
    check('the list in order, each with the titles it governs', list.j.items.map((r: any) => `${r.name}:${r.titles}`), ['EPL:2', 'Embargoed:1']);
    const tb = await call('POST', `${P}/test`, { assetId: eplUp });
    check('the test box: the rule that applies, its place, and which others also match',
      [tb.s, tb.j.matched?.name, tb.j.matched?.position, tb.j.rules.map((r: any) => `${r.name}:${r.matches}`), tb.j.resolved.settings.geo.countries],
      [200, 'EPL', 1, ['EPL:true', 'Embargoed:true'], ['AU', 'NZ']]);
    check('the test box: a title no rule meets', (await call('POST', `${P}/test`, { assetId: plain })).j.matched, null);
    check('the test box: not an id', (await call('POST', `${P}/test`, { assetId: 'abc' })).s, 400);
    check('the test box: another account\'s title is not found', (await call('POST', `${P}/test`, { assetId: other })).s, 404);

    // ---- the order decides
    const ord = await call('PUT', `${P}/order`, { ids: [r2.j.id, r1.j.id] });
    check('reordered: Embargoed first', [ord.s, ord.j.items.map((r: any) => r.name), ord.j.restamp.marked], [200, ['Embargoed', 'EPL'], 2]);
    res = await resolve(eplUp);
    check('EPL and embargoed now gets the Embargoed rule', [res.settings.geo.countries, res.settings.distribution.shareLinks, res.rungs.find((x: any) => x.rung === 'metadata')?.name], [['GB'], false, 'Embargoed']);
    check('an order that leaves a rule out is refused', (await call('PUT', `${P}/order`, { ids: [r2.j.id] })).s, 400);
    await call('PUT', `${P}/order`, { ids: [r1.j.id, r2.j.id] });

    // ---- disabled is passed over
    const off = await call('PUT', `${P}/${r1.j.id}`, { name: 'EPL', conditions: eplCond, enabled: false });
    check('switched off: kept, its policy kept', [off.s, off.j.enabled, off.j.settings.geo.countries, off.j.version], [200, false, ['AU', 'NZ'], 2]);
    res = await resolve(eplUp);
    check('a rule switched off is passed over: the next one that matches applies', res.rungs.find((x: any) => x.rung === 'metadata')?.name, 'Embargoed');
    await call('PUT', `${P}/${r1.j.id}`, { name: 'EPL', conditions: eplCond, enabled: true });

    // ---- the title's own override beats the rule
    await query(`UPDATE vod_assets SET availability_override = '{"geo":{"mode":"worldwide","countries":[]}}'::jsonb WHERE id = $1`, [eplUp]);
    res = await resolve(eplUp);
    check('a title override beats the metadata rule; the rest still from the rule', [res.settings.geo.mode, res.sources.geo, res.sources.access], ['worldwide', 'asset', 'metadata']);
    await query(`UPDATE vod_assets SET availability_override = '{}'::jsonb WHERE id = $1`, [eplUp]);

    // ---- a lock on the account default
    await call('PUT', '/api/publishing-rules/account', { settings: { access: 'free' }, lockedFields: ['access'] });
    const lk = await call('PUT', `${P}/${r1.j.id}`, { name: 'EPL', conditions: eplCond, settings: { ...au, access: 'paid' } });
    check('saving a field the account locked is refused, naming the lock', [lk.s, lk.j.code, /locked by the account default/.test(lk.j.error ?? lk.j.message ?? '')], [422, 'policy_conflict', true]);
    res = await resolve(epl);
    check('and the stored rule\'s locked field is ignored at resolve and reported', [res.settings.access, res.sources.access, res.ignored.some((i: any) => i.rung === 'metadata' && i.field === 'access')], ['free', 'account', true]);
    await call('PUT', '/api/publishing-rules/account', { settings: {}, lockedFields: [] });

    // ---- a metadata edit reaches a published title
    await settle();
    await query(`UPDATE vod_assets SET metadata = metadata || '{"competition":"EPL"}'::jsonb WHERE id = $1`, [plain]);
    check('editing a published title\'s metadata marks it for the sweep', !!(await row(plain)).policy_stale_at, true);
    await A.restampStale();
    check('the sweep stamps it with the rule it now meets', [(await row(plain)).availability.geo.countries, (await row(plain)).availability_sources.geo, (await row(plain)).policy_stale_at], [['AU', 'NZ'], 'metadata', null]);
    await query(`UPDATE vod_assets SET availability_state = availability_state WHERE id = $1`, [plain]);
    check('a write that changes nothing a rule reads does not mark it', (await row(plain)).policy_stale_at, null);

    // ---- collections
    const col = (await one<any>(`INSERT INTO collections(account_id, name) VALUES ($1,'Premium picks') RETURNING id`, [me.a]))!.id;
    const r3 = await call('POST', P, { name: 'Premium picks', conditions: { match: 'all', conditions: [{ field: 'collection', op: 'has_any', value: [col] }] }, settings: { access: 'paid' } });
    await call('PUT', `${P}/order`, { ids: [r3.j.id, r1.j.id, r2.j.id] });
    await A.restampStale(); await settle();
    await query(`INSERT INTO collection_items(collection_id, vod_asset_id, position) VALUES ($1,$2,0)`, [col, epl]);
    check('going into a collection marks the published title', !!(await row(epl)).policy_stale_at, true);
    res = await resolve(epl);
    check('a condition on a collection matches its members', [res.rungs.find((x: any) => x.rung === 'metadata')?.name, res.settings.access, res.settings.geo.countries], ['Premium picks', 'paid', ['US']]);
    await A.restampStale();
    check('and the stamp follows', (await row(epl)).availability.access, 'paid');
    await query(`DELETE FROM collection_items WHERE collection_id = $1`, [col]);
    check('leaving it marks it again', !!(await row(epl)).policy_stale_at, true);
    await A.restampStale();
    check('and it falls back to the EPL rule', [(await row(epl)).availability.access, (await row(epl)).availability.geo.countries], ['entitled', ['AU', 'NZ']]);

    // ---- tenancy
    check('another account cannot read, change or remove a rule',
      [(await call('GET', `${P}/${r1.j.id}`, undefined, them.tok)).s, (await call('PUT', `${P}/${r1.j.id}`, { name: 'x', conditions: eplCond }, them.tok)).s, (await call('DELETE', `${P}/${r1.j.id}`, undefined, them.tok)).s],
      [404, 404, 404]);
    check('their list is empty and their EPL title meets nothing of ours', [(await call('GET', P, undefined, them.tok)).j.items.length, (await call('POST', `${P}/test`, { assetId: other }, them.tok)).j.matched], [0, null]);
    check('a rule id that is not an id is not found', (await call('GET', `${P}/nope`)).s, 404);

    // ---- removing a rule
    const del = await call('DELETE', `${P}/${r1.j.id}`);
    check('removed', del.s, 204);
    check('the order closes up', (await call('GET', P)).j.items.map((r: any) => `${r.name}@${r.position}`), ['Premium picks@0', 'Embargoed@1']);
    // The removal starts a restamp in the background; the sweep would do the same.
    await A.restampStale();
    await until(async () => (await row(epl)).availability_sources.geo === 'owner');
    check('its published titles fall to the rungs below (the channel title back to the owner\'s geo)', [(await row(epl)).availability.geo.countries, (await row(epl)).availability_sources.geo], [['US'], 'owner']);

    // ---- the audit trail
    const audit = await query<any>(`SELECT action FROM audit_log WHERE account_id = $1 AND entity_type = 'publishing_metadata_rule' ORDER BY created_at`, [me.a]);
    check('audited: creates, changes, the order and the removal', [audit.filter((a) => a.action === 'create').length >= 3, audit.filter((a) => a.action === 'update').length >= 4, audit.some((a) => a.action === 'delete')], [true, true, true]);
  } finally {
    srv.close();
    await sleep(200);
    await pool.end();
  }
  console.log(`publishing-metadata-rules: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
