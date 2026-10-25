---
title: Recipes for common integrations
sidebar_position: 10
description: Short, tested examples for the integrations most customers build first.
guide: developer
---

# Recipes for common integrations

Each recipe is a few lines that do one common job end to end. Like every example in these guides, each one is run against a real Volt API before the documentation is published.

## What it is for

- A starting point you can copy, for the jobs most integrations begin with.
- Seeing how the pieces in the other developer guides fit together.

## Before you start

- An app's publishable key and an account secret key: see [Getting started with apps and keys](apps-and-keys.md).
- `curl` and `jq`. Replace `https://your-volt-host` with your Volt address and the ids with your own.

## Step by step

### What is on now in your app

A guide screen or a "now playing" line, with only the publishable key (safe in an app):

```bash file=recipes/whats-on.sh
```

```json
{"channelId":"0000000e-...","programmes":[{"title":"Evening News","startsAt":1792895312769,"endsAt":1792898912769}]}
```

Times here are milliseconds since 1970 (what a JavaScript `Date` takes). The answer covers six hours back to a day ahead (`past` and `hours`, in hours, change that), includes `subtitle`, `description` and `imageUrl` when the guide has them, and may be cached for a minute. The [player](../guides/player-sdk.md) shows the same guide by itself with `epg: { channelId }`.

### Let your own members watch

Your members sign in to your own site. Your server vouches for them, and the player plays what members may watch:

```bash file=recipes/members-from-your-site.sh
```

On the page, create the player with the session (`viewerToken`), or hand it over later with `player.setViewerToken(...)`. Keep the refresh token on your server and refresh the session before it expires (15 minutes). The members-only rule is set on the content in Volt, so changing who may watch never needs a change to your site. See [the play gate](play-gate.md) and [authentication](authentication.md).

### Keep your own catalogue in step

Everything changed since your last sync, oldest change first, page by page. Store the newest `updated_at` you saw and start from it next time:

```bash file=recipes/sync-catalogue.sh
```

```json
{"id":"caa5c9ca-...","title":"Season opener","published":true,"updated_at":"2026-10-25T02:28:32.710Z"}
{"id":"5f84e573-...","title":"Coach interview","published":true,"updated_at":"2026-10-25T02:29:32.715Z"}
```

Filter further with any field the list offers, for example `published=true` or `kind=clip`. See [search, filter, sort and page](lists.md).

### More recipes in the other guides

| To | See |
|---|---|
| Send finished programmes from your media system into the library | [Uploads](uploads.md) |
| Be told when a file is in, with its checksum | [Notifications and webhooks](webhooks.md) |
| Push your schedule from your scheduling system | [Guide import and the EPG API](epg-api.md#1-push-programmes-from-your-own-system) |
| Put a player on your site with no code | [Embed the player](../guides/embedding.md) |
| Check playback quality from your own monitoring | [Playback reporting and the QoE API](playback-reporting.md) |

## Troubleshooting

| You see | Means | Do |
|---|---|---|
| `403` from the public guide or the play gate | The request came from a site the app does not allow | Add the site to the app; send `Origin` when testing with `curl` |
| `404 Channel not found` from the public guide | Not a channel or event of the key's account | Check the id and the key |
| The sync never ends | Your script is not reading the `Link` header's `rel="next"` | Stop when there is no `rel="next"`, as the example does |
| `curl: (3) bad range in URL` | `curl` read the `[...]` of a filter as a range | Use `curl -g` |
