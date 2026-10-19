# Viewer reporting: how it works, what runs locally, how to test it

## 1. Where viewer numbers come from

| Path | What it is | Runs locally? | Status |
|---|---|---|---|
| **Session beacons** | Every player posts `start`, a `heartbeat` (seconds watched, bitrate) and `end` to `POST /api/analytics/beacon`, carrying the playback token the play gate gave it | **Yes**, fully: beacons → `play_sessions`, `stream_concurrency`, `analytics_rollups` in Postgres → every report | Built. This is what the console's reports read |
| **Firehose copy** | The same beacons copied to S3 for a data lake (`ANALYTICS_FIREHOSE_STREAM`) | Not needed | Built, optional, AWS only |
| **CDN edge logs** | CloudFront real-time logs (Kinesis) counting every segment served, including players that send no beacons | No (AWS only) | **Designed, not built**. Until it is, a player that sends no beacons is not counted anywhere |

So reporting does **not** need AWS. Everything the console shows works on a
laptop or a local staging box, as long as the players send beacons.

## 2. Who sends beacons

| Player | Counted? |
|---|---|
| Your apps and the Volt web player (via the player API's playback token) | Yes |
| **Share-link preview page** | **Yes**, since 17 Oct 2026. Filed as client "Share link" (and app "share") so previews can be told apart from the public audience |
| The console's own players (channel page source and output, Multiview) | **No, by design**: operators checking a stream are not audience |
| A raw HLS/DASH URL opened in a third-party player | No beacons, so not counted until the CDN-log path exists |

Why the preview page did not count before: it played the stream but never sent
a beacon. It now sends start (with time to first frame), a heartbeat every 30
s with the seconds actually watched and the bitrate, and the end when the tab
is closed or hidden (via `sendBeacon`, so it survives the page going away).

### Playback tokens and long sessions

A playback token lives five minutes; a session can last hours. The token
proves the session started legitimately, so heartbeats and the end may carry
it for up to six hours after it expires. A new session may not start on an
expired token, with one exception: a share page keeps one token for the visit
(re-resolving would count another view of the link), so coming back to the tab
starts a new session with it.

## 3. When numbers appear

| Number | Appears | Where |
|---|---|---|
| Watching now | within ~5 s of a start | Channel page "Realtime viewers", Analytics "Watching now", `GET /api/analytics/realtime` |
| Last hour, minute by minute | as sessions run | Channel page chart (from `play_sessions`) |
| Views, unique viewers, watch time, device, country, app | **when a session ends** (rolled up every 5 s after the end) | Analytics, `GET /api/analytics/asset` |
| A day's final figures | sealed after the day, before raw sessions age out | Analytics (dashed days are not final yet) |

So during a test, "Watching now" moves at once and "Views" catches up as
viewers leave.

## 4. Testing it

### a) Simulated viewers (no player needed)

On the Mac demo (run-on-mac.sh), from `volt/volt-app`; the simulator signs
playback tokens itself, so it needs the API's secret:

```
cd volt-app
DATABASE_URL=postgres://volt:volt@localhost:5432/volt JWT_ACCESS_SECRET=dev-access-secret \
npx tsx scripts/simulate-viewers.ts \
  --api http://localhost:8080 --channel <channel id> \
  --viewers 40 --minutes 3 --leave 0.3 \
  --email <admin email> --password <password>
```

Forty pretend viewers on six devices and eight countries, starting over 20 s,
a heartbeat every 10 s, 30% leaving half way. While it runs, open the channel
page (Realtime viewers) and Analytics. At the end it prints what it **sent**
and what the reports **say**, side by side; they should match (views,
watch seconds, peak at once, device, country). `--kind event|vod` for events
and on-demand assets.

### b) The real share page

Create a share link for a running channel, open it in a browser, let it play,
close the tab. The session appears in Analytics under "Share link"; while it
plays the channel page counts it as watching.

### c) The automated check

`bash test/viewer-reporting.check.sh` (14 checks): simulator numbers match
the reports exactly, the channel page and realtime show the live count, a
share preview is filed as "Share link", expired-token rules, forged tokens
refused. `test/analytics-retention.check.ts` (33) covers sealing and pruning.

### d) Local staging

Nothing extra: the same build with Postgres. For many viewers set
`REDIS_URL` (concurrency across several API processes) and leave
`ANALYTICS_SESSIONS=postgres`. The CDN-log path is the only part that needs
CloudFront, and it is not built yet.
