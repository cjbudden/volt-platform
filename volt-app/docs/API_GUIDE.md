# Volt API: usage guide

How to call the Volt API: which API to use, which credential it takes, how sign-in works (including two-step sign-in), what access each call needs and what the errors mean.

| Document | What it is |
|---|---|
| This guide | How to use the API |
| [API_ROUTES.md](API_ROUTES.md) | Every route, with its credential and the feature and level it needs. Generated from the running app. |
| [API.md](API.md) | Request by request, with parameters and a real example response for each. Generated from a live run. |
| `api/Volt.postman_collection.json` + `api/Volt.postman_environment.json` | The same requests in Postman, runnable in order |
| [api-playground.html](api-playground.html) | Searchable page of the same requests, filterable by API |
| [ACCESS_CONTROL.md](../../ACCESS_CONTROL.md) | The access model behind all of this: roles, rules, security |

## 1. Three APIs

| API | Base path | For | Credential | Token audience | Served by |
|---|---|---|---|---|---|
| **Public** | `/api/public/*` | Apps, players and the audience (public users) | App publishable key (`pk_…`), plus a public user session when signed in | `volt:viewer` | Viewer tier (`ROLE=api-public`), scales out, edge cached where safe |
| **Admin** | `/api/*` | A client's staff (admin users) and the client's servers | Admin session, or the account secret key (`sk_live_…`) | `volt:admin` | Admin tier (`ROLE=api-admin`) |
| **Platform** | `/api/platform/*` | Volt staff | Platform session, only after the authenticator step | `volt:platform` | Admin tier |

**The APIs never accept each other's credentials:**
- **Public user sessions:** signed with a different key (`VIEWER_JWT_SECRET`), so they fail on the admin and platform APIs with `401`.
- **Admin sessions:** the public account routes (`/api/public/me/*`) refuse them with `401`.
- **Platform API:** accepts only a platform session. A password-only admin session gets `403 platform_mfa_required`.
- **Sign-in challenges:** a challenge token from a sign-in in progress is accepted nowhere as a session.

**Legacy aliases:** `/api/availability`, `/api/access/check`, `/api/player/*`, `/api/analytics/beacon` and `/api/payments/verify` still work, as aliases of the same `/api/public/*` routes. New code should use `/api/public/*`.

**Machine routes:** encoders, engines, add-ons and payment providers call their own routes with their own secrets (`X-Volt-Ingest-Token`, signatures). These are listed in API_ROUTES.md under Machine-to-machine.

## 2. Credentials and how to send them

| Credential | Looks like | Where it comes from | How to send it | Lifetime |
|---|---|---|---|---|
| Publishable key | `pk_live_…` / `pk_test_…` | `POST /api/apps` (shown once), one per app | `appKey` in the body or query string | Until rotated or revoked |
| Public user session | JWT | `POST /api/public/auth/login`, `/register`, `/mfa/challenge/verify`, `/token-exchange` | `Authorization: Bearer …` | 15 minutes (`VIEWER_ACCESS_TTL`) |
| Public user refresh token | `vr_…` | Same responses | Body of `/api/public/auth/refresh` | 60 days, rotates on every use |
| Admin session | JWT | `POST /api/auth/login`, `/mfa/challenge/verify` | `Authorization: Bearer …` | 15 minutes (`ACCESS_TTL`) |
| Admin refresh token | random string | Same responses | Body of `/api/auth/refresh` | 14 days from sign-in, rotates without extending |
| Account secret key | `sk_live_…` | `POST /api/apps/secret-keys` (admin tier, shown once) | `Authorization: Bearer sk_live_…` | Until revoked |
| Platform session | JWT | `POST /api/platform/auth/mfa` or `/step-up` | `Authorization: Bearer …` | 1 hour (`PLATFORM_SESSION_TTL`) |
| Playback token | JWT | The play gate (`/api/public/availability`) | Player URL / beacon | Minutes |
| Sign-in challenge | JWT | A sign-in response when a second step is due | `challenge` in the body | 10 minutes, one session |

**Rules for credentials:**
- **Secret keys:** never put a secret key in an app. It is for the client's own servers: server-to-server admin calls and token exchange.
- **Request bodies:** never send identity or entitlements in a public request body. The public user's session decides who they are, what groups they are in and what they have paid for. The body fields `viewer` and `entitled` are ignored unless the app has `restrictions.trustAssertedViewer`, which is meant for a client whose own server already checked.

## 3. Quick start

**Admin: sign in and list channels.**
```bash
B=http://localhost:8080
T=$(curl -s -X POST $B/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@volt.test","password":"VoltTest!2026"}' | jq -r .access)
curl -s $B/api/channels -H "authorization: Bearer $T"
```

