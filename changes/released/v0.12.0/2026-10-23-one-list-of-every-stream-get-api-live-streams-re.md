---
scope: core
type: added
area: API
---
One list of every stream: `GET /api/live-streams` returns your channels, radio stations, events and FAST channels together, with search, filters (kind, medium, preset, status, on air, group, dates), sorting, paging and totals. Each row links to its stream summary, its own record and its console page; add `health=true` for the same state, uptime and viewers the Live Streams board shows.
