# Requirements: live graphics overlays

**Status: specified, not built. Live burn-in proven feasible 20 Oct 2026** (see `SPIKE_live_graphics_burnin.md`: +1.9 to 3.7 % encode cost, 300 ms state-to-output, channel unaffected by graphics failures; prototype in `spikes/gfx-spike/`). This reverses section 11's "live burn-in deferred": it is now the cheap path, not the risky one. Companion to `DESIGN_html_graphics_overlays.md`,
which carries the cost analysis and the measured numbers. This document is the
requirement set and the workflows, at the level someone could build from.

---

## 1. Scope

**In scope: the live video workflows and the assets derived from them.**
Channels, events, recordings, clips, VoD assets and social cut-downs.

**Out of scope: radio.** Stations have no video path, so there is nothing to
composite onto. The station player has its own visualiser and its own now-playing
surface, and neither is affected by anything here.

There is one point of contact worth stating so it is not designed by accident:
radio already carries live track metadata from ICY into the EPG. **The state
document defined in section 4 must not be built as a radio metadata feature and
must not depend on one.** If a future station ever wants an on-screen now-playing
graphic for a video simulcast, it binds to the same state document as any other
source. The overlap is a consumer of the same shape, not a shared implementation.

---

## 2. Actors

| Actor | Does what | Existing role that covers it |
|---|---|---|
| **Template author** | Creates and versions graphics templates for an account | account admin |
| **Channel operator** | Binds a template to a channel, sets its default state | operator |
| **Live operator** | Drives the graphic during a broadcast: scores, names, show and hide | operator |
| **Publisher** | Chooses an intro and outro when publishing a VoD or a social cut-down | operator |
| **System admin** | Manages the shared template library and the render fleet | `platform_role` |
| **Viewer** | Sees the graphic, and in the addressable case a graphic chosen for them | none, public |

No new role is required. The feature fits the existing tenant `user_role` and
`platform_role` split without adding a tier.

---

## 3. The object model

Four objects, deliberately separate, because conflating any two of them is what
makes graphics systems rigid.

**Template.** An HTML artifact plus a declared data schema and a fixed canvas
size. Versioned. Owned by an account, or by the platform when it is a shipped
default. Renders identically in all three renderers (section 6).

**Binding.** A template attached to a channel or an event, with a position, a
z-order and a default state. One channel may carry several bindings, for example
a scorebug and a sponsor bug at once.

**State document.** A small JSON document per binding, holding the live values:
the score, the clock, the presenter's name, whether the graphic is on air. This
is the live surface, and it is the part with the product value.

**Render target.** Where a binding is drawn: the player, the console preview, a
burned live output, or an offline asset render. A binding can have several
targets at once and they must agree.

---

## 4. Workflows

### W1: author and publish a template

1. Author opens the template library and creates a template, or duplicates one of
   the shipped defaults.
2. Author edits the HTML, CSS and the declared field list. Canvas size and safe
   area are set here and are fixed for the life of the template version.
3. The console renders a live preview against sample data supplied with the
   template.
4. Author publishes. Publishing creates an immutable version. **Bindings pin a
   version**, so publishing never changes what is on air right now.
5. Existing bindings show that a newer version is available and are upgraded
   explicitly.

**Rule: a template on air is never mutated.** A broadcast that changes appearance
mid-programme because somebody saved an edit is a fault, not a feature.

### W2: bind a template to a channel or an event

1. Operator opens a channel or event, Graphics tab.
2. Picks a template, a corner or a free position, an offset and a z-order.
3. Sets the default state, the values the graphic holds when nothing is driving it.
4. Chooses the render targets: player overlay, burned into the live output, or both.
5. Saves. The binding is inert until it is put on air.

### W3: operate a graphic during a live broadcast

The core loop, and the one that has to feel instant.

1. Operator opens the Graphics panel for a live channel or event.
2. The panel shows each binding, its current state and whether it is on air.
3. Operator edits fields, for example increments the home score, and the change
   propagates to every render target.
