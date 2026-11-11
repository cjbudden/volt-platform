# Testing geo-based content replacement on FAST channels

Written 11 Nov 2026 against commit a01dfb7a (FAST geo rights) and later. For the code, see `volt-app/src/services/fast/rights.ts`, `services/edgeRights.ts`, `services/variantManifest.ts` and `modules/publicLive.ts`.

## 1. The workflow, end to end

1. **Rights are set on the titles.** Each title has a rights profile (Rights): whether FAST is an allowed use, its territories (allow or block list), blocked territories and a rights window. Its publishing plan can add geo too. Access removed means the title airs nowhere.
2. **The channel is set up.**
   - Settings > **Where it can be watched** sets geo for the whole channel.
   - Build > Brand & filler > **Geo replacement** names a Loops & Fillers loop or slate.
   - Choosing a replacement queues it to be packaged for the channel's ladder, at the programmes' segment length, with broadcast loudness (it shows in Overview > Media with the role Ident).
3. **The guide becomes rights windows.**
   - For every FAST programme in the next 24 hours whose title is restricted, `loadFastRights` makes a window.
   - The window covers the whole programme, with the title's countries, or every country outside the rights window.
   - The windows are cached for 15 seconds. `loadEdgeRulesFromDb` merges them with any windows typed into the EPG.
4. **The decision, per viewer and per playlist request.** In this order:
   - the account's geo, then the channel's geo: outside either, the viewer gets **451** for the whole channel;
   - then the programme windows: **allow**, **replace:v<key>** (with a geo replacement) or **block** (without one, 451).
   - Viewers whose countries give the same timeline share one variant key.
5. **What a replaced viewer is sent.**
   - The public `/live/<id>/master.m3u8` redirects them to `/live/<id>/v/<key>/master.m3u8`.
   - The variant service reads the FAST playout's own playlists and swaps the restricted programme's segments, slot for slot, for the replacement's segments, looping it.
   - Discontinuities mark the window's start, every loop wrap and the window's end.
   - When the programme ends, the playlist is the channel's own again. The player never changes URL.
6. **In production** the same decision runs in the CloudFront Function from the key-value store the control plane keeps in sync. A replaced viewer's `/channel/<id>/fast/<file>` request is rewritten to `/channel/<id>/v/<key>/fast/<file>`, which the variants origin answers with the same service.

DASH viewers get the same replacement: the restricted programme's Periods are cut at the window and the replacement's passes are added as Periods of their own.

Not covered yet:
- **Stitched-ads** viewers get the channel's own playlists, without their personalised ads, while replaced.

## 2. Mac or full deployment?

Most of it can be tested on the Mac, with `run-on-mac.sh`. The variant service runs inside the API there, and the Mac's public route makes the same decision the CDN does.

| What | Mac | Needs the cloud |
|---|---|---|
| The decision for each title, country and time | Yes: `?as=GB` and `&at=<time>` on the public URL (development only) | |
| Watching the replacement play, loop wraps and the return to the channel | Yes: the variant service runs in the API | |
| The channel-wide geo (Where it can be watched) | Yes, with `TRUST_EDGE_GEO=1` and an `x-viewer-country` header (curl or a header extension); `?as=` does not reach that check | |
| The rights preview (any country, any time, 24 hour strip, a playable link) | Yes, through the API | |
| Real viewer countries, the CloudFront Function, the key-value store sync | | Yes |
| The CDN logs and the delivery reports built from them | | Yes |
| Load: many viewers per variant | | Yes |

There is a middle step: the staging stack on the Mac (`deploy/staging`, docker compose). It runs the API in production mode behind an nginx edge, where `?as=` is ignored and the country comes from an `X-Test-Country` header. It checks the production code paths and caching, but its edge does not run the rights function: the decision is still made by the API's public route.

Test on the Mac first. The cloud run then only proves the edge plumbing and the reporting.

## 3. What is reported today

Measured against the code as it is now:

