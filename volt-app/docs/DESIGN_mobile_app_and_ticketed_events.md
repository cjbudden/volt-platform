# A mobile broadcaster app, and the ticketed-events market it would serve

**Assessment only. Nothing here is built and no code was changed to write it.**
Companion to `DESIGN_browser_capture_ingest.md`, which covered the browser path.

Two questions, and they have opposite answers.

**Would a mobile livestreaming app be hard to build?** Less hard than it looks,
and less valuable than it looks. The streaming part is close to solved. The part
that is hard is the part that never finishes: two platforms, two store reviews,
two OS releases a year, thermal and battery behaviour on real handsets, and a
support queue that says "it doesn't work on my Samsung". Call it six to ten weeks
for a credible v1 on top of an existing library, then a permanent tax.

**Is the musician and small-venue ticketed streaming idea worth doing?** The
market is real but it is not the market it looked like in 2021, and the thing
worth building for it is emphatically **not** the app. It is ticketing, payout
and a branded portal, which is four to eight weeks of work, is the part nobody
gives away free, and serves the corporate segment from the previous assessment
at the same time.

The short version: **the broadcaster app is free on both stores today and the
storefront is not. Spend the money on the storefront.**

---

## Part 1: how hard is a mobile broadcaster app

### Four tiers, cheapest first

**Tier 0: hand the phone a link, use somebody else's app. Effort: about a day.**

Larix Broadcaster is free on iOS and Android and does SRT properly. It also
accepts its entire configuration through a `larix://` deep link or a QR code, a
format Softvelum call **Larix Grove**: connection URL and credentials for
RTMP/RTMPS, SRT, RIST or Zixi, plus resolution, frame rate, bitrate, codec, SRT
latency and passphrase. The only mandatory parameter is the URL.

So the whole feature is: on an event's source page, render a QR code and a
button. The presenter scans it, the app opens configured against that event's SRT
endpoint with its stream key and passphrase already filled in, and they press
record. No build, no store account, no support burden, and they get adaptive
bitrate, HEVC, external mic support and reconnection logic that we did not write.

This is worth doing whatever else is decided, because it turns "mobile ingest" from
a project into an afternoon.

What it costs: their brand is on the phone, not ours. Some features sit behind
their Premium subscription. And we do not control that app's release cadence.

**Tier 1: browser WHIP. Effort: as assessed previously.**

Camera and microphone, no install at all, no screen capture on mobile ever. The
right answer for the person who will not install anything, and the wrong answer
for a two-hour gig because a backgrounded mobile browser will suspend the capture.

**Tier 2: build a branded app on an existing library. Effort: six to ten weeks
for v1, plus maintenance forever.**

One thing changed since the last time this route was cheap: **Softvelum have
sunset both the Larix Broadcaster SDK and the Larix Player SDK, and they are no
longer sold.** The obvious white-label shortcut, pay a licence and ship their
capture stack under our name, is closed. That is worth recording, because it is
the single biggest cost change in this option.

What remains is open source, and it is asymmetric:

| | iOS | Android |
|---|---|---|
| HaishinKit | Swift, mature, **RTMP and SRT** | Kotlin, **RTMP only** |

So "one library, both platforms" is not true today. Android would need libsrt
bound in separately, or a different library, or RTMP-only on Android, which
throws away the loss-recovery behaviour that makes SRT worth having on a cellular
uplink. Budget for that asymmetry rather than discovering it in week three.

**Tier 3: from scratch on AVFoundation and Camera2. Not sensible.** Reinventing
an encode-and-mux pipeline that two maintained libraries already give away.

### The protocol is not the hard part. This is:

1. **Heat and battery.** A phone encoding 1080p for ninety minutes gets hot and
   throttles. The stream does not fail, it degrades, which is worse, because
   nobody reports it and the recording is what people watch later.
2. **Interruptions.** An incoming call, a notification, a lock screen. On iOS,
   camera capture stops when the app backgrounds, full stop. "Background
   streaming" on iOS realistically means audio only, or ReplayKit screen capture,
   and each has its own entitlement and its own review conversation.
