# EPG: XMLTV in and XMLTV out

**Status (10 Oct 2026): OUTPUT BUILT, INPUT NOT BUILT.**

Output shipped as `services/xmltv.ts` + `modules/xmltv.ts`, migration
`0035_xmltv_export.sql`, console drawer **EPG → XMLTV export**, checks
`test/xmltv-pure.check.ts` and `test/xmltv.check.sh` (every document validated
against the XMLTV project's DTD in `test/fixtures/xmltv.dtd`). See *Output, as
built* at the end. The ordering note below still stands: input is the next
piece, and it is the one that unblocks onboarding a customer's existing guide.

## The requirement

XMLTV must be supported as **both**:

- an **INPUT** format: a broadcaster or a guide provider hands us an XMLTV file
  or a URL, and it becomes programmes on our channels;
- an **OUTPUT** format: a customer, an aggregator, a set-top box or a third-party
  guide asks us for XMLTV and we serve our schedule in it.

Both directions, because XMLTV is the interchange format of the guide world. It
is what almost every scraper, PVR, IPTV middleware and guide provider speaks. A
platform that cannot ingest it cannot onboard a customer's existing schedule,
and one that cannot emit it cannot be plugged into anything the customer already
runs. Either gap is a sales objection, not a feature request.

## What we already have to work with

The `programmes` table is close to the right shape, which is the good news: it
already models titled time ranges per channel with an idempotent import key.

| XMLTV concept | Our column | Note |
|---|---|---|
| `<programme start= stop= channel=>` | `starts_at`, `ends_at`, `channel_id` | `span` is a generated TSTZRANGE with a GiST index, so overlap detection is already there |
| `<title>` | `title` | |
| identity for re-import | `source_ref` | already the idempotent upsert key for import diffing |
| `<desc>`, `<category>`, `<episode-num>`, `<credits>`, `<icon>`, `<rating>` | `metadata` JSONB | no dedicated columns yet |
| series / episode | `programme_series` + `series_id` | partial: XMLTV's `episode-num` systems (`xmltv_ns`, `onscreen`, `dd_progid`) need mapping |
| `<channel><display-name>` | `channels.name` | XMLTV channel ids are the customer's, not ours; needs an alias table |

So the work is mapping and transport, not a new data model.

## What the work actually involves

**Input.**

- Parse XMLTV (streaming, not DOM: a year of a 200-channel guide is large).
- Map the file's `channel id` to our channel ids. This needs an **alias table**:
  the customer's XMLTV ids are theirs and will not match our UUIDs, the mapping
  must survive re-import, and it must be editable when they change provider.
- Timezones. XMLTV timestamps carry an offset (`20260902183000 +0100`) and
  sometimes do not. A missing offset has to be resolved against the channel's
  configured timezone rather than assumed UTC, or a whole guide silently shifts.
- `stop` is optional in XMLTV. Where it is absent the end is the next
  programme's start, and the last entry of a file has no end at all — our
  `ends_at` is NOT NULL, so the importer has to resolve this rather than the
  schema loosening to accommodate it.
- Idempotent re-import via `source_ref`, so a nightly refresh is a diff and not
  a duplicate. This is the mechanism `source_ref` was added for.
- Overlaps: a supplied guide will contain them. Reject the file, or accept and
  flag? Flagging is right (their guide, their problem, our job to show it), and
  the `span` GiST index already finds them.

**Output.**

- Emit `<tv>` with `<channel>` and `<programme>` elements over a requested
  window, per channel or per account.
- Stable channel ids in the output. Our UUID is stable and ugly; a configurable
  per-channel `xmltv_id` is what consumers actually want to see, and it should
  default to the UUID rather than being required.
- Serve as a plain authenticated URL a PVR or middleware can poll on a schedule,
  with correct caching headers — that is how these are consumed, not by a
  human clicking export.
- Decide whether as-run (`actual_start`/`actual_end`) or scheduled times are
  emitted. Scheduled is correct for a forward guide; as-run matters for a
  catch-up guide over past content. Probably a query parameter, and it must be
  explicit rather than a default nobody can see.

## Ordering note

Input before output. Ingesting a customer's existing guide is what unblocks an
onboarding; emitting ours matters once there is something worth emitting.

Output is built (below). Input is not started.

## Output, as built (10 Oct 2026)

**Endpoints**

| Route | Auth | Use |
|---|---|---|
| `GET /api/epg/xmltv` | session JWT or secret account key | console download, server-to-server pull |
| `GET /xmltv/<token>.xml` / `.xml.gz` | the token (public) | partner feed a PVR / middleware / aggregator polls |
| `GET /api/epg/channels` | session or key | channel list as JSON (id, xmltvId, name, icon, description, language, medium, tz) |
| `PUT /api/epg/channels/:id/xmltv-id` | session or key | set or clear a channel's XMLTV id |
| `GET/POST /api/epg/xmltv/feeds`, `PATCH/DELETE /api/epg/xmltv/feeds/:id`, `POST …/:id/rotate` | session or key | partner feed management |

Query on `/api/epg/xmltv`: `channelId` (comma list), `pastDays`/`futureDays` or
`from`/`to` (max 93 days), `times=scheduled|asrun`, `tz=local|utc`,
`includeEvents=true`, `lang`, `download=0` to serve inline.

**Decisions taken on the open questions above**

- *Scheduled or as-run:* both, explicit. `times` is a parameter (feed setting),
  echoed in an `X-Volt-Time-Basis` header and a comment at the top of the
  document. An unknown value is a 400, never a silent default.
- *Channel ids:* `channels.xmltv_id`, optional, unique per account, defaults to
  the UUID. Programmes reference the same id.
- *Polling:* partner feeds are their own credential (sha256 stored, shown once),
  scoped per partner, revocable and rotatable without touching other partners.
  `Cache-Control: private, max-age=300`, ETag + Last-Modified, 304 when nothing
  in the window changed; the feed window snaps to the hour so polls inside the
  same hour share an ETag.
- *Times:* channel-local offset by default (`tz` column), computed per instant,
  so a programme either side of a DST change carries the right offset. `tz=utc`
  for consumers that prefer it.
- *Scope:* cancelled programmes and channels with the guide switched off
  (`epg_enabled = false`) are left out. Overlaps are emitted as stored (the
  conflict view is where they are fixed, not the export).

**Metadata mapping** (programme `metadata` → XMLTV element): `subTitle` →
`sub-title`, `description` → `desc`, `credits` / `credits.<role>` →
`credits` (unknown roles as `guest`), `date`/`productionYear` → `date`,
`genre`/`category`/`categories` → `category`, `tags` → `keyword`, `language`,
`icon`/`image` (store keys resolved through the image service) → `icon`,
`url`, `country`, `season`+`episodeNumber` → `episode-num` (`xmltv_ns`, zero
based, plus `onscreen`), `repeat`/`previouslyShown`, `premiere`, `lastChance`,
`isNew`, `subtitles`, `rating`+`ratingSystem`, `starRating` ("4/5"). Radio
programmes carry `<video><present>no</present></video>`.

**Not in this release:** `PUBLIC_BASE_URL` must be set to the public host for
feed and icon URLs to be right outside a dev box; feeds do not yet emit
per-programme geo/blackout information (XMLTV has no element for it); the
Postman collection and API docs page do not list these routes yet.
