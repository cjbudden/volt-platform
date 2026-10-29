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

## The restore bin

Nothing removed by retention, `scripts/prune-recordings.ts` or a Media Library delete is destroyed at once:

* files and whole directories move (rename) to `VOLT_TRASH_DIR` (default `volt-app/trash/`), one folder per item;
* Image Library objects move inside the image store to `trash/<item>/...`;
* deleted database rows are kept on the item, parents before children, with the links the delete set to NULL.

**Storage > Recently removed** lists the items. **Restore** puts the files, images, rows and links back; a restored
recording's media is readable again and put on hold so the next sweep does not take it straight back (set a date in
the retention list to let it go later). **Delete now** purges one item. Items are purged after `VOLT_TRASH_DAYS`
(default 7) by the hourly retention sweep: that is the real deletion. S3 tiers are removed directly, not binned.

## The retention list

**Storage > Retention list**: every recording that still holds media, ordered by the date it will be deleted:

1. a date set by hand (`recordings.delete_after`), earlier or later than the rule; it also applies where no rule does;
2. else the channel's or event's rule: the delete stage's days after the recording ended;
3. else a legacy `expires_at`.

A recording already pruned to what clips use shows **Kept for clips** with no date. Per row: **Change date**,
**Use the rule** (clear the date set by hand), **Keep** / **Release** (a hold on all its media).

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
