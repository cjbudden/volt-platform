/**
 * IDENTITY CHECK: email change, mobile verification and two-step sign-in for
 * admin users and public users, the account policy, admin resets, and channel
 * group renames (ACCESS_CONTROL.md section 12).
 *
 *   DATABASE_URL=postgres://… npx tsx test/identity/identity-check.ts   (npm run test:identity)
 *
 * Runs the API with SECURITY_CODE_ECHO=1 (development only) so emailed and
 * texted codes come back in the response, and SMS_PROVIDER=log.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { totpAt } from '../../src/services/totp';

const DB = process.env.DATABASE_URL ?? 'postgres://volt:volt@localhost:5432/volt';
const ROOT = join(__dirname, '..', '..');
const API = 'http://localhost:18110';
const PW = 'VoltTest!2026';
const DOMAIN = `idn-${randomBytes(3).toString('hex')}.test`;
const procs: ChildProcess[] = [];
let failures = 0, passes = 0;

function ok(cond: boolean, what: string, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`);
  if (cond) passes++; else failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

function start(port: number) {
  const p = spawn(join(ROOT, 'node_modules/.bin/tsx'), ['src/index.ts'], {
    cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: DB, PORT: String(port), ROLE: 'all', ORCH_LAUNCHER: 'mock', PREWARM_ENABLED: 'false',
      NODE_ENV: 'development', SECURITY_CODE_ECHO: '1', SMS_PROVIDER: 'log', SMTP_URL: '', NOTIFY_FROM: '' },
  });
  p.stdout!.on('data', (d) => { if (process.env.VERBOSE) process.stdout.write(d); });
  p.stderr!.on('data', (d) => { if (process.env.VERBOSE) process.stderr.write(d); });
  procs.push(p);
}
async function ready() {
  for (let i = 0; i < 180; i++) {
    try { if ((await fetch(`${API}/health/ready`)).ok) return; } catch { /* starting */ }
    await sleep(500);
  }
  throw new Error('API never became ready');
}
async function call(method: string, path: string, token?: string | null, body?: any) {
  const r = await fetch(API + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, json };
}
const login = (email: string, password = PW) => call('POST', '/api/auth/login', null, { email, password });
const claims = (t: string) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());

