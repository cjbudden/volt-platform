---
scope: core
type: improved
area: Delivery
---
The CDN now lets players read its own request id (x-amz-cf-id) and request timings, so a player's report can be matched to the CDN's log line. CMCD on requests never changes what is cached: viewers still share one copy of each segment.
