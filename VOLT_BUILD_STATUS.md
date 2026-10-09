# Volt Streaming - Design vs Build Reconciliation

*Single source of truth for "what did we decide" vs "what is actually built."*
*`volt_build_status.html` is generated from THIS file: `node scripts/build-status.mjs`.*
Generated 2026-08-02 by reconciling the 25 project-memory notes (decisions from
all chat sequences) against the code in `volt-app/`, `volt-encoder/`, `e2e/`,
and `deploy/terraform/`.

**Last reconciled 2026-09-05**, including a sweep of every 🧪 prototype row against the tree (see the *Prototype sweep* section at the end): five of six were resolved, four to built and one to partial, and the one that remains a prototype turned out to have no caller. Counted from the tree on that date, not
remembered: **24 migrations**, **83 check suites** (54 TypeScript, 29 shell),
**48 mounted routers**, **136 backend TypeScript files (30.0k lines)**,
**48 console files (18.6k lines)** across **25 pages**. Suite *results* are not
restated here because they need a running database and API; run
`node scripts/check.js` for those.

**Legend** - ✅ Built & verified · 🟡 Partial (some built, some stubbed) ·
📐 Designed only (decision + doc, no code) · 🧪 Prototype / test-harness only ·
❌ Not started

**MEDIA SCOPE.** A note beginning **Video.**, **Audio.** or **Video + audio.**
states which workflow a capability belongs to. Added 5 Sep because the two were
being read as one and the requirements were drifting together: the waveform and
level metering are an AUDIO surface (a station, or the audio track of a video
asset) and say nothing about video; timed in-stream metadata is a VIDEO delivery
concern first; graphics overlays are video-only by decision and radio is
explicitly out of their scope. A capability with no scope note applies to both.
Anything built for one and described as if it served both is a requirement
defect, not a documentation one — it is how a video feature ends up with an
audio acceptance test and neither works.

The headline as first written: the **control/production/orchestration core is
built and verified** (chat-1 work), with the API contract, EPG, source-provider,
geo/rights, analytics and app-keys designs documented but not implemented.

**That gap has largely closed.** Hypermedia, EPG, geo/rights, analytics and
app-keys are all built and covered. What remains 📐 is now mostly work that was
*designed after* the original reconciliation — graphics overlays, timed
in-stream metadata, schedule inference, the operating report — rather than a
backlog the build never caught up with. The honest current gap is different in
kind: **the ECS launcher path, archive/restore against real S3, and scale beyond
one box have code and tests but no production exercise.**

---

## 1. Control plane & API

| Capability | Status | Notes / source |
|---|---|---|
| REST API - 34 endpoints (channels, events, recordings, vod, metadata-schemas, filler, scheduled-clips, publishing, status) | ✅ | `volt-app` - verify.sh 34/38, capture 34/34 2xx |
| schema.org `VideoObject`/`Clip` JSON-LD on VOD | ✅ | `schemaOrg.ts`; `/api/vod/:id/schema.org` |
| **Hypermedia / HATEOAS - JSON-LD + Hydra typed links, collections, entrypoint** | ✅ | Built 2 Aug: content-negotiated (`Accept: application/ld+json`); `hypermedia.ts` + middleware + `/api` entrypoint, `/api/context.jsonld`, `/api/doc`. 26/26 tests; plain JSON unchanged (34/38 regression clean). Cursor paging = follow-up |
| Source-provider API tiers (Delivery/Descriptive/Guide/Timed/Rights/Control) | 📐 | `metadata_source_provider.md`; doc delivered, no code |
| `BroadcastEvent` / `SportsEvent` output + SportsML-G2 ingest | 🧪 | `services/eventPromo.ts` (30 Aug): `SportsEvent` JSON-LD out (homeTeam/awayTeam/competitor/performer/superEvent/eventStatus/previousStartDate), plus the projection the player renders from the same captured bag, and `eventStatus` → `postponed`/`cancelled` phases. `test/event-promo.check.ts` 17/17. Outstanding: `metadata_schemas.target_kind` currently covers only things we STREAM (event/channel/vod), so a `SportsTeam` cannot be typed and `reference.refDomain` has nothing to resolve against, which makes the emitted `SportsTeam` JSON-LD an assertion the model does not back and makes SportsML-G2 ingest throw away the identifiers it was fetched for. Extend target_kind to things we DESCRIBE, then wire the projection into the player session. **5 Sep review, and it is worse than this row implied.** `target_kind` is still `vod | event | channel | any` from `0001_init.sql:395` — no migration extended it, so the `SportsTeam` gap is exactly as described. The sharper finding: **`services/eventPromo.ts` has no caller at all.** `presentationFromEventStatus`, `inferTemplate`, `promoFromMetadata` and `sportsEventJsonLd` are referenced by **zero** files in `volt-app/src`, and only by `test/event-promo.check.ts`. So the 17/17 green suite proves the *functions* are correct while nothing in the running application emits any of it: no route, no player session, no JSON-LD on the wire. Correctly 🧪 — a tested library awaiting a caller, not a feature. Wiring it is small (one route plus the player session payload); the `target_kind` extension is the half with a migration in it |
| Timed in-stream metadata (EXT-X-DATERANGE / SCTE-35 / ID3 / emsg) | ✅ | **Video. Built 5 Sep — `EXT-X-DATERANGE` is now emitted.** `services/timedMetadata.ts` annotates media playlists on the way out of `/origin`, so the schedule stays in Postgres and a rename or an override corrects itself on the next fetch instead of being frozen into a segment at encode time. Tags land in the header (a DATERANGE after an `#EXTINF` is a parse error, not untidiness), are idempotent across refetches, and a multivariant master cannot receive them because it has no PROGRAM-DATE-TIME to derive a window from. Quotes in a title are stripped rather than escaped — the attribute grammar has no escape for them. Fails open: an unreadable schedule serves a plain playlist rather than no playlist. `test/timed-metadata.check.ts` 37/37. **SCTE-35 and `emsg` are still to do.** Original note: Programme boundaries, ad markers and now/next carried in the DELIVERY stream, which is a video-asset concern: `EXT-X-DATERANGE` for programme and ad windows, SCTE-35 for signalling, `emsg` for the DASH equivalent. **Not the radio metadata path** — a station's now-playing arrives as ICY on the INGEST side and is already handled by `services/radio/icyMeta.ts` and `nowPlaying.ts`. The one genuine overlap is ID3-in-`emsg`, which can carry a track title on an HLS AUDIO rendition and is what would let an Icecast station's titles reach an HLS listener; scope that as a separate audio row when it is built, so the video work is not judged by it |
| **Now-playing resolution for sources that carry no metadata** | ✅ | **Audio.**  Built 5 Sep: `services/radio/nowPlaying.ts` makes one four-way decision (source title → scheduled programme → station name + reason → real break), used by the station list, the detail payload and the now-playing poll, which previously each decided separately and only one had every case. `sourceCarriesTitles()` lets the URL override the protocol column, so an `.m3u8` is HLS whatever the row says (same rule as `looks_like_hls()` in `radio.py`). Fixes an HLS station reading permanently as `Untitled break`, which is a claim that the source is *between* titles and sent operators looking for a metadata fault that does not exist. `test/now-playing.check.ts` 32/32, verified negatively at 30/2. `docs/REQ_now_playing_resolution.md` |
| Listener count = the whole audience, not the MP3 clients | ✅ | **Audio.** Built 5 Sep: `listenerCounts()` sums the MP3 fan-out clients and live player concurrency from `stream_concurrency` (across asset kinds, 120s freshness, matching the fleet total in `platform.ts`). The console previously rendered `p.mp3Clients.size` as "0 MP3 listeners", so a station with an HLS audience and no MP3 clients reported zero. Breakdown kept on `listenerCounts` for the tooltip; null still renders as no line rather than as a zero |
| **Automatic now-playing / EPG inference (broadcaster feed · fingerprint · transcript)** | 📐 | **Audio first, video later.** Designed 5 Sep, not built. The commercial answer to the case above, where a broadcaster hands us a URL and no schedule. Three routes — (a) fetch the broadcaster's own XMLTV/JSON guide: exact, but one bespoke adapter per network; (b) acoustic fingerprinting: high accuracy on released music, near zero on sport, speech and local programming, which is exactly what these stations carry; (c) transcribe the segments we already cut and infer: the only one that fits sport and talk, and the only one with a per-station-hour running cost. Shape that matters: **propose, never publish** — inferred programmes land as `proposed` with source and confidence for accept/reject in the EPG editor, ranked below an operator's schedule and above the station name; **detect the boundary before naming it**, since "the programme changed at 14:03" is cheaper and more useful than a wrong title nobody caught; billed per station, not a platform default. `docs/REQ_now_playing_resolution.md` §4 |
| API keys / app registration (account+app keys, playback token, per-app restrictions) | ✅ | Built 2 Aug: `apps`+`api_keys` (sha256, prefix), `apiKeys.ts` (gen/verify/restrictions/token), `/api/apps` + public `/api/availability` gate. 8 tests (origin enforce, 401/403, metering) |
| On-the-fly image service (resize/crop/filter by URL, cached · sharp) | ✅ | Prototype 3 Aug in `volt-image-proto/`: sharp service, URL grammar `/{fit}/{WxH}/filter(...)/{path}` - fit-in/fill/stretch + focus (center/edges/smart) + sharpen/blur/grayscale/format(webp/avif)/quality, HMAC-signed URLs, disk derivative cache (HIT 1.4ms vs ~150ms render). 14/14 assertions + gallery. `docs/DESIGN_image_service.md`. **Productionised 5 Sep review: this is in the app and serving.** `services/imageResize.ts` + `services/imageDims.ts`, `sharp ^0.35.3`, route `GET /img/<WxH>[,opts]/<store-key>` in `server.ts`, derivatives cached under the store's `derived/` prefix with `Cache-Control: max-age=86400, immutable`, origin served from `GET /library/*`. Grammar carried over: `fit` (cover|inside|contain|fill), `focus=X-Y`, `gray`, `blur=N`, `sat=N`, `q=N`, `fmt` (webp|jpeg|png). The console calls it through `thumbUrl()` in `volt-web/src/api.ts` → `/img/{w}x{h},{fit}/{key}`, and station and channel artwork renders through it (confirmed in live screenshots 5 Sep). **Two prototype features did not carry**: AVIF output, and *smart* focus detection — focus is now an explicit percent. **One real production gap remains: HMAC-signed URLs are not enforced.** The service notes it as hardening that layers on top and same-origin previews use it unsigned, so today anything that can reach the host can request an arbitrary derivative of any `library/` key. Sign before it faces the internet |
| Record edit API (PATCH partial + optimistic concurrency) + audit trail | ✅ | Built 4 Aug: shared `services/audit.ts` - `patchEntity` sends ONLY changed fields (null clears), bumps `version`, rejects stale writes 409 via If-Match/version; `created_by`/`updated_by`/`version` columns; `audit_log` diffs (from→to, by whom); `GET /:id/history`. Wired into channels, events, metadata-schemas (PATCH + PUT alias); pattern extends to any resource. verify.sh 38/38 clean + 23 edit-audit e2e |
| Live updates (admin real-time collaborative view) | ✅ | **Built 5 Sep.** `patchEntity()` publishes a `record` frame to the account's SSE hub after a committed change, and `liveStatus.ts` dispatches it; `liveRecord.tsx` turns it into a notice on any form holding a stale version. It lives in `patchEntity` rather than at each call site for the same reason the audit write does: one function changes a record, so one place can be certain what changed — a caller that had to remember would forget, as four call sites forgot `on_air`. **Only the SHAPE of a change travels** (columns, version, actor), never the values, so a frame cannot hand a viewer a field they may not read; the page re-reads through its own credential. Own-writes are suppressed by version, or every save would accuse the operator of conflicting with themselves. `test/live-record.check.ts` 24/24, including a structural assertion that fails if values ever reach the frame. Wired into the channel settings drawer; other editors are a one-line addition each. Public front-end live remains selective by design. Original note: Push committed field changes to other admins viewing the same record over the existing SSE hub + Postgres LISTEN/NOTIFY; version-conflict warning. Public front-end live = selective only: EPG now/next served from CDN + client advances at the known programme boundary + cache-tag purge on override (no per-viewer socket, so 500k viewers hit cache not origin) |

