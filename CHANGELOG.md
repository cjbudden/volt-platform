# Volt changelog

Every release, every change: product, SaaS platform and internal. The customer-facing subset is published as the release notes in the docs.

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

