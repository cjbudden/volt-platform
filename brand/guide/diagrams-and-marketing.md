# Diagrams, decks and marketing

## Diagrams

A Volt diagram is a picture of signal flow, not a page of boxes with paragraphs in them. Each node is an icon with a short label. The reader should follow the signal with their eye before reading a word.

- **Direction.** Signal flows left to right. Control and management sit above the flow, storage and archive below it. Audiences and devices are always on the right.
- **Nodes.** A 56px `panel` tile with `radius-tile` corners and a 1px `line-strong` border, a 28px `volt` icon in the centre, the label under it in `ui-body` semibold `ink`, and at most one detail line under that in `data-sm` `ink-muted` (a protocol, a count or a region). No more than 7 nodes in a row.
- **Connectors.** The live signal path is a 2px `volt` line. Secondary and control paths are 1.5px `ink-faint`. A backup or failover path is dashed (4 on, 4 off). Arrowheads are small open chevrons. Lines run straight or with right-angle turns, never diagonally.
- **Groups.** A boundary (a cloud region, a customer site, "Volt platform") is a 1px dashed `line-strong` rectangle with `radius-card` corners, labelled top-left in the eyebrow style in `ink-muted`. Tint at most one group with `volt-soft` to show where Volt is.
- **Labels on lines** are protocol tags (SRT, HLS, DASH) in mono, centred on the line on a `ground` knock-out.
- **Status** in a diagram uses the StatusPill colours and words. A red line on its own means nothing.
- **Background.** Control room for decks and the web, Paper for documents and print. Never place a diagram on a photograph.
- Customer-facing diagrams show what Volt does, not how it is built. Leave out internal service names, hostnames, ports, table names and instance sizes.

## Slide decks

- 16:9, `ground` background in Control room. Paper is acceptable for dense data appendices.
- Margins `space-16` (64px at 1920 wide). Content aligns to the left margin.
- **Title slide:** short lockup top-left, eyebrow, one display line, a deck line, and a product screen or one block cut by the slit on the right.
- **Content slide:** eyebrow, title in Archivo Expanded ExtraBold, then one idea: a screen, a diagram, three facts or a quote. Never a wall of bullets. Five bullets is the ceiling.
- **Footer:** the short lockup at 24px high bottom-left, a page number in `data-sm` bottom-right, and nothing else.
- Charts: `volt` for the first series, `current` for the second, `ink-muted` for comparison. Status colours only for status.

## Advertising and social

- **One message per piece.** An eyebrow that names the workflow, a headline, one line of deck and a call to action. The lockup always appears.
- **Proven headlines** that carry the two signature workflows: "Go live. Stay live." "Every live hour becomes a library." "Turn your archive into a channel." "Live → VOD in one take."
- **Call to action** is a `volt-strong` button shape with `on-volt` text, in sentence case: "Book a demo", "Start a trial", "See it live".
- **Formats.** 16:9 (1920×1080) for video and web heroes, 1:1 (1080×1080) and 4:5 (1080×1350) for social, 1200×628 for link cards, and 300×250 / 728×90 for display ads, where the short lockup replaces the full one.
- **Composition.** `ground` field, one Volt blend block (optionally cut by the slit), the product screen or a photograph, the type left-aligned on the ground, never on the blend. Keep a `space-12` safe area on every edge for social crops.
- **Motion.** The only brand animation is the slit: the two halves of the mark arrive from opposite directions along the slit and lock together in 400ms with an ease-out. Use it as an intro or outro sting, never as a loop.
- **Video and lower thirds.** Name in Archivo 700, role in Inter 400, on a `panel` bar with a 4px `volt` square to the left of the name. Safe-title area 10% of frame height.
