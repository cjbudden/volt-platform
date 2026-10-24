---
title: Monitoring
sidebar_position: 0.3
description: Problems only, most serious first, with a log of what happened on every stream.
guide: section
---

# Monitoring

Monitoring lists problems and nothing else. A healthy account leaves this page nearly empty, which is the point: anything on it needs a person. Below the alerts, **Fleet activity** records what happened on every stream and when.

![The Monitoring page: severity counts, the alert list and fleet activity](/img/screens/monitoring.png)

## What it is for

- **Knowing what is wrong right now.** Each alert is a condition that is still true: a stream that is down, stalled, stuck starting or on its backup source. It says which stream, what is wrong and how long it has been that way.
- **Ranking it.** Alerts are **Critical** (viewers are affected now), **Serious** (broken, but nobody is watching yet) or **Warning** (working, but not right). Each is labelled in words as well as colour.
- **Looking back.** **Fleet activity** lists start, stop, failover and fault events across every stream, newest first.

Operators keep it open on a second screen; on-call staff check it when alerted.

## Before you start

- Streams to watch: [channels](channels.md), [radio stations](radio.md), [events](events.md) or [FAST channels](fast.md).
- **Live and monitoring: View**.
- To be told about problems when you are not looking, set up notifications (**Admin > Notifications**).

## Step by step

### Deal with an alert

1. Open **Monitoring** in the sidebar.
2. Read the counts: **Critical**, **Serious**, **Warning**, **On air** and **Watching now**.
3. Use the **Alerts** filter (**All**, **Critical**, **Serious**, **Warning**) to narrow the list.
4. Read the alert: the stream, the part of the pipeline (for example **Pipeline** or **Server**), and what to check.
5. Choose **Open** to go to the stream's page, then **Diagnose** to walk the pipeline from server to output. [Channel status](channel-status.md) explains every word you will see there.
6. When the cause is fixed the alert leaves the list by itself. **Refresh** checks again now.

### See what happened on a stream

1. Scroll to **Fleet activity**.
2. Each row has the time, the stream, the event and its detail.
3. For one stream's full history, open the stream and read its event log, further down its page.

## How it connects

| Section | How it relates |
|---|---|
| [Dashboard](dashboard.md) | Its **Attention** panel is the top of this list |
| [Live Streams](live-streams.md) | Shows every running stream, healthy or not; Monitoring shows only the problems |
| [Channels](channels.md), [Radio](radio.md), [Events](events.md) | **Open** goes to the stream's page, where **Diagnose** and **Clear QC** are |
| [Notifications](notifications.md) | Sends the same alerts by email or to your own systems |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See alerts and fleet activity | Live and monitoring: View |
| Fix the stream (stop, start, clear QC) | Operate on that kind of stream (for example TV channels: Operate) |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **has been starting for** a long time | The stream started but never produced output. Starting is a short transition, not a resting state. | Open it and choose **Diagnose**. If the source is not arriving, check it at the sender; otherwise stop and start the stream. |
| **is down** with **connection lost** | Volt has had no report from the stream's encoder for 90 seconds | Open the stream. If it does not recover, stop and start it. |
| **has a stranded encoder record** | The stream is recorded as running but nothing is running it | Stop the stream to clear it, then start it again if needed |
| An alert stays after you fixed the cause | The health check has not run again yet | Choose **Refresh**, or **Clear QC** on the stream's page |
| Nothing listed but viewers complain | Every gate is healthy, so the fault may be in what viewers are given | Check the stream in [Multiview](multiview.md) with the viewer's country |

## Through the API

| Request | Answers |
|---|---|
| `GET /api/monitoring/overview` | The counts and the current alerts |
| `GET /api/monitoring/feed` | Fleet activity, newest first |
| `GET /api/status/{kind}/{id}/events` | One stream's event log |

```bash
curl -H "Authorization: Bearer $TOKEN" "https://your-volt-host/api/monitoring/overview"
```

Every route is in the [API reference](/api-reference).
