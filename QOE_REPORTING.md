# Playback experience (QoE) reporting: design, definitions and cost

Status: design, 24 Oct 2026. Replaces the CMCD line in build queue 1.14d and frames
2.9 (CDN logs) and 2.10 (CMSD). Extends REPORTING_TESTING.md (session beacons,
`play_sessions`), which stays the engagement path until this is built.

The goal in one sentence: every report below can be filtered by content, live or
on demand, device, OS and browser, app and player version, codec, CDN, region and
network, at a cost per viewer that **falls** as the audience grows.

---

## 1. Principles

1. **Measure the viewer, then explain with the network.** The player is the only
   place that knows whether a person saw a picture. CDN and server data explain
   why. Neither replaces the other.
2. **Start counting before the first media request.** A play attempt is opened
   when the viewer presses play, before entitlement, DRM or the manifest. Failures
   in those steps are the ones request-based CMCD alone never sees.
3. **One session id everywhere.** The play gate already issues a playback session
   (`play_sessions.session_key`). That id is the CMCD `sid`, the beacon session,
   the id in our server logs and the key the CDN log rows are joined on.
4. **Cost follows dimensions and time, not viewers.** Raw events are reduced to one
   summary row per view and to mergeable minute aggregates inside the collector.
   Reports read those, never the raw stream.
5. **Sample where statistics allow, never where one viewer matters.** CDN
   request logs are sampled as the audience grows. Player telemetry is never
   sampled, because report 11 must be able to show any viewer.
6. **Distributions, not averages.** Every time measure is reported as p50, p95
   and p99, with the number of viewers and sessions affected.
7. **Write the definitions down.** Providers differ (Mux, Conviva, NPAW). Ours are
   in section 4 and the console links to them from every chart.

---

## 2. The standards and what we use from them

### CMCD v2 (Common Media Client Data, CTA-5004-A, published 11 Feb 2026; current revision CTA-5004-B)

Two ways of sending, and we use both:

| Mode | How | What we use it for |
|---|---|---|
| **Request mode** (required for v2 players) | CMCD keys on every playlist and segment request, as **query arguments** (headers would force a CORS preflight on every segment from a CDN on another origin) | Lands in the CDN logs: joins a request to its session (`sid`, `cid`), its buffer (`bl`), throughput (`mtp`), object type (`ot`), startup (`su`) and starvation (`bs`) |
| **Event mode** (optional in the spec; we require it in our SDK) | Batched HTTP POST to our collector (`application/cmcd` body in -B; -A used `text/cmcd`). Every report carries `v`, `ts`, `e`, `sid` | The player experience itself: state changes (`e=ps` with `sta`: starting, playing, seeking, rebuffering, paused, ended, fatal, quit, preloading), errors (`e=e` with `ec`), bitrate changes (`e=bc`), the 30 s heartbeat (`e=t`), backgrounding (`e=b`), ad breaks (`abs`, `abe`, `as`, `ae`, `sk`) and response received (`e=rr` with `url`, `rc`, `ttfb`, `ttfbb`, `ttlb`) |

Keys we rely on beyond v1: `sta`, `ec`, `ltc` (live latency), `msd` (media start
delay), `pb` (playhead bitrate), `dfa` (dropped frames), `bsd`/`bsda` (starvation
duration), `bg` (backgrounded), `pr` (playback rate), `sn` (sequence number, for
event loss), `tpb` (top playable bitrate), `rr` timings, and `cmsds`/`cmsdd` (the
CMSD headers the player received, so server hints show up next to the experience).

What CMCD v2 does not have, we send as **custom keys** (the spec allows custom
keys containing a hyphen; ours are prefixed `com.volt-`): the startup breakdown
(entitlement, manifest, DRM licence, first segment, decode), app and SDK version,
device model, decoder (hardware or software where exposed), DRM system and licence
outcome, and the CDN edge request id of the response (section 3).

Event mode collector rules are the spec's: `204` on success, `429` slows the
player down (bigger batches), `410` stops reporting for the session, `5xx` retried
with back-off, reports kept and sent after connectivity returns.

**Player support today:** our SDK's engines use the SVTA common media library
(`@svta/cml-cmcd`, which encodes v2). hls.js supports CMCD v1 only (v2 is an open
request); dash.js supports CMCD and CMSD. Event mode is therefore built **in the
Volt SDK**, above the engine, so it works the same on Shaka, hls.js, dash.js and
native Safari. Third-party players that send CMCD v1 or v2 in request mode are still
counted from the CDN logs.

### CMSD (Common Media Server Data, CTA-5006)

CMSD is the reverse direction: the server tells the player about the response.
`CMSD-Static` describes the object (it does not change as the object passes
through caches); `CMSD-Dynamic` is added by each server on the path. dash.js
already acts on two keys: `mb` (maximum suggested bitrate, applied as an ABR
ceiling) and `etp` (estimated throughput, blended with the player's own
measurement).

What CMSD is for in Volt: **delivery guidance and diagnosis**, not experience
reporting. We use it to (a) tell players to cap their bitrate when an edge or the
origin is under duress (`mb`), (b) record what the server said next to what the
player did (through `cmsds`/`cmsdd` in event mode), and (c) prove whether an ABR
drop was the network or our own guidance.