3. **Network handover.** Wifi to cellular mid-song. SRT recovers from this far
   better than RTMP, which is the whole argument for the Android SRT work above.
4. **Android fragmentation.** Camera2 behaviour, encoder quirks and colour
   handling vary by chipset. This is where the six weeks becomes ten.
5. **Store review and OS churn.** Two accounts (Apple $99 a year, Google $25
   once), two review queues, and a mandatory release every autumn whether or not
   the product changed.
6. **The support burden**, which is the real cost and does not appear in any
   estimate.

### The verdict on the app

The build is tractable. The **distribution** is not, and it is the part that gets
skipped in the estimate. Persuading a busker to install our app, when Larix,
Streamlabs, Prism and the Instagram button on their home screen all exist and all
work, is a harder problem than writing it. An app is only worth owning when the
app **is** the product. Here it is a camera, and the camera is commoditised.

**Recommendation: Tier 0 now, Tier 1 when the WHIP work lands, and revisit Tier 2
only if a paying customer specifically demands our name on the phone.** At that
point it is a bespoke deliverable somebody is funding, which is a much better
reason to build it than a roadmap.

---

## Part 2: musicians, buskers, small venues and ticketed streams

### What happened to this market, honestly

This idea had its moment and the moment closed. The 2020 and 2021 cohort of
concert streaming platforms largely no longer exists. **Mandolin, the
best-funded of them, shut down in 2023 after three years**, and the industry
coverage at the time framed it as consolidation rather than a blip.

The survivor at scale is **Veeps**, and the way it survived is the lesson: it was
bought by Live Nation, it launched a subscription rather than selling tickets one
at a time, and it has been **installing streaming hardware into 60-plus Live
Nation venues.** It did not win by having better software. It won by owning the
supply and the audience.

The failure was never technical. Every one of those platforms could stream a
concert perfectly well. They died on **demand**, and demand splits cleanly:

- If an artist already has an audience, they do not need a marketplace. They need
  rails, and they will resent a marketplace's cut.
- If an artist does not have an audience, no platform can manufacture one for a
  five pound ticket.

That is why a consumer-facing "portal for musicians" is a customer acquisition
business wearing a streaming business as a costume, and why it is a different
company from the one being built here.

### The economics, worked through, because the number settles the argument

A decent busking or small-room stream: 40 paying viewers, £5 each, ninety
minutes, 3 Mbps.

| | |
|---|---|
| Gross | £200 |
| Card fees, 40 transactions at UK domestic rates (1.5% + 20p) | about £11 |
| Delivery: 40 × 1.5 h × 1.35 GB/h | **81 GB** |
| Delivery cost at AWS ($0.09/GB) | about $7 |
| Delivery cost on a bandwidth-inclusive host | about $0.11 |
| Encoder time | pennies |

The infrastructure is not the problem. On a bandwidth-inclusive host this event
costs us small change, and the same 80-times argument from `RELAY.md` applies
unchanged.

The problem is the take. At a 10% platform fee **we earn £20 from that event.**
To make £100k a year on £20 events you need **five thousand events a year, which
is fourteen every day, forever.** That is a consumer marketplace with consumer
marketing costs, and it is the whole case against building the version where we
go and find the musicians.

### The version that does work: sell to whoever already has the audience

Do not build a marketplace. Build **ticketed events as a feature of the platform
we already have**, and sell it to organisations that already have a mailing list:

- a venue or a promoter with a subscriber base
- a festival wanting a paid stream tier
- a theatre, a comedy club, a dance studio, a music school
- a church or a membership organisation
- a label running an album launch

They bring the demand, which is the expensive part. We bring the rails. Pricing
becomes per event, per seat or a monthly portal fee, all of which are reachable by
sales rather than by advertising. Two hundred events a year at £150 plus a
per-ticket fee is a real number that one person can go and win.

### And it is the same product as the corporate case

This is the part that makes it worth doing. A ticketed gig and a corporate town
hall are the same object:

> a scheduled or instant event, a branded page, controlled viewer access, a
> recording that becomes the VoD afterwards.

