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
  the bucket to `trash/<item>/vod/<id>/` (`VOD_STORE=s3`), so the CDN stops serving it at once.

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
watch folder files; rules made before it existed have it off. Details:
`services/archive/originals.ts` and HYBRID_SITES.md, Phase 3j.

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
| POST | `/api/vod/:id/restore` | Undelete that asset (latest held bin item), with `vod: manage` rather than the storage permission |

## Removed recordings leave the tables, the record stays

Once retention has removed a recording (every media object deleted, `storage_state = 'deleted'`), it no longer shows in Recordings, a source's recording list, or the channel roll-up. A source whose every recording has been removed drops out of the Recordings list. `GET /api/recordings?includeRemoved=1` still returns them for history checks, and a restore from the bin brings a recording back.

Every removal attempt writes a row to `recording_removals` (migration 0145) and an `audit_log` entry: the source, the time the recording covered, when it expired, the trigger (rule, a date set by hand, or the legacy channel keep period), the outcome (`removed`, `kept_for_clips`, `failed`) and what was taken (segments, stills, sprite sheets, media objects, bytes, bin item), or the error. A repeated failure with the same error is logged once a day, not every sweep. The report is `GET /api/storage/removals` (filters: `outcome`, `sourceId`, `from`, `to`, `before`, `limit`) and the Removal log card on the Storage page.
