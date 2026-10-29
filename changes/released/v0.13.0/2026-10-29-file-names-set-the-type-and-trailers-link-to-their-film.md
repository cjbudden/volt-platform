---
scope: core
type: added
area: VOD
---
Uploads are read by their file names: S01E03 makes an episode with its series, season and number, "Official Trailer" makes a trailer, and the title is tidied (`7th-voyage-of-sinbad_1958_trailer_1080p.webm` becomes "7th Voyage Of Sinbad"). Only what is clear is applied, nothing you typed or chose is replaced, and **Read from file name** on an asset or a selection shows each reading and why. A trailer's **Trailer for** now links to the film itself: Volt links it when one record matches clearly and suggests the closest ones when it does not. Your own file-name rules live in Ingest Rules, and the API returns linked records with `?include=linkedContent`.
