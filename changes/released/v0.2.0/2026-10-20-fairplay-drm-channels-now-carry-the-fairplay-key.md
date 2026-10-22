---
scope: core
type: added
area: Encoder
---
FairPlay: DRM channels now carry the FairPlay key tag (SAMPLE-AES, com.apple.streamingkeydelivery) in their HLS playlists, using the key URI from your key service, alongside Widevine and PlayReady. The first seconds of each stream are now encrypted too (they were left in the clear).
