# Volt at scale: the viewer path, roles, staging and AWS

This is the guide for running Volt so that a million viewers can press play
within a minute or two. It covers what changed in the code, how the same image
runs on one box, on a staging server and on AWS, and what to do before a big
event.

Target: 1M viewer starts in 60 to 120 s, which is 8,000 to 17,000 starts a
second on average and 30,000 to 50,000 at the peak.

## 1. What changed, and where

| Problem (before) | Fix | Code |
|---|---|---|
| Every viewer start ran `UPDATE api_keys SET request_count+1` on the same row: one lock, about 1,000 starts/s maximum | Key usage counted in memory, written once every 10 s per process | `src/scale/keyUsage.ts`, `services/apiKeys.ts` |
| 6 to 20 database round trips per start (key, app, asset, rules, programme, viewer) | Read-through cache: process memory plus optional Valkey, single-flight on a miss, invalidated within milliseconds by database triggers | `src/scale/cache.ts`, `services/viewerPath.ts`, `migrations/0046_viewer_path_scale.sql` |
| Every heartbeat: SELECT, INSERT/UPDATE, `count(*)` over all open sessions, upsert on one row | Beacons go to memory. Sessions and rollups written in multi-row statements every 5 s. Concurrency counted in Valkey (or per process) and published every 5 s by one process | `services/analytics.ts` |
| `/live/:id/master.m3u8` went through the API and database for every viewer | Cached answer, edge-cacheable for 2 s. The play gate now returns the manifest URLs directly (`delivery`) so players can skip it | `modules/publicLive.ts`, `modules/apps.ts` |
| On AWS the public URL always answered 503 (it checked a local folder the API cannot see) | Falls back to the encoder's status reports when the origin is not local | `modules/publicLive.ts` (`resolveLiveManifest`) |
| No way for an edge to answer starts | `GET /api/availability` (anonymous) is cacheable per app key, asset, Origin and viewer country | `modules/apps.ts`, `src/scale/edge.ts` |
| Viewer country came from the request body | Taken from CloudFront-Viewer-Country (or the staging edge) when `TRUST_EDGE_GEO=true`, and only with the edge secret | `src/scale/edge.ts` |
| Scheduler ran in every replica; a restarting API process reaped every encoder | One leader by Postgres advisory lock, hot standby takes over; encoder reap moved to the leader | `src/scale/leader.ts`, `src/index.ts` |
| One process did everything | `ROLE=all / api / api-public / api-admin / scheduler / worker` | `src/scale/config.ts`, `src/index.ts` |
| Live status (SSE) only reached clients on the same process | Fan-out through Postgres NOTIFY | `services/statusHub.ts` |
| `/health` said OK even with no database | `/health/live` (process) and `/health/ready` (booted, database answers) | `src/scale/health.ts` |
| Fargate needs 1 to 2 minutes per scale step, a kick-off needs seconds | Pre-warm: the scheduler raises the viewer tier's minimum before events with `expected_viewers` | `src/scale/prewarm.ts` |
| Workers had no scaling signal | Queue depth published to CloudWatch (`Volt/JobsQueued`) | `src/scale/metrics.ts` |
| Radio player and player telemetry wrote a row per event | Cached station lookups, batched `player_events` inserts | `modules/player.ts`, `src/scale/batches.ts` |

Measured in the build sandbox (2 vCPU, local Postgres, not AWS):

- 500 warm anonymous starts cost **2** database transactions in total (the old path: 3,000 to 10,000).
- One API process sustained about **2,200 starts/s** on one core.
- Through the staging edge: **99.9 %** of starts answered by the edge cache, play gate p95 under 1 ms, beacon p95 about 4 ms, every session written.
- An EPG blackout and a disabled key both took effect within 300 ms.

Treat these as relative, not as AWS capacity. Run the load test (section 7) on
your own staging and AWS to set the real figures.

## 2. One image, three shapes

| | Dev (one box) | Staging (one server, Docker) | AWS |
|---|---|---|---|
| How | `volt-app/docker-compose.yml` or `npm run dev` | `deploy/staging/` | `deploy/terraform/` |
| Roles | `ROLE=all` (one process) | admin, 2+ public, scheduler, worker | four ECS services |
| Edge | none | nginx (routing, cache, rate limits, geo) | CloudFront + WAF + ALB rules |
| Cache | process memory | memory + Valkey | memory + ElastiCache Valkey |
| Database | Postgres | Postgres | RDS (+ RDS Proxy) |
| Analytics sessions | Postgres, batched | Postgres, batched | Postgres batched, or `none` + Firehose |
| Pre-warm | off/log | log | sets ECS minimum |

