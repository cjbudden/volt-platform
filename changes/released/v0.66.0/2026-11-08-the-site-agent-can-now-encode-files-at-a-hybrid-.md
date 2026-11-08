---
scope: core
type: added
area: Sites
---
Site servers can now be made ready to encode at a Hybrid Site: started with the Volt encoder image, the agent runs the encoder in Docker on the server where the file sits and sends only the finished streams to Volt, which checks every file before the video plays. Encodes planned for an NVIDIA graphics card go only to servers that have one. Choosing Encode at site on an on-prem watchfolder follows in a later release.