| Where | What it shows |
|---|---|
| Build > Brand & filler > **Geo replacement** | The replacement chosen, and each restricted programme in the next two days with where it can be seen. A warning when there is no replacement |
| `GET /api/fast/channels/<id>/rights` | The same as JSON, plus the channel's own geo |
| `GET /api/channels/<id>/rights-preview?country=GB&at=<time>` | The decision for that viewer and the rule behind it, the variant key, whether the replacement is ready (`loopReady`), a playable link (HLS and DASH) and a 24 hour strip per audience |
| Response headers on every public playlist | `X-Volt-Rights: allow`, `replace:v<key>` or `block`, and `X-Volt-Variant: v<key>` on variant playlists |
| The variant playlist itself | Segment addresses inside the window point at the replacement (`/clips/vod/<replacement asset>/...`), outside it at the titles |
| Loops & Fillers > the item > **Used by** | The channel, with the role Geo replacement |
| Cloud: CDN real-time logs | Every playlist and segment request, with the viewer's country and the path. Variant paths keep `/v/<key>/`, and replacement segments carry the replacement asset's path |
| Rights demand report (P2-3) | Play-gate and edge-token refusals per title and country. It does **not** count FAST programme replacements |

**Rights delivery** (added 12 Nov, see section 3a) now counts this. Before it, nothing counted **"replacement delivered"**: how many viewers, from which countries, saw the replacement instead of which programme, and for how long. The facts are there:
- on the Mac, every variant playlist served;
- in the cloud, the CDN log lines with `/v/<key>/` or the replacement asset's segments.

They are not added up into a report. See section 6.

## 3a. The rights delivery report

Build > Brand & filler > **Rights delivery**, or `GET /api/fast/channels/<id>/rights-report?from=&to=`: per scheduled programme and country, the viewers who **saw it**, saw the **replacement**, or were **refused**, with the playlist requests behind each.

How it is counted, and why it does not load the database:
- **Without a CDN (the Mac):** every viewer of a FAST channel with rights is kept on the variant service, so each playlist reload is counted where it is answered. Allowed viewers are sent to `/live/<id>/v/v00000000/…`: the same playlists with no window.
- **Behind the CDN:** the CDN's real-time log lines are counted: the channel's own playlists as viewed, `/v/<key>/` paths as replaced, the edge's 451s as refused. The origin counts nothing, so no viewer is counted twice.
- **On the request path:** an in-memory counter only, per channel, 15 second bucket, country and outcome. Viewers are kept as they are while few, then as a 4 KB HyperLogLog.
- **Once a minute:** each task resolves its buckets to the guide's programmes (one indexed read per channel) and **inserts** minute rows into the analytics database. Inserts only, so tasks never wait on each other.
- **Every 5 minutes:** one task (the others skip) folds the minute rows into one row per programme, country and outcome, merging the viewers in memory, in one short transaction.
- **Measured** on a scratch Postgres 16, for 2000 rows: the minute insert takes about 45 ms and the roll-up about 60 ms. Merging the registers in SQL instead took about 10 s, so it is not done there.

## 4. Test setup on the Mac

1. Start the stack with the channel-geo stand-in on:
   ```
   TRUST_EDGE_GEO=1 ENCODER_MODE=docker bash run-on-mac.sh
   ```
2. **Rights profile.** Rights > New profile "AU and NZ only":
   - Territories **Only these**: AU, NZ.
   - Uses include **FAST**.
   - No window.
   - Assign it to one film, title **T1**.
3. **A second profile**, "Ends today", for a window test:
   - Worldwide, FAST allowed.
   - Rights end about 40 minutes from now.
   - Assign it to a second title, **T2**.
4. **A FAST channel**, "Geo Test":
   - Run order: T1, then an unrestricted title **T3**, then T2. Short titles (5 to 15 minutes) make the test quicker.
   - Channel clock: no rounding.
   - Activate, then **Go live** (the public URL only answers while the channel is public).
5. **A replacement.** Loops & Fillers: upload a 20 to 30 second loop, "Not available here". On the channel, Build > Brand & filler > Geo replacement > choose it.
6. **Wait for it to be ready.** Overview > Media until it reads Ready, or `GET /api/fast/channels/<id>/readiness`.
7. Note the channel id (from the URL) as `CH`, and the UTC start and end of each programme from Build > Week or the guide:
   - `T1_START`, `T1_END`, `T3_START`, `T2_START`, `T2_END`;
   - and the rights end of T2, `T2_RIGHTS_END`.

