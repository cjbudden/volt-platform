// ============================================================================
//  THE ASSET RUNG'S CHECKS (build queue P3-2b): PATCH /api/vod/:id/availability
//  (modules/vod.ts) and policyImpact's asset scope (services/publishingPolicies.ts).
//
//  A title's own override of a field a rung beneath it locked is refused with
//  422 policy_conflict naming the lock (before this it was saved and then
//  ignored when resolved), for a field the account locked, one it locked after the
//  title set it, and a type's lock; ?dryRun=1 answers the same with the impact on the title and
//  saves nothing; an unlocked field saves; a conflict the override brings
//  (DRM with MP4 download) is refused, one the rungs beneath already had is
//  not charged to it; DRM on a published title asks to confirm (409) and is
//  then applied at once; back to the ladder ({}) always saves; a bare body
//  with confirm; another account's title.
//    DATABASE_URL=... npx tsx test/publishing-asset-rung.check.ts
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
  const tag = Date.now().toString(36);
  const mk = async (n: string) => {
    const a = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`ar-${n}-${tag}`]))!.id;
    const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `ar-${n}-${tag}@volt.test`]))!.id;
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
  const draft = await asset(me.a, 'Draft match', sport), live = await asset(me.a, 'Final', sport, LIVE), interview = await asset(me.a, 'Interview', talk);
  const theirs = await asset(them.a, 'Not mine', null, LIVE);

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = async (method: string, path: string, body?: any, tok = me.tok) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const txt = await r.text(); let j: any = null; try { j = JSON.parse(txt); } catch { j = txt; }
    return { s: r.status, j };
  };
  const ov = async (id: string) => (await one<any>(`SELECT availability_override FROM vod_assets WHERE id = $1`, [id]))!.availability_override ?? {};
  const patch = (id: string, override: any, q = '', tok = me.tok) => call('PATCH', `/api/vod/${id}/availability${q}`, { override }, tok);

  try {
    // ---- the account locks the WAF profile
    check('the account sets and locks the WAF profile', (await call('PUT', '/api/publishing-rules/account', { settings: { protection: { waf: 'standard' } }, lockedFields: ['protection.waf'] })).s, 200);
    let r = await patch(draft, { protection: { waf: 'off' } });
    check('a title overriding the locked WAF profile: 422 policy_conflict naming the lock, nothing saved',
      [r.s, r.j.code, r.j.error, r.j.details?.conflicts?.map((c: any) => [c.code, c.fields]), await ov(draft)],
      [422, 'policy_conflict', 'WAF profile is locked by the account default: it cannot be changed here.', [['locked_field', ['protection.waf']]], {}]);
    r = await patch(draft, { protection: { waf: 'off' } }, '?dryRun=1');
    check('the dry run says the same and saves nothing', [r.s, r.j.dryRun, r.j.saved, r.j.canSave, r.j.conflicts.map((c: any) => c.code), r.j.impact.assets, await ov(draft)],
      [200, true, false, false, ['locked_field'], 1, {}]);
    r = await patch(draft, { protection: { waf: 'standard' } });
    check('restating the locked value is still an override of a locked field: refused', [r.s, r.j.code], [422, 'policy_conflict']);

    // ---- an unlocked field
    r = await patch(draft, { distribution: { shareLinks: false } }, '?dryRun=1');
    check('dry run of an unlocked field: can save, this one title, it changes, not published',
      [r.s, r.j.canSave, r.j.conflicts, r.j.impact.assets, r.j.impact.changed, r.j.impact.published, r.j.impact.repackage, await ov(draft)], [200, true, [], 1, 1, 0, 0, {}]);
    r = await patch(draft, { distribution: { shareLinks: false } });
    check('saved', [r.s, r.j.warnings, await ov(draft)], [200, [], { distribution: { shareLinks: false } }]);
    r = await patch(draft, { distribution: { shareLinks: false } }, '?dryRun=1');
    check('the same again changes nothing', [r.j.canSave, r.j.impact.changed], [true, 0]);

    // ---- a second lock on the account, and a type's lock
    check('the account also locks share links', (await call('PUT', '/api/publishing-rules/account', { settings: { protection: { waf: 'standard' } }, lockedFields: ['protection.waf', 'distribution.shareLinks'] })).s, 200);
    r = await patch(draft, { distribution: { shareLinks: false } });
    check('now the title\'s saved share-links override is refused when sent again, and kept as it was', [r.s, r.j.error, await ov(draft)],
      [422, 'Share links is locked by the account default: it cannot be changed here.', { distribution: { shareLinks: false } }]);
    check('cleared from the title, it saves', [(await patch(draft, {})).s, await ov(draft)], [200, {}]);
    await call('PUT', '/api/publishing-rules/account', { settings: { protection: { waf: 'standard' } }, lockedFields: ['protection.waf'] });
    check('the content type sets and locks Access', (await call('PUT', `/api/publishing-rules/schema/${talk}`, { settings: { access: 'entitled' }, lockedFields: ['access'] })).s, 200);
    r = await patch(interview, { access: 'free' });
    check('a title of that type overriding Access: refused, naming the content type rule', [r.s, r.j.error], [422, 'Access is locked by the content type rule: it cannot be changed here.']);
    r = await patch(draft, { access: 'free' });
    check('a title of another type may', [r.s, (await ov(draft)).access], [200, 'free']);

    // ---- conflicts the override brings
    r = await patch(draft, { protection: { drm: true } });
    check('DRM while MP4 download is allowed: 422 drm_mp4, nothing saved', [r.s, r.j.details?.conflicts?.map((c: any) => c.code), (await ov(draft)).protection], [422, ['drm_mp4'], undefined]);
    r = await patch(draft, { protection: { drm: true }, distribution: { mp4Download: false } });
    check('DRM with MP4 off on a draft: saved, nothing to package again', [r.s, (await ov(draft)).protection, r.j.reapplied], [200, { drm: true }, false]);

    // ---- a published title
    r = await patch(live, { protection: { drm: true }, distribution: { mp4Download: false } }, '?dryRun=1');
    check('the dry run on a published title: published, changes, one to package again',
      [r.j.canSave, r.j.impact.published, r.j.impact.changed, r.j.impact.repackage, r.j.impact.publishedChanged], [true, 1, 1, 1, 1]);
    r = await patch(live, { protection: { drm: true }, distribution: { mp4Download: false } });
    check('DRM on a published title: 409 confirm_repackage, nothing saved', [r.s, r.j.code, r.j.details?.impact?.repackage, await ov(live)], [409, 'confirm_repackage', 1, {}]);
    r = await call('PATCH', `/api/vod/${live}/availability`, { override: { protection: { drm: true }, distribution: { mp4Download: false } }, confirm: true });
    const stamp = await one<any>(`SELECT availability FROM vod_assets WHERE id = $1`, [live]);
    check('confirmed: saved and applied to the published title at once', [r.s, r.j.reapplied, (await ov(live)).protection, stamp.availability?.protection?.drm], [200, true, { drm: true }, true]);
    r = await call('PATCH', `/api/vod/${live}/availability`, { distribution: { shareLinks: false }, confirm: true });
    check('a bare body with confirm beside it: confirm is not taken as a setting', [r.s, await ov(live)], [200, { distribution: { shareLinks: false } }]);

    // ---- a problem the rungs beneath already have is not charged to the title
    await query(`UPDATE publishing_rules SET settings = settings || '{"geo":{"mode":"allow","countries":[]}}'::jsonb WHERE account_id = $1 AND scope_kind = 'account'`, [me.a]);
    r = await patch(draft, { distribution: { shareLinks: true } }, '?dryRun=1');
    check('the account already has an empty country list: the title is not blamed for it', [r.j.canSave, r.j.conflicts.map((c: any) => c.code)], [true, []]);

    // ---- back to the ladder, and other accounts
    r = await patch(interview, {});
    check('back to the ladder ({}) always saves', [r.s, await ov(interview)], [200, {}]);
    check('another account\'s title: 404', [(await patch(theirs, { access: 'free' })).s, (await patch(theirs, {}, '?dryRun=1')).s], [404, 404]);
    check('their title untouched', await ov(theirs), {});
  } finally {
    srv.close(); await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
