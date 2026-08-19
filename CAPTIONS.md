# VOLT Live Captions: where they come from, and why they stay in sync

This documents the caption workflow as built and measured. It answers three questions:
where the subtitle track is created from, how a cue ends up on the right frame, and how
we prove it rather than assert it.

The short version: **a subtitle cue is only ever as well aligned as the clock used to
place it, so there is exactly one clock.** Every number a player uses to put a cue on
screen is read off the media timeline of the stream we actually deliver. Nothing is
estimated from wall clock, and nothing is estimated from file modification times.

---

## Where the caption audio comes from

The **delivered audio**: the packager's own CMAF audio segments, the same bytes the
viewer's player decodes. Not the source URL, not a second pull, not a rendition.

Each CMAF segment carries a `tfdt` (baseMediaDecodeTime), which is the exact PTS its
first sample sits at. So a window of segments has a known start PTS to the sample, and a
word found N seconds into that window belongs at `start_pts + N`. The alignment is not
computed, it is read.

That also means captions can never be transcribed from audio the viewer is not hearing.
If the source stutters, the packaged audio stutters the same way, and the captions follow
it, because they are made from it.

### What this replaced

Captions used to come from a **second, independent ffmpeg pull of the source URL**,
started a few seconds after the video ingest. Two independent joins to a live HLS edge
land on different source segments, so the audio whisper heard was offset from the video
being packaged by a random amount on every run, and the two were reconciled afterwards by
comparing file mtimes. That is the "sometimes ahead, usually way behind, sometimes never
shown" behaviour, and because the offset was random per run it was never reproducible.

Measured on the unified-streaming test source: **median sync error 15.7 seconds, no cue
within 2 seconds of correct, and a different error every run.**

---

## How a cue reaches the right frame

Three values place a cue, and all three come from the same two numbers.

**1. The run epoch.** Anchored ONCE, when the first segment appears:
`epoch = segment write time - segment duration - segment PTS`. It is the wall clock that
media PTS 0 corresponds to. It never moves for the life of the run.

**2. `EXT-X-PROGRAM-DATE-TIME` on video and on subtitles.** Both are `epoch + that
segment's own PTS`, read from its `tfdt`. Because both terms are exact:

  * consecutive stamps are exactly `EXTINF` apart,
  * the stamps are identical every time the playlist is regenerated, so nothing jitters
    under a player that is already watching,
  * and the video segment covering PTS 16s and the subtitle segment covering PTS 16s
    carry the *same* wall clock, by construction rather than by two clocks happening to
    agree.

**3. `X-TIMESTAMP-MAP` in each WebVTT segment.** `MPEGTS` is the window's true start PTS
in 90 kHz units, and the cues inside are written relative to that. A constant map (such
as `MPEGTS:0`) maps every window's cues onto the same spot on the timeline, which is the
classic "captions worked for two chunks and then never again" failure. If the PTS cannot
be read for a window, the map is **omitted** rather than guessed, and the player falls
back to fragment-anchored placement.

### Why not stamp PDT from file modification times

That was the previous scheme, and it is worth writing down why it is wrong, because it
looks safer than it is: a per-segment mtime "cannot accumulate drift".

It stamps the encoder's write schedule, not the media. Measured on a box that was not
keeping up, nominally **4.000s segments were stamped 8.8s and 11.2s apart**. Players align
a subtitle rendition to video by PDT, so cues landed wherever the encoder happened to
stutter. A single anchor plus real PTS cannot do that, and the anchor's accuracy only
affects what the clock reads, never the alignment between tracks.

Current measurement: **PDT step error 0.000s across a full DVR window.**

---

## Window shape, and why there is a preroll

A caption window is a whole number of delivered audio segments, so its start and end are
exact points on the media timeline. The window **ends where the next segment begins**,
read from that segment's `tfdt`, not at `start + nominal duration`: the packager cuts on
keyframes, so a nominal duration leaves a gap or an overlap, and an overlap means the
same words published twice on two different segments.

Each window is transcribed with the **previous segment as context** (`preroll_segments`,
default 1). Whisper is far more accurate when a sentence does not begin at a hard cut.
Everything found in the preroll was already published by the previous window, so it is
discarded, with one subtlety that matters: the recogniser is told where the boundary is
and forces a cue cut there. Without that, a sentence straddling the boundary comes back
as one cue that starts in the preroll, gets discarded as already-seen, and the half of the
sentence belonging to this window is silently lost.

---

## Transcription quality

Whisper's raw output is not a subtitle track. The decode options and the cue shaping each
earn their place:

  * **VAD gating** — whisper was trained on speech and will confidently invent sentences
    over music, room tone or silence. On a live feed a large share of any window is not
    speech, so this is the single biggest accuracy win.
  * **`condition_on_previous_text=False`** — with it on, one bad window poisons the next
    and whisper falls into repeating a line forever. Windows here are independent by
    design, so the feature has nothing to offer and a well known failure mode to add.
  * **log-probability, compression-ratio and no-speech thresholds** — drop a window whose
    decode was improbable, whose output looks like a loop, or which the model itself
    thinks was silence.
  * **word timestamps** — cues are cut and timed from the words themselves. A cue starts
    on its first word and ends on its last, instead of inheriting whisper's coarse
    segment boundaries.
  * **cue shaping** — a cue closes when it reaches a readable length (two lines of ~42
    characters), when it has been on screen long enough, when the speaker pauses, or when
    a sentence ends and the cue is already long enough to stand alone. Durations are
    clamped to 1..7s and a cue is never allowed to overlap its successor.
  * **model default** — `base.en` for a channel pinned to English, `base` otherwise. The
    old default was `tiny`, which is a large part of why the text often did not match what
    was said. `small.en` and `medium.en` are the quality step-ups and want more CPU or a
    GPU; the encoder reports `caption.slow` when transcription is using more than half its
    window so the sizing is visible rather than silent.

