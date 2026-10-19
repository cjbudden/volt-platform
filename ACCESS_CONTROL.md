# Volt access control: who can see and do what

This guide covers the access model: the three kinds of users, the split between the public and admin APIs, admin roles and permissions, public user accounts, and who can watch what content. It also covers how all of this stays fast at a million viewers, and the checklist for building any new feature so that it honours the rules.

The API decides every request. The admin console mirrors the same rules so that nobody is offered something the API would refuse, but the console is never the thing that enforces them.

## 1. Three kinds of user, kept apart

| | Platform staff | Client admin users | Public users (viewers) |
|---|---|---|---|
| Who | Volt / SaaS operator staff | A client's own staff | A client's audience |
| Scope | Every client account | One account | One account |
| Stored in | `users` with `platform_role` | `users` | `viewers` |
| Signs in at | `/api/auth/login`, then the authenticator code (`/api/platform/auth/mfa` or `/step-up`) | `/api/auth/login` | `/api/public/auth/login`, or the client's own sign-in plus token exchange |
| Token audience (`aud`) | `volt:platform` | `volt:admin` | `volt:viewer` |
| Signing key | `JWT_ACCESS_SECRET` | `JWT_ACCESS_SECRET` | `VIEWER_JWT_SECRET` (a separate key) |
| API | `/api/platform/*` | `/api/*` (admin) | `/api/public/*` |

Anonymous visitors (not signed in) can use only the public API, and only with an app's publishable key.

**Tokens never cross:**
- **Viewer tokens:** signed with a different key, so they cannot verify on the admin or platform API.
- **Platform API:** accepts only a `volt:platform` session, which exists only after the authenticator step. A password-only admin session gets `403 platform_mfa_required`, even for a user who has a platform role. (Before this change it was let through, which meant MFA could be skipped.)
- **Admin API:** accepts admin and platform sessions, plus the account secret key (`sk_live_…`) for server-to-server use.

## 2. The public API and the admin API

| Path | Who | Notes |
|---|---|---|
| `/api/public/auth/*` | anyone with a publishable key | Viewer register, login, refresh, logout, password reset, and token exchange (secret key) |
| `/api/public/me/*` | a signed-in viewer | Their own profile, password, entitlements, purchases, sessions, and deleting their account |
| `/api/public/availability` | anonymous or viewer | The play gate. `GET` is anonymous and cached at the edge; `POST` is for any viewer |
| `/api/public/access/check` | anonymous or viewer | Yes/no access answers, without issuing a token |
| `/api/public/player/*` | anonymous | Embedded player handshake and telemetry |
| `/api/public/analytics/beacon` | holder of a playback token | Playback beacons |
| `/api/public/payments/verify` | app key | Receipt verification |
| `/api/*` (everything else) | admin session or account secret key | Checked by the role catalogue below |
| `/api/platform/*` | platform session | Cross-tenant |

The older public paths (`/api/availability`, `/api/access`, `/api/player`, `/api/analytics/beacon`, `/api/payments/verify`) are aliases of the same handlers and keep working.

**Deployment:** the `api-public` service (`ROLE=api-public`) serves only public paths and answers 404 for everything else, including every admin path. The same split is configured in the staging nginx (`deploy/staging/nginx.conf.template`), the ALB rules (`deploy/terraform/scaling_alb.tf`) and CloudFront (`deploy/terraform/scaling_edge.tf`).

## 3. Admin users: tiers, roles, features and levels

### Tier (`users.role`)
`owner > admin > operator > viewer`
- **Owner and admin:** full access to everything in the account. Only an owner can make or unmake another owner. Account secret keys can only be created by the admin tier, because a secret key has full access.
- **Operator:** access comes only from the user's roles.
- **Viewer:** the same as operator, but every level is capped at `view`.

A user's tier follows their roles: the Administrator role makes them `admin`, System Viewer makes them `viewer`, and any other role makes them `operator`.

### Roles (`user_groups`)
A role is a named set of levels, one per feature. A user can hold several roles, and gets the **highest** level any of them grants for each feature. The default (system) roles are the same in every account and are read-only. To make a variation, copy one and edit the copy.

### Levels
| Level | Means |
|---|---|
| `none` | The section is hidden and the API refuses it |
| `view` | Lists and detail pages |
| `operate` | Running things: start/stop, on/off air, auto connect, publish, retry |
| `manage` | Create, edit and delete, plus everything `operate` allows |

