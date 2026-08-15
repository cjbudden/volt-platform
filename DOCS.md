# Volt — project map & index

**This repo is the single source of truth.** Not the chat history. Every design
doc, workflow, test, script and status board lives here, travels with every
`git pull`, and is versioned in `git log`. If something was built, solved, or
decided, it is captured in one of the places below — start here, not by scrolling
old conversations. Artifacts pinned in chat are convenience copies; the real,
current version is always the file in this repo.

---

## Where do I look for…?

| I want to know… | Look here |
|-----------------|-----------|
| **What exists and its state** (done / ready to test / pending) | Feature tracker → `feature-tracker/` · Build board → `VOLT_BUILD_STATUS.md` / `volt_build_status.html` |
| **The current north-star design for encoding** | `volt-app/docs/ENCODING_WORKFLOW_PLAN.md` |
| **How a subsystem was designed & why** | Design docs (below) |
| **The history of a change** (what changed, when, why) | `git log --oneline` — every change is a commit with a message |
| **How to run / test locally** | This page's *Run & test* + *Test base* sections |
| **The API** (params, payloads, hypermedia) | `volt-app/docs/API.md` + Postman collection |
| **A specific file** | It's in this repo; the important ones are linked below |

**Fast orientation (do this at the start of any work session):**
1. Read this file (the map).
2. `git log --oneline -20` — see what changed recently.
3. Open the feature tracker for current status.
4. For encoding work, re-read `ENCODING_WORKFLOW_PLAN.md`.

---

## Status & tracking
- **Feature tracker** — `feature-tracker/features.json` (+ `tracker.html`). 23 product
  features with status (`done` / `ready_to_test` / `in_progress` / `pending`), how to
  test each, and any feedback. This is the "what's built vs open" list.
- **Build status board** — `VOLT_BUILD_STATUS.md` (markdown) and `volt_build_status.html`
  (open in a browser). Every capability + state.
- **History** — `git log`. Each commit message states what changed and why. To see
  the story of a file: `git log --oneline -- path/to/file`.

## The plan (north star)
- **[Encoding workflow plan](volt-app/docs/ENCODING_WORKFLOW_PLAN.md)** — the five-gate
  model (server → input → encoder → output → public), the status/error/QC model,
  local↔cloud, provisioning & billing, and auto-profile selection. The current
  reference for all encoding/status/error work.

## Design docs (`volt-app/docs/`)
- [SaaS architecture](volt-app/docs/SAAS_ARCHITECTURE.md) — the original platform workflow & tiers.
- [Forms & fields](volt-app/docs/DESIGN_forms_and_fields.md) — channel/event form design.
- [Source preview & monitor](volt-app/docs/DESIGN_source_preview_monitor.md) — previewing any source type.
- [Frame-accurate media access](volt-app/docs/DESIGN_frame_access.md)
- [On-the-fly image service](volt-app/docs/DESIGN_image_service.md)
- [File manager + watchfolder ingest](volt-app/docs/DESIGN_file_manager_watchfolder.md)
- [API access map (public vs admin)](volt-app/docs/API_ACCESS_MAP.md)

## Workflow docs (`volt-app/docs/`)
- [Captions + translation](volt-app/docs/WORKFLOW_captions_translation.md)
- [Share page](volt-app/docs/WORKFLOW_share_page.md)
- [Social publishing](volt-app/docs/WORKFLOW_social_publishing.md)

## API
- [API reference](volt-app/docs/API.md) · [API additions](volt-app/docs/API-additions.md)
- Postman — `volt-app/api/Volt.postman_collection.json` (+ `Volt.postman_environment.json`)

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
`DATABASE_URL` to a scratch DB — see `README.md`).

**Control plane — `volt-app/test/`**
- `orchestrator.check.ts` — provisioning: primary + backup renditions, failover, teardown.
- `tenancy.check.ts` — multi-tenant hierarchy (parent → children → grandchild) isolation.
- `epg-pure.check.ts` / `epg.check.sh` — EPG: RRULE materialization, guide window, effective-end.
- `autovod.check.ts` — auto-VOD from a completed event recording.
- `vod-extractor.check.ts` — VOD extractor pure logic: segment selection/snapping.
- `retrim.check.sh` — non-destructive clip re-trim (change in/out, original preserved).
- `captions-plan.check.ts` — decides if a stream needs the heavy Whisper task.
- `captions-orchestration.check.ts` — separate captions task launched, tracked, torn down.
- `captions-toggle.check.ts` — account captions_provider master toggle (none/whisper/gladia).
- `metadata-events.check.ts` — metadata-on-events: schema composition + target_kind enforcement.
- `access-control.check.sh` — admin routes unreachable without admin auth (the access map).
- `apps.check.sh` — apps + API keys: publishable key once, /availability gate.
- `edit-audit.check.sh` — create stamps created_by + audit; partial PATCH + version.
- `geo-rights.check.sh` — play gate: blackout on a current programme blocks playback.
- `hypermedia.check.sh` — JSON-LD + Hydra: entrypoint, context, ApiDocumentation.
- `mfa-login.check.sh` — SaaS-admin 2-step login: password → TOTP → session.
- `totp.check.ts` — RFC 6238 TOTP correctness.
- `notifications.check.sh` — templated send fans out to recipient × channel deliveries.
- `saas.check.sh` — analytics ingest + reports, platform dashboard, support.
- `share-links.check.sh` — admin creates a share link, public resolves it (isolated).
- **API contract** — `volt-app/api/verify.sh` (Newman, runs the Postman collection).

**Encoder — `volt-encoder/`**
- `validate.sh` — REAL encoder against a synthetic source (HLS path), offline.
- `validate-docker.sh` — ALL encoder functions incl. **SRT ingest**, inside the Linux image.

**Prototypes**
- `volt-frame-proto/test.mjs` — 15/15 frame-accuracy assertions.
- `volt-image-proto/test.mjs` — 14/14 image-service contract checks.

**End-to-end** — `e2e/run-e2e.sh` (brings up the stack, runs the pipeline, checks output);
plus `e2e/local-pipeline-test.sh`, `e2e/source-ladder.sh`, `e2e/extractor-test.sh`.

---

## Keeping this repo in sync
Claude edits the canonical repo directly and commits; you `git pull` (or the files
are already in your local folder). To sync GitHub, `git push origin main` from your
terminal. (The old `volt-update.bundle` / `publish.sh` flow is retired.)

## How we avoid re-solving or re-breaking things
1. **Every change is a commit** with a message — `git log` is the memory of what was done.
2. **Status lives in the feature tracker**, not in chat — check it before starting.
3. **This map** links every doc/test/script — if it's not here, add it here.
4. When a bug is fixed or a feature lands, its commit + the feature tracker entry are
   the record. Re-reading those (not the chat) is how we confirm something's already done.