4. Operator toggles on air and off air. The transition animation, if the template
   declares one, plays on both.
5. Every change is recorded with a timestamp and the user who made it.

**The API path must be equivalent to the panel.** A customer with a sports data
feed drives the same state document by API, and an operator with the panel open
sees it change under them. There is no separate API mode.

### W4: intro and outro on a VoD asset

1. Publisher opens a recording or a VoD asset and chooses Publish.
2. Picks an intro template, an outro template, or both, and fills their fields,
   for example a title and a date.
3. The system reads the target asset's exact encoder parameters and renders the
   cards to match them.
4. The cards and the body are joined by stream copy. No re-encode of the body.
5. **The joined asset is verified before it is published**: the packet count must
   equal the sum of the parts, and the duration must be within tolerance of the
   sum. A mismatch fails the job. See FR-14 and the note in the design document
   about how badly and how quietly this fails when it is not checked.

### W5: a persistent sponsor graphic burned into the output

1. Operator binds a sponsor template with the burned target selected.
2. The graphic is composited into the live encode, so it survives recording,
   clipping, download and redistribution.
3. For an existing asset, the same choice at publish time re-encodes the whole
   asset and is priced accordingly.

### W6: graphics on a social cut-down

1. Publisher creates a social cut-down, which reformats and therefore re-encodes.
2. Graphics selected here are burned into that render at no extra transcode cost,
   because the transcode was already happening.

---

## 5. Functional requirements

**Templates**

- **FR-1** A template declares a canvas size, a safe area, and a typed field list.
- **FR-2** A template version is immutable once published.
- **FR-3** Templates are scoped to an account, or shipped by the platform and
  visible to all accounts as read-only until duplicated.
- **FR-4** The console previews a template against sample data without a binding.

**Bindings**

- **FR-5** A channel or event carries zero or more bindings, each with a position,
  z-order, pinned template version and default state.
- **FR-6** A binding declares its render targets independently: player, burned, or both.
- **FR-7** Bindings survive a channel restart and re-apply on resume.

**Live state**

- **FR-8** State changes reach the player within two seconds of being made.
- **FR-9** The panel and the API write to the same state document, and a change
  from either is visible in the other without a reload.
- **FR-10** Every state change records actor, timestamp and previous value.
- **FR-11** A graphic that is off air is not rendered at all, not rendered
  transparent.

**Rendering**

- **FR-12** A template renders identically in the player, the console preview and
  the offline renderer. Any template that cannot is rejected at publish.
- **FR-13** Animation is driven by frame number, not wall clock, so an offline
  render can request an arbitrary frame and get what the player showed.
- **FR-14** An offline render inherits the target asset's codec, profile, level,
  pixel format, resolution, frame rate, GOP structure and audio parameters, and
  the joined output is verified by packet count and duration before publication.
- **FR-15** Burned-in graphics are composited once, before the ladder splits, so
  the cost does not multiply by the number of renditions.

**Addressable overlays**

- **FR-16** A player-side binding may vary its state by viewer attributes,
  currently geography and account.
- **FR-17** Player-side graphic impressions are reported through the existing
  player events channel.

**Permissions**

- **FR-18** Template authoring, binding and live operation are separately
  permissioned within the existing role model.
- **FR-19** Platform templates can only be edited by `platform_role`.

---

## 6. The three renderers

Non-negotiable, and the reason for FR-12 and FR-13.

| Renderer | Where | Cost | Notes |
|---|---|---|---|
| **Player** | DOM over the video, `volt-player` `stage.ts` z-stack | free | Addressable. Blockable. Does not survive download. |
| **Console preview** | The same DOM, in the operator panel | free | Must be the same code path as the player or it stops being a preview. |
| **Offline and live burn** | Headless browser to frames, composited by ffmpeg | see design doc | Survives everything. Not addressable. |

---