**Public: a public user signs in through an app and asks to play.**
```bash
PK=pk_test_...   # from POST /api/apps, or printed by npm run seed:access
V=$(curl -s -X POST $B/api/public/auth/login -H 'content-type: application/json' \
  -d "{\"appKey\":\"$PK\",\"email\":\"fan@volt.test\",\"password\":\"VoltTest!2026\"}" | jq -r .access)
curl -s -X POST $B/api/public/availability -H "authorization: Bearer $V" -H 'content-type: application/json' \
  -d "{\"appKey\":\"$PK\",\"assetId\":\"<channel, event or VOD id>\"}"
```

**Client server: vouch for a member from your own sign-in system.**
```bash
curl -s -X POST $B/api/public/auth/token-exchange -H "authorization: Bearer $SECRET_KEY" -H 'content-type: application/json' \
  -d '{"externalId":"crm-123","email":"member@club.example","groups":["members"]}'
# -> {viewer, access, refresh}: hand access and refresh to your app
```

**Test users:** `npm run seed:access` creates them (password `VoltTest!2026`) and prints a publishable key. `SEED_PLATFORM_STAFF=1` adds `staff@volt.test`. ACCESS_CONTROL.md section 10 has the list.

## 4. Signing in

### Admin users

`POST /api/auth/login {email, password}` answers in one of three ways:

| Answer | When | Next |
|---|---|---|
| `{access, refresh, expiresIn, amr:["pwd"]}` | No second step is due | Use `access` |
| `{mfaRequired:true, challenge, methods, email, phone}` | The user has two-step sign-in on. `email` and `phone` are masked. `methods` is any of `totp`, `email`, `sms`, `backup`. | For `email` or `sms`: `POST /api/auth/mfa/challenge/send {challenge, method}`. Then `POST /api/auth/mfa/challenge/verify {challenge, method, code}` returns the session. |
| `{mfaSetupRequired:true, challenge, available, email}` | The account requires two-step sign-in and this user has no method yet | Set one up with the challenge: `POST /api/auth/mfa/{totp\|email\|sms}/start {challenge}`, then `/confirm {challenge, code}`. The confirm returns the session and 10 backup codes. |

**Session behaviour:**
- **`amr`:** the session records how it was signed in (RFC 8176), for example `["pwd","mfa","otp"]`.
- **Refresh:** `POST /api/auth/refresh {refresh}` returns a new pair. The refresh token rotates, and sessions end 14 days after sign-in whatever the activity.
- **Policy switched on mid-session:** if the account switched on "require two-step sign-in" and this session did not use it, refresh answers `401` with code `mfa_required`. The user signs in again and is taken through set-up.
- **Sign out:** `POST /api/auth/logout {refresh}` revokes the refresh token.
- **Rate limits:** sign-in allows 10 tries per email and 50 per address in 5 minutes. Past that it answers `429 rate_limited`.

### Public users

The flow is the same, under `/api/public/auth/*`, with the app's `appKey` in the body:

- `POST /api/public/auth/register {appKey, email, password, displayName?}`: creates a public user in the app's client account and signs them in. The answer does not reveal whether the email already had an account.
- `POST /api/public/auth/login {appKey, email, password}`: answers `{viewer, access, refresh, expiresIn}`, or `{mfaRequired, challenge, methods}` when they turned two-step sign-in on.
- `POST /api/public/auth/mfa/challenge/send` and `/verify`: the same as for admin users.
- `POST /api/public/auth/refresh {refresh}`: rotates. A reused refresh token is refused.
- `POST /api/public/auth/password-reset {appKey, email}`: emails a 6-digit code (15 minutes). Then `/password-reset/confirm {appKey, email, code, password}`, which ends every session.
- `POST /api/public/auth/logout {refresh}`.

The public user's access token carries their groups and an entitlement snapshot, so the play gate can decide without a database read. A purchase made after the token was issued is still honoured: on a refusal the gate re-checks live entitlements. Disabling a public user, a password change or "sign out everywhere" ends their tokens at once on every API process.

### Platform staff

1. `POST /api/platform/auth/login {email, password}` returns `{enroll, secret, otpauthUri, mfaToken}` the first time (set up the authenticator app), or `{mfa_required, mfaToken}` after that.
2. `POST /api/platform/auth/mfa {mfaToken, code}` returns `{accessToken}`, the platform session.

From the admin console, `POST /api/platform/auth/step-up {code}` (with the admin session) gives a platform session without signing in again. Platform staff with an authenticator also get it as their second step in the console.

## 5. Email, mobile number and two-step sign-in

The routes are the same for both kinds of user:
- **Admin users:** under `/api/auth/`.
- **Public users:** under `/api/public/me/`, except the sign-in challenge, which is under `/api/public/auth/`.

