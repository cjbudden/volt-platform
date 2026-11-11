// ============================================================================
//  SHARED EDGE TOKENS (build queue P2-2f, first part: the token format and the
//  three checks; services/edgeTokens.ts sharedEdgeToken, sharedEdgeTokens,
//  verifyEdgeToken; deploy/edge/vod-token-viewer-request.js;
//  deploy/staging/edge-token.js; the API's tokenPathMiddleware).
//
//  A FAST channel's playlist and a guided ad playlist are the same for every
//  viewer, so under enforce they need a token that opens several titles'
//  folders for anyone. Pure: the claims, the fixed rotation clock (the same
//  token in every process inside a period, the overlap), the size cap and the
//  split. Then the check three times on the same cases (the TypeScript
//  reference, the real CloudFront Function file and the real staging njs
//  file): each named title opens under /vod/ and /clips/vod/, nothing else
//  does, no country, through a rotation with no refusal, a copied address
//  stops after its period plus the overlap, a revoked title stops while the
//  others in the same token play, a republished one plays again, the token
//  cannot be widened. Then the API as its own edge under enforce, over HTTP.
//    DATABASE_URL=... npx tsx test/edge-shared-tokens.check.ts
// ============================================================================
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLIPS = mkdtempSync(join(tmpdir(), 'volt-shared-'));
process.env.CLIPS_DIR = CLIPS;
process.env.TRUST_EDGE_GEO = 'true';
delete process.env.EDGE_SHARED_SECRET;
delete process.env.EDGE_SHARED_TOKEN_PERIOD_SEC;
delete process.env.EDGE_SHARED_TOKEN_OVERLAP_SEC;

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};

