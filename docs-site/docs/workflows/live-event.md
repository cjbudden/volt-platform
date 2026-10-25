---
title: A live event from start to finish
sidebar_position: 4
description: A scheduled event that is promoted before it starts, runs itself on air, is recorded and clipped, comes back as a replay and is reported on afterwards.
guide: workflow
---

# A live event from start to finish

A match, a concert, a launch or a town hall happens once, at a set time. This workflow takes one event through every section it touches: you schedule it, share a preview and put a countdown player on your website, Volt brings it on air for its window and records it, your editors clip the best moments and sign them off, the whole event comes back as a replay, and Analytics tells you who watched and how it ran.

## What it is for

Event managers and producers running anything that is not on around the clock. Without it, someone starts and stops the stream by hand, watches the clock to make it public, downloads the recording to cut highlights elsewhere and uploads the replay again afterwards. With it, the event's own window starts and stops the stream, the recording is already in Volt to clip, the replay is made for you when the recording closes, and the figures are there the next day.

## Before you start

- A channel group with room for the event, of the type you need: **Transcode** (you send one feed) or **Packaging** (you send a ladder you encode yourself) ([Channel Groups](../guides/channel-groups.md)).
- The source details from whoever sends the feed (SRT, RTMP, RTMPS, HLS, DASH, NDI or ST 2110), and the feed itself on the day. Volt cannot put an event on air, record it or make a replay without a real source sending to it.
- For the countdown player on your website, a registered web app with your domains allowed ([API Keys & Apps](../guides/api-keys-and-apps.md), [Embed the player](../guides/embedding.md)).
- For clips that must be signed off before they go out, **Require an approved review before publishing** under **Publish gate** in [Publishing Rules](../guides/publishing-rules.md) (or on the event's own **Access** tab, step 1).
- The access listed under [Who can do it](#who-can-do-it).

## The flow

![Events schedules the window and gives out a share link and a countdown player; the EPG lists what happens inside the window; the event goes on air for its public window; Recordings holds what went out; clips cut there pass through Review; the full event and the approved clips land in the Media Library; Analytics reports who watched and how it ran](/img/flows/live-event.svg)

The event's window is the schedule everything else follows. Before it starts, a share link gives a sponsor or producer a private preview, and the embed player shows your website's visitors a countdown that turns into the live player. The event's guide (optional) lists what happens inside the window. During the window Volt brings the stream up, makes it public and records it. Clips cut from the recording go to Review for a decision, and the full event comes back as one replay asset. Each run and each viewer is counted in Analytics.

| Step | Section | What happens |
|---|---|---|
| 1 | [Events](../guides/events.md) | The event is created with its on-air window, source, recording and **Automatic VOD on end** |
| 2 | [Events](../guides/events.md), [Share links](../guides/share-links.md), [Embed the player](../guides/embedding.md) | Before the start: a private preview link for approvals, and a player tag for your website that counts down to the start |
| 3 | [EPG](../guides/epg.md) | Optionally, the programmes inside the event (pre-match, first half, presentation), which name the parts of the recording |
| 4 | [Events](../guides/events.md) | The server comes up early so the source can be checked, viewers can watch inside the public window, and the stream stops when the window ends |
| 5 | [Recordings](../guides/recordings.md) | The event's recording is clipped while it runs or afterwards |
| 6 | [Review](../guides/review.md) | Clips sent for review are approved, sent back or rejected, with QC's findings beside them |
| 7 | [Media Library](../guides/media-library.md) | The full event arrives as a replay when the recording closes; the replay and the approved clips are published from here |
| 8 | [Analytics](../guides/analytics.md) | Who watched (Audience) and how the event ran against its window (Operating) |

## Step by step

### 1. Schedule the event

1. Open **Events** in the sidebar and choose **New event**.
2. Enter the **Event name** and choose the **Workflow**: **Transcode** or **Packaging**.
3. Under **Schedule**, set **On-air start** and **On-air end**, and choose **Spin up server early** (up to **1 hour before**): your time to receive and check the feed before anyone can watch.
4. Set the source: for **Transcode**, the **Primary source** and optionally a **Backup source**; for **Packaging**, one row per rendition under **Sent renditions**.
5. Choose the **Filler on total loss**, keep **Recording and clipping** on, set **Keep recordings for**, and keep **Automatic VOD on end** on for the replay.
6. Choose **Create event**. It is listed as **SCHEDULED**, with how long until it starts.
7. Open the event and choose **Settings** (the gear). The **Metadata** tab gives it a content type and details that the replay carries; the **Access** tab, now that the event exists, sets its own publishing rule: who can watch, where, whether it is paid, and the **Publish gate** for its clips and replay. Choose **Save publishing rule**.

Field by field: [Events](../guides/events.md) and [Publishing Rules](../guides/publishing-rules.md#override-it-for-a-content-type-a-stream-or-an-item).

### 2. Promote it before the start

Volt gives you two things to hand out before the event: a private preview, and a public player that counts down. Announcing the event on social platforms is done outside Volt; social accounts receive the replay and clips afterwards.

1. On the event's page, choose the share icon (**Share a private preview link**). Choose **Create a link** or **Send by email**, how long it lasts and **Who can open it**, then **Create link**. Copy the address: **The full link is shown once here**. The preview plays only while the stream is being produced, so tell a sponsor to open it once the server is up.
2. On the event's page, choose the player icon (**Embed player: countdown, Buy when paid, then the live player**). In the **Embed player** window, keep **Event player**: it shows a countdown before the start, a **Buy** button when the event is paid, becomes the live player when it goes live, and plays the replay afterwards. Pick the **App** whose key the tag uses and set the look and size. Under **Preview**, choose **Countdown**, **Paid**, **Postponed**, **Live** and **Replay** to see each phase. Copy the tag under **Tag** into your website.

The tag carries its own settings, so you can put it on several sites differently. Details: [Share links](../guides/share-links.md) and [Embed the player](../guides/embedding.md).

### 3. List what happens inside the window (optional)

1. Open **EPG**, choose **Events** and **Build** (or **Open**) on the event. Or, on the event's page, choose **Add EPG** on the programme guide panel. Move to the event's day with the date box.
2. Choose **Add programme** for each part of the event (for example "Pre-match", "First half", "Presentation") with its **Start**, **End** and details.
3. The parts show as now and next on the event's page (from a few hours before the start) and in the player, and name the parts of the recording, so one click in Recordings marks a whole part.

Details: [EPG](../guides/epg.md).

### 4. Go live

1. At the **Spin up server early** time, Volt starts the server by itself. To start sooner, choose **Start event** on its page (or **Start** on its row in **Events**).
2. **Schedule** on the event's page shows three bars: **Server**, **Event** and **Public**. Check the **Source** and **Output** players and the five gates while it is still private.
3. There is no button to go on air: the event is public while it is live inside its public window. **Realtime viewers** on the page counts who is watching.
4. When the window ends Volt stops it. **Stop event** ends it early.

Details: [Events](../guides/events.md#run-an-event) and [channel status](../guides/channel-status.md).

### 5. Clip the best moments

1. On the event's page, **Recordings** lists what it has recorded. Choose **Open in workbench** on the recording (or find the event under **Events** in **Recordings**). You can clip while the event is still live.
2. Play and scrub, set the in and out points (**I** and **O**, or drag on the clipping timeline), or click a part of the event in the metadata lane to mark it.
3. Enter a **Clip title**, choose an **Output** and choose **Create clip**. The clip appears in the **Media Library**.

Details: [Recordings](../guides/recordings.md#cut-a-clip).

### 6. Sign the clips off

1. Send each clip for review. The console has no button for this yet: send it with the API (see [Through the API](#through-the-api)).
2. Open **Review**. Each waiting clip shows its **QC** result. Open it, read **What was measured**, type a note in **A note for whoever reads this next…** and choose **Approve**, **Request changes** or **Reject**.

Details: [Review](../guides/review.md).

### 7. Publish the replay and the clips

1. When the recording closes after the event, the full event appears in the **Media Library** with the event's name and details (with **Automatic VOD on end** on). Choose the **Event** chip to see the event's assets.
2. Open the replay, go to **Availability** and choose **Publish**. The replay waits for you even when the rule has **Auto-publish**: it is published by hand.
3. Do the same for each approved clip. A clip whose rule has **Auto-publish** and no review gate is published as soon as it is built.
4. To post a clip or the replay to your social accounts, open its **History** tab and choose **Publish to social**.

No replay? Turn on recording and **Automatic VOD on end** for the next event, and for this one open the recording and choose **Publish full VOD**. Details: [Media Library](../guides/media-library.md#publish-it-or-take-it-off-availability).

### 8. Report on it

1. Open **Analytics**. **Audience** shows **Views**, **Unique viewers**, **Watch hours** and **Peak concurrent** for the window you choose, and the event and its replay under **Most watched**. Today's figures are **not final** until the day closes.
2. Choose **Operating**, then **Events**, and choose the event's row. **Availability** is its on-air time over its public window; the runs table says why each run stopped (**Schedule** when the window ended, **Operator** for **Stop event**, **Fault** if it failed).
3. **Download CSV** gives the same table for your report.

Details: [Analytics](../guides/analytics.md).

## Who can do it

One Event Manager can run most of it; an administrator sets up the pieces around it.

| Stage | Access needed |
|---|---|
| Create and change the event, its guide and recording settings | Events: Manage, EPG & schedules: Manage |
| Set the event's own publishing rule (the **Access** tab) | Account settings: Manage |
| Share a preview link | Share links: Manage |
| Get the embed player tag | API Keys & Apps: View |
| Start and stop the event | Events: Operate |
| Cut clips | Recordings & clips: Manage |
| Approve, request changes or reject in Review | Media library & publishing: Manage |
| Publish the replay and clips, post to social | Media library & publishing: Operate |
| Read Analytics | Analytics & reports: View |

The default Event Manager role covers the event, its guide, share links, clips, publishing and reading Analytics. It does not include the embed player, the event's **Access** tab or approving in Review: an Owner or Administrator does those, or gives a custom role the access. Roles are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **Not saved: No transcode group set up yet** | The account has no transcode group | Choose **Packaging**, or ask an administrator to add a transcode group |
| **Start event (no source)** | The event has no source | Open **Settings** and add the primary source |
| The share link's viewer sees **Preview not live right now** | The server is not up yet | Ask them to choose **Check again** after the **Spin up server early** time |
| The embed player says the site is not on the app's allowed origins | Your website's domain is not listed for the app | Add it in [API Keys & Apps](../guides/api-keys-and-apps.md) |
| Viewers get "not on air" before the start | The public window has not opened | Expected: the stream is private until then |
| **Nothing recorded yet. Recording starts when the event goes live.** | The event has not gone live | Wait for the start, or **Start event** |
| No replay in the Media Library | Recording or **Automatic VOD on end** was off, or the recording has not closed | Open the recording and choose **Publish full VOD** once it has closed |
| The replay is **Not published** | Replays are published by hand | Open it, choose **Availability** and **Publish** |
| Publishing a clip is refused because of review | The rule requires an approved review | Approve it in [Review](../guides/review.md) |
| **Nothing ran in this period** in Operating | The period does not include the event | Choose a period that does, and **Events** or **All** |

## Through the API

| Request | Does |
|---|---|
| `POST /api/events` | Creates the event with its window, source, recording and `autoVod` |
| `PUT /api/publishing-rules/owner/{eventId}` | Sets the event's own publishing rule |
| `POST /api/share-links` | Creates a preview link (`resourceKind: "event"`) |
| `POST /api/epg` | Adds a programme to the event's guide (`eventId`) |
| `POST /api/events/{id}/start`, `POST /api/events/{id}/stop` | Starts it before its spin-up time, or ends it early |
| `GET /api/events/{id}/detail` | The event with its gates, schedule and recordings |
| `POST /api/recordings/{id}/clip` | Cuts a clip from the event's recording |
| `POST /api/vod/{id}/review` | Sends a clip for review (`{"to": "in_review"}`) or decides on it |
| `GET /api/vod?event_id={eventId}` | The event's replay and clips |
| `POST /api/vod/{id}/publish` | Publishes the replay or a clip through its rule |
| `GET /api/reports/stream/{eventId}` | The event's runs, for the Operating report |
| `GET /api/analytics/overview` | Audience figures, with most watched |

This sends a clip for review, which puts it in the Review queue:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"to": "in_review"}' \
  "https://your-volt-host/api/vod/$CLIP_ID/review"
```

Every route is in the [API reference](/api-reference).
