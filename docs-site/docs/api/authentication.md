---
title: Authentication
sidebar_position: 2
description: The credentials Volt uses, how to send them, how sign-in works, and quick-start examples.
guide: developer
---

# Authentication

Every Volt request carries one credential: an admin session or your account secret key for the admin API, a publishable key (and, once someone signs in, a public user session) for the public API. This page lists them all and shows each sign-in flow working.

## What it is for

- Signing your staff in to tools you build on the admin API, including two-step sign-in.
- Calling Volt from your own servers with the account secret key.
- Letting your audience make accounts and sign in through your apps, or vouching for members who already sign in to your own site.

## Before you start

- An app and its publishable key, and an account secret key: see [Getting started with apps and keys](apps-and-keys.md).
- `curl` and `jq` for the examples. Replace `https://your-volt-host` with your Volt address.

## Credentials

| Credential | Looks like | Where it comes from | How to send it | Lifetime |
|---|---|---|---|---|
| **Publishable key** | `pk_live_...` / `pk_test_...` | Created with an app (**API Keys and Apps**, or `POST /api/apps`). Shown once. | `appKey` in the body or query string | Until rotated or revoked |
| **Account secret key** | `sk_live_...` | **API Keys and Apps**, or `POST /api/apps/secret-keys`. Shown once. | `Authorization: Bearer sk_live_...` | Until revoked |
| **Admin session** | A token | `POST /api/auth/login`, or `/api/auth/mfa/challenge/verify` | `Authorization: Bearer ...` | 15 minutes |
| **Admin refresh token** | A random string | The same answers | Body of `POST /api/auth/refresh` | 14 days from sign-in. Rotates on every use, without extending. |
| **Public user session** | A token | `POST /api/public/auth/login`, `/register`, `/mfa/challenge/verify` or `/token-exchange` | `Authorization: Bearer ...` | 15 minutes |
| **Public user refresh token** | `vr_...` | The same answers | Body of `POST /api/public/auth/refresh` | 60 days. Rotates on every use. |
| **Playback token** | A token | The play gate (`/api/public/availability`) | Handled by the player | Minutes |
| **Sign-in challenge** | A token | A sign-in answer when a second step is due | `challenge` in the body | 10 minutes, one use |

### Rules

- **Never put a secret key in an app or a web page.** It is for your own servers only.
- **Publishable keys are safe in public**, but only work on the domains, app bundle ids or IP ranges you allow for the app.
- **Never send identity or entitlements in a public request body.** The public user's session decides who they are, which groups they are in and what they have paid for.

## Step by step

### 1. Admin: sign in, use the session, refresh it

```bash file=authentication/admin-sign-in.sh
```

From your own server you can skip sign-in and send the account secret key instead: `Authorization: Bearer sk_live_...`.

### 2. Public: a viewer makes an account in your app and asks to play

```bash file=authentication/viewer-sign-in.sh
```

Registering again with the same email is refused without saying whether the address has an account; use `POST /api/public/auth/login` with the same body to sign in. The `Origin` header is what a browser sends by itself: the publishable key only works on the sites its app allows.

### 3. Your server: vouch for a member from your own sign-in system

If your members already sign in to your own site, your server can exchange that for a Volt public user session. The `groups` you send are what members-only rules check.

```bash file=authentication/token-exchange.sh
```

## Admin sign-in

`POST /api/auth/login {email, password}` answers in one of three ways:

| Answer | When | Next |
|---|---|---|
| `{access, refresh, expiresIn}` | No second step is due | Use `access` |
| `{mfaRequired: true, challenge, methods, email, phone}` | The user has two-step sign-in on. `methods` is any of `totp`, `email`, `sms`, `backup`. | For email or text: `POST /api/auth/mfa/challenge/send {challenge, method}`. Then `POST /api/auth/mfa/challenge/verify {challenge, method, code}` returns the session. |
| `{mfaSetupRequired: true, challenge, available}` | Your account requires two-step sign-in and this user has no method yet | Set one up with the challenge: `POST /api/auth/mfa/{totp\|email\|sms}/start {challenge}`, then `/confirm {challenge, code}`. Confirm returns the session and 10 backup codes. |

- **Refresh**: `POST /api/auth/refresh {refresh}` returns a new pair. Sessions end 14 days after sign-in whatever the activity.
- **Policy turned on mid-session**: if your account starts requiring two-step sign-in and this session did not use it, refresh answers `401` with code `mfa_required`. Sign in again to set it up.
- **Sign out**: `POST /api/auth/logout {refresh}`.

