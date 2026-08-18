# VOLT Live Captions: where they come from, when they are made, and how they stay in sync

This documents the caption workflow as built and tested. It answers three questions:
where the subtitle track is created from, when the AI output joins the encoder outputs
and manifests, and how sync is kept stable no matter what the viewer does with DVR.

## Where the subtitle track is created from

Captions are transcribed from the SOURCE stream directly, not from a rendition and not
from the encoder's output. A dedicated lightweight ffmpeg pulls the same source URL the
video ingest uses, starts at the live edge with the same adaptive edge logic as the
video path, and extracts only the audio: mono, 16 kHz, in fixed 8 second chunks. Video
never passes through it and it never touches the video pipeline.

## When, relative to the ladder

The caption path runs IN PARALLEL with the ladder encode, not before it. The ladder
does not wait for whisper, and whisper does not wait for the ladder. This matters for
latency: transcription adds ZERO delay to the video path. The cost of AI captioning is
paid only in caption availability: a chunk must finish (8s) and be transcribed and
translated (typically 1 to 4s), so a cue exists roughly 9 to 12 seconds after the words
were spoken. The player absorbs that by holding live playback back by about 14 seconds
when captions are on, so by the time the playhead reaches any moment its cues already
exist. This is why expected start-up is 10 to 20 seconds with captions on and about 4
seconds with captions off.

Because every ladder rendition comes from ONE transcode with one timeline, a single
subtitle track serves ALL bitrates. ABR switching changes the video quality, never the
captions.

## When the AI output joins the outputs and manifests

Each finished chunk becomes one WebVTT segment (sub_N.vtt) plus an updated live
subtitle playlist (subs.m3u8), written into the same per-run output directory as the
video segments. The player-facing manifests are the caption companions: master_cc.m3u8
and the per-variant *_cc.m3u8 (and manifest_cc.mpd for DASH), regenerated every 2
seconds by a refresher that is decoupled from transcription so video pacing is never
disturbed by a slow transcribe. The subtitle track is advertised from the very first
manifest write (an empty playlist placeholder), because players load the master once:
the track must exist at connect time and then fill in as cues arrive.

## How sync is kept, and why DVR cannot break it

Nothing in the sync chain is assumed or extrapolated. Three clocks are MEASURED
continuously:

1. Every video segment in the companion playlists carries its own wall-clock stamp
   (EXT-X-PROGRAM-DATE-TIME) taken from that segment file's write time. Stamped per
   segment, so pacing drift can never accumulate across the window.

2. Every caption chunk in subs.m3u8 carries its own wall-clock stamp taken from the
   audio chunk's measured capture time.

3. Every WebVTT segment carries an X-TIMESTAMP-MAP whose MPEGTS value is the video's
   REAL 90 kHz PTS for that chunk's start. The encoder reads it from the newest video
   segment's own headers (tfdt baseMediaDecodeTime plus the mdhd timescale) and maps
   wall-clock to PTS fresh for every chunk. This pins each cue to the video's media
   timeline itself.

Point 3 is the one that makes DVR safe. Cues are anchored to the media timeline, not
to the live edge and not to wall-clock arithmetic in the player. When a viewer scrubs
back three minutes, pauses, or crawls back to live, the player simply fetches the
subtitle segments for whatever region it is playing and their cues land on those exact
video positions. There is no drift to accumulate and nothing that depends on when the
viewer is watching. The same holds across the DVR window sliding forward.

Degradation is honest: if the video PTS cannot be read for a chunk, the timestamp map
is omitted for that chunk rather than written with a guessed value, and the caption
sidecar can never take the video down (it is a non-critical child; caption errors are
reported as caption.error events and shown in the console).

## Verification

The workflow is locked by tests at three levels: unit tests on the stamping and PTS
mapping (test_companion_pdt.py), the caption engine tests (test_captions.py), and a
browser-level harness that plays a simulated live origin, written by the real encoder
functions, in Chromium with the app's exact hls.js configuration. The harness showed
continuous cue display across two minutes including a full DVR window rotation, and a
six minute soak with the caption for chunk 43 still rendering on screen.
