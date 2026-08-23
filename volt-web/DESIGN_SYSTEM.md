# VOLT design system

*The visual language is what makes the platform usable: the same thing must look
the same, sit in the same place and be the same size on every page. This file is
the contract. If a page needs a value that is not here, the value is wrong or
this file needs a new token — not a one-off number in a component.*

## Tooling: Tailwind driven by our tokens

**Tailwind v4 utilities + our design tokens + semantic component classes, as one
system.** No SASS (Tailwind v4 needs no preprocessor; our tokens are native CSS
variables).

Tailwind was previously installed but dormant — never imported, zero utility
classes, running on every build for nothing. It is now wired up properly:

```css
@layer theme, base, components, utilities;
@import "tailwindcss/theme.css"     layer(theme);
@import "tailwindcss/utilities.css" layer(utilities);
@theme { --color-panel: …; --text-body: 13px; --radius-card: 16px; … }
```

`@theme` feeds Tailwind **our** values, so `text-body` is 13px, `text-faint` is
`#6a7387` and `p-4` is 16px — the same numbers the component classes use. There
is one source of truth, not two competing scales.

**Preflight is deliberately excluded.** Tailwind's reset is designed for a blank
project; this app already ships a complete reset and fully-styled elements, so
layering a second reset would silently change borders, buttons and inputs on
every page for no gain. We take the theme and the utilities, which is the part
that earns its place.

**Which to use:**

| Situation | Use |
|---|---|
| A widget that repeats across the app (card, button, tag, thumb, timeline) | semantic class — one edit changes everywhere |
| One-off layout on a page (flex row, gap, min-width, a text size) | Tailwind utility — `flex items-center gap-2 min-w-0 text-sm` |
| A raw px font size or a hand-picked status colour | **neither** — use the scale and `<StatusPill>` |

Inline `style={{}}` remains only for genuinely dynamic values (a computed
colour, a percentage position). Static layout belongs in utilities.

## Type scale

Defined once in `:root`. **Never write a raw px font size.** Everything on
screen resolves to one of these:

| Token | Value | Used for |
|---|---|---|
| `--fs-h1` | 23px | page title, entity title |
| `--fs-h2` | 15px | card headings, modal titles |
| `--fs-h3` | 14px | sub-headings, stat values |
| `--fs-base` | 14px | document default |
| `--fs-body` | 13px | body text, sub-lines, buttons, inputs |
| `--fs-sm` | 12.5px | dense body, table cells |
| `--fs-xs` | 11.5px | tags and chips |
| `--fs-label` | 11px | UPPERCASE section labels |
| `--fs-micro` | 10.5px | meta text, gate detail, ruler ticks |

Supporting tokens: `--lh-tight`, `--ls-title` (title tracking), `--ls-label`
(uppercase-label tracking), `--tag-drop` (see below).

The whole app renders in **7 distinct sizes**, all from this scale. Form
controls inherit it too (`input,select,textarea,button`), so an input never
disagrees with the text beside it.

## Status: shape is decided by TYPE, not by the page

Two different things, two consistent treatments:

- **What a thing IS** (workflow/kind) → `<TypeTag label="Packaging" />`.
  A pill with **no dot**, because a type is not a live state.
- **What a thing is DOING** (pipeline state) → `<StatusPill state="onair" />`.
  A pill **with a status dot**, coloured from the state.

`PIPELINE_STATE` in `scaffold.tsx` is the single map from state to label and
colour class:

| state | label | class |
|---|---|---|
| `onair` | On air | live (green) |
| `ready` | Ready · private | sched (blue) |
| `starting` | Starting | sched |
| `degraded` | Degraded | warn (amber) |
| `error` | Error | down (red) |
| `stopped` / `idle` | Stopped / Idle | idle (grey) |

A page **never** invents a status label or picks a colour. It passes the state
the backend produced. Adding a state or changing a colour is one edit here and
every page follows.

All pills render UPPERCASE (`.tag { text-transform: uppercase }`) so a row of
them reads as one control, and plain sentence text is never mistaken for a
status.

## The identity row

Every detail page opens with the same three lines, from one component
(`<PageIdentity>`): breadcrumb → thumb + title + tags → one-line summary.

- Navigation is by **breadcrumb** (`Channels / Snap`), never a floating back
  arrow.
- The thumb is `.dthumb`: 42px, 11px radius, brand gradient or the entity image.
- Tags sit **`--tag-drop` (3px) lower** than the title's box centre. A pill's
  geometric centre reads high against a large title; dropping it aligns it to
  the title's baseline. This is why the tags look "settled" rather than floating.

