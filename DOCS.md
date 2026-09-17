# Volt, project map & index

**This repo is the single source of truth.** Not the chat history. Every design
doc, workflow, test, script and status board lives here, travels with every
`git pull`, and is versioned in `git log`. If something was built, solved, or
decided, it is captured in one of the places below, start here, not by scrolling
old conversations. Artifacts pinned in chat are convenience copies; the real,
current version is always the file in this repo.

---

## Where do I look for…?

| I want to know… | Look here |
|-----------------|-----------|
| **What exists and its state** (done / ready to test / pending) | Feature tracker → `feature-tracker/` · Build board → `VOLT_BUILD_STATUS.md` / `volt_build_status.html` |
| **The current north-star design for encoding** | `volt-app/docs/ENCODING_WORKFLOW_PLAN.md` |
| **How a subsystem was designed & why** | Design docs (below) |
| **Why the subtitles line up** (and how to prove it again) | `CAPTIONS.md` + `volt-encoder/synctest.sh` |
| **The history of a change** (what changed, when, why) | `git log --oneline`, every change is a commit with a message |
| **How to run / test locally** | This page's *Run & test* + *Test base* sections |
| **The API** (params, payloads, hypermedia) | `volt-app/docs/API.md` + Postman collection |
| **A specific file** | It's in this repo; the important ones are linked below |

**Fast orientation (do this at the start of any work session):**
1. Read this file (the map).
2. `git log --oneline -20`, see what changed recently.
3. Open the feature tracker for current status.
4. For encoding work, re-read `ENCODING_WORKFLOW_PLAN.md`.

---

## Status & tracking
- **Feature tracker**, `feature-tracker/features.json` (+ `tracker.html`). 23 product
  features with status (`done` / `ready_to_test` / `in_progress` / `pending`), how to
  test each, and any feedback. This is the "what's built vs open" list.
- **Build status board**, `VOLT_BUILD_STATUS.md` (markdown) and `volt_build_status.html`
  (open in a browser). Every capability + state. The HTML is GENERATED from the
  markdown, `node scripts/build-status.mjs`, so edit the markdown and re-run it.
- **History**, `git log`. Each commit message states what changed and why. To see
  the story of a file: `git log --oneline -- path/to/file`.

## The plan (north star)
- **[Encoding workflow plan](volt-app/docs/ENCODING_WORKFLOW_PLAN.md)**, the five-gate
  model (server → input → encoder → output → public), the status/error/QC model,
  local↔cloud, provisioning & billing, and auto-profile selection. The current
  reference for all encoding/status/error work.

## Design docs (`volt-app/docs/`)
- [SaaS architecture](volt-app/docs/SAAS_ARCHITECTURE.md), the original platform workflow & tiers.
- [Forms & fields](volt-app/docs/DESIGN_forms_and_fields.md), channel/event form design.
- [Source preview & monitor](volt-app/docs/DESIGN_source_preview_monitor.md), previewing any source type.
- [Frame-accurate media access](volt-app/docs/DESIGN_frame_access.md)
- [On-the-fly image service](volt-app/docs/DESIGN_image_service.md)
- [File manager + watchfolder ingest](volt-app/docs/DESIGN_file_manager_watchfolder.md)
- [Media Library](volt-app/docs/DESIGN_media_library.md), publishing rules, metadata by content type (schema.org standard schemas, event types, EPG field mapping), availability / geo / paywall defaults with per-asset override, uploads + encoding profile. Preview + rename built.
- [API access map (public vs admin)](volt-app/docs/API_ACCESS_MAP.md)
- [Pages and embeds](volt-app/docs/DESIGN_pages_and_embeds.md), one Page object with three
  framings (public, iframe, share token), the module catalogue, composition templates, and
  the iframe mechanics. The base the portal builder would grow from.
  Working sketch: `volt-app/docs/pages-and-embeds-mock.html` (open in a browser), template
  and framing switcher over the module catalogue.
- [Presentation framework](volt-app/docs/DESIGN_presentation_framework.md), the player, its
  skins, embed vs SDK, telemetry, advertising seams, share/QC pages and which workflows ship.
  Working mock: `volt-app/docs/share-page-policy-mock.html` (open in a browser), the share
  page driven by the real workflow policy module.

## Workflow docs (`volt-app/docs/`)
- [Captions + translation](volt-app/docs/WORKFLOW_captions_translation.md)
- [Share page](volt-app/docs/WORKFLOW_share_page.md)
- [Social publishing](volt-app/docs/WORKFLOW_social_publishing.md)

## API
- **[Embedding the player](volt-app/docs/EMBEDDING.md)**, customer-facing: the JS embed, the
  iframe embed, every attribute, the SDK, headless mode, events, postMessage, and the
  things that go wrong.
- [API reference](volt-app/docs/API.md) · [API additions](volt-app/docs/API-additions.md)
- Postman, `volt-app/api/Volt.postman_collection.json` (+ `Volt.postman_environment.json`)