Shell helpers:
```
B=http://localhost:8080
CH=<channel id>
hdr() { curl -s -o /dev/null -D - "$@" | grep -iE '^(HTTP|location|x-volt-rights|x-volt-variant)'; }
segs() { curl -sL "$@" | grep -v '^#' | head -3; }
```

## 5. Test cases

Each case says the request, what should come back, and what is checked. Times are ISO, UTC, for example `2026-11-12T10:05:00Z`. Use `&at=` to test a programme that is not on air right now: the decision uses that time. The variant playlist still swaps segments against the real time, so for the playlist contents themselves (cases 3, 4, 7, 8) test while the programme is actually on air.

**1. The rights card lists what is restricted**
- **Do:** open Build > Brand & filler, or `GET /api/fast/channels/$CH/rights`.
- **Expect:** T1 "only in AU, NZ". T2 "nowhere" from its rights end (or listed with its window). T3 not listed. `enforcedAs: "replace"`.

**2. Allowed viewer during T1**
- **Do:** `hdr "$B/live/$CH/master.m3u8?as=AU&at=<T1_START+5 min>"`
- **Expect:** 302 to the channel's own playlist (`/origin/$CH/fast/master.m3u8`). `X-Volt-Rights: allow`.

**3. Restricted viewer during T1**
- **Do:** `hdr "$B/live/$CH/master.m3u8?as=GB&at=<T1_START+5 min>"`
- **Expect:**
  - 302 to `/live/$CH/v/v????????/master.m3u8?as=GB&at=...`
  - `X-Volt-Rights: replace:v????????`
  - Following it: media playlists whose segments inside T1 are `/clips/vod/<replacement>/...`, in order 1..N, repeating.

**4. Back to the channel after T1**
- **Do:** as case 3 with `at` set to 2 minutes after `T1_END`.
- **Expect:** `X-Volt-Rights: allow`. The playlist lists the replacement up to `T1_END`, a discontinuity, then T3's segments.

**5. Unknown country during T1**
- **Do:** `?as=XX` (a viewer whose country the CDN cannot tell).
- **Expect:** replace. An allow list needs a known country.

**6. Rights window ending mid-programme (T2)**
- **Do:**
  - `?as=AU&at=<T2_START + 1 min>` while still inside T2's rights;
  - then `?as=AU&at=<T2_RIGHTS_END + 1 min>`.
- **Expect:** allow, then replace for **every** country, AU included.

**7. Watch it**
- **Do:**
  - Open `http://localhost:5173/live/$CH/master.m3u8?as=GB` in Safari, or in the console's player.
  - Watch it while T1 is actually on air (or use the rights preview link, case 9).
- **Expect:**
  - The loop plays, wraps cleanly with no stall, for T1's length.
  - It then cuts to T3 at the boundary.
  - The clock and position never jump back.

**8. Same playlist for everyone in a variant**
- **Do:** compare `?as=GB` and `?as=US` variant playlists for T1.
- **Expect:** the same `X-Volt-Variant` key and the same body.

**9. The rights preview**
- **Do:** in the browser's developer console on `localhost:5173`:
  ```
  const m = await import('/src/api.ts')
  await m.apiRequest('/channels/<CH>/rights-preview?country=GB&at=<T1_START+5 min>')
  ```
- **Expect:**
  - `decision: "replace"`, `loopReady: true`, the rule naming T1's programme.
  - `play.hls` plays the replacement even while the channel is private.
  - The strip shows AU and NZ normal and "anywhere else" replaced for T1's slot.

**10. No geo replacement**
- **Do:** set Geo replacement to None. Wait 15 s. Run case 3 again.
- **Expect:** `X-Volt-Rights: block`, 451 with "This programme is not available where you are". The card shows the warning. Choose the replacement again afterwards.

**11. Channel-wide geo**
- **Do:**
  - Settings > Where it can be watched > Only AU, NZ. Save.
  - `hdr -H 'x-viewer-country: GB' "$B/live/$CH/master.m3u8"`
  - then the same with AU.
- **Expect:** GB gets 451 "This channel is not available in GB", for every programme. AU gets the channel, with T1 allowed. Set it back to Everywhere.

