---
scope: core
type: added
area: FAST
---
FAST channels report who saw what, and replace for DASH too: Build > Brand & filler > Rights delivery lists every scheduled programme with the viewers who saw it, saw the geo replacement, or were refused, in total and per country, for today, the last 7 or the last 31 days (also GET /api/fast/channels/{id}/rights-report). Viewers are counted in memory as they play and written once a minute without slowing playback or locking the database. DASH viewers outside a title's rights now get the geo replacement as HLS viewers do.
