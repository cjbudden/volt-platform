/**
 * ONE FAST TEST USER IN AN EXISTING ACCOUNT, nothing else touched.
 *
 *   npm run seed:fast-user
 *       fast@rtm.example / volt1234 in the account of admin@rtm.example (the local demo)
 *   SEED_ACCOUNT_ID=<uuid> SEED_EMAIL=fast@example.com SEED_PASSWORD='...' npm run seed:fast-user
 *
 * The user is an operator with the system role "FAST Manager" (auth/defaultRoles.ts):
 * FAST channels, the Media Library, Image Library, Loops & Fillers, uploads and the
 * encode queue, ladders, share links and reports. Re-running resets the password and
 * the role. Refuses with NODE_ENV=production (a shared, printed password).
 */
import { pool, one, query } from '../src/db';
import { migrate } from '../src/services/migrate';
import { hashPassword } from '../src/auth/password';
import { ensureDefaultRoles } from '../src/auth/defaultRoles';

async function main() {
  if (process.env.NODE_ENV === 'production' && !process.env.SEED_FORCE) {
    throw new Error('Refusing to seed a shared test password with NODE_ENV=production (set SEED_FORCE=1 if you really mean it).');
  }
  await migrate();
  const email = (process.env.SEED_EMAIL || 'fast@rtm.example').toLowerCase();
  const password = process.env.SEED_PASSWORD || 'volt1234';
  const accountId = process.env.SEED_ACCOUNT_ID
    || (await one<any>(`SELECT account_id FROM users WHERE lower(email) = 'admin@rtm.example'`))?.account_id
    || (await one<any>(`SELECT id FROM accounts WHERE name = 'RTM'`))?.id;
  if (!accountId) throw new Error('No account found: set SEED_ACCOUNT_ID, or run the demo seed first.');
  await ensureDefaultRoles(accountId);
  const role = await one<any>(`SELECT id, name FROM user_groups WHERE account_id = $1 AND role_key = 'fast_manager'`, [accountId]);
  if (!role) throw new Error('The FAST Manager role was not created.');
  const u = await one<any>(
    `INSERT INTO users(account_id, email, password_hash, role, status, display_name)
     VALUES ($1,$2,$3,'operator','active','Fay FAST')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'operator', status = 'active'
     RETURNING id, account_id`, [accountId, email, await hashPassword(password)]);
  if (u.account_id !== accountId) throw new Error(`${email} already exists in another account; choose another SEED_EMAIL.`);
  await query(`DELETE FROM user_group_members WHERE user_id = $1`, [u.id]);
  await query(`INSERT INTO user_group_members(user_id, group_id) VALUES ($1,$2)`, [u.id, role.id]);
  await query(`UPDATE users SET user_group_id = $2 WHERE id = $1`, [u.id, role.id]);
  console.log(`\nFAST test user ready in account ${accountId}:\n  ${email} / ${password}   (role: ${role.name}, tier: operator)\n`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