## 7. Data model sketch

```
overlay_templates      id, account_id NULL for platform, name, kind,
                       canvas_w, canvas_h, safe_area, fields JSONB,
                       created_by, created_at
overlay_versions       id, template_id, version, html, css, sample_state JSONB,
                       published_at, published_by            -- immutable
overlay_bindings       id, account_id, channel_id NULL, event_id NULL,
                       version_id, position, offset_x, offset_y, z,
                       targets TEXT[], default_state JSONB, enabled
overlay_state          binding_id PK, state JSONB, on_air BOOL, updated_at, updated_by
overlay_state_log      binding_id, at, actor, field, old_value, new_value
```

Assets live in the existing library. Templates are a new `media_files.kind`;
rendered output belongs under the existing `derived/<account>/…` prefix.

---

## 8. API surface sketch

```
GET    /api/overlay/templates
POST   /api/overlay/templates
POST   /api/overlay/templates/:id/versions        -> publish, immutable
GET    /api/overlay/bindings?channel_id=|event_id=
POST   /api/overlay/bindings
PATCH  /api/overlay/bindings/:id
GET    /api/overlay/bindings/:id/state
PATCH  /api/overlay/bindings/:id/state            -> the live driving call
POST   /api/overlay/bindings/:id/on-air           -> { on: true|false }
GET    /api/overlay/bindings/:id/events           -> stream of state changes
POST   /api/vod/:id/publish                       -> gains intro/outro fields
```

`PATCH …/state` is the hot path. It must be small, idempotent per field, and
cheap enough to call once a second from a sports data feed.

---

## 9. Non-functional requirements

Derived from the measurements in the design document, so they are budgets rather
than aspirations.

- **NFR-1** A template's DOM update costs under 5 ms per frame. Measured baseline
  for a scorebug: 0.9 ms.
- **NFR-2** The live renderer captures only the graphic's bounding box, never the
  full frame.
- **NFR-3** The live renderer captures on state change, not per frame. Frames
  between changes repeat the previous buffer.
- **NFR-4** Burned-in graphics add no more than 15 percent to a channel's encode
  cost, measured before the feature is offered commercially.
- **NFR-5** Attaching an intro and outro to a VoD asset by stream copy completes
  in under 5 seconds for a one-hour asset. Measured baseline for a 13 second
  join: 0.109 seconds.
- **NFR-6** A failed render never publishes a partial or malformed asset.

---

## 10. Acceptance criteria

1. An operator can put a scorebug on a live channel, change the score, and see it
   change in the player within two seconds.
2. The same change made through the API is visible in the operator panel without
   a reload, and the reverse.
3. A published VoD asset carries a branded intro and outro, joined without
   re-encoding, and the verification in FR-14 rejects a deliberately mismatched
   render.
4. A template published while a channel is on air does not change that channel's
   output until its binding is explicitly upgraded.
5. A sponsor graphic bound with the burned target appears in the recording and in
   a clip taken from it.
6. No radio station's behaviour changes in any respect.

---

## 11. Out of scope for the first release

- Customer-uploaded arbitrary HTML. The shipped library plus duplication covers
  the first release; arbitrary uploaded HTML is code execution in a renderer and
  needs a sandbox design of its own.
- A visual drag and drop template designer.
- Ad decisioning, `SCTE-35` markers and server-side ad insertion. Related,
  frequently confused with this feature, and a separate project.
- Live burn-in. Specified here so the model accommodates it, sequenced after the
  player and offline paths ship.

---

## Decisions, 20 Oct 2026 (Christian)

