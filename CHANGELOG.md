# Volt changelog

Every release, every change: product, SaaS platform and internal. The customer-facing subset is published as the release notes in the docs.

## 0.11.0 (2026-10-23)

### Product (in customer release notes)

- added · Player: Every Volt player now has a Playback stats panel: right-click the picture (or press Shift+D) to see the resolution, dropped frames, codecs, bitrate, connection speed, buffer, live latency and the CDN edge that served the stream, and copy it all for a support ticket. In the console it is on the channel output monitor (a Stats button beside HLS / DASH), the source and output previews, and every recording and media preview.
- added · FAST: Stitched ad breaks now report to your ad server: Volt sends each ad's impression, start, quartile, progress and complete trackers itself as each viewer's player reaches them, so a viewer who leaves halfway counts no complete. The channel's ad report shows impressions, completion and any tracker that failed, and the API gives the same per break.

### Internal

- added: New check suite fast-beacons (51 checks): server-side ad beacons end to end with a local VAST stub and a stand-in playout.

## 0.10.0 (2026-10-23)

### Product (in customer release notes)

- added · Graphics: Graphics set to Burned into the video now appear in the picture itself on transcode channels and events, so every viewer, recording, clip and third-party player sees them. Take them on, change them and take them off in live control as usual; they reach the encoded picture in well under a second, and leave it during ad breaks that hide graphics. A graphic assigned to burn while the stream is running appears from its next start.

### Internal

- added: Encoder: graphics renderer (headless Chromium, volt-encoder/gfx) and a composite-once filter graph for burned graphics, the burn feed for it (GET /api/streams/:id/burn-graphics, ingest token), GRAPHICS_BURN build argument for the encoder image, and the graphics-burn and test_gfx_burn checks.

## 0.9.0 (2026-10-23)

### Product (in customer release notes)

- fixed · Player: A Volt player created in code without naming a skin now gets the standard video look. Before, it could show with no picture area.
- changed · Player: Graphics in viewers' players now only use published template versions. A setup that is trying out a draft still works in the console preview and live control, and appears in players once it is moved to a published version.

### Internal

- added · Player: Browser check of player graphics end to end: shows, updates and hides through the operator API, and the template stays sandboxed (test/player-overlay-browser.check.ts).

## 0.8.0 (2026-10-23)

### Product (in customer release notes)

- improved · Graphics: Graphics live control, the running event rundown and a channel's graphics tab now update the moment anything changes (another operator's take, an API or feed update, a rundown cue, a rule going on at a programme start) instead of checking every second.

### Internal

- added · Graphics: graphics-live-push check suite (32 assertions): every graphics state change reaches a status stream subscriber as a gfx frame within a second, tenancy and permissions, and the consoles no longer poll.

## 0.7.0 (2026-10-23)

### Product (in customer release notes)

- added · Radio: HLS and DASH listeners now see the song and artist change inside the stream itself, at the moment it is heard: each title change on a station is carried in the audio as standard ID3 timed metadata, which Safari, hls.js, Shaka and dash.js read with no extra code.

### Internal

- added · Radio: Check suites for now-playing ID3 in emsg: radio-id3 (end to end with a synthetic ICY source and the real radio container) and test_id3_emsg.py (bytes, placement, which segments carry a tag); Dockerfile.radio now ships id3_emsg.py and a test fails if a module radio.py imports is not copied.

## 0.6.0 (2026-10-22)

### Product (in customer release notes)

- added · Channels: Ad breaks on live channels and events now carry SCTE-35 in the delivered streams: an SCTE-35 cue on the break in HLS, cue out and cue in on the segments it covers, and an SCTE-35 event in DASH. Downstream ad insertion and distribution partners see every break you start, schedule or send through the API.

### Internal

- added · Encoder: New check suite live-scte35 (break row to encoder poll to the real encoder placement, cues decoded back) and SCTE-35 placement cases in test_timed_events.py.

## 0.5.1 (2026-10-22)

### Internal

- fixed: Clip smart render: the join no longer leaves a gap after the copied middle (23 ms at 25 fps, 30 ms at 50 fps). Each part's length is now taken from its picture, and every render is checked frame by frame for gaps or overlaps before it is used. Smart render stays off by default.

## 0.5.0 (2026-10-22)

### Product (in customer release notes)

- improved · Media Library: The Encode tab now shows what each asset actually carries, read from its own files: the video profile and level of every rendition, each audio track with its codec, channels, sample rate and language, and, for a package-only stream, the codec and audio the contributor sent. File encodes also say which of the source's audio tracks was used, that subtitle tracks in the file are not carried yet, and that the result is not DRM protected.

### Internal

- added: Media facts for VOD assets: vod_assets.media_facts (migration 0077) from ffprobe of the delivered init segments, written by vod.encode and read once for recording-derived assets; vod_encoder.py probe lists every audio and subtitle track. vod-library.check.ts grows to 79 assertions and vod-library-pure.check.ts to 154.

