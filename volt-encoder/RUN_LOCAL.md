# Run the Volt encoder locally (offline, no cloud)

Run the real encoder on your machine, prove each function works over every ingest
transport, and watch a live channel in your browser. It uses a synthetic local
source, so it never depends on an external stream or AWS.

## Requirements (for the full "test all")
- macOS: `brew install ffmpeg`. This must be an ffmpeg BUILT WITH SRT. The Homebrew
  build includes SRT; if `validate.sh` reports SRT missing, run `brew upgrade ffmpeg`
  (or reinstall) so the SRT ingest path can be tested. HLS ingest works on any ffmpeg.
- `python3`.
- Shaka Packager: auto-downloaded into `volt-encoder/.bin/` on first run.

## Quick start
```
cd volt-encoder
chmod +x run-local.sh validate.sh bin/*.sh
bash validate.sh        # tests the real encoder over BOTH HLS and SRT ingest
bash run-local.sh       # continuous live channel; open http://localhost:8088/
```
`run-local.sh` uses HLS by default (any ffmpeg). To drive it over SRT instead:
`MODE=srt bash run-local.sh`. `Ctrl+C` stops it. Output lands in
`volt-encoder/_local_out/out` (HLS `master.m3u8`, DASH `manifest.mpd`, CMAF segments).

## What `validate.sh` proves (test all)
It runs the REAL encoder twice, once per ingest transport, and exits 0 only if every
check passes. For EACH of HLS and SRT it checks: the synthetic ladder starts, the
encoder relay pulls the contribution feed (`-c copy`), Shaka Packager launches, HLS
`master.m3u8` and DASH `manifest.mpd` are produced, the master advertises 3 ABR
renditions, CMAF segments are written, a separate audio track is produced, a 720p
segment decodes as h264 1280x720, and `status.json` is written. If ffmpeg lacks SRT,
the SRT phase fails with the one-line fix, so a missing capability is never hidden.

## Point it at a real feed
`job.local-synth.json` is an example for a real source. Copy it, set your real
SRT/RTMP/HLS input URLs, then:
```
WORK_DIR=./_local_out JOB_CONFIG=./job.local-synth.json python3 bin/run_local_live.py
```
For a single mezzanine to be transcoded into the ladder, set `"workflow":"transcode"`
and add a `ladder` (see `job.example.json`).

## Local vs cloud
Local validates ingest (HLS + SRT), packaging, ABR, live windowing, status and
events. It does not exercise GPU (NVENC) transcode, the captions sidecar, live
SPEKE/DRM, or S3/CloudFront scale; those belong on the Tier-2 cloud stack
(`deploy/terraform/`).
