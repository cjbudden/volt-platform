---
scope: core
type: added
area: Sources
---
**Validating an HLS source shows what metadata it carries.** Besides checking the playlist and the newest segment, the check now reads now playing from the playlist (the title and artist many radio services put in each #EXTINF) and from the ID3 tags at the start of the segment (title, artist, album, artwork, custom text and Apple's timestamp), and reports subtitle tracks, closed captions, EXT-X-DATERANGE and SCTE-35 markers, and whether the stream carries program date-time.
