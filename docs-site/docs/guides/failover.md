---
title: Input failover
sidebar_position: 2
description: Keep the output live when a source fails, with a backup source and a slate or loop filler, and test it before you go on air.
guide: section
---

# Input failover

Failover keeps your output live when a source fails. Viewers see the backup source, or a slate or loop, instead of a dead screen.

## What it is for

Anyone running a channel or event that must not go dark: a 24/7 channel, a paid event, a news feed.

### How it works

The order of preference is always: **primary, then backup, then filler**.

1. The **primary source** feeds the output normally.
2. If the primary fails and you have a **backup source**, the output switches to the backup and stays live.
3. If there is no backup, or the backup also fails, the output switches to the **filler**: a slate image, a loop video, or another option you choose.
4. When a real source returns, the output leaves the filler straight away.
5. When the primary recovers, the output can return to it automatically (**failback**), after a short hold so it does not bounce back onto a feed that is still unstable.

A source has to look healthy for a few seconds before it counts as up, and look dead for a couple of seconds before it counts as down. A brief network hiccup does not cause a switch.

Failover works on both transcode and packaging channels.

## Before you start

- A [channel](channels.md) or [event](events.md), stopped: failover settings are read when it starts.
- A second feed of the same content for the backup, ideally over a different path.
- A slate image or loop video in **Loops & Fillers**, if you want one as the filler.
- **TV channels: Manage** (or **Events: Manage**) to change the settings.

## Step by step

### Set it up

Open the channel and choose **Settings**. The channel must be stopped to change these.

| Setting | What it does |
|---|---|
| **Backup source (optional)** | A second feed of the same content, ideally from a different path |
| **Enable input failover** | Switches to the backup, then the filler, when the primary fails |
| **Auto failback to primary** | Returns to the primary once it has been healthy for a short hold. Off keeps the output on the backup until you move it. |
| **Filler on total loss** | What viewers see when no source is available |

#### Filler options

| Option | Viewers see |
|---|---|
| **None (output stops)** | Nothing. The output stops. |
| **Slate image** | A still image, for example "We'll be right back" |
| **Loop video** | A short video, looped until a source returns |
| **Freeze last frame** | The last picture received |
| **Black** | A black screen |

For a slate, pick an image from the library or upload one. For a loop, pick a loop asset. If you choose **Loop video** but only set a slate image, Volt makes a loop from the slate with a gentle zoom, so it is not a still frame.

### Test it before you go on air

The **Failover control** panel on the channel page lets you prove each path while the channel is running. Force a path, watch the **Output** player switch within a second or two, then return to normal.

| Button | Forces |
|---|---|
| **Simulate primary loss** | The primary is treated as down, so Volt picks the best remaining source |
| **Slate** | The slate filler |
| **Loop** | The loop filler |
| **Backup source** | The backup input |
| **Resume normal** | Back to automatic, health-driven behaviour |

You can also use these buttons on purpose during a broadcast, for example to move off a primary you know is about to have work done on it.

The controls become available once the channel is started. While it runs, automatic failover is always armed.

## How it connects

| Section | How it relates |
|---|---|
| [Channels](channels.md) and [Events](events.md) | Where the backup source and filler are set. **Failover control** is on the channel page. |
| Loops & Fillers | The slate and loop videos used as filler |
| [Channel status](channel-status.md) | A stream on its backup shows **DEGRADED** |
| [Monitoring](monitoring.md) | Lists a stream running on its backup or filler |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| Set the backup source and filler | TV channels: Manage (Events: Manage for an event) |
| Use **Failover control** on a channel | TV channels: Operate |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

### What failover looks like in the status

| You see | Means |
|---|---|
| Input **DEGRADED**, overall **DEGRADED** | The backup is on air |
| Input **NO SIGNAL** | Every source is lost and the filler is on air |

See [channel status](channel-status.md) for every status.

### Common cases

| You see | What it means | What to do |
|---|---|---|
| The failover settings cannot be changed | The channel is running | Stop it, change them, start it again |
| **Failover control** buttons are unavailable | The channel is not started | Start it; the controls work while it runs |
| The output stays on the backup after the primary returns | **Auto failback to primary** is off, or the primary has not been healthy for the hold yet | Wait, turn on auto failback, or choose **Resume normal** |
| Viewers see black or nothing on total loss | The filler is **Black** or **None (output stops)** | Choose a slate image or loop video |

## Through the API

| Request | Does |
|---|---|
| `PATCH /api/channels/{id}` | Sets the backup source and failover settings |
| `GET /api/channels/{id}/filler` and `POST` | Reads and sets the filler |
| `GET /api/channels/{id}/failover-test` | The forced path, if any |
| `POST /api/channels/{id}/failover-test` | Forces a path, or returns to normal, as **Failover control** does |

Events have the same filler routes under `/api/events/{id}/filler`. Every route is in the [API reference](/api-reference).
