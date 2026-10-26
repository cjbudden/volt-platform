# Server-side ads for FAST and VOD

**Status: FAST between-content scheduling built 26 Oct 2026 (section 3). VOD SSAI and SGAI first slice built
26 Oct 2026 (build queue 1.14k, section 9): rules, planning, stitched HLS, guided HLS Interstitials, beacons,
clicks, the ad timeline and snapback. FAST options in section 4, VOD DASH, catch-up DAR and VMAP are designed,
not built.** Companion to `volt-app/docs/DESIGN_fast_channels.md`, which covers the playout, the
stitcher, the VAST client, house fill and beacons that this builds on.

## 1. What we offer

Volt does not build an ad engine. It plans **where and how long** the breaks are, asks the customer's ad server
(any VAST 2/3/4 or VMAP server: Google Ad Manager, FreeWheel, SpringServe, Magnite, Publica, Beachfront) **what
goes in them**, and delivers the result, with the customer's own house spots when the ad server fails.

| Mode | FAST | VOD | Who sells the ads |
|---|---|---|---|
| **Off** | no breaks | no breaks | nobody (subscription, ad-free tier) |
| **Markers** | SCTE-35 in the stream, house spots in the breaks | ad cue points in the manifest and an ad timeline API | the platform or the customer's own player (Samsung TV Plus, Roku, Pluto, LG, a client-side SDK) |
| **Stitched (SSAI)** | per-viewer playlists, ads stitched in (built) | per-viewer manifest with pre, mid and post-rolls (to build) | the customer's ad server, through Volt |
| **Guided (SGAI)** | HLS Interstitials / DASH alternative content: shared cacheable manifest, the player fetches its own pod | same, and the best fit for VOD | the customer's ad server, through Volt's asset list endpoint |

One decision engine (break planning, VAST, pod fill, conditioning, house fallback, beacons, decision log) serves
all of them. Only the last step, how the pod reaches the player, differs.

## 2. Main requirements

| # | Requirement | Why | FAST | VOD |
|---|---|---|---|---|
| R1 | Vendor-neutral ad decisioning: VAST 2/3/4 tag templates with macros, wrappers, one time budget | no lock-in to one ad stack, and no ad engine to build | built | reuse |
| R2 | The break never goes empty or long: paid ads, then house spots, then slate, fitted to the break | in-house replacement ad when the ad server fails (stated requirement) | built | reuse |
| R3 | Ad request never on the manifest path; decide ahead, fall back to house fill | a slow ad server must never stall playback | built | reuse (decide on session start) |
| R4 | Creative conditioning: ads packaged once to the channel ladder, keyed by Universal Ad ID | stitching needs matching codecs, segment length, loudness | built | reuse |
| R5 | Break scheduling rules: load, placement, lengths, dayparts, caps, per-title rules | the commercial heart of a FAST channel | **built (section 3)** | rules per content type (section 5) |
| R6 | SCTE-35 signalling (splice_insert now, time_signal with segmentation descriptors next) | syndication to FAST platforms, inventory split | splice_insert built | cue points for markers mode |
| R7 | Graphics off during breaks (server-side trigger) | stated requirement | built | reuse (player hides overlays on ad periods) |
| R8 | Server-side beacons (impression, quartiles), from playlist progress | the ad server only pays for what it is told was seen | built | reuse, plus seek-aware rules |
| R9 | Seek and timeline rules: content time vs stitched time, snapback, no replay of watched ads | VOD only: viewers scrub | n/a | to build |
| R10 | Entitlement-aware ads: ad-free for subscribers, ad tier from access rules | AVOD / SVOD / hybrid tiers | per channel | per viewer (access rules) |
| R11 | Privacy and consent: GDPR TCF, US Privacy / GPP, LMT, kids (COPPA, no targeting) | legal | macros built; kids flag next | reuse |
| R12 | Reporting: fill, house share, timeouts, latency, impressions, completion | prove revenue, find faults | built | reuse, plus per-asset |
| R13 | Scale at low per-viewer cost | stated cost requirement | per-session playlists in Valkey; SGAI cheaper | SGAI preferred for long-tail VOD |
| R14 | DRM and captions across ad parts | encrypted content with clear ads; subtitles must not break | next | next |

## 3. FAST: scheduling ads between content (built)

Every option is on the channel's ad policy (`channel_ads.policy`), edited on the FAST builder's **Ads** tab, and
resolved by `services/fast/adPlan.ts`. The lineup walk (`lineup.ts`) applies them while it writes the guide, so
the guide, the playout timeline, the SCTE-35 and the stitcher all see the same breaks.

### 3.1 Placement
**Breaks go:** inside programmes and between them (default), **only between programmes** (content is never
interrupted, typical for kids, music, premium films and short-form), or only inside.

