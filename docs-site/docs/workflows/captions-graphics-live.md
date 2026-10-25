---
title: Captions and graphics on a live stream
sidebar_position: 7
description: A channel or event that goes out with live subtitles in the languages you choose and graphics your operators take on and off.
guide: workflow
---

# Captions and graphics on a live stream

Captions and graphics are both added to a live stream as it goes out, but they are set up in different places: captions on the output profile a stream shares with its channel group, graphics on the channel or event itself. This guide puts the two together, so a channel or event starts with subtitles in the right languages and your operators can run scorebugs, lower thirds and tickers over it.

## What it is for

Presentation teams, match-day producers and whoever looks after accessibility use this flow before a channel launches or an event goes live. It saves you from:

- adding subtitles stream by stream: captions are set once on an output profile, and every channel, station and event in the groups using it gets them;
- burning graphics into a source in an outside system: Volt draws them over the picture in its own players, or burns them into the picture, and operators take them on and off from the console;
- finding out on air that subtitles are missing: the stream's page shows whether captions are running, separately from its health.

## Before you start

- A channel or event to work on ([Channels](../guides/channels.md), [Events](../guides/events.md)), in a channel group whose output profile you can change ([Channel Groups](../guides/channel-groups.md)).
- A time when you can stop the streams on that output profile. Captions are read when a stream starts, so a profile cannot be changed while any channel, station or event on it is running.
- A captions engine your Volt service can run. **Gladia (managed service)** is a cloud service charged per minute of audio. **Whisper (self-hosted)** runs on Volt's servers: the **Whisper model** list says which models run inside the stream's own encoder (**runs in the encoder, no GPU**) and which need a **GPU add-on**. Ask your Volt contact which your service has before you rely on captions for a broadcast.
- For graphics burned into the picture, a channel or event in a **Transcode** group. A **Packaging** stream can only show graphics as a player overlay.
- The access each stage needs: see [Who can do it](#who-can-do-it).

## The flow

![Captions settings reach a stream through its channel group's output profile; graphics reach it through assigned setups that operators take on and off](/img/flows/captions-graphics-live.svg)

- **Captions to Channel Groups:** the engine for the account and, per output profile, captions on or off, the language spoken, the caption languages and the hold-back.
- **Channel Groups to Channels or Events:** each group's output profile, read when each of its streams starts.
- **Graphics to live control:** setups assigned to the channel or event, each with where it is shown and how it runs.
- **Live control to the stream:** an operator takes graphics on and off and changes their values; setups that run always, by rule or on a trigger go on air by themselves.
- **The stream to viewers:** a subtitle track per caption language in the HLS and DASH outputs, and the graphics as a player overlay, burned into the picture, or both.

| Step | Section | What happens |
|---|---|---|
| 1 | [Captions](../guides/captions.md) | Choose the captions engine for the account |
| 2 | [Channel Groups](../guides/channel-groups.md) | Find which output profile the channel or event uses |
| 3 | [Captions](../guides/captions.md) | Turn captions on for that profile and choose its languages |
| 4 | [Channels](../guides/channels.md) or [Events](../guides/events.md) | Start the stream; check the subtitles in the **Output** player |
| 5 | [Graphics](../guides/graphics.md) | Build a setup from a template and assign it to the channel or event |
| 6 | [Graphics](../guides/graphics.md) | Run it live: live control for a channel, a rundown for an event |

## Step by step

### 1. Choose the captions engine

1. Open **Admin** and choose **Captions**.
2. Under **Captions engine for the account**, choose **Whisper (self-hosted)** or **Gladia (managed service)**. With **Off**, no stream is captioned, whatever its profile says.
3. Choose **Save engine**. Streams with captions on use it from their next start.

### 2. Find the stream's output profile

1. Open **Admin** and choose **Channel Groups** (or **Channel Groups** at the top of the Captions page).
2. Find the group the channel or event is in (its name is the grey line under it in the Channels and Events lists). The **Output profile** column names its profile.
3. Every channel, station and event in every group using that profile gets the same captions. If only some streams should be captioned, put them in a group with a profile of their own (**New group**, keeping **New profile with the default ladder**). Details are in [Channel Groups](../guides/channel-groups.md#create-a-group).

### 3. Turn captions on for the profile

1. Back on **Captions**, find the profile under **Output profiles**. Its card says which groups use it and how many channels, stations and events that is.
2. If the card shows **running** and **Running now:** with stream names, stop those streams first (**Stop channel** on a channel's page, **Stop event** on an event's page).
3. Turn on **Caption this profile's streams**.
4. Set **Language spoken**, or leave **Detect automatically**.
5. Under **Caption languages**, add each language viewers can choose. At least one is needed.
6. Set **Hold captions back by (seconds)**, a whole number from 0 to 60. 3 to 6 seconds suits most streams.
7. With Whisper, choose the **Whisper model**. Each model says whether it **runs in the encoder, no GPU** or needs a **GPU add-on**.
8. Choose **Save profile**.

The same settings can be changed from a stopped channel: its **Settings**, then **Subtitles**: **Live captions / subtitles**, **Output languages** and **Subtitle offset** (in seconds; a positive number shows subtitles later, a negative one earlier, from the next restart). They are saved to the channel's output profile, so they change every stream on it. Events have no subtitle settings of their own: an event is captioned when its group's profile is. How **Subtitle offset** and **Hold captions back by (seconds)** relate is described in [Captions](../guides/captions.md); this guide does not change either.

### 4. Start the stream and check the subtitles

1. Open the channel and choose **Start channel**, or open the event and let it start at its spin-up time (or choose **Start event**). The header line now ends **captions on**.
2. Expect the first output to take 10 to 20 seconds longer than usual while captions warm up; the **Output** player says so.
3. In the **Output** player, turn on **CC** and choose a language. Subtitles appear as people speak; stretches of music or crowd noise are left blank rather than guessed.
4. Choose **QC** in the stream's header to see the **Captions** line beside the five gates: the engine, the languages and whether it is starting, writing captions or has failed (with **How to fix**). A captions failure never turns the stream red: the stream keeps going without subtitles.
5. For a channel, choose **Go on air** when the output is right. An event is public inside its window. Viewers pick a subtitle language in the player.

This needs a real source with speech and an engine your Volt service runs (step 1). Without them the stream still starts, and the **Captions** line explains why there are no subtitles.

### 5. Build a graphics setup and assign it

1. Open **Graphics** in the sidebar. On the **Templates** tab, choose **Preview** on a template to try it with **Sample data**, then **New setup**.
2. Type the **Setup name**. Under **Where each field gets its content**, choose what each field **Comes from**: **Fixed text**, **Data feed**, **Channel guide**, **Operator** (changed live) or **API**.
3. Under **Position and size**, choose the **Anchor** and nudge it with **Move right (px)** and **Move down (px)**. Choose **Save and assign**.
4. Pick the **Channel or event**. Radio stations are not listed: there is no picture.
5. Under **Shown in**, choose **Player overlay** (drawn by Volt players), **Burned into output** (in every rendition, recording and clip; **Transcode** streams only) or **Both**.
6. Under **How it runs**, choose **Always**, **By rule**, **On a trigger** or **By hand**. Events start on **By hand**, for a rundown or live control.
7. Choose **Assign**. The **On channels and events** tab lists it under the stream.

Each field and option is explained in [Graphics](../guides/graphics.md#build-a-setup).

### 6. Run graphics live

For a channel:

1. On the **On channels and events** tab, choose **Live control** beside the channel. It opens in a window of its own, so you can keep it beside the stream. Each graphic shows **On air** or **Standby**.
2. **TAKE ON** puts a **By hand** graphic on screen; **On for 10 s**, **On for 15 s** or **On for 30 s** take it off by themselves. A graphic that runs by rule offers **Hold on screen** instead.
3. Change a value: **−** and **+** on a number apply at once; after typing text, choose **Update on air**.
4. **TAKE OFF** clears it. **Changes** lists every action and who made it.

For an event:

1. On the **On channels and events** tab, choose the event under **Events without graphics yet**, or **Rundown** beside it.
2. In **Prepare**, choose **Add graphic**: a **Title**, a **Segment**, the **Setup**, its **Content**, the **Cue** and how long it **Stays on**. Choose **Add**.
3. When the event is live, switch to **Run**. **TAKE NEXT** puts the next manual item on air; **TAKE OFF** clears it. Timed cues fire by themselves.

Viewers see a change a few seconds after you make it, in step with the stream. A player overlay is drawn by Volt players only, so downloads and partner feeds do not carry it; burned graphics are drawn by the encoder, so they need a transcode stream that is actually running.

## Who can do it

| Stage | Access needed |
|---|---|
| Choose the captions engine | Owner or Administrator |
| Read the groups and output profiles | Account settings: View |
| Change an output profile's captions on the Captions page | Account settings: Manage |
| Change captions from a channel's **Subtitles** settings | TV channels: Manage |
| Start and stop channels and events | TV channels: Operate, Events: Operate |
| Build setups and assign them, build rundowns | Graphics: Manage |
| Take graphics on and off, change values, run rundowns | Graphics: Operate |

One administrator can do the whole flow. In most teams an administrator sets up captions once, a graphics designer (Graphics: Manage) prepares setups, and a **Graphics Operator** runs them on the day: that role can take graphics on and off but cannot change templates or setups. An **Event Manager** can build and run an event's graphics but cannot change captions. See [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| A profile card on **Captions** shows **running** and cannot be changed | A stream on that profile is running; captions are read at start | Stop the streams it names, change the profile, start them again |
| "Captions are off for the account" on a profile | The engine is **Off** | Choose an engine and **Save engine** |
| The header never says **captions on** | The stream's group uses a different profile from the one you changed | Check the group's **Output profile** in Channel Groups |
| The **Captions** line under **QC** says failed | The engine could not run: for example no GPU capacity for the chosen Whisper model, or the managed service is not available to your Volt service | Read **How to fix**; choose a model that **runs in the encoder, no GPU**, or ask your Volt contact |
| No **CC** button in the **Output** player | Nothing has been transcribed yet, or captions are off for this stream | Wait 10 to 20 seconds after the start, and check speech is reaching the source |
| Subtitles appear early or late | The hold-back does not suit this stream | See [Captions](../guides/captions.md#troubleshooting) and restart the stream after a change |
| "…is packaging only, so its graphics come from the source encoder" when assigning | **Burned into output** needs a transcode stream | Choose **Player overlay** |
| A graphic is on **Standby** when it should be on | It runs by rule or trigger and the guide does not match now | Check the channel's **Rules and day**, or **Hold on screen** in live control |
| Graphics are missing from a download or a partner feed | They are a player overlay | Assign them as **Burned into output** or **Both** on a transcode stream |

## Through the API

| Request | Does |
|---|---|
| `PATCH /api/account-settings/captions` | Sets the engine (`{"provider": "whisper"}`; `none`, `whisper` or `gladia`) |
| `GET /api/groups` | The groups with their output profile, to find which profile a stream uses |
| `PATCH /api/account-settings/captions/profiles/{id}` | Turns captions on for a profile: `enabled`, `sourceLang`, `targets`, `offsetSec`, `modelSize` |
| `POST /api/channels/{id}/start`, `POST /api/events/{id}/start` | Starts the stream with its profile's captions |
| `POST /api/graphics/setups` | Saves a setup from a template version (`name`, `versionId`, `fields`, `placement`) |
| `POST /api/graphics/assignments` | Assigns it (`setupId`, `channelId` or `eventId`, `targets`, `runMode`) |
| `POST /api/graphics/assignments/{id}/air` | Takes it on (`{"on": true}`, optionally `forSec`) or off |
| `POST /api/graphics/rundowns/{eventId}/take` | Takes the next item of an event's rundown |

This turns captions on for a profile in English and Malay:

```bash
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"enabled": true, "sourceLang": "en", "targets": ["en", "ms"], "offsetSec": 4}' \
  "https://your-volt-host/api/account-settings/captions/profiles/$PROFILE_ID"
```

A change to a profile with a running stream is refused with `locked_while_running`. Every route is in the [API reference](/api-reference).