**12. Publishing plan geo**
- **Do:** give T3's publishing plan a geo block on GB, then `?as=GB` while T3 airs.
- **Expect:** replace for GB, allow for AU.

**13. FAST not allowed by the rights**
- **Do:** take FAST out of T3's profile uses. Wait 15 s. Run `?as=AU` while T3 airs.
- **Expect:** replace for everyone. Put FAST back.

**14. A rights change reaches viewers**
- **Do:** with a GB player on T1's replacement, add GB to T1's profile territories.
- **Expect:** within about 15 s plus a playlist reload, the GB player gets the film.

**15. DASH**
- **Do:** `hdr "$B/live/$CH/manifest.mpd?as=GB"` while T1 is on air, follow it, and play it in a DASH player (for example the dash.js reference player, pointed at `http://localhost:5173/live/$CH/manifest.mpd?as=GB`).
- **Expect:** `X-Volt-Rights: replace:v…`. In the MPD, T1's Period is gone, and Periods whose ids start with the variant key play the replacement (`initialization` under the replacement's folder), one per pass. T3's Period follows unchanged. The player loops the replacement, then moves on to T3.

**16. Stitched ads (known limit)**
- **Do:** set Ads to stitched, then run case 3.
- **Expect:** the replaced viewer gets the channel's playlists without per-viewer ads during T1.

**17. Loops & Fillers shows the role**
- **Do:** open the replacement item in Loops & Fillers.
- **Expect:** Used by: Geo Test, FAST channel, "Geo replacement", Ready.

**17a. Rights delivery**
- **Do:**
  1. Play `/live/$CH/master.m3u8?as=AU` in one browser and `?as=GB` in another (different browsers count as different viewers) through T1 and into T3.
  2. Wait a minute.
  3. Open Build > Brand & filler > Rights delivery, Today.
- **Expect:**
  - T1: Saw it 1 (AU), Replacement 1 (GB).
  - T3: Saw it 2 (AU, GB).
  - Totals: 2 viewers.
  - Run case 10 (no replacement) with a GB player: Refused 1 for that programme.
- **Check:** `curl -sI` with `x-viewer-country: GB` against a channel limited to AU, NZ (case 11) adds to Refused.

**18. Automated checks**
- **Do:**
  ```
  cd volt-app
  npx tsx test/fast-geo-rights.check.ts
  npx tsx test/fast-geo-dash.check.ts
  npx tsx test/rights-delivery.check.ts
  npx tsx test/edge-variant-manifests.check.ts
  ```
- **Expect:** 19, 9, 24 and 43 passed, 0 failed.

## 6. In the cloud (after the Mac pass)

1. Deploy the release with the FAST geo commit. Check that the CloudFront distribution's variants behaviour covers `/channel/*/v/*` (Terraform), and that the key-value store sync is running: the scheduler log prints `[edge-rights] N written, ...` when the windows change.
2. From a machine in AU and one outside (a VPN, or a cloud VM in another region), play the public FAST URL during T1. Check the response headers on the playlist (`x-volt-rights` comes from the origin on variant requests; a 451 comes from the edge function).
3. In the CDN real-time logs for that hour:
   - GB requests should carry `/channel/<CH>/v/<key>/fast/...` playlists and replacement segment paths during T1;
   - AU requests should carry the titles' segments.

## 7. Gaps found while writing this, and suggested next steps

1. **A "replacement delivered" report.** Built 12 Nov (section 3a).
   - Count each variant playlist served, by stream, programme, country and variant, in memory, flushed once a minute to a daily rollup. This is the same pattern as the rights demand report.
   - In the cloud, count the CDN log lines carrying `/v/<key>/`.
   - Show it on the FAST channel and in Analytics as viewers and minutes replaced per programme and country.
2. **The rights preview on the FAST page.** The API works for FAST channels, but the preview panel is only on live channel and event pages.
3. **Multiview's "Viewer location" for FAST.** It plays FAST channels as they are today.
4. **The rights preview's "not ready" hint for FAST.** It points at the live fallback loop, not the geo replacement.
5. **DASH replacement for FAST**: done. The existing DASH variant renderer handles the FAST MPD (checked by test/fast-geo-dash.check.ts).
