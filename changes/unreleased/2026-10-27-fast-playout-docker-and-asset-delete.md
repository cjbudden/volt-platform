---
scope: core
type: fixed
area: FAST
---
FAST channels now play when Volt runs with the Docker encoder launcher (run-on-mac.sh): the playout runs on the host, as it does with the local launcher, instead of never starting and leaving the channel at "Starting". The FAST channel page has a **Start** button (and Restart the playout) like a live channel, and a **QC** drawer that checks the run order, guide, media, playout, output manifest, what is on air, the public URL, watermark and ads. Deleting a media asset no longer fails with "operator does not exist: bigint = uuid" when something linked to it (review notes, QC runs, ad rows) is keyed by a number rather than a uuid.
