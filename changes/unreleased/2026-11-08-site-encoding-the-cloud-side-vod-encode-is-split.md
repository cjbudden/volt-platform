---
scope: internal
type: added
area: Hybrid Sites
---
Site encoding, the cloud side: vod.encode is split into a plan step and an execute step, and a site can probe and encode a file and hand back only the package, which the cloud verifies before the asset plays. The site worker and the Encode at site placement follow in H4-2.