| Route | Body | Notes |
|---|---|---|
| `GET …/security` | | Email and mobile (verified or not), methods on, backup codes left, whether the account requires it |
| `POST …/email/change` | `newEmail, password` | Code to the NEW address. Nothing changes yet. |
| `POST …/email/change/confirm` | `code` | Changes and verifies the email. A notice goes to the old address. |
| `POST …/email/verify` → `/confirm` | `code` | Verify the current address |
| `POST …/phone` → `/confirm` | `phone` (E.164, e.g. `+61412345678`), `password`, then `code` | Texted code |
| `DELETE …/phone` | `password` | Also turns off text codes |
| `POST …/mfa/totp/start` | `password` (or `challenge` during required set-up) | Returns `secret` and `otpauthUri` (draw it as a QR code) |
| `POST …/mfa/totp/confirm` | `code` | The first method on returns `backupCodes` (10, shown once) |
| `POST …/mfa/email/start` → `/confirm` | `password`, then `code` | Also verifies the email |
| `POST …/mfa/sms/start` → `/confirm` | `password`, `phone?`, then `code` | Also verifies the number |
| `DELETE …/mfa/{totp\|email\|sms}` | `password` | Refused for the last method while the account requires it |
| `POST …/mfa/backup-codes` | `password` | 10 new codes. The old ones stop working. |

Admins manage the policy and lockouts:
- `GET` / `PUT /api/users/security-policy {requireAdminMfa}`: needs `users:manage` and the admin tier.
- `POST /api/users/:id/mfa/reset`: an admin user who lost their phone.
- `POST /api/viewers/:id/mfa/reset`: the same for a public user.

**Codes:**
- **Format and lifetime:** 6 digits, single use, 10 minutes. 5 wrong guesses and the code is dead.
- **Sends:** limited to 10 per person and per destination per 15 minutes.
- **Test servers:** started with `SECURITY_CODE_ECHO=1` (never in production), every response that sends a code also returns it as `devCode`, so tests and Postman can finish the flow.

## 6. Admin access: features and levels

Every admin route belongs to a **feature** (channels, radio, events, epg, recordings, vod, media, analytics, users, access, viewers, apps, payments, settings and so on). A user's roles give each feature one of four levels:

| Level | Allows |
|---|---|
| `none` | Nothing. The feature is hidden in the console. |
| `view` | GET |
| `operate` | Run things without changing their settings: start, stop, put on air, publish, retry. Each feature lists what operate means. |
| `manage` | Everything, including create, edit and delete |

**Working with levels:**
- **Find a route's level:** API_ROUTES.md shows, for every admin route, the feature and level it needs. For example, `POST /api/channels/:id/start` needs `channels: operate`, or `radio: operate` when the channel is a station.
- **Find a user's levels:** `GET /api/auth/me` returns the user's effective level per feature (`permissions`) and the catalogue. Build menus and buttons from it.
- **When a level is missing:** the API answers:
  ```json
  { "error": "Your role does not allow manage on Admin users", "code": "forbidden_feature", "feature": "users", "level": "manage" }
  ```
- **Lookups:** a few lookups that forms need (groups, output profiles, engines, encode profiles, add-ons, metadata schemas) are readable by every admin user.
- **Secret keys:** an account secret key has full admin access to its account.

**Users and roles:**
- **Users:** `/api/users` (feature `users`).
- **Roles:** `/api/access-roles` (feature `access`). `/api/user-groups` is the same router.
- **No escalation:** the API refuses any change that would give someone access the person making it does not hold, feature by feature. Nobody changes their own access, and the last owner cannot be removed.

## 7. The public API in detail

| Route | Credential | Body / query | Answer |
|---|---|---|---|
| `GET /api/public/availability` | none | `appKey, assetId, geo?` (query) | `{available, mode, assetId, playbackToken, expiresIn, delivery}` or why not. Edge cached per app, asset and country. |
| `POST /api/public/availability` | public user session (optional) | `appKey, assetId, geo?` | Same, decided with the public user's groups and entitlements. Never edge cached when signed in. |
| `POST /api/public/access/check` | none | `appKey, assetId` | Booleans for catalogue screens, no token |
| `POST /api/public/player/session`, `/events`, `/now-playing` | publishable key or player token | | Embedded player handshake and telemetry |
| `POST /api/public/analytics/beacon` | playback token | | Playback beacons (batched) |
| `POST /api/public/payments/verify` | publishable key + public user | | App store or provider receipt verification |
| `GET` / `PATCH /api/public/me` | public user session | `displayName?, avatarRef?, profile?` | Profile. Groups and entitlements are not editable. |
| `POST /api/public/me/password` | public user session | `current, next` | Ends every session |
| `GET /api/public/me/entitlements`, `/purchases`, `/sessions` | public user session | | |
| `POST /api/public/me/sign-out-everywhere` | public user session | | |
| `DELETE /api/public/me` | public user session | `password` | Deletes the account: personal data scrubbed, purchases kept |

