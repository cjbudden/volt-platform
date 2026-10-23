# Volt API: every route

Generated from the running app by `npm run docs:routes` (scripts/api-routes.ts). Do not edit by hand.
The usage guide is [API_GUIDE.md](API_GUIDE.md), the access model is [ACCESS_CONTROL.md](../../ACCESS_CONTROL.md).

**660 routes.** Public API: 71 · Sign-in (no session yet): 7 · Admin API: 523 · Platform API: 23 · Machine-to-machine: 14 · Delivery and previews (outside /api): 14 · Health and discovery: 8

- **Access:** for admin routes, `feature: level` is what one of the user's roles must grant (levels: view < operate < manage). The API answers `403 forbidden_feature` with the feature and level when it is missing.
- **Viewer tier:** ✓ means the public tier (ROLE=api-public) serves the route. Everything else answers 404 there.
- **Paths:** `:id` and similar are path parameters.

## Public API

For apps and players. A publishable key (`pk_…`) names the client account. Viewer sessions are Bearer tokens with audience `volt:viewer`. Served by the viewer tier.

### `/api/access`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| POST | `/api/access/check` | publishable key | public (legacy alias of /api/public/access/check) | ✓ |

### `/api/analytics`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| POST | `/api/analytics/beacon` | playback token | public (legacy alias of /api/public/analytics/beacon) | ✓ |

### `/api/availability`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/availability` | publishable key; viewer session optional | public (legacy alias of /api/public/availability) | ✓ |
| POST | `/api/availability` | publishable key; viewer session optional | public (legacy alias of /api/public/availability) | ✓ |

### `/api/onboarding`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| POST | `/api/onboarding/code` | none or per-route | open |  |
| POST | `/api/onboarding/complete` | none or per-route | open |  |
| POST | `/api/onboarding/forgot` | none or per-route | open |  |
| POST | `/api/onboarding/link` | none or per-route | open |  |
| POST | `/api/onboarding/password-check` | none or per-route | open |  |
| POST | `/api/onboarding/verify` | none or per-route | open |  |

### `/api/payments`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| POST | `/api/payments/verify` | publishable key + viewer | public (legacy alias of /api/public/payments/verify) | ✓ |

### `/api/player`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/player/epg` | publishable key or player token | public (legacy alias of /api/public/player/epg) | ✓ |
| GET | `/api/player/event` | publishable key or player token | public (legacy alias of /api/public/player/event) | ✓ |
| POST | `/api/player/events` | publishable key or player token | public (legacy alias of /api/public/player/events) | ✓ |
| GET | `/api/player/graphics` | publishable key or player token | public (legacy alias of /api/public/player/graphics) | ✓ |
| POST | `/api/player/graphics/impressions` | publishable key or player token | public (legacy alias of /api/public/player/graphics/impressions) | ✓ |
| POST | `/api/player/now-playing` | publishable key or player token | public (legacy alias of /api/public/player/now-playing) | ✓ |
| POST | `/api/player/session` | publishable key or player token | public (legacy alias of /api/public/player/session) | ✓ |

### `/api/public/access`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| POST | `/api/public/access/check` | publishable key | public API | ✓ |

### `/api/public/analytics`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| POST | `/api/public/analytics/beacon` | playback token | public API | ✓ |

### `/api/public/auth`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| POST | `/api/public/auth/login` | publishable key (appKey in body) | public API | ✓ |
| POST | `/api/public/auth/logout` | viewer refresh token (body) | public API | ✓ |
| POST | `/api/public/auth/mfa/challenge/send` | sign-in challenge (body) | public API | ✓ |
| POST | `/api/public/auth/mfa/challenge/verify` | sign-in challenge (body) | public API | ✓ |
| POST | `/api/public/auth/password-reset` | publishable key (appKey in body) | public API | ✓ |
| POST | `/api/public/auth/password-reset/confirm` | publishable key (appKey in body) | public API | ✓ |
| POST | `/api/public/auth/refresh` | viewer refresh token (body) | public API | ✓ |
| POST | `/api/public/auth/register` | publishable key (appKey in body) | public API | ✓ |
| POST | `/api/public/auth/token-exchange` | account secret key (sk_live_…) | public API | ✓ |

### `/api/public/availability`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/public/availability` | publishable key; viewer session optional | public API | ✓ |
| POST | `/api/public/availability` | publishable key; viewer session optional | public API | ✓ |

### `/api/public/me`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| DELETE | `/api/public/me` | viewer session (Bearer) | public API | ✓ |
| GET | `/api/public/me` | viewer session (Bearer) | public API | ✓ |
| PATCH | `/api/public/me` | viewer session (Bearer) | public API | ✓ |
| POST | `/api/public/me/email/change` | viewer session (Bearer) | public API | ✓ |
| POST | `/api/public/me/email/change/confirm` | viewer session (Bearer) | public API | ✓ |
| POST | `/api/public/me/email/verify` | viewer session (Bearer) | public API | ✓ |
| POST | `/api/public/me/email/verify/confirm` | viewer session (Bearer) | public API | ✓ |
| GET | `/api/public/me/entitlements` | viewer session (Bearer) | public API | ✓ |
| DELETE | `/api/public/me/mfa/:method` | viewer session (Bearer) | public API | ✓ |
| POST | `/api/public/me/mfa/backup-codes` | viewer session (Bearer) | public API | ✓ |
| POST | `/api/public/me/mfa/email/confirm` | viewer session (Bearer) | public API | ✓ |
| POST | `/api/public/me/mfa/email/start` | viewer session (Bearer) | public API | ✓ |
| POST | `/api/public/me/mfa/sms/confirm` | viewer session (Bearer) | public API | ✓ |
| POST | `/api/public/me/mfa/sms/start` | viewer session (Bearer) | public API | ✓ |
| POST | `/api/public/me/mfa/totp/confirm` | viewer session (Bearer) | public API | ✓ |
| POST | `/api/public/me/mfa/totp/start` | viewer session (Bearer) | public API | ✓ |
| POST | `/api/public/me/password` | viewer session (Bearer) | public API | ✓ |
| DELETE | `/api/public/me/phone` | viewer session (Bearer) | public API | ✓ |
| POST | `/api/public/me/phone` | viewer session (Bearer) | public API | ✓ |
| POST | `/api/public/me/phone/confirm` | viewer session (Bearer) | public API | ✓ |
| GET | `/api/public/me/purchases` | viewer session (Bearer) | public API | ✓ |
| GET | `/api/public/me/security` | viewer session (Bearer) | public API | ✓ |
| GET | `/api/public/me/sessions` | viewer session (Bearer) | public API | ✓ |
| POST | `/api/public/me/sign-out-everywhere` | viewer session (Bearer) | public API | ✓ |

### `/api/public/payments`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| POST | `/api/public/payments/verify` | publishable key + viewer | public API | ✓ |

### `/api/public/player`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/public/player/epg` | publishable key or player token | public API | ✓ |
| GET | `/api/public/player/event` | publishable key or player token | public API | ✓ |
| POST | `/api/public/player/events` | publishable key or player token | public API | ✓ |
| POST | `/api/public/player/now-playing` | publishable key or player token | public API | ✓ |
| POST | `/api/public/player/session` | publishable key or player token | public API | ✓ |

### `/api/share`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/share/:token/download/:element` | share link token (path), plus PIN or emailed code when the link has one | public (legacy alias of /api/public/share/:token/download/:element) | ✓ |
| POST | `/api/share/:token/request-code` | share link token (path), plus PIN or emailed code when the link has one | public (legacy alias of /api/public/share/:token/request-code) | ✓ |
| POST | `/api/share/:token/resolve` | share link token (path), plus PIN or emailed code when the link has one | public (legacy alias of /api/public/share/:token/resolve) | ✓ |

### `/api/signup`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| POST | `/api/signup` | none or per-route | open |  |
| POST | `/api/signup/checkout-status` | none or per-route | open |  |
| GET | `/api/signup/config` | none or per-route | open |  |
| POST | `/api/signup/webhooks/stripe` | none or per-route | open |  |

### `/api/source-preview`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/source-preview/:token/index.m3u8` | none or per-route | open |  |
| GET | `/api/source-preview/:token/pl` | none or per-route | open |  |
| GET | `/api/source-preview/:token/seg` | none or per-route | open |  |

## Sign-in (no session yet)

Admin and platform sign-in. Returns a session, or a two-step challenge.

### `/api/auth`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| POST | `/api/auth/login` | email + password | no session |  |
| POST | `/api/auth/mfa/challenge/send` | sign-in challenge (body) | no session |  |
| POST | `/api/auth/mfa/challenge/verify` | sign-in challenge (body) | no session |  |
| POST | `/api/auth/refresh` | refresh token (body) | no session |  |
| POST | `/api/auth/register` | email + password | no session |  |

### `/api/platform/auth`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| POST | `/api/platform/auth/login` | email + password | no session |  |
| POST | `/api/platform/auth/mfa` | sign-in challenge (body) | no session |  |

## Admin API

A client's staff. Admin session (audience `volt:admin`) or the account secret key. Each route needs the feature and level shown, from the user's roles (ACCESS_CONTROL.md section 3).

