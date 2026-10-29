# In-stream graphic triggers (player graphics)

**Status: built 20 Oct 2026.** First graphic: **Up next**. Code: `src/services/graphicTriggers.ts`
(control plane), `volt-encoder/bin/timed_events.py` (encoder), `volt-player/src/sdk/triggers.ts` (player).
Checks: `test/graphic-triggers.check.ts`, `test/player-triggers.check.ts`, `volt-encoder/bin/test_timed_events.py`.

## The idea

A player learns what to draw, and when, from the manifests it already loads. No side channel and no extra API
call. The data is always in the stream, and each player decides whether to act on it (`showGraphics`).

## The standard

| | HLS | DASH |
|---|---|---|
| Carrier | `#EXT-X-DATERANGE` (RFC 8216 4.3.2.7) in each delivered media playlist | `EventStream` in each `Period` of the delivered MPD |
| What kind | `CLASS="com.boomlabs.volt.graphic"` (programme markers keep `com.boomlabs.volt.programme`) | `schemeIdUri="urn:com:boomlabs:volt:graphic:2026"`, `value="up-next"` |
| Data | `X-` attributes: `X-GRAPHIC`, `X-TITLE`, `X-SUBTITLE`, `X-STARTS`, `X-IMAGE`, `X-PROGRAMME`, `X-ID` | `messageData` = the same as JSON, lower-case keys |
| When | `START-DATE` + `DURATION`, wall clock | `presentationTime` (ms) from the Period's wall-clock start |

Players that don't know the class or scheme ignore it, as both specs require, so partner platforms are unaffected.
Cost: about 250 bytes per trigger, and only while it is inside the playlist window (plus 90 s look-ahead).

```
#EXT-X-DATERANGE:ID="up-next:<programme>",CLASS="com.boomlabs.volt.graphic",START-DATE="2026-10-20T18:28:00.000Z",
  DURATION=12.000,X-ID="up-next:<programme>",X-GRAPHIC="up-next",X-TITLE="Evening Bulletin",
  X-STARTS="2026-10-20T18:30:00.000Z",X-SUBTITLE="Live from the harbour",X-IMAGE="https://..."
```

## The Up next rule

For every content programme with a known end, when the next content programme follows within 5 minutes:
from `leadSec` (default 120) before the end, for `durationSec` (default 12), naming the next content programme.
- Ad and filler items are skipped, both as the programme and as "next".
- A programme shorter than lead + card + 60 s gets no card.
- Per channel or event in `graphics` (migration 0060). The setting is under the channel's settings, "Graphics in the stream".
- Not locked while running: the encoder re-reads every 5 s.

## Flow

```
EPG (programmes) + channel.graphics
   -> control plane: graphicTriggers.ts builds triggers, formats the HLS line and DASH payload
      GET /api/streams/:id/timed-events (ingest token), schedule cached per 6 h block,
      invalidated by the programmes / channels row triggers (0046): edits reach the next poll
   -> encoder: TriggerFeed polls every 5 s, keeps the last good list for 10 min
      companion refresher (every 1 s) writes them into stream_*_cc.m3u8 and manifest_cc.mpd
   -> CDN -> player: Shaka metadataadded (HLS) / timelineregionadded (DASH), Safari DataCues
      -> on screen while currentTime is inside [start, end)
```

**Why the encoder writes them.** In production, viewers fetch playlists from S3 through CloudFront and never pass
the control plane. So `DATERANGE` tags added by the control plane only ever reached local dev (that was the
September build). The encoder already rewrites the delivered copies, so it places the triggers. The control plane
still owns the schedule and the grammar.

**Delivered copies for every video stream.** `master_cc.m3u8` / `stream_*_cc.m3u8` / `manifest_cc.mpd` used to be
written only with captions or failover playout. Now they are written for every transcode and package-only stream,
because they are the files that carry `PROGRAM-DATE-TIME` and the triggers. The packager's own HLS has no wall
clock. `publicLive.ts` hands out the delivered copies for every TV channel and event.

## Player

- `showGraphics` in the player setup (Player setup page, "Show graphics the stream asks for", default on), or the
  SDK option of the same name.
- The stream's own Up next takes priority over one computed from a fetched guide. The existing Up next card in the
  video skin draws it.
- `state.graphics` lists what is on screen, and a `graphic` event fires as each one appears, for custom skins and
  host pages.
- With no guide loaded, the stream's programme marker names what is on (`state.programme`).

## Found by running it (live HLS and DASH through Shaka 4.16, our encoder code, our endpoint)

1. **Shaka splits one `DATERANGE` into a metadata region per attribute and drops `ID`.** The player regroups them by
   class and times. The server repeats the ID as `X-ID`, so a retimed programme replaces the copy the player holds
   instead of appearing twice.
2. **Shaka hands DASH attribute values over still XML-escaped** (`&quot;`). The player unescapes `messageData`
   before parsing.
3. **Timing:** the card appeared within 0.1–0.2 s of its scheduled wall-clock moment as seen by the viewer's
   playhead, and stayed 11.6 of 12 s, on both HLS and DASH. With `showGraphics` off, nothing showed.

## Radio (built 20 Oct 2026)

Same triggers, same standard. A station is a channel row, so `graphicTriggers.ts` already builds its
schedule; what radio lacked was something to write them into its manifests. `radio.py` has no packager to
rewrite, so it now keeps **delivered copies** beside ffmpeg's own files, every second:

- `audio/index_cc.m3u8`: ffmpeg's playlist (which already carries `PROGRAM-DATE-TIME`) plus `EXT-X-DATERANGE`;
- `dash/manifest_cc.mpd`: ffmpeg's MPD plus the `EventStream`;
- once the first copy exists, the run's `master.m3u8` is rewritten to point at `audio/index_cc.m3u8`, so the
  public HLS URL does not change. The public DASH URL is `dash/manifest_cc.mpd` (`publicLive.ts`).

Fails open like the TV path: no control plane means a copy without triggers; a playlist caught mid-write keeps
the last good copy. Job config: `timed_events` in `services/radio/jobConfig.ts`. Image: `Dockerfile.radio`
copies `timed_events.py`. Check: `volt-encoder/bin/test_radio_triggers.py`. Run for real on 20 Oct: a live
station through `radio.py`, Shaka in Chromium, the banner on screen at the trigger's wall-clock second for
its 20 s (Opus in the test because headless Chromium has no AAC; only the codec differed).

**Found by running the check on the Mac:** ffmpeg writes `PROGRAM-DATE-TIME` as `...47.592+1000` (`+0000` in a
UTC container), and Python 3.10, the version Ubuntu 22.04 ships in the images, rejects that offset form. The
playlist then had no window and every radio copy went out without triggers. `timed_events._parse_iso` now
normalises the offset and the fraction (covered in `test_radio_triggers.py`). The TV copies were unaffected:
the encoder writes its own PDT with `Z`.

## The card template and the radio layout

- `kit.upNextCard(ctx, 'overlay' | 'banner')` is the one Up next / Coming up card. The video skin, the
  `audio_nowplaying` skin and the new `audio_radio` skin all use it; custom skins can.
- **Fixed with it:** a stream-timed card's progress bar sat at zero for its whole life (it divided the
  two-minute countdown by the twelve-second card). It now runs over the card's own time on screen
  (`UpNext.shownMs`); `UpNext.startsAt` gives the "18:30".
- `audio_radio` (migration 0061): station logo and name, the programme on air with start, end, a progress bar
  and the time left in words, a waveform, the Coming up banner, a quiet "Next" line between banners (from the
  guide, or with no guide from the stream's next programme marker), and Later from the guide.

## Checking it: the share page

`/share/<token>` plays the delivered copies for TV and events (it played the packager's own master, which has no
wall clock or triggers, so a share preview could never show Up next) and the radio layout for a station. Every
live preview has an **In-stream graphics** panel: the programme marker on now, and each card the manifests
announced with its wall-clock window and state (In 4 min, On screen, Shown). Read from
`player.getStreamGraphics()`.

## Key metadata for now and next (built 28 Oct 2026)

Every programme marker (`CLASS="com.boomlabs.volt.programme"`, DASH `urn:com:boomlabs:volt:programme:2026`) carries the programme's key metadata, so a player can show what is on and what is next from the stream alone, with no guide request. Live channels, events and FAST channels (video and audio) all get it, because the encoder and the FAST playout write the same triggers.

| Attribute | From |
|---|---|
| `X-TITLE`, `X-SUBTITLE`, `X-IMAGE`, `X-KIND` | the programme (image: the programme's, else the asset's poster on the CDN) |
| `X-DESCRIPTION` | programme, else asset; one line, cut at 280 characters on a word |
| `X-GENRE`, `X-SERIES`, `X-SEASON`, `X-EPISODE`, `X-RATING`, `X-YEAR`, `X-LANGUAGE` | programme, else asset (schema.org names such as `contentRating`, `inLanguage`, `releaseYear` are read too) |
| `X-ARTIST`, `X-ALBUM` | songs and audio programmes |
| `X-ASSET`, `X-DURATION` | the library asset behind the programme, and its length in whole seconds |
| `X-MEDIA="audio"` | on an audio FAST channel |
| `X-NEXT-TITLE`, `X-NEXT-START`, `X-NEXT-ID`, `X-NEXT-SUBTITLE`, `X-NEXT-IMAGE` | the next content programme |

Only what is set is written. Up next cards repeat the next programme's genre, series, season, episode, rating, artist and description. In DASH the same keys are in the event's JSON `messageData`, lower case (`next-title`).

```
#EXT-X-DATERANGE:ID="<programme>",CLASS="com.boomlabs.volt.programme",START-DATE="2026-10-28T10:00:00.000Z",DURATION=1800.000,
  X-TITLE="Episode 3",X-DESCRIPTION="A quiet town, and a storm.",X-GENRE="Drama, Mystery",X-SERIES="Drama Hour",X-SEASON="1",X-EPISODE="3",
  X-RATING="M",X-ASSET="…",X-DURATION="1800",X-NEXT-TITLE="Episode 4",X-NEXT-START="2026-10-28T10:30:00.000Z",X-ID="<programme>"
```

The Volt player turns these into `state.programme` and `state.nextProgramme` (`description`, `imageUrl`, and `meta` with the rest, keys lower case with underscores), whether or not stream graphics are drawn. With no next marker in the look-ahead yet, `nextProgramme` comes from the current marker's `X-NEXT-*`. Built in `services/graphicTriggers.ts` (`keyMetadata`), checked by `test/stream-metadata.check.ts`.

## Next graphics

New graphic types are a new `graphic` value and rule in `buildTriggers`, plus a renderer in the player. Candidates:
programme lower third at the start of a programme, promo bug, "Live" / "Replay" flag, sponsor slate. Data that
changes second by second (scores, clocks) does not belong in manifest triggers. That is the burn-in path, or a
player data feed.
