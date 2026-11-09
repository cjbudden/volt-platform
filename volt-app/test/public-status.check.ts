// ============================================================================
//  PUBLIC STATUS AND THE PUBLIC VISIBILITY RULE (build queue P1,
//  services/publicStatus.ts, migrations 0148 and 0149, PUBLISHING_POLICIES.md).
//
//  Pure: every public status and its reason and next moment, from the editorial
//  state, review, media, the publish window and the rights (which always
//  narrow); the transitions of one asset over time; which statuses are visible
//  and listed. Then over real HTTP against a database: every hidden status is
//  answered by the play gate (POST and GET) and the access check exactly as an
//  unknown id; an Available title plays (unlisted too, by link); a Scheduled
//  title past its Listed from date is a teaser with no token; publish,
//  withdraw, archive and restore store the status at once; the sweep moves a
//  title whose window ends and fills rows never computed; a rights profile
//  change sends its assets back to the sweep; the catalogue SQL filter; and a
//  warm play gate makes no database reads, the on-demand ad lookup included,
//  with and without an ad rule (VA-cache, migration 0150).
//    DATABASE_URL=... npx tsx test/public-status.check.ts
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};

(async () => {
  const P = await import('../src/services/publicStatus');
  const R = await import('../src/services/rightsProfiles');

  // ---------------------------------------------------------------- pure
  const now = new Date('2026-11-10T12:00:00Z');
  const h = (n: number) => new Date(now.getTime() + n * 3600_000);
  const open = R.OPEN;
  const pub = { availability_state: 'available', published: true, master_key: 'k', media_state: 'ready', review_state: 'approved' };
  const st = (row: any, rights = open, at = now) => P.computePublicStatus(row, rights, at);
  const sOf = (row: any, rights = open, at = now) => st(row, rights, at).status;

  check('a new asset is a draft', [sOf({ availability_state: 'draft' }), st({ availability_state: 'draft' }).editorial], ['draft', 'draft']);
  check('a draft by its review state', ['in_review', 'changes_requested', 'rejected', 'approved'].map((r) => sOf({ availability_state: 'draft', review_state: r })),
    ['in_review', 'changes_requested', 'rejected', 'draft']);
  const wd = st({ availability_state: 'withdrawn', withdrawn_by: 'Ana', available_from: h(-5) });
  check('withdrawn is back to draft, says who, keeps its dates', [wd.status, wd.editorial, wd.reason.includes('Ana'), wd.effectiveFrom?.toISOString()], ['draft', 'draft', true, h(-5).toISOString()]);
  check('published but the media is being made: processing', sOf({ ...pub, media_state: 'processing' }), 'processing');
  check('published but the media failed, is missing or unplayable: not public', ['failed', 'missing', 'unplayable'].map((m) => sOf({ ...pub, media_state: m })), ['processing', 'processing', 'processing']);
  check('published with no manifest yet: processing', sOf({ ...pub, master_key: null }), 'processing');
  const sch = st({ ...pub, availability_state: 'scheduled', available_from: h(6) });
  check('before the window: scheduled, changes when it opens', [sch.status, sch.until?.toISOString(), sch.editorial], ['scheduled', h(6).toISOString(), 'published']);
  const tz = st({ ...pub, availability_state: 'scheduled', available_from: h(6), listed_from: h(2) });
  check('a teaser: the next moment is its Listed from date', [tz.status, tz.until?.toISOString(), tz.listedFrom?.toISOString()], ['scheduled', h(2).toISOString(), h(2).toISOString()]);
  const av = st({ ...pub, available_from: h(-1), available_until: h(48) });
  check('inside the window: available until its end', [av.status, av.until?.toISOString(), av.reason.startsWith('Available until')], ['available', h(48).toISOString(), true]);
  check('no end: available with no next moment', st({ ...pub, available_from: h(-1) }).until, null);
  check('assets from before availability (draft, published = true) stay available', sOf({ availability_state: 'draft', published: true, master_key: 'k' }), 'available');
  check('the window has closed: expired', [sOf({ ...pub, available_until: h(-1) }), sOf({ ...pub, availability_state: 'expired' })], ['expired', 'expired']);
  check('archived wins over everything', [sOf({ ...pub, archived_at: h(-1) }), st({ availability_state: 'draft', archived_at: h(-1) }).editorial], ['archived', 'archived']);

  // the rights, which always narrow
  const prof = (o: any) => R.effectiveRights({ id: 'p', account_id: 'a', name: 'Pacific', builtin: null, provider: null, takedown_contact: null, agreement_ref: null,
    territory_mode: 'worldwide', territories: [], app_mode: 'all', app_types: [], app_ids: [], uses: ['on_demand'], access_types: ['free'],
    window_kind: 'open', window_from: null, window_until: null, relative_count: null, relative_unit: null, relative_from: null, warn_days: 30, agreement: null, ...o }, {});
  const early = prof({ window_kind: 'fixed', window_from: h(-100).toISOString(), window_until: h(24).toISOString() });
  const nar = st({ ...pub, available_from: h(-1), available_until: h(48) }, early);
  check('the rights end before the publish window: available until the rights end', [nar.status, nar.until?.toISOString(), nar.effectiveUntil?.toISOString()], ['available', h(24).toISOString(), h(24).toISOString()]);
  check('after the rights end, inside the publish window: restricted', sOf({ ...pub, available_from: h(-1), available_until: h(48) }, early, h(30)), 'restricted');
  const late = prof({ window_kind: 'fixed', window_from: h(3).toISOString(), window_until: null });
  const gap = st({ ...pub, available_from: h(-1) }, late);
  check('publish window open, rights not yet: restricted until they open', [gap.status, gap.until?.toISOString()], ['restricted', h(3).toISOString()]);
  const both = st({ ...pub, availability_state: 'scheduled', available_from: h(1) }, late);
  check('scheduled: the window a viewer gets starts with the rights', [both.status, both.effectiveFrom?.toISOString(), both.until?.toISOString()], ['scheduled', h(3).toISOString(), h(1).toISOString()]);
  check('rights that keep it off on demand: restricted', sOf(pub, prof({ uses: ['fast'] })), 'restricted');
  check('All restricted: restricted', st(pub, prof({ uses: [] })).reason.includes('allow no use'), true);
  check('an allow-list with no territory: restricted', sOf(pub, prof({ territory_mode: 'allow', territories: [] })), 'restricted');
  check('a territory list is not a status: available (the gate refuses by country)', sOf(pub, prof({ territory_mode: 'allow', territories: ['AU'] })), 'available');

  // one asset over time
  const life = { ...pub, availability_state: 'scheduled', available_from: h(2), available_until: h(10), listed_from: h(1) };
  check('one asset over time: scheduled, teaser, available, expired',
    [h(0), h(1), h(2), h(9), h(10)].map((t) => { const s = st(life, open, t); return `${s.status}:${P.publiclyVisible(s, t)}`; }),
    ['scheduled:false', 'scheduled:true', 'available:true', 'available:true', 'expired:false']);

  // visible and listed
  const vis = (row: any) => { const s = st(row); return [P.publiclyVisible(s, now), P.publiclyListed(s, now)]; };
  check('hidden statuses are never visible', ['draft', 'in_review', 'changes_requested', 'rejected'].map((r) => vis({ availability_state: 'draft', review_state: r })[0])
    .concat([vis({ ...pub, media_state: 'processing' })[0], vis(pub as any)[0] && vis({ ...pub, archived_at: h(-1) })[0], vis({ ...pub, availability_state: 'expired' })[0], vis({ ...pub, availability_state: 'scheduled', available_from: h(3) })[0]]),
    [false, false, false, false, false, false, false, false]);
  check('restricted is never visible', P.publiclyVisible(st(pub, prof({ uses: [] })), now), false);
  check('available: visible and listed; unlisted: visible, not listed', [vis(pub), vis({ ...pub, unlisted: true })], [[true, true], [true, false]]);
  check('scheduled past Listed from: visible and listed', vis({ ...pub, availability_state: 'scheduled', available_from: h(3), listed_from: h(-1) }), [true, true]);

  // ---------------------------------------------------------------- database
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { invalidateTag } = await import('../src/scale/cache');
  const A = await import('../src/services/availability');
  const tag = Date.now().toString(36);
  const mk = async (n: string) => {
    const a = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`ps-${n}-${tag}`]))!.id;
    const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `ps-${n}-${tag}@volt.test`]))!.id;
    return { a, u, tok: signAccess({ sub: u, account_id: a, role: 'owner' }) };
  };
  const me = await mk('me'), them = await mk('them');
  const asset = async (o: { a: string }, title: string, set = '') => {
    const id = (await one<any>(
      `INSERT INTO vod_assets(account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms)
       VALUES ($1,'upload','clip',$2,'/clips/x/master.m3u8',0,60000,60000) RETURNING id`, [o.a, title]))!.id;
    if (set) await query(`UPDATE vod_assets SET ${set} WHERE id = $1`, [id]);
    await P.refreshPublicStatus(id);
    invalidateTag(`asset:${id}`);
    return id;
  };
  const LIVE_AS = (state: string) => `availability_state = '${state}', published = true, availability = '{"targets":[{"kind":"portal"}],"access":"free"}'::jsonb, available_from = now() - interval '1 day'`;
  const LIVE = LIVE_AS('available');
  const stored = async (id: string) => (await one<any>(`SELECT public_status, status_reason, status_until FROM vod_assets WHERE id = $1`, [id]))!;

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = async (method: string, path: string, body?: any, tok = me.tok) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const txt = await r.text(); let j: any = null; try { j = JSON.parse(txt); } catch { j = txt; }
    return { s: r.status, j };
  };
  const raw = async (method: string, path: string, body?: any) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, t: await r.text() };
  };
  try {
    const cols = await query<any>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'vod_assets'
      AND column_name IN ('listed_from','unlisted','archived_at','archived_by','public_status','status_reason','status_until','status_at') ORDER BY 1`);
    check('migration 0148: the lifecycle and status columns', cols.map((c) => c.column_name), ['archived_at', 'archived_by', 'listed_from', 'public_status', 'status_at', 'status_reason', 'status_until', 'unlisted']);
    check('migration 0149: the index on the next moment', !!(await one(`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_vod_assets_status_until'`)), true);

    const app = (await call('POST', '/api/apps', { name: 'Web', type: 'web' })).j;
    const pk = app.publishableKey.key;
    const gatePost = (assetId: string) => raw('POST', '/api/availability', { appKey: pk, assetId, geo: 'AU' });
    const gateGet = (assetId: string) => raw('GET', `/api/availability?appKey=${encodeURIComponent(pk)}&assetId=${assetId}&geo=AU`);
    const gatePublic = (assetId: string) => raw('POST', '/api/public/availability', { appKey: pk, assetId, geo: 'AU' });
    const access = (assetId: string) => raw('POST', '/api/access/check', { appKey: pk, assetId, geo: 'AU' });
    const unknown = '00000000-0000-4000-8000-00000000abcd';
    const [u1, u2, u3, u4] = [await gatePost(unknown), await gateGet(unknown), await gatePublic(unknown), await access(unknown)];
    check('an unknown id: 404 on every route', [u1.s, u2.s, u3.s, u4.s], [404, 404, 404, 404]);

    // ---- every hidden status, on every public route, exactly as an unknown id
    const hidden: Record<string, string> = {
      draft: '',
      in_review: `review_state = 'in_review'`,
      changes_requested: `review_state = 'changes_requested'`,
      rejected: `review_state = 'rejected'`,
      processing: `${LIVE}, media_state = 'processing'`,
      restricted: `${LIVE}, rights_narrow = '{"uses":["fast"]}'::jsonb`,
      expired: LIVE_AS('expired'),
      archived: `${LIVE}, archived_at = now()`,
      withdrawn: `availability_state = 'withdrawn', withdrawn_at = now(), withdrawn_by = 'test'`,
      scheduled: `${LIVE_AS('scheduled').replace("now() - interval '1 day'", "now() + interval '1 day'")}`,
    };
    // A rights profile that keeps titles off on demand, for the restricted one.
    const fastOnly = (await call('POST', '/api/rights/profiles', { name: `FAST only ${tag}`, territoryMode: 'worldwide', territories: [], appMode: 'all', appTypes: [], appIds: [],
      uses: ['fast'], accessTypes: ['free'], window: { kind: 'open' } })).j;
    for (const [name, set] of Object.entries(hidden)) {
      const id = await asset(me, `Hidden ${name}`, set);
      if (name === 'restricted') { await query(`UPDATE vod_assets SET rights_profile_id = $2, rights_narrow = NULL WHERE id = $1`, [id, fastOnly.id]); await P.refreshPublicStatus(id); invalidateTag(`asset:${id}`); }
      const want = name === 'withdrawn' ? 'draft' : name;
      const r = [await gatePost(id), await gateGet(id), await gatePublic(id), await access(id)];
      check(`${name}: stored as ${want}, and every public route answers as for an unknown id`,
        [(await stored(id)).public_status, r.map((x) => x.s), r[0].t === u1.t && r[1].t === u2.t && r[2].t === u3.t && r[3].t === u4.t],
        [want, [404, 404, 404, 404], true]);
    }

    // ---- what is public
    const live = await asset(me, 'Available', LIVE);
    const lp = await gatePost(live), lg = await gateGet(live), la = await access(live);
    check('available: plays, with a token, on POST, GET and the access check',
      [(await stored(live)).public_status, lp.s, !!JSON.parse(lp.t).playbackToken, lg.s, JSON.parse(la.t).allowed], ['available', 200, true, 200, true]);
    const unl = await asset(me, 'Unlisted', `${LIVE}, unlisted = true`);
    check('unlisted: still plays by link', [(await gatePost(unl)).s, (await stored(unl)).public_status], [200, 'available']);
    const teaser = await asset(me, 'Teaser', `${LIVE_AS('scheduled').replace("now() - interval '1 day'", "now() + interval '2 days'")}, listed_from = now() - interval '1 hour'`);
    const tp = await gatePost(teaser), tg = await gateGet(teaser), ta = await access(teaser);
    const tj = JSON.parse(tp.t);
    check('scheduled past Listed from: a teaser, 403 scheduled, when and what, no token',
      [tp.s, tj.mode, !!tj.availableFrom, tj.meta?.title, 'playbackToken' in tj, 'delivery' in tj, tg.s, JSON.parse(ta.t).mode, JSON.parse(ta.t).allowed],
      [403, 'scheduled', true, 'Teaser', false, false, 403, 'scheduled', false]);
    const theirs = await asset(them, 'Theirs', LIVE);
    check('another account\'s available title: 404 as before', (await gatePost(theirs)).s, 404);

    // ---- the editorial actions store the status at once
    const d1 = await asset(me, 'Publish me');
    check('a new upload is stored as draft', (await stored(d1)).public_status, 'draft');
    const out = await A.publish(d1, 'test');
    check('publish: available at once, and the gate plays it', [out.state, (await stored(d1)).public_status, (await gatePost(d1)).s], ['available', 'available', 200]);
    await A.withdraw(d1, 'test', 'legal');
    check('withdraw: back to draft at once, and the gate says unknown', [(await stored(d1)).public_status, (await gatePost(d1)).s], ['draft', 404]);
    await A.republish(d1, 'test');
    const arc = await P.archiveAsset(d1, 'test');
    const ar = await one<any>(`SELECT archived_by, published, (SELECT count(*)::int FROM publications WHERE vod_asset_id = $1 AND status = 'published') AS live FROM vod_assets WHERE id = $1`, [d1]);
    check('archive: archived, publications withdrawn, unknown to the gate', [arc?.status, (await stored(d1)).public_status, ar.archived_by, ar.published, ar.live, (await gatePost(d1)).s],
      ['archived', 'archived', 'test', false, 0, 404]);
    const back = await P.unarchiveAsset(d1, 'test', 'draft');
    check('restore to draft: draft, dates kept, still not public', [back?.status, back?.editorial, (await gatePost(d1)).s], ['draft', 'draft', 404]);
    await P.archiveAsset(d1, 'test');
    const back2 = await P.unarchiveAsset(d1, 'test', 'published');
    check('restore to published: through publish again, available', [back2?.status, (await gatePost(d1)).s], ['available', 200]);
    check('restoring an asset that is not archived does nothing', await P.unarchiveAsset(d1, 'test', 'draft'), null);
    const lst = await P.setListing(teaser, { unlisted: true });
    check('setListing: unlisted kept, status unchanged', [lst?.unlisted, lst?.status], [true, 'scheduled']);

    // ---- the sweep
    const ending = await asset(me, 'Ending', `${LIVE}, available_until = now() + interval '1 hour'`);
    check('stored available with its end as the next moment', [(await stored(ending)).public_status, !!(await stored(ending)).status_until], ['available', true]);
    await query(`UPDATE vod_assets SET available_until = now() - interval '1 second', status_until = now() - interval '1 second' WHERE id = $1`, [ending]);
    // Rows untouched by the sweep's clock keep their stored answer until it runs.
    const sw = await A.sweepAvailability();
    check('the sweep closes the window and stores expired', [(await stored(ending)).public_status, (sw.statuses ?? 0) >= 1], ['expired', true]);
    const never = await asset(me, 'Never computed', LIVE);
    await query(`UPDATE vod_assets SET public_status = NULL, status_at = NULL WHERE id = $1`, [never]);
    await A.sweepAvailability();
    check('rows from before this existed are computed by the sweep', (await stored(never)).public_status, 'available');
    await query(`UPDATE vod_assets SET media_state = 'processing', updated_at = now() + interval '1 second' WHERE id = $1`, [never]);
    await A.sweepAvailability();
    check('a row changed since it was computed is computed again', (await stored(never)).public_status, 'processing');

    // ---- a rights profile change sends its assets back to the sweep
    const pacific = (await call('POST', '/api/rights/profiles', { name: `Pacific ${tag}`, territoryMode: 'worldwide', territories: [], appMode: 'all', appTypes: [], appIds: [],
      uses: ['on_demand'], accessTypes: ['free'], window: { kind: 'open' } })).j;
    const rt = await asset(me, 'Rights change', LIVE);
    await query(`UPDATE vod_assets SET rights_profile_id = $2 WHERE id = $1`, [rt, pacific.id]);
    await P.refreshPublicStatus(rt);
    check('under an open profile: available', (await stored(rt)).public_status, 'available');
    const put = await call('PUT', `/api/rights/profiles/${pacific.id}`, { name: `Pacific ${tag}`, territoryMode: 'worldwide', territories: [], appMode: 'all', appTypes: [], appIds: [],
      uses: ['fast'], accessTypes: ['free'], window: { kind: 'open' } });
    check('changing the profile marks its assets for the sweep', [put.s, (await one<any>(`SELECT status_at FROM vod_assets WHERE id = $1`, [rt])).status_at], [200, null]);
    await A.sweepAvailability();
    check('and the sweep stores restricted', (await stored(rt)).public_status, 'restricted');
    check('the gate already says unknown (it computes from the cached row and profile)', (await gatePost(rt)).s, 404);

    // ---- the catalogue filter on the stored status
    const listed = await query<any>(`SELECT v.title FROM vod_assets v WHERE v.account_id = $1 AND ${P.publicListSql('v')} ORDER BY v.title`, [me.a]);
    check('the catalogue SQL lists only available and listed teasers, never unlisted or hidden', listed.map((r) => r.title), ['Available', 'Publish me']);
    await query(`UPDATE vod_assets SET unlisted = false WHERE id = $1`, [teaser]);
    check('a teaser past Listed from is listed', (await query<any>(`SELECT v.title FROM vod_assets v WHERE v.id = $1 AND ${P.publicListSql('v')}`, [teaser])).length, 1);
    await query(`UPDATE vod_assets SET status_until = now() - interval '1 second' WHERE id = $1`, [live]);
    check('an available row past its next moment is out of the list before the sweep runs',
      (await query<any>(`SELECT 1 FROM vod_assets v WHERE v.id = $1 AND ${P.publicListSql('v')}`, [live])).length, 0);
    await query(`UPDATE vod_assets SET status_until = NULL WHERE id = $1`, [live]);

    // ---- scale: a warm play gate makes no database reads
    const warm = await asset(me, 'Warm', LIVE);
    await gateGet(warm); await gateGet(warm);
    // The on-demand ad lookup (services/vodAds adsForPlay: the asset and its
    // rule) is cached too since VA-cache, so every read is counted, and the ad
    // queries on their own as well.
    let reads = 0, adReads = 0;
    const orig = (pool as any).query.bind(pool);
    const counting = () => { reads = 0; adReads = 0; (pool as any).query = (...a: any[]) => { reads++; if (/vod_ad_rules|break_cues_ms/.test(String(a[0]))) adReads++; return orig(...a); }; };
    counting();
    const w1 = await gateGet(warm), w2 = await gatePost(warm);
    const availReads = reads, availAdReads = adReads;
    const w3 = await gatePost(theirs), w4 = await gatePost(rt), w5 = await gateGet(rt);
    (pool as any).query = orig;
    check('warm, no ad rule: an available title decided with no database read, the ad lookup included', [w1.s, w2.s, availReads, availAdReads], [200, 200, 0, 0]);
    check('warm: another account\'s title and a hidden title answered with no database read at all', [w3.s, w4.s, w5.s, reads - availReads], [404, 404, 404, 0]);

    // ---- VA-cache: with an ad rule on, a warm gate still reads nothing
    const listen = await pool.connect();
    const heard: string[] = [];
    listen.on('notification', (n: any) => { if (n.channel === 'volt_cache') heard.push(String(n.payload)); });
    await listen.query('LISTEN volt_cache');
    const on = await call('PUT', '/api/vod/ads/rules/default', { mode: 'on', policy: {} });
    check('an ad rule turned on for the account', [on.s, on.j?.mode], [200, 'on']);
    // The saved rule dropped the cached "no rule" answer at once: the next start asks again, once.
    counting();
    const r1 = await gateGet(warm);
    const afterSave = adReads;
    (pool as any).query = orig;
    check('saving a rule drops the cached rule: the next start reads it once', [r1.s, afterSave], [200, 1]);
    const adFree = await asset(me, 'Warm, ad-free title', `${LIVE}, metadata = '{"adRule":"none"}'::jsonb`);
    await gateGet(adFree); await gatePost(adFree); await gateGet(warm);
    counting();
    const r2 = await gateGet(adFree), r3 = await gatePost(adFree), r4 = await gateGet(warm);
    (pool as any).query = orig;
    check('warm, with an ad rule: titles decided with no database read, the ad lookup included', [r2.s, r3.s, r4.s, reads, adReads], [200, 200, 200, 0, 0]);
    check('the title that opts out of ads plays as it is', [JSON.parse(r2.t).ads ?? null, JSON.parse(r3.t).ads ?? null], [null, null]);
    // Another process learns of a rule change from the database (migration 0150).
    heard.length = 0;
    await query(`UPDATE vod_ad_rules SET mode = 'off', updated_at = now() WHERE account_id = $1`, [me.a]);
    for (let i = 0; i < 20 && !heard.includes(`vodads:${me.a}`); i++) await new Promise((r) => setTimeout(r, 50));
    check('migration 0150: a changed rule announces vodads:<account> on volt_cache', heard.includes(`vodads:${me.a}`), true);
    heard.length = 0;
    await query(`DELETE FROM vod_ad_rules WHERE account_id = $1`, [me.a]);
    for (let i = 0; i < 20 && !heard.includes(`vodads:${me.a}`); i++) await new Promise((r) => setTimeout(r, 50));
    check('migration 0150: a removed rule announces it too', heard.includes(`vodads:${me.a}`), true);
    // That announcement, as every process receives it, drops the cached rule.
    invalidateTag(`vodads:${me.a}`);
    counting();
    const r5 = await gateGet(warm);
    (pool as any).query = orig;
    check('the announcement drops the cached rule: the next start reads it once', [r5.s, adReads], [200, 1]);
    await listen.query('UNLISTEN volt_cache'); listen.release();
  } catch (e: any) {
    console.log('FAIL threw: ' + (e?.stack ?? e)); fail++;
  } finally {
    srv.close();
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
