---
title: A 24/7 channel that never goes dark
sidebar_position: 3
description: A round-the-clock channel with a backup source, a slate or loop for when every source is lost, and alerts that reach a person when it needs one.
guide: workflow
---

# A 24/7 channel that never goes dark

A channel that runs around the clock will lose its feed sooner or later: a contribution link drops, an encoder at the sender restarts, a cable is pulled. This workflow sets the channel up so viewers see the backup feed, or failing that your own slate or loop, instead of a dead screen, and so the right people hear about it.

## What it is for

Anyone running a news, sport or brand channel that must stay on air. Without it, a lost source means the output stops, viewers drift away and nobody notices until someone complains. With it, Volt switches to the backup feed by itself, falls back to a slate or loop when every source has gone, returns to the primary when it recovers, lists the problem in Monitoring and sends an alert when a person is needed.

## Before you start

- Room in the plan for one more channel: **Admin > Channel Groups** shows how much is **not yet shared** ([Channel Groups](../guides/channel-groups.md), [Plan & limits](../guides/plan-and-limits.md)).
- Two feeds of the same content: a primary and a backup, ideally over different paths (two links, two encoders). A backup over the same link fails at the same time as the primary.
- A slate image (for example "We'll be right back") or a short loop video, the shape of your output, usually 16:9.
- The access listed under [Who can do it](#who-can-do-it). Setting up a group needs an Owner or Administrator.
- Email and device push for alerts are set up for your Volt deployment by your Volt provider. The console inbox always works.

## The flow

![A group gives the channel its type and share of the plan; the channel takes a primary and a backup source and a slate or loop from Loops & Fillers; failover picks primary, then backup, then the filler; Monitoring lists problems and Notifications sends alerts](/img/flows/never-dark-channel.svg)

The group gives the channel its type and its share of the plan. Loops & Fillers holds the slate or loop the channel falls back on. The channel takes both sources and the filler, and failover picks between them: primary, then backup, then filler. What happens is reported to Monitoring, and the faults that need a person go out as alerts through Notifications.

| Step | Section | What happens |
|---|---|---|
| 1 | [Channel Groups](../guides/channel-groups.md) | A group with room holds the channel, decides whether it is transcode or packaging, and how many of its streams may run at once |
| 2 | [Loops & Fillers](../guides/loops-and-fillers.md) | The slate or loop is uploaded once, ready for any channel to fall back on |
| 3 | [Channels](../guides/channels.md) | The channel is created with its primary and backup sources and its filler on total loss |
| 4 | [Input failover](../guides/failover.md) | Failover is armed in the channel's settings and each path is tested with **Failover control** before the channel goes on air |
| 5 | [Monitoring](../guides/monitoring.md) | A channel on its backup or its filler, or down, is listed as an alert with what to check |
| 6 | [Notifications](../guides/notifications.md) | Faults that need a person reach the owners and administrators in the console inbox, and by email and push where those are set up |

## Step by step

### 1. Make room in a channel group

1. Open **Admin** and choose **Channel Groups**. The strip at the top says how many channels and stations are **not yet shared**.
2. To use an existing group, check its **Share of the plan** has room and that **Running at once** allows for a channel that never stops: a 24/7 channel counts against it all the time.
3. To give 24/7 channels their own group, choose **New group**, type a **Name**, choose **Transcode** (one source in) or **Packaging** (a ladder you encode yourself), set **Channels and stations** and **Running at once**, and choose **Create group**.
4. If **not yet shared** is 0, choose **Edit** on another group and lower its **Channels and stations** first.

Field by field: [Channel Groups](../guides/channel-groups.md).

### 2. Put the slate or loop in Loops & Fillers

1. Open **Loops & Fillers** in the sidebar.
2. Drop the file on the upload area. **Upload as** is set to **whatever the file is**: a still becomes a slate and a video becomes a loop.
3. Wait for it to show as **ready** with a preview. Choose **Refresh** if it still says **uploading**.
4. Click its name to give it a name operators will recognise, and press Enter.

Details: [Loops & Fillers](../guides/loops-and-fillers.md).

### 3. Create the channel with both sources

1. Open **Channels** and choose **New channel**.
2. Type the **Channel name**, choose **Transcode** or **Packaging**, and pick the **Group** from step 1.
3. For **Transcode**, fill in the **Primary source**, then turn on **Backup source** and fill in the second feed. Adding a backup turns input failover on for the channel. For **Packaging**, add the rendition rows, and under **Fallback**, **On source loss**, choose **Matching backup URLs (per rendition)** or **Single fallback source → transcode to all bitrates**.
4. **Check source** tests each address before you save.
5. Under **Filler on total loss**, set **When no source is available** to **Slate image** or **Loop video**, choose **Choose from Loops & Fillers…** and pick the file from step 2.
6. Choose **Create channel**. In Loops & Fillers, the slate or loop now shows the channel under **Used by**.

Every field: [Channels](../guides/channels.md).

### 4. Check the failover settings

1. Open the channel and choose **Settings** (the gear in the header). These settings are read when the channel starts, so the channel must be stopped to change them.
2. Under **Failover**, check **Enable input failover** is on. Turn on **Auto failback to primary** to return to the primary once it has been healthy for a short hold, or leave it off to stay on the backup until someone moves it.
3. Under **Availability**, check **Reconnect automatically after a restart** is on (it is for a new channel), so the channel is put back on air if Volt itself restarts. A channel you stopped yourself stays stopped.
4. Choose **Save changes**.

How failover decides: [Input failover](../guides/failover.md).

### 5. Prove each path, then go on air

1. Choose **Start channel** and confirm with **Start encoder**. The channel is metered from that moment.
2. Watch the five gates turn green and the status reach **READY** ([Channel status](../guides/channel-status.md)). The stream is still private.
3. In the **Failover control** panel, choose **Simulate primary loss** and watch the **Output** player move to the backup within a second or two. Then try **Slate** (or **Loop**) to see exactly what viewers get when every source is lost, and **Backup source**.
4. Choose **Resume normal** to hand control back to Volt.
5. Choose **Go on air**.

This step needs your real feeds arriving at Volt: with nothing sent, the channel waits at **STARTING** and there is nothing to switch between. **Start with test source** shows that the output works, but it does not test your own sender or backup path.

### 6. Watch it and make sure someone is told

1. Open **Monitoring**. A channel running on its backup is listed as **Serious**, **is degraded**, with **Running on the backup source.**; on its filler, with **Playing filler: no usable input.**; a channel that has failed is **Critical**, **is down**. **Open** goes to the channel, where **Diagnose** walks the pipeline.
2. Open **Admin > Notifications** and choose **Send me a test** on each delivery channel. The line under it should say **Sent to you. Check it arrived.**
3. Volt alerts the account's owners and administrators when the channel needs someone: its encoder stopped without being asked, a source cannot be read, it has been on the slate or loop for over a minute with every source lost, or its output's timing went wrong. It also alerts when **Reconnect automatically after a restart** gives up. Each is sent at most once every 30 minutes per channel ([Stream alerts](../guides/notifications.md#stream-alerts)). A channel running on its backup is not alerted: it is listed in **Monitoring** and on the channel's page, so keep Monitoring open on a screen in the control room, or watch status from your own systems through the API.
4. For push alerts on a phone, sign in to the Volt management app and allow notifications. The phone then appears under **Your devices**.

## Who can do it

| Stage | Access needed |
|---|---|
| Create a group or change a share of the plan | Owner or Administrator |
| Upload and rename slates and loops | Files, uploads & storage: Manage |
| Create the channel, choose its sources, filler and failover settings | TV channels: Manage |
| Start the channel, use **Failover control**, go on air | TV channels: Operate |
| Watch Monitoring | Live and monitoring: View |
| Send a test notification | An operator-tier role or above |
| Receive alerts | Owners and Administrators |

One administrator can do all of it. In a larger team an administrator sets up the group, someone with Files access uploads the slate, a channel manager creates the channel and an operator tests and runs it. Roles and levels are in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **New group** is unavailable and **The whole plan (... channels and stations) is shared out.** | Every channel in the plan is already given to a group | Lower another group's share with **Edit**, or raise the plan under **Plan & limits** |
| The failover settings are greyed out | The channel is running | Stop it, change them, start it again |
| **Failover control** buttons are unavailable | The channel is not started | Start it; the controls work while it runs |
| The output stays on the backup after the primary comes back | **Auto failback to primary** is off, or the primary has not been healthy for the hold yet | Wait, turn on auto failback, or choose **Resume normal** |
| Viewers see black or nothing when every source is lost | **When no source is available** is **Black** or **None (output stops)** | Choose **Slate image** or **Loop video** and pick one from Loops & Fillers |
| The channel's settings say the slate or loop **is no longer in Loops & Fillers** | It was deleted while the channel still used it | Choose another one in the channel's settings |
| Monitoring lists **is degraded** with **Running on the backup source.** | The primary failed and failover worked | Fix the primary feed at the sender; with auto failback on, the channel returns to it by itself |
| No alert arrived, but Monitoring shows the problem | Only a channel that auto connect gave up on is alerted; other faults are shown in Monitoring. Or you are not an owner or administrator, or email or push is **Not set up** | Check **Sent** in Notifications; keep Monitoring open on a screen, or watch status from your own systems through the API |

## Through the API

| Request | Does |
|---|---|
| `GET /api/plan` | How much of the plan is shared out |
| `POST /api/groups` | Creates a group (`name`, `workflowType`, `maxChannels`, `maxConcurrent`) |
| `GET /api/filler-assets` | The slates and loops, with their ids (files are sent with the uploads API) |
| `POST /api/channels` | Creates the channel with `sources` (one `primary`, one `backup`), `inputFailoverEnabled`, `autoFailback`, `inputLossBehavior` (`slate` or `vod_loop`) and `fillerAssetId` |
| `PATCH /api/channels/{id}` | Changes the failover settings, and `autoConnect` (**Reconnect automatically after a restart**) |
| `POST /api/channels/{id}/start` | Starts the channel |
| `POST /api/channels/{id}/failover-test` | Forces a path as **Failover control** does (`mode`: `primary_down`, `backup`, `slate`, `loop`, or `auto` to resume normal) |
| `POST /api/channels/{id}/air` | Goes on air (`{"on": true}`) |
| `GET /api/monitoring/overview` | The current alerts |
| `GET /api/status/stream` | Status changes as they happen, for your own monitoring |
| `GET /api/notifications` | The alerts sent, and what happened to each copy |

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"groupId": "<group id>", "name": "News 24",
       "sources": [{"role": "primary", "protocol": "srt", "ingestUrl": "srt://contribution.example.com:9000"},
                   {"role": "backup", "protocol": "srt", "ingestUrl": "srt://backup.example.com:9000"}],
       "inputFailoverEnabled": true, "autoFailback": true,
       "inputLossBehavior": "slate", "fillerAssetId": "<slate id>"}' \
  "https://your-volt-host/api/channels"
```

Every route, with its fields, is in the [API reference](/api-reference).
