# Design: metadata from the file name

**Status:** designed 29 Oct 2026 (Christian), not built. Build queue item 3.0.

Many files arrive with no embedded title (no ID3, no container `title` tag, no
sidecar). Today such an asset is titled with its raw file name, for example
`7th-voyage-of-sinbad_1958_trailer_1080p.webm`, and its content type is the
ingest rule's default. People then retype what the file name already said.

This step reads the file name as one more metadata source. It recognises known
tokens (resolution, content type or kind, year, season and episode, and so on),
records each one as a found value, strips it from the name, and treats what is
left as the title. Everything it sets can be corrected by hand, and it can be
run again on demand.

---

## 1. Where it runs, and what wins

It runs in the ingest pipeline after `extract()` (probe, ID3, sidecar) and
before the values are mapped into the content type (`candidates()` in
`services/ingest/metadata.ts` and `packages/ingest-core/src/metadata.ts`). It
runs for every ingest path: panel upload, API, watch folders (local and S3) and
providers.

Order of precedence for a field, highest first:

1. A value a person has entered or corrected on the asset (never overwritten,
   see section 6).
2. Embedded metadata: ID3, container tags, sidecar files.
3. Measured facts from the probe (width, height, frame rate, duration, codecs).
4. **The file name** (this step).
5. Defaults from the ingest rule and the content type.

Two exceptions:

- **Content type.** An ingest rule that names a content type explicitly wins
  over the file name. A rule left on the default lets the file name decide.
- **Resolution and other measured facts.** The probe wins. A file name value
  that disagrees (`1080p` in the name, 720 lines measured) is kept as a found
  value and shown as a mismatch on the asset, which is often worth knowing.

Each ingest rule gets a switch, **Read metadata from the file name**, on by
default.

## 2. The method

1. Take the original file name (not the sanitised storage name, see
   `naming.ts`), drop the extension.
2. Split into tokens on `_`, `-`, `.`, space and brackets, remembering the
   separators so the title can be rebuilt.
3. Match recognisers (section 3) against the tokens. Most work from the right
   end inward, because that is where tags pile up. Season and episode markers
   are matched anywhere.
4. Each match becomes a **found value** (field, value, the token it came from,
   the recogniser, a confidence) and the token is removed. Trailing and leading
   separators are trimmed after each removal.
5. Repeat until no recogniser matches at the end.
6. What remains is the title candidate (or the series name, see section 4).
   Separators become spaces, runs of spaces collapse, and the words are title
   cased (section 5).

**Never strip to nothing.** If removing a token would leave no title, the token
stays in the title. `1917.mp4` is titled "1917", not given year 1917 and an
empty title.

## 3. Recognisers

Matched case-insensitively on whole tokens only (`e1` matches, `the1` does
not). The account can add its own entries (section 7).

