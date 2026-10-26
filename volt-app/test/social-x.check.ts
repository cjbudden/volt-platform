// ============================================================================
//  X OFF BY DEFAULT, ON PER ACCOUNT (build queue 1.14h).
//
//  X bills its API per post and per read, so an account gets X only when a
//  system administrator switches it on (the deployment's X app) or when it
//  brings its own X developer app (X bills the customer). This suite, through
//  the real HTTP API and a local stand-in for X (test/lib/fake-social.ts):
//    - an account with neither: no X card, X refused for linking, sandbox,
//      publishing, publishing rules, legacy targets, retries, take-downs, and
//      no view syncing (reads cost money); its existing X accounts are kept
//      and listed as off;
//    - the switch: only a system administrator may set it on a shared Volt;
//      with it on, X shows, links on the deployment's app, and sandbox X works;
//    - its own app: X shows without the switch, the sign-in and the token
//      renewal use the account's client id and secret (checked on the wire),
//      and the secret is never returned by the API or written in the clear.
//
//  Usage: DATABASE_URL=... npx tsx test/social-x.check.ts   (needs ffmpeg)
// ============================================================================
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
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
  const work = mkdtempSync(join(tmpdir(), 'social-x-'));
  Object.assign(process.env, {
    CLIPS_DIR: join(work, 'clips'), SOCIAL_TEST_BASE: fake.base, SOCIAL_POLL_MS: '10', SOCIAL_SANDBOX_STEP_MS: '5',
    PUBLIC_BASE_URL: 'https://volt.example', SOCIAL_TOKEN_KEY: Buffer.alloc(32, 9).toString('base64'),
    // A shared Volt: the account owner is a customer, and only a system administrator sets the switch.
    VOLT_DEPLOYMENT: 'saas',
    // The deployment's own X app, as on a Volt that offers X.
    X_CLIENT_ID: 'deploy-x-id', X_CLIENT_SECRET: 'deploy-x-secret',
  });
  const { query, one, pool } = await import('../src/db');
  const { createServer } = await import('../src/server');
  const { signAccess, AUD_PLATFORM } = await import('../src/auth/jwt');
  const S = { ...(await import('../src/services/social')), ...(await import('../src/services/social/crypto')) };

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`x-${tag}`]))!.id;
  const owner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `x-${tag}@volt.test`]))!.id;
  const sysadmin = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status, platform_role) VALUES ($1,$2,'x','owner','active','saas_admin') RETURNING id`, [acct, `xs-${tag}@volt.test`]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
  const g = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name, status) VALUES ($1,'X Ch','ended') RETURNING id`, [g]))!.id;
  const asset = (await one<any>(`INSERT INTO vod_assets(channel_id, kind, title, master_key, export_mp4_key, start_epoch_ms, end_epoch_ms, duration_ms, metadata, thumb_status)
      VALUES ($1,'clip','Late winner','/clips/a/hls/index.m3u8','/clips/a/clip.mp4',$2,$3,2000,'{}'::jsonb,'ready') RETURNING id`, [ch, Date.now(), Date.now() + 2000]))!.id;
  mkdirSync(join(process.env.CLIPS_DIR!, 'a'), { recursive: true });
  const mp4 = join(process.env.CLIPS_DIR!, 'a', 'clip.mp4');
  const ff = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25', '-t', '1', '-c:v', 'libx264', mp4]);
  truthy('test clip rendered', ff.status === 0 && existsSync(mp4), String(ff.stderr));

  // An X account linked before X went off-by-default, with one published post: it must be kept.
  const oldX = (await one<any>(`INSERT INTO publish_targets(account_id, platform, name, external_account, enabled, mode, access_token_enc, account_label, link_status)
      VALUES ($1,'x','@voltold','42',true,'live',$2,'@voltold','connected') RETURNING id`, [acct, S.seal('x-at-old')]))!.id;
  const oldPub = (await one<any>(`INSERT INTO publications(vod_asset_id, platform, target_id, status, external_id, published_at)
      VALUES ($1,'x',$2,'published','t99', now() - interval '2 hours') RETURNING id`, [asset, oldX]))!.id;
  const yt = (await one<any>(`INSERT INTO publish_targets(account_id, platform, name, external_account, enabled, mode, access_token_enc, account_label, link_status)
      VALUES ($1,'youtube','Volt YT','UC1',true,'sandbox','sandbox','Volt YT','connected') RETURNING id`, [acct]))!.id;

  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = async (method: string, path: string, body?: any, sub = owner, aud?: string) => {
    const tok = signAccess({ sub, account_id: acct, role: 'owner' }, aud ? { aud } : {});
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let j: any = null; try { j = text ? JSON.parse(text) : null; } catch { j = text; }
    return { s: res.status, j, text };
  };
  const ids = (st: any) => (st.platforms ?? []).map((p: any) => p.id);

  console.log('== an account with neither ==');
  let st = (await call('GET', '/api/social/platforms')).j;
  check('no X card: the platforms leave X out', ids(st), ['youtube', 'facebook', 'instagram', 'threads', 'tiktok', 'dailymotion']);
  let xs = (await call('GET', '/api/social/x')).j;
  check('X state: off, no own app, the owner of a customer account cannot switch it', [xs.enabled, xs.allowed, xs.ownApp, xs.canSwitch], [false, false, null, false]);
  let r = await call('POST', '/api/social/connect/x');
  check('connecting X is refused with 403 and how it gets switched on', [r.s, /system administrator/.test(r.j?.error ?? '')], [403, true]);
  r = await call('POST', '/api/social/sandbox/x', {});
  check('a sandbox X account is refused too', r.s, 403);
  let refusedDirect = '';
  try { await S.startConnect('x', acct, owner); } catch (e: any) { refusedDirect = e.message; }
  truthy('the service refuses as well, not only the route', /not switched on/.test(refusedDirect), refusedDirect);
  r = await call('POST', '/api/publish-targets', { platform: 'x', name: 'by hand' });
  check('an X publish target cannot be added by hand', r.s, 403);
  const accts = (await call('GET', '/api/social/accounts')).j;
  const listedOld = accts.find((a: any) => a.id === oldX);
  check('the existing X account is kept and listed as off', [!!listedOld, listedOld?.off, listedOld?.enabled], [true, true, true]);
  check('other platforms are not off', accts.find((a: any) => a.id === yt)?.off, false);
  r = await call('POST', `/api/social/publish/${asset}`, { targets: [{ targetId: oldX, post: { description: 'Late winner' } }] });
  check('publishing to the X account is refused (422) with the reason', [r.s, /not switched on/.test(r.j?.error ?? '')], [422, true]);
  const pts = (await call('GET', '/api/publishing-rules/points')).j;
  const ptX = pts?.social?.find((p: any) => p.targetId === oldX);
  check('publishing rules list the X account as off, not as a choice', [ptX?.off, ptX?.enabled], [true, false]);
  const { validateTargets } = await import('../src/services/publishingRules');
  let ruleErr = '';
  try { await validateTargets(acct, [{ kind: 'social', targetId: oldX } as any]); } catch (e: any) { ruleErr = e.message; }
  truthy('a rule naming the X account cannot be saved', /not switched on/.test(ruleErr), ruleErr);
  const { publish } = await import('../src/services/availability');
  const out = await publish(asset, 'test', { targets: [{ kind: 'social', targetId: oldX, platform: 'x' }, { kind: 'social', targetId: yt, platform: 'youtube' }] });
  check('an old rule publishing to X and YouTube posts only to YouTube', out.publications.map((p: any) => p.platform), ['youtube']);
  // A post queued while X was on, run after it went off.
  const queued = (await one<any>(`INSERT INTO publications(vod_asset_id, platform, target_id, status, post) VALUES ($1,'x',$2,'pending','{"title":"","description":"q","tags":[],"privacy":"public"}') RETURNING id`, [asset, oldX]))!.id;
  try { await S.handleSocialPublish({ job: { payload: { publicationId: queued }, attempts: 1, max_attempts: 4 }, progress: async () => {} }); } catch { /* recorded on the row */ }
  const qrow = await one<any>(`SELECT status, error FROM publications WHERE id=$1`, [queued]);
  check('a post queued before X went off fails at once, nothing sent to X', [qrow.status, /not switched on/.test(qrow.error ?? ''), fake.calls.some((c) => c.path.startsWith('/x/'))], ['failed', true, false]);
  r = await call('POST', `/api/social/publications/${queued}/retry`, {});
  check('and cannot be retried while X is off', r.s, 403);
  await S.syncViews({ accountId: acct, force: true });
  check('no view reads from X while it is off (X bills every read)', fake.calls.filter((c) => c.path.startsWith('/x/')).length, 0);
  check('the old post keeps its row, untouched', (await one<any>(`SELECT status FROM publications WHERE id=$1`, [oldPub])).status, 'published');
  let tdErr = '';
  try { await S.removeFromPlatform(oldPub); } catch (e: any) { tdErr = e.message; }
  truthy('taking an X post down is refused while X is off', /not switched on/.test(tdErr), tdErr);

  console.log('\n== the switch ==');
  r = await call('PATCH', '/api/social/x', { enabled: true });
  check('the owner of a customer account cannot switch X on', r.s, 403);
  r = await call('PATCH', '/api/social/x', { enabled: true }, sysadmin);
  check('a system administrator can', [r.s, r.j?.enabled, r.j?.allowed, r.j?.canSwitch], [200, true, true, true]);
  truthy('the change is in the audit log', !!(await one<any>(`SELECT 1 FROM audit_log WHERE account_id=$1 AND entity_type='social_x'`, [acct])));
  st = (await call('GET', '/api/social/platforms')).j;
  const xCard = st.platforms.find((p: any) => p.id === 'x');
  check('X shows, ready on the deployment\'s app', [ids(st).includes('x'), xCard?.configured, xCard?.ownApp], [true, true, false]);
  check('the X account is no longer off', (await call('GET', '/api/social/accounts')).j.find((a: any) => a.id === oldX)?.off, false);
  r = await call('POST', '/api/social/sandbox/x', { label: 'Demo' });
  check('sandbox X works with X on', [r.s, r.j?.mode], [201, 'sandbox']);
  const sbx = r.j.id;
  const sbOut = await publish(asset, 'test', { targets: [{ kind: 'social', targetId: sbx, platform: 'x' }] });
  try { await S.handleSocialPublish({ job: { payload: { publicationId: sbOut.publications[0].id }, attempts: 1, max_attempts: 4 }, progress: async () => {} }); } catch { /* row */ }
  check('and publishes to the sandbox', (await one<any>(`SELECT status FROM publications WHERE id=$1`, [sbOut.publications[0].id])).status, 'published');
  r = await call('POST', '/api/social/connect/x');
  const u1 = new URL(r.j.url);
  check('connecting uses the deployment\'s X app', u1.searchParams.get('client_id'), 'deploy-x-id');
  const linked1 = await S.finishConnect('x', u1.searchParams.get('state')!, 'code-1', null);
  check('linked through the deployment\'s app', linked1.linked, ['@voltnews']);
  const tokCall = [...fake.calls].reverse().find((c) => c.path === '/x/api/2/oauth2/token')!;
  check('the token exchange authenticated as the deployment\'s app', Buffer.from(String(tokCall.auth).replace(/^Basic /, ''), 'base64').toString(), 'deploy-x-id:deploy-x-secret');
  r = await call('PATCH', `/api/platform/accounts/${acct}`, { xEnabled: false }, sysadmin);
  check('System Admin\'s account API needs a verified platform session', r.s, 403);
  r = await call('PATCH', `/api/platform/accounts/${acct}`, { xEnabled: false }, sysadmin, AUD_PLATFORM);
  check('with one, it switches X off again', [r.s, r.j?.x_enabled], [200, false]);
  const plist = (await call('GET', '/api/platform/accounts', undefined, sysadmin, AUD_PLATFORM)).j;
  const prow = (Array.isArray(plist) ? plist : plist?.items ?? plist?.accounts ?? []).find((a: any) => a.id === acct);
  check('and the System Admin account list says X is off', [prow?.x_enabled, prow?.x_own_app], [false, false]);
  check('and X is hidden again', ids((await call('GET', '/api/social/platforms')).j).includes('x'), false);

  console.log('\n== its own X app ==');
  r = await call('PUT', '/api/social/x/app', { clientId: 'cust-x-id', clientSecret: 'cust-x-secret-value' });
  check('the account saves its own X app', [r.s, r.j?.ownApp?.clientId, r.j?.ownApp?.hasSecret, r.j?.allowed, r.j?.enabled], [200, 'cust-x-id', true, true, false]);
  truthy('the secret is not in the answer', !r.text.includes('cust-x-secret-value'));
  const getX = await call('GET', '/api/social/x');
  truthy('nor in a later read', !getX.text.includes('cust-x-secret-value') && getX.j.ownApp.clientId === 'cust-x-id');
  const stored = await one<any>(`SELECT x_client_secret_enc FROM accounts WHERE id=$1`, [acct]);
  truthy('stored sealed, never in the clear', stored.x_client_secret_enc?.startsWith('v1.') && !stored.x_client_secret_enc.includes('cust-x-secret'));
  const audit = await query<any>(`SELECT detail::text AS d FROM audit_log WHERE account_id=$1 AND entity_type='social_x_app'`, [acct]);
  truthy('audited by client id, the secret not in the audit log', audit.length === 1 && audit[0].d.includes('cust-x-id') && !audit[0].d.includes('cust-x-secret'));
  st = (await call('GET', '/api/social/platforms')).j;
  check('X shows without the switch, ready on its own app', [ids(st).includes('x'), st.platforms.find((p: any) => p.id === 'x')?.configured, st.platforms.find((p: any) => p.id === 'x')?.ownApp], [true, true, true]);
  r = await call('POST', '/api/social/connect/x');
  const u2 = new URL(r.j.url);
  check('the sign-in sends the account\'s own client id to X', u2.searchParams.get('client_id'), 'cust-x-id');
  const before = fake.calls.length;
  const linked2 = await S.finishConnect('x', u2.searchParams.get('state')!, 'code-2', null);
  check('linked through its own app', linked2.linked, ['@voltnews']);
  const tok2 = fake.calls.slice(before).find((c) => c.path === '/x/api/2/oauth2/token')!;
  check('the token exchange authenticated with the account\'s own id and secret', Buffer.from(String(tok2.auth).replace(/^Basic /, ''), 'base64').toString(), 'cust-x-id:cust-x-secret-value');
  const live = await one<any>(`SELECT * FROM publish_targets WHERE account_id=$1 AND platform='x' AND mode='live' AND external_account='42' AND id <> $2`, [acct, oldX])
    ?? await one<any>(`SELECT * FROM publish_targets WHERE id=$1`, [oldX]);
  await query(`UPDATE publish_targets SET token_expires_at = now() - interval '1 minute', refresh_token_enc = $2 WHERE id=$1`, [live.id, S.seal('x-rt-1')]);
  const b2 = fake.calls.length;
  await S.validToken(await one<any>(`SELECT * FROM publish_targets WHERE id=$1`, [live.id]));
  const ref = fake.calls.slice(b2).find((c) => c.path === '/x/api/2/oauth2/token')!;
  check('renewing the token also uses the account\'s own app', Buffer.from(String(ref?.auth ?? '').replace(/^Basic /, ''), 'base64').toString(), 'cust-x-id:cust-x-secret-value');
  r = await call('POST', `/api/social/publish/${asset}`, { targets: [{ targetId: live.id, post: { description: 'Late winner' } }] });
  check('publishing to X is accepted with its own app', r.s, 201);
  r = await call('DELETE', '/api/social/x/app');
  check('removing its own app turns X off again (no switch)', [r.s, r.j?.ownApp, r.j?.allowed], [200, null, false]);
  check('the linked X accounts are kept', (await query(`SELECT 1 FROM publish_targets WHERE account_id=$1 AND platform='x'`, [acct])).length >= 2, true);
  r = await call('PUT', '/api/social/x/app', { clientId: 'cust-x-id', clientSecret: 'cust-x-secret-value' }, owner);
  const viewer = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','viewer','active') RETURNING id`, [acct, `xv-${tag}@volt.test`]))!.id;
  const tokV = signAccess({ sub: viewer, account_id: acct, role: 'viewer' });
  const rv = await fetch(base + '/api/social/x/app', { method: 'PUT', headers: { authorization: `Bearer ${tokV}`, 'content-type': 'application/json' }, body: JSON.stringify({ clientId: 'evil-id', clientSecret: 'evil-secret' }) });
  check('a viewer cannot set the account\'s X app', rv.status, 403);

  srv.close(); fake.close(); await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
