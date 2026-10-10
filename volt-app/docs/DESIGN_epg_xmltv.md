# EPG: XMLTV in and XMLTV out

**Status (10 Oct 2026): BUILT, both directions.**

Output: `services/xmltv.ts` + `modules/xmltv.ts`, migration `0035_xmltv_export.sql`,
console **EPG → XMLTV export**, see *Output, as built*. Input:
`services/xmltvParse.ts` + `services/xmltvImport.ts` + `modules/xmltvImport.ts`,
migration `0037_xmltv_import.sql`, console **EPG → XMLTV import**, see *Input,
as built*. Checks: `xmltv-pure`, `xmltv`, `xmltv-import-pure`, `xmltv-import`
(every exported document validated against the XMLTV project's DTD, and an
export imported back into a second account).

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

Both are built (below).

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

## Input, as built (10 Oct 2026)

**Sources.** One per guide taken in: a URL fetched on a schedule (1 hour to a
week) or files uploaded by hand. Each carries the zone for times with no offset
(default: each channel's own `tz`), how many days of history to keep, an
optional preferred language for multi-language titles, and whether to map
channels automatically.

**Channel aliases** (`epg_channel_aliases`). Every channel id a file names is
recorded per source, with its display name and icon. Auto-mapping takes only an
unambiguous match: a Volt channel whose `xmltv_id` equals theirs, else exactly
one channel with the same name. Everything else waits, unmapped, its programmes
counted and skipped, until somebody picks a channel in the console. Re-pointing
a mapping takes that source's not-yet-aired programmes off the old channel.

**A run.** Gzip and Latin-1 are detected and read; the file streams through the
reader; times are resolved per channel in its zone; a missing stop is the next
start, else `<length>`, else the programme is reported and skipped; writes are
an upsert on `source_ref = xmltv:<source>:<their channel>:<start>`, so the same
file twice changes nothing; inside the span the file covers for a channel,
programmes the file no longer lists are removed, except any with a clip cut
from it. Overlaps are counted and kept. A failed run changes nothing and tells
the account's admins.

**API** (`/api/epg/import`): `GET/POST /sources`, `PATCH/DELETE /sources/:id`,
`POST /sources/:id/run`, `POST /sources/:id/upload` (the file as the body),
`GET /sources/:id/channels`, `PUT /aliases/:id`, `GET /sources/:id/runs`,
`POST /sources/:id/test` (fetch the first request, report, write nothing).

### Hosted guide APIs, kept N days ahead (built 10 Oct)

A URL source can be a guide API rather than a static file, and is kept topped
up on its refresh schedule. `services/xmltvRequests.ts` (pure) plans each run's
requests; migration `0039_xmltv_import_api.sql` adds the settings.

- **URL template.** `{date}` (the day being fetched), `{from}` (today), `{to}`
  (today + days ahead), `{days}`, `{from_unix}`, `{to_unix}`. Dates are written
  in the source's date format (`YYYY-MM-DD`, `YYYYMMDD`, `DD/MM/YYYY`, unix
  seconds) and taken in the source's fallback zone, else UTC. Unknown
  placeholders and a mode that does not match the template are refused on save.
- **Request mode.** `single`: one request for today .. today + days ahead (a
  static file, or an API taking a range). `per_day`: one request per day for the
  same span, for APIs that serve a day at a time. A day that fails is a warning,
  its part of the guide is left exactly as it was (the removal diff runs per day
  that was read), and the run only fails when every day fails.
- **Days ahead** (1 to 21, default 7). Programmes starting at or after local
  midnight after the last day are not imported (counted as beyond the window).
- **Minimum days ahead** (0 to 21, default 5, 0 = off). After each run Volt
  measures, per mapped channel, how far ahead this source's guide reaches
  *continuously*: from now, programme after programme, up to the first hole of
  more than 12 hours (an overnight close-down is not a hole, a missing day is).
  Below the minimum, the run is "with warnings" naming the channels, and owners
  and admins get one `epg.coverage_low` alert; it re-arms once coverage recovers.
- **Headers.** Up to 10 request headers (an API key, say), sealed with the same
  AES-256-GCM key as social tokens. Only the names are ever returned.
- **Unchanged guides.** A scheduled `single` run sends the last ETag /
  Last-Modified; a 304 is a run with "guide unchanged" and no re-import.
  Manual runs, and the first run after any edit or remapping, always read in full.
- **Retries.** A failed run of a scheduled source retries in 15 min, then 30,
  60 ... never later than the refresh interval. Owners and admins are alerted
  on the first failure of a run of them, not on every retry.

Checks: `test/xmltv-import-api-pure.check.ts` 31/31, `test/xmltv-import-api.check.sh`
39/39 against a stand-in guide API (`test/lib/fake-guide-api.py`).