### 3.2 Length of the break after a programme
* **Fixed:** the same length every time (the original behaviour).
* **Earned:** the ad load applied to the content since the last break, rounded to a step (15 s default, to match
  spot lengths) and held between a shortest and longest. 9 min/hour after a 22 minute episode earns 195 s; after a
  2 hour film it earns the maximum. This keeps the load right when titles vary in length, which on a VOD-built
  channel they always do.

### 3.3 Accumulation over short titles
**Only after at least N minutes of content.** Short titles add up: with 15 minutes set, a channel of 5 minute clips
gets one break after every third clip, earning 8 min/hour on those 15 minutes = 120 s. 0 puts a break after every
programme. Ad-free titles neither break nor earn.

### 3.4 Dayparts
Load, mid-break length, between-break length, the hourly cap and placement can change by local time and weekday
(e.g. prime 18:00 to 22:30 at 12 min/hour, overnight at 6, Saturday morning between-only). First match wins. A
daypart that runs past midnight belongs to the day it starts on. A programme follows the daypart it **starts** in.

### 3.5 Hourly cap
**Never more than N minutes in a clock hour.** Breaks are charged to the local hour they start in; one that would
go over is shortened to whole segments or dropped, and the plan says so. Platforms and some regulators cap ad
minutes per hour, and it stops a run of short titles stacking breaks.

### 3.6 Sell grid pad as break time
When programmes are rounded up to a 15/30/60 minute grid, the pad was promos and slate. With this on, a pad of at
least 30 s becomes ad time after the programme (up to 180 s, within the hourly cap), joining the between break or
becoming one. A 22 minute episode on a 30 minute grid with a 60 s between break gets a 240 s break and 4 minutes
of promos, and still ends on the grid.

### 3.7 Per-title and per-slot rules
A title's metadata `adRule` (`none` = ad-free, `no_mid` = breaks only after it; `ads: false` also means ad-free),
overridden per slot in the run order (**Ads:** as the channel / only after, never inside / none). For kids titles,
rights holders who forbid interruption, and sponsored premieres.

### 3.8 Pod shape (stitched)
**Most ads in a break** and **longest single ad** are enforced when the pod is filled, and sent to the ad server as
`[POD_MAX_ADS]` and `[MAX_AD_DURATION]`, with `[BREAK_POSITION]` (`mid` or `between`). **Competitive separation:**
one ad per advertiser (VAST `<Advertiser>`, else the first `<Category>`) in a pod.

### Checks
`test/fast-ad-schedule.check.ts` 34/34 (placement, earned lengths, accumulation and its determinism across
windows, per-title and per-slot rules, dayparts including past midnight, the hourly cap, pad to ads, pod shape,
competitive separation). `fast-lineup.check.ts` 62/62 and `fast-ads.check.ts` 48/48 unchanged. App and console
typecheck clean. The console controls have not yet been looked at in a browser.

Known limits: the accumulator and hourly cap restart at a lineup rebase (activating a new version), so the hour of
a rebase can run up to one break over the cap. The mid-break spacing rule can place fewer breaks than the load asks
for in short titles with a large minimum gap (pre-existing; the achieved load is shown in the preview).

## 4. FAST: other options we need

In priority order. None of these change the work in section 3.

| Option | What it is | Why customers ask | Effort |
|---|---|---|---|
| **Break structure (bumpers, billboards)** | fixed elements around the sellable avail: bumper out ("back after the break"), sponsor billboard, bumper in. Parts of the break that are never replaced; the avail between them is what the stitcher or platform replaces. | broadcast look, sponsorship revenue | medium: timeline parts already exist |
| **"Up next" promo in the break** | the last house slot of a between break is the promo of the next programme in the guide | retention at the programme boundary, where viewers leave | small |
| **Inventory split for syndication** | per break or per minute, whose inventory it is: the channel's (provider) or the platform's (distributor). Signalled with SCTE-35 `time_signal` + segmentation descriptors (Provider / Distributor Placement Opportunity, types 0x34 / 0x36). | Samsung, Roku, Pluto and others contract a split of the ad minutes; the platform needs to know which breaks it may sell | medium: SCTE-35 writer extension |
| **One channel, several outputs** | the same channel delivered as a markers feed to platforms and a stitched feed to Volt's own apps at once, each with its own mode and ad server | the normal FAST business: syndicate everywhere, monetise your own apps directly | medium: mode moves from channel to output |
| **Sponsorship of a programme** | one advertiser owns every break in a programme or daypart (billboards plus the avail) | premium, guaranteed deals | small once break structure exists |
| **Break at the credits** | place the between break at the start of the end credits (from `vod_markers` credits detection) instead of after them | viewers leave in the credits | small |
| **Frequency and separation rules on house spots** | no house spot more than N times an hour; separation by product | house fill is a large share early on | small |
| **Kids / COPPA flag** | per channel or title: no targeting macros, `coppa=1` style flags, contextual only | legal | small |
| **Ad-free windows** | daypart with no ads (launch week, a sponsored marathon) | marketing | done via a daypart with load 0 and placement mid; make explicit |
| **Weekend marathon / day-of-week slot rules** | from `FAST_CHANNELS.md` next steps | programming | medium |

