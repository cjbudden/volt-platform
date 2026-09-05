# Media Library: publishing rules, metadata by type, availability

Status: DESIGN (5 Sep 2026). Built so far from this doc: the rename (VOD Library
becomes Media Library) and a preview that works for every asset with the right
surface for audio and for video. Everything else below is proposed for review.

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

## 4. Publishing rules and availability

### 4.1 Default publishing rule (new: `publishing_rules`)

One per account (later: per group / per owner override), with:

- targets: which publications happen automatically on publish (the platform's
  own on-demand catalogue, share page, each social adapter) and their settings;
- availability window: publish immediately or at a time; expire after N days,
  at a date, or never;
- access: geo mode (worldwide / allow / block + countries), rights profile,
  paywall (free / entitlement required / price tier);
- review gate: require approved review and QC pass before auto-publish (the
  existing `publishGate`).

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
and who bills); whether the default rule is per account only or also per group;
whether "On Demand" should be the viewer-facing catalogue name while operators
see "Media Library".
