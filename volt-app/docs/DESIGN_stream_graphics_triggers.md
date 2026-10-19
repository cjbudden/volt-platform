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

## Next graphics

New graphic types are a new `graphic` value and rule in `buildTriggers`, plus a renderer in the player. Candidates:
programme lower third at the start of a programme, promo bug, "Live" / "Replay" flag, sponsor slate. Data that
changes second by second (scores, clocks) does not belong in manifest triggers. That is the burn-in path, or a
player data feed.
