# Skip intro, recap and credits on on-demand assets

**Status: built 20 Oct 2026.** Code: `src/services/introDetect.ts` (detection), `src/services/vodMarkers.ts` (store,
series, playlist annotation), `src/services/jobs/handlers/vodMarkers.ts` (job), `src/modules/vod.ts` (API),
`volt-web/src/SkipMarkers.tsx` (editor, the asset's "Skip markers" tab), `volt-player/src/sdk` (Skip button).
Migration `0062_vod_markers.sql`. Checks: `test/vod-markers.check.ts` (detection on real audio, the playlists,
series), `test/player-triggers.check.ts`.

## What a viewer gets

On an **on-demand** item, while the playhead is inside a marked stretch, the player shows **Skip intro**, **Skip
recap** or **Skip credits**. One press jumps to the end of it; Skip credits on a playlist item plays the next item.
Live and FAST playback never show it: only the on-demand playlists carry the markers, and the player ignores them
when the stream is live.

## How intros are found

There is no reliable way to find an intro inside one programme on its own. What an intro is, is the same audio in
every episode. So each episode is fingerprinted (Chromaprint, through ffmpeg's own `chromaprint` muxer: no extra
tool) over its opening 10 minutes, compared with up to four other episodes of the series, and the longest shared
stretch is the intro; the closing 7 minutes give the credits.

- A match is a run where the fingerprints differ in at most 10 of 32 bits, **densely** (60% of a 2 s window), so
  unrelated audio cannot chain into a false match.
- Accuracy on real encodes (including a louder MP3 copy): within 0.25 s of the true theme times, after a fixed
  0.7 s alignment correction measured on those encodes.
- Confidence = the share of comparisons that agree. 0.5 and up goes straight into the outputs; below that it is a
  **suggestion** shown in the console only, until someone presses "Use it".
- Runs after every build (`clip.extract`, `vod.encode`), and "Detect now" in the console. A new episode also
  refreshes its peers' automatic markers, so episode 1 gets its intro when episode 2 arrives.
- Series: the episode metadata's `series`, else the guide programme the asset was recorded from (its title on its
  channel), else the asset's own title with episode numbers and dates removed.
- Cost: audio only, a few seconds per episode.

## Editing, any time

The "Skip markers" tab on an asset: a timeline with the ranges (drag an edge, or move the whole range), "Start
here" / "End here" from the playhead, typed times, Preview, Remove, "Add at playhead". The player there is the
admin player on the asset's own playlist, so its Skip button is exactly what a viewer gets; after a change the
playlist reloads where you were.

A marker a person sets, moves or accepts is `manual`, and detection never changes it again.

## How an edit reaches the outputs

Markers are **not** baked into the files. The control plane writes them into the on-demand playlists **when a
player asks** (`server.ts`, ahead of the `/clips` files):

- HLS media playlists: `EXT-X-DATERANGE` (`CLASS="com.boomlabs.volt.skip"`, `X-GRAPHIC="skip-intro"`, `X-KIND`,
  `X-TO`), plus the `PROGRAM-DATE-TIME` a DATERANGE needs (an on-demand build has none). The anchor is the
  recording's real start for a recording-made asset, else a fixed epoch; only differences matter.
- DASH MPDs: an `EventStream` (`urn:com:boomlabs:volt:skip:2026`) in each Period.
- Playlists are cached 10 s (they were cached for a year, so an edit could never have reached a viewer who had
  loaded the asset once). Segments keep their year-long immutable cache. The marker list is cached in each API
  process and dropped on any edit (migration 0062's trigger, tag `asset:<id>`).
- Apps that draw their own button get the same ranges as `skip` in the item details (`modules/apps.ts`).

## Fixed on the way

- On-demand share links pointed at `<master_key>/master.m3u8`, which did not exist (`master_key` already is the
  playlist). They now use the playlist itself, and the MPD beside an encode's master.
