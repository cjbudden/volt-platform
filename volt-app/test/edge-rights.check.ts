// ============================================================================
//  EDGE RIGHTS: the CloudFront Function and the rules the control plane keeps
//  in its KeyValueStore (services/edgeRights.ts, deploy/edge/rights-viewer-request.js).
//
//  The function is the real file, run here with a stand-in for the
//  `cloudfront` module's KeyValueStore; the rules come from the real compiler
//  and, for the database part, from real channel, account and programme rows.
//    DATABASE_URL=... npx tsx test/edge-rights.check.ts
// ============================================================================
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};

(async () => {
  const er = await import('../src/services/edgeRights');
  const NOW = 1_800_000_000;
  const P = (fromMin: number, toMin: number, mode: string | null, cc: string[], repl: string | null = null) => ({
    starts_at: new Date((NOW + fromMin * 60) * 1000), ends_at: new Date((NOW + toMin * 60) * 1000), geo_mode: mode, geo_countries: cc, replacement_asset_id: repl,
  });

  // ---- compiler -------------------------------------------------------------------------------
  check('nothing restricts: no key', er.compileEdgeRules({ account: null, channel: null, programmes: [P(-10, 50, 'worldwide', [])], nowSec: NOW }), null);
  let r = er.compileEdgeRules({ account: { mode: 'block', countries: ['IL'] }, channel: { mode: 'allow', countries: ['GB', 'IE'] }, programmes: [], nowSec: NOW })!;
  check('account block list and channel allow list', [r.a, r.c], [['b', ['IL']], ['a', ['GB', 'IE']]]);
  r = er.compileEdgeRules({ account: null, channel: null, nowSec: NOW, programmes: [
    P(-120, -60, 'block', ['US']), P(-10, 50, 'block', ['US', 'CA']), P(60, 120, 'allow', ['GB'], '11111111-1111-1111-1111-111111111111'), P(26 * 60, 27 * 60, 'block', ['FR'])] })!;
  check('programme windows: past and beyond the horizon left out, nearest first', r.w!.map((w) => [w[0] - NOW, w[2], w[3], w[4]]), [[-600, 'b', ['US', 'CA'], 0], [3600, 'a', ['GB'], 1]]);
  check('...complete until the horizon', r.u, NOW + er.RIGHTS_HORIZON_SEC);
  const many = Array.from({ length: 60 }, (_, i) => P(i * 10, i * 10 + 10, 'block', ['US', 'CA', 'MX']));
  r = er.compileEdgeRules({ account: null, channel: null, programmes: many, nowSec: NOW })!;
  check('60 windows are cut to fit the 1 KB value', Buffer.byteLength(JSON.stringify(r)) <= 1024 && r.w!.length < 60 && r.w!.length > 5, true);
  check('...and say until when the list is complete (the first left out)', r.u, r.w![r.w!.length - 1][0] + 600);
  let threw = false;
  try { er.compileEdgeRules({ account: { mode: 'allow', countries: Array.from({ length: 300 }, (_, i) => String.fromCharCode(65 + (i % 26)) + String.fromCharCode(65 + Math.floor(i / 26))) }, channel: null, programmes: [], nowSec: NOW }); } catch { threw = true; }
  check('an allow list too big for the store is an error, never silently cut', threw, true);

  // ---- the CloudFront Function ---------------------------------------------------------------
  const src = readFileSync(join(__dirname, '../../deploy/edge/rights-viewer-request.js'), 'utf8');
  check('the function names its store through Terraform', src.includes("cf.kvs('${kvs_id}')"), true);
  check('the function is inside CloudFront Functions\' 10 KB', Buffer.byteLength(src) < 10240, true);
  const store: Record<string, string> = {};
  let storeDown = false;
  (globalThis as any).__cf = { kvs: (id: string) => ({ async get(k: string) { if (storeDown) throw new Error('kvs down'); if (id !== 'kvs-test') throw new Error('wrong store'); if (!(k in store)) throw new Error('key not found'); return store[k]; } }) };
  const body = src.replace("import cf from 'cloudfront';", 'const cf = globalThis.__cf;').replace('${kvs_id}', 'kvs-test');
  const handler = new Function(`${body}\nreturn handler;`)();
  const realNow = Date.now;
  Date.now = () => NOW * 1000;
  const CH = '22222222-2222-2222-2222-222222222222';
  const req = async (uri: string, cc?: string) => handler({ request: { uri, headers: cc ? { 'cloudfront-viewer-country': { value: cc } } : {} } });
  const outcome = (x: any) => (x.statusCode ? x.statusCode : x.uri);

  check('no rules for the stream: open', outcome(await req(`/channel/${CH}/master_cc.m3u8`, 'CN')), `/channel/${CH}/master_cc.m3u8`);
  store[`s:${CH}`] = JSON.stringify(er.compileEdgeRules({ account: { mode: 'block', countries: ['CN'] }, channel: null, programmes: [], nowSec: NOW }));
  check('account block: 451 on the master', outcome(await req(`/channel/${CH}/master_cc.m3u8`, 'CN')), 451);
  check('...on a DASH manifest too', outcome(await req(`/channel/${CH}/manifest_cc.mpd`, 'CN')), 451);
  check('...lower-case header value', outcome(await req(`/channel/${CH}/master_cc.m3u8`, 'cn')), 451);
  check('...not cached', (await req(`/channel/${CH}/master_cc.m3u8`, 'CN')).headers['cache-control'].value, 'no-store');
  check('other countries pass', outcome(await req(`/channel/${CH}/master_cc.m3u8`, 'GB')), `/channel/${CH}/master_cc.m3u8`);
  check('segments always pass (no manifest, no segment names)', outcome(await req(`/channel/${CH}/480p/seg_12.m4s`, 'CN')), `/channel/${CH}/480p/seg_12.m4s`);
  check('paths that are not a stream pass', outcome(await req(`/img/logo.m3u8`, 'CN')), `/img/logo.m3u8`);
  store[`s:${CH}`] = JSON.stringify(er.compileEdgeRules({ account: null, channel: { mode: 'allow', countries: ['GB'] }, programmes: [], nowSec: NOW }));
  check('channel allow list: listed country passes', outcome(await req(`/channel/${CH}/stream_1_cc.m3u8`, 'GB')), `/channel/${CH}/stream_1_cc.m3u8`);
  check('...unlisted country blocked', outcome(await req(`/channel/${CH}/stream_1_cc.m3u8`, 'FR')), 451);
  check('...unknown country blocked (allow lists are closed)', outcome(await req(`/channel/${CH}/stream_1_cc.m3u8`)), 451);
  store[`s:${CH}`] = JSON.stringify(er.compileEdgeRules({ account: null, channel: null, nowSec: NOW,
    programmes: [P(-5, 30, 'block', ['US']), P(30, 60, 'block', ['DE'], '33333333-3333-3333-3333-333333333333')] }));
  check('programme blackout now: US blocked', outcome(await req(`/channel/${CH}/master_cc.m3u8`, 'US')), 451);
  check('...DE not yet (its window is later)', outcome(await req(`/channel/${CH}/master_cc.m3u8`, 'DE')), `/channel/${CH}/master_cc.m3u8`);
  Date.now = () => (NOW + 40 * 60) * 1000;
  check('the same URL later: US open again, nothing to change for the viewer', outcome(await req(`/channel/${CH}/master_cc.m3u8`, 'US')), `/channel/${CH}/master_cc.m3u8`);
  check('a replacement with no replacement playlists is enforced as a block', outcome(await req(`/channel/${CH}/master_cc.m3u8`, 'DE')), 451);
  const withRp = JSON.parse(store[`s:${CH}`]); withRp.rp = 1; store[`s:${CH}`] = JSON.stringify(withRp);
  check('with replacement playlists: the master is served as master_rp', outcome(await req(`/channel/${CH}/master_cc.m3u8`, 'DE')), `/channel/${CH}/master_rp.m3u8`);
  check('...a media playlist as its _rp twin', outcome(await req(`/channel/${CH}/stream_1_cc.m3u8`, 'DE')), `/channel/${CH}/stream_1_rp.m3u8`);
  check('...the DASH manifest as manifest_rp.mpd', outcome(await req(`/channel/${CH}/manifest_cc.mpd`, 'DE')), `/channel/${CH}/manifest_rp.mpd`);
  check('...other countries get the channel', outcome(await req(`/channel/${CH}/master_cc.m3u8`, 'GB')), `/channel/${CH}/master_cc.m3u8`);
  storeDown = true;
  check('a store that cannot be read fails open (the play gate still enforces)', outcome(await req(`/channel/${CH}/master_cc.m3u8`, 'DE')), `/channel/${CH}/master_cc.m3u8`);
  storeDown = false;
  store[`s:${CH}`] = '{not json';
  check('a broken value fails open', outcome(await req(`/channel/${CH}/master_cc.m3u8`, 'DE')), `/channel/${CH}/master_cc.m3u8`);
  Date.now = realNow;

  // ---- from the database, and the sync ------------------------------------------------------------
  if (!process.env.DATABASE_URL) {
    console.log('PASS skipped the database part: set DATABASE_URL');
  } else {
    const { pool, one, query } = await import('../src/db');
    const tag = Date.now().toString(36);
    const acct = (await one<any>(`INSERT INTO accounts(name, geo_access) VALUES ($1, '{"mode":"block","countries":["KP"]}') RETURNING id`, [`er-${tag}`]))!.id;
    const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
    const g = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
    const ch = (await one<any>(`INSERT INTO channels(group_id, name, geo_mode, geo_countries) VALUES ($1,'ER News','allow',ARRAY['GB','IE']) RETURNING id`, [g]))!.id;
    const open = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'ER Open') RETURNING id`, [g]))!.id;
    await query(`UPDATE accounts SET geo_access = NULL WHERE id = $1`, [acct]).catch(() => {});
    await query(`UPDATE accounts SET geo_access = '{"mode":"block","countries":["KP"]}' WHERE id = $1`, [acct]);
    await query(`INSERT INTO programmes(channel_id, title, starts_at, ends_at, geo_mode, geo_countries) VALUES ($1,'Match',now() - interval '5 minutes', now() + interval '1 hour','block',ARRAY['IE'])`, [ch]);
    await query(`INSERT INTO programmes(channel_id, title, starts_at, ends_at) VALUES ($1,'News',now() + interval '1 hour', now() + interval '2 hours')`, [ch]);
    const rules = (await er.loadEdgeRules('channel', ch))!;
    check('db: account, channel and the programme blackout', [rules.a, rules.c, rules.w?.length, rules.w?.[0][3]], [['b', ['KP']], ['a', ['GB', 'IE']], 1, ['IE']]);
    const openRules = await er.loadEdgeRules('channel', open);
    check('db: a channel with only the account rule still gets a key', openRules?.a, ['b', ['KP']]);
    const kv = new Map<string, string>();
    const calls = { get: 0, put: 0, del: 0 };
    const fake: any = { async get(k: string) { calls.get++; return kv.get(k) ?? null; }, async put(k: string, v: string) { calls.put++; kv.set(k, v); }, async delete(k: string) { calls.del++; kv.delete(k); } };
    let s = await er.syncEdgeRights(fake, [{ kind: 'channel', id: ch }, { kind: 'channel', id: open }]);
    check('sync: two keys written', [s.put, kv.has(er.keyFor(ch)), kv.has(er.keyFor(open))], [2, true, true]);
    s = await er.syncEdgeRights(fake, [{ kind: 'channel', id: ch }]);
    check('sync again: unchanged, nothing written', [s.put, s.unchanged], [0, 1]);
    await query(`UPDATE accounts SET geo_access = NULL WHERE id = $1`, [acct]);
    s = await er.syncEdgeRights(fake, [{ kind: 'channel', id: open }]);
    check('the account rule removed: the open channel\'s key is deleted', [s.deleted, kv.has(er.keyFor(open))], [1, false]);
    const memo = new Map<string, string | null>();
    await er.syncEdgeRights(fake, [{ kind: 'channel', id: ch }], undefined, memo);
    const before = calls.get;
    s = await er.syncEdgeRights(fake, [{ kind: 'channel', id: ch }], undefined, memo);
    check('with the memo a steady state reads nothing from the store', [calls.get - before, s.unchanged], [0, 1]);
    const stored = JSON.parse(kv.get(er.keyFor(ch))!); stored.u = Math.floor(Date.now() / 1000) + 1800; kv.set(er.keyFor(ch), JSON.stringify(stored));
    s = await er.syncEdgeRights(fake, [{ kind: 'channel', id: ch }]);
    check('a value whose window list runs out within the hour is rewritten, though nothing else changed', [s.put, JSON.parse(kv.get(er.keyFor(ch))!).u > stored.u], [1, true]);
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
