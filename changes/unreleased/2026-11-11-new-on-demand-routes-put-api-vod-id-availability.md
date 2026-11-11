---
scope: core
type: added
area: API
---
New on-demand routes: PUT /api/vod/{id}/availability (Listed from, Unlisted), POST /api/vod/{id}/archive and /unarchive, and POST /api/vod/{id}/evaluate (who can watch). GET /api/vod and GET /api/vod/{id} carry the public status, and the list filters on public_status and expires_within_days.