## 0.4.0 (2026-10-22)

### Product (in customer release notes)

- added · Account: A new Captions page under Admin turns live captions on for the account, picks the engine (self-hosted Whisper or the Gladia service), and sets each output profile's caption languages, the language spoken, the delay that keeps captions in step with the picture, and the Whisper model. A profile used by a running stream is shown locked until that stream stops.

### Internal

- added: Captions settings API (/api/account-settings/captions) with its check suite, captions-settings.check.sh (38 assertions); the caption language list now lives in one module the API validates against.

## 0.3.0 (2026-10-22)

### Product (in customer release notes)

- added · API: New event routes matching the channel ones: GET /api/events/{id}/access-check, GET /api/events/{id}/inputs/{inputId}/preview and POST /api/events/{id}/health/reset.
- fixed · Events: On the event page, 'View as a viewer in' now answers for the event instead of showing Could not check, and an HLS source that blocks playback from other sites now previews through Volt.
- fixed · Events: The event page no longer goes blank once a live event's output starts playing.
- added · Events: The event page now has Clear QC, like the channel page: it resets the event's health after an earlier fault, and the fault stays in the event log.

### Internal

- added: Check suite event-routes.check.sh for the three event routes (tenancy, shape parity with channels, token binding, Clear QC effects, role).

## 0.2.1 (2026-10-22)

### Product (in customer release notes)

- fixed · FAST: Taking a FAST channel on or off air now counts towards its on-air hours and as-run reports, the same as any other channel. Before, those hours were missing from the totals.
- fixed · Radio: The Now playing column in the station list now shows the same line as the station page. A station on an HLS source, which cannot send titles, shows a dash instead of Untitled break, and Untitled break is kept for an Icecast station between two titles.

### Internal

- fixed · Tests: Baseline of all 179 check suites, each on its own database: 178 pass. Suites that drifted from the product were brought up to date (10 character passwords, roles model, platform sign-in with an authenticator code, plan allocation, kept metadata keys, smart render, the audio_radio skin). Fixture faults fixed: a docs test user and clashing fixture ids in the check seed, invited test users, and test media that suites now make themselves (smart render, ingest extract). New helpers test/lib/platform-session.sh and test/lib/react-global.ts.

## 0.2.0 (2026-10-22)

### Product (in customer release notes)

