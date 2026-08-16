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
