# RADIO: audio-only streaming workflows

*Requirements, the reasons behind them, and how the platform supports each one.*
*Status: first full build (supersedes the 16 Aug audio-only channel work that was
lost in the two-session merge, see commit d460f5b).*

## Why radio is its own section

Radio and audio-first broadcasters need the same operate / record / clip / publish
toolchain as TV channels, without paying for any of the video machinery (GPU
transcode, ABR ladders, 16:9 players). At the same time an audio station already
broadcasts its own content log: Icecast now-playing metadata says what is on air,
second by second, for free. Capturing that log turns a flat audio recording into
searchable, clippable content. Radio follows the same base structure and design
language as Channels and Events (list page, create/settings drawer, detail page),
so an operator who knows one section knows them all.

## Requirements and how each is supported

### 1. Live audio outputs: MP3, HLS and DASH, single bitrate

Reason: every radio consumer expects one of these three. MP3 over HTTP is the
universal "just works everywhere" stream (hardware receivers, old apps, VLC),
HLS covers Apple and modern web, DASH covers Android/TV stacks. Radio is single
bitrate by definition: there is no ABR ladder to manage.

Support: one ffmpeg pipeline per running station produces all enabled outputs
from one input connection:

- HLS: audio-only rendition, fMP4 segments in the standard per-run origin
  namespace (`/origin/<id>/live/master.m3u8`), which means the existing
  recording index, range playback and clipping work unchanged.
- DASH: `manifest.mpd` from the same segmenter, same run directory.
- MP3: a continuous encode fanned out by the control plane at
  `/radio/:id/stream.mp3` to any number of listeners (one encoder, N clients),
  with ICY `StreamTitle` passed through so receivers show now-playing.

The output bitrate is one picker (64 to 320 kbps). Packaging is the default
workflow: if the source is already MP3/AAC at the right rate we repackage
without re-encoding where the container allows it. Transcode exists only to
change bitrate or format (for example 320k source down to a 128k delivery),
exactly as the create form explains.

### 2. Audio-valid inputs, including Icecast

Reason: the source picker must not offer video-shaped inputs that cannot work;
Icecast/SHOUTcast is how the vast majority of internet radio is actually
delivered.

Support: radio sources offer Icecast / HTTP audio (http(s) MP3 or AAC mount,
with `Icy-MetaData` negotiation), HLS audio pull, and SRT audio. RTMP and the
video-only options are not offered for radio. The three SomaFM reference
streams are seeded for testing: Groove Salad, Secret Agent and Drone Zone
(`https://ice5.somafm.com/<mount>-128-mp3`).

### 3. A timed log of received metadata, stored in the EPG tables

Reason: "what was received and broadcast, and when" is the key to trimming and
clipping later, and to searching for content. Rather than invent a new store,
the EPG programme tables and APIs already model titled time ranges per channel,
power search (recordings search already matches programme titles), and drive
post-airing automation.

Support: while a station runs, the ICY metadata reader turns every now-playing
change into a programme row owned by the radio channel: `starts_at` when the
title appeared, `ends_at` when the next one replaced it (as-run times), title
from `StreamTitle`, and the raw ICY fields kept in `metadata` jsonb
(`{ source: 'icy', raw, class, stream_url }`). Consequences that come free from
reusing EPG:

- The recordings search box matches these entries, so "find when X was played"
  works the same way as EPG matches on TV recordings.
- The recording detail page can highlight the log entry covering the playhead
  and jump the clipping bar to an entry's time range.
- Post-airing automation (the EPG auto-clip path) can cut a song or segment out
  of the recording using the logged times and carry the title onto the VOD
  asset.

### 4. Classify each entry: song, ad, or content

Reason: for clipping and for transcription policy you need to know whether the
audio is music, advertising, or speech (news, DJ talk, interviews).

Support: a heuristic classifier tags every log entry as it lands
(`metadata.class`):

- `song`: matches the "Artist - Title" shape (the Icecast convention), with
  plausible duration.
- `ad`: title matches advert / sponsor / promo / commercial patterns, an empty
  `StreamTitle` during a break, or a very short untitled gap between songs.
- `content`: everything else (news bulletins, DJ chatter, interviews, station
  IDs with speech).

The class is a stored field, so it can be corrected by hand through the normal
EPG programme PATCH, and better classifiers (audio analysis) can replace the
heuristic later without changing the data model.

### 5. Detail page: audio visualiser instead of a 16:9 video

Reason: a black video rectangle tells you nothing about an audio service. The
operator's question is "are we receiving something?", and the answer must be
visible even with the speakers muted.

Support: the radio detail page replaces the video surface with a live
visualiser (Web Audio analyser driving a canvas: spectrum bars plus a level
meter) fed by the actual output stream, so a flat line means silence on air,
independent of the local volume/mute. Around it:

- station artwork (the channel brand image) and the live now-playing title,
- the raw ICY fields when the source is Icecast (station name, genre,
  `StreamUrl` artwork/link when the station provides one),
- the timed metadata log with class chips (song / ad / content), a search box
  and click-to-time behaviour,
- the MP3 / HLS / DASH output URLs with copy buttons.

The same visualiser component stands in for the video player on radio
recordings in the recording workbench.

### 6. Create/settings form policy

Reason: the form should only offer what makes sense for audio, in the same
section order as channels and events, so the three forms stay 90 percent alike.

Support: Name, then Type (Packaging is default and recommended; Transcode is
offered "only if you need to change bitrate or format"), then Source (audio
options only, Icecast first), then Outputs (MP3 / HLS / DASH toggles and the
single bitrate), then Metadata log (Icecast only: capture toggle plus
classification), then Recording (the shared recording and retention section),
then Transcription. Transcription is only offered when the source is Icecast,
because only there does metadata tell speech from songs and ads; when enabled
it transcribes just the segments classified as content, since transcripts of
songs and adverts are noise.

### 7. Recording and clipping parity

Reason: the whole point of the log is to trim and clip; radio must reuse the
recording pipeline, not fork it.

Support: radio runs write the same per-run origin layout the recording index
scans, so recordings appear in the same library with the same range playback,
transcript/EPG/name search and clip creation. The metadata log gives clip
candidates their in/out times and names.

## Test setup

Local dev has an Icecast simulator (`volt-app/test/icecast-sim.js`) that loops
generated audio and rotates ICY titles through songs, adverts and DJ talk, so
the whole chain (capture, classification, log, search, visualiser) is testable
offline; `volt-app/test/radio.check.sh` runs the e2e. On a real network, create
stations from the three SomaFM URLs above and the same flows run against live
radio.

## Production notes / follow-ups

- The dev pipeline runs ffmpeg under the control plane (same pattern as the
  local test stream). For production scale the same command graph moves into
  the encoder container; the manifest layout and APIs do not change.
- MP3 fan-out is in-process; put it behind the edge/CDN for real listener
  counts (HLS/DASH already are).
- Classifier is heuristic; a later pass can add audio-based ad detection and
  fingerprint-based song ID without schema changes.
- Icecast OUTPUT (serving a public icy mount) is out of scope for this round;
  MP3-over-HTTP covers the compatibility need.
