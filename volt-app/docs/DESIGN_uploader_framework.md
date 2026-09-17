# Design: Volt Ingest, an upload and ingest framework

Christian, 17 Sep 2026: "I used uppy.io before. Can we develop our own
framework, built into Volt, that other developers could also use?" This is the
assessment, the recommendation, and the build plan. First use is Volt itself:
video, audio and images into the Media Library.

## 1. The short answer

Yes, and most of the hard half already exists in this repo. The important
thing to be clear about first is WHERE the value is, because Uppy and "our
own uploader" are not the same product and the comparison is misleading if
they are treated as one.

Uppy is a browser upload UI plus transports. It is MIT licensed, mature, and
does a handful of things very well: a file picker and dashboard, drag and
drop, per-file progress, resumable transfer over the tus protocol, S3
multipart, crash recovery of an in-progress upload (Golden Retriever), and
remote sources through Companion, its server component that streams from
Google Drive, Dropbox, OneDrive, Box, a URL and others into the upload
destination. That is the whole of Uppy. Everything you listed after "show and
track upload progress" is outside it: rules by media type and folder, naming
and GUID policy, honouring or flattening directory structure, duplicate
detection with a configured action, reading ffprobe, ID3 and EXIF metadata,
sidecar files and webhooks to an ingest system, pre-metadata gating, auto
upload, drop folders, S3 and encoder friendly output. Uppy stops the moment the
last byte lands. Volt's product is what happens next.

So the recommendation is to build the framework, but to draw the line in the
right place:

- The INGEST ENGINE is ours, entirely. Sources, rules, naming, dedupe,
  metadata, sidecars, webhooks, destinations, watchfolders, events. Nothing
  off the shelf does this, and it is the part that is both useful to other
  developers and defensible as a code base.
- The WIRE PROTOCOL for browser uploads should be tus, an open resumable
  upload spec (MIT), rather than a private chunk format. That one decision
  makes the server usable from any tus client on day one: Uppy itself, the
  official iOS, Android, Python, Go and .NET clients, and command line tools.
  A developer who already has Uppy on their page points it at Volt and gets
  our rules, metadata and destinations behind it. A developer who wants
  nothing but a script gets tus-py. We do not have to win the UI argument to
  win the platform argument.
- The BROWSER CLIENT is ours too, small, because the version in this repo is
  already ahead of Uppy on one thing (Background Fetch: the upload continues
  with the tab closed on Chromium browsers) and because "one action for the
  basic case, metadata when you want it" is a product feel that is easier to
  own than to configure.

What we should NOT rebuild is the provider OAuth plumbing that Companion
exists for. Section 4 explains the cheaper route to Drive, Dropbox and
OneDrive.

## 2. What Volt already has (about 2,700 lines, all tested)

| Piece | Where | State |
| --- | --- | --- |
| Chunked resumable upload server: sessions, out of order 8 MB chunks, size verified, assembly, expiry | `services/uploads.ts`, `modules/uploads.ts` | built |
| Browser upload manager: singleton that survives navigation, resume after reload, Background Fetch via service worker | `volt-web/src/uploadManager.ts`, `public/upload-sw.js` | built |
| Watchfolder scanner: quiet-time detection, hygiene (junk and part files), quarantine, move before record | `services/watchfolder/scanner.ts` | built |
| Ordered first-match rules (glob, regex, extension, prefix, suffix), accept or reject with reason, folder policy | `services/watchfolder/rules.ts` | built |
| Ingest into the media library, video ingest with ffprobe | `services/watchfolder/ingest.ts`, `videoIngest.ts` | built |
| Watchfolder API with rules CRUD, dry run, scan, items, resolve | `modules/watchfolders.ts` | built |
| Media files library with folders, kinds, tags | `modules/mediaFiles.ts` | built |
| Storage driver interface with tiers, restore, retention | `services/media/storage.ts` | local driver built, S3 driver not yet |
| Content types and strict metadata validation | `services/contentTypes.ts`, `metadataValidator.ts` | built |
| Job queue, notifications, audit, API keys, webhooks for publishing | various | built |

