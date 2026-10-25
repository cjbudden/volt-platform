---
title: Getting started with apps and keys
sidebar_position: 1.5
description: Register an app, get its publishable key and a secret key for your servers, make your first call and rotate keys without downtime.
guide: developer
---

# Getting started with apps and keys

Everything you build on Volt starts with two kinds of key. Each app that plays your content (a website, a phone or TV app) gets a **publishable key**, safe to ship inside the app. Your own servers use an **account secret key**, which never leaves them.

## What it is for

- **A player on your website or in your app.** The publishable key (`pk_live_...`) lets it ask the [play gate](play-gate.md) whether something can be played, read the programme guide and send [playback reports](playback-reporting.md). It cannot read or change anything else.
- **Your back-end systems.** The account secret key (`sk_live_...`) can do everything an Owner can: create channels and events, push the guide, upload media, read reports. Use it from servers you control, never from a browser or an app.
- **Changing keys safely.** An app can hold several keys at once, so you can roll out a new one and revoke the old one with no gap in playback.

| Key | Looks like | Made by | Safe in an app? |
|---|---|---|---|
| Publishable key | `pk_live_...` | Registering an app, or issuing a new key for it | Yes. It only works where its app allows. |
| Account secret key | `sk_live_...` | An Owner or Administrator | No. Servers only. |

Every key is shown **once**, when it is made. Volt keeps only a fingerprint and the first few characters, so copy it straight into your app's settings or your server's secret store.

## Before you start

- An admin user with **Apps, API keys & players: Manage** to register apps. To make a secret key you also need to be an **Owner** or **Administrator**. See [roles and access](../getting-started/roles-and-access.md).
- Know your app's platform (`web`, `ios`, `android`, `tv`, `roku` or `server`). It cannot be changed later, because it decides how the key is protected.
- For a web player, the addresses it will be served from, for example `https://www.example.com`. A key restricted to a list only works on those sites.
- `curl` and `jq` for the examples on this page. Replace `https://your-volt-host` with your Volt address.

You can do all of this in the console too: see [API Keys & Apps](../guides/api-keys-and-apps.md).

## Step by step

### 1. Register an app and get its publishable key

```bash file=apps-and-keys/register-app.sh
```

The answer:

```json
{
  "appId": "f7b12c4f-e126-4fd3-a059-b5b2ea629583",
  "publishableKey": "pk_live_ZiS7yj...",
  "keyId": "147a9bb0-1001-460d-b981-f0468f33fb9c"
}
```

`restrictions` decides where the key works:

| Platform | Restriction | Means |
|---|---|---|
| `web` | `{"referrers": ["https://www.example.com", "*.example.com"]}` | Only pages on these sites. Leave the list out to allow any site. |
| `server` | `{"ipAllowlist": ["203.0.113.10"]}` | Only requests from these addresses |
| `ios`, `android`, `tv`, `roku` | none | Bound by the device checks in the Volt SDK |

### 2. Make a secret key for your servers

```bash file=apps-and-keys/secret-key.sh
```

Store it in your server's secrets (an environment setting or a secrets manager), not in your code or your repository.

### 3. Make your first call

```bash file=apps-and-keys/first-call.sh
```

Every admin request takes the secret key the same way, as `Authorization: Bearer sk_live_...`. It sees your account only.

### 4. Rotate a publishable key

Keys do not expire. Rotate one when it may have leaked, or as a routine:

```bash file=apps-and-keys/rotate-key.sh
```

The new key works at once and the old one keeps working until you revoke it, so release the new key in your app first, then revoke. A revoked key is refused straight away (`401`). To stop an app completely without revoking its keys, set `enabled` to `false` with `PUT /api/apps/{id}`.

A secret key is revoked the same way (`DELETE /api/apps/keys/{keyId}`); `GET /api/apps/keys` lists every key with its prefix, so you can tell which is which.

## Troubleshooting

| Response | Means | Do |
|---|---|---|
| `401 invalid publishable key` from the play gate | The key was revoked, mistyped, or is a secret key | Use the app's current `pk_live_...` key |
| `403 blocked: origin '...' not in allow-list` | The page's site is not on the app's list | Add the site to the app's `referrers`, including staging sites |
| `403 blocked: referrer/origin required for this web app` | The request came with no `Origin` or `Referer`, for example from a server | Call from the browser, or register a `server` app for server calls |
| `403 blocked: app disabled` | The app is switched off (`enabled: false`) | Turn it back on with `PUT /api/apps/{id}` |
| `403` when making a secret key | Your role is below Administrator | Ask an Owner or Administrator |
| `401` with a secret key | The key was revoked, or has a typo | Make a new one; old ones cannot be shown again |
