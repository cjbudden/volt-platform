---
scope: core
type: added
area: API
---
POST /api/vod/bulk/availability applies a preset or a set of fields as many assets' own publishing rule, or clears it, checking each asset as PATCH /api/vod/{id}/availability does; refused assets are listed with why, and ?dryRun=1 shows the result without saving.
