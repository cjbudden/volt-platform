---
title: FAST
sidebar_position: 2.3
description: "Build a linear channel from your library: a run order that loops, the guide written for you, and ad breaks."
guide: section
---

# FAST

A FAST channel is a linear channel built from what is already in your Media Library. You put films and series in a **run order**, and the channel plays it pass after pass, writes its own programme guide and signals ad breaks. No encoder runs: the channel is played out from media that is already packaged.

![The New FAST channel form: name, video or audio, group and time zone](/img/screens/fast-new.png)

## What it is for

- **Turning a library into a channel.** Films, shows and series, or audio, played on a loop.
- **Spreading titles across the week.** A run order is not a day long, so each pass starts at a different time of day and a film comes round at different hours without anyone scheduling it twice.
- **A guide without typing one.** Volt writes the programme guide from the run order, a week or more ahead.
- **Ads.** Break markers for FAST platforms that sell their own ads, or ads from your own ad server stitched in for each viewer, with your house spots as the fallback.

Programmers and channel managers use it.

## Before you start

- Titles in the Media Library that can air: packaged, or with their source still in Volt. The library only offers titles that can.
- Room in a channel group: a FAST channel counts towards the group's share of the plan like any channel.
- For stitched ads, the VAST tag URL of your ad server.

## Step by step

### Create the channel

1. Open **FAST** in the sidebar and choose **New FAST channel** (or **New Stream > FAST channel**).
2. Enter a **Name** and choose the **Channel type**: **Video** or **Audio**. It cannot be changed later.
3. Choose the **Group** and the **Time zone**. The time zone is the guide's clock: rounding, the daily restart and prime time are worked out in it. It starts on your browser's zone; **UTC** is first in the list.
4. Choose **Create and build lineup**. The channel opens on its **Run order**, as a draft.

### Build the run order

1. On the left, **Library** lists **Titles** and **Series** that can air on this channel. Choose one to add it to the run order as a slot.
2. For a title slot, add alternates that take turns, one per pass, or set it to air only every few passes.
3. For a series slot, choose **Episodes each time**, **In episode order** or **Shuffled, no repeats**, and what happens at the last episode: **Start again from episode 1** or **Drop out**.
4. Move, duplicate or remove slots to get the order you want.
5. **What this run order does to a week** shows how long one pass is, how many passes air this week, when the next pass starts and how many minutes of ads an hour. Notices under it warn about things like a run order so short it repeats titles within a few hours. Until the run order has a slot, it only asks you to add titles or series.
6. Under **Channel clock**, choose whether to **Restart the run order daily** at a fixed time, whether to **Round programmes up to** the hour, whether to **Rotate the run order each pass**, how far to **Keep the guide written ahead**, and what to play **when a title is outside its rights window**.
7. Choose **Save draft** to keep your work. Nothing airs until you activate it.

### Check the week before it airs

1. **Week** shows every programme in the coming week, hour by hour.
2. **Repeats** lists how often each title airs this week, how many of those are in prime time, the closest repeat, and whether a title airs at the same clock time twice.

### Set up ads

1. Open **Ads** and choose one:
   - **No ads**: programmes run back to back.
   - **Ad markers for a FAST platform**: breaks are signalled and filled with your house spots, and the platform that carries the channel replaces them with its own ads.
   - **Stitched ads from your ad server**: Volt asks your ad server for each break and stitches the ads in for each viewer. House spots fill what the ad server does not, or if it is slow or down.
2. Choose **How much and where**, or **Use the title's own break points**.
3. Add **House spots, in rotation** and a **Slate**.
4. For stitched ads, add the ad server (**Name**, **Vendor**, **VAST tag URL**, **Time budget**), choose **Add and use**, and choose how to **Decide**: **For each viewer** (targeted) or **Once per break for everyone** (cheapest).
5. The report under it shows the last seven days: decisions, paid fill, impressions and completion.

### Put it on air

1. Choose **Activate and go on air**. The programmes and ad breaks are written to the guide and the channel starts playing.
2. Open **On air**. The channel starts **Private**: only the console can preview it. Turn it on to give viewers the channel.
3. **Playout** shows where the channel runs, when it was last heard from, restarts and segments published. **Media** lists every title, house spot and slate it uses.

### Change a channel that is on air

1. Edit the run order. Volt makes a draft; the channel keeps playing the active version.
2. Choose **Activate (carry on from now)**. The new version takes over from now without a jump.
3. **Rewrite guide** writes the guide again from the active run order.

## How it connects

| Section | How it relates |
|---|---|
| Media Library | Where the titles come from; a title must be able to air to be offered |
| [EPG](epg.md) | The guide Volt writes for the channel; programmes entered by hand that overlap it are reported when you activate |
| Loops & Fillers | House spots and the slate for ad breaks |
| [Live Streams](live-streams.md) | FAST channels are listed there with every other stream |
| [Analytics](analytics.md) | Viewing and ad delivery reports |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| Open FAST and see channels, run orders, previews and reports | TV channels: View |
| Put a channel on or off air, activate a run order, test a break decision | TV channels: Operate |
| Create a channel, edit run orders, ads and ad servers, prepare titles, write the guide again | TV channels: Manage |
| Add or cancel an ad break on a FAST channel or live TV channel | TV channels: Operate |
| Add or cancel an ad break on an event or a radio station | Events: Operate or Radio stations: Operate |

FAST channels are TV channels, so FAST follows the TV channels level of your role. A role without TV channels does not see FAST and cannot use it through the API either. A role of the Viewer tier is held at View.

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **No video assets can air yet** | Nothing in the library is packaged or has its source in Volt | Upload or package titles in the Media Library |
| **Not shown: N video assets with no usable source** | Those titles cannot be played out | Re-upload their source, or package them |
| **Activate** is not available | The run order has no slots | Add at least one title or series |
| **A lineup this short repeats titles within a few hours** | One pass is short | Add titles, or accept the repeats |
| **Draft: not on air until activated** | Your changes are saved but not airing | Choose **Activate** |
| Viewers get nothing after activating | The channel is still **Private** | Turn it on in **On air** |

## Through the API

| Request | Does |
|---|---|
| `GET /api/fast/channels` | Lists FAST channels |
| `POST /api/fast/channels` | Creates one |
| `GET /api/fast/channels/{id}` | One channel with its lineups and output URLs |
| `GET /api/fast/library` | Titles and series that can air |
| `PUT /api/fast/lineups/{id}` | Saves a draft run order |
| `POST /api/fast/lineups/{id}/preview` | The week a run order would make, without saving it |
| `POST /api/fast/lineups/{id}/activate` | Activates it and writes the guide |
| `POST /api/fast/channels/{id}/on-air` | Opens or closes it to viewers |
| `PUT /api/fast/channels/{id}/ads` | Sets its ads |
| `GET /api/fast/channels/{id}/ad-report` | Ad delivery for the last days |

Every route is in the [API reference](/api-reference).
