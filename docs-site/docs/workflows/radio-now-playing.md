---
title: A radio station with now playing
sidebar_position: 6
description: Run a radio station whose song titles reach listeners' players, fill the station's guide, and let you find and clip any song from the recording.
guide: workflow
---

# A radio station with now playing

Your station already sends its song and programme titles inside its stream, as most Icecast and SHOUTcast stations do. This workflow brings that stream into Volt so listeners see the song as they hear it, every title is kept as a timed log in the station's guide, and any song, advert or talk segment can be found and clipped from the recording later.

## What it is for

Radio managers and station operators use it to put a station on air with now playing, without typing a playlist anywhere.

- **Now playing for listeners.** The titles in your stream go out with the audio on every output, so players show the song as it is heard.
- **A log nobody keeps by hand.** Each title change becomes an entry with when it started and ended, classed as a song, an advert or content (news, presenter talk, interviews).
- **Clips without hunting.** In Recordings the log marks every song on the timeline, so one click marks it for a clip.

## Before you start

- **An Icecast or SHOUTcast source** that sends now-playing titles (ICY metadata): the address of the station's mount, usually ending in the stream's name. HLS and SRT sources carry audio but no titles, so a station fed by them has no now-playing log (see [Troubleshooting](#troubleshooting)).
- **Room in a [channel group](../guides/channel-groups.md).** A group's limit counts TV channels and radio stations together.
- **Radio stations: Manage** to create the station (see [Who can do it](#who-can-do-it)).

## The flow

![The source sends audio and titles to the station; the station sends them to listeners, logs each title in the EPG and records the audio; Recordings uses the log to clip songs into the Media Library](/img/flows/radio-now-playing.svg)

- **Source to Radio:** the audio, with each now-playing title in the stream's metadata.
- **Radio to listeners:** MP3, HLS and DASH, each carrying the current title.
- **Radio to EPG:** every title change, as a timed entry in the station's guide.
- **Radio to Recordings:** the station's audio, kept for the period you choose.
- **EPG to Recordings:** the log entries, which mark each song and programme on the recording's timeline.
- **Recordings to Media Library:** the clips you cut.

| Step | Section | What happens |
|---|---|---|
| 1 | [Radio](../guides/radio.md) | The station is created from the Icecast source, with its outputs, the now-playing log and recording turned on |
| 2 | [Radio](../guides/radio.md#start-a-station-and-listen) | The station is started, checked and taken on air; titles reach listeners |
| 3 | [Radio](../guides/radio.md#read-and-search-the-now-playing-log) | The station's page shows what is playing now and the received log |
| 4 | [EPG](../guides/epg.md#radio-stations) | The log is kept on the station's guide, beside any programmes you schedule |
| 5 | [Recordings](../guides/recordings.md) | The recording is searched and clipped by the log; clips go to the [Media Library](../guides/media-library.md) |

## Step by step

### 1. Create the station

1. Open **Radio** and choose **New station**.
2. Enter a **Station name**. Leave **Type** on **Packaging**.
3. Under **Audio source**, choose **Icecast / HTTP audio** and paste the mount's address.
4. Choose **Validate source**. Volt checks the source plays, lets you listen to a sample and reads the station's name, genre, bitrate and artwork from the stream, each with a button to use it.
5. Under **Outputs**, keep **MP3 stream**, **HLS (audio-only)** and **DASH** on, and pick the **Output bitrate**.
6. Under **Metadata log**, turn on **Capture now-playing log**. This switch is only offered for an Icecast source.
7. Under **Recording**, turn on **Recording and clipping**, and set **Keep recordings for** if you do not want to keep recordings indefinitely.
8. Choose **Create station**.

The [Radio guide](../guides/radio.md#create-a-station) explains each field.

### 2. Start it, check it and go on air

1. Open the station and choose **Start station**. Volt connects to your source and starts the outputs and the recording.
2. Unmute the monitor to listen, and play **MP3**, **HLS** and **DASH** under **Output previews** to check each output.
3. When the output is producing audio, choose **Go on air**. The public addresses of the three outputs open, and **Output previews (public URLs)** lists them with a **Copy** button each.

Starting a station needs a real source that Volt can reach. In your deployment the level meter moves and the first titles appear within a few seconds of **Start station**.

### 3. What listeners get

- **MP3 stream:** the current title is passed through as the stream's own now-playing text, so hardware receivers, car radios and apps like VLC show it.
- **HLS and DASH:** each title change is carried in the audio as timed metadata, so web and app players that read it (Safari, and the common web players) show the song at the moment it is heard.
- **The Volt player:** choose **Player** on the station's page to style an embeddable player with the audio skins. They show the track now playing with its artwork, otherwise the programme on air. See [Embed the player](../guides/embedding.md) and the [player SDK](../guides/player-sdk.md).

### 4. Read now playing on the station page

The station's page shows, while it runs:

- **Now playing**, beside the player: the current title with its class (**Song**, **Ad** or **Content**), how long it has been playing and how many listeners there are across MP3, HLS and DASH.
- **Station metadata:** what the source announces about itself (**Station**, **Genre**, **Website**, **Source bitrate**, **Content type**) and how many **Title changes** have been received.
- **Programme guide:** the station's guide around now, the same strip a channel has.
- **Received metadata log:** every title received, newest first, with **When**, **Length**, **Title** and **Class**. Filter by **Songs**, **Ads** or **Content**, by **Period**, hide short entries with **Hide shorter than**, sort, or **Search titles…**. Click a title to open its clip, or the recording at exactly that time.

The class comes from the shape of the title: "Artist - Title" is a song, advert and sponsor wording is an ad, everything else is content.

### 5. The log in the station's guide

1. Open **EPG**, choose **Radio stations**, and open the station's guide (**Open**, or **Build** if it has nothing yet).
2. The log entries are in the guide with their start and end times, as they aired.
3. To say which show is on (a breakfast show, the news hour), add programmes with **Add programme**, as for any guide. They are shown in the station's **Programme guide** strip and in players that show the programme on air.
4. Turn on **Auto VOD** for a programme to have it cut from the recording as an on-demand asset when it ends.

See [the EPG guide](../guides/epg.md#add-a-programme) for adding and repeating programmes.

### 6. Find a song in the recording and clip it

1. Open **Recordings** and choose **Radio**. To find when a song was played, type part of its title in **Search names, programmes and songs…**: the station is listed with **Played:** and the latest time it aired. Open the station.
2. The **Timeline** shows the waveform with an **On air** lane of the logged titles. Drag across it, or use **Jump to a date and time**, and open the range in the clipper.
3. In the recording, click a song in the metadata lane: the in and out marks snap to it and its title fills **Clip title**.
4. Choose an **Output** (**Streaming (HLS/DASH)**, **Downloadable MP3** or **Streaming + MP3**) and choose **Create clip**.
5. The clip is listed in the [Media Library](../guides/media-library.md), named after the song, ready to publish.

From the station's page, **open in the clipping workbench** (beside **Recording since**) goes straight to the recording that is open now.

## Who can do it

| Stage | Access needed |
|---|---|
| Create the station, change its settings and the log switch | Radio stations: Manage |
| Start, stop, go on air | Radio stations: Operate |
| See the station's page and its log | Radio stations: View |
| Add programmes to the station's guide, turn on **Auto VOD** | EPG & schedules: Manage |
| Play and search recordings | Recordings & clips: View |
| Cut a clip | Recordings & clips: Manage |
| Open **Player** to style the embeddable player | Apps, API keys and players: View |

The **Radio Manager** role covers the station, its guide and its clips; an Owner or Administrator can do everything, including the player setup. Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **Capture now-playing log** is not offered | The source is HLS or SRT, which carry no titles | Use the station's Icecast or SHOUTcast mount as the source |
| The station page says the source **carries no track metadata** | The same: there is no now-playing title to receive | Use an Icecast mount, or add programmes to the station's guide to say what is on |
| **ICY headers appear here once the source connects and announces itself.** | The station has not received the source's headers yet | Start the station; if it stays, check the address with **Validate source** |
| **Received metadata log** stays empty on an Icecast station | The station is stopped, the log is off, or the source sends no titles | Start the station and turn on **Capture now-playing log** in **Settings** |
| A song is classed as **Ad** or **Content** | Its title did not look like "Artist - Title" | Choose **Song** in its **Class** column on the station's page (Radio stations: Operate) |
| Listeners see no title | Their player does not read now-playing data, or the station is off air | Check with the Volt player; MP3 receivers need the MP3 output on |
| The station is not under **Radio** in Recordings | It has not run with recording on | Turn on **Recording and clipping** in **Settings**; it applies from the next start |

## Through the API

| Request | Does |
|---|---|
| `POST /api/radio/probe` | Checks a source address, as **Validate source** does |
| `POST /api/channels` | Creates the station (a channel of the radio kind) |
| `POST /api/radio/{id}/start` | Starts it |
| `POST /api/radio/{id}/air` | Takes it on or off air |
| `GET /api/radio/{id}/nowplaying` | What is playing now |
| `GET /api/radio/{id}/log` | The received now-playing log |
| `GET /api/epg?channelId={id}&from=…&to=…` | The station's guide, with the log entries |
| `GET /api/recordings/sources?type=radio` | Stations with recordings |
| `GET /api/recordings/{id}/programmes` | The logged titles for a span of a recording |
| `POST /api/recordings/{id}/clip` | Cuts a clip |

Players read now playing with the publishable key through the public player API, as the Volt player does.

```bash
curl -H "Authorization: Bearer $TOKEN" "https://your-volt-host/api/radio/$STATION_ID/log"
```

Every route, with its fields, is in the [API reference](/api-reference).
