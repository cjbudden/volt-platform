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

## 6. What is missing, honestly

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
5. URL, Drive, Dropbox, OneDrive sources.
6. Package split and a README aimed at a developer who is not us.

## 9. Decisions to confirm

- tus as the wire protocol (recommended) versus keeping the private chunk
  format.
- Picker based cloud sources first (recommended) versus full OAuth adapters.
- Default naming for Volt: `guid` with the original name kept in metadata.
- Default duplicate action: `ask` in the panel, `skip` in watchfolders.
- Default gate: `before_ingest` when the content type has required fields.
