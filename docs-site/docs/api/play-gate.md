---
title: The play gate and playback tokens
sidebar_position: 5
description: Ask Volt whether a viewer may play a channel, event or on-demand asset, read the answer, and use the playback token it returns.
guide: developer
---

# The play gate and playback tokens

Before anything plays, the player asks the **play gate**: may this app, on this site, in this country, for this viewer, play this asset now? Volt answers with yes and the addresses to play, a replacement to show instead, or no and why. The Volt player does this for you; read on if you are building your own player or app screens.

## What it is for

- **Your own player or app.** Ask the gate, then play the `delivery` addresses it returns.
- **Catalogue and guide screens.** Show a lock, a price or "sign in to watch" without starting playback.
- **Members-only and paid content.** The gate decides with the signed-in viewer's groups and purchases, so your app never has to.

Everything the gate checks is set up in Volt: the app's allowed sites, the asset's [publishing rules](../guides/publishing-rules.md), geo rules and schedule windows, the [account's geo rule](../guides/account-settings.md), the guide's rights windows, and the members-only and paid rules with their [passes](../guides/payments.md). The [securing a live stream](../workflows/secure-live-stream.md) flow shows how they fit together.

## Before you start

- An app and its publishable key: see [Getting started with apps and keys](apps-and-keys.md). Web apps only work from the sites on their list.
- The id of a channel, event or on-demand asset in your account.
- For signed-in viewers, a public user session from [sign-in](authentication.md#public-user-sign-in) or the [token exchange](authentication.md).

## Step by step

### 1. Ask for an anonymous viewer

```bash file=play-gate/anonymous.sh
```

```json
{
  "available": true,
  "mode": "play",
  "expiresIn": 120,
  "title": "Example News",
  "live": true,
  "delivery": null
}
```

The full answer also has `assetId`, the `playbackToken` and `meta` (title, description, artwork, length, live or not, kind). `delivery` holds the addresses to play: `hls` and `dash` (and `mp3` for a radio station). It is `null` while a live channel is off air, so show "not on air" and ask again later.

The anonymous `GET` is the fast path for free content: the answer is the same for everyone with the same key, site and country, so it is cached at the edge, never past the next programme change.

### 2. Ask for a signed-in viewer

Send the viewer's session as `Authorization: Bearer ...` and use `POST`. The answer is never cached and is decided with who they are.

```bash file=play-gate/signed-in.sh
```

If the viewer has just bought a pass, the gate checks their purchases again before saying no, so there is no need to make them sign in again.

### 3. Read the answer

| Status | `mode` | Means | Your app shows |
|---|---|---|---|
| `200` | `play` | Play `delivery` | The stream |
| `200` | `replacement` | A blackout or rights window: play the replacement it names (`assetId` is the replacement's, with its own `delivery`) | The replacement, and `reason` if you show one |
| `402` | `paywall` | A pass or purchase is needed. `products` lists them; `meta` says what it is | The offers and Buy |
| `403` | `sign_in` | Members only | Sign in |
| `451` | `blocked` | Not available here or now (geo, schedule, rights). `reason` says which | Not available |
| `403` | | The app's key does not work on this site, or the app is off: `error` says which | Nothing: fix the app's settings |
| `401` | | The key is not valid | Nothing: fix the key |
| `404` | | No such asset in the key's account | Not found |

### 4. Check without playing

For a catalogue screen, ask for a yes or no without minting a token:

```bash file=play-gate/catalogue-check.sh
```

`reasons` lists why not, when the answer is no. `mode` is what the gate would answer.

### 5. The playback token

`playbackToken` names this app, this asset and this play attempt, and lasts `expiresIn` seconds (two minutes). Send it with the viewer reports for Analytics. It carries no personal details, so a cached anonymous answer can be shared by many viewers. Ask the gate again for each new play, not once per page load: a token is for starting playback, and an old one is refused.

To tie the gate, the reports and the CDN logs together, pass your play attempt's id as `sid` in the request body (8 to 64 letters, digits, `.`, `_`, `:` or `-`). The Volt player does this itself.

## Troubleshooting

```bash file=play-gate/wrong-site.sh
```

| Response | Means | Do |
|---|---|---|
| `403 blocked: origin '...' not in allow-list` | The request came from a site the app does not allow | Add the site to the app, including staging sites |
| `403 blocked: referrer/origin required for this web app` | No `Origin` or `Referer`, for example a server-side call with a web key | Call from the page, or use a `server` app |
| `401 invalid publishable key` | A revoked or mistyped key, or a secret key | Use the app's current `pk_live_...` key |
| `401 This session belongs to another account` | The viewer signed in with another account's app | Use the same account's key and session |
| `404 unknown asset` | Not an id in this account (or not an id at all) | Check the id; ids from another account always answer 404 |
| Members get `sign_in` although your app knows them | A `viewer` or `entitled` sent in the body is ignored from browsers and phones | Sign them in, or use the [token exchange](authentication.md) from your server |
| `200` with `delivery: null` | The live channel is off air, or its output is not ready | Show "not on air" and try again |
