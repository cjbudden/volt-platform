# Retention: what goes, what clips keep, and the restore bin

Built 25 Oct 2026. Code: `services/media/retention.ts` (the sweep), `services/media/prune.ts` (clip-aware removal),
`services/media/trash.ts` (the bin), `modules/storage.ts` (API), `pages/StorageRetention.tsx` (Storage page).
Migration 0083. Test: `test/retention-bin.check.ts`.

## When a recording's media is deleted

Retention deletes a recording's run when its rule's delete stage is due, or on a date set by hand. The run is
handled as a whole (every rendition, including the ones retention never registered, such as the 720p beside the 1080p):

| What | Kept | Removed (to the bin) |
|---|---|---|
| Segments | The segments each clip used (`clip_segments`: run, first and last segment) plus one either side, in every rendition, with the init segments and playlists | Every other segment; the whole run directory when no clip was cut from it |
| Encoder stills (Image Library, `media_files` kind keyframe) | Stills inside a clip's time, and any used as a poster | The rest of the run's time: rows and files |
| Storyboard sprite sheets | Sheets that overlap a clip's time | Sheets wholly inside the removed time, their library rows, and a storyboard hour left with none (with its VTT) |
| Media objects | Readable, on hold, the reason saying what was kept ("kept 15 segments that 1 clip were cut from") | Marked deleted when the whole run went |
| The recording row | Always kept, so provenance still reaches it | |

Clips are extracted to their own files and play either way; what is kept is their source, so a clip can be
re-cut, re-trimmed or checked against the original. A held object is never touched by retention again.

The hourly thumbnail sweep (`sweepThumbnails`, by the thumbnail retention days) skips any hour a clip was cut from.

## Recordings in the bucket (AWS, build queue 2.3)

On AWS a run is not on the control plane's disk: the encoder uploads it under
`s3://<bucket>/<kind>/<id>/runs/<runId>/` (2.2). `services/media/s3Runs.ts` is
the bucket side of the same model:

- **Registration.** `reconcileStream` also lists the stream's run folders when
  `MEDIA_STORE_DRIVER=s3`. Every rendition folder of a run (not `thumbs/`,
  `filler/`, `subtitles/`, `id3/`, `captions/`) is a media object keyed
  `run/<runId>/<rendition>`, its location the folder as a prefix, its tier read
  from the segments' storage class. A run whose own playlists changed within
  `MEDIA_S3_LIVE_WINDOW_MS` (5 min) is `writing`; once closed it is listed in
  full exactly once, for its size. The tick passes a stream at most every
  `MEDIA_S3_RECONCILE_MS` (5 min), because listing is billed per key.
- **Cool, archive, restore** go through the S3 driver on the rendition prefix,
  so only the keys under it change class or are restored.
- **Delete of a recording's run** (`pruneS3Run`): the clip rule above, on the
  bucket's keys: nothing kept, every key of the run folder goes and its objects
  are tombstoned; clips cut from it, their segments (one either side), init
  segments and playlists stay, and the objects are held. Deleted at once, not
  to the bin (whether recordings should go through the bin on AWS is 2.3b).
  Exact-frame stills of the run go as on the Mac. Encoder stills and storyboard
  sheets are not touched on AWS yet (2.3c).
- **Leftovers.** A run with no recording is deleted rendition by rendition;
  after the last one, the rest of the run folder goes too
  (`reclaimS3RunLeftovers`), never for the run `current_run.txt` names and
  never when the pointer cannot be read.
- **Missing.** A run folder gone from the bucket loses its location; an object
  with no copy left is marked deleted (`missing` in its history).
- **Never touched:** the stream root (stable playlists, `current_run.txt`),
  another run, another stream's run with the same id.

Tested by `test/s3-recordings-retention.check.ts` against a stand-in S3 client.

## Exact-frame stills

Added 2 Nov 2026 (build queue 3.2). Code: `services/frames/folders.ts`, `services/frames/store.ts`. Migrations 0121 and 0122.
Test: `test/frames.check.ts`.

A still made by `GET /api/vod/:id/frame` or `GET /api/recordings/:id/frame` is a JPEG in the image store, in one folder per owner:

| Owner | Folder (image store key) | Media object (`kind` frame_stills) |
|---|---|---|
| An asset | `derived/<account>/frames/assets/<asset>/<index version>/` | `frames/assets/<asset>/<version>`, owned by the asset alone |
| A capture run | `derived/<account>/frames/streams/<stream>/<run>/<rendition>/` | `frames/run/<run>/<rendition>`, owned by the channel or event |

Where they are is recorded twice, so the clean-up can always find them:

* `frame_stills`: one row per still with its key, `bucket` (the image store's S3 bucket, NULL on a local store), `folder`, `bytes` and `media_object_id`;
* the folder's media object, whose location is the folder's full address: `s3://<bucket>/<IMAGE_S3_PREFIX>/derived/.../` (trailing slash: that tree only) or the directory on disk. It is registered before the first still is written, and its size is the sum of its stills. Storage lists it.

What removes them, usually in this order:

| Rule | What happens | Where |
|---|---|---|
| `FRAME_STILL_TTL_DAYS` (default 7) after a still was last made | That still's file and row go | `pruneFrameStills`, in the frames sweep (every 10 minutes) |
| The asset's index is rebuilt (a re-encode) | Every older version's folder goes at once | `buildAssetFrameIndex` |
| The run is removed (retention delete rung, a date set by hand, `prune-recordings.ts`) | The run's frame folders go with it, straight away and not to the bin (they are made again from any segment that is kept) | `pruneRun` |
| The owner's retention rule reaches its **delete** rung | The folder goes; cold and archive rungs are skipped for stills, which cost more to move than to make again | `sweep` |
| The asset is deleted | The folder is left with no owner and reclaimed by the sweep after the 24 h grace | `sweep` (orphans) |

A still is refused (410) for a folder that retention has already removed, so nothing is ever written outside the clean-up.
Uploaded and watch folder assets have no channel, so no account rule reaches their media objects (their clips' outputs included);
their stills still go by the TTL, by a rebuild and with the asset.

## The restore bin

Nothing removed by retention, `scripts/prune-recordings.ts` or a Media Library delete is destroyed at once:

* files and whole directories move (rename) to `VOLT_TRASH_DIR` (default `volt-app/trash/`), one folder per item;
* Image Library objects move inside the image store to `trash/<item>/...`;
* deleted database rows are kept on the item, parents before children, with the links the delete set to NULL;
* a library asset's packaged media in the S3 origin bucket (`vod/<id>/`: HLS, DASH, FAST ladder variants) moves inside
  the bucket to `trash/<item>/vod/<id>/` (`VOD_STORE=s3`), so the CDN stops serving it at once;
* an original Volt holds in the bucket (`vod-src/...`, `VOD_SOURCE_DRIVER=s3`) and its `.json` or `.xml` sidecar move,
  key by key, to `trash/<item>/vod-src/...`; an original another asset still points at stays where it is. Before
  build queue 2.1a-2c such an original stayed in the bucket for good after the asset was purged.

**On AWS** (`VOLT_TRASH_DRIVER=s3`, set by Terraform) the files and directories above do not wait on the task's
disk: they are uploaded to the origin bucket under `trash/<item>/<group>/<n>/...` and removed from the disk, every
file uploaded before any is removed, so a bucket that cannot be reached fails the removal with nothing moved. A
restore on any task downloads them back to where they were (a file already in its place is kept); the purge deletes
them. The bucket policy keeps `trash/` away from the CDN. On the Mac (`local`, the default) nothing changes.

**Storage > Recently removed** lists the items. **Restore** puts the files, images, rows and links back; a restored
recording's media is readable again and put on hold so the next sweep does not take it straight back (set a date in
the retention list to let it go later). **Delete now** purges one item. Items are purged after `VOLT_TRASH_DAYS`
(default 7) by the hourly retention sweep: that is the real deletion. A Media Library delete, one asset or in bulk,
is held for `VOLT_LIBRARY_TRASH_DAYS` (default 2) instead. The sweep runs every `RETENTION_SWEEP_SECONDS` (default
3600) on the scheduler that holds the leader lock, so an item goes within an hour after its days are up. Recording
S3 tiers are removed directly, not binned. Bulk remove and management confirmation: `docs/BULK_ACTIONS.md`.

## The retention list

**Storage > Retention list**: every recording that still holds media, ordered by the date it will be deleted:

1. a date set by hand (`recordings.delete_after`), earlier or later than the rule; it also applies where no rule does;
2. else the channel's or event's rule: the delete stage's days after the recording ended;
3. else a legacy `expires_at`.

A recording already pruned to what clips use shows **Kept for clips** with no date. Per row: **Change date**,
**Use the rule** (clear the date set by hand), **Keep** / **Release** (a hold on all its media).

## Originals out of the cloud (Mirror and Archive, H3-5)

A rule's `original_after_days` removes an asset's original file from the cloud
that many days after it landed, once a verified archive copy of that file is
held at one of the account's storage targets. Only the original goes; the
renditions play on. Until a sound copy exists it waits, and the reason is
written on the asset and listed under Storage, Mirror and Archive, **Originals
out of the cloud**. `include_uploads` lets an account rule reach uploads and
watch folder files; rules made before it existed have it off. **Restore**
brings a removed original back from its copy (a site server uploads it, the
cloud checks it before the asset uses it), and its clock restarts. An encode
or a FAST channel's Prepare that needs such an original starts the restore by
itself and runs once it lands (`original_restore_then`). A recording of a
stream whose copy rule archives recordings is not deleted (rule or expiry
set by hand) until every consolidated archive file covering it is verified;
the reason is on the recording (`archive_wait`, `services/archive/
recordingWait.ts`) and in the retention list. Details:
`services/archive/originals.ts` and HYBRID_SITES.md, Phase 3j.

## Retention for VOD titles (publishing policies, P5)

Built 12 Nov 2026 (build queue P5). Code: `services/media/vodRetention.ts`, routes in `modules/storage.ts`,
called from the hourly `sweepRetention` after the originals pass. Migration 0178. Test: `test/vod-retention.check.ts`.

Titles in the Media Library are governed by the **Retention** section of their publishing policy
(`services/publishingRules.ts`: `keep` forever or `days`, counted from `anchor` ingest, available_from or
available_until), not by the recording ladder above. The due date is `retainUntil` in `publishingPolicies.ts`,
the same date the editor's conflict check reasons about, and is stored on the title (`retention_due_at`).

| When | What happens |
|---|---|
| 7 days before | Warned once (`retention_warned_at`, a `warned` row in `vod_retention_log`); a date that moves later clears it |
| Due, nothing keeps it | `removeVodAsset` into the restore bin (library bin days), a `removed` log row with the bin item, an audit entry |
| Due, kept | `retention_wait_code` and `retention_wait` on the title, logged when the reason changes |

What keeps a due title, in this order: `legal_hold`; `still_available` (published and its window still open, so it
is never deleted while it can be watched); `in_fast_lineup`; and, when its policy has a copy rule of the original
(Mirror and Archive), the copy-before-delete verdict of H3-5 (`judgeOriginal`: `no_copy`, `copy_pending`,
`copy_failed`, `copy_corrupt`, `copy_missing`, `copy_stale`, `copy_unchecked`, `in_use`, or `no_licence` with the
add-on off). An original already out of the cloud on a verified copy counts as copied.

A legal hold (`legal_hold_at`, `_by`, `_reason`) needs a reason and is refused where the policy has
`legalHoldAllowed` off. A hold that exists always keeps the title, even after the policy turns holds off: the
setting stops new holds and never deletes held material. Up to 200 titles are removed per pass.

Every rung counts: an account is read when a rule, a metadata rule or a title's own setting (the asset rung) keeps
for days (the first build read rules only; fixed in P5-2).

The console (P5-2): **Storage > Titles deleted by their publishing policy** (`TitleRetention` in
`volt-web/src/pages/StorageRetention.tsx`) lists the next 7, 30 or 90 days with why a due title is kept, and places
and releases legal holds (a reason is required).

Not built yet (P5-3): the storage tier move for archived titles (`archiveTier`), and the hold on the asset drawer.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/storage/expiring?within=&q=` | Recordings by expiry, with where the date comes from |
| PATCH | `/api/storage/recordings/:id/expiry` | `{ deleteAfter: ISO \| null, note? }` |
| POST | `/api/storage/recordings/:id/hold` | `{ hold, reason? }` |
| GET | `/api/storage/bin` | The bin (held items, and the last 14 days of restored and purged) |
| POST | `/api/storage/bin/:id/restore` | Put it back |
| DELETE | `/api/storage/bin/:id` | Purge now |
| GET | `/api/vod/:id/delete-impact` | What the delete dialog shows: what goes, posts that stay, `binDays`, and `blocker` (in an active FAST lineup) |
| DELETE | `/api/vod/:id` | Delete an asset into the bin; answers `{ bin, binDays, purgeAfter }` (the asset form's Delete) |
| GET | `/api/storage/vod-retention?within=7` | Titles their policy deletes within N days, due titles something keeps, held titles |
| GET | `/api/storage/vod-retention/log?assetId=` | The titles' retention log |
| POST | `/api/storage/vod/:id/hold` | `{ hold, reason? }` a legal hold (409 `legal_hold_not_allowed` where the policy forbids it) |
| POST | `/api/vod/:id/restore` | Undelete that asset (latest held bin item), with `vod: manage` rather than the storage permission |

## Removed recordings leave the tables, the record stays

Once retention has removed a recording (every media object deleted, `storage_state = 'deleted'`), it no longer shows in Recordings, a source's recording list, or the channel roll-up. A source whose every recording has been removed drops out of the Recordings list. `GET /api/recordings?includeRemoved=1` still returns them for history checks, and a restore from the bin brings a recording back.

Every removal attempt writes a row to `recording_removals` (migration 0145) and an `audit_log` entry: the source, the time the recording covered, when it expired, the trigger (rule, a date set by hand, or the legacy channel keep period), the outcome (`removed`, `kept_for_clips`, `failed`) and what was taken (segments, stills, sprite sheets, media objects, bytes, bin item), or the error. A repeated failure with the same error is logged once a day, not every sweep. The report is `GET /api/storage/removals` (filters: `outcome`, `sourceId`, `from`, `to`, `before`, `limit`) and the Removal log card on the Storage page.
