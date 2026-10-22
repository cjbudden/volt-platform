---
scope: internal
type: fixed
---
Clip smart render: the join no longer leaves a gap after the copied middle (23 ms at 25 fps, 30 ms at 50 fps). Each part's length is now taken from its picture, and every render is checked frame by frame for gaps or overlaps before it is used. Smart render stays off by default.