That is the server half of the uploader, the whole of the drop folder story,
and the rules engine's skeleton. What is missing is listed in section 6.

## 3. Shape of the framework

Two packages, one contract between them.

```
packages/
  ingest-core/        server. No Express, no Postgres: pure functions and
                      interfaces (Store, Storage, Source, Probe, Emit).
                      Rules, naming, dedupe, metadata, sidecars, events.
  ingest-server/      tus endpoint + REST + SSE, wired to ingest-core.
                      Express middleware, mountable in Volt or standalone.
  uploader/           browser. Framework free core (queue, tus client,
                      Background Fetch, events) plus a React panel.
```

Volt consumes all three. Another developer can take `ingest-core` alone and
wire their own storage, take `ingest-server` and use Uppy on top, or take
`uploader` and point it at a plain tus server. The pattern already used by
the watchfolder code (an `IngestStore` interface with a Postgres adapter and a
memory adapter in the tests) is the pattern for the whole package.

### 3.1 The lifecycle of one file

```
 pick ──► classify ──► (metadata gate) ──► transfer ──► verify ──► ingest ──► emit
  │           │              │                │            │           │         │
  source   rules engine   required fields   tus / fetch  checksum   destination  sidecar,
  adapter  + name check   before start?     + resume     + dedupe   naming,      webhook,
                                                                    structure    callbacks
```

Every stage is a hook point (section 7). Every stage writes its outcome on the
upload session row, so progress is a query rather than a memory.

## 4. Sources

| Source | How | Cost |
| --- | --- | --- |
| Local files, folders, drag and drop | File System Access API where present, `<input webkitdirectory>` fallback. Folder picks keep the relative path so the structure rule can honour it. | low, exists in part |
| URL | Server side fetch into the transfer stage. HEAD first for size and type, then stream. Signed URLs and HTTP auth headers accepted per link. | low |
| Google Drive, Dropbox, OneDrive | Each vendor's own PICKER (Google Picker, Dropbox Chooser, OneDrive File Picker). The user picks in the vendor UI, we receive a file id or a temporary direct link, the server fetches it. | medium |
| Watchfolders: local, network share, S3 prefix | The existing scanner. Add S3 listing as a second walker and SMB/NFS as "local" mounts. Event driven S3 (ObjectCreated to SQS) later, scan is the backstop. | medium |
| Any tus client | Point it at the endpoint. | none |
| Accelerated transfer (Aspera, Signiant, MASV, S3 Transfer Acceleration) | Provider plugin replaces the transfer stage, section 4.2. | medium per provider |
| Customer S3 bucket, GCS, Azure Blob | S3 server side copy, or AWS DataSync for GCS and Azure. | small to medium |

The picker route is the deliberate alternative to Companion's full OAuth
model. Companion asks for broad "read your whole Drive" scopes, which for
Google means restricted-scope verification and an annual security assessment
before the app is allowed out of testing. A Picker app uses `drive.file`
(access only to what the user picked), which is non-sensitive and needs no
review. Dropbox Chooser and the OneDrive picker hand back direct download
links with no server side token at all. We get the three sources you named
for a fraction of the maintenance, and the framework's source adapter
interface leaves the door open to full OAuth adapters later for anyone who
needs "sync this folder".


### 4.1 Cloud to cloud: never route a cloud file through the home connection

Christian, 17 Sep: a file that lives in Google Drive, Dropbox or OneDrive and
is dragged in from the mounted folder on a laptop goes cloud, to laptop, to
cloud, at the speed of a home ISP. Video files are large. If we can tell the
file is already in a cloud store, the transfer should go provider to AWS and
never touch the laptop.

WHY IT IS WORSE THAN IT LOOKS. Google Drive for desktop, OneDrive Files On
Demand and Dropbox smart sync all show files that are not on the disk at all.
Dragging one into a browser makes the sync client download it first, then
the browser uploads it: the file crosses the home connection twice, and the
laptop needs the disk space in between. A 60 GB camera card from a shoot is
an afternoon.

