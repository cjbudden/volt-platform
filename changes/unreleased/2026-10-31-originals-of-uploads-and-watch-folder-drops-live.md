---
scope: internal
type: added
area: Deployment
---
Originals of uploads and watch folder drops live in the origin bucket on AWS (VOD_SOURCE_DRIVER=s3); encodes, ladders and frame grabs take a scratch copy per job; the origin bucket policy denies the CDN vod-src/ and upload-staging/; new vod-source-store check suite.
