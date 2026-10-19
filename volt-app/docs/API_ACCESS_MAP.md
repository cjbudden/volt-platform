> **Superseded in part (Oct 2026).** The full access model, including the
> `/api/public/*` namespace, admin roles and permission levels, public user
> accounts, platform step-up and the hooks for new features, is in
> `ACCESS_CONTROL.md` at the repository root. Where the two disagree,
> ACCESS_CONTROL.md is current. The class of every route is now generated from
> the running app into `API_ROUTES.md`, and `API_GUIDE.md` explains the split.

# Volt Streaming — API access map (public vs admin)

Every control-plane route's access class. **The default is ADMIN** — the vast
majority of the API is tenant-admin only. A small, explicit set is public. This is
the contract the enforcement test (`test/access-control.check.sh`) verifies.

## Access classes
| Class | Credential | Scoped to |
|---|---|---|
| **public** | none, OR a **publishable key** (`pk_live_…`), OR a short-lived **playback token** | the account that owns the key |
| **admin** | an admin **session token** (JWT) **OR** the account **secret key** (`sk_live_…`, management scope) | that one account (all queries filtered by `account_id`) |
| **platform** | admin session of a user whose `platform_role` is set (SaaS staff) | cross-tenant (provider) |
| **ingest** | `X-Volt-Ingest-Token` (encoder/thumbnailer → control plane) | the reporting stream |

Content can never cross tenants: admin credentials each resolve to exactly one
`account_id`, and every list/detail query filters by it (verified by the
cross-tenant isolation test).

## Public control-plane routes (the ONLY ones without an admin session)
| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none | liveness |
| `GET /api`, `/api/context.jsonld`, `/api/doc` | none | Hydra discovery (service document) |
| `POST /api/auth/login`, `/refresh` | none | obtain a session |
| `POST /api/availability` | publishable key | **get play URL** — validates key + restriction (+ geo/rights) → mints a playback token |
| `POST /api/access/check` | publishable key | **check access** — booleans, no token minted |
| `POST /api/analytics/beacon` | playback token | viewer session heartbeat |

> **Manifests & media** (`*.m3u8`, `*.mpd`, segments, MP4s) are served by
> **CloudFront from the S3 origin**, not this API. They are public/CDN-gated (or
> DRM/token-gated for protected content) — they are not control-plane routes.

## Admin routes (require an admin session OR the account secret key)
`/api/channels`, `/api/events`, `/api/output-profiles`, `/api/recordings`,
`/api/vod`, `/api/metadata-schemas`, `/api/filler-assets`, `/api/scheduled-clips`,
`/api/epg`, `/api/apps`, `/api/publish-targets`, `/api/publications`,
`/api/status` (reads), `/api/analytics` (reports), `/api/tickets`, `/api/media`.

Admin auth accepts, interchangeably:
- `Authorization: Bearer <session JWT>` — interactive admin, or
- `Authorization: Bearer sk_live_…` **or** `X-Volt-Account-Key: sk_live_…` —
  server-to-server (the account API access token). Publishable keys are refused.

## Platform routes (SaaS provider only)
`/api/platform/*` — `requirePlatform`; the SaaS Admin uses a **separate API
surface** with its own credential (`platform_role`) and **2-step auth (MFA)** on
initial login (see SAAS_ARCHITECTURE.md §3–4).

## Ingest routes (encoder/thumbnailer → control plane)
`POST /api/streams/:id/report`, `POST /api/media/thumbnails` — `X-Volt-Ingest-Token`.

## Sub-accounts (planned)
`accounts.parent_account_id` lets a parent account own sub-accounts; tenant
scoping resolves the subtree so a parent admin can see its children while a
sub-account sees only itself. Schema + scoping helper land now; full per-query
subtree wiring is a follow-up (see SAAS_ARCHITECTURE.md).