### `/api/access-roles`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/access-roles` | admin session (Bearer) or account secret key | access or users: view |  |
| POST | `/api/access-roles` | admin session (Bearer) or account secret key | access: manage |  |
| DELETE | `/api/access-roles/:id` | admin session (Bearer) or account secret key | access: manage |  |
| PATCH | `/api/access-roles/:id` | admin session (Bearer) or account secret key | access: manage |  |
| POST | `/api/access-roles/:id/copy` | admin session (Bearer) or account secret key | access: manage |  |
| GET | `/api/access-roles/catalogue` | admin session (Bearer) or account secret key | access or users: view |  |

### `/api/account-settings`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/account-settings` | admin session (Bearer) or account secret key | settings: any signed-in admin user (lookup for forms) |  |
| PATCH | `/api/account-settings` | admin session (Bearer) or account secret key | settings: manage |  |
| GET | `/api/account-settings/captions` | admin session (Bearer) or account secret key | settings: any signed-in admin user (lookup for forms) |  |
| PATCH | `/api/account-settings/captions` | admin session (Bearer) or account secret key | settings: manage |  |
| PATCH | `/api/account-settings/captions/profiles/:id` | admin session (Bearer) or account secret key | settings: manage |  |

### `/api/addons`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/addons` | admin session (Bearer) or account secret key | settings: any signed-in admin user (lookup for forms) |  |
| POST | `/api/addons` | admin session (Bearer) or account secret key | settings: manage |  |
| DELETE | `/api/addons/:id` | admin session (Bearer) or account secret key | settings: manage |  |
| PATCH | `/api/addons/:id` | admin session (Bearer) or account secret key | settings: manage |  |
| POST | `/api/addons/:id/rotate-secret` | admin session (Bearer) or account secret key | settings: manage |  |
| POST | `/api/addons/:id/test` | admin session (Bearer) or account secret key | settings: manage |  |
| GET | `/api/addons/triggers` | admin session (Bearer) or account secret key | settings: any signed-in admin user (lookup for forms) |  |
| POST | `/api/addons/triggers` | admin session (Bearer) or account secret key | settings: manage |  |
| DELETE | `/api/addons/triggers/:id` | admin session (Bearer) or account secret key | settings: manage |  |
| PATCH | `/api/addons/triggers/:id` | admin session (Bearer) or account secret key | settings: manage |  |

### `/api/analytics`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/analytics/asset` | admin session (Bearer) or account secret key | analytics: view |  |
| GET | `/api/analytics/audience` | admin session (Bearer) or account secret key | analytics: view |  |
| GET | `/api/analytics/overview` | admin session (Bearer) or account secret key | analytics: view |  |
| GET | `/api/analytics/realtime` | admin session (Bearer) or account secret key | analytics: view |  |
| GET | `/api/analytics/retention` | admin session (Bearer) or account secret key | analytics: view |  |
| PUT | `/api/analytics/retention` | admin session (Bearer) or account secret key | analytics: manage |  |
| POST | `/api/analytics/retention/sweep` | admin session (Bearer) or account secret key | analytics: manage |  |
| GET | `/api/analytics/usage` | admin session (Bearer) or account secret key | analytics: view |  |

### `/api/apps`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/apps` | admin session (Bearer) or account secret key | apps: view |  |
| POST | `/api/apps` | admin session (Bearer) or account secret key | apps: manage |  |
| GET | `/api/apps/:id` | admin session (Bearer) or account secret key | apps: view |  |
| PUT | `/api/apps/:id` | admin session (Bearer) or account secret key | apps: manage |  |
| POST | `/api/apps/:id/keys` | admin session (Bearer) or account secret key | apps: manage |  |
| GET | `/api/apps/keys` | admin session (Bearer) or account secret key | apps: view |  |
| DELETE | `/api/apps/keys/:keyId` | admin session (Bearer) or account secret key | apps: manage |  |
| POST | `/api/apps/secret-keys` | admin session (Bearer) or account secret key | apps: manage + admin tier |  |

### `/api/audit`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/audit` | admin session (Bearer) or account secret key | any signed-in admin user |  |
| GET | `/api/audit/export.csv` | admin session (Bearer) or account secret key | any signed-in admin user |  |
| GET | `/api/audit/facets` | admin session (Bearer) or account secret key | any signed-in admin user |  |

### `/api/auth`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| POST | `/api/auth/email/change` | admin session (Bearer) | own account (any admin user) |  |
| POST | `/api/auth/email/change/confirm` | admin session (Bearer) | own account (any admin user) |  |
| POST | `/api/auth/email/verify` | admin session (Bearer) | own account (any admin user) |  |
| POST | `/api/auth/email/verify/confirm` | admin session (Bearer) | own account (any admin user) |  |
| POST | `/api/auth/logout` | admin session (Bearer) | own account (any admin user) |  |
| GET | `/api/auth/me` | admin session (Bearer) | own account (any admin user) |  |
| PATCH | `/api/auth/me` | admin session (Bearer) | own account (any admin user) |  |
| DELETE | `/api/auth/mfa/:method` | admin session (Bearer) | own account (any admin user) |  |
| POST | `/api/auth/mfa/backup-codes` | admin session (Bearer) | own account (any admin user) |  |
| POST | `/api/auth/mfa/email/confirm` | admin session, or the setup challenge during sign-in | own account (any admin user) |  |
| POST | `/api/auth/mfa/email/start` | admin session, or the setup challenge during sign-in | own account (any admin user) |  |
| POST | `/api/auth/mfa/sms/confirm` | admin session, or the setup challenge during sign-in | own account (any admin user) |  |
| POST | `/api/auth/mfa/sms/start` | admin session, or the setup challenge during sign-in | own account (any admin user) |  |
| POST | `/api/auth/mfa/totp/confirm` | admin session, or the setup challenge during sign-in | own account (any admin user) |  |
| POST | `/api/auth/mfa/totp/start` | admin session, or the setup challenge during sign-in | own account (any admin user) |  |
| POST | `/api/auth/password` | admin session (Bearer) | own account (any admin user) |  |
| DELETE | `/api/auth/phone` | admin session (Bearer) | own account (any admin user) |  |
| POST | `/api/auth/phone` | admin session (Bearer) | own account (any admin user) |  |
| POST | `/api/auth/phone/confirm` | admin session (Bearer) | own account (any admin user) |  |
| GET | `/api/auth/security` | admin session (Bearer) | own account (any admin user) |  |

### `/api/channels`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/channels` | admin session (Bearer) or account secret key | channels: view |  |
| POST | `/api/channels` | admin session (Bearer) or account secret key | channels: manage |  |
| DELETE | `/api/channels/:id` | admin session (Bearer) or account secret key | channels: manage (radio: same level, when the channel is a station) |  |
| GET | `/api/channels/:id` | admin session (Bearer) or account secret key | channels: view (radio: same level, when the channel is a station) |  |
| PATCH | `/api/channels/:id` | admin session (Bearer) or account secret key | channels: manage (radio: same level, when the channel is a station) |  |
| PUT | `/api/channels/:id` | admin session (Bearer) or account secret key | channels: manage (radio: same level, when the channel is a station) |  |
| POST | `/api/channels/:id/:action(start\|stop)` | admin session (Bearer) or account secret key | channels: operate (radio: same level, when the channel is a station) |  |
| GET | `/api/channels/:id/access-check` | admin session (Bearer) or account secret key | channels: view (radio: same level, when the channel is a station) |  |
| POST | `/api/channels/:id/air` | admin session (Bearer) or account secret key | channels: operate (radio: same level, when the channel is a station) |  |
| POST | `/api/channels/:id/auto-connect` | admin session (Bearer) or account secret key | channels: operate (radio: same level, when the channel is a station) |  |
| GET | `/api/channels/:id/coverage` | admin session (Bearer) or account secret key | channels: view (radio: same level, when the channel is a station) |  |
| GET | `/api/channels/:id/dayparts` | admin session (Bearer) or account secret key | channels: view (radio: same level, when the channel is a station) |  |
| PUT | `/api/channels/:id/dayparts` | admin session (Bearer) or account secret key | channels: manage (radio: same level, when the channel is a station) |  |
| GET | `/api/channels/:id/delete-impact` | admin session (Bearer) or account secret key | channels: view (radio: same level, when the channel is a station) |  |
| GET | `/api/channels/:id/failover-test` | admin session (Bearer) or account secret key | channels: view (radio: same level, when the channel is a station) |  |
| POST | `/api/channels/:id/failover-test` | admin session (Bearer) or account secret key | channels: operate (radio: same level, when the channel is a station) |  |
| GET | `/api/channels/:id/filler` | admin session (Bearer) or account secret key | channels: view (radio: same level, when the channel is a station) |  |
| POST | `/api/channels/:id/filler` | admin session (Bearer) or account secret key | channels: manage (radio: same level, when the channel is a station) |  |
| GET | `/api/channels/:id/history` | admin session (Bearer) or account secret key | channels: view (radio: same level, when the channel is a station) |  |
| GET | `/api/channels/:id/inputs/:inputId/preview` | admin session (Bearer) or account secret key | channels: view (radio: same level, when the channel is a station) |  |
| POST | `/api/channels/:id/reset-health` | admin session (Bearer) or account secret key | channels: operate (radio: same level, when the channel is a station) |  |
| GET | `/api/channels/:id/test-stream` | admin session (Bearer) or account secret key | channels: view (radio: same level, when the channel is a station) |  |
| POST | `/api/channels/:id/test-stream` | admin session (Bearer) or account secret key | channels: operate (radio: same level, when the channel is a station) |  |
| GET | `/api/channels/:id/thumbs` | admin session (Bearer) or account secret key | channels: view (radio: same level, when the channel is a station) |  |
| GET | `/api/channels/:id/timeline` | admin session (Bearer) or account secret key | channels: view (radio: same level, when the channel is a station) |  |
| GET | `/api/channels/:id/waveform` | admin session (Bearer) or account secret key | channels: view (radio: same level, when the channel is a station) |  |

