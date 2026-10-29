# Media Library: publishing rules, metadata by type, availability

Status: BUILT (5 Sep 2026), first release. What exists:

- Rename (Media Library, route /vod) and the preview (MediaPreview.tsx).
- Content types (§3): migration 0026, services/contentTypes.ts (standard
  table, seed, defaults, inheritance, EPG mapping), required on radio / TV /
  event, inherited by clips, /api/epg/now-next `base` + /owner-defaults.
  Console: Admin → Content Types (field editor with EPG slot + schema.org),
  TypePicker + MetadataForm on the event, channel and station forms, and a
  Metadata tab on each library asset.
- Publishing rules and availability (§4): migration 0027, publishing_rules
  (account < schema < owner, per-field inherit), services/publishingRules.ts
  (resolver, target validation against the client's apps + social accounts,
  window), services/availability.ts (publish / withdraw / republish / sweep /
  autoPublishOnBuild / onDemandAccess), /api/publishing-rules, /api/vod/:id/
  availability | publish | withdraw, play gate through rights.evaluateAccess,
  apps as publishing points (publications.platform 'app'). Console: Admin →
  Publishing Rules (account default, points, type + owner rules), the same
  RuleEditor in each channel / station / event's Settings and on a content
  type, and an Availability tab per library asset (state, window, publish,
  remove access, per-item overrides, publishing points).

- Access rules engine and payments (§4.3, §4.4, 5 Sep): `settings.accessRules`
  on any rung (FOR / IF / THEN / TERMS, services/accessRules.ts), viewers,
  products, purchases, entitlements (migration 0028, services/entitlements.ts),
  provider adapters (services/payments/providers.ts), /api/payments, the play
  gate answering 402 paywall / 403 sign in / 451 blocked with the products to
  offer. Console: the rules editor inside every RuleEditor, Admin → Payments.

Not yet built: server-side confirmation with the App Store Server API and the
Play Developer API (events from those two are recorded pending until wired;
Stripe is signature-verified); Stripe Checkout session creation from the
platform (the app creates the session today); real social upload adapters
(stubbed); the encoding profile display for uploads (§5); XMLTV export of the
EPG mapping.

### 4.3 Access rules engine (Christian's model, kept)

Any rung's settings may carry `accessRules`, an ordered list. Each rule:
FOR (this item | linked live content | linked on-demand content, and/or
content types) · IF (viewer located in / not located in these countries;
WORLD = everywhere) · THEN (free | members only, optionally for user groups |
premium for user groups under TERMS). A TERM is a purchasable package: a
period (1 month for 9.99 AUD + 10% tax) or the item's published dates. First
matching rule decides; governed content with no matching region is a geo
refusal; no rule at all falls back to the simple geo / access / paywall
fields. Christian's definitions (5 Sep): `this` is the current channel,
event or station itself, on whichever rung the rule sits (on an item's own
rung, the item); the LINKED items are every VOD or AOD asset made from that
owner's recordings (`ondemand`); `live` is reserved for live streams linked
to the owner once that relation exists.

### 4.4 Payments and entitlements

