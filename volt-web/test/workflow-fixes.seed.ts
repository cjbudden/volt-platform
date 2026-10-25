// SEED FOR THE 1.14-G5a BROWSER CHECK (workflow-fixes.browser.mjs). In the
// account of EMAIL (default the demo seed's admin): an event whose AU viewers
// are replaced now, with failover on and a slate set but no loop built yet,
// and a FAST channel with a run order that is not active and no ad server.
// Prints EVENT_ID and FAST_ID.
//   DATABASE_URL=... npx tsx volt-web/test/workflow-fixes.seed.ts
import { one, query, pool } from '../../volt-app/src/db'

;(async () => {
  const email = process.env.EMAIL || 'admin@rtm.example'
  const u = await one<any>(`SELECT account_id FROM users WHERE email = $1`, [email])
  if (!u) throw new Error(`no user ${email}`)
  const g = (await one<any>(`SELECT id FROM groups WHERE account_id = $1 ORDER BY created_at LIMIT 1`, [u.account_id]))!.id
  const now = Math.floor(Date.now() / 1000)
  const ev = (await one<any>(
    `INSERT INTO events(group_id, name, status, scheduled_start, scheduled_end, input_failover_enabled, input_loss_behavior, filler_slate_ref)
     VALUES ($1,'Rights walk final','scheduled',to_timestamp($2),to_timestamp($3),true,'slate','/library/images/slate.png') RETURNING id`,
    [g, now - 600, now + 7200]))!.id
  await query(`INSERT INTO programmes(event_id, title, starts_at, ends_at, geo_mode, geo_countries, replacement_kind, replacement_ref)
               VALUES ($1,'Final AU',to_timestamp($2),to_timestamp($3),'block',ARRAY['AU'],'loop','f')`, [ev, now - 60, now + 900])
  const fast = (await one<any>(`INSERT INTO channels(group_id, name, origin) VALUES ($1,'Walk FAST','playlist') RETURNING id`, [g]))!.id
  await query(`INSERT INTO fast_lineups(channel_id, name, epoch, zone) VALUES ($1,'Main lineup',now(),'UTC')`, [fast])
  await query(`INSERT INTO channel_ads(channel_id) VALUES ($1) ON CONFLICT DO NOTHING`, [fast])
  console.log(`EVENT_ID=${ev}`)
  console.log(`FAST_ID=${fast}`)
  await pool.end()
})().catch((e) => { console.error(e); process.exit(1) })