### `/api/daypart-presets`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/daypart-presets` | admin session (Bearer) or account secret key | channels: view |  |

### `/api/docs`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/docs/session` | admin session (Bearer) or account secret key | any signed-in admin user |  |

### `/api/encode-profiles`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/encode-profiles` | admin session (Bearer) or account secret key | settings: any signed-in admin user (lookup for forms) |  |
| POST | `/api/encode-profiles` | admin session (Bearer) or account secret key | settings: manage |  |
| DELETE | `/api/encode-profiles/:id` | admin session (Bearer) or account secret key | settings: manage |  |
| PATCH | `/api/encode-profiles/:id` | admin session (Bearer) or account secret key | settings: manage |  |
| GET | `/api/encode-profiles/ladders` | admin session (Bearer) or account secret key | settings: any signed-in admin user (lookup for forms) |  |
| POST | `/api/encode-profiles/ladders` | admin session (Bearer) or account secret key | settings: manage |  |
| DELETE | `/api/encode-profiles/ladders/:id` | admin session (Bearer) or account secret key | settings: manage |  |
| PATCH | `/api/encode-profiles/ladders/:id` | admin session (Bearer) or account secret key | settings: manage |  |
| PUT | `/api/encode-profiles/ladders/:id/members` | admin session (Bearer) or account secret key | settings: manage |  |
| GET | `/api/encode-profiles/ladders/:id/preview` | admin session (Bearer) or account secret key | settings: any signed-in admin user (lookup for forms) |  |
| POST | `/api/encode-profiles/ladders/mirror` | admin session (Bearer) or account secret key | settings: manage |  |
| GET | `/api/encode-profiles/live-profiles` | admin session (Bearer) or account secret key | settings: any signed-in admin user (lookup for forms) |  |

### `/api/engines`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/engines` | admin session (Bearer) or account secret key | settings: any signed-in admin user (lookup for forms) |  |
| GET | `/api/engines/:id` | admin session (Bearer) or account secret key | settings: any signed-in admin user (lookup for forms) |  |
| POST | `/api/engines/:id/validate` | admin session (Bearer) or account secret key | settings: manage |  |
| PUT | `/api/engines/profiles/:profileId` | admin session (Bearer) or account secret key | settings: manage |  |

### `/api/epg`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/epg` | admin session (Bearer) or account secret key | epg: view |  |
| POST | `/api/epg` | admin session (Bearer) or account secret key | epg: manage |  |
| DELETE | `/api/epg/:id` | admin session (Bearer) or account secret key | epg: manage |  |
| GET | `/api/epg/:id` | admin session (Bearer) or account secret key | epg: view |  |
| PATCH | `/api/epg/:id` | admin session (Bearer) or account secret key | epg: manage |  |
| POST | `/api/epg/:id/convert` | admin session (Bearer) or account secret key | epg: manage |  |
| GET | `/api/epg/as-run` | admin session (Bearer) or account secret key | epg: view |  |
| POST | `/api/epg/batches/:id/undo` | admin session (Bearer) or account secret key | epg: manage |  |
| GET | `/api/epg/channels` | admin session (Bearer) or account secret key | epg: view |  |
| PUT | `/api/epg/channels/:id/guide-icon` | admin session (Bearer) or account secret key | epg: manage |  |
| PUT | `/api/epg/channels/:id/xmltv-id` | admin session (Bearer) or account secret key | epg: manage |  |
| POST | `/api/epg/clear-day` | admin session (Bearer) or account secret key | epg: manage |  |
| GET | `/api/epg/conflicts` | admin session (Bearer) or account secret key | epg: view |  |
| POST | `/api/epg/copy-day` | admin session (Bearer) or account secret key | epg: manage |  |
| PUT | `/api/epg/import/aliases/:id` | admin session (Bearer) or account secret key | epg: manage |  |
| GET | `/api/epg/import/sources` | admin session (Bearer) or account secret key | epg: view |  |
| POST | `/api/epg/import/sources` | admin session (Bearer) or account secret key | epg: manage |  |
| DELETE | `/api/epg/import/sources/:id` | admin session (Bearer) or account secret key | epg: manage |  |
| PATCH | `/api/epg/import/sources/:id` | admin session (Bearer) or account secret key | epg: manage |  |
| GET | `/api/epg/import/sources/:id/channels` | admin session (Bearer) or account secret key | epg: view |  |
| POST | `/api/epg/import/sources/:id/channels/:aliasId/use-icon` | admin session (Bearer) or account secret key | epg: manage |  |
| POST | `/api/epg/import/sources/:id/channels/bulk` | admin session (Bearer) or account secret key | epg: manage |  |
| POST | `/api/epg/import/sources/:id/run` | admin session (Bearer) or account secret key | epg: operate |  |
| GET | `/api/epg/import/sources/:id/runs` | admin session (Bearer) or account secret key | epg: view |  |
| POST | `/api/epg/import/sources/:id/test` | admin session (Bearer) or account secret key | epg: operate |  |
| POST | `/api/epg/import/sources/:id/upload` | admin session (Bearer) or account secret key | epg: manage |  |
| GET | `/api/epg/now-next` | admin session (Bearer) or account secret key | epg: view |  |
| GET | `/api/epg/owner-defaults` | admin session (Bearer) or account secret key | epg: view |  |
| GET | `/api/epg/owners` | admin session (Bearer) or account secret key | epg: view |  |
| POST | `/api/epg/repeat` | admin session (Bearer) or account secret key | epg: manage |  |
| POST | `/api/epg/series` | admin session (Bearer) or account secret key | epg: manage |  |
| GET | `/api/epg/series/:id` | admin session (Bearer) or account secret key | epg: view |  |
| POST | `/api/epg/series/:id/end` | admin session (Bearer) or account secret key | epg: manage |  |
| GET | `/api/epg/vod-status` | admin session (Bearer) or account secret key | epg: view |  |
| GET | `/api/epg/xmltv` | admin session (Bearer) or account secret key | epg: view |  |
| GET | `/api/epg/xmltv/feeds` | admin session (Bearer) or account secret key | epg: view |  |
| POST | `/api/epg/xmltv/feeds` | admin session (Bearer) or account secret key | epg: manage |  |
| DELETE | `/api/epg/xmltv/feeds/:id` | admin session (Bearer) or account secret key | epg: manage |  |
| PATCH | `/api/epg/xmltv/feeds/:id` | admin session (Bearer) or account secret key | epg: manage |  |
| POST | `/api/epg/xmltv/feeds/:id/rotate` | admin session (Bearer) or account secret key | epg: manage |  |

### `/api/events`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/events` | admin session (Bearer) or account secret key | events: view |  |
| POST | `/api/events` | admin session (Bearer) or account secret key | events: manage |  |
| DELETE | `/api/events/:id` | admin session (Bearer) or account secret key | events: manage |  |
| GET | `/api/events/:id` | admin session (Bearer) or account secret key | events: view |  |
| PATCH | `/api/events/:id` | admin session (Bearer) or account secret key | events: manage |  |
| PUT | `/api/events/:id` | admin session (Bearer) or account secret key | events: manage |  |
| POST | `/api/events/:id/:action(start\|stop)` | admin session (Bearer) or account secret key | events: operate |  |
| GET | `/api/events/:id/access-check` | admin session (Bearer) or account secret key | events: view |  |
| POST | `/api/events/:id/auto-connect` | admin session (Bearer) or account secret key | events: operate |  |
| GET | `/api/events/:id/detail` | admin session (Bearer) or account secret key | events: view |  |
| GET | `/api/events/:id/filler` | admin session (Bearer) or account secret key | events: view |  |
| POST | `/api/events/:id/filler` | admin session (Bearer) or account secret key | events: manage |  |
| POST | `/api/events/:id/health/reset` | admin session (Bearer) or account secret key | events: operate |  |
| GET | `/api/events/:id/history` | admin session (Bearer) or account secret key | events: view |  |
| GET | `/api/events/:id/inputs/:inputId/preview` | admin session (Bearer) or account secret key | events: view |  |
| POST | `/api/events/:id/reset-health` | admin session (Bearer) or account secret key | events: operate |  |

