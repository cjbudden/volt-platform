---
title: API Keys & Apps
sidebar_position: 10.9
description: Register the web, mobile and TV apps that play your content, rotate their keys, and make secret keys for your own servers.
guide: section
---

# API Keys & Apps

**API Keys & Apps** is where you register each application that plays your content (a web player, a mobile app, a smart TV app) and manage the secret keys your own servers use to work with Volt. Each app gets a **publishable key** it embeds; where that key works depends on the app's platform. Most people come here to register a new app and copy its key, or to rotate a key.

![The API Keys & Apps page: the registered apps with their platform, key prefix and requests, then the server-to-server secret keys](/img/screens/api-keys-and-apps.png)

## What it is for

- **Registered apps.** One per app you ship. Its publishable key (`pk_live_...`) is safe in client code: it can check whether something may be played and get a short-lived playback token, and it cannot read or change anything in this console.
- **Where a key works.** A web player's key can be limited to your own sites; a server app's to your own addresses; an iOS, Android, smart TV or Roku app's key is bound by device checks in the Volt SDK.
- **Account secret keys** (`sk_live_...`). For your own back-end systems. They can do everything an owner can and work from anywhere, so they never belong in an app or a repository.

Raw keys are shown once, when they are made. Volt keeps only a fingerprint and the first few characters.

## Before you start

- Know the platform of the app. It cannot be changed once registered, because the key's protection follows from it.
- For a web player, the addresses (origins) the player is served from, for example `https://watch.example.com`. You can register first and add them later.
- Access: **Apps, API keys & players: Manage** to register; account secret keys also need an Owner or Administrator (see [Who can do it](#who-can-do-it)).

## Step by step

### Register an app

1. Open **Admin** and choose **API Keys & Apps**.
2. Choose **Register app** (or **Register your first app**).
3. Type the **App name**, for example "Web player".
4. Under **Platform**, choose **Web player**, **iOS**, **Android**, **Smart TV**, **Roku** or **Server**. The line under each says how its key is protected.
5. Under **Where the key works**, for a web player or server choose **Any origin** (or **Any address**) or **Only my origins** (or **Only my addresses**). For the second, type one per line. Wildcards like `*.example.com` work for origins. Mobile and TV apps have nothing to set.
6. Read **What will be created**: where the key will work and what it can do. An unrestricted key is flagged in yellow; a restricted key with an empty list is flagged in red, because it would refuse every request.
7. Choose **Register and show me the key**.
8. Copy the key with **Copy** and keep it: it is shown once and cannot be retrieved. Choose **Done, I saved it**.

The app is listed with its platform, its key prefix, the requests it has made and **Enabled**. **All**, **Client apps** and **Server** filter the list.

### Change where a key works, or turn an app off

1. Choose **Open** on the app.
2. Change the name or **Where the key works**. It takes effect at once.
3. Under **Keys, rotation and availability**, **App enabled** off blocks all of the app's keys at once without deleting them; playback stops immediately.
4. Choose **Save changes**.

### Rotate an app's key

1. Open the app and **Keys, rotation and availability**.
2. Choose **Issue a new key** and copy it from the window that opens.
3. Roll the new key out in your app.
4. Back here, choose **Revoke** on the old key and confirm. Old keys keep working until revoked, so nothing breaks in between.

### Make a secret key for your servers

1. Under **Server-to-server keys**, choose **Create a secret key**.
2. Copy it from the window and keep it in your server's secrets, never in an app or a repository. Choose **Done, I saved it**.
3. The key is listed with its scope, when it was last used and its requests. **Revoke** stops it working at once, after you confirm.

How to use the keys is in [Authentication](../api/authentication.md).

## How it connects

| Section | How it relates |
|---|---|
| [Embedding](embedding.md), [Player SDK](player-sdk.md) | The player embeds an app's publishable key |
| [Account settings](account-settings.md), [Publishing Rules](publishing-rules.md) | Geo and access rules are checked when an app asks to play |
| [Payments](payments.md) | Apps check purchases with their publishable key |
| [Users & Roles](users-and-roles.md) | Public users sign in through your apps |
| [Analytics](analytics.md) | **By app** splits views by the app that played them |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See apps and keys | Apps, API keys & players: View |
| Register, change, enable or disable an app; issue and revoke its keys | Apps, API keys & players: Manage |
| Create an account secret key | Apps, API keys & players: Manage, as an Owner or Administrator |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **Give the app a name** | The name is empty | Type a name |
| **Unrestricted.** in yellow | The key would work from any page or address | Add your origins or addresses once you know them |
| **Restricted with an empty list, so every request would be refused, including your own player.** | **Only my origins** (or addresses) is chosen with nothing typed | Type at least one, or choose **Any origin** |
| A player stops playing after a change | Its origin is not in the list, the app is disabled, or its key was revoked | Check **Where the key works**, **App enabled** and the keys |
| You lost a key | Keys are shown once | Issue a new key, roll it out, revoke the old one |
| **None yet. Nothing outside this console can reach the API on your behalf.** | No secret key exists | Create one when a server needs it |
| **Couldn't load apps and keys.** | The page could not reach Volt | Choose **Retry** |

## Through the API

| Request | Does |
|---|---|
| `GET /api/apps` | The registered apps |
| `POST /api/apps` | Registers one (`name`, `type`, `restrictions`); answers with its publishable key, once |
| `PUT /api/apps/{id}` | Changes `name`, `restrictions` or `enabled` |
| `POST /api/apps/{id}/keys` | Issues a new key for it |
| `GET /api/apps/keys` | Every key in the account, by prefix |
| `DELETE /api/apps/keys/{keyId}` | Revokes a key |
| `POST /api/apps/secret-keys` | Creates an account secret key |

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "Web player", "type": "web", "restrictions": {"referrers": ["https://watch.example.com"]}}' \
  "https://your-volt-host/api/apps"
```

Every route is in the [API reference](/api-reference).
