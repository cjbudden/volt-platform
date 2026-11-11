// ============================================================================
//  TOKEN-FREE PLAYBACK (build queue P2-2c; services/deliveryPolicy.ts
//  tokenFreeBlockers and tokenFreeNow, services/publishingPolicies.ts,
//  services/edgeTokens.ts syncEdgeOpen and the plain-path check,
//  deploy/edge/vod-plain-refuse.js, deploy/staging/edge-token.js).
//
//  A publishing rule may ask for token-free playback (protection.tokenFree).
//  It cannot be saved where a viewer condition applies (geo, rights, DRM, a
//  paywall, sign-in, referrer domains, a streams limit); a title stamped with
//  it that gains one plays with tokens as before. Under enforce, the play gate
//  hands a token-free title's plain addresses out, and the API, the staging
//  edge and CloudFront let them through while the title is Available, from
//  "f:<asset id>" in the edge store; everything else stays refused.
//    DATABASE_URL=... npx tsx test/edge-token-free.check.ts
// ============================================================================
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLIPS = mkdtempSync(join(tmpdir(), 'volt-tokenfree-'));
process.env.CLIPS_DIR = CLIPS;
process.env.TRUST_EDGE_GEO = 'true';
delete process.env.EDGE_SHARED_SECRET;
process.env.VOLT_EDGE_TOKENS = 'enforce';

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};

