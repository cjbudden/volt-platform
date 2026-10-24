---
title: Multiview
sidebar_position: 0.4
description: Confidence monitors on what viewers are actually given, for every running stream on one wall.
guide: section
---

# Multiview

Multiview is a wall of confidence monitors: one tile per running stream, playing what viewers are given. Health checks can be green while the picture is wrong (the wrong programme, a frozen frame, no sound), and only looking tells you that.

![Multiview: the output and viewer location choices, grid size, and a tile per running stream](/img/screens/multiview.png)

## What it is for

- **Seeing and hearing every stream at once.** Each tile shows the stream's name, status and viewers, with flags for the source (for example **NO SOURCE**) on the left and the output (for example **PRIVATE**) on the right.
- **Seeing what a viewer in another country gets.** **Viewer location** plays each tile as a viewer in that country would receive it, so a programme blocked or replaced there shows as it really is.
- **Telling an encoder fault from a delivery fault.** **Output: delivered** plays what viewers get; **Output: packager** plays the packaged files before delivery.

Control rooms keep it on a wall display; operators open it before and during an important broadcast.

## Before you start

- At least one running stream. Tiles appear for streams that are doing work; stopped streams are left off.
- **Live and monitoring: View**.

## Step by step

### Watch the wall

1. Open **Multiview** in the sidebar.
2. Choose a grid size: **Auto** fits the screen, or **2×**, **3×** or **4×** columns.
3. Choose **Monitor** (or **Play**) on a tile, or **Monitor page** to play every tile on the page. Tiles start paused and muted, and at most nine play at once, because every playing tile is a separate decode.
4. Choose the speaker on a playing tile to hear it. One tile is heard at a time; choosing another moves the sound there.
5. **Stop all** pauses every tile.

### Check what a viewer in another country gets

1. Open **Viewer location** and pick a country, or **Unknown country** for a viewer whose location cannot be told.
2. Every tile now plays the version a viewer there is given, and its lower corner says what that viewer gets: **ALLOWED**, **REPLACED** or **BLOCKED**, and until when.
3. Set it back to **Viewer location: any** when you are done.

### Find where a playback problem is

1. If a tile does not play, switch **Output** to **packager**. If it plays now, the stream is being produced and the problem is in delivery; if not, look at the stream's encoder and source.
2. Right-click a tile, or hold the pointer over it and press Cmd+D (Ctrl+D on Windows), for debug mode: it says whether the problem is the stream or this connection.
3. Choose the stream's name under a tile to open its page.

## How it connects

| Section | How it relates |
|---|---|
| [Live Streams](live-streams.md) | The same running streams, as health gates instead of pictures |
| [Channels](channels.md), [Radio](radio.md), [Events](events.md) | A tile is one of these; its page has the source and output players |
| [EPG](epg.md) | Rights windows in the guide decide what **Viewer location** shows |
| [Monitoring](monitoring.md) | Where the problems a tile shows are listed |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| Watch the wall, change location and output | Live and monitoring: View |

Watching changes nothing on the stream. Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **Nothing to monitor** | No channel, station or event is producing output | Start a stream; its tile appears as soon as it starts, before it goes on air |
| **Play** is not available on a tile | Nine tiles are already playing | Pause one, or choose **Stop all** |
| A tile plays but there is no sound | Only one tile is heard at a time, and tiles start muted | Choose the speaker on that tile |
| **NO SOURCE** on a tile | The stream is running but its source is not arriving | Check the sender, or the stream's backup source |
| **NO REPORT** with a time | Volt has not heard from the stream's encoder for that long | Choose the stream's name to open it and check its gates |
| **PRIVATE** on a tile | The stream is not on air, so viewers get nothing yet | Expected before **Go on air**. With **Output: delivered**, a private stream plays its preview. |
| **BLOCKED** or **REPLACED** on a tile | A rights window blocks or replaces the programme for that country now | Check the programme's rights in the [EPG](epg.md) |

## Through the API

There is no separate route for the wall. It plays each stream's output URLs, which `GET /api/live-streams/{kind}/{id}` and the stream's own page list, and its tile states come from `GET /api/live-streams?health=true`. Every route is in the [API reference](/api-reference).