**Cost guardrail:** CloudFront does not add CMSD to segment responses by itself,
and adding it per segment with Lambda@Edge would cost about $0.002 per viewer hour
(3,600 requests at $0.60 per million plus duration), which is 2 to 10 % of the cost
of delivering the video. So: CMSD on **playlists** from our own manifest service
(it already answers the rights variants, 1.14b), where one header covers every
segment the playlist lists; segment-level CMSD only on a CDN that adds it natively.

---

## 3. Architecture

```
 Viewer's player (Volt SDK)                         CDN (CloudFront)                 Volt
 ─────────────────────────                          ────────────────                 ────
 press play ──► open attempt (sid) ───────────────────────────────────────────► collector
            ──► entitlement / play gate (sid) ──────────────────────────────────► API log (timed)
            ──► DRM licence (sid) ──────────────────────────────────────────────► licence proxy log
            ──► manifest, segments  ── ?CMCD=sid,cid,bl,mtp,ot,su,bs ──► edge ──► real-time logs (sampled)
            ◄── response + CMSD + x-amz-cf-id (exposed to the page)                standard logs (optional)
 events (ps, e, bc, t, b, rr, ads) ── POST application/cmcd, batched ─────────► collector
                                                                                    │
                    collector: enrich (geo, ASN, UA, app), keep session state,      │
                    write one summary row per view, minute sketches, raw Parquet ◄──┘
                    stores: Postgres (small) / ClickHouse (large); S3 Parquet (timelines)
```

**The joins.** `sid` is the playback session from the play gate, set as the
CMCD session id, carried in the beacon and in our server logs. Request ids join a
player's `rr` event to the CDN's own log row: the CDN response headers policy
exposes `x-amz-cf-id` to the page (`Access-Control-Expose-Headers`), the SDK copies
it into the `rr` event, and the CDN log carries the same value as
`x-edge-request-id`. Our API and licence proxy log `sid` and their own request id.

**The collector** is a small stateless service (Node, behind the existing load
balancer, autoscaled). It keeps each live session's state in memory, routed by
`sid`, and at the end of a view (or after 60 s of silence, closed for good after 60
minutes) writes one **view row**. Every 10 s it flushes **minute aggregates**:
counts, sums and DDSketch percentile sketches (mergeable, about 1 % relative error)
per content and per the main dimensions. It also appends the raw events, compressed,
to Parquet files on S3 for the session timeline.

**Why not the AWS managed pipes.** At large audiences, Firehose ($0.029 per GB
plus $0.018 for Parquet), API Gateway ($1 per million requests) and Lambda per
event each grow linearly with viewers and would become the biggest line in the bill.
The collector writes its own Parquet files (one S3 PUT per 64 MB) and its own rows,
so the only per-viewer cost is CPU, and that is small (section 9).

**Stores, by size.** Below about a million viewer hours a month: the Postgres we
already run (`play_sessions` grows into the view row; minute aggregates in a new
table). Above that: ClickHouse, where a filter on any dimension over months of view
rows is a sub-second query. The switch is configuration, not a rewrite: the
collector writes through one interface.

---

## 4. Definitions (ours, written down)

**View (play attempt).** Opened when the viewer presses play or playback starts
programmatically, before entitlement. Closed at end, quit, or 60 s without events;
events within 60 minutes resume it. Counted in time ranges by its **start**
(engagement) or its **end** (experience), as Mux does.

**States.** Every second of a view is exactly one of: starting, playing,
rebuffering (involuntary stall), seeking (stall caused by a seek, until playing
resumes), paused, backgrounded (`bg` true, or the page hidden), ad. Rebuffering
time never includes startup, seeking, pauses or backgrounded time.

| Measure | Formula | Denominator / notes |
|---|---|---|
| Startup success | views that reach first frame / play attempts | per **attempt** |
| Startup failure | attempts ending in a fatal error before first frame / play attempts | error code kept |
| Exit before first frame (EBFF) | attempts the viewer left before first frame without an error / play attempts | split by how long they waited |
| Failure after start | views with a fatal error after first frame / views that **started** | per **started view**, not per attempt |
| Play-to-first-frame (startup time) | first frame rendered − play pressed | started views only; p50, p95, p99. Preroll ads excluded (reported as ad startup) |
| Startup breakdown | entitlement, manifest, DRM licence, first segment, decode | each a span of the above; gaps reported as "other" so they always add up |
| Rebuffer ratio | rebuffering time / (playing time + rebuffering time) | started views; startup, seeking, paused, backgrounded excluded |
| Rebuffer frequency | stalls / hour of playing time | same exclusions |
| Views with stalls | views with ≥ 1 stall / started views | the "how many people" number |
| Time to first stall | first stall − first frame | views with a stall |
| Seek delay | seek end (playing again) − seek start | separate from rebuffering |
| Time-weighted bitrate | Σ(bitrate × seconds at it) / playing seconds | playing time only |
| Time at resolution | seconds at each rendition height / playing seconds | plus % above / below what the screen can use (`tpb`) |
| Quality switches | switches / hour; **oscillation** = up then down (or down then up) within 10 s | ABR stability |
| Dropped-frame ratio | dropped / decoded frames (`dfa`) | playing time |
| Live latency | `ltc` (or wall clock − PDT of the playhead) | p50/p95; drift = change over the view |
| Playing time | seconds in playing | engagement; the basis for completion |
| Completion (on demand) | furthest playhead / duration ≥ 90 % | views with a known duration |
| Exit after stall / error | views ending within 30 s after a stall or a non-fatal error / views | the link between quality and retention |

