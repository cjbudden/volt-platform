---
title: Dashboard
sidebar_position: 0.1
description: "The first screen after you sign in: what is broken, what is on air, and what is waiting on you."
guide: section
---

# Dashboard

The Dashboard answers three questions at a glance: is anything broken, what is on air, and what is waiting on you. Each panel links to the section that has the detail, so it is a starting point rather than a place to work.

![The Dashboard: five counts across the top, then the attention list, streams on air, the last seven days and recent output](/img/screens/dashboard.png)

## What it is for

- **A first look at the start of a shift.** The counts across the top say how many streams are on air, how many people are watching, how many problems need attention, how many views the last seven days had and how many items wait in review.
- **Spotting trouble.** The **Attention** panel lists the same problems as [Monitoring](monitoring.md), most serious first.
- **Checking what viewers have.** **On air and at risk** lists the streams that are public, with their state, viewers and active source.
- **Seeing what was made.** **Recent output** lists the newest items in the Media Library, with their state.

Operators and managers use it every day; anyone with access to live and monitoring sees it.

## Before you start

- Nothing to set up. The panels fill in as you add [channels](channels.md), [radio stations](radio.md) and [events](events.md) and people start watching.
- You need **Live and monitoring: View**. Panels you have no access to say so in the panel; the rest of the page still works.

## Step by step

### Check the account at the start of a shift

1. Open **Dashboard** in the sidebar.
2. Read the counts across the top. **Needs attention** shows the number of problems and how many are warnings.
3. If **Attention** lists a problem, choose its **Monitoring** heading to open the full list, or open the stream from there.
4. Check **On air and at risk**: every public stream, its state and its active source. A stream on its backup source shows it here.

### Follow a count to its section

1. Choose the heading of a panel: **Monitoring**, **Live Streams**, **Analytics** or **Media Library**.
2. The section opens with the full detail.

## How it connects

| Section | How it relates |
|---|---|
| [Monitoring](monitoring.md) | The **Attention** panel is the top of Monitoring's alert list |
| [Live Streams](live-streams.md) | **On air** and **On air and at risk** come from the same board |
| Analytics | **Views · 7D** and the **Last 7 days** sparkline are a summary of the audience reports |
| Media Library and Review | **Recent output** and **Awaiting review** count what is in them |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See the Dashboard | Live and monitoring: View |
| See the views and watch hours | Analytics and reports: View |
| See recent output and the review count | Media library and publishing: View |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **Not enough history yet** under **Last 7 days** | Nothing has been watched long enough to draw a trend | Nothing. It fills in once streams have viewers. |
| **Nothing is published right now** | No stream is on air | Start a channel and go on air ([first channel](../getting-started/first-channel.md)) |
| A panel says you do not have access | Your role does not include that area | Ask an administrator, or ignore the panel |
| **On air 0** but a stream is running | It is running but private | Open it and choose **Go on air** when the output is valid |

## Through the API

The Dashboard reads routes you can call yourself with an admin session or an account secret key:

| Request | Answers |
|---|---|
| `GET /api/live-streams?health=true` | Every stream with its state, uptime and viewers |
| `GET /api/monitoring/overview` | The counts and alerts behind **Attention** |

```bash
curl -H "Authorization: Bearer $TOKEN" "https://your-volt-host/api/monitoring/overview"
```

Every route is in the [API reference](/api-reference).
