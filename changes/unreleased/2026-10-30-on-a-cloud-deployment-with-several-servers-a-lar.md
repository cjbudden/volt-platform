---
scope: core
type: improved
area: Uploads
---
On a cloud deployment with several servers, a large upload's chunks or tus requests can reach any server and the upload still completes; two requests to finish the same upload give one file and the same answer.
