# VOLT Stream — Architecture (Modules and Workflows)

The single shared picture of the system. Every session should start here so nothing
is re-solved or re-broken. Two parts: the **modules** (the capabilities, with where
each lives in code and what it depends on), and the **workflows** (the end to end
routes through those modules). A workflow is a defined path through the modules, so a
new feature is understood by which modules it touches.

Status legend: **built** (working, in use), **partial** (works, gaps noted),
**building** (designed / next up).

---

## Modules

### 1. Video Encoder Module — built
One mezzanine in, the full ABR ladder out. ffmpeg fans the source into each rung
(scale + x264 or NVENC) with aligned closed GOPs, each rendition on its own local UDP
bus for the Packaging module to read.
- Code: `volt-encoder/bin/encoder.py` (`start_transcode`), ladder from
  `volt-app/src/services/jobConfig.ts` (channel `output_ladder` overrides the profile
  rungs).
- Depends on: Watermark and Branding (overlay is a re-encode step here), Packaging
  (consumes the bus), Control Plane (job config + launch).

### 2. Audio Encoder Module — building
Audio-only channels (radio): a single audio input and a single audio output, no video
ladder. Adds Icecast as an input alongside SRT / RTMP / HLS, and a live audio waveform
/ level meter on the detail page for what is received and broadcast. Shares Packaging
and Delivery; needs its own encode profile (audio codec + bitrate, no scale filter).
- Code: to be added in `encoder.py` (an audio-only path) + a new channel shape.
- Depends on: Transcribe and Translate (optional), Packaging, Delivery, Status.

### 3. Transcribe and Translate Module — in review
Live captions. Whisper transcribes rolling audio chunks; NLLB translates to non
English targets; WebVTT is segmented and written as per-language LIVE renditions;
companion manifests reference them; an estimated live offset (chunk + measured
transcribe/translate time) is reported. Engine-agnostic (whisper self-hosted or
Gladia). Runs as a sidecar on the program audio, so it serves both video and audio
channels.
- Code: `volt-encoder/bin/captions.py` (engine, unit-tested) + `encoder.py`
  `start_captions` (live worker, companion `master_cc.m3u8` / `manifest_cc.mpd`,
  `caption.offset` / `caption.status` / `caption.error` events); config in
  `jobConfig.ts`; account switch `accounts.captions_provider`.
- Needs: faster-whisper on the encoder host; a soak test to confirm alignment and
  that the model keeps real time (offset stays bounded).
- Depends on: Packaging (subtitle group in the manifest), Status (surfacing offset /
  errors), Access and Security (account provider).

### 4. Watermark and Branding Module — partial
Brand assets and how they are applied. Owns the per-channel watermark config (image
ref, position TL/TR/BL/BR/TC/BC, pixel offsets, size as % of frame height, opacity),
the burn-in overlay, the live preview overlay on the player, and the channel branding
image (identity logo by the channel name, default TV icon when unset — building).
- Code: `channels.watermark_*` columns; `encoder.py` `_fetch_watermark` + `_overlay_vf`;
  `WatermarkOverlay` component + Settings controls in `volt-web`.
- Boundaries: burn-in only on the Video Encoder transcode path (re-encode); packaged
  channels get preview only; audio-only has no visual mark (station artwork instead).
- Depends on: File Manager (brand images), Video Encoder (burn-in), Delivery/player
  (preview).

### 5. Packaging Module — built
Shaka Packager reads the rendition buses and emits CMAF single-file segments with
synchronised HLS (`master.m3u8`) and DASH (`manifest.mpd`), DVR window via
time-shift-buffer, optional cbcs encryption. Because Shaka rewrites the manifests every
segment, the Transcribe module writes captions-aware **companion** manifests rather
than patching Shaka's.
- Code: `encoder.py` `build_shaka`.
- Depends on: Video/Audio Encoder (input buses), Access and Security (DRM keys).

### 6. Delivery Module — partial
Getting the output to viewers. The gated public URL `/live/:id/master.m3u8|manifest.mpd`
serves ONLY when the channel is on air with valid content (off air 404, broken 503,
else redirect to CloudFront in prod or the origin locally). The origin is served
locally for the app player. This is the path that enforces the production rules (DRM,
geo, programme replacement, EPG, CDN); those hooks are staged, not all wired.
- Code: `volt-app/src/modules/publicLive.ts`, `/origin` static in `server.ts`.
- Depends on: Access and Security (rules), Packaging (manifests), EPG, Status.