The only difference is that one of them takes a card payment at the door. **One
ticketing feature serves both segments,** which changes the return on the work
substantially, and it points at the same conclusion as the browser capture
assessment: the money is in the event lifecycle, not in the camera.

---

## What exists today, and what genuinely does not

**Already built and directly reusable:** events with scheduling windows, the
encoder fleet, recording to VoD, clipping, captions, the branded player, share
links with expiry, geo and rights gating, per-viewer analytics, account and group
multi-tenancy, and the two-tier permission model so a venue can administer its own
account without touching the platform.

**Missing, and this is the actual build:**

1. **Entitlements.** A purchase grants one viewer access to one event, with a
   device or concurrency cap, and a defined behaviour when a show is cancelled or
   refunded. Share links with expiry are already most of this mechanism; the
   missing piece is binding one to a payment rather than to a person who was sent it.
2. **Payments, via Stripe Connect with destination charges.** The artist or venue
   is paid directly and **we never hold their money.** This is not fee
   optimisation, it is a regulatory posture: taking in ticket money and remitting
   it later is a different kind of company with a different kind of licence.
3. **Merchant of record, and therefore tax.** Cross-border VAT on digital goods
   is the genuinely unpleasant part. If the venue is the merchant of record they
   own their own VAT and we stay a software vendor, which is the recommended
   shape. If we are the merchant of record we acquire a VAT obligation in every
   country a viewer buys from. Decide this before writing the checkout, because
   it is not a setting, it is the legal shape of the product.
4. **A public storefront.** A per-account portal on a subdomain or custom domain:
   theme, event listing, buy flow, confirmation email, "watch now" on the night.
   We have a branded player. We do not have a shop.
5. **Tipping and pay-what-you-want.** For busking specifically this converts
   better than ticketing, because that audience will not pre-commit £5 but will
   send £3 during a song they liked. It is cheap once payments exist and it is the
   feature the busking case actually needs.

Rough shape: **ticketing v1 in four to eight weeks**, against six to ten weeks
plus a permanent maintenance tail for the app. The ticketing work compounds,
serves corporate as well, and has no free substitute. The app has a free
substitute on both stores today.

---

## Recommendation

1. **Do the Larix Grove QR code.** A day of work, and mobile ingest is done.
2. **Keep browser WHIP on the roadmap** for the no-install case, desktop first,
   as already assessed.
3. **Do not build a native app now.** Revisit only when a customer is paying for
   their name to be on it.
4. **If the musician and venue market is to be tested, test it with three real
   events before building the storefront.** Find one friendly venue, run three
   ticketed streams, take the money by any crude means available. If three events
   cannot be filled, the missing piece was never the technology, and that is a
   very cheap way to find out.
5. **Then build ticketing as a platform feature**, sold to organisations with an
   audience, priced per event or per seat, shared with the corporate segment.

## Open decisions

- Merchant of record: us or the venue. Everything else in the checkout follows
  from this answer.
- Does a ticket grant the VoD afterwards as well as the live stream? It is a
  meaningful part of the value and it is nearly free for us to give.
- Tipping in the first release, or tickets only.
- Custom domains per portal, or subdomains only for v1.

## Sources

- [Larix Grove: deliver Larix settings to multiple devices](https://softvelum.com/larix/grove/)
- [Softvelum: Larix SDK availability](https://softvelum.com/mobile/buy/)
- [Larix Broadcaster](https://softvelum.com/larix/)
- [HaishinKit.swift (RTMP and SRT, iOS)](https://github.com/HaishinKit/HaishinKit.swift)
- [HaishinKit.kt (RTMP only, Android)](https://github.com/HaishinKit/HaishinKit.kt)
- [Variety: Livestream platform Mandolin shuts down after three years](https://variety.com/2023/music/news/mandolin-shuts-down-concert-livestreaming-1235589897/)
- [Billboard: Livestream concerts' next step, consolidation](https://www.billboard.com/pro/livestreaming-next-step-business-consolidation/)
- [JamBase: Veeps begins equipping 60+ Live Nation venues](https://www.jambase.com/article/veeps-live-nation-venues-livestreams)
- [Stripe Connect pricing](https://stripe.com/gb/connect/pricing)
