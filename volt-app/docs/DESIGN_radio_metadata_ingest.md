# Getting schedule and now-playing OUT of a broadcaster's system

When we take a radio station's audio, we also want two things that are not in
the audio: **what is playing right now** (the song or the presenter) and **what
is scheduled** (the programme grid). This is the survey of how broadcasters
actually publish those, and what we should build ingest for.

The short version: **there is one real standard for the schedule, no real
standard for now-playing, and a very small number of transport shapes that cover
almost every playout system in the market.** Build to the shapes, not to the
vendors.

---

## 1. Now-playing: what exists

### ICY metadata (what we support today)

Interleaved in the Icecast/SHOUTcast byte stream, negotiated with
`Icy-MetaData: 1`. One string, usually `Artist - Title`, sometimes a programme
name, sometimes empty. We read it in `services/radio/icyMeta.ts`.

**Its limits are structural, not incidental.** It is a single untyped string
with no schema, no artist/title separation, no start time, no duration, and no
identifiers. Everything downstream (the song/ad/content classifier, the metadata
log, artwork lookup) is inference over that one string. It also only exists if
the source is Icecast — an HLS or SRT contribution feed carries none of it.

### What broadcasters have that is better

Every one of these is richer than ICY, and a station that has a playout system
has at least one of them:

| Source | What it carries | Shape |
|---|---|---|
| **Playout "now playing" export** | artist, title, duration, start time, category (music/ad/promo/news), often the library id | TCP socket XML, HTTP POST, file drop, or a polled JSON/XML endpoint |
| **RDS / RadioText+ feed** | artist/title, tagged (RT+ types) | usually the same feed the RDS encoder is given |
| **DAB+ DLS / PAD** | dynamic label, tagged like RT+ | same origin as above |
| **Music scheduler log** | the day's planned playout, per item, with categories | a scheduled file export (as-run and planned) |

The important observation: **a station already sends this data somewhere** — to
its RDS encoder, to its DAB multiplex, to its website. We are asking to be one
more destination, which is a configuration change at their end rather than a
project.

### Vendors, and why we should not build per-vendor

RCS Zetta, WideOrbit, Myriad, RadioDJ, StationPlaylist, PlayoutONE, Rivendell,
MusicMaster and the rest all export now-playing, and there is an ecosystem of
connectors (MetaRadio and similar) that exists precisely because each does it
slightly differently. Zetta, for example, exports "Zetta Lite" XML over a **TCP
socket** to a nominated host and port.

**Do not build ten vendor integrations.** They reduce to four transports:

1. **HTTP POST to a URL we give them** — the modern default, and what most
   systems can be pointed at with a template string.
2. **A polled HTTP endpoint** — they publish JSON/XML, we fetch it every N
   seconds. Common for stations whose playout cannot reach out.
3. **A file drop** — XML or JSON written to a watched folder / FTP / S3 prefix.
   Older systems, and still very common.
