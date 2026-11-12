---
scope: internal
type: added
area: Encoding
---
vod_encoder.py fetches SPEKE keys and passes Shaka the live encoder's cbcs flags for file encodes (dev/test_vod_drm.py); a FAST channel never reuses an encrypted main encode.