## Buttons and icons

- `.btn` is the standard action: 35px tall, `--fs-body`, 15px icons.
  `.btn.primary` for the main action, `.btn.ghost` for everything else.
- Action order on a detail page is fixed: **QC → Settings → lifecycle**
  (Start → Go on air / Take off air → Stop). An operator's hand learns one path.
- `.icon-btn` is for **icon-only** actions (notifications, sign out, mute).
  It is **chromeless**: no border, no fill, 18px icon, a subtle hover wash.
  A bordered box around a bare icon competes with the real buttons next to it.

## Forms

**Text entry is styled by the element, not by remembering a class.** `input`,
`select` and `textarea` carry the platform look by default: `--panel-2` fill,
`--border`, `--radius-ctl`, `--fs-body`, brand focus ring. Checkboxes, radios,
ranges, colours and file pickers keep native rendering, and `html { color-scheme:
dark }` makes native chrome (dropdown lists, autofill, scrollbars) render dark.
Before this, a bare `<input>` fell back to a white box with black text on a dark
panel; the fix belongs in the element rule, not in every component.

`.inp` and scoped rules like `.search input` still win where a control needs
something different.

### Choice rows

A mutually exclusive choice where **each option needs a line of explanation**
(share delivery, expiry style, link security) uses `.choices` / `.choice`, not
inline radios: full-width rows, title on top, one plain-English line under it,
and the dependent control **nested inside the selected row**. The description is
part of the decision, so it has to be readable, and no control is ever on screen
whose owner is not selected.

The row is a `div` with `role="radio"`, never a `<button>`: a selected row can
contain a `select` or an `input`, and interactive content nested in a button is
invalid HTML that browsers handle inconsistently.

## Layout

- `.content` caps at 1420px. Nothing may exceed it.
- Two-column bodies use `.grid-2` (1.55fr / 1fr). **Grid and flex children that
  can contain long unbreakable text need `min-width: 0`** — without it a
  monospace URL stretches the column and the page breaks out of its width. This
  was a real bug on the radio page; it is the first thing to check if a page
  looks wider than its neighbours.
- Section labels use `.sec-label` (see below).

## Section labels

`className="sec-label"` — **not** `style={SEC}`. The class and the object carry
the same tokens, but only the class can also say `:first-child { margin-top: 0 }`.
A card whose first child was `style={SEC}` opened with 20px of dead space above
the label on top of the card's own padding, and every card in the app did it.
`SEC` survives only for the rare place that must merge extra properties.

Result: every card's content starts at the same 17px from its top edge.

## The five-gate strip

Server → Input → Encoder → Output → On air, from **one component**
(`<PipelineStrip gates={…} />` in `scaffold.tsx`, used by both Channels and
Radio): a flat row of tinted cards with `→` between them, **no wrapping card**.
The gates *are* the status line for the entity; boxing them makes them read as
an aside instead.

**Five steps, one line, always.** Gates are `flex: 1 1 0` with `min-width: 0`, so
each takes an equal share of the row whatever it contains and long detail
ellipsises inside its own box (full text on hover via `title`). The earlier
`flex: 1 1 130px` let a gate with a long detail line — an Icecast station name, a
source URL — grow past its share and push "On air" onto a second row, at which
point the strip stops reading as a pipeline.

## The audio player (radio)

Three things live on the radio surface and must not be confused with each other:

1. **The waveform is the broadcast output.** Server-measured levels from the
   packager, drawn whether or not anyone is listening. There is exactly ONE
   waveform: a second local-analyser overlay used to be drawn on top while
   playing, which invited the reading "the picture changes when I press play".
   Local playback and mute change nothing on it.
2. **Listening is local.** Listen / Stop listening and the mute and volume
   controls change what *you* hear on *this device*, never the broadcast. The
   button is a fixed 150px and the row a fixed 46px, so switching state swaps a
   fill for an outline and a glyph for a dot — nothing resizes or moves.
3. **Output previews are per-rendition checks.** One compact play button per
   packaged format (MP3, HLS, DASH) beside its URL and Copy, deliberately with
   no waveform: the question is "does this rendition play", not "is the signal
   good". One sound at a time — starting a preview stops the live listen and
   vice versa.

## Checklist for a new page

1. `<PageIdentity>` for the header, `<StatusPill>` / `<TypeTag>` for state.
2. No raw px font sizes: use the scale.
3. Actions in the standard order, `.icon-btn` only for bare icons.
4. `.grid-2` for two columns, `min-width: 0` on children.
5. Compare it side by side with Channels before calling it done.
