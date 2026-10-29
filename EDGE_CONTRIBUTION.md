# EDGE_CONTRIBUTION: an on-prem station encoder for radio ("Volt Edge")

*Status: design, not built (28 Oct 2026). "Volt Edge" is a working name, pending the product rename.*
*Builds on `RADIO.md` (the cloud side of radio, built) and `SSAI.md` (the ad decision engine, built for FAST and VOD).*

## 1. Why

Triton Digital is the main competitor for radio streaming in Asia. What a station buys from Triton is a whole chain:

| | Triton | What it means for us |
|---|---|---|
| On-prem | **Station Manager**, Triton's own Windows encoder app. The customer supplies the PC (Windows 11, .NET 4.8, 8 to 16 GB RAM, DirectShow or ASIO sound card, no USB audio). One machine runs up to 16 stations / 32 mounts | It is software, not hardware. A software agent is enough to compete |
| Where the origin is | At the station. Triton calls the encoder "the origin of the stream" | Same model: the station encodes, the cloud relays, packages and delivers |
| Transport | **MRV2**, Triton's own protocol, AAC or MP3 to Triton's Media Relay servers | Proprietary. This is the lock-in |
| Metadata | Now-playing and ad-break cue points from the playout system go into the encoder and travel with the audio, timestamped to the millisecond | This is what makes their ad replacement accurate. We need the same timing |
| Partner encoders | Wheatstone (Wheatstream, Streamblade, Layers Stream) and Telos speak MRV2 | Stations with these boxes can usually also send SRT, HLS or Icecast, so they can feed Volt without our agent |
| Cloud | Media Gateways deliver to listeners and insert the ads each listener hears | Our equivalent is the radio relay tier plus the SSAI engine |

**Our position:** the same chain on open protocols (SRT, HLS, Icecast, SCTE-35, ID3). Linux or container as well as Windows. Ready for video (a visual-radio camera feed). A station can bring its own encoder, or use ours.

## 2. What Volt Edge is, and is not

**It does:** capture audio at the station, read the playout system's metadata, turn it into one timed event model, encode, and send audio and events to Volt over an outbound connection. It reports its health to Volt and takes its config from Volt.

**It does not:** serve listeners, decide ads, or hold a database. Listener delivery, packaging, the metadata log, QC and ads stay in the cloud, as `RADIO.md` already describes. The edge sends; the cloud does everything else.

**Relation to `volt-agent`:** `volt-agent` watches folders and uploads files. Volt Edge is real-time audio. They share the enrolment token, the account model and the config approach, but they are separate programs, because a real-time encoder has different needs for packaging, restarts and resources than a file uploader.

## 3. Shape

```
 STATION (on-prem)                                   VOLT CLOUD
 ┌──────────────────────────────────────────┐        ┌─────────────────────────────────────────┐
 │ Audio in: ASIO / WASAPI / ALSA,          │        │ SRT ingest gateway (fixed address,      │
 │ AES67 / Livewire / Dante (virtual card), │  SRT   │ stream ID per station)                  │
 │ or an existing Icecast / SRT feed        │ ─────► │   │                                     │
 │                                          │ (main  │   ▼                                     │
 │ Playout metadata adapters ──► event model│ + back │ Radio station container (radio.py)      │
 │                                          │  path) │   • packages HLS / DASH / MP3 (built)   │
 │ Encoder: AAC-LC / HE-AAC / MP3 / Opus    │        │   • reads in-band events ──► timed      │
 │ Mux: MPEG-TS + ID3 + SCTE-35             │  HTTPS │     events feed ──► EPG log (built)     │
 │ Buffer, failover, health, levels         │ ─────► │ Edge API: enrol, config, health,        │
 └──────────────────────────────────────────┘        │ side-channel events                     │
                                                     │ Relay tier, players, SSAI (built/next)  │
                                                     └─────────────────────────────────────────┘
```

Every connection goes **out** from the station. A station network never has to accept an inbound connection, so there are no firewall changes beyond allowing outbound SRT (UDP) or HTTPS.