### Features (the catalogue, `volt-app/src/auth/roles.ts`)
| Feature | Label | API prefixes | `operate` covers |
|---|---|---|---|
| `monitoring` | Live & monitoring | `/api/status`, `/api/monitoring` | |
| `channels` | TV channels | `/api/channels` (TV), `/api/daypart-presets` | start, stop, air, auto-connect, test-stream, failover-test |
| `radio` | Radio stations | `/api/radio`, and `/api/channels/:id` when the channel is a radio station | start, stop, air, auto-connect, clear-recovery, probe |
| `events` | Events | `/api/events` | start, stop, auto-connect |
| `epg` | EPG & schedules | `/api/epg` | XMLTV import run and test |
| `recordings` | Recordings & clips | `/api/recordings`, `/api/scheduled-clips` | publish |
| `vod` | Media library & publishing | `/api/vod`, `/api/publications`, `/api/social` | publish, withdraw, social publish and retry |
| `media` | Files, uploads & storage | `/api/files`, `/api/filler-assets`, `/api/uploads`, `/api/tus`, `/api/watchfolders`, `/api/storage`, `/api/jobs` | job retry and cancel, watchfolder dry run |
| `sharing` | Share links | `/api/share-links` | |
| `analytics` | Analytics & reports | `/api/analytics` | |
| `fleet` | Fleet & usage | `/api/fleet` | |
| `users` | Admin users | `/api/users` | |
| `access` | Roles & access | `/api/access-roles`, `/api/user-groups` (users with `users:view` may also read them, to assign roles) | |
| `viewers` | Public users | `/api/viewers` | sign out everywhere |
| `apps` | Apps, API keys & players | `/api/apps`, `/api/player-config` | |
| `payments` | Payments & products | `/api/payments` | |
| `settings` | Account settings | `/api/groups`, `/api/output-profiles`, `/api/metadata-schemas`, `/api/notification-templates`, `/api/publish-targets`, `/api/engines`, `/api/addons`, `/api/workflows`, `/api/encode-profiles`, `/api/ingest`, `/api/publishing-rules` | workflow run, cancel and retry |

**Mapping rules:**
- **Method:** reads (`GET`) need `view`. Writes need `operate` if the path matches the feature's operate list, otherwise `manage`.
- **Shared paths:** `/api/sources` is allowed for anyone holding the needed level on channels, radio or events.
- **Shared lookups:** groups, output profiles, metadata schemas, engines, add-ons and encode profiles can be read by any signed-in admin user, because other features' forms need them.
- **Unlisted paths:** a signed-in user's own notifications, tickets, search and discovery documents. Anyone can read them; writing needs at least the operator tier.
- **Filtered lists:** search results and the live board only include kinds the user can see.

### Default roles
| | Administrator | Report & Analytics Manager | Event Manager | Radio Manager | System Viewer |
|---|---|---|---|---|---|
| Tier | admin | operator | operator | operator | viewer |
| Live & monitoring | manage | view | view | view | view |
| TV channels | manage | view | view | – | view |
| Radio stations | manage | view | – | **manage** | view |
| Events | manage | view | **manage** | – | view |
| EPG | manage | view | manage | manage | view |
| Recordings | manage | view | manage | manage | view |
| Media library & publishing | manage | view | operate | – | view |
| Files & storage | manage | view | manage | manage | view |
| Share links | manage | view | manage | manage | view |
| Analytics | manage | **manage** | view | view | view |
| Fleet & usage | manage | view | – | – | view |
| Admin users / Roles | manage | – | – | – | view |
| Public users | manage | view | – | – | view |
| Apps / Payments / Settings | manage | – | – | – | view |

"Public" is not an admin role. A public user is a viewer account (section 5), a different kind of user that can never hold an admin session.

## 4. Rules for managing admin users

All of these are enforced in `volt-app/src/modules/users.ts` and `userGroups.ts`:

1. **No escalation.** The access a user would end up with must be covered, feature by feature, by the access of the person granting it. The same applies to creating or editing a role: you can only use levels you hold yourself.
2. **No managing above yourself.** You cannot change, disable or delete a user whose current access you don't cover, or whose tier is higher than yours.
3. **No self-service access.** Users change their own name and password (`PATCH /api/auth/me`, `POST /api/auth/password`), never their own roles, tier or status.
4. **The last owner stays.** The last active owner cannot be demoted, disabled or deleted.
5. **Changes apply on the next request.** Database triggers drop the cached access the moment a user, role or membership changes, and changing a user's access or status also revokes their refresh tokens. A disabled user's unexpired access token stops working immediately, on every API process.
6. **Everything is audited.** Every create, update and delete of a user, role or viewer is written to the audit log.

