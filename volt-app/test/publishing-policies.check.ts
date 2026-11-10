// ============================================================================
//  PUBLISHING POLICIES: sections, precedence, locks, presets, conflicts and
//  the impact of a save (build queue P3, services/publishingRules.ts,
//  services/publishingPolicies.ts, migration 0153, PUBLISHING_POLICIES.md).
//
//  Pure: the protection, distribution and retention sections resolve field by
//  field (a rung that states one field leaves the others to the rungs below);
//  a lock is final from the rung that sets it, what a more specific rung says
//  about a locked field is ignored and reported; every conflict rule of the
//  design that this build covers, as a block or a warning; the presets.
//  Then over real HTTP against a database: the migration; saving sections,
//  locks, a name and a preset; a type rung refused for changing a field the
//  account locked; a blocking conflict refused with 422 and its conflicts,
//  nothing saved; a dry run counting the titles a save governs, changes and
//  would block, saving nothing; a DRM change on published titles refused with
//  409 until confirmed; the trace of one title with its locks and conflicts;
//  another account's rung and titles out of reach; the audit entry.
//    DATABASE_URL=... npx tsx test/publishing-policies.check.ts
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};

(async () => {
  const R = await import('../src/services/publishingRules');
  const P = await import('../src/services/publishingPolicies');
  const RP = await import('../src/services/rightsProfiles');

  // ---------------------------------------------------------------- pure: sections resolve per field
  const L = (acc: any, sch: any = {}, own: any = {}, ast: any = {}, locks: { acc?: string[]; sch?: string[]; own?: string[] } = {}) => R.resolveLadder([
    { rung: 'account', settings: acc, lockedFields: locks.acc }, { rung: 'schema', settings: sch, lockedFields: locks.sch },
    { rung: 'owner', settings: own, lockedFields: locks.own }, { rung: 'asset', settings: ast }]);
  const none = L({});
  check('nothing set: the baseline sections (no DRM, everything allowed, kept forever)',
    [none.settings.protection.drm, none.settings.protection.waf, none.settings.distribution.mp4Download, none.settings.distribution.shareLinks, none.settings.retention.keep],
    [false, 'off', true, true, 'forever']);
  check('and every section field is from the baseline', Object.values(none.fieldSources).every((s) => s === 'baseline'), true);
  const per = L({ protection: { waf: 'standard' }, distribution: { shareLinks: false } }, { protection: { drm: true } }, {}, { distribution: { mp4Download: false } });
  check('a type that states only DRM keeps the account WAF profile',
    [per.settings.protection.drm, per.fieldSources['protection.drm'], per.settings.protection.waf, per.fieldSources['protection.waf']], [true, 'schema', 'standard', 'account']);
  check('the title states MP4 only, share links still from the account',
    [per.settings.distribution.mp4Download, per.fieldSources['distribution.mp4Download'], per.settings.distribution.shareLinks, per.fieldSources['distribution.shareLinks']],
    [false, 'asset', false, 'account']);
  check('a section is attributed to the most specific rung that set any of its fields', [per.sources.protection, per.sources.distribution], ['schema', 'asset']);
  check('an owner that sets WAF back to off is more specific than the account',
    L({ protection: { waf: 'standard' } }, {}, { protection: { waf: 'off' } }).settings.protection.waf, 'off');

  // ---------------------------------------------------------------- pure: locks
  const lk = L({ protection: { drm: true } }, { protection: { drm: false } }, {}, { protection: { drm: false } }, { acc: ['protection.drm'] });
  check('the account locks DRM on: the type and the title cannot turn it off', [lk.settings.protection.drm, lk.fieldSources['protection.drm']], [true, 'account']);
  check('the lock and its rung are named', lk.locks['protection.drm'], 'account');
  check('and what was not listened to is reported', lk.ignored.map((i) => `${i.rung}:${i.field}:${i.lockedBy}`), ['schema:protection.drm:account', 'asset:protection.drm:account']);
  const lk2 = L({}, { access: 'paid', paywall: { tier: 'gold' } }, { access: 'free' }, { access: 'free' }, { sch: ['access'] });
  check('a type locks Access: the owner and the title are ignored', [lk2.settings.access, lk2.sources.access], ['paid', 'schema']);
  check('an unlocked field on the same rung still resolves normally', lk2.settings.paywall?.tier, 'gold');
  const lk3 = L({ protection: { drm: true, waf: 'standard' } }, { protection: { drm: false, waf: 'off' } }, {}, {}, { acc: ['protection'] });
  check('locking a whole section locks each of its fields', [lk3.settings.protection.drm, lk3.settings.protection.waf], [true, 'standard']);
  const lk4 = L({ protection: { drm: true } }, { protection: { drm: false } }, {}, {}, { acc: ['protection.drm'], sch: ['protection.drm'] });
  check('the highest lock wins when two rungs lock the same field', [lk4.locks['protection.drm'], lk4.settings.protection.drm], ['account', true]);
  check('a rung that locks a field it does not set locks the inherited value',
    L({}, { protection: { drm: true } }, {}, {}, { acc: ['protection.drm'] }).settings.protection.drm, false);
  check('lockConflicts names the field and the rung',
    P.lockConflicts({ protection: { drm: false }, geo: { mode: 'worldwide', countries: [] } }, 'schema', { 'protection.drm': 'account' }).map((c) => c.message),
    ['DRM is locked by the account default: it cannot be changed here.']);
  check('a rung may restate nothing locked', P.lockConflicts({ access: 'free' }, 'schema', { 'protection.drm': 'account' }).length, 0);
  check('statedFields lists section fields by name', P.statedFields({ protection: { drm: true, waf: 'off' }, access: 'free' }), ['protection.drm', 'protection.waf', 'access']);

  // ---------------------------------------------------------------- pure: conflicts
  const C = (s: any, o: any = {}) => P.policyConflicts(L(s).settings, o).map((c) => `${c.code}:${c.level}`);
  const social = [{ kind: 'social', targetId: 'x', platform: 'youtube' }];
  check('DRM on + MP4 download allowed: block', C({ protection: { drm: true } }), ['drm_mp4:block']);
  check('DRM on, MP4 off: nothing', C({ protection: { drm: true }, distribution: { mp4Download: false } }), []);
  check('DRM on + a social target: block', C({ protection: { drm: true }, distribution: { mp4Download: false }, targets: social }), ['drm_social:block']);
  check('geo restriction + social: warning (and geo without WAF)', C({ geo: { mode: 'allow', countries: ['AU'] }, targets: social }), ['geo_social:warn', 'geo_no_waf:warn']);
  check('geo restriction with a WAF profile: no WAF warning', C({ geo: { mode: 'block', countries: ['US'] }, protection: { waf: 'standard' } }), []);
  check('an access rule limited to some countries counts as a geo restriction',
    C({ accessRules: [{ id: 'a', for: { scopes: ['ondemand'] }, if: { geo: 'in', countries: ['AU'] }, then: { access: 'free' } }] }), ['geo_no_waf:warn']);
  check('a worldwide access rule does not', C({ accessRules: [{ id: 'a', for: { scopes: ['ondemand'] }, if: { geo: 'in', countries: ['WORLD'] }, then: { access: 'members' } }] }), []);
  check('only in these countries with none chosen: warning', C({ geo: { mode: 'allow', countries: [] }, protection: { waf: 'standard' } }), ['geo_empty:warn']);
  check('expires before it becomes available: block',
    C({ availableFrom: { mode: 'at', at: '2026-12-01T00:00:00Z' }, expire: { mode: 'at', at: '2026-11-01T00:00:00Z' } }), ['empty_window:block']);
  check('retention on titles that never expire: block', C({ retention: { keep: 'days', days: 90, anchor: 'available_until' } }), ['retention_while_live:block']);
  check('retention 90 days after expiry: fine', C({ expire: { mode: 'days', days: 30 }, retention: { keep: 'days', days: 90, anchor: 'available_until' } }), []);
  check('retention 10 days from availability, available for 30: block',
    C({ expire: { mode: 'days', days: 30 }, retention: { keep: 'days', days: 10, anchor: 'available_from' } }), ['retention_while_live:block']);
  check('retention 60 days from availability, available for 30: fine', C({ expire: { mode: 'days', days: 30 }, retention: { keep: 'days', days: 60, anchor: 'available_from' } }), []);
  const now = new Date('2026-11-10T12:00:00Z'), d = (n: number) => new Date(now.getTime() + n * 86_400_000);
  const rights = (o: any) => ({ ...RP.OPEN, ...o });
  const t = (o: any = {}) => ({ rights: rights({}), availableFrom: d(0), availableUntil: null, createdAt: d(-1), ...o });
  check('rights-managed without a rights window, for a title: block',
    C({ protection: { drm: true, waf: 'rights_managed' }, distribution: { mp4Download: false } }, { title: t() }), ['rights_managed_no_window:block']);
  check('the same preset by its key alone: block',
    C({ protection: { waf: 'standard' } }, { presetKey: 'rights_managed', title: t() }), ['rights_managed_no_window:block']);
  check('rights-managed with a rights window inside the publish window: fine',
    C({ protection: { waf: 'rights_managed' } }, { title: t({ rights: rights({ from: d(-5), until: d(30) }), availableUntil: d(20) }) }), []);
  check('publish window reaching outside the rights window: warning',
    C({}, { title: t({ rights: rights({ from: d(-5), until: d(10) }), availableUntil: d(20) }) }), ['window_outside_rights:warn']);
  check('rights limited to some territories + social: warning',
    C({ targets: social }, { title: t({ rights: rights({ territoryMode: 'allow', territories: ['AU'] }) }) }), ['geo_social:warn']);
  check('a retention date before the title\'s own end date: block',
    C({ retention: { keep: 'days', days: 5, anchor: 'ingest' } }, { title: t({ availableUntil: d(30) }) }), ['retention_while_live:block']);

  // ---------------------------------------------------------------- pure: presets
  check('five presets, in the design\'s order', P.PRESETS.map((p) => p.key), ['open', 'members', 'geo_locked', 'premium', 'rights_managed']);
  const presetConflicts = P.PRESETS.map((p) => `${p.key}:${P.policyConflicts(L(p.settings).settings, { presetKey: p.key }).filter((c) => c.level === 'block').length}`);
  check('no preset blocks on its own', presetConflicts, ['open:0', 'members:0', 'geo_locked:0', 'premium:0', 'rights_managed:0']);
  const prem = L(P.presetByKey('premium')!.settings).settings;
  check('Premium: paid, DRM, no MP4', [prem.access, prem.protection.drm, prem.distribution.mp4Download], ['paid', true, false]);
  const rm = L(P.presetByKey('rights_managed')!.settings).settings;
  check('Rights-managed: DRM, the rights-managed WAF, no MP4, no social', [rm.protection.drm, rm.protection.waf, rm.distribution.mp4Download, rm.targets.some((x: any) => x.kind === 'social')], [true, 'rights_managed', false, false]);
  check('Geo-locked leaves the countries to the person', P.presetByKey('geo_locked')!.settings.geo?.countries, []);

  // ---------------------------------------------------------------- database
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const tag = Date.now().toString(36);
  const mk = async (n: string) => {
    const a = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`pp-${n}-${tag}`]))!.id;
    const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `pp-${n}-${tag}@volt.test`]))!.id;
    return { a, u, tok: signAccess({ sub: u, account_id: a, role: 'owner' }) };
  };
  const me = await mk('me'), them = await mk('them');
  const schema = async (a: string, name: string) => (await one<any>(`INSERT INTO metadata_schemas(account_id,name,target_kind,fields) VALUES ($1,$2,'vod','[]'::jsonb) RETURNING id`, [a, name]))!.id;
  const sport = await schema(me.a, 'Sports match'), talk = await schema(me.a, 'Talk'), theirs = await schema(them.a, 'Theirs');
  const asset = async (a: string, title: string, schemaId: string | null, set = '') => {
    const id = (await one<any>(
      `INSERT INTO vod_assets(account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, schema_id)
       VALUES ($1,'upload','clip',$2,'/clips/x/master.m3u8',0,60000,60000,$3) RETURNING id`, [a, title, schemaId]))!.id;
    if (set) await query(`UPDATE vod_assets SET ${set} WHERE id = $1`, [id]);
    return id;
  };
  const LIVE = `availability_state = 'available', published = true, available_from = now() - interval '1 day'`;
  const s1 = await asset(me.a, 'Final', sport, LIVE), s2 = await asset(me.a, 'Semi', sport, LIVE), s3 = await asset(me.a, 'Draft match', sport);
  const t1 = await asset(me.a, 'Interview', talk, LIVE);
  await asset(them.a, 'Not mine', theirs, LIVE);

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = async (method: string, path: string, body?: any, tok = me.tok) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const txt = await r.text(); let j: any = null; try { j = JSON.parse(txt); } catch { j = txt; }
    return { s: r.status, j };
  };
  const stored = async (kind: string, id: string | null, a = me.a) => one<any>(
    `SELECT settings, locked_fields, name, preset_key, version FROM publishing_rules WHERE account_id = $1 AND scope_kind = $2 AND scope_id IS NOT DISTINCT FROM $3::uuid`, [a, kind, id]);
  try {
    const cols = await query<any>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'publishing_rules' AND column_name IN ('locked_fields','name','preset_key') ORDER BY 1`);
    check('migration 0153: locked_fields, name, preset_key', cols.map((c) => c.column_name), ['locked_fields', 'name', 'preset_key']);

    const pr = await call('GET', '/api/publishing-rules/presets');
    check('GET presets: the five', [pr.s, pr.j.map((p: any) => p.name)], [200, ['Open', 'Members', 'Geo-locked', 'Premium', 'Rights-managed']]);
    const fl = await call('GET', '/api/publishing-rules/fields');
    check('GET fields: five sections, the lockable fields and their labels',
      [fl.s, Object.keys(fl.j.sections), fl.j.lockable.includes('protection.drm'), fl.j.labels['distribution.mp4Download']],
      [200, ['lifecycle', 'access', 'protection', 'distribution', 'retention'], true, 'MP4 download']);

    // ---- an old-style save (settings only) still works and stores sections
    const plain = await call('PUT', '/api/publishing-rules/account', { distribution: { shareLinks: false } });
    check('a body that is only settings saves as before', [plain.s, (await stored('account', null))!.settings.distribution.shareLinks], [200, false]);
    check('an unknown section field is refused', (await call('PUT', '/api/publishing-rules/account', { protection: { drm: true, colour: 'red' } })).s, 422);
    check('retention in days with no number of days is refused', (await call('PUT', '/api/publishing-rules/account', { settings: { retention: { keep: 'days' } } })).s, 400);
    check('an unknown field cannot be locked', (await call('PUT', '/api/publishing-rules/account', { settings: {}, lockedFields: ['protection.colour'] })).s, 400);

    // ---- the account locks the WAF profile; a type may not change it
    const acc = await call('PUT', '/api/publishing-rules/account', { settings: { protection: { waf: 'standard' } }, lockedFields: ['protection.waf'], name: 'House policy' });
    const accRow = await stored('account', null);
    check('the account saves a section, a lock and a name', [acc.s, accRow!.settings.protection.waf, accRow!.locked_fields, accRow!.name], [200, 'standard', ['protection.waf'], 'House policy']);
    check('a later settings-only save keeps the lock and the name',
      [(await call('PUT', '/api/publishing-rules/account', { protection: { waf: 'standard' } })).s, (await stored('account', null))!.locked_fields, (await stored('account', null))!.name], [200, ['protection.waf'], 'House policy']);
    const lockedOut = await call('PUT', `/api/publishing-rules/schema/${talk}`, { settings: { protection: { waf: 'off' } } });
    check('a type changing the locked WAF profile: 422 policy_conflict naming the lock, nothing saved',
      [lockedOut.s, lockedOut.j.code, lockedOut.j.error, lockedOut.j.details.conflicts[0].code, await stored('schema', talk)],
      [422, 'policy_conflict', 'WAF profile is locked by the account default: it cannot be changed here.', 'locked_field', null]);

    // ---- a blocking conflict
    const drmMp4 = await call('PUT', `/api/publishing-rules/schema/${talk}`, { settings: { protection: { drm: true } } });
    check('DRM with MP4 still allowed: 422 with the conflict, nothing saved',
      [drmMp4.s, drmMp4.j.details.conflicts.map((c: any) => c.code), await stored('schema', talk)], [422, ['drm_mp4'], null]);

    // ---- dry run: counts, nothing saved
    const premium = P.presetByKey('premium')!.settings;
    const dry = await call('PUT', `/api/publishing-rules/schema/${sport}?dryRun=1`, { settings: premium, presetKey: 'premium' });
    check('dry run of Premium on Sports match: 3 titles, 2 published, 3 change, 2 to repackage, can save, nothing saved',
      [dry.s, dry.j.saved, dry.j.canSave, dry.j.impact.assets, dry.j.impact.published, dry.j.impact.changed, dry.j.impact.repackage, await stored('schema', sport)],
      [200, false, true, 3, 2, 3, 2, null]);
    const dryAcc = await call('PUT', `/api/publishing-rules/account?dryRun=1`, { settings: { protection: { waf: 'standard' }, distribution: { shareLinks: false, sitemap: false } } });
    check('a dry run on the account counts every title of the account, none of another\'s',
      [dryAcc.j.impact.assets, dryAcc.j.impact.changed, dryAcc.j.impact.repackage], [4, 4, 0]);
    const dryBad = await call('PUT', `/api/publishing-rules/schema/${talk}?dryRun=1`, { settings: { protection: { drm: true } } });
    check('a dry run says when a save would be refused', [dryBad.s, dryBad.j.canSave, dryBad.j.conflicts[0].code], [200, false, 'drm_mp4']);

    // ---- an encode-time change on published titles must be confirmed
    const unconfirmed = await call('PUT', `/api/publishing-rules/schema/${sport}`, { settings: premium, presetKey: 'premium' });
    check('DRM on two published titles: 409 confirm_repackage with the count, nothing saved',
      [unconfirmed.s, unconfirmed.j.code, unconfirmed.j.details.impact.repackage, await stored('schema', sport)], [409, 'confirm_repackage', 2, null]);
    const confirmed = await call('PUT', `/api/publishing-rules/schema/${sport}`, { settings: premium, presetKey: 'premium', lockedFields: ['protection.drm'], confirm: true });
    const sr = await stored('schema', sport);
    check('confirmed: saved with its preset and lock, the impact returned',
      [confirmed.s, sr!.preset_key, sr!.locked_fields, sr!.settings.protection.drm, confirmed.j.impact.repackage], [200, 'premium', ['protection.drm'], true, 2]);

    // ---- warnings are saved and returned
    const warn = await call('PUT', `/api/publishing-rules/schema/${talk}`, { settings: { geo: { mode: 'allow', countries: [] } } });
    check('a warning does not stop a save, and is returned', [warn.s, warn.j.warnings.map((w: any) => w.code)], [200, ['geo_empty']]);

    // ---- a title-level block: rights-managed on a title with no rights window
    // (the account first unlocks its WAF profile, which Rights-managed sets)
    check('the account unlocks its WAF profile', (await call('PUT', '/api/publishing-rules/account', { settings: { protection: { waf: 'standard' } }, lockedFields: [] })).s, 200);
    const rmDry = await call('PUT', `/api/publishing-rules/schema/${talk}?dryRun=1`, { settings: { ...P.presetByKey('rights_managed')!.settings, geo: { mode: 'allow', countries: ['AU'] } }, presetKey: 'rights_managed', confirm: true });
    check('Rights-managed on Talk: the title with no rights window blocks it, named',
      [rmDry.j.canSave, rmDry.j.impact.blocks.map((b: any) => `${b.code}:${b.count}:${b.titles[0].title}`)], [false, ['rights_managed_no_window:1:Interview']]);
    const rmSave = await call('PUT', `/api/publishing-rules/schema/${talk}`, { settings: { ...P.presetByKey('rights_managed')!.settings, geo: { mode: 'allow', countries: ['AU'] } }, presetKey: 'rights_managed', confirm: true });
    check('and the save is refused with the count in its words', [rmSave.s, rmSave.j.error.startsWith('1 title: A rights-managed policy needs a rights window')], [422, true]);
    const windowed = (await call('POST', '/api/rights/profiles', { name: `Window ${tag}`, territoryMode: 'allow', territories: ['AU'], appMode: 'all', appTypes: [], appIds: [],
      uses: ['on_demand'], accessTypes: ['free', 'subscription'], window: { kind: 'fixed', from: new Date(Date.now() - 86_400_000).toISOString(), until: new Date(Date.now() + 90 * 86_400_000).toISOString() } })).j;
    await query(`UPDATE vod_assets SET rights_profile_id = $2 WHERE id = $1`, [t1, windowed.id]);
    RP.invalidateRights(windowed.id, [t1]);
    const rmOk = await call('PUT', `/api/publishing-rules/schema/${talk}`, { settings: { ...P.presetByKey('rights_managed')!.settings, geo: { mode: 'allow', countries: ['AU'] } }, presetKey: 'rights_managed', confirm: true });
    check('once the title has a rights window, Rights-managed saves', [rmOk.s, (await stored('schema', talk))!.preset_key], [200, 'rights_managed']);

    // ---- the trace of one title
    const tr = await call('GET', `/api/publishing-rules/resolve?assetId=${s1}`);
    check('the trace: DRM on from the type and locked there, WAF from the account and no longer locked',
      [tr.s, tr.j.settings.protection.drm, tr.j.fieldSources['protection.drm'], tr.j.locks['protection.drm'], tr.j.fieldSources['protection.waf'], tr.j.locks['protection.waf'] ?? null], [200, true, 'schema', 'schema', 'account', null]);
    check('the trace carries the rungs with their preset and locks', tr.j.rungs.find((r: any) => r.rung === 'schema').presetKey, 'premium');
    check('the trace carries the title\'s conflicts (none here)', tr.j.conflicts, []);
    await query(`UPDATE vod_assets SET availability_override = '{"protection":{"drm":false},"distribution":{"mp4Download":true}}'::jsonb WHERE id = $1`, [s2]);
    const tr2 = await call('GET', `/api/publishing-rules/resolve?assetId=${s2}`);
    check('a title override on a locked field is ignored and reported, its unlocked field applies',
      [tr2.j.settings.protection.drm, tr2.j.ignored.map((i: any) => `${i.field}:${i.lockedBy}`), tr2.j.settings.distribution.mp4Download], [true, ['protection.drm:schema'], true]);
    check('and the conflict that leaves is shown on the title', tr2.j.conflicts.map((c: any) => c.code), ['drm_mp4']);

    // ---- a save that changes nothing changes no title (P3-2): a stored rung
    // comes back from jsonb with its keys in another order than it was sent
    const paywall = { protection: { waf: 'standard' }, paywall: { tier: 'gold', priceCents: 500, currency: 'AUD' }, geo: { mode: 'block', countries: ['US'] } };
    check('the account saves a paywall and a geo block', (await call('PUT', '/api/publishing-rules/account', { settings: paywall, lockedFields: [] })).s, 200);
    const same = await call('PUT', '/api/publishing-rules/account?dryRun=1', { settings: paywall, lockedFields: [] });
    check('a dry run of the same rung again: every title governed, none changed', [same.j.impact.assets > 0, same.j.impact.changed], [true, 0]);
    check('P.stableJson ignores key order, not values', [P.stableJson({ a: 1, b: { c: 2, d: [1, { f: 1, e: 2 }] } }) === P.stableJson({ b: { d: [1, { e: 2, f: 1 }], c: 2 }, a: 1 }), P.stableJson({ a: [1, 2] }) === P.stableJson({ a: [2, 1] })], [true, false]);
    check('the account goes back to its WAF profile alone', (await call('PUT', '/api/publishing-rules/account', { settings: { protection: { waf: 'standard' } }, lockedFields: [] })).s, 200);

    // ---- tenancy
    check('another account\'s content type cannot be given a rule', (await call('PUT', `/api/publishing-rules/schema/${theirs}`, { settings: {} })).s, 404);
    check('another account\'s title cannot be traced', (await call('GET', `/api/publishing-rules/resolve?assetId=${s1}`, undefined, them.tok)).s, 404);
    const theirDry = await call('PUT', `/api/publishing-rules/account?dryRun=1`, { settings: { protection: { waf: 'standard' } } }, them.tok);
    check('their dry run counts only their title', theirDry.j.impact.assets, 1);
    check('my locks are not theirs', (await call('PUT', `/api/publishing-rules/schema/${theirs}`, { settings: { protection: { waf: 'off' } } }, them.tok)).s, 200);

    // ---- audit
    const aud = await one<any>(`SELECT detail FROM audit_log WHERE account_id = $1 AND entity_type = 'publishing_rule' AND detail->'changes' ? 'preset_key' ORDER BY created_at DESC LIMIT 1`, [me.a]);
    check('the audit entry records the preset and the lock it set', [!!aud, aud?.detail?.changes?.preset_key?.to, aud?.detail?.changes?.locked_fields?.to], [true, 'rights_managed', undefined]);

    // ---- scale: a dry run over many titles
    await query(`INSERT INTO vod_assets(account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, schema_id, availability_state, published, available_from)
                 SELECT $1,'upload','clip','Bulk '||g,'/clips/x/m.m3u8',0,1000,1000,$2,'available',true,now() FROM generate_series(1,5000) g`, [me.a, talk]);
    const t0 = Date.now();
    const big = await call('PUT', `/api/publishing-rules/account?dryRun=1`, { settings: { protection: { waf: 'standard' }, distribution: { sitemap: false } } });
    const ms = Date.now() - t0;
    check(`a dry run over 5,004 titles answers (${ms} ms, under 5 s)`, [big.j.impact.assets, ms < 5000], [5004, true]);
  } finally {
    srv.close();
    await pool.end();
  }
  console.log(`publishing-policies: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
