---
scope: internal
type: added
area: Deployment
---
Terraform adds the watch folder drop queue (SQS with a dead-letter queue), the origin bucket's ObjectCreated notification under watch_s3_prefix, and the control plane's permission to read it; new suite watchfolder-s3-events.
