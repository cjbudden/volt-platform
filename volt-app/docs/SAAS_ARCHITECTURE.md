# Volt Streaming — SaaS Architecture (data stores, tenancy, admin layer)

How the platform is structured to run as a multi-tenant SaaS: where every kind of
data lives, how tenant isolation is enforced, the two admin scopes, SSO, and the
SaaS-provider management view. This is the reference the schema + services follow.

## 1. Data stores — what lives where (clearly defined)

| Data | Store | Why |
|---|---|---|
| **All structured app data** — accounts, users, groups, channels, events, EPG, recordings, VOD, metadata schemas, apps, API keys, publications, tickets, billing/usage | **PostgreSQL (RDS)** — system of record | relational, transactional, tenant-scoped by `account_id` |
| **Analytics SERVING data** — `play_sessions` (one row per viewing session) + `analytics_rollups` (per program/channel/account/day aggregates) | **PostgreSQL** | this is what the dashboards read; bounded volume (sessions + daily rollups, not per-request) |
| **Realtime concurrency** — distinct active sessions on a live stream in the last W seconds | **Redis / Amazon Timestream** (fast rolling counter). Represented in `stream_concurrency` in Postgres for the initial build | sub-second, high-write, ephemeral; a rolling window, not history |
| **Raw request firehose** — every CDN edge request (incl. cache hits) | **S3 (log bucket) + Athena** | far too high-volume/cardinality for Postgres; queried ad-hoc, rolled up into Postgres |
| **Secrets** — DRM keys, OAuth tokens, DB creds | **AWS Secrets Manager** (ARNs only in Postgres) | never store secret values in the DB |
| **Media** — CMAF segments, manifests, MP4s, thumbnails, subtitles | **S3 origin** (+ CloudFront) | object storage; time-addressable archive |

### Analytics ingestion path (server-side, player-agnostic)
```
CloudFront real-time logs ──▶ Kinesis ──▶ consumer (Lambda/worker)
                                            ├─▶ Redis/Timestream : realtime concurrency (rolling W)
                                            ├─▶ Postgres play_sessions : upsert session (last_seen, watch time, bytes)
                                            └─▶ Postgres analytics_rollups : per-program/day aggregates
```
The `/api/availability` gate mints the **session token** embedded in play URLs, so
every downstream request is attributable to `{account, app, asset, session}`
without a player SDK. A live-manifest re-request is a free heartbeat → rolling
distinct sessions = concurrency. CMCD (CTA-5004) in the logs adds real QoS.

The initial build implements the **Postgres serving layer** (`play_sessions`,
`analytics_rollups`, `stream_concurrency`) + a beacon/heartbeat ingest endpoint,
so reporting works end-to-end now; the CloudFront→Kinesis firehose and
Redis/Timestream are the scale path (documented, not required for correctness).

### The defined reports (what we serve)
- **Realtime**: current concurrency per stream + total; by app / device / geo now.
- **Per-program** (EPG-joined): total views, unique, **peak concurrent**, avg/total
  watch time, viewers-over-time, conversion, drop-off, blocked-by-geo.
- **Audience**: **by app** (authoritative, billable — top dimension), by device,
  by geo, by referrer (+ no-referrer classification).
- **QoS**: TTFF proxy, rebuffering, bitrate distribution (from CMCD).
- **Usage**: per-app metering → billing (GB, stream-hours).

## 2. Tenancy — isolation is enforced, not optional
- Every tenant row carries `account_id` (directly or via `group_id → account_id`).
- Every authenticated API resolves `account_id` from the JWT and **filters every
  query by it** — a request can only ever see its own tenant's data. New modules
  (EPG, apps, analytics) follow the same rule; a cross-tenant isolation test
  asserts account A cannot read account B's channels/vod/epg/apps.
- The public `/api/availability` gate is scoped by the **publishable key**, which
  belongs to exactly one account.
- Isolation TIERS (compute): shared multi-tenant node groups (default, dense) vs
  dedicated node groups (premium) — see capacity model. Data isolation is logical
  (account_id) in all tiers.

## 3. Two admin scopes
- **Client Admin** (tenant): an account's `users` with role `owner`/`admin` —
  manages that account's channels/events/EPG/VOD/apps/billing. Everything they
  see is filtered to their `account_id`. (Existing model.)
- **SaaS Admin** (platform/provider): a user with a `platform_role`
  (`saas_admin` | `support` | `read_only`) — operates ACROSS all tenants for
  monitoring + support. Guarded by `requirePlatform` middleware; every platform
  action is audit-logged. Platform staff are not billed tenants.

## 4. SSO (Microsoft / Google) — planned
- `identity_providers` (scope = platform or a specific account; kind `oidc`;
  provider `google`/`microsoft`/`okta`; issuer, client_id, secret_ref, enabled).
- Flow (OIDC Authorization Code + PKCE): `/api/auth/sso/:provider/start` →
  IdP → `/api/auth/sso/:provider/callback` → match/JIT-provision the user in the
  bound account (or platform) → issue the normal Volt JWT. Microsoft = Entra ID
  (Azure AD) tenant; Google = Workspace. Client admins configure their own IdP
  (login with your company Google/MS); SaaS staff use the platform IdP.
- **This round**: schema + the plan land; the OIDC exchange is built next.

## 5. SaaS-provider system view (monitoring & support)
`GET /api/platform/overview` (platform-auth) returns, across ALL tenants:
- **Active servers/instances** + count (running encoder/packager tasks) and their
  utilization; **projected instances needed today** from booked events + live
  channels (container = channel/event, so count = distinct live channels + events
  server-window-active today).
- **Upcoming events** (next 24h, all tenants).
- **Active channels** count + list.
- **Active viewers** (sum of realtime concurrency across streams).
- **Active admins** (recently-active sessions).
- **API/system status** (subsystem health checks).
- **Support tickets** (open count + recent).

Plus `GET /api/platform/accounts` (tenant list + headline usage) and
**account impersonation** — a SaaS admin mints a short-lived, audit-logged token
scoped to a client account to "view as" them. Impersonation is **planned for**
(schema + endpoint stub); execution is deferred past the initial deployment.

## 6. Support tickets
`support_tickets` (account_id, opened_by, subject, body, status
`open`/`pending`/`resolved`/`closed`, priority, assignee platform-staff,
timestamps) + comments. Clients file within their account; SaaS admins triage
across accounts from the platform overview.