WHAT THE BROWSER CAN AND CANNOT KNOW. A dropped file arrives with a name, a
size, a modified time and a relative path within the drop. The absolute path
is deliberately hidden by every browser, so the page alone cannot see that a
file came from `~/Library/CloudStorage/GoogleDrive-...`. Detection therefore
has three routes, from cheapest to most complete:

1. THE PICKER. If the file is chosen in the vendor's picker (section 4) it is
   already cloud to cloud: the server fetches it, the laptop moves nothing.
   The panel should offer the pickers prominently, with the words "faster for
   files already in Drive, Dropbox or OneDrive", because the biggest win is
   the operator choosing the right door.
2. CONNECTED ACCOUNT LOOKUP. With a Dropbox or OneDrive account linked to the
   Volt user, a dropped file's name, size and modified time are sent to the
   server before any byte moves, and the server searches the account. Both
   APIs support search by name and, given the drop's relative path, a get
   by path. A match on name and exact size is offered as "This file is in
   your Dropbox. Transfer from there instead?" (or done silently when the
   rule says so). Google Drive is the exception: every scope that allows
   search is a restricted scope with Google's verification and annual
   assessment, so for Google this route is only for accounts that have gone
   through that, and the picker is the default.
3. DESKTOP AGENT. A small Volt desktop agent (the same component the local
   watchfolder design already needs for on prem drop folders) sees the real
   path, recognises the sync roots (`GoogleDrive-*`, `OneDrive-*`,
   `Dropbox-*` under `~/Library/CloudStorage` on macOS, the drive letter or
   `%USERPROFILE%` folders on Windows), knows whether the file is cloud only
   or hydrated, and hands the server a provider plus path. For Dropbox and
   OneDrive that path resolves directly. For Google the agent walks the
   folder names in the account. This is the route that makes plain drag and
   drop do the right thing without the operator thinking about it.

Recommendation: 1 now, 2 with the cloud sources phase, 3 when the desktop
agent is built for watchfolders anyway. The rule set gets one more THEN
field, `transfer = auto | local | cloud`, with `auto` meaning "cloud if we
can find it, local otherwise".

