# Design: file names, classification rules and content links

**Status:** built 29 Oct 2026 (build queue 3.0, widened in the session with
Christian to classification rules, related-content links and the API include).
Code: `services/ingest/filenameParse.ts` (reading a name), `classify.ts`
(rules and precedence), `filenameApply.ts` (what is applied, on ingest and on
demand), `services/relatedMatch.ts` (scoring), `services/contentLinks.ts`
(links), `modules/contentLinks.ts` and `modules/filenameRules.ts` (routes),
migration `0117_content_links_and_filename_rules.sql`. Tests:
`test/filename-metadata.check.ts` (pure, 102 checks), `test/content-links.check.ts`
(database and HTTP, 80 checks), `volt-web/test/content-link-field.check.tsx`.

Files often arrive with no embedded title, and their names say a lot:
`Movie_Title_2025_Official_Trailer_1080p.mp4` is a trailer for the 2025 film
"Movie Title", in 1080p. People used to retype that, choose the type by hand,
and type the film's name into a free-text "Trailer for" box that linked to
nothing. This reads the name, suggests and (when clear) applies the type and
fields, and links a trailer to the record it promotes by id.

The principle throughout: **a file name gives signals, not facts.** Every
reading carries the token it came from, a confidence and a sentence a person
can read, and automation acts only where it is reliable. Everything uncertain
stays visible on the asset and is one click to correct.

---

## 1. Reading a name (`filenameParse.ts`)

1. Drop the folder and the extension. Rewrite compound spellings a separator
   would break (`h.264`, `web-dl`), and find dates first (`2026-10-28`,
   `28.10.2026`, `20261028`).
2. Split into tokens on `_ - . space + , ;` and brackets. A dot inside the
   numbers that are tags (`5.1`, `23.976`) is kept; a dotted name splits
   (`Blade.Runner.2049.2017` keeps 2049 in the title and reads 2017 as the year).
3. Season and episode markers anywhere: `S01E03`, `1x03`, `s1`, `season 1`,
   `series1`, `e01`, `ep1`, `eps01`, `episode 3`. They divide the name into
   the **series** (before) and the episode's own **title** (after).
4. Tags peeled from the **right** while recognised (resolution, frame rate,
   codecs, audio, release tags, versions, a year, a language in capitals or
   brackets, promo markers with their modifiers: "Official Trailer 2"), then a
   few kinds from the **left** (a date, a numbered version, a promo or type word,
   an account rule word).
5. What is left is the title, title cased (every word by default; headline style
   is a setting). Mixed-case words are kept as written (`iPhone`, `McDonald`);
   `7th` stays `7th`; Roman numerals are capitals.

Guards against ordinary words: a tag is never peeled if no real title word
would be left (`1917.mp4` is titled 1917, not given the year 1917; small words
like "the" do not count as a title). Words that are also English (web, final,
master, spot, bug, interview ...) are tags only in capitals, in brackets, or
when two real title words remain, so *Charlottes Web*, *The Master*, *Final
Destination* and *Hot Spot Cafe* keep their names. Language codes count only in
capitals or brackets (*The Merry Month of May* keeps May). A promo word that
starts a name with season and episode markers (*Trailer Park Boys S01E01*) is
kept in the title and noted as a weak signal.

## 2. Classification rules (`classify.ts`)

IF/THEN rules suggest a content type from the reading. Built-in rules come from
the taxonomy in `contentTypes.ts`:

| Built-in rule | Suggests | Confidence |
|---|---|---|
| Promotional markers (trailer, teaser, promo, featurette, tv spot, sneak peek ...) | Trailer / promo, with its Kind (Trailer, Teaser, Promo, Featurette) | 0.9 at the end of the name, 0.65 to 0.7 elsewhere |
| Season and episode (S01E03, 1x03, Season 2 Episode 5) | Programme / episode | 0.92 |
| Episode number only | Programme / episode | 0.82 |
| Season only | Programme / episode | 0.65 |
| interview | Interview | 0.7 |
| highlights, highlight, recap | Clip / highlight | 0.65 |
| music video, lyric video, official video | Music video | 0.75 |
| full movie, feature film | Movie / feature film | 0.6 |
| sponsor bug, bug | Bug / sponsor graphic | 0.55 |

