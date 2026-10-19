# Document styles

Volt documents come in three styles. All three use the same name rules, colours, fonts and logo. They differ in how much Control room they carry, and that decides when to use each. The Briefing sheet and the Report have both had good feedback from readers. Use them for anything that represents Volt to a prospect or partner.

| Style | Look | Use it for | Start from |
| --- | --- | --- | --- |
| **Paper** | All light. Full lockup on the cover, short lockup in the header, one Volt blend band on the cover only. | Working documents people edit: specs, requirements, SoWs, user guides, internal one-pagers, anything that will be printed in black and white. | `Volt_Word_Template.dotx`, `Volt_One_Pager.docx` |
| **Briefing sheet** | One A4 page. A Control room band across the top holds the lockup, the document type, the date and confidentiality line, the headline and a lead paragraph. Below it, Paper content in tight modules, with one dark panel in the middle or lower third for a proof strip or illustration. | Platform summaries, solution briefs, pricing and cost explainers, event handouts. One subject, read in two minutes. | `templates/html/Volt_Briefing_Sheet_Template.html` (from the Distribution and running cost sheet) |
| **Report** | Multi-page A4. A full Control room cover with the lockup, eyebrow, headline, deck, metadata row and one Volt blend block cut by the slit. Inside, Paper pages with an eyebrow and title at the top, two-column text, tinted side boxes, stat tiles and full-width product screens with captions. | Platform overviews, proposals, investor and partner packs, design summaries. | `templates/html/Volt_Report_Template.html` (from the Platform Overview) |

## Shared rules

- **Page:** A4, edge to edge. Content margin 13mm on briefing sheets, 18mm on reports and Paper documents.
- **Type:** headlines in Archivo (heavy, slightly extended, sentence case), body in Inter at 7.5 to 9pt on a briefing sheet and 9.5 to 10.5pt in a report, numbers and page numbers in JetBrains Mono.
- **Eyebrows** sit above every section: Archivo semibold, uppercase, tracked +14%, in `volt-end` on Paper and `volt-text` on Control room.
- **Headline accent:** a briefing sheet or report headline may set its second clause in `volt-text`, for example "Servers follow the streams. *Cost follows the work.*" Use it once per page.
- **Footer:** the confidentiality line on the left and the © or page number on the right, in `ink-faint` at 6.3 to 7pt above a 1px `line` rule. Reports also put the short lockup at the start of the footer.
- **Never** put a thick coloured rule down one edge of a tile, box or stat. Separate with tone, a hairline on top, or a 1px outline.

## Briefing sheet anatomy

1. **Band** (Control room `ground`, about the top 18% of the page). Row one has the lockup on the left with a short descriptor after a 1px divider ("Distribution and running cost", "Live · On-demand · Radio") and the meta block on the right in uppercase tracked `ink-muted`: document type, month and year, and **Confidential** in `volt-text`. Then the headline at 19 to 20pt in white and a lead paragraph in a light grey (#c9cfdc). A soft Volt-tinted light in the top-right corner of the band is allowed in this style only.
2. **Lead module:** either two routes side by side in `panel-2` boxes with a dark icon tile, or a four-step numbered flow (01 to 04, numbers in `volt-text`) with small arrows between the steps.
3. **Capability grid:** three columns. Each item has a hairline on top, a 4mm `volt` icon beside an Inter semibold title, and two to four lines of text.
4. **Dark panel:** one Control room panel per sheet. It is either a proof strip of four big numbers (JetBrains Mono or Archivo, units in `volt-text`) or a small illustration such as a server pool with tagged chips and load bars.
5. **Lower section:** two columns. One holds "Why it is ahead" or "Built for real deployment" prose, the other a dotted list of what comes next, ending with a one-line call to action and the author's name.
6. **Legal line** at the foot of the page.

## Report anatomy

- **Cover:** Control room `ground` and the colour lockup on dark, top-left. Below it a confidentiality eyebrow and a descriptor line, then a two-to-three-line headline with the second half in `volt-text`, and a deck paragraph. A metadata row along the foot (Prepared by, Date, Status) is set in eyebrow labels over Inter values. One Volt blend block bleeds off the top-right, cut by the slit.
- **Contents and introduction** share page 2: the introduction in two columns on the left, "In this document" as a ruled list with page numbers in mono on the right, and an "About this document" note in a `panel-2` box.
- **Content pages:** an eyebrow (OVERVIEW, CAPABILITIES, SCREENS, MATURITY, NEXT STEP), then the page title in Archivo bold at about 20pt. Cards in a two-column grid with 1px outlines, and the one key point of the page in a `volt-soft` box.
- **Screen pages:** one or two full-width product screens per page, each with a caption that opens with the screen name in bold.
- **Maturity or stats page:** a 3 × 2 grid of outlined stat tiles with the figure in JetBrains Mono at about 22pt and a two-line label in `ink-muted`.
- **Closing page:** a short invitation, the author's name and date, and the confidentiality note in a `panel-2` box.

## Choosing

- If the reader will edit it, use **Paper**.
- If it must make the case on one page, use a **Briefing sheet**.
- If it needs more than two pages and represents the product, use a **Report**.
- Keep all three in the same document set: a Report can travel with a Briefing sheet as its summary, and Paper specs can follow as appendices.