Frequency capping across breaks for one viewer belongs to the ad server (we pass session, IFA and IP); Volt does
not keep viewer ad history.

## 5. VOD SSAI: design

### 5.1 Ad schedule (where the breaks go)
An **ad rule set** per content type or collection (and overridable per asset), reusing the FAST policy shape:

* **Pre-roll** (0 to N ads, optionally only for content over N seconds, so a 20 s clip has none),
* **Mid-rolls** at the asset's cue points (`break_cues_ms`, editor-marked act breaks), else every N minutes on a
  segment boundary, with the same first-after / end-guard / min-gap rules,
* **Post-roll** (often off: viewers leave),
* **Per-title rule** (`adRule`) and **entitlement** (R10): a viewer whose access rule grants ad-free gets none.

Two sources of the schedule, chosen per ad server:
1. **Volt rules + VAST per break** (default, same as FAST), or
2. **VMAP from the ad server** (the ad server decides the breaks, common with GAM and FreeWheel). Volt maps
   VMAP time offsets onto the nearest segment boundary.

### 5.2 Live to VOD (catch-up) dynamic ad replacement
A recording or auto-VOD of a live channel already knows its breaks (`stream_breaks`, and later source SCTE-35).
The catch-up asset gets those break windows as **replaceable** cue points: the broadcast ads are cut out (non-
destructive manifest subrange, like re-trim) and the VOD ad schedule fills them. This is the most valuable VOD case
for broadcasters and needs no editor work.

### 5.3 Delivery: two ways
| | Stitched VOD manifest (SSAI) | Guided (SGAI): HLS Interstitials, DASH alternative content |
|---|---|---|
| Manifest | per viewer session, ads as discontinuity / Periods | shared and cacheable; breaks are `EXT-X-DATERANGE CLASS="com.apple.hls.interstitial"` pointing at an asset list URL |
| Ad decision | on session start (whole schedule, in the time budget), late breaks decided in the background | when the player reaches the break (asset list request) |
| Players | all HLS and DASH players | Safari / tvOS / AVPlayer, recent Shaka, hls.js; patchy on older smart TVs |
| Seek rules | must be emulated (section 5.4) | native: the player knows ads from content |
| Cost | one manifest per viewer (VOD manifests are bigger than live playlists) | one manifest per asset at the CDN, one asset list call per break |
| Ad blocking resilience | high (ads are content segments) | lower |

**Recommendation:** build the decision and timeline once, deliver **SGAI by default where the player supports it**
(our own SDK, Apple platforms), and **stitched** for everything else and for platforms that require it. The
player SDK chooses by capability; the API takes `adDelivery=auto|stitched|guided`.

### 5.4 Seeking and timelines (stitched)
* Two clocks: **content time** (what bookmarks, resume, chapters, captions, analytics and clipping use) and
  **stitched time** (what the player sees). Volt exposes the mapping as an **ad timeline** in the play response
  and as a sidecar (`/vod/<id>/s/<session>/timeline.json`): each break's stitched start, length and ads. Our SDK
  draws ad markers on the scrubber and reports content time.
* **Snapback:** a viewer who seeks past one or more unwatched mid-rolls plays the last one skipped, then lands where
  they asked. In stitched delivery the SDK does this from the timeline; without our SDK it is not enforceable.
* **No replay:** a break already watched is not played again on a seek back (SDK skips it; SGAI does it natively).
* **Resume** returns to content time; the pre-roll is optional on resume (rule setting).
* Beacons (R8) follow playback, not the manifest: a skipped ad sends nothing.

### 5.5 Other VOD rules
Downloads / offline: no ads, or ads baked at download time (decide per customer). Clips and share links: rule set
"short-form" (pre-roll only above N seconds). DRM: clear ads in encrypted content (key change at the
discontinuity). Captions: empty WebVTT for ad parts so subtitle tracks stay continuous.

## 6. What VOD reuses from FAST

| Piece | FAST code | VOD use |
|---|---|---|
| Break rules | `adPlan.ts` | pre/mid/post planning on one asset (a new `planVodBreaks`, same policy shape) |
| VAST client, macros, wrappers | `vast.ts` | as is; VMAP parser added |
| Pod fill and house fallback | `pod.ts` | as is |
| Creative conditioning | `adCondition.ts` | as is (VOD ladder = channel ladder) |
| Session store and decision lock | `sessionStore.ts` | per VOD session |
| Stitcher | `stitch.ts` (live sliding window) | a simpler static stitch for a complete VOD playlist; DASH multi-Period writer new |
| Beacons | `beacons.ts`, `beaconSender.ts` | driven by player progress (SDK) or playlist position |
| Reports | `ad_decisions`, ad report | per asset and per content type |

