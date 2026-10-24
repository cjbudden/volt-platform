/**
 * Demo account for the customer guides' screenshots (build queue 1.14-G0).
 *
 * The everyday demo seed (seed-demo.ts) is named after a real prospect, and a
 * screenshot carries whatever the page shows: the docs site's banned-term
 * check reads text, not pictures. So this runs that seed and then gives the
 * account, its people and its streams neutral names, plus a little history
 * (audit rows) so pages that list past actions are not empty in a guide.
 * The screenshot script (docs-site/scripts/screenshots.mjs) still checks every
 * page's visible text against scrub.json before it saves a picture, as a net
 * for anything a future seed or page adds.
 *
 *   DATABASE_URL=... npx tsx scripts/seed-docs.ts
 * Sign-in afterwards: admin@example.com / volt1234
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { query, pool } from '../src/db';
import { writeAudit } from '../src/services/audit';

const ACCOUNT = '3de20755-af2b-46d0-8d24-f39afbf4b3a0';
const ADMIN = '8342a24d-751f-46ca-9636-f72a8a1110ef';
const NEWS = 'ae0e5ac4-9833-48b7-ab97-91df0d27467c';
const SPORT = '32cfef30-0d1d-44df-b2b8-0ed5a06bdf80';
export const DOCS_LOGIN = { email: 'admin@example.com', password: 'volt1234' };

async function main() {
  const r = spawnSync(join(__dirname, '../node_modules/.bin/tsx'), [join(__dirname, 'seed-demo.ts')], {
    cwd: join(__dirname, '..'), stdio: 'inherit', env: process.env,
  });
  if (r.status !== 0) throw new Error('seed-demo.ts failed');

  await query(`UPDATE accounts SET name='Example Broadcaster' WHERE id=$1`, [ACCOUNT]);
  await query(`UPDATE users SET email=$2 WHERE id=$1`, [ADMIN, DOCS_LOGIN.email]);
  await query(`UPDATE groups SET name='Main' WHERE account_id=$1 AND name='RTM Main'`, [ACCOUNT]);
  await query(`UPDATE channels SET name='News 24' WHERE id=$1`, [NEWS]);
  await query(`UPDATE channels SET name='Sport One' WHERE id=$1`, [SPORT]);

  // A short, believable history for the audit log. Re-running the seed
  // replaces it rather than piling up copies.
  await query(`DELETE FROM audit_log WHERE account_id=$1 AND detail->>'seed'='docs'`, [ACCOUNT]);
  const label = 'admin@example.com';
  // The snapshot carries the name, so the log says which channel, not an id.
  const rows: Array<[string, 'create' | 'update' | 'delete', string, string, string, Record<string, { from: any; to: any }> | undefined]> = [
    ['5 hours', 'create', 'channel', SPORT, 'Sport One', undefined],
    ['3 hours', 'update', 'channel', NEWS, 'News 24', { name: { from: 'News', to: 'News 24' } }],
    ['2 hours', 'update', 'channel', NEWS, 'News 24', { failover_enabled: { from: false, to: true } }],
    ['40 minutes', 'update', 'channel', SPORT, 'Sport One', { name: { from: 'Sport', to: 'Sport One' } }],
  ];
  for (const [ago, action, type, id, name, changes] of rows) {
    await writeAudit(null, { accountId: ACCOUNT, userId: ADMIN, label, action, entityType: type, entityId: id, changes, snapshot: { name } });
    await query(
      `UPDATE audit_log SET created_at = now() - $2::interval, detail = detail || '{"seed":"docs"}'::jsonb
        WHERE id = (SELECT id FROM audit_log WHERE account_id=$1 ORDER BY created_at DESC LIMIT 1)`,
      [ACCOUNT, ago],
    );
  }

  console.log(`\ndocs demo ready. Sign in as ${DOCS_LOGIN.email} (password as in seed-demo.ts)`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
