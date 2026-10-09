# Requirements: now-playing resolution, and filling the gap for sources without metadata

**Status: the four-way resolution is built. The automatic schedule service in
section 4 is specified, not built.**

---

## 1. The problem this solves

The line above the waveform answered one question, "what did ICY last send",
and used it to answer a different one, "what is on right now". On an Icecast
station those coincide often enough that the difference never showed. On an HLS
source they never coincide, because **HLS carries no track metadata that we
read at all**, so the line fell through to `Untitled break` permanently.

That is not a cosmetic problem. "Untitled break" is a statement that the source
is between titles, which invites the operator to go and find out why the
metadata pipeline stopped. Nothing has stopped. There was never anything to
receive. Absence of a capability and absence of a value are different facts and
only one of them is a reason to investigate.

The same shape applied to the audience figure. `0 MP3 listeners` counted the
clients attached to the control plane's MP3 fan-out and nothing else, so a
station with four hundred people on HLS and nobody on MP3 reported zero. The
words were true and the number answered the wrong question.

---

## 2. What is built

### The now-playing line, resolved once on the server

`services/radio/nowPlaying.ts` makes one four-way decision, ordered by how much
the operator can trust each answer:

| Order | Case | Shown | Kind |
|---|---|---|---|
| 1 | The source sent a title | the title | `icy` |
| 2 | No title, a scheduled programme covers now | the programme title | `epg` |
| 3 | No title, and the source cannot carry one | the station name, plus a sentence saying why | `no_metadata` |
| 4 | No title, and the source can carry one | `Untitled break` | `gap` |

Off air outranks all four.

Whether a source can carry a title is decided by `sourceCarriesTitles()`:
Icecast, SHOUTcast and plain HTTP audio can; HLS, DASH and SRT cannot. **The URL
overrides the protocol column**, because a station created before that column
was filled in carries the default and the `.m3u8` is what is actually true. This
is the same rule `looks_like_hls()` applies in `radio.py`.

The EPG fallback deliberately excludes rows the ICY capture wrote
(`metadata.source = 'icy'`). Those are a log of what was received, not a
schedule; using them would make the fallback echo the title already found
missing.

The decision is made in one place because three call sites used to make it
separately, the station list, the detail payload and the now-playing poll, and
only one of them had every case. `test/now-playing.check.ts` pins the decision
without a database, and its last two cases read the console's source and fail if
`|| 'Untitled break'` reappears there.

### The audience figure

`listeners` is now **MP3 fan-out clients plus live player concurrency** for the
same stream, summed across asset kinds rather than assuming one. The breakdown
stays available on `listenerCounts` for the tooltip and for anyone who needs the
delivery split, but the bare word "listeners" never again means MP3 only.

Null still means "not measured" and is rendered as no line at all, never as a
zero. That is the same rule `relayHealth` follows for an unmeasured host and
`host_samples` follows by writing no row for a failed reading.

---

## 3. What is still thin

- **The station list does not consult the EPG.** It would be a query per row.
  A station with a schedule and no ICY title therefore shows its own name in the
  list and the programme title on the detail page. Fixable with one batched
  query when it matters.
- **Timed ID3 in HLS is not read.** It is the standard way an HLS source carries
  a now-playing title, and several broadcasters publish it. If we read it,
  `sourceCarriesTitles()` is the single place that changes and case 3 stops
  applying to those sources.
- **`ends_at IS NULL` counts as "still running"** in the schedule lookup, so an
  open-ended programme stays on screen indefinitely. Correct for a rolling
  strand, wrong for a schedule somebody forgot to close.

---

## 4. The opportunity: work out what is on without being told

Case 3 is the interesting one commercially. A broadcaster hands us a stream URL
and no schedule, and today we say so politely. There are three ways to do better,
and they are worth different amounts.

### 4a. Fetch the published schedule (cheapest, most accurate)

Most broadcasters publish their own guide. ABC, the BBC and commercial networks
all expose either an XMLTV feed, a JSON now-playing endpoint, or a station page
carrying the current programme.

- **Effort**: a per-broadcaster adapter, an hour or two each, plus a scheduled
  fetch and a mapping onto `programmes`.
- **Accuracy**: exact, because it is the broadcaster's own data.
- **Limits**: only works where such a feed exists, and each one is bespoke. This
  is a connector library, not a feature, and it grows one station at a time.

### 4b. Recognise the audio (accurate for music, useless for speech)

Acoustic fingerprinting against a catalogue. Commercial APIs exist and are
mature.

- **Effort**: we already cut segments and already run ffmpeg over them, so the
  sampling side is nearly free. The work is the API integration, a cache so the
  same track is not re-queried every fifteen seconds, and a confidence threshold.
- **Accuracy**: high for commercially released music; near zero for live speech,
  sport, or local programming, which is exactly what case 3 stations tend to be.
- **Cost**: per-query, so it needs the cache to be affordable.

### 4c. Transcribe and infer (the one that fits sport and talk)

Speech to text on the audio we already segment, then a model reads the transcript
and answers "what programme is this, and has it changed". A rugby league
commentary identifies itself within a minute; so does a news bulletin, a weather
segment or an ad break.

- **Effort**: the largest of the three. Transcription per station-hour, plus
  prompt and schedule-writing logic, plus a way to correct it.
- **Accuracy**: good at *classifying* (sport, news, music, advertising) and at
  detecting a *change of programme*. Weaker at naming a programme it has no prior
  knowledge of. Best used to propose, never to publish unreviewed.
- **Cost**: the real question. Transcribing every station continuously is a
  running cost per station-hour, not a one-off. Sampling thirty seconds every
  five minutes gets most of the value for a fraction of it.

### The shape worth building

Not "AI fills in the EPG". Rather:

1. **Propose, do not publish.** Anything inferred lands as a `proposed`
   programme with its source and a confidence, visible in the EPG editor with
   accept and reject. The operator's schedule stays authoritative.
2. **Say where it came from.** A title from the broadcaster's own feed, one from
   fingerprinting and one from a transcript are three different levels of claim.
   The resolution order in section 2 already has a slot for each; they rank below
   an operator-entered schedule and above the station name.
3. **Detect the boundary first, name it second.** Knowing that the programme
   changed at 14:03 is more useful, and far cheaper, than knowing what it is
   called. A boundary plus an operator naming it is a good product; a wrong name
   nobody noticed is a bad one.
4. **Bill it.** This is per-station running cost, so it is a per-station option,
   not a platform default.

### Acceptance criteria, when it is built

1. An inferred programme is never shown as if an operator had entered it.
2. Rejecting a proposal stops that programme being proposed again for the same
   window.
3. A station with the service off behaves exactly as case 3 does today.
4. The cost per station-hour is visible before the service is enabled, and it
   accrues the same way encoder time does.
5. A boundary the system detected and could not name still appears, as an
   unnamed programme with a start time, rather than being discarded.
