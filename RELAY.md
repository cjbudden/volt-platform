# The MP3 relay tier: what it is, how it scales, and what it costs

Radio has one output that is not a file. HLS and DASH are segments a station
writes into the origin and a CDN serves. MP3 is a **live push to an Icecast
relay**, and the relay owns listener fan-out. That difference is why the relay
is the one piece of the platform that is not currently modelled anywhere.

This document is the honest state of it plus the design, written after being
asked the reasonable question: *once Docker is up and Icecast is running, how
does the relay scale, and is it tracked and costed like the encoder fleet?*

---

## What exists today

**One address, from an environment variable.**

```
ICECAST_HOST=localhost  ICECAST_PORT=8000
ICECAST_SOURCE_USER=source  ICECAST_SOURCE_PASSWORD=…
ICECAST_PUBLIC_BASE=            # the listener-facing face, e.g. a CDN
ICECAST_AUTH_SECRET=            # shared secret for the listener gate
```

Every station pushes to that same host:port. There is no pool, no discovery,
and no health check beyond `radio.py`'s three-second TCP probe at launch, which
drops the MP3 output when nothing answers rather than letting one refused
`icecast://` connection kill the ffmpeg that also carries HLS and DASH.

**The mount is derived from the channel id**, not its name:

```ts
mountFor(channelId) => `${channelId}.mp3`
```

That was done so a renamed station keeps its listener URL. It has a second
consequence that matters here: mounts are **stable and hash-shardable**, which
is exactly what multi-master scaling needs.

**`ICECAST_PUBLIC_BASE` already separates two addresses.** The in-VPC host:port
a station pushes to is not the address a listener is given. That seam is where
a load balancer or CDN slots in, and it already exists.

**The listener gate already exists.** `modules/icecastAuth.ts` answers Icecast's
`listener_add` callback on every connect and admits the listener only if the
station is on air and the rights allow it, so the on-air gate survives the
control plane leaving the audio path.

### Three things that did NOT exist

