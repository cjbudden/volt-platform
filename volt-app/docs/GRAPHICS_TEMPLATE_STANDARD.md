# Graphics template standard

What a Volt graphics template is, which industry standards it follows, and the layout the shipped
defaults use. Companion to `REQ_graphics_overlays.md` (requirements) and
`DESIGN_stream_graphics_triggers.md` (in-stream signalling).

## 1. The standards, in one table

| Concern | Standard we follow | Notes |
|---|---|---|
| How a template is driven | **CasparCG HTML template contract**: `update(data)`, `play()`, `next()`, `stop()` | The de facto contract for HTML broadcast graphics. CasparCG, SPX Graphics Controller and Loopic templates work as they are. `update` receives a JSON string. |
| Open standard packages | **EBU OGraf v1** (ograf.ebu.io): a `*.ograf.json` manifest and a Web Component | Imported as they are; Volt hosts the component and maps the four functions onto its actions (section 7). |
| How a template describes itself | **Volt manifest** (`<script type="application/json" id="volt-manifest">` or `volt.json`) | Our own, small: name, canvas, fps, bbox, typed fields, sample data. Volt also reads an SPX `SPXGCTemplateDefinition` and `data-field="…"` attributes, so imported templates need no changes. |
| Raster | 1920 × 1080, square pixels, transparent background, 25 fps (50 Hz regions) | The template is laid out at its canvas size and scaled to the picture; positions are broadcast pixels. |
| Safe areas | **SMPTE ST 2046-1** and **EBU R 95** | Action safe 93%, graphics safe 90% (section 3). The defaults keep every element inside the graphics-safe area. |
| Text legibility | WCAG 2.2 AA contrast (4.5:1) for all default colour pairs; 26 px minimum text at 1080 lines (our own floor) | Checked for every default pair (white on navy, white on crimson, ink on amber, ink on paper). |
| Fonts | SIL Open Font License fonts, bundled in each package | Templates run with no network; a web font link would be missing on air. |
| Isolation | Sandboxed iframe, CSP `sandbox allow-scripts`, `connect-src` limited to the template's own package | A template cannot reach the host page, cookies, the Volt session, other templates or the network. It can `fetch()` its own bundled files (a Lottie animation's JSON, say). |
| In-stream signalling | **HLS `EXT-X-DATERANGE`** (RFC 8216 §4.3.2.7), **DASH `EventStream`** (ISO/IEC 23009-1), **SCTE-35** for breaks | Used for Up next, programme markers and ad breaks. Second-by-second graphics values do not go in manifests (section 5). |
| Timing | **`EXT-X-PROGRAM-DATE-TIME`** wall clock | The player applies graphics state at its playhead's wall clock, so graphics stay with the picture behind live and in the DVR. |

Not used: CasparCG's AMCP control protocol (Volt's API and live control replace it), SMPTE ST 2110
key and fill (hardware playout), and vendor scene formats (Viz Engine, Singular). Those systems keep
their own graphics; Volt's are for streams Volt encodes or plays.

## 2. The template contract

```js
function update(json) { /* JSON string or object; fields not in the call keep their value */ }
function play()       { /* animate on */ }
function next()       { /* advance a multi-step graphic (the ticker's next headline) */ }
function stop()       { /* animate off */ }
```

* `update` is called before `play` and again for every change while on air. It must be cheap (budget 5 ms).
* Animation is CSS, GSAP or `requestAnimationFrame`. The burn-in renderer runs a virtual clock, so all
  three are deterministic there.
* No network, storage or cookies. Fonts and images go in the package and are referred to by relative path.
  A template may `fetch()` files from its own package and nothing else.

Manifest:

```json
{
  "name": "News L-bar (strap, ticker, clock and weather)",
  "contract": "casparcg-html",
  "canvas": [1920, 1080],
  "fps": 25,
  "bbox": [120, 850, 1690, 170],
  "fields": [
    { "id": "tag", "type": "text", "label": "Tag (a name, or BREAKING / LIVE / DEVELOPING)" },
    { "id": "tickerItems", "type": "list", "label": "Ticker headlines" }
  ],
  "sample": { "tag": "BREAKING" }
}
```

