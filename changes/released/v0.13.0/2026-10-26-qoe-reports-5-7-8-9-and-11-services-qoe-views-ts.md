---
scope: internal
type: added
area: Analytics
---
QoE reports 5, 7, 8, 9 and 11 (services/qoe: views.ts definitions version 2 with ad as its own state, gateLog.ts timed play gate decisions by sid in the analytics database, timeline.ts from the raw reports); a stitched FAST session is named <sid>_<random> so ad beacons join the player's reports. Check suite test/qoe-reports-more.check.ts.