Nothing needs Valkey or AWS to work. With neither, each process caches on its
own and counts concurrency on its own, which is exact on one box.

### Roles

| ROLE | Serves HTTP | Scheduler | Jobs | Migrates on boot |
|---|---|---|---|---|
| `all` (default) | everything | competes for leader | yes | yes |
| `api` | everything | no | no | yes |
| `api-admin` | everything (console, admin API) | no | no | yes |
| `api-public` | viewer paths only (others 404) | no | no | no, waits for schema |
| `scheduler` | health only in practice | competes for leader | no | yes |
| `worker` | health only in practice | no | yes | no, waits for schema |

Viewer paths (api-public): `/api/public/*` (the public API, see ACCESS_CONTROL.md), `/api/availability`, `/api/access/*`,
`/api/player/*`, `/api/analytics/beacon`, `/api/payments/verify`, `/live/*`,
`/share/*`, `/api/share/*`, `/xmltv/*`, `/img/*`, `/library/*`, `/player*`,
`/clips/*`, `/health*`. The same list is in the staging nginx, the ALB rules
and `PUBLIC_PATH_PREFIXES`.

## 3. Staging (one server, no cloud)

Needs Docker with Compose v2 on a Linux server (4+ vCPU, 8 GB+ for load tests).

```bash
cd volt/deploy/staging
cp .env.example .env        # set every secret (openssl rand -hex 32)
docker compose up -d --build
docker compose ps           # all healthy after ~1 min
curl http://localhost/edge-health
curl http://localhost/health/ready      # goes to api-admin
```

Open `http://<server>/` for the console. Register, create an app (publishable
key) and a channel as usual.

Scale the viewer tier and reload the edge:

```bash
docker compose up -d --scale api-public=4
docker compose restart edge
```

Watch the leader fail over:

```bash
docker compose up -d --scale scheduler=2
docker compose logs scheduler | grep leader     # one says "now the leader"
docker compose kill <that container>             # the other takes over within ~10 s
```

Staging geo: there is no GeoIP on the staging edge, so the viewer country comes
from an `X-Test-Country` request header (the load test sends it). Staging only.

Real encoders in staging: set `ORCH_LAUNCHER=docker` in `.env` and uncomment
the docker socket mount under `api-admin` (and add it to `scheduler`). The
default `mock` is enough for viewer-path testing.

## 4. AWS

### 4.1 First time, or upgrading an existing stack

```bash
cd volt/deploy/terraform
cp terraform.tfvars.example terraform.tfvars   # the "Scaling" block at the end
terraform init -upgrade
terraform plan
terraform apply
```

Then build and push the control-plane image as in `deploy/terraform/README.md`
(the `volt-control-plane` repo; all four roles run the same image) and roll the
services:

```bash
aws ecs update-service --cluster volt --service volt-<env>-control-plane --force-new-deployment
# with enable_role_split = true, also:
for s in api-public scheduler worker; do
  aws ecs update-service --cluster volt --service volt-<env>-$s --force-new-deployment; done
```

Order on the first deploy of this change: the control-plane (api-admin) and
scheduler services apply migration 0046 on boot. api-public and worker wait
for it ("waiting for migration 0046…" in their logs) and start serving once it
lands, so no manual ordering is needed.

Point DNS / players / the console at the `api_edge_domain` output (or your
alias via `api_edge_aliases` + a us-east-1 ACM certificate). The ALB stays the
origin and is still what encoders call (`INTERNAL_API_BASE_URL`).

### 4.2 What Terraform builds for scaling

| File | What |
|---|---|
| `scaling_services.tf` | api-public, scheduler, worker services (same image, ROLE env); autoscaling for public (requests per task + CPU), admin (CPU), workers (queue depth alarms); IAM for pre-warm, metrics, Firehose |
| `scaling_alb.tf` | api-public target group (`/health/ready`), path rules sending viewer paths to it |
| `scaling_edge.tf` | CloudFront in front of the ALB (play gate cache, /live cache, edge secret header), WAF (login rate, per-IP rate, AWS IP reputation, bad inputs) |
| `scaling_cache.tf` | ElastiCache Valkey 8, TLS, Multi-AZ when replicas ≥ 1 |
| `scaling_rds_proxy.tf` | RDS Proxy (optional); `DATABASE_URL` goes through it, `DATABASE_LISTEN_URL` goes direct |
| `scaling_analytics.tf` | Firehose to S3 for raw beacons (optional) |
| changes | `alb.tf` health check `/health/ready`, deregistration 30 s, optional LCU reservation; `ecs_services.tf` env moved into `local.control_plane_env`, container health check, deploy circuit breaker with rollback; `secrets.tf` adds `DATABASE_LISTEN_URL`, `EDGE_SHARED_SECRET`, `PLAYBACK_TOKEN_SECRET` |

