# Volt Streaming - Design vs Build Reconciliation

*Single source of truth for "what did we decide" vs "what is actually built."*
*`volt_build_status.html` is generated from THIS file: `node scripts/build-status.mjs`.*
Generated 2026-08-02 by reconciling the 25 project-memory notes (decisions from
all chat sequences) against the code in `volt-app/`, `volt-encoder/`, `e2e/`,
and `deploy/terraform/`.

**Legend** - ✅ Built & verified · 🟡 Partial (some built, some stubbed) ·
📐 Designed only (decision + doc, no code) · 🧪 Prototype / test-harness only ·
❌ Not started

The headline: the **control/production/orchestration core is built and verified**
(chat-1 work). The **API contract, EPG, source-provider, geo/rights, analytics,
and app-keys designs (chat-2/3 work) are documented and prototyped but not yet
implemented.** Design is ~2 chats ahead of build.

---

## 1. Control plane & API

| Capability | Status | Notes / source |
|---|---|---|
| REST API - 34 endpoints (channels, events, recordings, vod, metadata-schemas, filler, scheduled-clips, publishing, status) | ✅ | `volt-app` - verify.sh 34/38, capture 34/34 2xx |
| schema.org `VideoObject`/`Clip` JSON-LD on VOD | ✅ | `schemaOrg.ts`; `/api/vod/:id/schema.org` |
| **Hypermedia / HATEOAS - JSON-LD + Hydra typed links, collections, entrypoint** | ✅ | Built 2 Aug: content-negotiated (`Accept: application/ld+json`); `hypermedia.ts` + middleware + `/api` entrypoint, `/api/context.jsonld`, `/api/doc`. 26/26 tests; plain JSON unchanged (34/38 regression clean). Cursor paging = follow-up |
| Source-provider API tiers (Delivery/Descriptive/Guide/Timed/Rights/Control) | 📐 | `metadata_source_provider.md`; doc delivered, no code |
| `BroadcastEvent` / `SportsEvent` output + SportsML-G2 ingest | 📐 | designed; only VideoObject implemented |
| Timed in-stream metadata (EXT-X-DATERANGE / SCTE-35 / ID3 / emsg) | 📐 | designed; not emitted |
| API keys / app registration (account+app keys, playback token, per-app restrictions) | ✅ | Built 2 Aug: `apps`+`api_keys` (sha256, prefix), `apiKeys.ts` (gen/verify/restrictions/token), `/api/apps` + public `/api/availability` gate. 8 tests (origin enforce, 401/403, metering) |
| On-the-fly image service (resize/crop/filter by URL, cached · sharp) | 🧪 | Prototype 3 Aug in `volt-image-proto/`: sharp service, URL grammar `/{fit}/{WxH}/filter(...)/{path}` - fit-in/fill/stretch + focus (center/edges/smart) + sharpen/blur/grayscale/format(webp/avif)/quality, HMAC-signed URLs, disk derivative cache (HIT 1.4ms vs ~150ms render). 14/14 assertions + gallery. `docs/DESIGN_image_service.md`. Productionise: S3 origin + CloudFront + require signatures |
| Record edit API (PATCH partial + optimistic concurrency) + audit trail | ✅ | Built 4 Aug: shared `services/audit.ts` - `patchEntity` sends ONLY changed fields (null clears), bumps `version`, rejects stale writes 409 via If-Match/version; `created_by`/`updated_by`/`version` columns; `audit_log` diffs (from→to, by whom); `GET /:id/history`. Wired into channels, events, metadata-schemas (PATCH + PUT alias); pattern extends to any resource. verify.sh 38/38 clean + 23 edit-audit e2e |
| Live updates (admin real-time collaborative view) | 📐 | Push committed field changes to other admins viewing the same record over the existing SSE hub + Postgres LISTEN/NOTIFY; version-conflict warning. Public front-end live = selective only: EPG now/next served from CDN + client advances at the known programme boundary + cache-tag purge on override (no per-viewer socket, so 500k viewers hit cache not origin) |

## 2. Production plane (encoder / packager)