async function main() {
  start(18110);
  await ready();
  const seed = spawnSync(join(ROOT, 'node_modules/.bin/tsx'), ['scripts/seed-access.ts'], {
    cwd: ROOT, env: { ...process.env, DATABASE_URL: DB, SEED_DOMAIN: DOMAIN, SEED_PASSWORD: PW }, encoding: 'utf8' });
  const acct = /Account ([0-9a-f-]{36})/.exec(seed.stdout)?.[1];
  const pk = /(pk_test_[A-Za-z0-9_-]+)/.exec(seed.stdout)?.[1];
  ok(!!acct && !!pk, 'test users seeded', acct ?? seed.stderr.slice(0, 200));
  if (!acct || !pk) return;
  const db = new Client({ connectionString: DB });
  await db.connect();

  // ===== admin user: authenticator app ==============================================
  let r = await login(`admin@${DOMAIN}`);
  let admin = r.json?.access as string;
  ok(!!admin && !r.json?.mfaRequired, 'no second step until one is set up');
  r = await call('GET', '/api/auth/security', admin);
  ok(r.status === 200 && r.json.methods.length === 0 && r.json.emailVerified === false, 'security summary: nothing set up yet');

  r = await call('POST', '/api/auth/mfa/totp/start', admin, {});
  ok(r.status === 403, 'adding an authenticator from a session needs the password', String(r.status));
  r = await call('POST', '/api/auth/mfa/totp/start', admin, { password: PW });
  const secret = r.json?.secret as string;
  ok(!!secret && String(r.json?.otpauthUri).startsWith('otpauth://totp/'), 'authenticator setup returns the secret and the otpauth URI for the QR code');
  const stored = (await db.query(`SELECT mfa_secret_ref FROM users WHERE email=$1`, [`admin@${DOMAIN}`])).rows[0].mfa_secret_ref;
  ok(String(stored).startsWith('enc:v1:') && !String(stored).includes(secret), 'the seed is stored sealed, never in plain text');
  r = await call('POST', '/api/auth/mfa/totp/confirm', admin, { code: '000000' });
  ok(r.status === 400 && r.json?.code === 'invalid_code', 'a wrong code is 400, not 401 (a typo never signs anyone out)', String(r.status));
  const c0 = totpAt(secret, now());
  r = await call('POST', '/api/auth/mfa/totp/confirm', admin, { code: c0 });
  const backup: string[] = r.json?.backupCodes ?? [];
  ok(r.status === 200 && backup.length === 10 && r.json.methods.includes('totp'), 'authenticator on, 10 backup codes issued once', String(r.status));

  // ===== sign-in now needs the second step ===========================================
  r = await login(`admin@${DOMAIN}`);
  let ch = r.json?.challenge as string;
  ok(r.json?.mfaRequired === true && !r.json?.access && r.json.methods.includes('totp') && r.json.methods.includes('backup'),
    'sign-in answers with a challenge, not tokens', JSON.stringify(r.json?.methods));
  r = await call('GET', '/api/channels', ch);
  ok(r.status === 401, 'a challenge token is not a session', String(r.status));
  r = await call('POST', '/api/auth/mfa/challenge/verify', null, { challenge: ch, method: 'totp', code: c0 });
  ok(r.status === 429, 'the code used at setup cannot be replayed', String(r.status));
  r = await call('POST', '/api/auth/mfa/challenge/verify', null, { challenge: ch, method: 'totp', code: totpAt(secret, now() + 30) });
  admin = r.json?.access;
  ok(r.status === 200 && !!admin && claims(admin).amr.includes('mfa'), 'authenticator code completes sign-in (amr has mfa)', String(r.status));
  r = await call('POST', '/api/auth/mfa/challenge/verify', null, { challenge: ch, method: 'backup', code: backup[0] });
  ok(r.status === 429, 'a challenge produces one session only', String(r.status));

  // backup code
  r = await login(`admin@${DOMAIN}`);
  r = await call('POST', '/api/auth/mfa/challenge/verify', null, { challenge: r.json.challenge, method: 'backup', code: backup[1].toUpperCase() });
  ok(r.status === 200 && !!r.json?.access && r.json.backupCodesRemaining === 9, 'a backup code signs in (case-insensitive) and is spent', String(r.json?.backupCodesRemaining));
  r = await login(`admin@${DOMAIN}`);
  r = await call('POST', '/api/auth/mfa/challenge/verify', null, { challenge: r.json.challenge, method: 'backup', code: backup[1] });
  ok(r.status === 400, 'a used backup code is refused', String(r.status));

  // ===== codes by email ==================================================================
  r = await call('POST', '/api/auth/mfa/email/start', admin, { password: PW });
  const ecode = r.json?.devCode as string;
  ok(r.status === 200 && /^\d{6}$/.test(ecode) && String(r.json.sentTo).includes('@'), 'email code sent (masked address)', r.json?.sentTo);
  const leak = (await db.query(`SELECT count(*)::int AS n FROM notifications WHERE body LIKE '%' || $1 || '%'`, [ecode])).rows[0].n;
  ok(leak === 0, 'security codes are never stored in the notifications inbox');
  r = await call('POST', '/api/auth/mfa/email/confirm', admin, { code: ecode });
  ok(r.status === 200 && r.json.methods.includes('email') && !r.json.backupCodes, 'email codes on (no new backup codes for a second method)');
  r = await call('GET', '/api/auth/security', admin);
  ok(r.json?.emailVerified === true, 'receiving the code verified the email address');

  r = await login(`admin@${DOMAIN}`);
  ch = r.json.challenge;
  r = await call('POST', '/api/auth/mfa/challenge/send', null, { challenge: ch, method: 'email' });
  const lcode = r.json?.devCode;
  for (let i = 0; i < 5; i++) await call('POST', '/api/auth/mfa/challenge/verify', null, { challenge: ch, method: 'email', code: '111111' });
  r = await call('POST', '/api/auth/mfa/challenge/verify', null, { challenge: ch, method: 'email', code: lcode });
  ok(r.status === 400, 'after 5 wrong guesses the code is dead, even the right one', String(r.status));
  r = await call('POST', '/api/auth/mfa/challenge/send', null, { challenge: ch, method: 'email' });
  r = await call('POST', '/api/auth/mfa/challenge/verify', null, { challenge: ch, method: 'email', code: r.json?.devCode });
  ok(r.status === 200 && !!r.json?.access, 'a fresh emailed code signs in', String(r.status));
  admin = r.json.access;

  // ===== change email ==========================================================================
  r = await call('POST', '/api/auth/email/change', admin, { newEmail: `boss@${DOMAIN}`, password: 'wrong-password' });
  ok(r.status === 403 && r.json?.code === 'reauth_failed', 'changing email needs the password (403, session kept)', String(r.status));
  ok((await call('GET', '/api/auth/me', admin)).status === 200, 'the session survives a mistyped password');
  r = await call('POST', '/api/auth/email/change', admin, { newEmail: `events@${DOMAIN}`, password: PW });
  ok(r.status === 400, 'an address another user has is refused', String(r.status));
  r = await call('POST', '/api/auth/email/change', admin, { newEmail: `Boss@${DOMAIN}`, password: PW });
  ok(r.status === 200 && !!r.json?.devCode, 'code sent to the NEW address', r.json?.sentTo);
  const before = (await call('GET', '/api/auth/me', admin)).json?.email;
  ok(before === `admin@${DOMAIN}`, 'the email does not change until the code is entered');
  r = await call('POST', '/api/auth/email/change/confirm', admin, { code: r.json.devCode });
  ok(r.status === 200 && r.json.email === `boss@${DOMAIN}`, 'email changed after confirmation (lower-cased)', r.json?.email);
  r = await login(`admin@${DOMAIN}`);
  ok(r.status === 401, 'the old address no longer signs in', String(r.status));
  r = await login(`boss@${DOMAIN}`);
  ok(r.json?.mfaRequired === true, 'the new address signs in (with the second step)');

  // ===== mobile number and SMS codes ============================================================
  r = await call('POST', '/api/auth/phone', admin, { phone: '0412 345 678', password: PW });
  ok(r.status === 400 || r.status === 422, 'a number not in international format is refused', String(r.status));
  r = await call('POST', '/api/auth/phone', admin, { phone: '+61412345678', password: PW });
  ok(r.status === 200 && String(r.json?.sentTo).endsWith('78') && !String(r.json?.sentTo).includes('345'), 'SMS code sent (masked number)', r.json?.sentTo);
  r = await call('POST', '/api/auth/phone/confirm', admin, { code: r.json.devCode });
  ok(r.status === 200 && r.json.phoneVerified, 'mobile number verified');
  r = await call('POST', '/api/auth/mfa/sms/start', admin, { password: PW });
  r = await call('POST', '/api/auth/mfa/sms/confirm', admin, { code: r.json?.devCode });
  ok(r.status === 200 && r.json.methods.includes('sms'), 'SMS codes on, to the verified number');
  r = await call('DELETE', '/api/auth/mfa/sms', admin, {});
  ok(r.status === 403, 'removing a method needs the password', String(r.status));
  r = await call('DELETE', '/api/auth/mfa/sms', admin, { password: PW });
  ok(r.status === 200 && !r.json.methods.includes('sms'), 'SMS codes removed');

  // ===== account policy ===========================================================================
  const radio = (await login(`radio@${DOMAIN}`)).json.access;
  r = await call('PUT', '/api/users/security-policy', radio, { requireAdminMfa: true });
  ok(r.status === 403, 'a non-administrator cannot change the policy', String(r.status));
  const evLogin = (await login(`events@${DOMAIN}`)).json;   // a session from BEFORE the policy
  r = await call('PUT', '/api/users/security-policy', admin, { requireAdminMfa: true });
  ok(r.status === 200 && r.json.requireAdminMfa === true, 'administrator requires two-step sign-in for the account');
  r = await call('POST', '/api/auth/refresh', null, { refresh: evLogin.refresh });
  ok(r.status === 401 && r.json?.code === 'mfa_required', 'a session without a second step ends at its next refresh', `${r.status} ${r.json?.code}`);
  r = await login(`events@${DOMAIN}`);
  ch = r.json?.challenge;
  ok(r.json?.mfaSetupRequired === true && !r.json?.access && r.json.available.includes('totp'), 'a user without a method is asked to set one up', JSON.stringify(r.json?.available));
  r = await call('POST', '/api/auth/mfa/challenge/verify', null, { challenge: ch, method: 'backup', code: 'aaaa-aaaa' });
  ok(r.status === 401, 'a setup challenge cannot be used to skip setup', String(r.status));
  r = await call('POST', '/api/auth/mfa/totp/start', null, { challenge: ch });
  const evSecret = r.json?.secret;
  r = await call('POST', '/api/auth/mfa/totp/confirm', null, { challenge: ch, code: totpAt(evSecret, now()) });
  ok(r.status === 200 && !!r.json?.access && r.json.backupCodes?.length === 10, 'setting up during sign-in finishes the sign-in', String(r.status));
  const ev = r.json.access;
  r = await call('DELETE', '/api/auth/mfa/totp', ev, { password: PW });
  ok(r.status === 400, 'the last method cannot be removed while the account requires one', String(r.status));
  const evId = claims(ev).sub;
  r = await call('POST', `/api/users/${evId}/mfa/reset`, radio);
  ok(r.status === 403, 'a Radio Manager cannot reset another user', String(r.status));
  r = await call('POST', `/api/users/${evId}/mfa/reset`, admin);
  ok(r.status === 204, 'an administrator resets a locked-out user', String(r.status));
  r = await login(`events@${DOMAIN}`);
  ok(r.json?.mfaSetupRequired === true, 'after a reset they set it up again at next sign-in');
  r = await call('GET', '/api/users', admin);
  const evRow = (r.json ?? []).find((u: any) => u.id === evId);
  ok(evRow && evRow.mfa === false, 'the user list shows two-step status', JSON.stringify(evRow?.mfa));
  await call('PUT', '/api/users/security-policy', admin, { requireAdminMfa: false });

  // ===== public user ===================================================================================
  r = await call('POST', '/api/public/auth/login', null, { appKey: pk, email: `fan@${DOMAIN}`, password: PW });
  let fan = r.json?.access as string;
  ok(!!fan, 'public user signs in (no second step yet)');
  r = await call('POST', '/api/public/me/mfa/email/start', fan, { password: PW });
  r = await call('POST', '/api/public/me/mfa/email/confirm', fan, { code: r.json?.devCode });
  ok(r.status === 200 && r.json.methods.includes('email') && r.json.backupCodes?.length === 10, 'public user turns on email codes', String(r.status));
  r = await call('POST', '/api/public/auth/login', null, { appKey: pk, email: `fan@${DOMAIN}`, password: PW });
  ch = r.json?.challenge;
  ok(r.json?.mfaRequired === true && !r.json?.access, 'public sign-in now asks for the code');
  r = await call('POST', '/api/auth/mfa/challenge/send', null, { challenge: ch, method: 'email' });
  ok(r.status === 401, 'a public challenge is refused on the admin API', String(r.status));
  r = await call('POST', '/api/public/auth/mfa/challenge/send', null, { challenge: ch, method: 'email' });
  r = await call('POST', '/api/public/auth/mfa/challenge/verify', null, { challenge: ch, method: 'email', code: r.json?.devCode });
  fan = r.json?.access;
  ok(r.status === 200 && !!fan && r.json.viewer?.email === `fan@${DOMAIN}`, 'public user completes sign-in with the emailed code', String(r.status));
  r = await call('GET', '/api/public/me', fan);
  ok(r.status === 200, 'the session works on the public API', String(r.status));
  r = await call('POST', '/api/public/me/email/change', fan, { newEmail: `superfan@${DOMAIN}`, password: PW });
  r = await call('POST', '/api/public/me/email/change/confirm', fan, { code: r.json?.devCode });
  ok(r.status === 200 && r.json.email === `superfan@${DOMAIN}`, 'public user changes email with verification');
  const vid = claims(fan).sub;
  r = await call('GET', `/api/viewers/${vid}`, admin);
  ok(r.json?.mfa === true && r.json?.security?.methods?.includes('email'), 'admin sees the public user\'s two-step status');
  r = await call('POST', `/api/viewers/${vid}/mfa/reset`, admin);
  ok(r.status === 204, 'admin resets a public user\'s two-step sign-in');
  r = await call('POST', '/api/public/auth/login', null, { appKey: pk, email: `superfan@${DOMAIN}`, password: PW });
  ok(!!r.json?.access && !r.json?.mfaRequired, 'after the reset the public user signs in with the password only');

  // ===== channel groups ===================================================================================
  const g = (await db.query(`INSERT INTO groups(account_id, name, max_channels) VALUES ($1,$2,7) RETURNING id`, [acct, `Main ${DOMAIN}`])).rows[0].id;
  await db.query(`INSERT INTO groups(account_id, name) VALUES ($1,$2)`, [acct, `Sport ${DOMAIN}`]);
  const sv = (await login(`viewer@${DOMAIN}`)).json.access;
  r = await call('PATCH', `/api/groups/${g}`, sv, { name: 'News' });
  ok(r.status === 403, 'System Viewer cannot rename a group', String(r.status));
  r = await call('PATCH', `/api/groups/${g}`, admin, { name: `SPORT ${DOMAIN}` });
  ok(r.status === 400, 'two groups cannot share a name', String(r.status));
  r = await call('PATCH', `/api/groups/${g}`, admin, { name: `News ${DOMAIN}`, maxChannels: 999 });
  ok(r.status === 200 && r.json.name === `News ${DOMAIN}` && r.json.max_channels === 7, 'administrator renames a group; caps are not theirs to change', JSON.stringify({ s: r.status, n: r.json?.name, m: r.json?.max_channels, e: r.json?.error }));

  await db.end();
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(() => {
    for (const p of procs) { try { process.kill(-p.pid!, 'SIGTERM'); } catch { /* gone */ } }
    console.log(`\n${passes} passed, ${failures} failed`);
    setTimeout(() => process.exit(failures ? 1 : 0), 1500);
  });
