---
title: Analytics
sidebar_position: 0.45
description: Who watched, what ran and for how long, and what viewers actually saw when they pressed play.
guide: section
---

# Analytics

**Analytics** answers three questions about your account, each in its own view: who watched (**Audience**), what ran, for how long and why it stopped (**Operating**), and what viewers actually saw when they pressed play (**Playback**). Most people come here to see how many people watched over the last month, or to download a report of each stream's air time.

![The Audience view: watching now, views, unique viewers, watch hours and peak concurrent across the top, then views and unique viewers by day](/img/screens/analytics.png)

## What it is for

- **Audience.** Views, unique viewers, watch hours and the peak number watching at once, by day, with the split by device, country and app, and the most watched channels, events and on-demand items. **Watching now** is live and refreshes every 15 seconds.
- **Operating.** Every channel, radio station and event that ran in a period: how many runs, hours run, hours on air, availability, unplanned stops and the time to recover from a fault. Open a stream for each run and why it ended. Download either as CSV.
- **Playback.** The player's own reports from players built on the Volt SDK: whether playback started, how long it took, how often it stalled, the quality chosen, how smoothly the device played it, whether access checks or DRM got in the way, how far behind live viewers were, how ads played and whether viewers stayed. Filter by content, device, app, country, network and more, rank the worst segments, and open any one viewer's session to see everything that happened to it, in order. Apps that send their journey events also show where viewers give up between opening the app and the first frame, and which rows, searches, links and notifications lead to watching.

Audience and Operating are read from daily totals that Volt keeps after the raw viewing events age out, so a report for last quarter still answers. Today is a partial day: it is drawn dashed and called **not final** until it closes.

Programme and marketing staff use Audience; operations staff use Operating to prove availability and find faults; app and player teams use Playback.

## Before you start

