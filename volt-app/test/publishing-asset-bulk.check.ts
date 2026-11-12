// ============================================================================
//  THE ASSET RUNG IN BULK (build queue P3-2c): POST /api/vod/bulk/availability
//  (modules/vodBulk.ts), assetBulkCheck and policyImpact's 'assets' scope
//  (services/publishingPolicies.ts), markPolicyStale's 'assets' scope
//  (services/availability.ts).
//
//  Apply one policy (fields or a preset) as the selected titles' own override,
//  or clear their overrides. Each title is checked as the single PATCH checks
//  one: a lock beneath it refuses that title only, naming the rung; a conflict
//  the override brings is refused per title (one title already had MP4 off,
//  another did not); a block from a title's own rights (rights-managed with
//  no rights window) refuses that title and the impact is measured over the
//  rest; the impact is summed over the titles saved; ?dryRun=1 saves nothing;
//  DRM on published titles asks to confirm; published titles are marked and
//  take the change up through the restamp, drafts are not marked; titles of
//  another account and unknown ids are listed as missing and left alone.
//    DATABASE_URL=... npx tsx test/publishing-asset-bulk.check.ts
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
  const P = await import('../src/services/publishingPolicies');
  const tag = Date.now().toString(36);
  const mk = async (n: string) => {
    const a = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`ab-${n}-${tag}`]))!.id;
    const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `ab-${n}-${tag}@volt.test`]))!.id;
    return { a, u, tok: signAccess({ sub: u, account_id: a, role: 'owner' }) };
  };
  const me = await mk('me'), them = await mk('them');
  const schema = async (a: string, name: string) => (await one<any>(`INSERT INTO metadata_schemas(account_id,name,target_kind,fields) VALUES ($1,$2,'vod','[]'::jsonb) RETURNING id`, [a, name]))!.id;
  const sport = await schema(me.a, 'Sports match'), talk = await schema(me.a, 'Talk');
  const asset = async (a: string, title: string, schemaId: string | null, set = '') => {
    const id = (await one<any>(
      `INSERT INTO vod_assets(account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, schema_id)
       VALUES ($1,'upload','clip',$2,'/clips/x/master.m3u8',0,60000,60000,$3) RETURNING id`, [a, title, schemaId]))!.id;
    if (set) await query(`UPDATE vod_assets SET ${set} WHERE id = $1`, [id]);
    return id;
  };
  const LIVE = `availability_state = 'available', published = true, available_from = now() - interval '1 day'`;
  const match = await asset(me.a, 'Draft match', sport), final = await asset(me.a, 'Final', sport, LIVE);
  const interview = await asset(me.a, 'Interview', talk), panel = await asset(me.a, 'Panel', talk);
  const theirs = await asset(them.a, 'Not mine', null, LIVE);
  const nobody = '00000000-0000-4000-8000-000000000000';

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = async (method: string, path: string, body?: any, tok = me.tok) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const txt = await r.text(); let j: any = null; try { j = JSON.parse(txt); } catch { j = txt; }
    return { s: r.status, j };
  };
  const ov = async (id: string) => (await one<any>(`SELECT availability_override FROM vod_assets WHERE id = $1`, [id]))!.availability_override ?? {};
  const bulk = (b: any, q = '', tok = me.tok) => call('POST', `/api/vod/bulk/availability${q}`, b, tok);
  const refusedOf = (j: any) => (j.refused ?? j.details?.refused ?? []).map((r: any) => [r.title, r.conflicts.map((c: any) => c.code)]).sort();
  const wait = async (f: () => Promise<boolean>) => { for (let i = 0; i < 50; i++) { if (await f()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

  try {
    // ---- what is asked
    check('no ids: 400', (await bulk({ ids: [], action: 'clear' })).s, 400);
    check('an unknown action: 400', (await bulk({ ids: [match], action: 'merge' })).s, 400);
    check('apply with nothing to apply: 400', (await bulk({ ids: [match], action: 'apply', override: {} })).s, 400);
    check('an unknown preset: 400', (await bulk({ ids: [match], action: 'apply', presetKey: 'gold' })).s, 400);

    // ---- a lock beneath refuses each title, nothing saved
    check('the account sets and locks the WAF profile', (await call('PUT', '/api/publishing-rules/account', { settings: { protection: { waf: 'standard' } }, lockedFields: ['protection.waf'] })).s, 200);
    let r = await bulk({ ids: [match, interview], action: 'apply', override: { protection: { waf: 'off' } } }, '?dryRun=1');
    check('dry run over a field the account locked: no title can take it, each named with the lock',
      [r.s, r.j.dryRun, r.j.canSave, r.j.ok, refusedOf(r.j), r.j.refused[0].conflicts[0].message, r.j.impact.assets],
      [200, true, false, 0, [['Draft match', ['locked_field']], ['Interview', ['locked_field']]], 'WAF profile is locked by the account default: it cannot be changed here.', 0]);
    r = await bulk({ ids: [match, interview], action: 'apply', override: { protection: { waf: 'off' } } });
    check('saving it: 422 policy_conflict with the refusals, nothing saved',
      [r.s, r.j.code, refusedOf(r.j).length, await ov(match), await ov(interview)], [422, 'policy_conflict', 2, {}, {}]);

    // ---- a type's lock refuses only that type's titles; the rest are saved and summed
    check('the Talk type sets and locks Access', (await call('PUT', `/api/publishing-rules/schema/${talk}`, { settings: { access: 'entitled' }, lockedFields: ['access'] })).s, 200);
    const ids = [match, final, interview, theirs, nobody, 'not-a-uuid'];
    r = await bulk({ ids, action: 'apply', override: { access: 'entitled' } }, '?dryRun=1');
    check('dry run of Access on four of mine, one of theirs and two unknown: two can take it, Interview refused by its type, the rest missing',
      [r.j.canSave, r.j.ok, refusedOf(r.j), r.j.refused[0].conflicts[0].message, r.j.missing.sort()],
      [true, 2, [['Interview', ['locked_field']]], 'Access is locked by the content type rule: it cannot be changed here.', [theirs, nobody, 'not-a-uuid'].sort()]);
    check('the impact is summed over the two that can: both change, one published and taking it up',
      [r.j.impact.assets, r.j.impact.changed, r.j.impact.published, r.j.impact.publishedChanged, r.j.impact.repackage], [2, 2, 1, 1, 0]);
    check('and the dry run saved nothing', [await ov(match), await ov(final)], [{}, {}]);
    r = await bulk({ ids, action: 'apply', override: { access: 'entitled' } });
    const stale = await one<any>(`SELECT (SELECT policy_stale_at IS NOT NULL FROM vod_assets WHERE id = $1) AS draft_marked`, [match]);
    check('saved: the two take the override, Interview and their title left as they were, one published title marked',
      [r.s, r.j.saved, r.j.ok, r.j.marked, await ov(match), await ov(final), await ov(interview), await ov(theirs), stale.draft_marked],
      [200, true, 2, 1, { access: 'entitled' }, { access: 'entitled' }, {}, {}, false]);
    check('the published title takes the change up through the restamp, without being published again',
      await wait(async () => (await one<any>(`SELECT availability->>'access' AS a, policy_stale_at FROM vod_assets WHERE id = $1`, [final]))?.a === 'entitled'), true);
    const audit = await one<any>(`SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1 AND entity_type = 'vod_asset' AND detail->'snapshot'->>'bulk' = 'true'`, [me.a]).catch(() => null);
    check('each saved title has its own audit entry', audit?.n ?? 'no audit table', 2);

    // ---- a conflict the override brings, per title
    check('Talk sets MP4 download off (no lock)', (await call('PUT', `/api/publishing-rules/schema/${talk}`, { settings: { access: 'entitled', distribution: { mp4Download: false } }, lockedFields: ['access'] })).s, 200);
    r = await bulk({ ids: [match, panel], action: 'apply', override: { protection: { drm: true } } }, '?dryRun=1');
    check('DRM on a sport title (MP4 allowed) and a talk title (MP4 off): only the sport one is refused, drm_mp4',
      [r.j.ok, refusedOf(r.j)], [1, [['Draft match', ['drm_mp4']]]]);

    // ---- a block from a title's own rights: refused, the impact over the rest
    check('the account unlocks its WAF profile', (await call('PUT', '/api/publishing-rules/account', { settings: { protection: { waf: 'standard' } }, lockedFields: [] })).s, 200);
    const windowed = (await one<any>(`INSERT INTO rights_profiles(account_id, name, window_kind, window_from, window_until) VALUES ($1,'Season rights','fixed', now() - interval '10 days', now() + interval '300 days') RETURNING id`, [me.a]))!.id;
    await query(`UPDATE vod_assets SET rights_profile_id = $2 WHERE id = $1`, [panel, windowed]);
    r = await bulk({ ids: [match, panel], action: 'apply', override: { protection: { waf: 'rights_managed' } } }, '?dryRun=1');
    check('a rights-managed WAF profile: the title with no rights window is refused, the one with a window can take it, impact over that one',
      [r.j.ok, refusedOf(r.j), r.j.impact.assets, r.j.impact.blocks.length], [1, [['Draft match', ['rights_managed_no_window']]], 1, 0]);

    // ---- DRM on published titles asks to confirm
    const drm = { protection: { drm: true }, distribution: { mp4Download: false } };
    r = await bulk({ ids: [final, match], action: 'apply', override: drm });
    check('DRM on one published and one draft title: 409 confirm_repackage with the count, nothing saved',
      [r.s, r.j.code, r.j.details?.impact?.repackage, r.j.error, await ov(final)],
      [409, 'confirm_repackage', 1, 'This changes DRM on 1 published title: their files must be packaged again. Send again with confirm to go ahead; they keep their current protection until then.', { access: 'entitled' }]);
    r = await bulk({ ids: [final, match], action: 'apply', override: drm, confirm: true });
    check('confirmed: both saved, the published one marked', [r.s, r.j.ok, r.j.marked, await ov(final), await ov(match)], [200, 2, 1, drm, drm]);

    // ---- a preset
    r = await bulk({ ids: [match], action: 'apply', presetKey: 'members' }, '?dryRun=1');
    const members = P.presetByKey('members')!.settings as any;
    check('a preset: its fields are the override, named in the answer', [r.s, r.j.presetKey, r.j.override.access, r.j.override.access === members.access], [200, 'members', members.access, true]);

    // ---- clear
    r = await bulk({ ids: [match, final, interview, panel], action: 'clear' });
    check('clearing takes DRM off a published title, so it asks to confirm too', [r.s, r.j.code, r.j.details?.impact?.repackage], [409, 'confirm_repackage', 1]);
    r = await bulk({ ids: [match, final, interview, panel], action: 'clear', confirm: true });
    check('clear: every title back to the rules, the published one marked again', [r.s, r.j.ok, r.j.refused, r.j.marked,
      await ov(match), await ov(final), await ov(interview), await ov(panel)], [200, 4, [], 1, {}, {}, {}, {}]);

    // ---- other accounts
    r = await bulk({ ids: [theirs], action: 'clear' }, '', them.tok);
    check('their own title is theirs to clear', [r.s, r.j.ok, r.j.missing], [200, 1, []]);
    r = await bulk({ ids: [theirs], action: 'apply', override: { access: 'free' } });
    check('mine cannot touch theirs: 422, missing, untouched', [r.s, r.j.details?.missing, await ov(theirs)], [422, [theirs], {}]);
  } finally {
    srv.close(); await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