## 2. Production plane (encoder / packager)

| Capability | Status | Notes / source |
|---|---|---|
| package_only + transcode → CMAF → HLS+DASH | ✅ | real ffmpeg→Shaka, decodable |
| **Local-storage mode (encoder writes CMAF to disk, no S3)** | ✅ | Built 6 Aug: `encoder.py` `output.mode=local` → writes the ladder + HLS/DASH straight to a local origin dir (served at `/origin/<id>`) and **skips the S3 uploader**; `s3` block no longer required; per-job `UDP_BASE_PORT` so concurrent channels don't collide. Origin dir IS the live edge + DVR (`time_shift_buffer_depth`) + recording (`preserved_segments=0`). Unit tests + real e2e (HLS pull → 720/480/360 ladder → CMAF, decodable, DASH `timeShiftBufferDepth` honoured) |
| **Local thumbnailer mode (poster/storyboard/VTT to disk)** | ✅ | Built 6 Aug: `thumbnailer.py` `out_dir` → writes `poster.jpg` + `sb_NNN.jpg` sheets + `thumbs.vtt` locally, no S3; `accurate` seek path for CMAF fMP4 (Shaka's live playlists carry no ENDLIST). Verified against a real local encode (poster + 5×5 sheet + VTT). 4 new builder tests |
| Input failover + filler-on-loss (package_only) | ✅ | `source_selector.py` for primary/backup. **9 Oct:** the filler is no longer pushed through the packager (Shaka stopped on its codec change and took the channel down); it is a pre-built, source-matched loop spliced into the delivered HLS. `dev/wftest.sh vod_loop package_only`: primary→backup→loop→primary delivered, packager stays up, 0 stalls |
| SPEKE / Axinom DRM cbcs (client) | 🟡 | client coded; **not live-tested** against a SPEKE endpoint |
| Keyscreen thumbnailer (CPU) | ✅ | `thumbnailer.py`, 22 assertions |
| Status / events → control plane | ✅ | `events.py`, 16 assertions |
| Live captions / transcribe + translate (multi-engine sidecar) | ✅ | `bin/captions.py` - offset, HLS-aligned WebVTT segments, per-language tracks, final VTT. 3 engines: offline (tests) · **whisper** (self-hosted faster-whisper, no per-min cost) · gladia (paid). Extended 3 Aug: Whisper transcribes ~100 langs + native X→English; **NLLB-200 MT stage** adds all other targets (en↔ms, en↔zh, en↔ta proven with real espeak→whisper→NLLB run). Account master toggle `accounts.captions_provider` (none\|whisper\|gladia) gates it; jobConfig pins engine to the account. 33 unit tests. Live Gladia websocket adapter still stubbed (needs key+network). Workflow + engine alternative: `docs/WORKFLOW_captions_translation.md` **8 Oct: the 19 Aug one-clock sync fix had been overwritten (2f29a5d, then 0f1a6cd and a 30 Aug sync) and is restored; median sync -19.8s → +0.02s, 94% of cues within 1s. On the Mac the encoder ran with Homebrew python3, which cannot import faster-whisper; run-on-mac.sh now uses volt-encoder/.venv. See CAPTIONS.md** |
| Captions provisioning workflow (per-stream engine plan · whisper GPU add-on vs Gladia sidecar · sizing · launch/teardown) | ✅ | `captionsPlan.ts` + orchestrator: resolves none/gladia/whisper per stream, sizes GPU (T4 covers ≤large-v3+NLLB), launches whisper as its own `instances` row (role=captions) only when needed, torn down with the stream. 9 plan + orchestration tests. `docs/WORKFLOW_captions_translation.md` |
| Captions settings UI (account provider toggle + per-profile targets/model/offset) | ❌ | backend + master toggle done; the admin screen to enable it and pick languages is a follow-up |
| Transcode-workflow failover | ✅ | **Tested 8 Oct** with `dev/wftest.sh` (real encoder + Shaka, sources killed on cue): primary→backup→loop→primary and primary→backup→slate→primary both delivered segment by segment, 0 playback violations. Fixed on the way: the loop was read over HTTP and ffmpeg hung (no output during the whole outage), the slate filler ran unpaced at 6.7x realtime for the channel's whole life, loss detection 5s→3s and a 1s forwarder probe (output gap at a switch 16s→10s, inside the player's 12-14s live hold) |
| Zero-gap primary↔backup splice | ✅ | **9 Oct: manifest-level splice built for HLS and DASH** (`bin/playout.py`): when the live edge is three quarters of a segment late the delivered playlists carry the pre-built loop with a discontinuity, and `manifest_cc.mpd` carries it as its own Period. DASH Period boundaries are placed per track (audio and video segments do not end together), the one segment crossing a boundary is served cut to it (`bin/mp4util.py truncate`), and a track whose clock jumps gets its own boundary. Played in real Chrome with the console's hls.js and dash.js (`dev/browsercheck.mjs`): 0s frozen on transcode and package_only, both formats (52s stalled without). A source switch that takes longer than the hold shows one loop segment. Open: gpac stops following the live MPD at a Period change; one hls.js run in five froze 40s on package_only |
| Recording marks where the loop was on air | ✅ | **9 Oct.** The loop is not recorded, so an outage is a hole. `GET /api/recordings/:id/timeline` now returns `fallbacks` (from the run's `playout.jsonl`: from/to, loop or slate, source-lost or forced) and marks each hole `onAir`; the workbench draws an amber strip and a "Loop on air" count. Checked end to end through the API |
| Console player live position | ✅ | **9 Oct.** With captions off the console player sat 0.5s behind the newest segment, so any late segment froze the picture (6s at a splice, measured in Chrome). Now 12s, three segments, as hls.js/dash.js do by default (`ChannelDetail.tsx` `liveHold`) |
| Source probe + pre-built ladder-matched loop | ✅ | **9 Oct.** `bin/source_probe.py` (codec, profile/level, size, fps, bitrate, audio) stored on `stream_inputs.probe` when sources are added; `filler.build` job (`services/fillerPrep.ts` → `bin/filler_build.py`) renders the loop/slate to the ladder with the watermark and packages it once; `GET/POST /api/channels/:id/filler`. The encoder verifies it against its live output and rebuilds from that output if needed (push sources) |
| Watermark / bug overlay | ✅ | Built 15 Aug, extended 16 Aug (burn-in wired into the encoder + test harness `test-stream.sh`; the settings show for ALL channels, burn-in stays transcode-only and packaged channels get the preview overlay): per-channel burn-in on the transcode path (image, corner/edge anchor, px offsets, % size, opacity) with a live console preview. Now settable **on the create form** as well as settings. Packaging channels copy the source, so it is hidden there. |
| **HTML graphics overlays (scorebug · lower third · sponsor bug · ticker)** | 📐 | **Video only, radio explicitly out of scope.** Designed 4 Sep, not built. Templates are HTML on a fixed 1920×1080 stage bound to a small live **state document**; one template renders in three places (player DOM · console preview · burned into the encode) and a binding picks the targets. **Video workflows only, radio explicitly out of scope.** Grows out of the watermark row above: same `_overlay_vf` burn-in path, same `media_files` library, same jobs queue. Measured: template DOM update 0.9 ms/frame (45× realtime), so the cost is the *capture* pipeline, not the browser — capture the graphic's bounding box on state change, never the full frame at frame rate. Needs `encoder.py` `start_transcode()` moved from per-rung `-vf` to one `-filter_complex` composite before the ladder splits, so the blend happens once rather than per rendition. Sequenced player-side first, burn-in last. `docs/REQ_graphics_overlays.md` (requirements + workflows), `docs/DESIGN_html_graphics_overlays.md` (cost, measured), `docs/prototypes/graphics-bench.html` (client-facing prototype) |
| Ad markers (SCTE-35 · `EXT-X-DATERANGE` · `CUE-OUT`) | ❌ | **Video.** No ad signalling of any kind exists: a repo-wide search for scte/daterange/cue-out/vast/vmap returns nothing but `Array.splice`. The HLS writers already emit `EXT-X-DISCONTINUITY`, so the markers themselves are a small addition to code that exists. Prerequisite for server-side ad insertion, and the correct answer to "insert banner ads" — a burned-in banner is identical for every viewer and sells for a fraction of a targeted one |
| Channel brand image + description (identity, not burn-in) | ✅ | Built 16 Aug: `channels.brand_ref/brand_colour/description`. Set on create + settings from the Image Library; list thumbnail + detail header; served to guide clients via **`GET /api/epg/channels`** (id, name, icon, colour, description, medium) = XMLTV `<channel><icon/></channel>`. Doubles as station artwork for radio. Never reaches the encoder (asserted). |
| Multi-language audio tracks (probe -> per-track AAC -> manifest track picker) | ✅ | Built 16 Aug: `probe_audio_tracks` on the mezzanine, one AAC elementary stream per source track on its own port, Shaka descriptors with language + display name (first = default), player track selector + real level meter with volume/mute. |
| Audio-only (radio) channels | ✅ | Built 16 Aug: `channels.audio_only` + `audio_ladder`; `buildEncoderJobConfig` short-circuits both video workflows (no ladder, no GPU, one input, AAC rungs defaulting to 128k/64k); `encoder.py` audio path (`-vn`, N AAC renditions on the UDP bus) + audio-only HLS/DASH packaging; **Radio** nav section with `/radio` + `/radio/:id`. 13/13 `radio-brand.check.ts`. Open on this feature: dedicated Icecast input adapter + live waveform/level meter. |
| FairPlay HLS | ❌ | backlog |

## 3. Orchestration & infrastructure

| Capability | Status | Notes / source |
|---|---|---|
| Orchestrator lifecycle → ECS (mock+ecs), recordings, retention, scheduled-clip firing | ✅ | `orchestrator/`, 30 assertions |
| **Local launcher - real encoder.py/thumbnailer.py as on-box child processes (no AWS)** | ✅ | Built 6 Aug: `orchestrator/localLauncher.ts` implements the `TaskLauncher` interface, so **all** orchestrator wiring (recordings open/close, thumbnailer-on-stop, retention, day-roll) is reused unchanged. `ORCH_LAUNCHER=local` selects it. `launchEncoder` injects `output.mode=local` + per-stream UDP port + `WORK_DIR=origin/<id>`; `stopTask` SIGTERM→SIGKILL; `launchThumbnailer` picks the hi-res rendition, synthesizes a VOD (ENDLIST) playlist over the on-disk segments, and runs the real thumbnailer. TS integration test drives the real encoder end-to-end (12/12): ingest→ladder→CMAF (HLS+DASH), clean stop, poster+sheet+VTT. **This closes the mock/ecs-only gap - the real encode/package/DVR/record/thumbnail pipeline now runs and is testable locally.** `run-on-mac.sh` auto-enables it when ffmpeg+python3+Shaka `packager` are present |
| **App surfacing: channel Start → real local encode, played back in ChannelDetail** | ✅ | Built 6 Aug: channel **Start** already calls `orchestrator.startStream`; with the local launcher it now spawns the real encoder to `/origin/<id>`. Status endpoint probes the origin on disk (fresh `master.m3u8`) so `testStream.running` fires for the real encoder too - the existing hls.js player + DVR scrubber play it with **no UI rewrite**; a `REAL ENCODER · x264 → CMAF` badge distinguishes it from the test card; `producer`/`poster`/`thumbsVtt` added to the status payload |
| Terraform Tier-2 cloud stack (VPC/ECS/RDS/S3/CloudFront/ECR/ALB/Secrets) | ✅ | `deploy/terraform/`, `terraform validate` clean (apply needs AWS creds) |
| S3 retention cleanup (delete objects on expiry) | ❌ | DB row deleted; S3 sweep is a TODO |
| vod-extractor - real clip stitch / progressive concat / MP4 export | ✅ | Built 2 Aug: `vod-extractor-job.ts` + `tools/extract-clip.ts`. Manifest trim + multi-recording concat + progressive MP4 (ffmpeg -c copy). e2e/extractor-test.sh: MP4 decodes h264, exact 8s. S3-upload of outputs + ECS launch = wiring follow-up |
| Tier-3 scaling & chaos harness | ❌ | planned on top of Tier-2 |
| **Relay tier in the fleet — `relays` + relay accruals (migration 0021)** | ✅ | The Icecast relay was a single `ICECAST_HOST:PORT` in the environment, which left three questions unanswerable: which relay is this station pointed at, how is it doing, and what does it cost — so the fleet page implied it was free. Everything needed already existed for encoders and was simply not pointed at the relay: `compute_hosts` for identity and first/last seen, `host_samples` for cpu, memory and network in/out, and the rates table whose prices stay flagged `indicative` until contracted ones replace them. **Two gaps remain**: `max_listeners` is stored and read by nothing, and there is no relay UI (the API exists behind `requirePlatform`) |
| Relay capacity and load balancing across relays | 📐 | Measured, decided, not built. Icecast package defaults are `<clients>100</clients>` and `<sources>2</sources>`; at 128 kbps a listener is 16 KB/s, so 1 Gbps ≈ 6,200 concurrent at 80% utilisation. The finding that settles the design: **a CDN cannot cache an endless stream**, so every edge holds an origin connection per listener and MP3 does not fan out the way HLS does. Self-served MP3 on inclusive bandwidth is ~6× cheaper per listener-hour than CDN-delivered HLS; AWS egress is the expensive combination. `docs/DECISION_mp3_delivery.md` |

## 4. Media & data

| Capability | Status | Notes / source |
|---|---|---|
| Recordings (channel-day/event, retention→expiry) | ✅ | `recordings.ts` + orchestrator |
| VOD library + custom metadata schemas (validated) | ✅ | `vod.ts`, `metadataValidator.ts` |
| Multi-recording compose-clip (`clip_spec`) | ✅ | extractor renders it - `vod-extractor-job.ts` composes across recordings w/ discontinuities; 16 unit + real-media e2e |
| Intro / outro cards on published assets | 📐 | **Video.** Designed 4 Sep, not built. Render the card to the target asset's **exact** encoder parameters, then join with `-f concat -c copy`. Measured: a 13 s join took **0.109 s** and produced exactly 75 + 250 = 325 packets, so a one-hour asset is effectively free and the body is never re-encoded. The trap, also measured: a parameter mismatch joins anyway, **exits 0**, and yields a file reporting 90.9 s and the wrong resolution — so the publish step must verify packet count against the sum of the parts before anything ships. Social cut-downs re-encode regardless, so burned graphics are free there. `docs/DESIGN_html_graphics_overlays.md` |
| Slates & loops (filler assets) | ✅ | `fillerAssets.ts` |
| Publishing + social + view tracking | 🟡 | data/records/views real; social OAuth upload is a **stub** |
| **Publish / share a clip to social media** (YouTube/Facebook/X/TikTok/Dailymotion) | 🟡 | Foundation built: `publish_targets` (linked account per platform) + `publications` (per asset×destination, status, external URL, views) + `/api/publish-targets` + `/api/publications` (publish + sync-views). Platform enum covers portal+5 socials. **To deliver:** per-platform OAuth app + token exchange, real upload adapter (video + title/description/thumbnail from the clip's metadata), real view-count sync, and a "Publish to…" UI. Needs each platform's developer app credentials. Workflow: `docs/WORKFLOW_social_publishing.md` |
| Social publishing UI integration (Publish to… action · target picker · caption editor · connected-accounts screen) | ❌ | the clip-side action + settings screen to link accounts and post; backend APIs (`publish-targets`/`publications`) already exist. `docs/WORKFLOW_social_publishing.md` |
| Frame-accurate media access (scrub any frame · JIT clip · no proxies) | 🟡 | Prototype 3 Aug in `volt-frame-proto/`: frame index over the chunked origin + JIT single-frame pull (frame-accurate, MAD 0.02 vs ground-truth decode) + JIT clip (exact 76-frame cut across segments) + WebVTT sprite scrub + HLS I-frame trick-play playlist + browser scrubber. 15/15 assertions. Standards-based design-around (no per-frame storage; open formats + prior art). `docs/DESIGN_frame_access.md`. **5 Sep review — half of this shipped and the other half was REPLACED rather than ported, which is worth being explicit about.** **Built and in daily use:** frame-exact cutting. `services/clips/resolve.ts` holds the segment index with each segment's *measured* true duration (the encoder targets 4s and lands where the keyframe lands), and `services/clips/extract.ts` puts `-ss` **after** `-i` — decode-and-discard output seeking, which is precisely what makes the cut frame-exact rather than keyframe-exact; input seeking would be faster and would land on the preceding keyframe. Driven by `modules/timeline.ts` (three-lane coverage API) and the clipping workbench, covered by `clip-extract.check.ts` and `clip-provenance.check.ts`. **Not built, and replaced by a different approach:** the prototype's JIT random access. There is no frame-index table in any migration, no single-frame pull endpoint, and no `EXT-X-I-FRAME-STREAM-INF` trick-play playlist anywhere in `volt-app` or `volt-encoder`. Scrubbing is served instead by `services/waveform.ts` and `services/thumbs.ts` (waveform buckets + filmstrip), which is cheaper and answers the editor's actual question. **Still genuinely open:** smart render — every cut needing a trim is a `full-render` today, and `extract.ts` already carries the `copy` vs `full-render` strategy split plus a note naming which segments a smart render would re-encode, so the seam exists. Phase 3 (NLE integration) unchanged |
| Image Library / file manager (watermarks · slates · posters · brands) | ✅ | Built 6 Aug: `media_files` + `media_folders` (account-scoped, hierarchical path/folder, kind, tags, dims). **Storage-driver abstraction** `services/imageStore.ts` - `local` base dir (IMAGE_STORE_DIR) for local runs, `s3` bucket+prefix for cloud (`@aws-sdk/client-s3`); curated `library/` vs generated `derived/` prefixes. `/api/files` - list/browse/search (folder/kind/q/tag), folder tree + create, base64 upload (dependency-free PNG/JPEG/GIF/WebP dimension probe), rename/move (moves the object), **guarded+audited delete** (428 confirm + in-use guard). Serves `/library/*` from the store = the image-resize origin. React **Image Library** browser (folder tree + grid + upload + search + delete-confirm). Backend verified end-to-end. Direct-to-S3 presigned upload = cloud-scale follow-up; slate/brand picker wiring into forms = next. `docs/DESIGN_file_manager_watchfolder.md` |
| Watchfolder ingest (assign a folder or S3 bucket/prefix as an auto ingest source) | ✅ | **Complete for local folders 6 Sep: schema, rules, quarantine, scanner, ingest, API and console.** Migration `0029_watchfolders.sql` adds `watchfolders`, `watchfolder_rules` (ordered, first match wins) and `watchfolder_items` — deliberately ONE table for the idempotency log and the QC queue, because they are the same fact seen twice, and splitting them is how a quarantined file gets re-quarantined on every scan. **The requirement that shaped it: a file that matches nothing is neither ingested as `other` nor deleted.** It is moved to a review path, the reason is STORED (not recomputed against rules somebody has since edited), and a person corrects, reclassifies or removes it. `services/watchfolder/rules.ts` is pure, so the same function answers "what would happen to this file" for the console's dry run and "what happens" for the scanner — a dry run with its own copy of the logic would be worse than no dry run, because it would be confidently wrong. Hygiene runs before the rules: `.DS_Store`, `~$` locks, `.part` uploads still copying, and the quiet one, a correctly-named **zero-byte** file from a failed copy. `services/watchfolder/scanner.ts` walks the folder, never descends into the quarantine path, only considers files whose mtime has been QUIET for `min_age_ms` (a file copied under its final name is briefly a truncated file with a perfectly good name), dedupes on **name + content** so a corrected re-drop is a new item rather than a silent no-op, and moves a refused file BEFORE writing its row. `services/watchfolder/ingest.ts` turns an accepted item into a `media_files` record: it **re-hashes the file first**, because the row's checksum is a claim about the past and an operator can drop a corrected version over the top between passes; a file that has moved is closed as `failed`, not left at `seen` to be re-read on every pass forever. Bytes go to the store BEFORE the row, so the failure mode is an orphaned object rather than a library record pointing at nothing; a name collision is suffixed rather than failed, since `media_files` is UNIQUE on (account_id, path) and refusing the second is a file that can never ingest; and a target the image library cannot hold (`vod`, `loop`) is **deferred to its own workflow, never coerced into `other`**. The item is also **claimed atomically** before any bytes move, because the 60s tick and the operator’s Scan button are two callers over one queue: guarding only the closing UPDATE is too late, since by then both have written a library record and the second is suffixed, reading as though the file was dropped twice. `/api/watchfolders` gives folders and rules CRUD, a dry run, scan-and-ingest, the item queue, and reprocess/remove. Console **Watchfolders** page (Media): numbered movable rules with the winning rule highlighted, the filename dry run, Scan now, and the review queue where Dismiss says on the button that the file is left where it is. Scanned and ingested every 60s by the orchestrator, on its own error boundary. `test/watchfolder-rules.check.ts` 43/43, `test/watchfolder-scan.check.ts` 33/33 against real files, `test/watchfolder-api.check.ts` 26/26 against a real Postgres, `test/watchfolder-ingest.check.ts` 70/70 — each verified negatively by reverting the guard and confirming the suite fails. **Remaining: S3 event-driven acquisition (EventBridge/SQS ObjectCreated + reconcile scan), and the VOD/loop ingest targets, which are their own workflows.** `docs/DESIGN_file_manager_watchfolder.md` |
| File-based video encoding (upload or watchfolder → encode job on the live ladder) | ✅ | **Complete 6 Sep: engine, both ingest paths, and the console.** The requirement was that a file encode MATCH the live transcoder, and the way that is achieved is the whole design. Copying the live rungs into a VOD ladder is correct on the day it is written and wrong for the rest of the system's life: somebody re-tunes the live 720p rung, both encodes keep succeeding, both outputs still look plausible, and the only symptom is that the two disagree. So `0030_encode_profiles.sql` adds `encode_profiles` (one rendition) and `encode_ladder_groups` (a named ordered set), and a group can **track** a live `output_profile` rather than copy it: it holds no rungs, reads them at encode time, and takes the tracked profile's segment length and fps too, because GOP = segment × fps and a different GOP puts the keyframes somewhere else. Verified against a real Postgres: change the live profile, the file ladder follows with no write of its own. The per-rung ENCODER settings (preset, maxrate 1.1×, bufsize 2×, GOP, sc_threshold, forced keyframes, AAC 128k) were inline in `encoder.py:start_transcode`; they are now `volt-encoder/bin/ladder_args.py`, imported by the live path and the file path alike, and the extraction was proved byte-identical against a captured golden for both x264 and NVENC. `dev/test_ladder_args.py` reads the source and fails if either caller starts building them by hand — verified by putting back a hand-rolled copy that produces IDENTICAL arguments today and confirming it still fails. `bin/vod_encoder.py` probes, encodes every rendition in ONE ffmpeg pass (N passes decode the source N times) and packages CMAF HLS+DASH; proved end to end on a real 720p source: three renditions with keyframes at identical timestamps, `EXT-X-PLAYLIST-TYPE:VOD`, `mediaPresentationDuration=PT12S`. **A real bug caught in that run:** the HLS playlist was VOD and the MPD was `type="dynamic"` with a 30-minute `timeShiftBufferDepth` over a 12-second file, because Shaka takes two different flags and only one was set — checking the HLS playlist and concluding the package was right is being correct about the wrong question. `services/encode/ladder.ts` fits the ladder to the source: never upscale, and a **height that was not measured is not a height of zero** (zero drops every rung and produces an asset with no renditions while the log claims the source was tiny). A source below every rung adapts the lowest rung to the source's own height rather than encoding nothing and reporting success. `vod.encode` runs on the durable jobs table; the watchfolder's `vod`/`loop` targets stop being deferred, with `loop` registered as a filler and NOT laddered because its consumer re-encodes it anyway, and the source **copied out of the drop folder before the job is queued** so an operator tidying the folder cannot break a job that was accepted. `test/encode-ladder.check.ts` 50/50, `test/watchfolder-video.check.ts` 53/53, `dev/test_ladder_args.py` + `dev/test_vod_encoder.py` 30/30, each verified negatively. Console: **Media → Encoding Profiles** manages renditions and ladders, shows a tracking ladder's resolved rungs with where they come from, and previews which rungs a given source height would get through the SAME `fitToSource()` the encode runs. Ladder pickers on the watchfolder detail and the Media Library upload panel; the library row shows the encode's live state and, once done, the rungs kept and dropped. `0031_vod_uploads.sql` links an upload session to its VOD asset so a two-hour upload is visible and can be watched to fail while its bytes are in flight, with a CHECK that a session points at one asset, not two. **A bug caught while wiring the library:** `vod_assets` ownership was an INNER JOIN through the channel or event, correct while every asset came from a recording and silent death for one that does not — uploaded assets would have encoded successfully and then never appeared in any list. Now a LEFT JOIN with `COALESCE(g.account_id, v.account_id)`, verified against a real Postgres: the old join found 0 uploaded assets, the new one finds them, recording-derived assets are unchanged, and another account still sees none. `test/encode-store.check.ts` pins the assertion the feature rests on — re-tune the live profile, re-read the ladder, and it has changed with no write of its own. **Remaining: S3 watchfolders, and a re-encode action on an asset whose ladder later changes.** |
| TAMS - Time Addressable Media Store API (BBC/AMWA open standard, Apache 2.0) | 📐 | Strong fit: our CMAF-segments-in-S3 + Postgres segment index already = TAMS essence + metadata planes; recordings/renditions/segments → Sources/Flows/Flow Segments/Media Objects; non-destructive clip = TAMS edit-by-reference (copy-on-write). Plan: read-side API first (`GET /flows` + `/flows/:id/segments?timerange=` → presigned S3 URLs) over the frame-access segment store, then write-side (storage + segment register); add TAMS nanosecond-TAI timerange layer + account scoping. Interop: AWS MediaConvert accepts TAMS input. Complements frame-access (TAMS = store/API; frame index = frame-level read) |

## 5. Domain model & taxonomy

| Capability | Status | Notes / source |
|---|---|---|
| Two-plane composition (production vs distribution) | 🟡 | `domain_model.md`; backend has the pieces piecemeal, not formally modeled |
| Unified spine + origin×lifecycle presets (Channel/Event/FAST/Loop) | 📐 | `product_positioning.md`; code paths not unified |
| Metadata schemas assignable to events/channels (not just VOD) + schema compose/extends + `reference` field type | ✅ | Built 2 Aug: `target_kind`/`domain`/`extends_id` on schemas, `schema_id`+`metadata` on channels/events, `mergeFields` composition, `reference` type, `resolveEffectiveFields`. 9 tests; caught+fixed a forward-FK bug |

## 6. EPG & scheduling

| Capability | Status | Notes / source |
|---|---|---|
| Scheduled clips (timeline → auto-VOD at end) | ✅ | `scheduledClips.ts` + orchestrator fires it |
| EPG programme store, RRULE recurrence, materialized instances, conflict detection | ✅ | Built 2 Aug: `programmes`+`programme_series` (tstzrange span, GiST/GIN idx), `epg.ts` (RRULE expand, effective-end), `/api/epg` (guide/now-next/conflicts/series). 7 pure + 6 HTTP tests |
| FAST playlists / VOD→Live playout (PlaylistInput origin) | 📐 | designed; not built |
| Notification API (event→recipients→channels, templated, retries) | ✅ | Built 3 Aug: `notifications.ts` + `/api/notifications` (send/inbox/retry) + templates. Fan-out to recipient×channel deliveries, email/push adapters (stub), delivery log + retry. 9 tests |
| Auto-VOD metadata harvest + non-destructive re-trim | ✅ | Built 3 Aug: `deriveEventVod` harvests event schema+metadata → full-event VOD on recording end (wired in orchestrator); `PATCH /api/vod/:id/trim` re-cuts a clip's in/out, recording untouched. 8+8 tests |

## 7. Geo / rights / delivery

| Capability | Status | Notes / source |
|---|---|---|
| Geo/rights evaluation in the play gate (blackout per current programme) | ✅ | Built 3 Aug: `rights.ts` + wired into `/availability` + `/access/check`; block/allow-list by country. 7 tests. (Edge CloudFront-Function switching still prototype) |
| Program replacement (blackout → replacement asset) | ✅ | Built 3 Aug: blocked region gets the programme's replacement asset + a playback token for it. Tested |
| CloudFront native geo-restriction | 🟡 | **Placeholder removed 5 Sep.** Was a hardcoded `restriction_type = "none"`; now driven by `var.cdn_geo_restriction_type` (validated `none|whitelist|blacklist`) and `var.cdn_geo_countries`, defaulting to `none` so behaviour is unchanged until somebody sets it. **Stays 🟡 on purpose, and the reason matters before anyone treats this as the geo feature.** CloudFront applies ONE country list to the WHOLE distribution, so it cannot express "this programme is blacked out in these markets" — that is what `rights.ts` already does per-programme in the play gate, with a replacement asset for a blocked viewer. What this buys is a hard edge stop for a country we must not serve at all (a sanctions list, a licence held nowhere): enforced before a request reaches the origin and not dependent on our token logic being right. It cannot go ✅ until a `terraform apply` has happened, and nothing has ever been applied |

## 8. Analytics & reporting

| Capability | Status | Notes / source |
|---|---|---|
| Server-side audience/QoS/realtime from CDN logs; by-app lead; no-referrer VPN classification | ✅ | Built 2 Aug: Postgres serving layer (`play_sessions`, `analytics_rollups`, `stream_concurrency`), UA/referrer parsing, beacon ingest (playback-token), reports (realtime/asset/audience/usage). CloudFront→Kinesis firehose = scale path. 6 tests |
| WAF enforcement (paid add-on) | 📐 | designed; not built |
| **Air ledger — `air_sessions` (migration 0023)** | ✅ | Built 5 Sep. "Total hours on air" had no defensible source: a channel going on air ran a bare `UPDATE channels SET on_air` and left no trace, radio wrote a `stream_events` row an operator can now clear with a button, and an event's `public_start`/`public_end` are a PLAN written at creation. One row per window of public delivery; `to_at IS NULL` means on air now, so one table answers the live question and the historical one. Identity is snapshotted and FK-free (as `usage_accruals` does) so the record outlives the stream, and a rename does not rewrite history. A partial unique index `(stream_id) WHERE to_at IS NULL` is the invariant: overlapping windows double-count and every row still looks correct. `services/airSessions.ts` owns the column AND the ledger together, because four call sites used to write `on_air` and already disagreed about whether to record anything; `test/air-sessions.check.ts` reads the source and fails if a fifth appears. 37/37. `docs/REQ_stream_reporting.md` |
| Per-stream operating report (runs, hours run vs hours on air, peak concurrent) + CSV | 📐 | Requirements written 4 Sep, endpoint not built. Runs and hours-run come from `usage_accruals` (durable, survives channel deletion); hours-on-air now has the ledger above. The remaining design constraint is peak concurrent, which is exact from `play_sessions` only inside the raw retention window and daily-only from `analytics_rollups` after it — so the report must return **null meaning "not retained", never zero**, or a four-month-old run reading `Peak 0` invites exactly one conclusion and it is the wrong one. `docs/REQ_stream_reporting.md` |
| **Listener sessions — measured MP3 egress (migration 0022)** | ✅ | The only place egress is a fact rather than an estimate. Every earlier figure was bitrate × assumed duration, or a host's `net_out_bps` integrated and divided among whichever stations shared the box — an estimate of an estimate. The on-demand gateway terminates the listener connection itself, so it WROTE every byte it reports: one row per listener, closed on leave, with the measured count. Makes per-station and per-account relay cost answerable for pricing. No IP stored; `ip_hash` is salted and truncated |
| Listener count = the whole audience, not the MP3 clients | ✅ | Built 5 Sep: `listenerCounts()` sums MP3 fan-out clients and live player concurrency from `stream_concurrency` (across asset kinds, 120s freshness, matching the fleet total in `platform.ts`). The console rendered `p.mp3Clients.size` as "0 MP3 listeners", so a station with an HLS audience and no MP3 clients reported zero. Breakdown kept for the tooltip; null renders as no line rather than a zero |

## 9. Frontend

| Capability | Status | Notes / source |
|---|---|---|
| Site-wide search (channels · events · recordings) | ✅ | Built 16 Aug: `GET /api/search?q=` account-scoped across the three entities (defensive per entity), top-panel field with a debounced results dropdown that navigates on click. |
| Radio section (audio-only scope) | ✅ | Built 16 Aug: `/radio` + `/radio/:id` reuse the channel list + detail at the audio scope, station wording, audio-ladder column and editor, create form with artwork + AAC rungs. |
| **Auto connect is armed by a healthy run, not by pressing Start (migration 0024)** | ✅ | Built 4 Sep. `desired_state='running'` was written the moment Start was pressed and the resume pass read that as licence to relaunch, so a channel whose **first** start failed (wrong source URL, relay never running) was relaunched five times twenty seconds apart before anyone could read why — each relaunch overwriting the log with a fresh identical failure, burying the one reason the operator needed under four copies of itself. `resume_armed_at` is now stamped by the health pass the first time SERVER, INPUT, ENCODER and OUTPUT are all healthy at once. Until then a fault is a failed start and is left exactly where it fell |
| Operator can put down a give-up notice, and clear the event log | ✅ | Built 4 Sep: `POST /radio/:id/clear-recovery` and `DELETE /radio/:id/events`. The trap in the first: `resume_gave_up_at IS NULL` is one of four conditions for auto connect and a FAILED stream still carries `desired_state='running'` deliberately, so clearing the give-up alone hands the crash loop straight back. Dismissing is an acknowledgement, not a retry — it clears the give-up **and** stands the intent down. The trap in the second: a cleared log must not read as a log of nothing, so the delete is followed by one `log.cleared` entry naming the actor and the count, with its own audit row because the event log cannot be its own witness. `test/station-clear.check.ts` 25/25 |
| Recovery notice styling and placement | ✅ | Built 5 Sep: full transparent-red panel matching the primary-error banner rather than a card with an offset left rule, and moved from above the breadcrumb to under the channel header, where it sits with the other failure banners on both the channel and station pages |
| Monitoring: fleet activity reads as events, not as a wall | ✅ | Built 4 Sep: `activityLog.ts` collapses runs of the same owner+type+detail into one row with a `×9 over 1m` badge, and shows an absolute clock as the primary with the relative time underneath. One station appearing nine times in a feed was a repeated heartbeat rendered as nine incidents. Root cause fixed too: `packager()` in `volt-encoder/bin/events.py` emitted an event on **every** heartbeat call — a level reported as an edge — and now only fires on transition. 24 + 13 assertions |
| Recordings counts computed before filtering | ✅ | Built 4 Sep: the tab counts were derived from the already-filtered list, so "Recording now" read 0 while a station was demonstrably capturing. Counts are computed on the mapped set and the filters applied after. `test/recordings-counts.check.ts` 29/29, verified negatively at 19/10 |
| Now-playing line for sources that carry no metadata | ✅ | Built 5 Sep: see §6. Station metadata and the received-metadata log now show what the station **is** rather than four zeros and an apology, for sources that structurally cannot fill them |
| Docker check and start step in `run-on-mac.sh` | ✅ | Built 4 Sep: five steps with `ensure_docker()` (Docker Desktop / OrbStack / colima, 90s wait), an Icecast liveness probe on the Server header, `lsof` on a port conflict and `docker logs --tail 12` on a timeout — so a station whose MP3 output silently failed because nothing was listening on 8000 now says so before the run starts |


> **App-surfacing coverage** (tracked per-feature in `feature-tracker/features.json` via the `app_surface` field → the *volt-feature-tracker* artifact). Many capabilities below are ✅ *at the API/engine level* but **not yet wired into the React app**. In-app now: Channels list + create (transcode/package), **Radio (audio-only) list + create**, Channel detail/control page, **channel brand + watermark on create/settings**, **share-preview links (create, email, QR, extend, rotate, revoke)**, Test stream + playback + subtitles, Deep-link routing; Ladder profiles (in build). Backend-built but **not in app yet** (do not lose): social publishing, full captions settings. *(Corrected 6 Sep: **watchfolder** and **live-updates** are now surfaced — watchfolders through the Media → Watchfolders page, live updates through the foreign-edit notice in the channel settings drawer.)* *(Corrected 5 Sep: **image service**, **frame-accurate cutting**, **EPG**, **analytics**, **file manager** and **SaaS admin** are all now surfaced in the console and were wrongly still listed here — the image service through `thumbUrl()`, frame-accurate cutting through the clipping workbench and the three-lane timeline.)* These are carried as `app_surface: none` in the tracker so the gap stays visible; removals require a formal confirmation and are struck from both this doc and the tracker.

| Capability | Status | Notes / source |
|---|---|---|
| ~~Admin prototype (single-file HTML)~~ | ✅ | **Superseded and removed.** `volt_admin_prototype.html` is no longer in the tree (checked 5 Sep). Replaced by the real console: `volt-web`, 25 pages, 48 files, 18.6k lines. Kept as a row rather than deleted so the replacement is on the record |
| Nav architecture / wireframes / concept screens | 📐 | design artifacts |
| Custom Live Timeline (vanilla) | ✅ | **React port done** (checked 5 Sep): `volt-web/src/SourceTimeline.tsx` and `volt-web/src/ClipTimeline.tsx`, self-contained and shared, used by `RecordingSource.tsx` and `RecordingDetail.tsx`. Backed by `modules/timeline.ts`, which returns media coverage, broadcast days, daypart strips and what was on air **in one response**, so the three lanes cannot disagree about where a boundary is — which they would if each fetched separately and one was a request behind. Bounded to the visible window, and the window is capped, so zooming out cannot become an unbounded query |
| **Runnable local test console** (login + all tabs wired to the live API) | ✅ | Built 3 Aug: `public/console.html` served at `/console`; `run-local.sh` one-command (reset+seed+boot); `TEST_TONIGHT.md`. Verified end-to-end in browser |
| **Real React + TS + Vite + Tailwind admin app** | ✅ | Built 5 Aug: `volt-web/` scaffolded on the Volt Stream Concept design system (grouped sidebar, bolt logo, dark control-room palette). Channels section wired to the live API - empty state, filter chips, create drawer (transcode/packaging + DVR window + Whisper captions), list. Runs via `run-on-mac.sh`. **5 Sep review: the "other sections are placeholders" clause was a month stale and is withdrawn.** `volt-web/src/pages/` holds **25 pages, 11,929 lines**, and a sweep for placeholder / coming-soon / not-implemented markers returns nothing (the only two hits are a comment about an embed key and one about a missing-artwork fallback). The smallest page is `Epg.tsx` at 131 lines. The app is the product now, not a scaffold |
| Channel detail / control page (React) | ✅ | Built 5 Aug: dual source/output players, EPG now/next, realtime viewers chart, output+source status board + rendition ladder, event log; **editable settings drawer** (source ingest, source geo rules, DVR window ≤4h / mode, subtitle targets, retention) via optimistic-concurrency PATCH + audit. Per-channel DVR window (`channels.dvr_window_sec` ≤4h CHECK, `dvr_mode` sliding\|event_start) + source geo (`geo_mode`/`geo_countries`). Telemetry is representative pending live wiring |
| **Test stream, real playback & live subtitles** | ✅ | Built 6 Aug: one-click per-channel test stream - `volt-encoder/bin/test-stream.sh` runs FFmpeg to generate a real live HLS/DASH ladder from a test card (burnt clock+tone); `bin/test-captions.mjs` writes a live-growing WebVTT per language (EN/MS/ZH/TA sample; real-Whisper mode via `captions.py`). Control plane serves `/origin/<id>/…` (m3u8/mpd/m4s/vtt); `POST /api/channels/:id/test-stream {start\|stop}` spawns/kills on the API host. Output player plays it for real with **hls.js**, live subtitle overlay + language switch, and DVR scrubber seeking the HLS timeline. Generator + captions + origin serving + start/stop validated; in-browser H.264 playback runs on Mac Chrome/Safari (headless CI can't decode H.264). Needs `ffmpeg` on the host. **5 Sep review: still wired and still surfaced** — `test-stream.sh` is present, `POST /api/channels/:id/test-stream` is mounted for both start and stop in `channels.ts`, `testStreamStart`/`testStreamStop` are in the console client and `ChannelDetail.tsx` reads `d.testStream`. Reclassified from prototype to built: it is a shipped operator feature, not a mock. **Its original purpose is largely served by something better now** — the local launcher runs the *real* encoder against a real source, so the test card is what you reach for when you have no source to point at, rather than the only way to see a stream |

## 10. SaaS platform layer

| Capability | Status | Notes / source |
|---|---|---|
| Multi-tenant isolation (every API filtered by account_id) | ✅ | Built + audited 2 Aug; cross-tenant isolation test (account A can't see B's data). `docs/SAAS_ARCHITECTURE.md` §2 |
| Analytics data store (clearly defined) | ✅ | Postgres serving + S3/Athena raw + Redis/Timestream realtime; documented in `SAAS_ARCHITECTURE.md` §1 |
| SaaS-admin vs client-admin roles | ✅ | `platform_role` on users + `requirePlatform` middleware (saas_admin/support/read_only). 4 auth tests |
| SaaS-admin dashboard (servers/perf, upcoming events, projected instances, active channels, viewers, admins, API status, tickets) | ✅ | `/api/platform/overview` + `/accounts`. Cross-tenant aggregation. Tested |
| Support tickets (client file + SaaS triage) | ✅ | `support_tickets` + `/api/tickets` (client) + `/api/platform/tickets` (triage). Tested |
| Account impersonation ("view as") | 🟡 | **Backend built and audit-logged; the hold is a decision, not a gap.** `POST /api/platform/impersonate/:accountId` in `modules/platform.ts:202`, behind `requirePlatform` + TOTP, writing a `platform.impersonate` row to `audit_log` on every use. What is missing is only the console affordance — no "view as" control exists in `volt-web`, deliberately, **deferred past initial deploy** per your call. Related and worth keeping in view: `auth/jwt.ts` records that the pre-MFA challenge token once reached this route, which is why `typ` is now checked on every access token. Stays 🟡 because a feature an operator cannot reach is not shipped, but nothing here is unfinished code |
| SSO - Microsoft / Google (OIDC) | 📐 | `identity_providers` schema + flow plan in `SAAS_ARCHITECTURE.md` §4; OIDC exchange built next |

## 11. API access control (public vs admin, keyed)

| Capability | Status | Notes / source |
|---|---|---|
| Public vs admin API classification (map + enforced) | ✅ | `docs/API_ACCESS_MAP.md`; every route tagged public/admin/platform/ingest. Enforcement test 17/17 |
| Content filtered by account key - no cross-tenant access | ✅ | admin credential → one `account_id`; every query filtered; isolation + ACL tests |
| Dual-credential admin auth (session OR account secret key) | ✅ | `requireAuth` accepts JWT or `sk_live` (mgmt scope); publishable keys refused for admin. Tested |
| Public play surface: get-play-URL + check-access | ✅ | `/api/availability` (mints token) + `/api/access/check` (booleans); publishable-key auth |
| Share page - secure time-boxed standalone preview link | ✅ | Built 3 Aug: `share_links` table + `shareLinks.ts` + `/api/share-links` (create/list/revoke, account-scoped) + public `/share/:token` isolated page (`sharePage.ts`) + `/api/share/:token/resolve`+`/download`. Time-boxed, revoke, max-views, optional PIN, watermarked preview, allow-download (hi-res/metadata) + notify-on-open, geo/rights enforced, cross-tenant isolated. Renders to the supplied mockup. 20 e2e assertions. Workflow: `docs/WORKFLOW_share_page.md` |
| Share preview drawer + link management in the React app | ✅ | Built 16 Aug: two-step drawer on channel detail (set up → created link). Recipients + **email the one-time URL** at create/rotate, expiry preset **or an exact date/time**, PIN (generate/clear, min 3), view cap, watermark + notify-on-open toggles, note. Created step shows copy, open, **QR** (`volt-web/src/qr.ts`, dependency-free, verified against a real reader), expiry countdown, PIN reminder, delivery count. Link list per channel: view stats, last opened, recipients, **extend**, **new URL (rotate)**, revoke. API gained `PATCH /api/share-links/:id`, `POST /:id/rotate`, `?resourceKind&resourceId` filtering, `has_pin`. 42 assertions in `share-links.check.sh`. `docs/WORKFLOW_share_page.md` |
| Sub-accounts (parent → child subtree) | 🟡 | `accounts.parent_account_id` + `accountSubtree()` helper (8 tests); per-query subtree wiring = follow-up. **5 Sep review: still true, and the file admits it.** `services/tenancy.ts` exports `accountSubtree()` (recursive CTE) and `isInSubtree()`, and its own header notes that auth still resolves a single `account_id`. Neither export is called from any module — the same no-caller shape as `eventPromo`. **Blocked on a decision, not on effort**: wiring the subtree into every query means answering what a parent should actually see (all children's channels? their usage and billing? their users? read-only or operable?), and each answer is a different set of query changes and a different RBAC surface. Cheap once decided; wrong to guess |
| SaaS-admin MFA (2-step login) | ✅ | Built 3 Aug: `totp.ts` (RFC 6238, no dep) + `/api/platform/auth/login`→enrol→`/mfa`→session. 9 TOTP-vector + 8 flow tests |
| **Sessions that last as long as the work (silent token refresh)** | ✅ | Built 5 Sep. The refresh token, the hashed store and `POST /auth/refresh` all existed and **nothing ever called them**: the sign-in screen read `access` and dropped `refresh`, and the only 401 handling in the console was a bounce to the login form. So every session was capped at `ACCESS_TTL` of wall clock — 15 minutes, mid-broadcast, whatever the operator was doing. The console now renews proactively a minute before expiry, recovers reactively on a 401 with one retry, and does both through a **single-flight** promise, because this console fires many concurrent requests and a refresh per failure would stampede an endpoint that rotates the credential — the first response would invalidate the token the others still hold and sign the operator out via the fix. Presence is tracked from pointer/key/wheel/touch/visibility events only, **never from API traffic**, so a tab left open overnight is not mistaken for someone working. Refresh token stays in memory; persisting it survives a reload and is a separate decision with a different risk |
| Refresh endpoint honours user standing, and rotates | ✅ | Two holes that had to close before a long session was safe. **A disabled user was never signed out**: the query joined `users` for `account_id` and `role` and never read `u.status`, so a disabled account minted fresh access tokens for the full 14 days — while the Users page states "Disabling signs the user out (at the next token refresh)", an interface making a claim the code did not implement. Both user status and account suspension are now checked. **Rotation would have removed the cap**: the replacement inherits the original row's `expires_at` rather than getting a fresh 14 days, or an absolute cap silently becomes a sliding window that never closes. Logout revokes server-side; `expiresIn` comes from `config.jwt.accessTtl` instead of a `900` literal that appeared twice. `test/session-refresh.check.ts` |

---

## How to keep design and build converged
1. **This file is the checklist.** Update the status column whenever something
   is built or decided, in the same session. A decision recorded in memory
   without a status change here = a gap that will resurface (this is exactly what
   happened with Hydra).
2. **Design docs point back here.** The chat-2/3 docs (metadata/source-provider,
   EPG, geo-rights, analytics, api-keys) are specs; each maps to one or more rows
   above. "Delivered a doc" ≠ "built."
3. **Suggested convergence order** (implementation catching up to design):
   API hypermedia layer (closes the most-cited gap) → metadata-on-events +
   two-plane model → EPG/scheduling core → geo/rights edge → analytics ingest →
   real React app. Encoder functional gaps (captions, vod-extractor) slot in
   wherever they unblock a demo.

---

## 2026-08-13 update - streaming works end to end + detail page de-faked

- LIVE STREAM END TO END (working, verified): create a Transcode channel with an
  HLS/RTMP/SRT pull source, Send source, and the real encoder ingests, builds the ABR
  ladder (x264), packages CMAF (HLS+DASH) to the origin, and the app plays it. Verified
  in a full local stack against the JR HLS source (1080/720/480 ABR served + playable).
- CHANNEL DETAIL wired to the REAL encoder (was driving the synthetic test-card). Source
  + output players load /origin/<id>/master.m3u8; Send source / Drop source call the
  production start/stop.
- DETAIL PAGE DE-FABRICATED: EPG (was Sunrise/Morning News...), viewers (was ~18k), status
  board and event log were all invented in channelDetail.ts. Now real only: status from
  stream_status, event log from stream_events PLUS the real encoder.log error lines (see
  WHY a source/output failed), EPG from the programmes table (empty state when none),
  viewers empty until real analytics.
- run-on-mac.sh: persists test data across runs (only seeds a fresh DB; RESET_DB=1 to
  reset); removed the stale volt-update.bundle step that aborted startup.
- Encoder local test tooling: validate.sh (HLS) + validate-docker.sh (HLS+SRT, prod Linux
  runtime). README updated with setup / test / local build / cloud deploy.

### Pending (honest)
- Source Validate button + info (ffprobe: codec/res/fps/bitrate/metadata/subtitles) in the
  create form + detail; cap output rungs to source. ffprobe proven; UI + endpoint next.
- Settings fields read-only (copyable) while running, editable when stopped. Next.
- Frontend empty-state polish (EPG "create" button, viewers "no data yet").
- Real analytics wiring for the viewers card.

## 2026-08-23 update - admin shipped, radio in build

- ADMIN SECTION (built, 47/47 e2e): apps & API keys UI (publishable key shown once,
  origin/IP restrictions, account secret keys), user management with roles
  (owner>admin>operator>viewer) plus USER GROUPS carrying per-feature levels
  none/view/manage enforced centrally in requireAuth and mirrored into the nav via
  /auth/me; System Admin (platform staff only) creates client accounts + primary
  owner in one transaction with credentials shown once, sets plan/quotas, suspends
  accounts (login blocked, sessions revoked, API keys rejected). See admin.check.sh.
- EPG (built, 18/18 extended e2e): owners roll-up, day builder (copy/clear days,
  conflicts), per-slot geo + slot replacement fields, post-airing auto clip/VOD
  using programme metadata for naming. Radio reuses these tables for its log.
- RECORDINGS WORKBENCH (built, 34/34 e2e): searchable library (names, EPG
  programmes, spoken words), NLE-style detail page with range playback across
  runs, transcript column synced to the playhead, clip creation.
- RADIO (in build, see RADIO.md): audio-only workflows. MP3 + HLS + DASH single
  bitrate outputs, audio-valid inputs incl Icecast, ICY now-playing captured as a
  timed log into the EPG tables with song/ad/content classification (drives
  search, trimming, clipping and the transcription policy), detail page with an
  audio visualiser instead of the 16:9 video, station artwork + live metadata.
  NOTE: the 16 Aug audio-only channel work was lost in the two-session merge
  (d460f5b); the new build supersedes it.

---

## Recording, clipping, VOD and the media lifecycle

*Added 23–24 Aug. Every row below is verified by an assertion in `volt-app/test/`,
against real media on disk rather than fixtures. 481 assertions across 13 suites.*

| Capability | Status | Notes |
|---|---|---|
| **Migration runner** | ✅ | Numbered `NNNN_name.sql`, one transaction each, advisory-locked, adopts pre-runner databases, refuses `ALTER TYPE … ADD VALUE`. Boot refuses to serve on a failed migration |
| **Durable job system** | ✅ | `jobs` rows claimed `FOR UPDATE SKIP LOCKED` against a LEASE, not a flag; reaper for expired leases; exponential backoff; `PermanentError` skips retries; `dedupe_key` for idempotent enqueue; `job_attempts` history. `test/jobs.check.ts` 43 |
| **Frame-accurate clips** | ✅ | Output seeking (`-ss` after `-i`), per-block render then concat demuxer. A 20,000ms request produces 20,023ms of media. `test/clip-extract.check.ts` 36 |
| **Broadcast-day containers** | ✅ | 06:00→06:00 in channel-local time; a clock-change day is 23 or 25 hours. tz and anchor FROZEN on the container so editing the channel cannot re-file history. Verified across both UK changes, New York and Sydney. `test/broadcast-day.check.ts` 35 |
| **Dayparts** | ✅ | Anchors only — a start time per channel, each running to the next, so gaps and overlaps are unrepresentable. UK presets default. `test/containers-dayparts.check.sh` 23 |
| **Three-lane timeline** | ✅ | Media, time, on-air on one wall-clock axis from ONE response, so the lanes cannot disagree about a boundary. Spans containers: a capture boundary is a mark on the axis, never the end of it |
| **Audio waveform in the media lane** | ✅ | True peak on a LINEAR amplitude scale, per-run cache, progressive fill. A flat block says a recording exists; the waveform says where to cut. `test/waveform.check.sh` 10 |
| **Video thumbnails in the media lane** | ✅ | Keyframe extraction, free because the encoder forces an IDR on every segment boundary. Cold strip of six: 263ms. A slot with no media stays empty rather than borrowing a neighbour's frame. `test/thumbs.check.ts` 27 |
| **Clip provenance chain** | ✅ | `clip_segments`: one row per contiguous block, back to run, rendition, segment range, recording and broadcast day. ON DELETE SET NULL so the chain OUTLIVES its sources. `GET /api/vod/:id/provenance`, and `GET /api/recordings/:id/derived` in reverse. `test/clip-provenance.check.ts` 57 |
| **Media lifecycle** | ✅ | `media_objects` (what it is, can it be read now) separate from `media_locations` (where the bytes are, what reading them costs). Nine states. Deletion leaves a tombstone with its logical key, size and history |
| **Retention ladder** | ✅ | Ordered rungs: cool, archive, delete. Walked oldest-first, so year-old media is deleted directly rather than cooled, archived and deleted across three sweeps. Holds outrank every rule. Dry run before it fires |
| **Feature-gated archive** | ✅ | Cold and archive actions offered ONLY on S3 (or compatible) with archiving explicitly enabled. On local storage a rule naming them is refused at WRITE time with the reason. Restore records the tier's published window and says "expected by", never "ready at"; a restored copy lapses back on its own timer. `test/media-lifecycle.check.ts` 97 |
| **QC** | ✅ | Duration against the request, coverage from the chain, silence, black frames, loudness and true peak — one ffmpeg pass. Findings with a time range and a measurement, not verdicts. Checks that could not run are recorded, because "we did not look" and "we looked and it was fine" are different answers |
| **Review** | ✅ | Decisions kept as events with a name and a note. The publish gate is SOFT by default: publishing over a QC warning is allowed and is written down. Two hard blocks per account, both off by default. `test/review-qc.check.ts` 51 |
| **Analytics retention** | ✅ | Reports outlive the events they were computed from. Recompute → seal → prune, with the seal check inside the DELETE's own predicate. Raw window per account, default 90 days. `test/analytics-retention.check.ts` 33 |
| **Publication provenance** | ✅ | A publication stamps the build time, review state, QC state and who published. A rebuild marks existing publications stale |
| Smart render (re-encode only the two partial end segments) | 📐 | `plan()` already reports the saving. Must be validated frame-for-frame against the full-render output before it replaces it |
| Segment duration per profile | 📐 | Frame accuracy made 4s a performance question rather than an accuracy one |

### Defects found and fixed while building this

Each of these was live, and each was found by a test written to prove something
else:

* **Negative segment durations.** `scanRun` read a duration from the tfdt delta
  between consecutive segments. An encoder rebasing its timeline inside a run
  makes that delta negative — one real run measured -1,264,001 ms — and start is
  mtime minus duration, so the segment was placed twenty-one minutes into the
  future.
* **Durations measured across a hole.** With a segment missing, the delta spans
  the gap: the segment before a five-segment hole took a 24s duration and was
  placed 20s early, on top of its own predecessors. Media that looks present, in
  the wrong place, with no gap reported.
* **A run treated as one contiguous span.** Segments either side of a hole were
  byte-joined, so a clip came out shorter than asked for, with the missing
  minutes silently absent and every trim point after the hole wrong, at 100%
  reported coverage.
* **The waveform plotted loudness, not amplitude.** Real programme audio came
  out pinned near full scale with no shape to trim against.
* **Recordings filed only at boot.** A recording opened at 09:00 stayed unfiled
  until the next restart, invisible to every question asked by broadcast day.
* **Media objects duplicating.** Two identity bugs, both producing the same
  media described twice with two histories and two separate retention futures.
* **Unique views were not unique.** The rollup added one to total_views and one
  to unique_views per session, so the columns were always equal.
* **The account-scope rollup had no uniqueness at all.** scope_id is NULL for
  that scope and Postgres treats NULLs as distinct in a unique constraint, so
  `ON CONFLICT DO UPDATE` never fired and every write inserted instead of
  accumulating.
* **Every audit trail wrote the actor as "unknown."** The code read `req.user`;
  the access claim is `req.auth`.


---

## 2026-09-05 update - reporting foundations, session length, and three "correct about the wrong question" bugs

Five days of work whose through-line is worth naming, because the same shape
turned up four times: **things individually well built, failing in the wiring
between them, and several numbers that were correct about the wrong definition.**

**Built and covered**

* **The air ledger** (migration 0023 + `services/airSessions.ts`). "Hours on air"
  now has a source that survives a channel deletion, a rename, and an operator
  clearing the event log. One function owns the boolean and the history together;
  a check suite reads the source and fails if a fifth call site writes `on_air`.
* **Sessions that survive a shift.** The refresh token, its hashed store and
  `/auth/refresh` all existed and were never called, so every session ended after
  15 minutes of wall clock. Silent single-flight refresh in the console, plus two
  server holes closed: a disabled user could refresh for 14 days (while the Users
  page claimed otherwise), and naive rotation would have turned the absolute cap
  into a window that never closes.
* **Now-playing resolution** for HLS and other sources that carry no track
  metadata, replacing a permanent "Untitled break" that read as a broken pipeline.
* **A listener count that means the whole audience**, not the MP3 clients.
* **Auto connect armed by a healthy run** (migration 0024), ending the five-relaunch
  crash loop that buried the one error message an operator needed.
* **Operator control over the give-up notice and the event log**, with the
  stand-down that stops dismissing from re-arming the loop.

**Measured, not assumed**

* **MP3 delivery economics.** A CDN cannot cache an endless stream, so every edge
  holds an origin connection per listener. Self-served MP3 is ~6× cheaper per
  listener-hour than CDN-delivered HLS; AWS egress is the expensive combination.
  `docs/DECISION_mp3_delivery.md`
* **Graphics overlay cost.** Template DOM update 0.9 ms/frame (45× realtime); the
  bottleneck is the capture pipeline, not the browser. Intro/outro concat with
  matched parameters: 0.109 s, no re-encode — and a parameter mismatch joins
  anyway, **exits 0**, and yields a corrupt file, so the publish step must verify
  packet count.
* **API navigability.** The Hydra/JSON-LD layer is content-negotiated and only
  activates on `Accept: application/ld+json`; a blind walk with the right header
  reached 39 URLs three levels deep. `docs/API_NAVIGABILITY_REPORT.md`

**Known open, carried deliberately**

* `/radio/:id/stream.mp3` still 302s to a dead relay instead of returning the
  degraded reason.
* `resolveOutputs` defaults `mp3:false` while `outputUrls`/`publicUrls` default
  `mp3:true` — three defaults, two answers.
* `ownedRecording()` still infers kind from `radio_config IS NOT NULL` rather than
  reading the column that already knows.
* `stream_events` has no retention sweep.
* `max_listeners` on relays is stored and read by nothing; there is no relay UI.
* Events are not wired to the air ledger — no `on_air` column and no air endpoint,
  pending a decision on whether an event goes on air by explicit action or by its
  scheduled window.


---

## 2026-09-05 prototype sweep - which 🧪 rows were still true

Every row carrying 🧪 was checked against the tree rather than against memory.
Six rows; **one is still a prototype**, and it is the one that looked healthiest.

| Row | Was | Now | What the tree actually says |
|---|---|---|---|
| On-the-fly image service | 🧪 | ✅ | Productionised. `services/imageResize.ts`, `sharp ^0.35.3`, `GET /img/<WxH>[,opts]/<key>`, derivatives cached under `derived/`. The console calls it via `thumbUrl()` and station artwork renders through it. **Gap: signed URLs are not enforced.** |
| Frame-accurate media access | 🧪 | 🟡 | **Half shipped, half replaced.** Frame-exact *cutting* is in daily use (`-ss` after `-i`, decode-and-discard seek). Frame-index JIT pull and I-frame trick-play were never built and are not needed: waveform + filmstrip serve scrubbing instead. Smart render is still genuinely open. |
| Admin prototype (single-file HTML) | 🧪 | ✅ | The file is gone from the tree. Superseded by `volt-web` (25 pages). |
| Custom Live Timeline (vanilla) | 🧪 | ✅ | React port done: `SourceTimeline.tsx` + `ClipTimeline.tsx`, over `modules/timeline.ts`. |
| Test stream + playback + subtitles | 🧪 | ✅ | Still wired and surfaced. A shipped operator feature, not a mock — though the local launcher running the *real* encoder has largely taken over its job. |
| `BroadcastEvent` / `SportsEvent` + SportsML-G2 | 🧪 | 🧪 | **Stays, and for a worse reason than the row gave.** `eventPromo.ts` has **zero callers** outside its own test. The 17/17 suite proves the functions; nothing emits them. |

### The lesson worth keeping

Two of these had drifted in *opposite* directions, and both drifts came from the
same habit of writing the status when the work was done and never re-reading it:

* **The image service and the timeline were undersold.** They had been built into
  the app and the row still said prototype, so real capability was invisible on
  the status page and in the app-surfacing note, which still listed the image
  service as "not in app yet" while the console had been serving artwork through
  it for weeks.
* **`eventPromo` was oversold.** A green test suite reads as evidence of a working
  feature, and here it is evidence of a working *library*. A passing suite says
  the code does what its test asks. It says nothing about whether anything calls
  it. Worth checking callers, not just coverage, before a row claims output is
  being produced.

### Follow-ups this sweep created

1. **Sign the image URLs** before the service faces the internet. Today anything
   that can reach the host can request an arbitrary derivative of any `library/`
   key. `services/imageResize.ts` already notes it as hardening to layer on.
2. **Give `eventPromo` a caller**, or move it out of the build status until it
   has one. One route plus the player-session payload.
3. **Extend `metadata_schemas.target_kind`** past things we STREAM to things we
   DESCRIBE, so a `SportsTeam` can be typed and SportsML-G2 ingest stops
   discarding the identifiers it was fetched for. This one has a migration in it.


---

## 2026-09-05 partial sweep - what is actually blocking each 🟡

Same treatment as the prototype rows. Nine partials, and they fall into four
groups that want very different things from you.

### One was simply stale

* **Real React + TS + Vite + Tailwind admin app** → ✅. The note still said
  "other sections are placeholders", written 5 Aug when Channels was the only
  wired section. There are now 25 pages and 11,929 lines, and a sweep for
  placeholder markers finds nothing. The app is the product.

### One moved, and stays 🟡 for an honest reason

* **CloudFront native geo-restriction.** The hardcoded `restriction_type = "none"`
  is gone, replaced by `var.cdn_geo_restriction_type` (validated) and
  `var.cdn_geo_countries`, defaulting to `none`. It cannot go ✅ until something
  is applied, and nothing ever has been. **Do not mistake it for the geo
  feature**: CloudFront takes one country list for the whole distribution, so
  per-programme blackout stays in the play gate where it already works.

### Three are blocked on credentials only. No code decision is left

| Row | What unblocks it |
|---|---|
| SPEKE / Axinom DRM cbcs | One SPEKE endpoint + key-provider credentials. `volt-encoder/bin/speke_client.py` is written and wired through `jobConfig.ts` and the launcher; it has never spoken to a real key server |
| Publishing + social + view tracking | Developer apps on YouTube, Facebook, X, TikTok, Dailymotion |
| Publish a clip to social | The same five, plus the "Publish to…" UI once a token exchange exists |

The last two are one job, not two. `modules/publishing.ts:182` carries an
explicit `TODO(adapter)` and marks a publication as published against a
placeholder URL, so **the records and view tracking are real and the upload is
theatre.** That is the honest state and it will not change until there are apps
registered. Registering five developer apps is days of *your* calendar time in
review queues, not engineering time, which is why this has not moved.

### Two are blocked on a decision, and guessing would be worse than waiting

* **Sub-accounts subtree wiring.** `accountSubtree()` and `isInSubtree()` exist,
  tested, with **no callers** — the same shape as `eventPromo`. The question to
  answer first is what a parent actually sees: all children's channels? their
  usage and billing? their users? read-only or operable? Each answer is a
  different set of query changes and a different RBAC surface.
* **Two-plane composition (production vs distribution).** The pieces exist
  piecemeal. Formalising the model is a schema and vocabulary decision, and the
  cost of picking wrong is a migration across everything that references either
  plane.

### One is real engineering, well defined, and ready to start

* **Smart render** (the open half of frame-accurate access). Every cut needing a
  trim is a `full-render` today. `services/clips/extract.ts` already carries the
  `copy` vs `full-render` strategy split and a note naming which segments a
  smart render would have to re-encode, so the seam is cut and the work is
  bounded: re-encode the partial segment at each end, stream-copy the middle,
  and validate the join frame-for-frame against a full render of the same range.
  The header of that file already warns that the join is where this goes wrong.

### Also worth noting

**Account impersonation** is not partially built. The route, the platform gate,
the TOTP requirement and the audit row are all done; only the console affordance
is missing, deliberately, deferred past initial deploy per your call. It stays 🟡
because a feature an operator cannot reach is not shipped, but there is no
unfinished code behind it.


---

## 2026-09-05 - media scope, and the smart render that is built but not on

### Media scope is now a stated property, not an assumption

Video and audio workflows had started to be described as one thing, and the
requirements were drifting into each other. Three that were actually being
confused:

* **The waveform, level metering and the signal verdict are AUDIO.** They read a
  station's broadcast output, or the audio track of a video asset. They say
  nothing about picture, and no video capability should be specified in terms of
  them.
* **Timed in-stream metadata is VIDEO first.** `EXT-X-DATERANGE`, SCTE-35 and
  `emsg` carry programme boundaries and ad markers in the DELIVERY stream. A
  radio station's now-playing is a different thing on a different side of the
  pipeline: ICY on INGEST, already handled. The one real overlap is ID3-in-`emsg`
  on an HLS audio rendition, and that is its own row when it is built, so the
  video work is never judged by an audio acceptance test.
* **Graphics overlays are video only**, by decision, and radio is explicitly out
  of their scope — which the design doc says and the tracker did not.

The legend now carries the convention. A capability with no scope note applies to
both; anything built for one and written up as if it served both is a
requirements defect rather than a wording one.

### Smart render: built, measured, and deliberately off

`services/clips/extract.ts` gained the whole path — an eligibility gate, an
Annex-B TS intermediate so each part carries its own parameter sets through the
join, a single audio pass to remove AAC priming seams, a runtime verify and a
fallback to the full render. Measured **1,059ms against 2,077ms** on the test
fixture, with the saving growing as the clip lengthens because the middle is
never decoded.

It is **opt-in and off by default**, and the reason is a measurement:

> A 15,082ms render against a 15,000ms request passed the runtime duration check
> **and was six frames short.** A duration check cannot see a seam.

The middle currently starts ~74ms late, because the concat demuxer offsets the
next part by the previous file's container duration (1.541s) while its picture
ends at 1.520s. `test/clip-smart-render.check.ts` is the acceptance test — 20
passing, 4 failing, and the four failing ones are the frame-for-frame
comparisons that define done. It is deliberately **not** wired into
`npm run check` yet: it currently fails on purpose, and smart render stays off
until it does not.

Four real defects were found and fixed on the way there, each by the frame
comparison rather than by reasoning: the TS 1.4s start offset accumulating
across parts; AAC priming making the muxer shift the picture a frame late;
`-shortest` truncating the picture because audio was the shorter stream; and a
hardcoded 80ms tolerance that rejected a correct 25fps render by 17ms.

### Live updates: the server half is done

`patchEntity()` now publishes a `record` frame to the account's SSE hub after a
committed change, and the console's shared `EventSource` dispatches it. It sits
in `patchEntity` rather than at each call site for the same reason the audit
write does: one function changes a record, so one place can be certain a change
happened and what changed. A caller that had to remember would forget, exactly
as four call sites forgot `on_air`.

**Only the SHAPE of the change travels** — which columns moved, the new version,
and who — never the values. The receiving page re-reads through its own
credential, so a frame cannot hand a viewer a field they are not allowed to see.

Remaining: the console-side affordance. A detail page holding an older `version`
than the frame reports knows its copy is stale, which is what turns a silent
overwrite into a warning.


---

## 2026-09-05 (overnight) - three off the queue

Worked in priority order while Christian slept. Everything committed; the tree is
working at every commit.

**Live updates — done, both halves.** Server publishes, console listens, the
channel settings drawer warns while the form is still open rather than after
Save is refused. 24/24.

**Timed in-stream metadata (video) — DATERANGE now emitted.** Annotated on the
way out of `/origin` rather than baked in by the encoder, because the schedule
keeps changing after the segment was written. 37/37.

**Watchfolder — complete for local folders.** Schema, ordered rules and the
quarantine model that was the actual requirement, then the scanner, the ingest
step, the API and the console page. 43 + 33 + 26 + 63 assertions, and the
migration was applied to a real Postgres on top of the existing ones rather than
eyeballed.

The ingest step is the one worth reading. The scanner writes a row saying what a
file is, and that row carries the checksum it had at that moment. Sixty seconds
later the ingest pass reads the bytes — and in that gap an operator can drop a
corrected version over the top under the same name. Trusting the row would put
content in the library that was never classified, so the file is re-hashed and a
file that has moved is refused. The half that is easy to miss is that refusing
is not enough: a row left at `seen` over a file that will never match is re-read
and re-hashed on every pass for the life of the folder, so it is CLOSED, and the
new content arrives as a new item because the unique index is keyed on content.

The same shape appears three more times in that file. Bytes go to the store
before the row, because an orphaned object costs disk while a row pointing at
nothing is a broken asset that looks authoritative. A library path collision is
suffixed rather than failed, because `media_files` is UNIQUE on
(account_id, path) and refusing the second is a file that can never ingest
however often it is retried. And a target the image library cannot hold, `vod`
or `loop`, is deferred to its own workflow rather than coerced into `other` —
coercion is exactly the unidentifiable-junk outcome the quarantine exists to
prevent, and marking it failed would hide real failures in the noise.

### Two things caught that would have cost the morning

* **A migration number collision.** The new migration was written as `0025_` and
  `0025_audio_export_keys.sql` already existed. The runner tracks by full
  filename so both would have applied, but it is wrong and fragile — renumbered
  to `0026_`, and the mis-numbered file moved to `migrations/_to_delete/`.
* **The smart-render verify was not sufficient**, found the same way: a render
  that passed a duration check was six frames short. Smart render is therefore
  built, measured (~2x faster) and **off**, with a failing acceptance test that
  defines when it may be turned on.

### Still queued

| Build | Scope | State |
|---|---|---|
| Watchfolder: S3 acquisition + VOD/loop ingest targets | Both | Local folders are done end to end. S3 is event-driven rather than a walk, and `vod`/`loop` are deferred by the ingest step for the workflows that own them |
| Smart render seam | Video | Concat demuxer offsets by container duration while the picture ends earlier. Byte-concat the TS parts and regenerate timestamps |
| SCTE-35 / `emsg` | Video | DATERANGE is in; the ad-signalling half is not |
| ID3-in-`emsg` now-playing | **Audio** | Its own row, its own test — deliberately not folded into the video work |
| Social publishing | Both | Blocked on developer app registrations, not on code |
