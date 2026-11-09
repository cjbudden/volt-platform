// ============================================================================
//  REFUSALS, THE BLOCK MESSAGE AND NOTIFY ME (build queue P2-2 (a),
//  services/blockMessage.ts, the play gate in modules/apps.ts, migration 0152).
//
//  Over real HTTP against a database: each refusal code and its body (451 for
//  a region and for the rights, with the block message, `code` and `notify`;
//  403 Scheduled with `until`; 403 sign in answered, not thrown; 402 for a
//  title whose own access is paid, which used to answer 451); the account's
//  block message set on the Rights page (audited, Rights: manage only, back to
//  the default when emptied, too long refused) and seen by the gate at once on
//  POST and GET; Notify me stored only for a viewer the gate refuses with the
//  button offered (by email or by viewer id, once per title), and refused for
//  a title that plays, an unknown or unpublished one, another account's, with
//  no email, and when not offered; the Rights page's count per title, scoped
//  to the account; the Volt player showing the gate's words; a warm 451 with
//  no database read.
//    DATABASE_URL=... npx tsx test/block-message.check.ts
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};

(async () => {
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { signViewer } = await import('../src/auth/viewerTokens');
  const { invalidateTag } = await import('../src/scale/cache');
  const P = await import('../src/services/publicStatus');
  const B = await import('../src/services/blockMessage');
  const tag = Date.now().toString(36);
  const acct = async (n: string, geo: string | null = null) => (await one<any>(`INSERT INTO accounts(name, geo_access) VALUES ($1, $2::jsonb) RETURNING id`, [`${n}-${tag}`, geo]))!.id;
  const user = async (a: string, role: string) => {
    const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x',$3,'active') RETURNING id`, [a, `${role}-${a.slice(0, 8)}-${tag}@volt.test`, role]))!.id;
    return signAccess({ sub: u, account_id: a, role });
  };
  const me = await acct('bm', '{"mode":"block","countries":["NZ"]}');
  const them = await acct('bm-them');
  const otok = await user(me, 'owner'), vtok = await user(me, 'viewer'), ttok = await user(them, 'owner');
  const LIVE = `availability_state = 'available', published = true, availability = '{"targets":[{"kind":"portal"}],"access":"free"}'::jsonb, available_from = now() - interval '1 day'`;
  const asset = async (a: string, title: string, set = LIVE) => {
    const id = (await one<any>(
      `INSERT INTO vod_assets(account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms)
       VALUES ($1,'upload','clip',$2,'x',0,60000,60000) RETURNING id`, [a, title]))!.id;
    await query(`UPDATE vod_assets SET master_key = $2, formats = '{"hls":true}'::jsonb, ${set} WHERE id = $1`, [id, `/clips/vod/${id}/master.m3u8`]);
    await P.refreshPublicStatus(id);
    invalidateTag(`asset:${id}`);
    return id;
  };
  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const http = async (method: string, path: string, body?: any, auth?: string) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j: any = null; try { j = JSON.parse(t); } catch { j = t; }
    return { s: r.status, j };
  };
  try {
    const cols = await query<any>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'accounts' AND column_name IN ('block_message','block_notify') ORDER BY 1`);
    const ncols = await query<any>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'availability_notify' ORDER BY 1`);
    check('migration 0152: the account columns and the notify table', [cols.map((c) => c.column_name), ncols.length >= 10],
      [['block_message', 'block_notify'], true]);

    const pk = (await http('POST', '/api/apps', { name: 'Web', type: 'web' }, otok)).j.publishableKey.key;
    const tpk = (await http('POST', '/api/apps', { name: 'Theirs', type: 'web' }, ttok)).j.publishableKey.key;
    const gate = (id: string, geo = 'AU', key = pk, auth?: string) => http('POST', '/api/availability', { appKey: key, assetId: id, geo }, auth);
    const gateGet = (id: string, geo = 'AU') => http('GET', `/api/availability?appKey=${encodeURIComponent(pk)}&assetId=${id}&geo=${geo}`);
    const notifyMe = (id: string, geo: string, email?: string, key = pk, auth?: string) =>
      http('POST', '/api/availability/notify', { appKey: key, assetId: id, geo, ...(email ? { email } : {}) }, auth);

    // ---- defaults
    const s0 = (await http('GET', '/api/rights/settings', undefined, otok)).j;
    check('settings: the default words, no custom message, Notify me off, nobody waiting',
      [s0.blockMessage, s0.blockMessageDefault, s0.notifyMe, s0.notifyRequests?.total, !!s0.defaultProfileId], [null, 'Not available in your region', false, 0, true]);

    // ---- 451 for a region
    const film = await asset(me, 'Film');
    const nz = await gate(film, 'NZ');
    check('region (account geo): 451 blocked, code region, the default words, no Notify me, the title shown locked',
      [nz.s, nz.j.mode, nz.j.code, nz.j.message, nz.j.notify, nz.j.meta?.title, 'playbackToken' in nz.j, 'delivery' in nz.j],
      [451, 'blocked', 'region', 'Not available in your region', false, 'Film', false, false]);
    check('...the same from the anonymous GET gate', [(await gateGet(film, 'NZ')).j.message, (await gateGet(film, 'NZ')).s], ['Not available in your region', 451]);
    check('...and from Australia it plays', (await gate(film, 'AU')).s, 200);

    // ---- set the message on the Rights page
    const put = await http('PUT', '/api/rights/settings', { blockMessage: '  Not licensed   in your country yet. ', notifyMe: true }, otok);
    check('set: trimmed, spaces folded, Notify me on', [put.s, put.j.blockMessage, put.j.notifyMe, put.j.defaultProfileId], [200, 'Not licensed in your country yet.', true, s0.defaultProfileId]);
    const au = await one<any>(`SELECT detail FROM audit_log WHERE account_id = $1 AND entity_type = 'account_block_message' ORDER BY id DESC LIMIT 1`, [me]).catch(() => null)
      ?? await one<any>(`SELECT detail FROM audit_log WHERE account_id = $1 AND entity_type = 'account_block_message' LIMIT 1`, [me]);
    check('...audited, from and to', JSON.stringify(au?.detail ?? {}).includes('Not licensed in your country yet.') && JSON.stringify(au?.detail ?? {}).includes('Not available in your region'), true);
    const nz2 = await gate(film, 'NZ');
    check('the gate says the new words at once, and offers Notify me', [nz2.s, nz2.j.message, nz2.j.notify], [451, 'Not licensed in your country yet.', true]);
    check('...the GET gate too', [(await gateGet(film, 'NZ')).j.message, (await gateGet(film, 'NZ')).j.notify], ['Not licensed in your country yet.', true]);
    // The Volt player shows the gate's words (volt-player resolver), not its own.
    const { resolveAsset } = await import('../../volt-player/src/sdk/resolver');
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = (u: any, init: any) => realFetch(u, { ...init, body: JSON.stringify({ ...JSON.parse(init.body), geo: 'NZ' }) });
    let shown: any = null;
    try { await resolveAsset(base, pk, film); } catch (e: any) { shown = { status: e.status, mode: e.mode, message: e.message, title: e.meta?.title }; }
    (globalThis as any).fetch = realFetch;
    check('the Volt player is locked with the account\'s words and the title', shown, { status: 451, mode: 'blocked', message: 'Not licensed in your country yet.', title: 'Film' });
    check('a viewer role cannot change it', (await http('PUT', '/api/rights/settings', { blockMessage: 'x' }, vtok)).s, 403);
    check('...but can read it', (await http('GET', '/api/rights/settings', undefined, vtok)).j.blockMessage, 'Not licensed in your country yet.');
    check('too long: 422, nothing changed', [(await http('PUT', '/api/rights/settings', { blockMessage: 'x'.repeat(201) }, otok)).s,
      (await http('GET', '/api/rights/settings', undefined, otok)).j.blockMessage], [422, 'Not licensed in your country yet.']);
    check('changing only the message leaves the default profile', (await http('PUT', '/api/rights/settings', { blockMessage: 'Not licensed in your country yet.' }, otok)).j.defaultProfileId, s0.defaultProfileId);
    check('another account\'s gate keeps its own (default) words', (await one<any>(`SELECT block_message FROM accounts WHERE id = $1`, [them]))!.block_message, null);

    // ---- 451 for the rights
    const prof = await http('POST', '/api/rights/profiles', { name: `AU only ${tag}`, territoryMode: 'allow', territories: ['AU'] }, otok);
    const ronly = await asset(me, 'AU rights');
    const pr = await http('PUT', `/api/rights/assets/${ronly}`, { profileId: prof.j.id }, otok);
    invalidateTag(`asset:${ronly}`);
    const us = await gate(ronly, 'US');
    check('rights (territory): 451 blocked, code rights, the account\'s words, Notify me', [prof.s, pr.s, us.s, us.j.mode, us.j.code, us.j.message, us.j.notify],
      [201, 200, 451, 'blocked', 'rights', 'Not licensed in your country yet.', true]);

    // ---- 403 scheduled, with until
    const teaser = await asset(me, 'Teaser', `${LIVE.replace("'available'", "'scheduled'").replace("now() - interval '1 day'", "now() + interval '2 days'")}, listed_from = now() - interval '1 hour'`);
    const tz = await gate(teaser, 'AU');
    check('scheduled: 403 answered (not thrown), until = availableFrom, the words, Notify me, no token',
      [tz.s, tz.j.mode, !!tz.j.until, tz.j.until === tz.j.availableFrom, tz.j.message, tz.j.notify, 'playbackToken' in tz.j], [403, 'scheduled', true, true, 'Not available yet', true, false]);

    // ---- 403 sign in (POST used to throw it as a bare error), 402 paid
    const members = await asset(me, 'Members', LIVE.replace(`"access":"free"}'`, `"access":"free","accessRules":[{"id":"m","for":{"scopes":["this"]},"if":{"geo":"in","countries":["WORLD"]},"then":{"access":"members"}}]}'`)
      + `, availability_sources = '{"accessRules":"asset"}'::jsonb`);
    const mp = await gate(members, 'AU');
    check('members only: 403 sign_in on POST with its words and the title', [mp.s, mp.j.mode, mp.j.message, mp.j.meta?.title], [403, 'sign_in', 'Sign in to watch', 'Members']);
    const paid = await asset(me, 'Paid', LIVE.replace(`"access":"free"`, `"access":"paid"`));
    const pp = await gate(paid, 'AU');
    check('a title whose own access is paid: 402 paywall (was 451), never the block message', [pp.s, pp.j.mode, pp.j.message], [402, 'paywall', 'Buy or subscribe to watch']);

    // ---- bare errors stay errors
    check('an unknown title: 404', (await gate('22222222-2222-4222-8222-222222222222')).s, 404);
    check('a bad key: 401', (await gate(film, 'NZ', 'pk_nope_nope')).s, 401);

    // ---- Notify me
    const n1 = await notifyMe(film, 'NZ', 'Viewer@Example.COM');
    check('notify: stored for a viewer refused in their region', [n1.s, n1.j.created, n1.j.reason], [201, true, 'region']);
    const row = await one<any>(`SELECT account_id, email, who, country, reason, viewer_id FROM availability_notify WHERE asset_id = $1`, [film]);
    check('...with the account, the address lower-cased, the country and why', [row?.account_id === me, row?.email, row?.who, row?.country, row?.reason, row?.viewer_id],
      [true, 'viewer@example.com', 'email:viewer@example.com', 'NZ', 'region', null]);
    check('asking twice changes nothing', [(await notifyMe(film, 'NZ', 'viewer@example.com')).j.created, (await one<any>(`SELECT count(*)::int AS n FROM availability_notify WHERE asset_id = $1`, [film]))!.n], [false, 1]);
    const vid = (await import('node:crypto')).randomUUID();
    const vt = signViewer({ id: vid, accountId: me, appId: null, groups: [], entitlements: [] }).token;
    const n2 = await notifyMe(ronly, 'US', undefined, pk, vt);
    check('a signed-in viewer needs no email: kept by their id, for the rights', [n2.s, n2.j.reason, (await one<any>(`SELECT who FROM availability_notify WHERE asset_id = $1`, [ronly]))?.who], [201, 'rights', `viewer:${vid}`]);
    check('a Scheduled teaser: kept as scheduled', [(await notifyMe(teaser, 'AU', 'a@b.co')).j.reason], ['scheduled']);
    check('no email and not signed in: 400', (await notifyMe(film, 'NZ')).s, 400);
    check('a title that plays for this viewer: 409', (await notifyMe(film, 'AU', 'a@b.co')).s, 409);
    check('a paywall is not a block: 409', (await notifyMe(paid, 'AU', 'a@b.co')).s, 409);
    check('an unknown title: 404', (await notifyMe('22222222-2222-4222-8222-222222222222', 'NZ', 'a@b.co')).s, 404);
    const draft = await asset(me, 'Draft', `availability_state = 'draft'`);
    check('an unpublished title: 404, as the gate', (await notifyMe(draft, 'NZ', 'a@b.co')).s, 404);
    check('another account\'s key for my title: 404', (await notifyMe(film, 'NZ', 'a@b.co', tpk)).s, 404);
    check('not an email: 422', (await notifyMe(film, 'NZ', 'nope')).s, 422);

    const s1 = (await http('GET', '/api/rights/settings', undefined, otok)).j;
    check('the Rights page: who is waiting, per title', [s1.notifyRequests.total, s1.notifyRequests.titles.map((t: any) => [t.title, t.count]).sort()],
      [3, [['AU rights', 1], ['Film', 1], ['Teaser', 1]]]);
    check('...another account sees none of them', (await http('GET', '/api/rights/settings', undefined, ttok)).j.notifyRequests.total, 0);

    await http('PUT', '/api/rights/settings', { notifyMe: false }, otok);
    check('Notify me off: the gate stops offering it, and a request is refused (409)', [(await gate(film, 'NZ')).j.notify, (await notifyMe(film, 'NZ', 'z@b.co')).s], [false, 409]);
    const back = await http('PUT', '/api/rights/settings', { blockMessage: '' }, otok);
    check('emptied: back to the default words', [back.j.blockMessage, (await gate(film, 'NZ')).j.message], [null, 'Not available in your region']);
    check('the service default is the edge\'s words', B.DEFAULT_BLOCK_MESSAGE, 'Not available in your region');

    // ---- scale: a warm 451 reads nothing
    await gateGet(film, 'NZ'); await gate(film, 'NZ');
    const orig = (pool as any).query.bind(pool);
    let reads = 0;
    (pool as any).query = (...q: any[]) => { reads++; return orig(...q); };
    const w1 = await gateGet(film, 'NZ'), w2 = await gate(film, 'NZ');
    (pool as any).query = orig;
    check('warm: a 451 with its message and no database read', [w1.s, w2.s, w2.j.message, reads], [451, 451, 'Not available in your region', 0]);
  } catch (e: any) {
    console.log('FAIL threw: ' + (e?.stack ?? e)); fail++;
  } finally {
    srv.close();
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
