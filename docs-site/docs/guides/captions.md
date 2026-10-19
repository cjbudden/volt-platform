---
title: Live captions and translation
sidebar_position: 9
description: Add automatic subtitles to a live channel, in the spoken language and translated into others.
---

# Live captions and translation

Volt can listen to a channel's audio as it goes out, write subtitles from it, and translate them into other languages. Viewers pick a subtitle language in the player.

## What you get

- **Subtitles made from what viewers actually hear.** Captions are made from the delivered audio, so they follow the stream exactly, even when the source stutters.
- **The spoken language is detected automatically**, and subtitles are produced in each **output language** you choose.
- **Readable cues**: at most two lines, timed from the words themselves, and never overlapping.
- **No delay to the picture.** Captioning runs alongside the encode. When captions are on, the player holds live playback back by about 14 seconds, so subtitles are ready by the time viewers reach each moment.

## Turn them on

You can turn captions on when you create a channel, or later in **Settings > Subtitles** (the channel must be stopped):

1. Turn on **Live captions / subtitles**.
2. Choose the **output languages**.
3. Start the channel. With captions on, the first output takes 10 to 20 seconds longer to appear.

## Adjust the timing

If subtitles appear too early or too late, set **Subtitle offset** in seconds. A positive number shows them later, a negative number earlier.

## Good to know

- Captions are automatic. Accuracy depends on the audio: clear speech gives the best results, while music, crowd noise and overlapping speakers are harder. Volt deliberately skips stretches with no speech, rather than inventing text over music or silence.
- If captioning ever falls behind, it skips ahead to stay live. Viewers may lose a few seconds of subtitles once, but never lose them permanently.
