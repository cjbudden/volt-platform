# Run the Volt encoder locally (offline, no cloud)

This is the reliable way to run the real encoder on your machine, prove each
function works, and watch a live channel in your browser. It uses a synthetic
local source, so it does not depend on any external stream or AWS.

## What this changes
`run-live.sh` / `job.local-live.json` tested against an external CloudFront feed.
Testing against a remote source mixes several variables together (source
reachability, the relay, the packager, and the local serving layer all at once),
so a single "it did not work" is hard to localise. The tooling here runs the exact
same encoder path against a synthetic local source, removing the source and the
network as variables and checking each function independently. Use `validate.sh`
to confirm the encoder and packager themselves are healthy on your machine; if that
passes but a real feed still fails, the fault is isolated to the source relay or the
serving layer, not the encode/package core.

## Requirements
- macOS: `brew install ffmpeg` (the Homebrew build includes SRT, which is required).
- `python3`.
- Shaka Packager: downloaded automatically into `volt-encoder/.bin/` on first run.

## Quick start
```
cd volt-encoder
chmod +x run-local.sh validate.sh bin/*.sh   # once
bash validate.sh      # runs the real encoder for ~18s, prints PASS/FAIL per function
bash run-local.sh     # continuous live channel; open http://localhost:8088/
```
`Ctrl+C` stops the channel. Output is written to `volt-encoder/_local_out/out`
(HLS `master.m3u8`, DASH `manifest.mpd`, CMAF segments per rendition).

## What `validate.sh` proves (the "what works" gate)
It exits 0 only if every check passes:
- synthetic SRT contribution ladder starts (720p/480p/360p),
- the encoder relays pull the feeds (`-c copy`, no re-encode),
- Shaka Packager launches,
- HLS `master.m3u8` and DASH `manifest.mpd` are produced,
- the master advertises 3 ABR video renditions,
- CMAF segments are written,
- a separate audio track is produced,
- a 720p segment decodes as h264 1280x720,
- the HLS playlists are LIVE (rolling window),
- the encoder writes `status.json`.

## Point it at a real source instead of the synthetic one
The encoder path is identical; only the input changes. Edit `job.local-synth.json`
`inputs[].url` to your real feeds (SRT/RTMP/HLS), then run:
```
JOB_CONFIG=./job.local-synth.json WORK_DIR=./_local_out python3 bin/run_local_live.py
```
For `package_only`, each input is one already-encoded rendition. For a single
mezzanine that should be transcoded into the ladder, set `"workflow":"transcode"`
and provide a `ladder` (see `job.example.json`).

## Local vs cloud
Local is enough to validate correctness of ingest, packaging, ABR, live
windowing, status and events. It does not exercise GPU (NVENC) transcode,
the captions sidecar, live SPEKE/DRM, or S3/CloudFront scale. Those belong on
the Tier-2 cloud stack (`deploy/terraform/`). You do not need the cloud to
validate the pipeline functions above.