4. **A raw TCP socket** they connect to and push XML down (Zetta's shape).

Build those four with a **field-mapping layer** on top, and the vendor list
becomes configuration. The mapping is the actual product: "their `<TITLE>` is our
title, their `<CATEGORY>` value `COM` means an ad".

### What we should offer, in order

1. **Now-playing push endpoint.** `POST /api/ingest/nowplaying/:channelId` with a
   token, accepting JSON *and* form-encoded *and* a generic XML body, with a
   per-channel field map. This is one endpoint and it unlocks most stations,
   because "POST this URL when the song changes" is a checkbox in most playout
   software.
2. **A polled endpoint** for stations that cannot push.
3. **File/FTP drop** reusing the watch-folder machinery already designed for
   media (`docs/DESIGN_file_manager_watchfolder.md`).
4. **TCP listener** last: it needs an inbound port, which conflicts with the
   container rule that makes the fleet deployable, so it belongs on a small
   dedicated collector rather than in a station container.

**A structured now-playing feed should outrank ICY when both exist.** ICY becomes
the fallback for stations that have nothing else, and the classifier stops having
to infer a category that the station already knows.

---

## 2. The schedule: there IS a standard, and it is not XMLTV

For television, XMLTV is the interchange format (see
`docs/DESIGN_epg_xmltv.md`). For **radio**, the real standard is:

### ETSI TS 102 818 — Service and Programme Information (SPI)

The XML specification for hybrid digital radio (DAB, DRM, **RadioDNS**). It
defines three document types:

- **Service Information (SI)** — `<serviceInformation>`: the stations
  themselves, their providers, bearers (FM frequency, DAB ensemble, stream URL)
  and groupings. This is how a station declares "these are the ways you can
  receive me", including its IP stream.
- **Programme Information (PI)** — `<epg>`: the schedule. Programmes with
  `<location><time>` start and duration, and crucially `<actualTime>` /
  `<actualDuration>` for **as-run** times.
- **Group Information (GI)** — `<epg>`: series and programme groupings.

Two things about it matter for us:

**It has as-run built in.** `actualTime` and `actualDuration` are first-class,
which maps directly onto our `programmes.actual_start` / `actual_end` — the
columns clipping and VOD already prefer. XMLTV has nothing equivalent.

**There is no "now playing" element.** The current programme is derived by
comparing the schedule against the clock. So SPI answers the *schedule* question
and never the *song* question; the two ingests are genuinely separate and should
not be conflated in one importer.

### RadioDNS is how you find it without being told

RadioDNS lets a receiver take the broadcast parameters of an FM or DAB station
and resolve them, via DNS, to the station's IP services — including where its SPI
documents live. For us that means a station can often be onboarded from **its
broadcast identity alone**, with no URL exchanged. That is a genuinely good
onboarding story: "give us your frequency and country, we will find your guide."

### The practical reality

Broadcasters at the larger end (public service, national commercial, anyone in a
DAB multiplex or on Radioplayer) will have SPI, because their apps and hybrid
radios need it. Smaller stations will have **nothing** structured — their
schedule lives on a WordPress page and in the presenters' heads.

So the schedule ingest tiers are:

1. **SPI (TS 102 818)**, discovered via RadioDNS or given as a URL. The standard
   answer for anyone who has one.
2. **XMLTV**, because some radio groups publish it anyway and we need the parser
   for television regardless — the same importer with a different mapping.
3. **CSV / spreadsheet upload**, which is what a small station can actually
   produce, and should not be sneered at: it is how most of them will onboard.
4. **Derived from as-run** — build the guide from what actually aired, using the
   now-playing log we are already capturing. For a music station with no
   schedule at all, this is the only guide that will ever exist, and we can
   produce it from data we already have.

Tier 4 is worth noticing: we capture a timed metadata log per station already
(`programmes` rows with `metadata->>'source' = 'icy'`). Rolling that into
programme blocks is a feature nobody else offers a small station.

---

## 3. What this implies for the source form

Today a radio source is a URL and a protocol. It should also be able to carry,
independently of the audio:

- a **now-playing source**: push (we issue a URL and token), poll (they give a
  URL), file drop, or none — falling back to ICY when the audio is Icecast;
- a **schedule source**: SPI URL, RadioDNS identity, XMLTV URL, upload, or
  derive-from-as-run;
- a **field map** for whichever of those is not already in a known shape.

None of that is built. The audio ingest is protocol-aware and the metadata
ingest is not: it assumes ICY or nothing, which is exactly the assumption that
leaves an HLS station with a permanently empty now-playing panel.

---

## Sources

- ETSI TS 102 818 V3.5.1, *Hybrid Digital Radio (DAB, DRM, RadioDNS); XML
  Specification for Service and Programme Information (SPI)*
- Media Realm / MetaRadio integration notes for RCS Zetta, WideOrbit, Myriad,
  RadioDJ and StationPlaylist — useful as a survey of what each playout system
  can actually emit
