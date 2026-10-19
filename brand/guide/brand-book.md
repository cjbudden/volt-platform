Volt Streaming is a live-first streaming platform: live channels, live events, radio, FAST and loops, with recordings that turn into a media library and a library that turns back into a channel. The brand comes from the room it is used in. Operators sit in a dim control room watching signals, so the identity is dark, calm and precise, with one bright current running through it: the Volt blend, from Volt Blue to Volt Indigo.

Use this system for everything that carries the Volt name: the product UI, documentation, solution and architecture diagrams, slide decks, proposals, advertising, social posts and the website. The font guide, icon guide and the diagram and marketing rules are separate sections of this book.

## Name

- Write **Volt Streaming** on first mention in any document, page or ad. After that, **Volt** on its own is correct.
- Always title case: `Volt`, never `VOLT`, `volt` or `VOLT Stream`. All caps is reserved for eyebrows and status pills, where the whole line is uppercase anyway.
- The descriptor, when one is needed under the name, is **Live streaming platform**.
- Never use earlier working names in anything new.
- Product areas keep their UI names, in title case when they are a place in the product and sentence case in running text: Live Channels, Live Events, Radio, FAST, Loops, Recordings, Media Library, EPG, Multiview, Watchfolders, Analytics.
- The two signature workflows are written with an arrow: **Live → VOD** and **VOD → Live**. In plain text where the arrow is not available, write "Live to VOD" and "VOD to Live".

## Voice

Volt talks like a senior broadcast engineer who respects the operator's time.

- **Plain and specific.** Say what happens: "Recording starts when the channel goes on air", not "Seamlessly capture your content".
- **The operator's words.** On air, off air, ingest, failover, rendition, as-run, EPG, slate. Do not soften broadcast terms into consumer language, and do not invent new ones.
- **Active voice, present tense.** Buttons state the action ("Go on air", "Take off air", "Publish"). The confirmation repeats it ("On air", "Published").
- **Errors explain and fix.** "No signal on the primary input. Volt switched to the backup at 14:02:11" is right. "Oops, something went wrong" is not.
- **Calm about failure.** The product exists for the bad night. Never alarmist, never cute.
- **Spelling is UK English** (colour, organisation, programme for a broadcast programme, program for software).
- **Sentence case** for headings, buttons and menu items. Title case only for product areas and the name.
- **No emoji** in product, docs or ads. Status is carried by the pill, the dot and the word.
- Keep em dashes and semicolons rare. Prefer a full stop, a comma, a colon or brackets.

Real copy from the product, as reference: "Ready · private", "Go on air", "Take off air", "Stop listening", "Server → Input → Encoder → Output → On air".

## Logo

The mark is the **split bolt**: a lightning bolt cut by one steep slit into two halves. The upper half is live, the lower half is VOD, and the current runs both ways. It is drawn on a 48-unit grid and must never be redrawn, re-angled or replaced with an emoji or a generic bolt glyph.

| Asset | Use |
| --- | --- |
| `volt-lockup-on-dark.svg` | Default. Website, product sign-in, decks, ads on `ground`. |
| `volt-lockup-on-light.svg` | Documents, proposals, print, anything on Paper or white. |
| `volt-lockup-solid-on-light.svg` | Where a gradient cannot be reproduced (one-colour spot print, embroidery, some email clients). Mark in solid `volt`. |
| `volt-lockup-white.svg`, `volt-lockup-ink.svg` | One-colour use: on the Volt blend, over photography, single-colour print, partner co-branding. |
| `volt-short-on-dark.svg`, `volt-short-on-light.svg` | Mark plus "Volt" for tight spaces: app headers, footers, slide footers. |
| `volt-mark.svg`, `volt-mark-solid.svg` | The mark alone, in the blend or solid `volt`, once the name is already on the page. |
| `volt-tile.svg` | App icon, favicon, avatar, the product sidebar. White mark on the Volt blend with top-down lighting. |
| `volt-tile-flat.svg` | The tile without lighting, for print and EPS. |

Every logo also ships as PNG, EPS and PDF in the brand folder, and the tile ships at app-icon sizes from 16 to 1024px plus `favicon.ico`.

