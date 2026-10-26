---
title: Playback reporting and the QoE API
sidebar_position: 6
description: How players report what viewers saw, how to report from a player of your own, and how to read the playback experience reports from your systems.
guide: developer
---

# Playback reporting and the QoE API

Volt measures the playback experience (did it start, how fast, did it stall, at what quality) from what each player reports, in the open CMCD v2 standard. The Volt player reports by itself. This page shows how a player of your own can report the same way, and how to read the reports from your own systems.

## What it is for

- **Your own dashboards and alerts.** Pull the same figures as **Analytics > Playback** in the console: startup failures, startup time, rebuffering, quality, errors.
- **Finding what is broken.** Rank app versions, device models, countries or networks by how badly they do.
- **Answering "what happened to this viewer?"** Read one play attempt's reports in order, with the play gate's answer and the ad beacons for it.
- **Players that are not the Volt player** (a native TV app, a partner's player) counted in the same reports.

## Before you start

- To send reports: an app's publishable key (see [Getting started with apps and keys](apps-and-keys.md)).
- To read reports: an account secret key, or an admin user with **Analytics: View**.
- With the Volt player there is nothing to send: it reports from the moment it asks the [play gate](play-gate.md), so a refused entitlement or a failed licence is counted too. Name your app with the player's [`cmcd` option](../guides/player-sdk.md#playback-reporting-and-drm) so releases can be told apart.

## Step by step

### 1. Send reports from your own player

Post CMCD v2 **event reports**, one per line, to the collector with your publishable key. Each line needs `v=2`, `ts` (milliseconds), `e` (the event), and `sid` (one id per play attempt); `sn` numbers the reports of an attempt so lost ones can be counted.

```bash file=playback-reporting/send-reports.sh
```

| `e` | Report | Keys Volt reads |
|---|---|---|
| `ps` | Play state changed. `sta` is the new state: `s` starting, `p` playing, `r` rebuffering, `k` seeking, `a` paused, `e` ended, `q` the viewer quit, `f` a fatal error | `sta`, `cid` (the asset id), `st` (`l` live or `v` on demand) |
| `t` | Heartbeat, every 30 seconds | `bl` (buffer, ms), `mtp` (throughput), `ltc` (live latency), `pb` and `tpb` (bitrate and top bitrate, kbps), `dfa` (dropped frames) |
| `e` | An error | `ec` (your error code), `com.volt-step` (where: `entitlement`, `manifest`, `drm`, `segment`, `decode`, `playback`), `com.volt-http` (the HTTP status when a request was refused) |
| `bc` | Bitrate changed | `br` (kbps) |
| `b` | Went to or came back from the background | `bg` |
| `pr` | Playback rate changed | `pr` (1 is normal speed; above 1 is catching up to live) |
| `abs`, `abe` | An ad break started, ended | `com.volt-brk` (the break's id) |
| `rr` | Response received, for a sample of requests and every slow or failed one | `rc`, `ttlb`; the CDN is read from it. Mark licence requests with `com.volt-req=licence` |

Name your app on any report with `com.volt-app` and `com.volt-appv` (and `com.volt-dm` for the device model, `com.volt-hwdec` for hardware decoding, `com.volt-drm` for the DRM system), so the reports can be broken down by them.

Send the same `sid` to the [play gate](play-gate.md) when you ask it for the stream: its answer is then joined to the view, so a refusal is reported with its reason (region, rights window, payment, sign in). Time between an ad break's start and end is counted as the ad's, not the programme's.

Send batches every few seconds rather than one request per report, at most 200 lines a request. Answers follow the CMCD collector rules:

| Status | Means |
|---|---|
| `204` | Received |
| `400` | No line was a valid v2 event report (the answer lists the first few reasons) |
| `410` | Stop reporting: the key is not a publishable key Volt knows |
| `413` | More than 200 lines |
| `415` | Send `Content-Type: application/cmcd` |
| `429` | Too fast for one play attempt. Wait as long as `Retry-After` says, then send a bigger batch |

A view closes when its play attempt goes quiet for a minute, and then appears in the reports.

### 2. Read the overview

```bash file=playback-reporting/overview.sh
```

```json
{
  "attempts": 1,
  "startupFailureRate": 0,
  "startupP95ms": 850,
  "rebufferRatio": 0
}
```

The full answer has ten parts: `success` (attempts, startup failures, exits before the first frame, failures after start, the errors with their codes), `startup` (percentiles, and where the time went: entitlement, manifest, DRM, first segment, decode), `buffering`, `quality`, `rendering` (dropped frames per minute of playing, decoder errors, hardware decoding, DRM systems, by device), `access` (the play gate's decisions by reason and how long they took, failed views attributed to the step and the gate's reason, licence time and failures, tokens refused mid-view), `live` (latency behind live, drift during a view and catching up, by device), `ads` (breaks, ad startup, buffering in breaks, return to the programme, viewers who left during an ad, and the stitcher's beacons), `engagement`, and `telemetry` (how many reports arrived and how many were lost on the way). `GET /api/analytics/qoe/definitions` says exactly how each figure is worked out.

**The window:** `days`, `hours`, or `from` and `to` (ISO 8601). One day if you send none.

**Filters**, any of: `content_id`, `stream_type` (`live` or `vod`), `device_model`, `device_class`, `os`, `os_version`, `browser`, `browser_version`, `app_name`, `app_version`, `sdk_version`, `player_version`, `codec`, `cdn`, `country`, `region`, `asn`, `network`. Values are comma separated; `__none` means "not reported". `GET /api/analytics/qoe/dimensions` lists the values seen for each.

### 3. Find the worst segments

```bash file=playback-reporting/breakdown.sh
```

```json
{
  "by": "app_version",
  "measure": "failure",
  "label": "Startup failure rate",
  "minViews": 1,
  "rows": [{ "value": "2.1.0", "views": 1, "sessions": 1, "affected": 0, "measure": 0, "name": null }]
}
```

`by` is any filter above. `measure` is one of `failure`, `ebff` (exits before the first frame), `fatal` (failures after start), `stalls`, `rebuffer`, `startup_p95` and `bitrate`. Values with fewer than `minViews` views (20 unless you say) are left out, so one bad phone does not top the list. For `content_id`, `name` is the channel, event or asset name.

For trend lines, `GET /api/analytics/qoe/series` returns minute buckets for the same window; only `content_id`, `stream_type`, `country`, `device_class` and `cdn` filter it.

### 4. Follow one session

```bash file=playback-reporting/session.sh
```

```json
{
  "sid": "attempt-1792975000-12345",
  "reports": 3,
  "missingSequence": [],
  "spans": [{ "state": "starting", "ms": 850 }, { "state": "playing", "ms": 30150 }],
  "events": ["Play pressed", "First frame", "Heartbeat: buffer 9.0 s"]
}
```

`GET /api/analytics/qoe/sessions` lists views, newest first, with the same window and filters as the overview; `problem` narrows it to `error` (ended by an error), `failed` (never started), `stalled`, `exited` (left before the first frame) or `ad` (left during an ad). `GET /api/analytics/qoe/sessions/{sid}` returns every report of that play attempt in the player's order (`events`, each with `label`, `kind`, `problem`, `offsetMs`), the states as `spans`, the reports that never arrived (`missingSequence`), the view rows made of them (`views`), the play gate's answers for it (`gate`) and the server-side ad beacons sent for it (`beacons`). Another account's session answers `404`.

### 5. Journey to play: how viewers got to the play button

Volt can join the way a viewer reached a play (the app opened, a row, a detail page, search, a deep link or a push) to what happened after it: the play gate, payment, the startup and the watch time. It is not a general analytics tool: a fixed set of about ten events, and Google Analytics or your own tool keeps doing page analytics. The Volt SDK sends them with `VoltJourney` (see [Player SDK](../guides/player-sdk.md#journey-to-play)); an app of its own posts them as JSON lines with its publishable key:

```bash file=playback-reporting/send-journey.sh
```

```
HTTP 204
```

The events are `app_open` (`launch`: `icon`, `deeplink`, `push`; `cold`), `screen` (`name`, `type`: `home`, `browse`, `detail`, `search`, `player`, `account`, `other`; `cid` for a page about one title), `content_select` (`cid`, `entry`: `row`, `search`, `deeplink`, `push`, `epg`, `continue`, `related`, `other`; `ed` the row or campaign; `pos`), `search` (`n` results; `qh` a SHA-256 of the query, never the query), `paywall_show` and `purchase` (`product`, `outcome`: `success`, `failed`, `cancelled`), `play_intent` (`sid`, the play attempt's CMCD `sid`), `background`, `foreground`, `app_close` and `track` (`name` like `trailer_play`, up to ten short `props`). Every event has `v: 1`, `ts`, `asid` (one per app session) and `sn`; `jid` names the journey from the select (or deep link) on. Anything else in an event is not kept, and the answer says how many fields were left out (`x-journey-dropped-fields`).

So that each view also knows its journey, put the same ids on the play attempt's first CMCD report: `com.volt-jid`, `com.volt-asid`, `com.volt-entry` and `com.volt-depth` (the screens seen before the play). Reports 1 to 10 then filter by `entry_point` and `session_depth` (`2`, `3-5`, `6+`).

```bash file=playback-reporting/journeys.sh
```

```json
{
  "sessions": 1,
  "steps": [{ "step": "open", "sessions": 1 }, { "step": "browse", "sessions": 1 }, { "step": "detail", "sessions": 1 }, { "step": "play", "sessions": 1 },
            { "step": "entitled", "sessions": 0 }, { "step": "paid", "sessions": 0 }, { "step": "first_frame", "sessions": 0 }]
}
{
  "rows": [{ "entry": "row", "detail": "Trending", "journeys": 1, "plays": 1, "watchMs": 0 }]
}
```

`GET /api/analytics/qoe/journeys` is the funnel over app sessions that opened in the window: each step with `sessions`, `dropOff`, `fromPrevious` and `msSinceOpen` (`p50`, `p95`), plus `openToFirstFrame`, `paywall` (`shown`, `purchased`, `abandoned`) and `refusedByGate`. A session counts at a step when it got there or further, so a deep link straight to a detail page has passed browse. `GET /api/analytics/qoe/discovery` gives per entry point (`by=detail`: per row or campaign) the journeys, `plays`, `started`, `watchMs`, `completion`, `startupFailureRate`, `startupP50` and `rebufferRatio`, and `neverPlayed`: titles whose detail page was viewed in an app session and not played in it. Both take the window, `entry_point` and the app's own filters (`app_name`, `app_version`, `os`, `browser`, `device_class`, `country`). In the example the play is still waiting for its CMCD reports, so it has not passed the gate yet.

## Troubleshooting

| You see | Means | Do |
|---|---|---|
| `415 use Content-Type: application/cmcd` | The body was sent as JSON or form data | Send the lines as they are, with that content type |
| `400 no valid CMCD v2 event reports` | Every line was missing `v=2`, `e`, `ts` or `sid`, or `ts` was more than a day out | Check the device clock and the keys; `rejected` in the answer says why |
| `410 unknown publishable key` | The key was revoked or mistyped | Stop sending with it; use the app's current key |
| Reports accepted but the overview shows nothing | The play attempt has not been quiet for a minute yet, or the window or filters leave it out | Wait a minute; widen the window |
| `app_version` shows `null` | The reports did not name the app | Add `com.volt-app` and `com.volt-appv`, or the player's `cmcd` option |
| `403` reading reports | The user lacks **Analytics: View** | Use the secret key or a user with that access |
| `access.failures` says `not in the gate log` | The view failed at the entitlement step but the gate has no answer for its `sid` | Send the same `sid` to the play gate's `POST` |
| `404` for a session | Not in your account, or its raw reports are no longer kept | Use a recent `sid` from `GET /api/analytics/qoe/sessions` |
| `400 no valid journey events` | Every event lacked `v: 1`, `ts`, `asid` (8 to 64 letters, digits, `.`, `_`, `:` or `-`), named an event outside the set, or a `content_select` had no `jid` | `rejected` in the answer says why |
| `415 use Content-Type: application/x-ndjson` | The journey events were sent as form data or text | One JSON event per line with that type, or a JSON array as `application/json` |
| `x-journey-dropped-fields` on a `204` | Fields outside the event set were left out (a plain search query, an e-mail address) | Remove them; send `qh`, a SHA-256 of the query, if you want searches grouped |
| A play in the funnel never passes **entitled** | No CMCD view arrived for its `sid` | Send the same `sid` in `play_intent` and in the player's reports |