Providers (App Store, Google Play, Stripe, manual) TAKE the payment. The
platform decides what it buys and for how long: every premium TERM is a
`products` row (key = productKey, grants = the rule it came from, provider
ids set under Admin → Payments); a verified payment is a `purchases` row
(idempotent on the provider's transaction id) and grants an `entitlements`
row (the product's grants copied onto the viewer, valid for the term's
period, extended by renewals, revoked by refund or cancellation). The app
names the viewer (externalId, groups) on the play gate; the gate evaluates
the rules with the viewer's live entitlements. Two paths in: provider
webhooks (raw body, signature-verified where possible) and the app's own
receipt / token / session via /api/payments/verify. Nothing is granted on an
unverified event.

## What Christian asked for (5 Sep)

- Rename VOD Library to On Demand or Media Library. Keep what works: where an
  asset came from (provenance) and where it was published.
- Publishing and availability take several forms. A DEFAULT PUBLISHING RULE is
  set up and configured once; on-demand content applies it automatically when
  published, and any asset can be set by hand instead.
- Metadata is a key part of on-demand: assign it, manage it, and have the system
  assign it BY TYPE. Event live streams must be given a type at setup, and the
  type decides which metadata can be assigned and captured.
- In the absence of a scheduled EPG entry, live content (radio, event, channel)
  still needs a base metadata entry. Radio and channel get one STANDARD schema
  each, built on schema.org recommendations; editable and customisable, but one
  assigned schema per station or channel. Events can have MANY types (town hall
  with speakers, church service, a single sports match, a multi-day multi-sport
  event), each capturing different metadata.
- Each type also decides the EPG metadata fields, within the EPG standard we
  work to.
- The library holds assets made by the recording and clipping tools AND assets
  uploaded as files and encoded. Show the encoding profile. The preview is key,
  with a player suited to audio or to video.
- Publishing and availability need: remove access (content no longer
  available), geo targeting and access rights, paywall settings. A default rule,
  overridable per item of content.
- Start with the preview.

## 1. Naming and route

"Media Library" (the section already contains uploads as well as cuts, and
"On Demand" reads as a viewer-facing product name rather than a place operators
work). Route stays `/vod` so links keep working; the section key stays `vod`.
The label is one line in `App.tsx` if the other name is preferred.

## 2. Preview (BUILT)

`volt-web/src/MediaPreview.tsx`. The server says what the asset is
(`GET /api/vod/:id` now returns `audioOnly`, from the source stream's renditions
or, for an upload with no stream, from the files it produced). Video gets a
`<video>` fed the progressive MP4 or the HLS manifest through hls.js. Audio gets
the same visualiser the station page uses, drawn from the element's own output,
over a play/seek transport, fed the MP3 or M4A if present, else HLS on an
`<audio>` element. A clip cut with the default streaming output previews now;
it used to be a black box.

## 3. Content types and metadata

### 3.1 The model that already exists

`metadata_schemas` (0001_init): named schemas per account with typed fields,
`target_kind` (vod | event | channel | any), a `domain`, and `extends_id` for
composition (inherit a parent's fields, override by key). Channels, events and
assets carry `schema_id` and validated `metadata` JSONB. `schemaOrg.ts` already
emits a schema.org `VideoObject` for an asset and a live object for an owner.

So "type" is not a new table. A CONTENT TYPE is a schema with `target_kind`
set, and what is missing is: (a) a curated set of standard schemas seeded per
account, (b) the rule that a live owner must have one, (c) the EPG field
mapping, and (d) inheritance from owner to derived assets.

### 3.2 Standard schemas (seeded, editable, schema.org-based)

Seeded once per account, `is_standard = true`, editable and cloneable, never
deleted while assigned.

| Type | target_kind | schema.org base | Core fields |
|---|---|---|---|
| Radio station | channel (radio) | RadioStation + BroadcastService | name, genre (enum), language, broadcaster, description, logo, streamingFormat |
| TV channel | channel | TelevisionChannel + BroadcastService | name, genre, language, broadcaster, description, logo |
| Broadcast event (generic) | event | BroadcastEvent | name, description, startDate/endDate (from schedule), performer, organizer, location |
| Town hall / conference | event | Event (BusinessEvent) | speakers[] (Person), agenda[], organizer, location |
| Worship service | event | Event | congregation, officiant, readings[], hymns[] |
| Sports match | event | SportsEvent | sport, homeTeam, awayTeam (SportsTeam with logo), competition, venue, round |
| Multi-sport event | event | SportsEvent (superEvent) with subEvents | sports[], sessions[] (each a Sports match), venue(s), days |
| Clip / highlight | vod | VideoObject / AudioObject | headline, keywords, thumbnail, contentLocation, isPartOf |
| Song | vod | MusicRecording | title, artist, album, genre, ISRC, label, release date, artwork |
| Interview | vod | Interview | title, guests, interviewer, topic, description, keywords |
| Programme (on-demand episode) | vod | Episode / RadioEpisode | series, season, episodeNumber, partOfSeries |

`domain` carries `sports`, `music`, `civic`, `worship`; extends_id lets "Sports
match" extend "Broadcast event".

### 3.3 Rules

- A radio station and a TV channel REQUIRE exactly one assigned schema
  (`channels.schema_id NOT NULL` for those kinds; the create form defaults it
  to the standard one). Their metadata is the BASE ENTRY: when no EPG programme
  is on, the public now/next and the schema.org output fall back to it.
- An event REQUIRES a type at creation (`events.schema_id NOT NULL`); the form's
  first question is "what kind of event is this". The type decides the fields
  captured against the event and against every recording, clip and auto-VOD
  derived from it (inherit `schema_id` and copy the metadata values; the asset
  can override).
- Assets keep their own `schema_id`. Uploads choose a vod-targeted type at
  upload; cuts inherit from the source owner.

### 3.4 EPG field mapping

Each schema field may carry `epg: { as: 'title' | 'description' | 'category' |
'episode' | 'sub-title' | 'credits.<role>' | 'icon' | 'custom:<name>' }`. The
XMLTV / JSON-LD exporters (`DESIGN_epg_xmltv.md`) read that mapping, so a
Sports match's homeTeam/awayTeam land in the EPG as category "Sports" and
credits, and a Town hall's speakers land as credits with role "presenter". A
programme created from an event copies the event's metadata into the
programme's `metadata` JSONB under the same keys.

### 3.5 The account's genre list (BUILT 26 Oct 2026)

A client manages its own genres in **Admin > Media setup > Genres** instead of
living with the fixed platform list. One list per account (`metadata_lists`,
migration 0089, `list_key = 'genres'`); an account with no row uses the
platform default (`DEFAULT_GENRES` in `services/metadataLists.ts`).

- **Linking.** An enum field with `optionsList: 'genres'` takes its options
  from the list. The standard Radio station, TV channel, Broadcast event (and
  its children through inheritance), Song, Programme / episode and Movie types
  are linked; 0089 links existing accounts' standard fields only where the
  options were still the untouched platform list. Content Types can link or
  unlink any enum field (Options: Own list / Genres list).
- **Copied in, not looked up.** On every list save and type save the list is
  written into the linked fields (`options`, plus `retiredOptions`), so every
  reader of `metadata_schemas.fields` (forms, validation, EPG fill, library
  completeness, XMLTV) sees the account's list unchanged.
- **Edits never break what is tagged.** Add and reorder freely. *Retire*: still
  valid where set (the validator accepts `retiredOptions`), not offered, shown
  as "(retired)" on a record that has it. *Rename* in place and *Merge into*
  another rewrite the value on every channel, station, event and asset whose
  type links the list, in the same transaction as the save. *Remove* is
  refused (409, with counts) for a value anything carries. *Reset* restores the
  platform list, keeping used custom values as retired. EPG programmes keep the
  categories they were announced with.
- API: `GET /api/metadata-lists`, `GET|PUT /api/metadata-lists/genres`
  (`{items:[{value,retired?}], renames?:[{from,to}], version?}`, If-Match),
  `POST /api/metadata-lists/genres/reset`. Feature `settings`: read-open,
  manage to change. Every save is in the audit log (`metadata_list`).
- Checks: `test/metadata-lists.check.ts` (38, pure); the SQL (migration,
  usage, rename/merge, sync, reset) was run against Postgres 16.

## 4. Publishing rules and availability

### 4.0 Everything here is CLIENT-LEVEL (added 5 Sep, Christian)

In the SaaS release a client sees and controls only its own content, so every
rule and default in this section belongs to the client account, not to the
platform. Concretely:

- The PUBLISHING POINTS a client can publish to are the client's own:
  - its REGISTERED APPS (`apps` + `api_keys`, the API Keys & Apps page). A
    publication to "the app" means: this asset is available to that app's
    playback keys through the availability gate. An asset can be published
    to some apps and not others (the web app but not the TV app);
  - its SOCIAL ACCOUNTS (`publish_targets`: platform + external account id +
    credential reference), enabled per client. A platform with no registered
    account for the client is not offered at all.
  Both tables already carry `account_id`; the rule is that the publish UI,
  the default rule and the API only ever list and accept targets from the
  caller's account, and the platform never shows a global list.
- The DEFAULT PUBLISHING RULE is a client setting (one per account), set up
  by the client's admin. Per-asset override stays inside the client.
- Publishing links to API Keys & Apps: from an asset's History tab ("Published to"),
  each app publication links to the app's registration; from an app, the
  list of assets published to it. Adding an app to a client makes it a
  publishable point immediately, disabling the app (or its keys) withdraws
  every publication to it.

### 4.1 Publishing rules: a ladder, not one default (new: `publishing_rules`)

Christian, 5 Sep: an account-level default, plus rules by CONTENT TYPE, plus
rules at the level of an individual channel, event or station. So a rule has
a SCOPE, and the most specific scope that matches an asset wins:

| Precedence | Scope | `scope_kind` / `scope_id` | Example |
|---|---|---|---|
| 1 (highest) | the asset itself | (stored on the asset as `custom`) | this one clip goes nowhere |
| 2 | one channel / station / event | `owner` / channels.id or events.id | Sky Sport clips auto-publish to YouTube and the TV app |
| 3 | a content type | `schema` / metadata_schemas.id | every Sports match goes to X and the web app |
| 4 (lowest) | the client account | `account` / null | everything else: web app only, geo worldwide, no paywall |

Resolution is per FIELD, not per rule: a channel-level rule that sets only
the social targets still takes its availability window and paywall from the
content-type rule, and the rest from the account default. That keeps a
station's rule to the two lines that differ. The resolved result is stored on
the asset at publish time (`availability`, `publish_plan`) with the id of the
rule each field came from, so "why did this go to TikTok" has an answer.

One row per scope: `UNIQUE (account_id, scope_kind, scope_id)`. The account
row is created with the account and cannot be deleted; owner and type rows
are optional. The Settings page for a channel, station or event gains a
"Publishing" section that shows the inherited values greyed and lets the
operator override any of them; the Content type editor gets the same section.

Each rule carries:

- targets: which publications happen automatically on publish, chosen ONLY
  from the client's registered apps and enabled social accounts (see 4.0),
  plus the client's share page, and their settings;
- availability window: publish immediately or at a time; expire after N days,
  at a date, or never;
- access: geo mode (worldwide / allow / block + countries), rights profile,
  paywall (free / entitlement required / price tier);
- review gate: require approved review and QC pass before auto-publish (the
  existing `publishGate`).

`publications.platform` gains `app` with `target_id` pointing at `apps.id`
(today `portal` covers the platform catalogue; `app` makes each registered app
its own publishing point).

`vod_assets` gains `availability` JSONB (`{ rule: 'default' | 'custom', from,
until, geo_mode, geo_countries, access, paywall }`) plus `availability_state`
(scheduled | available | expired | withdrawn). "Publish" applies the default
rule and stores the resolved values on the asset; "Edit availability" switches
the asset to `custom` and edits them; "Remove access" sets `withdrawn` now
(kept, not deleted: the asset stays in the library with its history).

### 4.2 Enforcement

`services/rights.ts` today evaluates the CURRENT PROGRAMME's geo for live. It
gains an on-demand branch: the play gate for an asset reads
`vod_assets.availability` (state, window, geo, paywall) and answers allowed /
blocked-with-reason; the public catalogue and share pages omit withdrawn and
expired items; the edge (CF Function + KVS, see the geo/rights design) gets the
same decision published as a small per-asset record so blocking happens at the
CDN, not only at the API.

## 5. Uploaded assets and encoding profile

Uploads already exist (`uploads.ts`, resumable) and encode through the same job
queue. The library row and detail show `source: recording | clip | upload`, the
encoding profile used (ladder or audio rungs, codec, container) from the job
that built it, and the original file's probe (container, codecs, duration,
size). Both kinds of asset share the same preview, metadata, publishing and
availability.

## 6. Build order (proposed)

1. Preview (done) and the rename (done).
2. Standard schemas seeded per account; radio/channel require one; event
   requires a type; forms updated; inheritance to derived assets.
3. EPG field mapping in schema fields and in the exporters.
4. `publishing_rules` + `vod_assets.availability`; Publish applies the rule;
   Edit availability, Remove access; play gate + catalogue enforcement.
5. Upload/encoding profile display in the library.

Open questions for Christian: paywall model (entitlement token vs price tiers,
and who bills); whether "On Demand" should be the viewer-facing catalogue name
while operators see "Media Library".

Answered 5 Sep: rules and defaults are client-account level; publishing points
are the client's registered apps and its configured social accounts only;
rules form a ladder: account default, then by content type, then per channel /
event / station, then per asset (most specific wins, resolved per field).

## 7. Library views, filters and target metadata (BUILT 20 Oct 2026)

The Media Library screen (`/vod`, `volt-web/src/pages/Vod.tsx` and `pages/vod/`)
now has a grid and a list view, server-side filters by content type, target
metadata per type with a completeness measure, EPG auto-fill, and the encode
settings of each asset.

### 7.1 Views

- **List | Grid** toggle (icons and labels) in the toolbar, remembered in this
  browser (`volt.list.vod.view`). Both views share the selection, the bulk bar,
  the sort, the paging and the asset detail.
- **Grid card:** keyscreen through the image service (480x270, lazy), length
  and top rendition on the image, title, content type (with its schema.org
  type on hover), availability pill, metadata completeness, encode summary
  (top rendition, codec, renditions). The checkbox and the card are separate
  controls, so Tab reaches both and Enter opens the card in a drawer.
- **Table:** the existing columns, plus optional ones chosen under
  **Columns** and remembered: Content type and Metadata (on by default), Top
  rendition, Codec, Renditions, Source blocks.
- **Paging** on the server: 48 a page with a total, Previous and Next.
- **Bulk actions:** Fill from EPG (empty fields only, clear matches only) and
  Publish.

### 7.2 Filters (all server side, all in the URL)

| Filter | Page URL | API (`GET /api/vod`, list standard) |
|---|---|---|
| Content type, multi-select with counts | `type=<id>,<id>` | `schema_id=<id>,<id>` (also `schema_key=episode,movie`, `schema_org_type=Episode`) |
| Availability | `avail=available,scheduled` | `availability_state=...` |
| Source | `origin=clip,upload` | `origin=recording,clip,upload,watchfolder` |
| Missing required metadata | `missing=1` | `metadata_missing_required=true` |
| Completeness | | `metadata_completeness[lt]=50`, `sort=metadata_completeness` |
| Top resolution | `res=2160,1080` | `top_height=2160,1080` or `top_height[gte]=1080` |
| Codec | `codec=h264` | `video_codec=h264` |
| Review, stale copy | `review=needs`, `stale=1` | `review_state=...`, `has_stale_publication=true` |
| Date added | `from=2026-10-01&to=2026-10-18` | `created_at[gte]=2026-10-01&created_at[lt]=2026-10-19` |
| Duration (minutes) | `dmin=5&dmax=60` | `duration_ms[gte]=300000&duration_ms[lte]=3600000` |
| Text | `q=harbour` | `q=harbour` (title, file name, source, type, description) |

Filters combine (AND across filters, any-of within one). `GET /api/vod/facets`
takes the same query and returns the count for each choice with every other
filter applied (`types`, `availability`, `origins`, `resolutions`, `codecs`,
`metadata`, and `total`).

New list fields: `schema_key`, `schema_org_type`, `origin`,
`metadata_completeness` (0 to 100, null with no type),
`metadata_missing_required`, `top_height`, `video_codec`, `rendition_count`.

Indexes (migration 0071): `schema_id, created_at`, `top_height`,
`video_codec`, `duration_ms`, the millisecond `created_at, id` keyset, and
`programmes(clip_asset_id)`. `top_height` and `video_codec` are columns kept
by a trigger (`trg_vod_assets_encode_facts`) from `encode_result.kept` for a
file, or from the live output profile for a recording-derived asset, so the
two encode filters are indexable.

### 7.3 Target metadata per content type

Defined in `services/vodLibrary.ts` (`TARGETS`) over the existing standard
types' own field keys. Required first, then recommended.

| Type (schema.org) | Required | Recommended |
|---|---|---|
| Programme / episode (Episode) | title, series, episodeNumber, description | season, genre, rating, image |
| Movie / feature film (Movie, new) | title, description, year | genre, cast, director, rating, image |
| Clip / highlight (VideoObject) | headline, description | keywords, thumbnail |
| Song (MusicRecording) | title, artist | album, genre, released, artwork |
| Interview (Interview) | title, guests | interviewer, topic, description, image |
| Sports match (SportsEvent) | name, sport, competition, homeTeam, awayTeam | venue, round, description, image |
| Multi-sport event (SportsEvent) | name, sports | edition, venues, description, image |
| Broadcast event (BroadcastEvent) | name, description | category, organizer, location, image |
| Town hall, worship service | name | their own fields, description |
| TV channel, radio station (inherited by a clip) | name | description, genre, logo |
| A client's own type | the fields it marks required | all its fields |

- A field the schema itself marks required is always required.
- An asset with no content type counts as missing required metadata.
- A target key the account's copy of a type does not have (seeded before the
  field existed, or edited out) is reported as "not on this type", not as
  missing. Episode gained `rating` and the Movie type was added on 20 Oct;
  existing accounts get Movie on their next seed and keep their Episode copy.
