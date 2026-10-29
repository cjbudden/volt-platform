---
title: Recordings
sidebar_position: 3.6
description: Find what your channels, radio stations and events have recorded, scrub through it and cut clips, full-length VOD and downloads from it.
guide: section
---

# Recordings

Recordings lists every channel, radio station and event that has recorded content, and opens each one as a single span you can search, scrub and clip across. Most people come here to cut a clip: mark an in and an out point on the timeline, give it a title and choose **Create clip**.

![The Recordings page: filter chips for channels, radio, events and what is recording now, then one row per source with its recordings, available range, content held and status](/img/screens/recordings.png)

## What it is for

- **Find recorded material.** One row per source (a channel, a radio station or an event), with how many recordings it holds, the range of time they cover, how much content that adds up to and when the oldest one is removed.
- **Review and clip.** Open a recording to play it with the same player your viewers use, scrub a waveform and the programme guide, mark a range with the keyboard or the mouse, and cut it into a clip.
- **Publish and download.** Turn a whole recording into one VOD asset, or export it as a file (MP4 for video, MP3 for radio).

Producers, clip editors and the people who look after a channel's catch-up content use it day to day.

## Before you start

- Recording must be on for the channel, station or event. In its settings, under **Recording**, turn on **Recording and clipping** and, if you like, set **Keep recordings for** (leave it blank to keep recordings indefinitely). It applies from the next start. See [Channels](channels.md), [Radio](radio.md) and [Events](events.md).
- The stream must have run with recording on. Nothing is listed until it has.
- **Recordings & clips: View** to see recordings. Cutting clips and publishing need more (see [Who can do it](#who-can-do-it)).

## Step by step

### Find a recording

1. Open **Recordings** in the sidebar.
2. Narrow the list with **All**, **Channels**, **Radio** or **Events**. Each chip shows how many sources it holds. **Recording now** shows only sources that are capturing at this moment.
3. Type in **Search source names…** to find a source by name.
4. To filter by date, choose **Dates**, then set **Recorded between** (when the content was recorded) or **Source created between** (when the channel, station or event was made). **Clear** removes the dates.
5. Click a column heading (**Source**, **Recordings**, **Available range** or **Content held**) to sort by it; click again to reverse the order.
6. Choose **Open** on a row, or click the row, to open the source.

The **Status** column says **Recording** while the source is capturing, **Idle** when it is not, and **Off** when recording is turned off in its settings. Under the recording count you can see the keep period (for example **kept for 30d**) and when the next recording is due to go (**next removal**).

### Find a moment in a source

A source page shows everything the source still holds as one span, so a programme that crosses midnight or a restart reads as one thing.

1. For a channel or radio station, the **Timeline** shows three lanes on one clock: the media (a waveform for radio, blocks for video), **Time** and **On air** (what the guide or the now-playing log says was playing). Use **‹ Earlier** and **Later ›** to move, the zoom buttons (**1m** to **7d**) to zoom, and **Fit** to see everything.
2. Drag across the timeline to mark a range. The **Selected range** card shows its start, end and length. Choose **Open in the clipper** to open that range ready to cut, or **Clear** to start again.
3. Or, under **Jump to a date and time**, enter a date and time and choose **Go**. **Earliest held** and **Most recent** fill in the ends of the range. Volt opens whichever recording holds that moment.
4. The table underneath lists each recording (**Capture**) with its **Window**, **Duration**, **Status**, when it is **Removed**, and how many VOD assets have been made from it (**Assets**). Choose **Open** to work on one.

Events have no timeline on this page: use **Jump to a date and time** or open a recording from the table.

### Cut a clip

1. Open a recording. The player loads the most recent material, with the in and out marks on the last five minutes.
2. Play and scrub. With the page focused (not a text field), **space** plays and pauses, the left and right arrows move 10 seconds, `<` and `>` step one frame, **I** sets the in point and **O** sets the out point at the playhead. **Position**, **In** and **Out** show where you are.
3. Use the clipping timeline under the player to find the range. Drag on it to set the marks. Zoom with **1m**, **5m**, **15m**, **1h**, **4h** and **1d**, **−** and **+**, and pan with **◀** and **▶**. **Zoom on** chooses what the zoom keeps in view: **Playhead**, **In**, **Out** or **Middle**. **Fit all** shows the whole recording (**Last day** on recordings longer than a day), and **Zoom to marks** zooms to the range you marked.
4. To clip exactly one programme or song, click it in the metadata lane. The marks snap to it and its title fills in **Clip title**.
5. To fine-tune, type a time (hh:mm:ss) in the **In** and **Out** fields. **Load marks** loads just the marked range into the player.
6. Enter a **Clip title** and choose an **Output**: **Streaming (HLS/DASH)**, **Downloadable MP4** (**Downloadable MP3** for radio), or both (**Streaming + MP4** or **Streaming + MP3**).
7. Choose **Create clip**. **Clip created. Listed below and in the Media Library.** confirms it. The clip appears in the table under the clip controls and in the [Media Library](media-library.md), where it is published.

If the recording has transcripts, a panel beside the player lists what was said in the loaded range. Type in **Search subtitles… (all words, any order)** to search the whole recording, and click a line to jump there.

### Clip across a gap

A recording can have holes: the stream was stopped and started again, or segments are missing. The page header says how many (for example **2 gaps in this recording · 0:45 missing**), and each chip zooms to its gap. If the channel showed its loop or slate while the source was lost, a second line says so; that time is not in the recording either.

When your marks cross a gap, **Missing media inside the marks.** explains how long the clip will be, and the button reads **Create clip (skips 3.0s gap)**. Choose it to cut the clip without the missing time (the audio jumps at each gap), or move a mark past the red band to avoid the gap.

### Publish the whole recording or download it

1. Open the recording.
2. Choose **Publish full VOD** to make the whole recording one VOD asset. It is available once the recording has closed. **Recording published as a full VOD asset.** confirms it.
3. Choose **Download MP4** (**Download MP3** for radio) to export the whole recording as a file. The button is there for roles with Downloads: Operate. The first time, **MP4 export is being prepared. Check back shortly.** appears: choose the button again later and the file opens. A radio export also offers **AAC (.m4a)** beside it.

### Check what a clip was made from

In the table of clips under the clip controls, choose **Sources** on a row to see which runs and segments the clip was built from, and whether that media still exists. **Review** loads a clip's range back into the player and marks.

### Send a recording to an add-on

Choose **Send to add-on** at the top of the recording and pick an add-on (for example transcription or quality checks). Its progress shows beside the button while it runs. **Track it** opens the run in [Workflows](workflows.md) for roles that can open Workflows (Account settings: View); others see the progress only.

## How it connects

| Section | How it relates |
|---|---|
| [Channels](channels.md), [Radio](radio.md), [Events](events.md) | Each one turns recording on and sets **Keep recordings for** in its settings |
| [Media Library](media-library.md) | Clips and full VOD made here are listed and published there |
| [Live Streams](live-streams.md) | Its timeline can open a range of a recording here with the marks already set |
| [EPG](epg.md) | Programme titles and times fill the metadata lane, so one click marks a programme |
| [Storage](storage.md) | The retention ladder decides when recorded media moves to cheaper storage or is deleted |
| [Workflows](workflows.md) | **Send to add-on** starts an add-on run on a recording |
| [Loops & Fillers](loops-and-fillers.md) | Time when a loop or slate was on air is not in the recording, and is marked on it |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See sources and recordings, play, scrub, search transcripts | Recordings & clips: View |
| Download a recording as a file | Recordings & clips: View and Downloads: Operate |
| Publish a whole recording as VOD (**Publish full VOD**) | Recordings & clips: Operate |
| Cut a clip (**Create clip**) | Recordings & clips: Manage |
| Send a recording to an add-on | Recordings: Operate (or Account settings: Operate) |
| Turn recording on and set the keep period | TV channels, Radio stations or Events: Manage |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **No recordings yet** | No channel, station or event has run with recording on | Turn on **Recording and clipping** in its settings and start it |
| **Nothing matches those filters** | The chips, search or dates leave nothing | Choose **All**, clear the search, or **Clear** the dates |
| **Off** in the Status column | Recording is turned off for that source | Turn it on in the source's settings; it applies from the next start |
| **Couldn't load recordings.** | The list could not be read | Choose **Retry** |
| **Nothing was recorded at** a date and time | Nothing the source holds covers that moment | Pick a time inside the **held:** range shown beside the buttons |
| **Nothing was recorded at the start of that range.** | The range you dragged starts in a gap | Start the range a little later |
| **No segments on disk** | The recording's media was removed by the keep period or retention, or recording was off for that run | Nothing to recover; cut what you need before **Removed in** passes |
| **Set the trim marks first (I and O, or drag on the timeline)** | There is no valid in and out | Set both marks, with the out after the in |
| **Give the clip a title** | **Clip title** is empty | Enter a title |
| **Clip range is outside the recording** | A mark is outside the recording's window | Move the marks inside it, or open the recording that holds that time |
| A message that gaps **fall inside this range**, with **Accept the gap and create the clip** | The range crosses missing media | Choose the button to cut it without the missing time, or **Cancel** and move the marks |
| **Publish full VOD** is greyed out | The recording is still in progress (**Available when the recording closes**) | Wait until it closes, or cut a clip instead |
| **MP4 export is being prepared. Check back shortly.** | The file is being made | Choose **Download MP4** again in a minute |
| **Some parts did not load** above the player | Part of the page (coverage, waveform, metadata lane or transcript) failed; hover over it for the reason | Choose **Refresh** |
| **Playback failed:** under the player | The player could not load the range | Choose **Refresh**, or load a smaller range with **Load marks** |
| **No add-on accepts a recording. An admin can add one under Workflows.** | No add-on is set up for recordings | Ask an administrator to add one in [Workflows](workflows.md) |

## Through the API

| Request | Does |
|---|---|
| `GET /api/recordings/sources` | Lists sources with counts; filter with `type`, `q`, `recordingNow=1`, `recordedFrom`, `recordedTo`, sort with `sort` and `dir` |
| `GET /api/recordings?sourceId={id}` | One source's recordings |
| `GET /api/recordings/{id}` | One recording, with the VOD assets made from it |
| `GET /api/recordings/{id}/timeline` | What is on disk, with its gaps |
| `GET /api/recordings/{id}/programmes` | The programmes and now-playing items for a span |
| `GET /api/recordings/{id}/transcript` | Transcript lines for a span, or matches for `q` |
| `POST /api/recordings/{id}/clip` | Cuts a clip (`title`, `startMs`, `endMs`, `outputKind`, optional `acceptGapsMs`) |
| `POST /api/recordings/{id}/publish` | Publishes the whole recording as VOD |
| `GET /api/recordings/{id}/download` | Starts or fetches the file export |
| `GET /api/scheduled-clips`, `POST /api/scheduled-clips`, `DELETE /api/scheduled-clips/{id}` | Clips cut automatically when a window you set ends; the console has no page for these yet |

Times are milliseconds since 1 January 1970 (UTC). A clip that crosses missing media is refused with `409` and code `coverage_gap`, listing the gaps and `totalGapMs`; send it again with `acceptGapsMs` set to at least that total to accept them.

```bash
curl -X POST "https://your-volt-host/api/recordings/{id}/clip" \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"title":"Half-time highlights","startMs":1767225600000,"endMs":1767225900000,"outputKind":"both"}'
```

Every route is in the [API reference](/api-reference).
