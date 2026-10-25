---
title: API overview
sidebar_position: 1
description: The public and admin APIs, base paths, conventions and how to explore them.
---

# API overview

Everything you can do in the Volt console you can also do through the API: create and run channels, build guides, cut clips, manage users, and let your own apps decide who can watch.

The [API reference](/api-reference) lists every request with its parameters and a real example answer, and lets you send requests from your browser.

## Two APIs

| API | Base path | For | Credential |
|---|---|---|---|
| **Public** | `/api/public/` | Your apps, players and your audience (public users) | Your app's publishable key (`pk_...`), plus a public user session when someone is signed in |
| **Admin** | `/api/` | Your staff (admin users) and your own servers | An admin session, or your account secret key (`sk_live_...`) |

The two never accept each other's credentials. A public user's session is refused by the admin API, and an admin session is refused by the public account routes.

Some older public paths still work as aliases: `/api/availability`, `/api/access/check`, `/api/player/*`, `/api/analytics/beacon` and `/api/payments/verify`. New code should use the `/api/public/` versions.

See [authentication](authentication.md) for every credential and how to send it.

## Conventions

- **JSON**: request and response bodies are JSON (`Content-Type: application/json`), except uploads, media and stream delivery.
- **Ids**: UUIDs.
- **Times**: ISO 8601 in UTC in bodies (`2027-01-01T10:00:00Z`). Positions on a timeline are milliseconds since the epoch (for example `startMs`).
- **Lists**: every list searches, filters, sorts and pages the same way: `q`, `field=value`, `field[op]=value`, `sort=-field`, `limit` and `cursor`, with paging in the response headers. See [Search, filter, sort and page](lists.md).
- **Your account only**: every admin credential belongs to one account, and every request only sees that account. An id from another account answers 404.
- **Errors**: JSON with an `error` message and often a `code`. See [errors](errors.md).

## Explore the API by following links

Send `Accept: application/ld+json` on a GET to receive the same data with links to related resources (JSON-LD with Hydra). Start at `GET /api`, then follow the links down to a resource, up to its parent, or across to its siblings, without building URLs yourself. Plain JSON is unchanged when you do not ask for it.

```bash file=lists/follow-links.sh
```

## What each admin request needs

Every admin request belongs to an area of Volt (channels, radio, events, EPG, recordings, media, analytics, users and so on) and needs a level in it: **View** for reading, **Operate** for running things (start, stop, go on air, publish), **Manage** for creating, changing and removing. The [API reference](/api-reference) shows the area and level for each request. See [roles and access](../getting-started/roles-and-access.md).

To build menus and buttons that match what a user may do, call `GET /api/auth/me`. It returns the user's level in every area.

An account secret key has full admin access to its account.

## Changes to the API

The API is not versioned in the path. New fields and new requests are added without notice, so write clients that ignore fields they do not know. Changes that could affect an integration are announced in the [release notes](/release-notes).
