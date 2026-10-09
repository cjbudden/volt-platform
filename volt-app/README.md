# Volt Streaming — Control Plane

The standalone control-plane API for **Volt Streaming** (OTT livestreaming platform): secure auth, tenanted accounts/groups, output profiles, channels, events, instances, and live-to-VOD. Node.js + TypeScript + Express + PostgreSQL. This is the service that manages the SaaS and orchestrates the streaming data plane (SRS + FFmpeg / Shaka Packager encoders on EC2).

> Status: **Phase 2 scaffold** — auth + channels/events/profiles CRUD are wired to the validated schema. AWS orchestration, VOD routes, groups/accounts/instances and captions/DRM signing are stubbed with `TODO`s and land next.

## Quick start (local, Docker)

```bash
cp .env.example .env
docker compose up --build
# Postgres comes up, applies migrations/0001_init.sql automatically,
# API is on http://localhost:8080  (GET /health)
```

## Quick start (without Docker)

```bash
npm install
createdb volt && psql volt -f migrations/0001_init.sql   # or: DATABASE_URL=... npm run migrate
cp .env.example .env
npm run dev        # tsx watch, hot reload
```

## API (implemented)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/register` | create account + owner user (argon2) |
| POST | `/api/auth/login` | → access JWT + rotating refresh token |
| POST | `/api/auth/refresh` | new access token |
| POST | `/api/auth/logout` | revoke refresh token |
| GET/POST/PUT/DELETE | `/api/channels` | 24/7 channels; enforces `max_channels` |
| POST | `/api/channels/:id/start\|stop` | orchestrator hook (TODO: launch/terminate) |
| GET/POST/PUT/DELETE | `/api/events` | events w/ server & public windows; enforces concurrency |
| GET/POST/DELETE | `/api/output-profiles` | ABR ladder, workflow (transcode/package_only), DRM, DVR, captions |
| POST | `/api/streams/:id/report` | **ingest** — encoder posts events + status snapshots (ingest-token auth, not JWT) |
| GET | `/api/status` | all streams' latest status for the tenant (dashboard poll) |
| GET | `/api/status/stream` | **SSE** — live status pushes (`?ticket=<accessJWT>`) |
| GET | `/api/status/:kind/:id` | one stream's current snapshot (`kind` = channel\|event) |
| GET | `/api/status/:kind/:id/events` | one stream's event log, newest first, `?since=<id>&limit=` |

Every non-auth route is scoped by `account_id` from the JWT (multi-tenant isolation).

## Live stream status & events

The encoder container reports to `POST /api/streams/:id/report` on every change —
a source going up/down, a failover switch, filler engaging. Each report carries
an `event` (appended to `stream_events`, the per-stream log) and/or a `status`
snapshot (upserted into `stream_status`, one row per stream). The snapshot is
what the admin renders: `output_available`, `active_source` (primary/backup/
filler), `fallback_in_use`, `filler_in_use`, and a per-source state map. An
`ON CONFLICT … WHERE last_seq <= EXCLUDED.last_seq` guard drops out-of-order
reports.

**Transport — polling REST base + SSE live layer (not raw WebSocket).** Status
is a low-frequency, read-only, server→client signal watched by a handful of
operators, so:

- **Polling REST** is the base (`GET /api/status`, `/:kind/:id`, `/:kind/:id/events`):
  always available, cacheable, trivial to integrate, works through any proxy.
- **SSE** (`GET /api/status/stream`) is the live layer: pushes changes to the
  dashboard within ~1s over plain HTTP with built-in auto-reconnect — no sticky
  sessions or socket infrastructure. `services/statusHub.ts` fans out per tenant.
- We deliberately did **not** use raw WebSocket: it adds stateful connection
  management and (on ECS behind an ALB) sticky-session/scale-out complexity for a
  one-way feed that gains nothing from a duplex channel. Add WS later only if the
  admin needs to *send* control over the same socket. For multi-instance
  control-plane scale-out, back the hub with Postgres `LISTEN/NOTIFY` — that
  change is isolated to `statusHub.ts`; the API is unchanged.

Proven end-to-end against live Postgres: ingest auth, snapshot upsert/collapse,
polling reads, event log, and an SSE client receiving a live failover push.

## Orchestrator