## Public user sign-in

The same flow, under `/api/public/auth/`, with your app's `appKey` in the body:

| Request | Does |
|---|---|
| `POST /api/public/auth/register {appKey, email, password, displayName?}` | Creates a public user and signs them in. The answer never reveals whether the email already had an account. |
| `POST /api/public/auth/login {appKey, email, password}` | Answers `{viewer, access, refresh, expiresIn}`, or `{mfaRequired, challenge, methods}` |
| `POST /api/public/auth/mfa/challenge/send` and `/verify` | The second step, as for admin users |
| `POST /api/public/auth/refresh {refresh}` | Rotates the pair. A refresh token used twice is refused. |
| `POST /api/public/auth/password-reset {appKey, email}` | Emails a 6-digit code, valid for 15 minutes. Then `/password-reset/confirm {appKey, email, code, password}`, which ends every session. |
| `POST /api/public/auth/logout {refresh}` | Signs out |

A purchase made after a session was issued is still honoured: if the play gate says no, it checks the viewer's purchases again. Disabling a public user, a password change or "sign out everywhere" ends their sessions at once.

## Email, mobile number and two-step sign-in

The same requests work for both kinds of user: under `/api/auth/` for admin users, and under `/api/public/me/` for public users.

| Request | Body | Notes |
|---|---|---|
| `GET .../security` | | Email and mobile (verified or not), methods on, backup codes left, whether two-step sign-in is required |
| `POST .../email/change`, then `/confirm` | `newEmail, password`, then `code` | The code goes to the new address. The old address is told. |
| `POST .../phone`, then `/confirm` | `phone` (for example `+61412345678`), `password`, then `code` | Texted code |
| `POST .../mfa/totp/start`, then `/confirm` | `password`, then `code` | Returns a secret and an `otpauthUri` to show as a QR code. The first method turned on returns 10 backup codes, shown once. |
| `POST .../mfa/email/start` or `/mfa/sms/start`, then `/confirm` | `password`, then `code` | Also verifies the email or number |
| `DELETE .../mfa/{totp\|email\|sms}` | `password` | Refused for the last method while two-step sign-in is required |
| `POST .../mfa/backup-codes` | `password` | 10 new codes. The old ones stop working. |

**Codes** are 6 digits, single use and valid for 10 minutes. Five wrong guesses and the code stops working. At most 10 codes are sent per person and per destination in 15 minutes.

Administrators can require two-step sign-in for all admin users (`PUT /api/users/security-policy {requireAdminMfa}`), and reset it for someone who has lost their phone (`POST /api/users/{id}/mfa/reset`, or `POST /api/viewers/{id}/mfa/reset` for a public user).

## The play gate

Before a player can play anything, it asks the play gate:

| Request | Credential | Answers |
|---|---|---|
| `GET /api/public/availability?appKey&assetId` | None | Whether it can play, a playback token and the stream addresses, or why not. Cached at the edge. |
| `POST /api/public/availability {appKey, assetId}` | A public user session (optional) | The same, decided with the viewer's groups and purchases |
| `POST /api/public/access/check {appKey, assetId}` | None | Yes or no answers for catalogue screens, without a token |

The gate applies the asset's publishing rules, geo rules, schedule windows and access rules. The [player](../guides/player-sdk.md) does all of this for you.

The [play gate guide](play-gate.md) covers the answers and the playback token in full.

## Troubleshooting

| Response | Means | Do |
|---|---|---|
| `401 Invalid email or password` | Wrong email or password, or the user is disabled | Check both; an administrator can re-enable the user |
| `401` with code `mfa_required` on refresh | Your account started requiring two-step sign-in | Sign in again and set up a method |
| `401 An account secret key is required` from token exchange | The request carried a publishable key, an admin session or nothing | Send `Authorization: Bearer sk_live_...` from your server |
| `401 This session belongs to another account` at the play gate | A viewer session from one account with another account's key | Use the key of the app the viewer signed in to |
| A refresh token is refused | It was already used once (refresh tokens rotate) or the session ended | Keep the newest pair from each refresh; sign in again if refused |
| `429` | Too many sign-in attempts or codes | Wait, see [Errors and limits](errors.md) |