- fixed · EPG: Add EPG on a channel page now opens that channel's programme guide. It previously showed an error.
- improved · Monitoring: The channel event log no longer repeats a harmless packager timing warning every few seconds. It is summarised once a minute, and real audio gaps are still reported in full.
- fixed · Encoder: Transcoded audio is now always delivered at 48 kHz, which removes a recurring audio timing warning from the channel log when the source is 44.1 kHz.
- improved · EPG: When a guide can't be shown because its channel, event or station no longer exists, the page now says why and offers to choose another guide or create a new one.
- improved · API: Each service in the API reference now opens with what it is for, its key tasks and the access it needs.
- added · API: Every list in the API (VOD, recordings, jobs, channels, events, programme guide, users and more) now searches, filters, sorts and pages the same way: q, field=value, field[op]=value, sort=-field, limit and cursor. The API reference lists each list's fields and operators.
- fixed · API: Filtering VOD by recordingId now works (it was ignored), and an invalid limit on a stream's event history is refused with a clear message instead of an error.
- fixed · VOD: Uploaded and watch-folder assets can now be published, shared, found in search and counted in review and QC, like recorded assets. Assets recorded from events can now be shared too.
- added · Analytics: Operating reports for every channel, station and event: each run with its start, end, time on air and why it stopped, plus availability, faults, time to recover and audience peak, for any period and as a CSV download. Find them under Analytics, Operating.
- added · API: The hypermedia view of the API (send `Accept: application/ld+json` or add `?format=jsonld`) now covers every list and record. Every list is a Hydra collection with the full match count, first, previous, next and last page links, and its filters as a search template. Every record carries a breadcrumb from the entry point, links to its siblings, and one link per sub-resource. `GET /api` links every collection, and `GET /api/doc` declares each resource's operations (method, input and output) and properties. Plain JSON responses are unchanged and point at the hypermedia view with a `Link: rel="alternate"` header.
- fixed · Encoder: Channels using the Whisper captions add-on no longer also start a second transcription inside the encoder, which failed on every run with an import error.
- added · Encoder: FairPlay: DRM channels now carry the FairPlay key tag (SAMPLE-AES, com.apple.streamingkeydelivery) in their HLS playlists, using the key URI from your key service, alongside Widevine and PlayReady. The first seconds of each stream are now encrypted too (they were left in the clear).
- added · API: Lists now page both ways: the Link header carries rel="prev", "first" and "last" alongside "next" (with an X-Prev-Cursor header). Filler assets, scheduled clips, publish targets, publications and programmes can now be read by id (GET /api/<resource>/{id}), so every record's link opens it.
- added · Encoder: Live captions with Gladia: the Gladia engine now transcribes and translates live through one streaming session per run, written as WebVTT subtitle tracks like the Whisper engine.
- added · VOD: The Media Library has a grid view beside the list, with keyscreens, content type, availability, how complete each asset's metadata is and its top rendition. Filter by content type, availability, source, missing required metadata, resolution, codec, date and duration, and share the filtered view by its link. Each asset shows the metadata its type needs (an episode's series, season and episode number, a match's teams) and can fill it from the programme guide, never replacing what you typed. A new Encode tab shows the renditions, audio, captions, packaging and DRM.
- fixed · Recordings: On cloud (S3) storage, retention rules now really delete, cool and archive clip media in the bucket. Before, a deleted clip was marked deleted but its files stayed in storage.
- fixed · API: Paging through a list sorted by a time (for example sort=created_at) no longer repeats the last record of each page or skips records created in the same millisecond.
- added · EPG: Plan against as-run: the guide now records what actually aired (actual start and end, live while airing, aired when done) from the channel's own runs, and GET /api/epg/as-run compares plan and as-run per programme with on-air, source and filler time and whether it aired, partly aired or was missed.
- fixed · Encoder: Programme start and end markers in the stream now reach viewers on every channel. Before, they were only present on channels with subtitles or a backup source.
- added · Monitoring: QC shows a Captions lane for channels with live captions: starting, healthy, degraded (windows skipped) or failed with the reason and how to fix it. A captions problem never turns the channel red.
- added · API: Stream aggregate API: GET /api/live-streams/{channel|event}/{id} shows a stream as its production plane (origin, processing profile, placement) and distribution plane (schema.org VideoObject published by a BroadcastEvent, metadata, availability), its preset (live channel, live event, FAST channel) and its source-provider contract per tier (delivery, descriptive, guide, timed, rights, control). /schema.org serves the JSON-LD, with the sports fixture as broadcastOfEvent for sports events.
- fixed · Channels: Switch source and force slate or loop from the Failover panel now reach the encoder on cloud deployments (it runs on another server). Each choice is recorded in the channel's log with who made it, and a restart always returns to automatic.
- added · Player: Channels with a programme guide now carry an Up next notice in the stream itself, towards the end of each programme. The Volt player shows it with the next title, image and a countdown, and you can set when it appears per channel or turn it off in Player setup.
- fixed · Channels: A loop video chosen as a channel's fallback is now played as a loop. It was being treated as a still image.
- added · Monitoring: An On air button in the top bar shows how many streams are on air, degraded or failed, from any page, and opens a list with a link to each.
- added · Channels: Channel and event pages list every output address, private monitoring and public playback, each with its own preview, Copy button and live status.
- added · Channels: Channel and station pages can be arranged: move panels, minimise them or hide them, and reset to the default. Each person's layout is kept in their browser.
- added · Events: Each event now has its own page: the schedule with its server, event and public windows, source and output players, output addresses, viewers, status, event log and the recordings it made.
- fixed · Channels: Long pages no longer show a lighter band partway down the background when scrolled.
- fixed · EPG: Plan against as-run is recorded for television channels again. A database error stopped it on every pass.
- changed · Channels: Slates and loops for channels, stations and events are now chosen from Loops & Fillers, which shows which streams use each one. A slate picked from the Image Library before this keeps working and can be copied into Loops & Fillers in one step. Deleting a slate or loop that a stream uses now asks first and names the streams.
- changed · Account: The main menu now holds the pages you use every day. Setup, account and access pages have moved into an Admin area, with a link back to the page you left, and Ctrl K (⌘K on a Mac) jumps to any page or stream.

### SaaS platform

- added: Customer documentation site with guides, an interactive API reference and release notes, available to signed-in users from Volt.

### Internal

- added: Release tooling: change notes, scope rules, pre-commit check and a single release command. OpenAPI spec generated from the route inventory and captured requests.
- added: API list standard helper (listQuery), generic list test across all list endpoints, VOD ownership regression test, API_STANDARDS.md.
- added: Edge rights: a CloudFront Function on manifests enforces account and channel geo and programme blackouts from a KeyValueStore the control plane keeps current (off until EDGE_RIGHTS_KVS_ARN is set and the KeyValueStore SDK is installed). Move to a core note when it is switched on.
- added: Encoder health endpoint on HEALTH_PORT: /healthz (liveness, used by the ECS health check), /readyz, /metrics (Prometheus) and /status.
- changed: Baseline includes Media Library work in progress from a parallel session (asset images, music providers, song details) and a type fix in the FAST page.
- fixed: The API reference builds again: four services (FAST, Graphics, Live Streams, graphics delivery) were missing their usage statements. Two new Loops & Fillers routes documented; dev proxy passes /live/<id>/ to the API.

