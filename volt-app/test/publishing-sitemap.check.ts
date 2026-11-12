// ============================================================================
//  SITEMAP AND schema.org (build queue P3-4c-2, PUBLISHING_POLICIES.md
//  Distribution; services/deliveryPolicy.ts sitemapListedOf and
//  schemaOrgExposure, services/schemaOrg.ts videoObjectFromAsset `mp4`,
//  modules/vod.ts the two routes).
//
//  A title whose publishing rule turns Sitemap and schema.org off is left out
//  of its schema.org data: `GET /api/vod/{id}/schema.org` answers 404
//  not_listed and the asset's own `jsonld` is null. A title whose MP4
//  download is off keeps its HLS and DASH addresses but never names the MP4.
//  A draft reads its rules at once; a published title its stamp, so a rule
//  change reaches it with the restamp. Its own override wins both ways.
//    DATABASE_URL=... npx tsx test/publishing-sitemap.check.ts
// ============================================================================
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

Object.assign(process.env, { CLIPS_DIR: mkdtempSync(join(tmpdir(), 'volt-smp-')), VOLT_EDGE_TOKENS: 'off' });

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('PASS ' + m); pass++; } else { console.log(`FAIL ${m} -- expected [${w}] got [${g}]`); fail++; }
};

(async () => {
  const S = await import('../src/services/schemaOrg');
  const D = await import('../src/services/deliveryPolicy');
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { invalidateTag } = await import('../src/scale/cache');
  const P = await import('../src/services/publicStatus');
  const { restampStale } = await import('../src/services/availability');

  // ---------------------------------------------------------------- pure
  check('sitemapListedOf: no stamp, or a stamp from before the section: listed (the baseline)',
    [D.sitemapListedOf(null), D.sitemapListedOf({ access: 'free' }), D.sitemapListedOf({ distribution: {} })], [true, true, true]);
  check('sitemapListedOf: the stamp says off / on', [D.sitemapListedOf({ distribution: { sitemap: false } }), D.sitemapListedOf({ distribution: { sitemap: true } })], [false, true]);
  const a = { id: 'aaaaaaaa-0000-4000-8000-0000000000e1', title: 'T', kind: 'vod', master_key: 'vod/x/master.m3u8', progressive_key: 'vod/x/file.mp4', formats: { hls: true, dash: true, progressive: true } };
  const noMp4 = S.videoObjectFromAsset(a, [], { mp4: false });
  check('mp4: false leaves out contentUrl and the MP4 entry, keeps HLS, DASH and the watch page',
    ['contentUrl' in noMp4, noMp4.associatedMedia?.map((m: any) => m.encodingFormat), !!noMp4.embedUrl], [false, ['application/vnd.apple.mpegurl', 'application/dash+xml'], true]);
  check('...and the MP4 is named nowhere in it', JSON.stringify(noMp4).includes('file.mp4'), false);
  check('mp4 left unsaid: the MP4 is named as before', [!!S.videoObjectFromAsset(a).contentUrl, S.videoObjectFromAsset(a).associatedMedia.length], [true, 3]);

  // ---------------------------------------------------------------- the API
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`smp-${tag}`]))!.id;
  const owner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `smp-${tag}@volt.test`]))!.id;
  const tok = signAccess({ sub: owner, account_id: acct, role: 'owner' } as any);
  const schema = async (name: string) => (await one<any>(`INSERT INTO metadata_schemas(account_id,name,target_kind,fields) VALUES ($1,$2,'vod','[]'::jsonb) RETURNING id`, [acct, name]))!.id as string;
  const film = await schema('Film'), docu = await schema('Documentary'), short = await schema('Short');
  const STAMP = (o: any = {}) => JSON.stringify({ targets: [{ kind: 'portal' }], access: 'free', geo: { mode: 'worldwide', countries: [] }, ...o });
  const mk = async (title: string, schemaId: string, stamp: string | null) => {
    const id = (await one<any>(
      `INSERT INTO vod_assets(account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, formats, schema_id)
       VALUES ($1,'upload','clip',$2,0,60000,60000,'{"hls":true,"dash":true,"progressive":true}'::jsonb,$3) RETURNING id`, [acct, title, schemaId]))!.id;
    await query(`UPDATE vod_assets SET master_key = $2, progressive_key = $3, media_state = 'ready' WHERE id = $1`, [id, `vod/${id}/master.m3u8`, `vod/${id}/file.mp4`]);
    if (stamp) {
      await query(`UPDATE vod_assets SET availability_state = 'available', published = true, availability = $2::jsonb, available_from = now() - interval '1 day' WHERE id = $1`, [id, stamp]);
      await P.refreshPublicStatus(id);
    }
    invalidateTag(`asset:${id}`);
    return String(id);
  };
  const old = await mk('Harbour', film, STAMP());                                               // stamped before the section
  const hidden = await mk('Hidden', film, STAMP({ distribution: { sitemap: false } }));
  const noDl = await mk('No download', film, STAMP({ distribution: { mp4Download: false } }));
  const tfNoDl = await mk('Token-free, no download', film, STAMP({ protection: { tokenFree: true }, distribution: { mp4Download: false } }));
  const draft = await mk('Valley', docu, null);
  const pub = await mk('Shorts', short, STAMP());

  const srv = createServer().listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = async (method: string, path: string, body?: any) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const txt = await r.text(); let j: any = null; try { j = JSON.parse(txt); } catch { j = txt; }
    return { s: r.status, j };
  };
  const ld = async (id: string) => { const r = await call('GET', `/api/vod/${id}/schema.org`); return [r.s, r.j?.code ?? null]; };
  const jsonldOf = async (id: string) => (await call('GET', `/api/vod/${id}`)).j?.jsonld;
  const wait = async (f: () => Promise<boolean>) => { for (let i = 0; i < 60; i++) { if (await f()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
  const listed = [200, null], left = [404, 'not_listed'];
  try {
    // ---- the stamp
    check('a title stamped before the section is listed, its MP4 named', [await ld(old), !!(await call('GET', `/api/vod/${old}/schema.org`)).j.contentUrl], [listed, true]);
    const h = await call('GET', `/api/vod/${hidden}/schema.org`);
    check('a stamp turning Sitemap and schema.org off: 404 not_listed, with the reason',
      [h.s, h.j.code, h.j.error], [404, 'not_listed', 'This title is not listed: its publishing rule turns Sitemap and schema.org off (Distribution).']);
    check('...and the asset\'s own jsonld is null; the asset itself still answers', [(await call('GET', `/api/vod/${hidden}`)).s, await jsonldOf(hidden)], [200, null]);
    const nd = (await call('GET', `/api/vod/${noDl}/schema.org`)).j;
    check('MP4 download off: no contentUrl, HLS and DASH kept, the MP4 named nowhere',
      ['contentUrl' in nd, nd.associatedMedia?.map((m: any) => m.encodingFormat), JSON.stringify(nd).includes('file.mp4')],
      [false, ['application/vnd.apple.mpegurl', 'application/dash+xml'], false]);
    const ndj = await jsonldOf(noDl);
    check('...the same in the asset\'s jsonld', ['contentUrl' in ndj, ndj.associatedMedia.length], [false, 2]);
    process.env.VOLT_EDGE_TOKENS = 'enforce';
    const tf = (await call('GET', `/api/vod/${tfNoDl}/schema.org`)).j;
    check('enforce: a token-free title keeps its plain HLS and DASH but not the MP4 when its download is off',
      ['contentUrl' in tf, tf.associatedMedia?.length, JSON.stringify(tf).includes('file.mp4')], [false, 2, false]);
    process.env.VOLT_EDGE_TOKENS = 'off';

    // ---- a draft, from its rules, at once
    check('the draft documentary is listed to start with', await ld(draft), listed);
    let r = await call('PUT', `/api/publishing-rules/schema/${docu}`, { settings: { distribution: { sitemap: false } }, lockedFields: [] });
    check('the Documentary rule turns Sitemap and schema.org off', r.s, 200);
    check('the draft is left out at once (read from its rules)', [await ld(draft), await jsonldOf(draft)], [left, null]);
    r = await call('PUT', `/api/publishing-rules/schema/${docu}`, { settings: { distribution: { mp4Download: false } }, lockedFields: [] });
    const dd = (await call('GET', `/api/vod/${draft}/schema.org`)).j;
    check('the rule turning MP4 download off instead: listed again, without the MP4', [!!dd.embedUrl, 'contentUrl' in dd, dd.associatedMedia.length], [true, false, 2]);

    // ---- a published title, from its stamp, once the restamp has stamped it
    r = await call('PUT', `/api/publishing-rules/schema/${short}`, { settings: { distribution: { sitemap: false } }, lockedFields: [] });
    check('the Short rule turns it off: the published title is marked for the restamp', [r.s, r.j.restamp?.marked ?? r.j.marked], [200, 1]);
    check('its stamp now says Sitemap is off', await wait(async () => { await restampStale();
      return (await one<any>(`SELECT availability->'distribution'->>'sitemap' AS f FROM vod_assets WHERE id = $1`, [pub]))?.f === 'false'; }), true);
    invalidateTag(`asset:${pub}`);
    check('and it is left out (read from the stamp)', [await ld(pub), await jsonldOf(pub)], [left, null]);

    // ---- the title's own override wins, both ways
    r = await call('PATCH', `/api/vod/${pub}/availability`, { override: { distribution: { sitemap: true } } });
    check('its own policy turns it back on', r.s, 200);
    check('listed again once restamped', await wait(async () => { await restampStale(); invalidateTag(`asset:${pub}`); return (await ld(pub))[0] === 200; }), true);
    r = await call('PATCH', `/api/vod/${draft}/availability`, { override: { distribution: { sitemap: false } } });
    check('a draft\'s own policy turning it off leaves it out', [r.s, await ld(draft)], [200, left]);

    // ---- unknown
    check('an unknown title still answers 404 not found, not not_listed',
      [(await call('GET', `/api/vod/bbbbbbbb-0000-4000-8000-0000000000e2/schema.org`)).s, (await call('GET', `/api/vod/bbbbbbbb-0000-4000-8000-0000000000e2/schema.org`)).j?.code ?? null], [404, null]);
    check('schemaOrgExposure refuses what is not an id', await D.schemaOrgExposure('nope', acct), { listed: false, mp4: false });
  } catch (e: any) {
    console.log('FAIL unexpected error -- ' + (e?.stack ?? e)); fail++;
  } finally {
    srv.close();
    await pool.end().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
