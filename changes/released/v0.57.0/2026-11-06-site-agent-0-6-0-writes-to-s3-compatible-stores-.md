---
scope: internal
type: added
area: Site agent
---
Site agent 0.6.0 writes to S3-compatible stores with its own Signature V4 signer (checked against the AWS SDK), single PUT or multipart, If-None-Match on every write; new check suite mirror-archive-s3 runs against moto with IAM auth when ARCHIVE_S3_TEST_ENDPOINT is set.
