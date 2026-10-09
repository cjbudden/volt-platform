// ============================================================================
//  THE AUTHENTICATION BOUNDARY.
//
//  Every token in this system is signed with the same secret, so a valid
//  signature proves only that we minted it — never what we minted it FOR.
//  Three separate tokens turned out to open a full admin session, and one
//  unrecognised role string walked straight through the admin gate. None of
//  those were exotic: each is what you get by taking a token the product
//  hands out and putting it in the Authorization header.
//
//  This suite exists so none of them come back. It checks the boundary from
//  the OUTSIDE, over HTTP, because that is where the mistake lived: every
//  individual function was doing what it said, and the composition was wrong.
//
//    - the platform login's PRE-MFA challenge token must not be a session
//    - a playback token, which is public by construction, must not be a session
//    - a token naming an unknown role must be the LEAST privileged thing
//      around, not the most
//    - the admin gate must not be escapable by changing the case of the path
//    - the public play gate must not mint tokens for other tenants' assets
//    - the share page must not reflect its path segment into script
//
//  Usage: DATABASE_URL=... API=http://localhost:8080 npx tsx test/auth-boundary.check.ts
// ============================================================================
import jwt from 'jsonwebtoken';
import { pool, query, one } from '../src/db';
import { hashPassword } from '../src/auth/password';

