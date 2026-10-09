# Design — the presentation framework (players, skins, share pages, workflows)

How Volt puts live content in front of a viewer, and what a customer may change
about it. Covers the three live content types, the player and its skins, the
embed tag and the JS SDK, telemetry, the advertising seams, share and QC pages,
and which workflows we ship rather than let people assemble.

Written because the same question kept arriving in six pieces: skins, SDK,
tracking, ads, share pages, approvals, workflows, a template builder. They are
one system, and answering them separately produces six systems.

---

## 1. The problem, stated once

There are three renderings of "a player" in this repo today and they can
disagree with each other:

1. `volt-player/` — the real embeddable audio player. Shaka, source selection,
   key gated, batched telemetry, one skin (`card`).
2. `volt-app/src/modules/sharePage.ts` — a hand rolled `<video>` with hls.js
   from a CDN, built as an HTML string. No skin, no telemetry, its own
   "not live right now" state.
3. `volt-web/src/pages/PlayerSetup.tsx` — a third copy of the card markup, so
   the console can preview a config. Its own comment admits it is "a faithful
   copy of the card layout's markup rather than the real bundle".

Three copies is not an accident, it is what happens when the player is thought
of as an audio embed feature rather than as the platform's presentation layer.
Every one of the requirements below (video skins, ads, QC comments, approval,
usage tracking) lands on all three, and lands three times.

**The framework is: one player, one skin system, three frames.** Everything
after this section is the detail of that sentence.

---

## 2. What already exists (do not re-solve this)

| Thing | Where | State |
|---|---|---|
| Embeddable audio player, Shaka, MP3/HLS/DASH fallback | `volt-player/src/core.ts` | Built |
| Layout interface, data and commands only, no transport access | `volt-player/src/types.ts` | Built |
| Layout registry with fallback | `volt-player/src/layouts/index.ts` | Built, one layout |
| Player config per station, per account default, built in default | `player_configs`, migration 0018 | Built |
| Player telemetry, batched, beacon on pagehide, GA forwarding | `volt-player/src/report.ts`, `player_events` | Built |
| Embed snippet generator plus origin allowlist warning | `volt-web/src/pages/PlayerSetup.tsx` | Built |
| Share links: expiry, PIN, view cap, download flags, revoke, notify, geo gate | `shareLinks.ts`, `test/share-links.check.sh` (42 assertions) | Built |
| Standalone share page with watermark | `sharePage.ts` | Built |
| Review as an event log: actor, note, legal transitions, QC override mark | `asset_reviews`, `services/review.ts`, migration 0009 | Built, VOD only |
| Automated QC findings with time ranges and severity | `qc_events`, `qcRun.ts` | Built |
| Viewer session analytics beacon on a playback token | `POST /api/analytics/beacon` | Built |
| Notifications, templated, fanned out to recipient x channel | `test/notifications.check.sh` | Built |
| Audit log with diffs and per entity history | `services/audit.ts` | Built |
| Access classes: public / admin / platform / ingest | `docs/API_ACCESS_MAP.md` | Built and enforced |

Roughly two thirds of what this document describes is wiring, not invention.
That is the main reason to do it as one framework rather than as features.

**Nothing ad related exists.** No VAST, no VMAP, no SSAI, no break signalling
in the player. Section 9 is design only.

---

## 3. Four layers

Each layer is replaceable without touching the others. This is the whole
architecture.

```
  FRAME     where it lives, and what the viewer is allowed to do
            embed on a customer site | hosted page (share, QC, landing) | SDK in an app
              |
  SKIN      what it looks like: tokens + region arrangement
            authored by us or by a designer, chosen by the customer
              |
  SURFACE   what kind of thing is being rendered, and therefore which
            regions exist at all: audio | video | event
              |
  CORE      transport, source selection, playback token, errors, telemetry
            never skinnable, never reachable from a skin
```

The existing `Layout` interface is already the SKIN/CORE boundary and it is the
right one. A layout is handed data and commands and nothing else, no Shaka
instance, no media element, no fetch. Keep that property absolutely. It is what
makes a third party skin safe to accept: a bad skin renders badly instead of
breaking playback or leaking the session.

What is missing is SURFACE and FRAME, which is why the share page had to be
written separately.

---

## 4. The three content types are one player with three surfaces

Station (audio only), Channel (24x7 live), Event (a scheduled live stream) are
not three players. They are three sets of regions over the same core.

| | Station | Channel | Event |
|---|---|---|---|
| Media | audio element | video element | video element |
| Artwork | yes, primary | poster, secondary | poster plus event branding |
| Now playing | track metadata, ICY | EPG now/next | the event itself |
| Timeline | none | DVR window | DVR window, then replay |
| Off air | station offline | channel offline | **pre, live, ended, replay** |
| Continuous | yes | yes | no, it has a lifecycle |

**Event is the one that forces work.** The others are always either on or off.
An event has a before and an after, and both are viewer facing: a countdown and
a holding slate before, "this event has ended" or a replay after. The share
page has already hand rolled a fragment of this ("Preview not live right now",
with a Check again button), which is the evidence that it belongs in the core
rather than in one page.

So the core state model grows from `playing / loading / error` to include a
**presentation state**:

```
  pre        scheduled, not started. Countdown and slate.
  live       producing. Normal playback.
  ended      finished, no replay available.
  replay     finished, VOD exists, play that instead.
  offline    should be producing and is not. This is a fault, not a state.
```

A layout renders whichever of these it supports and falls back to a plain
message for the rest. The transition from `pre` to `live` must be driven by the
same source of truth as the EPG, not by a client side timer against a start
time, because the thing that actually matters is whether the stream is being
produced, not whether the clock has passed 19:00.

### 4.1 The pre-event page is the product, not a placeholder

Somebody builds the event page days ahead and links to it. So the page has to
be worth arriving at when there is nothing to play, and what it shows is a
promise: this thing, at this time. Treating `pre` as an error state wastes the
only window in which the audience is being assembled.

Four countdown treatments, chosen per player, because "before the event" is not
one situation:

| Style | Shows | For |
|---|---|---|
| `none` | title and the operator's message | a page whose own design already says when |
| `datetime` | the date and time **in the viewer's timezone** | an event weeks out, where "in 19 days" is less useful than "Sat 12 Oct" |
| `relative` | "Starts in 3 days", to one unit | a calm line in a page that is mostly text |
| `digits` | ticking DD HH MM SS, with the date beneath | the last day, and the page people sit on |

