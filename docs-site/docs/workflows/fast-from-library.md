---
title: A FAST channel from the library
sidebar_position: 5
description: Turn titles in your Media Library into a linear channel that loops, writes its own guide, carries ad breaks and reaches viewers as a live stream.
guide: workflow
---

# A FAST channel from the library

You have films, shows or series in the Media Library and want them on air as a free, ad-supported linear channel, without anyone building a schedule by hand. This workflow takes titles from the library into a run order, lets Volt write the programme guide from it, fills the ad breaks, and gives viewers the channel as a live stream.

## What it is for

Programmers and channel managers use it to launch or refresh a FAST channel: a movie channel, a single-series channel, or a genre channel for FAST platforms and your own apps.

It saves the work that a linear channel usually needs:

- **No schedule to type.** The run order loops pass after pass, and each pass starts at a different time of day, so titles spread across the week on their own. Volt writes the guide from it and keeps it written ahead.
- **No encoder to run.** The channel is played out from media that is already packaged, so nothing is transcoded while it is on air.
- **One place for ad breaks.** Breaks are planned with the run order, written into the guide, and filled with house spots, a slate or ads from your ad server.

## Before you start

- **Titles in the [Media Library](../guides/media-library.md)** that can air: packaged, or with their uploaded file still kept in Volt. For a series slot, the episodes need their series, season and episode number in their metadata (see step 1).
- **Short house spots and a slate** in the Media Library if the channel will carry ad breaks: spots of two minutes or less, and a slate of a minute or less.
- **Room in a [channel group](../guides/channel-groups.md).** A FAST channel counts towards the group's share of the plan like any channel.
- **For stitched ads**, the VAST tag URL of your ad server.
- **A deployment where FAST channels play out.** The console lets you build, activate and check a channel anywhere, but the stream itself only plays where Volt's FAST playout runs. Your Volt deployment does this for you; the **On air** tab shows whether it is running (step 5).

## The flow

![Titles go from the Media Library into a FAST run order; activating it writes the EPG; the playout plays the guide to viewers](/img/flows/fast-from-library.svg)

- **Media Library to FAST:** the titles and series that can air are offered in the run order's library.
- **FAST to EPG:** activating the run order writes its programmes and ad breaks into the channel's guide.
- **EPG to the playout:** the channel plays what the guide says, programme by programme, with the breaks in place.
- **Playout to viewers:** once the channel is public, viewers get it as live HLS and DASH.