| Recogniser | Examples | Sets |
|---|---|---|
| Resolution | `2160p` `4k` `uhd` `1080p` `1080i` `720p` `576i` `480p` `sd` `hd` `fhd` | `resolution` found value (and height where explicit) |
| Frame rate | `25p` `29.97` `50i` `60fps` | `fps` found value |
| Content type and kind | a content type's key or name (`trailer`, `movie`, `episode`, `interview`, `clip`, `song`), or a value of a type's Kind list (`teaser`, `promo`, `featurette` belong to Trailer), plus synonyms (`tlr`, `trl`) | content type; for a kind, the parent content type **and** its Kind field |
| Year | four digits from 1900 to next year | the content type's year field: `year` (Movie), `releaseDate` year (Trailer), `released` (Song); otherwise a `year` found value |
| Date | `2026-10-29` `20261029` `29.10.2026` | the type's date field (`recordedAt`, `released`), otherwise a found value |
| Season | `s1` `s01` `season1` `season 1` `series1` `series 1` | `season` |
| Episode | `e1` `e01` `ep1` `ep01` `eps1` `eps01` `episode1` `episode 1` | `episodeNumber` |
| Season and episode together | `s01e03` `S1E3` `1x03` | `season`, `episodeNumber` |
| Part | `pt1` `part1` `part 1` | `part` found value |
| Language | `en` `eng` `[EN]` `th` `tha` (ISO 639-1 and -2 codes on the account's language list) | `language` |
| Video and audio codec | `h264` `x264` `avc` `hevc` `x265` `h265` `av1` `aac` `ac3` `5.1` `stereo` | found values only (probe wins) |
| Version and workflow words | `v2` `final` `master` `clean` `textless` `web` `bcast` | found values only, removed from the title |

A token that could be two things (`e1` as episode, `en` as language) is taken as
the one its position supports. If still ambiguous it is recorded with low
confidence and left in the title, so the person decides.

## 4. Episodes

When a season or episode marker is found, the asset is an episode:

- Content type becomes **Programme / episode** (unless a rule or a stronger
  token says otherwise).
- The text **before** the marker is the **series** name (`series` field).
- Text **after** the marker, if any, is the episode's own title:
  `the-office_s02e01_the-dundies` gives series "The Office", season 2,
  episode 1, title "The Dundies".
- With no text after the marker, the title is built from a template, default
  **`Episode {episode} (S{season})`**, or `Episode {episode}` with no season:
  `bluey_s1_ep01.mp4` gives series "Bluey", season 1, episode 1, title
  "Episode 1 (S1)". The account can change the template.

## 5. Title case

Separators become spaces, then the first letter of each word is capitalised and
the rest left as typed when it is mixed case (`McDonald`, `iPhone` keep their
case) or lowercased when the whole name was in one case. Tokens starting with a
digit keep their letters lowercase (`7th`, `1st`, `2nd`). An account setting
offers **headline style** instead, which keeps short words lowercase except at
the start (`7th Voyage of Sinbad`). Default: every word capitalised, as asked.

## 6. Found values, corrections and running it again

Everything this step finds is stored with the asset under
`metadata.ingest.filename`:

```json
{
  "source": "7th-voyage-of-sinbad_1958_trailer_1080p.webm",
  "ranAt": "2026-10-29T00:13:00Z",
  "found": [
    { "token": "1080p",   "field": "resolution",  "value": "1080p", "recogniser": "resolution", "confidence": "high", "probe": "1920x1080", "applied": false },
    { "token": "trailer", "field": "contentType", "value": "trailer", "recogniser": "contentType", "confidence": "high", "applied": true },
    { "token": "trailer", "field": "trailerType", "value": "Trailer", "recogniser": "kind", "applied": true },
    { "token": "1958",    "field": "releaseDate", "value": "1958", "recogniser": "year", "confidence": "medium", "applied": true }
  ],
  "title": "7th Voyage Of Sinbad"
}
```

The asset's Metadata tab shows a **Found in the file name** panel listing each
value, the token it came from and whether it was applied.

**Corrections win.** A field a person has edited (the edit audit already records
who changed which field) is never overwritten by this step, on ingest or on a
re-run, unless the person ticks it in the preview.

**Manual trigger.** **Read from file name** on the asset (Metadata tab) and as a
bulk action on a Library selection. It runs the same step, then shows a preview
(current value, proposed value, the token) with a tick per field. Fields a
person edited start unticked. Apply writes the ticked values and an audit entry.
Also `POST /api/vod/:id/metadata/from-filename` (`?dryRun=1` for the preview)
and the bulk form for a list of ids.

## 7. Account rules

Under Admin > Ingest, **File name rules**:

- Extra synonyms for a content type or kind (`tlr` > Trailer, `pkg` > Clip).
- Extra tokens to strip with a field, or with no field (house codes such as
  `ABC_` prefixes or `_MASTER`).
- The episode title template and title case style.
- A test box: type a file name, see the tokens, found values and the title,
  which is also how support explains a result to a customer.

Rules are data on the account, not code, and the built-in list in section 3 is
the default set every account starts with.

## 8. Worked examples

**`7th-voyage-of-sinbad_1958_trailer_1080p.webm`**

| Step | Remaining name | Found |
|---|---|---|
| Drop extension | `7th-voyage-of-sinbad_1958_trailer_1080p` | |
| `1080p` is a resolution; strip, trim `_` | `7th-voyage-of-sinbad_1958_trailer` | resolution 1080p (probe checked) |
| `trailer` is a Kind of Trailer / promo; strip, trim `_` | `7th-voyage-of-sinbad_1958` | content type Trailer / promo, Kind Trailer |
| `1958` is a year; the type has a release date; strip, trim `_` | `7th-voyage-of-sinbad` | release date year 1958 |
| No recogniser matches; this is the title | `7th voyage of sinbad` | |
| Title case | **7th Voyage Of Sinbad** | |

For a trailer the same name also fills **Trailer for** ("7th Voyage Of Sinbad").

**`bluey_s1_ep01.mp4`**: series Bluey, season 1, episode 1, type Programme /
episode, title **Episode 1 (S1)**.

**`the-office_s02e01_the-dundies_720p.mov`**: series The Office, season 2,
episode 1, title **The Dundies**, resolution 720p.

**`1917.mp4`**: title **1917** (never strip to nothing), no year set.

**`ABC_interview_jane-smith_20261028_v2.mxf`** with `ABC` as an account strip
token: type Interview, recorded 28 Oct 2026, title **Jane Smith**.

## 9. Tests

A table-driven test of the parser with every example above plus 40 or so real
file names from the demo assets and watch folder fixtures; the ingest suite
proving precedence (ID3 title beats the file name, a rule's explicit type beats
the file name, probe resolution beats the name and records a mismatch); the
re-run proving an edited field is untouched unless ticked.
