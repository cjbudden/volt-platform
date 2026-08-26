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

### 8. Monitoring parity with channels: five gates, event log, QC

Reason: a station that is on air is a service, and it must be operable the same
way a TV channel is. If radio had its own ad-hoc status, an operator would have
to learn two mental models and the two could disagree about the same situation.

Support: radio reuses the SAME five-gate pipeline model
(`services/pipelineHealth.ts`) that channels use, fed by radio ground truth:

- **Server**: the station's pipeline process is up.
- **Input**: audio is actually arriving (measured from the output, plus the ICY
  connection state and ffmpeg error lines).
- **Encoder**: ffmpeg alive and the packager writing segments.
- **Output**: the live audio playlist is advancing right now (mtime ground
  truth, the same rule the TV output gate uses).
- **On air**: published AND serving valid content, which is exactly what the
  public URL would do.

The same roll-up (`idle / starting / ready / onair / degraded / error /
stopped`) drives the badge on both the list and the detail page, so radio and
TV never disagree. A radio-specific event log writes to the shared
`stream_events` table (station start/stop, on air/off air, input errors,
output stalled/resumed, QC alarms) and merges the run's real ffmpeg error
lines, with known-benign decoder chatter filtered out so a healthy station does
not read as broken.

### 9. QC support for radio

Reason: channels have QC for picture and packaging; the audio equivalents are
"is there actually sound", "is it programme audio or just noise", and "is the
packaging still sane". Those are the faults that silently ruin a radio service.

Support: a monitor tick (`services/radio/monitor.ts`) analyses the newest
complete output segment with ffmpeg (`astats` + `silencedetect` + `ebur128`)
and checks the live playlist, producing:

- **Signal verdict**: `audio`, `quiet`, `silent` (dead air), or `static`
  (noise-like: high entropy with low crest factor sustained). Dead air and
  sustained static raise events after a hold-down period, so a momentary gap is
  not an alarm.
- **Level measurements**: peak / RMS dBFS, crest factor, entropy, shown on the
  QC panel and used by the meter.
- **Playlist invariants**, the audio equivalent of `playcheck.py`: stale
  playlist, media-sequence regression, duplicate URIs, PDT going backwards or
  jumping, no segments.
- **Metadata stall**: the ICY connection dropping is reported, since a station
  can keep streaming audio while its metadata feed dies.

The monitor also keeps `stream_status` current, which is what lets the shared
gate model read radio like any other stream.

### 10. Start, then go on air (two explicit steps)

Reason: the same contract channels already have. Starting a station is an
engineering action (receive, encode, record, check it); publishing is an
editorial one. They must be separable so an operator can bring a station up,
confirm the signal, and only then open it to the public.

Support: **Start station** runs the pipeline and opens the recording, with the
output reachable only on PRIVATE preview URLs (`/radio/:id/stream.mp3`,
`/origin/:id/live/...`), the audio counterpart of a channel's preview. **Go on
air** flips `on_air`, and only then do the PUBLIC URLs serve:
`/live/:id/stream.mp3`, `/live/:id/master.m3u8`, `/live/:id/manifest.mpd`.
Off air they return 404, and on air without valid content they return 503
rather than pointing at a dead manifest. Going on air is refused until the
first valid segments exist, and stopping a station always takes it off air, so
nothing public can outlive the run. The detail page shows whichever URL set is
currently real, labelled as private preview or public.

### 11. The visualiser proves RECEPTION, not local playback

Reason: the operator's question is "are we receiving something, and is it more
than static", and that must be answerable with the speakers muted or with
nobody listening at all. A meter driven only by local playback answers a
different, useless question.

Support: the meter is fed by SERVER-MEASURED levels from the broadcast output
(the monitor's ~100ms EBU R128 momentary-loudness frames, served by
`/api/radio/:id/levels`), polled continuously by the page. It moves whenever
the station is receiving audio, regardless of local playback state, and the
frames are played back at their measured cadence so the motion is honest rather
than decorative. The verdict badge on the meter states what the signal IS
(audio present / low level / dead air / static-like) with the dBFS figures
beside it. When the operator does press Listen, the Web Audio analyser adds a
live spectrum overlay on top: detail, never the proof of signal.

## Test setup

Local dev has an Icecast simulator (`volt-app/test/icecast-sim.js`) that loops
generated audio and rotates ICY titles through songs, adverts and DJ talk, so
the whole chain (capture, classification, log, search, visualiser, QC) is
testable offline; `volt-app/test/radio.check.sh` runs the e2e and
`volt-app/test/radio-classify.check.ts` pins the classifier rules.

`volt-app/scripts/seed-radio.ts` is an OPTIONAL manual step that adds real test
stations (nothing is seeded automatically):

```
npx tsx scripts/seed-radio.ts                      # music set (SomaFM)
npx tsx scripts/seed-radio.ts --all                # + speech/news set
npx tsx scripts/seed-radio.ts --all --account RTM  # pick the account
npx tsx scripts/seed-radio.ts --list               # show without writing
```

Two sets, because they exercise different halves of the feature:

- **Music** (SomaFM Groove Salad / Secret Agent / Drone Zone): dense, well
  formed `Artist - Title` metadata. Tests the log, classification and metadata
  driven clipping.
- **Speech / news**: NPO Radio 1 (sends programme + broadcaster, e.g.
  `NPO Radio 1 - De Ochtend - KRO-NCRV`, the strongest programme-metadata
  test), WPLN 90.3 and WPLN International (NPR / BBC talk), KPFA (interviews
  and public affairs), WFMU Freeform (alternates programme and track
  metadata), and NA0D Baxter Stream (ham/GMRS/weather: sparse metadata and
  long silences, which is what exercises the dead-air and static QC checks).

Classifier behaviour was tuned against what these stations actually send, and
the observed formats are pinned in the classifier test: `Artist - Title`
(SomaFM), `"Title" by Artist on Show` (WFMU), three-part programme lines
(NPO), and blank titles. The blank case takes context: on a station that names
its tracks a blank title is an ad break, while on a speech station it simply
means the stream carries no track metadata, so it is treated as content rather
than mislabelling every news stream as advertising. Playlist-style URLs
(`.m3u` / `.pls`) are resolved to the underlying mount, since that is what many
stations publish.

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