## 4. Audio input

| Input | How | Notes |
|---|---|---|
| Sound card | ASIO or WASAPI (Windows), ALSA (Linux) | Covers what Station Manager covers, plus USB interfaces (which Triton does not support) |
| AES67 / Livewire / Dante / WheatNet | Through the vendor's virtual sound card on the same machine, or AES67 receive directly on Linux | Direct AES67 needs PTP. Phase 2 |
| Existing stream | Pull an Icecast mount or an SRT / RTP feed already on the station network | For stations that already have an encoder and only want the metadata and transport parts |
| Local fallback file | A loop or playlist played when input is silent for N seconds | Optional, per station. Same idea as a TV slate |

The edge measures input levels and silence locally (EBU R128 momentary, as `RADIO.md` section 11 does in the cloud). That lets it tell "the studio is silent" apart from "the link is down", which the cloud alone cannot.

## 5. Metadata: adapters and one event model

### 5.1 Adapters

Playout systems (Zetta, WideOrbit, ENCO, Myriad, RCS, NexGen and others) send their output in a few common shapes. One adapter per shape, configured per station, rather than one per vendor:

| Adapter | Takes | Typical use |
|---|---|---|
| TCP / UDP listener | Text, XML or JSON lines pushed by the playout system | The most common now-playing output |
| HTTP webhook | `POST` from the playout system or a middleware | Newer systems, cloud playout |
| File watch | A now-playing file the playout system rewrites (XML, JSON, text) | Older systems |
| GPIO / network GPIO | Break start and end as contact closures, or Livewire / WheatNet GPIO over the network | Stations whose ad breaks are only signalled by a GPIO |
| ICY passthrough | `StreamTitle` from an existing Icecast feed | Stations that already stream. Same parsing as the cloud capture today |
| Manual | A break button in the edge's local UI, or through the Volt console | Testing, small stations |

Each adapter has a field map (which tag is title, artist, category, duration) set in the Volt console and pushed to the edge. Vendor presets ship as saved field maps. Exact formats per vendor must be confirmed against each vendor's documentation or a customer's live output before a preset is published.

### 5.2 The event model

Every adapter produces the same event. This is the same canonical, time-based approach as the sports data framework: any source in, one model out.

| Field | Meaning |
|---|---|
| `type` | `song`, `spot` (one ad), `break_start`, `break_end`, `talk`, `news`, `station_id`, `program_start`, `program_end` |
| `at` | UTC time the event happened at the edge, from a disciplined clock (NTP at least, PTP when AES67 is used) |
| `stream_time` | The position in the encoded audio (PTS) the event belongs to. This is what makes it frame accurate |
| `duration_ms` | Planned length, when the playout system knows it (a break, a spot, a song) |
| `title`, `artist`, `album`, `program`, `presenter` | Display fields |
| `ids` | Whatever IDs the source gives: ISRC, playout cart number, Ad-ID, break ID |
| `raw` | The original message, kept as received |
| `source` | Which adapter produced it |

Because the playout system says what each item is, the `song / ad / content` class in `RADIO.md` section 4 comes **from the source** rather than from the title heuristic. The heuristic stays for stations without an edge.

## 6. Transport to Volt

Three modes, chosen per station. SRT is the default.

| | SRT (recommended) | HLS push | Icecast source |
|---|---|---|---|
| Container | MPEG-TS | fMP4 or TS segments over HTTPS `PUT` | MP3 or AAC stream |
| Now-playing | ID3 timed metadata in the TS | ID3 in the segments (`emsg` or TS ID3) | ICY `StreamTitle` |
| Breaks | SCTE-35 `splice_insert` (and `time_signal` later) in the TS | `EXT-X-DATERANGE` with `SCTE35-OUT` / `SCTE35-IN` | **None in band**. Side channel only |
| Timing | Exact (tied to PTS) | Exact to the segment, plus offset in DATERANGE | Approximate (ICY timing is loose) |
| Network | Outbound UDP. AES encryption, retransmission, configurable latency | Outbound HTTPS only. Works through strict firewalls and proxies | Outbound HTTP(S) |
| Failover | Two SRT paths (main and backup network, or two gateways) | Two upload targets | One |
| Fit | Default for any station that allows UDP out | Stations behind a proxy that only allows HTTPS | Compatibility: a station that only wants mass delivery, no ad replacement |

