# Is MP3 worth offering, if it cannot go behind a CDN?

**Decision memo. Continues `RELAY.md`, which chose a relay tier over a CDN and
explained why. This one answers the questions that follow from that choice:
how many listeners a relay actually holds, how listeners would be balanced
across several, and whether the output earns its place at all.**

**Short answer: yes, keep it, and the reason the naive analysis says otherwise is
that it silently assumes AWS egress.** On bandwidth-inclusive hosting, serving
MP3 ourselves is **cheaper per listener-hour than serving HLS through a
commercial CDN**. What MP3 actually costs is not money, it is operations: we own
the capacity planning, the failover and the load balancing that a CDN would do
for us. So it belongs in the product as a **compatibility output with a cap**,
not as the primary delivery path.

---

## 1. How many listeners can one relay hold?

Two ceilings. The network one binds first, and the configuration one will bite
you before either.

### The configuration ceiling, which is where you are right now

Measured from the shipped Debian package `icecast2 2.4.4-4build4`:

```
<clients>100</clients>
<sources>2</sources>
<queue-size>524288</queue-size>
<burst-size>65536</burst-size>
```

**Icecast ships capped at 100 concurrent clients and 2 sources.** The container
`run-on-mac.sh` starts inherits that default, so the relay on your machine tops
out at 100 listeners and two stations before anything else is reached. And
`clients` is not listeners alone: the documentation is explicit that "listeners
are considered clients, but so are accesses to any static content and also any
requests to gather stats", so a monitoring poller eats the same budget.

This is the first thing to change in any real deployment, and it is worth
knowing that the number is not a measurement of anything. It is a default.

### The network ceiling, which is the real one

At 128 kbps, one listener is **16 KB/s, 57.6 MB per hour**.

| Relay NIC | Theoretical at 128 kbps | Realistic at 80% |
|---|---|---|
| 1 Gbps | 7,800 listeners | **~6,200** |
| 2.5 Gbps | 19,500 | ~15,600 |
| 10 Gbps | 78,000 | ~62,000 |

Icecast does no encoding. It accepts one source connection and copies bytes to
every listener, so CPU is almost never the wall; the NIC is. Beyond the NIC the
next limits are file descriptors and the `clients` cap, both of which are
configuration rather than capability.

**So: about six thousand concurrent listeners per gigabit, per station or across
stations, it makes no difference to the box.**

---

## 2. How listeners would be balanced, and how they are balanced today

### Today: they are not

`pickRelay` balances **stations**, not listeners, and assignment is sticky. So
every listener of one station lands on the one relay that station was assigned
to, and **a single popular station is capped by a single box** no matter how many
relays exist. Ten relays do not help one station with twelve thousand listeners.

That is fine for the shape the tier was built for, which is many small stations
spread across a few boxes. It is not fine for one big one.

### The mechanism that does work: an Icecast relay tree

Icecast has this natively, and the documentation says what it is for: relaying is
"used primarily for large broadcasts that need to distribute listening clients
across multiple physical machines".

```
station ──push──► MASTER icecast ──┬── one connection ──► EDGE 1 ──► listeners
                                   ├── one connection ──► EDGE 2 ──► listeners
                                   └── one connection ──► EDGE 3 ──► listeners
```

A slave is configured with the master's address and mirrors its mountpoints,
polling for new ones as stations come and go. Each edge costs the master **one
connection per mount**, so the master's load is the number of edges rather than
the number of listeners, and each edge fans out locally within its own gigabit.
Listeners are then spread across the edges by DNS round robin or a layer 4 load
balancer, because the listener side is plain HTTP.

Two consequences for our schema, and they are the real work:

1. **`relays` currently conflates two roles.** One row carries `source_host` and
   `source_port` (where a station pushes) and `public_base` (where a listener
   connects). In a tree those are different machines with different capacities
   and different lifecycles. An edge tier needs to be its own thing.
2. **`max_listeners` has to start meaning something.** It is stored, editable
   through the admin API, and read by nothing. `pickRelay` ignores it. Capacity
   based assignment is impossible until it does not.

---

## 3. The money, worked through

Per listener-hour, 128 kbps MP3: **0.0576 GB**.

| Where the bytes leave from | Rate | Per listener-hour | 1,000 listeners for 3 hours |
|---|---|---|---|
| AWS egress | $0.09/GB | **$0.0052** | $15.55 |
| Commercial CDN | ~$0.015/GB | $0.00086 | $2.59 |
| Bandwidth-inclusive host | ~$0.0013/GB | **$0.000075** | $0.22 |

And the same figures as a monthly allowance, which is how these boxes are
actually sold. A 20 TB inclusive allowance is **355,000 listener-hours a month**:

- 487 listeners, continuously, all month, or
- 1,000 listeners for twelve hours a day, or
- 10,000 listeners for an hour and a bit a day.

That same 20 TB, bought as AWS egress, is **$1,843 a month**. On a box that costs
about fifty.

### The comparison that actually answers the question

