---
title: Captions
sidebar_position: 9
description: "Live subtitles and translation for channels, stations and events: the engine for the account and the languages each output profile publishes."
guide: section
---

# Captions

Volt can listen to a stream's audio as it goes out, write subtitles from it, and translate them into other languages. Viewers pick a subtitle language in the player. **Admin > Captions** is where the account chooses its captions engine and where each output profile is set: whether its streams are captioned, the language spoken and the languages published.

![The Captions page: the engine for the account at the top, then a card for each output profile with its languages and who uses it](/img/screens/captions.png)

## What it is for

- **Subtitles from what viewers actually hear.** Captions are made from the delivered audio, so they follow the stream exactly, even when the source stutters.
- **Translation.** The spoken language is detected (or named), and subtitles are published in each **caption language** you choose, as selectable tracks in the HLS and DASH outputs.
- **Readable cues.** At most two lines, timed from the words themselves, never overlapping. Stretches with no speech are skipped rather than filled with invented text.
- **One setting for many streams.** Captions are set on an output profile, which every channel, station and event in the channel groups using it shares.

Account administrators choose the engine; whoever looks after output settings sets the profiles.

## Before you start

- An output profile: a profile is made with a channel group (Admin > Channel Groups). A channel, station or event takes its captions from its group's profile.
- The captions engine for the account. With **Off**, no stream is captioned, whatever its profile says.
- The streams on a profile stopped: captions are read when a stream starts, so a profile with a running stream is locked.
- Account administrators and owners choose the engine; **Account settings: Manage** changes a profile (see [Who can do it](#who-can-do-it)).

## Step by step

### Choose the captions engine

1. Open **Admin** and choose **Captions**.
2. Under **Captions engine for the account**, choose:

   | Engine | Means |
   |---|---|
   | **Off** | No stream is captioned |
   | **Whisper (self-hosted)** | Runs on Volt servers, with no per-minute fee. Transcribes about 100 languages; translation adds a translation model |
   | **Gladia (managed service)** | A cloud speech and translation service, charged per minute of audio |

3. Choose **Save engine**. Streams with captions on use it from their next start.

### Caption a profile's streams

1. On the same page, find the profile under **Output profiles**. Its card says which channel groups use it and how many channels, stations and events that is. A change applies to all of them.
2. If the card says **running**, stop the streams it names first.
3. Turn on **Caption this profile's streams**.
4. Set **Language spoken**: name it, or leave **Detect automatically**. Naming it is faster and more accurate.
5. Under **Caption languages**, add each language to publish. At least one is needed.
6. Set **Hold captions back by (seconds)**: the delay that keeps words in step with the picture, in whole seconds from 0 to 60. 3 to 6 seconds suits most streams.
7. With the Whisper engine, choose the **Whisper model**: larger models are more accurate and need more of the server.
8. Choose **Save profile**, then start the streams. With captions on, a stream's first output takes 10 to 20 seconds longer to appear.

### Change captions from a channel

The same settings can be changed from one channel: stop the channel, open its **Settings**, and under **Subtitles** turn on **Live captions / subtitles**, choose the **Output languages** and, if subtitles appear too early or too late, the **Subtitle offset** (a positive number shows them later). These are the profile's settings, so the change applies to every stream on that profile. While any other stream on that profile is running the change is refused, naming those streams, the same as in **Admin > Captions**: stop them first.

## How it connects

| Section | How it relates |
|---|---|
| Channel Groups | Each group uses an output profile; captions are set on the profile |
| [Channels](channels.md), [Radio](radio.md), [Events](events.md) | Captioned when their profile says so; a channel's **Subtitles** settings edit the same profile |
| [Graphics](graphics.md) | Graphics and captions can run on the same stream |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See the captions settings | Any signed-in administrator |
| Choose the captions engine | Owner or Administrator |
| Change an output profile's captions | Account settings: Manage |
| Change captions from a channel's settings | TV channels: Manage |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| A profile card says **running** and cannot be changed | Captions are read when a stream starts | Stop the streams it names, change the profile, start them again |
| "Captions are off for the account" on a profile | The engine is **Off** | Choose an engine at the top of the page |
| **Save profile** is unavailable with captions on | No caption language is chosen, or the hold-back is not a whole number from 0 to 60 | Add a language, or fix the number |
| Subtitles appear early or late | The hold-back does not match the stream | Change **Hold captions back by (seconds)** and restart the streams |
| Gaps in the subtitles during music or crowd noise | Volt skips stretches with no clear speech rather than inventing text | Expected; clear speech gives the best results |
| Subtitles skip a few seconds once | Captioning fell behind and skipped ahead to stay live | Expected; they carry on from there |

## Through the API

| Request | Does |
|---|---|
| `GET /api/account-settings/captions` | The engine, every output profile's captions, and the languages and models offered |
| `PATCH /api/account-settings/captions` | Sets the engine (`{"provider": "whisper"}`; `none`, `whisper` or `gladia`) |
| `PATCH /api/account-settings/captions/profiles/{id}` | Sets a profile: `enabled`, `sourceLang`, `targets`, `offsetSec`, `modelSize` |
| `GET /api/caption-languages` | The languages captions can be published in |

```bash
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"enabled": true, "sourceLang": "en", "targets": ["en", "ms"], "offsetSec": 4}' \
  "https://your-volt-host/api/account-settings/captions/profiles/$PROFILE_ID"
```

A change to a profile with a running stream is refused with `locked_while_running`. Every route is in the [API reference](/api-reference).