The date is rendered in the **viewer's** timezone with the zone name shown, not
the broadcaster's, because the question it answers is "when is it, for me".

### 4.1a Event archetypes, and what actually promotes each one

"Coastal Cup Final, starts in 3 days" is a fact, not a reason to come back. The
pre-event window is the only time the audience is being assembled, and
different kinds of event are sold by different things.

| Archetype | Examples | What sells it | Template |
|---|---|---|---|
| **Fixture** | football, boxing, esports, a debate | the two sides, their badges, their form | `versus` |
| **Billing** | concert, comedy, DJ set, product drop | the artwork and the headline name | `billing` |
| **Session** | keynote, panel, webinar, AGM, town hall | who is speaking, and their affiliation | `people` |
| **Field** | motorsport, athletics, racing, a tournament | the entrants, as a field rather than a pair | `field` |
| **Programme** | news bulletin, church service, council meeting | the brand and the time. It is recurring, so identity beats promotion | `plain` |
| **Occasion** | wedding, funeral, graduation, launch | one image and the names. Quiet and typographic | `billing` or `plain`, with a poster |

Five templates, six archetypes: occasions borrow the billing treatment, because
what they need is a picture and a name and nothing shouting.

**One data shape underneath all of them.** `sides` carries teams, speakers and
entrants alike, because structurally they are the same thing: an ordered list of
parties with a name, a picture and a qualifier. Only the arrangement and the
emphasis differ, and those are CSS.

```
  EventPromo {
    template     plain | versus | billing | people | field
    headline     competition, tour or series. Sits above.
    subhead      round, venue, episode. Sits below.
    posterUrl    behind the text. Every template supports one.
    posterFit    cover | contain   (a designed gig poster wants contain)
    posterFocus  object-position, so a crop does not cut the face off
    overlay      left | centre | bottom, to keep text off the busy part
    sides[]      { name, imageUrl, subtitle }
    separator    what goes between two sides ("V", "vs", "x")
  }
```

Two templates deliberately suppress the event title: `versus` already names both
sides in large type, and `billing` already names the headliner. Repeating
"Harbour vs Northbank" underneath is noise.

**For a sports event this should be projected from metadata that already
exists.** SportsML-G2 and schema.org `SportsEvent` already carry team and logo
(see the metadata design notes). Typing the two sides again into a promo form is
a second copy that will disagree with the first. Manual entry is the override,
not the source.

### 4.1c Where the promo comes from: the schema.org mapping

`EventPromo` is a **render contract**, deliberately small. schema.org is the
**interchange contract** we already planned to capture, deliberately large.
`services/eventPromo.ts` is the seam, and it exists so neither leaks into the
other: nobody types a team twice, the player never learns what `superEvent`
means, and the day a fixture arrives from a rights holder's SportsML feed
instead of a form, only that file changes.

**It is captured once, at content level, and there is no second form.** An
event already carries `schema_id` and `metadata`, entered when the event is set
up and its publishing page assigned. The comment beside that field in
`events.ts` already states the rule: *defined once, harvested to auto-VOD*. The
promo is the same rule pointed at the player instead of at the VOD. Nothing here
adds a capture surface, and if it ever seems to, that is the mistake.

The few promo-only settings (`posterFit`, `promoOverlay`, an explicit
`promoTemplate`) are optional fields on the same schema, on the same form, and
almost nobody will touch them: the template infers, the fit defaults to cover,
the overlay defaults to left.

| schema.org | Type | Becomes |
|---|---|---|
| `name` | Event | the event title |
| `startDate` / `endDate` | Event | `startsAt` / `endsAt` |
| `previousStartDate` | Event | "Originally Sat 5 Oct" on a moved event |
| `eventStatus` | Event | **the phase** (see below) |
| `superEvent.name` | Event | `headline` (competition, tour, series) |
| `location.name` | Place | `subhead`, with `round` |
| `image` | Event | `posterUrl` |
| `homeTeam` / `awayTeam` | SportsTeam | `sides[0]` / `sides[1]`, in that order |
| `competitor[]` | SportsTeam | `sides[]` (two makes a fixture, more makes a field) |
| `performer[]` | Person / PerformingGroup | `sides[]` for `billing` and `people` |
| `SportsTeam.logo`, `Person.image` | ImageObject / URL | `sides[].imageUrl` |
| `Person.jobTitle`, `affiliation.name` | Person | `sides[].subtitle` |

**The template is derived, not asked for.** The shape of the data already says
what kind of event this is: home plus away is a fixture, a field of competitors
is a race, performers are a billing, and performers **with job titles** are a
session. That last distinction separates a conference from a concert without
asking anyone anything. An explicit `promoTemplate` still wins, because there
will always be an event that is technically a `SportsEvent` and is being sold
like a gig.

**Field keys are schema.org property names.** A tenant's fixture schema declares
`homeTeam`, `awayTeam`, `superEvent`, `location`, `eventStatus`, not `team_a`
and `team_b`. The stored `metadata` JSONB is then already a schema.org bag, the
JSON-LD output is a rename rather than a per-tenant mapping table, and the
projection is mechanical. This costs nothing at capture time and is close to
impossible to retrofit, because by then every tenant has invented their own key
names.

**`eventStatus` is a phase, and it was missing.** `EventCancelled` becomes
`cancelled`, `EventPostponed` and `EventRescheduled` become `postponed`, both
new. Without them a called-off match counts down to a kick-off that will never
happen: confidently wrong, in public, to the whole audience at once. A postponed
event keeps its promo block, because the two sides are still the two sides and a
fixture page stripped back to one grey line reads as an error rather than as
news. A cancelled one does not, because there is nothing left to sell.

**The gap is in the type system, not in a table.** schema.org is a graph of
typed things: an `Event` refers to a `SportsTeam`, which is an `Organization`,
which has its own `name`, `logo` and identifier. A team is a type, not a string
property of a fixture.

Our metadata model is currently flat by comparison. `metadata_schemas.target_kind`
is one of `event`, `channel`, `vod`, `any`: all of them things we STREAM. There
is no target kind for a team, a person or a competition, which are things we
DESCRIBE. So a fixture's two sides can only be stored as values inside the
fixture, and the type disappears at the point of capture.

