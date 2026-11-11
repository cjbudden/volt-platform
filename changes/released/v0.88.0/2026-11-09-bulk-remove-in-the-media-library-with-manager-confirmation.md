---
scope: core
type: added
area: Media Library
---
Remove several assets at once from the Media Library bulk bar. The dialog lists what goes and what cannot (an asset in an active FAST lineup), you type the number to confirm, and everything goes to Storage > Recently removed with Undo. Library deletes, single or bulk, are now kept for 2 days before the hourly cleanup deletes them for good (VOLT_LIBRARY_TRASH_DAYS). A new account setting, off by default, sends bulk actions by people below administrator to an administrator or owner to approve first. In production storage the packaged HLS and DASH in the origin bucket now go into the bin too: before this they stayed in the bucket, still playable, and were never cleaned up.
