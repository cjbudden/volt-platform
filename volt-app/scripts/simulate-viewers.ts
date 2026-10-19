// ============================================================================
//  SIMULATE VIEWERS: test reporting locally, with no AWS (docs/REPORTING_TESTING.md).
//
//  Runs N pretend viewers against a channel, event or on-demand asset through
//  the SAME public beacon every real player uses (POST /api/analytics/beacon):
//  a start, a heartbeat every few seconds with the seconds watched and the
//  bitrate, and an end. Each viewer gets its own device, country and app, so
//  the audience breakdowns have something to show. At the end it prints what
//  it sent, and what the reports say, side by side, so the numbers can be
//  checked rather than eyeballed.
//
//    DATABASE_URL=... npx tsx scripts/simulate-viewers.ts \
//      --api http://localhost:8080 --channel <id> --viewers 25 --minutes 3
//
//  Options: --kind channel|event|vod (default channel), --viewers N, --minutes M,
//  --beat S (heartbeat seconds, default 10), --ramp S (spread the starts over
//  S seconds, default 20), --leave 0..1 (share who leave half way, default 0.2),
//  --email/--password to read the reports back (an admin of the account).
//
//  The playback token is minted here with the server's own signing code (so
//  DATABASE_URL and the same secrets as the API are needed), exactly as the
//  play gate would mint it for an app.
// ============================================================================
import { mintPlaybackToken } from '../src/services/apiKeys';
import { one, pool } from '../src/db';

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d };
const API = arg('api', process.env.API || 'http://localhost:8080')!.replace(/\/$/, '');
const KIND = (arg('kind', 'channel') as 'channel' | 'event' | 'vod');
const ID = arg(KIND) ?? arg('id');
const N = Number(arg('viewers', '25'));
const MINUTES = Number(arg('minutes', '3'));
const BEAT = Number(arg('beat', '10'));
const RAMP = Number(arg('ramp', '20'));
const LEAVE = Number(arg('leave', '0.2'));
if (!ID) { console.error(`usage: --${KIND} <id> [--viewers N --minutes M]`); process.exit(2) }

const UAS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36',
  'Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0) AppleWebKit/537.36 SamsungBrowser/4.0 TV Safari/537.36',
  'Roku/DVP-12.5 (12.5.0.4174)',
]
const GEOS = ['AU', 'AU', 'AU', 'NZ', 'MY', 'SG', 'GB', 'US']
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const pick = <T,>(a: T[], i: number) => a[i % a.length]

async function main() {
  const acct = KIND === 'vod'
    ? await one<any>(`SELECT account_id FROM vod_assets WHERE id = $1`, [ID])
    : KIND === 'event'
      ? await one<any>(`SELECT g.account_id FROM events e JOIN groups g ON g.id = e.group_id WHERE e.id = $1`, [ID])
      : await one<any>(`SELECT g.account_id FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id = $1`, [ID])
  if (!acct) { console.error(`no ${KIND} ${ID}`); process.exit(2) }
  const sent = { starts: 0, ends: 0, beats: 0, seconds: 0, rejected: 0, peak: 0 }
  let live = 0
  const post = async (body: any, ua: string) => {
    const r = await fetch(`${API}/api/analytics/beacon`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': ua }, body: JSON.stringify(body) })
    if (!r.ok) sent.rejected++
  }
  const viewer = async (i: number) => {
    await sleep((RAMP * 1000 * i) / Math.max(1, N))
    const geo = pick(GEOS, i), ua = pick(UAS, i)
    const tok = mintPlaybackToken({ accountId: acct.account_id, appId: null, assetId: ID!, assetKind: KIND, geo, ttlSec: 120 }).token
    const sid = `sim-${Date.now()}-${i}`
    const kbps = pick([5000, 2800, 1200], i)
    await post({ playbackToken: tok, sessionId: sid, event: 'start', ttffMs: 600 + (i % 7) * 150, bitrateKbps: kbps }, ua)
    sent.starts++; live++; sent.peak = Math.max(sent.peak, live)
    const stayMs = (Math.random() < LEAVE ? 0.5 : 1) * MINUTES * 60_000
    const until = Date.now() + stayMs
    while (Date.now() < until) {
      await sleep(BEAT * 1000)
      await post({ playbackToken: tok, sessionId: sid, event: 'heartbeat', seconds: BEAT, bitrateKbps: kbps, bytes: Math.round(kbps * 125 * BEAT) }, ua)
      sent.beats++; sent.seconds += BEAT
    }
    await post({ playbackToken: tok, sessionId: sid, event: 'end' }, ua)
    sent.ends++; live--
  }
  console.log(`${N} viewers on ${KIND} ${ID} for up to ${MINUTES} min (heartbeat ${BEAT} s), via ${API}`)
  const tick = setInterval(() => console.log(`  watching now: ${live}`), 15_000)
  await Promise.all(Array.from({ length: N }, (_, i) => viewer(i)))
  clearInterval(tick)
  console.log(`\nSENT     starts ${sent.starts}, heartbeats ${sent.beats}, ends ${sent.ends}, seconds watched ${sent.seconds}, peak at once ${sent.peak}, rejected ${sent.rejected}`)

  // The reports, read back the way the console reads them (after one flush).
  const email = arg('email'), password = arg('password')
  await sleep(8_000)
  if (email && password) {
    const t = await (await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json() as any
    const h = { authorization: `Bearer ${t.access}` }
    const a = await (await fetch(`${API}/api/analytics/asset?kind=${KIND}&id=${ID}`, { headers: h })).json() as any
    const today = (a.daily ?? [])[0] ?? {}
    console.log(`REPORTED views ${today.total_views ?? '?'}, watch seconds ${today.watch_seconds ?? '?'}, peak at once ${today.peak_concurrent ?? '?'}, by device ${JSON.stringify(today.by_device ?? {})}, by country ${JSON.stringify(today.by_geo ?? {})}`)
  } else {
    const r = await one<any>(`SELECT total_views, watch_seconds, peak_concurrent FROM analytics_rollups WHERE account_id = $1 AND scope = $2 AND scope_id = $3 AND bucket_date = current_date`, [acct.account_id, KIND, ID])
    console.log(`REPORTED (rollup) views ${r?.total_views ?? 0}, watch seconds ${r?.watch_seconds ?? 0}, peak at once ${r?.peak_concurrent ?? 0}   (pass --email/--password to read it through the API)`)
  }
  await pool.end()
}
main().catch(e => { console.error(e); process.exit(1) })
