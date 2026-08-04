# Design — File manager + Watchfolder ingest

Two related additions to the requirements: a **file manager** for uploading and
organising assets (watermarks, slates, logos, source media), and a **watchfolder**
workflow that treats a folder or S3 bucket/prefix as an automatic ingest source.

## 1. File manager interface
A browser library for the account's stored files, backed by S3.

Scope / kinds:
- **watermarks / bugs** (PNG with alpha) — used by the encoder overlay,
- **slates / loops** (image or short video) — the existing `filler_assets`,
- **logos / poster art / thumbnails** — consumed by the image service,
- **source media** (progressive files) — for VOD ingest and file-based playout.

Model:
- `media_files(id, account_id, kind, name, source_key, mime, bytes, width, height,
  duration_ms, checksum, status, tags jsonb, created_by, created_at)` — one row per
  stored object, account-scoped. `kind` = watermark | slate | logo | source | other.
- Storage: the account's S3 prefix (`account/{id}/files/...`). Thumbnails/previews
  come from the image service (logos/images) or the keyscreen thumbnailer (video).

API:
- `POST /api/files` → presigned S3 upload (direct-to-S3, no proxying large files
  through the API), then `POST /api/files/confirm` to register + probe metadata.
- `GET /api/files?kind=&tag=&q=` (list/filter), `GET /api/files/:id`,
  `PATCH` (rename/tag), `DELETE` (soft-delete + S3 cleanup on retention sweep).
- Direct-upload is a Prohibited-action-safe pattern: the browser uploads to S3 via
  the presigned URL; the API only records metadata.

UI:
- A grid/list with kind filter, search, tags, drag-and-drop upload with progress,
  and a preview (image service for stills, player for clips). Pickers elsewhere
  (encoder watermark, channel slate, portal logo) read from this same library.

## 2. Watchfolder ingest
Assign a folder or S3 bucket/prefix as an ingest source; new files that land there
are automatically pulled in as `media_files` (and optionally turned into VOD or a
playlist item).

Model:
- `watchfolders(id, account_id, name, kind, config jsonb, target_kind, enabled,
  last_scan_at, created_at)`:
  - `kind = s3 | local` (local = an on-prem agent/SFTP drop; s3 = a bucket/prefix,
    possibly cross-account via an assumed role),
  - `config` = bucket/prefix or path, optional glob, credentials_ref (Secrets
    Manager), delete-after-ingest flag,
  - `target_kind` = what an arriving file becomes: `source` file, `vod` asset,
    `slate`, `watermark`, or a `playlist` append.
- `watchfolder_events(id, watchfolder_id, object_key, status, media_file_id,
  error, seen_at)` — an idempotent record per object so nothing is ingested twice.

How it detects new files:
- **S3**: the clean path is event-driven — an S3 event notification (EventBridge /
  SQS) fires on `ObjectCreated`; a worker validates, copies/registers into the
  account's library, probes metadata, and creates the target. A periodic reconcile
  scan is the backstop for missed events.
- **Local / SFTP**: an on-prem agent (or the desktop bridge) watches the path and
  uploads via the same presigned-upload path; the control plane sees them as
  arriving objects.

Pipeline per arriving file:
1. dedupe against `watchfolder_events` (by object key + etag/checksum),
2. validate (type/size/glob),
3. register a `media_files` row (probe width/height/duration via ffprobe),
4. build the target (VOD asset, slate, playlist append) per `target_kind`,
5. optionally delete the source object, and emit a notification.

Reuses: the same S3 origin, ffprobe metadata, notifications API, and (for VOD) the
existing recording/VOD model. Sits alongside the orchestrator's scheduler as a small
ingest worker.

## Build state
Both are **designed / not started** (tracked rows in the build status). The image
service they lean on (thumbnails/previews) is prototyped; the file manager's
direct-to-S3 upload + metadata model and the watchfolder S3-event worker are the
first pieces to build.