**Asset IDs:** `assetId` is a channel, event or VOD asset id. The gate applies the asset's publishing rules, geo, schedule windows and access rules (ACCESS_CONTROL.md section 6).

**App restrictions:** an app's `restrictions` (allowed web origins, bundle ids, IP ranges) are checked on every public call that names it.

### Image URLs

Library images are served resized, cropped and filtered by URL, through the
image service: `GET /img/{signature}/{W}x{H},{fit}[,options]/library/{accountId}/{path}`.
Render URLs need no token, but every one must be **signed**, so only URLs your
account minted are rendered. Get them from `POST /api/images/sign` (admin
session or secret key), or sign locally with the account's key from
`GET /api/images/signing-key` and the `@volt/image-url` package. The URLs never
expire and are cached for a year at the CDN. Every option, limit and example:
[IMAGES.md](IMAGES.md).

Library search (`GET /api/files?q=...`, `/api/files/search`) covers names, tags and the metadata
read from each upload (place, GPS, camera, date taken, title, keywords), with filters for source,
channel, time and distance: [IMAGES.md](IMAGES.md) section 17. Encoder thumbnails, sprite sheets and
hover or clip VTTs are under `/api/thumbnails/*`: [THUMBNAILS.md](THUMBNAILS.md).
The account's audit log (every delete, including refused ones) is `/api/audit` for administrators, and
deleting a channel is admin-only with `GET /api/channels/:id/delete-impact` first: [AUDIT_LOG.md](AUDIT_LOG.md).

## 8. Errors

Errors are JSON: `{error, code?, …}`.

| Status | `code` | Meaning |
|---|---|---|
| 400 | | Bad request. The message says what to fix. |
| 400 | `invalid_code` | A wrong or expired one-time code. Never 401, so the session survives a typo. |
| 401 | | No credential, an expired or wrong session, or a sign-in challenge used as a session. Refresh, or sign in again. |
| 401 | `mfa_required` | On refresh: the account now requires two-step sign-in. Sign in again. |
| 403 | `forbidden_feature` | The user's roles do not give `feature` at `level` |
| 403 | `platform_mfa_required` | The platform API needs a platform session: step up with the authenticator code |
| 403 | `reauth_failed` | The current password was wrong on a re-authenticated change. The session is kept. |
| 404 | | Not found, or not in your account. Accounts never see each other's ids. On the viewer tier, any non-public path answers 404. |
| 409 | e.g. `no_media` | The request conflicts with the state of the world. The body says why (for example, the gaps in a recording). |
| 422 | `ValidationError` | The body or query does not match the schema. `error` names the fields in a sentence ("Check these fields: name: Required"); `details` lists each issue. |
| 429 | `rate_limited` | Too many tries (sign-in, codes, refresh). Wait and try again. |

## 9. Conventions

- **JSON:** request and response bodies are JSON (`Content-Type: application/json`), except uploads (tus), media and delivery routes.
- **Ids:** UUIDs.
- **Times:** ISO 8601 UTC in bodies (`2027-01-01T10:00:00Z`). Timeline positions are epoch milliseconds (`startMs`, `start_epoch_ms`).
- **Lists:** most return an array. Searchable lists (for example `/api/viewers`) take `q`, `limit` (max 200) and `offset`, and return `{total, items}`.
- **Hypermedia:** send `Accept: application/ld+json` on a GET for the JSON-LD/Hydra form with links (`GET /api` is the entry point). Plain JSON is unchanged.
- **Multi-tenancy:** every admin credential resolves to one account, and every query is scoped to it.

## 10. Keeping the docs and Postman current

| Command | What it does |
|---|---|
| `npm run docs:routes` | Rewrites API_ROUTES.md and api-routes.json from the running app. `-- --check` fails if they are out of date (test/docs.check.sh runs it). |
| `DATABASE_URL=postgres://…/volt_capture ./api/capture_api.sh` | Throwaway database, seed, server, then runs every request and rewrites the Postman collection and environment, API.md and the playground |
| `DATABASE_URL=postgres://…/volt_verify ./api/verify.sh` | Runs the Postman collection end to end with Newman against a fresh server |

**Adding an endpoint:**
1. Follow the checklist in ACCESS_CONTROL.md section 9.
2. Run `npm run docs:routes`.
3. If it is something clients will call, add a step to `api/build.ts` (folder, body, `params`, a sentence of description, and `save` for any id later steps need).
4. Run `capture_api.sh`.

**Postman notes:**
- **Variables between requests:** the collection saves tokens, ids and codes into the environment as it goes, so run the folders in order.
- **Authenticator codes:** worked out by a pre-request script from the saved secret.
- **Emailed and texted codes:** come from `devCode` on a test server. Elsewhere, set `{{code}}` from the email or text.
- **Image service:** runs like every other folder: it uploads a small image, signs it and renders it. The signed render needs no token.