(async () => {
  const T = await import('../src/services/edgeTokens');
  const D = await import('../src/services/deliveryPolicy');
  const PP = await import('../src/services/publishingPolicies');
  const { BASELINE, SECTION_FIELDS, LOCKABLE_FIELDS } = await import('../src/services/publishingRules');
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { invalidateTag } = await import('../src/scale/cache');
  const P = await import('../src/services/publicStatus');

  // ---------------------------------------------------------------- pure: what stops it
  const S = (o: any = {}) => ({ ...BASELINE, ...o, protection: { ...BASELINE.protection, tokenFree: true, ...(o.protection ?? {}) } });
  const codes = (s: any, o: any = {}) => D.tokenFreeBlockers(s, o).map((b) => b.code);
  check('the field exists, off by default, lockable', [SECTION_FIELDS.protection.includes('tokenFree'), (BASELINE.protection as any).tokenFree, LOCKABLE_FIELDS.includes('protection.tokenFree')], [true, false, true]);
  check('open content: nothing stops it', codes(S()), []);
  check('a world-wide free rule is not a condition', codes(S({ accessRules: [{ id: 'w', for: { scopes: ['this'] }, if: { geo: 'in', countries: ['WORLD'] }, then: { access: 'free' } }] })), []);
  check('geo allow and block', [codes(S({ geo: { mode: 'allow', countries: ['AU'] } })), codes(S({ geo: { mode: 'block', countries: ['US'] } }))], [['geo'], ['geo']]);
  check('an access rule naming countries', codes(S({ accessRules: [{ id: 'x', for: { scopes: ['this'] }, if: { geo: 'not_in', countries: ['US'] }, then: { access: 'free' } }] })), ['geo']);
  check('paid, entitled, a paywall, a premium rule', [codes(S({ access: 'paid' })), codes(S({ access: 'entitled' })), codes(S({ paywall: { tier: 'gold' } })),
    codes(S({ accessRules: [{ id: 'p', for: { scopes: ['this'] }, if: { geo: 'in', countries: ['WORLD'] }, then: { access: 'premium' } }] }))], [['paywall'], ['paywall'], ['paywall'], ['paywall']]);
  check('sign-in: a members rule, a viewer group', [codes(S({ accessRules: [{ id: 'm', for: { scopes: ['this'] }, if: { geo: 'in', countries: ['WORLD'] }, then: { access: 'members' } }] })),
    codes(S({ accessRules: [{ id: 'g', for: { scopes: ['this'] }, if: { geo: 'in', countries: ['WORLD'] }, then: { access: 'free', userGroups: ['staff'] } }] }))], [['sign_in'], ['sign_in']]);
  check('DRM, referrers, a streams limit', [codes(S({ protection: { drm: true } })), codes(S({ protection: { referrers: ['a.com'] } })), codes(S({ protection: { concurrentStreams: 2 } }))], [['drm'], ['referrers'], ['concurrent']]);
  check('rights territories or apps, the account\'s geo, a collection asking for a package',
    [codes(S(), { rights: { territoryMode: 'allow', appMode: 'all' } }), codes(S(), { rights: { territoryMode: 'worldwide', appMode: 'allow' } }), codes(S(), { rights: { territoryMode: 'worldwide', appMode: 'all' } }),
     codes(S(), { accountGeo: { mode: 'block', countries: ['IL'] } }),
     codes(S(), { collectionAccess: { v: 1, g: [{ levels: [{ rules: [{ access: 'premium' }] }] }] } }), codes(S(), { collectionAccess: { v: 1, g: [{ levels: [{ rules: [{ access: 'free' }] }] }] } })],
    [['rights'], ['rights'], [], ['account'], ['collection'], []]);

  // ---------------------------------------------------------------- the conflict check
  const cf = (s: any, o: any = {}) => PP.policyConflicts(s, o).filter((c) => c.code === 'token_free_conditions');
  check('a policy asking for it with no condition: no conflict', cf(S()).length, 0);
  const g1 = cf(S({ geo: { mode: 'allow', countries: ['AU'] }, protection: { drm: true }, distribution: { ...BASELINE.distribution, mp4Download: false } }));
  check('with geo and DRM: one block naming both and their fields', [g1.length, g1[0]?.level, g1[0]?.fields, /limited to some countries, DRM is on/.test(g1[0]?.message ?? '')],
    [1, 'block', ['protection.tokenFree', 'geo', 'protection.drm'], true]);
  check('with a title whose rights limit territories: a block', cf(S(), { title: { rights: { territoryMode: 'allow', appMode: 'all' } } }).length, 1);
  check('token-free off: no conflict whatever else is set', cf({ ...BASELINE, geo: { mode: 'allow', countries: ['AU'] } }).length, 0);
  check('its label', PP.fieldLabel('protection.tokenFree'), 'Token-free playback');

  // ---------------------------------------------------------------- the database parts
  const tag = Date.now().toString(36);
  const a = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`tf-${tag}`]))!.id;
  const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `tf-${tag}@volt.test`]))!.id;
  const tok = signAccess({ sub: u, account_id: a, role: 'owner' });
  // Rules are saved on an account of their own: a saved rule restamps that
  // account's published titles (P3-4), which would rewrite the stamps below.
  const b = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`tf2-${tag}`]))!.id;
  const ub = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [b, `tf2-${tag}@volt.test`]))!.id;
  const tokB = signAccess({ sub: ub, account_id: b, role: 'owner' });
  const STAMP = (o: any = {}) => JSON.stringify({ targets: [{ kind: 'portal' }], access: 'free', geo: { mode: 'worldwide', countries: [] }, ...o, protection: { tokenFree: true, ...(o.protection ?? {}) } });
  const mkAsset = async (title: string, stamp: string | null, extra = '') => {
    const id = (await one<any>(
      `INSERT INTO vod_assets(account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, formats)
       VALUES ($1,'upload','clip',$2,0,60000,60000,'{"hls":true,"dash":true}'::jsonb) RETURNING id`, [a, title]))!.id;
    await query(`UPDATE vod_assets SET master_key = $2, availability_state = 'available', published = true, media_state = 'ready',
                   availability = COALESCE($3::jsonb, '{"targets":[{"kind":"portal"}],"access":"free"}'::jsonb), available_from = now() - interval '1 day' ${extra} WHERE id = $1`,
      [id, `/clips/vod/${id}/master.m3u8`, stamp]);
    mkdirSync(join(CLIPS, 'vod', id, '720p'), { recursive: true });
    writeFileSync(join(CLIPS, 'vod', id, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n720p/index.m3u8\n');
    writeFileSync(join(CLIPS, 'vod', id, 'manifest.mpd'), '<MPD/>');
    writeFileSync(join(CLIPS, 'vod', id, '720p', 'seg_1.m4s'), 'SEGMENT');
    await P.refreshPublicStatus(id); invalidateTag(`asset:${id}`);
    return id;
  };
  const free = await mkAsset('Free for all', STAMP(), `, available_until = now() + interval '3 days'`);
  const normal = await mkAsset('Ordinary', null);
  const stale = await mkAsset('Token-free, then geo', STAMP({ geo: { mode: 'allow', countries: ['AU'] } }));
  const drm = await mkAsset('Token-free, then DRM', STAMP({ protection: { drm: true } }));

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const http = async (method: string, path: string, body?: any, auth?: string, h: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...h }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j: any = null; try { j = JSON.parse(t); } catch { j = t; }
    return { s: r.status, j, t };
  };
  try {
    const cols = await query<any>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'edge_open_assets' ORDER BY 1`);
    check('migration 0162: the token-free set the edge was told', cols.map((c) => c.column_name), ['asset_id', 'synced_at', 'value']);

    // ---- saving a rule
    const save = (body: any) => http('PUT', '/api/publishing-rules/account', body, tokB);
    const bad = await save({ settings: { geo: { mode: 'allow', countries: ['AU'] }, protection: { tokenFree: true, waf: 'standard' } } });
    check('a rule asking for token-free with geo: refused 422 policy_conflict', [bad.s, bad.j.code, (bad.j.details?.conflicts ?? []).some((c: any) => c.code === 'token_free_conditions')], [422, 'policy_conflict', true]);
    const badDrm = await save({ settings: { protection: { tokenFree: true, drm: true }, distribution: { mp4Download: false } } });
    check('...with DRM: refused', [badDrm.s, (badDrm.j.details?.conflicts ?? []).map((c: any) => c.code)], [422, ['token_free_conditions']]);
    const badPaid = await save({ settings: { access: 'paid', protection: { tokenFree: true } } });
    check('...with a paywall: refused', badPaid.s, 422);
    const dry = await http('PUT', '/api/publishing-rules/account?dryRun=1', { settings: { access: 'free', accessRules: [{ id: 'm', for: { scopes: ['this', 'live', 'ondemand'] }, if: { geo: 'in', countries: ['WORLD'] }, then: { access: 'members' } }], protection: { tokenFree: true } } }, tokB);
    check('...with sign-in: the dry run says it cannot be saved', [dry.s, dry.j.canSave, dry.j.conflicts.map((c: any) => c.code)], [200, false, ['token_free_conditions']]);
    const ok = await save({ settings: { protection: { tokenFree: true } } });
    const stored = await one<any>(`SELECT settings FROM publishing_rules WHERE account_id = $1 AND scope_kind = 'account'`, [b]);
    check('open content: saved', [ok.s, stored?.settings?.protection?.tokenFree], [200, true]);
    const fields = await http('GET', '/api/publishing-rules/fields', undefined, tokB);
    check('GET fields lists it under Protection with its label', [fields.j.sections.protection.includes('protection.tokenFree'), fields.j.labels['protection.tokenFree']], [true, 'Token-free playback']);
    check('a non-boolean is refused', (await save({ settings: { protection: { tokenFree: 'yes' } } })).s >= 400, true);
    await save({ settings: { protection: { tokenFree: false } } });

    // ---- tokenFreeNow
    const now = await D.tokenFreeNow(free, { accountId: a });
    check('tokenFreeNow: an open token-free title plays plain until its window ends', [now.open, !!now.until], [true, true]);
    check('...an ordinary one does not', (await D.tokenFreeNow(normal)).open, false);
    const st = await D.tokenFreeNow(stale);
    check('...an old stamp that gained geo is ignored, and says why', [st.open, st.blockers.map((b) => b.code)], [false, ['geo']]);
    check('...one with DRM too', (await D.tokenFreeNow(drm)).open, false);

    // ---- the play gate
    const pk = (await http('POST', '/api/apps', { name: 'Web', type: 'web' }, tok)).j.publishableKey.key;
    const gate = (id: string) => http('POST', '/api/availability', { appKey: pk, assetId: id, geo: 'AU', sid: 'sid-tokenfree1' });
    const gf = await gate(free);
    check('the gate hands a token-free title its plain addresses', [gf.s, gf.j.delivery?.hls, gf.j.delivery?.dash], [200, `/clips/vod/${free}/master.m3u8`, `/clips/vod/${free}/manifest.mpd`]);
    const gn = await gate(normal);
    check('...an ordinary title still gets a token', [gn.s, /^\/t\/[^/]+\/clips\/vod\//.test(gn.j.delivery?.hls ?? '')], [200, true]);
    const gs = await gate(stale);
    check('...and so does a token-free stamp a condition now applies to', [gs.s, /^\/t\//.test(gs.j.delivery?.hls ?? '')], [200, true]);
    const gget = await http('GET', `/api/availability?appKey=${encodeURIComponent(pk)}&assetId=${free}&geo=AU`);
    check('the anonymous GET gate too', [gget.s, gget.j.delivery?.hls], [200, `/clips/vod/${free}/master.m3u8`]);
    // scale: warm, a token-free answer and its plain manifest at the API read nothing
    await gate(free); await http('GET', `/clips/vod/${free}/master.m3u8`);
    const orig = (pool as any).query.bind(pool);
    let reads = 0;
    (pool as any).query = (...q: any[]) => { reads++; return orig(...q); };
    const w1 = await gate(free), w2 = await http('GET', `/clips/vod/${free}/master.m3u8`);
    (pool as any).query = orig;
    check('warm: the gate\'s token-free answer and the API\'s plain-path check make no database read', [w1.s, w1.j.delivery?.hls, w2.s, reads], [200, `/clips/vod/${free}/master.m3u8`, 200, 0]);

    // ---- the API's own plain-path check under enforce
    const get = (p: string) => http('GET', p);
    check('enforce: the token-free title plays by plain address (manifest, segment)', [(await get(`/clips/vod/${free}/master.m3u8`)).s, (await get(`/clips/vod/${free}/720p/seg_1.m4s`)).t], [200, 'SEGMENT']);
    check('...the others are still refused plain', [(await get(`/clips/vod/${normal}/master.m3u8`)).s, (await get(`/clips/vod/${stale}/master.m3u8`)).s, (await get(`/clips/vod/${drm}/master.m3u8`)).s], [403, 403, 403]);
    check('...an ordinary title\'s token still plays', (await get(gn.j.delivery.hls)).s, 200);
    check('...a path climbing out of the free title\'s folder is refused', (await get(`/clips/vod/${free}/../${normal}/master.m3u8`)).s === 200, false);

    // ---- the edge set
    const storeFile = join(CLIPS, 'edge', 'store.json');
    const store = await T.fileEdgeStore(storeFile);
    const r1 = await T.syncEdgeOpen(store);
    const kv = () => JSON.parse(readFileSync(storeFile, 'utf8'));
    const until = Math.floor(now.until!.getTime() / 1000);
    check('sync: f:<id> for the token-free title only, holding the end of its window', [r1.put, kv()[T.openKey(free)], T.openKey(normal) in kv(), T.openKey(stale) in kv()], [1, String(until), false, false]);
    check('...and remembered in edge_open_assets', (await query<any>(`SELECT asset_id::text AS id, value FROM edge_open_assets`)).map((r) => [r.id, r.value]), [[free, String(until)]]);
    check('a second sync writes nothing', await T.syncEdgeOpen(store), { put: 0, deleted: 0 });
    // the title's stamp loses token-free (a rule changed and it was restamped)
    await query(`UPDATE vod_assets SET availability = availability #- '{protection,tokenFree}' WHERE id = $1`, [free]);
    invalidateTag(`asset:${free}`);
    check('turned off: the plain address is refused at the API at once', (await get(`/clips/vod/${free}/master.m3u8`)).s, 403);
    const r2 = await T.syncEdgeOpen(store);
    check('...and the next sync removes the key and the row', [r2.deleted, T.openKey(free) in kv(), (await query<any>(`SELECT 1 FROM edge_open_assets`)).length], [1, false, 0]);
    // back on, then withdrawn
    await query(`UPDATE vod_assets SET availability = jsonb_set(availability, '{protection}', '{"tokenFree":true}') WHERE id = $1`, [free]);
    invalidateTag(`asset:${free}`);
    await T.syncEdgeOpen(store);
    await query(`UPDATE vod_assets SET availability_state = 'withdrawn' WHERE id = $1`, [free]);
    await P.refreshPublicStatus(free); invalidateTag(`asset:${free}`);
    check('withdrawn: refused plain at the API, the gate answers 404', [(await get(`/clips/vod/${free}/master.m3u8`)).s, (await gate(free)).s], [403, 404]);
    check('...and the sync removes it from the edge', [(await T.syncEdgeOpen(store)).deleted, T.openKey(free) in kv()], [1, false]);
    process.env.VOLT_EDGE_TOKENS = 'issue';
    check('issue: plain addresses play as before', (await get(`/clips/vod/${normal}/master.m3u8`)).s, 200);
    process.env.VOLT_EDGE_TOKENS = 'enforce';

    // ---------------------------------------------------------------- the two edges' files against the reference
    const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
    const nowS = Math.floor(Date.now() / 1000);
    const cases: [string, string, string | null, number][] = [
      [`/vod/${id}/master.m3u8`, 'enforce', '0', nowS],
      [`/clips/vod/${id}/720p/seg_1.m4s`, 'enforce', String(nowS + 60), nowS],
      [`/vod/${id}/master.m3u8`, 'enforce', String(nowS - 1), nowS],
      [`/vod/${id}/master.m3u8`, 'enforce', null, nowS],
      [`/vod/${id.toUpperCase()}/master.m3u8`, 'enforce', '0', nowS],
      [`/vod/${id}/../other/master.m3u8`, 'enforce', '0', nowS],
      [`/vod/not-an-id/master.m3u8`, 'enforce', '0', nowS],
      [`/vod/${id}/master.m3u8`, 'issue', null, nowS],
      [`/clips/other/index.m3u8`, 'enforce', null, nowS],
    ];
    const ref = cases.map(([uri, mode, open, n]) => T.plainPathVerdict(uri, mode, open, n));
    check('the reference on its cases', ref, ['ok', 'ok', '403', '403', 'ok', '403', '403', 'ok', 'ok']);
    const njsSrc = readFileSync(join(__dirname, '../../deploy/staging/edge-token.js'), 'utf8');
    const njs = new Function(`${njsSrc.replace("import fs from 'fs';", 'const fs = null;').replace("import crypto from 'crypto';", 'const crypto = null;').replace(/export default .*/, 'return { plainVerdict };')}`)();
    check('the staging edge agrees with the reference', cases.map(([uri, mode, open, n]) => njs.plainVerdict(uri, mode, open == null ? {} : { [`f:${id}`]: open }, n)), ref);
    const cfSrc = readFileSync(join(__dirname, '../../deploy/edge/vod-plain-refuse.js'), 'utf8');
    check('the CloudFront function names its store through Terraform, inside 10 KB', [cfSrc.includes("cf.kvs('${kvs_id}')"), Buffer.byteLength(cfSrc) < 10240], [true, true]);
    let kvsData: Record<string, string> = {};
    (globalThis as any).__cft = { kvs: (k: string) => ({ async get(key: string) { if (k !== 'kvs-test') throw new Error('wrong store'); if (!(key in kvsData)) throw new Error('key not found'); return kvsData[key]; } }) };
    const cfh = new Function(`${cfSrc.replace("import cf from 'cloudfront';", 'const cf = globalThis.__cft;').replace('${kvs_id}', 'kvs-test')}\nreturn handler;`)();
    // The function is only attached under enforce, on the plain on-demand behaviours: those cases.
    const enforced = cases.filter(([uri, mode]) => mode === 'enforce' && /^\/(clips\/vod|vod)\//.test(uri));
    const cfOut: string[] = [];
    for (const [uri, , open] of enforced) {
      kvsData = open == null ? {} : { [`f:${id}`]: open };
      const out = await cfh({ request: { uri, headers: {} } });
      cfOut.push(out.statusCode === 403 ? '403' : out.uri === uri ? 'ok' : 'changed');
    }
    check('CloudFront agrees with the reference (a passed request goes on unchanged)', cfOut, enforced.map(([uri, mode, open]) => T.plainPathVerdict(uri, mode, open, nowS)));
    const tf = readFileSync(join(__dirname, '../../deploy/terraform/edge_tokens.tf'), 'utf8');
    const block = tf.slice(tf.indexOf('resource "aws_cloudfront_function" "vod_plain_refuse"'), tf.indexOf('resource "aws_cloudfront_origin_request_policy" "vod_token"'));
    check('Terraform gives the refuse function the store', [/templatefile\(.*vod-plain-refuse\.js/.test(block), /key_value_store_associations = \[aws_cloudfront_key_value_store\.rights\[0\]\.arn\]/.test(block)], [true, true]);
    const orch = readFileSync(join(__dirname, '../src/services/orchestrator/index.ts'), 'utf8');
    check('the minute sync keeps the set', /syncEdgeOpen\(store, edgeMemo\)/.test(orch), true);
  } catch (e: any) {
    console.log('FAIL unexpected error -- ' + (e?.stack ?? e)); fail++;
  } finally {
    srv.close();
    await pool.end().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