That is a type error rather than an inconvenience, and it shows up in four
places that matter:

- **The JSON-LD we emit asserts a type we never modelled.** `sportsEventJsonLd`
  writes `"@type": "SportsTeam"` with a `name` and a `logo`. If that came from
  two strings typed into a fixture form, the output is claiming a structure the
  system does not actually have. Interoperable output has to be backed by an
  interoperable model or it is decoration.
- **SportsML-G2 ingest, which is the plan, delivers identified entities.** Teams
  and persons arrive with their own IDs, and those identifiers are the entire
  point of taking a feed: they are what lets tomorrow's fixture list join to
  today's. With nowhere typed to put them, ingest degrades to flattening and
  throws away the identity it was fetched for.
- **Rights, blackout and availability attach to competitions and teams**, not to
  individual fixtures. "Not available in this territory when this competition is
  playing" is a rule about a typed entity. Expressed per fixture it has to be
  restated every week and will eventually be restated wrong.
- **Then, and only then, the copying.** The same badge in forty fixtures is the
  visible symptom, not the disease. Rename a club and you edit forty rows.

The validator already anticipated this: `reference` has a `refDomain` whose own
comment says `'sports-team'`. What is missing is anything that can BE a
`sports-team`. Extending `target_kind` from "things we stream" to "things we
describe" is the change; a `metadata_entities` table is its consequence, not the
decision itself.

**Not a launch blocker, and not a reason to change how anything is captured.**
The validator already accepts a reference as an object, so a team can be entered
inline as `{id, name, logo}` on the same form as everything else, once per
event, and every template above renders correctly from that today. The flat form
only starts costing anything when the same entity recurs a lot or arrives from a
feed: a broadcaster with a league and forty fixtures a season, or the first
SportsML-G2 ingest. That is when to type it, and the projection is written so
that day changes nothing else.

The projection takes a `resolve` function precisely so both work: inline
references now, a resolved entity later, same output. Verified both ways in
`test/event-promo.check.ts` (17 assertions).

### 4.1b A poster makes this the same problem as video

Text over artwork nobody has seen cannot have its contrast computed, exactly as
over a moving picture. So the phase panel has two ink modes and switches on one
condition, whether there is a poster:

- **no poster**: ink computed from `--vp-surface`, as everywhere else
- **poster**: ink fixed to the overlay ink, over a scrim the panel draws

Same rule, same tokens and same reasoning as the video stage in section 5.0,
which means one fewer thing to hold in your head rather than two systems that
happen to look alike. The rule is also what caught a real bug: the stage sets
overlay ink on its box for the chrome that sits on the picture, and a phase
panel with no poster was inheriting it, so a cream surface rendered white text
on cream.

`posterFocus` exists because `cover` crops, and the thing it crops on a portrait
poster is usually the face.

### 4.2 Three rules that are easy to get wrong

**The countdown never starts the player.** Reaching zero changes the words on
screen and nothing else. Events start late. A client that promotes itself to
live on the scheduled second shows a dead stream to everyone who arrived on
time, which is most of the audience. Past the scheduled time and still not
live, the panel says "Starting shortly", which is true, rather than holding a
countdown at zero, which reads as broken.

**Correct for the viewer's clock.** The session response carries the server's
time, and the difference is applied to every countdown. A laptop four minutes
fast would otherwise show a page claiming the event has started when it has
not, and the viewer concludes the stream is broken.

**Do not attach a manifest that does not exist yet.** An event three hours out
has nothing behind its URL. Fetching it anyway produces a real error on a page
whose only fault is being early. The source is attached when the phase becomes
live, and the poll cadence tightens near the start time so the promotion is
prompt rather than up to twenty seconds late.

### 4.2a The go-live watch, and why it must not hit the API

While an event is `pre`, the poll is not asking what is playing. It is asking
one question: has this gone on air. How often to ask depends on how close we
are, and the two ends of that are very far apart.

| Distance from start | Cadence |
|---|---|
| more than an hour | every 5 minutes |
| 15 to 60 minutes | every 2 minutes |
| 3 to 15 minutes | every minute |
| **inside 3 minutes, and any time after the scheduled start while still pre** | **every 30 seconds** |

Both the window and the watch interval are configurable
(`goLiveWindowMinutes`, `goLivePollSeconds`), because the right numbers differ
between a football match and a shareholder meeting. Thirty seconds means a
viewer can wait up to thirty seconds after the stream actually starts. That is
the deliberate trade against request volume.

**And it is only affordable because the watch hits a cached document.** Every
viewer waiting for a big event polls at the same time and asks the identical
question. At half a million viewers on a thirty second cadence that is roughly
sixteen thousand requests a second, which no control plane survives, and the
moment it fails is the moment the event starts. So the watch is a plain GET,
no credentials, no body, against a small status document
(`{ phase, startsAt?, replayUrl? }`) served from the CDN with a short TTL. One
origin request per TTL, however many people are waiting. This is the same
reasoning that keeps the public EPG off per-viewer sockets.

When `statusUrl` is absent the client falls back to the ordinary now-playing
poll, which is correct and not cheap. Treat the fallback as a development
convenience, not as the shape to launch on.

### 4.3 After the event

`ended` says so and stops. `replay` is the same panel plus a **Watch the
replay** control, and the two are distinguished by exactly one thing: whether
the event has been turned into a VOD yet. That is the auto-VOD path that
already exists, so the player needs a URL and nothing else.

The replay control is a **command on the layout context**, not a link in the
markup, so an embedder who wants to route internally or open a modal overrides
it and no skin changes.

### 4.4 What the control plane has to send

The client half of this is built. It degrades to today's behaviour when the
fields are absent, so nothing breaks before the server catches up.

```
  SessionResponse.serverTime   epoch ms at handshake, for skew correction
  SessionResponse.event        null for a station or channel; otherwise:
    id, title
    startsAt, endsAt           epoch ms, null when unannounced
    phase                      pre | live | ended | replay | offline
                               THE ONLY THING THAT MOVES THE PLAYER
    replayUrl                  null until auto-VOD has produced one
    statusUrl                  the small CDN-cached go-live document (4.2a).
                               Null falls back to the now-playing poll.
    preMessage, endedMessage   operator copy, null falls back to layout wording
```