---

## Run & test

| Task | Command |
|------|---------|
| **Run the whole app locally (Layer 1, native encoder)** | `bash run-on-mac.sh` → http://localhost:5173 (admin@rtm.example / volt1234) |
| **Run with the Docker encoder (Layer 2, prod-parity ffmpeg incl. SRT)** | `ENCODER_MODE=docker bash run-on-mac.sh` |
| **Reset the demo DB** | `RESET_DB=1 bash run-on-mac.sh` |
| **Control plane only** | `cd volt-app && ./run-local.sh` |
| **Encoder offline validation** | `cd volt-encoder && bash validate.sh` (HLS) · `bash validate-docker.sh` (ALL, incl. SRT) |
| **Full media e2e** | `bash e2e/run-e2e.sh` |

Encoder run details: `volt-encoder/RUN_LOCAL.md`. Quick-start narrative: `volt-app/TEST_TONIGHT.md`.

## Test base (what each test covers)

Run TS checks with `npx tsx <file>`; shell checks with `bash <file>` (most need a
`DATABASE_URL` to a scratch DB, see `README.md`).

**Control plane, `volt-app/test/`**
- `orchestrator.check.ts`, provisioning: primary + backup renditions, failover, teardown.
- `tenancy.check.ts`, multi-tenant hierarchy (parent → children → grandchild) isolation.
- `epg-pure.check.ts` / `epg.check.sh`, EPG: RRULE materialization, guide window, effective-end.
- `waveform-holes.check.ts`, waveform: a hole in a run never shifts what follows it.
- `waveform-cache.check.ts`, waveform: the 100ms envelope cache (a window measured once is
  served with no decode, legacy caches upgrade, primer progress) and the incremental segment
  index scan. Needs ffmpeg, no database.
- `auto-connect.check.ts`, auto connect: intent vs status, adopt before restart, five
  attempts then give up, armed only by a healthy run, stopped by hand (needs a DB).
- `recovery-note.check.ts`, the console's one-sentence recovery notice (pure).
- `failure-diagnosis.check.ts`, the QC "what went wrong" classifier: one fixture per
  cause, evidence carried, retry note (pure).
- `content-types.check.ts`, the standard content types (seed table sanity, inheritance,
  EPG field mapping) (pure).
- `publishing-rules.check.ts`, the publishing ladder resolves per field (account < type <
  owner < asset), paywall clearing, availability windows (pure).
- `access-rules.check.ts`, the FOR / IF / THEN / TERMS access rules engine: first match,
  members, premium + entitlements, geo in / not in, content types, term periods (pure).
- `ingest-core.check.ts`, the upload and ingest framework core: name sanitising and
  naming/structure modes, the ingest rules ladder (account < type < source < item, first
  match by ordinal, deferred facts), duplicate matching and actions, real type from magic
  bytes, ID3v2 reading, metadata merge into a content type, sidecar/webhook payload (pure).
- `tus.check.ts`, the tus 1.0.0 endpoint over real HTTP with the memory store: options,
  version and auth errors, creation, HEAD, sequential PATCH, offset conflict, checksum
  mismatch rollback, over-length, completion hook, creation-with-upload, termination.
- `ingest-s3.check.ts`, the S3 destination (single put, multipart in parallel, abort on a
  failed part, sidecar beside the object) and the S3 watchfolder mirror (quiet time, junk,
  known objects, review prefix) against an in-memory bucket (pure).
- `ingest-sources.check.ts`, remote sources over a fake provider on localhost: the parallel
  range fetcher (reassembly, retry of one range, single-stream fallback, short body), and
  the URL, Dropbox, OneDrive and Google Drive adapters (describe, locate by path / name and
  size, unlinked errors, picker token).
- `ingest-providers.check.ts`, accelerated transfer providers against fake endpoints:
  Aspera (upload_setup request, transfer spec launch, event parsing, poll), MASV and
  Signiant (package creation, portal launch, webhook parsing) and S3 Transfer Acceleration
  presigned PUT URLs with fixed credentials (pure).
- `agent.check.ts`, the desktop agent (`volt-agent/`): sync root detection for macOS and
  Windows Drive / OneDrive / Dropbox paths, cloud-only heuristic, and one pass against a
  fake Volt on localhost (locate then cloud to cloud, tus upload with provenance, quiet
  time, junk, idempotent state). Compile with `--rootDir ..` since it imports volt-agent.
- `ingest-extract.check.ts`, extract() over real files made with ffmpeg (an ID3-tagged
  mp3, a mov, a mov named .mp3). Needs ffmpeg/ffprobe; pass the directory as argv[2].
