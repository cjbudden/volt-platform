# Volt build queue

The work list the scheduled **Volt build queue** task runs through, one item
per run: build it, validate it, commit, cut a release, record the result here
and in `VOLT_BUILD_STATUS.md`, then stop. The next run takes the next item.
How a run works, and how to validate, is in `BUILD_RUNBOOK.md`.

**Goal of the queue:** every key element in place and tested end to end on a
single Mac server, then ready to deploy to AWS with the Terraform in
`deploy/terraform` and to exercise the cloud-specific functions that make Volt
cost effective (ECS launcher, per-run S3 prefixes, retention and archive,
consolidation, edge rights, scaling).

**Statuses:** `todo` · `doing (since <ISO time>, run <id>)` · `done (vX.Y.Z, <date>)` ·
`skipped: <why>` · `needs input: <question for Christian>` · `blocked: <what>`.
A run takes the FIRST `todo` item. Order is deliberate; do not reorder without
a reason written in the item.

Created 22 Oct 2026 from Christian's list, triaged against the goal.

---

## Phase 1: the Mac single server, end to end

| # | Item | Status | Acceptance and validation | Result |
|---|---|---|---|---|
| 1.1 | **Baseline: every check suite green.** Run `node scripts/check.js` (all suites, own DB each) and fix what fails, or record why a suite cannot run here | todo | A table in the result column: suite, passed/failed, cause of any failure. Fix real product faults; a suite that needs hardware (GPU, Docker, Chrome codecs) is recorded, not faked | |
| 1.2 | **Event page refinements: the three channel-only routes.** `GET /events/:id/access-check`, `GET /events/:id/inputs/:inputId/preview`, `POST /events/:id/health/reset`; point SourcePlayer, HlsOutput geo check and Clear QC at the event versions when `d.kind === 'event'` | todo | Check suite for the three routes (tenancy, 404 for another account, same answer shape as channels). Browser: event page "view as a viewer elsewhere" answers, Clear QC button present for events | |
| 1.3 | **Captions settings screen.** Admin screen to turn live captions on for the account (provider none / whisper / gladia) and set per-profile targets, model and offset. Backend and the master switch exist | todo | Screen under Admin; saving round-trips through the existing API; check suite for the API calls it uses; browser check of save and reload | |
| 1.4 | **Encode tab facts that are not stored yet:** audio tracks and languages, video profile, caption tracks of file encodes, DRM on file encodes (state that they are clear), codec and audio of a package-only source | todo | Stored on the asset at encode/probe time; `GET /api/vod/:id/encode` marks each value stored, not "not recorded"; extend `vod-library.check.ts` | |
| 1.5 | **Smart render seam fix.** Byte-concat the TS parts and regenerate timestamps so the join is seamless (concat demuxer offsets by container duration while the picture ends earlier) | todo | Encoder test: render a clip across a seam with ffmpeg test sources, assert no timestamp gap or overlap (ffprobe packet PTS continuity) | |
| 1.6 | **SCTE-35 / emsg ad signalling (video).** DATERANGE is in; add SCTE-35 cues (EXT-X-DATERANGE SCTE35-OUT/IN for HLS, emsg scte35 for DASH) from ad breaks | todo | Playlist and segment tests: cues present at the break times, valid SCTE-35 binary, players ignore them safely | |
| 1.7 | **ID3-in-emsg now-playing (audio).** Its own path and test, not folded into the video work | todo | Radio HLS/DASH segments carry ID3 TIT2/TPE1 timed to the now-playing changes; test with a synthetic ICY source | |
| 1.8 | **Graphics: live updates over SSE.** Live control currently polls every second; push state changes on the existing status stream | todo | Check suite: an air/state change reaches a subscriber in under 1 s; live control drops the poll | |
| 1.9 | **Graphics: overlays in the Volt player.** Player loads the assigned setup's published version from `/gfx/<version>/` in a sandboxed layer and follows live state | todo | Player test with a sample template: shows, updates, hides; CSP sandbox kept | |
| 1.10 | **Graphics: burn-in in the encoder.** Wire the burn-in sidecar (spike passed) for transcode channels that ask for burnt-in graphics | todo | Encoder test: rendered output frames contain the overlay at the expected time (pixel check) | |
| 1.11 | **Server-side ads: impression and quartile beacons** for stitched breaks, fired server-side, recorded per break | todo | Test against a local VAST stub: beacons hit in order (impression, start, quartiles, complete); report shows them | |
| 1.12 | **Stream model: one list endpoint** over channels, events and FAST channels (`GET /api/live-streams`), list-standard paging and hypermedia | todo | Check suite: all three kinds, filters, tenancy, paging; Live Streams page can use it | |
| 1.13 | **Watch folders: VOD and loop ingest targets** (local folders already work end to end) | todo | Dropping a file into a folder with a vod or loop target lands it in the Media Library or Loops & Fillers; check suite | |
| 1.14 | **Phone layout for the app shell.** Sidebar becomes a drawer under 900 px, top bar condenses, panels stack | todo | Browser checks at 390 px and 768 px: no horizontal scroll on Dashboard, Channels, a channel page, an event page, Media Library | |
| 1.15 | **Mac end-to-end run sheet.** One script and one document that run the whole product path on the Mac (start, failover, captions, record, clip, VOD, publish, radio, event, FAST if playout exists) and print pass/fail per step | todo | `scripts/e2e-mac.sh` + `TESTING_WORKFLOWS.md` §8 updated; dry-run here, full run is Christian's on the Mac | |