**Percentiles and affected viewers.** Every time measure shows p50, p95, p99 from
the sketches, the number of views it covers, and the number of distinct viewers
affected (sessions, or signed-in users where the app has them).

---

## 5. The reports

All eleven read the view rows and minute aggregates, are filterable by every
dimension in section 6, and show the definitions they use.

| # | Report | Key measurements | Answers | Data | Freshness, retention |
|---|---|---|---|---|---|
| 1 | Playback success | Attempts, successful starts, startup failures (by code), EBFF, fatal errors after start | Can viewers actually watch? | Player events, play gate log | 1 min; 13 months |
| 2 | Startup performance | Play-to-first-frame p50/p95/p99; entitlement, manifest, DRM licence, first segment, decode spans | Why does playback start slowly? | Player custom spans + API and licence proxy timings by `sid` | 1 min; 13 months |
| 3 | Buffering and interruptions | Views with stalls, stall count, duration, rebuffer ratio, time to first stall; seek delays separately | How often is viewing interrupted? | `ps` state changes, `bsd`/`bsda` | 1 min; 13 months |
| 4 | Video quality and ABR | Time at each resolution, time-weighted bitrate, switches, oscillation, buffer level and throughput | Is the player choosing a sustainable quality? | `bc`, `pb`, `bl`, `mtp`, `tpb` in heartbeats | 1 min; 13 months |
| 5 | Rendering and device health | Dropped-frame ratio, decoder errors, freezes; A/V sync where measurable; codec and hardware decoding where exposed | Does it look smooth even when delivery is fine? | `dfa`, `ec`, custom decoder keys; the encoder's own A/V check (output_check.py) for the stream side | 5 min; 13 months |
| 6 | CDN and origin delivery | Manifest and segment latency, TTFB, throughput, HTTP errors, retries, cache hits, CDN failover outcomes | Is delivery responsible? | `rr` events (sampled requests plus every error, retry and slow one) joined to CDN logs by edge request id; CMSD received | 1 min; 90 days detail, 13 months rollups |
| 7 | DRM and access | Licence latency, licence and renewal failures, expired-token errors, entitlement denials (geo, rights, payment), output-protection failures | Are protection or access checks blocking playback? | Play gate and licence proxy logs + player `ec` | 1 min; 13 months |
| 8 | Live-stream health | Distance from live edge, latency drift, catch-up rate (`pr`), manifest freshness, missing segments, discontinuities | Are viewers live, stable and close to target latency? | `ltc`, `pr` from players; output_check.py and the five gates from the stream side | 1 min; 13 months |
| 9 | Advertising | Ad startup delay, ad errors, ad buffering, completion, break duration, return to content | Are ads hurting playback or revenue? | Player ad events; the server-side beacons already recorded (1.11) | 1 min; 13 months |
| 10 | Engagement and abandonment | Playing time, completion, EBFF, exits after stalls or errors, per programme (EPG) | How does quality relate to retention? | View rows; EPG join (exists) | 5 min; 25 months |
| 11 | Individual session timeline | Every state change, request (sampled), quality change, buffer level, error, DRM and ad event, in order | What happened to this viewer? | Raw events in Parquet, by `sid` | seconds after the event; 30 days |
| 12 | **Telemetry health** (added) | Views with no `sid`, event loss (gaps in `sn`), reporting coverage (views with telemetry ÷ sessions seen at the CDN), late events, unknown or unsupported keys, clock skew | Can we trust the other eleven? | Collector counters, CDN sessions | 1 min; 90 days |

---

## 6. Dimensions and where each comes from

| Dimension | Source | Cardinality control |
|---|---|---|
| Content / channel / event / programme | `cid` = our asset id; programme from the EPG at the playhead time | none needed |
| Live or on demand | CMCD `st` (v, l, ll) | 3 values |
| Device model | App-reported (native APIs), else UA Client Hints, else UA parse | top 500 per account per month, the rest "Other" |
| OS and browser (+ versions) | UA Client Hints / UA parse; app-reported on native | major version only |
| App and player version | Custom keys `com.volt-app`, `com.volt-sdk`; engine name and version | kept in full: a bad release is exactly what this must catch |
| Codec | Playing rendition's codec string (from the manifest the player chose) | family + profile |
| CDN | Response host (`h`), CDN-identifying response headers | small |
| Region | Collector geo lookup on the IP (country, region; city optional); IP never stored, only hashed | ISO codes |
| ISP and network type | ASN lookup (MaxMind GeoLite2 ASN or IPinfo) for ISP; Network Information API (where the browser has it) and native APIs for wifi / cellular / wired | top 1,000 ASNs, the rest by type |

**Why per-view rows and not a precomputed cube.** Nine dimensions multiplied
together would be billions of combinations, nearly all empty. One compressed row
per view (about 70 bytes in ClickHouse) holds them all, and a columnar store
filters on any of them quickly. The minute aggregates only use the few dimensions
the live dashboards need (content, live/VOD, country, device class, CDN).

