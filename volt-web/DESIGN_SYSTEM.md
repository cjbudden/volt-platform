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

## Layout

- `.content` caps at 1420px. Nothing may exceed it.
- Two-column bodies use `.grid-2` (1.55fr / 1fr). **Grid and flex children that
  can contain long unbreakable text need `min-width: 0`** — without it a
  monospace URL stretches the column and the page breaks out of its width. This
  was a real bug on the radio page; it is the first thing to check if a page
  looks wider than its neighbours.
- Section labels use `.sec-label` (or the `SEC` style object, which reads the
  same tokens).

## The five-gate strip

Server → Input → Encoder → Output → On air, rendered identically on channels and
radio: a flat row of tinted cards with `→` between them, **no wrapping card**.
The gates *are* the status line for the entity; boxing them makes them read as
an aside instead.

## Checklist for a new page

1. `<PageIdentity>` for the header, `<StatusPill>` / `<TypeTag>` for state.
2. No raw px font sizes: use the scale.
3. Actions in the standard order, `.icon-btn` only for bare icons.
4. `.grid-2` for two columns, `min-width: 0` on children.
5. Compare it side by side with Channels before calling it done.
