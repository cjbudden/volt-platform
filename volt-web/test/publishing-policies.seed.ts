// SEED FOR THE PUBLISHING POLICIES BROWSER CHECK (publishing-policies.browser.mjs,
// build queue P3-2). Run after the docs seed (volt-app/scripts/seed-docs.ts):
// in the account of admin@example.com, a "Documentary" content type with four
// of the account's titles, two of them published, and no publishing rules but
// the account default's archive copies (its locks and preset cleared), so the
// check starts from a known ladder. Prints SCHEMA_ID.
//   DATABASE_URL=... npx tsx volt-web/test/publishing-policies.seed.ts
import { one, query, pool } from '../../volt-app/src/db'

const acct = (await one<{ account_id: string }>(`SELECT account_id FROM users WHERE email = $1`, [process.env.EMAIL || 'admin@example.com']))!.account_id
const schema = (await one<{ id: string }>(
  `INSERT INTO metadata_schemas(account_id, name, description, target_kind) VALUES ($1, 'Documentary', 'Long-form factual titles', 'vod')
   ON CONFLICT (account_id, name) DO UPDATE SET description = EXCLUDED.description RETURNING id`, [acct]))!.id
const titles = await query<{ id: string }>(
  `SELECT id FROM vod_assets WHERE account_id = $1 AND archived_at IS NULL AND title IN ('Harbour Market', 'Smoke and Salt', 'The Night Bakery', 'A Quiet Valley') ORDER BY title`, [acct])
if (titles.length !== 4) throw new Error(`expected the docs seed's four titles, found ${titles.length}`)
await query(`UPDATE vod_assets SET schema_id = $2 WHERE id = ANY($1::uuid[])`, [titles.map((t) => t.id), schema])
// Two published, so a DRM change on them asks to package them again.
await query(`UPDATE vod_assets SET availability_state = 'available', published = true, available_from = now() - interval '1 day'
              WHERE id IN (SELECT id FROM vod_assets WHERE id = ANY($1::uuid[]) ORDER BY title LIMIT 2)`, [titles.map((t) => t.id)])
await query(`DELETE FROM publishing_rules WHERE account_id = $1 AND scope_kind <> 'account'`, [acct])
await query(`UPDATE publishing_rules SET settings = settings - 'protection' - 'distribution' - 'retention', locked_fields = '{}', preset_key = NULL WHERE account_id = $1`, [acct])
console.log(`SCHEMA_ID=${schema}`)
await pool.end()
