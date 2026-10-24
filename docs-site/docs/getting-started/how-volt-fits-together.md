---
title: How Volt fits together
sidebar_position: 1.5
description: A map of every section of the console and the main ways work flows between them.
guide: map
---

# How Volt fits together

Volt is one console for live and on-demand media. Each section of the console does one job, and most real work passes through several of them: a schedule in the guide starts a recording, the recording becomes a clip, a rule publishes the clip. This page is the map. Each section has its own guide for the detail.

![The main flows between the sections of Volt](/img/flows/how-volt-fits-together.svg)

## The sections

The console has a daily area, for running streams and media, and an **Admin** area, for setting up how the account works. The **Admin** entry at the bottom of the sidebar opens it, and **Back to** at the top of the Admin sidebar returns you to the page you left. You see the sections your role allows.

### Overview: what is happening now

| Section | What it is for |
|---|---|
| **Dashboard** | What is broken, what is on air, and what is waiting on you |
| **Live Streams** | Every channel, station and event that is running, with the same health checks the detail pages show |
| **Monitoring** | Problems only: a healthy account leaves it nearly empty |
| **Multiview** | Confidence monitors showing what viewers are actually given |
| **Analytics** | Audiences, operations and playback quality over time |

### Broadcast: the live streams and what shapes them

| Section | What it is for |
|---|---|
| **Channels** | Live channels that run around the clock: a source in, adaptive outputs out, with backup sources and failover ([first channel](first-channel.md), [status](../guides/channel-status.md), [failover](../guides/failover.md)) |
| **Radio** | Audio-only stations with MP3, HLS and DASH outputs and a now-playing log |
| **Events** | Scheduled one-off broadcasts: the stream starts for its window, then recordings and replays follow the event's settings |
| **FAST** | Channels played out from the library: a run order of programmes that loops, with the guide written for you and ad breaks signalled |
| **EPG** | The programme guide for each stream: what is on when, and per slot, where it can be watched, what replaces it and what is clipped afterwards ([guide](../guides/epg.md)) |
| **Loops & Fillers** | What a stream shows when its source goes away |
| **Graphics** | Templates, the setups built from them, and what is on air now |

### Media: everything recorded, cut or uploaded

| Section | What it is for |
|---|---|
| **Media Library** | Every on-demand asset: what it is, how it was encoded and where it was published |
| **Recordings** | Everything a stream has sent out, to search, scrub and clip across the retained range |
| **Image Library** | Watermarks, slates, posters and channel brands, with an image service for any size ([guide](../guides/images-and-thumbnails.md)) |
| **Review** | Clips waiting for a decision, with what quality checks already found |

### Admin: media setup

| Section | What it is for |
|---|---|
| **Encoding Profiles** | The ladders that uploaded and watch-folder files are encoded to |
| **Watchfolders** | Folders Volt watches for new files to ingest |
| **Storage** | What media exists, where it lives, and what retention will do to it next |
| **Workflows** | The steps every stream, recording and file goes through, and where each piece of work is now |
| **Content Types** | What metadata each kind of content carries, and which guide fields it fills |
| **Publishing Rules** | Where on-demand content goes when it is published, and who can watch it, where and until when |
| **Ingest Rules** | What happens to a file when it arrives: its name, where it is filed, duplicates, required metadata |
| **Channel Groups** | The groups every channel, station and event sits in; a group sets the output profile and its share of the plan |
| **Captions** | Live subtitles and translation: the engine for the account and the languages each output profile publishes ([guide](../guides/captions.md)) |
| **Formats & reframing** | Which social formats Volt makes from your widescreen media, and how it keeps the subject in frame |

### Admin: account and access

| Section | What it is for |
|---|---|
| **Account settings** | Your logo and colours, and where your content can be watched ([guide](../guides/account-settings.md)) |
| **Plan & limits** | What your plan allows, and how the channel groups share it |
| **Fleet & Usage** | The servers running your streams and the billable time they have used |
| **Payments** | The payment providers you use and what each product buys |
| **Social accounts** | The social channels, Pages and accounts clips can be published to |
| **Notifications** | The alerts Volt sends to the people who run the account |
| **Users & Roles** | Who can sign in to the console and what they can do, and the viewers who watch ([roles and access](roles-and-access.md)) |
| **Permissions map** | What each kind of user can do, area by area, including your own roles |
| **API Keys & Apps** | The apps that play your content and the keys your own servers use ([authentication](../api/authentication.md)) |
| **Audit log** | Who changed what and when, including every delete ([guide](../guides/audit-log.md)) |

## The main flows

These are the paths most work follows. Each will get its own step-by-step guide.

| Flow | Sections it passes through |
|---|---|
| **A 24/7 channel that never goes dark** | Channel Groups, Channels (primary and backup sources, failover), Loops & Fillers, Monitoring and Notifications |
| **The guide drives recording and publishing** | EPG (the schedule), Recordings (what aired), Media Library (each programme as an asset), Publishing Rules and Social accounts (where it goes) |
| **A live event from start to finish** | Events (schedule and window), EPG, Recordings, Review, Media Library (the replay), Analytics (who watched) |
| **From upload to published** | Watchfolders or an upload, Ingest Rules, Content Types, Encoding Profiles, Media Library, Publishing Rules |
| **A FAST channel from the library** | Media Library (the programmes), FAST (the run order), EPG (written for you) |
| **A radio station with now playing** | Radio (the station and its log), EPG, Recordings |
| **Captions and graphics on a live stream** | Captions (engine and languages), Channels or Events (turned on per stream), Graphics (templates and live control) |
| **Securing a live stream** | Account settings and EPG (where it can be watched), API Keys & Apps (which apps can play it), Payments and Users & Roles (who can watch) |

Underneath every flow, **Dashboard**, **Live Streams** and **Multiview** show what is running, **Storage** and **Workflows** show what is being kept and done, and the **Audit log** records who changed what.

## Where to go next

- New to Volt: read [Key concepts](overview.md), then [set up your first channel](first-channel.md).
- Setting up your team: [Roles and access](roles-and-access.md).
- Running channels: [channel status](../guides/channel-status.md) and [input failover](../guides/failover.md).
- Building the schedule: [the programme guide](../guides/epg.md).
- Writing code against Volt: the [API overview](../api/overview.md).