**1. The relay is not in the fleet.** *(Addressed by migration 0021 — see "What
is built now" at the end.)* The schema was explicit:

```sql
compute_hosts.kind  CHECK (kind IN ('ec2', 'fargate', 'local'))
instances.task_kind CHECK (task_kind IN ('transcode','package_only','radio','captions','thumbnailer'))
```

`usage_accruals` accrues one row per metered window **per instance**. The relay
has no instance row, so it accrues nothing: it does not appear in Fleet & Usage,
and it contributes zero to any invoice. The fleet page currently implies the
relay is free, and it is not.

**2. Listener counts do not work in container mode.** `radio/state.ts` reads a
listener count only when the task arn starts with `radio:`, which is the legacy
in-process path where the control plane held every listener socket itself:

```ts
let listeners: number | null = null;
if (arn.startsWith('radio:')) { … listeners = rs.listeners; }
```

A containerised station never matches, so `listeners` is always `null`. The
console's **"0 MP3 listeners" is not a measurement, it is the absence of one** —
the same claim-versus-evidence confusion that has bitten this codebase before,
rendered as a confident zero.

**3. Listener sessions are discarded.** `listener_remove` is a stub:

```ts
icecastAuthRouter.post('/listener-remove', (_req, res) => { res.status(200).send('ok'); });
```

Icecast tells us when every listener leaves, and we throw it away. That event is
the other half of the only number that matters for relay cost.

---

## Why it cannot simply be another `task_kind`

The encoder fleet and the relay have **different cost shapes**, and metering the
relay the way tasks are metered would capture the wrong number.

| | Encoder / station | Relay |
|---|---|---|
| Cost driver | tasks × time | concurrent listeners × bitrate × time |
| Scales with | how many streams are running | how many people are listening |
| Attributable to | one channel, exactly | one channel, per listener session |
| Dominant term | instance hours | **egress bytes** |
| Idle cost | none (task is stopped) | the host is still up |

A station is one ffmpeg: its cost is the same whether nobody or a million people
are listening, because it does not serve any of them. The relay is the opposite:
it costs almost nothing until people arrive, and then it costs in proportion to
them.

Concretely, a 128 kbps mount is **16 KB/s per listener**. One thousand
concurrent listeners is 16 MB/s, about 128 Mbit/s, and roughly **57 GB per
hour**. At typical cloud egress that is far more than the box it runs on. Adding
`kind='relay'` to `compute_hosts` and accruing its hourly rate would put maybe
two cents an hour on the invoice while missing the number that is actually being
spent.

So the relay needs metering in its own unit — **listener-seconds, converted to
bytes** — and the host hourly is a rounding error beside it.

---

## Does a CDN in front of MP3 cost us anything?

The intuition is right — an edge tier that holds **one connection per station**
to the master and fans out locally is exactly the shape to want. But a general
CDN is usually the wrong component to get it from, and where it does work it
takes real features with it.

### A CDN mostly will not collapse a continuous stream

Request collapsing works on **finite, cacheable objects**. An Icecast mount is an
endless chunked response with no content-length: most CDNs treat it as an
uncacheable pass-through and open **one origin connection per listener**, which
buys the egress bill and none of the fan-out.

Fastly, whose streaming-miss feature is the closest thing to what is wanted,
says so in its own documentation:

> If you serve an endless response to Fastly, we will hold those connections
> forever and you will exhaust the maximum number of concurrent connections we
> can make to your origin.

Its guidance is that streamed responses have a **maximum duration**, around 30
seconds as a default. A 24/7 radio mount is the case it warns against.

### What we would lose where it does work

Each of these is load-bearing today, not theoretical:

- **Per-listener authentication.** `listener_add` fires on the connection
  *Icecast* sees. Collapse N listeners into one origin connection and Icecast
  sees one listener, so the on-air gate and the geo/rights check in
  `modules/icecastAuth.ts` are applied once, to the CDN, instead of to each
  person. The rights gate stops being per-listener, which is the only thing it
  was for.
- **Listener counts, and therefore egress metering.** Same cause. We would count
  one where there are a thousand, and `/admin/stats` would agree with us.
  Counting would have to move to CDN log ingestion: delayed by minutes to hours
  instead of live.
- **Per-listener geo.** We currently see the listener IP on connect. Behind a
  collapsing cache we see the edge.
- **ICY metadata.** Now-playing titles are **interleaved into the byte stream**
  per connection, and only for clients that sent `Icy-MetaData: 1`. A cache
  keyed on URL alone serves one group the other's bytes and breaks titles for
  everybody. It must `Vary` on that header, which also halves any collapsing.
- **Dropping a listener.** `/admin/killclient` removes one listener at the
  relay. Behind a collapsed connection you cannot address an individual
  listener at all, and killing the shared connection drops everyone.

### The component that actually does what you described

**Icecast's own relaying**, which is what it was built for. From the Icecast
documentation: *"Relaying is the process by which one server mirrors one or more
streams from a remote server"*, and an on-demand relay *"will only retrieve the
stream if there are listeners requesting the stream"*.

An edge relay holds **one connection per mount to the master regardless of how
many listeners it serves** — precisely the property wanted — and, because each
edge still terminates real listener connections, `listener_add` still fires per
listener. Point the edges' auth callbacks at the control plane and **every
feature above survives**, including per-listener rights and live counts.

So: edge tier yes, CDN-for-MP3 no. Keep the CDN where it already earns its
place — HLS and DASH, which are finite cacheable segments and exactly what a CDN
is good at. If a CDN is later put in front of MP3 anyway for egress economics,
it is a deliberate trade: per-listener gating moves to signed URLs validated at
the edge, and counting moves to log ingestion. That is a different design, not a
configuration change.

## How it scales


**Vertically, first, and further than people expect.** Icecast fan-out is a
socket write per listener; the limits are network throughput and file
descriptors, not CPU. A single modest instance serves a few thousand concurrent
128k listeners before the NIC is the constraint.

**Horizontally, in one of two shapes.**

*Icecast's own relay tree.* A master that stations push to, and edge relays
configured to pull each mount from the master. This is what Icecast was built
for, it needs no new component, and each edge multiplies capacity. The cost is
that the edges are servers you run, monitor and pay for around the clock.

*A CDN in front of a small origin.* The master is the origin; the CDN caches
nothing (this is a continuous stream) but terminates listener connections at the
edge and pays egress at CDN rates. This is the shape the rest of the platform
already uses — CloudFront serving HLS and DASH out of S3 — and it is the one to
prefer, because it makes the relay's capacity somebody else's operational
problem and leaves us with one small origin tier to run.

**The sharding unit is the master, and the station picks it.** A station is a
SOURCE: it pushes to exactly one address, so a station cannot be spread across
masters. What can be spread is the set of stations. Because `mountFor()` derives
the mount from the channel id, `hash(channel_id) % masters` assigns a station to
a master deterministically, keeps it there across restarts, and needs no
coordination.

**The one thing blocking that today** is that `config.icecast` is a single
host:port from the environment, so there is no way to express "station X pushes
to master 2". Multi-master needs the relay target to become **a row rather than
an env var** — which then also gives it somewhere to be monitored and costed
from, so the two problems have one answer.

---

## What to build, in order

**1. Close the listener-session loop.** `listener_add` opens a session row;
`listener_remove` closes it. Duration × the mount's bitrate is bytes served,
attributable to a channel and an account. This single change produces the
audience number the product needs *and* the egress number the invoice needs,
from an event we already receive and currently discard.

It needs a sweeper, because `listener_remove` will not always arrive — a relay
that crashes takes its open sessions with it. That is the same shape as the
stuck-recording reconciler that already exists: a session with no close and no
corresponding live listener in the relay's stats is closed at its last-seen
mark, never at `now()`.

**2. Poll `/admin/stats` for concurrent listeners per mount.** Icecast publishes
it, it is one HTTP call per relay, and it turns the console's fabricated `0` into
a measurement. It is also the cross-check that keeps the session ledger honest.

**3. Put the relay in the fleet.** A `relay` host kind and a rate row, so it
appears in Fleet & Usage beside the encoders and its hourly stops being
invisible. Small, and it removes the implication that the relay is free.

**4. Then multi-master.** Relay targets as rows, station-to-master assignment by
hash of channel id, and `publicBase` per relay so the listener URL follows the
assignment. Not before there is something in place to tell you a relay is
saturated, which is what steps 1 and 2 provide.

Steps 1 and 2 are worth doing before any beta with real listeners, because
without them the platform cannot answer "how many people are listening" or "what
did that cost", and both questions will be asked on the first day.


---

## What is built now

Migration `0021_relay_fleet.sql` and `services/fleet/relays.ts` land the first
three items above, reusing the encoder machinery rather than building a second
one beside it.

| Question | Where it is answered |
|---|---|
| Which relay is this station pointed at? | `channels.relay_id`, assigned on first start and **sticky** thereafter |
| What is that relay? | `relays` row + `compute_hosts` (type, region, lifecycle, first/last seen) |
| How is it doing? | `host_samples` — cpu, memory, **net in and out** — with absent readings staying absent |
| How long has it been running? | `compute_hosts.first_seen_at`, surfaced as `uptimeSeconds` |
| What is it costing? | `relay_accruals` (hours × rate **plus** GB out × egress rate) |
| How does that compare to the bill? | `cost_actuals` + `GET /api/platform/costs/comparison` |

**Assignment is sticky, and that is the load-bearing property.** `mountFor()`
derives the mount from the channel id so a renamed station keeps its listener
URL; choosing a relay afresh on every start would move the *host* in that URL
instead and undo it. `draining` stops a relay taking new stations while the ones
on it keep broadcasting; only `offline` moves them.

**A deployment with no relays registered keeps using `ICECAST_HOST`.** An empty
table is a development machine, not a misconfiguration.

### Who may see it

All of it is on `/api/platform` behind `requirePlatform`, and none of it has a
tenant route:

- **System admin** (`platform_role`: `saas_admin` / `support` / `read_only`) —
  relay topology, host telemetry, rates, accruals, estimated vs actual.
  Creating a relay and entering a bill require `saas_admin`.
- **Account admin** (tenant `user_role`: `owner` / `admin`) — their account,
  their users, their stations, and **their own usage and bill**, which is
  `usage_accruals` and already account-scoped. Never the infrastructure
  underneath.

The boundary is that these things have **no route on the tenant surface at
all**, rather than a tenant route that checks a role — a check can be edited out
in a hurry, a route that does not exist cannot be reached by mistake.
`liveHosts()` (the tenant fleet view) is now explicitly filtered to
`role = 'compute'`: relays were already excluded by an inner join on `instances`,
but that was an accident of the current shape rather than a decision.

`test/relay-fleet.check.ts` pins all of it, including the boundary.

### Can the relay be serverless, and what does it really cost?

### Lambda is out by construction

A Lambda invocation is capped at **15 minutes**. A relay holds a listener
connection for hours, and holds a source connection for the life of the station.
Nothing about that fits an invocation model, and no amount of chaining works
because the socket cannot survive the boundary. The same rules out any
request/response FaaS.

What CAN host it: **ECS/Fargate or EC2 with autoscaling**, both of which the
fleet already models (`compute_hosts.kind IN ('ec2','fargate','local')`). But
choosing between them is close to irrelevant, for the reason below.

### The arithmetic, which decides everything else

One listener on a 128 kbps mount is 16 KB/s, so **57.6 MB per listener-hour**.

| | 1,000 concurrent listeners, 24/7, one month |
|---|---|
| Bytes served | 57.6 MB/h × 1000 × 730 h ≈ **42 TB** |
| Compute (one `c6in.large`, ~$0.113/h) | **~$83** |
| Egress at AWS list ($0.09/GB) | **~$3,800** |

The audio is **128 Mbit/s**, which one modest instance carries without noticing.
So **egress is ~98% of the bill and compute is a rounding error.** Optimising the
compute layer — Fargate versus EC2, spot versus on-demand, autoscaling
sophistication — is optimising the 2%.

### Which means the cost-effective decision is WHERE the bytes leave

This is the one that actually moves the number. Comparing published rates:

| | Egress |
|---|---|
| AWS | first 100 GB free, then **$0.09/GB** |
| Hetzner | first **20 TB included**, then ~**$0.0013/GB** |

That is roughly **82× per gigabyte**. The same 42 TB month is ~$3,800 on AWS
against single-digit dollars on a bandwidth-inclusive provider.

**The relay tier is the one part of this platform that should probably not run on
AWS.** It is stateless, it holds no customer data at rest, it needs no VPC
adjacency, and it is pure fan-out — which is exactly the workload hyperscaler
egress pricing punishes hardest. Stations push to it over the public internet
(one connection each, negligible), and it serves listeners from wherever
bandwidth is cheapest.

The relay model built here already supports that: a `relays` row carries its own
`source_host`, `public_base` and `region`, with no assumption that it lives
beside the control plane. `compute_hosts.kind` would need a value beyond
ec2/fargate/local, which is a one-line CHECK change when the time comes.

Numbers should be re-confirmed against current pricing before committing —
egress rates change and volume tiers matter — but an 80× gap is not a rounding
error that better instance selection closes.

### MP3 on request, not by default

**Done.** `resolveOutputs()` now defaults `mp3: false` with `hls` and `dash`
still on, in both the TypeScript and Python builders (`radio-args.check.ts` pins
the asymmetry and diffs the two). The three were defaulting together, which hid
that they are different kinds of thing: HLS and DASH are files this process
writes and cost the same whether anybody listens; MP3 is a live push whose bill
is egress, and it is the only output with an external dependency that can degrade
a station.

A station with MP3 on and no MP3 listeners still occupies a mount, holds a source
connection, and counts against the relay's capacity for stations that do have an
audience.

### Derive MP3 on demand — BUILT

*(`services/radio/mp3Gateway.ts`, migration 0022, `test/mp3-gateway.check.ts`.)*

Opt-in is per STATION. The stronger version is per LISTENER: MP3 exists only
while somebody is listening to it.

Opt-in is per STATION. This is per LISTENER: MP3 exists only while somebody is
listening to it.

The station cannot do that itself — it pushes, so it cannot know whether anyone
is on the other side. So the station stops pushing MP3 at all, and MP3 becomes a
**derived, on-demand transcode of the HLS the station is already writing**:

| | |
|---|---|
| idle station | **zero.** No process, no relay, no mount. |
| first listener | one `ffmpeg` reading `<liveDir>/audio/index.m3u8` → MP3 |
| more listeners | the **same** ffmpeg; bytes fanned out in the gateway |
| last listener out | 30s linger, then stop |

**Three topologies now coexist**, and the discriminator is not "is mp3 enabled":

- *legacy in-process* — the control plane holds the station's ffmpeg and serves
  MP3 off its stdout;
- *container + relay* — `outputs.mp3` is explicitly true, so the station pushes
  and the public URL redirects to the relay;
- *container, no relay* — the default now, and the on-demand path.

Keying on `outputs.mp3` alone read the legacy case as the relay case and
redirected to a mount nothing was pushing to. The mode decides first.

**What it buys beyond cost.** MP3 leaves the station's critical path entirely:
a station can no longer be degraded, crash-looped or held up by a relay, because
it no longer knows one exists. Per-listener auth and counting are ours by
construction — we terminate the connection — which is precisely what a CDN in
front of Icecast would have taken away. And listener SESSIONS become measurable
with **real byte counts**, which is the missing half of relay cost attribution.

**Three things it had to get right, all asserted against real sockets and a real
ffmpeg** (`test/mp3-gateway.check.ts`, 24 assertions):

- *Backpressure.* The classic fan-out bug is unbounded buffering: a listener on a
  bad connection cannot drain as fast as we write, Node buffers the difference,
  and one stuck client grows until the process dies — taking every listener on
  every station with it. Live audio is not resumable, so a listener 2 MB behind
  is dropped and their player reconnects.
- *Linger.* Tearing down on the last disconnect means a page refresh pays the
  full start latency again. Thirty seconds costs a third of a percent of a core
  and removes the class.
- *Nothing before there is audio.* Headers are not written until ffmpeg has
  produced bytes. A 200 followed by silence is indistinguishable from a station
  that has gone quiet.

The cost is about eight seconds of latency (HLS is a couple of segments behind)
and one cheap AAC→MP3 transcode per *active* station rather than per station.
Icecast listeners are already buffered 5–20 seconds behind, so it is inside the
noise for radio.

### Listener sessions — BUILT

Migration 0022. One row per listener, closed when they leave, with the
**measured** byte count: the gateway wrote those bytes, so this is the only
place in the platform where egress is a fact rather than an estimate. It carries
`ended_reason`, because `client_closed` (they stopped listening) and `too_slow`
(we dropped them) are not the same event and a platform that cannot tell them
apart cannot tell a popular station from a failing one. No IP address — a salted
truncated hash, the same posture `play_sessions` already takes.

This also fixes the console's fabricated `0`: `radio/state.ts` read a listener
count only for the legacy path, so a containerised station showed the absence of
a measurement as a measurement of zero. The gateway terminates the connections,
so its count is the truth for every station.

## Still to do

- **Lift the gateway out of the control plane.** It is an EDGE service: it
  terminates inbound connections and scales with listeners, not with streams.
  It lives in `volt-app` for now because that is where the origin and the auth
  already are, and it is written to be liftable (it touches the origin through
  `liveOrigin.ts` and nothing else of the orchestrator). Scaling listeners by
  scaling the control plane is the thing to fix when listeners are real.
- **Roll listener_sessions into relay_accruals** so measured bytes feed the
  cost comparison directly, instead of the host-sample integration standing in.
- **`/admin/stats` polling** for stations that DO push to a relay, since those
  listeners are Icecast's and not ours to count.
- **A relay sampler** to write `host_samples` rows for relay hosts; the read
  side is done and shows "no reading" honestly until something writes them.
- **The system-admin UI** for all of the above. The API is there; nothing renders
  it yet.
