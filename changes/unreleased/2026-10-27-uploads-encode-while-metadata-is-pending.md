---
scope: core
type: fixed
area: VOD
---
An upload whose content type has a required field left empty (a bug's Advertiser, for example) is now encoded straight away, with its renditions, thumbnails and preview sprites, instead of sitting at "No media" until the field is filled. Uploaded H.264 / AAC MP4 and MOV files also get an MP4 beside HLS and DASH, and the asset page shows the source file's full technical details: container, size, duration, overall and per-stream bitrates, codec with profile and level, resolution, aspect, frame rate, scan, bit depth, colour, and every audio and subtitle track.
