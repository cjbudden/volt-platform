---
title: Live Streams
sidebar_position: 0.2
description: Every channel, station, event and FAST channel in one place, with the same health checks the detail pages show.
guide: section
---

# Live Streams

Live Streams shows every live thing in your account together: TV channels, radio stations, events and FAST channels. The **Board** puts what is running first, each with its five health gates; the **List** is for finding one stream in a large account; the **Timeline** lays the streams out against the clock with their programmes.

![The Live Streams board: counts across the top, then one row per running stream with its five gates](/img/screens/live-streams.png)

## What it is for

- **Watching the running fleet.** Each running stream has a row with its overall status, uptime, viewers, group and the five gates (**Server, Input, Encoder, Output, On air**), refreshed every ten seconds.
- **Finding a stream.** The **List** view searches by name, group or XMLTV id and filters by kind (**TV**, **Radio**, **Events**, **FAST**).
- **Seeing the day.** The **Timeline** view shows each stream's programmes around now, so you can see what is on and what is next on every stream at once.

It suits operators in a control room and anyone who looks after more than a few streams.

## Before you start

- At least one [channel](channels.md), [radio station](radio.md), [event](events.md) or [FAST channel](fast.md).
- **Live and monitoring: View**.

## Step by step

### Check the running streams

1. Open **Live Streams** in the sidebar. The **Board** view opens.
2. Read the counts: **On air**, **Encoders up**, **Watching now**, **Down**, **Degraded** and **Fleet**.
3. Read each row left to right. The first gate that is not green is usually where the problem is ([channel status](channel-status.md) explains every word).
4. Choose **Open** to go to the stream's page, or **Stop** to stop it.
5. Choose **Show N not running** to add the streams that are stopped or idle.

### Find one stream

1. Choose **List**.
2. Type in the search box (name, group or XMLTV id), or choose a kind: **All**, **TV**, **Radio**, **Events** or **FAST**.
3. Choose a row to open the stream.

### See what is on across every stream

1. Choose **Timeline**.
2. Pick how much to show around now: **−1h / +2h**, **−2h / +4h**, **−6h / +6h** or **−12h / +12h**. **Now** brings the ruler back to the present.
3. Drag the ruler to move through time. Streams are grouped by channel group, and a group with problems says how many need attention.
4. Drag along a row in the past to make a clip from that stretch of the recording, or in the future to add a programme to the guide.

The view you choose is remembered in your browser.

## How it connects

| Section | How it relates |
|---|---|
| [Channels](channels.md), [Radio](radio.md), [Events](events.md), [FAST](fast.md) | Every row is one of these; **Open** goes to its page |
| [Monitoring](monitoring.md) | The problems behind a red or amber gate are listed there |
| [Multiview](multiview.md) | Shows the pictures of the same running streams |
| [EPG](epg.md) | The **Timeline** shows each stream's guide, and adding a programme there writes to it |
| Recordings | A clip dragged out on the **Timeline** comes from the stream's recording |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See the board, list and timeline | Live and monitoring: View |
| Start or stop a stream from the board | Operate on that kind of stream (for example TV channels: Operate) |
| Add a programme from the timeline | EPG and schedules: Manage |
| Make a clip from the timeline | Recordings and clips: Manage |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| A stream is missing from the **Board** | It is not running | Choose **Show N not running**, or use **List** |
| **Down** is above zero | A running stream has a failed gate | Open it and choose **Diagnose**, or open [Monitoring](monitoring.md) |
| **Degraded** is above zero but every gate is green | One of the stream's outputs is not being delivered (for example a radio station's MP3 stream) | Open the stream and check its outputs |
| **updated** time stops moving | The page lost its connection to Volt | Choose **Refresh**, or reload the page |

## Through the API

`GET /api/live-streams` is the same list: every kind of stream, with the standard [list parameters](../api/lists.md) for searching, filtering and paging. Add `health=true` for each row's state, uptime and viewers.

```bash
curl -H "Authorization: Bearer $TOKEN" "https://your-volt-host/api/live-streams?kind=channel&health=true&limit=25"
```

`GET /api/live-streams/{kind}/{id}` answers one stream, and `GET /api/status/stream` pushes status changes as they happen. Every route is in the [API reference](/api-reference).
