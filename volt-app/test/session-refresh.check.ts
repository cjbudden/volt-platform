// ============================================================================
//  A SESSION THAT LASTS AS LONG AS THE WORK, AND NOT ONE MINUTE LONGER.
//
//  The control plane already issued a refresh token, stored its hash, and
//  exposed /auth/refresh to exchange it. The console never called any of it:
//  the sign-in screen read `access` and dropped `refresh`, and the only 401
//  handling was a bounce to the login form. So every session was capped at
//  ACCESS_TTL of WALL CLOCK -- fifteen minutes, whatever the operator was doing.
//
//  Wiring the console up is most of the fix and cannot be asserted from here.
//  What CAN be asserted is the half that had to be true first, because a
//  long-lived session is only safe if the endpoint that extends it is:
//
//  A DISABLED USER MUST ACTUALLY BE SIGNED OUT. The old query joined `users` to
//  read account_id and role and never looked at `u.status`, so a disabled
//  account went on minting access tokens for the full fourteen days. The Users
//  page says, in as many words, "Disabling signs the user out (at the next
//  token refresh)". That made this the worse kind of bug: an interface making a
//  claim the code did not implement, which is indistinguishable from working
//  until the day it matters. Same for a suspended account.
//
//  ROTATION MUST NOT EXTEND THE ABSOLUTE CAP. Rotating on use is what makes a
//  stolen refresh token short-lived, and the obvious implementation -- issue the
//  replacement with a fresh fourteen days -- quietly converts an absolute cap
//  into a sliding one that never expires. The replacement inherits the original
//  row's expires_at, so continuous work still ends fourteen days after login.
//
//  THE OLD TOKEN MUST STOP WORKING. A rotation that leaves the previous token
//  live is not rotation, it is issuance, and replay is exactly what it was
//  meant to stop.
//
//  Usage: DATABASE_URL=... API=http://localhost:8080 npx tsx test/session-refresh.check.ts
// ============================================================================
import { pool, query, one } from '../src/db';

const API = process.env.API || 'http://localhost:8080';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);

const A = '00000000-0000-0000-0000-00005e55104a';
const EMAIL = 'session-check@volt.test';
const PW = 'correct horse battery staple';

const J = { 'content-type': 'application/json' };
const post = (p: string, body: any) =>
  fetch(`${API}/api${p}`, { method: 'POST', headers: J, body: JSON.stringify(body) });

const login = async () => {
  const r = await post('/auth/login', { email: EMAIL, password: PW });
  return { status: r.status, body: r.ok ? await r.json() : null };
};
const refresh = async (t: string) => {
  const r = await post('/auth/refresh', { refresh: t });
  return { status: r.status, body: r.ok ? await r.json() : null };
};
/** Does this access token actually open a session? */
const usable = async (access: string) =>
  (await fetch(`${API}/api/auth/me`, { headers: { authorization: 'Bearer ' + access } })).status;

