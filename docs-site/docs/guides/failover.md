---
title: Input failover
sidebar_position: 2
description: Keep the output live when a source fails, with a backup source and a slate or loop filler, and test it before you go on air.
---

# Input failover

Failover keeps your output live when a source fails. Viewers see the backup source, or a slate or loop, instead of a dead screen.

## How it works

The order of preference is always: **primary, then backup, then filler**.

1. The **primary source** feeds the output normally.
2. If the primary fails and you have a **backup source**, the output switches to the backup and stays live.
3. If there is no backup, or the backup also fails, the output switches to the **filler**: a slate image, a loop video, or another option you choose.
4. When a real source returns, the output leaves the filler straight away.
5. When the primary recovers, the output can return to it automatically (**failback**), after a short hold so it does not bounce back onto a feed that is still unstable.

A source has to look healthy for a few seconds before it counts as up, and look dead for a couple of seconds before it counts as down. A brief network hiccup does not cause a switch.

Failover works on both transcode and packaging channels.

## Set it up

Open the channel and choose **Settings**. The channel must be stopped to change these.

| Setting | What it does |
|---|---|
| **Backup source (optional)** | A second feed of the same content, ideally from a different path |
| **Enable input failover** | Switches to the backup, then the filler, when the primary fails |
| **Auto failback to primary** | Returns to the primary once it has been healthy for a short hold. Off keeps the output on the backup until you move it. |
| **Filler on total loss** | What viewers see when no source is available |

### Filler options

| Option | Viewers see |
|---|---|
| **None (output stops)** | Nothing. The output stops. |
| **Slate image** | A still image, for example "We'll be right back" |
| **Loop video** | A short video, looped until a source returns |
| **Freeze last frame** | The last picture received |
| **Black** | A black screen |

For a slate, pick an image from the library or upload one. For a loop, pick a loop asset. If you choose **Loop video** but only set a slate image, Volt makes a loop from the slate with a gentle zoom, so it is not a still frame.

## Test it before you go on air

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

## What failover looks like in the status

| You see | Means |
|---|---|
| Input **DEGRADED**, overall **DEGRADED** | The backup is on air |
| Input **NO SIGNAL** | Every source is lost and the filler is on air |

See [channel status](channel-status.md) for every status.
