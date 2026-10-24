---
title: Channels
sidebar_position: 0.5
description: Create 24/7 live channels, connect their sources, start and stop them, and put them on air.
guide: section
---

# Channels

A channel is a live stream that runs around the clock: a source comes in, Volt produces adaptive HLS and DASH outputs, and viewers watch through your players and apps. **Channels** lists them all; each channel's page is where you start it, check its source and output, put it on air and change its settings.

![The Channels list: type and status filters, then one row per channel with its type, status and a Start or Stop button](/img/screens/channels.png)

## What it is for

- **Creating channels.** Name, logo, type, group, sources, output ladder, filler, subtitles, watermark, catch-up and recording.
- **Running them.** Start and stop, check the source and output side by side, go on air and come off air.
- **Watching their health.** Each channel's five gates (**Server, Input, Encoder, Output, On air**), its event log and its viewers.
- **Handing out the stream.** Private monitoring URLs, public playback URLs, the embed player and share links.

There are two types:

| Type | Use it when |
|---|---|
| **Transcode** | You send one high-quality source and want Volt to build every output size for you |
| **Packaging** | You already send a full ladder of encoded renditions and want Volt to package them as they are |

A channel belongs to a **channel group**, and the group decides which type it is. FAST channels, which are played out from the library, are listed under [FAST](fast.md) instead.

## Before you start

- A channel group with room in it (**Admin > Channel Groups**). The form says when there is no group of the type you picked, or when a group is full.
- A source you can send to Volt or point Volt at: SRT, RTMP, RTMPS, HLS, DASH, NDI or ST 2110.
- **TV channels: Manage** to create a channel. [Set up your first channel](../getting-started/first-channel.md) is a walk-through from nothing to on air.

## Step by step

### Create a channel

1. Open **Channels** in the sidebar and choose **New channel** (or **New Stream > 24x7 channel** in the top bar).
2. Enter a **Channel name** and, if you have one, a logo (**Browse / upload…**).
3. Choose **Transcode** or **Packaging**, and a **Group**.
4. For **Transcode**, under **Source**, choose the **Primary source** protocol and fill in its address. For **Packaging**, add one row per rendition you send instead: its label, bitrate, protocol and address. For SRT, choose **Caller (we connect)** or **Listener (it connects)**, and set the latency and passphrase to match the sender. **Check source** tests it before you save.
5. Optionally add a **Backup source** (see [input failover](failover.md)).
6. Choose the **Output rendition ladder** (transcode only), a **Watermark**, the **Filler on total loss**, **Subtitles**, the **DVR window** (how far viewers can rewind) and whether to keep **Recording and clipping**.
7. The **Metadata** and **Access** tabs set the channel's descriptive details and who can watch it. Both can be filled in later.
8. Choose **Create channel**. If something stops the channel being created, the reason is shown at the bottom of the form.

### Start a channel and check it

1. Open the channel from the list.
2. Choose **Start channel**. Volt asks you to confirm, because a running channel is metered from that moment. No source yet? **Start with test source** runs the channel on a test picture so you can check the output.
3. Watch the five gates turn from grey to blue and then green ([channel status](channel-status.md) explains every word).
4. The **Source** player shows what Volt is receiving and the **Output** player what it is producing. Check picture, sound and subtitles. The stream is still private.

### Go on air and off air

1. When the output is valid, choose **Go on air**. The public URLs open and the status changes to **ON AIR**.
2. **Take off air** closes the public URLs; the channel keeps running and the preview keeps playing.
3. **Stop channel** brings the whole channel down. Viewers lose the stream.

You can also start and stop channels from the list: the **Start** or **Stop** button on a row, or tick several rows and use the bar that appears.

### Change a channel's settings

1. Open the channel and choose **Settings** (the gear in the header).
2. Change what you need and save. Sources, failover, filler, catch-up, the output ladder, subtitles and the watermark are read when the channel starts, so stop the channel first to change them.

### Hand out the stream

- **Output URLs** on the channel page: **Private monitoring** URLs play whenever the channel is producing, for checking only; **Public playback** URLs are what viewers and apps use, and answer "not on air" until the channel is on air.
- **Share** makes a private preview link for a colleague or client.
- **Embed player** gives the code to put the channel on a web page ([embedding](embedding.md)).
- **Rights preview** shows what a viewer with a given country, rights class and time is given, and why, and plays exactly that version.

### Remove a channel

1. Stop the channel.
2. At the bottom of its page choose **Remove channel**. Volt lists the recordings, clips and guide that go with it and asks you to type the channel's name.

## How it connects

| Section | How it relates |
|---|---|
| Channel Groups | A channel's group decides its type and counts towards the plan's channel limit |
| Loops & Fillers | The slate or loop a channel shows when every source is lost |
| [EPG](epg.md) | The channel's programme guide: now and next, rights windows, what is recorded and clipped |
| Graphics and Captions | Overlays and live subtitles on the channel's output |
| Recordings and Media Library | A recorded channel can be clipped, and clips published as on-demand assets |
| [Live Streams](live-streams.md), [Monitoring](monitoring.md), [Multiview](multiview.md) | Where a running channel is watched alongside everything else |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See channels and their pages | TV channels: View |
| Start, stop, go on air, test failover, clear QC | TV channels: Operate |
| Create a channel and change its settings | TV channels: Manage |
| Remove a channel | Owner or Administrator |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **New channel** is unavailable, with a reason beside it | The plan or every group is at its channel limit | Remove a channel, choose another group, or ask for a higher limit |
| **No transcode group yet** under **Transcode** | The account has no group of that type | Pick **Packaging**, or ask an administrator to add a transcode group |
| **Go on air** is unavailable | The output is not valid yet, or there is an error to resolve first | Wait for **READY**, or choose **Diagnose** |
| A setting cannot be changed | The channel is running | Stop it, change the setting, start it again |
| **Remove channel** is unavailable | The channel is running, or you are not an owner or administrator | Stop it first, or ask an administrator |
| The channel stays **STARTING** | The source is not arriving | See [channel status](channel-status.md) |

## Through the API

| Request | Does |
|---|---|
| `GET /api/channels` | Lists channels |
| `POST /api/channels` | Creates a channel |
| `GET /api/channels/{id}` | One channel |
| `PATCH /api/channels/{id}` | Changes its settings |
| `POST /api/channels/{id}/start` and `/stop` | Starts and stops it |
| `POST /api/channels/{id}/air` | Takes it on air (`{"on": true}`) or off air (`{"on": false}`). Going on air is refused until the output is valid. |
| `GET /api/channels/{id}/delete-impact` | What would be removed with it |
| `DELETE /api/channels/{id}` | Removes it |

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" "https://your-volt-host/api/channels/$CHANNEL_ID/start"
```

Every route, with its fields, is in the [API reference](/api-reference).