Field types: `text`, `number`, `image`, `list`, `color`, `boolean`. `bbox` is the graphic's area, used
for library thumbnails and for capturing only that area in burn-in.

Two optional keys (25 Oct 2026):

- `"snap": true` (needs a `bbox`): the setup's **Anchor** places the graphic. Its box goes to that spot of the
  frame, keeping the margin it was drawn with, at any **Size**; Move right and Move down become a nudge from
  there. Without it the anchor is only the point the graphic scales about. A snap template should not have its
  own position or size fields: the setup's Position and size panel is the one place for both, and a template
  that moves itself inside its canvas escapes its `bbox`, so burn-in would crop it.
- A field's `"replaces": ["oldId"]`: when a setup moves to this version, the binding of the older field carries
  into this one (and the move says so) instead of being dropped.

## 3. Safe areas at 1920 × 1080

| Area | Margin | x range | y range |
|---|---|---|---|
| Action safe (93%) | 3.5% | 67 to 1853 | 38 to 1042 |
| Graphics safe (90%) | 5% | 96 to 1824 | 54 to 1026 |

## 4. The news layout (shipped defaults)

The defaults follow the structure news channels use on air, the **L-bar**: a strap and a ticker along the
bottom, a channel block at the right end of them, and a locator top left. The designs are Volt's own; colours
and the channel name or logo are fields.

| Element | Template | Box (x, y, w, h) | Type |
|---|---|---|---|
| Strap: tag + headline | News L-bar | 120, 862, 1440, 84 | Tag: Volt Sans 700 36 px caps. Headline: Volt Serif 600 46 px, shrinks to 72% to fit one line. |
| Ticker | News L-bar, News ticker | 120, 954, 1440, 52 | Volt Serif 400 31 px. Flips one headline at a time (default 7 s); `next()` advances. |
| Channel block: name or logo + clock | News L-bar, Clock and weather | 1572, 862, 228, 84 | Clocks rotate through a list (default the Australian states, every 6 s). |
| Weather | News L-bar, Clock and weather | 1572, 954, 228, 52 | City code, icon, temperature; rotates with the clocks. |
| Locator: status + place | Locator | 96, 58, auto, 64 | LIVE, REPLAY, EARLIER, EXCLUSIVE, then the place. |
| Name super | Name super | 120, 842, auto | Name in Volt Serif 600 52 px, role in Volt Sans 500 30 px caps. Sits where the strap goes; take the strap off first. |
| Weather panel | Weather panel | 192, 180, 1536, auto | Up to eight cities: icon, max, min, summary. |
| Scorebug | Scorebug | 96, 58, auto, 64 | Top left, like the locator; use one or the other. |

A tag of BREAKING, LIVE, DEVELOPING, JUST IN, EXCLUSIVE, UPDATE or ALERT shows a pulsing chevron; anything else
is a name.

**List formats** (typed in the console, or fed as JSON objects):

| Field | Text form | Object form |
|---|---|---|
| Clocks | `NSW|Australia/Sydney` | `{ "label": "NSW", "tz": "Australia/Sydney" }` |
| Weather | `SYD|partly|24` | `{ "code": "SYD", "icon": "partly", "temp": 24 }` |
| Weather panel cities | `Sydney|partly|24|16|Partly cloudy` | `{ "city", "icon", "max", "min", "summary" }` |
| Ticker | one headline per line | an RSS source's `items` (each `title`) |

Weather icons: `sun`, `partly`, `cloud`, `showers`, `rain`, `storm`, `fog`, `wind`, `snow`, `clear_night`
(also `sunny`, `cloudy`, `thunderstorm`, `mostly_sunny` and similar names).

**Fonts.** Volt Serif is Source Serif 4 and Volt Sans is Barlow Semi Condensed, both under the SIL Open Font
License (`fonts/OFL.txt` in each package).