**Example:** a "User desk" role with `users: manage` and `radio: view` can add users with roles inside that access. It cannot add an Administrator or a Radio Manager, cannot create a role with `radio: manage`, cannot touch the owner, and cannot change itself. The test suite checks each of these.

## 5. Public users (viewer accounts)

There are two ways for a viewer to sign in:
- **Hosted:** Volt keeps the account. The viewer registers and signs in with email and password through an app's publishable key (`/api/public/auth/register`, `/login`). Passwords are hashed with argon2id at the OWASP settings (19 MiB memory, t=2, p=1).
- **The client's own identity provider:** the client's server authenticates the viewer, then calls `POST /api/public/auth/token-exchange` with the account secret key and `{externalId, email, groups}`. Volt returns viewer tokens for the client's app. This is the secure replacement for an app *claiming* a viewer in the play request body.

**What a signed-in viewer can do:**
- `GET`/`PATCH /api/public/me`: name, avatar and free-form preferences. Groups and entitlements cannot be self-edited.
- `POST /api/public/me/password`: change password, which ends every session.
- `GET /api/public/me/entitlements`, `/purchases`, `/sessions`; `POST /me/sign-out-everywhere`.
- `DELETE /api/public/me`: removes personal data. Purchases are kept for the client's records.
- `POST /api/public/auth/password-reset` and `/confirm`: a 6-digit emailed code valid for 15 minutes. The response is the same whether or not the email exists, and both steps are rate limited.

**Sessions:**
- The access token lasts 15 minutes (`VIEWER_ACCESS_TTL`).
- The refresh token lasts 60 days (`VIEWER_REFRESH_TTL`), is rotated on every use, and cannot be replayed.

**Admin management:** the Users & Roles page (Public users tab) and `/api/viewers`, behind the `viewers` feature. Admins can search, view entitlements and purchases, disable or enable, sign a viewer out everywhere, change groups, and delete. Granting access stays in Payments (`/api/payments/grants`).

## 6. Who can watch what (content access)

The play gate (`/api/public/availability`) decides for every start, in this order:
1. **App key:** a valid publishable key, and the request passes the app's restrictions (allowed web origins, server IP list).
2. **Ownership:** the asset belongs to the key's account. An asset from another account gets the same 404 as one that doesn't exist.
3. **Viewer:** from a verified viewer session (`Authorization: Bearer <viewer token>`) if there is one, otherwise anonymous.
4. **Rights:** the asset's availability and publishing window, publishing rules (members only, groups, paid), the per-programme geo blackout and its replacement slate. The country comes from the edge (CloudFront-Viewer-Country) when `TRUST_EDGE_GEO` is set.
5. **Token:** if allowed, it returns a short-lived playback token plus the manifest URLs.

**Viewer identity sent in the request body is ignored** (`viewer`, `entitled`), unless the app is marked `restrictions.trustAssertedViewer = true`, which is meant for server-side apps only. From a browser or phone, those fields are whatever the user typed, and they used to unlock members-only and paid content. Use viewer sessions or token exchange instead.

**Pay-per-view:**
1. The viewer signs in.
2. The play gate answers `402 paywall` with the products on offer.
3. The app takes payment through the provider (Stripe, App Store, Google Play).
4. The provider's webhook, or `/api/public/payments/verify`, records the purchase and the entitlement.
5. The next play request succeeds. The token carries an entitlement snapshot, and when that snapshot says no, the gate checks the live entitlements once, so a purchase works without signing in again. The app can also refresh the token after checkout.
6. A refund or revocation ends access within milliseconds, through the revocation list described in section 7.

## 7. Why this scales, and why it is secure

