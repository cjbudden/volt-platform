---
title: Errors and limits
sidebar_position: 4
description: Status codes, the error body, and the rate limits on sign-in and codes.
---

# Errors and limits

Errors are JSON:

```json
{ "error": "Your role does not allow manage on Admin users", "code": "forbidden_feature", "feature": "users", "level": "manage" }
```

`error` is a sentence you can show to a person. `code`, when present, is stable and meant for your code to act on.

## Status codes

| Status | `code` | Means | What to do |
|---|---|---|---|
| 400 | | Bad request. The message says what to fix. | Fix the request |
| 400 | `invalid_code` | A wrong or expired one-time code. Never 401, so a typo does not end the session. | Ask for the code again |
| 401 | | No credential, or an expired or wrong session | Refresh, or sign in again |
| 401 | `mfa_required` | On refresh: your account now requires two-step sign-in | Sign in again and set it up |
| 403 | `forbidden_feature` | The user's roles do not give `feature` at `level` | Ask an administrator for access |
| 403 | `reauth_failed` | The current password was wrong on a change that asks for it. The session is kept. | Try again |
| 404 | | Not found, or not in your account | Check the id |
| 409 | for example `no_media` | The request conflicts with the current state. The body says why. | Read `error`, change the state, retry |
| 422 | `ValidationError` | The body or query does not match what is expected. `error` names the fields ("Check these fields: name: Required") and `details` lists each problem. | Fix the fields |
| 429 | `rate_limited` | Too many tries | Wait, then try again |

## Rate limits

| What | Limit |
|---|---|
| Sign-in | 10 tries per email address and 50 per network address in 5 minutes |
| Codes sent by email or text | 10 per person and per destination in 15 minutes |
| A one-time code | 5 wrong guesses, then it stops working |

Past a limit the API answers `429` with code `rate_limited`.

## Good practice

- **Refresh before the session ends.** Admin and public user sessions last 15 minutes. Use the refresh token rather than signing in again.
- **Ignore fields you do not know.** New fields are added to answers over time.
- **Act on `code`, show `error`.** Codes are stable. Messages may be reworded.
- **Keep secret keys on your servers**, and revoke any key you think has leaked.
