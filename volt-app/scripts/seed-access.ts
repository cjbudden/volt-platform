/**
 * TEST USERS FOR THE ACCESS MODEL.
 *
 *   npm run seed:access                       # account "Volt Access Demo"
 *   SEED_ACCOUNT_ID=<uuid> npm run seed:access   # add the users to an existing account
 *   SEED_PASSWORD='...' SEED_DOMAIN=example.com npm run seed:access
 *
 * Creates (or updates, idempotently):
 *   admin@<domain>       owner, Administrator         full access
 *   analytics@<domain>   Report and Analytics Manager
 *   events@<domain>      Event Manager
 *   radio@<domain>       Radio Manager
 *   fast@<domain>        FAST Manager
 *   viewer@<domain>      System Viewer                read-only admin
 *   fan@<domain>         PUBLIC user (viewer account, not an admin user)
 * plus a web app "Access demo player" and its publishable key, printed once,
 * which the public user signs in through.
 *
 * NEVER run against production: the password is shared and printed.
 */
import { randomBytes, createHash } from 'node:crypto';
import { pool, one, query } from '../src/db';
import { migrate } from '../src/services/migrate';
import { hashPassword } from '../src/auth/password';
import { hashViewerPassword } from '../src/auth/viewerTokens';
import { ensureDefaultRoles } from '../src/auth/defaultRoles';

const PASSWORD = process.env.SEED_PASSWORD || 'VoltTest!2026';
const DOMAIN = process.env.SEED_DOMAIN || 'volt.test';

const STAFF: { local: string; name: string; roleKey: string; tier: string }[] = [
  { local: 'admin', name: 'Ada Administrator', roleKey: 'administrator', tier: 'owner' },
  { local: 'analytics', name: 'Ari Analytics', roleKey: 'analytics_manager', tier: 'operator' },
  { local: 'events', name: 'Eve Events', roleKey: 'event_manager', tier: 'operator' },
  { local: 'radio', name: 'Rae Radio', roleKey: 'radio_manager', tier: 'operator' },
  { local: 'fast', name: 'Fay FAST', roleKey: 'fast_manager', tier: 'operator' },
  { local: 'viewer', name: 'Vic Viewer', roleKey: 'system_viewer', tier: 'viewer' },
];

async function main() {
  if (process.env.NODE_ENV === 'production' && !process.env.SEED_FORCE) {
    throw new Error('Refusing to seed shared test passwords with NODE_ENV=production (set SEED_FORCE=1 if you really mean it).');
  }
  await migrate();
  let accountId = process.env.SEED_ACCOUNT_ID || null;
  if (!accountId) {
    const a = await one<any>(`SELECT id FROM accounts WHERE name = 'Volt Access Demo'`);
    accountId = a?.id ?? (await one<any>(`INSERT INTO accounts(name) VALUES ('Volt Access Demo') RETURNING id`))!.id;
  }
  await ensureDefaultRoles(accountId!);
  const roles = await query<any>(`SELECT id, role_key, name FROM user_groups WHERE account_id=$1 AND role_key IS NOT NULL`, [accountId]);
  const roleId = (k: string) => roles.find((r) => r.role_key === k)?.id;

  const hash = await hashPassword(PASSWORD);
  const out: string[][] = [];
  for (const s of STAFF) {
    const email = `${s.local}@${DOMAIN}`;
    const u = await one<any>(
      `INSERT INTO users(account_id, email, password_hash, role, status, display_name)
       VALUES ($1,$2,$3,$4::user_role,'active',$5)
       ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, role=EXCLUDED.role,
              status='active', display_name=EXCLUDED.display_name
       RETURNING id, account_id`,
      [accountId, email, hash, s.tier, s.name]);
    if (u.account_id !== accountId) { out.push([email, 'SKIPPED: exists in another account', '']); continue; }
    await query(`DELETE FROM user_group_members WHERE user_id=$1`, [u.id]);
    await query(`INSERT INTO user_group_members(user_id, group_id) VALUES ($1,$2)`, [u.id, roleId(s.roleKey)]);
    await query(`UPDATE users SET user_group_id=$2 WHERE id=$1`, [u.id, roleId(s.roleKey)]);
    out.push([email, roles.find((r) => r.role_key === s.roleKey)?.name ?? s.roleKey, s.tier]);
  }

  // Optional: a platform staff user (System Admin). SEED_PLATFORM_STAFF=1.
  // Their first platform sign-in enrols an authenticator app.
  if (process.env.SEED_PLATFORM_STAFF === '1') {
    const email = `staff@${DOMAIN}`;
    await query(
      `INSERT INTO users(account_id, email, password_hash, role, status, display_name, platform_role, mfa_secret_ref, mfa_enabled)
       VALUES ($1,$2,$3,'owner','active','Sam Staff','saas_admin',NULL,false)
       ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, platform_role='saas_admin', status='active',
              mfa_secret_ref=NULL, mfa_enabled=false`,
      [accountId, email, hash]);
    out.push([email, 'Platform staff (saas_admin)', 'owner']);
  }

  // The public side: an app to sign in through, and one hosted viewer.
  let app = await one<any>(`SELECT id FROM apps WHERE account_id=$1 AND name='Access demo player'`, [accountId]);
  if (!app) app = await one<any>(`INSERT INTO apps(account_id, name, type) VALUES ($1,'Access demo player','web') RETURNING id`, [accountId]);
  const raw = `pk_test_${randomBytes(24).toString('base64url')}`;
  await query(
    `INSERT INTO api_keys(account_id, app_id, kind, key_prefix, key_hash, scopes) VALUES ($1,$2,'publishable',$3,$4,'{playback}')`,
    [accountId, app.id, raw.slice(0, 14), createHash('sha256').update(raw).digest('hex')]);
  const fan = `fan@${DOMAIN}`;
  const vh = await hashViewerPassword(PASSWORD);
  const existing = await one<any>(`SELECT id FROM viewers WHERE account_id=$1 AND lower(email)=$2 AND source='hosted' AND status<>'deleted'`, [accountId, fan]);
  if (existing) {
    await query(`UPDATE viewers SET password_hash=$2, status='active', password_changed_at=now() WHERE id=$1`, [existing.id, vh]);
  } else {
    await query(
      `WITH n AS (SELECT gen_random_uuid() AS id)
       INSERT INTO viewers(id, account_id, external_id, email, password_hash, display_name, source, status, password_changed_at)
       SELECT n.id, $1, 'local:' || n.id, $2, $3, 'Fran Fan', 'hosted', 'active', now() FROM n`,
      [accountId, fan, vh]);
  }
  out.push([fan, 'Public user (viewer account)', '-']);

  console.log(`\nAccount ${accountId}\nPassword for every user below: ${PASSWORD}\n`);
  console.log(['email'.padEnd(28), 'role'.padEnd(34), 'tier'].join(''));
  for (const r of out) console.log(r[0].padEnd(28) + r[1].padEnd(34) + r[2]);
  console.log(`\nPublishable key for the public user (app "Access demo player"), shown once:\n  ${raw}`);
  console.log(`\nSign the public user in:\n  curl -s -X POST <base>/api/public/auth/login -H 'content-type: application/json' \\\n    -d '{"appKey":"${raw}","email":"${fan}","password":"${PASSWORD}"}'\n`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
