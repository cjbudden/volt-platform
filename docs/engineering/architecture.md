# Architecture and service map

Volt is one control plane on one Postgres database. The control plane starts
encoder processes, they write CMAF segments to an origin, and viewers fetch
them through the API's public live routes on the Mac or through CloudFront in
AWS. The module-by-module design and the workflows through the modules are in
`ARCHITECTURE.md`; this page is the map of processes and where their code is.

## The processes

| Process | Code | On the Mac | In AWS |
|---|---|---|---|
| Control plane: API, scheduler, job worker | `volt-app/src/index.ts`, routes in `volt-app/src/modules`, logic in `volt-app/src/services` | one Node process on :8080 doing everything (`ROLE=all`) | one image, four ECS services chosen by `ROLE` (below) |
| Console | `volt-web/src` (React and Vite), routes in `volt-web/src/App.tsx` | Vite dev server on :5173 | built bundle served by the control plane (`volt-app/test/console-serving.check.sh` holds that to its rules) |
| Player SDK | `volt-player/src` | built into the console and the embed pages | the same, from the CDN |
| Live video encoder | `volt-encoder/bin/encoder.py` with ffmpeg and Shaka Packager | a child process (`ORCH_LAUNCHER=local`) or a container (`ORCH_LAUNCHER=docker`) | an ECS task on EC2, Spot first (`ORCH_LAUNCHER=ecs`) |
| Radio | `volt-encoder/bin/radio.py`, MP3 through an Icecast relay | child process or container, Icecast in Docker on :8000 | an ECS task from its own image (`volt-encoder/Dockerfile.radio`); the stack does not create that image's repository or task definition yet (item 2.1) |
| FAST playout | `volt-encoder/bin/fast_playout.py`, server side ads in `volt-app/src/services/fast` | child process | one small task per FAST channel (`volt-encoder/Dockerfile.fast`) |
| Thumbnailer | `volt-encoder/bin/thumbnailer.py` | child process beside the encoder | a task from the encoder image |
| Captions | `volt-encoder/bin/captions.py` | beside the encoder | sidecar image (`volt-encoder/Dockerfile.captions`) |
| Graphics burn-in | `volt-encoder/bin/gfx_burn.py` (Chromium renderer) | beside the encoder | same |
| VOD encodes, clips, QC, filler builds | jobs in `volt-app/src/services/jobs` | inside the one process | the `worker` service |
| Database | Postgres 16. Migrations in `volt-app/migrations`, applied on boot by `volt-app/src/services/migrate.ts` | local Postgres, or Docker, on :5432 | RDS, optionally through RDS Proxy |
| Cache | Valkey, optional (`REDIS_URL`) | none: caches are per process | ElastiCache |
| Origin | segments under the control plane's origin folder (`volt-app/origin` by default, `ORIGIN_DIR`), served at `/origin` and `/live` | a folder | S3 behind CloudFront |
| Edge rights | `deploy/edge/rights-viewer-request.js` picks a viewer's variant; `volt-app/src/services/variantManifest.ts` builds it | the API decides | CloudFront Function and KeyValueStore |
| Customer docs | `docs-site` (Docusaurus) | :3000, started by `run-on-mac.sh` | S3 and CloudFront from `deploy/terraform-docs` |

The encoder reports what it is doing by posting status events to the control
plane (`volt-encoder/bin/events.py`). The control plane keeps the live picture
in `volt-app/src/services/statusHub.ts` and pushes it to the console over one
server-sent event stream. Nothing in the console polls an encoder directly.

## Roles: one image, four services

`volt-app/src/scale/config.ts` reads `ROLE` and everything else that changes
behaviour under load. With no settings it is one process on one box. In AWS
the same image runs as:

| Service | `ROLE` | Does |
|---|---|---|
| control plane | `api-admin` | console and admin API; owns migrations |
| public API | `api-public` | the viewer surface only (play gate, live, player); scales out |
| scheduler | `scheduler` | one leader by advisory lock, with a standby; starts and stops encoders |
| worker | `worker` | background jobs; scales on queue depth |

`deploy/staging/docker-compose.yml` runs the same split on one machine with an
nginx edge, which is the cheapest way to see it before AWS. Why each setting
exists: `SCALING.md`.

## How the control plane starts an encoder

The scheduler hands a job (`volt-app/src/services/jobConfig.ts`) to a launcher
chosen by `ORCH_LAUNCHER`:

| Value | Launcher | Used for |
|---|---|---|
| `mock` | records the intent only | the check suites |
| `local` | `volt-app/src/services/orchestrator/localLauncher.ts` | the Mac with ffmpeg, Python and Shaka installed |
| `docker` | `volt-app/src/services/orchestrator/dockerLauncher.ts` | the Mac with production ffmpeg (SRT, drawtext) in the encoder image |
| `ecs` | `volt-app/src/services/orchestrator/launcher.ts` | AWS RunTask on the Spot and on-demand capacity providers |

The job carries everything the encoder needs; the encoder never reads the
database. That is what lets the same encoder run as a child process, a
container or an ECS task.

## The control plane's code

| Folder | Holds |
|---|---|
| `volt-app/src/modules` | Express routers, one per area (channels, events, radio, EPG, VOD, uploads, analytics and so on) |
| `volt-app/src/services` | the logic the routes call, the scheduler, the job handlers, the stores |
| `volt-app/src/auth` | sign-in, tokens, roles and the permission map |
| `volt-app/src/util` | list paging and filters (`volt-app/src/util/listQuery.ts`), the route inventory |
| `volt-app/src/scale` | roles, Valkey, leadership, rate limits, metrics |
| `volt-app/docs` | design documents and the generated API reference (`volt-app/docs/openapi.json`) |

API conventions (account scoping through groups, the list standard,
hypermedia links) are in `volt-app/docs/API_STANDARDS.md`.

## Other folders

| Folder | What it is |
|---|---|
| `packages/image-url` | the published SDK that builds and signs image service URLs |
| `packages/ingest-core` | the upload and ingest rules as a library with no database |
| `volt-agent` | the desktop agent that watches folders on a customer machine and feeds Volt |
| `volt-site` | the static promo and sign-up site |
| `e2e` | the Docker end-to-end media pipeline harness |
| `feature-tracker` | the product feature tracker page |
| `volt-frame-proto`, `volt-image-proto`, `spikes` | prototypes; the app does not use them |

## Where to read more

- Failover and failback: `FAILOVER.md`
- Radio and the relay: `RADIO.md`, `RELAY.md`
- FAST playout: `PLAYOUT.md`
- Edge rights variants: `EDGE_RIGHTS_VARIANTS.md`
- Placement and consolidation of encoders: `PLACEMENT.md`, `CONSOLIDATION.md`