### Second set: basics with in and out sequences (25 Oct 2026)

General-purpose templates beside the news family. Each has a designed **in** sequence on `play()` and a
different **out** sequence on `stop()` (not the in played backwards), then resets itself so the next `play()`
starts clean.

| Template | Kind | Box (x, y, w, h) | In | Out | `next()` |
|---|---|---|---|---|---|
| Crawl ticker | ticker | 0, 958, 1920, 56 | Bar wipes on from the left, optional label slides out of the edge, crawl starts from the right | Crawl fades, label slides back, bar wipes off to the right | No |
| Social badge | bug | top right, 394 × 98 | Label wipes on, icon panel follows, icons pop in one after another, handle bar wipes under and the handle rises | Icons shrink last first, handle drops out, bars wipe off right | Next handle |
| Breaking banner | lower_third | 120, 846, 1680, 138 | Tag snaps open, its words rise, headline bar wipes out of the tag, subline follows; pulsing dot and sheen while on | Headline slides back into the tag, bars retract, tag folds away | No |
| Name super, accent line | lower_third | 96, 812, 1100, 172 | Plate fades, line draws down, photo pops, name and role slide out from behind the line | Role then name slide back, line draws up, photo and plate go | No |
| Up next | bug | 1168, 58, 656, 128 | Card wipes on from the right, thumbnail settles with a slow push, label, title and time arrive in turn | Text clears left, card wipes off right | Next item |
| Quote card | full_frame | centred, 1220 wide | Card rises, quote mark swings in, words land one by one (characters for Chinese, Japanese, Korean), rule draws, attribution follows | Words clear together, card lifts away, picture brightens | No |
| Title card | full_frame | 0, 380, 1920, 320 | Band opens from its centre line, kicker settles, letters rise out of a mask, rule draws, subtitle fades up | Letters leave upward, band closes to its centre | No |
| QR callout | bug | top right, 474 × 236 | Panel unrolls, the code opens from its centre with one scan line, call to action slides in | Text clears, code closes, panel rolls up | No |

**Crawl ticker.** A continuous crawl (speed in pixels per second, default 140), the basic ticker; the News
ticker above flips one headline at a time instead. New headlines join after the ones already on screen, so an
update or an RSS refresh never jumps the crawl.

**Social badge.** `platforms` is a list (or one comma-separated line) of `facebook`, `instagram`, `tiktok`,
`youtube`, `x`, `threads`, `whatsapp`, `telegram`, `bluesky`, `line`, `wechat`, `spotify` (also `fb`, `ig`, `yt`,
`twitter`). One `handle` for all of them, or `handles` as `platform|@name` lines: the badge then rotates, lighting
the matching icon. `iconStyle` `brand` draws the platform colours, `mono` one ink colour. `position` puts it in
any corner. Glyphs are Simple Icons (CC0, `ICONS.txt` in the package).

**QR callout.** The code is drawn in the template from `url` (qrcode-generator, MIT, `lib/` in the package),
error correction M, black on white with a quiet zone, so it scans from a phone at normal viewing distance.

**Motion.** Ease out (`cubic-bezier(.16,1,.3,1)`) for things arriving, ease in (`cubic-bezier(.7,0,.84,0)`) for
things leaving, a small overshoot for icons and chips; in sequences 0.6 to 1.2 s, out sequences under 0.9 s.
Everything is CSS transitions or `requestAnimationFrame`, so burn-in's virtual clock draws them frame-exact.
Three body states drive it: none (hidden), `.on`, `.out`; `.reset` snaps back to hidden with no transition.

**Chinese, Japanese and Korean text.** Volt Sans and Volt Serif are Latin fonts. Every template falls back to
Noto Sans CJK (then PingFang, Microsoft YaHei), so a label like 新闻号 draws in the player on any desktop or phone.
For burn-in the encoder image installs `fonts-noto-cjk` with `GRAPHICS_BURN=true`.

