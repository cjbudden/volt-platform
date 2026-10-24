---
title: Events
sidebar_position: 2.2
description: Scheduled one-off broadcasts that start and stop themselves, record, and can publish a replay.
guide: section
---

# Events

An event is a live broadcast with a start and an end: a match, a concert, a briefing. You set its window and its source, and Volt starts the stream before the window, makes it public for the window, stops it afterwards, records it and, if you want, publishes the whole event as an on-demand replay.

![The Events list: status filters, list and calendar views, then one row per event with its window, status, recording and replay settings](/img/screens/events.png)

## What it is for

- **Scheduling broadcasts.** An event runs itself: the server comes up early so you can check the source, viewers can watch inside the window, and it stops when the window ends.
- **Running them.** The event's page has the same five gates, source and output players and logs as a channel, plus its schedule.
- **Keeping what was broadcast.** Recording keeps the event as one recording to review and clip, and **Automatic VOD on end** publishes the full event when it closes.

Event managers and producers use it for anything that is not on around the clock.

## Before you start

- A channel group with room in it, of the type you want (transcode or packaging).
- The source details from whoever is sending the feed: SRT, RTMP, RTMPS, HLS, DASH, NDI or ST 2110.
- **Events: Manage** to create an event.

## Step by step

### Schedule an event

1. Open **Events** in the sidebar and choose **New event** (or **New Stream > Event**).
2. Enter the **Event name** and choose the **Workflow**: **Transcode** or **Packaging**.
3. Under **Schedule**, set **On-air start** and **On-air end**.
4. Choose when to **Spin up server early**: from **at the on-air time** up to **1 hour before**. That is your time to receive and check the source before viewers can watch.
5. For **Transcode**, under **Source**, set the **Primary source** and, optionally, a **Backup source**. For **Packaging**, under **Sent renditions**, add one row per rendition you send: its label, bitrate, protocol and address. **Check source** tests each one.
6. Choose the **Filler on total loss**, **Recording and clipping** with how long to keep it, and **Automatic VOD on end**.
7. The **Metadata** and **Access** tabs set what the event is and who can watch it.
8. Choose **Create event**. It is listed as **SCHEDULED**, with how long until it starts.

### Run an event

1. Open the event. **Schedule** shows three windows on one bar with a marker for now: **Server** (when the encoder is up), **Event** (the scheduled window) and **Public** (when viewers can play it).
2. Volt starts the server at the early spin-up time. To start sooner, choose **Start event** on the page, or **Start** on its row in the list.
3. Check the **Source** and **Output** players and the five gates ([channel status](channel-status.md)).
4. There is no **Go on air** button: an event is public while it is live inside its public window.
5. When the window ends Volt stops it. **Stop event** ends it early.

### After the event

1. **Recordings** on the event's page lists what it recorded, with a link to clip it.
2. With **Automatic VOD on end**, the full event is published to the Media Library when the recording closes, with the event's details carried over.

### Find events

- Filter by **Live**, **Upcoming** or **Ended**, and sort by date or name.
- Choose **Calendar** to see events by day. Choose one to open it.

### Change or delete an event

1. Choose **Settings** (the gear in the header) on the event's page to change it.
2. **Delete event** at the bottom of its page removes the event with its recordings and clips. A live event has to be stopped first.

## How it connects

| Section | How it relates |
|---|---|
| [EPG](epg.md) | An event can have its own programme guide, with rights windows and clips |
| Recordings | An event's recording is reviewed and clipped there |
| Media Library | **Automatic VOD on end** publishes the full event there |
| Loops & Fillers | What the event shows when every source is lost |
| [Live Streams](live-streams.md), [Monitoring](monitoring.md), [Multiview](multiview.md) | Where a running event is watched with everything else |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See events and their pages | Events: View |
| Start and stop an event, clear QC | Events: Operate |
| Create, change and delete events | Events: Manage |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **Not saved: No transcode group set up yet** | The account has no transcode group, and the form starts on **Transcode** | Choose **Packaging**, or ask an administrator to add a transcode group |
| **Not saved: Add at least one rendition input** | A packaging event needs the renditions you send | Fill in the label and address of at least one rendition |
| **Start event (no source)** | The event has no source set | Open its settings and add the primary source |
| **No input source is configured** | The same: the event cannot start without one | Add a source in the event's settings |
| The public window starts after the event | The **Public** bar on the schedule misses the start | Check the event's times and access settings |
| Viewers get "not on air" before the start | The public window has not opened yet | Expected. The stream is private until then. |
| No replay after the event | **Automatic VOD on end** is off, or recording was off | Turn both on for the next event; clip the recording by hand from Recordings |
| **Delete event** is not shown | The event is live, or you do not have Events: Manage | Stop it first |

## Through the API

| Request | Does |
|---|---|
| `GET /api/events` | Lists events |
| `POST /api/events` | Creates an event |
| `GET /api/events/{id}/detail` | The event with its gates, schedule and recordings |
| `PATCH /api/events/{id}` | Changes it |
| `POST /api/events/{id}/start` and `/stop` | Starts it now, or ends it early |
| `DELETE /api/events/{id}` | Deletes it (stop it first) |

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" "https://your-volt-host/api/events/$EVENT_ID/start"
```

Every route, with its fields, is in the [API reference](/api-reference).