## 7. Build plan

1. **Done:** FAST between-content scheduling (section 3).
2. **FAST options:** break structure (bumpers, billboards), up-next promo, SCTE-35 time_signal with provider /
   distributor placement opportunities, per-output ad mode.
3. **VOD SSAI MVP:** ad rule sets on content types, pre/mid/post planning, stitched HLS per session, ad timeline
   API, SDK snapback and ad markers, beacons, entitlement ad-free.
4. **VOD SGAI:** HLS Interstitials with an asset list endpoint, SDK capability switch, DASH multi-Period stitch.
5. **Catch-up DAR:** replace broadcast breaks in live-to-VOD assets.
6. **VMAP** from the ad server.

## 8. Decisions needed

Decided 26 Oct 2026 (Christian): VOD delivery is **guided first** where the player supports it, stitched
otherwise; **snapback on** by default; **no ads offline** (downloads play without ads). Still open:

1. **Inventory split:** do we expect to syndicate to FAST platforms with a provider/distributor split from day one?
   If yes, item 2's SCTE-35 work moves ahead of bumpers.
2. **VOD default delivery:** SGAI first with stitched fallback (recommended), or stitched only to start?
3. **Snapback** as a default on, or a rule setting off by default?
4. **Downloads:** no ads, or ads baked in at download?
5. **Earned between breaks as the default** for new FAST channels (recommended for VOD-built channels), or keep
   fixed as the default?

## 9. VOD: what is built (26 Oct 2026, build queue 1.14k)

| Piece | Where | Notes |
|---|---|---|
| Ad rules: account default, one per content type | `vod_ad_rules` (0086), `modules/vodAds.ts`, console **Admin > On-demand ads** | pre, mid (cue points or every N minutes, first-after, end guard, min gap, max), post; ad server; house spots; ad-free for paid (default) or members; snapback; delivery auto, stitched, guided. A title opts out with `adRule: none`, or keeps pre and post only with `no_mid` |
| Break planning | `services/vodAds/plan.ts` | mid-rolls on the nearest segment start, so stitched and guided put ads in the same places |
| Decisions | `services/vodAds/index.ts` `decideVodBreak` | FAST's engine as is: VAST with wrappers and one budget, pod fill, house spots, conditioning cache, `ad.condition`; no slate (nothing waits on a clock) |
| Stitched HLS | `/vod-ads/s/<session>/...` | all breaks decided in parallel at the play gate; the playlist waits at most the budget; DISCONTINUITY each side of a pod and between its items; subtitles kept in step with blank WebVTT; I-frame playlists dropped; DASH not offered while ads apply |
| Guided HLS (Interstitials) | `/vod-ads/g/<asset>/<version>/...` | shared and CDN-cacheable per asset and rule version; asset list decided per playback (`_HLS_primary_id`); each ad is its own small stream through the session |
| Server-side beacons | `segmentRedirect` | ad segments go through `/vod-ads/s/<session>/seg/...` (302 to the CDN): impression and start on the first, a quartile when a later segment starts after it, complete on the last; works for any player, ours or not |
| Player events and clicks | `POST .../events`, `GET .../click/<b>/<p>` | pause, mute and the rest sent on the viewer's behalf; a click is recorded, its ClickTracking (wrappers included) sent with X-Device-IP and X-Device-User-Agent, then 302 to the ClickThrough. FAST got the same: `/fast/<id>/s/<sid>/ads.json` and `.../click/<break>/<pod>` |
| Play gate | `modules/apps.ts` | `adDelivery` and `caps` in, `ads {delivery, sessionId, timelineUrl}` out; a viewer let in by an entitlement is ad-free |
| SDK | `volt-player/src/sdk/ads.ts` | the ad on screen ("Ad 1 of 2 · 0:12", Learn more), snapback, no seeking inside an ad, watched breaks jumped over, content time, `state.ad`, `commands.adClick()`; asks for guided only when it plays HLS natively on Apple |
| Report | `GET /api/vod/ads/report` | plays with ads, fill, house share, timeouts, impressions, completion, clicks and click rate |

**Not yet (queued as 1.14k-2 to 1.14k-5):** guided playback in the SDK's own engine (Shaka interstitials) and
DASH (multi-Period stitch); catch-up dynamic ad replacement (section 5.2); VMAP from the ad server; ad markers
on the built-in skins' scrubber and the overlay's words in the player's string table; repeat player events
(each event is sent once per ad); a real ad server and real devices (Safari, Apple TV) are Christian's to try.