### Sport scores: racket and net sports (25 Oct 2026)

One score bug per sport, top left like the Scorebug (96, 58), sharing one engine so they look and move alike.

| Template | Scoring it shows |
|---|---|
| Tennis score | Sets as games each with the current set last (lighter cell), then points (15, 30, 40, AD, or tie-break points) |
| Badminton score | Finished games (to 21), then the points of the current game |
| Table tennis score | Finished games (to 11), then points |
| Squash score | Finished games (to 11), then points |
| Pickleball score | Finished games, points, and the doubles server number (1 or 2) beside the serve marker |
| Volleyball score | Finished sets (to 25, fifth to 15), then points |

**Fields.** `title` (event, round, court), `p1Name` and `p2Name` (a player, a pair as `Smith / Jones`, or a team), `sets` (a list
of `a-b`, or `{a,b}` objects from a feed), `points` (`a-b`), `server` (1, 2 or 0), `status` (MATCH POINT, TIE-BREAK, CHALLENGE,
FINAL: a tab under the bug, pulsing for match, set and break points), `winner` (1 or 2: ticks the winner, dims the other, counts
every set, hides points and the serve marker), optional flags or logos (`p1Image`, `p2Image`, else a colour chip), colours.

**Motion.** In: title tab rises, the card unrolls, the rows slide in one after the other, the serve marker pops, the status tab
wipes out. While on: a changed score rolls (old number up and out, new one up and in) and flashes, a new set or game column opens
out, the serve marker slides between the rows. Out: status and marker first, rows slide out, card rolls up, title drops.

#### Tennis: the rules and the callouts (26 Oct 2026)

The Tennis score works its callout out from the score, so an operator (or a feed) only keeps the sets, points and server up to date.

- **Format.** `bestOf` (3 or 5), `finalSet` (`tb7` tie-break to 7 at 6-6; `tb10` the 10-point tie-break at 6-6 used at the Grand
  Slams; `adv` an advantage set with no tie-break; `mtb` a match tie-break to 10 instead of the final set, where `points` holds the
  tie-break points), `noAd` (a deciding point at deuce). Every other set has a tie-break to 7 at 6-6.
- **Automatic callouts** (`autoCallouts`, on by default): `BREAK POINT`, `SET POINT`, `MATCH POINT` (or `CHAMPIONSHIP POINT` with
  `championship` on), with the count when there is more than one in a row (`2 BREAK POINTS`, `3 MATCH POINTS`); the highest stake
  wins (a break that wins the set is a set point); `TIE-BREAK` and `MATCH TIE-BREAK`, `DEUCE`, `DECIDING POINT` (no-ad);
  `SET · name` between sets; `GAME, SET AND MATCH` at the end. A server's ordinary game point says nothing. The winner is worked out
  from the sets when `winner` is empty.
- **Taking over, in order:** `statusCustom` (any text), then `status` (a list: time out, medical and injury time-out, toilet break,
  challenge, Hawk-Eye review, code and time violation, rain delay, heat break, match suspended, warm-up, set break, retired,
  walkover), then a feed's `matchStatus` (interrupted, delayed, retired, walkover and the like), then the automatic callout.
  `calloutPlayer` (1 or 2) adds the player's name to a manual or custom one: `MEDICAL TIME-OUT · M. Kowalski`.
