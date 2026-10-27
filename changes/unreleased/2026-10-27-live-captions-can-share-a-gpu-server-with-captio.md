---
scope: internal
type: added
area: Fleet
---
Live captions can share a GPU server: with captions_gpu_sharing on, a Whisper task reserves no GPU and placement packs captions onto a running GPU server while GPU memory and GPU time fit (two small-model streams on one g4dn.xlarge), falling back to a whole GPU when ECS will not start the shared task. Off by default until checked on a real T4.
