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
- Publishing links to API Keys & Apps: from an asset's "Where it went",
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
