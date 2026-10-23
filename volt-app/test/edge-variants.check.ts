// ============================================================================
//  EDGE RIGHTS VARIANTS (EDGE_RIGHTS_VARIANTS.md, build queue 1.14a).
//
//  1. The reducer: a stream's programme rights become a few variants, one per
//     distinct replace timeline, shared by every audience that sees the same.
//  2. Parity: the CloudFront Function file itself (run here with stand-ins for
//     its `cloudfront` and `crypto` modules) and services/edgeRights.ts give
//     the same answer over one fixture table; the signed rights-class claim
//     is honoured, a forged, expired or borrowed one is not; fail-open kept.
//  3. The same decision on the Mac: the public /live route with the
//     development-only test country, rights class and time, and production
//     ignoring them.
//    DATABASE_URL=... npx tsx test/edge-variants.check.ts
// ============================================================================
process.env.TRUST_EDGE_GEO = '1';
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
  const H = 3600;
  const LOOP = '44444444-4444-4444-4444-444444444444', SLATE = '55555555-5555-5555-5555-555555555555';
  const P = (fromH: number, toH: number, mode: string, cc: string[], repl: string | null = LOOP, exempt?: string[]) => ({
    starts_at: new Date((NOW + fromH * H) * 1000), ends_at: new Date((NOW + toH * H) * 1000), geo_mode: mode, geo_countries: cc,
    replacement_asset_id: repl, metadata: exempt ? { rights_exempt: exempt } : {},
  });
  const compile = (programmes: any[], vs = true) => er.compileEdgeRules({ account: null, channel: null, programmes, nowSec: NOW, variantService: vs })!;
  const at = (h: number) => NOW + Math.round(h * H);

  // ---- 1. the reducer -----------------------------------------------------------------------------
  // AU replaced 20:00 to 21:00, NZ 21:00 to 22:00 (hours from NOW: 2 to 3, 3 to 4)
  let v = er.streamVariants([P(2, 3, 'block', ['AU']), P(3, 4, 'block', ['NZ'])], NOW);
  check('AU then NZ: two variants', v.variants.length, 2);
  check('...each its own timeline', v.variants.map((x) => [x.audiences, x.timeline.map((t) => [(t[0] - NOW) / H, (t[1] - NOW) / H])]), [[['AU'], [[2, 3]]], [['NZ'], [[3, 4]]]]);
  let r = compile([P(2, 3, 'block', ['AU']), P(3, 4, 'block', ['NZ'])]);
  check('...at 21:30 AU gets the normal stream and NZ the loop', [er.edgeDecision(r, 'AU', '', at(3.5)), er.edgeDecision(r, 'NZ', '', at(3.5))], ['allow', 'replace:' + r.vm!.NZ]);
  check('...at 20:30 AU gets its variant, NZ the stream, MY always the stream', [er.edgeDecision(r, 'AU', '', at(2.5)), er.edgeDecision(r, 'NZ', '', at(2.5)), er.edgeDecision(r, 'MY', '', at(2.5))], ['replace:' + r.vm!.AU, 'allow', 'allow']);

  v = er.streamVariants([P(2, 3, 'block', ['AU']), P(2, 3, 'block', ['NZ'])], NOW);
  check('the same window for AU and NZ (two programmes): one shared variant', [v.variants.length, v.variants[0]?.audiences], [1, ['AU', 'NZ']]);
  v = er.streamVariants([P(2, 3, 'block', ['AU', 'NZ'])], NOW);
  check('...and from one programme naming both: the same single variant key', [v.variants.length, v.variants[0].key], [1, er.streamVariants([P(2, 3, 'block', ['AU']), P(2, 3, 'block', ['NZ'])], NOW).variants[0].key]);

  v = er.streamVariants([P(2, 4, 'block', ['AU', 'NZ']), P(3, 5, 'block', ['NZ'], SLATE)], NOW);
  check('overlapping AU and NZ windows: two variants', v.variants.length, 2);
  check('...NZ keeps the first window where they overlap, then the slate (first rule wins, as at the edge)',
    v.variants.find((x) => x.audiences.includes('NZ'))!.timeline.map((t) => [(t[0] - NOW) / H, (t[1] - NOW) / H, t[2] === LOOP ? 'loop' : 'slate']), [[2, 4, 'loop'], [4, 5, 'slate']]);

  check('a key is "v" and 8 hex, stable for the same timeline', [/^v[0-9a-f]{8}$/.test(v.variants[0].key), er.variantKey([[1, 2, 'x']]) === er.variantKey([[1, 2, 'x']])], [true, true]);
  check('...and differs when only the replacement differs', er.variantKey([[1, 2, LOOP]]) !== er.variantKey([[1, 2, SLATE]]), true);
  check('a plain blackout (no replacement) makes no variant', er.streamVariants([P(2, 3, 'block', ['AU'], null)], NOW).variants.length, 0);
  check('a loop or slate named by kind is a replacement too',
    er.streamVariants([{ ...P(2, 3, 'block', ['AU'], null), replacement_kind: 'loop', replacement_ref: 'filler-7' }], NOW).variants[0]?.timeline[0][2], 'loop:filler-7');

  r = compile([P(2, 3, 'allow', ['MY'])]);
  check('allow list: every other country (and an unknown one) shares the "*" variant', [Object.keys(r.vm!), er.edgeDecision(r, 'GB', '', at(2.5)), er.edgeDecision(r, '', '', at(2.5)), er.edgeDecision(r, 'MY', '', at(2.5))],
    [['*'], 'replace:' + r.vm!['*'], 'replace:' + r.vm!['*'], 'allow']);

  r = compile([P(2, 3, 'block', ['AU'], LOOP, ['premium'])]);
  check('a rights class exempt from the window watches through it', [er.edgeDecision(r, 'AU', 'premium', at(2.5)), er.edgeDecision(r, 'AU', '', at(2.5)), er.edgeDecision(r, 'AU', 'basic', at(2.5))], ['allow', 'replace:' + r.vm!.AU, 'replace:' + r.vm!.AU]);
  check('...the window carries its exempt classes', r.w![0][5], ['premium']);
  r = compile([P(2, 3, 'block', ['AU'], LOOP, ['premium']), P(3, 4, 'block', ['AU'], SLATE)]);
  check('a class with its own timeline gets its own variant and map entry', [Object.keys(r.vm!).sort(), er.edgeDecision(r, 'AU', 'premium', at(3.5)) === 'replace:' + r.vm!['AU/premium'], r.vm!.AU !== r.vm!['AU/premium']], [['AU', 'AU/premium'], true, true]);
  check('no variant service yet: a replace is enforced as a block', er.edgeDecision(compile([P(2, 3, 'block', ['AU'])], false), 'AU', '', at(2.5)), 'block');

  // Every audience at every time: when the decision is replace, its variant's
  // timeline covers that moment with the window's own replacement.
  const fixtures = [
    [P(1, 3, 'block', ['AU', 'NZ']), P(2, 4, 'block', ['NZ', 'FJ'], SLATE), P(5, 6, 'allow', ['MY'], LOOP, ['gold'])],
    [P(0, 1, 'block', ['US'], null), P(0.5, 2, 'block', ['US', 'CA'], SLATE, ['gold', 'silver']), P(1.5, 2.5, 'allow', ['US'])],
    [P(-1, 1, 'block', ['GB']), P(1, 2, 'block', ['GB']), P(2, 3, 'block', ['GB'], SLATE)],
  ];
  let covered = 0, cases = 0;
  for (const progs of fixtures) {
    const rules = compile(progs);
    const vars = er.streamVariants(progs, NOW).variants;
    for (const cc of ['', 'AU', 'NZ', 'FJ', 'MY', 'US', 'CA', 'GB', 'DE']) for (const rc of ['', 'gold', 'silver', 'other']) for (let h = -0.5; h <= 6.5; h += 0.25) {
      const t = at(h), d = er.edgeDecision(rules, cc, rc, t);
      if (!d.startsWith('replace:')) continue;
      cases++;
      const tl = vars.find((x) => x.key === d.slice(8))?.timeline ?? [];
      const win = progs.find((p: any) => t >= +p.starts_at / 1000 && t < +p.ends_at / 1000 && er.decideFor(er.compileEdgeRules({ account: null, channel: null, programmes: [p], nowSec: NOW }), cc, rc, t) !== 'allow');
      if (tl.some((x) => t >= x[0] && t < x[1] && x[2] === (win as any)?.replacement_asset_id)) covered++;
      else console.log('  not covered', cc, rc, h, d);
    }
  }
  check(`every replace decision lands on a variant covering that moment with the right replacement (${cases} cases)`, cases > 50 && covered === cases, true);

  const many = Array.from({ length: 60 }, (_, i) => P(i / 6, i / 6 + 1 / 6, 'block', [['AU', 'NZ', 'FJ'][i % 3], 'PG'], i % 2 ? LOOP : SLATE));
  r = compile(many);
  const pub = r.w!.length;
  check('60 replace windows still fit the 1 KB value, cut nearest first', Buffer.byteLength(JSON.stringify(r)) <= 1024 && pub > 3 && pub < 60, true);
  const fromPublished = er.streamVariants(many.slice(0, pub), NOW).vm;
  check('...and the map is made from exactly the windows published', JSON.stringify(r.vm), JSON.stringify(fromPublished));
  check('...complete until the first window left out', r.u, Math.floor(+many[pub].starts_at / 1000));

  // ---- 2. parity with the CloudFront Function, and the claim -----------------------------------------
  const src = readFileSync(join(__dirname, '../../deploy/edge/rights-viewer-request.js'), 'utf8');
  check('the function is inside CloudFront Functions\' 10 KB', Buffer.byteLength(src) < 10240, true);
  const store: Record<string, string> = {};
  let storeDown = false;
  (globalThis as any).__cf = { kvs: () => ({ async get(k: string) { if (storeDown) throw new Error('kvs down'); if (!(k in store)) throw new Error('key not found'); return store[k]; } }) };
  (globalThis as any).__crypto = await import('node:crypto');
  const body = src.replace("import cf from 'cloudfront';", 'const cf = globalThis.__cf;').replace("import crypto from 'crypto';", 'const crypto = globalThis.__crypto;').replace('${kvs_id}', 'kvs-test');
  const edge = new Function(`${body}\nreturn { handler, edgeDecision, claimClass };`)();

  const tableRules: any[] = [null, { v: 1 }, { v: 2, w: [[0, 9e9, 'b', ['AU'], 1]] }, { v: 1, a: ['b', ['CN']], c: ['a', ['MY', 'AU', 'NZ', 'US']] },
    ...fixtures.map((f) => compile(f)), ...fixtures.map((f) => compile(f, false)),
    compile([P(2, 3, 'block', ['AU'], LOOP, ['premium']), P(3, 4, 'block', ['AU'], SLATE)]), compile([P(2, 3, 'allow', ['MY'])]), compile(many)];
  let same = 0, total = 0;
  for (const rr of tableRules) for (const cc of ['', 'AU', 'NZ', 'FJ', 'MY', 'US', 'CA', 'GB', 'CN', 'PG']) for (const rc of ['', 'gold', 'silver', 'premium']) for (let h = -1; h <= 7; h += 0.5) {
    total++;
    const a = er.edgeDecision(rr, cc, rc, at(h)), b = edge.edgeDecision(rr, cc, rc, at(h));
    if (a === b) same++; else if (total - same < 5) console.log('  differs', JSON.stringify(rr).slice(0, 80), cc, rc, h, a, b);
  }
  check(`the function and edgeRights.ts decide the same in all ${total} fixture cases`, same, total);

  const key = 'k'.repeat(64);
  const CH = '22222222-2222-2222-2222-222222222222', OTHER = '66666666-6666-6666-6666-666666666666';
  const good = er.signRightsClaim(CH, 'premium', NOW + 600, key);
  check('a claim signed by the app is verified by the function', edge.claimClass(good, CH, key, NOW), 'premium');
  check('...and by the app', er.verifyRightsClaim(good, CH, NOW, key), 'premium');
  const forged = good.slice(0, -1) + (good.endsWith('0') ? '1' : '0');
  check('a forged signature proves nothing (function and app)', [edge.claimClass(forged, CH, key, NOW), er.verifyRightsClaim(forged, CH, NOW, key)], ['', '']);
  const upgraded = good.replace('premium', 'gold');
  check('another class on a real signature proves nothing', [edge.claimClass(upgraded, CH, key, NOW), er.verifyRightsClaim(upgraded, CH, NOW, key)], ['', '']);
  check('an expired claim proves nothing', [edge.claimClass(good, CH, key, NOW + 601), er.verifyRightsClaim(good, CH, NOW + 601, key)], ['', '']);
  check('a claim for another stream proves nothing', [edge.claimClass(good, OTHER, key, NOW), er.verifyRightsClaim(good, OTHER, NOW, key)], ['', '']);
  check('a claim checked with another key proves nothing', er.verifyRightsClaim(good, CH, NOW, 'x'.repeat(64)), '');
  let threw = false; try { er.signRightsClaim(CH, 'Premium Tier', NOW + 60, key); } catch { threw = true; }
  check('a class that is not short, lower case and URL safe is refused at signing', threw, true);

  const realNow = Date.now;
  Date.now = () => at(2.5) * 1000;
  const rules = compile([P(2, 3, 'block', ['AU'], LOOP, ['premium']), P(2, 3, 'block', ['CN'], null)]);
  store[`s:${CH}`] = JSON.stringify(rules);
  store['k:rc'] = key;
  const AUk = rules.vm!.AU;
  const live = er.signRightsClaim(CH, 'premium', at(4), key);      // valid at the mocked clock
  const liveForged = live.slice(0, -1) + (live.endsWith('0') ? '1' : '0');
  const req = async (uri: string, cc?: string, extra: any = {}) => edge.handler({ request: { uri, headers: cc ? { 'cloudfront-viewer-country': { value: cc } } : {}, querystring: {}, cookies: {}, ...extra } });
  const outcome = (x: any) => (x.statusCode ? x.statusCode : x.uri);
  check('handler: AU in the window is rewritten to its variant', outcome(await req(`/channel/${CH}/master_cc.m3u8`, 'AU')), `/channel/${CH}/v/${AUk}/master_cc.m3u8`);
  check('...a media playlist in a rendition folder too', outcome(await req(`/channel/${CH}/720p/index_cc.m3u8`, 'AU')), `/channel/${CH}/v/${AUk}/720p/index_cc.m3u8`);
  check('...on an event path too', outcome(await req(`/event/${CH}/manifest_cc.mpd`, 'AU')), `/event/${CH}/v/${AUk}/manifest_cc.mpd`);
  check('...MY gets the normal stream', outcome(await req(`/channel/${CH}/master_cc.m3u8`, 'MY')), `/channel/${CH}/master_cc.m3u8`);
  check('...a plain blackout is a 451', outcome(await req(`/channel/${CH}/master_cc.m3u8`, 'CN')), 451);
  check('a signed premium claim in the query: AU watches through the window', outcome(await req(`/channel/${CH}/master_cc.m3u8`, 'AU', { querystring: { vrc: { value: live } } })), `/channel/${CH}/master_cc.m3u8`);
  check('...in a cookie too', outcome(await req(`/channel/${CH}/master_cc.m3u8`, 'AU', { cookies: { vrc: { value: live } } })), `/channel/${CH}/master_cc.m3u8`);
  check('a forged claim: the default class, so the variant', outcome(await req(`/channel/${CH}/master_cc.m3u8`, 'AU', { querystring: { vrc: { value: liveForged } } })), `/channel/${CH}/v/${AUk}/master_cc.m3u8`);
  delete store['k:rc'];
  check('no claim key in the store: claims prove nothing', outcome(await req(`/channel/${CH}/master_cc.m3u8`, 'AU', { querystring: { vrc: { value: live } } })), `/channel/${CH}/v/${AUk}/master_cc.m3u8`);
  store['k:rc'] = key;
  check('a variant asked for by name is served to its own audience', outcome(await req(`/channel/${CH}/v/${AUk}/master_cc.m3u8`, 'AU')), `/channel/${CH}/v/${AUk}/master_cc.m3u8`);
  check('...but is no way round a block', outcome(await req(`/channel/${CH}/v/${AUk}/master_cc.m3u8`, 'CN')), 451);
  check('...nor for a viewer who should get the normal stream', outcome(await req(`/channel/${CH}/v/${AUk}/master_cc.m3u8`, 'MY')), 451);
  check('segments always pass', outcome(await req(`/channel/${CH}/720p/seg_9.m4s`, 'CN')), `/channel/${CH}/720p/seg_9.m4s`);
  storeDown = true;
  check('a store that cannot be read fails open', outcome(await req(`/channel/${CH}/master_cc.m3u8`, 'AU')), `/channel/${CH}/master_cc.m3u8`);
  storeDown = false;
  store[`s:${CH}`] = '{not json';
  check('a broken value fails open', outcome(await req(`/channel/${CH}/master_cc.m3u8`, 'CN')), `/channel/${CH}/master_cc.m3u8`);
  Date.now = realNow;

  // ---- 3. on the Mac: the public route -----------------------------------------------------------------
  if (!process.env.DATABASE_URL) {
    console.log('PASS skipped the database part: set DATABASE_URL');
  } else {
    const { pool, one, query } = await import('../src/db');
    const { config } = await import('../src/config');
    const express = (await import('express')).default;
    const { publicLiveRouter } = await import('../src/modules/publicLive');
    const app = express(); app.use(publicLiveRouter);
    const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    const tag = Date.now().toString(36);
    const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`ev-${tag}`]))!.id;
    const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
    const g = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
    const ch = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'EV Sport') RETURNING id`, [g]))!.id;
    await query(`INSERT INTO programmes(channel_id, title, starts_at, ends_at, geo_mode, geo_countries, replacement_kind, replacement_ref, metadata)
                 VALUES ($1,'Match AU',now() - interval '5 minutes', now() + interval '1 hour','block',ARRAY['AU'],'loop','filler-1','{"rights_exempt":["premium"]}'),
                        ($1,'Match NZ',now() + interval '1 hour', now() + interval '2 hours','block',ARRAY['NZ'],'loop','filler-1','{}')`, [ch]);
    const get = async (path: string, headers: Record<string, string> = {}) => {
      const res = await fetch(base + path, { headers, redirect: 'manual' });
      let j: any = null; try { j = await res.json(); } catch { /* redirect */ }
      return { status: res.status, j, rights: res.headers.get('x-volt-rights'), cache: res.headers.get('cache-control'), loc: res.headers.get('location'), vary: res.headers.get('vary') };
    };
    // the variant service is on by default outside production since 1.14b;
    // these checks are of the rights decision before it, so it is off here
    process.env.EDGE_VARIANT_SERVICE = '0';
    const dbRules = (await er.loadEdgeRules('channel', ch))!;
    check('db: the guide gives AU and NZ each a variant', Object.keys(dbRules.vm ?? {}).sort(), ['AU', 'NZ']);
    let x = await get(`/live/${ch}/master.m3u8?as=AU`);
    check('dev ?as=AU in the window: 451, replaced, with its variant named', [x.status, x.j?.reason, x.j?.decision, x.j?.variant], [451, 'rights', 'replace', dbRules.vm!.AU]);
    check('...the edge decision in a header, and not cached', [x.rights, /no-store/.test(x.cache ?? '')], ['block', true]);
    x = await get(`/live/${ch}/master.m3u8?as=MY`);
    check('dev ?as=MY passes the rights and reaches the on-air check (off air here)', [x.status, x.j?.reason, x.rights, x.vary], [404, 'not_on_air', 'allow', 'CloudFront-Viewer-Country']);
    x = await get(`/live/${ch}/master.m3u8`, { 'X-Volt-Test-Country': 'NZ' });
    check('the test header works as ?as= (NZ not yet replaced)', [x.status, x.rights], [404, 'allow']);
    x = await get(`/live/${ch}/master.m3u8?as=NZ&at=${encodeURIComponent(new Date(Date.now() + 90 * 60_000).toISOString())}`);
    check('dev &at= 90 minutes on: NZ replaced', [x.status, x.j?.variant], [451, dbRules.vm!.NZ]);
    x = await get(`/live/${ch}/master.m3u8?as=AU&rc=premium`);
    check('dev &rc=premium: AU watches through the window it is exempt from', [x.status, x.rights], [404, 'allow']);
    x = await get(`/live/${ch}/master.m3u8?as=XX`);
    check('XX (country unknown) is not in a block list', x.status, 404);
    process.env.EDGE_VARIANT_SERVICE = '1';
    const nowIso = encodeURIComponent(new Date().toISOString());
    x = await get(`/live/${ch}/master.m3u8?as=AU&at=${nowIso}`);
    check('with the variant service on: AU is sent to its variant, the stand-ins with it', [x.status, x.loc], [302, `/live/${ch}/v/${dbRules.vm!.AU}/master.m3u8?as=AU&at=${nowIso}`]);
    process.env.EDGE_VARIANT_SERVICE = '0';

    (config as any).env = 'production';
    x = await get(`/live/${ch}/master.m3u8?as=AU`);
    check('production ignores ?as= (no country header: not in the block list)', [x.status, x.rights], [404, 'allow']);
    x = await get(`/live/${ch}/master.m3u8`, { 'X-Volt-Test-Country': 'AU' });
    check('...and the test header', x.status, 404);
    x = await get(`/live/${ch}/master.m3u8`, { 'CloudFront-Viewer-Country': 'AU' });
    check('production: the CDN country header decides (AU replaced)', [x.status, x.j?.decision], [451, 'replace']);
    x = await get(`/live/${ch}/master.m3u8?rc=premium`, { 'CloudFront-Viewer-Country': 'AU' });
    check('...?rc= is ignored in production', x.status, 451);
    const claim = er.signRightsClaim(ch, 'premium', Math.floor(Date.now() / 1000) + 600);
    x = await get(`/live/${ch}/master.m3u8?vrc=${claim}`, { 'CloudFront-Viewer-Country': 'AU' });
    check('...a signed premium claim is honoured, and the answer is not shared', [x.status, /no-store/.test(x.cache ?? '')], [404, true]);
    x = await get(`/live/${ch}/master.m3u8`, { 'CloudFront-Viewer-Country': 'AU', Cookie: `a=1; vrc=${claim}` });
    check('...from a cookie too', x.status, 404);
    x = await get(`/live/${ch}/master.m3u8?vrc=${claim.slice(0, -2)}00`, { 'CloudFront-Viewer-Country': 'AU' });
    check('...a forged one is not', x.status, 451);
    (config as any).env = 'development';
    delete process.env.EDGE_VARIANT_SERVICE;
    srv.close();
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
