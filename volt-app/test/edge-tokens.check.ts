// ============================================================================
//  EDGE PLAY TOKENS FOR ON-DEMAND MEDIA (build queue P2, services/edgeTokens.ts,
//  deploy/edge/vod-token-viewer-request.js, deploy/staging/edge-token.js,
//  migration 0151).
//
//  Pure: the claims, the expiry cut to the title's window, the lifetimes, the
//  folder a token opens, the URL with the token in its path, the policy class.
//  The check itself three times on the same cases: the TypeScript reference,
//  the real CloudFront Function file and the real staging njs file (each run
//  here with stand-ins for their runtime's modules): valid, tampered, expired,
//  early, outside its folder, another country, revoked, issued after the
//  revocation, and no key in the store. Then over real HTTP against a
//  database: tokens off leaves the play gate's URLs as they were; on, the
//  gate's on-demand URLs carry a token for that folder, country and window
//  (POST and GET); withdrawing a title writes a revocation that the sync puts
//  in the edge store, so the token handed out before stops and one minted
//  after plays; an expired revocation leaves the store and the table; a warm
//  gate with tokens on still makes no database read.
//    DATABASE_URL=... npx tsx test/edge-tokens.check.ts
// ============================================================================
import { readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};

(async () => {
  const T = await import('../src/services/edgeTokens');
  const crypto = await import('node:crypto');
  const NOW = 1_800_000_000;
  const KEY = 'k'.repeat(64);
  const A = '11111111-1111-4111-8111-111111111111';
  const PRE = `/vod/${A}/`;

  // ---------------------------------------------------------------- pure
  const t1 = T.mintEdgeToken({ assetId: A, prefix: PRE, country: 'au', policyClass: 'rights', sid: 'sid-12345678', nowSec: NOW, key: KEY });
  check('claims: asset, folder, country upper-cased, class, clear, sid, issued, expiry', t1.claims,
    { a: A, p: PRE, c: 'AU', k: 'rights', d: 0, s: 'sid-12345678', n: NOW, e: NOW + 4 * 3600 });
  check('open content lives 24 hours', T.mintEdgeToken({ assetId: A, prefix: PRE, policyClass: 'open', nowSec: NOW, key: KEY }).claims.e, NOW + 86400);
  const cut = T.mintEdgeToken({ assetId: A, prefix: PRE, policyClass: 'open', nowSec: NOW, key: KEY, effectiveUntil: new Date((NOW + 1800) * 1000) });
  check('expiry is cut to the end of the window', cut.claims.e, NOW + 1800);
  process.env.EDGE_TOKEN_TTL_SEC = '600';
  check('the lifetime can be set (EDGE_TOKEN_TTL_SEC)', [T.tokenLifetimeSec('members'), T.tokenLifetimeSec('open')], [600, 86400]);
  process.env.EDGE_TOKEN_TTL_SEC = '5';
  check('...never under a minute (falls back to the default)', T.tokenLifetimeSec('premium'), 4 * 3600);
  delete process.env.EDGE_TOKEN_TTL_SEC;
  check('a revocation is kept as long as the longest token', T.maxTokenLifetimeSec(), 86400);
  check('token shape: base64url claims, 32 hex', /^[A-Za-z0-9_-]+\.[0-9a-f]{32}$/.test(t1.token), true);

  check('the folder of an encode (HLS and DASH side by side)', T.tokenPrefix([`/clips/vod/${A}/master.m3u8`, `/clips/vod/${A}/manifest.mpd`]), `/clips/vod/${A}/`);
  check('...on the CDN', T.tokenPrefix([`https://cdn.example.net/vod/${A}/master.m3u8`, null]), PRE);
  check('...of a clip', T.tokenPrefix(['/clips/abc/hls/index.m3u8']), '/clips/abc/hls/');
  check('two folders share their parent', T.tokenPrefix([`/vod/${A}/hls/master.m3u8`, `/vod/${A}/dash/manifest.mpd`]), PRE);
  check('never a folder one level deep ("/clips/")', T.tokenPrefix(['/clips/a.m3u8', '/clips/b.mpd']), null);
  check('nothing to open', T.tokenPrefix([null, undefined]), null);
  check('the token goes in front of the path (relative)', T.withToken(`/clips/vod/${A}/master.m3u8`, 'TOK.x'), `/t/TOK.x/clips/vod/${A}/master.m3u8`);
  check('...absolute, query kept', T.withToken(`https://cdn.example.net/vod/${A}/master.m3u8?x=1`, 'TOK.x'), `https://cdn.example.net/t/TOK.x/vod/${A}/master.m3u8?x=1`);
  check('...no URL stays none', T.withToken(null, 'TOK.x'), null);
  check('policy class', [T.policyClassOf({ territoryMode: 'worldwide', via: 'no_rule' }), T.policyClassOf({ territoryMode: 'allow', via: 'entitlement' }),
    T.policyClassOf({ via: 'entitlement' }), T.policyClassOf({ via: 'members' }), T.policyClassOf({})], ['open', 'rights', 'premium', 'members', 'open']);

  // ---- the check, three implementations on the same cases
  const cfSrc = readFileSync(join(__dirname, '../../deploy/edge/vod-token-viewer-request.js'), 'utf8');
  check('the function names its store through Terraform', cfSrc.includes("cf.kvs('${kvs_id}')"), true);
  check('the function is inside CloudFront Functions\' 10 KB', Buffer.byteLength(cfSrc) < 10240, true);
  const store: Record<string, string> = {};
  (globalThis as any).__cf = { kvs: (id: string) => ({ async get(k: string) { if (id !== 'kvs-test') throw new Error('wrong store'); if (!(k in store)) throw new Error('key not found'); return store[k]; } }) };
  (globalThis as any).__crypto = crypto;
  const cfHandler = new Function(`${cfSrc.replace("import cf from 'cloudfront';", 'const cf = globalThis.__cf;').replace("import crypto from 'crypto';", 'const crypto = globalThis.__crypto;').replace('${kvs_id}', 'kvs-test')}\nreturn handler;`)();
  const njsSrc = readFileSync(join(__dirname, '../../deploy/staging/edge-token.js'), 'utf8');
  check('the staging edge file exports what nginx.conf calls', /export default \{ verdict, check \}/.test(njsSrc), true);
  const njs = new Function(`${njsSrc.replace("import fs from 'fs';", 'const fs = null;').replace("import crypto from 'crypto';", 'const crypto = globalThis.__crypto;').replace(/export default .*/, 'return { verdict, check };')}`)();
  const realNow = Date.now;
  const three = async (uri: string, cc: string, at = NOW) => {
    Date.now = () => at * 1000;
    const m = /^\/t\/([^/]+)(\/.*)$/.exec(uri);
    const ts = m ? T.verifyEdgeToken(m[1], m[2], { country: cc, nowSec: at, revokedAt: store['r:' + A] ? Number(store['r:' + A]) : null, key: store['k:pt'] ?? 'no-key' }).verdict : 'malformed';
    const out = await cfHandler({ request: { uri, headers: cc ? { 'cloudfront-viewer-country': { value: cc } } : {} } });
    const cfv = out.statusCode ? String(out.statusCode) : out.uri;
    const nv = njs.check(uri, cc, store, at);
    Date.now = realNow;
    return [ts, cfv, nv];
  };
  const tok = (o: any = {}) => T.mintEdgeToken({ assetId: A, prefix: PRE, country: 'AU', policyClass: 'rights', nowSec: NOW, key: KEY, ...o }).token;
  const good = tok();
  check('no key in the store yet: 503 at both edges, never "open"', (await three(`/t/${good}${PRE}master.m3u8`, 'AU')).slice(1), ['503', '503']);
  store['k:pt'] = KEY;
  check('valid: the plain path goes on (manifest)', await three(`/t/${good}${PRE}master.m3u8`, 'AU'), ['ok', `${PRE}master.m3u8`, 'ok']);
  check('valid: a segment below it', await three(`/t/${good}${PRE}720p/seg_3.m4s`, 'au'), ['ok', `${PRE}720p/seg_3.m4s`, 'ok']);
  check('valid: the viewer country unknown at the edge is not a mismatch', await three(`/t/${good}${PRE}master.m3u8`, ''), ['ok', `${PRE}master.m3u8`, 'ok']);
  const [body, sg] = good.split('.');
  const flip = sg.slice(0, -1) + (sg.endsWith('0') ? '1' : '0');
  check('tampered signature: 403', await three(`/t/${body}.${flip}${PRE}master.m3u8`, 'AU'), ['signature', '403', '403']);
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), c: 'JP' })).toString('base64url');
  check('claims changed under the old signature (country): 403', await three(`/t/${forged}.${sg}${PRE}master.m3u8`, 'JP'), ['signature', '403', '403']);
  check('signed with another key: 403', await three(`/t/${tok({ key: 'x'.repeat(64) })}${PRE}master.m3u8`, 'AU'), ['signature', '403', '403']);
  check('expired: 403 from the second it ends', await three(`/t/${good}${PRE}master.m3u8`, 'AU', NOW + 4 * 3600), ['expired', '403', '403']);
  check('...and one second before it still plays', await three(`/t/${good}${PRE}master.m3u8`, 'AU', NOW + 4 * 3600 - 1), ['ok', `${PRE}master.m3u8`, 'ok']);
  const win = tok({ effectiveUntil: new Date((NOW + 600) * 1000) });
  check('the window\'s end, to the second, with no dates at the edge', [(await three(`/t/${win}${PRE}a.m3u8`, 'AU', NOW + 599))[0], await three(`/t/${win}${PRE}a.m3u8`, 'AU', NOW + 600)], ['ok', ['expired', '403', '403']]);
  check('not yet valid (more than a minute early): 403', await three(`/t/${good}${PRE}master.m3u8`, 'AU', NOW - 61), ['early', '403', '403']);
  check('another title\'s folder: 403', await three(`/t/${good}/vod/22222222-2222-4222-8222-222222222222/master.m3u8`, 'AU'), ['path', '403', '403']);
  check('climbing out of the folder: 403', await three(`/t/${good}${PRE}../22222222-2222-4222-8222-222222222222/master.m3u8`, 'AU'), ['path', '403', '403']);
  check('another country (a URL shared across a border): 403', await three(`/t/${good}${PRE}master.m3u8`, 'NZ'), ['country', '403', '403']);
  check('a token with no country plays anywhere', (await three(`/t/${tok({ country: null })}${PRE}master.m3u8`, 'NZ'))[0], 'ok');
  check('garbage in the token place: 403', (await three(`/t/not-a-token${PRE}master.m3u8`, 'AU')).slice(1), ['403', '403']);
  store['r:' + A] = String(NOW + 10);
  check('revoked: a token issued before the revocation is refused', await three(`/t/${good}${PRE}master.m3u8`, 'AU', NOW + 20), ['revoked', '403', '403']);
  const after = tok({ nowSec: NOW + 30 });
  check('...one issued after it (republished) plays', await three(`/t/${after}${PRE}master.m3u8`, 'AU', NOW + 40), ['ok', `${PRE}master.m3u8`, 'ok']);
  delete store['r:' + A];
  check('refusals are never cached', (await cfHandler({ request: { uri: `/t/${body}.${flip}${PRE}m.m3u8`, headers: {} } })).headers['cache-control'].value, 'no-store');

  // ---- the staging nginx config wires the file in
  const conf = readFileSync(join(__dirname, '../../deploy/staging/nginx.conf.template'), 'utf8');
  check('nginx: njs loaded and the verdict set', [/load_module modules\/ngx_http_js_module\.so;/.test(conf), /js_set \$edge_token edgetoken\.verdict;/.test(conf)], [true, true]);
  check('nginx: /t/ only to /clips/, refused unless ok, prefix stripped', [/location ~ \^\/t\/\[\^\/\]\+\/clips\/ \{/.test(conf), conf.includes('if ($edge_token != "ok") { return 403; }'), conf.includes('rewrite ^/t/[^/]+(/.*)$ $1 break;'), conf.includes('location ~ ^/t/ { return 403; }')], [true, true, true, true]);

  // ---------------------------------------------------------------- database
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { invalidateTag } = await import('../src/scale/cache');
  const P = await import('../src/services/publicStatus');
  const tag = Date.now().toString(36);
  const a = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`et-${tag}`]))!.id;
  const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `et-${tag}@volt.test`]))!.id;
  const otok = signAccess({ sub: u, account_id: a, role: 'owner' });
  const LIVE = `availability_state = 'available', published = true, availability = '{"targets":[{"kind":"portal"}],"access":"free"}'::jsonb, available_from = now() - interval '1 day'`;
  const asset = async (title: string, set = LIVE) => {
    const id = (await one<any>(
      `INSERT INTO vod_assets(account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms)
       VALUES ($1,'upload','clip',$2,'x',0,60000,60000) RETURNING id`, [a, title]))!.id;
    await query(`UPDATE vod_assets SET master_key = $2, formats = '{"hls":true,"dash":true}'::jsonb, ${set} WHERE id = $1`, [id, `/clips/vod/${id}/master.m3u8`]);
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
    const cols = await query<any>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'edge_revocations' ORDER BY 1`);
    check('migration 0151: the revocation set', cols.map((c) => c.column_name), ['asset_id', 'expires_at', 'reason', 'revoked_at']);
    const pk = (await http('POST', '/api/apps', { name: 'Web', type: 'web' }, otok)).j.publishableKey.key;
    const gate = (id: string, geo = 'AU') => http('POST', '/api/availability', { appKey: pk, assetId: id, geo, sid: 'sid-abcdef12' });
    const gateGet = (id: string, geo = 'AU') => http('GET', `/api/availability?appKey=${encodeURIComponent(pk)}&assetId=${id}&geo=${geo}`);
    const film = await asset('Film');

    delete process.env.VOLT_EDGE_TOKENS;
    const off = await gate(film);
    check('tokens off: the URLs are as they were', [off.s, off.j.delivery?.hls, off.j.delivery?.dash], [200, `/clips/vod/${film}/master.m3u8`, `/clips/vod/${film}/manifest.mpd`]);

    process.env.VOLT_EDGE_TOKENS = 'issue';
    const on = await gate(film);
    const hm = /^\/t\/([^/]+)(\/clips\/vod\/.*)$/.exec(on.j.delivery?.hls ?? '');
    const dm = /^\/t\/([^/]+)(\/clips\/vod\/.*)$/.exec(on.j.delivery?.dash ?? '');
    check('tokens on: both URLs carry one token in the path', [on.s, !!hm, !!dm, hm?.[1] === dm?.[1], hm?.[2], dm?.[2]],
      [200, true, true, true, `/clips/vod/${film}/master.m3u8`, `/clips/vod/${film}/manifest.mpd`]);
    const now = Math.floor(Date.now() / 1000);
    const v = T.verifyEdgeToken(hm![1], hm![2], { country: 'AU', nowSec: now });
    check('...which the edge accepts for that folder', [v.verdict, v.claims?.p, v.claims?.a], ['ok', `/clips/vod/${film}/`, film]);
    check('...bound to the country, the attempt, open, clear, 24 hours', [v.claims?.c, v.claims?.s, v.claims?.k, v.claims?.d, (v.claims?.e ?? 0) - (v.claims?.n ?? 0)], ['AU', 'sid-abcdef12', 'open', 0, 86400]);
    check('...refused from another country', T.verifyEdgeToken(hm![1], hm![2], { country: 'US', nowSec: now }).verdict, 'country');
    check('...and for a segment of another title', T.verifyEdgeToken(hm![1], `/clips/vod/${await asset('Other')}/720p/seg_1.m4s`, { nowSec: now }).verdict, 'path');
    const g = await gateGet(film);
    check('the anonymous GET gate hands out a token too', [g.s, /^\/t\/[^/]+\/clips\/vod\//.test(g.j.delivery?.hls ?? '')], [200, true]);

    const short = await asset('Short window', `${LIVE}, available_until = now() + interval '20 minutes'`);
    const sv = T.verifyEdgeToken(/^\/t\/([^/]+)/.exec((await gate(short)).j.delivery.hls)![1], `/clips/vod/${short}/master.m3u8`, { nowSec: now });
    const until = (await one<any>(`SELECT floor(extract(epoch FROM available_until))::bigint AS e FROM vod_assets WHERE id = $1`, [short]))!.e;
    check('a title whose window ends in 20 minutes: the token ends with it', [sv.verdict, sv.claims?.e], ['ok', Number(until)]);

    // ---- revocation: withdraw, sync, the old token stops, a new one plays
    const dir = mkdtempSync(join(tmpdir(), 'edge-store-'));
    const fstore = await T.fileEdgeStore(join(dir, 'store.json'));
    const memo = new Map<string, string | null>();
    await T.syncEdgeTokens(fstore, memo);
    check('the sync puts the signing key in the store', await fstore.get('k:pt'), T.edgeTokenKey());
    const before = hm![1];
    const wd = await http('POST', `/api/vod/${film}/withdraw`, {}, otok);
    if (wd.s >= 400) { const { withdraw } = await import('../src/services/availability'); await withdraw(film, 'test'); }
    await P.refreshPublicStatus(film);
    const rv = await one<any>(`SELECT extract(epoch FROM revoked_at)::bigint AS at, extract(epoch FROM expires_at - revoked_at)::bigint AS keep FROM edge_revocations WHERE asset_id = $1`, [film]);
    check('withdrawing an available title writes a revocation, kept as long as a token lives', [!!rv, Number(rv?.keep)], [true, 86400]);
    const s1 = await T.syncEdgeTokens(fstore, memo);
    check('the sync puts it at r:<asset id>', [await fstore.get(`r:${film}`), s1.put >= 1], [String(rv?.at), true]);
    const st = JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8'));
    const nowS = Math.floor(Date.now() / 1000);
    check('the staging edge, reading that file: the token from before is refused', njs.check(`/t/${before}/clips/vod/${film}/master.m3u8`, 'AU', st, nowS), '403');
    check('the gate no longer plays the title at all', (await gate(film)).s, 404);
    await query(`UPDATE vod_assets SET ${LIVE}, withdrawn_at = NULL WHERE id = $1`, [film]);
    await P.refreshPublicStatus(film); invalidateTag(`asset:${film}`);
    const fresh = T.mintEdgeToken({ assetId: film, prefix: `/clips/vod/${film}/`, policyClass: 'open', nowSec: Number(rv.at) + 1 }).token;
    check('republished: a token minted after the revocation plays at the staging edge', njs.check(`/t/${fresh}/clips/vod/${film}/master.m3u8`, 'AU', st, Number(rv.at) + 2), 'ok');
    const again = await T.syncEdgeTokens(fstore, memo);
    check('a steady store: the sync writes nothing', [again.put, again.deleted], [0, 0]);
    await query(`UPDATE edge_revocations SET expires_at = now() - interval '1 second' WHERE asset_id = $1`, [film]);
    const gone = await T.syncEdgeTokens(fstore, memo);
    check('an expired revocation leaves the store and the table', [gone.deleted, await fstore.get(`r:${film}`), !!(await one(`SELECT 1 FROM edge_revocations WHERE asset_id = $1`, [film]))], [1, null, false]);
    const draft = await asset('Never public', `availability_state = 'draft'`);
    await P.refreshPublicStatus(draft);
    check('a title that was never available is not revoked', !!(await one(`SELECT 1 FROM edge_revocations WHERE asset_id = $1`, [draft])), false);

    // ---- scale: tokens on, a warm gate still reads nothing
    const warm = await asset('Warm');
    await gateGet(warm); await gate(warm);
    const orig = (pool as any).query.bind(pool);
    let reads = 0;
    (pool as any).query = (...q: any[]) => { reads++; return orig(...q); };
    const w1 = await gateGet(warm), w2 = await gate(warm);
    (pool as any).query = orig;
    check('warm, tokens on: tokenised answers with no database read', [w1.s, w2.s, /^\/t\//.test(w2.j.delivery.hls), reads], [200, 200, true, 0]);
  } catch (e: any) {
    console.log('FAIL threw: ' + (e?.stack ?? e)); fail++;
  } finally {
    srv.close();
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