### `/api/fast`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/fast/ad-servers` | admin session (Bearer) or account secret key | any signed-in admin user |  |
| POST | `/api/fast/ad-servers` | admin session (Bearer) or account secret key | operator tier or above |  |
| DELETE | `/api/fast/ad-servers/:sid` | admin session (Bearer) or account secret key | operator tier or above |  |
| PUT | `/api/fast/ad-servers/:sid` | admin session (Bearer) or account secret key | operator tier or above |  |
| POST | `/api/fast/ad-servers/:sid/test` | admin session (Bearer) or account secret key | operator tier or above |  |
| GET | `/api/fast/channels` | admin session (Bearer) or account secret key | any signed-in admin user |  |
| POST | `/api/fast/channels` | admin session (Bearer) or account secret key | operator tier or above |  |
| GET | `/api/fast/channels/:id` | admin session (Bearer) or account secret key | any signed-in admin user |  |
| GET | `/api/fast/channels/:id/ad-report` | admin session (Bearer) or account secret key | any signed-in admin user |  |
| GET | `/api/fast/channels/:id/ads` | admin session (Bearer) or account secret key | any signed-in admin user |  |
| PUT | `/api/fast/channels/:id/ads` | admin session (Bearer) or account secret key | operator tier or above |  |
| GET | `/api/fast/channels/:id/breaks/:bid/beacons` | admin session (Bearer) or account secret key | any signed-in admin user |  |
| POST | `/api/fast/channels/:id/breaks/:bid/decide` | admin session (Bearer) or account secret key | operator tier or above |  |
| POST | `/api/fast/channels/:id/lineups` | admin session (Bearer) or account secret key | operator tier or above |  |
| POST | `/api/fast/channels/:id/on-air` | admin session (Bearer) or account secret key | operator tier or above |  |
| POST | `/api/fast/channels/:id/prepare` | admin session (Bearer) or account secret key | operator tier or above |  |
| GET | `/api/fast/channels/:id/readiness` | admin session (Bearer) or account secret key | any signed-in admin user |  |
| GET | `/api/fast/library` | admin session (Bearer) or account secret key | any signed-in admin user |  |
| DELETE | `/api/fast/lineups/:lid` | admin session (Bearer) or account secret key | operator tier or above |  |
| GET | `/api/fast/lineups/:lid` | admin session (Bearer) or account secret key | any signed-in admin user |  |
| PUT | `/api/fast/lineups/:lid` | admin session (Bearer) or account secret key | operator tier or above |  |
| POST | `/api/fast/lineups/:lid/activate` | admin session (Bearer) or account secret key | operator tier or above |  |
| POST | `/api/fast/lineups/:lid/apply` | admin session (Bearer) or account secret key | operator tier or above |  |
| POST | `/api/fast/lineups/:lid/preview` | admin session (Bearer) or account secret key | operator tier or above |  |
| GET | `/api/fast/streams/:kind/:id/breaks` | admin session (Bearer) or account secret key | any signed-in admin user |  |
| POST | `/api/fast/streams/:kind/:id/breaks` | admin session (Bearer) or account secret key | operator tier or above |  |
| DELETE | `/api/fast/streams/:kind/:id/breaks/:bid` | admin session (Bearer) or account secret key | operator tier or above |  |

### `/api/files`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/files` | admin session (Bearer) or account secret key | media: any signed-in admin user (lookup for forms) |  |
| POST | `/api/files` | admin session (Bearer) or account secret key | media: manage |  |
| DELETE | `/api/files/:id` | admin session (Bearer) or account secret key | media: manage |  |
| GET | `/api/files/:id` | admin session (Bearer) or account secret key | media: any signed-in admin user (lookup for forms) |  |
| PATCH | `/api/files/:id` | admin session (Bearer) or account secret key | media: manage |  |
| POST | `/api/files/:id/metadata/refresh` | admin session (Bearer) or account secret key | media: manage |  |
| GET | `/api/files/folders` | admin session (Bearer) or account secret key | media: any signed-in admin user (lookup for forms) |  |
| POST | `/api/files/folders` | admin session (Bearer) or account secret key | media: manage |  |
| POST | `/api/files/metadata/backfill` | admin session (Bearer) or account secret key | media: manage |  |
| GET | `/api/files/search` | admin session (Bearer) or account secret key | media: any signed-in admin user (lookup for forms) |  |

### `/api/filler-assets`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/filler-assets` | admin session (Bearer) or account secret key | media: view |  |
| POST | `/api/filler-assets` | admin session (Bearer) or account secret key | media: manage |  |
| DELETE | `/api/filler-assets/:id` | admin session (Bearer) or account secret key | media: manage |  |
| GET | `/api/filler-assets/:id` | admin session (Bearer) or account secret key | media: view |  |
| PATCH | `/api/filler-assets/:id` | admin session (Bearer) or account secret key | media: manage |  |
| POST | `/api/filler-assets/copy-from-library` | admin session (Bearer) or account secret key | media: manage |  |
| GET | `/api/filler-assets/elsewhere` | admin session (Bearer) or account secret key | media: view |  |

### `/api/fleet`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/fleet/hosts` | admin session (Bearer) or account secret key | fleet: view |  |
| GET | `/api/fleet/hosts/:id/samples` | admin session (Bearer) or account secret key | fleet: view |  |
| GET | `/api/fleet/usage` | admin session (Bearer) or account secret key | fleet: view |  |
| GET | `/api/fleet/usage/stream/:id` | admin session (Bearer) or account secret key | fleet: view |  |

### `/api/graphics`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/graphics/assignments` | admin session (Bearer) or account secret key | graphics: view |  |
| POST | `/api/graphics/assignments` | admin session (Bearer) or account secret key | graphics: manage |  |
| DELETE | `/api/graphics/assignments/:id` | admin session (Bearer) or account secret key | graphics: manage |  |
| PATCH | `/api/graphics/assignments/:id` | admin session (Bearer) or account secret key | graphics: manage |  |
| POST | `/api/graphics/assignments/:id/air` | admin session (Bearer) or account secret key | graphics: operate |  |
| GET | `/api/graphics/assignments/:id/state` | admin session (Bearer) or account secret key | graphics: view |  |
| PATCH | `/api/graphics/assignments/:id/state` | admin session (Bearer) or account secret key | graphics: operate |  |
| GET | `/api/graphics/live` | admin session (Bearer) or account secret key | graphics: view |  |
| GET | `/api/graphics/log` | admin session (Bearer) or account secret key | graphics: view |  |
| GET | `/api/graphics/plan` | admin session (Bearer) or account secret key | graphics: view |  |
| GET | `/api/graphics/rundowns/:eventId` | admin session (Bearer) or account secret key | graphics: view |  |
| POST | `/api/graphics/rundowns/:eventId/copy-from` | admin session (Bearer) or account secret key | graphics: manage |  |
| POST | `/api/graphics/rundowns/:eventId/import-csv` | admin session (Bearer) or account secret key | graphics: manage |  |
| POST | `/api/graphics/rundowns/:eventId/items` | admin session (Bearer) or account secret key | graphics: manage |  |
| DELETE | `/api/graphics/rundowns/:eventId/items/:itemId` | admin session (Bearer) or account secret key | graphics: manage |  |
| PATCH | `/api/graphics/rundowns/:eventId/items/:itemId` | admin session (Bearer) or account secret key | graphics: manage |  |
| POST | `/api/graphics/rundowns/:eventId/items/:itemId/:action(skip\|restore)` | admin session (Bearer) or account secret key | graphics: operate |  |
| POST | `/api/graphics/rundowns/:eventId/reorder` | admin session (Bearer) or account secret key | graphics: manage |  |
| POST | `/api/graphics/rundowns/:eventId/take` | admin session (Bearer) or account secret key | graphics: operate |  |
| POST | `/api/graphics/rundowns/:eventId/take-off` | admin session (Bearer) or account secret key | graphics: operate |  |
| GET | `/api/graphics/setups` | admin session (Bearer) or account secret key | graphics: view |  |
| POST | `/api/graphics/setups` | admin session (Bearer) or account secret key | graphics: manage |  |
| DELETE | `/api/graphics/setups/:id` | admin session (Bearer) or account secret key | graphics: manage |  |
| GET | `/api/graphics/setups/:id` | admin session (Bearer) or account secret key | graphics: view |  |
| PATCH | `/api/graphics/setups/:id` | admin session (Bearer) or account secret key | graphics: manage |  |
| GET | `/api/graphics/sources` | admin session (Bearer) or account secret key | graphics: view |  |
| POST | `/api/graphics/sources` | admin session (Bearer) or account secret key | graphics: manage |  |
| DELETE | `/api/graphics/sources/:id` | admin session (Bearer) or account secret key | graphics: manage |  |
| PATCH | `/api/graphics/sources/:id` | admin session (Bearer) or account secret key | graphics: manage |  |
| POST | `/api/graphics/sources/:id/push` | admin session (Bearer) or account secret key | graphics: operate |  |
| POST | `/api/graphics/sources/:id/test` | admin session (Bearer) or account secret key | graphics: manage |  |
| GET | `/api/graphics/templates` | admin session (Bearer) or account secret key | graphics: view |  |
| POST | `/api/graphics/templates` | admin session (Bearer) or account secret key | graphics: manage |  |
| DELETE | `/api/graphics/templates/:id` | admin session (Bearer) or account secret key | graphics: manage |  |
| GET | `/api/graphics/templates/:id` | admin session (Bearer) or account secret key | graphics: view |  |
| PATCH | `/api/graphics/templates/:id` | admin session (Bearer) or account secret key | graphics: manage |  |
| DELETE | `/api/graphics/templates/:id/draft` | admin session (Bearer) or account secret key | graphics: manage |  |
| PUT | `/api/graphics/templates/:id/draft` | admin session (Bearer) or account secret key | graphics: manage |  |
| POST | `/api/graphics/templates/:id/draft/publish` | admin session (Bearer) or account secret key | graphics: manage |  |
| POST | `/api/graphics/templates/:id/duplicate` | admin session (Bearer) or account secret key | graphics: manage |  |
| POST | `/api/graphics/templates/:id/style` | admin session (Bearer) or account secret key | graphics: manage |  |
| GET | `/api/graphics/templates/:id/versions/:vid/download` | admin session (Bearer) or account secret key | graphics: view |  |
| GET | `/api/graphics/templates/:id/versions/:vid/files` | admin session (Bearer) or account secret key | graphics: view |  |
| GET | `/api/graphics/templates/:id/versions/:vid/source` | admin session (Bearer) or account secret key | graphics: view |  |
| GET | `/api/graphics/templates/:id/versions/:vid/style` | admin session (Bearer) or account secret key | graphics: view |  |
| POST | `/api/graphics/templates/import` | admin session (Bearer) or account secret key | graphics: manage |  |

