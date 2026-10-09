# EPG: XMLTV in and XMLTV out

**Status: REQUIRED, NOT BUILT.** Recorded here so it does not live only in a
conversation. There is currently no XMLTV support anywhere in the codebase —
`grep -ri xmltv` across `src/` and `docs/` returns nothing.

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

Neither is started. This file is the note.