- **Wiring a feed.** No open standard covers live tennis scoring (IPTC SportsML's tennis part is statistics). The template reads the
  common feed shapes as they come: `{home_score, away_score}` and `{t1, t2}` as well as `a-b` text, `home` / `away` for the server
  and winner, a points count of 50 or a named `advantage` as AD. For a Sportradar Tennis API match summary, bind by path:

  | Field | Path |
  |---|---|
  | `sets` | `sport_event_status.period_scores` |
  | `points` | `sport_event_status.game_state` |
  | `server` | `sport_event_status.game_state.serving` |
  | `bestOf` | `sport_event.sport_event_context.mode.best_of` |
  | `matchStatus` | `sport_event_status.match_status` |
  | `p1Name`, `p2Name` | `sport_event.competitors.0.name`, `sport_event.competitors.1.name` |

  Home is player 1. The final-set rule is not in that feed: set `finalSet` for the event.

Fields with a fixed list of values declare `options` (`[{value, label}]`) in the manifest; the setup and live control show them as
a dropdown. Tests: `test/tennis-callouts.check.ts` (36 situations in Chromium, and `test/fixtures/sportradar-tennis-live.json`).

## 5. Three ways a graphic reaches a viewer

| Shown in | How | Survives download, recording, partners | Can differ per viewer |
|---|---|---|---|
| Player | Player feed + sandboxed iframe in the player (REQ section 13) | No | Yes |
| Burned into output | Rendered and composited once before the encode ladder | Yes | No |
| In-stream trigger | `EXT-X-DATERANGE` / `EventStream` read by the player (Up next) | No | No |

## 6. Captions

The L-bar sits in the lower fifth of the picture, where captions are drawn. Players should lift captions
while the L-bar is on; this is not built yet.

## 7. EBU OGraf packages

OGraf is the EBU's open specification for HTML graphics (Graphics spec v1, 2025; ograf.ebu.io, github.com/ebu/ograf).
Volt imports OGraf v1 packages as they are: upload the folder as a .zip, with or without a top folder.

**How Volt reads one.** The `*.ograf.json` manifest is the entry (an `index.html` beside it is not used).

| OGraf | Volt |
|---|---|
| `name`, `id`, `version`, `author` | Template name; shown on the OGraf tag and in the checks |
| `schema.properties` | Fields, in `order` then schema order. `string` is text, `integer`/`number` is number, `boolean`, `array` is list, `gddType: color-rrggbb` is colour, `gddType: file-path/image-path` is image. `enum` becomes a dropdown, labelled from `gddOptions.labels`. `default` is the sample. Nested objects get no input and keep the graphic's own defaults. |
| `renderRequirements[].resolution`, `frameRate` | Canvas and fps. With none, the graphic is responsive and laid out at 1920 × 1080. |
| `stepCount` | Next steps through the steps. |
| `customActions` | Listed in the checks; not yet in live control. |

**How Volt drives one.** `/gfx/<version>/index.html` is a host page generated from the stored manifest (never
stored, so a downloaded package is still the OGraf package as uploaded). It imports `main`, registers the
default export as a custom element, calls `load()` with the current data and `renderType: "realtime"`, and
queues every later call behind it:

| Volt (CasparCG) | OGraf action |
|---|---|
| `update(json)` | `updateAction({ data })`, with every value set so far |
| `play()` | `playAction({ goto: 0 })` |
| `next()` | `playAction({ delta: 1 })` |
| `stop()` | `stopAction({})` |

Actions run in order, each after the last one's Promise resolves, as OGraf requires. A `ReturnPayload` with a
4xx or 5xx `statusCode`, or an exception, is reported to the console like any template error.

**Checks.** Publishing is blocked when the manifest is not JSON, `main` is missing or has no default export,
`load` or `playAction` is missing, `supportsRealTime` is false, or the render requirements need the public
internet. Missing `updateAction`, custom actions, several manifests in one package and schema properties without
an input are warnings. The shared checks (self-contained, size, storage) apply as for any template.

**Verified** against the EBU's own examples (minimal, l3rd-name, responsive-lower-third, scoreboard, headline,
weather, bar-chart): all import, publish and play, update, step and stop in Chromium inside Volt's sandbox with no
errors. Two of them are test fixtures (`test/fixtures/ograf`, MIT).

**Not yet:** custom actions in live control, non-real-time rendering (`goToTime`, `setActionsSchedule`) for the
burn-in renderer, and OGraf thumbnails as library thumbnails.

## 8. Status, previews and the style editor (not a designer)

**Status.** Every template has one status, the same in the API (`status` on each template) and the console:

