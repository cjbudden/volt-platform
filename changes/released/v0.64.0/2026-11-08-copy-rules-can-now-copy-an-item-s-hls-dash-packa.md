---
scope: core
type: improved
area: Mirror and Archive
---
Copy rules can now copy an item's HLS/DASH package into an S3-compatible store at your site, such as MinIO, as well as to a folder: every playlist and segment goes under one folder in the bucket, each object read back, and nothing already in the store is ever replaced. A package that cannot be finished leaves nothing behind.
