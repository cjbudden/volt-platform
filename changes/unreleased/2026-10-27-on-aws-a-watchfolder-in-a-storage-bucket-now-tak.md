---
scope: core
type: improved
area: Watchfolders
---
On AWS, a watchfolder in a storage bucket now takes a file in as soon as it finishes uploading, usually within seconds, instead of waiting for the next check of the folder. Put the folder under watch/ in Volt's own bucket; every bucket folder is still looked through once an hour in case a file was missed.