---

## 7. Paused, backgrounded and the healthy average

- Pauses and backgrounding are their own states (section 4). They never count as
  rebuffering, and backgrounded time is excluded from dropped frames (browsers stop
  rendering hidden tabs).
- Every chart shows the overall line **and** the worst segments: the dimension
  values with the biggest share of affected viewers, over a minimum number of
  views, so a bad TV model or app release stands out instead of being averaged away.

---

## 8. Telemetry health (report 12) in detail

| Measure | How |
|---|---|
| Missing session id | views or CDN sessions with no `sid` (third-party players, broken integrations) |
| Event loss | gaps in the per-session `sn` sequence ÷ events expected |
| Reporting coverage | views with player telemetry ÷ playback sessions seen at the CDN, per app and version |
| Late or out-of-order events | arrival − `ts` beyond 60 s |
| Unsupported or unknown keys | counted per key and player, so a new player version that changes its output shows up |
| Clock skew | `ts` − collector time, per device class |

---

## 9. Scale and cost

### What the model assumes

- A **viewer hour (VH)** is one person watching for an hour. Average concurrent
  viewers = VH per month ÷ 730; the peak is taken as 4 × the average.
- Player telemetry: 130 events per VH (the 30 s heartbeat plus state, bitrate,
  error and ad events), plus `rr` for 1 in 50 requests and every error, retry or
  slow one (about 92 per VH), about 200 bytes each, sent in batches of 10.
- Collector: 50 µs of CPU per event, Fargate on ARM, run at 50 % at peak, two small
  tasks minimum.
- CDN real-time logs: about 3,600 requests per VH for live (4 s segments, video and
  audio, playlist refreshes), 700 bytes per line, sampled so at most about 1,000
  lines a second reach us. CloudFront's lowest sample rate is 1 %.
- Prices (us-east-1, October 2026): CloudFront real-time logs $0.01 per million
  lines; Kinesis Data Streams on demand $0.08 per GB plus $0.04 per stream hour
  (Advantage $0.032 per GB above a TB a month); Fargate ARM about $0.032 per vCPU
  hour; ClickHouse on Graviton EC2 on demand (r7g.large about $77 a month, 2xlarge
  about $308, 8xlarge about $1,232), EBS $0.08 per GB; S3 $0.023 per GB.
- For scale: delivering the video itself costs roughly $0.03 to $0.11 per VH at 3
  Mb/s (CDN egress at $0.02 to $0.085 per GB).

### Total, and cost per viewer

| Audience | Viewer hours / month | Avg / peak concurrent | Store | Monthly cost | Per 1,000 VH | Share of delivery cost |
|---|---|---|---|---|---|---|
| Pilot | 100 k | 137 / 550 | Postgres (existing) | about $90 | $0.90 | 0.8 to 3.3 % |
| Small | 1 M | 1.4 k / 5.5 k | ClickHouse r7g.large | about $215 | $0.22 | 0.2 to 0.8 % |
| Medium | 10 M | 14 k / 55 k | ClickHouse r7g.large | about $217 | $0.022 | 0.02 to 0.08 % |
| Large | 100 M | 137 k / 550 k | ClickHouse 2 × r7g.2xlarge | about $875 | $0.009 | under 0.03 % |
| Very large | 1 B | 1.4 M / 5.5 M | ClickHouse 2 × r7g.8xlarge | about $4,400 | $0.004 | under 0.02 % |

Not in these totals: the long-term raw archive (section 9a), which adds under $1,
about $25 and about $175 a month at 1 M, 100 M and 1 B VH once 25 months are held.

The total grows about 50 times while the audience grows 10,000 times. The cost per
1,000 viewer hours falls from $0.90 to $0.004. At the pilot size most of the cost is
fixed (the Kinesis stream hour and two collector tasks). At very large sizes the
biggest lines are the database and the sampled CDN logs, and both are bounded:
the CDN sample is capped at 1 %, and database cost follows stored rows (one per
view), not events.

### By report (monthly)

Shared costs are split by the events and storage each report needs.

| Report | 100 k VH | 1 M VH | 10 M VH | 100 M VH | 1 B VH | What drives it |
|---|---|---|---|---|---|---|
| 1 Playback success | $1 | $9 | $9 | $57 | $233 | view rows |
| 2 Startup performance | $2 | $13 | $13 | $86 | $351 | 9 extra events per VH, span columns |
| 3 Buffering | $1 | $13 | $13 | $85 | $346 | state changes, sketches |
| 4 Quality and ABR | $2 | $15 | $15 | $100 | $406 | bitrate changes, time-at-resolution columns |
| 5 Rendering and device | $1 | $7 | $7 | $43 | $178 | piggybacks on heartbeats |
| 6 CDN and origin | $63 | $108 | $108 | $227 | $1,646 | CDN real-time logs and `rr` events: the only report with a per-request source |
| 7 DRM and access | $1 | $7 | $7 | $44 | $179 | server logs we already write |
| 8 Live-stream health | $1 | $7 | $7 | $43 | $177 | heartbeat keys + the encoder's own checks (free) |
| 9 Advertising | $3 | $11 | $11 | $60 | $252 | about 24 ad events per VH on ad-supported content |
| 10 Engagement | $1 | $14 | $14 | $99 | $400 | view rows, 25-month retention |
| 11 Session timeline | $1 | $1 | $2 | $15 | $142 | raw events in Parquet on S3, 30 days |
| 12 Telemetry health | (in the collector) | | | | | counters only |

