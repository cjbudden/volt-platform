// ============================================================================
//  THE POLICY AT DELIVERY (build queue P3-4b, services/deliveryPolicy.ts,
//  PUBLISHING_POLICIES.md "What a policy contains").
//
//  A rule's Protection and Distribution fields, read from the title's stamp
//  where it is played or handed out:
//    - the edge token lives as long as the rule says (the platform default
//      when it says nothing), and a revocation is kept as long as the longest
//      token a rule may ask for;
//    - the play gate refuses a page on a site the rule does not list, a web
//      app that names no page, and lets phone apps through; a shared GET
//      answer checked against a Referer is not shared;
//    - making a share link is refused when the rule turns sharing off, and a
//      link made before stops opening;
//    - an MP4 leaving Volt (Downloads, a share link's hi-res file) is refused
//      when the rule turns MP4 download off; the audio files and the metadata
//      file are not;
//    - each is taken up by a published title after a rule change (P3-4), and a
//      draft is judged by its rules as they resolve;
//    - a warm play gate still makes no database read.
//    DATABASE_URL=... npx tsx test/publishing-delivery.check.ts
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const D = await import('../src/services/deliveryPolicy');
  const T = await import('../src/services/edgeTokens');

  // ---------------------------------------------------------------- pure
  check('a stamp with no sections: the baseline (platform lifetime, any site, MP4 and sharing allowed)',
    D.deliveryPolicyOf({ geo: { mode: 'worldwide' } }), { tokenLifetimeSec: null, referrers: [], mp4Download: true, shareLinks: true, tokenFree: false });
  check('a stamp with sections: read as written',
    D.deliveryPolicyOf({ protection: { tokenLifetimeSec: 600, referrers: ['Example.com '] }, distribution: { mp4Download: false, shareLinks: false } }),
    { tokenLifetimeSec: 600, referrers: ['example.com'], mp4Download: false, shareLinks: false, tokenFree: false });
  check('no stamp at all: the baseline', D.deliveryPolicyOf(null).mp4Download, true);
  check('domains: exact, wildcard covers the bare name and names under it, not look-alikes',
    [D.domainMatches('example.com', 'example.com'), D.domainMatches('example.com', 'www.example.com'), D.domainMatches('*.partner.tv', 'partner.tv'),
      D.domainMatches('*.partner.tv', 'a.b.partner.tv'), D.domainMatches('*.partner.tv', 'evilpartner.tv')], [true, false, true, true, false]);
  check('host names without the port', [D.hostNameOf('https://example.com:8443/watch?x=1'), D.hostNameOf('example.com/page'), D.hostNameOf('')], ['example.com', 'example.com', null]);
  const R = ['example.com'];
  check('referrers: listed site allowed, other site refused with its name',
    [D.referrerRefusal(R, { origin: 'https://example.com', webApp: true }), D.referrerRefusal(R, { origin: 'https://evil.test', webApp: true })],
    [null, 'This title cannot be played on evil.test.']);
  check('referrers: Referer counts when there is no Origin', D.referrerRefusal(R, { referrer: 'https://example.com/films/1', webApp: true }), null);
  check('referrers: a web app naming no page is refused; a phone app is not',
    [typeof D.referrerRefusal(R, { webApp: true }), D.referrerRefusal(R, { webApp: false })], ['string', null]);
  check('referrers: an empty list allows any site', D.referrerRefusal([], { origin: 'https://evil.test', webApp: true }), null);
  const lt = (o: any) => { const c = T.mintEdgeToken({ assetId: 'a', prefix: '/p/', policyClass: 'open', nowSec: 1000, ...o }).claims; return c.e - c.n; };
  check('token lifetime: the rule\'s, the class default without one, never above a day, still clamped by the window',
    [lt({ lifetimeSec: 600 }), lt({}), lt({ lifetimeSec: 999_999 }), lt({ lifetimeSec: 600, effectiveUntil: new Date(1300 * 1000) })],
    [600, T.tokenLifetimeSec('open'), 86_400, 300]);
  check('a revocation is kept at least a day (the longest token a rule may ask for)', T.maxTokenLifetimeSec() >= 86_400, true);

  // ---------------------------------------------------------------- database
  process.env.VOLT_EDGE_TOKENS = 'issue';
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { invalidateTag } = await import('../src/scale/cache');
  const A = await import('../src/services/availability');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`pd-${tag}`]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `pd-${tag}@volt.test`]))!.id;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' });
  const schema = async (name: string) => (await one<any>(`INSERT INTO metadata_schemas(account_id,name,target_kind,fields) VALUES ($1,$2,'vod','[]'::jsonb) RETURNING id`, [acct, name]))!.id;
  const premium = await schema('Premium film'), news = await schema('News');
  const asset = async (title: string, schemaId: string) => {
    const id = (await one<any>(
      `INSERT INTO vod_assets(account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, schema_id, media_state)
       VALUES ($1,'upload','clip',$2,'x',0,60000,60000,$3,'ready') RETURNING id`, [acct, title, schemaId]))!.id;
    await query(`UPDATE vod_assets SET master_key = $2, progressive_key = $3, export_mp3_key = $4, formats = '{"hls":true,"dash":true,"progressive":true}'::jsonb WHERE id = $1`,
      [id, `/clips/vod/${id}/master.m3u8`, `/clips/vod/${id}/file.mp4`, `/clips/vod/${id}/sound.mp3`]);
    invalidateTag(`asset:${id}`);
    return id;
  };
  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const http = async (method: string, path: string, body?: any, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j: any = null; try { j = JSON.parse(t); } catch { j = t; }
    return { s: r.status, j, cc: r.headers.get('cache-control') };
  };
  const admin = (method: string, path: string, body?: any) => http(method, path, body, { authorization: `Bearer ${tok}` });
  const until = async (fn: () => Promise<boolean>, ms = 10_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return Date.now() - t0; await sleep(50); } return -1; };
  const life = (hls: string) => { const m = /^\/t\/([^/]+)\//.exec(hls ?? ''); if (!m) return null; const c = JSON.parse(Buffer.from(m[1].split('.')[0], 'base64url').toString()); return c.e - c.n; };
  try {
    // The Premium film type: 10-minute tokens, two sites, no MP4, no sharing.
    const put = await admin('PUT', `/api/publishing-rules/schema/${premium}`, { settings: {
      protection: { tokenLifetimeSec: 600, referrers: ['example.com', '*.partner.tv'] }, distribution: { mp4Download: false, shareLinks: false } } });
    check('the Premium film rule saves', put.s, 200);
    const film = await asset('Film', premium), story = await asset('Story', news), draft = await asset('Draft film', premium);
    await A.publish(film, 'test'); await A.publish(story, 'test');
    const st = (await one<any>(`SELECT availability FROM vod_assets WHERE id = $1`, [film]))!.availability;
    check('the stamp carries the sections', [st.protection?.tokenLifetimeSec, st.protection?.referrers, st.distribution?.mp4Download, st.distribution?.shareLinks],
      [600, ['example.com', '*.partner.tv'], false, false]);

    const web = (await admin('POST', '/api/apps', { name: 'Web', type: 'web' })).j.publishableKey.key;
    const ios = (await admin('POST', '/api/apps', { name: 'Phone', type: 'ios' })).j.publishableKey.key;
    const gate = (id: string, key: string, h: Record<string, string> = {}) => http('POST', '/api/availability', { appKey: key, assetId: id, geo: 'GB' }, h);
    const gateGet = (id: string, key: string, h: Record<string, string> = {}) => http('GET', `/api/availability?appKey=${encodeURIComponent(key)}&assetId=${id}&geo=GB`, undefined, h);

    // ---- protection: referrers and the token's lifetime
    const ok = await gate(film, web, { origin: 'https://example.com' });
    check('a listed site plays it, with a 10-minute edge token', [ok.s, ok.j.mode, life(ok.j.delivery?.hls)], [200, 'play', 600]);
    const sub = await gate(film, web, { origin: 'https://www.partner.tv' });
    check('a name under a wildcard plays it', sub.s, 200);
    const evil = await gate(film, web, { origin: 'https://evil.test' });
    check('another site is refused, saying which site, as an app restriction',
      [evil.s, evil.j.code, evil.j.mode, evil.j.reason, evil.j.delivery, evil.j.playbackToken], [403, 'referrer', 'blocked', 'This title cannot be played on evil.test.', undefined, undefined]);
    const none = await gate(film, web);
    check('a web app that names no page is refused', [none.s, none.j.code], [403, 'referrer']);
    const phone = await gate(film, ios);
    check('a phone app (no page) plays it, with the rule\'s lifetime', [phone.s, life(phone.j.delivery?.hls)], [200, 600]);
    const viaRef = await gate(film, web, { referer: 'https://example.com/films/1' });
    check('a Referer from a listed site counts when there is no Origin', viaRef.s, 200);
    const gOrigin = await gateGet(film, web, { origin: 'https://example.com' });
    const gRef = await gateGet(film, web, { referer: 'https://example.com/films/1' });
    check('GET: an answer for an Origin is shared at the edge; one checked against a Referer is not',
      [gOrigin.s, /s-maxage=\d+/.test(gOrigin.cc ?? ''), gRef.s, gRef.cc], [200, true, 200, 'private, no-store']);
    const gEvil = await gateGet(film, web, { origin: 'https://evil.test' });
    check('GET: another site is refused', [gEvil.s, gEvil.j.code], [403, 'referrer']);
    const open = await gate(story, web, { origin: 'https://evil.test' });
    check('a News title (no referrers, no lifetime) plays anywhere with the platform lifetime', [open.s, life(open.j.delivery?.hls)], [200, T.tokenLifetimeSec('open')]);

    // ---- distribution: share links and MP4 download
    const sl = (id: string, extra: any = {}) => admin('POST', '/api/share-links', { resourceKind: 'vod', resourceId: id, accessPeriod: '7 days', ...extra });
    const refused = await sl(film);
    check('a share link for the Premium film is refused, saying where to change it', [refused.s, refused.j.code, /Share links under Distribution/.test(refused.j.error ?? '')], [403, 'sharing_off', true]);
    check('...and so is one for its draft (judged by its rules as they resolve)', (await sl(draft)).s, 403);
    check('nothing was saved', Number((await one<any>(`SELECT count(*)::int AS n FROM share_links WHERE resource_id = ANY($1::uuid[])`, [[film, draft]]))!.n), 0);
    const made = await sl(story, { accessType: 'allow_download', allowHiRes: true, allowMetadata: true });
    const raw = String(made.j.token);
    check('a share link for a News title is made', made.s, 201);
    const resolve = () => http('POST', `/api/share/${raw}/resolve`, { visit: 'visit-abcdef12' });
    check('it opens', (await resolve()).s, 200);
    check('its hi-res download is offered while the rule allows MP4', (await http('GET', `/api/share/${raw}/download/hi_res`)).s, 200);

    const dl = (id: string, format: string) => admin('POST', `/api/downloads/vod/${id}/link`, { format });
    const mp4 = await dl(film, 'mp4');
    check('Downloads: the Premium film\'s MP4 is refused, saying why', [mp4.s, mp4.j.code, /MP4 download under Distribution/.test(mp4.j.error ?? '')], [403, 'mp4_off', true]);
    check('Downloads: its MP3 is not the MP4 and is handed out', (await dl(film, 'mp3')).s, 200);
    check('Downloads: the draft\'s MP4 is refused by its resolved rules', (await dl(draft, 'mp4')).s, 403);
    const list = await admin('GET', `/api/downloads/vod/${film}`);
    const row = (f: string) => list.j.files.find((x: any) => x.format === f);
    check('Downloads list: the MP4 marked not allowed with the reason, the MP3 not', [row('mp4')?.allowed, typeof row('mp4')?.reason, row('mp3')?.allowed], [false, 'string', undefined]);
    check('Downloads: a News title\'s MP4 is handed out', (await dl(story, 'mp4')).s, 200);
    check('no download was written to the audit for the refused MP4s',
      Number((await one<any>(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id::text = ANY($1::text[]) AND action = 'download' AND detail::text LIKE '%mp4%'`, [[film, draft]]))!.n), 0);

    // ---- a rule change on News reaches its published title (P3-4), then delivery
    const t0 = Date.now();
    const p2 = await admin('PUT', `/api/publishing-rules/schema/${news}`, { settings: { protection: { tokenLifetimeSec: 1200, referrers: ['news.example'] }, distribution: { mp4Download: false } } });
    check('News: MP4 off, a site and 20-minute tokens saved, one published title marked', [p2.s, p2.j.restamp?.marked], [200, 1]);
    const took = await until(async () => (await one<any>(`SELECT availability FROM vod_assets WHERE id = $1`, [story]))!.availability?.distribution?.mp4Download === false);
    check(`the published News title takes it up (${took} ms)`, took >= 0, true);
    invalidateTag(`asset:${story}`);
    const n1 = await gate(story, web, { origin: 'https://news.example' });
    check('...plays on its site with a 20-minute token', [n1.s, life(n1.j.delivery?.hls)], [200, 1200]);
    check('...is refused on the site that played it before', (await gate(story, web, { origin: 'https://evil.test' })).s, 403);
    check('...its MP4 is refused in Downloads now', (await dl(story, 'mp4')).s, 403);
    const hi = await http('GET', `/api/share/${raw}/download/hi_res`);
    check('...the share link\'s hi-res download is refused although the link allowed it', [hi.s, hi.j.reason], [403, 'mp4_off']);
    check('...its metadata file is still handed out', (await http('GET', `/api/share/${raw}/download/metadata`)).s, 200);
    check('...and the link still opens (sharing is still on)', (await resolve()).s, 200);
    const p3 = await admin('PUT', `/api/publishing-rules/schema/${news}`, { settings: { protection: { tokenLifetimeSec: 1200, referrers: ['news.example'] }, distribution: { mp4Download: false, shareLinks: false } } });
    check('News: sharing turned off', p3.s, 200);
    await until(async () => (await one<any>(`SELECT availability FROM vod_assets WHERE id = $1`, [story]))!.availability?.distribution?.shareLinks === false);
    invalidateTag(`asset:${story}`);
    const gone = await resolve();
    check(`the link made before stops opening (${Date.now() - t0} ms after the first change)`, [gone.s, gone.j.reason], [410, 'sharing_off']);
    const page = await http('GET', `/share/${raw}`);
    check('the share page has words for it', String(page.j).includes('Sharing has been turned off for this title.'), true);

    // ---- a title stamped before the sections: the baseline
    const old = await asset('Old film', premium);
    await query(`UPDATE vod_assets SET published = true, availability_state = 'available', available_from = now() - interval '1 day',
                 availability = '{"targets":[{"kind":"portal"}],"access":"free"}'::jsonb WHERE id = $1`, [old]);
    await (await import('../src/services/publicStatus')).refreshPublicStatus(old);
    invalidateTag(`asset:${old}`);
    const o1 = await gate(old, web, { origin: 'https://evil.test' });
    check('a stamp from before the sections: any site, the platform lifetime, MP4 allowed', [o1.s, life(o1.j.delivery?.hls), (await dl(old, 'mp4')).s],
      [200, T.tokenLifetimeSec('open'), 200]);

    // ---- scale: a warm gate with a referrer rule still reads nothing
    await gateGet(film, web, { origin: 'https://example.com' }); await gate(film, web, { origin: 'https://example.com' });
    const orig = (pool as any).query.bind(pool);
    let reads = 0;
    (pool as any).query = (...q: any[]) => { reads++; return orig(...q); };
    const w1 = await gateGet(film, web, { origin: 'https://example.com' }), w2 = await gate(film, web, { origin: 'https://example.com' }), w3 = await gate(film, web, { origin: 'https://evil.test' });
    (pool as any).query = orig;
    check('warm: allowed and refused answers with no database read', [w1.s, w2.s, w3.s, life(w2.j.delivery?.hls), reads], [200, 200, 403, 600, 0]);
  } catch (e: any) {
    console.log('FAIL threw: ' + (e?.stack ?? e)); fail++;
  } finally {
    srv.close();
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