The now-playing poll carries the same `event` block, because it is already the
heartbeat and a phase change is exactly what a heartbeat is for. `undefined`
means an older control plane and must leave the phase alone rather than reset
it to live.

`phase` comes from whether the stream is being produced, not from comparing the
clock to `startsAt`. That is the same source of truth the EPG uses, and it is
the difference between a page that is right and a page that is punctual.

### 4.4a Events are video, so there is a fourth layout

`card`, `bar` and `hero` are audio skins. A video player is not an audio player
with a picture added: the picture occupies a stage, the controls sit **on** it
rather than beside it, and the box is reserved before there is anything to put
in it. So `stage` was added rather than one of the others stretched to cover it
(migration `0019_player_stage_layout.sql`, plus the `LAYOUTS` list and the
config enum).

The core builds a `<video>` rather than an `<audio>` when the config says
`surface: video` or the layout is `stage`. Either signal alone is enough: an
event misconfigured onto the card layout should still get a video element
rather than silently playing only the audio track. The element reaches the
layout as `ctx.media`, which is a deliberate narrowing of "the layout never
touches the transport" rather than an exception to it. A skin may position and
size the picture; it still cannot reach the session, the key or the manifest,
because under Media Source Extensions the element's own `src` is a blob URL and
the signed manifest never appears on it.

Two details that are easy to miss and expensive to find later. The element
carries `playsinline`, or iOS takes the picture fullscreen the moment it plays,
which is not what an embed on somebody's article is for. And a poster holds the
frame until the first real frame paints, because a black rectangle that is
technically playing is indistinguishable from a black rectangle that is broken.

### 4.5 The box is reserved, in every phase

A video player set to 16:9 shows its countdown in a 16:9 box, its "event has
finished" in the same 16:9 box, and the video in the same 16:9 box. Nothing on
the host page moves when the stream starts.

That matters more than it sounds. The moment the stream starts is the moment
the whole audience is looking at the page, and a page that jumps then reads as
a page that broke. It is also the moment a publisher's own layout, their ad
slots and their above-the-fold measurements all shift, which is the version of
this problem that generates a complaint.

An `aspect` option (`16:9`, `4:3`, `1:1`, `21:9`, `9:16`, `auto`) becomes the
`--vp-aspect` token. `auto` is right for audio, where the player is a strip and
a reserved rectangle would just be empty space. When a ratio is set the height
floor is dropped, because a 260px minimum is taller than 16:9 on a narrow
phone and would quietly break the ratio on exactly the devices where holding it
matters most.

Verified rather than asserted: the box measures the same height across `pre`,
`live`, `ended` and `replay`, and holds 1.78 at both desktop and 380px widths.

---

---

## 5. Skins: tokens and regions, not arbitrary markup

### 5.0 Three colour contexts, not one

This is the part that changes once events are video, and the part a skinning
system usually gets wrong.

| Context | Where | How the ink is decided |
|---|---|---|
| **on surface** | panels: countdown, ended, replay, the card and hero bodies | **computed** from `--vp-surface` by sRGB luminance |
| **on brand** | text and glyphs inside a filled control | **computed** from `--vp-primary` |
| **on video** | overlay controls, title, live badge | **fixed white, over a scrim we draw** |

The first two work because the background is a colour somebody gave us. The
third has no such colour: the background is somebody else's football match and
it changes twenty five times a second. Contrast cannot be computed against it,
so it has to be constructed.

**Therefore a customer cannot set the overlay text colour.** Offering it would
be offering the setting that makes the player unreadable, and eventually
somebody picks it. What they get instead is `scrim` (`light` / `medium` /
`heavy`), the one legibility control they legitimately need: a station showing
night football wants less of it, a station showing snow wants more.

### 5.0a How the brand actually gets onto video

The brand appears where it can carry its own contrast: the play button fill,
the live badge, the volume track, and their logo. Text inside a brand fill uses
`--vp-accent-on`, computed from the fill, so a pale yellow button gets dark
glyphs without anyone choosing that.

The remaining failure is narrow and real: a very dark brand on a dark scrim
over dark footage. A navy play button on a night match is a navy circle nobody
can find.

The obvious fix is to lighten their colour until it is visible. **That was
tried and rejected.** Lifting `#0b2545` far enough to clear a luminance floor
produced `#798799`, which is not their navy, and a player that silently
repaints a brand is worse than one that is briefly hard to see. A brand colour
is the one thing a customer checks pixel by pixel.

So the fill is never touched and **the edge is guaranteed instead**: a hairline
ring of overlay ink whose alpha rises only as the brand gets dark enough to
need it. `#3f7bff` and `#ffd400` get no ring at all, `#0b2545` gets one at 78%,
`#000000` at 85%. The shape is always findable and the colour is always theirs.

The brand's complete set of controls:

```
  primaryColor     accents, control fills, badges, volume track
  secondaryColor   the surface behind panels and the countdown
  logoUrl          a bug on the stage, size-capped so it cannot cover the picture
  logoPosition     top-left | top-right
  scrim            light | medium | heavy
  letterbox        what shows beside a picture that does not fill the box.
                   Black by default: a brand-coloured letterbox reads as a bug
  aspect, radius, density, font, countdown
```

Everything a customer may set is on that list. Everything else is computed,
which is what stops a skin from producing an unusable player.

### The recommendation

**No general HTML/CSS/JS template builder.** A skin is a token set plus an
arrangement of named regions, and skins are authored, reviewed and shipped by
us or by a designer working to the same contract.

### Why not a builder

A builder that accepts arbitrary markup and script means:

- Third party JavaScript running inside a component we are liable for, on
  customer pages, next to a playback token.
- No way to ship a player fix. Any change to internal markup breaks templates
  that reached into it, so the player freezes at whatever shape it had the day
  the builder shipped.
- An unbounded QA surface. Every template is a new device matrix.
- Support load shaped like "your player is broken" for a template we did not
  write.

The people who genuinely need arbitrary markup are a small minority and they
are exactly the people who can use an SDK. Give them a headless mode (section
6) and they get more control than a builder would ever offer, at no cost to us.

### What a skin actually is

