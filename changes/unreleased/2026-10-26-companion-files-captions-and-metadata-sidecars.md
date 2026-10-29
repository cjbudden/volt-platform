---
scope: core
type: added
area: VOD
---
A new Companion files tab on each asset takes caption and metadata files that belong with it. SRT, WebVTT and TTML captions are checked (timing, overlaps, reading speed, files timed from a timecode) and appear as subtitle tracks in the player for HLS and DASH as soon as they are added, with the language read from the file name. Metadata sidecars (JSON, XML or NFO, CSV) are matched to the asset's fields for you to review and apply.