- Something must have been watched or run. Audience fills from your players' viewing sessions; Operating from each run of a channel, station or event; Playback only from players built on the Volt SDK with its reporting (`cmcd`) on (see [Player SDK](player-sdk.md)); **Journey to play** and **Where plays come from** only from apps that also send their journey events (`VoltJourney` in the SDK, once the viewer's consent allows it).
- Access: **Analytics & reports: View** to read any of the three views (see [Who can do it](#who-can-do-it)).

## Step by step

### See who watched

1. Open **Analytics** in the sidebar. It opens on **Audience**.
2. Choose **7 days**, **30 days** or **90 days**. The tiles across the top cover that window: **Views**, **Unique viewers**, **Watch hours** and **Peak concurrent**. **Watching now** is the number watching at this moment, with how many streams are live. **Blocked** appears when viewers were refused by geo or access rules.
3. **Audience** charts views and unique viewers by day. Point at the chart to read a day's figures. Days drawn dashed are **not final yet**.
4. **Peak concurrent** has its own chart, because it is a different measure at a different scale.
5. **By device**, **By country** and **By app** show where the views came from, largest first.
6. **Most watched** lists the channels, events and on-demand items with the most views in the window, with their watch hours and peak.
7. **Refresh** reads the figures again.

### Report on what ran

1. In **Analytics**, choose **Operating**.
2. Choose a period: **This month**, **Last month**, **7 days**, **30 days** or **90 days**, or set your own dates in the two date fields.
3. Narrow it with **All**, **Channels**, **Stations** or **Events**, or type in **Find a stream**.
4. The tiles show how many **Streams** ran, the **Hours run**, the **Hours on air** and the **Unplanned stops**.
5. Each row is a stream:

   | Column | Shows |
   |---|---|
   | **Runs** | How many times it was started in the period |
   | **Hours run** | How long it ran |
   | **On air** | How long of that it was on air |
   | **Availability** | On-air time over the expected window: the whole period for a 24/7 channel or station, the public window for an event |
   | **Faults** | Unplanned stops. A **+n?** beside it counts runs that ended without a recorded reason |
   | **Recover** | The average time from a fault to the next run |
   | **Peak** | The most watching at once. A small **d** means the highest daily peak, because the exact figure is older than the raw viewing data kept |
   | **Watch hours** | Viewing in the period |

6. Choose a column heading to sort by it; choose it again to reverse the order.
7. **Download CSV** downloads the table for the period and filters chosen.

### See one stream's runs

1. In **Operating**, choose a stream's row.
2. The tiles show its **Hours run**, **Hours on air**, **Availability**, **Unplanned stops** (with planned and unknown stops under it), **Time to recover**, **Peak concurrent** and **Watch hours**.
3. **Runs and air time** draws each run across the period: grey while running, the brand colour while on air, a red mark where a run ended in a fault.
4. The table lists every run with when it started and ended, how long it ran and was on air, and why it stopped:

   | Stop | Means |
   |---|---|
   | **Operator** | Stopped by a person. Planned |
   | **Schedule** | The scheduled window ended. Planned |
   | **Fault** | The stream failed. Unplanned. The reason is shown under it |
   | **Platform** | Volt restarted or moved it. Nobody decided to stop it |
   | **Unknown** | The run ended without a recorded reason, for example a lost server |
   | **Running** | Still running |

5. A radio station also shows **MP3 listeners**, counted separately from the players.
6. **Open channel** (or station, or event) goes to the stream itself; **Download CSV** downloads its runs; **Operating reports** in the breadcrumb goes back to the list with the same period.

### See what viewers saw

1. In **Analytics**, choose **Playback**.
2. Choose **1 hour**, **24 hours**, **7 days** or **30 days**.
3. Under **Filters**, pick a value in any list (**Content**, **Live or on demand**, **Device class**, **Device model**, **OS**, **Browser**, **App**, **App version**, **SDK version**, **Codec**, **CDN**, **Country**, **Region**, **Network (ASN)**, **Connection**, **Came from**, **Screens before play**). Each value shows how many views it had. **Came from** is where the viewer picked the title (a row, search, a deep link, a push notification, the guide, continue watching, related titles); **Screens before play** how many screens the app showed before play was pressed. **Clear filters** removes them all.
4. Read the reports from the top:

   | Report | Answers |
   |---|---|
   | The trend | Play attempts and the startup time p95 over the period |
   | **Playback success** | Can viewers watch? Play attempts, startup success and failures, exits before the first frame, failures after the start, and the errors seen |
   | **Startup** | How long from pressing play to the first frame, as p50, p95 and p99, and which step took the time |
   | **Buffering and interruptions** | Views with stalls, the rebuffer ratio, stalls per hour, time to first stall and seek delay |
   | **Quality and adaptive bitrate** | The bitrate watched, time below what the screen can use, quality switches, buffer and throughput |
   | **Rendering and devices** | Dropped frames per minute of playing, decoder errors, hardware or software decoding and the DRM system, with the worst devices first |
   | **Access and DRM** | How often the play gate said no and why (region, rights window, payment, sign in, the app's restrictions, an unknown asset), how long it took, licence time and failures, and viewers whose token was refused part way through |
   | **Live streams** | How far behind live viewers were, how much that grew during a view (drift), and time spent catching up, by device. Shown when live views are in the period |
   | **Advertising** | Breaks watched to the end, ad startup, buffering inside breaks, the time back to the programme, viewers who left during an ad, and the beacons the ad stitcher sent. Shown when the period has ad breaks |
   | **Engagement and abandonment** | Playing time, viewers who left after a stall or an error, and the same by content |
   | **Journey to play** | Where viewers give up between opening the app and the first frame: opened the app, browsed, opened a title, pressed play, allowed to watch, paid where needed, first frame, with how many left at each step and how long after opening they got there. Also who left at the paywall and how long from opening the app to the first frame. A play still going is counted at **Allowed to watch** and **First frame** once it ends, or a minute after the player last reported |
   | **Where plays come from** | For each entry point (**By entry point**) or each row and campaign (**By row or campaign**): journeys, how many played and started, watch time, how many were watched to the end, startup and buffering. **Viewed, never played** lists titles whose page was opened and not played |
   | **Worst segments** | Which values of a dimension do worst on a measure you choose |
   | **Sessions** | The views behind the numbers, newest first, to open one viewer's timeline |
   | **Telemetry health** | Whether the numbers can be trusted: reports lost, late or refused |

   Time inside an ad break counts as the ad's, so stalls during an ad are in **Advertising**, not in **Buffering and interruptions**.

5. In **Worst segments**, choose **By** (the dimension), **Ranked by** (the measure) and **At least** (the fewest views a value needs to be ranked), so one unlucky viewer does not top the list.
6. **How these are measured** at the foot of the page gives the definition behind every figure.

### Follow one viewer's session

1. In **Playback**, under **Sessions**, choose which views to list: **All**, **Ended by an error**, **Failed to start**, **Stalled**, **Left before the first frame** or **Left during an ad**. The filters at the top apply here too.
2. Choose **Timeline** beside a view.
3. **Session timeline** opens below the list:
   - a line with the content, the device, the country and how the view went;
   - a coloured strip of what the viewer saw, second by second (starting, playing, stalled, seeking, paused, in the background, ad), with the time in each;
   - every report the player sent, in order, with the play gate's answer for this session and the beacons the ad stitcher sent for this viewer. Problems are shown in red.
4. If reports are missing (the player sent them but they never arrived), the line at the top says how many and which. A batch the player sent twice is counted once.
5. **Close** hides the timeline.

A timeline can be opened for as long as the player's raw reports are kept.

## How it connects

| Section | How it relates |
|---|---|
| [Channels](channels.md), [Radio](radio.md), [Events](events.md) | Each run of a stream is a row in Operating; their viewers are counted in Audience |
| [Media Library](media-library.md) | On-demand items appear in Most watched |
| [Monitoring](monitoring.md) | Shows faults as they happen; Operating counts them over a period |
| [Fleet & Usage](fleet-and-usage.md) | The billable server time behind the same runs |
| [Account settings](account-settings.md), [Publishing Rules](publishing-rules.md) | Geo and access rules are what the **Blocked** figure counts |
| [Player SDK](player-sdk.md) | Players built on it send the reports Playback reads |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| Read Audience, Operating and Playback, download CSV | Analytics & reports: View |

The Report and Analytics Manager role has **Analytics & reports: Manage**. Event Managers, Radio Managers and System Viewers can read Analytics. Users without the access do not see **Analytics** in the sidebar.

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **No audience data yet** | Nothing has been watched since the account started | Figures appear once something is watched; they are rolled up daily |
| **Nothing has been watched in this window.** under Most watched | No channel, event or item had views in the days chosen | Choose a longer window |
| A day drawn dashed, **not final** | Today, or a day whose totals are still being counted | Read it again once the day has closed |
| **Nothing ran in this period** | No channel, station or event ran in the dates chosen | Choose a wider period, or **All** instead of one kind |
| **not retained** under Peak | The raw viewing data for that run has aged out, so the exact peak no longer exists | The day's peak is shown under it instead |
| **+1?** beside Faults, or **Unknown** as a stop | A run ended without Volt recording why, for example a lost server | See [Monitoring](monitoring.md) for that time |
| **No playback reports in this period** | No player sent reports, or none for these filters | Clear the filters, choose a longer period, or turn reporting on in your player |
| **No value has 20 views or more in this period.** | Nothing in that dimension has enough views to rank | Choose a lower **At least**, or a longer period |
| **No sessions like this in the period.** | No view matches the choice under **Sessions** | Choose **All**, or a longer period |
| **Not in the gate log** under **Why, from the gate** | The view failed at the entitlement step, but the play gate has no answer for its session: the answer came from an edge cache, or the player did not send its session to the gate | Use a player built on the Volt SDK, which sends it |
| **No view row: the session never reached play.** in a timeline | The play gate answered for this session but the player never reported pressing play | Check the app: it asked for the stream and did not play it |
| **Couldn't open that session** | The session is not in your account, or its raw reports are no longer kept | Choose a more recent session |
| **No app sessions in this period.** under Journey to play | No app sent journey events, the viewers' consent does not allow it yet, or none in this period | Send them with `VoltJourney` in the Volt SDK (see [Player SDK](player-sdk.md)), or choose a longer period |
| **The trend is not filtered by ...** | The minute-by-minute trend keeps only content, live or on demand, country, device class and CDN | The reports below it are filtered by everything chosen |
| **Couldn't load analytics.** (or operating or playback reports) | The page could not reach Volt | Choose **Retry** |

## Through the API

| Request | Does |
|---|---|
| `GET /api/analytics/overview?days=30` | The Audience view: totals, daily figures, device, country and app, most watched |
| `GET /api/analytics/realtime` | How many are watching now, per stream |
| `GET /api/reports/streams` | The Operating view for a period (`from`, `to`, `kind`, `q`, `sort`) |
| `GET /api/reports/streams.csv` | The same as CSV |
| `GET /api/reports/stream/{id}` | One stream's runs (`from`, `to`); `/api/reports/stream/{id}.csv` for CSV |
| `GET /api/analytics/qoe/overview` | The Playback reports (`hours` and any filter, for example `device_class=tv`) |
| `GET /api/analytics/qoe/breakdown` | Worst segments (`by`, `measure`, `minViews`) |
| `GET /api/analytics/qoe/sessions` | The views behind the numbers (`problem`: `all`, `error`, `failed`, `stalled`, `exited`, `ad`) |
| `GET /api/analytics/qoe/sessions/{sid}` | One session's timeline: every report in order, the states, the gate's answers and the ad beacons |
| `GET /api/analytics/qoe/journeys` | Journey to play: the funnel from app open to first frame |
| `GET /api/analytics/qoe/discovery` | Where plays come from (`by=entry` or `by=detail`) and titles viewed and never played |
| `GET /api/analytics/qoe/definitions` | How each figure is measured |

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://your-volt-host/api/reports/streams?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z&kind=channel"
```

Every route is in the [API reference](/api-reference).
