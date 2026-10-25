---
title: Fleet & Usage
sidebar_position: 10.3
description: The servers running your streams right now, and the billable time your streams have used.
guide: section
---

# Fleet & Usage

**Fleet & Usage** has two halves: the servers running your streams now and how loaded they are, and the billable time your streams have used, by day, week, month or year and by stream. Most people come here to see how much time was used this month, or whether a server is coping.

![The Fleet & Usage page: servers now, billable today, this month and all time across the top, one server with its load, then billable time by day](/img/screens/fleet-and-usage.png)

## What it is for

- **Servers.** Each server carrying your channels, stations and events: what kind it is, how many of your streams it carries, and its CPU, memory and network load.
- **Billable time.** The unit is time, never money: how long your streams ran, as settled by Volt's meter, per day, week, month or year.
- **By stream.** Each stream's time today, this month and all time, with how many runs and when it was last used.

Account owners use it to follow usage against their plan; operations staff use the Servers half when a stream misbehaves.

## Before you start

- A stream has to run before there is a server to show or time to report.
- Access: **Fleet & usage: View** (see [Who can do it](#who-can-do-it)).

## Step by step

### Check the servers

1. Open **Admin** and choose **Fleet & Usage**.
2. The tiles across the top: **Servers now** (with how many streams are running), **Billable today**, **Billable this month**, **All time** and **Not yet settled**.
3. Under **Servers**, each card is one server: a **Shared cloud server** (other customers' streams may run on it too), a **Cloud server for one stream** or an **On-premises server**, with its vCPUs, the number of your **Streams** on it, and **CPU**, **Memory** and **Network** in and out. On a Volt you run yourself, the account owner sees the machine type, zone and id instead.
4. Where other customers' work shares the machine, **Streams** reads "1 of 9": yours of the machine's. The load figures are always the whole machine's, because that is what tells you whether it is coping.
5. **Streams** on a card lists what of yours runs on it and how long each has been up; **Hide** closes the list.
6. The line under each card says how old the reading is, for example **Read 2m ago**. **reading is stale** means it is more than ten minutes old.

The page reads again every 30 seconds; **Refresh** reads at once.

### See the billable time

1. Under **Billable time**, choose **Daily**, **Weekly**, **Monthly** or **Yearly**.
2. Each bar is one period, oldest first, with the time used and how many servers and streams it took.
3. **By stream** lists each stream with its time **Today**, **This month** and **All time**, its **Runs** and when it was **Last used**.
4. A green **+... running** beside a stream is time it has run since the meter last settled. It is real usage but still moving, so it is shown apart from the totals, and the **Not yet settled** tile adds it up.

## How it connects

| Section | How it relates |
|---|---|
| [Channels](channels.md), [Radio](radio.md), [Events](events.md) | Each run of one is time on a server |
| [Plan & limits](plan-and-limits.md) | How many may run at once; this page shows what they used |
| [Analytics](analytics.md) | Operating reports show the same runs with their air time and faults |
| [Monitoring](monitoring.md) | Faults as they happen |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See servers and billable time | Fleet & usage: View |

Owners, Administrators, the Report and Analytics Manager and the System Viewer have it by default. The page changes nothing.

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **No servers carrying your work** | Nothing of yours is running now | Servers appear once a channel, event or station is running |
| **no reading** under CPU or Memory, and **no reading from this server yet** under the card | The server could not be measured, which is not the same as idle | Look again shortly; if it stays, check [Monitoring](monitoring.md) |
| **no reading: a server for one stream has no machine figures to read** | A server that runs a single stream reports no machine load; this is expected, not a fault | Nothing to do; the stream's own health is on [Monitoring](monitoring.md) |
| **reading is stale** | The last reading is more than ten minutes old | Choose **Refresh**; a server that stays stale may have lost contact |
| **No usage recorded yet.** | No stream has run since metering began | Time appears once a stream has run |
| **Couldn't refresh the fleet.** | The page could not reach Volt; the last figures stay shown | Choose **Retry** |

## Through the API

| Request | Does |
|---|---|
| `GET /api/fleet/hosts` | The servers carrying your streams, with their latest readings |
| `GET /api/fleet/usage?period=month&limit=12` | Billable time per period (`day`, `week`, `month`, `year`), the totals and each stream |
| `GET /api/fleet/usage/stream/{id}` | One stream's time |

```bash
curl -H "Authorization: Bearer $TOKEN" "https://your-volt-host/api/fleet/usage?period=day&limit=30"
```

Times are in seconds. Every route is in the [API reference](/api-reference).