### Optional: complete CDN counts for players we do not control

Standard (batch) CDN logs to S3, processed hourly and deleted after two days, give
billing-grade audience counts for third-party players that send no telemetry: about
$0.0005 per 1,000 VH ($0.53 a month at 1 M VH, $529 at 1 B VH). Off by default,
since our own players are counted by the collector.

### What keeps it cheap (and what would break that)

| Choice | Why | Cost of getting it wrong |
|---|---|---|
| Summaries and sketches inside the collector | Database rows follow views, not events | Storing every event as a row: about 300× the rows |
| The collector writes its own Parquet and rows | Per-event managed services grow linearly with viewers | Firehose with Parquet at 1 B VH: about $1,200 a month for ingest alone |
| Adaptive sampling of CDN real-time logs | Delivery diagnosis is statistical; 1,000 lines a second is plenty | 100 % at 1 B VH: about $36,000 a month in log lines and stream |
| CMSD on playlists, not per segment | One header covers a playlist's worth of segments | Lambda@Edge on every segment: about $2,000 a month per million VH |
| Query mode CMCD on media requests | No CORS preflight on every segment | Header mode across origins doubles media requests |
| Cache key ignores CMCD | Viewers still share one cached object | A CMCD-aware cache key would make every request a miss |
| Postgres until about 1 M VH | No new system for a pilot | |

---

## 9a. Where the data lives, keeping it safe, and reprocessing

### The raw events are the source of truth; the summaries are rebuildable

```
 player ─► collector ─► 1. RAW: append the batch to S3 (Parquet, the original CMCD text kept)   ◄── the record
                      ─► 2. DERIVED: view rows + minute sketches  ─► analytics store             ◄── rebuildable
                         (from 1, never instead of it)
```

- The collector **writes the raw batch first** and answers the player's POST
  only once it is buffered for that write. In-memory session state (the running
  view row) is only a fast path: if a collector task dies, the views it held are
  rebuilt from the raw files.
- Every derived row carries the **definitions version** it was computed with
  (section 4). Changing a definition, fixing a bug or adding a new report structure
  means a **replay**: read the raw Parquet for the period and rebuild that
  period's rows. Replays are idempotent. View ids are deterministic from `sid` and
  the attempt number, and rebuilt rows replace a whole day partition, so running a
  replay twice gives the same answer.
- Sampled CDN real-time log lines are archived the same way, so report 6 can be
  replayed too. Standard CDN logs, when turned on, are kept as raw.

### A separate store, so reporting can never slow the platform down

- **Analytics never shares the control plane's database at any real size.** On the
  Mac and for a pilot it can be a second database on the same Postgres server, with
  its own connection pool and a hard limit on connections. From about 1 M VH a
  month it is ClickHouse on its own instances. The control plane (channels,
  encoders, the play gate) has no dependency on the analytics store, so a slow
  report or a backlog cannot delay a stream start or a playback token.
- **Writes are batched, never per event.** The collector inserts view rows and
  minute aggregates in batches every 10 s (Postgres `COPY`, ClickHouse batch
  inserts of thousands of rows). At 1 B VH a month that is about 600 view rows a
  second in a few large inserts: well inside one ClickHouse node. No row is
  updated per event, so there are no hot rows and no lock contention.
- **Reads hit summaries.** Dashboards read minute aggregates and view rows, with
  query time limits. Heavy exports and replays run against a replica, or read the
  Parquet in S3 directly (ClickHouse `s3()` or Athena), never the live write path.
- **Backpressure, not loss.** If the analytics store is slow or down, the
  collector keeps writing raw files to S3, holds the derived inserts in a bounded
  queue, then catches up or replays from the raw files. Players never see an error
  for it.

### Protection from loss

| Layer | Protection |
|---|---|
| Player | Reports kept and retried with back-off (the CMCD v2 rules: `5xx` retry, `429` slow down), sent after connectivity returns; `sn` numbers let report 12 measure what was still lost |
| Collector | Two or more tasks across availability zones behind the load balancer; a batch is flushed to S3 every 10 s or 64 MB, so a crash loses at most the unflushed seconds of one task, which the players' retries cover |
| Raw archive (S3) | 11 nines durability; **versioning plus Object Lock (governance mode)** so nobody (or a bug) can delete or overwrite raw data inside its retention; optional replication to a second region for disaster recovery |
| Analytics store | ClickHouse: two replicas and nightly backups to S3. Postgres (small sizes): the automated backups and point-in-time recovery we already need. Either can be rebuilt from the raw archive |

### The long-term raw archive

Raw events move through S3 storage classes by age. Files are written large
(64 to 256 MB), so the per-object charges on the archive tiers stay negligible.

