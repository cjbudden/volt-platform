---
scope: internal
type: added
area: Deployment
---
Upload chunks and tus parts wait in the origin bucket on AWS (UPLOAD_STAGING_DRIVER=s3) with a lifecycle rule for forgotten parts; new upload-staging check suite with two API processes.
