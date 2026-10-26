// ============================================================================
//  INSTAGRAM REELS AND FEED POSTS (build queue 1.14i).
//
//  Through the real HTTP API, the real publish job and a local stand-in for
//  the Instagram and Facebook Graph APIs (test/lib/fake-social.ts, v25.0):
//    - linking both ways: Instagram Login (short token, long-lived token, the
//      professional account; a personal account refused) and Facebook Login
//      (the Instagram account tied to a Page, posted with the Page token);
//    - a clip as a Reel through the container flow (create resumable, upload
//      the bytes to rupload, wait for FINISHED, media_publish, permalink),
//      the made 9:16 version sent when there is one;
//    - an Image Library picture as a feed post (a signed JPEG URL Meta fetches);
//    - a container that errors (the platform's words, no retry), a dropped
//      publish answer (the retry carries on with the same container);
//    - the 24 hour publishing limit read and shown, and posting refused at it;
//    - caption and hashtag limits; views, likes and followers read back;
//    - the token renewed in its last week; take-down refused honestly;
//    - a sandbox Instagram account end to end, pictures included.
//
//  Usage: DATABASE_URL=... npx tsx test/social-instagram.check.ts   (needs ffmpeg)
// ============================================================================
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeSocial } from './lib/fake-social';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `expected [${JSON.stringify(want)}] got [${JSON.stringify(got)}]`);
const truthy = (m: string, v: unknown, d = '') => (v ? ok(m) : bad(m, d || `got [${JSON.stringify(v)}]`));

