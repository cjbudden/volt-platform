# FAST channels (VOD to live) and server-side ads

**Status: built 20 Oct 2026; production deployment (ECS playout, S3, shared stitcher state) the same day, section 10.** A FAST channel is a live channel built from the library: a run order
of films and series that loops, the guide written from it, played out as live HLS and DASH from media that is
already packaged, with ad breaks that any FAST platform can replace, or that Volt stitches per viewer from a
commercial ad server, with house spots when the ad server fails.

| Piece | Code | Checks |
|---|---|---|
| Run order engine (rotation, series, repeats, rights, grid, daily restart, versions) | `src/services/fast/lineup.ts` | `test/fast-lineup.check.ts` 56/56 |
| Break planning | `src/services/fast/adPlan.ts` | in the above |
| SCTE-35 splice_insert, built and read | `src/services/fast/scte35.ts` | `test/fast-ads.check.ts` (vectors checked against threefive 3.1.3) |
| VAST 2/3/4 client (macros, wrappers, one time budget) | `src/services/fast/vast.ts` | `test/fast-ads.check.ts` |
| Break fill: ads, house spots, slate | `src/services/fast/pod.ts` | `test/fast-ads.check.ts` |
| Per-viewer HLS stitcher | `src/services/fast/stitch.ts` | `test/fast-ads.check.ts` (a session through a sliding live window) |
| Guide writing, top-up, timeline, decisions, report | `src/services/fast/store.ts` | `test/fast.check.sh` 45/45 |
| API | `src/modules/fast.ts` | `test/fast.check.sh` |
| Creative conditioning job | `src/services/jobs/handlers/adCondition.ts` | `test/fast.check.sh` (queued) |
| Graphics hidden in breaks | `src/services/graphicTriggers.ts`, `volt-player/src/sdk/triggers.ts` | `test/fast-graphics.check.ts` 15/15 |
| Playout (no encoder) | `volt-encoder/bin/fast_playout.py`, image `volt-encoder/Dockerfile.fast` | `volt-encoder/bin/test_fast_playout.py` 32/32 (S3 output with moto) |
| Playout supervision, heartbeat, state | `src/services/fast/playoutRunner.ts`, `migrations/0067_fast_playouts.sql` | `dev/fast-prod-e2e.sh` |
| Public URL, stitcher session store, library media in S3, media preparation | `src/services/fast/delivery.ts`, `sessionStore.ts`, `vodStore.ts`, `prepare.ts` | `dev/fast-prod-e2e.sh` 23/23 |
| Builder UI | `volt-web/src/pages/Fast.tsx` | looked at in Chromium |
| Schema | `migrations/0065_fast_channels.sql` | |
| End to end in a browser | `dev/fast-e2e.ts`; production shape `dev/fast-prod-e2e.sh` | see "Measured" and section 10 |

## 1. What a FAST channel is here

An ordinary `channels` row with `origin = 'playlist'`. So the guide, XMLTV out, now/next, Up next, the player,
share links, reports and access rules all work on it unchanged. What differs:

* **No source, no encoder, no recording.** `fast_playout.py` writes the channel's live playlists from the
  segments of packaged VOD assets. Nothing is transcoded while it runs; one small process can run many channels.
* **The guide is the script.** Activating a lineup writes ordinary programmes (`source_ref fast:<lineup>:...`)
  and their ad breaks (`stream_breaks`). The playout plays the guide, not the lineup, so a title swapped by hand
  in the guide is what goes to air.

## 2. The playlist builder

### The model: a run order, not a day

A lineup is an ordered list of **slots** that loops. Each loop is a **pass**. A pass is not a day long, so each
pass starts at a different clock time, which spreads every title round the week without anyone scheduling it
twice. That is the cable movie channel model.

A slot is one of:

| Slot | What it plays | Controls |
|---|---|---|
| **Title** | a pool of titles that take turns, one per pass: `[A, B, C]` plays A on pass 1, B on pass 2, C on pass 3, then A | **Skip this turn** in the pool drops the slot on that turn; **Every Nth pass** rests it (with the pass it starts on); duplicate the slot for a second showing in the same pass |
| **Series** | the next N episodes, carrying on from where the last play stopped | episodes each time; in episode order, or **shuffled with no repeats** (every episode once per pass through the series, never the same one across the join); at the end start again or drop out; **Repeat of** (an encore of what another slot just aired); every Nth pass |