`enable_role_split = false` keeps one control-plane service (ROLE=all, now
safe to run several of because of the leader lock) with everything else
(Valkey, edge, proxy) still available.

Validated with `terraform validate` and a mocked `terraform test` plan of both
the default and the everything-on configuration. Not yet applied against a
real account.

## 5. Before a big event

1. **Set the expected audience.** `events.expected_viewers` (or
   `programmes.expected_viewers` for a programme on a 24/7 channel). The
   scheduler raises api-public's minimum `PREWARM_LEAD_MIN` (20) minutes
   before and holds it `PREWARM_HOLD_MIN` (30) after the start:

   `tasks = viewers x PREWARM_ORIGIN_FRACTION / PREWARM_RAMP_SEC / PREWARM_STARTS_PER_TASK`

   For 1M viewers with CloudFront (0.1 reach the API), 90 s ramp and 1,500
   starts/s per task: 1,000,000 x 0.1 / 90 / 1,500 = 1 task, so the floor
   (`api_public_min`) decides. Without the edge (fraction 1): 8 tasks. For
   signed-in-only content (POST, not edge-cached) use fraction 1.
   `GET /health/ready` on the leader shows the plan (`prewarm`).
2. **Size the shared pieces a day ahead** (terraform.tfvars, apply):
   `valkey_node_type = "cache.r7g.large"`, `enable_rds_proxy = true`,
   `db_instance_class = "db.r7g.xlarge"`, `db_multi_az = true`,
   `api_public_max = 80-120`, `analytics_sessions = "none"` with
   `enable_analytics_firehose = true`.
3. **Reserve ALB capacity** with `alb_lcu_reservation` (billed while set; unset
   after). With the edge answering most starts the ALB sees a fraction of the
   load, so start around 100 to 200 LCU and adjust from the load test.
4. **Load test staging, then AWS** at the event's peak (section 7) and set
   `prewarm_starts_per_task` from what one task sustained.
5. **Players**: anonymous players should call `GET /api/availability?appKey=…&assetId=…`
   (edge-cached) and play `delivery.hls` / `delivery.dash` directly. Signed-in
   viewers keep using `POST` (not edge-cached, but still almost free on a warm
   process).

## 6. Settings reference

All optional. Defaults keep the old single-process behaviour.

| Variable | Default | Meaning |
|---|---|---|
| `ROLE` | `all` | See roles table |
| `REDIS_URL` | unset | Valkey/Redis, `redis://` or `rediss://` (TLS) |
| `DATABASE_LISTEN_URL` | `DATABASE_URL` | Direct database URL for LISTEN, leader lock, boot lock (bypass RDS Proxy) |
| `DB_POOL_MAX` | 10 | Connections per process |
| `RUN_MIGRATIONS` | by role | Force migrating on boot on or off |
| `VIEWER_CACHE` | true | Off = every lookup hits the database (the old behaviour) |
| `CACHE_KEY_TTL_SEC` / `CACHE_ASSET_TTL_SEC` / `CACHE_RULES_TTL_SEC` / `CACHE_PROGRAMME_TTL_SEC` | 60 / 300 / 30 / 60 | Backstop TTLs; changes invalidate immediately anyway |
| `CACHE_VIEWER_TOUCH_SEC` | 900 | How often a returning viewer's `last_seen_at` is written |
| `CACHE_ENTITLEMENT_TTL_SEC` | 60 | Entitlements (purchases invalidate at once) |
| `KEY_USAGE_FLUSH_SEC` | 10 | Key usage write interval |
| `TRUST_EDGE_GEO` | false | Take viewer country from the edge header |
| `EDGE_SHARED_SECRET` | unset | Require `X-Volt-Edge` with this value before trusting the geo header |
| `EDGE_AVAILABILITY_MAX_AGE` | 15 | Edge cache seconds for the anonymous play gate |
| `EDGE_LIVE_REDIRECT_MAX_AGE` | 2 | Edge cache seconds for `/live` redirects |
| `PLAYBACK_TOKEN_SECRET` | access secret | Separate key for playback tokens (changing it invalidates tokens in flight, ~2 min) |
| `ANALYTICS_SESSIONS` | postgres | `none` = no per-session rows, views counted at `start`, rollups only |
| `ANALYTICS_FIREHOSE_STREAM` | unset | Mirror raw beacons to Firehose |
| `ANALYTICS_FLUSH_SEC` / `ANALYTICS_CONCURRENCY_SEC` | 5 / 5 | Write and recount intervals |
| `WORKER_CONCURRENCY` | 2 | Jobs per worker process |
| `LEADER_RETRY_SEC` | 10 | How fast a standby scheduler takes over |
| `PREWARM_*` | see `src/scale/config.ts` | Pre-warm maths and mode (`log` or `aws`) |
| `CLOUDWATCH_METRICS` | false | Publish `Volt/JobsQueued` etc. |
| `PUBLIC_PATH_PREFIXES` | viewer paths | What api-public serves |

