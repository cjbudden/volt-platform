// ============================================================================
//  SERVER SETUP NAMES ARE FOR WHOEVER RUNS VOLT (build queue 1.14-G4a).
//
//  Social accounts, Notifications and Fleet & Usage used to explain what was
//  missing in the server's own terms (SOCIAL_TOKEN_KEY, YOUTUBE_CLIENT_ID,
//  SMTP_URL, FCM_SERVICE_ACCOUNT, the mail host) to every account user. Now
//  only a system administrator, or the owner on a single-client deployment,
//  sees them (services/serverSetup.ts); everyone else is told their Volt
//  provider sets it up. The console reads `seesServerSetup` from /auth/me.
//
//  Over real HTTP, for an owner and an administrator on a single-client
//  deployment, an owner on a shared one, and a system administrator there:
//  /auth/me, /api/social/platforms and /api/notifications/config. Plus the
//  stored reason on an email that could not be sent.
//    DATABASE_URL=... npx tsx test/server-setup.check.ts
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};
/** Every server setting name a customer must not be shown. */
const SETTING = /SOCIAL_TOKEN_KEY|SMTP_URL|NOTIFY_FROM|FCM_SERVICE_ACCOUNT|_CLIENT_ID|_CLIENT_SECRET|_APP_ID|_APP_SECRET|_CLIENT_KEY|_API_KEY|_API_SECRET|\/api\/social\/callback/;

(async () => {
  // A known, empty mail and push setup to start from, whatever the shell has.
  for (const k of ['SMTP_URL', 'NOTIFY_FROM', 'FCM_SERVICE_ACCOUNT', 'SOCIAL_TOKEN_KEY']) delete process.env[k];
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { config } = await import('../src/config');
  const { sendNotification } = await import('../src/services/notifications');

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`ss-${tag}`]))!.id;
  const mk = async (who: string, role: string, platform: string | null = null) =>
    (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status, platform_role) VALUES ($1,$2,'x',$3,'active',$4) RETURNING id`,
      [acct, `${who}-${tag}@example.com`, role, platform]))!.id;
  const owner = await mk('owner', 'owner');
  const admin = await mk('admin', 'admin');
  const staff = await mk('staff', 'admin', 'support');

  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = (sub: string, role: string) => signAccess({ sub, account_id: acct, role });
  const get = async (path: string, t: string) => {
    const r = await fetch(base + path, { headers: { authorization: `Bearer ${t}` } });
    return { s: r.status, body: await r.json().catch(() => null) as any };
  };
  const view = async (sub: string, role: string) => {
    const t = tok(sub, role);
    const me = await get('/api/auth/me', t), soc = await get('/api/social/platforms', t), nt = await get('/api/notifications/config', t);
    return { me, soc, nt };
  };
  const original = config.deployment;
  try {
    // ---- single-client deployment (the default): the owner runs the server
    (config as any).deployment = 'single';
    let v = await view(owner, 'owner');
    check('single, owner: /auth/me says seesServerSetup', v.me.body?.seesServerSetup, true);
    check('single, owner: platforms list each platform\'s two settings', v.soc.body?.platforms?.every((p: any) => Array.isArray(p.env) && p.env.length === 2), true);
    check('single, owner: and the token key state and redirect URL', [typeof v.soc.body?.tokenKeyConfigured, !!v.soc.body?.platforms?.[0]?.callbackUrl], ['boolean', true]);
    check('single, owner: email says which settings send it', /SMTP_URL/.test(v.nt.body?.channels?.email?.detail ?? ''), true);
    check('single, owner: push says which setting sends it', /FCM_SERVICE_ACCOUNT/.test(v.nt.body?.channels?.push?.detail ?? ''), true);

    v = await view(admin, 'admin');
    check('single, administrator: /auth/me says not seesServerSetup', v.me.body?.seesServerSetup, false);
    check('single, administrator: platforms still load (200)', v.soc.s, 200);
    check('single, administrator: platforms keep id, label, ready, limits', v.soc.body?.platforms?.every((p: any) => p.id && p.label && typeof p.configured === 'boolean' && p.limits), true);
    check('single, administrator: no settings, redirect URLs, scopes or token key', v.soc.body?.platforms?.some((p: any) => p.env || p.callbackUrl || p.scopes) || 'tokenKeyConfigured' in (v.soc.body ?? {}), false);
    check('single, administrator: platforms name no server setting', SETTING.test(JSON.stringify(v.soc.body)), false);
    check('single, administrator: and say the detail is left out', v.soc.body?.setupDetail, false);
    check('single, administrator: email not set up, in plain words', v.nt.body?.channels?.email, { configured: false, detail: 'Not set up yet. Your Volt provider sets this up.' });
    check('single, administrator: push not set up, in plain words', v.nt.body?.channels?.push, { configured: false, detail: 'Not set up yet. Your Volt provider sets this up.' });
    check('single, administrator: the inbox line is unchanged', v.nt.body?.channels?.in_app?.configured, true);
    check('single, administrator: notifications name no server setting', SETTING.test(JSON.stringify(v.nt.body)), false);

    // ---- shared (saas) deployment: the owner is a customer
    (config as any).deployment = 'saas';
    v = await view(owner, 'owner');
    check('saas, owner: /auth/me says not seesServerSetup', v.me.body?.seesServerSetup, false);
    check('saas, owner: platforms name no server setting', SETTING.test(JSON.stringify(v.soc.body)), false);
    check('saas, owner: notifications name no server setting', SETTING.test(JSON.stringify(v.nt.body)), false);
    v = await view(staff, 'admin');
    check('saas, system administrator (support): /auth/me says seesServerSetup', v.me.body?.seesServerSetup, true);
    check('saas, system administrator: sees the settings', v.soc.body?.platforms?.[0]?.env?.length, 2);

    // ---- mail set up: the account user sees the sender, never the host
    process.env.SMTP_URL = 'smtp://mail.internal.example:2525';
    process.env.NOTIFY_FROM = 'alerts@example.com';
    v = await view(admin, 'admin');
    check('mail on, administrator: email ready, says the sender address', v.nt.body?.channels?.email, { configured: true, detail: 'Sent from alerts@example.com.' });
    check('mail on, administrator: the mail host is not shown', /mail\.internal/.test(JSON.stringify(v.nt.body)), false);
    v = await view(staff, 'admin');
    check('mail on, system administrator: sees the host and port', /mail\.internal\.example:2525/.test(v.nt.body?.channels?.email?.detail ?? ''), true);
    delete process.env.SMTP_URL; delete process.env.NOTIFY_FROM;

    // ---- the stored reason on an email that could not go names no settings:
    // it is shown on the Sent list and after Send me a test, to anyone.
    const r = await sendNotification({ accountId: acct, topic: 'test', recipients: [`admin-${tag}@example.com`], channels: ['email'], subject: 's', body: 'b' });
    const d = await one<any>(`SELECT status, last_error, gave_up_at FROM notification_deliveries WHERE notification_id=$1`, [r.id]);
    check('unsent email: failed and not retried', [d?.status, !!d?.gave_up_at], ['failed', true]);
    check('unsent email: the reason is plain', d?.last_error, 'Email is not set up on this deployment.');
  } finally {
    (config as any).deployment = original;
    srv.close();
    await query(`DELETE FROM notification_deliveries WHERE notification_id IN (SELECT id FROM notifications WHERE account_id=$1)`, [acct]).catch(() => {});
    await pool.end();
  }
  console.log(`\nserver-setup: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
