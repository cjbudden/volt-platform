---
scope: saas
type: fixed
area: Loops & Fillers
---
On AWS, an encoder now uses the fallback loop already built for its stream instead of building its own copy when it starts, so failover is ready sooner and costs the encoder no extra work. The preview of each stream's copy on a slate or loop's details also plays whichever server answers.
