---
scope: internal
type: added
area: Player
---
The web player's Shaka engine ignores I-frame playlists (manifest.disableIFrames), so web viewers keep scrubbing with sprites and never load keyframe lists. New check suite trickplay.
