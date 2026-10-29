// ============================================================================
//  GRAPHICS DEFAULT SETS end to end against Postgres and the real HTTP app:
//  shipped sets and their templates, per-account on/off over the set default,
//  what a client sees and can start setups from, setups staying per account,
//  System Admin uploads, versions, retiring and moving between sets, and that
//  turning a set off never breaks setups already made.
//
//  Usage: DATABASE_URL=... npx tsx test/graphics-sets.check.ts   (a migrated, disposable database)
// ============================================================================
let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };

(async () => {
  const { createServer } = await import('../src/server');
  const { pool, one } = await import('../src/db');
  const { signAccess, AUD_PLATFORM } = await import('../src/auth/jwt');
  const { ensureDefaultTemplates } = await import('../src/services/graphics/defaults');

  const tag = Date.now().toString(36);
  const mk = async (n: string) => {
    const a = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`${n}-${tag}`]))!.id;
    const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `${n}-${tag}@volt.test`]))!.id;
    return { a, u, tok: signAccess({ sub: u, account_id: a, role: 'owner' }) };
  };
  const A = await mk('sets-a'); const B = await mk('sets-b');
  const staff = await mk('sets-staff');
  await one(`UPDATE users SET platform_role = 'saas_admin' WHERE id = $1`, [staff.u]);
  const ptok = signAccess({ sub: staff.u, account_id: staff.a, role: 'owner' }, { aud: AUD_PLATFORM });
  const support = await mk('sets-support');
  await one(`UPDATE users SET platform_role = 'read_only' WHERE id = $1`, [support.u]);
  const rtok = signAccess({ sub: support.u, account_id: support.a, role: 'owner' }, { aud: AUD_PLATFORM });

  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: any, o: { token?: string; raw?: Buffer; type?: string } = {}) => {
    const headers: Record<string, string> = { authorization: `Bearer ${o.token ?? A.tok}` };
    let b: any;
    if (o.raw) { b = o.raw; headers['content-type'] = o.type ?? 'application/octet-stream'; }
    else if (body !== undefined) { b = JSON.stringify(body); headers['content-type'] = 'application/json'; }
    const r = await fetch(base + path, { method, headers, body: b });
    const text = await r.text(); let j: any = null; try { j = JSON.parse(text); } catch { j = text; }
    return { s: r.status, j };
  };
  const names = async (tok: string) => (await api('GET', '/api/graphics/templates', undefined, { token: tok })).j.items;

  try {
    console.log('== shipped sets ==');
    await ensureDefaultTemplates();
    let r = await api('GET', '/api/platform/graphics/sets', undefined, { token: ptok });
    const sets = Object.fromEntries(r.j.items.map((s: any) => [s.key, s]));
    ok(r.s === 200 && sets.news && sets.general && sets.sport, 'News, General and Sport scores sets exist', JSON.stringify(r.j).slice(0, 200));
    ok(sets.news.templates >= 8 && sets.general.templates >= 7 && sets.sport.templates >= 1, `every shipped template is in a set (news ${sets.news.templates}, general ${sets.general.templates}, sport ${sets.sport.templates})`);
    r = await api('GET', '/api/platform/graphics/templates?set=none', undefined, { token: ptok });
    ok(r.s === 200 && r.j.items.length === 0, 'no Volt template without a set');
    ok((await api('GET', '/api/platform/graphics/sets', undefined, { token: A.tok })).s === 403, 'a client admin cannot reach the platform library');
    ok((await api('PATCH', `/api/platform/graphics/sets/${sets.sport.id}`, { defaultEnabled: false }, { token: rtok })).s === 403, 'read-only platform staff cannot change a set');

    let items = await names(A.tok);
    const scorebug = items.find((t: any) => t.owner === 'volt' && t.set?.key === 'sport' && t.name === 'Scorebug');
    ok(!!scorebug && scorebug.available === true && scorebug.set.name === 'Sport scores', 'clients see Volt templates with their set');

    console.log('== a set off by default, on for one account ==');
    r = await api('PATCH', `/api/platform/graphics/sets/${sets.sport.id}`, { defaultEnabled: false }, { token: ptok });
    ok(r.s === 200 && r.j.defaultEnabled === false, 'Sport scores off by default');
    ok(!(await names(A.tok)).some((t: any) => t.set?.key === 'sport'), 'account A no longer sees sport templates');
    r = await api('PUT', `/api/platform/graphics/accounts/${A.a}/sets/${sets.sport.id}`, { enabled: true }, { token: ptok });
    const sportA = r.j.items.find((s: any) => s.key === 'sport');
    ok(r.s === 200 && sportA.override === true && sportA.enabled === true, 'switched on for account A');
    ok((await names(A.tok)).some((t: any) => t.id === scorebug.id), 'A sees the sport templates again');
    ok(!(await names(B.tok)).some((t: any) => t.set?.key === 'sport'), 'B (following the default) does not');
    ok((await api('GET', `/api/graphics/templates/${scorebug.id}`, undefined, { token: B.tok })).s === 404, 'B cannot open one by id either');

    console.log('== setups stay per account ==');
    r = await api('POST', '/api/graphics/setups', { name: 'Final score', versionId: scorebug.latest.id, fields: { home: { source: 'text', value: 'AUS' } } });
    const setupA = r.j;
    ok(r.s === 201, 'A makes a setup from the sport scorebug', JSON.stringify(r.j).slice(0, 200));
    r = await api('POST', '/api/graphics/setups', { name: 'Mine', versionId: scorebug.latest.id, fields: {} }, { token: B.tok });
    ok(r.s === 404 || r.s === 403, 'B cannot start a setup from a set that is off for it', String(r.s));
    r = await api('PUT', `/api/platform/graphics/accounts/${B.a}/sets/${sets.sport.id}`, { enabled: true }, { token: ptok });
    r = await api('GET', '/api/graphics/setups', undefined, { token: B.tok });
    ok(r.s === 200 && r.j.items.length === 0, 'B, now with the set on, sees none of A\'s setups');
    r = await api('GET', `/api/graphics/templates/${scorebug.id}`, undefined, { token: B.tok });
    ok(r.s === 200 && r.j.usedBy.length === 0, 'B sees no setups under the template, though A has one');
    r = await api('GET', `/api/graphics/setups/${setupA.id}`, undefined, { token: B.tok });
    ok(r.s === 404, 'B cannot open A\'s setup');

    console.log('== turning a set off keeps setups working ==');
    r = await api('PUT', `/api/platform/graphics/accounts/${A.a}/sets/${sets.sport.id}`, { enabled: false }, { token: ptok });
    items = await names(A.tok);
    const still = items.find((t: any) => t.id === scorebug.id);
    ok(!!still && still.available === false, 'the template stays listed for A, marked not available, because a setup uses it', JSON.stringify(still && { available: still.available, set: still.set, retired: still.retired }));
    ok(items.filter((t: any) => t.set?.key === 'sport').length === 1, 'the other sport templates (tennis, badminton and the rest) are hidden from A');
    r = await api('GET', `/api/graphics/setups/${setupA.id}`);
    ok(r.s === 200, 'A\'s setup still opens');
    r = await api('PATCH', `/api/graphics/setups/${setupA.id}`, { name: 'Final score (kept)' });
    ok(r.s === 200, 'and can still be edited');
    r = await api('POST', '/api/graphics/setups', { name: 'Another', versionId: scorebug.latest.id, fields: {} });
    ok(r.s === 403 && /not switched on/.test(JSON.stringify(r.j)), 'but no new setup starts from it', JSON.stringify(r.j).slice(0, 160));
    r = await api('POST', `/api/graphics/templates/${scorebug.id}/duplicate`, {});
    ok(r.s === 403, 'nor can it be duplicated');
    r = await api('PUT', `/api/platform/graphics/accounts/${A.a}/sets/${sets.sport.id}`, { enabled: null }, { token: ptok });
    ok(r.j.items.find((s: any) => s.key === 'sport').override === null, 'A back to following the default');

    console.log('== System Admin: a new set and a template uploaded to it ==');
    r = await api('POST', '/api/platform/graphics/sets', { key: 'esports', name: 'Esports', description: 'Game HUDs' }, { token: ptok });
    const es = r.j;
    ok(r.s === 201 && es.defaultEnabled === false && es.accountsOn === 0, 'a new set starts off for everyone');
    ok((await api('POST', '/api/platform/graphics/sets', { key: 'esports', name: 'Again' }, { token: ptok })).s === 409, 'set keys are unique');
    const html = (label: string) => `<script type="application/json" id="volt-manifest">{"name":"Kill feed","canvas":[1920,1080],"fields":[{"id":"line","type":"text","label":"Line"}],"sample":{"line":"${label}"}}</script>
      <div id="l"></div><script>function update(d){d=typeof d==='string'?JSON.parse(d):d;document.getElementById('l').textContent=d.line||''} function play(){} function stop(){}</script>`;
    r = await api('POST', `/api/platform/graphics/templates/import?setId=esports&kind=bug&filename=feed.html`, undefined, { token: ptok, raw: Buffer.from(html('v1')), type: 'text/html' });
    const kf = r.j;
    ok(r.s === 201 && kf.set?.key === 'esports' && kf.draft && !kf.latest, 'uploaded into the set as a draft', JSON.stringify(r.j).slice(0, 200));
    ok(!(await names(A.tok)).some((t: any) => t.id === kf.id), 'clients do not see it before it is published and switched on');
    r = await api('POST', `/api/platform/graphics/templates/${kf.id}/draft/publish`, { note: 'first' }, { token: ptok });
    ok(r.s === 200 && r.j.version === 1, 'published as v1');
    ok(!(await names(A.tok)).some((t: any) => t.id === kf.id), 'still hidden: the set is off by default');
    r = await api('PATCH', `/api/platform/graphics/sets/${es.id}`, { defaultEnabled: true }, { token: ptok });
    ok(r.j.accountsOn === r.j.accountsTotal, `on by default reaches every account (${r.j.accountsOn}/${r.j.accountsTotal})`);
    ok((await names(A.tok)).some((t: any) => t.id === kf.id) && (await names(B.tok)).some((t: any) => t.id === kf.id), 'every account now sees it');
    r = await api('PUT', `/api/platform/graphics/accounts/${B.a}/sets/${es.id}`, { enabled: false }, { token: ptok });
    ok(!(await names(B.tok)).some((t: any) => t.id === kf.id), 'switched off for B alone');
    r = await api('PATCH', `/api/platform/graphics/sets/${es.id}`, { defaultEnabled: true, clearOverrides: true }, { token: ptok });
    ok(r.j.overridesOff === 0 && (await names(B.tok)).some((t: any) => t.id === kf.id), 'clear overrides: the default applies to all again');

    console.log('== versions, retiring, moving ==');
    const kfA = (await names(A.tok)).find((t: any) => t.id === kf.id);
    r = await api('POST', '/api/graphics/setups', { name: 'Feed', versionId: kfA.latest.id, fields: { line: { source: 'text', value: 'x' } } });
    const feedSetup = r.j;
    ok(r.s === 201, 'A makes a setup on v1');
    r = await api('PUT', `/api/platform/graphics/templates/${kf.id}/draft?filename=feed.html`, undefined, { token: ptok, raw: Buffer.from(html('v2')), type: 'text/html' });
    ok(r.s === 200 && r.j.status === 'draft', 'System Admin uploads a new draft');
    r = await api('POST', `/api/platform/graphics/templates/${kf.id}/draft/publish`, {}, { token: ptok });
    ok(r.j.version === 2, 'published as v2');
    r = await api('GET', `/api/graphics/setups/${feedSetup.id}`);
    ok(r.j.version === 1 && r.j.upgradeAvailable === true, 'A\'s setup stays on v1 with an update available');
    r = await api('PATCH', `/api/platform/graphics/templates/${kf.id}`, { retired: true }, { token: ptok });
    ok(r.s === 200 && r.j.retired, 'retired');
    items = await names(B.tok);
    ok(!items.some((t: any) => t.id === kf.id), 'hidden from accounts that do not use it');
    const forA = (await names(A.tok)).find((t: any) => t.id === kf.id);
    ok(!!forA && forA.available === false && forA.retired, 'still listed for A, as retired');
    const v2 = (await api('GET', `/api/graphics/templates/${kf.id}`)).j.versions.find((v: any) => v.version === 2);
    r = await api('PATCH', `/api/graphics/setups/${feedSetup.id}`, { versionId: v2.id });
    ok(r.s === 200 && r.j.version === 2, 'A can still move its setup to v2 of the retired template', JSON.stringify(r.j).slice(0, 160));
    r = await api('PATCH', `/api/platform/graphics/templates/${kf.id}`, { retired: false, setId: sets.general.id }, { token: ptok });
    ok(r.j.set.key === 'general' && !r.j.retired, 'restored and moved to General');
    r = await api('GET', `/api/platform/graphics/templates/${kf.id}`, undefined, { token: ptok });
    ok(r.j.accounts.length === 1 && r.j.accounts[0].id === A.a && r.j.versions.length === 2, 'detail lists the accounts using it');

    console.log('== boot keeps System Admin changes ==');
    const lt = (await api('GET', '/api/platform/graphics/templates?set=news', undefined, { token: ptok })).j.items.find((t: any) => t.name.startsWith('Name super (who'));
    await api('PATCH', `/api/platform/graphics/templates/${lt.id}`, { setId: sets.general.id }, { token: ptok });
    await api('PATCH', `/api/platform/graphics/sets/${sets.news.id}`, { name: 'Newsroom' }, { token: ptok });
    await api('PUT', `/api/platform/graphics/templates/${lt.id}/draft`, { html: '<script type="application/json" id="volt-manifest">{"name":"Name super (who is speaking)","fields":[{"id":"name","type":"text"}]}</script><div></div><script>function update(){} function play(){} function stop(){}</script>' }, { token: ptok });
    await api('POST', `/api/platform/graphics/templates/${lt.id}/draft/publish`, {}, { token: ptok });
    const again = await ensureDefaultTemplates();
    ok(again === 0, `a restart publishes nothing over an admin's version (${again})`);
    r = await api('GET', `/api/platform/graphics/templates/${lt.id}`, undefined, { token: ptok });
    ok(r.j.set.key === 'general' && r.j.latest.version === 2, 'the move and the admin version stay');
    r = await api('GET', '/api/platform/graphics/sets', undefined, { token: ptok });
    ok(r.j.items.find((s: any) => s.key === 'news').name === 'Newsroom', 'the set rename stays');
  } catch (e) {
    fail++; console.log('FAIL threw', e);
  } finally {
    srv.close(); await pool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