(async () => {
  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
  await query(`INSERT INTO accounts(id,name,status) VALUES ($1,'SessionCo','active')`, [A]);
  // Registering through the API is what gets a correctly hashed password.
  const reg = await post('/auth/register', { accountName: 'SessionCo2', email: EMAIL, password: PW });
  if (reg.status !== 201) { console.log(`FATAL could not register test user (${reg.status})`); process.exit(1); }
  const u = await one<any>(`SELECT id, account_id FROM users WHERE email=$1`, [EMAIL]);

  // ---- the happy path -----------------------------------------------------
  console.log('== a login hands back everything a long session needs ==');
  const l = await login();
  check('login succeeds', l.status, 200);
  check('an access token is issued', typeof l.body?.access === 'string' && l.body.access.length > 20, true);
  // THE FIELD THE CONSOLE USED TO THROW AWAY.
  check('and a refresh token with it', typeof l.body?.refresh === 'string' && l.body.refresh.length > 20, true);
  check('with the ttl the server is actually using, not a literal',
    l.body?.expiresIn, Number(process.env.ACCESS_TTL ?? 900));
  check('the access token opens a session', await usable(l.body.access), 200);

  console.log('\n== refreshing extends the session and rotates the credential ==');
  const r1 = await refresh(l.body.refresh);
  check('the exchange succeeds', r1.status, 200);
  check('a new access token comes back', typeof r1.body?.access === 'string', true);
  check('and it works', await usable(r1.body.access), 200);
  // ROTATION. Without this the console keeps presenting the same refresh token
  // for fourteen days and a copy of it is as good as the original.
  check('a REPLACEMENT refresh token comes back', typeof r1.body?.refresh === 'string', true);
  check('and it is not the one we sent', r1.body.refresh !== l.body.refresh, true);

  console.log('\n== and the old refresh token stops working ==');
  const replay = await refresh(l.body.refresh);
  check('replaying the spent token is refused', replay.status, 401);
  const r2 = await refresh(r1.body.refresh);
  check('while the replacement still works', r2.status, 200);

  console.log('\n== rotation does NOT push the absolute cap outwards ==');
  // Every live row for this user must still expire when the ORIGINAL did.
  // Reissuing fourteen days per rotation would turn the cap into a session that
  // can never end, which is the failure this case exists to catch.
  const spans = await query<any>(
    `SELECT DISTINCT date_trunc('minute', expires_at) AS e
       FROM refresh_tokens WHERE user_id = $1`, [u.id]);
  check('every token in the chain shares one expiry', spans.length, 1);
  const far = await one<any>(
    `SELECT (max(expires_at) > now() + interval '14 days') AS beyond
       FROM refresh_tokens WHERE user_id = $1`, [u.id]);
  check('and none of them reaches past the original fourteen days', far?.beyond, false);

  // ---- the standing of the user holding the session -----------------------
  console.log('\n== disabling a user really does end their session ==');
  const live = await refresh(r2.body.refresh);
  check('the session is healthy first', live.status, 200);
  await query(`UPDATE users SET status='disabled' WHERE id=$1`, [u.id]);
  const afterDisable = await refresh(live.body.refresh);
  // THE CLAIM THE USERS PAGE ALREADY MAKES. It was not true before this.
  check('a disabled user cannot refresh', afterDisable.status, 401);
  check('and cannot log in either', (await login()).status, 401);

  console.log('\n== a suspended account is refused the same way ==');
  await query(`UPDATE users SET status='active' WHERE id=$1`, [u.id]);
  const back = await login();
  check('re-enabling restores sign-in', back.status, 200);
  await query(`UPDATE accounts SET status='suspended' WHERE id=$1`, [u.account_id]);
  check('but a suspended account cannot refresh', (await refresh(back.body.refresh)).status, 401);
  await query(`UPDATE accounts SET status='active' WHERE id=$1`, [u.account_id]);

  // ---- signing out ---------------------------------------------------------
  console.log('\n== signing out revokes the refresh token, not just the tab ==');
  const s = await login();
  const outRes = await fetch(`${API}/api/auth/logout`, {
    method: 'POST',
    headers: { ...J, authorization: 'Bearer ' + s.body.access },
    body: JSON.stringify({ refresh: s.body.refresh }),
  });
  check('logout succeeds', outRes.status, 204);
  check('and the refresh token is dead afterwards', (await refresh(s.body.refresh)).status, 401);

  console.log('\n== nonsense is refused rather than accepted ==');
  check('an unknown refresh token is 401', (await refresh('not-a-real-token')).status, 401);
  check('an access token is not a refresh token', (await refresh(s.body.access)).status, 401);

  await query(`DELETE FROM users WHERE email=$1`, [EMAIL]);
  await query(`DELETE FROM accounts WHERE id=$1 OR name='SessionCo2'`, [A]);
  console.log(`\nsession-refresh: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('FATAL', e);
  await pool.end().catch(() => {});
  process.exit(1);
});