| Step | Section | What happens |
|---|---|---|
| 1 | [Media Library](../guides/media-library.md) | Titles are uploaded and described: content type, series, season and episode |
| 2 | [FAST](../guides/fast.md) | A channel is created and its run order built from the library |
| 3 | [FAST](../guides/fast.md#set-up-ads) | The **Ads** tab decides how breaks are signalled and filled |
| 4 | [FAST](../guides/fast.md#put-it-on-air), [EPG](../guides/epg.md) | Activating the run order writes the programmes and breaks to the guide |
| 5 | [FAST](../guides/fast.md#put-it-on-air) | **On air** shows the playout and the media; the channel is made public |
| 6 | [Live Streams](../guides/live-streams.md), [Embed the player](../guides/embedding.md), [EPG](../guides/epg.md#send-the-guide-to-partners-xmltv-export) | Viewers get the stream and the guide |

## Step by step

### 1. Get the titles ready in the Media Library

1. Open **Media Library** and upload the titles, house spots and slate (drop them on **Drop files or a folder here**, or choose **This device**). Each file is encoded after it arrives; see [Upload files](../guides/media-library.md#upload-files).
2. For a series, open each episode, go to **Metadata**, set the **Content type** to **Programme / episode**, fill in **Title** (it is required), **Series**, **Season** and **Episode number**, and choose **Save metadata**. Episodes with the same **Series** are grouped into one series in the FAST library.
3. A title with a rights window only airs inside it. Set **Available from** and **Expires** on the asset's **Availability** tab if a title is licensed for a limited time.

The FAST library only offers titles that can air. A title whose original file is no longer kept, and that was never packaged for FAST, is left out and counted under the library's **Not shown** line.

### 2. Create the channel and build the run order

1. Open **FAST** and choose **New FAST channel**. Enter a **Name**, choose **Video** or **Audio** under **Channel type** (it cannot be changed later), the **Group** and the **Time zone**, then **Create and build lineup**.
2. On **Run order**, choose titles under **Library** (**Titles** or **Series**) to add them as slots. Add **+ Alternates (take turns)** to a title slot, or set a series slot's **Episodes each time**, **Order** and **At the end**.
3. Read **What this run order does to a week**, then set the **Channel clock**: **Restart the run order daily**, **Round programmes up to**, **Rotate the run order each pass**, **Keep the guide written ahead** and the backfill title for **When a title is outside its rights window, play instead**.
4. Check **Week** and **Repeats** to see the guide the run order will write.
5. Choose **Save draft**. Nothing airs yet.

The [FAST guide](../guides/fast.md#build-the-run-order) explains every slot and clock setting.

### 3. Set up the ad breaks

1. Open **Ads** and choose **No ads**, **Ad markers for a FAST platform** or **Stitched ads from your ad server**.
2. Set **How much and where** (for example **Ad load** in minutes per hour), or tick **Use the title's own break points**.
3. Under **House spots and slate**, add spots with **+ Add a promo or sponsor spot** and choose a **Slate**. These fill every break nobody has sold, and every break when the ad server is slow or down.
4. For stitched ads, choose **Stitched ads from your ad server**. With no ad server yet, the **Ad server** card opens: enter its **Name**, **Vendor**, **VAST tag URL** and **Time budget** and choose **Add and use**. Stitched ads are saved with that server; until then the channel keeps its previous ad setting. Change the server later under **Ask**, add more with **+ Add ad server**, and choose how to **Decide**.

Ad settings are saved as you change them. Break lengths reach the guide when you activate (step 4); on a channel already on air, choose **Rewrite guide** after changing them.

Stitched ads need a real ad server that answers your VAST tag. With **Ad markers for a FAST platform**, the platform that carries the channel replaces the house spots with its own ads, so nothing more is set up in Volt.

### 4. Activate: the guide is written

1. Choose **Activate and go on air**. Volt confirms **On air.** with how many programmes and ad breaks were written to the guide.
2. If the message says programmes entered by hand overlap it, open the channel's guide in **EPG** and remove or move them.
3. Open **EPG**, choose **Channels**, and **Open** the channel's guide. Each programme of the run order is listed with its times, a week or more ahead. Volt keeps it written as far ahead as **Keep the guide written ahead** says.

Activating also checks every title, house spot and slate the channel uses, and prepares any that are not yet ready to air. The message says how many are being prepared.

### 5. Check the playout and make the channel public

1. Open **On air**. **Playout** shows the channel's state (**Playing**, **Starting**, **Not responding** or **Failed to start**), **Runs on**, **Last heard from**, **Restarts** and **Segments published**.
2. **Media** lists every title, house spot and slate with **Ready**, **Preparing**, **Needs preparing** or **No source**. Choose **Prepare** (with the number) if any need preparing.
3. When the playout is **Playing**, **Preview** plays the channel's own feed. Check it.
4. Turn on **Public**. **The channel is public.** confirms it. Until then only the console can preview it. **Public** can be turned on only with an active run order (step 4).

The playout and the preview need a real deployment of Volt: the FAST playout runs there, on its own, for each channel with an active run order. If it stays on **Starting**, nothing is writing the channel yet.

### 6. Where viewers get it

- **The stream.** Once a run order is active, the channel's page header shows **output HLS / DASH**, the public addresses of the live stream. They play only while the channel is **Public** and its playout is running; otherwise viewers are told the channel is not available.
- **Your website and apps.** The channel is a channel like any other: embed it with the Volt player using its id ([Embed the player](../guides/embedding.md)), or play it with the [player SDK](../guides/player-sdk.md).
- **FAST platforms.** Give the platform the HLS address. With **Ad markers for a FAST platform**, the breaks are signalled in the stream for the platform's own ads.
- **The guide.** Partners and guide providers take the channel's guide from an XMLTV feed ([XMLTV export](../guides/epg.md#send-the-guide-to-partners-xmltv-export)).
- **The console.** **Live Streams** lists the channel under **FAST** with every other stream.

### Changing it later

Edit the run order or the clock and Volt makes a draft; the channel keeps playing the active version. Choose **Activate (carry on from now)** to switch to it without a jump: the run order and every series carry on from where they were. New titles you add to the Media Library appear in the FAST library straight away.

## Who can do it

| Stage | Access needed |
|---|---|
| Upload titles | Files, uploads & storage: Manage, and Account settings: Manage |
| Set content type, series and episode | Media library & publishing: Manage |
| See FAST channels, run orders and reports | TV channels: View |
| Activate a run order, make the channel public | TV channels: Operate |
| Create a channel, build the run order, set ads | TV channels: Manage |
| Read the guide Volt writes | EPG & schedules: View |
| Change programmes by hand, set up XMLTV feeds | EPG & schedules: Manage |

An Owner or Administrator can run the whole flow. Otherwise a media librarian prepares the titles and a channel manager builds and runs the channel. Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **No video assets can air yet** in the FAST library | Nothing in the library is packaged or still has its file in Volt | Upload titles in the Media Library |
| A title you uploaded is not in the FAST library at all | It is not encoded yet, or its row in the Media Library says **Encode failed** | Wait for the encode to finish; upload it again if it failed |
| **Not shown:** with a number of assets **with no usable source** | Those titles cannot be played out or prepared | Upload them again |
| **No series yet** under **Series** | No asset has a **Series** in its metadata | Set **Programme / episode** and fill in **Series**, **Season** and **Episode number** (step 1) |
| **Activate and go on air** is greyed out | The run order has no slots | Add at least one title or series |
| The activation message says programmes entered by hand overlap it | The channel's guide already had programmes in that time | Remove or move them in the channel's guide in EPG |
| **Public** cannot be turned on; it reads **Activate the run order first** | The channel has no active run order, so it has nothing to play | Activate the run order, then turn on **Public** |
| New ad settings are not in the guide | Break lengths reach the guide when it is written | Choose **Rewrite guide**, or activate the draft |
| **Needs preparing** in **Media** | A title is not yet packaged for the channel | Choose **Prepare** |
| **No source** in **Media** | The title's file is gone, so it cannot be prepared | Upload it again |
| **Starting**, and **The preview starts once the playout is writing the channel.** | The playout has not started writing the channel | Wait a minute; in a real deployment it starts on its own after activation |
| **Not responding** | The playout has not been heard from recently | Volt restarts it by itself; if it stays, contact your Volt administrator |
| Viewers get nothing | The channel is still **Private**, or the playout is not running | Turn on **Public** in **On air** and check **Playout** |

## Through the API

| Request | Does |
|---|---|
| `PUT /api/vod/{id}` | Sets an asset's content type (`schemaId`) and `metadata` (`series`, `season`, `episodeNumber`) |
| `POST /api/fast/channels` | Creates the channel with a draft run order (`name`, `groupId`, `zone`, `media`) |
| `GET /api/fast/library?channel={id}` | The titles and series that can air on it |
| `PUT /api/fast/lineups/{id}` | Saves the draft run order and clock |
| `POST /api/fast/lineups/{id}/preview` | The week it would make, without saving |
| `POST /api/fast/ad-servers` | Adds an ad server (`name`, `vendor`, `tagTemplate`, `timeoutMs`) |
| `PUT /api/fast/channels/{id}/ads` | Sets the ad mode, policy, house spots, slate and `adServerId` |
| `POST /api/fast/lineups/{id}/activate` | Activates it and writes the guide |
| `GET /api/epg?channelId={id}&from=…&to=…` | The programmes written to the guide |
| `GET /api/fast/channels/{id}/readiness` | Whether each title, spot and slate is ready to air |
| `POST /api/fast/channels/{id}/on-air` | Makes it public (`{"on": true}`, refused with 409 until a run order is active) or private |
| `GET /api/fast/channels/{id}` | The channel, its playout and its public HLS and DASH addresses |

```bash
curl -X POST "https://your-volt-host/api/fast/channels/$CHANNEL_ID/on-air" \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"on": true}'
```

Every route, with its fields, is in the [API reference](/api-reference).
