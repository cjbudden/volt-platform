---
scope: core
type: added
area: Hybrid Sites
---
Files encoded at a site now get their ingest sidecar too: when your ingest rules write a .json or .xml sidecar, the site agent writes it beside the original at the site, naming the file as it is there. The watchfolder does not take it in again, and a file of that name you already have is never replaced.