### `/api/groups`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/groups` | admin session (Bearer) or account secret key | settings: any signed-in admin user (lookup for forms) |  |
| POST | `/api/groups` | admin session (Bearer) or account secret key | settings: manage |  |
| DELETE | `/api/groups/:id` | admin session (Bearer) or account secret key | settings: manage |  |
| PATCH | `/api/groups/:id` | admin session (Bearer) or account secret key | settings: manage |  |
| GET | `/api/groups/:id/usage` | admin session (Bearer) or account secret key | settings: any signed-in admin user (lookup for forms) |  |

### `/api/images`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/images/config` | admin session (Bearer) or account secret key | any signed-in admin user |  |
| POST | `/api/images/sign` | admin session (Bearer) or account secret key | operator tier or above |  |
| GET | `/api/images/signing-key` | admin session (Bearer) or account secret key | any signed-in admin user |  |
| GET | `/api/images/stats` | admin session (Bearer) or account secret key | any signed-in admin user |  |

### `/api/ingest`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| POST | `/api/ingest/assets/:id/duplicate` | admin session (Bearer) or account secret key | settings: manage |  |
| POST | `/api/ingest/assets/:id/metadata` | admin session (Bearer) or account secret key | settings: manage |  |
| GET | `/api/ingest/baseline` | admin session (Bearer) or account secret key | settings: view |  |
| GET | `/api/ingest/held` | admin session (Bearer) or account secret key | settings: view |  |
| POST | `/api/ingest/locate` | admin session (Bearer) or account secret key | settings: manage |  |
| POST | `/api/ingest/preview` | admin session (Bearer) or account secret key | settings: manage |  |
| GET | `/api/ingest/providers` | admin session (Bearer) or account secret key | settings: view |  |
| POST | `/api/ingest/providers` | admin session (Bearer) or account secret key | settings: manage |  |
| DELETE | `/api/ingest/providers/:id` | admin session (Bearer) or account secret key | settings: manage |  |
| GET | `/api/ingest/providers/:provider/authorize` | admin session (Bearer) or account secret key | settings: view |  |
| GET | `/api/ingest/providers/:provider/callback` | admin session (Bearer) or account secret key | settings: view |  |
| POST | `/api/ingest/remote` | admin session (Bearer) or account secret key | settings: manage |  |
| GET | `/api/ingest/rules` | admin session (Bearer) or account secret key | settings: view |  |
| POST | `/api/ingest/rules` | admin session (Bearer) or account secret key | settings: manage |  |
| DELETE | `/api/ingest/rules/:id` | admin session (Bearer) or account secret key | settings: manage |  |
| PATCH | `/api/ingest/rules/:id` | admin session (Bearer) or account secret key | settings: manage |  |
| POST | `/api/ingest/sanitise` | admin session (Bearer) or account secret key | settings: manage |  |
| GET | `/api/ingest/transfers` | admin session (Bearer) or account secret key | settings: view |  |
| POST | `/api/ingest/transfers` | admin session (Bearer) or account secret key | settings: manage |  |
| GET | `/api/ingest/webhooks` | admin session (Bearer) or account secret key | settings: view |  |
| POST | `/api/ingest/webhooks` | admin session (Bearer) or account secret key | settings: manage |  |
| DELETE | `/api/ingest/webhooks/:id` | admin session (Bearer) or account secret key | settings: manage |  |
| PATCH | `/api/ingest/webhooks/:id` | admin session (Bearer) or account secret key | settings: manage |  |

### `/api/jobs`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/jobs` | admin session (Bearer) or account secret key | media: view |  |
| GET | `/api/jobs/:id` | admin session (Bearer) or account secret key | media: view |  |
| POST | `/api/jobs/:id/cancel` | admin session (Bearer) or account secret key | media: operate |  |
| POST | `/api/jobs/:id/retry` | admin session (Bearer) or account secret key | media: operate |  |

### `/api/live-streams`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/live-streams` | admin session (Bearer) or account secret key | monitoring: view |  |
| GET | `/api/live-streams/:kind/:id` | admin session (Bearer) or account secret key | monitoring: view |  |
| GET | `/api/live-streams/:kind/:id/provider` | admin session (Bearer) or account secret key | monitoring: view |  |
| GET | `/api/live-streams/:kind/:id/schema.org` | admin session (Bearer) or account secret key | monitoring: view |  |
| GET | `/api/live-streams/presets` | admin session (Bearer) or account secret key | monitoring: view |  |

### `/api/metadata-schemas`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/metadata-schemas` | admin session (Bearer) or account secret key | settings: any signed-in admin user (lookup for forms) |  |
| POST | `/api/metadata-schemas` | admin session (Bearer) or account secret key | settings: manage |  |
| DELETE | `/api/metadata-schemas/:id` | admin session (Bearer) or account secret key | settings: manage |  |
| GET | `/api/metadata-schemas/:id` | admin session (Bearer) or account secret key | settings: any signed-in admin user (lookup for forms) |  |
| PATCH | `/api/metadata-schemas/:id` | admin session (Bearer) or account secret key | settings: manage |  |
| PUT | `/api/metadata-schemas/:id` | admin session (Bearer) or account secret key | settings: manage |  |
| GET | `/api/metadata-schemas/:id/effective-fields` | admin session (Bearer) or account secret key | settings: any signed-in admin user (lookup for forms) |  |
| GET | `/api/metadata-schemas/:id/history` | admin session (Bearer) or account secret key | settings: any signed-in admin user (lookup for forms) |  |

### `/api/monitoring`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/monitoring/feed` | admin session (Bearer) or account secret key | monitoring: view |  |
| GET | `/api/monitoring/live` | admin session (Bearer) or account secret key | monitoring: view |  |
| GET | `/api/monitoring/overview` | admin session (Bearer) or account secret key | monitoring: view |  |

### `/api/notification-templates`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/notification-templates` | admin session (Bearer) or account secret key | settings: view |  |
| POST | `/api/notification-templates` | admin session (Bearer) or account secret key | settings: manage |  |
| DELETE | `/api/notification-templates/:id` | admin session (Bearer) or account secret key | settings: manage |  |
| PATCH | `/api/notification-templates/:id` | admin session (Bearer) or account secret key | settings: manage |  |

### `/api/notifications`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/notifications` | admin session (Bearer) or account secret key | any signed-in admin user |  |
| POST | `/api/notifications` | admin session (Bearer) or account secret key | operator tier or above |  |
| GET | `/api/notifications/:id` | admin session (Bearer) or account secret key | any signed-in admin user |  |
| GET | `/api/notifications/config` | admin session (Bearer) or account secret key | any signed-in admin user |  |
| POST | `/api/notifications/deliveries/:id/retry` | admin session (Bearer) or account secret key | operator tier or above |  |
| GET | `/api/notifications/devices` | admin session (Bearer) or account secret key | any signed-in admin user |  |
| POST | `/api/notifications/devices` | admin session (Bearer) or account secret key | operator tier or above |  |
| DELETE | `/api/notifications/devices/:id` | admin session (Bearer) or account secret key | operator tier or above |  |
| GET | `/api/notifications/inbox` | admin session (Bearer) or account secret key | any signed-in admin user |  |
| POST | `/api/notifications/inbox/:id/read` | admin session (Bearer) or account secret key | operator tier or above |  |
| POST | `/api/notifications/inbox/read-all` | admin session (Bearer) or account secret key | operator tier or above |  |
| POST | `/api/notifications/retry` | admin session (Bearer) or account secret key | operator tier or above |  |
| POST | `/api/notifications/test` | admin session (Bearer) or account secret key | operator tier or above |  |

### `/api/output-profiles`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/output-profiles` | admin session (Bearer) or account secret key | settings: any signed-in admin user (lookup for forms) |  |
| POST | `/api/output-profiles` | admin session (Bearer) or account secret key | settings: manage |  |
| DELETE | `/api/output-profiles/:id` | admin session (Bearer) or account secret key | settings: manage |  |

### `/api/payments`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| POST | `/api/payments/grants` | admin session (Bearer) or account secret key | payments: manage |  |
| POST | `/api/payments/manual` | admin session (Bearer) or account secret key | payments: manage |  |
| GET | `/api/payments/products` | admin session (Bearer) or account secret key | payments: view |  |
| PATCH | `/api/payments/products/:id` | admin session (Bearer) or account secret key | payments: manage |  |
| GET | `/api/payments/providers` | admin session (Bearer) or account secret key | payments: view |  |
| PUT | `/api/payments/providers/:provider` | admin session (Bearer) or account secret key | payments: manage |  |
| GET | `/api/payments/viewers/:externalId` | admin session (Bearer) or account secret key | payments: view |  |

