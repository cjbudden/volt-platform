---
scope: core
type: added
area: Radio
---
HLS and DASH listeners now see the song and artist change inside the stream itself, at the moment it is heard: each title change on a station is carried in the audio as standard ID3 timed metadata, which Safari, hls.js, Shaka and dash.js read with no extra code.
