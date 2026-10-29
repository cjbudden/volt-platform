---
scope: core
type: fixed
area: VOD
---
QC no longer passes an asset it could not measure. An asset with no media, or media that will not open or decode, now fails QC with the reason, and QC reads the HLS manifest a viewer plays rather than an MP4 that a streaming clip never has. The QC panel lists every check: what it found, that it was clean, or why it could not run. A picture with no audio track is reported.