- The asset page's Metadata tab shows the target fields, filled or empty,
  required, and an EPG marker on any value filled from the guide.
- `GET /api/vod/:id/target-metadata` returns the type, the target fields,
  the completeness and the provenance.

**Required is a publish rule, not a save rule (28 Oct 2026).** Content is
created empty and filled in over time: an API create, an upload or a watch
folder item, then edits along the way. So saving never fails because a
required field is empty (`services/metadataValidator.ts`); what is there is
still checked strictly (types, list values, unknown keys). Publishing is where
it counts: the publish gate (`services/review.ts publishGate`, which every
publish goes through: the Publish button, bulk publish, the publishing API,
social, auto-publish rules, republish) refuses with code
`metadata_incomplete` while any required field above is empty, and names
them ("Fill in the required fields before publishing: Headline, Genre."),
also returned as `gate.missingRequired` with each field's label. An asset with
no content type is not held back by this (recording clips often have none);
the list still counts it as missing metadata. The ingest gate
(`DESIGN_uploader_framework.md`, "awaiting metadata") works as before, and its
form can now be saved part-filled. Checked by
`test/publish-required-metadata.check.ts`.

### 7.4 Fill metadata from the EPG

`services/epgFill.ts`.

- **Match:** the programme whose auto-VOD made the asset
  (`programmes.clip_asset_id`) wins. Otherwise programmes of the same channel
  or event overlapping the asset's window, using as-run times when the guide
  has them, ranked by overlap. A match is clear when the best programme
  covers half the asset (or the asset is inside it) and the runner-up overlaps
  less than half as much. An uploaded file has no window and gets no
  suggestions, and says so. A deployment with no guide tables gets none either.