const API = process.env.API || 'http://localhost:8080';
const SECRET = process.env.JWT_ACCESS_SECRET || 'devsecret';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected truthy, got [${String(v)}]`));

// Ids namespaced to this suite.
const A = '00000000-0000-0000-0000-0000b0da0001';
const A2 = '00000000-0000-0000-0000-0000b0da0002';
const U = '00000000-0000-0000-0000-0000b0daf001';
const OP = '00000000-0000-0000-0000-0000b0daf002';
const P = '00000000-0000-0000-0000-0000b0da0d01';
const G = '00000000-0000-0000-0000-0000b0da0b01';
const G2 = '00000000-0000-0000-0000-0000b0da0b02';
const C = '00000000-0000-0000-0000-0000b0da0c01';
const C2 = '00000000-0000-0000-0000-0000b0da0c02';

async function reset() {
  await query(`DELETE FROM users WHERE email IN ('boundary@x.example','boundary-op@x.example')`);
  await query(`DELETE FROM accounts WHERE id = ANY($1)`, [[A, A2]]);
}

async function seed() {
  await reset();
  const pw = await hashPassword('volt1234');
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'BoundaryCo'),($2,'RivalCo')`, [A, A2]);
  await query(
    `INSERT INTO users(id,account_id,email,password_hash,role,status,platform_role) VALUES
       ($1,$3,'boundary@x.example',$4,'owner','active','saas_admin'),
       ($2,$3,'boundary-op@x.example',$4,'operator','active',NULL)`,
    [U, OP, A, pw]
  );
  await query(
    `INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type)
     VALUES ($1,$2,'p','[]','package_only')`, [P, A]
  );
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id) VALUES ($1,$2,'g',$3),($4,$5,'g2',NULL)`,
    [G, A, P, G2, A2]);
  await query(`INSERT INTO channels(id,group_id,name,status) VALUES ($1,$2,'mine','live'),($3,$4,'theirs','live')`,
    [C, G, C2, G2]);
}

const j = (t: string) => ({ Authorization: `Bearer ${t}`, 'content-type': 'application/json' });
async function status(path: string, tok: string, init: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, { ...init, headers: { ...j(tok), ...(init.headers ?? {}) } });
  return r.status;
}

(async () => {
  await seed();

  // ---- a real session still works (the control) --------------------------
  const good = jwt.sign({ sub: U, account_id: A, role: 'owner', typ: 'access' }, SECRET, { expiresIn: 300 });
  check('a real access token reaches the API', await status('/api/channels', good), 200);
  const legacy = jwt.sign({ sub: U, account_id: A, role: 'owner' }, SECRET, { expiresIn: 300 });
  check('a token minted before typ existed still works', await status('/api/channels', legacy), 200);

  // ---- the pre-MFA challenge token ---------------------------------------
  // Issued after the PASSWORD step and before the second factor. It carries
  // the real user id, so every downstream re-read of the user's role passed.
  const login = await fetch(`${API}/api/platform/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'boundary@x.example', password: 'volt1234' }),
  });
  const lj = await login.json() as any;
  truthy('platform login returns an MFA challenge rather than a session', !!lj.mfaToken && !lj.access);
  check('the MFA challenge token is NOT a session', await status('/api/channels', lj.mfaToken), 401);
  check('and it cannot reach the platform surface either',
    await status('/api/platform/accounts', lj.mfaToken), 401);
  // The thing it IS for still works.
  const hand = jwt.sign({ sub: U, typ: 'mfa' }, SECRET, { expiresIn: 300 });
  check('a hand-made mfa-typed token is refused the same way',
    await status('/api/channels', hand), 401);

  // ---- a playback token ---------------------------------------------------
  // Handed to any member of the public by the availability gate.
  const pb = jwt.sign({ typ: 'playback', aid: A, app: null, asset: C, kind: 'channel' }, SECRET, { expiresIn: 300 });
  check('a playback token is not a session', await status('/api/channels', pb), 401);
  check('and does not reach an admin surface', await status('/api/users', pb), 401);

  // ---- an unrecognised role ----------------------------------------------
  // ROLE_RANK[role] is undefined for an unknown role, and `undefined < 3` is
  // false, so the admin gate skipped its own throw.
  const weird = jwt.sign({ sub: U, account_id: A, role: 'wizard', typ: 'access' }, SECRET, { expiresIn: 300 });
  // The subject is a real owner, so resolveAccess replaces the role from the
  // database — which is correct. The dangerous case is a subject that is NOT a
  // user, where the token's own role stands.
  const ghost = jwt.sign(
    { sub: '00000000-0000-0000-0000-00000000dead', account_id: A, role: 'wizard', typ: 'access' },
    SECRET, { expiresIn: 300 }
  );
  check('an unknown role does not open the admin surface', await status('/api/users', ghost), 403);
  check('nor an admin write', await status('/api/apps', ghost, {
    method: 'POST', body: JSON.stringify({ name: 'x', type: 'web' }),
  }), 403);
  check('nor an unmapped write', await status('/api/notifications', ghost, {
    method: 'POST', body: JSON.stringify({ topic: 't', recipients: ['a@b'], channels: ['in_app'] }),
  }), 403);
  void weird;

  // ---- case of the path ---------------------------------------------------
  // Express routes case-insensitively; startsWith does not.
  const op = jwt.sign({ sub: OP, account_id: A, role: 'operator', typ: 'access' }, SECRET, { expiresIn: 300 });
  check('an operator cannot mint an account key', await status('/api/apps/secret-keys', op, { method: 'POST' }), 403);
  check('and cannot mint one by shouting the path',
    await status('/API/apps/secret-keys', op, { method: 'POST' }), 403);
  check('and cannot read the key list that way either',
    await status('/API/apps/keys', op), 403);

  // ---- the public play gate ----------------------------------------------
  const app = await fetch(`${API}/api/apps`, {
    method: 'POST', headers: j(good),
    body: JSON.stringify({ name: 'W', type: 'web', restrictions: {} }),
  }).then(r => r.json()) as any;
  const pk = app?.publishableKey?.key;
  truthy('a publishable key was issued for the test app', !!pk);

  const avail = async (assetId: string) => {
    const r = await fetch(`${API}/api/availability`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appKey: pk, assetId }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) as any };
  };
  const mine = await avail(C);
  check('the gate mints a token for my own channel', mine.status, 200);
  check('and the token names what the asset IS', mine.body?.available, true);
  const theirs = await avail(C2);
  check("the gate refuses another tenant's channel", theirs.status, 404);
  const nonsense = await avail('not-a-uuid');
  check('and a malformed id gets the same answer, not a 500', nonsense.status, 404);
  const missing = await avail('00000000-0000-0000-0000-0000000000ff');
  check('an unknown uuid is indistinguishable from someone else’s', missing.status, 404);

  // The kind must be in the token: without it the beacon guessed, and guessed
  // wrong for every channel that ever existed.
  const claims: any = jwt.decode(mine.body.playbackToken);
  check('the playback token carries the asset kind', claims?.kind, 'channel');

  // ---- the share page -----------------------------------------------------
  const xss = '%3C%2Fscript%3E%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E';
  const page = await fetch(`${API}/share/${xss}`);
  const html = await page.text();
  check('a script-breaking token is refused outright', page.status, 404);
  truthy('and nothing it contained is reflected as markup',
    !html.includes('</script><img') && !html.includes('onerror=alert'));

  await reset();
  console.log(`\nauth-boundary: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
