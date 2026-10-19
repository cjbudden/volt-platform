---
title: Set up your first channel
sidebar_position: 2
description: Create a channel, connect a source, start it, check the output and go on air.
---

# Set up your first channel

This walk-through takes a channel from nothing to on air. You need the **TV channels: Manage** level (see [roles and access](roles-and-access.md)) and a live source you can send or point Volt at.

## 1. Create the channel

1. Open **Channels** and choose **New channel**.
2. On the settings tab, give the channel a **name** and, if you have one, a **logo**. The logo is shown in lists, on the channel page and in the programme guide.
3. Choose the **type**:
   - **Transcode** if you send one high-quality source and want Volt to build every output size for you.
   - **Packaging** if you already send a full ladder of encoded renditions and want Volt to package them as they are.
4. Pick a **group**. A group that is already full cannot be picked, and the form says why.
5. Add the **primary source**: choose the protocol (for example SRT, RTMP or HLS) and enter its address. You can add a **backup source** now or later.
6. Optionally choose the output ladder, filler for when no source is available, subtitles and a watermark. All of these can be changed later in the channel's settings.
7. Choose **Create**.

If something stops the channel being created, the reason is shown at the bottom of the form, whichever tab you are on.

## 2. Start the channel

Open the channel. The **Start channel** button brings the encoder up and begins receiving the source. Volt asks you to confirm, because a running channel is metered from that moment.

While it starts, the five gates across the channel page (Server, Input, Encoder, Output, On air) turn from grey to blue and then green. [Channel status](../guides/channel-status.md) explains every word and colour you might see.

:::note
Sources, failover, filler, catch-up (DVR), the output ladder, subtitles and the watermark are read when the channel starts. While it is running they are locked. Stop the channel to change them.
:::

## 3. Check the output

The channel page shows two players side by side:

- **Source**: what Volt is receiving.
- **Output**: what Volt is producing. It waits for the source to arrive, warms up for a few seconds, then shows **ready to go live**.

Watch the output and check picture, sound and subtitles before you go public. At this point the stream is still private.

## 4. Go on air

When the output is producing valid content, the **Go on air** button becomes available. It opens the public URL, and the overall status changes to **ON AIR**.

| Button | What it does |
|---|---|
| **Go on air** | Opens the public URL. Only available once the output is valid. |
| **Take off air** | Closes the public URL. The encoder stays up and the preview keeps playing. |
| **Stop channel** | Brings the whole encoder down. Viewers lose the stream. |

## 5. What to do next

- Add a [programme guide](../guides/epg.md) so players show what is on now and next.
- Turn on [input failover](../guides/failover.md) and test it before an important broadcast.
- Put the channel on your website with the [embed player](../guides/embedding.md).
- Share a private preview link with a colleague or client from the **Share** button on the channel page.
