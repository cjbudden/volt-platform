// ============================================================================
//  THE LIFECYCLE IN THE ADMIN API (build queue P1-2, services/publicStatus.ts,
//  services/whoCanWatch.ts, modules/vod.ts).
//
//  Over real HTTP against a database: the public status, its reason and next
//  moment on GET /api/vod/:id and in the library list (a column, a filter, a
//  facet, Expires in N days); Listed from and Unlisted through
//  PUT /api/vod/:id/availability (a teaser at once on the play gate); Archive
//  and Restore (to draft and to published), audited, with their refusals; the
//  who-can-watch tester agreeing with the play gate for every status and for
//  region, sign-in and paywall refusals, and asking about another moment; and
//  tenancy and permissions on every new route.
//    DATABASE_URL=... npx tsx test/vod-lifecycle-api.check.ts
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};

(async () => {
  const P = await import('../src/services/publicStatus');
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { invalidateTag } = await import('../src/scale/cache');
  const tag = Date.now().toString(36);
  const mk = async (n: string) => {
    const a = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`lc-${n}-${tag}`]))!.id;
    const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `lc-${n}-${tag}@volt.test`]))!.id;
    return { a, u, tok: signAccess({ sub: u, account_id: a, role: 'owner' }) };
  };
  const me = await mk('me'), them = await mk('them');
  const vu = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','viewer','active') RETURNING id`, [me.a, `lc-viewer-${tag}@volt.test`]))!.id;
  const viewerTok = signAccess({ sub: vu, account_id: me.a, role: 'viewer' });
  const asset = async (o: { a: string }, title: string, set = '') => {
    const id = (await one<any>(
      `INSERT INTO vod_assets(account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms)
       VALUES ($1,'upload','clip',$2,'/clips/x/master.m3u8',0,60000,60000) RETURNING id`, [o.a, title]))!.id;
    if (set) await query(`UPDATE vod_assets SET ${set} WHERE id = $1`, [id]);
    await P.refreshPublicStatus(id);
    invalidateTag(`asset:${id}`);
    return id;
  };
  const LIVE_AS = (state: string, access = 'free', extra = '') => `availability_state = '${state}', published = true, availability = '{"targets":[{"kind":"portal"}],"access":"${access}"${extra}}'::jsonb, available_from = now() - interval '1 day'`;
  const LIVE = LIVE_AS('available');
  const SCHED = (days: number) => LIVE_AS('scheduled').replace("now() - interval '1 day'", `now() + interval '${days} days'`);

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = async (method: string, path: string, body?: any, tok = me.tok) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const txt = await r.text(); let j: any = null; try { j = JSON.parse(txt); } catch { j = txt; }
    return { s: r.status, j };
  };
  const raw = async (method: string, path: string, body?: any) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j: any = null; try { j = JSON.parse(t); } catch { j = t; }
    return { s: r.status, j };
  };
  const audits = async (id: string) => (await query<any>(`SELECT detail FROM audit_log WHERE entity_type = 'vod_asset' AND entity_id = $1 ORDER BY created_at`, [id])).map((r) => Object.keys(r.detail?.changes ?? {}).sort().join('+'));
  try {
    const app = (await call('POST', '/api/apps', { name: 'Web', type: 'web' })).j;
    const pk = app.publishableKey.key;
    const gate = (assetId: string, geo = 'AU') => raw('POST', '/api/availability', { appKey: pk, assetId, geo });
    const tester = (id: string, b: any = {}) => call('POST', `/api/vod/${id}/evaluate`, { country: 'AU', viewer: 'anonymous', ...b });

    // ---------------------------------------------------------------- the status on the asset and in the list
    const live = await asset(me, 'Lc Available', `${LIVE}, available_until = now() + interval '3 days'`);
    const det = (await call('GET', `/api/vod/${live}`)).j;
    check('GET /api/vod/:id: public status, reason, next moment, editorial state, window, visible and listed',
      [det.public_status, det.status_reason.startsWith('Available until'), !!det.status_until, det.editorial_state, !!det.effective_from, !!det.effective_until, det.publicly_visible, det.publicly_listed],
      ['available', true, true, 'published', true, true, true, true]);
    const draft = await asset(me, 'Lc Draft');
    const dd = (await call('GET', `/api/vod/${draft}`)).j;
    check('a draft: draft, not visible', [dd.public_status, dd.editorial_state, dd.publicly_visible, dd.status_reason], ['draft', 'draft', false, 'Draft: not published.']);
    const later = await asset(me, 'Lc Later', `${LIVE}, available_until = now() + interval '30 days'`);
    const fastOnly = (await call('POST', '/api/rights/profiles', { name: `FAST only ${tag}`, territoryMode: 'worldwide', territories: [], appMode: 'all', appTypes: [], appIds: [],
      uses: ['fast'], accessTypes: ['free'], window: { kind: 'open' } })).j;
    const restr = await asset(me, 'Lc Restricted', LIVE);
    await query(`UPDATE vod_assets SET rights_profile_id = $2 WHERE id = $1`, [restr, fastOnly.id]); await P.refreshPublicStatus(restr); invalidateTag(`asset:${restr}`);

    const lst = await call('GET', '/api/vod?limit=100');
    const row = (lst.j as any[]).find((r) => r.id === live);
    check('the list carries the status columns', [row?.public_status, !!row?.status_reason, !!row?.status_until, row?.editorial_state], ['available', true, true, 'published']);
    const byStatus = (await call('GET', '/api/vod?public_status=restricted&limit=100')).j as any[];
    check('filter: public_status=restricted', byStatus.map((r) => r.title), ['Lc Restricted']);
    const avail = (await call('GET', '/api/vod?public_status=available&sort=title&limit=100')).j as any[];
    check('filter: public_status=available', avail.map((r) => r.title), ['Lc Available', 'Lc Later']);
    const soon = (await call('GET', '/api/vod?expires_within_days=7&limit=100')).j as any[];
    check('Expires in 7 days: only the one ending in 3 days', soon.map((r) => r.title), ['Lc Available']);
    check('Expires in 60 days: both', ((await call('GET', '/api/vod?expires_within_days=60&sort=title&limit=100')).j as any[]).map((r) => r.title), ['Lc Available', 'Lc Later']);
    check('expires_within_days must be a sensible number', [(await call('GET', '/api/vod?expires_within_days=0')).s, (await call('GET', '/api/vod?expires_within_days=x')).s], [400, 400]);
    check('sort by the next moment works', (await call('GET', '/api/vod?public_status=available&sort=status_until&limit=10')).j.map((r: any) => r.title), ['Lc Available', 'Lc Later']);
    const fx = (await call('GET', '/api/vod/facets')).j;
    const fn = (k: string) => (fx.facets.public_status as any[]).find((x) => x.value === k)?.n ?? 0;
    check('facets: public_status counted', [fn('available'), fn('restricted'), fn('draft')], [2, 1, 1]);
    check('facets honour Expires in', ((await call('GET', '/api/vod/facets?expires_within_days=7')).j.facets.public_status as any[]).map((x) => `${x.value}:${x.n}`), ['available:1']);
    check('another account sees none of them', ((await call('GET', '/api/vod?limit=100', undefined, them.tok)).j as any[]).length, 0);

    // ---------------------------------------------------------------- Listed from and Unlisted
    const sch = await asset(me, 'Lc Scheduled', SCHED(2));
    check('scheduled with no listing: hidden on the gate', (await gate(sch)).s, 404);
    const put = await call('PUT', `/api/vod/${sch}/availability`, { listedFrom: new Date(Date.now() - 3600_000).toISOString() });
    const tz = await gate(sch);
    check('PUT listedFrom in the past: a teaser at once (403 scheduled, no token)',
      [put.s, put.j.public_status, put.j.publicly_visible, !!put.j.listedFrom, tz.s, tz.j.mode, 'playbackToken' in tz.j], [200, 'scheduled', true, true, 403, 'scheduled', false]);
    const unl = await call('PUT', `/api/vod/${live}/availability`, { unlisted: true });
    check('PUT unlisted: still plays, not listed', [unl.s, unl.j.unlisted, unl.j.publicly_visible, unl.j.publicly_listed, (await gate(live)).s], [200, true, true, false, 200]);
    await call('PUT', `/api/vod/${live}/availability`, { unlisted: false });
    const back = await call('PUT', `/api/vod/${sch}/availability`, { listedFrom: null });
    check('listedFrom: null goes back to the default: hidden again', [back.s, back.j.listedFrom, (await gate(sch)).s], [200, null, 404]);
    check('PUT with nothing to set: 400', (await call('PUT', `/api/vod/${sch}/availability`, {})).s, 400);
    check('PUT with an unknown field or a bad date: 422', [(await call('PUT', `/api/vod/${sch}/availability`, { listed: true })).s, (await call('PUT', `/api/vod/${sch}/availability`, { listedFrom: 'tomorrow' })).s], [422, 422]);
    check('Listed from and Unlisted are audited', (await audits(sch)).filter((x) => x === 'listed_from').length, 2);

    // ---------------------------------------------------------------- Archive and Restore
    const ar = await asset(me, 'Lc Archive me', LIVE);
    const a1 = await call('POST', `/api/vod/${ar}/archive`, { reason: 'season over' });
    check('archive: archived, who and when, not visible, the gate says unknown',
      [a1.s, a1.j.public_status, a1.j.editorial_state, !!a1.j.archivedAt, !!a1.j.archivedBy, a1.j.publicly_visible, (await gate(ar)).s], [200, 'archived', 'archived', true, true, false, 404]);
    check('archiving twice: 409', [(await call('POST', `/api/vod/${ar}/archive`)).s, (await call('POST', `/api/vod/${ar}/archive`)).j.code], [409, 'archived']);
    check('the archive is in the list filter', ((await call('GET', '/api/vod?public_status=archived&limit=100')).j as any[]).map((r) => r.title), ['Lc Archive me']);
    const r1 = await call('POST', `/api/vod/${ar}/unarchive`, {});
    check('restore (default): a draft, dates kept, still hidden', [r1.s, r1.j.public_status, r1.j.editorial_state, !!r1.j.effective_from, (await gate(ar)).s], [200, 'draft', 'draft', true, 404]);
    check('restore when not archived: 409', [(await call('POST', `/api/vod/${ar}/unarchive`, {})).s, (await call('POST', `/api/vod/${ar}/unarchive`, {})).j.code], [409, 'not_archived']);
    await call('POST', `/api/vod/${ar}/archive`);
    const r2 = await call('POST', `/api/vod/${ar}/unarchive`, { to: 'published' });
    check('restore to published: through publish, available, plays', [r2.s, r2.j.public_status, r2.j.editorial_state, (await gate(ar)).s], [200, 'available', 'published', 200]);
    check('restore takes draft or published only', (await call('POST', `/api/vod/${ar}/unarchive`, { to: 'live' })).s, 422);
    check('archive and restore are audited, from and to', (await audits(ar)).filter((x) => x === 'editorial_state+public_status').length, 4);
    const auditRow = (await one<any>(`SELECT detail FROM audit_log WHERE entity_type = 'vod_asset' AND entity_id = $1 ORDER BY created_at LIMIT 1`, [ar])).detail;
    check('the archive audit says from what, to what, and why', [auditRow.changes.editorial_state.from, auditRow.changes.editorial_state.to, auditRow.changes.public_status.to, auditRow.snapshot.reason],
      ['published', 'archived', 'archived', 'season over']);
    // Restoring to published when publishing refuses: out of the archive as a draft, 409 with the reason.
    // A rights profile that keeps it off on demand: publish refuses.
    const nomedia = await asset(me, 'Lc Not cleared', LIVE);
    await query(`UPDATE vod_assets SET rights_profile_id = $2 WHERE id = $1`, [nomedia, fastOnly.id]);
    await call('POST', `/api/vod/${nomedia}/archive`);
    const r3 = await call('POST', `/api/vod/${nomedia}/unarchive`, { to: 'published' });
    check('restore to published refused: 409, back as a draft, says why',
      [r3.s, r3.j.code, r3.j.editorial_state, r3.j.public_status, /^Restored as a draft/.test(r3.j.error ?? '')], [409, 'not_publishable', 'draft', 'draft', true]);

    // ---------------------------------------------------------------- who can watch, against the gate
    const statuses: Record<string, string> = {
      draft: '', in_review: `review_state = 'in_review'`, changes_requested: `review_state = 'changes_requested'`, rejected: `review_state = 'rejected'`,
      processing: `${LIVE}, media_state = 'processing'`, expired: LIVE_AS('expired'), archived: `${LIVE}, archived_at = now()`,
      scheduled: SCHED(1), teaser: `${SCHED(1)}, listed_from = now() - interval '1 hour'`, available: LIVE, unlisted: `${LIVE}, unlisted = true`,
      region: LIVE_AS('available', 'free', ',"geo":{"mode":"allow","countries":["NZ"]}'), paid: LIVE_AS('available', 'paid'),
    };
    const agree: string[] = [], want: string[] = [];
    for (const [name, set] of Object.entries(statuses)) {
      const id = await asset(me, `Lc who ${name}`, set);
      const [g, t] = [await gate(id), await tester(id)];
      agree.push(`${name}:${t.j.http}:${t.j.outcome}`);
      want.push(`${name}:${g.s}:${g.s === 200 ? 'play' : g.s === 404 ? 'not_found' : g.j.mode === 'scheduled' ? 'teaser' : g.j.mode}`);
    }
    // the restricted title made above, by its rights
    agree.push(`restricted:${(await tester(restr)).j.http}`); want.push(`restricted:${(await gate(restr)).s}`);
    check('who can watch agrees with the play gate for every status and refusal', agree, want);
    check('...and those answers are the expected ones', agree.map((x) => x.split(':').slice(0, 2).join(':')),
      ['draft:404', 'in_review:404', 'changes_requested:404', 'rejected:404', 'processing:404', 'expired:404', 'archived:404', 'scheduled:404', 'teaser:403', 'available:200', 'unlisted:200', 'region:451', 'paid:402', 'restricted:404']);
    const region = (await query<any>(`SELECT id FROM vod_assets WHERE title = 'Lc who region' AND account_id = $1`, [me.a]))[0].id;
    const nz = await tester(region, { country: 'NZ' });
    check('the same title from the allowed country plays, and the gate agrees', [nz.j.http, (await gate(region, 'NZ')).s], [200, 200]);
    const paid = (await query<any>(`SELECT id FROM vod_assets WHERE title = 'Lc who paid' AND account_id = $1`, [me.a]))[0].id;
    const pt = await tester(paid, { viewer: 'entitled' });
    check('a viewer who has paid plays the paid title', [pt.j.http, pt.j.outcome], [200, 'play']);
    const hid = (await tester(draft)).j;
    check('a hidden title says why, decided by the status', [hid.decidedBy, hid.status.publicStatus, hid.message.startsWith('Not public'), hid.notChecked.length > 0], ['status', 'draft', true, true]);
    // another moment
    const fut = await tester(sch, { at: new Date(Date.now() + 3 * 86400_000).toISOString() });
    check('a scheduled title, asked about a moment inside its window: plays', [fut.j.http, fut.j.status.publicStatus], [200, 'available']);
    const past = await tester(live, { at: new Date(Date.now() + 4 * 86400_000).toISOString() });
    check('an available title, asked about after its end: expired, hidden', [past.j.http, past.j.status.publicStatus], [404, 'expired']);
    const app2 = (await call('POST', '/api/apps', { name: 'TV', type: 'tv' })).j;
    check('the tester takes an app of this account', (await tester(live, { appId: app2.id })).s, 200);
    check('...and refuses another account\'s app', (await call('POST', `/api/vod/${live}/evaluate`, { appId: (await call('POST', '/api/apps', { name: 'X', type: 'web' }, them.tok)).j.id })).s, 400);
    check('a bad country or viewer kind: 422', [(await tester(live, { country: 'Australia' })).s, (await tester(live, { viewer: 'vip' })).s], [422, 422]);
    check('the tester changes nothing (no audit, status as it was)', [(await audits(live)).filter((x) => x === '').length, (await call('GET', `/api/vod/${live}`)).j.public_status], [0, 'available']);

    // ---------------------------------------------------------------- tenancy and permissions
    const mine = live;
    const theirs = await Promise.all([
      call('GET', `/api/vod/${mine}`, undefined, them.tok), call('PUT', `/api/vod/${mine}/availability`, { unlisted: true }, them.tok),
      call('POST', `/api/vod/${mine}/archive`, {}, them.tok), call('POST', `/api/vod/${mine}/unarchive`, {}, them.tok), call('POST', `/api/vod/${mine}/evaluate`, {}, them.tok)]);
    check('another account: 404 on every new route, and nothing changed', [theirs.map((x) => x.s), (await call('GET', `/api/vod/${mine}`)).j.public_status, (await call('GET', `/api/vod/${mine}`)).j.unlisted],
      [[404, 404, 404, 404, 404], 'available', false]);
    const vw = [await call('POST', `/api/vod/${mine}/evaluate`, { country: 'AU' }, viewerTok), await call('POST', `/api/vod/${mine}/archive`, {}, viewerTok),
      await call('PUT', `/api/vod/${mine}/availability`, { unlisted: true }, viewerTok), await call('POST', `/api/vod/${mine}/unarchive`, {}, viewerTok)];
    check('a Viewer role may test who can watch, but not archive, restore or change the listing', vw.map((x) => x.s), [200, 403, 403, 403]);
  } catch (e: any) {
    console.log('FAIL unexpected error -- ' + (e?.stack ?? e)); fail++;
  } finally {
    srv.close();
    await pool.end().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