**Side channel.** In every mode the edge also sends each event to the Edge API over HTTPS (with `at` and `stream_time`). This keeps the metadata log working if the in-band data is lost, and it is the only path for breaks in Icecast mode. The cloud uses the in-band copy when present and the side-channel copy otherwise, matched by event ID so nothing is logged twice.

### 6.1 The SRT ingest gateway (new, cloud)

`RADIO.md` section 2 sets the rule that **a station container is always the SRT caller, never a listener**, because a listener needs a fixed address and cannot be moved, scaled or reaped with the fleet. Today the studio end listens and the station calls it. That does not work for an edge behind NAT with no inbound port.

So the edge needs something fixed to call. The SRT ingest gateway is that: a small fixed-address tier that accepts SRT from edges, authenticates each one by **stream ID and passphrase**, and makes the stream available to the station container, which calls the gateway. The station container stays a caller and keeps the fleet rule. The gateway is also where the second SRT path lands for failover. It carries no transcoding and is cheap to run in each region.

## 7. What changes in the cloud

| Piece | Today (`RADIO.md`) | With Volt Edge |
|---|---|---|
| Ingest | Icecast, HLS, SRT (station calls the studio) | Plus the SRT ingest gateway and HLS push ingest |
| Metadata log | ICY captured by the control plane over a second connection, classified by heuristic | Events from the TS (read by `radio.py`, sent on the existing timed-events feed) or from the side channel. Class from the source |
| ID3 for players | Title changes written as ID3 in `emsg` (built, `id3_emsg.py`) | Same, fed by edge events. Richer fields (album, artwork URL, program) |
| ICY on MP3 output | Passed through | Generated from edge events |
| Break markers on output | None | SCTE-35 / `EXT-X-DATERANGE` on HLS and DASH outputs, so a platform or a client-side SDK can replace ads ("markers" mode in `SSAI.md`) |
| Live ad replacement | Not built for radio | New: see 7.1 |
| QC | Cloud level monitor, dead air, static, metadata stall | Plus edge health: input level at the studio, link state, buffer depth, clock offset. The cloud can then say whether a fault is at the studio, on the link or in the cloud |
| Monitoring | Five gates, event log | A sixth view in front of **Input**: the edge itself (online, version, input signal, link) |

### 7.1 Live ad replacement for radio (the Triton revenue feature)

This is what Triton's Media Gateways do and what most commercial stations will ask about first. With accurate break markers from the edge, Volt can reuse the `SSAI.md` decision engine (VAST, pod fill, house fallback, beacons, reporting) for live audio:

* **HLS / DASH listeners:** per-listener playlists with ad audio stitched into the break (the FAST stitcher, audio only), or guided (HLS Interstitials) where the player supports it.
* **Icecast / MP3 listeners:** the relay tier swaps the break audio per listener connection. This is the hard part: one shared stream becomes per-listener during breaks. It needs ad audio conditioned to the station's codec and bitrate and a splice on frame boundaries. Design separately before committing.
* **Length fit:** a 120 s broadcast break filled with paid ads that add up to 105 s needs 15 s of house fill or a station promo, the same rule as FAST (R2 in `SSAI.md`).

## 8. Resilience

* **Local buffer:** the edge keeps a rolling buffer (default 60 s, configurable) and resends after a short outage. SRT recovers lost packets within its latency window. The buffer covers longer drops.
* **Two paths:** a main and a backup SRT path, over different networks where the station has them.
* **Two sites:** a backup edge at a second site or in a data centre, taking the same playout feed. The gateway takes whichever is healthy, using the same failover rules as channels (`FAILOVER.md`).
* **Silence fallback:** optional local loop when the input is silent, so listeners hear the station's filler rather than dead air.
* **Clock:** events are only as accurate as the clock. The edge reports its offset, and Volt warns when it drifts beyond a limit.

