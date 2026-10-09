// ============================================================================
//  SOCIAL PUBLISHING, end to end against a local stand-in for each platform
//  (test/lib/fake-social.ts): link accounts with OAuth (PKCE where the platform
//  needs it), store their tokens encrypted, publish a real MP4 through each
//  platform's upload sequence, read views back, renew an expiring token, and
//  fail properly (a rejected post, a revoked account, a flaky platform).
//
//  Usage: DATABASE_URL=... npx tsx test/social.check.ts   (needs ffmpeg)
// ============================================================================
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeSocial } from './lib/fake-social';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `expected [${JSON.stringify(want)}] got [${JSON.stringify(got)}]`);
const truthy = (m: string, v: unknown, d = '') => (v ? ok(m) : bad(m, d || `got [${JSON.stringify(v)}]`));

const ACC = '0000000a-0000-0000-0000-000000000501';
const USER = '0000000b-0000-0000-0000-000000000501';

(async () => {
  const fake = await startFakeSocial();
  const work = mkdtempSync(join(tmpdir(), 'social-'));
  process.env.CLIPS_DIR = join(work, 'clips');
  process.env.SOCIAL_TEST_BASE = fake.base;
  process.env.SOCIAL_POLL_MS = '10';
  process.env.SOCIAL_SANDBOX_STEP_MS = '5';
  process.env.PUBLIC_BASE_URL = 'https://volt.example';
  process.env.SOCIAL_TOKEN_KEY = Buffer.alloc(32, 7).toString('base64');

  const { query, one, pool } = await import('../src/db');
  const S = await import('../src/services/social');
  const { seal, open } = await import('../src/services/social/crypto');
  const { publish } = await import('../src/services/availability');

  console.log('== token sealing ==');
  const sealed = seal('secret-token')!;
  truthy('sealed value does not contain the token', !sealed.includes('secret-token'));
  check('opens back', open(sealed), 'secret-token');
  let tampered = false;
  try { open(sealed.slice(0, -2) + (sealed.endsWith('A') ? 'B' : 'A') + sealed.slice(-1)); } catch { tampered = true; }
  truthy('a tampered value is refused, not decrypted to garbage', tampered);

  console.log('\n== set up ==');
  check('nothing configured: every platform says not set up', S.platformStatus().platforms.map((p) => p.configured), [false, false, false, false, false]);
  let refused = '';
  try { await S.startConnect('youtube', ACC, null); } catch (e: any) { refused = e.message; }
  truthy('connecting an unconfigured platform names the variables to set', /YOUTUBE_CLIENT_ID/.test(refused), refused);
  Object.assign(process.env, {
    YOUTUBE_CLIENT_ID: 'yt-id', YOUTUBE_CLIENT_SECRET: 'yt-secret', FACEBOOK_APP_ID: 'fb-id', FACEBOOK_APP_SECRET: 'fb-secret',
    X_CLIENT_ID: 'x-id', X_CLIENT_SECRET: 'x-secret', TIKTOK_CLIENT_KEY: 'tt-key', TIKTOK_CLIENT_SECRET: 'tt-secret',
    DAILYMOTION_API_KEY: 'dm-key', DAILYMOTION_API_SECRET: 'dm-secret',
  });
  check('configured from the environment', S.platformStatus().platforms.map((p) => p.configured), [true, true, true, true, true]);
  check('callback URL is on the public host', S.platformStatus().platforms[0].callbackUrl, 'https://volt.example/api/social/callback/youtube');

  await query(`INSERT INTO accounts(id,name) VALUES ($1,'SocialCo') ON CONFLICT (id) DO NOTHING`, [ACC]);
  await query(`INSERT INTO users(id,account_id,email,password_hash,role,status) VALUES ($1,$2,'owner@social.example','x','owner','active') ON CONFLICT (id) DO NOTHING`, [USER, ACC]);
  await query(`INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('0000000c-0000-0000-0000-000000000501',$1,'HD','[{"height":360,"bitrate_kbps":800}]','transcode') ON CONFLICT (id) DO NOTHING`, [ACC]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id) VALUES ('0000000d-0000-0000-0000-000000000501',$1,'G','0000000c-0000-0000-0000-000000000501') ON CONFLICT (id) DO NOTHING`, [ACC]);
  await query(`INSERT INTO channels(id,group_id,name,status) VALUES ('0000000e-0000-0000-0000-000000000501','0000000d-0000-0000-0000-000000000501','Social Ch','ended') ON CONFLICT (id) DO NOTHING`);

  // a real 2-second MP4 the adapters upload, sitting where a rendered clip would
  const ASSET = '0000000f-0000-0000-0000-000000000501';
  mkdirSync(join(process.env.CLIPS_DIR!, ASSET), { recursive: true });
  const mp4 = join(process.env.CLIPS_DIR!, ASSET, 'clip.mp4');
  const ff = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000',
    '-t', '2', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', mp4]);
  truthy('test clip rendered', ff.status === 0 && existsSync(mp4), String(ff.stderr));
  const size = statSync(mp4).size;
  const now = Date.now();
  await query(`INSERT INTO vod_assets(id, channel_id, kind, title, master_key, export_mp4_key, start_epoch_ms, end_epoch_ms, duration_ms, metadata, thumb_status)
               VALUES ($1,'0000000e-0000-0000-0000-000000000501','clip','Grand Final highlights','/clips/${ASSET}/hls/index.m3u8','/clips/${ASSET}/clip.mp4',$2,$3,2000,
                       '{"description":"The winning try, in full.","tags":["rugby","final"]}'::jsonb,'ready') ON CONFLICT (id) DO NOTHING`, [ASSET, now, now + 2000]);
  const asset = await one<any>(`SELECT * FROM vod_assets WHERE id=$1`, [ASSET]);

  console.log('\n== posts ==');
  const ytDefault = S.defaultPost(asset, 'youtube');
  check('YouTube default post from the asset', [ytDefault.title, ytDefault.description, ytDefault.tags], ['Grand Final highlights', 'The winning try, in full.', ['rugby', 'final']]);
  const xDefault = S.defaultPost(asset, 'x');
  check('X default caption is title then description', xDefault.description, 'Grand Final highlights\n\nThe winning try, in full.');
  check('X tags become hashtags in the caption', S.fitPost('x', xDefault).post.description, 'Grand Final highlights\n\nThe winning try, in full. #rugby #final');
  truthy('an over-long X caption is a problem, counted with the hashtags', S.fitPost('x', { description: 'a'.repeat(275), tags: ['toolong'] }).problems[0]?.includes('280'));
  truthy('a YouTube title over 100 characters is a problem', S.fitPost('youtube', { title: 't'.repeat(101), description: '' }).problems[0]?.includes('100'));
  check('an unsupported privacy falls back to what the platform allows', S.fitPost('facebook', { title: 'x', description: 'y', privacy: 'unlisted' }).post.privacy, 'public');

  console.log('\n== linking accounts ==');
  async function link(platform: any, extra: Record<string, string> = {}) {
    const url = new URL(await S.startConnect(platform, ACC, USER));
    const st = url.searchParams.get('state')!;
    const verifier = (await one<any>(`SELECT code_verifier FROM social_oauth_states WHERE id=$1`, [st]))?.code_verifier ?? null;
    const r = await S.finishConnect(platform, st, 'code-123', null);
    return { url, r, state: st, verifier, ...extra };
  }
  const yt = await link('youtube');
  truthy('YouTube authorize URL asks for offline access with PKCE', yt.url.searchParams.get('access_type') === 'offline' && yt.url.searchParams.get('code_challenge_method') === 'S256');
  truthy('the PKCE verifier is kept server-side, never in the URL', !!yt.verifier && !yt.url.toString().includes(yt.verifier));
  check('YouTube channel linked', yt.r.linked, ['Volt Channel']);
  const reuse = await S.finishConnect('youtube', yt.state, 'code-123', null);
  truthy('a state cannot be used twice', reuse.error && /already been used/.test(reuse.error), JSON.stringify(reuse));
  const fb = await link('facebook');
  check('Facebook links every Page the person manages', fb.r.linked, ['Volt News', 'Volt Sport']);
  truthy('Facebook exchanged for the long-lived token before listing Pages', fake.routes().filter((r) => r.includes('/facebook/graph/v21.0/oauth/access_token')).length === 2);
  const xl = await link('x');
  check('X account linked as its handle', xl.r.linked, ['@voltnews']);
  const tt = await link('tiktok');
  check('TikTok account linked', tt.r.linked, ['@voltnews']);
  const dm = await link('dailymotion');
  check('Dailymotion account linked', dm.r.linked, ['VoltDM']);
  const denied = await (async () => { const u = new URL(await S.startConnect('youtube', ACC, USER)); return S.finishConnect('youtube', u.searchParams.get('state')!, null, 'access_denied'); })();
  truthy('a person who declines on the platform gets the platform\'s answer', /access_denied/.test(denied.error ?? ''));
  await query(`INSERT INTO social_oauth_states(id, account_id, platform, created_at) VALUES ('old-state',$1,'youtube', now() - interval '11 minutes')`, [ACC]);
  truthy('a state older than ten minutes is refused', /ten minutes/.test((await S.finishConnect('youtube', 'old-state', 'c', null)).error ?? ''));
  const targets = await query<any>(`SELECT * FROM publish_targets WHERE account_id=$1 AND mode='live' ORDER BY platform, name`, [ACC]);
  check('six live accounts linked', targets.length, 6);
  truthy('tokens are stored sealed, never in the clear', targets.every((t) => t.access_token_enc?.startsWith('v1.') && !t.access_token_enc.includes('-at-') && !t.access_token_enc.includes('fb-page')));
  const relink = await link('youtube');
  check('linking the same channel again updates it rather than duplicating it', [relink.r.linked, (await query(`SELECT 1 FROM publish_targets WHERE account_id=$1 AND platform='youtube' AND mode='live'`, [ACC])).length], [['Volt Channel'], 1]);

  console.log('\n== publishing through each platform ==');
  const T = async (platform: string, name?: string) => one<any>(`SELECT * FROM publish_targets WHERE account_id=$1 AND platform=$2 AND mode='live' ${name ? `AND name='${name}'` : ''} LIMIT 1`, [ACC, platform]);
  async function publishTo(target: any, post: any = null) {
    const out = await publish(ASSET, 'test', { targets: [{ kind: 'social', targetId: target.id, platform: target.platform }], ...(post ? { posts: { [target.id]: post } } : {}) });
    const pub = out.publications[0];
    return pub;
  }
  async function runJob(pubId: string, attempts = 1, max = 4) {
    const pub = await one<any>(`SELECT * FROM publications WHERE id=$1`, [pubId]);
    const job = await one<any>(`SELECT * FROM jobs WHERE id=$1`, [pub.job_id]);
    try { await S.handleSocialPublish({ job: { ...job, attempts, max_attempts: max }, progress: async () => {} }); } catch { /* recorded on the row */ }
    return one<any>(`SELECT * FROM publications WHERE id=$1`, [pubId]);
  }
  const p1 = await publishTo(await T('youtube'));
  check('a publication starts pending with its post and a queued job', [p1.status, p1.stage, !!p1.job_id, p1.post?.title], ['pending', 'queued', true, 'Grand Final highlights']);
  let r = await runJob(p1.id);
  check('YouTube: published with the watch URL', [r.status, r.external_url, r.progress], ['published', 'https://www.youtube.com/watch?v=ytVID1', 100]);
  const ytPut = fake.calls.find((c) => c.method === 'PUT' && c.path === '/youtube/upload/session/s1');
  check('YouTube: the whole file went up in the resumable session', ytPut?.bytes, size);

  r = await runJob((await publishTo(await T('facebook', 'Volt Sport'))).id);
  check('Facebook: posted as the Page, with the Page token', [r.status, r.external_url], ['published', 'https://www.facebook.com/p2/videos/fbvid1']);
  truthy('Facebook used the Page token, not the user token', fake.calls.some((c) => c.path === '/facebook/video/v21.0/p2/videos' && c.auth === 'Bearer fb-page-2' && c.bytes > size));

  r = await runJob((await publishTo(await T('x'))).id);
  check('X: posted with the media, link to the post', [r.status, r.external_url], ['published', 'https://x.com/voltnews/status/t99']);
  check('X: initialize, append, finalize, wait for processing, then post', fake.routes().filter((x) => x.includes('/x/api/2/media') || x.includes('/x/api/2/tweets')),
    ['POST /x/api/2/media/upload/initialize', 'POST /x/api/2/media/upload/m1/append', 'POST /x/api/2/media/upload/m1/finalize', 'GET /x/api/2/media/upload', 'GET /x/api/2/media/upload', 'POST /x/api/2/tweets']);

  r = await runJob((await publishTo(await T('tiktok'), { title: '', description: 'The winning try', tags: ['rugby'], privacy: 'public' })).id);
  check('TikTok: published (privately, as an unaudited app must)', [r.status, r.external_id, r.external_url], ['published', '7001', 'https://www.tiktok.com/@voltnews/video/7001']);
  truthy('TikTok: one chunk with the exact byte range', fake.calls.some((c) => c.path === '/tiktok/up/u1' && c.headers['content-range'] === `bytes 0-${size - 1}/${size}`));

  r = await runJob((await publishTo(await T('dailymotion'))).id);
  check('Dailymotion: uploaded, created, linked', [r.status, r.external_url], ['published', 'https://www.dailymotion.com/video/xdm1']);

  console.log('\n== views ==');
  const synced = await S.syncViews({ accountId: ACC, force: true });
  check('views synced for all five', synced, 5);
  const views = await query<any>(`SELECT platform, views FROM publications WHERE status='published' AND target_id IS NOT NULL ORDER BY platform::text`, []);
  check('the platforms\' own counts', views.map((v) => [v.platform, Number(v.views)]), [['dailymotion', 12], ['facebook', 77], ['tiktok', 9], ['x', 555], ['youtube', 1234]]);

  console.log('\n== failures ==');
  r = await runJob((await publishTo(await T('youtube'), { title: 'REJECT this', description: 'x', tags: [], privacy: 'public' })).id);
  check('a post the platform rejects fails at once with the platform\'s words', [r.status, /invalid video title/.test(r.error ?? '')], ['failed', true]);
  const inbox = await query<any>(`SELECT n.subject FROM notifications n WHERE n.account_id=$1 AND n.topic='publish.failed'`, [ACC]);
  truthy('the owner is told', inbox.some((n) => /Could not publish "Grand Final highlights" to YouTube/.test(n.subject)));

  fake.state.flaky.set('POST /dailymotion/api/me/videos', 1);
  const flaky = await publishTo(await T('dailymotion'));
  r = await runJob(flaky.id, 1, 4);
  check('a 503 on an early attempt leaves it pending, to be retried', [r.status, r.stage, /503/.test(r.error ?? '')], ['pending', 'will retry', true]);
  r = await runJob(flaky.id, 2, 4);
  check('and the retry publishes it', r.status, 'published');
  fake.state.flaky.set('POST /dailymotion/api/me/videos', 1);
  const last = await publishTo(await T('dailymotion'));
  r = await runJob(last.id, 4, 4);
  check('a 503 on the last attempt fails it', r.status, 'failed');

  const xt = await T('x');
  await query(`UPDATE publish_targets SET token_expires_at = now() - interval '1 minute' WHERE id=$1`, [xt.id]);
  r = await runJob((await publishTo(xt)).id);
  const xt2 = await one<any>(`SELECT * FROM publish_targets WHERE id=$1`, [xt.id]);
  check('an expired token is renewed before the upload, and the new one sealed', [r.status, open(xt2.access_token_enc)?.startsWith('x-at-r'), new Date(xt2.token_expires_at).getTime() > Date.now()], ['published', true, true]);

  fake.state.revoked.add('fb-page-1');
  const fbNews = await T('facebook', 'Volt News');
  r = await runJob((await publishTo(fbNews)).id);
  const fbAfter = await one<any>(`SELECT link_status FROM publish_targets WHERE id=$1`, [fbNews.id]);
  check('a revoked account fails the post and marks the account to reconnect', [r.status, fbAfter.link_status], ['failed', 'expired']);

  console.log('\n== take down ==');
  const ytPub = await one<any>(`SELECT id FROM publications WHERE external_id='ytVID1' LIMIT 1`);
  await S.removeFromPlatform(ytPub.id);
  truthy('YouTube delete called and the publication marked removed', fake.calls.some((c) => c.method === 'DELETE' && c.path === '/youtube/api/youtube/v3/videos' && c.query.get('id') === 'ytVID1')
    && (await one<any>(`SELECT status FROM publications WHERE id=$1`, [ytPub.id])).status === 'removed');
  let tdErr = '';
  try { await S.removeFromPlatform((await one<any>(`SELECT id FROM publications WHERE external_id='7001'`)).id); } catch (e: any) { tdErr = e.message; }
  truthy('TikTok says it cannot be taken down by an app', /does not let apps delete/.test(tdErr), tdErr);

  console.log('\n== sandbox ==');
  const sb = await S.addSandbox(ACC, USER, 'youtube', 'Demo channel');
  check('a sandbox account is labelled as one', [sb.mode, sb.name], ['sandbox', 'Demo channel (sandbox)']);
  r = await runJob((await publishTo(sb)).id);
  check('sandbox publishes with a page of its own', [r.status, r.external_url?.startsWith('https://volt.example/social-sandbox/')], ['published', true]);
  truthy('and nothing was sent to the platform', !fake.calls.some((c) => c.auth === 'Bearer sandbox'));
  r = await runJob((await publishTo(sb, { title: 'Try [fail]', description: '', tags: [], privacy: 'public' })).id);
  check('"[fail]" makes the sandbox fail on purpose', [r.status, /on purpose/.test(r.error ?? '')], ['failed', true]);

  fake.close(); await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