Against the alternative, which is HLS with HE-AAC at 64 kbps behind a CDN:

| | Bytes per listener-hour | Who pays for delivery | Cost per listener-hour |
|---|---|---|---|
| HLS / HE-AAC 64k via CDN | 0.0288 GB | CDN, cacheable, high offload | ~$0.00043 |
| MP3 128k from our relay, AWS | 0.0576 GB | us, no offload possible | ~$0.0052 |
| MP3 128k from our relay, inclusive host | 0.0576 GB | us, no offload possible | **~$0.000075** |

Two things fall out, and the second one is the answer:

- **MP3 is twice the bytes for the same perceived quality.** HE-AAC v1 at 64 kbps
  is roughly MP3 at 128. That penalty is real and permanent and has nothing to do
  with CDNs.
- **Even so, self-served MP3 on inclusive bandwidth is about six times cheaper
  per listener-hour than CDN-delivered HLS.** The expensive combination is not
  "MP3 without a CDN". It is "MP3 on metered cloud egress", which is twelve times
  the CDN-delivered AAC listener and the version of this that looks unaffordable.

---

## 4. Why it cannot go behind a CDN, stated as mechanism

A CDN caches responses that **end**. An Icecast MP3 stream is one HTTP response
that never ends, so an edge cannot store it, cannot serve a second listener from
a stored copy, and instead holds an open connection to the origin for as long as
that listener listens. Every listener therefore still costs one origin
connection, which is exactly the cost a CDN exists to remove. The CDN adds a hop,
a bill and a connection limit, and removes nothing.

This is not a tuning problem and no configuration fixes it. It is what an endless
response means. HLS is the opposite case and CDNs love it: a finite segment file
that thousands of listeners request, cached once at the edge and served from
there, which is why the HLS path scales without us and the MP3 path does not.

---

## 5. So does MP3 earn its place?

**Yes, for reasons that are about audience rather than technology.**

The listeners that need MP3 cannot be reached any other way:

- **Hardware receivers**, kitchen internet radios and car head units, configured
  once and never again, many of which cannot do HLS at all.
- **Aggregator directories.** TuneIn, vTuner, Sonos, Alexa and the rest list a
  station by a direct stream URL. A station that cannot supply one is not listed,
  and for an established broadcaster that listing IS their audience.
- **Anything that wants to start playing in under a second** with a client that
  is nine lines of code.

Losing MP3 means telling a radio customer to abandon the audience they already
have. That is not a trade a streaming platform gets to make on their behalf.

But it should be shaped honestly:

1. **Compatibility output, not primary delivery.** Off by default, which
   `resolveOutputs` already does, and on by request. HLS and DASH remain the path
   that scales without us.
2. **Never on metered cloud egress.** This is the single decision that changes
   the answer. Relays belong on bandwidth-inclusive hosting, and they are
   stateless, so they belong wherever is cheapest.
3. **Prefer the on-demand gateway while an audience is small.** MP3 derived from
   the HLS the station is already writing, started on the first listener and
   stopped after the last, means an idle station costs nothing and there is no
   second machine to be down. Per-listener auth and byte metering survive, which
   a relay in front of a CDN would have collapsed into one anonymous connection.
4. **Move to a relay only when the audience justifies it**, and to a relay tree
   only when one station outgrows one box.
5. **Cap it.** `max_listeners` enforced in `pickRelay`, and a per-account limit,
   so a single station cannot take a shared relay down. Today nothing stops it.
6. **Price it as what it is.** An MP3 listener costs us roughly twice an AAC
   listener in bytes and cannot be offloaded. That is a fine thing to sell, and a
   bad thing to give away without counting.

---

## 6. What to do next, in order

| | Effort | Why now |
|---|---|---|
| Raise `clients` in the Icecast container config from 100 | minutes | Your demo caps at 100 listeners and nothing says so |
| Enforce `max_listeners` in `pickRelay`, or drop the column | small | A capacity number nothing reads will be believed |
| Report listener counts per relay from the Icecast admin API | small | `relayHealth` reports stations, not listeners, so the number that drives cost is the one we do not have |
| Split `relays` into source and edge roles | medium | Prerequisite for a relay tree; one row cannot be both |
| Master-slave edge tier plus an L4 balancer | medium | Only needed when one station passes about six thousand listeners |

The first three are worth doing whether or not the tier ever grows. The last two
are a response to a customer, not a roadmap item: nothing in the product needs
them until one station has an audience bigger than a gigabit.

---

## Sources

- Defaults measured from the Debian package `icecast2 2.4.4-4build4`, file `/etc/icecast2/icecast.xml`
- [Icecast configuration reference: limits](https://www.icecast.org/docs/icecast-trunk/config_file/)
- [Icecast relaying: master-slave and per-mount relays](https://www.icecast.org/docs/icecast-trunk/relaying/)
- `RELAY.md` in this repo, for the original relay versus CDN analysis and the egress economics
- `volt-app/docs/prototypes/encoders-and-relays.html`, for how assignment works today
