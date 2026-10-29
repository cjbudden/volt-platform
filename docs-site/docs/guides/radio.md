---
title: Radio
sidebar_position: 2.1
description: Audio-only stations with MP3, HLS and DASH outputs and a timed now-playing log.
guide: section
---

# Radio

A radio station is an audio-only live stream. Volt takes the station's audio in (an Icecast or SHOUTcast mount, HTTP audio, HLS or SRT), and serves it as an MP3 stream, HLS and DASH. For Icecast sources it also keeps a timed log of every now-playing title, so songs, adverts and talk can be found, trimmed and clipped later.

![The Radio list: status filters, then one row per station with now playing, signal, outputs and status](/img/screens/radio.png)

## What it is for

- **Running stations.** Start and stop, listen to each output, go on air and off air.
- **Now playing.** Titles the source sends become a timed log, classified as **song**, **ad** or **content**, and are passed through to MP3 listeners.
- **Quality.** Each station checks its own output (playlist continuity, timing and audio level) and shows the signal it is receiving.
- **After the broadcast.** With recording on, the log drives search and clipping in Recordings; talk can be transcribed.

Radio managers and station operators use it day to day.

## Before you start

- A source: the URL of an Icecast or SHOUTcast mount or other HTTP MP3 or AAC stream, an HLS playlist, or an SRT feed.
- Room in a channel group: a group's limit counts TV channels and radio stations together.
- **Radio stations: Manage** to create a station.

## Step by step

### Create a station

1. Open **Radio** in the sidebar and choose **New station** (or **New Stream > Radio station**).
2. Enter a **Station name** and, optionally, artwork.
3. Leave **Type** on **Packaging** to pass the source audio through as it is. Choose **Transcode** only to change the bitrate or format.
4. Under **Audio source**, choose **Icecast / HTTP audio**, **HLS** or **SRT** and enter the address.
5. Choose **Validate source**. Volt checks that the source plays, lets you listen to a sample and, for Icecast, reads the station's name, genre, bitrate and artwork. Nothing is saved until you apply it.
6. Under **Outputs**, choose **MP3 stream**, **HLS (audio-only)** and **DASH**, and an **Output bitrate**. Radio is a single bitrate by design.
7. Turn on **Capture now-playing log** for an Icecast source, and **Recording and clipping** if you want to clip later. **Transcribe speech segments** transcribes only the parts classified as content.
8. Choose **Create station**.

### Start a station and listen

1. Open the station from the list.
2. Choose **Start station** and watch the five gates turn green ([channel status](channel-status.md)).
3. The monitor starts muted, so the page never makes noise on its own. Unmute it to listen. The level meter works whether you listen or not.
4. Under **Output previews**, play **MP3**, **HLS** or **DASH** to check each output on its own. One plays at a time.
5. When the output is valid, choose **Go on air** to open the public URLs.

### Read and search the now-playing log

1. On the station's page, scroll to **Received metadata log**.
2. Filter by **Songs**, **Ads** or **Content**, by **Period**, and hide entries shorter than a length you choose.
3. Search titles, and sort by newest, oldest, longest or title.
4. If an entry is in the wrong class (a station ident read as a song, a sponsor read as content), choose the right one in its **Class** column: **Song**, **Ad** or **Content**. Hover over it to see who corrected it and what Volt had said. The entry still playing can be corrected once the next title arrives.

The class decides what the **Songs**, **Ads** and **Content** tabs count, which entries are transcribed (content only) and which get a cover (songs only).

### Change or remove a station

1. Choose **Settings** on the station's page. Stop the station to change its source and outputs.
2. **Remove** removes the station with its recordings, clips and guide. Stop it first; Volt asks you to confirm.

## How it connects

| Section | How it relates |
|---|---|
| [EPG](epg.md) | The station's programme guide; the now-playing log is kept on it |
| [Recordings](recordings.md) | A recorded station is clipped there; its search finds a station by a song in its log |
| Channel Groups | Stations count towards a group's channel limit |
| [Live Streams](live-streams.md), [Monitoring](monitoring.md), [Multiview](multiview.md) | Where a running station is watched with everything else; Multiview shows a level meter for it |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See stations and their pages | Radio stations: View |
| Start, stop, go on air, clear recovery, correct a log entry's class | Radio stations: Operate |
| Create a station, change settings, clear its log | Radio stations: Manage |
| Remove a station | Owner or Administrator |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| The now-playing log stays empty | The source sends no titles (HLS and SRT sources usually do not), or the log is off | For titles, use the station's Icecast mount and turn on **Capture now-playing log** |
| **Validate source** fails | Volt cannot play the address | Check the URL in a player; a mount URL usually ends in the stream's name |
| No sound when you unmute | The station is stopped, or another output preview is playing | Start the station; stop the other preview |
| **DEGRADED** with every gate green | One of the outputs, for example the MP3 stream, is not being served | Open the station and check **Quality checks** and the event log |
| **New station** is unavailable | The group or the plan is at its channel limit | Remove a station or channel, or ask for a higher limit |

## Through the API

Stations are channels of the radio kind: they are created and changed with the channel routes, and have their own routes for what only radio has.

| Request | Does |
|---|---|
| `GET /api/radio` | Lists stations |
| `GET /api/radio/{id}` | One station |
| `POST /api/radio/{id}/start` and `/stop` | Starts and stops it |
| `POST /api/radio/{id}/air` | Takes it on or off air |
| `GET /api/radio/{id}/nowplaying` | What is playing now |
| `GET /api/radio/{id}/log` | The now-playing log |
| `PATCH /api/radio/{id}/log/{entryId}` | Corrects one entry's class (`{"class": "song"}`, `"ad"` or `"content"`) |
| `GET /api/radio/{id}/delete-impact` and `DELETE /api/radio/{id}` | What removing the station takes with it, and removes it (owners and administrators; stop it first) |
| `POST /api/radio/probe` | Checks a source address, as **Validate source** does |

```bash
curl -H "Authorization: Bearer $TOKEN" "https://your-volt-host/api/radio/$STATION_ID/nowplaying"
```

Every route is in the [API reference](/api-reference).
