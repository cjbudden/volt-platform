---
scope: core
type: added
area: FAST
---
**Audio FAST channels are a clear choice.** New FAST channel now asks "Video channel" or "Audio channel (radio)", and each channel's library and Find media offer only its own media: video for a video channel, audio and songs for an audio channel (the filters can narrow inside that, never leave it). Audio channels get ad breaks too: house spots from audio in the library, and stitched ads where the ad server is told the inventory is audio (`[MEDIA_TYPE]`, `[AD_TYPE]`, `[INVENTORY_TYPE]` tag macros) and an audio creative is preferred.

**Key metadata in the manifests.** Every programme marker in HLS (`EXT-X-DATERANGE`) and DASH (`EventStream`) now carries the programme's description, genre, series, season, episode, rating, year, language, artist and album, the asset and its length, and what is next (title, start, subtitle, image), for players' now and next displays. Up next cards carry the next programme's key fields too. The Volt player exposes them as `programme.meta` and `nextProgramme`, even with stream graphics off.