| Capability | Status | Notes / source |
|---|---|---|
| package_only + transcode → CMAF → HLS+DASH | ✅ | real ffmpeg→Shaka, decodable |
| **Local-storage mode (encoder writes CMAF to disk, no S3)** | ✅ | Built 6 Aug: `encoder.py` `output.mode=local` → writes the ladder + HLS/DASH straight to a local origin dir (served at `/origin/<id>`) and **skips the S3 uploader**; `s3` block no longer required; per-job `UDP_BASE_PORT` so concurrent channels don't collide. Origin dir IS the live edge + DVR (`time_shift_buffer_depth`) + recording (`preserved_segments=0`). Unit tests + real e2e (HLS pull → 720/480/360 ladder → CMAF, decodable, DASH `timeShiftBufferDepth` honoured) |
| **Local thumbnailer mode (poster/storyboard/VTT to disk)** | ✅ | Built 6 Aug: `thumbnailer.py` `out_dir` → writes `poster.jpg` + `sb_NNN.jpg` sheets + `thumbs.vtt` locally, no S3; `accurate` seek path for CMAF fMP4 (Shaka's live playlists carry no ENDLIST). Verified against a real local encode (poster + 5×5 sheet + VTT). 4 new builder tests |
| Input failover + filler-on-loss (package_only) | ✅ | `source_selector.py`, 43 assertions |
| SPEKE / Axinom DRM cbcs (client) | 🟡 | client coded; **not live-tested** against a SPEKE endpoint |
| Keyscreen thumbnailer (CPU) | ✅ | `thumbnailer.py`, 22 assertions |
| Status / events → control plane | ✅ | `events.py`, 16 assertions |
| Live captions / transcribe + translate (multi-engine sidecar) | ✅ | `bin/captions.py` - offset, HLS-aligned WebVTT segments, per-language tracks, final VTT. 3 engines: offline (tests) · **whisper** (self-hosted faster-whisper, no per-min cost) · gladia (paid). Extended 3 Aug: Whisper transcribes ~100 langs + native X→English; **NLLB-200 MT stage** adds all other targets (en↔ms, en↔zh, en↔ta proven with real espeak→whisper→NLLB run). Account master toggle `accounts.captions_provider` (none\|whisper\|gladia) gates it; jobConfig pins engine to the account. 33 unit tests. Live Gladia websocket adapter still stubbed (needs key+network). Workflow + engine alternative: `docs/WORKFLOW_captions_translation.md` |
| Captions provisioning workflow (per-stream engine plan · whisper GPU add-on vs Gladia sidecar · sizing · launch/teardown) | ✅ | `captionsPlan.ts` + orchestrator: resolves none/gladia/whisper per stream, sizes GPU (T4 covers ≤large-v3+NLLB), launches whisper as its own `instances` row (role=captions) only when needed, torn down with the stream. 9 plan + orchestration tests. `docs/WORKFLOW_captions_translation.md` |
| Captions settings UI (account provider toggle + per-profile targets/model/offset) | ❌ | backend + master toggle done; the admin screen to enable it and pick languages is a follow-up |
| Transcode-workflow failover | ❌ | logs warning, runs primary only |
| Zero-gap primary↔backup splice | ❌ | sub-second gap today |
| Watermark / bug overlay | ✅ | Built 15 Aug, extended 16 Aug (burn-in wired into the encoder + test harness `test-stream.sh`; the settings show for ALL channels, burn-in stays transcode-only and packaged channels get the preview overlay): per-channel burn-in on the transcode path (image, corner/edge anchor, px offsets, % size, opacity) with a live console preview. Now settable **on the create form** as well as settings. Packaging channels copy the source, so it is hidden there. |
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

## 4. Media & data

| Capability | Status | Notes / source |
|---|---|---|
| Recordings (channel-day/event, retention→expiry) | ✅ | `recordings.ts` + orchestrator |
| VOD library + custom metadata schemas (validated) | ✅ | `vod.ts`, `metadataValidator.ts` |
| Multi-recording compose-clip (`clip_spec`) | ✅ | extractor renders it - `vod-extractor-job.ts` composes across recordings w/ discontinuities; 16 unit + real-media e2e |
| Slates & loops (filler assets) | ✅ | `fillerAssets.ts` |
| Publishing + social + view tracking | 🟡 | data/records/views real; social OAuth upload is a **stub** |
| **Publish / share a clip to social media** (YouTube/Facebook/X/TikTok/Dailymotion) | 🟡 | Foundation built: `publish_targets` (linked account per platform) + `publications` (per asset×destination, status, external URL, views) + `/api/publish-targets` + `/api/publications` (publish + sync-views). Platform enum covers portal+5 socials. **To deliver:** per-platform OAuth app + token exchange, real upload adapter (video + title/description/thumbnail from the clip's metadata), real view-count sync, and a "Publish to…" UI. Needs each platform's developer app credentials. Workflow: `docs/WORKFLOW_social_publishing.md` |
| Social publishing UI integration (Publish to… action · target picker · caption editor · connected-accounts screen) | ❌ | the clip-side action + settings screen to link accounts and post; backend APIs (`publish-targets`/`publications`) already exist. `docs/WORKFLOW_social_publishing.md` |
| Frame-accurate media access (scrub any frame · JIT clip · no proxies) | 🧪 | Prototype 3 Aug in `volt-frame-proto/`: frame index over the chunked origin + JIT single-frame pull (frame-accurate, MAD 0.02 vs ground-truth decode) + JIT clip (exact 76-frame cut across segments) + WebVTT sprite scrub + HLS I-frame trick-play playlist + browser scrubber. 15/15 assertions. Standards-based design-around (no per-frame storage; open formats + prior art). `docs/DESIGN_frame_access.md`. Phase 2 (multi-res JIT + edge cache) + phase 3 (NLE integration, build-or-licence) = roadmap |
| Image Library / file manager (watermarks · slates · posters · brands) | ✅ | Built 6 Aug: `media_files` + `media_folders` (account-scoped, hierarchical path/folder, kind, tags, dims). **Storage-driver abstraction** `services/imageStore.ts` - `local` base dir (IMAGE_STORE_DIR) for local runs, `s3` bucket+prefix for cloud (`@aws-sdk/client-s3`); curated `library/` vs generated `derived/` prefixes. `/api/files` - list/browse/search (folder/kind/q/tag), folder tree + create, base64 upload (dependency-free PNG/JPEG/GIF/WebP dimension probe), rename/move (moves the object), **guarded+audited delete** (428 confirm + in-use guard). Serves `/library/*` from the store = the image-resize origin. React **Image Library** browser (folder tree + grid + upload + search + delete-confirm). Backend verified end-to-end. Direct-to-S3 presigned upload = cloud-scale follow-up; slate/brand picker wiring into forms = next. `docs/DESIGN_file_manager_watchfolder.md` |
| Watchfolder ingest (assign a folder or S3 bucket/prefix as an auto ingest source) | 📐 | `watchfolders` + `watchfolder_events` (idempotent). S3 event-driven (EventBridge/SQS ObjectCreated) + reconcile scan; local/SFTP via agent. Arriving file → dedupe → validate → register `media_file` → build target (source/VOD/slate/playlist). `docs/DESIGN_file_manager_watchfolder.md` |
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
| CloudFront native geo-restriction | 🟡 | Terraform has it as `none` placeholder |

## 8. Analytics & reporting

| Capability | Status | Notes / source |
|---|---|---|
| Server-side audience/QoS/realtime from CDN logs; by-app lead; no-referrer VPN classification | ✅ | Built 2 Aug: Postgres serving layer (`play_sessions`, `analytics_rollups`, `stream_concurrency`), UA/referrer parsing, beacon ingest (playback-token), reports (realtime/asset/audience/usage). CloudFront→Kinesis firehose = scale path. 6 tests |
| WAF enforcement (paid add-on) | 📐 | designed; not built |

## 9. Frontend

| Capability | Status | Notes / source |
|---|---|---|
| Site-wide search (channels · events · recordings) | ✅ | Built 16 Aug: `GET /api/search?q=` account-scoped across the three entities (defensive per entity), top-panel field with a debounced results dropdown that navigates on click. |
| Radio section (audio-only scope) | ✅ | Built 16 Aug: `/radio` + `/radio/:id` reuse the channel list + detail at the audio scope, station wording, audio-ladder column and editor, create form with artwork + AAC rungs. |


> **App-surfacing coverage** (tracked per-feature in `feature-tracker/features.json` via the `app_surface` field → the *volt-feature-tracker* artifact). Many capabilities below are ✅ *at the API/engine level* but **not yet wired into the React app**. In-app now: Channels list + create (transcode/package), **Radio (audio-only) list + create**, Channel detail/control page, **channel brand + watermark on create/settings**, **share-preview links (create, email, QR, extend, rotate, revoke)**, Test stream + playback + subtitles, Deep-link routing; Ladder profiles (in build). Backend-built but **not in app yet** (do not lose): image service, frame-accurate access, social publishing, EPG, analytics, file manager, watchfolder, SaaS admin, live-updates, full captions settings. These are carried as `app_surface: none` in the tracker so the gap stays visible; removals require a formal confirmation and are struck from both this doc and the tracker.

| Capability | Status | Notes / source |
|---|---|---|
| Admin prototype (single-file HTML) | 🧪 | `volt_admin_prototype.html` - mock, not the app |
| Nav architecture / wireframes / concept screens | 📐 | design artifacts |
| Custom Live Timeline (vanilla) | 🧪 | proven in prototype; React port pending |
| **Runnable local test console** (login + all tabs wired to the live API) | ✅ | Built 3 Aug: `public/console.html` served at `/console`; `run-local.sh` one-command (reset+seed+boot); `TEST_TONIGHT.md`. Verified end-to-end in browser |
| **Real React + TS + Vite + Tailwind admin app** | 🟡 | Built 5 Aug: `volt-web/` scaffolded on the Volt Stream Concept design system (grouped sidebar, bolt logo, dark control-room palette). Channels section wired to the live API - empty state, filter chips, create drawer (transcode/packaging + DVR window + Whisper captions), list. Runs via `run-on-mac.sh`. Other sections are placeholders |
| Channel detail / control page (React) | ✅ | Built 5 Aug: dual source/output players, EPG now/next, realtime viewers chart, output+source status board + rendition ladder, event log; **editable settings drawer** (source ingest, source geo rules, DVR window ≤4h / mode, subtitle targets, retention) via optimistic-concurrency PATCH + audit. Per-channel DVR window (`channels.dvr_window_sec` ≤4h CHECK, `dvr_mode` sliding\|event_start) + source geo (`geo_mode`/`geo_countries`). Telemetry is representative pending live wiring |
| **Test stream, real playback & live subtitles (test build)** | 🧪 | Built 6 Aug: one-click per-channel test stream - `volt-encoder/bin/test-stream.sh` runs FFmpeg to generate a real live HLS/DASH ladder from a test card (burnt clock+tone); `bin/test-captions.mjs` writes a live-growing WebVTT per language (EN/MS/ZH/TA sample; real-Whisper mode via `captions.py`). Control plane serves `/origin/<id>/…` (m3u8/mpd/m4s/vtt); `POST /api/channels/:id/test-stream {start\|stop}` spawns/kills on the API host. Output player plays it for real with **hls.js**, live subtitle overlay + language switch, and DVR scrubber seeking the HLS timeline. Generator + captions + origin serving + start/stop validated; in-browser H.264 playback runs on Mac Chrome/Safari (headless CI can't decode H.264). Needs `ffmpeg` on the host |

## 10. SaaS platform layer

| Capability | Status | Notes / source |
|---|---|---|
| Multi-tenant isolation (every API filtered by account_id) | ✅ | Built + audited 2 Aug; cross-tenant isolation test (account A can't see B's data). `docs/SAAS_ARCHITECTURE.md` §2 |
| Analytics data store (clearly defined) | ✅ | Postgres serving + S3/Athena raw + Redis/Timestream realtime; documented in `SAAS_ARCHITECTURE.md` §1 |
| SaaS-admin vs client-admin roles | ✅ | `platform_role` on users + `requirePlatform` middleware (saas_admin/support/read_only). 4 auth tests |
| SaaS-admin dashboard (servers/perf, upcoming events, projected instances, active channels, viewers, admins, API status, tickets) | ✅ | `/api/platform/overview` + `/accounts`. Cross-tenant aggregation. Tested |
| Support tickets (client file + SaaS triage) | ✅ | `support_tickets` + `/api/tickets` (client) + `/api/platform/tickets` (triage). Tested |
| Account impersonation ("view as") | 🟡 | built behind saas_admin + audit-logged, but **deferred past initial deploy** per your call |
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
| Sub-accounts (parent → child subtree) | 🟡 | `accounts.parent_account_id` + `accountSubtree()` helper (8 tests); per-query subtree wiring = follow-up |
| SaaS-admin MFA (2-step login) | ✅ | Built 3 Aug: `totp.ts` (RFC 6238, no dep) + `/api/platform/auth/login`→enrol→`/mfa`→session. 9 TOTP-vector + 8 flow tests |

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
