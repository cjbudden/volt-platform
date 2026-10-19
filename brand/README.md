# Volt Streaming brand assets

Source files for the Volt Streaming brand. The live brand book (logo, colour, type, icons, diagrams, marketing) is the **Volt Streaming** design system artifact in Claude. A copy of its text is in `guide/`.

| Folder | What | Use it for |
| --- | --- | --- |
| `guide` | `Volt_Brand_Guidelines.pdf` and the brand book as Markdown | The rules. The live version is the Volt Streaming design system in Claude. |
| `templates` | PowerPoint template (`.potx`) and sample deck, the brand style guide deck, Word template (`.dotx`) and sample document, one-pager | Starting points for any new deck or Paper document. |
| `templates/html` | Briefing sheet and Report templates (HTML, print to A4 PDF from Chrome: margins none, background graphics on) | The two richer document styles for prospects and partners. |
| `logos/svg`, `logos/eps`, `logos/pdf` | Lockups, short lockups, marks, flat tile. Colour (Volt blend), solid, white and ink | Web, print, design tools, agencies. |
| `logos/png` | Lockups at 1200px wide, marks and tiles at 512px | Office files, email signatures. |
| `logos/app-icon` | Lit tile at 16 to 1024px, `favicon.ico`, `favicon.svg` | App icons, favicons, avatars. |
| `icons/svg/currentColor` | 51 icons that inherit text colour | The product and web pages. |
| `icons/{svg,png,eps}/{volt,ink,white}` | The same icons with colour baked in | Diagrams, Word, PowerPoint, print. |
| `icons/volt-icons.sprite.svg` | One sprite, symbols `volt-<name>` and `volt-mark` | `<svg><use href="#volt-channel"/></svg>` |
| `fonts/web`, `fonts/desktop` | Archivo, Inter, JetBrains Mono (variable WOFF2, static TTF) | Web and installing for Office. |
| `tokens` | `volt-tokens.css`, `volt-tokens.json` | Colours, the Volt blend, type, spacing, radii in code. |

The desktop fonts are Latin-only subsets made from the variable fonts. For other scripts download the full families from Google Fonts (Archivo, Inter, JetBrains Mono). All three are under the SIL Open Font License.

Quick rules: write **Volt Streaming** first, **Volt** after, never VOLT. The primary colour is the Volt blend, `#5b8cff` to `#4f46e5` at 140°, and the mark always carries it in colour artwork (solid fallback `#5569f2`). Icons are 24 grid, 2px stroke, no fills. Diagrams flow left to right with icon nodes and short labels.