(async () => {
  const fake = await startFakeSocial();
  const work = mkdtempSync(join(tmpdir(), 'social-ig-'));
  Object.assign(process.env, {
    CLIPS_DIR: join(work, 'clips'), IMAGE_STORE_DIR: join(work, 'images'), SOCIAL_TEST_BASE: fake.base, SOCIAL_POLL_MS: '5', SOCIAL_SANDBOX_STEP_MS: '2',
    PUBLIC_BASE_URL: 'https://volt.example', SOCIAL_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
    INSTAGRAM_APP_ID: 'ig-app', INSTAGRAM_APP_SECRET: 'ig-secret', FACEBOOK_APP_ID: 'fb-app', FACEBOOK_APP_SECRET: 'fb-secret',
  });
  const { query, one, pool } = await import('../src/db');
  const { createServer } = await import('../src/server');
  const { signAccess } = await import('../src/auth/jwt');
  const S = { ...(await import('../src/services/social')), ...(await import('../src/services/social/crypto')) };
  const { FB } = await import('../src/services/social/platforms');

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`ig-${tag}`]))!.id;
  const owner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `ig-${tag}@volt.test`]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
  const g = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name, status) VALUES ($1,'IG Ch','ended') RETURNING id`, [g]))!.id;
  const mkAsset = async (title: string, dir: string) => (await one<any>(`INSERT INTO vod_assets(channel_id, kind, title, master_key, export_mp4_key, start_epoch_ms, end_epoch_ms, duration_ms, metadata, thumb_status)
      VALUES ($1,'clip',$2,$3,$4,$5,$6,2000,'{"tags":["rugby","final"]}'::jsonb,'ready') RETURNING id`, [ch, title, `/clips/${dir}/hls/index.m3u8`, `/clips/${dir}/clip.mp4`, Date.now(), Date.now() + 2000]))!.id;
  const render = (out: string, size: string) => spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=25`, '-t', '1', '-c:v', 'libx264', out]);
  for (const d of ['a', 'b']) mkdirSync(join(process.env.CLIPS_DIR!, d), { recursive: true });
  render(join(process.env.CLIPS_DIR!, 'a', 'clip.mp4'), '160x90');
  render(join(process.env.CLIPS_DIR!, 'b', 'clip.mp4'), '160x90');
  render(join(process.env.CLIPS_DIR!, 'a', 'v916.mp4'), '90x160');
  const assetA = await mkAsset('Late winner', 'a');
  const assetB = await mkAsset('Full time', 'b');
  const sizeA = statSync(join(process.env.CLIPS_DIR!, 'a', 'clip.mp4')).size;
  const size916 = statSync(join(process.env.CLIPS_DIR!, 'a', 'v916.mp4')).size;
  truthy('test clips rendered', sizeA > 0 && size916 > 0 && size916 !== sizeA);
  // Asset A has a made, approved 9:16 version; render-on-publish stays off (the default).
  await query(`INSERT INTO vod_formats(vod_asset_id, format, review, render_state, output_key) VALUES ($1,'9x16','approved','ready','/clips/a/v916.mp4')`, [assetA]);

  // An Image Library picture (PNG: Instagram gets it as JPEG).
  const key = `library/${acct}/posters/final-whistle.png`;
  mkdirSync(join(process.env.IMAGE_STORE_DIR!, 'library', acct, 'posters'), { recursive: true });
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x400', '-frames:v', '1', join(process.env.IMAGE_STORE_DIR!, key)]);
  const img = (await one<any>(`INSERT INTO media_files(account_id, kind, path, folder, name, content_type, store_key, tags) VALUES ($1,'poster','posters/final-whistle.png','posters','final-whistle.png','image/png',$2,'{matchday}') RETURNING id`, [acct, key]))!.id;

  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = async (method: string, path: string, body?: any) => {
    const tok = signAccess({ sub: owner, account_id: acct, role: 'owner' });
    const res = await fetch(base + path, { method, redirect: 'manual', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let j: any = null; try { j = text ? JSON.parse(text) : null; } catch { j = text; }
    return { s: res.status, j, text, loc: res.headers.get('location') };
  };
  const runJob = async (pubId: string, attempts = 1, max = 4) => {
    let threw = '';
    try { await S.handleSocialPublish({ job: { payload: { publicationId: pubId }, attempts, max_attempts: max }, progress: async () => {} }); } catch (e: any) { threw = e.message; }
    return { ...(await one<any>(`SELECT * FROM publications WHERE id=$1`, [pubId])), threw };
  };
  const since = (n: number) => fake.calls.slice(n);

  console.log('== the platform ==');
  const st = (await call('GET', '/api/social/platforms')).j;
  const igCard = st.platforms.find((p: any) => p.id === 'instagram');
  check('Instagram is offered, ready, with both ways in', [igCard?.configured, igCard?.variants?.map((v: any) => [v.id, v.configured])], [true, [['instagram', true], ['facebook', true]]]);
  check('it posts pictures and has a publishing limit', [igCard?.images, igCard?.publishingLimit], [true, true]);
  check('caption limits: 2,200 characters, 30 hashtags, no title', [igCard?.limits.title, igCard?.limits.description, igCard?.limits.hashtags], [null, 2200, 30]);
  check('the Meta Graph API version is v25.0', FB, 'v25.0');

  console.log('\n== Instagram Login ==');
  let r = await call('POST', '/api/social/connect/instagram', {});
  const u = new URL(r.j.url);
  check('the sign-in goes to Instagram with the Instagram app and its permissions',
    [u.pathname, u.searchParams.get('client_id'), u.searchParams.get('scope')], ['/instagram/auth/oauth/authorize', 'ig-app', 'instagram_business_basic,instagram_business_content_publish']);
  let n0 = fake.calls.length;
  r = await call('GET', `/api/social/callback/instagram?state=${u.searchParams.get('state')}&code=ig-code`);
  check('the callback links the professional account', [r.s, new URL(r.loc!, 'http://x').searchParams.get('linked')], [302, '@voltnews']);
  check('code, then long-lived token, then the profile', since(n0).map((c) => c.path), ['/instagram/api/oauth/access_token', '/instagram/graph/access_token', `/instagram/graph/${FB}/me`]);
  const igT = (await one<any>(`SELECT * FROM publish_targets WHERE account_id=$1 AND platform='instagram' AND external_account='1789'`, [acct]))!;
  const days = (new Date(igT.token_expires_at).getTime() - Date.now()) / 86_400_000;
  check('stored: Instagram Login, the follower count, a 60 day token, sealed', [igT.variant, Number(igT.followers), Math.round(days), S.open(igT.access_token_enc), igT.access_token_enc.includes('ig-long')], ['instagram', 4200, 60, 'ig-long', false]);
  fake.state.igPersonal = true;
  r = await call('POST', '/api/social/connect/instagram', { variant: 'instagram' });
  r = await call('GET', `/api/social/callback/instagram?state=${new URL(r.j.url).searchParams.get('state')}&code=ig-code`);
  truthy('a personal Instagram account is refused, saying why', /personal Instagram account/.test(new URL(r.loc!, 'http://x').searchParams.get('error') ?? ''), r.loc ?? '');
  fake.state.igPersonal = false;
  r = await call('POST', '/api/social/connect/instagram', { variant: 'tiktok' });
  check('an unknown way in is refused', r.s, 400);

  console.log('\n== Facebook Login ==');
  r = await call('POST', '/api/social/connect/instagram', { variant: 'facebook' });
  const uf = new URL(r.j.url);
  check('the sign-in goes to the Facebook dialog on v25.0 with the Meta app', [uf.pathname, uf.searchParams.get('client_id')], [`/facebook/auth/${FB}/dialog/oauth`, 'fb-app']);
  truthy('asking for the Instagram publishing permissions', ['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement'].every((s) => (uf.searchParams.get('scope') ?? '').split(',').includes(s)));
  r = await call('GET', `/api/social/callback/instagram?state=${uf.searchParams.get('state')}&code=fb-code`);
  check('only the Page with an Instagram account is linked', new URL(r.loc!, 'http://x').searchParams.get('linked'), '@voltnews.page');
  const pgT = (await one<any>(`SELECT * FROM publish_targets WHERE account_id=$1 AND platform='instagram' AND external_account='1790'`, [acct]))!;
  check('stored: Facebook Login, the Page token, no expiry', [pgT.variant, S.open(pgT.access_token_enc), pgT.token_expires_at, Number(pgT.followers)], ['facebook', 'fb-page-1', null, 900]);

  console.log('\n== a Reel ==');
  r = await call('GET', `/api/social/accounts/${igT.id}/publishing-limit`);
  check('the publishing limit is read before posting', [r.s, r.j?.applies, r.j?.used, r.j?.total, r.j?.remaining, r.j?.windowHours], [200, true, 0, 100, 100, 24]);
  r = await call('POST', `/api/social/publish/${assetA}`, { targets: [{ targetId: igT.id, post: { description: 'Late winner #rugby', tags: [] } }] });
  check('publishing is accepted', r.s, 201);
  n0 = fake.calls.length;
  let row = await runJob(r.j.publications[0].id);
  check('published, with the post\'s permalink', [row.status, row.external_id, row.external_url], ['published', 'mc1', 'https://www.instagram.com/reel/mc1/']);
  const seq = since(n0).map((c) => `${c.method} ${c.path.replace(/c\d+$/, 'c#')}`);
  check('the container flow in order', seq.filter((s, i) => s !== seq[i - 1]),
    [`GET /instagram/graph/${FB}/1789/content_publishing_limit`, `POST /instagram/graph/${FB}/1789/media`, `POST /instagram/rupload/ig-api-upload/${FB}/c#`,
     `GET /instagram/graph/${FB}/c#`, `POST /instagram/graph/${FB}/1789/media_publish`, `GET /instagram/graph/${FB}/mc#`]);
  const create = since(n0).find((c) => c.path.endsWith('/1789/media'))!;
  const cf = new URLSearchParams(create.body);
  check('a resumable Reel container with the caption', [cf.get('media_type'), cf.get('upload_type'), cf.get('caption')], ['REELS', 'resumable', 'Late winner #rugby']);
  const upload = since(n0).find((c) => c.path.includes('/rupload/'))!;
  check('the made 9:16 version was uploaded, not the 16:9', upload.bytes, size916);
  truthy('graph calls use the account\'s own token', since(n0).filter((c) => c.path.includes('/graph/')).every((c) => c.auth === 'Bearer ig-long'));
  r = await call('POST', `/api/social/publish/${assetB}`, { targets: [{ targetId: igT.id, post: { description: 'Full time' } }] });
  n0 = fake.calls.length;
  row = await runJob(r.j.publications[0].id);
  check('an asset with no vertical version sends its own file', [row.status, since(n0).find((c) => c.path.includes('/rupload/'))?.bytes], ['published', statSync(join(process.env.CLIPS_DIR!, 'b', 'clip.mp4')).size]);

  console.log('\n== a picture ==');
  r = await call('GET', `/api/social/publish-image/${img}/defaults`);
  check('a picture\'s default post: its name and tags, Instagram only', [Object.keys(r.j), r.j.instagram?.description, r.j.instagram?.tags], [['instagram'], 'final whistle', ['matchday']]);
  r = await call('POST', `/api/social/publish-image/${img}`, { targets: [{ targetId: pgT.id, post: { description: 'Final whistle #matchday' } }] });
  check('publishing the picture is accepted', r.s, 201);
  const imgPub = r.j.publications[0].id;
  n0 = fake.calls.length;
  row = await runJob(imgPub);
  check('the picture is a published feed post', [row.status, row.image_key, row.vod_asset_id], ['published', key, null]);
  const ic = since(n0).find((c) => c.path.endsWith('/1790/media'))!;
  const imageUrl = new URLSearchParams(ic.body).get('image_url') ?? '';
  truthy('on the Facebook graph with the Page token', ic.path.startsWith(`/facebook/graph/${FB}/`) && ic.auth === 'Bearer fb-page-1');
  truthy('Instagram is given a signed JPEG on Volt\'s public address', imageUrl.startsWith('https://volt.example/img/') && /fm_jpeg|jpeg/.test(imageUrl), imageUrl);
  truthy('no upload of bytes for a picture', !since(n0).some((c) => c.path.includes('/rupload/')));
  const rendered = await fetch(base + imageUrl.replace('https://volt.example', ''));
  check('that address answers with a JPEG', [rendered.status, rendered.headers.get('content-type')], [200, 'image/jpeg']);
  r = await call('GET', `/api/social/publications?imageId=${img}`);
  check('the picture\'s publications are listed', [r.s, r.j?.length, r.j?.[0]?.status], [200, 1, 'published']);
  const yt = (await one<any>(`INSERT INTO publish_targets(account_id, platform, name, external_account, enabled, mode, access_token_enc, account_label, link_status)
      VALUES ($1,'youtube','Volt YT','UC1',true,'sandbox','sandbox','Volt YT','connected') RETURNING id`, [acct]))!.id;
  r = await call('POST', `/api/social/publish-image/${img}`, { targets: [{ targetId: yt, post: { title: 'x', description: 'y' } }] });
  truthy('a picture to YouTube is refused (422): it takes videos', r.s === 422 && /takes videos, not pictures/.test(r.j?.error ?? ''), r.text);
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`ig-o-${tag}`]))!.id;
  const otherImg = (await one<any>(`INSERT INTO media_files(account_id, kind, path, folder, name, store_key) VALUES ($1,'poster','p.png','','p.png',$2) RETURNING id`, [other, `library/${other}/p.png`]))!.id;
  r = await call('POST', `/api/social/publish-image/${otherImg}`, { targets: [{ targetId: pgT.id, post: { description: 'y' } }] });
  check('another account\'s picture is not found', r.s, 404);

  console.log('\n== failures ==');
  r = await call('POST', `/api/social/publish/${assetB}`, { targets: [{ targetId: igT.id, post: { description: 'IGERROR on purpose' } }] });
  row = await runJob(r.j.publications[0].id, 1, 4);
  check('a container that errors fails at once with Instagram\'s words', [row.status, /2207026 The video format is not supported/.test(row.error ?? ''), row.platform_state], ['failed', true, null]);
  r = await call('POST', `/api/social/publish/${assetB}`, { targets: [{ targetId: igT.id, post: { description: 'REJECT this' } }] });
  row = await runJob(r.j.publications[0].id, 1, 4);
  check('a caption Instagram refuses fails with its words', [row.status, /caption was rejected/.test(row.error ?? '')], ['failed', true]);
  r = await call('POST', `/api/social/publish/${assetB}`, { targets: [{ targetId: igT.id, post: { description: 'Dropped answer' } }] });
  const dropId = r.j.publications[0].id;
  fake.state.flaky.set(`POST /instagram/graph/${FB}/1789/media_publish`, 1);
  const containersBefore = fake.state.igContainers;
  row = await runJob(dropId, 1, 4);
  check('a dropped publish answer: retried later, the container kept', [row.status, row.stage, !!row.platform_state?.container, row.platform_state?.uploaded], ['pending', 'will retry', true, true]);
  n0 = fake.calls.length;
  row = await runJob(dropId, 2, 4);
  check('the retry publishes with the same container, uploading nothing again', [row.status, fake.state.igContainers - containersBefore, since(n0).some((c) => c.path.includes('/rupload/'))], ['published', 1, false]);

  console.log('\n== the publishing limit and caption limits ==');
  fake.state.igQuotaUsed = 100;
  r = await call('GET', `/api/social/accounts/${igT.id}/publishing-limit`);
  check('at the limit: 100 of 100 used, none left', [r.j?.used, r.j?.remaining], [100, 0]);
  r = await call('POST', `/api/social/publish/${assetB}`, { targets: [{ targetId: igT.id, post: { description: 'One more' } }] });
  truthy('posting is refused (422) and says why', r.s === 422 && /100 of its 100 posts in the last 24 hours/.test(r.j?.error ?? ''), r.text);
  const queued = (await one<any>(`INSERT INTO publications(vod_asset_id, platform, target_id, status, post) VALUES ($1,'instagram',$2,'pending','{"title":"","description":"queued","tags":[],"privacy":"public"}') RETURNING id`, [assetB, igT.id]))!.id;
  n0 = fake.calls.length;
  row = await runJob(queued, 1, 4);
  check('a post queued before the limit was reached fails at the limit, nothing created', [row.status, /publishing limit/.test(row.error ?? ''), since(n0).some((c) => c.path.endsWith('/media'))], ['failed', true, false]);
  fake.state.igQuotaUsed = 3;
  const tags31 = Array.from({ length: 31 }, (_, i) => `t${i}`);
  r = await call('POST', `/api/social/publish/${assetB}`, { targets: [{ targetId: igT.id, post: { description: 'Hashtags', tags: tags31 } }] });
  truthy('31 hashtags are refused: at most 30', r.s === 422 && /at most 30 hashtags/.test(r.j?.error ?? ''), r.text);
  r = await call('POST', `/api/social/publish/${assetB}`, { targets: [{ targetId: igT.id, post: { description: 'x'.repeat(2201) } }] });
  truthy('a caption over 2,200 characters is refused', r.s === 422 && /2200 characters/.test(r.j?.error ?? ''), r.text);
  check('30 hashtags fit', S.fitPost('instagram', { description: 'ok', tags: tags31.slice(0, 30) }).problems, []);

  console.log('\n== read back ==');
  await S.syncViews({ accountId: acct, force: true });
  const reel = await one<any>(`SELECT views, likes FROM publications WHERE external_id='mc1'`);
  check('views and likes of a Reel are read back', [Number(reel.views), Number(reel.likes)], [640, 31]);
  check('follower counts are read back', [Number((await one<any>(`SELECT followers FROM publish_targets WHERE id=$1`, [igT.id])).followers), Number((await one<any>(`SELECT followers FROM publish_targets WHERE id=$1`, [pgT.id])).followers)], [4321, 950]);
  const listed = (await call('GET', '/api/social/accounts')).j.find((a: any) => a.id === igT.id);
  check('the accounts list carries the way in and the followers', [listed?.variant, Number(listed?.followers)], ['instagram', 4321]);
  r = await call('GET', `/api/social/publications?assetId=${assetA}`);
  check('the asset\'s publications carry likes', Number(r.j?.[0]?.likes), 31);

  console.log('\n== the token, take-downs ==');
  await query(`UPDATE publish_targets SET token_expires_at = now() + interval '3 days' WHERE id=$1`, [igT.id]);
  n0 = fake.calls.length;
  const tok = await S.validToken(await one<any>(`SELECT * FROM publish_targets WHERE id=$1`, [igT.id]));
  const renewed = await one<any>(`SELECT token_expires_at, access_token_enc FROM publish_targets WHERE id=$1`, [igT.id]);
  check('a token in its last week is renewed with ig_refresh_token', [tok, since(n0)[0]?.path, since(n0)[0]?.query.get('grant_type'), Math.round((new Date(renewed.token_expires_at).getTime() - Date.now()) / 86_400_000)],
    ['ig-long-r1', '/instagram/graph/refresh_access_token', 'ig_refresh_token', 60]);
  let tdErr = '';
  try { await S.removeFromPlatform((await one<any>(`SELECT id FROM publications WHERE external_id='mc1'`)).id); } catch (e: any) { tdErr = e.message; }
  truthy('taking a post down says to do it in the Instagram app', /remove it in the Instagram app/.test(tdErr), tdErr);

  console.log('\n== sandbox ==');
  r = await call('POST', '/api/social/sandbox/instagram', { label: 'Volt Demo' });
  check('a sandbox Instagram account', [r.s, r.j?.mode, r.j?.account_label], [201, 'sandbox', '@volt_demo']);
  const sb = r.j.id;
  r = await call('POST', `/api/social/publish/${assetA}`, { targets: [{ targetId: sb, post: { description: 'Sandbox reel' } }] });
  n0 = fake.calls.length;
  row = await runJob(r.j.publications[0].id);
  check('a sandbox Reel publishes, nothing sent to Instagram', [row.status, since(n0).some((c) => c.path.startsWith('/instagram/'))], ['published', false]);
  let page = await fetch(`${base}/social-sandbox/${row.id}`);
  let html = await page.text();
  truthy('its post page says it is a sandbox Instagram post', page.status === 200 && html.includes('Sandbox Instagram post') && html.includes('<video'));
  r = await call('POST', `/api/social/publish-image/${img}`, { targets: [{ targetId: sb, post: { description: 'Sandbox picture' } }] });
  row = await runJob(r.j.publications[0].id);
  page = await fetch(`${base}/social-sandbox/${row.id}`); html = await page.text();
  truthy('a sandbox picture post shows the JPEG', row.status === 'published' && /<img[^>]+\/img\/[^"]+/.test(html), html.slice(0, 300));
  r = await call('GET', `/api/social/accounts/${sb}/publishing-limit`);
  check('a sandbox counts its own posts against the limit', [r.j?.used, r.j?.total], [2, 100]);
  process.env.SOCIAL_SANDBOX_IG_LIMIT = '2';
  r = await call('POST', `/api/social/publish/${assetB}`, { targets: [{ targetId: sb, post: { description: 'Third' } }] });
  check('and is held to it', r.s, 422);
  delete process.env.SOCIAL_SANDBOX_IG_LIMIT;
  await S.syncViews({ accountId: acct, force: true });
  truthy('sandbox followers move', Number((await one<any>(`SELECT followers FROM publish_targets WHERE id=$1`, [sb])).followers) > 1200);
  void readFileSync; void existsSync;

  srv.close(); fake.close(); await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