`services/orchestrator/` turns channel/event lifecycle into running tasks and
recordings. `POST /api/channels|events/:id/start` builds the encoder job config
from the DB (`services/jobConfig.ts` — profile ladder, inputs incl. primary/backup,
DRM, redundancy/filler, **captions**, S3 target, status-report webhook), launches
an ECS task (`launcher.ts`, Spot + on-demand capacity-provider fallback), records
the `instances` row, and opens a `recordings` row (per-day for channels, one per
run for events) snapshotting the retention rule. `stop` terminates the task,
closes the recording (stamping `expires_at` from retention), and fires the CPU
thumbnailer. A background scheduler (`startScheduler()` in `index.ts`) provisions
scheduled events at `server_start`, stops them past `server_stop`, rolls channel
recordings at the UTC day boundary, and sweeps expired recordings.

The `TaskLauncher` is injected: `mock` (default — records intent, used by the e2e
harness and tests) or `ecs` (real Fargate/EC2 via `@aws-sdk/client-ecs`). Set
`ORCH_LAUNCHER=ecs` + the ECS env in production. Time is handled server-side (SQL
`now()`/`current_date`) so behaviour is tz-correct and deterministic. Verified
against live Postgres: `test/orchestrator.check.ts` (30 assertions — jobConfig for
transcode/package/DRM/redundancy/captions, ECS RunTask params, start→instance+
recording+live, stop→terminate+close+expiry+thumbnailer, per-day dedup, retention
sweep) plus a full HTTP start/stop round-trip.

> In production the event-scheduling half can move to EventBridge and the
> retention sweep to a scheduled Lambda without changing `service.ts`.

## Layout

```
migrations/0001_init.sql     validated Postgres schema (accounts→groups→events/channels,
                             output_profiles, stream_inputs, instances, segments DVR index,
                             vod_assets, usage_records, drm_configs, audit_log)
src/
  config.ts   db.ts          env config; pg pool + tx helper
  auth/                       argon2 passwords, access JWT + refresh tokens, requireAuth
  modules/                    channels, events, output profiles (CRUD, limits, lifecycle)
  services/vod-extractor.ts   time→segment resolution, VOD manifest, MP4 export, preview
  util/http.ts                asyncHandler + typed ApiError + error middleware
scripts/migrate.js            forward-only migration runner (for RDS)
```

## Next (Phase 3+)

- Terraform Tier-2 staging so `ORCH_LAUNCHER=ecs` has a real cluster: ECS + capacity providers (the Spot/on-demand strategy the launcher already emits), RDS, S3, CloudFront, ECR, ALB, Secrets Manager.
- Encoder **captions worker** (Gladia): the job config already carries the `captions` block (engine/source/targets/offset) the orchestrator builds — the remaining piece is `volt-encoder/bin/captions.py` (audio → Gladia streaming STT/translation → segmented WebVTT with the playout offset).
- VOD routes over `services/vod-extractor.ts` incl. honouring `clip_spec` (composed clips) + MP4 export for downloads; groups / accounts / instances / usage endpoints.
- Wire S3 object cleanup into the retention sweep (rows are dropped now; enqueue prefix deletion).

## Deploy

Container image builds via the multi-stage `Dockerfile`. Target **ECS Fargate** for the control plane (small, always-on) with **RDS PostgreSQL**. Run `npm run migrate` against RDS on deploy. Secrets (DB creds, JWT secrets, Axinom management key) via AWS Secrets Manager — never in the image.

## Configuration for notifications, social publishing and guide import

All optional: without them each feature says what is missing in the console,
and the rest of the platform is unaffected.

| Setting | For |
|---|---|
| `PUBLIC_BASE_URL` | The public host. XMLTV feed URLs, icons, and the OAuth callback (`<host>/api/social/callback/<platform>`) are built from it. |
| `SMTP_URL`, `NOTIFY_FROM` | Notification email, e.g. `smtps://user:pass@email-smtp.ap-southeast-2.amazonaws.com:465` and `Volt <alerts@example.com>`. |
| `FCM_SERVICE_ACCOUNT` | Device push: the Firebase service account JSON, or a path to it. |
| `SOCIAL_TOKEN_KEY` | 32 bytes (hex or base64) that encrypt linked social accounts' tokens. Set it before linking real accounts. |
| `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` | YouTube publishing (Google Cloud OAuth client, YouTube Data API v3 enabled). |
| `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` | Facebook Page publishing (Meta app with Pages and video permissions). |
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | X posting (OAuth 2.0 app with media.write). |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | TikTok Content Posting API. Posts are private until TikTok audits the app. |
| `DAILYMOTION_API_KEY`, `DAILYMOTION_API_SECRET` | Dailymotion publishing. |

Register `<PUBLIC_BASE_URL>/api/social/callback/<platform>` as the redirect URL
with each platform. Admin > Social accounts shows the exact values.