| Status | Meaning |
|---|---|
| Ready | A published version passes its checks; setups can use it. A waiting draft is noted (ready to publish, or N errors). |
| In development | Nothing published yet; the draft passes and can be published. Previews carry an IN DEVELOPMENT ribbon. |
| N errors | Nothing published yet; the draft has errors that block publishing. The first one is named. |
| No files | Nothing uploaded. |

**Previews never fail silently.** Fields with no sample value get a generated one (the field label for text,
three items for a list, the first option of a dropdown), so a template without sample data still draws. The stage
then says what happened: *Loading preview*, *The preview did not load* (no answer from the template page within
10 s), a template error, or *drew nothing with this data*. The last comes from the bridge: asked once the preview is
on screen (Chrome pauses animation in off-screen frames), it counts the elements that paint (own text, a
background, a border, an image) and returns where they are; library thumbnails zoom to that area when a template
declares no `bbox`.

**Dev server.** `volt-web`'s Vite config proxies `/gfx` to the API like `/api`. Without it every preview loads
the console's own page inside the sandbox and shows nothing (the cause of the blank previews seen on 20 Oct).

**The style editor ("Customise look", "Customise a copy" for Volt templates)** changes what a template already
has, in any package, whoever made it:

* theme variables (`--brand: #0a2350`) are edited at the declaration;
* colours written as literals (#hex, rgb(), hsl()) in the template's own CSS, HTML and scripts are grouped
  (#fff and #ffffff are one) and replaced everywhere; id selectors, `url(#id)` and `href="#x"` are left alone;
* fonts: the first family of each `font-family`, `font:` shorthand or script `fontFamily` can be swapped for any
  family the package has, keeping the fallbacks and the original quoting; `@font-face` rules are not rewritten;
* font files (.woff2, .woff, .ttf, .otf, 4 MB each) are added to `fonts/` with an `@font-face` in
  `volt-fonts.css`, linked from index.html (OGraf: from the host page).

Vendor and minified scripts (`lib/`, `vendor/`, `*.min.js`, over 200 KB) are not scanned. Colours inside images,
Lottie JSON or canvas drawing are out of reach; the editor says so when it finds nothing. Every save is a new
draft, checked like any other, with a note of what changed; nothing on air changes until it is published and a
setup moves to it.

**No template designer in Volt (decision, 20 Oct 2026).** Designing broadcast graphics (layout, animation
timing, motion) is what dedicated tools do well: Loopic (exports CasparCG, SPX and OGraf), SPX, Singular, or any
HTML/CSS workflow, and OGraf makes their output portable. A designer in Volt would be a large surface to build,
test and keep up with those tools. Volt's part is everything after design: import from any of them, check,
preview, adapt to a brand (style editor, code editor), bind data and operate. Revisit if customers without a
graphics team need simple layouts; the first step then would be field-level layout presets on Volt's own
templates, not a free-form canvas.

## 9. Default sets: which Volt templates each client account gets (25 Oct 2026)

Volt's own templates (`gfx_templates.account_id` NULL) belong to a **set**. Three ship with Volt: **News** (L-bar family, both
tickers, locator, both name supers, breaking banner), **General** (social badge, up next, quote card, title card, QR callout,
corner bug, countdown) and **Sport scores** (Scorebug and the racket and net sports). SaaS staff can make more sets.

**On or off per account.** A set's default ("on for all accounts") applies to every account without a choice of its own,
including accounts created later. Any account can be switched on or off by itself; "Apply default to all" drops those choices.

| Client sees a Volt template when | Can start a setup from it or duplicate it when |
|---|---|
| its set is on for the account, or the account already has setups on it | its set is on, the set is not archived and the template is not retired |

So turning a set off, archiving it or retiring a template never breaks anything on air: setups already made stay listed, open,
edit, and can move between versions of their template. New setups and duplicates are refused with the reason.

**Setups are per account.** `gfx_setups.account_id` is required and every setup query filters by it, so a client only ever sees
its own setups, including under a Volt template that fifty other accounts also use (the template's "used by" lists only its own).

**System Admin > Graphics library** (`/api/platform/graphics`, platform session with the authenticator code; changes need
`saas_admin`, reading needs any platform role):

* Sets: create, rename, describe, on for all accounts or not, archive, apply the default to all.
* Templates: upload a .zip or .html into a set (a draft, checked like any template), publish, upload a new version, discard a
  draft, move between sets, retire and restore. Each shows how many accounts and setups use it.
* Client accounts > an account > Graphics sets: Default, On or Off for each set.

Publishing a new version moves nobody: each setup stays on its version and the client sees "update available".

**Shipped templates and boot.** `services/graphics/defaults.ts` creates the shipped sets and templates on first boot and
publishes a new version only when the files Volt ships change (compared with the last version Volt shipped, so a version an
admin published is not overwritten by a restart). Boot never changes a set's name or default, a template's set once it has
one, or whether it is retired.

Tables: `gfx_template_sets`, `gfx_account_sets` (account, set, enabled), `gfx_templates.set_id` and `retired_at`
(migration 0081). Tests: `test/graphics-sets.check.ts`.

## 10. Bugs and alpha video (25 Oct 2026)

**Bugs** are a usage type in the Image Library (`kind = 'bug'`, the **bugs** filter, a `bugs/` folder by default) and a
standard content type in the Media Library (**Bug / sponsor graphic**). Both carry the same small set of advertising
details: **advertiser**, **agency**, **campaign** and an **ad code** (Ad-ID, key number or CAD number). In the Image
Library they are `metadata.ad`, set on upload or from the item's panel (`PUT /api/files/:id/ad`), and searchable.

**schema.org** has no advertisement type. The closest fit, which `GET /api/files/:id` returns as `jsonLd` for a bug:
the creative itself (`ImageObject` or `VideoObject`, `genre: Advertising`) with `sponsor` (the advertiser, an
Organization), `producer` (the agency), `isPartOf` (the campaign, a CreativeWorkSeries) and `identifier`
(PropertyValue `Ad-ID`).

**Alpha video.** A video uploaded to the Image Library (`POST /api/files/motion?folder=&name=&kind=`, raw body, up to
500 MB and 300 s; or just drop it in the library or a picker) is converted by `services/motionGraphics.ts` to
VP9-with-alpha WebM, with a transparent first-frame PNG (the item's thumbnail) and the original kept beside it.
ProRes 4444, QuickTime Animation, PNG-in-MOV and WebM with alpha keep their transparency; a video without alpha is
accepted with a warning. A template field of type `image` bound to it receives the WebM.

**Corner bug** has ONE field for the bug, `logo`: a still, a GIF or an alpha video from the Image Library (a video
plays, anything else shows as an image; the field can be cleared). Then `loop` (off plays once and holds the last
frame), `caption`, `panel` and `opacity`. Where it sits and how big it is are the setup's **Position and size**
(it is a `snap` template): no `position` or `height` fields. Version 3 had a separate `motion` field; `logo`
replaces it, so a setup moved to the new version keeps its video, and the template still honours `motion`
from older data. Chromium, Chrome, Edge, Firefox and burn-in play WebM alpha; Safari shows the transparent first
frame.

**Burn-in and graphics that never settle.** The renderer captured frames only for 4 s after a change, so a crawl,
a looping bug or a rotating handle froze in the burned picture. Between changes it now takes a frame every 400 ms
and follows any movement frame by frame (`volt-encoder/gfx/burn_renderer.js`).

Tests: `test/motion-graphics.check.ts` (ProRes 4444 upload, alpha kept in the WebM and the PNG, byte ranges, the
binding, the template playing it in Chromium over magenta with the transparent half showing through, a still and a
cleared value in the same field, ad details, search, the bugs filter); `test/corner-bug-one-field.check.ts` (the
shipped manifest, an empty image field, a setup moving version carrying `motion` into `logo`, and the anchor placing
the box in every corner at 50 to 200 % by the burn-in maths).
