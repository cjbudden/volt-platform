/**
 * ACCESS CHECK: proves the rules in ACCESS_CONTROL.md against running
 * processes (ROLE=all on :18100, ROLE=api-public on :18101).
 *
 *   DATABASE_URL=postgres://… npx tsx test/access/access-check.ts      (npm run test:access)
 *
 * Seeds a fresh set of the default test users under a unique domain, then
 * checks, among others: each default role sees and does exactly what it should
 * (radio vs TV, view vs operate vs manage), escalation is refused, access
 * changes apply on the next request, admin / platform / viewer tokens never
 * cross, the public tier serves only the public API, and viewer sessions are
 * revoked at once. Exits non-zero on the first failure count > 0.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { totpAt } from '../../src/services/totp';

const DB = process.env.DATABASE_URL ?? 'postgres://volt:volt@localhost:5432/volt';
const ROOT = join(__dirname, '..', '..');
const ADMIN = 'http://localhost:18100';
const PUBLIC = 'http://localhost:18101';
const PW = 'VoltTest!2026';
const DOMAIN = `acl-${randomBytes(3).toString('hex')}.test`;
const procs: ChildProcess[] = [];
let failures = 0;
let passes = 0;

function ok(cond: boolean, what: string, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`);
  if (cond) passes++; else failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function start(role: string, port: number) {
  const p = spawn(join(ROOT, 'node_modules/.bin/tsx'), ['src/index.ts'], {
    cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: DB, PORT: String(port), ROLE: role, ORCH_LAUNCHER: 'mock', PREWARM_ENABLED: 'false', NODE_ENV: 'development' },
  });
  p.stdout!.on('data', (d) => { if (process.env.VERBOSE) process.stdout.write(`[${role}] ${d}`); });
  p.stderr!.on('data', (d) => { if (process.env.VERBOSE) process.stderr.write(`[${role}] ${d}`); });
  procs.push(p);
}
async function ready(base: string) {
  for (let i = 0; i < 180; i++) {
    try { if ((await fetch(`${base}/health/ready`)).ok) return; } catch { /* starting */ }
    await sleep(500);
  }
  throw new Error(`${base} never became ready`);
}

async function call(base: string, method: string, path: string, token?: string | null, body?: any, extra: Record<string, string> = {}) {
  const r = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, json, headers: r.headers };
}
const login = async (email: string) => (await call(ADMIN, 'POST', '/api/auth/login', null, { email, password: PW })).json?.access as string;