(async () => {
  const T = await import('../src/services/edgeTokens');
  const crypto = await import('node:crypto');
  const KEY = 'k'.repeat(64);
  const P = 3 * 3600, O = 3600;
  const NOW = Math.floor(1_800_000_000 / P) * P + 600;   // ten minutes into a period
  const START = NOW - 600;
  const A = '11111111-1111-4111-8111-111111111111';
  const B = 'BBBBBBBB-2222-4222-8222-222222222222';
  const C = '33333333-3333-4333-8333-333333333333';
  const hex = (id: string) => id.replace(/-/g, '').toLowerCase();

  // ---------------------------------------------------------------- pure
  const s1 = T.sharedEdgeToken({ scope: 'fast:chan-1', assetIds: [B, A, A], nowSec: NOW, key: KEY });
  check('claims: shared, scope, the titles as 32 hex (sorted, once), clear, issued at the period start, period plus overlap',
    s1.claims, { k: 'shared', g: 'fast:chan-1', A: [hex(A), hex(B)].sort(), d: 0, n: START, e: START + P + O });
  check('default rotation: every 3 hours, 1 hour overlap', T.sharedRotation(), { periodSec: P, overlapSec: O });
  process.env.EDGE_SHARED_TOKEN_PERIOD_SEC = '7200'; process.env.EDGE_SHARED_TOKEN_OVERLAP_SEC = '10';
  check('...settable, never under 5 minutes and 1 minute', T.sharedRotation(), { periodSec: 7200, overlapSec: 3600 });
  delete process.env.EDGE_SHARED_TOKEN_PERIOD_SEC; delete process.env.EDGE_SHARED_TOKEN_OVERLAP_SEC;
  const later = T.sharedEdgeToken({ scope: 'fast:chan-1', assetIds: [A, B], nowSec: NOW + 3000, key: KEY });
  check('the same token anywhere in the period, in any order (every process agrees, cached playlists stay valid)', later.token, s1.token);
  const next = T.sharedEdgeToken({ scope: 'fast:chan-1', assetIds: [A, B], nowSec: START + P, key: KEY });
  check('a new token from the next period, due when the last one said', [next.token !== s1.token, next.claims.n, s1.nextAt], [true, START + P, START + P]);
  const cut = T.sharedEdgeToken({ scope: 'g', assetIds: [A], nowSec: NOW, key: KEY, effectiveUntil: new Date((NOW + 900) * 1000) });
  check('an end date cuts the expiry', cut.claims.e, NOW + 900);
  const ids = Array.from({ length: 40 }, (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`);
  const big = T.sharedEdgeToken({ scope: 'fast:' + 'x'.repeat(200), assetIds: ids.slice(0, T.SHARED_TOKEN_MAX_TITLES), nowSec: NOW, key: KEY });
  check('32 titles and a long scope stay inside the 2048 the edges take', [big.token.split('.')[0].length <= 2048, big.claims.g.length], [true, 80]);
  let threw = ''; try { T.sharedEdgeToken({ scope: 'x', assetIds: ids.slice(0, 33), key: KEY }); } catch (e: any) { threw = e.message; }
  check('...33 is refused', /at most 32/.test(threw), true);
  threw = ''; try { T.sharedEdgeToken({ scope: 'x', assetIds: [], key: KEY }); } catch (e: any) { threw = e.message; }
  check('...and none', /at least one/.test(threw), true);
  const many = T.sharedEdgeTokens({ scope: 'fast:big', assetIds: ids, nowSec: NOW, key: KEY });
  check('more titles: split into tokens of 32, each title mapped to the one that opens it',
    [many.tokens.length, many.byAsset.size, T.verifyEdgeToken(many.byAsset.get(ids[39])!, `/vod/${ids[39]}/seg.ts`, { nowSec: NOW, key: KEY }).verdict,
      T.verifyEdgeToken(many.tokens[0], `/vod/${ids[39]}/seg.ts`, { nowSec: NOW, key: KEY }).verdict], [2, 40, 'ok', 'path']);
  const rep = T.sharedEdgeToken({ scope: 'fast:chan-1', assetIds: [A, B], nowSec: NOW, key: KEY, revokedAt: { [A]: NOW - 100, [C]: NOW - 50 } });
  check('a title revoked inside the period: issued just after it (other titles\' revocations ignored)', rep.claims.n, NOW - 99);
  check('...one revoked before the period changes nothing', T.sharedEdgeToken({ scope: 'fast:chan-1', assetIds: [A, B], nowSec: NOW, key: KEY, revokedAt: { [A]: START - 5 } }).token, s1.token);

  // ---- the check, three implementations on the same cases
  const cfSrc = readFileSync(join(__dirname, '../../deploy/edge/vod-token-viewer-request.js'), 'utf8');
  check('the function is still inside CloudFront Functions\' 10 KB', Buffer.byteLength(cfSrc) < 10240, true);
  const store: Record<string, string> = { 'k:pt': KEY };
  (globalThis as any).__cf = { kvs: () => ({ async get(k: string) { if (!(k in store)) throw new Error('key not found'); return store[k]; } }) };
  (globalThis as any).__crypto = crypto;
  const cfHandler = new Function(`${cfSrc.replace("import cf from 'cloudfront';", 'const cf = globalThis.__cf;').replace("import crypto from 'crypto';", 'const crypto = globalThis.__crypto;').replace('${kvs_id}', 'kvs-test')}\nreturn handler;`)();
  const njsSrc = readFileSync(join(__dirname, '../../deploy/staging/edge-token.js'), 'utf8');
  const njs = new Function(`${njsSrc.replace("import fs from 'fs';", 'const fs = null;').replace("import crypto from 'crypto';", 'const crypto = globalThis.__crypto;').replace(/export default .*/, 'return { check, words };')}`)();
  const realNow = Date.now;
  const three = async (uri: string, cc: string, at = NOW) => {
    Date.now = () => at * 1000;
    const m = /^\/t\/([^/]+)(\/.*)$/.exec(uri)!;
    const title = T.sharedAssetOf(m[2]);
    const ts = T.verifyEdgeToken(m[1], m[2], { country: cc, nowSec: at, revokedAt: title && store['r:' + title] ? Number(store['r:' + title]) : null, key: KEY }).verdict;
    const out = await cfHandler({ request: { uri, headers: cc ? { 'cloudfront-viewer-country': { value: cc } } : {} } });
    const cfv = out.statusCode ? String(out.statusCode) : out.uri;
    const nv = njs.check(uri, cc, store, at);
    Date.now = realNow;
    return [ts, cfv, nv];
  };
  const t = s1.token;
  check('a named title\'s manifest, in the bucket: the plain path goes on (the cache key stays the plain path)', await three(`/t/${t}/vod/${A}/master.m3u8`, 'AU'), ['ok', `/vod/${A}/master.m3u8`, 'ok']);
  check('...a segment of the other named title, on the API\'s disk', await three(`/t/${t}/clips/vod/${B.toLowerCase()}/720p/seg_9.m4s`, 'AU'), ['ok', `/clips/vod/${B.toLowerCase()}/720p/seg_9.m4s`, 'ok']);
  check('...upper-case id in the path', (await three(`/t/${t}/vod/${B}/a.ts`, ''))[0], 'ok');
  check('no country in a shared token: any viewer, anywhere', await three(`/t/${t}/vod/${A}/a.ts`, 'NZ'), ['ok', `/vod/${A}/a.ts`, 'ok']);
  check('a title it does not name: 403', await three(`/t/${t}/vod/${C}/master.m3u8`, 'AU'), ['path', '403', '403']);
  check('a named title\'s clip output folder (not an encode): 403', await three(`/t/${t}/clips/${A}/hls/index.m3u8`, 'AU'), ['path', '403', '403']);
  check('ad creatives and other folders: 403', await three(`/t/${t}/clips/ads/x/master.m3u8`, 'AU'), ['path', '403', '403']);
  check('climbing out of a named folder: 403', await three(`/t/${t}/vod/${A}/../${C}/master.m3u8`, 'AU'), ['path', '403', '403']);
  const [body, sg] = t.split('.');
  const wider = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), A: [hex(A), hex(B), hex(C)] })).toString('base64url');
  check('a title added under the old signature: 403', await three(`/t/${wider}.${sg}/vod/${C}/master.m3u8`, 'AU'), ['signature', '403', '403']);
  check('signed with another key: 403', await three(`/t/${T.sharedEdgeToken({ scope: 's', assetIds: [A], nowSec: NOW, key: 'x'.repeat(64) }).token}/vod/${A}/a.ts`, 'AU'), ['signature', '403', '403']);
  const noA = Buffer.from(JSON.stringify({ k: 'shared', g: 'x', n: NOW, e: NOW + 60 })).toString('base64url');
  const noAsig = crypto.createHmac('sha256', KEY).update(noA).digest('hex').slice(0, 32);
  check('a shared token with no title list: 403', await three(`/t/${noA}.${noAsig}/vod/${A}/a.ts`, 'AU'), ['malformed', '403', '403']);

  // ---- through a rotation: segments written before the switch keep playing for the overlap
  const SWITCH = START + P;
  check('just before the switch: the current token plays', (await three(`/t/${t}/vod/${A}/s1.ts`, '', SWITCH - 1))[1], `/vod/${A}/s1.ts`);
  check('at the switch: the new token plays and the one before still does (no 403 across it)',
    [(await three(`/t/${next.token}/vod/${A}/s2.ts`, '', SWITCH)), (await three(`/t/${t}/vod/${A}/s1.ts`, '', SWITCH))],
    [['ok', `/vod/${A}/s2.ts`, 'ok'], ['ok', `/vod/${A}/s1.ts`, 'ok']]);
  check('...to the last second of the overlap', (await three(`/t/${t}/vod/${A}/s1.ts`, '', SWITCH + O - 1))[0], 'ok');
  check('a copied segment address stops after its period plus the overlap', await three(`/t/${t}/vod/${A}/s1.ts`, '', SWITCH + O), ['expired', '403', '403']);
  check('...with the expiry words', njs.words(`/t/${t}/vod/${A}/s1.ts`, '', store, SWITCH + O), 'This link has expired');
  check('the next token opened before its period, inside a minute (clock skew): plays', (await three(`/t/${next.token}/vod/${A}/s2.ts`, '', SWITCH - 30))[0], 'ok');

  // ---- the revocation set, per title
  store['r:' + A] = String(NOW + 10);
  check('a withdrawn title: its segments refused under the shared token', await three(`/t/${t}/vod/${A}/s1.ts`, 'AU', NOW + 20), ['revoked', '403', '403']);
  check('...with the words', njs.words(`/t/${t}/vod/${A}/s1.ts`, 'AU', store, NOW + 20), 'No longer available');
  check('...the other title in the same token still plays', await three(`/t/${t}/vod/${B}/s1.ts`, 'AU', NOW + 20), ['ok', `/vod/${B}/s1.ts`, 'ok']);
  const back = T.sharedEdgeToken({ scope: 'fast:chan-1', assetIds: [A, B], nowSec: NOW + 30, key: KEY, revokedAt: { [A]: NOW + 10 } });
  check('republished: the token minted with its revocation time plays again in the same period', await three(`/t/${back.token}/vod/${A}/s1.ts`, 'AU', NOW + 40), ['ok', `/vod/${A}/s1.ts`, 'ok']);
  delete store['r:' + A];

  // ---- personal tokens unchanged at all three
  const own = T.mintEdgeToken({ assetId: A, prefix: `/vod/${A}/`, country: 'AU', policyClass: 'rights', nowSec: NOW, key: KEY }).token;
  check('a viewer\'s own token still checks its country and folder', [await three(`/t/${own}/vod/${A}/m.m3u8`, 'AU'), (await three(`/t/${own}/vod/${A}/m.m3u8`, 'NZ'))[0], (await three(`/t/${own}/vod/${B}/m.m3u8`, 'AU'))[0]],
    [['ok', `/vod/${A}/m.m3u8`, 'ok'], 'country', 'path']);
  const { edgeDemandOf } = await import('../src/services/availabilityDemand');
  check('a refused shared token is not counted as a viewer\'s country demand (it has no viewer)',
    edgeDemandOf({ status: 403, path: `/t/${t}/vod/${C}/master.m3u8`, country: 'NZ', at: NOW * 1000 }, (tk, uri, cc, n) => T.verifyEdgeToken(tk, uri, { country: cc, nowSec: n, key: KEY })), null);

  // ---------------------------------------------------------------- the API as its own edge, enforce
  process.env.VOLT_EDGE_TOKENS = 'enforce';
  const { createServer } = await import('../src/server');
  const { pool, one } = await import('../src/db');
  const { invalidateTag } = await import('../src/scale/cache');
  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const get = async (path: string) => { const r = await fetch(base + path); return `${r.status} ${(await r.text()).trim().slice(0, 30)}`; };
  try {
    const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`sh-${Date.now().toString(36)}`]))!.id;
    const mk = async (title: string) => {
      const id = (await one<any>(
        `INSERT INTO vod_assets(account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms) VALUES ($1,'upload','clip',$2,0,60000,60000) RETURNING id`, [acct, title]))!.id;
      mkdirSync(join(CLIPS, 'vod', id, '720p'), { recursive: true });
      writeFileSync(join(CLIPS, 'vod', id, 'master.m3u8'), '#EXTM3U\n');
      writeFileSync(join(CLIPS, 'vod', id, '720p', 'seg_1.m4s'), 'SEGMENT');
      return id as string;
    };
    const x = await mk('On the channel'), y = await mk('Also on it'), z = await mk('Not on it');
    const now = Math.floor(Date.now() / 1000);
    const sh = T.sharedEdgeToken({ scope: 'fast:test', assetIds: [x, y] }).token;
    check('API, enforce: a named title\'s manifest and segment play under the shared token',
      [await get(`/t/${sh}/clips/vod/${x}/master.m3u8`), await get(`/t/${sh}/clips/vod/${y}/720p/seg_1.m4s?x=1`)], ['200 #EXTM3U', '200 SEGMENT']);
    check('...a title it does not name is refused', await get(`/t/${sh}/clips/vod/${z}/master.m3u8`), '403 Not available');
    check('...the plain address is refused as before', await get(`/clips/vod/${x}/master.m3u8`), '403 Not available');
    await T.revokeAsset(x, 'test', now); invalidateTag(`asset:${x}`);
    check('...withdrawn: that title refused, the other plays', [await get(`/t/${sh}/clips/vod/${x}/720p/seg_1.m4s`), await get(`/t/${sh}/clips/vod/${y}/720p/seg_1.m4s`)],
      ['403 No longer available', '200 SEGMENT']);
    const again = T.sharedEdgeToken({ scope: 'fast:test', assetIds: [x, y], nowSec: now + 1, revokedAt: { [x]: now } }).token;
    check('...republished: the next shared token plays it', await get(`/t/${again}/clips/vod/${x}/720p/seg_1.m4s`), '200 SEGMENT');
  } catch (e: any) {
    console.log('FAIL threw: ' + (e?.stack ?? e)); fail++;
  } finally {
    srv.close();
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