| Concern | Mechanism |
|---|---|
| Admin permission check per request | Effective access is cached per user in each process and dropped by triggers on change (`user:`, `ugroup:` tags). A check is a map lookup, with no database query. |
| Signed-in viewer play request | The viewer token carries the account, app, groups and an entitlement snapshot. Verification is an HMAC check, with no database query. |
| Anonymous play request | Answered by the edge cache (CloudFront or nginx) for up to 15 s, keyed by app key, asset, page origin and viewer country. A request carrying a session is never cached (`no-store`, and it bypasses the cache). |
| Revoking a viewer (disable, refund, password change, sign out everywhere) | Postgres NOTIFY feeds an in-memory revocation list on every process. Tokens issued before the revocation are refused immediately. |
| Disabling an admin user | The access cache is dropped by trigger and refresh tokens are revoked, so the user is refused on the next request. |
| Password guessing | Per-email and per-IP rate limits in Valkey (per process if Valkey isn't configured). WAF rate rules at CloudFront. The same response timing for unknown accounts. |
| Kick-off sign-in burst | Each viewer sign-in costs about 10 to 20 ms of CPU (argon2id). Keep viewers signed in with 60-day refresh tokens, prompt sign-in before the event, and pre-warm `api-public` (SCALING.md). Refreshing a token costs one indexed query, not a password hash. |
| Purchase burst | Provider webhooks are idempotent (one row per provider transaction). New entitlements reach viewers through the "re-check on refusal" path, without every viewer refreshing their token. |

## 8. The admin interface

`volt-web/src/access.tsx` reads one map from `GET /api/auth/me` (`permissions`: feature → level):
- **The menu:** a section appears only when the user has `view` on its feature (`NAV_FEATURE` in `App.tsx`). Users & Roles appears when any of `users`, `access` or `viewers` is visible. System Admin appears only for platform staff, and asks for the authenticator code.
- **Deep links:** opening a section the role doesn't include shows "No access". Landing on `/` goes to the user's first allowed section.
- **Buttons:** create, edit and delete need `manage`; start/stop, on/off air, auto connect and failover need `operate` (Radio, Radio station, Channels, Channel, Events). Users with only view or operate see a "View only" or "Operate only" badge where the controls would be.
- **Other pages:** pages without per-button gating yet show a "view only" notice for those roles, and the API refuses the action with a message naming the feature.
- **Example:** a role with only `radio: view` sees Radio in the menu. They can open the list and click into a station, but see no Start, Stop, On air or Settings, and the API refuses those calls with `403 forbidden_feature` naming `operate` or `manage`.

## 9. Checklist: adding a feature or endpoint

**A new admin endpoint or router:**
1. Mount it under a catalogue prefix, or add its prefix to the right `FeatureDef` in `src/auth/roles.ts`. It is then gated with no further code: reads need `view`, writes need `manage`.
2. If any of its writes are "running" rather than "changing", add path regexes to that feature's `operate` list, and a one-line `operateMeans`.
3. For decisions inside a handler, use `can(req, feature, level)` or `requirePermission(feature, level)`, never the tier. Filter lists that mix kinds (as search and the live board do).
4. If a write gives someone access (users, roles, keys), check it with `assertCovers(req.access.perms, wanted, '…')`.
5. Add a test to `test/access/access-check.ts`: one role that may, and one that may not.

**A new feature area:**
6. Add a `FeatureDef` (key, label, area, prefixes, operate). It appears in the role editor automatically.
7. Decide its level in each default role (`src/auth/defaultRoles.ts`). Existing accounts pick up the change at the next boot (`ensureDefaultRoles`).

**In the console:**
8. Add the section key to `NAV_FEATURE` in `App.tsx`.
9. Wrap controls in `useAccess().can(feature, 'operate' | 'manage')` or `<Can feature level>`. For channel rows, use `featureForChannel(kind)`.

**A new public endpoint:**
10. Mount it under `/api/public/…`, with a publishable key and/or `viewerAuth(req)`. Never read identity or entitlements from the request body.
11. If it is outside `/api/public/`, add it to `PUBLIC_PATH_PREFIXES` (`src/scale/config.ts`), the staging nginx public location, the ALB `public_path_groups`, and a CloudFront behaviour if it can be cached.
12. Credential endpoints get `limit(…)` rate limits.

**The documentation (every endpoint):**
13. Run `npm run docs:routes` so `volt-app/docs/API_ROUTES.md` lists it with its credential and access (`test/docs.check.sh` fails until you do).
14. If clients will call it, add a step to `volt-app/api/build.ts` (body, `params`, one sentence) and run `api/capture_api.sh`. That refreshes the Postman collection, `API.md` and the playground from a live run. `docs/API_GUIDE.md` explains how to use the API.

## 10. Test users and tests

```bash
cd volt/volt-app
npm run seed:access      # creates the test users and prints a publishable key
npm run test:access      # 52 checks across the rules above (needs Postgres)
npm run test:identity    # 59 checks: email change, mobile, two-step sign-in, policy, resets, groups
```

| Email | Password | Role |
|---|---|---|
| admin@volt.test | `VoltTest!2026` | Owner, Administrator |
| analytics@volt.test | `VoltTest!2026` | Report and Analytics Manager |
| events@volt.test | `VoltTest!2026` | Event Manager |
| radio@volt.test | `VoltTest!2026` | Radio Manager |
| viewer@volt.test | `VoltTest!2026` | System Viewer |
| fan@volt.test | `VoltTest!2026` | Public user (sign in through the printed publishable key) |

- **Options:** `SEED_ACCOUNT_ID`, `SEED_DOMAIN` and `SEED_PASSWORD` change the account, email domain and password.
- **Production:** the script refuses to run with `NODE_ENV=production`.

## 11. What changed for existing clients and deployments

- **Platform access:** System Admin now asks for the authenticator code once an hour (step-up). Set `PLATFORM_REQUIRE_MFA=false` only in local development.
- **Play requests:** viewer identity and `entitled` in the body are ignored unless the app has `trustAssertedViewer`. Apps that relied on them should move to viewer sessions or token exchange.
- **User groups:** existing groups are now roles. Their members keep their access, and `monitoring` and `fleet` were added as `view` so the Live board stays visible. Users can hold several roles; the API accepts `roleIds`, and the old `userGroupId` still works.
- **Delegated administration:** user management, roles, apps, payments and settings are features that can be delegated, safely, because of the no-escalation rule. Secret keys still need the admin tier.
- **Passwords:** the minimum length for new admin and viewer passwords is now 10 characters.
- **New settings:**
  - `VIEWER_JWT_SECRET`: set it in production. Terraform generates it, and in staging it can be blank (derived).
  - `VIEWER_ACCESS_TTL` / `VIEWER_REFRESH_TTL`: viewer token lifetimes.
  - `PLATFORM_SESSION_TTL`: platform session lifetime.
  - `PLATFORM_REQUIRE_MFA`: see Platform access above.
- **Migration 0048** adds verified email and mobile, two-step sign-in, the account policy, one-time codes, backup codes and unique group names (see section 12).
- **Migration 0047** adds the role columns, the multi-role membership table, the viewer account columns, viewer refresh tokens and the change-notification triggers.

## 12. Email, mobile number and two-step sign-in

Both admin users and public users can change their email (with verification), verify a mobile number and turn on two-step sign-in. One implementation serves both (`volt-app/src/auth/identity.ts`). Admin users manage it in **My account** (click your name at the bottom of the menu, or `/account`), which every admin user can open whatever their role.

### Methods

| Method | How it works | Notes |
|---|---|---|
| Authenticator app | TOTP (RFC 6238), any standard app. The console shows a QR code and the key. | Most secure, works offline. The seed is sealed with AES-256-GCM (`MFA_ENCRYPTION_KEY`). Platform staff use the same entry for System Admin. |
| Code by email | 6-digit code to the verified email address | Setting it up verifies the address |
| Code by text message | 6-digit code to the verified mobile, sent with AWS SNS | Needs `SMS_PROVIDER=sns` and the task role permission (Terraform adds it) |
| Backup codes | 10 one-time codes, shown once when the first method is turned on | Can be remade (old ones stop working) |

### Sign-in

1. `POST /api/auth/login` (or `/api/public/auth/login`) with email and password.
2. If no second step is due, the answer is the session as before.
3. If the person has a method on, the answer is `{mfaRequired, challenge, methods, email, phone}` instead (masked). The `challenge` is a 10-minute token (audience `volt:mfa`) that is not a session: the API refuses it everywhere else.
4. For email or text: `POST …/mfa/challenge/send {challenge, method}`.
5. `POST …/mfa/challenge/verify {challenge, method, code}` returns the session. The session records how it was signed in (`amr`, RFC 8176), for example `["pwd","mfa","otp"]`.
6. If the account requires two-step sign-in and the person has no method yet, the answer is `{mfaSetupRequired, challenge, available}`. They set a method up with the challenge (`…/mfa/{totp|email|sms}/start` then `/confirm`), and the confirm returns the session and their backup codes.

### Account policy (admin users)

**Users & Roles > Admin users > Require two-step sign-in for all admin users** (`PUT /api/users/security-policy`, needs `users:manage` and the admin tier).

- **When it is switched on:** current sessions that did not use a second step end at their next refresh (within `ACCESS_TTL`, 15 minutes by default) with `401 mfa_required`. Anyone without a method sets one up at their next sign-in.
- **The last method cannot be removed** while the policy is on.
- **Public users:** two-step sign-in is optional for them. The client app decides whether to offer it.

### Changing email

1. `POST …/email/change {newEmail, password}` sends a code to the **new** address. Nothing changes yet.
2. `POST …/email/change/confirm {code}` changes it and marks it verified. A notice goes to the old address.
- **Uniqueness:** admin emails are unique across the platform. Public user emails are unique within the client account.
- **Signing in:** the old address stops working at once.
- **External viewers:** viewers who sign in through the client's own system (token exchange) have their email and security managed there, so these routes refuse them.

### Mobile number

`POST …/phone {phone, password}` (international format, for example `+61412345678`) sends a code. `…/phone/confirm {code}` saves and verifies it. `DELETE …/phone {password}` removes it and turns off text codes.

### Locked out

- **Admin users:** an administrator opens the user in **Users & Roles** and clicks **Reset two-step sign-in** (`POST /api/users/:id/mfa/reset`). The no-escalation rules apply, so nobody can reset a user whose access they do not cover. The user's sessions end.
- **Public users:** reset from **Public users** (`POST /api/viewers/:id/mfa/reset`, `viewers:manage`).
- **Audit log:** every reset, method change and email change is recorded.

### Security properties

- **Codes:** 6 digits, single use, 10 minutes, 5 guesses, then dead. Only a keyed hash is stored (`security_codes`).
- **Delivery:** codes are sent directly and never stored in the notifications inbox. The public password-reset code now follows the same rule.
- **Rate limits:**
  - 10 sends per person and per destination per 15 minutes, so SMS cost cannot be run up.
  - 20 guesses per person per 15 minutes.
  - Counted in Valkey across processes.
- **Replay:** a TOTP code cannot be used twice. A challenge produces one session, and a finished challenge is refused before any code is looked at, so a replay cannot spend a backup code.
- **Re-authentication:** the password is needed to change email or mobile, to remove a method and to make new backup codes. It is also needed to add a method from a signed-in session, so a borrowed session cannot lock the owner out.
- **Wrong answers:** a wrong password or code answers `403 reauth_failed` or `400 invalid_code`, never `401`, so a typo never signs anyone out.
- **Scale:** none of this is on the playback path. It costs only at sign-in and in settings, so the viewer path is unchanged.

### Settings

| Setting | Where | Meaning |
|---|---|---|
| `MFA_ENCRYPTION_KEY` | Secrets Manager (Terraform generates it), staging `.env` | 32 bytes (base64 or hex). Blank derives one from `JWT_ACCESS_SECRET`. Keep it once set: a new key makes existing authenticator set-ups unreadable. |
| `SMTP_URL`, `NOTIFY_FROM` | env | Email for codes. In staging, blank means the mailpit catcher (`http://<host>:8025`). |
| `SMS_PROVIDER` | env | `sns` (AWS), or blank for none. `log` writes texts to the API log, outside production only. |
| `SMS_SENDER_ID`, `SMS_ORIGINATION_NUMBER`, `SMS_REGION` | env / Terraform variables | Sender details SNS needs for some countries. |
| `SECURITY_CODE_ECHO=1` | dev and test only | The API returns codes in its responses (`devCode`) so tests can finish the flow. Ignored when `NODE_ENV=production`. |

**AWS SMS before go-live:** take the account out of the SNS SMS sandbox, register a sender ID or origination number where the country needs one, and set a monthly spend limit (`deploy/terraform/scaling_identity.tf` has the steps and an optional `manage_sms_preferences`).

## 13. Channel groups (the name under each channel, station and event)

The grey line under each item in the Channels, Radio and Events lists (for example "RTM Main") is the item's **channel group**. It is not a server, pool or region: placement decides where a stream runs.

A group sets:
- **Output profile:** transcode or packaging only, the rendition ladder and captions.
- **Max channels:** the account's entitlement for the group.
- **Max running at once:** the account's entitlement for the group.

**Who changes what:**

| Change | Where | Needs |
|---|---|---|
| Rename a group, or pick another output profile of the same workflow type | Admin > **Channel Groups** (`PATCH /api/groups/:id`) | `settings:manage` |
| Create or delete a group, or change its caps | System Admin > account > Groups (`/api/platform/accounts/:id/groups`) | Platform staff. The caps are what the account pays for. |

- **Names are unique** within an account. Migration 0048 renames any existing duplicates to "Name (2)" and so on.
- **Deleting:** only an empty group can be deleted.
- **The demo data:** "RTM Main" comes from `scripts/seed-demo.ts`.
