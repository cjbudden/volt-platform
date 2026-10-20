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