## 7. Checking it works

**Logic check (any machine with Postgres):**

```bash
cd volt/volt-app
DATABASE_URL=postgres://volt:volt@localhost:5432/volt npx tsx test/scale/scale-check.ts
# add REDIS_URL=redis://localhost:6379 to check the Valkey paths too
```

It starts four processes in different roles and checks: warm starts cost
almost no database work, cache headers, blackout and key-disable take effect
within 300 ms, batched key usage, sessions/rollups/concurrency land and a
replayed `end` is not double counted, api-public refuses admin paths, exactly
one scheduler leads and a standby takes over. It leaves a `scale-check`
account behind; use a scratch database.

**Load test (staging, then AWS):** `deploy/loadtest/README.md`.

**Watching it live:** `GET /health/ready` on any process shows cache hit
counts, pool usage, buffered analytics, Valkey and listener state, and (on the
leader) the pre-warm plan.

## 8. Things to know

- **Viewer logins.** Hosted viewer accounts now exist (`/api/public/auth/*`,
  ACCESS_CONTROL.md). Sign-in costs one argon2id hash (~10-20 ms CPU), so keep
  viewers signed in with refresh tokens and prompt sign-in before a big event;
  a signed-in viewer's play request is verified from the token with no
  database query. The note below still applies to clients using their own IdP.
- **Viewer logins are not on this path.** Volt identifies viewers by the
  customer's own `externalId` (their identity provider), so a million viewers
  never hit Volt's operator login or its argon2 hashing. If Volt ever hosts
  viewer accounts, use a managed identity service (Cognito, Auth0) and verify
  its tokens statelessly; do not reuse `/api/auth/login`.
- **Edge decision vs KeyValueStore.** The earlier plan was to push rights
  decisions into a CloudFront KeyValueStore and sign tokens in a CloudFront
  Function. This build caches the API's own decision at CloudFront instead,
  capped at 15 s and never across a programme boundary. Same effect (most
  starts never reach the API), with the rules in one place and no sync service.
  KeyValueStore remains an option if signed-in viewers ever need the edge too.
- **`ANALYTICS_SESSIONS=none` changes when a view counts** (at `start`, not at
  `end`) and keeps session detail only in the Firehose/S3 data. Rollup sealing
  is unaffected (it only recomputes days that have raw sessions).
- **Concurrency without Valkey** is exact on one process and approximate with
  several (a session whose beacons land on two processes is counted by both
  for one window). Use Valkey whenever there is more than one API process.
- **Migration 0046 adds triggers** on keys, accounts, apps, channels, events,
  VOD assets, programmes, publishing rules, output profiles, entitlements and
  player configs. They only send a NOTIFY; cost is negligible.
- **The ALB health check is now `/health/ready`.** A task without a database
  leaves the load balancer instead of answering 500s; the container health
  check is `/health/live`, so a database outage does not restart every task.
- **Not done here:** HTTPS between CloudFront and the ALB (set
  `alb_origin_protocol = "https-only"` once the ALB has a certificate), Aurora
  (RDS Postgres + RDS Proxy + Multi-AZ is the supported path for now), and a
  chaos run on AWS (AWS FIS: kill tasks, fail over RDS and Valkey, interrupt
  Spot) which is the next step after the first AWS load test.