- **Suggestions:** title (the sub-title for an episode, as XMLTV puts the
  series in the title), series, season, episode number (also read from
  "S2E5"), synopsis, genre (only values the type's options allow), rating,
  image, year, cast, director, teams, competition, venue, language, keywords.
  A content type is suggested when the programme says what it is (an episode,
  a film, a fixture), with the values that would not carry over listed.
- **Never overwrite:** empty fields are ticked, filled ones are shown as a
  conflict and only replaced when their own Replace box is ticked
  (`overwrite` in the API). Bulk fill has no overwrite and uses clear matches
  only.
- **Provenance:** `vod_assets.metadata_provenance` holds, per field, the
  programme id and title, when and by whom. A hand edit of that field drops
  its entry. Every fill is written to the audit log as a `vod_asset` update
  with the programme id and the fields.
- Routes: `GET /api/vod/:id/epg-fill` (preview, `?programmeId=` to choose),
  `POST /api/vod/:id/epg-fill` (`fields`, `overwrite`, `applyType`,
  `title`), `POST /api/vod/epg-fill` (bulk, `ids` up to 200).

### 7.5 Encode settings

`GET /api/vod/:id/encode` and the asset page's **Encode** tab: workflow
(transcode or package only), ladder profile, renditions (resolution, bitrate,
codec, profile, frame rate) and the rungs not encoded with the reason, audio
tracks, captions and subtitles, segment duration, packaging (HLS, DASH, MP4),
container, DRM and the source or mezzanine.

Each value says where it came from: stored, derived from the encoder's fixed
settings (marked "derived"), or not recorded.

**Read from the files (22 Oct 2026, build queue 1.4).** `vod_assets.media_facts`
(migration 0077, `services/media/mediaFacts.ts`) holds what ffprobe reads from
the asset's own init segments, each joined with its first media segment
because Shaka writes the H.264 parameter sets in band: per rendition the codec,
profile, level and frame rate, every audio track's codec, channels, sample
rate and language, and any subtitle tracks.

- A file encode writes it when the encode finishes (`vod.encode`), and
  `encode_result` now also records the source's full probe (video codec and
  profile, every audio and subtitle track with its language), the audio track
  the encode took (track 0, AAC 128 kb/s stereo 48 kHz, with that track's
  language), `captions: []` (none carried) and `drm: 'clear'`.
- A recording-derived asset is read the first time its Encode tab is opened,
  from the init segments of the first recording run in its window, and kept.
  For a package-only stream this is the only record of the contributor's codec
  and audio; the Source panel shows them.
- The tab lists, as notes rather than gaps, that a source had more audio
  tracks than the one encoded, that its subtitle tracks are not carried, and
  that a file encode is in the clear.

Still not recorded, and listed on the tab: encodes made before this change
(re-encode to fill them in), and a recording that is not on the control
plane's disk (the S3 origin in production) until a reader for S3 is added.

Recording-derived assets read the live output profile of their stream's group
(rungs, packaging, workflow, segment length, DRM systems, caption languages).