Accounts add their own (table `filename_rules`): any of some **words**, a
**signal** (promo, seasonEpisode, episode, season, year, date, language) and/or
a **pattern** (a regular expression on the lower-case name), then a type
(standard key or the account's own type) and, for Trailer / promo, a Kind.
Built-in rules can be switched off per account. A rule's words are also taken
out of the title.

**Precedence**, highest first:

1. A type a person chose: on upload, or later on the asset. Never changed
   automatically.
2. A type an ingest rule names explicitly (`resolveIngest` sources it from a
   rung, not the baseline). Never changed automatically.
3. The account's own file-name rules: when one matches, built-in rules only advise.
4. Built-in rules.

**Conflicts.** A promotional marker at the end of the name outranks season and
episode markers: `Show_S01E03_Promo` is a promo for an episode, and its S01E03
finds that episode (section 4). Otherwise two different types within 0.1 of
each other are a conflict: nothing is set, both are offered with their reasons.

**Applied without asking** only at 0.8 or above, with no conflict, when the type
is still the default, and with the account's "Set the content type when the name
is clear" on. Below that, the reading is stored and offered on the asset.

## 3. What is applied (`filenameApply.ts`)

"Set by a person" uses the platform's existing convention: a field with a value
and **no** `metadata_provenance` entry was typed or confirmed by someone, because
every automatic filler writes an entry and any edit by hand removes it
(`pruneProvenance`). The content type's entry is `@type`.

| Situation | Type | Fields and title | Link (section 4) |
|---|---|---|---|
| **Ingest** (every path: panel, API, watch folders, providers) | Only rule 1 and 2 not in play, confident, no conflict | Only fields empty after embedded tags, the operator and rules (a rule's default may be replaced) | One clear match links; close matches are kept as suggestions; weak evidence keeps only the name |
| **Read from file name**, one asset | Offered; ticked when it would be applied at ingest | Empty fields ticked; a value a person typed needs its own Replace | The matches with scores and reasons, Let Volt decide, or leave it |
| **Read from file name**, a selection | As ingest | As ingest, and a field filled from the file name earlier may be refreshed | As ingest |

Each value applied records `{source: 'filename', file, token, reason, at, by, was}`
in provenance, and the change is in the audit log. The whole reading (signals,
classification, what was applied and skipped, the match query) is kept in
`vod_assets.filename_analysis`. The ingest rule setting **Read the file name**
(`filenameMetadata`: auto, suggest, off) decides per rung whether this runs.
A probe that disagrees with the name (1080p in the name, 720 lines measured)
keeps the measured value and records a mismatch.

Fields filled for a type: the title (`title`, `headline` or `name`), `series`,
`season`, `episodeNumber`, `year`, `language`, the first date field
(`recordedAt`, `released`, `releaseDate`), and for Trailer / promo its Kind
(`trailerType`). A promo for an episode is titled with the programme ("Show:
Episode 3 (S1)"). An episode with no title of its own uses the account's
template, default `Episode {episode} (S{season})`.

## 4. Content links (`contentLinks.ts`, `relatedMatch.ts`)

**The field.** The Trailer / promo type's **Trailer for** is now a `content`
field (`relation: trailer_for`). Any type can have content fields (Content
Types, type **content**, relation **Trailer or promo for** or **Related to**).
A value is `{id, name}` when linked to a record by its stable id, or `{name}`
when unresolved. A plain string from an older client is read as `{name}`.

**Storage.** Table `content_links`, one row per field per asset: the target id
(or none), the name, who decided (`person`, `auto`, `migration`), confidence,
reasons, and candidates for a person to choose. The asset's metadata keeps a
copy of the value so the form, the EPG (`sub-title`) and schema.org (`about`)
read it as before. A trigger keeps the copy right when the target is deleted
(the link falls back to its name) or restored from the bin (the link comes
back; the bin's generic foreign-key snapshot handles both). Readers heal values
written straight into metadata by an older path.

**Relations and direction.** `trailer_for`: a trailer or promo points at the
record it promotes; the inverse, on that record, is `trailers` ("Trailers and
promos"). `related`: either way. A target may not be the asset itself, a
trailer or a bug (for `trailer_for`), a record of another account, or a record
that already links back on the same relation (no loops).

**Finding the record a trailer promotes.** The query is the reading's title
(or series, for an episode promo), year, season and episode, with promo
markers and tags removed. Candidates are the account's records of other types
whose titles share the query's most telling words. Each is scored:

- title similarity: 1 for an exact match after normalising (case, accents,
  punctuation, "&" as "and", a bracketed year), 0.97 when only "the" or "a"
  differs, otherwise a blend of word overlap and character-pair overlap;
- year: +0.08 when equal, nothing when one apart (production and release
  years differ), -0.4 otherwise;
- season and episode: +0.1 when they match, -0.5 for a different episode,
  -0.15 when the file names an episode and the record is a film, -0.2 when the
  record is one episode and the file names none.

**Decision:** link only when the best is 0.85 or more **and** 0.15 clear of
the next; suggest the records within 0.25 of the best (at least 0.5, at most
five) when it is close or lower; otherwise no link and no suggestion, only the
name. The account setting "Link a trailer to its film when one record matches
clearly" turns linking into suggesting.

**A record arriving later.** After every ingest, unresolved links in the
account are looked at again: one the matcher filled in is re-decided (and may
link now); a name a person typed only gains the new record as a suggestion.

**Migration (0117).** Every schema field `trailerFor` of type string becomes a
content field. Every existing text value: exactly one record in the same
account with that title (or that title plus a bracketed year) becomes a link
by id (`source: migration`); none, or several, keeps the text as an unresolved
name, with a reason saying which. Safe to run again.

## 5. API

- `GET /api/vod/{id}?include=linkedContent`: the default response is
  unchanged; with the include, `linkedContent.links` (outgoing, with state,
  source, confidence, reasons and candidates) and `linkedContent.linkedFrom`
  (incoming, by the inverse relation). One level, summaries only. Unknown
  include values are a 400. See API_STANDARDS.md section 12.
- `GET /api/vod/{id}/links`, `PUT /api/vod/{id}/links/{field}` (`{assetId}` or
  `{name}`), `DELETE /api/vod/{id}/links/{field}`.
- `GET /api/vod/link-candidates?q=&for=&field=`: records by name, best first.
- `GET` and `POST /api/vod/{id}/from-filename`: the preview and apply;
  `POST /api/vod/from-filename` with `{ids}` for a selection (safe mode).
- `/api/ingest/filename-rules`: list, add, change, delete; `builtin/{id}`;
  `settings`; `test` with `{filename}`.

All under the existing permissions: Media library for `/api/vod`, Account
settings for `/api/ingest`. There is no public content route yet; when the
viewer portal (build queue 3.9) adds one, `readLinks` is reused there with the
viewer's access check on each included record.

## 6. Console

- **Metadata form**: content fields are a search-and-pick control. Linked (solid
  box, the record and its type, Change, remove, "Linked automatically, 97%
  sure" with Why this record); name only (dashed box, "Not linked to a record",
  the suggestions with how alike, Find the record); empty (search by name, or
  Keep "…" as a name).
- **Target metadata**: Read from file name beside Fill from EPG; File name and
  Auto link marks on fields; Related content (what it links to, its Trailers
  and promos, Open).
- **Library**: Read from file name on a selection.
- **Ingest Rules**: the File names card (settings, Try a file name, your rules,
  built-in rules) and **Read the file name** on each rule.

## 7. Worked examples

| File name | Type | Title and fields | Link |
|---|---|---|---|
| `7th-voyage-of-sinbad_1958_trailer_1080p.webm` | Trailer / promo, Kind Trailer | 7th Voyage Of Sinbad; resolution 1080p (probe checked) | Looks for "7th Voyage Of Sinbad" (1958) |
| `Movie_Title_2025_Official_Trailer.mp4` | Trailer / promo | Movie Title | Links to "Movie Title (2025)"; with a 1998 film of the same name and no year in the file, both are suggested |
| `bluey_s1_ep01.mp4` | Programme / episode | Episode 1 (S1), series Bluey, season 1, episode 1 | |
| `the-office_s02e01_the-dundies_720p.mov` | Programme / episode | The Dundies, series The Office | |
| `Show_S01E03_Promo.mp4` | Trailer / promo (promo outranks the episode markers) | Show: Episode 3 (S1) | Links to that episode |
| `Jane_Smith_Interview_Highlights.mp4` | Not set: Interview and Clip conflict | Offered with both reasons | |
| `1917.mp4` | Not set | 1917 (never stripped to nothing) | |
