// ============================================================================
//  THREADS PUBLISHING (build queue 1.14j).
//
//  Through the real HTTP API, the real publish job and a local stand-in for
//  the Threads API (test/lib/fake-social.ts, graph.threads.net v1.0). The
//  stand-in fetches every video and picture address it is given, as Threads
//  does, from the Volt under test, so the signed media link is exercised end
//  to end:
//    - linking a profile (code, long-lived token, the profile, its followers);
//    - a clip as a video post: the container by video_url (a signed, expiring
//      link to /api/social/media/<id>.mp4 that Threads fetches), wait for
//      FINISHED, threads_publish, permalink; the link gone once published;
//    - the media link itself: range requests, a wrong signature, an expired
//      link, a Volt with no public address refused before Threads is asked;
//    - an Image Library picture as an image post (a signed JPEG);
//    - a container that errors (Threads' words, no retry), a dropped publish
//      answer (the retry carries on with the same container);
//    - the 500 character limit and one hashtag; the asset's first tag only;
//    - the 24 hour publishing limit (250) read, shown and enforced;
//    - views, likes and followers read back; the token renewed in its last
//      week; take-down refused honestly;
//    - a sandbox Threads profile end to end, pictures included.
//
//  Usage: DATABASE_URL=... npx tsx test/social-threads.check.ts   (needs ffmpeg)
// ============================================================================
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, statSync } from 'node:fs';
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
  const work = mkdtempSync(join(tmpdir(), 'social-th-'));
  Object.assign(process.env, {
    CLIPS_DIR: join(work, 'clips'), IMAGE_STORE_DIR: join(work, 'images'), SOCIAL_TEST_BASE: fake.base, SOCIAL_POLL_MS: '5', SOCIAL_SANDBOX_STEP_MS: '2',
    PUBLIC_BASE_URL: 'https://volt.example', SOCIAL_TOKEN_KEY: Buffer.alloc(32, 9).toString('base64'),
    THREADS_APP_ID: 'th-app', THREADS_APP_SECRET: 'th-secret',
  });
  const { query, one, pool } = await import('../src/db');
  const { config } = await import('../src/config');
  const { createServer } = await import('../src/server');
  const { signAccess } = await import('../src/auth/jwt');
  const S = { ...(await import('../src/services/social')), ...(await import('../src/services/social/crypto')) };

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`th-${tag}`]))!.id;
  const owner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `th-${tag}@volt.test`]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
  const g = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name, status) VALUES ($1,'TH Ch','ended') RETURNING id`, [g]))!.id;
  const mkAsset = async (title: string, dir: string) => (await one<any>(`INSERT INTO vod_assets(channel_id, kind, title, master_key, export_mp4_key, start_epoch_ms, end_epoch_ms, duration_ms, metadata, thumb_status)
      VALUES ($1,'clip',$2,$3,$4,$5,$6,2000,'{"tags":["rugby","final"]}'::jsonb,'ready') RETURNING id`, [ch, title, `/clips/${dir}/hls/index.m3u8`, `/clips/${dir}/clip.mp4`, Date.now(), Date.now() + 2000]))!.id;
  const render = (out: string, size: string) => spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=25`, '-t', '1', '-c:v', 'libx264', out]);
  for (const d of ['a', 'b']) mkdirSync(join(process.env.CLIPS_DIR!, d), { recursive: true });
  render(join(process.env.CLIPS_DIR!, 'a', 'clip.mp4'), '160x90');
  render(join(process.env.CLIPS_DIR!, 'b', 'clip.mp4'), '192x108');
  const sizeA = statSync(join(process.env.CLIPS_DIR!, 'a', 'clip.mp4')).size;
  const sizeB = statSync(join(process.env.CLIPS_DIR!, 'b', 'clip.mp4')).size;
  truthy('test clips rendered', sizeA > 0 && sizeB > 0);
  const assetA = await mkAsset('Late winner', 'a');
  const assetB = await mkAsset('Full time', 'b');

  const key = `library/${acct}/posters/final-whistle.png`;
  mkdirSync(join(process.env.IMAGE_STORE_DIR!, 'library', acct, 'posters'), { recursive: true });
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x400', '-frames:v', '1', join(process.env.IMAGE_STORE_DIR!, key)]);
  const img = (await one<any>(`INSERT INTO media_files(account_id, kind, path, folder, name, content_type, store_key, tags) VALUES ($1,'poster','posters/final-whistle.png','posters','final-whistle.png','image/png',$2,'{matchday}') RETURNING id`, [acct, key]))!.id;

  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  // The stand-in fetches what it is given from this Volt, in place of https://volt.example.
  fake.state.thFetchBase = base;
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
  const fetchCopy = (pubId: string) => join(process.env.CLIPS_DIR!, '.social-fetch', `${pubId}.mp4`);
  const local = (u: string) => base + u.replace('https://volt.example', '');

  console.log('== the platform ==');
  let st = (await call('GET', '/api/social/platforms')).j;
  let card = st.platforms.find((p: any) => p.id === 'threads');
  check('Threads is offered and ready', [card?.label, card?.configured, card?.accountNoun], ['Threads', true, 'profile']);
  check('it posts pictures and has a publishing limit', [card?.images, card?.publishingLimit], [true, true]);
  check('text up to 500 characters, one hashtag, no title', [card?.limits.title, card?.limits.description, card?.limits.hashtags], [null, 500, 1]);
  check('its settings and permissions for whoever sets it up', [card?.env, card?.scopes], [['THREADS_APP_ID', 'THREADS_APP_SECRET'], ['threads_basic', 'threads_content_publish', 'threads_manage_insights']]);
  check('listed beside the other Meta platforms', st.platforms.map((p: any) => p.id).slice(0, 4), ['youtube', 'facebook', 'instagram', 'threads']);
  delete process.env.THREADS_APP_ID;
  st = (await call('GET', '/api/social/platforms')).j;
  check('without its app id Threads says it is not set up', st.platforms.find((p: any) => p.id === 'threads')?.configured, false);
  const notSet = await call('POST', '/api/social/connect/threads', {});
  truthy('and connecting is refused, naming the settings', notSet.s === 400 && /THREADS_APP_ID/.test(notSet.j?.error ?? ''), notSet.text);
  process.env.THREADS_APP_ID = 'th-app';

  console.log('\n== linking a profile ==');
  let r = await call('POST', '/api/social/connect/threads', {});
  const u = new URL(r.j.url);
  check('the sign-in goes to Threads with the Threads app and its permissions',
    [u.pathname, u.searchParams.get('client_id'), u.searchParams.get('scope'), u.searchParams.get('response_type')],
    ['/threads/auth/oauth/authorize', 'th-app', 'threads_basic,threads_content_publish,threads_manage_insights', 'code']);
  let n0 = fake.calls.length;
  r = await call('GET', `/api/social/callback/threads?state=${u.searchParams.get('state')}&code=th-code`);
  check('the callback links the profile', [r.s, new URL(r.loc!, 'http://x').searchParams.get('linked')], [302, '@voltnews']);
  check('code, long-lived token, the profile, its followers', since(n0).map((c) => `${c.method} ${c.path}`),
    ['POST /threads/graph/oauth/access_token', 'GET /threads/graph/access_token', 'GET /threads/graph/v1.0/me', 'GET /threads/graph/v1.0/7001/threads_insights']);
  const ex = since(n0)[0];
  check('the code is exchanged with the app secret and the redirect address', [new URLSearchParams(ex.body).get('client_secret'), new URLSearchParams(ex.body).get('redirect_uri')], ['th-secret', 'https://volt.example/api/social/callback/threads']);
  const T = (await one<any>(`SELECT * FROM publish_targets WHERE account_id=$1 AND platform='threads' AND external_account='7001'`, [acct]))!;
  const days = (new Date(T.token_expires_at).getTime() - Date.now()) / 86_400_000;
  check('stored: followers, a 60 day token that renews itself, sealed', [Number(T.followers), Math.round(days), S.open(T.access_token_enc), S.open(T.refresh_token_enc), T.access_token_enc.includes('th-long')], [880, 60, 'th-long', 'th-long', false]);
  r = await call('GET', `/api/social/callback/threads?state=${u.searchParams.get('state')}&code=th-code`);
  truthy('the same sign-in cannot be used twice', /already been used/.test(new URL(r.loc!, 'http://x').searchParams.get('error') ?? ''));

  console.log('\n== a video post ==');
  r = await call('GET', `/api/social/accounts/${T.id}/publishing-limit`);
  check('the publishing limit is read before posting', [r.s, r.j?.applies, r.j?.used, r.j?.total, r.j?.remaining, r.j?.windowHours], [200, true, 0, 250, 250, 24]);
  r = await call('GET', `/api/social/publish/${assetA}/defaults`);
  check('the default post has the title and the first tag only', [r.j.threads?.description, r.j.threads?.tags], ['Late winner', ['rugby']]);
  check('which fits, as one hashtag', [S.fitPost('threads', r.j.threads).problems, S.fitPost('threads', r.j.threads).post.description], [[], 'Late winner #rugby']);
  r = await call('POST', `/api/social/publish/${assetA}`, { targets: [{ targetId: T.id, post: { description: 'Late winner #rugby' } }] });
  check('publishing is accepted', r.s, 201);
  const pubA = r.j.publications[0].id;
  n0 = fake.calls.length;
  let fetched0 = fake.state.thFetched.length;
  let row = await runJob(pubA);
  check('published, with the post\'s permalink', [row.status, row.external_id, row.external_url], ['published', 'pt1', 'https://www.threads.net/@voltnews/post/pt1']);
  const seq = since(n0).map((c) => `${c.method} ${c.path.replace(/t\d+$/, 't#')}`);
  check('the container flow in order', seq.filter((s, i) => s !== seq[i - 1]),
    ['GET /threads/graph/v1.0/7001/threads_publishing_limit', 'POST /threads/graph/v1.0/7001/threads', 'GET /threads/graph/v1.0/t#', 'POST /threads/graph/v1.0/7001/threads_publish', 'GET /threads/graph/v1.0/pt#']);
  const create = since(n0).find((c) => c.path.endsWith('/7001/threads'))!;
  const cf = new URLSearchParams(create.body);
  const videoUrl = cf.get('video_url') ?? '';
  check('a VIDEO container with the text', [cf.get('media_type'), cf.get('text'), cf.get('image_url')], ['VIDEO', 'Late winner #rugby', null]);
  truthy('Threads is given a signed, expiring link on Volt\'s public address', new RegExp(`^https://volt\\.example/api/social/media/${pubA}\\.mp4\\?exp=\\d+&sig=`).test(videoUrl), videoUrl);
  const exp = Number(new URL(videoUrl).searchParams.get('exp'));
  truthy('the link works for hours, not days', exp * 1000 - Date.now() > 5 * 3600_000 && exp * 1000 - Date.now() <= 6 * 3600_000 + 5000, String(exp));
  const got = fake.state.thFetched.slice(fetched0);
  check('Threads fetched the whole clip from Volt, as video/mp4', got.map((f) => [f.status, f.bytes, f.ctype]), [[200, sizeA, 'video/mp4']]);
  truthy('nothing was uploaded: no upload call at all', !since(n0).some((c) => /upload/.test(c.path)));
  truthy('graph calls use the profile\'s own token', since(n0).filter((c) => c.path.includes('/graph/v1.0/')).every((c) => c.auth === 'Bearer th-long'));
  check('once published the link answers 404 and the copy is gone', [(await fetch(local(videoUrl))).status, existsSync(fetchCopy(pubA))], [404, false]);
  truthy('the clip itself is untouched', existsSync(join(process.env.CLIPS_DIR!, 'a', 'clip.mp4')) && statSync(join(process.env.CLIPS_DIR!, 'a', 'clip.mp4')).size === sizeA);

  console.log('\n== the media link ==');
  const fakePub = '00000000-0000-4000-8000-0000000000aa';
  const link = S.fetchableVideo(fakePub, join(process.env.CLIPS_DIR!, 'b', 'clip.mp4'));
  let res = await fetch(local(link.url));
  check('a fresh link serves the file', [res.status, res.headers.get('content-type'), (await res.arrayBuffer()).byteLength, res.headers.get('cache-control')], [200, 'video/mp4', sizeB, 'private, no-store']);
  res = await fetch(local(link.url), { headers: { range: 'bytes=0-99' } });
  check('with range requests, as video fetchers use them', [res.status, (await res.arrayBuffer()).byteLength], [206, 100]);
  const lu = new URL(link.url);
  const sig = lu.searchParams.get('sig')!;
  check('a changed signature is refused', (await fetch(local(link.url.replace(`sig=${encodeURIComponent(sig)}`, `sig=${sig.slice(0, -2)}xx`)))).status, 404);
  check('a changed expiry is refused', (await fetch(local(link.url.replace(/exp=\d+/, `exp=${Number(lu.searchParams.get('exp')) + 3600}`)))).status, 404);
  const other = '00000000-0000-4000-8000-0000000000bb';
  check('another publication\'s id with this signature is refused', (await fetch(local(link.url.replace(fakePub, other)))).status, 404);
  const old = S.fetchableVideo(fakePub, join(process.env.CLIPS_DIR!, 'b', 'clip.mp4'), Date.now() - 7 * 3600_000);
  check('an expired link is refused', (await fetch(local(old.url))).status, 404);
  check('no signature, no file', (await fetch(`${base}/api/social/media/${fakePub}.mp4`)).status, 404);
  link.cleanup();
  check('cleaned up, the link stops working', [(await fetch(local(link.url))).status, existsSync(fetchCopy(fakePub))], [404, false]);
  config.publicBaseUrl = 'http://localhost:8080';
  r = await call('POST', `/api/social/publish/${assetB}`, { targets: [{ targetId: T.id, post: { description: 'No public address' } }] });
  n0 = fake.calls.length;
  row = await runJob(r.j.publications[0].id, 1, 4);
  truthy('a Volt with no public address fails at once, saying why, before Threads is asked',
    row.status === 'failed' && /fetches the video from Volt's public address/.test(row.error ?? '') && !since(n0).some((c) => c.path.endsWith('/threads')), row.error ?? '');
  check('and leaves no copy behind', existsSync(fetchCopy(row.id)), false);
  config.publicBaseUrl = 'https://volt.example';

  console.log('\n== a picture ==');
  r = await call('GET', `/api/social/publish-image/${img}/defaults`);
  check('a picture\'s default post is offered for Threads too', [Object.keys(r.j).sort(), r.j.threads?.description, r.j.threads?.tags], [['instagram', 'threads'], 'final whistle', ['matchday']]);
  r = await call('POST', `/api/social/publish-image/${img}`, { targets: [{ targetId: T.id, post: { description: 'Final whistle #matchday' } }] });
  check('publishing the picture is accepted', r.s, 201);
  n0 = fake.calls.length; fetched0 = fake.state.thFetched.length;
  row = await runJob(r.j.publications[0].id);
  check('the picture is a published Threads post', [row.status, row.image_key, row.vod_asset_id], ['published', key, null]);
  const ic = new URLSearchParams(since(n0).find((c) => c.path.endsWith('/7001/threads'))!.body);
  check('an IMAGE container', [ic.get('media_type'), ic.get('video_url')], ['IMAGE', null]);
  truthy('given a signed JPEG on Volt\'s public address', (ic.get('image_url') ?? '').startsWith('https://volt.example/img/'), ic.get('image_url') ?? '');
  check('which Threads fetched as a JPEG', fake.state.thFetched.slice(fetched0).map((f) => [f.status, f.ctype]), [[200, 'image/jpeg']]);

  console.log('\n== failures ==');
  r = await call('POST', `/api/social/publish/${assetB}`, { targets: [{ targetId: T.id, post: { description: 'THERROR on purpose' } }] });
  row = await runJob(r.j.publications[0].id, 1, 4);
  check('a container that errors fails at once with Threads\' words, nothing kept', [row.status, /unsupported format/.test(row.error ?? ''), row.platform_state, existsSync(fetchCopy(row.id))], ['failed', true, null, false]);
  r = await call('POST', `/api/social/publish/${assetB}`, { targets: [{ targetId: T.id, post: { description: 'REJECT this' } }] });
  row = await runJob(r.j.publications[0].id, 1, 4);
  check('text Threads refuses fails with its words', [row.status, /text was rejected/.test(row.error ?? '')], ['failed', true]);
  r = await call('POST', `/api/social/publish/${assetB}`, { targets: [{ targetId: T.id, post: { description: 'Dropped answer' } }] });
  const dropId = r.j.publications[0].id;
  fake.state.flaky.set('POST /threads/graph/v1.0/7001/threads_publish', 1);
  const containersBefore = fake.state.thContainers;
  row = await runJob(dropId, 1, 4);
  check('a dropped publish answer: retried later, the container and the copy kept', [row.status, row.stage, !!row.platform_state?.container, existsSync(fetchCopy(dropId))], ['pending', 'will retry', true, true]);
  fetched0 = fake.state.thFetched.length;
  row = await runJob(dropId, 2, 4);
  check('the retry publishes the same container, nothing fetched again', [row.status, fake.state.thContainers - containersBefore, fake.state.thFetched.length - fetched0, existsSync(fetchCopy(dropId))], ['published', 1, 0, false]);

  console.log('\n== limits ==');
  r = await call('POST', `/api/social/publish/${assetB}`, { targets: [{ targetId: T.id, post: { description: 'x'.repeat(501) } }] });
  truthy('501 characters are refused (422): at most 500', r.s === 422 && /500 characters/.test(r.j?.error ?? ''), r.text);
  r = await call('POST', `/api/social/publish/${assetB}`, { targets: [{ targetId: T.id, post: { description: 'Two tags', tags: ['rugby', 'final'] } }] });
  truthy('two hashtags are refused: one, the topic', r.s === 422 && /allows one hashtag in a post/.test(r.j?.error ?? ''), r.text);
  check('500 characters with one hashtag fit', S.fitPost('threads', { description: `${'y'.repeat(492)} #rugby` }).problems, []);
  fake.state.thQuotaUsed = 250;
  r = await call('GET', `/api/social/accounts/${T.id}/publishing-limit`);
  check('at the limit: 250 of 250 used, none left', [r.j?.used, r.j?.remaining], [250, 0]);
  r = await call('POST', `/api/social/publish/${assetB}`, { targets: [{ targetId: T.id, post: { description: 'One more' } }] });
  truthy('posting is refused (422), naming Threads\' limit', r.s === 422 && /250 of its 250 posts in the last 24 hours, Threads' publishing limit/.test(r.j?.error ?? ''), r.text);
  fake.state.thQuotaUsed = 4;
  check('Instagram\'s wording is unchanged', S.limitReached('@a', { used: 1, total: 1 }).includes("Instagram's publishing limit"), true);

  console.log('\n== read back ==');
  await S.syncViews({ accountId: acct, force: true });
  const post = await one<any>(`SELECT views, likes FROM publications WHERE external_id='pt1'`);
  check('views and likes of a post are read back', [Number(post.views), Number(post.likes)], [410, 22]);
  const ins = fake.calls.filter((c) => c.path === '/threads/graph/v1.0/pt1/insights').pop();
  check('in one insights call', ins?.query.get('metric'), 'views,likes');
  await query(`UPDATE publish_targets SET followers = 1 WHERE id = $1`, [T.id]);
  await S.syncFollowers({ accountId: acct, force: true });
  check('the follower count is read back', Number((await one<any>(`SELECT followers FROM publish_targets WHERE id=$1`, [T.id])).followers), 880);
  r = await call('GET', `/api/social/publications?assetId=${assetA}`);
  check('the asset\'s publications carry the views and likes', [r.j?.[0]?.platform, Number(r.j?.[0]?.views), Number(r.j?.[0]?.likes)], ['threads', 410, 22]);

  console.log('\n== the token, take-downs ==');
  await query(`UPDATE publish_targets SET token_expires_at = now() + interval '3 days' WHERE id=$1`, [T.id]);
  n0 = fake.calls.length;
  const tok = await S.validToken(await one<any>(`SELECT * FROM publish_targets WHERE id=$1`, [T.id]));
  const renewed = await one<any>(`SELECT token_expires_at FROM publish_targets WHERE id=$1`, [T.id]);
  check('a token in its last week is renewed with th_refresh_token', [tok, since(n0)[0]?.path, since(n0)[0]?.query.get('grant_type'), Math.round((new Date(renewed.token_expires_at).getTime() - Date.now()) / 86_400_000)],
    ['th-long-r1', '/threads/graph/refresh_access_token', 'th_refresh_token', 60]);
  let tdErr = '';
  try { await S.removeFromPlatform((await one<any>(`SELECT id FROM publications WHERE external_id='pt1'`)).id); } catch (e: any) { tdErr = e.message; }
  truthy('taking a post down says to do it in the Threads app', /remove it in the Threads app/.test(tdErr), tdErr);

  console.log('\n== sandbox ==');
  r = await call('POST', '/api/social/sandbox/threads', { label: 'Volt Demo' });
  check('a sandbox Threads profile', [r.s, r.j?.mode, r.j?.account_label], [201, 'sandbox', '@volt_demo']);
  const sb = r.j.id;
  r = await call('POST', `/api/social/publish/${assetA}`, { targets: [{ targetId: sb, post: { description: 'Sandbox post' } }] });
  n0 = fake.calls.length;
  row = await runJob(r.j.publications[0].id);
  check('a sandbox video post publishes, nothing sent to Threads, nothing placed', [row.status, since(n0).some((c) => c.path.startsWith('/threads/')), existsSync(fetchCopy(row.id))], ['published', false, false]);
  let page = await fetch(`${base}/social-sandbox/${row.id}`);
  let html = await page.text();
  truthy('its post page says it is a sandbox Threads post', page.status === 200 && html.includes('Sandbox Threads post') && html.includes('<video'));
  r = await call('POST', `/api/social/publish-image/${img}`, { targets: [{ targetId: sb, post: { description: 'Sandbox picture' } }] });
  row = await runJob(r.j.publications[0].id);
  page = await fetch(`${base}/social-sandbox/${row.id}`); html = await page.text();
  truthy('a sandbox picture post shows the picture', row.status === 'published' && /<img[^>]+\/img\/[^"]+/.test(html), html.slice(0, 300));
  r = await call('GET', `/api/social/accounts/${sb}/publishing-limit`);
  check('a sandbox counts its own posts against Threads\' 250', [r.j?.used, r.j?.total], [2, 250]);
  process.env.SOCIAL_SANDBOX_TH_LIMIT = '2';
  r = await call('POST', `/api/social/publish/${assetB}`, { targets: [{ targetId: sb, post: { description: 'Third' } }] });
  check('and is held to it', r.s, 422);
  delete process.env.SOCIAL_SANDBOX_TH_LIMIT;
  await S.syncViews({ accountId: acct, force: true });
  truthy('sandbox followers move', Number((await one<any>(`SELECT followers FROM publish_targets WHERE id=$1`, [sb])).followers) > 300);

  console.log('\n== publish targets ==');
  r = await call('GET', '/api/publish-targets?platform=threads');
  truthy('the publish targets list filters by threads', r.s === 200 && JSON.stringify(r.j).includes('@voltnews'), r.text.slice(0, 200));

  srv.close(); fake.close(); await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