### 7. Control Plane and Orchestrator Module — built
Channel and event lifecycle, the job config builder, and the task launchers
(mock / local / docker / ecs) that spawn and tear down the encoder. Owns port safety
(probe-free UDP blocks) and cleanup (reap orphaned ffmpeg / packager on start, stop and
boot) so restarts never fail on ports or leave orphans. On air is a real persisted
state here; stop takes a channel off air.
- Code: `modules/channels.ts`, `modules/events.ts`, `services/orchestrator/*`
  (`service.ts`, `localLauncher.ts`, `dockerLauncher.ts`, `encoderPorts.ts`,
  `encoderCleanup.ts`), `services/jobConfig.ts`.
- Depends on: everything downstream; it is the conductor.

### 8. Status and Health Module — built
The honest picture of what is happening. The five-gate model
(Server, Input, Encoder, Output, On air) computed from real telemetry plus the ground
truth of the origin manifest advancing on disk, so a stall blips amber and self
recovers instead of sitting falsely green. Live push over SSE (one socket per viewer,
account-scoped), the primary-error banner, and the QC / diagnose page.
- Code: `services/pipelineHealth.ts`, `services/channelDetail.ts`, `modules/status.ts`
  (SSE hub), `volt-web/src/liveStatus.ts` (client), tables `stream_status` /
  `stream_events`.
- Depends on: encoder reports + on-disk manifest; read by the whole console.

### 9. Access and Security Module — partial
Who can do and watch what. JWT and account-key auth with `requireAuth`, tenant scoping
on every query, account and client token hooks, geo and rights evaluation, DRM key
provisioning (SPEKE to Shaka), and the share-link security surface (PIN, expiry, view
caps, revoke).
- Code: `volt-app/src/auth/*`, `services/rights.ts`, `services/apiKeys.ts`
  (`mintPlaybackToken`), `volt-encoder/bin/speke_client.py` + `shaka_drm_flags`,
  `modules/shareLinks.ts` (policy).
- Depends on: nothing above it; Delivery and Control Plane lean on it.

### 10. EPG Module — in review
The programme guide: schedule, now and next, the guide lane on the detail page, and the
add-guide / hide-guide actions.
- Code: `modules/epg.ts`, EPG assembly in `channelDetail.ts`, `EpgStrip` in `volt-web`.
- Depends on: Control Plane (channels), feeds Delivery and the console.

### 11. File Manager and Uploader Module — built
Media assets end to end: the image / media library with folders, upload, tags and
versioning; the on-the-fly resize and thumbnail service (`/img`); and the `ImagePicker`
used across the app.
- Code: `modules/mediaFiles.ts`, `modules/mediaIngest.ts`, the `/img` resize origin,
  `volt-web/src/ImagePicker.tsx`.
- Depends on: nothing above it; Watermark and Branding, filler slates / loops, and
  channel branding all pull images from here.

### Fleet and Metering
The servers the tasks land on, how hard they are working, and how much billable time
each stream has caused. This is the one module whose rows are OBSERVATIONS rather than
intent: everything else in the control plane records what was asked for, and this
records what actually happened.

Three records, and the distinction between them is the design:

- `compute_hosts` — one row per MACHINE, upserted from the launcher's placement report.
  Not the same thing as `instances`, which is one row per TASK: on EC2 capacity several
  tasks share a host, and it is the host's CPU that answers "do I need more capacity".
  A Fargate host carries exactly one task by construction and reports no host metric,
  which is stated rather than faked.
- `host_samples` — telemetry, from CloudWatch on ECS and from /proc on an on-box
  deployment. A reading that could not be taken has no row, never a zero.
- `usage_accruals` — the billable ledger. Each task carries a `metered_through` mark and
  a pass accrues only the window between that mark and now, so a tick that runs twice
  accrues nothing and a control plane that was down for an hour accrues that hour on its
  next pass. Windows are cut at the UTC day boundary, which makes every roll-up a plain
  SUM with no apportionment for anyone to get wrong. The account and a no-foreign-key
  copy of the stream id are frozen onto each row, so a channel moved between accounts
  does not rewrite last month, and a deleted channel does not erase its own history.

