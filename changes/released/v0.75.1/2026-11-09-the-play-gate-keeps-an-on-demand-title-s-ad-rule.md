---
scope: internal
type: improved
area: Playback
---
The play gate keeps an on-demand title's ad rule and asset row in the viewer-path cache, so a warm start reads nothing from the database; a saved or removed rule is announced by a new trigger (migration 0150) and dropped at once.