- **Colours.** In colour artwork the mark is always the **Volt blend** (`volt-start` #5b8cff to `volt-end` #4f46e5 at 140°), running continuously across both halves. "Volt" is `ink`, "Streaming" is `current` on Control room and `volt-end` on Paper. Nothing else may be recoloured.
- **The tile.** The blend fills a square with corners at 10/34 of its width. Light comes from above: a soft white highlight fading out by the middle, a slight indigo shade at the base, a 1px light inner edge and a soft shadow under the white mark. Under the tile use `shadow-tile`, a neutral shadow, never a coloured glow.
- **Clear space** around the lockup equals the height of the capital V. Nothing (text, image edges, other logos) enters it.
- **Minimum sizes.** Full lockup 120px wide on screen (30mm in print). Short lockup 64px (16mm). Mark alone 16px. Below 24px use `volt-tile.svg`, because the slit closes up on a bare mark.
- **Backgrounds.** Place the colour lockups only on `ground`, `panel`, white or Paper. Over photography use the white or ink one-colour lockup on a calm area of the image.
- **Do not** stretch, outline, add shadows or glows, put the mark in a circle, set the name in another face, recolour "Streaming" to match "Volt", rotate the mark or animate the two halves apart in still artwork.
- **Co-branding.** Partner logos sit to the right of a 1px `line-strong` divider, matched by cap height, with clear space on both sides.

## Colour

Two themes share one set of token names. **Control room** (dark) is the product and the default for marketing. **Paper** (light) is for documents, proposals and print. Build every surface from the tokens, never from a hex value typed into a slide or a stylesheet.

- **The Volt blend is the primary colour.** `volt-start` (Volt Blue #5b8cff) to `volt-end` (Volt Indigo #4f46e5) at 140°, taken from the app tile. Use it on the mark, the app tile and one hero block per layout. Never put body text on it and never use it as a page background.
- `volt` (#5569f2) is the blend's centre, the solid primary for anything that cannot carry a gradient: single-colour marks, icons, focus rings, selected states, the first chart series.
- **Proportion.** Roughly 60% `ground`, 25% `panel`, `ink` and neutrals, 10% Volt (blend or solid), 5% `current` and status colours. If more than about a tenth of a layout is Volt, it stops meaning anything.
- `ground` is the page, `panel` the card, `panel-2` the input, `panel-3` the chip. Separate them with `line`, and use `line-strong` for the boundary that must be seen.
- `ink` for body text, `ink-muted` for secondary text and meta lines, `ink-faint` only for decorative meta at 12px or more (it is below 4.5:1 in Control room and is kept to match the shipped UI).
- Words in the brand colour (links, eyebrows) use `volt-text`, never `volt` or the blend.
- Filled buttons and filled tags use `volt-strong` (Volt Indigo) with `on-volt` text (6.3:1). Do not put small white text on `volt-start`.
- `volt-soft` tints a selected row, an info banner or a highlighted diagram group.
- `current` is the second voice: "Streaming" in the wordmark on Control room and the second data series. Never a button.
- **Status colours mean state and nothing else:** `live` on air or healthy, `sched` ready or scheduled, `warn` degraded, `down` error, `idle` stopped, `filler` slates and filler content. A status colour always travels with its word and a dot (see the StatusPill component), so `live` and `down` are never told apart by hue alone.
- Focus ring: 2px solid `volt` with a 2px offset. It holds 3:1 on every surface in both themes.

## Type at a glance

Three families, each with one job. Full detail is in the font guide.

- **Archivo** (display): headlines, slide titles, document headings, eyebrows, the wordmark.
- **Inter** (text): the product UI, body copy, tables, captions.
- **JetBrains Mono** (data): timecode, stream URLs, keys, code, protocol tags and anything an operator compares character by character.

## Documents

Volt documents come in three styles, set out in the Document styles section. **Paper** is light and simple, for documents people edit. A **Briefing sheet** is one A4 page with a Control room band across the top, for summaries and briefs. A **Report** has a dark cover and Paper pages inside, for overviews and proposals. Briefing sheets and Reports are the styles to use for anything that represents Volt to a prospect or partner.

## Space, shape and depth

- Spacing runs on a 4px base: `space-1` 4, `space-2` 8, `space-3` 12, `space-4` 16, `space-5` 20, `space-6` 24, `space-8` 32, `space-12` 48, `space-16` 64. Lay out with gaps, not margins.
- Corners follow the product: `radius-xs` for progress bars and ticks, `radius-ctl` for buttons and inputs, `radius-tile` for thumbnails and diagram nodes, `radius-card` for cards and panels, `radius-pill` for status pills. Marketing blocks and print use the same values. Do not round things that are not objects (rules, dividers, full-bleed images).
- Separate with tone first, a 1px line second, and shadow last. `shadow-card` is for cards on `ground` and `shadow-tile` is for the app tile. No glows, no gradients on surfaces other than the Volt blend, no coloured edge bars on cards.

## Imagery

- **Product screens are the hero.** Show the real UI in Control room, cropped to the part that tells the story (the five-gate strip, the timeline, a channel monitor). Use demo tenants and demo channels, never a real customer's names, URLs or data.
- **Photography** is real broadcast work: control rooms, outside broadcast trucks, commentary booths, stadiums at night, radio studios. Cool and low-key, lit by screens. No stock people pointing at laptops, no glowing globes, no abstract "data" swooshes.
- **The slit** is the only graphic device. The mark's 6:26 diagonal (about 77°) may cut a colour block, crop a photo edge or split a before/after pair. Use it once per layout.
