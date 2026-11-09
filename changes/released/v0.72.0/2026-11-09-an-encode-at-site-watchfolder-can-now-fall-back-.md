---
scope: core
type: added
area: Hybrid Sites
---
An Encode at site watchfolder can now fall back to the cloud. Set If the site does not encode it to a time from 15 minutes to 1 day: when no server of the site has started an encode in that time, the site's agent sends the original and Volt encodes it in the cloud, recording why in the audit log. By default the item still waits for the site and the original never leaves your storage.
