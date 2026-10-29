// SEED FOR THE 1.14-G2a BROWSER CHECK (epg-fixes.browser.mjs). In the account
// of EMAIL (default the demo seed's admin): a channel with an empty guide but
// for "Morning show" today 10:00 to 11:00 (UTC, the browser check's zone), so
// a new programme at 10:30 overlaps it, and "Old slate slot" 14:00 to 15:00
// whose replacement is an Image Library address saved before the fix. Loops &
// Fillers gets a ready loop and a ready slate. Prints CHANNEL_ID and LOOP_ID.
//   DATABASE_URL=... npx tsx volt-web/test/epg-fixes.seed.ts
import { one, query, pool } from '../../volt-app/src/db'

;(async () => {
  const email = process.env.EMAIL || 'admin@rtm.example'
  const u = await one<any>(`SELECT account_id FROM users WHERE email = $1`, [email])
  if (!u) throw new Error(`no user ${email}`)
  const g = (await one<any>(`SELECT id FROM groups WHERE account_id = $1 ORDER BY created_at LIMIT 1`, [u.account_id]))!.id
  const ch = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'Guide walk') RETURNING id`, [g]))!.id
  const day = new Date(); day.setUTCHours(0, 0, 0, 0)
  const at = (h: number) => new Date(day.getTime() + h * 3_600_000).toISOString()
  await query(`INSERT INTO programmes(channel_id, title, starts_at, ends_at) VALUES ($1,'Morning show',$2,$3)`, [ch, at(10), at(11)])
  await query(`INSERT INTO programmes(channel_id, title, starts_at, ends_at, geo_mode, geo_countries, replacement_kind, replacement_ref)
               VALUES ($1,'Old slate slot',$2,$3,'allow',ARRAY['GB'],'slate','/library/images/old-slate.png')`, [ch, at(14), at(15)])
  const loop = (await one<any>(`INSERT INTO filler_assets(account_id, kind, name, source_key, duration_ms, status)
                                 VALUES ($1,'loop','Ocean loop','filler/ocean-loop.mp4',30000,'ready') RETURNING id`, [u.account_id]))!.id
  await query(`INSERT INTO filler_assets(account_id, kind, name, source_key, status) VALUES ($1,'slate','Holding slate','filler/holding.png','ready')`, [u.account_id])
  console.log(`CHANNEL_ID=${ch}`)
  console.log(`LOOP_ID=${loop}`)
  await pool.end()
})().catch((e) => { console.error(e); process.exit(1) })