| Age | Class | Used for |
|---|---|---|
| 0 to 30 days | S3 Standard | Session timelines (report 11), replays of recent periods |
| 30 to 90 days | S3 Glacier Instant Retrieval | Investigations, a replay within minutes |
| 90 days onward | S3 Glacier Deep Archive (bulk restore in about 12 to 48 hours) | Rebuilding history when definitions change or a new report is added |

About 220 events of 200 bytes each per viewer hour gives about 44 KB raw, or about
5.5 KB as compressed Parquet. Keeping **25 months** of raw events:

| Audience | Raw added per month | Archive held at 25 months | Monthly archive cost (about) | Replaying one full month |
|---|---|---|---|---|
| 1 M VH | 5.5 GB | 140 GB | under $1 | cents |
| 100 M VH | 550 GB | 14 TB | about $25 | about $2 restore + compute |
| 1 B VH | 5.5 TB | 140 TB | about $175 | about $15 restore + a few hours of compute |

(Deep Archive about $0.001 per GB-month, Glacier Instant Retrieval about $0.004,
bulk restore from Deep Archive about $0.0025 per GB; Deep Archive has a 180-day
minimum, which this lifecycle always meets.)

Keeping raw events is cheap enough that the default is **keep 25 months, archive
after 90 days**. Longer is a policy choice, not a cost problem. Raw events hold no
IP address (only the hash and the derived geo and ASN), so long retention does not
widen the privacy footprint beyond what the reports already hold.

---

## 10. Build plan (proposed changes to BUILD_QUEUE.md)

| Item | Scope | Acceptance |
|---|---|---|
| **1.14d** (rewritten) | CMCD v2 in the Volt SDK: request mode (query) on every engine, event mode to `POST /api/cmcd` (the collector, inside the API on the Mac), attempt opened before entitlement, custom startup spans, `x-amz-cf-id` exposure, CloudFront cache policy ignoring CMCD keys, `sid` = playback session | Player test: request keys valid for v2; event reports carry `v`, `ts`, `e`, `sid`, `sn`; a failed licence and a refused entitlement still produce a view with the right code; two sessions share one cached segment |
| **1.14e** (new) | Collector writing raw batches first (local folder on the Mac, S3 in the cloud), then view rows and minute sketches into a **separate analytics database** with its own pool; replay command; reports 1, 2, 3, 4, 10 and 12 in the console with the section 4 definitions and the section 6 filters | Simulated viewers with known stalls, failures and switches give exactly the expected numbers at p50/p95/p99; filters by device model and app version isolate a planted bad release; deleting the derived rows and replaying gives identical reports; the analytics database stopped mid-run loses nothing and the control plane is unaffected |
| **1.14f** (new) | Reports 5, 7, 8, 9 and 11 (session timeline from Parquet, on the Mac from local files) | One planted session is reconstructable end to end; DRM and entitlement failures attributed to the right step |
| **2.9** | CDN real-time logs with CMCD, adaptive sampling, join on edge request id; report 6 | Sampled logs give delivery percentiles within 2 % of a 100 % run on the same traffic |
| **2.10** | CMSD on playlists (`mb` under duress, static object info), recorded via `cmsds`/`cmsdd`; content steering | dash.js and the SDK respect `mb`; the report shows guided versus network-driven drops |
| **2.11** (new) | ClickHouse store, switched on above a configured size; load test at 100 k concurrent simulated sessions | Collector at 50 % CPU at the modelled event rate; dashboards under 1 s over 13 months |

---

## 11. Decisions for Christian

1. **Telemetry is never sampled** (report 11 needs every viewer). Fine, or sample
   timelines (not summaries) above some size to save the S3 line?
2. **Retention:** 13 months for experience reports, 25 for engagement, 30 days for
   session timelines, 90 days for request detail. Change any?
3. **Signed-in viewers:** count distinct affected *people* where the app signs
   viewers in, or sessions only (privacy and consent)?
4. **ClickHouse:** self-run on our own instances (the costs above) or ClickHouse
   Cloud (simpler operations, roughly 2 to 3 × the cost at the larger sizes)?
5. **Third-party players:** turn on the optional complete CDN counts by default for
   accounts that publish raw stream URLs?
6. **Raw archive:** keep raw events 25 months (archived after 90 days), or longer?
   Replicate the raw archive to a second region?

## Sources

