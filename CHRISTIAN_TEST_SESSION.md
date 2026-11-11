# Christian's test session

Hands-on checks a scheduled build run cannot do (no Safari, no Mac display, no
live source, no Docker, no real S3, no GPU). Run them once, together, **before
the first AWS deploy**: Part 1 on the Mac, Part 2 on AWS staging once it is up.
Decided by Christian, 11 Nov 2026 (build queue 3.2b-11 and H4-9 deferred here).

When done, tell the queue what passed and what failed (item number and step).
Anything that failed becomes a new queue item.

## Part 1: on the Mac

### A. I-frame trick-play in Safari (build queue 3.2b-11)

Needs real Shaka Packager output, Safari, and a DASH player (and a DASH smart
TV if one is to hand). Everything else for trick-play is built and tested in
Chromium.

1. **Live channel, trick-play on, DASH packaged.**
   - `master_cc.m3u8` lists `<rendition>.iframes.m3u8`.
   - `manifest_cc.mpd` has the trickmode AdaptationSet.
   - `<label>_trick/` segments are written.
   - Safari scrubs the live window and shows pictures while scrubbing.
2. **Same channel, input failover on, loop forced from the Failover panel.**
   - `master_cc.m3u8` lists `<rendition>.iframes_cc.m3u8`.
   - Safari scrubbing over the loop shows the loop.
   - `manifest_cc.mpd` has a trick set in every Period; the loop Period's comes from `filler/<label>/trick/`.
   - A DASH player fast-forwarding over the loop shows the loop.
3. **Rights blackout on that channel** (from the Rights preview).
   - The variant's HLS and DASH scrub and fast-forward to the loop inside the window.
4. **FAST channel, trick-play on.**
   - `master.m3u8` lists `v<h>.iframes.m3u8`.
   - `manifest.mpd` lists a trick set once `trick.json` is beside each title's MPD.
   - Safari scrubs.
5. **An on-demand asset** scrubs in Safari, and on a DASH smart TV if available.

### B. Encoding at a site with Docker (build queue H4-9, Mac half)

Run `VOLT_ENCODER_IMAGE=volt-encoder:<tag> volt-agent site run` on the Mac with Docker up.

1. Drop a file into an **Encode at site** watch folder. The console shows **Queued at site**, then **Encoding at site** with a percentage and the **At site** tag.
2. It is encoded in Docker and plays from the local origin.
3. The source and its `.json` sidecar stay in the folder, and the sidecar is not taken in again.
4. A FAST channel with a ladder gets that title's ladder variant from the site.
5. Kill the agent mid-encode: the lease is reaped after about two minutes and the encode is retried.

## Part 2: on AWS staging (after the first staging deploy)

### C. Encoding at a site into the bucket (build queue H4-9, AWS half)

1. Repeat B.1 to B.5 with the site writing into the staging S3 bucket.
2. Real S3 refuses a wrong checksum with `BadDigest` (the agent reports it and retries).
3. **GPU path** on NVIDIA hardware, if a GPU machine is available: the same drop encodes on the GPU.
