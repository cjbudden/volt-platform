---
scope: core
type: added
area: Watchfolders
---
Captions (SRT, WebVTT, TTML/DFXP) and metadata files (JSON, XML/NFO, CSV) dropped into a watchfolder are attached to the video they are named after: Scrubs-s1-e1_en.vtt gives Scrubs-s1-e1.mp4 an English subtitle track in HLS and DASH, with sdh and forced read from the name and the most specific name winning. A file that arrives before its video waits up to 24 hours for it, then goes to review.