A cue lives in exactly one segment, the one containing its start. Writing a spanning cue
into every overlapped segment created near-duplicate copies that stacked on screen.

---

## Latency

The caption path runs **in parallel** with the ladder encode. The ladder never waits for
whisper and whisper never waits for the ladder, so transcription adds **zero** delay to
the video path.

The cost is paid in caption availability only: a window must be packaged (window length)
and then transcribed (typically 2 to 5s on CPU), so a cue exists roughly 10 to 13 seconds
after the words were spoken. The player absorbs that by holding live playback back about
14 seconds when captions are on, so by the time the playhead reaches any moment its cues
already exist.

If transcription falls behind, the worker **jumps to the newest full window** and records
the gap as a `caption.skip` event. Processing a backlog in order never catches up, and the
offset only compounds until the captions are past the player's hold point and invisible
while burning maximum compute. A live viewer loses a few seconds of captions once; they
never lose captions permanently.

---

## Ingest: a defect that looked like a caption problem

While measuring the above, the delivered audio itself turned out to be incomplete. On a
480 second run, **71 of 116 delivered audio segments contained less audio than their own
timeline claimed, and 9.5% of the audio was missing outright.**

Cause: ffmpeg demuxes and encodes in one pipeline, so while x264 is working nothing drains
the HTTP socket. The connection goes idle, the far end closes it, and the remainder of that
source segment is lost. It is silent: no error is fatal, the run continues, and the damage
only shows up downstream as audio shorter than its own timeline. For a viewer it is an
audible dropout; for the recogniser it is missing words.

Fixed by giving the demuxer a real read-ahead queue (`-thread_queue_size`), resuming
truncated fetches (`-reconnect*`) and reusing connections (`-http_persistent 1`). The same
110s transcode went from **73 ingest errors and 9% missing audio to zero errors and
complete audio**.

## Ingest: one variant, not all of them

Pointed at an HLS **master** playlist, ffmpeg exposes every variant as its own program and
opens all of them, and `-map 0:v:0` takes the **first** video stream, which is the
**lowest** rung. On the test source that meant the entire output ladder was being upscaled
from 192x108 while the 1080p rung sat unused, all five variants were being downloaded, and
each variant's audio became a duplicate manifest audio track (six identical English
tracks). It is also where the "Invalid timestamps" and "Packet corrupt" log spam came from.

A master URL is now resolved to a single variant media playlist before ffmpeg sees it
(`inputs[].variant`: `highest` by default, `lowest`, or a height like `720`).

---

## Verification

Three levels, all runnable, none of them trusting the encoder's own account of itself.

**Unit** — `test_captions.py` (58 assertions: cue shaping, boundary splitting, model
defaults, translation routing) and `test_companion_pdt.py` (37 assertions: box parsing,
PDT from the media timeline, one shared epoch, playlist shape, variant resolution).

**Against the delivered stream** — `bin/syncheck.py` decodes the audio a run actually
delivered, transcribes it offline at high quality with word timestamps, and reports how far
every published cue is from the words it belongs to. Because a delivered segment does not
always contain as much audio as its timeline claims, the wav position is mapped back
through the real per-segment breakpoints rather than assumed continuous; a checker without
that reports a growing error that is entirely its own invention.

**Against a real player** — `bin/test_player_alignment.py` packages a short asset, writes
its subtitle track with the encoder's own functions, gives every cue a text that states the
media time it claims to be at, then plays it in headless Chromium with hls.js and checks
each cue appeared when the playhead really was there. This is the part that catches a
subtly misinterpreted `X-TIMESTAMP-MAP`, which looks perfect on disk.

`./synctest.sh <name> <seconds>` runs all of it end to end against a live source.

### Measured, unified-streaming 1080p source, 10 minute run

| | before | after |
|---|---|---|
| median sync error | −15.7s | **+0.012s** |
| cues within 1s | 0% | **95.5%** |
| cues within 0.5s | 0% | **88.0%** |
| worst cue | −25.9s | **+3.9s** |
| PDT step error (max) | 8.777s | **0.000s** |
| cues with no timestamp map | 3 of 24 | **0 of 178** |
| missing delivered audio | 9.49% | **0.00%** |
| spoken words with a cue on screen | 55% | **87.2%** |
| word error rate vs the delivered audio | — | **0.161** |
| word error rate vs the source's own subtitles | 0.341 | **0.269** |
| player-level cue placement error | — | **+0.171s** |

Positive sync error means the cue is late.