**Tokens.** A closed set of custom properties, the same names for every skin,
set once on the container:

```
  --vp-primary          brand / control colour
  --vp-surface          background of the player body      (today: --vp-secondary)
  --vp-ink              text, COMPUTED from surface luminance, never configured
  --vp-ink-dim          secondary text
  --vp-radius           corner radius
  --vp-density          compact | comfortable
  --vp-font             font stack
  --vp-accent-on        readable ink on top of --vp-primary
```

`--vp-ink` is computed and not configurable on purpose. `idealInk()` in
`card.ts` already does this: it takes the sRGB relative luminance of the
surface colour and returns near black or white. A customer who picks a pale
brand colour gets dark text without choosing it, which is the difference
between a themeable player and a player that can be made unreadable.

**Regions.** A fixed vocabulary of slots a layout may place:

```
  media          video surface or artwork
  identity       station / channel / event name and logo
  nowplaying     track, programme, or event title, plus secondary line
  transport      play / pause, and for event replay, scrub
  volume         volume and mute
  guide          now/next strip (channel and event only)
  captions       caption toggle and language
  quality        rendition selection (SDK exposed, off by default)
  status         connecting, errors, off air messages
  slots.*        companion advertising boxes (section 9)
  actions        share, open in new tab, and on a QC frame, comment and decide
```

A layout declares which regions it supports. The core never assumes a region
exists. This is what lets one player serve an audio card and a full bleed event
hero without branching in the core.

**Escape hatch, scoped.** Documented part names on every region so a customer
can write scoped CSS against a stable contract rather than against our internal
class names. Their CSS can change appearance and cannot reach the core. If they
need more than that, they need the SDK.

### One bug to fix while doing this

In `card.ts`, every rule is prefixed with the generated per instance class
except the two `.vp-status` rules, which are global. Those leak into the host
page and would restyle any element a customer happens to have with that class.
The entire file is written to avoid exactly this, so it is a slip rather than a
decision.

---

## 6. Embed tag and JS SDK: one bundle, two entry points, identical rendering

`index.ts` already has the right shape: a declarative scan for
`[data-volt-player]` and an imperative `create()`. Extend it rather than
building a second product.

**Declarative (`data-*`).** The subset that is safe to set from markup on
someone else's page. A CMS block, a marketing page, a customer with no
developer. No JavaScript to write.

**Imperative (SDK).** The same options object, plus:

- event callbacks (`onEvent`, already in `VoltPlayerOptions`)
- imperative commands (play, pause, volume, seek where the surface allows it)
- multiple instances on one page
- `render: false`, **headless mode**: the SDK does transport, source selection,
  telemetry, error handling and state, and hands state to the embedder's own
  UI. This is the answer to "what if someone wants a completely custom player".
  It costs almost nothing to offer because it is the same `LayoutContext` and
  `LayoutState` that layouts already receive.
- custom region renderers: supply a function for one region and keep the shipped
  skin for the rest. The common real request is "our own play button", not "our
  own player".

**Both get the same skins.** There is one rendering path. A locally installed
SDK does not get a lesser or a different set of layouts, because there is only
one set and it lives in the same bundle.

### The line that decides what goes where

> The embed can change **how it looks and what it plays**.
> It can never change **what it is allowed to do**.

Presentation is embed side. Policy is account side, stored in `player_configs`,
`apps` and `share_links`, and settable only with an admin credential. This maps
exactly onto the access classes already enforced in `API_ACCESS_MAP.md`, so it
is testable the same way `access-control.check.sh` is.

---

## 7. What may be set where

