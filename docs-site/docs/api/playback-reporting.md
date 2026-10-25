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
| `e` | An error | `ec` (your error code) |
| `bc` | Bitrate changed | `br` (kbps) |
| `b` | Went to or came back from the background | `bg` |
| `rr` | Response received, for a sample of requests and every slow or failed one | The CDN is read from it |

Name your app on any report with `com.volt-app` and `com.volt-appv` (and `com.volt-dm` for the device model), so the reports can be broken down by them.

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

The full answer has six parts: `success` (attempts, startup failures, exits before the first frame, failures after start, the errors with their codes), `startup` (percentiles, and where the time went: entitlement, manifest, DRM, first segment, decode), `buffering`, `quality`, `engagement`, and `telemetry` (how many reports arrived and how many were lost on the way). `GET /api/analytics/qoe/definitions` says exactly how each figure is worked out.

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

## Troubleshooting

| You see | Means | Do |
|---|---|---|
| `415 use Content-Type: application/cmcd` | The body was sent as JSON or form data | Send the lines as they are, with that content type |
| `400 no valid CMCD v2 event reports` | Every line was missing `v=2`, `e`, `ts` or `sid`, or `ts` was more than a day out | Check the device clock and the keys; `rejected` in the answer says why |
| `410 unknown publishable key` | The key was revoked or mistyped | Stop sending with it; use the app's current key |
| Reports accepted but the overview shows nothing | The play attempt has not been quiet for a minute yet, or the window or filters leave it out | Wait a minute; widen the window |
| `app_version` shows `null` | The reports did not name the app | Add `com.volt-app` and `com.volt-appv`, or the player's `cmcd` option |
| `403` reading reports | The user lacks **Analytics: View** | Use the secret key or a user with that access |
