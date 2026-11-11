// ============================================================================
//  EDGE PLAY TOKENS, ENFORCED (build queue P2-2b, services/edgeTokens.ts,
//  deploy/edge/vod-plain-refuse.js, deploy/staging/edge-token.js and
//  nginx.conf.template, deploy/terraform/edge_tokens.tf).
//
//  The API as its own edge: /t/<token>/clips/... checked (signature, expiry,
//  folder, the viewer's country, the revocation set) and served from the plain
//  path with its query kept; under VOLT_EDGE_TOKENS=enforce a plain
//  /clips/vod/ path refused, other /clips paths and the console's /vod page
//  untouched; under issue and off plain paths play. The console's preview
//  (GET /api/vod/:id `preview`) and a share page carry tokens that play under
//  enforce, a share token ending at the earlier of the link's expiry and the
//  title's window, bound to the viewer's country. The staging edge's plain
//  check and the CloudFront refuse function on their cases; the staging nginx
//  config routes as described. (Terraform: tests/edge_tokens.tftest.hcl.)
//    DATABASE_URL=... npx tsx test/edge-tokens-enforce.check.ts
// ============================================================================
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLIPS = mkdtempSync(join(tmpdir(), 'volt-enforce-'));
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
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { invalidateTag } = await import('../src/scale/cache');
  const P = await import('../src/services/publicStatus');
  const SL = await import('../src/services/shareLinks');
  const tag = Date.now().toString(36);
  const a = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`enf-${tag}`]))!.id;
  const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `enf-${tag}@volt.test`]))!.id;
  const tok = signAccess({ sub: u, account_id: a, role: 'owner' });
  const mkAsset = async (title: string, set = '') => {
    const id = (await one<any>(
      `INSERT INTO vod_assets(account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, formats)
       VALUES ($1,'upload','clip',$2,0,60000,60000,'{"hls":true,"dash":true}'::jsonb) RETURNING id`, [a, title]))!.id;
    await query(`UPDATE vod_assets SET master_key = $2, progressive_key = $3 ${set ? ', ' + set : ''} WHERE id = $1`,
      [id, `/clips/vod/${id}/master.m3u8`, `/clips/vod/${id}/${id}.mp4`]);
    mkdirSync(join(CLIPS, 'vod', id, '720p'), { recursive: true });
    writeFileSync(join(CLIPS, 'vod', id, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n720p/index.m3u8\n');
    writeFileSync(join(CLIPS, 'vod', id, 'manifest.mpd'), '<MPD/>');
    writeFileSync(join(CLIPS, 'vod', id, '720p', 'seg_1.m4s'), 'SEGMENT');
    writeFileSync(join(CLIPS, 'vod', id, `${id}.mp4`), 'MP4');
    await P.refreshPublicStatus(id); invalidateTag(`asset:${id}`);
    return id;
  };
  const LIVE = `availability_state = 'available', published = true, media_state = 'ready', availability = '{"targets":[{"kind":"portal"}],"access":"free"}'::jsonb, available_from = now() - interval '1 day'`;
  const id = await mkAsset('Enforce me', LIVE);
  mkdirSync(join(CLIPS, 'other'), { recursive: true });
  writeFileSync(join(CLIPS, 'other', 'index.m3u8'), '#EXTM3U\n');

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const get = async (path: string, h: Record<string, string> = {}) => {
    const r = await fetch(base + path, { headers: h });
    return { s: r.status, t: await r.text(), cc: r.headers.get('cache-control') };
  };
  const api = async (path: string) => (await fetch(base + path, { headers: { authorization: `Bearer ${tok}` } })).json() as any;
  const PRE = `/clips/vod/${id}/`;
  const mint = (o: any = {}) => T.mintEdgeToken({ assetId: id, prefix: PRE, country: 'AU', policyClass: 'rights', ...o }).token;
  try {
    // ---------------------------------------------------------------- the API as its own edge
    check('mode reads enforce', T.edgeTokensMode(), 'enforce');
    const plain = await get(`${PRE}master.m3u8`);
    check('enforce: a plain /clips/vod/ manifest is refused, not cached', [plain.s, plain.t.trim(), plain.cc], [403, 'Not available', 'no-store']);
    check('...and a plain segment and file', [(await get(`${PRE}720p/seg_1.m4s`)).s, (await get(`${PRE}${id}.mp4`)).s], [403, 403]);
    check('...encoded, too (%2F tricks)', (await get(`/clips/vod%2F${id}/master.m3u8`)).s === 200, false);
    const good = mint();
    const t1 = await get(`/t/${good}${PRE}master.m3u8`, { 'x-viewer-country': 'AU' });
    check('a valid token: the manifest plays', [t1.s, t1.t.startsWith('#EXTM3U')], [200, true]);
    check('...a segment below it, with its query kept', [(await get(`/t/${good}${PRE}720p/seg_1.m4s?x=1`, { 'x-viewer-country': 'AU' })).t], ['SEGMENT']);
    check('...the viewer country unknown is not a mismatch', (await get(`/t/${good}${PRE}master.m3u8`)).s, 200);
    const words = async (p: string, h: Record<string, string> = { 'x-viewer-country': 'AU' }) => { const r = await get(p, h); return `${r.s} ${r.t.trim()}`; };
    check('another country: refused with the region words', await words(`/t/${good}${PRE}master.m3u8`, { 'x-viewer-country': 'JP' }), '403 Not available in your region');
    check('outside the token\'s folder: refused', await words(`/t/${good}/clips/vod/00000000-0000-4000-8000-000000000001/master.m3u8`), '403 Not available');
    check('climbing out of the folder: refused', (await get(`/t/${good}${PRE}../../other/index.m3u8`, { 'x-viewer-country': 'AU' })).s === 200, false);
    const now = Math.floor(Date.now() / 1000);
    check('expired: refused with the expiry words', await words(`/t/${mint({ nowSec: now - 10 * 3600, lifetimeSec: 3600 })}${PRE}master.m3u8`), '403 This link has expired');
    check('signed with another key: refused', await words(`/t/${mint({ key: 'k'.repeat(64) })}${PRE}master.m3u8`), '403 Not available');
    check('garbage token: refused', await words(`/t/not-a-token${PRE}master.m3u8`), '403 Not available');
    check('a token on a path the API does not serve: refused', await words(`/t/${good}/vod/${id}/master.m3u8`), '403 Not available');
    // the revocation set
    await T.revokeAsset(id, 'test', now);
    invalidateTag(`asset:${id}`);
    check('revoked: a token issued before is refused', await words(`/t/${mint({ nowSec: now - 5 })}${PRE}master.m3u8`), '403 No longer available');
    check('...one issued after plays again', (await get(`/t/${mint({ nowSec: now + 1 })}${PRE}master.m3u8`, { 'x-viewer-country': 'AU' })).s, 200);
    await query(`DELETE FROM edge_revocations WHERE asset_id = $1`, [id]); invalidateTag(`asset:${id}`);

    // other paths under enforce
    check('enforce leaves other /clips paths alone', (await get('/clips/other/index.m3u8')).s, 200);
    check('...and the console\'s Media Library page (/vod) is not refused', (await get('/vod')).s === 403, false);
    const { scaleConfig } = await import('../src/scale/config');
    const { pathMatches } = await import('../src/scale/health');
    check('the public API tier serves /t/ (the staging edge passes tokenised paths to it)', scaleConfig.publicPrefixes.some((p) => pathMatches(`/t/${good}${PRE}master.m3u8`, p)), true);
    check('the load balancer sends /t/* to the public tier', /"\/t\/\*"\]/.test(readFileSync(join(__dirname, '../../deploy/terraform/scaling_alb.tf'), 'utf8')), true);
    // issue and off
    process.env.VOLT_EDGE_TOKENS = 'issue';
    check('issue: the plain path still plays', (await get(`${PRE}master.m3u8`)).s, 200);
    check('issue: tokens still checked', [(await get(`/t/${good}${PRE}master.m3u8`, { 'x-viewer-country': 'AU' })).s, (await get(`/t/${good}${PRE}master.m3u8`, { 'x-viewer-country': 'JP' })).s], [200, 403]);
    process.env.VOLT_EDGE_TOKENS = 'off';
    check('off: the plain path plays', (await get(`${PRE}master.m3u8`)).s, 200);

    // ---------------------------------------------------------------- the console's preview
    const off = await api(`/api/vod/${id}`);
    check('off: no preview addresses (the console uses the plain keys)', off.preview, null);
    process.env.VOLT_EDGE_TOKENS = 'enforce';
    const d = await api(`/api/vod/${id}`);
    const pv = d.preview;
    check('enforce: the preview carries a token on every file of the asset',
      [pv.hls.startsWith('/t/') && pv.hls.endsWith(`${PRE}master.m3u8`), pv.dash.endsWith(`${PRE}manifest.mpd`), pv.progressive.endsWith(`${PRE}${id}.mp4`), pv.mp3, !!pv.expiresAt], [true, true, true, null, true]);
    check('...and every one plays under enforce, from any country (no country in an admin\'s token)',
      [(await get(pv.hls, { 'x-viewer-country': 'JP' })).s, (await get(pv.dash)).s, (await get(pv.progressive)).s], [200, 200, 200]);
    const draft = await mkAsset('A draft');
    const dpv = (await api(`/api/vod/${draft}`)).preview;
    check('a draft is previewable too (the token is not bound to the window)', [(await get(dpv.hls)).s, (await get(`/clips/vod/${draft}/master.m3u8`)).s], [200, 403]);

    // ---------------------------------------------------------------- share pages
    const link = await SL.createShareLink({ accountId: a, createdBy: u, resourceKind: 'vod', resourceId: id, ttlSec: 3 * 86400 });
    const view = await SL.openShare(link.token, { geo: 'AU' }) as any;
    check('a share page: tokenised manifests that play under enforce', [view.ok, view.view.hls.startsWith('/t/'), (await get(view.view.hls, { 'x-viewer-country': 'AU' })).s, (await get(view.view.dash, { 'x-viewer-country': 'AU' })).s], [true, true, 200, 200]);
    const claims = (url: string) => JSON.parse(Buffer.from(/^\/t\/([^.]+)\./.exec(url)![1], 'base64url').toString());
    const c1 = claims(view.view.hls);
    check('...bound to the viewer\'s country, ending by the link\'s expiry', [c1.c, c1.e <= Math.floor(new Date(link.expiresAt).getTime() / 1000), c1.a], ['AU', true, id]);
    check('...refused in another country', (await get(view.view.hls, { 'x-viewer-country': 'JP' })).s, 403);
    await query(`UPDATE vod_assets SET available_until = now() + interval '2 hours' WHERE id = $1`, [id]);
    await P.refreshPublicStatus(id); invalidateTag(`asset:${id}`);
    const c2 = claims((await SL.openShare(link.token, { geo: 'AU' }) as any).view.hls);
    const end = Math.floor((await one<any>(`SELECT extract(epoch FROM available_until)::bigint AS e FROM vod_assets WHERE id = $1`, [id])).e);
    check('a title whose window ends before the link: the token ends with the window', c2.e, end);
    const lng = await SL.createShareLink({ accountId: a, createdBy: u, resourceKind: 'vod', resourceId: id, ttlSec: 3600 });
    const c3 = claims((await SL.openShare(lng.token, { geo: 'AU' }) as any).view.hls);
    check('a link that expires first: the token ends with the link', c3.e, Math.floor(new Date(lng.expiresAt).getTime() / 1000));
    // the public page's own route: the country from the trusted edge header
    const rv = await fetch(`${base}/api/share/${link.token}/resolve`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-viewer-country': 'NZ' }, body: '{}' });
    const rj: any = await rv.json();
    check('the share page route binds the token to the edge\'s country (X-Viewer-Country)', [rv.status, claims(rj.hls ?? rj.view?.hls).c, (await get(rj.hls ?? rj.view?.hls, { 'x-viewer-country': 'NZ' })).s], [200, 'NZ', 200]);
    process.env.VOLT_EDGE_TOKENS = 'off';
    check('off: a share page has the plain addresses as before', (await SL.openShare(link.token, { geo: 'AU' }) as any).view.hls, `${PRE}master.m3u8`);
    process.env.VOLT_EDGE_TOKENS = 'enforce';

    // ---------------------------------------------------------------- the two edges' files
    const njsSrc = readFileSync(join(__dirname, '../../deploy/staging/edge-token.js'), 'utf8');
    const njs = new Function(`${njsSrc.replace("import fs from 'fs';", 'const fs = null;').replace("import crypto from 'crypto';", 'const crypto = null;').replace(/export default .*/, 'return { plainVerdict };')}`)();
    check('staging edge: plain on-demand paths refused only under enforce',
      [njs.plainVerdict(`${PRE}master.m3u8`, 'enforce'), njs.plainVerdict(`/vod/${id}/master.m3u8`, 'enforce'), njs.plainVerdict(`${PRE}master.m3u8`, 'issue'), njs.plainVerdict(`${PRE}master.m3u8`, ''), njs.plainVerdict('/clips/other/index.m3u8', 'enforce'), njs.plainVerdict(`${PRE}x`, ' ENFORCE ')],
      ['403', '403', 'ok', 'ok', 'ok', '403']);
    const conf = readFileSync(join(__dirname, '../../deploy/staging/nginx.conf.template'), 'utf8');
    const iT = conf.indexOf('location ~ ^/t/[^/]+/clips/ {'), iPlain = conf.indexOf('location ~ ^/clips/vod/ {'), iGeneric = conf.indexOf('location ~ ^/(api/public/|');
    const tBlock = conf.slice(iT, conf.indexOf('}', conf.indexOf('proxy_pass', iT)));
    check('staging nginx: the token location passes the token on (no rewrite), the plain location is checked first',
      [iT > 0 && iPlain > iT && iGeneric > iPlain, /rewrite/.test(tBlock), /env VOLT_EDGE_TOKENS;/.test(conf), /js_set \$edge_plain edgetoken\.plain;/.test(conf),
       /if \(\$edge_plain != "ok"\) \{ return 403/.test(conf.slice(iPlain, iGeneric))], [true, false, true, true, true]);
    const compose = readFileSync(join(__dirname, '../../deploy/staging/docker-compose.yml'), 'utf8');
    check('staging compose: the edge is told the mode', /edge-token\.js/.test(compose) && (compose.match(/VOLT_EDGE_TOKENS: \$\{VOLT_EDGE_TOKENS:-issue\}/g) ?? []).length, 2);
    const cfSrc = readFileSync(join(__dirname, '../../deploy/edge/vod-plain-refuse.js'), 'utf8');
    const cf = new Function(`${cfSrc}\nreturn handler;`)();
    const out = cf({ request: { uri: `/vod/${id}/master.m3u8`, headers: {} } });
    check('CloudFront refuse function: 403, the same words, not cached, inside 10 KB', [out.statusCode, out.body, out.headers['cache-control'].value, Buffer.byteLength(cfSrc) < 10240], [403, 'Not available', 'no-store', true]);
  } catch (e: any) {
    console.log('FAIL unexpected error -- ' + (e?.stack ?? e)); fail++;
  } finally {
    srv.close();
    await pool.end().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