HOW FAST "CLOUD TO CLOUD" ACTUALLY IS, so nobody oversells it. None of the
three providers can push a file into S3 themselves, so the bytes go through
a Volt transfer worker running in AWS: provider to worker to S3, streaming,
nothing written to disk. That worker sits on datacentre bandwidth, so the
practical ceiling is the provider's per-connection rate, and all three
support HTTP Range requests, so the worker fetches a large file as parallel
ranges (eight to sixteen in flight) straight into an S3 multipart upload. In
practice that is hundreds of megabits to a few gigabits per file, against
the tens of megabits of a home upload, and the laptop can be closed the
moment the transfer is queued. When the source is ALREADY on S3 (a
customer's own bucket, a bring your own bucket account) the worker does not
move bytes at all: S3 multipart copy, server side, and a same region copy of
a 60 GB file is seconds. Google Cloud Storage and Azure Blob as sources go
through AWS DataSync, which supports both as locations, for accounts that
keep a library there.

### 4.3 Mobile

Christian, 17 Sep: uploads from phones and tablets must work. Two routes,
both already implied by the decisions above, and one set of specifics that
the panel has to get right:

- PHONE BROWSER. The same panel, and the file input opens the camera roll
  and the Files app on iOS and Android. `accept="video/*,audio/*"` plus a
  second control with `capture="environment"` for "record now and upload".
  Safari suspends a background tab within seconds and has no Background
  Fetch, so the client must treat "resume from the last verified chunk" as
  the normal path on mobile, not the fallback: the session id and token are
  remembered, and reopening the page offers "continue" with the file
  re-picked (the browser will not keep a File handle across a reload).
  Chunk size drops to 4 MB on a cellular connection, and the panel pauses
  automatically on cellular when the account setting says wifi only.
- NATIVE APP. The Volt mobile app (DESIGN_mobile_app_and_ticketed_events)
  uses the official tus clients (TUSKit on iOS, tus-android-client) against
  the same endpoint, with background transfer through the OS (NSURLSession
  background sessions, WorkManager). That is the whole reason tus won the
  protocol decision: the phone SDKs exist and are maintained by someone
  else.
- Metadata on a phone is the gate at its most useful: the operator picks
  the content type and fills the required fields while the upload runs, on
  the same screen, and the gate holds ingest until they are in.

### 4.2 Accelerated and secure transfer: Aspera and friends

For anything the web cannot do well (multi hundred gigabyte deliveries,
lossy long haul links, broadcasters who already own the licences) the
framework should have a first class hook for accelerated transfer tools
rather than pretend the browser is enough. The interface is one
`TransferProvider` per tool:

```
createTransfer(files, destination, rule) -> { spec, launch }
    spec:   what the tool needs to run the job (Aspera transfer_spec,
            a Signiant Jet job, a MASV package request, a presigned
            S3 accelerated URL)
    launch: how the operator's side starts it (browser handoff to the
            desktop client, deep link, portal URL, or nothing)
onEvent(payload) -> progress | complete | failed   (webhook or poll)
```

The upload session is the same row, the same events and the same ingest
pipeline afterwards. The tool replaces the transfer stage only; rules,
naming, dedupe, metadata and sidecars run unchanged when the bytes land.

Prebuilt providers, in the order they matter to the customers we sell to:

- IBM Aspera. The Volt server acts as an Aspera Node API client: it asks the
  customer's Aspera node (or Aspera on Cloud) for a transfer spec with a
  one time token for the destination, hands it to the operator's IBM Aspera
  desktop client through the browser SDK handoff, and follows the transfer
  through the Node API events. FASP does the moving. Also usable server side
  with `ascp` for cloud to cloud and watchfolder pulls from a customer's
  Aspera Shares.
- Signiant Media Shuttle and Jet: the Media Shuttle API for portal driven
  submits with a webhook on completion, Jet for scheduled automated
  transfers between Signiant endpoints.
- MASV: API driven packages and portals, webhook on delivery, straight to
  S3. The pragmatic choice for a customer who has no Aspera licence.
- AWS S3 Transfer Acceleration: not a tool, a different S3 endpoint that
  routes uploads through the nearest CloudFront edge. Costs nothing to
  support in the S3 driver (one flag), no client software, and it is the
  single biggest improvement available to a home upload without leaving the
  browser. Should be on by default for browser uploads to S3.
- FileCatalyst, Resilio and SFTP as later adapters behind the same
  interface, SFTP being the "secure, slow, everyone has it" floor.

Every provider is a plugin package (`ingest-provider-aspera`, and so on) so
the core never depends on a vendor SDK.

## 5. The rules engine

Reuse the shape you built for access rules, because it is already in the
product and operators will meet the same grammar in two places:

```
FOR   source | folder | media type | content type | account default
IF    extension in [...] | mime matches | size | duration | resolution |
      name matches (glob/regex) | path depth | has ID3 | metadata field = ...
THEN  destination, naming, structure, target kind, content type,
      metadata schema, dedupe action, sidecar, webhook, auto upload,
      post-ingest workflow (encode profile, normalise, thumbnail)
```

Same ladder as publishing: account default, overridden by media type,
overridden by the source or folder, with per-field inheritance (an absent key
inherits). First match wins within a rung, ordinal order, exactly as
`watchfolder/rules.ts` does today. The existing `WatchRule` becomes one rung
of this rather than a separate thing.

### 5.1 Naming policy

The function every file passes through, whatever the rule chooses:

```
sanitise(name):
  split extension, keep it, lowercase it
  NFKD normalise, strip diacritics (é -> e)
  replace anything outside [A-Za-z0-9._-] with _
  collapse runs of _ and -, trim them from the ends
  refuse reserved names (CON, NUL, .., empty)
  cap at 200 bytes (S3 keys are 1024 bytes, encoders and NTFS are pickier)
  optional lowercase
```

Modes a rule can pick:

- `honour`: sanitised original name, original kept in metadata.
- `guid`: `{uuid}.{ext}`, original name kept as `original_filename` and as
  the asset title. Default for Volt, because it makes every downstream
  system (S3, encoders, CDNs, players) indifferent to what people call
  things.
- `guid_prefixed`: `{uuid}_{sanitised}.{ext}` when humans still browse the
  bucket.
- `template`: `{yyyy}/{mm}/{content_type}/{sanitised}` for accounts that
  want a readable tree.

Structure modes: `flat` (default), `honour` (relative path from the pick or
drop folder, each segment sanitised), `minimal` (`{account}/{kind}/{yyyy}/{mm}`),
`template`.

### 5.2 Duplicates

Two checks, because they cost different amounts and catch different things:

1. At PICK time, by name: one round trip with the sanitised names of the
   selection, before any byte moves. Cheap, and it is when the operator is
   still looking at the list. Also matches on `original_filename` so a GUID
   rename does not hide a repeat.
2. At VERIFY time, by content: SHA-256 computed during assembly (the server
   already streams the parts once) and checked against the library. Catches
   the same file under a new name.

Actions, configurable per rule: `skip`, `replace` (new version, old object
retained per retention), `version` (keep both, `_v2`), `rename` (suffix and
carry on), `ask` (hold the item, surface it in the panel and in the
watchfolder review list, exactly like quarantine today). Default `ask` in the
UI, `skip` for watchfolders.

### 5.3 Metadata

Extracted server side on the verified file, never trusted from the browser
alone:

- Source type from magic bytes (`file-type`), not the extension. A `.mp4`
  that is a MOV is recorded as a MOV.
- Container and streams via ffprobe (already in the repo): duration, codecs,
  resolution, frame rate, audio channels, sample rate, bit rate.
- Tags via `music-metadata` (MIT): ID3v1/v2, Vorbis, MP4 atoms, FLAC, WAV
  INFO. Title, artist, album, track, year, genre, cover art.
- Images via `exifr`: dimensions, camera, capture time, GPS if present.
- File facts: size, mtime, checksum, original name, original path, source.

The extracted set maps into the content type's fields through a per-type
mapping (ID3 `title` -> `name`, `artist` -> `performer` for Song, and so on),
and anything the operator typed wins over anything extracted. The result is
validated with the strict validator for assets, which we already have.

Output, per rule, any combination of:

- SIDECAR: `{file}.json` (default) or `.xml` beside the object, containing
  the merged metadata, the extraction, the rule that fired and the
  provenance. XMP when a downstream MAM wants it.
- WEBHOOK: signed POST (HMAC, the same scheme as payments and publishing)
  with the same payload, retried with backoff, recorded in the audit log.
- CALLBACK: an in-process hook for Volt itself (create the VOD asset, queue
  the encode).

### 5.4 The metadata gate

Config, not code: `metadata.required = none | before_ingest | before_upload`.

- `none`: one action, the file goes.
- `before_ingest` (recommended default when a type has required fields):
  the bytes start moving the moment the file is picked, the item sits in
  "awaiting metadata" after transfer until the required fields are filled,
  then ingests. Nobody waits on a form to start a 20 GB transfer, and nothing
  reaches the library half described.
- `before_upload`: strict, for accounts that do not want unlabelled bytes on
  the server at all.

`autoUpload = true | false` is the second switch and applies to both the
panel and watchfolders: on, anything added starts (subject to the gate);
off, added items queue until Start.

## 6. Build status

Step 1 is built (17 Sep): `services/ingest/` holds naming, rules, duplicates,
sniff, id3, metadata, payload, events (pure, 97 checks) and pipeline (DB);
migration 0032 adds `ingest_rules`, `ingest_webhooks`, the asset columns and
the session inputs; `/api/ingest` serves the rules, preview, sanitise and
webhooks; the upload finish runs the pipeline and the panel sends folder
paths and shows the ingest outcome. Step 2 is built: `services/ingest/tus.ts` is a tus 1.0.0 router (creation,
creation-with-upload, expiration, termination, checksum) over a store
interface with a memory store for tests and `modules/tus.ts` backing it with
upload_sessions, mounted at `/api/tus` before the JSON parser; completion
goes through the same `completeLanded()` as the chunk protocol. The console
keeps the chunk protocol for its own panel (three chunks in flight,
Background Fetch); `volt-web/src/tusClient.ts` is the small resumable
client for phones, embeds and reference. Step 3 is built: `services/ingest/s3.ts` (a ten-call S3 interface, the real
SDK adapter with Transfer Acceleration, and an in-memory bucket for tests),
`services/ingest/destinations.ts` (local, and S3 multipart with parts in
flight), the pipeline pushing object and sidecar to the configured
destination (`INGEST_DESTINATION`, `INGEST_S3_*`), and
`services/watchfolder/s3walk.ts` mirroring a bucket prefix into local
staging so the existing scanner and ingest run unchanged, quarantines
mirrored back to the review prefix. Step 4 is built: `volt-web/src/IngestPanel.tsx` replaces the Media Library
upload panel (files, folders with their tree, drag and drop of folders,
pick-time preview of rename / duplicate / refuse per file, content type and
metadata entered while the bytes move, auto upload switch, the held list
for the metadata gate and duplicate decisions, camera roll and "record now"
on phones with the tus client), `pages/IngestRules.tsx` edits the ladder
and the webhooks, and `/api/ingest/held`, `/assets/:id/metadata` and
`/assets/:id/duplicate` complete an ingest the rules were holding. Step 5 is built: `services/ingest/sources/` (URL, Dropbox, OneDrive,
Google Drive adapters behind one interface with injected fetch, and the
parallel range fetcher), `providerAccounts.ts` (OAuth link and refresh for
Dropbox, OneDrive and Drive with drive.file only; credentials for Aspera,
MASV, Signiant), the `ingest.remote` job (the worker fetches into the
session's destination and calls `completeLanded()`), `/api/ingest/remote`,
`/locate` and `/providers/*`, and the panel's link box and "in Dropbox:
will transfer cloud to cloud" offer with a way to upload locally instead.
The object is staged on the worker's disk before ingest so extraction can
run; streaming straight into S3 multipart without the staging copy is a
later optimisation. Step 6 is built: `services/ingest/providers/` (the `TransferProvider`
interface; Aspera through the Node API with the transfer spec handed to the
desktop client and progress by hook or poll; MASV and Signiant as portal
driven packages with webhooks; S3 Transfer Acceleration as presigned PUT
URLs signed with SigV4), `services/ingest/transfers.ts` (create, record,
apply events, and when files land run each through the same
`completeLanded()` as an upload), `/api/ingest/transfers` and the
unauthenticated `/api/ingest/transfers/:id/events` callback, a poll on the
watchfolder tick, and "Send with <provider>" in the panel with the portal
link or the Aspera spec. Request shapes are pinned by tests against fakes
and must be verified against a live account before go-live. Step 7 is built: `volt-agent/` (no runtime dependencies) watches folders,
recognises Google Drive, OneDrive and Dropbox sync roots on macOS and
Windows, never reads a cloud-only placeholder from disk, asks Volt to
locate and fetch such files cloud to cloud, and uploads everything else
with tus carrying the relative path and provenance. State survives a
restart. Step 8 is built: `packages/ingest-core` is the distributable package. Its
`scripts/sync.js` copies the pure modules from volt-app (the source of
truth) and patches the two imports that reach outside the core, so the
package compiles with no dependency on Volt; the README is written for a
developer who is not us. `volt-app/test/ingest.sh` (`npm run test:ingest`)
runs all eight suites, 203 checks, in one command with no database.

All eight steps are built. Not yet done, and known: live verification of
the Aspera, MASV and Signiant request shapes against real accounts; the
provider OAuth apps (client ids) for Dropbox, OneDrive and Google;
streaming a remote fetch straight into S3 multipart without the staging
copy; Background Fetch for tus (not possible by design, the chunk protocol
covers it); the Aspera browser SDK on the console page.

## 6.1 What is missing

| Gap | Size |
| --- | --- |
| tus protocol on the server (Creation, Core, Checksum, Expiration, Concatenation for parallel chunks) or adopt `@tus/server` (MIT) behind our session model | medium |
| tus client in the browser client, keeping Background Fetch as the Chromium enhancement | small |
| S3 storage driver (multipart, presigned) and S3 walker for watchfolders | medium |
| URL source and picker based Drive, Dropbox, OneDrive sources | medium |
| Ingest rules as a ladder with the THEN fields above, replacing the flat watchfolder rule set | medium |
| Naming and structure policy, sanitise function | small |
| Duplicate detection (name and checksum) with actions | small |
| Metadata extraction: magic bytes, music-metadata, exifr, mapping to content types | medium |
| Sidecar and signed webhook emitter | small |
| Metadata gate and auto upload switches, "awaiting metadata" state | small |
| Event model (SSE server side, typed events client side) and public hooks | small |
| Bulk queue with concurrency, folder picks, per-item and total progress | small |
| Packaging as three packages with a memory store for tests and docs | medium |

Nothing on the list is research. Estimated at eight to ten working sessions
of the kind we have been doing, in the order below.

## 7. Events and hooks

Browser (typed, unsubscribe returned):

```
added, removed, queued, started, progress {bytes, total, rate, eta},
chunk, paused, resumed, restored, transferred, verifying,
awaiting_metadata, ingesting, ingested {assetId}, duplicate {action},
failed {reason, retryable}, cancelled
```

Server, the same names as SSE on `/api/ingest/events` and as webhook event
types, plus `rule_matched`, `quarantined`, `sidecar_written`,
`webhook_delivered`. A developer writes `uploader.on('ingested', ...)` in
the page or subscribes an endpoint, and gets the same story.

Server hooks for code that embeds the package: `classify`, `beforeTransfer`,
`beforeIngest`, `afterIngest`, `onDuplicate`, each able to change the
decision or veto it.

## 8. Build order

1. Rules ladder, naming, dedupe, metadata extraction, sidecar and webhook,
   as pure `ingest-core` with tests. Wire the existing upload finish and
   watchfolder ingest through it. Volt gets the behaviour before the
   protocol changes.
2. tus on the server over the existing session table, client switched to
   tus, Background Fetch kept. Uppy pointed at it as the compatibility test.
3. S3 driver and S3 watchfolder walker.
4. Upload panel v2: one action, folder picks, bulk, metadata gate, duplicate
   prompts, progress that survives navigation. Replaces the Vod page panel.
5. URL, Drive, Dropbox, OneDrive sources, with the cloud to cloud transfer
   worker (parallel ranges into S3 multipart) and connected account lookup.
   S3 Transfer Acceleration flag in the S3 driver comes with step 3.
6. Accelerated transfer providers: Aspera first, then MASV and Signiant.
7. Desktop agent for local watchfolders and sync root detection.
8. Package split and a README aimed at a developer who is not us.

## 9. Decisions to confirm

- tus as the wire protocol (recommended) versus keeping the private chunk
  format.
- Picker based cloud sources first (recommended) versus full OAuth adapters.
- Default naming for Volt: `guid` with the original name kept in metadata.
- Default duplicate action: `ask` in the panel, `skip` in watchfolders.
- Default gate: `before_ingest` when the content type has required fields.
- Default transfer: `auto` (cloud to cloud whenever the file can be found in
  a connected account, local otherwise) and S3 Transfer Acceleration on.
- Aspera as the first accelerated provider, MASV as the no licence fallback.