## 9. Management and security

* **Enrolment:** the operator creates the edge in the Volt console, which gives a one-time enrolment token. The edge exchanges it for its own credential. No passwords stored on the station machine.
* **Config from Volt:** stations, inputs, adapters and field maps, codec and bitrate, transport, buffer. Edited in the console, pulled by the edge. The edge runs the last good config if Volt is unreachable.
* **Updates:** signed releases, pulled by the edge, with rollback. Updates wait for a quiet window or an operator's go-ahead, never mid-programme by default.
* **Health and logs:** heartbeat, version, input levels (feeding the existing radio meter), link stats, buffer depth, clock offset, adapter state. The last N minutes of the edge's logs on request.
* **Security:** outbound only. SRT AES-128/256 with a passphrase per station. HTTPS for everything else. Credentials rotated from the console. One edge serves only the stations assigned to it.

## 10. Packaging

| Form | For | Notes |
|---|---|---|
| Linux container | Data centres, cloud playout, modern stations | Primary build |
| Windows service | Stations whose playout PC or audio interface is Windows only | Needed to replace Station Manager like for like |
| Appliance | Stations that want a box, not software | OEM small-form-factor PC with the agent installed. Not our own hardware |

Sizing to be measured, not assumed. An AAC or MP3 audio encode is light, so one machine should hold many stations, but publish a figure only after a test at 16 and 32 stations on a reference box.

## 11. Build plan

1. **Edge MVP:** Linux container, sound card and stream input, AAC / MP3 encode, SRT to a gateway, ICY and TCP/UDP adapters, event model, side channel, enrolment and config from Volt. Cloud: SRT ingest gateway, `radio.py` reads in-band ID3 and SCTE-35, events into the EPG log with class from the source.
2. **Operations:** edge health in the console (the edge view before the Input gate), buffer and resend, two paths, signed updates.
3. **Markers out:** SCTE-35 / `EXT-X-DATERANGE` on HLS and DASH radio outputs ("markers" mode).
4. **More inputs and adapters:** Windows service, HTTP webhook, file watch, GPIO, AES67 direct, vendor field-map presets.
5. **Live ad replacement, HLS / DASH:** reuse the SSAI engine for audio breaks.
6. **Live ad replacement, Icecast:** per-listener splice at the relay tier (design first).
7. **Visual radio:** one camera feed alongside the audio, through the same edge and gateway.

## 12. Decisions needed

1. **Target playout systems in APAC:** which ones do the first target stations run? That picks the first adapter presets.
2. **Ad revenue at launch:** do target stations depend on Triton's ad sales, or only its delivery? If ad sales, items 5 and 6 move ahead of 4, and an ad server or marketplace partner is needed (Volt does not sell ads, `SSAI.md` section 1).
3. **Windows at launch or later:** a like-for-like Station Manager replacement needs the Windows service in the MVP.
4. **Bring your own encoder:** support Wheatstone / Telos / other encoders sending SRT or HLS straight to the gateway from day one (low effort, wider reach), with metadata over the side-channel API?
5. **Appliance:** offer an OEM box at launch, or software only?
6. **Name:** "Volt Edge" is a placeholder until the product rename settles.

## Sources (Triton)

* Triton, *From Encoder to Listener*: https://help.tritondigital.com/docs/from-encoder-to-listener-understanding-the-flow-of-the-stream
* Triton, *Streaming and Delivery* requirements: https://help.tritondigital.com/docs/streaming-and-delivery
* Wheatstone adds the Triton Digital protocol (MRV2): https://wheatstone.com/?p=88814
* Triton, integration with The Telos Alliance: https://blog.tritondigital.com/our-integration-with-the-telos-alliance