### `/api/plan`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/plan` | admin session (Bearer) or account secret key | settings: any signed-in admin user (lookup for forms) |  |
| PATCH | `/api/plan` | admin session (Bearer) or account secret key | settings: manage |  |

### `/api/player-config`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/player-config/:channelId` | admin session (Bearer) or account secret key | apps: view |  |
| PUT | `/api/player-config/:channelId` | admin session (Bearer) or account secret key | apps: manage |  |
| GET | `/api/player-config/:channelId/report` | admin session (Bearer) or account secret key | apps: view |  |

### `/api/publications`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/publications` | admin session (Bearer) or account secret key | vod: view |  |
| GET | `/api/publications/:id` | admin session (Bearer) or account secret key | vod: view |  |
| POST | `/api/publications/sync-views` | admin session (Bearer) or account secret key | vod: manage |  |
| POST | `/api/publications/vod/:id/publish` | admin session (Bearer) or account secret key | vod: operate |  |

### `/api/publish-targets`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/publish-targets` | admin session (Bearer) or account secret key | settings: view |  |
| POST | `/api/publish-targets` | admin session (Bearer) or account secret key | settings: manage |  |
| DELETE | `/api/publish-targets/:id` | admin session (Bearer) or account secret key | settings: manage |  |
| GET | `/api/publish-targets/:id` | admin session (Bearer) or account secret key | settings: view |  |
| PATCH | `/api/publish-targets/:id` | admin session (Bearer) or account secret key | settings: manage |  |

### `/api/publishing-rules`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/publishing-rules` | admin session (Bearer) or account secret key | settings: view |  |
| DELETE | `/api/publishing-rules/:scopeKind/:scopeId?` | admin session (Bearer) or account secret key | settings: manage |  |
| GET | `/api/publishing-rules/:scopeKind/:scopeId?` | admin session (Bearer) or account secret key | settings: view |  |
| PUT | `/api/publishing-rules/:scopeKind/:scopeId?` | admin session (Bearer) or account secret key | settings: manage |  |
| GET | `/api/publishing-rules/points` | admin session (Bearer) or account secret key | settings: view |  |
| GET | `/api/publishing-rules/resolve` | admin session (Bearer) or account secret key | settings: view |  |

### `/api/radio`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/radio` | admin session (Bearer) or account secret key | radio: view |  |
| GET | `/api/radio/:id` | admin session (Bearer) or account secret key | radio: view |  |
| POST | `/api/radio/:id/air` | admin session (Bearer) or account secret key | radio: operate |  |
| POST | `/api/radio/:id/auto-connect` | admin session (Bearer) or account secret key | radio: operate |  |
| POST | `/api/radio/:id/clear-recovery` | admin session (Bearer) or account secret key | radio: operate |  |
| DELETE | `/api/radio/:id/events` | admin session (Bearer) or account secret key | radio: manage |  |
| GET | `/api/radio/:id/events` | admin session (Bearer) or account secret key | radio: view |  |
| GET | `/api/radio/:id/levels` | admin session (Bearer) or account secret key | radio: view |  |
| GET | `/api/radio/:id/log` | admin session (Bearer) or account secret key | radio: view |  |
| GET | `/api/radio/:id/nowplaying` | admin session (Bearer) or account secret key | radio: view |  |
| GET | `/api/radio/:id/qc` | admin session (Bearer) or account secret key | radio: view |  |
| POST | `/api/radio/:id/start` | admin session (Bearer) or account secret key | radio: operate |  |
| POST | `/api/radio/:id/stop` | admin session (Bearer) or account secret key | radio: operate |  |
| POST | `/api/radio/probe` | admin session (Bearer) or account secret key | radio: operate |  |

### `/api/recordings`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/recordings` | admin session (Bearer) or account secret key | recordings: view |  |
| GET | `/api/recordings/:id` | admin session (Bearer) or account secret key | recordings: view |  |
| POST | `/api/recordings/:id/clip` | admin session (Bearer) or account secret key | recordings: manage |  |
| GET | `/api/recordings/:id/derived` | admin session (Bearer) or account secret key | recordings: view |  |
| GET | `/api/recordings/:id/download` | admin session (Bearer) or account secret key | recordings: view |  |
| GET | `/api/recordings/:id/programmes` | admin session (Bearer) or account secret key | recordings: view |  |
| POST | `/api/recordings/:id/publish` | admin session (Bearer) or account secret key | recordings: operate |  |
| GET | `/api/recordings/:id/range/:kind(video\|audio).m3u8` | admin session (Bearer) or account secret key | recordings: view |  |
| GET | `/api/recordings/:id/range/master.m3u8` | admin session (Bearer) or account secret key | recordings: view |  |
| GET | `/api/recordings/:id/timeline` | admin session (Bearer) or account secret key | recordings: view |  |
| GET | `/api/recordings/:id/transcript` | admin session (Bearer) or account secret key | recordings: view |  |
| GET | `/api/recordings/:id/waveform` | admin session (Bearer) or account secret key | recordings: view |  |
| GET | `/api/recordings/channels` | admin session (Bearer) or account secret key | recordings: view |  |
| POST | `/api/recordings/compose-clip` | admin session (Bearer) or account secret key | recordings: manage |  |
| GET | `/api/recordings/sources` | admin session (Bearer) or account secret key | recordings: view |  |

### `/api/reports`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/reports/stream/:id` | admin session (Bearer) or account secret key | analytics: view |  |
| GET | `/api/reports/streams` | admin session (Bearer) or account secret key | analytics: view |  |
| GET | `/api/reports/streams.csv` | admin session (Bearer) or account secret key | analytics: view |  |

### `/api/scheduled-clips`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/scheduled-clips` | admin session (Bearer) or account secret key | recordings: view |  |
| POST | `/api/scheduled-clips` | admin session (Bearer) or account secret key | recordings: manage |  |
| DELETE | `/api/scheduled-clips/:id` | admin session (Bearer) or account secret key | recordings: manage |  |
| GET | `/api/scheduled-clips/:id` | admin session (Bearer) or account secret key | recordings: view |  |

### `/api/search`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/search` | admin session (Bearer) or account secret key | any signed-in admin user |  |

### `/api/share-links`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/share-links` | admin session (Bearer) or account secret key | sharing: view |  |
| POST | `/api/share-links` | admin session (Bearer) or account secret key | sharing: manage |  |
| GET | `/api/share-links/:id` | admin session (Bearer) or account secret key | sharing: view |  |
| POST | `/api/share-links/:id/revoke` | admin session (Bearer) or account secret key | sharing: manage |  |

### `/api/social`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/social/accounts` | admin session (Bearer) or account secret key | vod: view |  |
| POST | `/api/social/connect/:platform` | admin session (Bearer) or account secret key | vod: manage |  |
| GET | `/api/social/platforms` | admin session (Bearer) or account secret key | vod: view |  |
| GET | `/api/social/publications` | admin session (Bearer) or account secret key | vod: view |  |
| POST | `/api/social/publications/:id/remove` | admin session (Bearer) or account secret key | vod: manage |  |
| POST | `/api/social/publications/:id/retry` | admin session (Bearer) or account secret key | vod: operate |  |
| POST | `/api/social/publish/:assetId` | admin session (Bearer) or account secret key | vod: operate |  |
| GET | `/api/social/publish/:assetId/defaults` | admin session (Bearer) or account secret key | vod: view |  |
| POST | `/api/social/sandbox/:platform` | admin session (Bearer) or account secret key | vod: manage |  |
| POST | `/api/social/sync-views` | admin session (Bearer) or account secret key | vod: manage |  |

### `/api/sources`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| POST | `/api/sources/hls` | admin session (Bearer) or account secret key | channels or radio or events: manage |  |
| POST | `/api/sources/probe` | admin session (Bearer) or account secret key | channels or radio or events: manage |  |

### `/api/status`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/status` | admin session (Bearer) or account secret key | monitoring: view |  |
| GET | `/api/status/:kind/:id` | admin session (Bearer) or account secret key | monitoring: view |  |
| GET | `/api/status/:kind/:id/events` | admin session (Bearer) or account secret key | monitoring: view |  |
| GET | `/api/status/stream` | admin session (Bearer, or ?ticket= for EventSource) | live status push, filtered by the features the user holds |  |

### `/api/storage`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/storage/capabilities` | admin session (Bearer) or account secret key | media: view |  |
| GET | `/api/storage/objects` | admin session (Bearer) or account secret key | media: view |  |
| GET | `/api/storage/objects/:id` | admin session (Bearer) or account secret key | media: view |  |
| POST | `/api/storage/objects/:id/hold` | admin session (Bearer) or account secret key | media: manage |  |
| POST | `/api/storage/objects/:id/restore` | admin session (Bearer) or account secret key | media: manage |  |
| POST | `/api/storage/reconcile` | admin session (Bearer) or account secret key | media: manage |  |
| GET | `/api/storage/retention` | admin session (Bearer) or account secret key | media: view |  |
| PUT | `/api/storage/retention` | admin session (Bearer) or account secret key | media: manage |  |
| GET | `/api/storage/retention/effective` | admin session (Bearer) or account secret key | media: view |  |
| POST | `/api/storage/retention/preview` | admin session (Bearer) or account secret key | media: manage |  |