- [CTA-5004-A, Common Media Client Data (CTA WAVE)](https://cta-wave.github.io/Resources/common-media-client-data--cta-5004-a.html)
- [CMCD v2 released (EINBLIQ.IO)](https://einbliq.io/cmcd-v2-is-officially-released/)
- [hls.js CMCD v2 request (#7724)](https://github.com/video-dev/hls.js/issues/7724)
- [dash.js CMSD](https://dashif.org/dash.js/pages/usage/cmsd.html) and [dash.js CMCD](https://dashif.org/dash.js/pages/usage/cmcd.html)
- [Mux metric definitions](https://www.mux.com/docs/guides/understand-metric-definitions)
- [Kinesis Data Streams pricing](https://aws.amazon.com/kinesis/data-streams/pricing/), [Data Firehose pricing](https://aws.amazon.com/firehose/pricing/), [CloudFront pricing summary](https://www.factualminds.com/blog/amazon-cloudfront-pricing-regional-tiers-requests-security/)

---

## 12. What exists today, and the full reporting set

### How much of the eleven exists already (24 Oct 2026)

| # | Report | Today | What is missing |
|---|---|---|---|
| 1 | Playback success | **Partly.** The play gate counts play requests and refusals (geo, rights): Analytics "Blocked" | Attempts opened before entitlement, startup failures, exits before first frame, fatal errors after start (players report no errors today) |
| 2 | Startup performance | **Data only.** Beacons carry time to first frame (`play_sessions.ttff_ms`); not shown anywhere | Percentiles, the breakdown (entitlement, manifest, licence, first segment, decode), a report |
| 3 | Buffering | **Data only.** `play_sessions.rebuffer_ms` (one total per session); not shown | Stall count, duration distribution, time to first stall, seek separated, a report |
| 4 | Quality and ABR | **Data only.** Highest bitrate per session and bitrate in heartbeats; not shown | Time at resolution, time-weighted bitrate, switches and oscillation, buffer and throughput |
| 5 | Rendering and device | **Per viewer, live only:** the player debug panel shows dropped frames and the diagnosis; nothing is stored | Everything stored and aggregated |
| 6 | CDN and origin | **Per viewer, live only:** the debug panel shows the CDN and POP | Everything (2.9) |
| 7 | DRM and access | **Partly.** Geo and rights refusals counted; edge rights decisions designed and built (1.14a, 1.14b); rights preview being built (1.14c) | Licence latency and failures, token errors, output protection, per-step attribution |
| 8 | Live-stream health | **Stream side is strong:** five health gates, output timing check, monitoring board, Multiview, timeline grid, alerts, operating reports | The viewer side: distance from live edge, latency drift, catch-up per viewer |
| 9 | Advertising | **Server side for FAST:** decisions, fill, server-side beacons (impressions, quartiles, completion) | Ad startup, ad errors and buffering from the player, return to content; ads on live channels and events |
| 10 | Engagement | **Mostly.** Views, unique viewers, watch hours, peak and current concurrency, by device class, country and app; per-stream operating reports | Completion, exits before start, exits after stalls or errors, per programme (EPG), the new dimensions |
| 11 | Session timeline | **None** for a viewer (the stream's own event log exists) | Everything |

### Existing reports that must change to match this design

| Existing | Where | Change |
|---|---|---|
| Analytics (overview, realtime, by asset, audience) and the Dashboard tiles | `modules/analytics.ts`, `Analytics.tsx`, `Dashboard.tsx` | Read view rows and minute aggregates from the analytics store instead of `play_sessions`/`analytics_rollups`; a view is counted per the section 4 definition; add the section 6 filters (the JSON `by_app`/`by_device`/`by_geo` rollups cannot be filtered together); percentiles where times are shown |
| Session beacons | `POST /api/analytics/beacon` | Becomes a compatibility path: the SDK sends CMCD v2 event mode; old players' beacons are translated into the same events by the collector, so one pipeline counts both |
| Realtime viewers on stream pages | Channel and event pages | From the collector's minute aggregates (same number everywhere) |
| Analytics retention sweep | `analytics/retention` | Follows section 9a: derived data by its retention, raw kept in the archive instead of deleted |
| Operating reports (runs, hours run vs on air, unplanned stops, peak concurrent) | `modules/reports.ts`, `OperatingReports.tsx` | Kept (operations and billing). Peak concurrent taken from the collector; a link from each run to its QoE |
| FAST ad report and beacons | `modules/fast.ts` | Kept as the server-side half of report 9; joined with player ad events by `sid`; same filters |
| Geo and rights refusals, edge decisions | play gate, `edgeRights.ts`, `publicLive.ts` | Write their decisions with `sid` into report 7 |
| Player debug panel | `volt-player/src/sdk/stats.ts` | Uses the section 4 states and definitions, so what a person sees in the panel matches the reports |
| Monitoring board, Multiview, pipeline gates, output timing check, stream alerts | monitoring, `pipelineHealth.ts`, `output_check.py`, `streamAlerts.ts` | Kept (stream-side health); report 8 puts them next to the viewer side |
| Fleet usage, storage, audit log, notifications | as today | Unchanged; not viewer reporting |

### The complete reporting set once this is built

**Viewer experience (QoE)**
1. Playback success
2. Startup performance
3. Buffering and interruptions
4. Video quality and ABR
5. Rendering and device health
6. CDN and origin delivery
7. DRM and access
8. Live-stream health (viewer side and stream side together)
9. Advertising (player and server-side beacons together)
10. Engagement and abandonment (absorbs today's Analytics)
11. Individual session timeline
12. Telemetry health

**Audience (live and historical)**
13. Watching now and realtime concurrency (channel, event and stream pages, Analytics, Dashboard)
14. Audience by programme (EPG) and by time of day

**Stream operations**
15. Monitoring board and alerts (five gates, timing faults, no source, filler, stops)
16. Multiview (confidence monitoring with source and output flags, viewer-location checks)
17. Stream event log and timeline grid (outages, failovers, splices per stream)
18. Operating reports (runs, hours run against hours on air, unplanned stops, peak concurrent, CSV)
19. As-run against plan (EPG)

**Rights and access**
20. Rights preview (what a viewer in a country, rights class and time gets) and refusal counts

**Advertising**
21. FAST ad report (decisions, fill, beacons, completion) (feeds report 9)

**Content**
22. Media Library QC and review state, publications and social views

**Platform and cost**
23. Fleet usage and billing (server time, billable hours)
24. Storage
25. Reporting cost and telemetry coverage (from report 12 and section 9, per account)

**Governance**
26. Audit log (including downloads)
27. Notification delivery (alerts sent, failed, retried)

**Journey to play (section 13)**
28. Journey to play: the funnel from app open to first frame, with drop-off at each step
29. Discovery attribution: plays, watch time and completion by entry point

---

## 13. Journey to play (app view reporting)

Added 24 Oct 2026. **Not a general app-analytics SDK.** Google Analytics,
Firebase, Amplitude and PostHog already do page and event analytics, clients
already use one, and a general SDK across web, iOS, Android, tvOS, Android TV,
Tizen, webOS and Roku would be a large, permanent maintenance load with privacy
obligations attached. What only Volt can do is join **how a viewer got to the
play button** to **what happened after it** (entitlement, payment, startup,
QoE, watch time), because those last steps are ours. This section builds exactly
that and nothing more.

### What it answers

| Question | Why Volt is needed for it |
|---|---|
| Where do viewers give up before pressing play (home, detail, play, sign-in or paywall, first frame)? | The last steps are our entitlement, payments and startup data |
| Which row, search, deep link, push notification, EPG entry or "continue watching" produced plays, watch time and completion? | Watch time and completion come from our QoE data |
| How long from opening the app to the first frame? | It ends in our startup measurement |
| Did an app release hurt plays as well as playback? | App version is already a QoE dimension |
| Which detail pages are viewed and never played? | Needs the catalogue (Media Library) and play data together |
| Does a slow start or an error stop a viewer starting the next item? | Joins report 10 to the journey |

### The event set (fixed, about ten)

| Event | Carries |
|---|---|
| `app_open`, `app_close` | app id and version, cold or warm start, launch source (icon, deep link, push) |
| `screen` | screen name and type (home, browse, detail, search, player, account), content id where the screen is about one |
| `content_select` | content id, entry point (row and position, search, deep link, push, EPG, continue watching, related) |
| `search` | results count; the query hashed or left out (account setting) |
| `paywall_show`, `purchase` | product and outcome (payments already records the money) |
| `play_intent` | the QoE play attempt (section 4); the link between the two halves |
| `background`, `foreground` | for honest session lengths |
| `track(name, props)` | a few custom events per app, with a limit on names and properties |

No heatmaps, no click capture, no advertising identifiers, no user profiles, no
cross-app tracking.

### The join

The SDK keeps an **app session id** (a new one after 30 minutes in the
background) and a **journey id** that starts at `content_select` (or a deep
link) and is carried into the play attempt. The play attempt's `sid` records its
journey id, so every QoE view row knows its entry point and the screens before
it, and every journey knows whether it ended in a play, a refusal, a payment, an
error or nothing.

### How apps send it

- **Web:** automatic. The SDK listens to the browser's history (single-page apps
  included) for screen changes. Screen names come from a route map the app gives
  once, or from the path.
- **React Native, Android, iOS:** automatic where the standard navigation
  lifecycle allows (React Navigation listeners, activity and fragment lifecycle,
  view controller appearance via a delegate, no method swizzling).
- **TV platforms and custom routers:** one call in the router or page loader:
  `volt.screen('detail', { contentId })`. `volt.select(contentId, { entry: 'row:Trending', position: 3 })`
  where the app knows the entry point.
- **Ships inside the existing Volt SDK** (web first). Native and TV wrappers are
  small, added per platform when a client needs one.
- **Pass-through:** the same events can be forwarded to GA4, Firebase or Segment
  through an adapter, so Volt complements the client's analytics tool instead of
  replacing it.

### Privacy

Off until the app's consent says yes where consent is required. No personal data.
The IP address is hashed and only used for geo and network, as for QoE. Nothing
that could identify a person across apps, so no App Tracking Transparency prompt
is needed on iOS; the app's privacy labels list "product interaction" and
"diagnostics".

### Reports

- **28. Journey to play:** app open to first frame as a funnel (open, browse,
  detail, play pressed, entitlement passed, paid where needed, first frame), with
  drop-off and time at each step, filterable by every section 6 dimension plus
  entry point.
- **29. Discovery attribution:** plays, watch time, completion and QoE by entry
  point (row and position, search, deep link, push, EPG, continue watching),
  including "viewed, never played" for detail pages.
- **Two new dimensions on reports 1 to 10:** entry point and app session depth
  (how many screens before the play).

### Cost

About 20 to 40 events per app session, against about 220 per viewer hour for
playback, so it adds roughly 10 to 20 % to the collector and storage lines in
section 9. Same collector, same raw-first archive, same view and minute stores,
same downward cost per viewer. One journey row per journey (about 40 bytes
compressed) beside the view rows.

### Build

Build item **1.14g**, after 1.14e (it needs the collector): web SDK events and
auto capture, the journey id carried into the play attempt, reports 28 and 29,
the two new dimensions, the GA4 pass-through. Native and TV wrappers are separate
small items when a client needs them.
