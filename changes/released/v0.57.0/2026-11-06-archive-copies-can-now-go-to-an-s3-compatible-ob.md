---
scope: core
type: added
area: Mirror and Archive
---
Archive copies can now go to an S3-compatible object store at your site, such as MinIO or NetApp StorageGRID, as well as to a folder or NAS share. The store's keys stay on your site's server and are never sent to Volt; every copy is read back from the store and checked against the original before it counts, and nothing in the store is ever overwritten.