- **No graphics on package-only channels.** Their source encoder handles graphics. Advanced graphics (live HTML burn-in) are offered on the transcode workflow only. A burned binding on a package-only channel is not offered in the UI and is refused by the API.
- **FAST / VOD-to-live channel branding: proposed, awaiting decision.** Keep VOD-to-live transcode-free by burning the channel brand into the asset renditions at ingest (the existing "encode on the live ladder" job, about +2 to 4 % on an encode that already runs), one branded variant per asset per brand version, created when an asset is first scheduled on a branded channel. Ads and the ad slate stay unbranded. A live-transcode FAST mode (dynamic graphics, tickers) would be a premium option priced per channel-hour.
- **Player graphics via in-stream triggers: BUILT 20 Oct 2026** (first graphic: Up next). The standard trigger path for player-side graphics, see `DESIGN_stream_graphics_triggers.md`. Live HTML burn-in remains a separate, transcode-only path.


---

## 12. Decisions of 20 Oct 2026 and what is built

Agreed with Christian against the sample views (Volt Graphics management canvas), then built.

**Customer HTML is in release 1** (reverses section 11). Uploaded and pasted templates run sandboxed:
served from `/gfx/<version>/` with `Content-Security-Policy: sandbox allow-scripts` and `connect-src` limited to the
template's own package,
in an iframe without `allow-same-origin`, so they reach no network, no cookies and no Volt session. Everything
a template needs is inside its package; the publish checks refuse a template that loads from the internet.

**A fifth object, the SETUP**, sits between template and binding (section 3): a pinned template version plus
where each field's content comes from (fixed text, Image Library, a data feed path, the guide, the operator,
the API), and position, size and layer. A setup is built once and assigned to any number of channels and
events. What section 3 calls a binding is an ASSIGNMENT of a setup.

**Channels and events run graphics differently.**

