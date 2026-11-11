// ============================================================================
//  schema.org ADDRESSES FOLLOW THE PLAY TOKEN RULES (build queue P2-2g;
//  services/deliveryPolicy.ts schemaOrgMediaAllowed, services/schemaOrg.ts
//  videoObjectFromAsset `media`, modules/vod.ts the two routes).
//
//  `GET /api/vod/{id}/schema.org` (and the `jsonld` of `GET /api/vod/{id}`)
//  named the plain MP4 in `contentUrl` and the plain HLS, DASH and MP4 in
//  `associatedMedia`. Under enforce those answer 403; under issue or off they
//  go round the play gate. Decided by Christian, 11 Nov 2026: a token-free
//  title keeps them; every other title under enforce has neither; under issue
//  or off a title with a viewer condition (geo, rights, paywall, sign-in,
//  DRM, referrers, a streams limit) has neither and an open title keeps them;
//  `embedUrl` (the watch page) always stays.
//    DATABASE_URL=... npx tsx test/schema-org-tokens.check.ts
// ============================================================================
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

Object.assign(process.env, { CLIPS_DIR: mkdtempSync(join(tmpdir(), 'volt-sot-')), VOLT_EDGE_TOKENS: 'enforce' });

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

  // ---------------------------------------------------------------- pure
  const a = { id: 'aaaaaaaa-0000-4000-8000-0000000000f1', title: 'T', kind: 'vod', master_key: 'vod/x/master.m3u8', progressive_key: 'vod/x/file.mp4', formats: { hls: true, dash: true, progressive: true } };
  const on = S.videoObjectFromAsset(a), off = S.videoObjectFromAsset(a, [], { media: false });
  check('with media: contentUrl (the MP4) and HLS, DASH and MP4 in associatedMedia, as before', [!!on.contentUrl, on.associatedMedia?.map((m: any) => m.encodingFormat)], [true, ['application/vnd.apple.mpegurl', 'application/dash+xml', 'video/mp4']]);
  check('media: false leaves out contentUrl and associatedMedia and keeps embedUrl and the watch action',
    ['contentUrl' in off, 'associatedMedia' in off, off.embedUrl, off.potentialAction?.target, off.name], [false, false, on.embedUrl, on.embedUrl, 'T']);
  check('no plain address left anywhere in it', JSON.stringify(off).includes('master.m3u8') || JSON.stringify(off).includes('file.mp4'), false);

  // ---------------------------------------------------------------- the API
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`sot-${tag}`]))!.id;
  const owner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `sot-${tag}@volt.test`]))!.id;
  const tok = signAccess({ sub: owner, account_id: acct, role: 'owner' } as any);
  const STAMP = (o: any = {}) => JSON.stringify({ targets: [{ kind: 'portal' }], access: 'free', geo: { mode: 'worldwide', countries: [] }, ...o });
  const mk = async (title: string, stamp: string) => {
    const id = (await one<any>(
      `INSERT INTO vod_assets(account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, formats)
       VALUES ($1,'upload','clip',$2,0,60000,60000,'{"hls":true,"dash":true,"progressive":true}'::jsonb) RETURNING id`, [acct, title]))!.id;
    await query(`UPDATE vod_assets SET master_key = $2, progressive_key = $3, availability_state = 'available', published = true, media_state = 'ready',
                   availability = $4::jsonb, available_from = now() - interval '1 day' WHERE id = $1`,
      [id, `vod/${id}/master.m3u8`, `vod/${id}/file.mp4`, stamp]);
    await P.refreshPublicStatus(id); invalidateTag(`asset:${id}`);
    return String(id);
  };
  const tokenFree = await mk('Token-free', STAMP({ protection: { tokenFree: true } }));
  const open = await mk('Open', STAMP());
  const geo = await mk('Australia only', STAMP({ geo: { mode: 'allow', countries: ['AU'] } }));
  const paid = await mk('Paid', STAMP({ access: 'paid' }));
  const drm = await mk('DRM', STAMP({ protection: { drm: true } }));
  const members = await mk('Members', STAMP({ accessRules: [{ id: 'm', for: { scopes: ['this', 'live', 'ondemand'] }, if: { geo: 'in', countries: ['WORLD'] }, then: { access: 'members' } }] }));
  const referrers = await mk('Referrers', STAMP({ protection: { referrers: ['example.com'] } }));
  const streams = await mk('Streams limit', STAMP({ protection: { concurrentStreams: 2 } }));

  const srv = createServer().listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const get = async (p: string) => { const r = await fetch(base + p, { headers: { authorization: `Bearer ${tok}` } }); return { s: r.status, ct: r.headers.get('content-type'), j: await r.json().catch(() => null) as any }; };
  const media = async (id: string) => {
    const r = await get(`/api/vod/${id}/schema.org`);
    return [r.s, 'contentUrl' in (r.j ?? {}), 'associatedMedia' in (r.j ?? {}), typeof r.j?.embedUrl === 'string' && r.j.embedUrl.endsWith(`/portal/watch/${id}`)];
  };
  const both = [200, true, true, true], neither = [200, false, false, true];
  try {
    // ---- enforce
    process.env.VOLT_EDGE_TOKENS = 'enforce';
    check('enforce: a token-free title keeps contentUrl and associatedMedia (they play)', await media(tokenFree), both);
    const tf = await get(`/api/vod/${tokenFree}/schema.org`);
    check('...and they are its plain addresses', [tf.j.contentUrl.endsWith(`/vod/${tokenFree}/file.mp4`), tf.j.associatedMedia.length, (tf.ct ?? '').startsWith('application/ld+json')], [true, 3, true]);
    check('enforce: an ordinary open title has neither (they would answer 403), embedUrl stays', await media(open), neither);
    check('enforce: a geo-limited title has neither', await media(geo), neither);
    const det = await get(`/api/vod/${open}`);
    check('enforce: the asset\'s own jsonld follows the same rule', [det.s, 'contentUrl' in det.j.jsonld, 'associatedMedia' in det.j.jsonld, !!det.j.jsonld.embedUrl], [200, false, false, true]);
    check('enforce: the token-free title\'s jsonld keeps them', 'associatedMedia' in (await get(`/api/vod/${tokenFree}`)).j.jsonld, true);

    // ---- issue
    process.env.VOLT_EDGE_TOKENS = 'issue';
    check('issue: an open title keeps them', await media(open), both);
    check('issue: a token-free title keeps them', await media(tokenFree), both);
    check('issue: a geo-limited title has neither (it would go round the gate)', await media(geo), neither);
    check('issue: a paid title has neither', await media(paid), neither);
    check('issue: DRM, members only, referrers and a streams limit: neither',
      [await media(drm), await media(members), await media(referrers), await media(streams)], [neither, neither, neither, neither]);
    check('issue: the jsonld of an open title keeps them, of a paid title not',
      ['associatedMedia' in (await get(`/api/vod/${open}`)).j.jsonld, 'associatedMedia' in (await get(`/api/vod/${paid}`)).j.jsonld], [true, false]);

    // ---- off
    process.env.VOLT_EDGE_TOKENS = 'off';
    check('off: open keeps them, geo-limited and paid have neither', [await media(open), await media(geo), await media(paid)], [both, neither, neither]);

    // ---- a rule changing
    process.env.VOLT_EDGE_TOKENS = 'issue';
    await query(`UPDATE vod_assets SET availability = $2::jsonb WHERE id = $1`, [open, STAMP({ geo: { mode: 'block', countries: ['US'] } })]);
    invalidateTag(`asset:${open}`);
    check('issue: an open title that gains a country limit loses them', await media(open), neither);
    check('an unknown title still answers 404', (await get(`/api/vod/bbbbbbbb-0000-4000-8000-0000000000f2/schema.org`)).s, 404);
    check('schemaOrgMediaAllowed refuses what is not an id', await D.schemaOrgMediaAllowed('nope'), false);
  } catch (e: any) {
    console.log('FAIL unexpected error -- ' + (e?.stack ?? e)); fail++;
  } finally {
    srv.close();
    await pool.end().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
