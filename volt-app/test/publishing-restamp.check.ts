// ============================================================================
//  A RULE CHANGE REACHES PUBLISHED TITLES (build queue P3-4,
//  services/availability.ts restampPublished / markPolicyStale / restampStale,
//  migrations 0154 and 0155, PUBLISHING_POLICIES.md "Encode-time vs
//  delivery-time fields").
//
//  Pure: the restamp keeps where a title was published, the DRM its files
//  have and the moment it was published; a relative window counts from that
//  moment; the rights window caps it; the state follows the dates.
//  Then over real HTTP against a database: a save marks the published titles
//  it governs and they take the change up without being published again (the
//  play gate answers by the new geo within a few seconds); no social post is
//  made again; drafts, withdrawn titles and another account's titles are left
//  alone; a window shortened into the past ends a title at once (expired,
//  publications removed, the edge revocation written) and the dry run counted
//  it as "unavailable now"; DRM is kept until repackaged; removing a rung
//  hands its titles to the rungs above; the sweep picks up what is marked;
//  batches of 500, two workers never take the same title; 3,000 titles
//  marked in one statement and stamped in batches, timed.
//    DATABASE_URL=... npx tsx test/publishing-restamp.check.ts
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const R = await import('../src/services/publishingRules');
  const A = await import('../src/services/availability');

  // ---------------------------------------------------------------- pure
  const now = new Date('2026-11-10T12:00:00Z'), d = (n: number) => new Date(now.getTime() + n * 86_400_000);
  const L = (s: any) => R.resolveLadder([{ rung: 'account', settings: s }]).settings;
  const noRights = { from: null, until: null };
  const was = { targets: [{ kind: 'portal' }, { kind: 'social', targetId: 't1', platform: 'youtube' }], protection: { drm: false }, geo: { mode: 'worldwide', countries: [] } };
  const r1 = A.restampPublished(was, L({ geo: { mode: 'allow', countries: ['AU'] }, targets: [{ kind: 'portal' }], protection: { drm: true, waf: 'standard' } }), { anchor: d(-3), rights: noRights, now });
  check('the new geo and WAF are stamped', [r1.availability.geo.mode, r1.availability.geo.countries, r1.availability.protection.waf], ['allow', ['AU'], 'standard']);
  check('where it was published is kept (the social target stays, no new targets)', r1.availability.targets.map((t: any) => t.kind), ['portal', 'social']);
  check('DRM stays as the files have it until they are packaged again', r1.availability.protection.drm, false);
  check('the moment it was published is kept, and the window opens there', [r1.availability.publishedAt, r1.from.toISOString(), r1.until, r1.state], [d(-3).toISOString(), d(-3).toISOString(), null, 'available']);
  const r2 = A.restampPublished(was, L({ expire: { mode: 'days', days: 30 } }), { anchor: d(-3), rights: noRights, now });
  check('available for 30 days counts from publishing, not from the change', [r2.until?.toISOString(), r2.state], [d(27).toISOString(), 'available']);
  const r3 = A.restampPublished(was, L({ expire: { mode: 'days', days: 1 } }), { anchor: d(-3), rights: noRights, now });
  check('a window that now ends in the past: expired', [r3.until?.toISOString(), r3.state], [d(-2).toISOString(), 'expired']);
  const r4 = A.restampPublished(was, L({ availableFrom: { mode: 'at', at: d(2).toISOString() } }), { anchor: d(-3), rights: noRights, now });
  check('a window that now opens later: scheduled', [r4.from.toISOString(), r4.state], [d(2).toISOString(), 'scheduled']);
  const r5 = A.restampPublished(was, L({ expire: { mode: 'days', days: 60 } }), { anchor: d(-3), rights: { from: d(-1), until: d(5) }, now });
  check('the rights window caps it both ends', [r5.from.toISOString(), r5.until?.toISOString(), r5.state], [d(-1).toISOString(), d(5).toISOString(), 'available']);
  const r6 = A.restampPublished(null, L({ protection: { drm: true } }), { anchor: d(-3), rights: noRights, now });
  check('a stamp from before the protection section: DRM off (encodes are clear), targets from the rules', [r6.availability.protection.drm, r6.availability.targets], [false, [{ kind: 'portal' }]]);
  check('publishedAnchor: the stamp first, then available_from', [
    A.publishedAnchor({ availability: { publishedAt: d(-9).toISOString() }, available_from: d(-1) }).toISOString(),
    A.publishedAnchor({ availability: {}, available_from: d(-1) }).toISOString()], [d(-9).toISOString(), d(-1).toISOString()]);

  // ---------------------------------------------------------------- database
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const tag = Date.now().toString(36);
  const mk = async (n: string) => {
    const a = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`rs-${n}-${tag}`]))!.id;
    const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `rs-${n}-${tag}@volt.test`]))!.id;
    return { a, u, tok: signAccess({ sub: u, account_id: a, role: 'owner' }) };
  };
  const me = await mk('me'), them = await mk('them');
  const schema = async (a: string, name: string) => (await one<any>(`INSERT INTO metadata_schemas(account_id,name,target_kind,fields) VALUES ($1,$2,'vod','[]'::jsonb) RETURNING id`, [a, name]))!.id;
  const film = await schema(me.a, 'Film'), news = await schema(me.a, 'News'), theirs = await schema(them.a, 'Theirs');
  const asset = async (a: string, title: string, schemaId: string | null) => (await one<any>(
    `INSERT INTO vod_assets(account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, schema_id, media_state)
     VALUES ($1,'upload','clip',$2,'/clips/x/master.m3u8',0,60000,60000,$3,'ready') RETURNING id`, [a, title, schemaId]))!.id;
  const row = (id: string) => one<any>(`SELECT availability, availability_state, available_from, available_until, published, public_status, policy_stale_at FROM vod_assets WHERE id = $1`, [id]);

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = async (method: string, path: string, body?: any, tok = me.tok) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const txt = await r.text(); let j: any = null; try { j = JSON.parse(txt); } catch { j = txt; }
    return { s: r.status, j };
  };
  /** Wait until fn() is true, up to `ms`; returns how long it took or -1. */
  const until = async (fn: () => Promise<boolean>, ms = 10_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return Date.now() - t0; await sleep(50); } return -1; };
  try {
    const col = await one<any>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'vod_assets' AND column_name = 'policy_stale_at'`);
    const idx = await one<any>(`SELECT indexname FROM pg_indexes WHERE indexname = 'idx_vod_assets_policy_stale'`);
    check('migrations 0154 and 0155: the mark and its partial index', [!!col, !!idx], [true, true]);

    // Published through the real door, so the stamp is what publish() writes.
    const f1 = await asset(me.a, 'Film one', film), f2 = await asset(me.a, 'Film two', film), n1 = await asset(me.a, 'News one', news);
    const draft = await asset(me.a, 'Film draft', film), gone = await asset(me.a, 'Film withdrawn', film);
    const other = await asset(them.a, 'Their film', theirs);
    for (const id of [f1, f2, n1, gone]) await A.publish(id, 'test');
    await A.publish(other, 'test');
    await A.withdraw(gone, 'test');
    const pf1 = await row(f1);
    check('publish() stamps the moment it published', [!!pf1.availability.publishedAt, pf1.availability_state], [true, 'available']);
    // A social post made when it was published: the change must not post again.
    const tgt = (await one<any>(`INSERT INTO publish_targets(account_id, platform, name, enabled) VALUES ($1,'youtube','Our channel',true) RETURNING id`, [me.a]))!.id;
    await query(`INSERT INTO publications(vod_asset_id, platform, target_id, status, published_at) VALUES ($1,'youtube',$2,'published', now())`, [f1, tgt]);
    await query(`UPDATE vod_assets SET availability = jsonb_set(availability, '{targets}', availability->'targets' || $2::jsonb) WHERE id = $1`, [f1, JSON.stringify([{ kind: 'social', targetId: tgt, platform: 'youtube' }])]);
    const pubsBefore = (await query<any>(`SELECT id FROM publications WHERE vod_asset_id = ANY($1::uuid[])`, [[f1, f2, n1]])).length;
    const gate = async (id: string, c: string) => (await A.onDemandAccess(id, c))?.allowed;
    check('before: playable in the US', [await gate(f1, 'US'), await gate(n1, 'US')], [true, true]);

    // ---- the account restricts to Australia: every published title takes it up
    const dry = await call('PUT', '/api/publishing-rules/account?dryRun=1', { settings: { geo: { mode: 'allow', countries: ['AU'] }, protection: { waf: 'standard' } } });
    check('the dry run counts the published titles that take it up, none unavailable now',
      [dry.s, dry.j.impact.published, dry.j.impact.publishedChanged, dry.j.impact.unavailableNow], [200, 3, 3, 0]);
    const t0 = Date.now();
    const save = await call('PUT', '/api/publishing-rules/account', { settings: { geo: { mode: 'allow', countries: ['AU'] }, protection: { waf: 'standard' } } });
    check('the save marks the three published titles (not the draft, the withdrawn one or theirs)', [save.s, save.j.restamp.marked], [200, 3]);
    const took = await until(async () => (await row(n1)).availability?.geo?.mode === 'allow' && (await row(f1)).availability?.geo?.mode === 'allow' && (await row(f2)).availability?.geo?.mode === 'allow');
    check(`the titles take it up without a sweep (${took} ms after the response, ${Date.now() - t0} ms after the save)`, took >= 0, true);
    check('the play gate answers by the new geo: US refused, AU allowed', [await gate(f1, 'US'), await gate(f1, 'AU'), await gate(n1, 'US')], [false, true, false]);
    const af1 = await row(f1);
    check('the stamp: new geo and WAF, same targets with the social one, same publish moment',
      [af1.availability.geo.countries, af1.availability.protection.waf, af1.availability.targets.map((t: any) => t.kind), af1.availability.publishedAt, af1.policy_stale_at],
      [['AU'], 'standard', ['portal', 'social'], pf1.availability.publishedAt, null]);
    check('no publication was made again (no social re-post)', (await query<any>(`SELECT id FROM publications WHERE vod_asset_id = ANY($1::uuid[])`, [[f1, f2, n1]])).length, pubsBefore);
    check('the draft and the withdrawn title are untouched', [(await row(draft)).availability, (await row(gone)).availability_state, (await row(gone)).availability.geo.mode], [null, 'withdrawn', 'worldwide']);
    check('another account\'s title is untouched', [(await row(other)).availability.geo.mode, await gate(other, 'US')], ['worldwide', true]);

    // ---- Film: available for 1 day after publishing, on a title published 3 days ago
    await query(`UPDATE vod_assets SET availability = jsonb_set(availability, '{publishedAt}', to_jsonb((now() - interval '3 days')::text)), available_from = now() - interval '3 days' WHERE id = $1`, [f2]);
    const dry2 = await call('PUT', `/api/publishing-rules/schema/${film}?dryRun=1`, { settings: { expire: { mode: 'days', days: 1 } } });
    check('the dry run: 2 published Film titles change, 1 becomes unavailable now', [dry2.j.impact.publishedChanged, dry2.j.impact.unavailableNow], [2, 1]);
    const save2 = await call('PUT', `/api/publishing-rules/schema/${film}`, { settings: { expire: { mode: 'days', days: 1 } } });
    check('the save marks the two published Film titles', [save2.s, save2.j.restamp.marked], [200, 2]);
    await until(async () => (await row(f2)).availability_state === 'expired');
    const ef2 = await row(f2), ef1 = await row(f1);
    check('the title published 3 days ago ends now: expired, unpublished, its public status expired',
      [ef2.availability_state, ef2.published, ef2.public_status], ['expired', false, 'expired']);
    check('its window ends a day after it was published', Math.round((new Date(ef2.available_until).getTime() - new Date(ef2.available_from).getTime()) / 3_600_000), 24);
    check('the edge stops tokens already handed out (revocation written)', !!(await one<any>(`SELECT 1 FROM edge_revocations WHERE asset_id = $1`, [f2])), true);
    check('the play gate refuses it', await gate(f2, 'AU'), false);
    check('the one published today stays available, now with an end date', [ef1.availability_state, !!ef1.available_until], ['available', true]);
    check('its portal publication is removed, as the sweep removes one', (await one<any>(`SELECT status FROM publications WHERE vod_asset_id = $1 AND platform = 'portal'`, [f2]))!.status, 'removed');

    // ---- DRM: confirmed on published titles, the stamp keeps the files' protection
    const drm = await call('PUT', `/api/publishing-rules/schema/${news}`, { settings: { protection: { drm: true }, distribution: { mp4Download: false } }, confirm: true });
    await until(async () => (await row(n1)).availability?.distribution?.mp4Download === false);
    const dn1 = await row(n1);
    check('DRM on for News: the MP4 field is taken up, DRM stays off on the stamp until packaged again',
      [drm.s, dn1.availability.distribution.mp4Download, dn1.availability.protection.drm], [200, false, false]);

    // ---- removing a rung: its titles fall back to the rungs above
    const del = await call('DELETE', `/api/publishing-rules/schema/${news}`);
    await until(async () => (await row(n1)).availability?.distribution?.mp4Download === true);
    check('the News rung removed: News one takes up the account rules again', [del.s, (await row(n1)).availability.distribution.mp4Download, (await row(n1)).availability.geo.countries], [204, true, ['AU']]);

    // ---- a save that changes nothing marks nothing
    const same = await call('PUT', '/api/publishing-rules/account', { settings: { geo: { mode: 'allow', countries: ['AU'] }, protection: { waf: 'standard' } } });
    check('saving the same rung again marks nothing', same.j.restamp.marked, 0);

    // ---- the sweep: titles marked by a save on another task are picked up there
    await query(`UPDATE publishing_rules SET settings = '{"geo":{"mode":"block","countries":["NZ"]}}'::jsonb WHERE account_id = $1 AND scope_kind = 'account'`, [me.a]);
    const marked = await A.markPolicyStale(me.a, { kind: 'account', id: null });
    const sw = await A.sweepAvailability();
    check('the sweep stamps what is marked (Film one and News one)', [marked, sw.restamped, (await row(n1)).availability.geo.mode, (await row(f1)).availability.geo.mode, (await row(n1)).policy_stale_at], [2, 2, 'block', 'block', null]);
    // A title withdrawn after it was marked stays withdrawn.
    await query(`UPDATE publishing_rules SET settings = '{"geo":{"mode":"worldwide","countries":[]}}'::jsonb WHERE account_id = $1 AND scope_kind = 'account'`, [me.a]);
    await A.markPolicyStale(me.a, { kind: 'account', id: null });
    await A.withdraw(n1, 'test');
    await A.restampStale();
    check('withdrawn after it was marked: a person\'s withdraw wins', [(await row(n1)).availability_state, (await row(n1)).availability.geo.mode], ['withdrawn', 'block']);

    // ---- scale: 3,000 published titles, one statement to mark, batches of 500
    await query(`INSERT INTO vod_assets(account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, schema_id, media_state, availability_state, published, available_from, availability)
                 SELECT $1,'upload','clip','Bulk '||g,'/clips/x/m.m3u8',0,1000,1000,$2,'ready','available',true,now() - interval '1 hour', '{"targets":[{"kind":"portal"}]}'::jsonb FROM generate_series(1,3000) g`, [them.a, theirs]);
    await query(`INSERT INTO publishing_rules(account_id, scope_kind, scope_id, settings) VALUES ($1,'account',NULL,'{"geo":{"mode":"block","countries":["US"]}}'::jsonb)`, [them.a]);
    const m0 = Date.now();
    const many = await A.markPolicyStale(them.a, { kind: 'account', id: null });
    const markMs = Date.now() - m0;
    check(`3,001 titles marked in one statement (${markMs} ms)`, many, 3001);
    const [b1, b2] = await Promise.all([A.restampStale(500), A.restampStale(500)]);
    check('two workers at once take 1,000 different titles', [b1.checked + b2.checked, b1.checked, b2.checked], [1000, 500, 500]);
    const s0 = Date.now(); let left = 0, batches = 0;
    for (;;) { const b = await A.restampStale(500); if (!b.checked) break; left += b.checked; batches++; }
    const stampMs = Date.now() - s0;
    check(`the rest in ${batches} batches of 500 (${stampMs} ms for ${left} titles)`, [left, batches], [2001, 5]);
    // One sweep tick takes up a large change within its 20 s budget.
    await query(`UPDATE publishing_rules SET settings = '{"geo":{"mode":"block","countries":["GB"]}}'::jsonb WHERE account_id = $1`, [them.a]);
    await A.markPolicyStale(them.a, { kind: 'account', id: null });
    const w0 = Date.now(); const tick = await A.sweepAvailability(); const tickMs = Date.now() - w0;
    check(`one sweep tick stamps all 3,001 again in batches (${tickMs} ms)`, [tick.restamped, (await one<any>(`SELECT count(*)::int AS n FROM vod_assets WHERE policy_stale_at IS NOT NULL`))!.n], [3001, 0]);
    check('every one stamped and none still marked',
      [(await one<any>(`SELECT count(*)::int AS n FROM vod_assets WHERE account_id = $1 AND availability->'geo'->'countries' ? 'GB'`, [them.a]))!.n,
       (await one<any>(`SELECT count(*)::int AS n FROM vod_assets WHERE policy_stale_at IS NOT NULL`))!.n], [3001, 0]);
  } finally {
    srv.close();
    await sleep(200);
    await pool.end();
  }
  console.log(`publishing-restamp: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