* Channels run on their own: each assignment is *always*, *by rule* (genre, title, days, time window, in the
  channel's time zone), *on a trigger* (N s after each programme starts, or N s before it ends) or *by hand*,
  and optionally cleared for ad breaks. The day strip shows from the guide when each one will be on.
* Events are operated from a **graphics rundown**: an ordered list of graphics by segment, each with its own
  content, how long it stays, and a cue: manual (Take next), a clock time, an offset from the start, a change
  of a data feed value (a try), or a repeat. Automatic cues show in the list as Armed and can be skipped.
  A rundown can be imported from CSV or copied from another event.

**Live control is its own window** for a second screen, opened from the console. Sessions live in memory,
so the window asks its opener (same origin) for the current access token, never the refresh token.

**Moving a setup to a new version is the explicit upgrade.** Publishing never changes what is on air; moving
a setup does, at once, for every channel and event using it.

**Data feeds are polled only while something live reads them**, and feed URLs on private networks are refused
(`GRAPHICS_ALLOW_PRIVATE_FEEDS=1` for local testing).

| Built 20 Oct | Where |
|---|---|
| Schema (templates, frozen versions + files, sources, setups, assignments, state + log, rundown) | `migrations/0064_graphics.sql` |
| API, files serving, bridge | `src/modules/graphics.ts` |
| Package reader, manifest, checks | `src/services/graphics/zip.ts`, `templatePackage.ts` |
| Run modes, day plan | `src/services/graphics/schedule.ts` |
| Value resolution | `src/services/graphics/values.ts` |
| Rundown cues, CSV | `src/services/graphics/rundown.ts` |
| Live state, feeds, tick (leader, every second) | `src/services/graphics/runtime.ts` |
| Volt default templates | `assets/graphics/*`, `src/services/graphics/defaults.ts` |
| Console | `volt-web/src/graphics/*` |
| Checks | `test/graphics-pure.check.ts`, `test/graphics.check.ts` |

**Still to build:** the
burn-in sidecar in the encoder, reading the same live state; intro and outro on VOD (W4); SSE for live
control (it polls each second, inside FR-8's two seconds); per-viewer addressable state (FR-16).


---

## 13. The player overlay (built 20 Oct 2026)

Graphics assigned with *Shown in: player* (or both) are drawn by Volt players over the picture.

**Feed, not manifests.** Second-by-second values do not belong in manifest triggers
(DESIGN_stream_graphics_triggers.md), so players read `GET /api/player/graphics?appKey=&streamId=&since=`:
the graphics (template URL, canvas, placement, layer) and the state over time as **snapshots**. The scheduler
leader records a snapshot whenever a live stream's player graphics change (at most once a second, and at once
after an operator's change); they are kept 48 hours (migration 0066). Off-air graphics carry no values, so
nothing is sent before it is shown. Same key rules as every player route, cached per stream for a second, so
the cost does not grow with the audience.

**In step with the picture.** The player applies the snapshot in force at its playhead's wall clock
(PROGRAM-DATE-TIME), never at the viewer's own clock. A viewer 40 s behind live sees the score change when the
try is scored on their screen; one scrubbing the DVR sees what was on screen then. Verified in Chromium against
a live HLS stream.

**Drawing.** `volt-player/src/sdk/overlay.ts`: one sandboxed iframe per graphic (no `allow-same-origin`, CSP
sandbox, `connect-src` limited to its own package, from `/gfx/`), driven through the same postMessage bridge as the console
preview, laid out at the template canvas and scaled to the picture's box (letterboxing respected). Hidden when
graphics are off (`showGraphics`), during an ad break, or when there is no picture. `state.overlays` lists what
is on screen and the `graphic` event fires with `graphic: 'html'` as each comes on.

**Impressions (FR-17).** `POST /api/player/graphics/impressions` once per graphic per appearance, scoped to the
stream's own assignments; the console shows views in the last 24 hours per graphic.

**Public tier.** `/gfx/` is in the default `PUBLIC_PATH_PREFIXES` and the ALB public rule; `/api/player/` was already.

**Still open:** a viewer who joins after a graphic last changed and scrubs back further than the snapshots
reach sees the earliest one; snapshots only exist while the stream is live.

---

## 14. EBU OGraf packages (built 20 Oct 2026)

Volt imports EBU OGraf v1 packages (a `*.ograf.json` manifest plus a Web Component module) alongside CasparCG,
SPX and Loopic templates. The schema gives the fields (enums as dropdowns), the render requirements give the
canvas, and `/gfx/<version>/index.html` is a host page generated from the manifest that maps update, play,
next and stop onto updateAction, playAction (goto 0, then delta 1) and stopAction behind `load()`. Nothing else
in Volt changes: setups, assignments, live control, rundowns and the player overlay drive an OGraf graphic exactly
like any other. Edit code opens the graphic's main module and keeps the other files.

Templates may now `fetch()` files from their own package (`connect-src` is the template's own `/gfx/<version>/`
path), which OGraf's Lottie-based examples need; they still reach no network, no other template and no Volt API.

Details, mapping and checks: `GRAPHICS_TEMPLATE_STANDARD.md` section 7. Not yet: custom actions in live control,
non-real-time rendering for burn-in.

---

## 15. Status, reliable previews and the style editor (built 20 Oct 2026)

Christian: previews were blank; status (ready, in development, erroring) is key; at minimum copy a template and
change its fonts and colours; a builder only if it does not over-commit us.

* **Blank previews**: the console dev server did not proxy `/gfx`, so template frames loaded the console page.
  Fixed, and the stage now always says why it shows nothing (did not load, template error, drew nothing).
  Fields without samples get generated values; thumbnails zoom to where a graphic draws.
* **Status**: Ready / In development / N errors / No files, on every template in the API and console, with a status
  filter in the library and a ribbon on previews of anything not yet usable.
* **Style editor**: colours (theme variables and literals) and fonts in any template, plus added font files, saved as
  a checked draft. Volt templates are customised as a copy. API: `GET .../versions/:vid/style`,
  `POST /api/graphics/templates/:id/style`.
* **No in-app designer**: design happens in graphics tools (Loopic, SPX, Singular, OGraf producers); Volt imports,
  adapts and operates. Reasoning in `GRAPHICS_TEMPLATE_STANDARD.md` section 8.