### Channel lineup: choosing and assigning a feed's channels (built 10 Oct)

Tested against xmltv.net's Sydney feed (9 MB, 47 channels, 11,063 programmes
over 8 days). A feed is a lineup, not a channel: "7 Sydney" appears on 7, 70
and 71, SD and HD simulcasts sit side by side (ABC TV on 2, 20 and 21), radio
(Double J, SBS Radio) is mixed with TV, two channels have no programmes, and a
name ends in a tab. Migration `0040_xmltv_lineup.sql`, `services/xmltvLineup.ts`,
console `pages/EpgXmltvLineup.tsx`.

- **Three states per feed channel.** *Used* (on one Volt channel), *not used*
  (`ignored`: skipped quietly, counted as `ignoredChannels`, never a warning),
  *waiting* (new, undecided: skipped and named in the run's warning).
- **New channels** the feed adds later start as waiting, or as not used when
  the source's `new_channels` is `ignore` (big feeds where a few channels matter).
- **Channel number.** `<lcn>` (not in the DTD, common in AU/UK feeds) is read
  and shown first; the lineup is in number order, and same-named channels say
  "Same name as 70, 71: check the number".
- **Automatic use, only when certain.** Our XMLTV id equals theirs, or the name
  is unique on BOTH sides. None of the three "7 Sydney" is matched.
- **One feed channel per Volt channel** within a source (unique index); a
  second is refused naming the one it has. Another source feeding the same Volt
  channel is allowed and flagged "Also fed by …: expect overlaps".
- **Suggestions** (shown, never applied on their own). The feed's regional
  words (in at least a quarter of names: "sydney", "nsw") are set aside and the
  rest compared with our channel names, exactly or without HD/SD/+1. One to
  one: per Volt channel only the best candidate is suggested, a channel with
  programmes first (7mate 74, not the empty 73), then an exact name (SBS on 3,
  not 30), then the lowest number.
- **Bulk.** Select any rows (or all shown): use suggestions, don't use, back to
  waiting, or **create Volt channels** in a group as TV or radio, named after the
  feed channel with its id as the XMLTV id (when free), no stream source yet,
  audited as created from the import. Needs manage on channels.
- **Before the first import.** Try it records the lineup (no programmes), so a
  big feed can be narrowed down before anything is imported.
- **Changing your mind.** Taking a channel out of use, or moving it, removes
  that source's not-yet-aired programmes from the Volt channel it was on.

API: `GET /sources/:id/channels` (state, lcn, programmes in the feed and span,
`sameNameAs`, `suggestion`, `alsoFedBy`, guide coverage), `PUT /aliases/:id`
(`channelId` and/or `ignored`), `POST /sources/:id/channels/bulk`
(`not_used | waiting | accept_suggestions | create`).
Checks: `test/xmltv-lineup-pure.check.ts` 20/20 (the real Sydney lineup),
`test/xmltv-lineup.check.sh` 27/27 (optionally reading a real feed via
`XMLTV_REAL_FEED`).

### Source time zone (built 10 Oct)

Migration `0041_xmltv_source_timezone.sql`. Each source has a **source time
zone** (the zone the guide is for, `fallback_tz`) and a **time mode**:

- **Read as stamped** (default): a time with an offset is exact whatever zone
  is set. xmltv.net's Sydney feed is UTC (`+0000`) and correct: ABC News at
  `08:00 +0000` is 19:00 AEDT, SBS World News 18:30.
- **Ignore the offsets**: every time is local time in the source zone (or each
  channel's zone when none is set), for feeds that stamp local times as `+0000`
  or carry a wrong offset. DST is applied per date.

The source zone now **wins over each channel's own zone** (before, a channel's
zone always won, and every channel has one, so the setting never applied). It
reads times with no offset, decides "today" for `{date}`, `{from}`, `{to}` and
the days-ahead window, and is the zone of channels created from the feed. Not
set: each channel's own zone for times, UTC for dates.

**Changing the zone or the time mode** clears the source's not-yet-aired
programmes (never one with a clip) and re-reads the guide at once, so no copy
is left at the old times. The PATCH answers `reread: { removedProgrammes,
reimporting }`.

**Try it** reports the offsets the feed's times carry (`+0000 (11063)`, or "no
offset"), warns when some have none and no zone is set, and lists a few
programmes as they will land in the source zone next to the raw stamp, so a
known slot can be checked before importing.

Checks: `test/xmltv-import-api-pure.check.ts` 38/38 (offsets, stripping, a
mislabelled feed, DST), `test/xmltv-timezone.check.sh` 16/16 (correct feed,
source zone over the channel's, mislabelled feed fixed and re-read, `{date}` in
UTC+14).