The unit reported is TIME. `compute_rates` exists and every accrual freezes the rate that
applied, but no API surface leads with a currency figure while those rates are seeded
placeholders.

- Code: `services/fleet/*`, `modules/fleet.ts`, migration `0016`, the fleet pass in
  `services/orchestrator/index.ts`, `volt-web/src/pages/Fleet.tsx`.
- Depends on: the launcher (for placement) and the orchestrator's instance rows. Nothing
  depends on it: the fleet pass observes and can start or stop nothing, which is why it
  runs on its own interval and its own error boundary.

### Auto Connect (surviving a reboot)
What should be running right now, and the fastest way back to it after the control
plane restarts.

The load-bearing idea is that INTENT AND OBSERVATION ARE DIFFERENT FACTS.
`channels.status` / `events.status` are a cache of what was seen and are routinely
wrong after a crash; `instances` is a claim that something was launched. Neither is a
statement that a stream is meant to be on air. `desired_state` is, and it moves only on
a deliberate act: starting sets it to `running`, a RECORDED stop sets it to `stopped`.
Nothing observational touches it, so "not running, and nobody asked it to stop" becomes
a queryable condition, which is exactly what auto-connect fires on.

What counts as a recorded stop is declared, not inferred: `stopStream` takes a
`StopIntent`. An operator pressing Stop and the scheduler closing an event's window are
recorded. An encoder reporting a fatal fault, or the platform stopping something in
order to restart it, are not, because those are the cases recovery exists for.

On boot, and every `RESUME_RETRY_SECONDS` after it:

- ADOPT BEFORE RESTART. A task container takes no inbound connections, so it does not
  stop when the control plane does. If the launcher says the task is alive, the owner is
  simply marked live again and the day's recording reopened. Nothing is launched and
  nothing is interrupted.
- Restart only what is DEFINITELY dead.
- On `unknown`, do nothing and spend no attempt. An unreachable launcher is not a dead
  task, and launching a second encoder into the same output namespace corrupts the live
  edge rather than merely costing money.

Five attempts, twenty seconds apart, then it stops and records the reason on the row.
The counter is in the database so a crash mid-recovery cannot reset it and loop. Any
operator start clears a give-up, so nothing is ever permanently written off.

ARMED BY A HEALTHY RUN, NOT BY PRESSING START. Intent alone is not enough to be a
candidate: `resume_armed_at` must be set, and the resume pass sets it (`armProvenStreams`)
the first time a run shows SERVER, INPUT, ENCODER and OUTPUT all healthy at once
(PUBLIC is a publishing decision, not evidence). A start that never gets there is a
failed start, and relaunching a failed start five times only buries the reason under
four copies of itself: it is left where it fell, the recovery note says "not armed",
and the QC report's "What went wrong" block (`services/failureDiagnosis.ts`) states the
likely cause with the raw lines it was read from and whether a retry is coming. The
stamp is cleared by a person's Start (the new run proves itself again) and Stop, never
by a fault. A person can also stop auto connect by hand mid-retry
(`POST /:id/auto-connect {enabled:false}` on channels, events and radio); that halts
the loop and touches nothing else, so the evidence stays readable.

Events keep their own scheduling on top of this. The tick still provisions an event when
its window opens and stops it when the window closes; auto-connect is not a second
scheduler and never decides when an event should run. It answers only the reboot
question, which the schedule cannot: "the window is open" is also true of an event a
person deliberately stopped mid-flight.

`auto_connect` defaults to true on channels, stations and events; `AUTO_CONNECT=false`
disables the whole pass for a deployment that prefers to bring its fleet up by hand.

- Code: `services/orchestrator/resume.ts`, `Orchestrator.adoptRunning` /
  `reapOrphanInstances` / `StopIntent` / `StartIntent`, migration `0017`.
- Depends on: the launcher's three-valued liveness answer. Everything here rests on
  `unknown` being a first-class value rather than a boolean.

### The Embeddable Player
A Shaka-based audio player a customer pastes onto their own website, plus the now-playing
enrichment that gives it something to show.