| Setting | Embed tag | SDK | Console / admin only |
|---|---|---|---|
| Which station / channel / event (within the app's allowed set) | yes | yes | |
| Skin, tokens, density, radius, logo | yes | yes | |
| Region on/off (artwork, volume, guide, captions) | yes | yes | |
| Autoplay, muted start, preferred delivery, default caption language | yes | yes | |
| Poster / holding image override | yes | yes | |
| Event callbacks, imperative commands, multiple instances | | yes | |
| Headless render, custom region renderers | | yes | |
| Programmatic quality selection | | yes | |
| Which origins may embed | | | yes (`apps`, origin allowlist) |
| Geo and rights, blackout, DRM | | | yes |
| Watermark on/off, download permissions | | | yes |
| Share link creation, expiry, PIN, view cap, revoke | | | yes |
| Review decisions, QC gate hardness | | | yes |
| Telemetry on/off, retention | | | yes |
| Advertising configuration and inventory | | | yes |
| Token TTL, entitlement, tenant scope | | | **never client side at all** |

The rule that generates this table: anything that could be used to get more
access than the publishable key already grants is admin only. Anything that
only changes pixels is not.

---

## 8. Telemetry: from "did it load" to "did anyone watch"

`player_events` today answers an operator's question: did the bundle load, did
the manifest resolve, is it erroring on one site and not another. It does not
answer a marketer's question, and the requirement here is explicitly the second
one, "track usage based on when a player rendered to play, track interaction".

### Add these events

```
  player.render    mounted in the DOM. Distinct from player.load.
  player.view      at least 50% visible for at least 1s (IntersectionObserver).
  play.start       first play of this session
  play.resume      any subsequent play
  interaction      volume, mute, seek, fullscreen, caption, quality, share
  break.*          reserved, section 9
```

`player.view` is the one that matters and the one that is missing. Without it
there is no denominator: you cannot say "how many people saw the player and did
not press play", which is the only question a customer asks about an embed
after the first week.

Both must be added to `EVENTS` in `volt-app/src/modules/player.ts`, which is a
`z.enum`, so an unknown event name is rejected today.

### Where each kind of number lives, and why not one table

- **Diagnostics** stay in `player_events`. That table is explicitly swept
  (migration 0018: "this is diagnostics, not a billable record"). Do not put
  anything reportable in it.
- **Watch time and concurrency** go through the **existing**
  `POST /api/analytics/beacon`, which already takes a playback token and
  already lands in the analytics reports. Building a second heartbeat inside
  the player would produce two numbers for one question, which is worse than
  having none.

That split is the single most important thing in this section. It is also the
thing most likely to be got wrong by whoever implements the impression events,
because both are "player sends a thing to the server".

---

## 9. Advertising: build the seams now, the system later

Nothing ad related is being built for launch. Four seams cost almost nothing
now and are expensive to retrofit.

### 9.1 Content time, not manifest position. This is the landmine.

Server side ad insertion means the manifest already has ads stitched into it,
so **manifest position stops equalling content position**. Anything stored
against manifest position moves the day SSAI is switched on.

So, from now: every user facing time is expressed in **content time**. EPG
now/next, clip in and out points, QC comment timestamps, chapter marks,
analytics positions. The player carries a mapping from stream time to content
time; today it is the identity function.

This is not speculative work. The encoder already reasons in these terms (PDT
from the media timeline, one shared epoch for video and subtitles, tested in
`bin/test_companion_pdt.py`). The player simply has to agree with it.

If this is got wrong, the failure is silent and total: every QC comment ever
recorded points at the wrong frame, and there is no migration that fixes it,
because the information needed to fix it was never stored.

### 9.2 Break state in the player state object

```
  break: { active, kind: 'pre'|'mid'|'post', remainingMs, skippableAfterMs } | null
```

Always `null` until there is an ad system. Layouts render it or ignore it.
Adding it now means no layout has to be rewritten later.

### 9.3 Companion slots are just regions

`slots.leaderboard`, `slots.mrec`. A layout declares which it supports. An ad
system fills them later. Until then they are empty and take no space. Companion
advertising becomes a skin capability rather than an ad feature, which is what
makes it work across every frame including the hosted page.

### 9.4 The ad client is an adapter, loaded on demand

A documented adapter interface, and never bundled by default. An ad client
(IMA, or a VAST/VMAP parser) is the single biggest chunk of weight a player can
carry and most embeds will never use it. Load it only when the config says ads
are configured.

### 9.5 Where breaks come from

The same signal that already drives DATERANGE output. SCTE-35 in, break markers
out. Client side insertion reads them in the player, server side insertion acts
on them in the packager. Both consume one signal, which is why the signal work
belongs with the encoder and not with the player.

---

## 10. Share pages: preview and review are one page with two purposes

Share links already do the hard part: expiry, PIN, view cap, download flags,
watermark, revoke, notify on open, and the same geo and rights gate as normal
playback, all tested. Review already does the other hard part: a decision as an
event, with an actor label, a note, legal transitions, and a mark when someone
approved over outstanding QC findings.

They have never been introduced to each other. That is the work.

### 10.1 One page, a purpose flag

Add a **purpose** to a share link: `preview` or `review`.

- `preview` is today's page. Watch it, maybe download, no decision.
- `review` is the same page plus a feedback rail and two buttons.

Same token machinery, same policy enforcement, same player, same skin. A
different frame. Not a second page and not a second product.

### 10.2 What a reviewer can do

Exactly two outcomes, because a review with five outcomes is a review nobody
completes:

- **Approve.** Optionally with notes, which are then advisory.
- **Request changes.** Must carry at least one note, because "changes
  requested" with no note is a round trip that teaches the editor nothing.

Those map onto `approved` and `changes_requested`, which the `review_state`
enum already has and `services/review.ts` already governs with legal
transitions.

### 10.3 What a note is

Three scopes, because feedback arrives at three granularities and forcing all
of it into one shape loses information:

| Scope | Means | Times |
|---|---|---|
| `general` | a statement about the whole thing | none |
| `point` | something happens here | one timecode |
| `range` | this stretch is the problem | in and out |

And every note carries **a category and an action, kept separate**:

```
  category   language | audio | video | legal | branding | caption | edit | other
             what is wrong
  action     cut | beep | blur | replace | recut | none
             what should be done about it
  text       free note. Always available, never the only thing.
```

In the interface those are one tap, which is what was asked for: press
**Language**, get **cut / beep / replace**. The reviewer's experience is a quick
label. The stored data is still two fields.

**Why not one combined label.** "Language, beeped" as a single value cannot
answer either of the two questions that get asked later: how many language
problems did this cut have, and how much beeping work is queued. The same
category also takes different actions depending on context: a swear word gets
cut for a daytime slot, beeped for a repeat, and left alone after the
watershed. One field forces the reviewer to encode the remedy into the problem.

**Why a controlled vocabulary at all.** The person receiving this is an editor,
and an editor needs a work list, not prose. Ten notes in free text is a
conversation to be read; ten notes with category and action is a job with a
length. It is also the only version that can ever be executed automatically: a
`beep` over a range in content time is a mechanical operation the clip pipeline
could one day perform, and a sentence never is. Doing it now costs a lookup
table. Retrofitting it means reading back everything anyone has already
written.

Notes also carry their own state (`open`, `accepted`, `rejected`, `done`),
separate from the review decision, so a re-cut can be checked off note by note.
That is what makes the second round short.

### 10.4 Times are content time. This is not negotiable.

Every `t_in` and `t_out` is content time, per section 9.1. A note stored
against manifest position points at the wrong frame the day server side ad
insertion is switched on, and nothing can repair it afterwards because the
information needed to repair it was never stored.

### 10.5 Human notes and machine findings share one lane

`qc_events` already stores automated findings as one row per finding, each with
its own time range and severity, explicitly so an operator can jump to each one
rather than being told "silence detected". Human notes use the same time model
and are drawn in the same timeline lane, distinguished by origin.

That is the whole point of the review page: the reviewer sees that the machine
found forty seconds of silence at 12:03 and puts their own note at 12:05, and
the editor gets one list rather than two systems to reconcile.

Keep them as separate tables. They have different lifecycles: a finding is
measured and immutable, a note is authored, argued with and resolved.

### 10.6 Decisions go through the existing code

Route external decisions through `decide()` in `services/review.ts`, so a
client's approval lands in `asset_reviews` beside internal ones, with the same
legal transition rules and the same QC override mark. Two decision paths for
one decision is how you end up unable to answer "who approved this".

Three gaps to close, all small:

1. `asset_reviews.actor_id` references `users(id)`, and an external reviewer has
   no user row. `actor_label` is already free text and already exists for
   "approved by someone who has since left"; extend that to "approved by
   someone who never had an account", and add a `share_link_id` so the approval
   is traceable to the link that granted it.
2. Review attaches to `vod_assets` only. QC on live content is explicitly
   wanted, so generalise to `(entity_kind, entity_id)` now while the table is
   young. Doing it later means migrating a history that people rely on.
3. `review_notes` is new: the table described in 10.3, with the same
   `(entity_kind, entity_id)` key and an optional `share_link_id`.

### 10.7 One distinction to hold on to

**Approval on a share link is stakeholder sign off. It is not permission to
publish.** Publishing stays an internal act by someone with an admin
credential. If a share link can cause publication, the share link has become a
publishing credential, and every property in section 7 is undone.

## 10A. Applying workflow controls

The share page's actions are the visible consequence of a policy. This section
is how that policy is expressed, where it lives today, and where it moves to.

### 10A.1 The settings belong to an account. There are no accounts yet.

"Review links always need a PIN", "approval needs two people", "QC is a hard
gate here" are decisions a broadcaster makes once for their whole organisation.
They are account settings. Account management does not exist yet, and this is a
single-account deployment we are testing on, so today the values come from the
deployment's own config.

The trap in that is worth naming, because it is easy to walk into. If the code
reads `config.workflow.review.qcGate` at twenty call sites, adding accounts
later means finding and rewriting twenty call sites, and the ones that get
missed keep serving the deployment default to every tenant. That is a security
bug wearing the costume of a config change.

So the shape is defined once and resolution is a **chain**, with the account
rung already in it and currently returning nothing:

```
  built-in defaults  ->  deployment  ->  account  ->  this one link
```

Later rungs win, and **only for the keys they actually set**: a link that says
nothing about PINs must not reset the account's PIN rule on its way past. That
is the one merge behaviour worth a test of its own, and it has one.

`services/workflowPolicy.ts` owns the shape, the defaults, the chain, and the
env reader. Nothing outside it reads `config.workflowPolicy` directly. Adding
SaaS accounts later fills the gap in the chain, and nothing else changes.

### 10A.2 The policy

```
  share.defaultExpiryDays / maxExpiryDays
  share.pin           never | optional | required
  share.watermark     off | optional | forced
  share.download      never | optional | always
  share.notifyOnFirstOpen

  review.identify             typed-name | verified-email
  review.approvalsRequired    1..n
  review.requireNoteOnChanges
  review.qcGate               soft | hard
  review.labels               the category and action vocabulary (10.3)
  review.notifyOnDecision
```

Each is settable from the environment
(`WORKFLOW_SHARE_DOWNLOAD`, `WORKFLOW_REVIEW_QC_GATE`, and so on). An unset
variable is not an override, and an unrecognised value is ignored rather than
crashed on, so a typo in a deployment's env degrades to the default instead of
taking the service down.

**Two directions of travel, and they are not symmetric.** Policy can withdraw
what a link granted (an account that later sets `download: never` closes off
downloads on links already out in the wild) but policy never grants what the
link withheld. A link created without hi-res rights does not acquire them
because somebody changed a setting.

### 10A.3 The page decides nothing

`shareActions(context)` is the whole authority. Given a purpose, a resolved
policy and the current state, it returns which actions exist, which are
enabled, why one is not, and whether taking it would be recorded as an
override. The page renders that list.

This matters because the share page is the surface handed to people outside the
organisation. A page that works out for itself whether Approve should be
showable is a page that can be wrong in somebody else's browser.

Three behaviours worth calling out, all tested:

- **A disabled control always says why.** "Add at least one note saying what
  needs to change" is a decision the reviewer can act on. A greyed button with
  no explanation is a support ticket.
- **An override is announced before the click, not after.** Under a soft gate
  with QC findings outstanding, Approve is enabled and carries "approving anyway
  will be recorded against your name". That sentence is what makes a soft gate
  worth having.
- **A closed review carries no stale override warning.** Warning somebody about
  a consequence of an action they cannot take is noise that teaches them to
  ignore the warnings that matter.

### 10A.4 Seeing it

`docs/share-page-policy-mock.html` is a working page, not a screenshot: it
bundles the real `shareActions()` so what it shows is what the server will
decide. Change a setting on the left and the page's actions change. Open it in
a browser.

Verified in `test/workflow-policy.check.ts` (20 assertions), covering the chain,
the partial-override rule, the env reader, the download asymmetry, both QC
gates, multi-approval and closure.

---

## 11. Workflows: ship six named ones, no engine at launch

### The recommendation

Ship opinionated, named workflows. Ship the event stream and webhooks. Do not
build a workflow builder for launch.

### Why not a builder

- A workflow engine is a product: a definition format, a runner, versioning,
  failure and retry semantics, a debugger, and a UI. It competes for the same
  months as encoding, which is the thing customers are actually buying.
- Almost nobody configures workflows in week one. They configure them in month
  six, after using the standard ones and finding the one step that annoys them.
  A builder shipped at launch is a builder nobody has an opinion about yet.
- The right precursor is not an engine, it is **a stable event stream plus
  webhooks**. If every meaningful transition emits an event and customers can
  subscribe, they automate outside our product at zero cost to us, and we get to
  watch which sequences they actually assemble. Then we standardise the top
  three, with evidence.
- The bones exist: notifications (templated, fanned out), the audit log, and
  per entity history.

So the launch answer to "custom or standard" is: standard, plus the hooks that
make custom possible without us building it.

### The six

Chosen because each is a sequence people already perform, and three of them are
mostly built already.

1. **Share for preview.** Link, expiry, PIN, watermark, no decision.
   *Built.* Needs the console modal wired up.
2. **Share for review.** As above plus timecoded comments and a recorded
   decision. Covers client sign off on a clip and stakeholder check of an event
   stream before announcement. *Section 10.*
3. **Clip and approve.** Clip, QC run, review, publish to targets.
   *Largely built.* Needs naming and a visible state.
4. **Event go live.** Draft, provision, rehearsal preview (internal review
   link), live, ended, auto VOD, review, publish. Most pieces exist; the
   workflow is the named sequence and the state a person can see.
5. **Channel launch.** Provision, test stream, QC the output, EPG populated,
   player configured, preview shared to a stakeholder, go public.
6. **Embed a player.** Configure, preview, copy snippet, verify origin, and
   then the half that is missing: confirm the first impressions actually
   arrived from the customer's domain. An embed that silently fails on their
   site is the most common support ticket a player product has.

### Do templates and workflows combine?

No, and keeping them apart is what keeps this shippable. Three separate
questions:

- a **skin** answers "what does it look like"
- a **frame** answers "where does it live and what may the viewer do"
- a **workflow** answers "what happens next and who decides"

They meet in exactly one place: the hosted page. A share or QC page is a frame,
rendering a skin, in service of a workflow step. That is an integration point,
not a merged product. Merging them produces a "template and workflow builder",
which is a platform project rather than a launch.

---

## 12. Where this lives in the admin, and selector vs builder

### 12.1 Not a separate admin tool

The temptation is a second application, launched from Volt, that owns
templates and workflows. Resist it. A second admin is a second auth surface, a
second navigation, a second permission model, a second deploy and a second
place to be logged out of, and it separates the configuration of a channel's
player from the channel.

What actually drives the request is that a skin editor needs the whole screen.
A full screen route inside the same app gives that, and costs nothing.

Three placements, all inside the existing console:

1. **On the entity** (channel, event, clip detail), as a tab: the player config
   for this thing, its embed snippet, its share links, its review state. This
   is the existing IA, a spine plus lenses plus entity detail tabs, and player
   setup is already a page of this kind.
2. **In account settings**: the theme library (saved token sets), share
   defaults (default expiry, watermark policy, whether a PIN is required), and
   which workflows are switched on. Account level because a broadcaster with a
   dozen stations has one brand, and the schema already supports it via the
   account level default config row.
3. **A full screen editor route**, launched from the entity: the skin editor
   and the internal review surface. Same app, same session, same permissions,
   same deploy. A route, not a product.

**Explicitly not the SaaS Admin.** That surface has its own credential
(`platform_role`), its own MFA, and is cross tenant. Templates and workflows
are tenant data. Putting them there would mean provider staff configuring
customer branding, which crosses a permissions boundary for no benefit and
turns every skin tweak into a support ticket.

The one surface genuinely outside the admin is the share or QC page itself. It
is a public frame on a share token, with no login, which is already how share
pages work.

### 12.2 Selector at launch

A selector: pick a skin, set tokens, toggle regions, live preview against a
real track, then take the output as an embed snippet, a hosted page URL, or a
share link. One configuration screen serving all three frames, because all
three consume the same config. `PlayerSetup.tsx` is most of this already; it
needs to stop being audio only and to stop keeping its own copy of the card
markup, previewing by mounting the real bundle instead.

### 12.3 Theme builder later

Named themes, saved once and applied across stations and channels, with an
account default. The schema already anticipates this: `player_configs` has a
`name` column and a unique index for an account level default row where
`channel_id IS NULL`. Nothing needs migrating.

### 12.4 Markup builder never

That request is served by SDK headless mode, which gives more control and
carries none of the liability.

## 13. Launch cut, in build order

1. ~~**Skin token model.**~~ **Done.** `src/tokens.ts`, applied once on the
   container by the core. `.vp-status` leak fixed, and `scopedStyle` in
   `layouts/shared.ts` now makes prefixing structural rather than remembered.
2. ~~**`bar` and `hero` layouts.**~~ **Done.** Both registered, so the
   fallback no longer fires for a config the API itself offers.
3. ~~**The `stage` layout and the video surface.**~~ **Done.** Migration 0019,
   the `LAYOUTS` entry, the config enum, `<video>` in the core, and the overlay
   colour model in 5.0.
4. ~~**Event promo templates.**~~ **Done** in the player: `versus`, `billing`,
   `people`, `field` and `plain` over one `sides` shape, with poster support and
   the two ink modes (4.1a, 4.1b).
5. ~~**The schema.org projection.**~~ **Done**: `services/eventPromo.ts` derives
   the promo and the template from metadata already captured on the event,
   serialises the same bag out as `SportsEvent` JSON-LD, and maps `eventStatus`
   onto the new `postponed` and `cancelled` phases (4.1c). **Outstanding for
   launch**: wiring the projection into the player session response, which is
   the only part that blocks anything. **Deferred**: extending `target_kind` so a
   team or a person can be typed rather than entered inline, worth doing when a
   customer brings a league or a SportsML feed, and not before.
3. ~~**Impression telemetry.**~~ **Done.** `player.render` and `player.view`
   (IntersectionObserver, half the box for a second, emitted once), plus both
   names added to the `EVENTS` enum on the control plane.
4. **Surface split.** Video surface alongside audio, so the share page can stop
   hand rolling hls.js and use the real player.
5. **Event presentation states.** Client half **done**: `pre / live / ended /
   replay / offline`, the shared phase panel every skin renders, four countdown
   styles, clock-skew correction, deferred source attach, the replay command,
   the go-live poll ladder (4.2a) and the reserved aspect box (4.5).
   **Server half outstanding**: the `event` block and `serverTime` in the
   session and now-playing responses, and the CDN-cached go-live status
   document, per sections 4.2a and 4.4.
6. **Share link `purpose`, and the review frame.** The feedback rail, quick
   labels (category plus action), notes in content time, and the two outcomes.
7. **`review_notes`**, plus **review generalised** to
   `(entity_kind, entity_id)` with an external actor and `share_link_id`.
   Human notes drawn in the same timeline lane as `qc_events` findings.
8. **Console preview mounts the real bundle**, deleting the third copy of the
   card markup.
9. **Workflow naming and visible state** for the six.
10. **Event stream and webhooks**, which is what defers the workflow builder
    honestly rather than just postponing it.

Deferred on purpose: advertising (seams only, section 9), theme builder,
workflow builder, third party skin submission.

---

## 14. Open questions

- **Is Station a channel at audio scope, or its own entity?** The app treats it
  as the former (`/radio` reuses the channel list and detail at audio only
  scope) and the player config table keys off `channel_id`. If Station ever
  becomes its own entity, `player_configs.channel_id` and the embed's
  `data-channel-id` both become wrong. Worth deciding before the SDK's public
  attribute names are set, because those are the hardest thing here to change
  later.
- **Do external reviewers need identity beyond a name typed at first open?**
  A PIN plus a typed name is weak attribution for anything contractual. Email
  verification on the link is the cheap upgrade, but it is a real decision
  about how much the approval is meant to be worth.
- **Do we let a skin be authored outside the repo before there is a review
  process for skins?** Recommendation: no, not at launch.