Lineup-wide:

* **Free-running or a daily restart.** Free-running spreads titles round the clock. A daily restart ("06:00")
  starts the run order again every day: the programme before the restart is padded up to it and anything that
  would cross it waits for the next day. That is strip programming.
* **Rotate the run order each pass** by k slots, so a title does not keep landing in the same part of the pass.
* **Round programmes up** to 5, 15, 30 or 60 minutes, padding with promos or the slate, so the guide reads like
  a traditional grid (the EPG design's slot rounding).
* **Backfill** for a title outside its rights window (`available_from` / `available_until`): the closest in
  length; otherwise the slot is skipped for that pass and the builder says so.
* **Keep the guide written ahead** 3 to 14 days; the scheduler tops it up every 10 minutes.

### The HBO example

Seven films of about two hours make a 14-hour pass. Free-running, that is 12 passes a week; every 14 hours a
film comes round again, 10 hours earlier on the clock, so each film airs at 12 different times. Then:

* slot 2 holds three films taking turns, so each plays 4 times a week instead of 12;
* slot 4 has "Skip this turn" in its pool, so it plays on every other pass and the run order closes up;
* slot 7 alternates two films.

A week of that guide has the shape of a cable movie channel: titles drop out and come back at different times,
the same film is never at the same time twice, and nobody built the week by hand. The builder's **"What this
run order does to a week"** card shows the pass length, passes a week, the clock shift per pass and every clock
time the first slot gets; each slot shows its plays a week (counted from the planned week), and **"want N /
week"** sets the slot's frequency to the nearest. The **Repeats** tab lists every title with plays, prime-time
plays, the closest repeat and any same-clock-time repeat.

A free-running pass that divides a day exactly (8, 12 or 24 hours) puts every title at the same time every day,
and one that does not divide the week starts next week at a different point; the builder warns about both.

### Series channels (the 7plus style)

Seven runs around 50 FAST channels, many of them a single series or a tight genre (nostalgic Australian drama,
factual: *Blue Heelers*, *A Country Practice*, *Border Security*, *Bondi Rescue*, *Highway Patrol*), as a
lean-back, bingeable channel rather than appointment viewing ([Mediaweek](https://www.mediaweek.com.au/7plus-fast-channels-audience-growth/),
[Seven West Media](https://sevenwestmedia.com.au/wp-content/uploads/2025/04/Sevens-FAST-channels-race-ahead.pdf)).
The controls map onto that directly:

| Pattern | How to build it |
|---|---|
| Serial drama from episode 1, forever | one series slot, in order, 4 to 6 episodes each time, start again at the end |
| Procedural or factual (episodes stand alone) | shuffled, no repeats: a different order every time through, no episode twice per pass |
| Strip at the same time daily | daily restart, the series slot first |
| Premiere then encore later the same day | a second series slot with **Repeat of** the first |
| Two shows interleaved | two series slots alternating in the run order, each with its own place in its series |
| Weekend marathon | not built: needs day-of-week rules on a slot (next step) |
| Start at a given season or episode | not in the console yet; the engine has the pointer (`series_start`) |
| Season limits, "play season 3 only" | not built (next step) |

### Determinism, versions and edits

The plan is a pure function of the lineup and its epoch. The guide, the playout's timeline and the break windows
all come from one computation, so they cannot disagree, and any window can be regenerated. Series pointers are
not stored state; they fall out of walking the passes from the epoch.

* The **active** lineup cannot be edited in place. Editing in the builder makes a **draft**; activating it
  archives the old version and starts the new run order from its top when the programme on air ends, with the
  pass count (rotation pools keep turning) and **every series where it was**. Nothing restarts from episode 1.
* A re-write of the guide (a new ad policy changed programme lengths, say) carries the run order on from the
  end of the programme on air in the guide, exactly, so there is never a hole after it.
* Nothing that has started, aired, or was entered by hand is deleted. Programmes entered by hand that overlap
  the lineup are reported as conflicts.

### Video or audio (22 Oct 2026)

A FAST channel is a **video** or an **audio** channel (`channels.fast_media`, migration 0075), chosen when it is
made and fixed after. The builder's library shows only that media: an audio channel lists audio assets (the Media
Library's audio test: a radio recording, a probe with no video, or an MP3/M4A export with no video rung), a video
channel lists video assets. Either lists only assets that **can air**: packaged with audio and video aligned for
splicing (`encode_result.zeroStart`), or with the source file still on this server so activation can prepare it.
That is the readiness check's "No source" applied up front. The library says how many it left out and why. Saving
a lineup with a title, backfill or series of the other media is refused (400). Not yet run end to end: an audio-only
channel through `fast_playout.py`.

## 3. The playout (no encoder)

`fast_playout.py` reads the timeline (`GET /api/fast-playout/<id>/timeline`, ingest token) and each asset's own
VOD playlists, and writes `master.m3u8`, `v<height>.m3u8`, `audio.m3u8` and `manifest.mpd`, rewritten every
second. The timeline is the guide cut into **parts**: content (asset, in, out), each ad break's fill (house spots,
then slate), and grid pads.

* Every part join is a discontinuity, on every track at the same place, with the init segment again.
* A segment is listed once its wall-clock end has passed, like a live encoder's.
* PDT is continuous; if the playout falls behind the guide by more than a segment it re-anchors at the next
  part's scheduled start.
* **The slate is elastic.** Spots are whole segments and a break is not, so the slate takes whatever brings the
  break to the guide's next start. A slate packaged in 1 second segments lands every break to the second; the
  next elastic fill takes back any difference, so it never accumulates.
* **Audio is cut by media time** against the video cut (a segment belongs to the part its midpoint falls in), so
  lip sync holds across every splice.
* Breaks carry `EXT-X-DATERANGE` with `SCTE35-OUT` (real splice_insert bytes), `EXT-X-CUE-OUT` /
  `CUE-OUT-CONT` / `CUE-IN`, and Volt's graphics-hide attributes. DASH has one Period per part, an
  `urn:scte:scte35:2014:xml+bin` EventStream on the break's first Period, and the graphics-hide event on every
  Period of the break (a player clips an event to its Period).
* The counters are sent to the control plane with every heartbeat (and kept in `state.json` locally), so a
  restart, on this server or another, carries the media sequence on.

### What the media must be

* **One ladder and one segment length** for everything on the channel (the account ladder; 2 s here).
* **Media time from zero.** ffmpeg's MPEG-TS muxer starts at 1.4 s, so the packager cut video at 1.48, 3.48...
  and audio at 2.0, 4.0..., and every audio segment straddled two video ones. Cut at a break, the audio would be
  up to a segment early or late. `vod_encoder.py` now sets `-muxdelay 0 -muxpreload 0` (env `VOD_ZERO_START=0`
  restores the old offset), which lines the two grids up to within one AAC frame, so **any newly encoded asset
  can go on a FAST channel as it is**. Assets encoded before 20 Oct 2026 should be re-encoded before they go on
  one.
* The **slate** in 1 second segments (above). Activation prepares it, and re-encodes older assets and
  un-normalised house spots, when their source is still there (section 10).
* The channel brand burned into the FAST copies (decision of 20 Oct 2026, branded copies tracked against the
  original). Ads are separate media, so they are clean of the bug without anything having to switch it off.

## 4. Ad breaks and server-side ads

### Planning the breaks

On a VOD-built channel a break **inserts time**: the film pauses at a segment boundary, the break plays, the film
carries on from the same frame. So the guide slot is content + breaks (+ grid pad), and every break is known
hours ahead, which is what lets every consumer prepare. The policy (per channel): target load in minutes per
hour (FAST runs about 8 to 12), mid-programme break length, a break between programmes, no break before N
minutes or in the last N minutes, a minimum gap, no mid breaks in titles under N minutes, and the title's own
break cues first (`vod_assets.break_cues_ms`, act breaks an editor marked), else spread evenly. Always on a
segment boundary.

### One break signal: `stream_breaks`

Every ad break on every stream is a row, whoever caused it: a FAST lineup (`fast`), an operator's **Go to
break** or an automation (`manual`, `api`: `POST /api/fast/streams/:kind/:id/breaks`, any channel or event), and
later a live source's SCTE-35 (`scte35`). Everything that must react to a break reads this one signal.

### How an ad gets requested

Three modes per channel:

| Mode | What happens | When |
|---|---|---|
| **Off** | no breaks | |
| **Markers** | breaks signalled with SCTE-35 and filled with house spots; **the platform** (Samsung TV Plus, Roku, Pluto, LG, Vizio...) replaces them with its own ads | syndication: most FAST distribution works this way |
| **Stitched** | Volt asks the channel's ad server for each break and stitches the ads in | Volt's own apps and web player |

Stitched, the request is **never on the manifest path**:

1. A viewer's player asks for `/fast/<channel>/s/<session>/<track>.m3u8`.
2. For any break starting in the next 60 seconds that this session has no decision for, the stitcher starts
   one in the background (`decideBreak`) and answers the playlist at once.
3. The decision: fill the vendor's VAST tag macros (break length, pod index, session, content id and title,
   series, genre, IP, user agent, country, app, IFA, consent strings, cache buster; unknown vendor macros pass
   through), GET it, follow wrappers (depth limit), all inside **one time budget** (default 1500 ms).
4. When the break's first segment reaches the playlist, the session's copy has the pod in place of the house
   fill. If the decision is not ready, the house fill plays. A viewer who joins mid-break sees the house fill
   for that break; the next one is theirs.

Vendors: Google Ad Manager, FreeWheel, SpringServe, Magnite, Publica, Beachfront, or any VAST 2/3/4 server:
each is a tag URL template. `POST /api/fast/ad-servers/:id/test` shows what the server would send for a break.
**Decide once per break for everyone** (`decision_scope = channel`) is the cheap option without targeting.

### Fallback: the break is never empty and never long

`pod.ts`, in order: the ad server's pod ads in sequence, then its buffet ads, each only if **conditioned**
(already packaged to the channel ladder) and if it fits; then **house spots** (weighted rotation, no repeat
inside a pod, consecutive breaks open with different spots); then the **slate** in whole segments. The same fill
covers every failure: the ad server timed out (VAST 301), errored, returned nothing, or returned only creatives
we have not packaged yet. Each decision is logged (`ad_decisions`) with the fallback reason, and the console
shows paid fill, house share, timeouts and p95 latency.

**Creative conditioning.** An ad server's creative is an MP4 at whatever size, frame rate and loudness the
agency exported; manifest stitching can only play it once it is on the channel ladder. The first time a creative
is offered it is skipped and an `ad.condition` job downloads it (the Mezzanine when there is one) and runs the
ordinary `vod.encode` on it; from then on every break and viewer reuses the packaged copy (keyed by Universal Ad
ID). Every commercial stitcher works this way.

### The stitcher

Only playlists are per session; every segment is a shared CDN object. The hard part is numbering: a pod rarely
has the same number of segments or discontinuities as the house fill it replaces, and every refresh must agree
on which segment is media sequence n. Per session and per break the stitcher keeps the channel's first media
sequence number, segment count and item count, and the pod's, and shifts every later segment by the running
difference. It never makes a pod longer than the break (content resumes on the channel's clock), and anything
it cannot read is passed through unchanged.

**In production** it runs on the api-public tier (`/fast/` is routed there), stateless per task: the session state
(a few hundred bytes per track) and the decided pods are in Valkey, so any task answers any refresh (section 10).
Without `REDIS_URL` the state is kept in the process.

**Later, the cheaper alternative:** server-guided ad insertion with HLS Interstitials (`CLASS=
"com.apple.hls.interstitial"` with an asset list URL) and DASH alternative content, where the shared, cacheable
playlist says where the break is and the player fetches its own pod. Same decision code, no per-session
playlists. Worth adding once player support is solid across the target devices.

## 5. What a break does to the rest of the platform

| Workflow | Effect | State |
|---|---|---|
| **Player graphics** | Every break is an `ad-break` trigger (`HIDE-GRAPHICS=all`) in the stream. While one is on, the player draws nothing of its own and offers no Up next, and reports `state.adBreak` so a host page can pause its overlays too. A break can be set to keep graphics (a sponsored break that wants its bug). | built |
| **Up next** | A card that would be on screen during a break is moved to finish before it (FAST puts a break at the end of most programmes, where Up next goes); if that leaves no room, no card. | built |
| **Burned-in graphics** (transcode channels) | `GET /api/streams/:id/timed-events` now also returns `breaks` (windows + hide flag) for the compositor to take graphics off air. The graphics work (`services/graphics/schedule.ts`, "clear for ad breaks") should read these as well as ad items in the guide. | feed built; hook to wire in the graphics work |
| **Channel brand / watermark** | Burned into the FAST content copies, so ads and house spots are clean by construction. | by design |
| **Live channels** | Go to break (console, API, automation) puts a break on any live channel or event; the live encoder's delivered playlists carry it at once through the existing timed-events feed. SCTE-35 from a live source is the next source of breaks. | manual and API built; source SCTE-35 next |
| **Guide / EPG** | A programme's slot includes its breaks; the guide lists programmes only. XMLTV out unchanged. | built |
| **Captions** | Content subtitles stay with their parts. Ads, spots and slate have none, so a FAST channel with subtitles needs empty WebVTT segments for those parts. | next |
| **DRM** | Ads are usually clear while content is encrypted: the key changes at a discontinuity, which players handle; settle per platform. | next |
| **Loudness** | Ads and house spots are brought to EBU R128 (-23 LUFS, -1 dBTP) when conditioned or prepared. | built |
| **Tracking** | Impressions and quartiles are not fired yet. Server-side, from the session's playlist progress, or client-side from the ad DATERANGE. | next |
| **Analytics** | `ad_decisions` gives fill, fallbacks and latency; ad segments in the CDN logs are the delivered-impression proxy. | decisions built |
| **Recording / clipping** | A FAST channel does not record; clip the asset. | by design |
| **Geo / rights** | Programme geo rules apply as on any channel; breaks are not affected. | unchanged |

## 6. API

| | |
|---|---|
| `GET/POST /api/fast/channels` | list; create a playlist channel (plan and group checks as any channel) with a draft lineup |
| `GET /api/fast/channels/:id` | channel, lineups, ads, playout health, URLs |
| `GET /api/fast/channels/:id/readiness`, `POST .../prepare` | is every asset the channel uses ready to air; queue the encodes that fix it |
| `POST /api/fast/channels/:id/on-air` | `{on}`: public or private |
| `GET /api/fast/library?channel=&q=` | assets and series; with `channel`, only that channel's media that can air, plus `hidden` counts and `inUse` (titles its lineups use that the filter leaves out) |
| `POST /api/fast/channels/:id/lineups` | new draft (copy of the active one by default) |
| `GET/PUT/DELETE /api/fast/lineups/:lid` | a lineup; the active one cannot be edited |
| `POST /api/fast/lineups/:lid/preview` | plan a window from unsaved slots: programmes, notices, repeat report, rotation maths, ad load |
| `POST /api/fast/lineups/:lid/activate` | make it active (carry on from the old version) and write the guide |
| `POST /api/fast/lineups/:lid/apply` | rewrite the guide ahead (`dryRun` to see what would change) |
| `GET/PUT /api/fast/channels/:id/ads` | mode, policy, ad server, house spots, decision scope |
| `GET/POST/PUT/DELETE /api/fast/ad-servers`, `POST .../:sid/test` | ad servers; one real test request |
| `GET/POST/DELETE /api/fast/streams/:kind/:id/breaks` | breaks on any channel or event; Go to break |
| `POST /api/fast/channels/:id/breaks/:bid/decide` | decide a break as the stitcher would (logged) |
| `GET /api/fast/channels/:id/ad-report` | fill, fallbacks, latency, creatives |
| `GET /api/fast-playout/:id/timeline` | the playout's timeline (ingest token) |
| `POST /api/fast-playout/:id/heartbeat`, `GET .../state` | the playout's heartbeat with its state; a new task's starting state (ingest token) |
| `GET /fast/:id/s/:session/(master\|v<h>\|audio).m3u8` | a viewer's stitched playlists (public) |

## 7. Measured (20 Oct 2026)

Real packaged assets (VP9/Opus CMAF, 2 s segments, two rungs + audio: headless Chromium has no H.264/AAC, the
mechanics are codec-agnostic), the control plane, `fast_playout.py` against it, a fake VAST server, Shaka 4.16
in Chromium, 120 to 200 s, across film, ad breaks (house spot + elastic slate), grid pads, a film change, a series
episode and a repeat:

| Stream | Stalls | Errors | Notes |
|---|---|---|---|
| Channel, HLS | **0** | 0 | breaks signalled, house fill played |
| Channel, DASH (multi-Period) | **0** | 0 | SCTE-35 and graphics events received per break |
| Viewer session, HLS, stitched | **0** | 0 | the ad played in every break, no house fill, same content segments as the channel |
| Probe session (refreshed every second, 360 playlists) | | | 0 inconsistent numbers, 0 gaps |

Found by running it: a pod 1 s longer than the channel's break (a 15 s ad against 14 s of house fill on a 2 s
slate) stalled the stitched session twice; hence pods are never longer than the break, and the slate is elastic
and best packaged in 1 s segments.

## 8. Checking it

```
# media: any packaged assets (vod_encoder.py) under <lab>/vod/<name>/
volt-app$ DATABASE_URL=... bash test/fast.check.sh                    # API + guide + decisions, 45 checks
volt-app$ npx tsx test/fast-lineup.check.ts && npx tsx test/fast-ads.check.ts && npx tsx test/fast-graphics.check.ts
volt-encoder$ python3 bin/test_fast_playout.py                          # FAST_LAB=<clips dir> for real media
volt-app$ BASE=... FAST_LAB=<clips dir> CHROME=<chromium> npx tsx dev/fast-e2e.ts   # API running with CLIPS_DIR/ORIGIN_DIR
volt-app$ BASE=... EMAIL=... PASSWORD=... npx tsx dev/fast-demo-seed.ts # two demo channels with realistic lengths
volt-app$ DATABASE_URL=... FAST_LAB=<VP9 lab> SLATE_SRC=<mp4> CHROME=... PACKAGER_BIN=... bash dev/fast-prod-e2e.sh
                                                                        # production shape, 23 checks (section 10)
```

## 9. Next

1. Impression and quartile beacons from the stitcher (the decisions already hold the tracking URLs).
2. S3 retention for `channel/<id>/fast/` after a channel is deleted (the playlists are a few kilobytes; the
   library media under `vod/<id>/` follows the asset's own deletion).
3. FairPlay / Widevine for FAST channels (the playlists carry no keys yet).
4. SCTE-35 from live sources; captions across ad parts.
5. Day-of-week rules on a slot (weekend marathons), a series start point and season limits in the console.
6. Drag to reorder in the run order; drop titles from the library onto the week view.
7. HLS Interstitials / SGAI mode; the stitcher for DASH.

## 10. Production (20 Oct 2026)

```
 console ──activate──▶ control plane ──RunTask──▶ ECS task "volt-fast" (one per channel, 0.125 vCPU, 256 MiB, Spot first)
                          ▲    │                     │  fast_playout.py, FAST_CONFIG_JSON
             heartbeat 5 s│    │ state back           │  reads library playlists from s3://<origin>/vod/<asset>/
         (state, sequence)│    ▼ on restart           ▼  writes s3://<origin>/channel/<id>/fast/*.m3u8, manifest.mpd
                       fast_playouts ◀────────────────┘  segment URLs absolute on the CDN
 viewer ──/live/<id>/master.m3u8──▶ api-public ──302──▶ CDN playlist (no ads stitched)
                                                 └─302──▶ /fast/<id>/s/<session>/master.m3u8 (stitched, never cached)
                                                          any api-public task; session state in Valkey
```

**The playout is its own task.** The control plane launches one ECS task of the `volt-fast` image per channel with
an active lineup (`EcsTaskLauncher.launchFast`, task definition `FAST_TASK_DEF`). The image is Python and boto3
(`volt-encoder/Dockerfile.fast`): the playout writes text and never touches media. It is configured entirely by
`FAST_CONFIG_JSON` (channel, API, token, bucket and prefix, CDN prefix, DVR length).

**State lives in the control plane, not the task.** Every 5 s the playout posts a heartbeat
(`POST /api/fast-playout/<id>/heartbeat`, ingest token) with its state (the channel's media and discontinuity
sequence, what it has published), and a replacement task starts by asking for it (`GET .../state`). A Spot
interruption or a crash therefore never restarts the channel's numbering; players carry on. SIGTERM sends a last
heartbeat before the task exits.

**Supervision** (`reconcilePlayouts`, every 30 s on the scheduler leader): launch what is missing, relaunch a task
ECS reports dead, replace one that is alive but has been silent for 3 minutes, stop playouts whose channel has no
active lineup. The console's On air tab shows it: where it runs, when it was last heard from, restarts, segments
published, titles it could not read.

**The public URL trusts the heartbeat.** `/live/<id>/...` answers only while the channel is public (on air) and the
playout's heartbeat is younger than `FAST_STALE_SEC` (30 s); otherwise 503 `no_valid_content`, never a playlist
that has stopped moving. A channel without stitched ads redirects to its playlists on the CDN. A stitched channel
gives each viewer a new session on the stitcher, marked no-store.

**The stitcher scales out.** api-public serves `/fast/` (ALB rule and `PUBLIC_PATH_PREFIXES`). A viewer's refreshes
land on any task, so the session's state is in Valkey (`services/fast/sessionStore.ts`): the stitch numbering per
track, the decided pod per break, and a 30 s lock so only one task asks the ad server for a given break. Without
`REDIS_URL` it is kept in the process (one task, a laptop). A Valkey error is a miss, and a miss is house fill.

**Library media lives in the bucket** (`VOD_STORE=s3`, the default on ECS): an encode uploads the packaged folder to
`vod/<id>/` (segments first, playlists last; segments immutable, playlists 60 s) and `master_key` becomes that key.
Before, it stayed on the control plane task's disk, which a FAST task on another server cannot read and which goes
with the task.

**Media is prepared on activation** (`services/fast/prepare.ts`, also `POST /api/fast/channels/<id>/prepare` and the
On air tab's Prepare button). Each title, house spot and slate the channel uses is checked: packaged with aligned
audio and video (`encode_result.zeroStart`), house spots at broadcast loudness (EBU R128, -23 LUFS, `loudnorm`),
the slate in 1 s segments. What is not is re-encoded from its source with the account's default ladder; an asset
whose source file is gone is reported (No source), not guessed at.

**Terraform** (`deploy/terraform`): ECR repository `volt-fast`; task definition `<name>-fast` (EC2, awsvpc, the
encoder's task role: origin bucket read/write, so PassRole is unchanged); control-plane settings `FAST_TASK_DEF`,
`FAST_OUTPUT=s3`, `VOD_STORE=s3` and `PUBLIC_BASE_URL` (variable `public_base_url`, else the first API edge alias,
else the API edge, else the ALB); `/fast/*` routed to api_public. The image build is in the Terraform README.

**Checked** (`dev/fast-prod-e2e.sh`): moto as the bucket, a signing proxy in front of it as CloudFront with origin
access control, redis as Valkey, two API processes (ROLE=all and ROLE=api-public), the playout configured exactly as
its ECS task. 23 checks: library in the bucket; the slate prepared to 1 s, zero-start, into the bucket on
activation; playlists in the bucket with their content types and no-store; segment URLs on the CDN; private until on
air; a session per viewer, not cached; DASH to the CDN MPD; Chromium playing the channel's HLS and DASH from the CDN
and a stitched session for 90 s with no stalls and every segment from the CDN; one session refreshed 92 times
alternately on the two API processes with no inconsistency, gap or hole, carrying the ad server's ad; the playout
killed and replaced with its media sequence carried on; deactivation stopping it and the public URL answering 503.

Found on the way: `vod_encoder.py`'s GPU check named its result `probe`, which hid the `probe()` function in
`main()`, so every probe step (the first step of every library encode) failed with UnboundLocalError. Renamed.