### `/api/thumbnails`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| POST | `/api/thumbnails/build` | admin session (Bearer) or account secret key | operator tier or above |  |
| GET | `/api/thumbnails/recordings/:id.vtt` | admin session (Bearer) or account secret key | any signed-in admin user |  |
| GET | `/api/thumbnails/status` | admin session (Bearer) or account secret key | any signed-in admin user |  |
| GET | `/api/thumbnails/storyboard` | admin session (Bearer) or account secret key | any signed-in admin user |  |
| GET | `/api/thumbnails/vod/:id.vtt` | admin session (Bearer) or account secret key | any signed-in admin user |  |
| GET | `/api/thumbnails/vtt` | admin session (Bearer) or account secret key | any signed-in admin user |  |

### `/api/tickets`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/tickets` | admin session (Bearer) or account secret key | any signed-in admin user |  |
| POST | `/api/tickets` | admin session (Bearer) or account secret key | operator tier or above |  |
| GET | `/api/tickets/:id` | admin session (Bearer) or account secret key | any signed-in admin user |  |

### `/api/timeline`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/timeline/grid` | admin session (Bearer) or account secret key | monitoring: view |  |
| GET | `/api/timeline/selection` | admin session (Bearer) or account secret key | monitoring: view |  |

### `/api/tus`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| OPTIONS | `/api/tus` | admin session (Bearer), checked per request | media: manage (resumable upload, tus protocol) |  |
| POST | `/api/tus` | admin session (Bearer), checked per request | media: manage (resumable upload, tus protocol) |  |
| DELETE | `/api/tus/:id` | admin session (Bearer), checked per request | media: manage (resumable upload, tus protocol) |  |
| HEAD | `/api/tus/:id` | admin session (Bearer), checked per request | media: manage (resumable upload, tus protocol) |  |
| OPTIONS | `/api/tus/:id` | admin session (Bearer), checked per request | media: manage (resumable upload, tus protocol) |  |
| PATCH | `/api/tus/:id` | admin session (Bearer), checked per request | media: manage (resumable upload, tus protocol) |  |

### `/api/uploads`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/uploads` | admin session (Bearer) or account secret key | media: view |  |
| POST | `/api/uploads` | admin session (Bearer) or account secret key | media: manage |  |
| DELETE | `/api/uploads/:id` | admin session (Bearer) or account secret key | media: manage |  |
| GET | `/api/uploads/:id` | admin session (Bearer) or account secret key | media: view |  |
| PUT | `/api/uploads/:id/chunks/:index` | upload session token (Bearer) | the upload the token was issued for |  |
| POST | `/api/uploads/:id/finish` | upload session token (Bearer) | the upload the token was issued for |  |
| GET | `/api/uploads/:id/state` | upload session token (Bearer) | the upload the token was issued for |  |

### `/api/user-groups`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/user-groups` | admin session (Bearer) or account secret key | access or users: view |  |
| POST | `/api/user-groups` | admin session (Bearer) or account secret key | access: manage |  |
| DELETE | `/api/user-groups/:id` | admin session (Bearer) or account secret key | access: manage |  |
| PATCH | `/api/user-groups/:id` | admin session (Bearer) or account secret key | access: manage |  |
| POST | `/api/user-groups/:id/copy` | admin session (Bearer) or account secret key | access: manage |  |
| GET | `/api/user-groups/catalogue` | admin session (Bearer) or account secret key | access or users: view |  |

### `/api/users`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/users` | admin session (Bearer) or account secret key | users: view |  |
| POST | `/api/users` | admin session (Bearer) or account secret key | users: manage |  |
| DELETE | `/api/users/:id` | admin session (Bearer) or account secret key | users: manage |  |
| GET | `/api/users/:id` | admin session (Bearer) or account secret key | users: view |  |
| PATCH | `/api/users/:id` | admin session (Bearer) or account secret key | users: manage |  |
| DELETE | `/api/users/:id/invite` | admin session (Bearer) or account secret key | users: manage |  |
| POST | `/api/users/:id/invite` | admin session (Bearer) or account secret key | users: manage |  |
| POST | `/api/users/:id/mfa/reset` | admin session (Bearer) or account secret key | users: manage |  |
| POST | `/api/users/:id/password` | admin session (Bearer) or account secret key | users: manage |  |
| POST | `/api/users/invite` | admin session (Bearer) or account secret key | users: manage |  |
| GET | `/api/users/security-policy` | admin session (Bearer) or account secret key | users: view |  |
| PUT | `/api/users/security-policy` | admin session (Bearer) or account secret key | users: manage + admin tier |  |

### `/api/viewers`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/viewers` | admin session (Bearer) or account secret key | viewers: view |  |
| DELETE | `/api/viewers/:id` | admin session (Bearer) or account secret key | viewers: manage |  |
| GET | `/api/viewers/:id` | admin session (Bearer) or account secret key | viewers: view |  |
| PATCH | `/api/viewers/:id` | admin session (Bearer) or account secret key | viewers: manage |  |
| POST | `/api/viewers/:id/mfa/reset` | admin session (Bearer) or account secret key | viewers: manage |  |
| POST | `/api/viewers/:id/sign-out` | admin session (Bearer) or account secret key | viewers: operate |  |

### `/api/vod`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/vod` | admin session (Bearer) or account secret key | vod: view |  |
| DELETE | `/api/vod/:id` | admin session (Bearer) or account secret key | vod: manage |  |
| GET | `/api/vod/:id` | admin session (Bearer) or account secret key | vod: view |  |
| PUT | `/api/vod/:id` | admin session (Bearer) or account secret key | vod: manage |  |
| GET | `/api/vod/:id/availability` | admin session (Bearer) or account secret key | vod: view |  |
| PATCH | `/api/vod/:id/availability` | admin session (Bearer) or account secret key | vod: manage |  |
| GET | `/api/vod/:id/encode` | admin session (Bearer) or account secret key | vod: view |  |
| GET | `/api/vod/:id/epg-fill` | admin session (Bearer) or account secret key | vod: view |  |
| POST | `/api/vod/:id/epg-fill` | admin session (Bearer) or account secret key | vod: manage |  |
| GET | `/api/vod/:id/history` | admin session (Bearer) or account secret key | vod: view |  |
| GET | `/api/vod/:id/image` | admin session (Bearer) or account secret key | vod: view |  |
| PUT | `/api/vod/:id/image` | admin session (Bearer) or account secret key | vod: manage |  |
| POST | `/api/vod/:id/image/auto` | admin session (Bearer) or account secret key | vod: manage |  |
| GET | `/api/vod/:id/markers` | admin session (Bearer) or account secret key | vod: view |  |
| DELETE | `/api/vod/:id/markers/:kind` | admin session (Bearer) or account secret key | vod: manage |  |
| PUT | `/api/vod/:id/markers/:kind` | admin session (Bearer) or account secret key | vod: manage |  |
| POST | `/api/vod/:id/markers/:kind/accept` | admin session (Bearer) or account secret key | vod: manage |  |
| POST | `/api/vod/:id/markers/detect` | admin session (Bearer) or account secret key | vod: manage |  |
| GET | `/api/vod/:id/provenance` | admin session (Bearer) or account secret key | vod: view |  |
| POST | `/api/vod/:id/publish` | admin session (Bearer) or account secret key | vod: operate |  |
| POST | `/api/vod/:id/qc` | admin session (Bearer) or account secret key | vod: manage |  |
| GET | `/api/vod/:id/review` | admin session (Bearer) or account secret key | vod: view |  |
| POST | `/api/vod/:id/review` | admin session (Bearer) or account secret key | vod: manage |  |
| GET | `/api/vod/:id/schema.org` | admin session (Bearer) or account secret key | vod: view |  |
| DELETE | `/api/vod/:id/song/details` | admin session (Bearer) or account secret key | vod: manage |  |
| POST | `/api/vod/:id/song/find` | admin session (Bearer) or account secret key | vod: manage |  |
| POST | `/api/vod/:id/song/use` | admin session (Bearer) or account secret key | vod: manage |  |
| GET | `/api/vod/:id/target-metadata` | admin session (Bearer) or account secret key | vod: view |  |
| PATCH | `/api/vod/:id/trim` | admin session (Bearer) or account secret key | vod: manage |  |
| POST | `/api/vod/:id/withdraw` | admin session (Bearer) or account secret key | vod: operate |  |
| POST | `/api/vod/epg-fill` | admin session (Bearer) or account secret key | vod: manage |  |
| GET | `/api/vod/facets` | admin session (Bearer) or account secret key | vod: view |  |
| POST | `/api/vod/music-lookup` | admin session (Bearer) or account secret key | vod: manage |  |
| GET | `/api/vod/review/queue` | admin session (Bearer) or account secret key | vod: view |  |