- `autovod.check.ts`, auto-VOD from a completed event recording.
- `vod-extractor.check.ts`, VOD extractor pure logic: segment selection/snapping.
- `retrim.check.sh`, non-destructive clip re-trim (change in/out, original preserved).
- `captions-plan.check.ts`, decides if a stream needs the heavy Whisper task.
- `captions-orchestration.check.ts`, separate captions task launched, tracked, torn down.
- `captions-toggle.check.ts`, account captions_provider master toggle (none/whisper/gladia).
- `metadata-events.check.ts`, metadata-on-events: schema composition + target_kind enforcement.
- `workflow-policy.check.ts`, the workflow policy chain (defaults → deployment →
  account → link), the partial-override rule, the env reader, and which actions a
  share page may offer under each policy. 20 assertions, pure logic.
- `event-promo.check.ts`, the schema.org projection: template inference from the
  data's own shape, promo fields from SportsEvent/Person, `eventStatus` to phase,
  and JSON-LD back out. 17 assertions, pure logic.
- `access-control.check.sh`, admin routes unreachable without admin auth (the access map).
- `apps.check.sh`, apps + API keys: publishable key once, /availability gate.
- `edit-audit.check.sh`, create stamps created_by + audit; partial PATCH + version.
- `geo-rights.check.sh`, play gate: blackout on a current programme blocks playback.
- `hypermedia.check.sh`, JSON-LD + Hydra: entrypoint, context, ApiDocumentation.
- `mfa-login.check.sh`, SaaS-admin 2-step login: password → TOTP → session.
- `totp.check.ts`, RFC 6238 TOTP correctness.
- `notifications.check.sh`, templated send fans out to recipient × channel deliveries.
- `saas.check.sh`, analytics ingest + reports, platform dashboard, support.
- `share-links.check.sh`, admin creates a share link, public resolves it (isolated);
  channel shares without going on air, custom expiry, PATCH (extend / PIN on+off / cap),
  rotate (old URL dies), scoped list, email deliveries. 42 assertions.
- `radio-brand.check.ts`, audio-only (radio) job config: no video ladder or GPU, AAC
  rung defaulting, video path untouched, and brand never becoming an encoder overlay.
- **API contract**, `volt-app/api/verify.sh` (Newman, runs the Postman collection).

**Encoder, `volt-encoder/`**
- `validate.sh`, REAL encoder against a synthetic source (HLS path), offline.
- `validate-docker.sh`, ALL encoder functions incl. **SRT ingest**, inside the Linux image.
- `synctest.sh <name> <seconds>`, **the caption-sync verdict**. Runs a real channel against
  a real live source, then measures in seconds how far the subtitles are from the words.
  Reports start-up, ingest health, clean stop, sync error, coverage, WER, and what a real
  player shows. Use this whenever anything in the caption or timeline path changes.
- `bin/syncheck.py`, the measurement behind it: decodes the audio a run ACTUALLY
  delivered, transcribes it offline with word timestamps, and reports the placement error
  of every published cue. Also reports PDT step error and how much delivered audio is
  missing. Trusts nothing the encoder says about itself.
- `bin/playercheck.py` (+ `bin/player_probe.html`), plays a run in headless Chromium with
  hls.js and records which cue is on screen at each playhead position, plus stalls,
  start-up and playback rate. `--vod` closes the DVR window so a stopped run replays whole.
- `bin/test_player_alignment.py`, integration test: cues whose text states the media time
  they claim, played in a real browser, checked against where the playhead actually was.
  This is what catches a misinterpreted `X-TIMESTAMP-MAP`, which looks perfect on disk.
- `bin/test_companion_pdt.py` (37), timeline maths: tfdt/mdhd parsing, PDT from the media
  timeline, one shared epoch for video and subtitles, playlist shape, HLS variant choice.
- `bin/test_captions.py` (58), caption engine: cue shaping from word timestamps, window
  boundary splitting, model defaults, translation routing, segmentation.
- `bin/capbench.py`, text-quality benchmark against the Unified vod2live demo's own
  professional subtitle track (complements syncheck, which measures placement).

**Prototypes**
- `volt-frame-proto/test.mjs`, 15/15 frame-accuracy assertions.
- `volt-image-proto/test.mjs`, 14/14 image-service contract checks.

**End-to-end**, `e2e/run-e2e.sh` (brings up the stack, runs the pipeline, checks output);
plus `e2e/local-pipeline-test.sh`, `e2e/source-ladder.sh`, `e2e/extractor-test.sh`.

---

## Keeping this repo in sync
Claude edits the canonical repo directly and commits; you `git pull` (or the files
are already in your local folder). To sync GitHub, `git push origin main` from your
terminal. (The old `volt-update.bundle` / `publish.sh` flow is retired.)

## How we avoid re-solving or re-breaking things
1. **Every change is a commit** with a message, `git log` is the memory of what was done.
2. **Status lives in the feature tracker**, not in chat, check it before starting.
3. **This map** links every doc/test/script, if it's not here, add it here.
4. When a bug is fixed or a feature lands, its commit + the feature tracker entry are
   the record. Re-reading those (not the chat) is how we confirm something's already done.