NOW PLAYING. A station's ICY metadata is one line of text. `services/radio/trackMeta.ts`
parses it, looks the recording up in MusicBrainz and takes the artwork from the Cover Art
Archive. Both are open: no key, no account, no display terms. The iTunes Search API was
rejected deliberately, despite better coverage, because Apple's terms require the artwork
to sit beside a store badge for a promotional purpose, which would put every customer's
skin in breach by default.

MusicBrainz permits ONE request per second per application and enforces it by blocking
the IP, so that limit is shared by every tenant whether the code acknowledges it or not.
Three consequences shape the design: the lookup runs in the station's metadata reader and
never in a request path; it goes through a single process-wide queue; and a MISS is
cached as firmly as a hit, because a track nobody knows, retried on every poll for the
twenty minutes it is on air, is what would quietly consume the whole budget. A
low-scoring match is treated as a miss too: wrong artwork is worse than none, because
nobody reports it.

THE PLAYER. `volt-player/` builds one self-contained IIFE, served by the control plane at
`/player/volt-player.js`, so an embed is one script tag from the same origin as the API
and there is no CORS to open. MP3 is tried FIRST — it needs no Media Source Extensions,
starts in one request, and is what a radio embed wants — with HLS and DASH behind it via
Shaka; all three URLs arrive in the session response so a blocked format needs no second
round trip. A layout receives state and commands only, never the Shaka instance, so a
third-party skin can render badly but cannot break playback or reach the session.

THE GATE. A publishable key ships in a web page and is not a secret; what it provides is
attribution and revocation. The ORIGIN ALLOW-LIST is what stops a lifted key working
elsewhere, checked server-side on every call. The station is checked against the key's
account, and a station belonging to another tenant answers exactly like one that does not
exist, so the endpoint is not an oracle for guessing ids.

REPORTING. Player events go to `player_events`, carrying the origin from the request
HEADER rather than the body — "it works on one of our sites and not the other" is the
commonest support question and a client-supplied origin would answer it wrongly. The same
events are forwarded to Google Analytics only if the host page already has it; injecting
gtag.js into somebody's site because they embedded a player is not ours to do.

- Code: `services/radio/trackMeta.ts`, `modules/player.ts`, `volt-player/*`, migration
  `0018`, `volt-web/src/pages/PlayerSetup.tsx`.
- Depends on: the ICY metadata reader for track changes, and the apps/api-keys module for
  the key and origin check.

### Cross-cutting
DVR and recording (the origin window is the live edge + DVR + recording), retention
(seconds, floored to the DVR window), and the cleanup service live across the Packaging,
Delivery and Control Plane modules rather than as a standalone module.

---

## Workflows (routes through the modules)

### Transcode channel, live
Control Plane spins up and provisions (Access and Security for auth + DRM keys) ->
Video Encoder + Watermark and Branding build the ladder -> Transcribe and Translate runs
in parallel on the audio -> Packaging to CMAF + manifests -> Delivery takes it on air
(public URL) -> Status and Health watches the chain; EPG and File Manager feed content
and assets.

### Package channel, live
Same as above minus the Video Encoder re-encode: the source ladder is relayed (-c copy)
straight into Packaging. No watermark burn-in (preview overlay only).

### Event
A scheduled channel: Control Plane provisions on the schedule; otherwise identical to a
transcode or package channel, with the EPG Module driving the schedule.

### Radio / audio-only (building)
Audio Encoder (single in, single out, Icecast or other input) -> Transcribe and
Translate (optional) -> Packaging -> Delivery, with Status showing the live audio
waveform. The lean path: no video ladder, no watermark burn-in.

### Live captions and translation
Runs alongside any channel: Transcribe and Translate taps the program audio, writes
LIVE WebVTT + companion manifests, Packaging carries the subtitle group, the player
renders it natively, Status surfaces the offset and any failure reason.

### On air / public delivery
The operator publishes (Control Plane sets on air, refused until output is valid) ->
Delivery opens the gated public URL -> Access and Security enforces DRM / geo /
replacement -> EPG supplies now and next -> CDN scales it. This is the full production
path.

### Share preview (separate from on air)
File Manager + Access and Security (PIN / expiry, geo rules skipped) + Delivery via the
share link. A private preview of the output for a client or reviewer to approve before
go-live. Does not publish the channel.

### Recording, DVR and clips
Packaging retains the origin window as live edge + DVR + recording; retention prunes it;
clip and review from a recording is building.
