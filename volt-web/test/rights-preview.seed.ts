// SEED FOR THE RIGHTS PREVIEW BROWSER CHECK (rights-preview.browser.mjs).
// One channel and one event in the account of EMAIL (default
// admin@rtm.example from the demo seed), with rights windows around now, and
// a delivered output plus its pre-built loop written under ORIGIN_DIR from
// test media: MEDIA_DIR/live/720p (blue, at least 40 four-second segments)
// and MEDIA_DIR/loop/720p (red, five). Prints CHANNEL_ID and EVENT_ID.
//   DATABASE_URL=... ORIGIN_DIR=... MEDIA_DIR=... npx tsx volt-web/test/rights-preview.seed.ts
import { mkdirSync, writeFileSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { one, query, pool } from '../../volt-app/src/db'

const ORIGIN = process.env.ORIGIN_DIR!, MEDIA = process.env.MEDIA_DIR!
const iso = (s: number) => new Date(s * 1000).toISOString()

function output(id: string, now: number) {
  const run = join(ORIGIN, id, 'runs', '20261024T000000Z')
  mkdirSync(join(run, 'filler'), { recursive: true })
  writeFileSync(join(ORIGIN, id, 'current_run.txt'), '20261024T000000Z')
  cpSync(join(MEDIA, 'live', '720p'), join(run, '720p'), { recursive: true })
  cpSync(join(MEDIA, 'loop', '720p'), join(run, 'filler', '720p'), { recursive: true })
  writeFileSync(join(run, 'master_cc.m3u8'), '#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-STREAM-INF:BANDWIDTH=400000,CODECS="vp09.00.30.08",RESOLUTION=640x360\nstream_0_cc.m3u8\n')
  // the newest segment ends now: the live edge sits inside the AU window
  const t0 = now - 160
  const L = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-DISCONTINUITY-SEQUENCE:0', '#EXT-X-MAP:URI="720p/init.mp4"']
  for (let n = 0; n < 40; n++) L.push(`#EXT-X-PROGRAM-DATE-TIME:${iso(t0 + n * 4)}`, '#EXTINF:4.000,', `720p/seg_${n + 1}.m4s`)
  writeFileSync(join(run, 'stream_0_cc.m3u8'), L.join('\n') + '\n')
  const segs = Array.from({ length: 5 }, (_, k) => ({ uri: `720p/seg_${k + 1}.m4s`, dur: 4 }))
  writeFileSync(join(run, 'filler', 'filler.json'), JSON.stringify({ hash: 'browser', segment_seconds: 4, loop_seconds: 20, tracks: { '720p': { kind: 'video', init: '720p/init.mp4', segments: segs } } }))
}

;(async () => {
  const email = process.env.EMAIL || 'admin@rtm.example'
  const acct = (await one<any>(`SELECT account_id FROM users WHERE email = $1`, [email]))!.account_id
  const g = (await one<any>(`INSERT INTO groups(account_id, name) VALUES ($1, 'Rights preview check') RETURNING id`, [acct]))!.id
  const ch = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1, 'Derby channel') RETURNING id`, [g]))!.id
  const now = Math.floor(Date.now() / 1000)
  const ev = (await one<any>(`INSERT INTO events(group_id, name, status, scheduled_start, scheduled_end) VALUES ($1, 'Derby final', 'scheduled', to_timestamp($2), to_timestamp($3)) RETURNING id`, [g, now - 600, now + 7200]))!.id
  await query(`INSERT INTO programmes(channel_id, title, starts_at, ends_at, geo_mode, geo_countries, replacement_kind, replacement_ref, metadata)
               VALUES ($1, 'Derby AU rights', to_timestamp($2), to_timestamp($3), 'block', ARRAY['AU'], 'loop', 'filler-1', '{}'),
                      ($1, 'Derby FJ blackout', to_timestamp($2), to_timestamp($3), 'block', ARRAY['FJ'], 'none', NULL, '{}'),
                      ($1, 'Derby NZ rights', to_timestamp($4), to_timestamp($5), 'block', ARRAY['NZ'], 'loop', 'filler-1', '{}'),
                      ($1, 'Late AU match', to_timestamp($6), to_timestamp($7), 'block', ARRAY['AU'], 'loop', 'filler-1', '{"rights_exempt":["premium"]}')`,
  [ch, now - 300, now + 1800, now + 2400, now + 3000, now + 3600, now + 5400])
  await query(`INSERT INTO programmes(event_id, title, starts_at, ends_at, geo_mode, geo_countries, replacement_kind, replacement_ref)
               VALUES ($1, 'Final AU rights', to_timestamp($2), to_timestamp($3), 'block', ARRAY['AU'], 'loop', 'f')`, [ev, now - 300, now + 1800])
  output(ch, now); output(ev, now)
  console.log(`CHANNEL_ID=${ch}\nEVENT_ID=${ev}`)
  await pool.end()
})().catch((e) => { console.error(e); process.exit(1) })
