# Font guide

Volt uses three open-source families (all under the SIL Open Font License, free for commercial use, embedding and print). Each has one job. Do not add a fourth.

| Role | Family | Token | Fallback stack | Why |
| --- | --- | --- | --- | --- |
| Display | **Archivo** | `--font-display` | Helvetica Neue, Arial, sans-serif | A grotesque with a width axis. Set slightly extended and heavy, it has the confidence of a broadcast lower third without looking like a sports scoreboard. |
| Text | **Inter** | `--font-sans` | system-ui, Segoe UI, Arial, sans-serif | Already the product's UI face. Built for screens at 11 to 15px, with tabular figures. |
| Data | **JetBrains Mono** | `--font-mono` | ui-monospace, Menlo, Consolas, monospace | Timecode, URLs, stream keys and code, where every character is compared. Clear 0/O and 1/l/I. |

## Archivo settings

Archivo is a variable font with weight (100 to 900) and width (62 to 125) axes. Volt uses only these settings:

- **Headlines and slide titles:** weight 800, width 112, tracking -2%, line height 0.92 to 1.0.
- **Document headings:** weight 700, width 100 (normal), tracking -1%.
- **Eyebrows:** weight 600, width 112, uppercase, tracking +14%.
- **The wordmark** is outlined artwork (Volt at 800/112, Streaming at 400/100). Never retype it.

On the web set the width with `font-variation-settings: "wdth" 112`. In desktop apps install the static fonts from the brand folder, where *Archivo Expanded ExtraBold* is the 800/112 cut.

## Scales

Use the named styles in the Typography view. Never type a font size that is not on a scale.

**Marketing** (web, ads, social, slides): `display-xl` 88, `display-l` 64, `display-m` 44, `headline` 32, `eyebrow` 12, `deck` 20. One display size per layout, plus an eyebrow and a deck at most.

**Documents** (proposals, specs, user guides, PDFs): `doc-title` 34, `doc-h1` 24, `doc-h2` 18, `doc-h3` 15, `doc-body` 15 on 24, `doc-caption` 12.5. Headings in Archivo, everything else in Inter.

**Interface** (the product): the app's own scale, exactly. `ui-h1` 23, `ui-h2` 15, `ui-h3` 14, `ui-body` 13, `ui-sm` 12.5, `ui-tag` 11.5, `ui-label` 11, `ui-micro` 10.5. The interface uses Inter only.

**Data**: `timecode` 13 medium with tabular figures, `code` 12.5 on 20, `data-sm` 11.5 for protocol tags and table IDs.

## Office documents and slides

Install the desktop fonts first (Archivo, Archivo Expanded, Inter and JetBrains Mono, from the brand folder or Google Fonts). Then map the styles:

| Word / PowerPoint style | Font | Size | Colour |
| --- | --- | --- | --- |
| Title | Archivo Bold | 26pt | `ink` |
| Heading 1 | Archivo Bold | 18pt | `ink` |
| Heading 2 | Archivo SemiBold | 13.5pt | `ink` |
| Heading 3 | Inter SemiBold | 11pt | `ink` |
| Normal / body | Inter | 10.5pt, 1.5 spacing | `ink` |
| Caption, table text | Inter | 9pt | `ink-muted` |
| Code, URLs, timecode | JetBrains Mono | 9pt | `ink` |
| Slide title | Archivo Expanded ExtraBold | 32 to 40pt | `ink` |
| Slide eyebrow | Archivo Expanded SemiBold, all caps, +14% spacing | 10pt | `volt-text` |
| Slide body | Inter | 16 to 20pt | `ink-muted` |

When the fonts cannot be embedded (a file sent to a customer who will edit it), choose **Embed fonts** in Office. If that is not possible, Arial replaces Archivo and Inter, and Consolas replaces JetBrains Mono. Never substitute a script, slab or condensed face.

## Rules

- Headlines are short and set in sentence case: "Every live hour becomes a library."
- Do not set body copy in Archivo or headlines in Inter.
- Numbers that line up (timecode, bitrates, viewer counts, prices) use tabular figures: `font-variant-numeric: tabular-nums` in CSS, or JetBrains Mono.
- Timecode is always `HH:MM:SS:FF` in mono, for example `00:59:58:12`. Bitrates are written `6 Mb/s`, resolutions `1920×1080`, frame rates `50p` or `59.94i`.
- Line length for running text is 60 to 75 characters.
- Left-align everything except single-line display text on a marketing panel.
