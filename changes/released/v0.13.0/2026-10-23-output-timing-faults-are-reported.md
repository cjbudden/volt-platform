---
scope: core
type: added
area: Encoder
---
Volt now checks the timing of every live output as it is written: audio and video out of step, a rendition that jumps in time, or a track that stops advancing. Each one shows on the Output gate as a timing fault, in plain words. A packaging channel now cuts its segments on the source's own keyframes, so every quality and the audio share the same boundaries. A stream that is running before anything has been pushed to it now says "awaiting source".