async function main() {
  start('all', 18100);
  await ready(ADMIN);

  const seed = spawnSync(join(ROOT, 'node_modules/.bin/tsx'), ['scripts/seed-access.ts'], {
    cwd: ROOT, env: { ...process.env, DATABASE_URL: DB, SEED_DOMAIN: DOMAIN, SEED_PASSWORD: PW }, encoding: 'utf8' });
  const acct = /Account ([0-9a-f-]{36})/.exec(seed.stdout)?.[1];
  const pk = /(pk_test_[A-Za-z0-9_-]+)/.exec(seed.stdout)?.[1];
  ok(!!acct && !!pk, 'test users seeded', acct ?? seed.stderr.slice(0, 200));
  if (!acct || !pk) return;

  const db = new Client({ connectionString: DB });
  await db.connect();
  const grp = (await db.query(`INSERT INTO groups(account_id, name) VALUES ($1,$2) RETURNING id`, [acct, `acl-test ${DOMAIN}`])).rows[0].id;
  const tv = (await db.query(`INSERT INTO channels(group_id, name, kind) VALUES ($1,'ACL TV','tv') RETURNING id`, [grp])).rows[0].id;
  const fm = (await db.query(`INSERT INTO channels(group_id, name, kind) VALUES ($1,'ACL FM','radio') RETURNING id`, [grp])).rows[0].id;

  const T: Record<string, string> = {};
  for (const u of ['admin', 'analytics', 'events', 'radio', 'viewer']) T[u] = await login(`${u}@${DOMAIN}`);
  ok(Object.values(T).every(Boolean), 'all five admin users can sign in');

  // ---- /me reflects the role ------------------------------------------------------
  const me = (await call(ADMIN, 'GET', '/api/auth/me', T.radio)).json;
  ok(me?.permissions?.radio === 'manage' && me?.permissions?.channels === 'none' && me?.roles?.[0]?.name === 'Radio Manager',
    'Radio Manager /me: radio manage, TV none', JSON.stringify({ radio: me?.permissions?.radio, channels: me?.permissions?.channels }));

  // ---- Radio Manager: stations yes, TV no ------------------------------------------
  let r = await call(ADMIN, 'GET', '/api/radio', T.radio);
  ok(r.status === 200, 'Radio Manager lists stations', String(r.status));
  r = await call(ADMIN, 'GET', `/api/channels/${fm}`, T.radio);
  ok(r.status !== 403, 'Radio Manager opens a station through /api/channels/:id', String(r.status));
  r = await call(ADMIN, 'GET', `/api/channels/${tv}`, T.radio);
  ok(r.status === 403 && r.json?.feature === 'channels', 'Radio Manager cannot open a TV channel', `${r.status} ${r.json?.feature}`);
  r = await call(ADMIN, 'POST', '/api/channels', T.radio, { kind: 'tv', name: 'nope', groupId: grp });
  ok(r.status === 403, 'Radio Manager cannot create a TV channel', String(r.status));
  r = await call(ADMIN, 'POST', '/api/channels', T.radio, { kind: 'radio', name: 'ACL FM 2', groupId: grp });
  ok(r.status !== 403, 'Radio Manager may create a station (POST /api/channels kind=radio)', String(r.status));
  r = await call(ADMIN, 'POST', `/api/radio/${fm}/start`, T.radio);
  ok(r.status !== 403, 'Radio Manager may start a station', String(r.status));
  r = await call(ADMIN, 'GET', '/api/events', T.radio);
  ok(r.status === 403, 'Radio Manager cannot see events', String(r.status));
  r = await call(ADMIN, 'GET', '/api/users', T.radio);
  ok(r.status === 403, 'Radio Manager cannot see admin users', String(r.status));
  r = await call(ADMIN, 'GET', `/api/search?q=ACL`, T.radio);
  ok(r.status === 200 && r.json.results.every((x: any) => x.kind === 'radio'), 'search only finds what the role may see',
    JSON.stringify(r.json?.results?.map((x: any) => x.kind)));

  // ---- System Viewer: sees, cannot operate or change --------------------------------
  r = await call(ADMIN, 'GET', `/api/radio/${fm}`, T.viewer);
  ok(r.status !== 403, 'System Viewer opens a station', String(r.status));
  r = await call(ADMIN, 'POST', `/api/radio/${fm}/start`, T.viewer);
  ok(r.status === 403 && r.json?.level === 'operate', 'System Viewer cannot start a station (operate)', `${r.status} ${r.json?.level}`);
  r = await call(ADMIN, 'PATCH', `/api/channels/${fm}`, T.viewer, { name: 'x' });
  ok(r.status === 403 && r.json?.level === 'manage', 'System Viewer cannot edit a station (manage)', `${r.status} ${r.json?.level}`);
  r = await call(ADMIN, 'GET', '/api/users', T.viewer);
  ok(r.status === 200, 'System Viewer can read the user list', String(r.status));
  r = await call(ADMIN, 'POST', '/api/users', T.viewer, { email: `x@${DOMAIN}`, password: PW });
  ok(r.status === 403, 'System Viewer cannot create users', String(r.status));

  // ---- Event Manager / Analytics ----------------------------------------------------
  r = await call(ADMIN, 'POST', `/api/radio/${fm}/start`, T.events);
  ok(r.status === 403, 'Event Manager cannot run radio', String(r.status));
  r = await call(ADMIN, 'GET', '/api/events', T.events);
  ok(r.status === 200, 'Event Manager lists events', String(r.status));
  r = await call(ADMIN, 'GET', '/api/analytics/realtime', T.analytics);
  ok(r.status !== 403, 'Analytics Manager reads analytics', String(r.status));
  r = await call(ADMIN, 'PATCH', `/api/channels/${tv}`, T.analytics, { name: 'x' });
  ok(r.status === 403, 'Analytics Manager cannot change channels', String(r.status));

  // ---- No escalation -----------------------------------------------------------------
  const roles = (await call(ADMIN, 'GET', '/api/access-roles', T.admin)).json as any[];
  const roleId = (k: string) => roles.find((x) => x.key === k)?.id;
  r = await call(ADMIN, 'PATCH', `/api/access-roles/${roleId('administrator')}`, T.admin, { description: 'x' });
  ok(r.status === 403, 'system roles are read-only', String(r.status));
  r = await call(ADMIN, 'POST', '/api/access-roles', T.admin, { name: `User desk ${DOMAIN}`, permissions: { users: 'manage', access: 'view', radio: 'view' } });
  ok(r.status === 201, 'Administrator creates a custom role', String(r.status));
  const desk = r.json?.id;
  r = await call(ADMIN, 'POST', '/api/users', T.admin, { email: `desk@${DOMAIN}`, password: PW, roleIds: [desk] });
  ok(r.status === 201 && r.json?.tier === 'operator', 'Administrator creates a delegate user', `${r.status} ${r.json?.tier}`);
  const deskTok = await login(`desk@${DOMAIN}`);
  r = await call(ADMIN, 'POST', '/api/users', deskTok, { email: `boss@${DOMAIN}`, password: PW, roleIds: [roleId('administrator')] });
  ok(r.status === 403 && r.json?.code === 'escalation' || r.json?.error?.includes('tier'), 'delegate cannot create an Administrator', `${r.status} ${r.json?.code ?? r.json?.error}`);
  r = await call(ADMIN, 'POST', '/api/users', deskTok, { email: `rm@${DOMAIN}`, password: PW, roleIds: [roleId('radio_manager')] });
  ok(r.status === 403 && r.json?.code === 'escalation', 'delegate cannot grant Radio Manager (radio:manage > their view)', `${r.status} ${r.json?.code}`);
  r = await call(ADMIN, 'POST', '/api/access-roles', deskTok, { name: `Sneaky ${DOMAIN}`, permissions: { radio: 'manage' } });
  ok(r.status === 403, 'delegate cannot create a role above their own access', String(r.status));
  r = await call(ADMIN, 'POST', '/api/users', deskTok, { email: `ro@${DOMAIN}`, password: PW, roleIds: [desk] });
  ok(r.status === 201, 'delegate can create a user with access they hold', String(r.status));
  const adminId = (await call(ADMIN, 'GET', '/api/auth/me', T.admin)).json.id;
  r = await call(ADMIN, 'PATCH', `/api/users/${adminId}`, deskTok, { status: 'disabled' });
  ok(r.status === 403, 'delegate cannot disable the owner', String(r.status));
  const deskId = (await call(ADMIN, 'GET', '/api/auth/me', deskTok)).json.id;
  r = await call(ADMIN, 'PATCH', `/api/users/${deskId}`, deskTok, { roleIds: [roleId('administrator')] });
  ok(r.status === 403, 'nobody changes their own access', String(r.status));

  // ---- Changes apply on the next request ---------------------------------------------
  r = await call(ADMIN, 'GET', '/api/radio', deskTok);
  ok(r.status === 200, 'delegate sees radio before the role change', String(r.status));
  await call(ADMIN, 'PATCH', `/api/access-roles/${desk}`, T.admin, { permissions: { users: 'manage', access: 'view', radio: 'none' } });
  await sleep(300);
  r = await call(ADMIN, 'GET', '/api/radio', deskTok);
  ok(r.status === 403, 'role change applies within 300 ms (no re-login)', String(r.status));
  await call(ADMIN, 'PATCH', `/api/users/${deskId}`, T.admin, { status: 'disabled' });
  await sleep(300);
  r = await call(ADMIN, 'GET', '/api/auth/me', deskTok);
  ok(r.status === 401, 'a disabled user\'s unexpired token stops working at once', String(r.status));

  // ---- Platform needs the second factor ----------------------------------------------
  await db.query(`UPDATE users SET platform_role='saas_admin', mfa_secret_ref=NULL WHERE id=$1`, [adminId]);
  await sleep(300);
  r = await call(ADMIN, 'GET', '/api/platform/accounts', T.admin);
  ok(r.status === 403 && r.json?.code === 'platform_mfa_required', 'admin session refused on /api/platform', `${r.status} ${r.json?.code}`);
  const enrol = (await call(ADMIN, 'POST', '/api/platform/auth/step-up', T.admin, {})).json;
  const code = totpAt(enrol.secret, Math.floor(Date.now() / 1000));
  const plat = (await call(ADMIN, 'POST', '/api/platform/auth/step-up', T.admin, { code })).json?.accessToken;
  r = await call(ADMIN, 'GET', '/api/platform/accounts', plat);
  ok(r.status === 200, 'platform session after the authenticator code', String(r.status));

  // ---- Public users (viewers) ----------------------------------------------------------
  start('api-public', 18101);
  await ready(PUBLIC);
  r = await call(PUBLIC, 'POST', '/api/public/auth/login', null, { appKey: pk, email: `fan@${DOMAIN}`, password: PW });
  ok(r.status === 200 && !!r.json?.access, 'public user signs in on the public tier', String(r.status));
  let fan = r.json?.access as string;
  const fanRefresh = r.json?.refresh as string;
  r = await call(PUBLIC, 'GET', '/api/public/me', fan);
  ok(r.status === 200 && r.json?.email === `fan@${DOMAIN}`, 'public user reads own profile', String(r.status));
  r = await call(PUBLIC, 'PATCH', '/api/public/me', fan, { displayName: 'Fran', profile: { lang: 'en' } });
  ok(r.status === 200 && r.json?.displayName === 'Fran', 'public user updates own profile', String(r.status));
  r = await call(ADMIN, 'GET', '/api/channels', fan);
  ok(r.status === 401, 'a public user token is refused by the admin API', String(r.status));
  r = await call(PUBLIC, 'GET', '/api/public/me', T.admin);
  ok(r.status === 401, 'an admin token is refused by the public API', String(r.status));
  r = await call(PUBLIC, 'GET', '/api/users', T.admin);
  ok(r.status === 404, 'the public tier does not serve admin paths at all', String(r.status));
  r = await call(PUBLIC, 'GET', `/api/public/availability?appKey=${encodeURIComponent(pk)}&assetId=${fm}`, fan);
  ok((r.headers.get('cache-control') ?? '').includes('no-store'), 'a signed-in play request is never edge-cached', r.headers.get('cache-control') ?? '');
  r = await call(PUBLIC, 'POST', '/api/public/auth/refresh', null, { refresh: fanRefresh });
  ok(r.status === 200 && !!r.json?.access, 'refresh rotates', String(r.status));
  const replay = await call(PUBLIC, 'POST', '/api/public/auth/refresh', null, { refresh: fanRefresh });
  ok(replay.status === 401, 'a used refresh token cannot be replayed', String(replay.status));
  fan = r.json.access;
  r = await call(PUBLIC, 'POST', '/api/public/me/password', fan, { current: PW, next: 'NewPassword!2026' });
  ok(r.status === 204, 'public user changes password', String(r.status));
  await sleep(300);
  r = await call(PUBLIC, 'GET', '/api/public/me', fan);
  ok(r.status === 401, 'password change ends existing sessions at once', String(r.status));
  r = await call(PUBLIC, 'POST', '/api/public/auth/login', null, { appKey: pk, email: `fan@${DOMAIN}`, password: 'NewPassword!2026' });
  fan = r.json?.access;
  ok(r.status === 200, 'public user signs in with the new password', String(r.status));
  const vid = (await call(PUBLIC, 'GET', '/api/public/me', fan)).json?.id;
  r = await call(ADMIN, 'GET', '/api/viewers?q=fan', T.admin);
  ok(r.status === 200 && r.json?.items?.some((x: any) => x.id === vid), 'Administrator finds the public user', String(r.status));
  r = await call(ADMIN, 'GET', '/api/viewers', T.radio);
  ok(r.status === 403, 'Radio Manager cannot see public users', String(r.status));
  await call(ADMIN, 'PATCH', `/api/viewers/${vid}`, T.admin, { status: 'disabled' });
  await sleep(300);
  r = await call(PUBLIC, 'GET', '/api/public/me', fan);
  ok(r.status === 401, 'disabling a public user ends their session at once', String(r.status));
  r = await call(PUBLIC, 'POST', '/api/public/auth/register', null, { appKey: pk, email: `new@${DOMAIN}`, password: PW });
  ok(r.status === 201 && !!r.json?.access, 'self-registration on the public API', String(r.status));
  r = await call(PUBLIC, 'POST', '/api/public/auth/register', null, { appKey: 'pk_test_bogus_key_000000', email: `x@${DOMAIN}`, password: PW });
  ok(r.status === 401, 'registration needs a valid publishable key', String(r.status));

  await db.end();
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(() => {
    for (const p of procs) { try { process.kill(-p.pid!, 'SIGTERM'); } catch { /* gone */ } }
    console.log(`\n${passes} passed, ${failures} failed`);
    setTimeout(() => process.exit(failures ? 1 : 0), 1500);
  });