### `/api/watchfolders`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/watchfolders` | admin session (Bearer) or account secret key | media: view |  |
| POST | `/api/watchfolders` | admin session (Bearer) or account secret key | media: manage |  |
| DELETE | `/api/watchfolders/:id` | admin session (Bearer) or account secret key | media: manage |  |
| GET | `/api/watchfolders/:id` | admin session (Bearer) or account secret key | media: view |  |
| PATCH | `/api/watchfolders/:id` | admin session (Bearer) or account secret key | media: manage |  |
| POST | `/api/watchfolders/:id/dry-run` | admin session (Bearer) or account secret key | media: operate |  |
| GET | `/api/watchfolders/:id/items` | admin session (Bearer) or account secret key | media: view |  |
| POST | `/api/watchfolders/:id/items/:itemId/resolve` | admin session (Bearer) or account secret key | media: manage |  |
| GET | `/api/watchfolders/:id/rules` | admin session (Bearer) or account secret key | media: view |  |
| POST | `/api/watchfolders/:id/rules` | admin session (Bearer) or account secret key | media: manage |  |
| DELETE | `/api/watchfolders/:id/rules/:ruleId` | admin session (Bearer) or account secret key | media: manage |  |
| PATCH | `/api/watchfolders/:id/rules/:ruleId` | admin session (Bearer) or account secret key | media: manage |  |
| POST | `/api/watchfolders/:id/scan` | admin session (Bearer) or account secret key | media: manage |  |

### `/api/workflows`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/workflows/events` | admin session (Bearer) or account secret key | settings: view |  |
| GET | `/api/workflows/map` | admin session (Bearer) or account secret key | settings: view |  |
| GET | `/api/workflows/runs` | admin session (Bearer) or account secret key | settings: view |  |
| POST | `/api/workflows/runs` | admin session (Bearer) or account secret key | settings: operate |  |
| GET | `/api/workflows/runs/:id` | admin session (Bearer) or account secret key | settings: view |  |
| POST | `/api/workflows/runs/:id/cancel` | admin session (Bearer) or account secret key | settings: operate |  |
| POST | `/api/workflows/runs/:id/retry` | admin session (Bearer) or account secret key | settings: operate |  |
| GET | `/api/workflows/trace` | admin session (Bearer) or account secret key | settings: view |  |

## Platform API

Volt staff only. Needs a platform session, minted after the authenticator step.

### `/api/platform/accounts`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/platform/accounts` | platform session (aud volt:platform, after TOTP) | platform_role (saas_admin / support as the route says) |  |
| POST | `/api/platform/accounts` | platform session (aud volt:platform, after TOTP) | platform_role (saas_admin / support as the route says) |  |
| PATCH | `/api/platform/accounts/:id` | platform session (aud volt:platform, after TOTP) | platform_role (saas_admin / support as the route says) |  |
| GET | `/api/platform/accounts/:id/groups` | platform session (aud volt:platform, after TOTP) | platform_role (saas_admin / support as the route says) |  |
| POST | `/api/platform/accounts/:id/groups` | platform session (aud volt:platform, after TOTP) | platform_role (saas_admin / support as the route says) |  |
| DELETE | `/api/platform/accounts/:id/groups/:gid` | platform session (aud volt:platform, after TOTP) | platform_role (saas_admin / support as the route says) |  |
| PATCH | `/api/platform/accounts/:id/groups/:gid` | platform session (aud volt:platform, after TOTP) | platform_role (saas_admin / support as the route says) |  |

### `/api/platform/auth`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| POST | `/api/platform/auth/step-up` | admin session (Bearer) | platform staff |  |

### `/api/platform/costs`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| PUT | `/api/platform/costs/actuals` | platform session (aud volt:platform, after TOTP) | platform_role (saas_admin / support as the route says) |  |
| GET | `/api/platform/costs/comparison` | platform session (aud volt:platform, after TOTP) | platform_role (saas_admin / support as the route says) |  |

### `/api/platform/fleet-plan`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/platform/fleet-plan` | platform session (aud volt:platform, after TOTP) | platform_role (saas_admin / support as the route says) |  |
| GET | `/api/platform/fleet-plan/hosts` | platform session (aud volt:platform, after TOTP) | platform_role (saas_admin / support as the route says) |  |
| GET | `/api/platform/fleet-plan/stream/:id` | platform session (aud volt:platform, after TOTP) | platform_role (saas_admin / support as the route says) |  |

### `/api/platform/impersonate`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| POST | `/api/platform/impersonate/:accountId` | platform session (aud volt:platform, after TOTP) | platform_role (saas_admin / support as the route says) |  |

### `/api/platform/overview`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/platform/overview` | platform session (aud volt:platform, after TOTP) | platform_role (saas_admin / support as the route says) |  |

### `/api/platform/relays`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/platform/relays` | platform session (aud volt:platform, after TOTP) | platform_role (saas_admin / support as the route says) |  |
| POST | `/api/platform/relays` | platform session (aud volt:platform, after TOTP) | platform_role (saas_admin / support as the route says) |  |
| PATCH | `/api/platform/relays/:id` | platform session (aud volt:platform, after TOTP) | platform_role (saas_admin / support as the route says) |  |
| GET | `/api/platform/relays/:id/stations` | platform session (aud volt:platform, after TOTP) | platform_role (saas_admin / support as the route says) |  |

### `/api/platform/signups`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/platform/signups` | platform session (aud volt:platform, after TOTP) | platform_role (saas_admin / support as the route says) |  |
| POST | `/api/platform/signups/:id/invite` | platform session (aud volt:platform, after TOTP) | platform_role (saas_admin / support as the route says) |  |

### `/api/platform/tickets`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/platform/tickets` | platform session (aud volt:platform, after TOTP) | platform_role (saas_admin / support as the route says) |  |
| PATCH | `/api/platform/tickets/:id` | platform session (aud volt:platform, after TOTP) | platform_role (saas_admin / support as the route says) |  |

## Machine-to-machine

Encoders, engines, add-ons, payment providers. Each has its own secret.

### `/api/addon-callbacks`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| POST | `/api/addon-callbacks/runs/:id` | add-on run token | callback |  |

### `/api/engine-hooks`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| POST | `/api/engine-hooks/:engineId` | engine callback signature | callback |  |

### `/api/fast-playout`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| POST | `/api/fast-playout/:id/heartbeat` | X-Volt-Ingest-Token | encoder / thumbnailer report |  |
| GET | `/api/fast-playout/:id/state` | X-Volt-Ingest-Token | encoder / thumbnailer report |  |
| GET | `/api/fast-playout/:id/timeline` | X-Volt-Ingest-Token | encoder / thumbnailer report |  |

### `/api/ingest`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| POST | `/api/ingest/transfers/:id/events` | transfer provider callback (checked per provider) | callback |  |

### `/api/media`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| POST | `/api/media/thumbnails` | X-Volt-Ingest-Token | encoder / thumbnailer report |  |

### `/api/payments`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| POST | `/api/payments/webhooks/:provider/:accountId` | payment provider signature | callback |  |

### `/api/radio`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| POST | `/api/radio/icecast/listener-auth` | Icecast auth callback secret | callback |  |
| POST | `/api/radio/icecast/listener-remove` | Icecast auth callback secret | callback |  |

### `/api/social`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/social/callback/:platform` | OAuth redirect (state parameter) | callback |  |

### `/api/streams`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/streams/:id/burn-graphics` | X-Volt-Ingest-Token | encoder / thumbnailer report |  |
| POST | `/api/streams/:id/report` | X-Volt-Ingest-Token | encoder / thumbnailer report |  |
| GET | `/api/streams/:id/timed-events` | X-Volt-Ingest-Token | encoder / thumbnailer report |  |

## Delivery and previews (outside /api)

Streams, images, share pages and players. The admin console web app is also served from `/` when its bundle is built (it signs in through the admin API).

### `/channel`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/channel/:id/v/:key/:file` | none, share token or playback token | public delivery | ✓ |

### `/event`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/event/:id/v/:key/:file` | none, share token or playback token | public delivery | ✓ |

### `/fast`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/fast/:id/s/:sid/:file` | none, share token or playback token | public delivery | ✓ |

### `/gfx`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/gfx/:versionId/*` | none, share token or playback token | public delivery | ✓ |

### `/img`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/img/*` | none, share token or playback token | public delivery | ✓ |
| HEAD | `/img/*` | none, share token or playback token | public delivery | ✓ |

### `/library`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/library/*` | none, share token or playback token | public delivery | ✓ |

### `/live`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/live/:id/:file(master.m3u8\|manifest.mpd)` | none, share token or playback token | public delivery | ✓ |
| GET | `/live/:id/stream.mp3` | none, share token or playback token | public delivery | ✓ |
| GET | `/live/:id/v/:key/:file` | none, share token or playback token | public delivery | ✓ |

### `/radio`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/radio/:id/stream.mp3` | admin session or internal | preview / internal |  |

### `/share`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/share/:token` | none, share token or playback token | public delivery | ✓ |

### `/social-sandbox`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/social-sandbox/:id` | admin session or internal | preview / internal |  |

### `/xmltv`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/xmltv/:file` | none, share token or playback token | public delivery | ✓ |

## Health and discovery

### `/api`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api` | none | Hydra service document |  |

### `/api/caption-languages`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/caption-languages` | none | reference data for forms |  |

### `/api/context.jsonld`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/context.jsonld` | none | Hydra service document |  |

### `/api/doc`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/doc` | none | Hydra service document |  |

### `/api/ingest-protocols`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/api/ingest-protocols` | none | reference data for forms |  |

### `/health`

| Method | Path | Credential | Access | Viewer tier |
|---|---|---|---|---|
| GET | `/health` | none | liveness / readiness | ✓ |
| GET | `/health/live` | none | liveness / readiness | ✓ |
| GET | `/health/ready` | none | liveness / readiness | ✓ |