## Phase 2: AWS, Terraform and the cost functions

| # | Item | Status | Acceptance and validation | Result |
|---|---|---|---|---|
| 2.1 | **Terraform ready to apply.** `terraform fmt -check`, `terraform validate`, tflint if obtainable; variables documented in `terraform.tfvars.example`; a `deploy/terraform/APPLY.md` runbook for the first apply | todo | Validate passes (or the exact reason it cannot run here is recorded); every variable the app reads at runtime is wired from Terraform (compare `src/config.ts` env vars against the task definitions) | |
| 2.2 | **Per-run S3 prefixes.** Each encoder run writes under its own prefix; the origin pointer moves at a run boundary. Prerequisite for recordings retention and consolidation (CONSOLIDATION.md) | todo | Encoder and control-plane tests on the local S3 driver; existing orchestrator, recordings and clip suites stay green | |
| 2.3 | **S3 retention for recordings** (clips and extracts are done): delete, cool, archive and restore on real S3 keys, using the per-run prefixes | todo | Retention suite against the S3 driver with a mocked client: lifecycle actions issued for the right keys only | |
| 2.4 | **Consolidation: make-before-break handoff.** Act on the planner's moves (start on the target, verify output, switch the pointer, stop the source) instead of advising only | todo | Local test with two encoder processes: output never stalls across the move (playlist continuity check), billing shows one overlap window | |
| 2.5 | **Edge rights: replacement playlists.** Write the `*_rp` playlists (slate spliced over replace windows) so a replace window plays the slate instead of blocking | todo | Playlist tests: replace window shows the slate segments with discontinuity tags; existing edge-rights offline tests stay green | |
| 2.6 | **Watch folders: S3 pickup**, event-driven (S3 notification to SQS to the ingest step), not a walk | todo | Terraform for the bucket notification + queue; handler tested with a sample S3 event; local folder path unchanged | |
| 2.7 | **WAF enforcement (paid add-on).** Terraform for the WAF web ACL on the CloudFront distribution; the Block buttons in Audience write to the rule set; off unless the add-on is on | todo | Terraform validates; API test that blocking adds the rule through a mocked WAF client; add-on gating test | |
| 2.8 | **Tier-3 scaling and chaos harness**, prepared to run against the Tier-2 deployment: kill an encoder task, lose a source, fail an AZ, scale out under load | todo | Scripts and a run sheet in `deploy/loadtest/` with expected outcomes; dry-run here. The real run needs the AWS deployment (needs input) | |

## Phase 3: worthwhile, not on the critical path

| # | Item | Status | Acceptance and validation | Result |
|---|---|---|---|---|
| 3.1 | **Server-side ads: DASH stitching and HLS Interstitials mode** | todo | Stitched DASH plays across a break in dash.js; Interstitials playlist validates | |
| 3.2 | **Frame-accurate access in the product.** Wire `volt-frame-proto` (frame index, JIT frame, JIT clip, trick-play) into the recordings workbench | todo | Existing 15 prototype assertions ported to a check suite; workbench uses it | |
| 3.3 | **Sub-accounts in queries.** Use `accountSubtree()` where a parent account reads its children | todo | Tenancy suite: parent sees children, child never sees parent or siblings | |
| 3.4 | **Relay capacity and load balancing across Icecast relays** (measured and decided, not built) | todo | Two local relays, listeners spread, a relay loss moves listeners | |
| 3.5 | **Microsoft / Google sign-in (OIDC).** Exchange built and tested against a local mock IdP | todo | Sign-in round trip with the mock; real tenant test needs app registrations (needs input) | |
| 3.6 | **Timeline mode, later phases.** Only after FAST playout exists; check TIMELINE_MODE.md first | todo | As TIMELINE_MODE.md phase 2 defines | |

## Set aside

| Item | Status |
|---|---|
| Automatic now-playing / EPG detection (guide feeds, fingerprinting, transcript) | needs input: which route first (broadcaster guide adapters, a fingerprint vendor and its cost, or transcript only), and for which stations |
| TAMS read-side API | needs input: is TAMS interoperability needed for a customer or partner now, or later |
| SportsML-G2 ingest and typed SportsTeam entities | needs input: extend `target_kind` beyond streamable things (a decision on the entity model) |
| Loop origin on channels | needs input: what a loop channel is in the product, separate from FAST |
| API docs for the six new library routes | done before the queue (regenerated 22 Oct; `docs.check.sh` covers it) |
| Axinom DRM and FairPlay playback | needs input: Axinom tenant id and key; Apple FairPlay deployment package and licence endpoint |
| Social publishing | needs input: developer app registrations |
| AWS first apply and Tier-3 real run | needs input: AWS account, credentials and region for the Tier-2 deployment |

---

## Run log

One line per run, newest first: date, item, outcome, release.

