# Run the Volt encoder locally (offline, no cloud)

Run the real encoder on your machine, prove each function works, and watch a live
channel in your browser. It uses a synthetic local source, so it never depends on an
external stream or AWS.

## Requirements
- macOS: `brew install ffmpeg` and `python3`. HLS ingest works on any ffmpeg.
- Shaka Packager: auto-downloaded into `volt-encoder/.bin/` on first run.
- For the full "test all" including SRT ingest: Docker Desktop (see below). Most
  Homebrew ffmpeg builds are compiled WITHOUT SRT (they show `srtp` but not `srt` in
  `ffmpeg -protocols`), so SRT is tested in a Linux container that has it.

## Quick start
```
cd volt-encoder
chmod +x run-local.sh validate.sh validate-docker.sh bin/*.sh
bash validate.sh          # native: tests HLS ingest now; SRT if your ffmpeg has it
bash validate-docker.sh   # TEST ALL: HLS + SRT inside the production Linux runtime
bash run-local.sh         # continuous live channel; open http://localhost:8088/
```
`run-local.sh` uses HLS by default. `Ctrl+C` stops it. Output lands in
`volt-encoder/_local_out/out` (HLS `master.m3u8`, DASH `manifest.mpd`, CMAF segments).

## Testing SRT ingest (Docker, matches production)
The encoder runs in Linux in production, where ffmpeg is built with SRT.
`validate-docker.sh` builds the encoder image from `Dockerfile` (Ubuntu + ffmpeg with
SRT + Shaka + python3) and runs the full validation INSIDE it, so both HLS and SRT
ingest are exercised without touching your Mac's ffmpeg:
```
bash validate-docker.sh   # needs Docker Desktop running; first build takes a few minutes
```
It runs the same checks as `validate.sh`, over both transports, and exits 0 only if all pass.

## What the validation proves (per ingest transport)
For each of HLS and SRT: the synthetic ladder starts, the encoder relay pulls the
contribution feed (`-c copy`), Shaka Packager launches, HLS `master.m3u8` and DASH
`manifest.mpd` are produced, the master advertises 3 ABR renditions, CMAF segments are
written, a separate audio track is produced, a 720p segment decodes as h264 1280x720,
and `status.json` is written.

## Point it at a real feed
`job.local-synth.json` is an example for a real source. Copy it, set your real
SRT/RTMP/HLS input URLs, then:
```
WORK_DIR=./_local_out JOB_CONFIG=./job.local-synth.json python3 bin/run_local_live.py
```
For a single mezzanine to be transcoded into the ladder, set `"workflow":"transcode"`
and add a `ladder` (see `job.example.json`).

## Optional: native SRT ffmpeg on macOS
If you would rather test SRT natively (no Docker), install an SRT-enabled ffmpeg via the
homebrew-ffmpeg tap:
```
brew tap homebrew-ffmpeg/ffmpeg
brew install homebrew-ffmpeg/ffmpeg/ffmpeg --with-srt
```
(unlink your current ffmpeg first if they clash). Verify with `ffmpeg -protocols | grep -w srt`.
Then `bash validate.sh` will run the SRT phase natively too.

## Local vs cloud
Local validates ingest (HLS + SRT), packaging, ABR, live windowing, status and events.
It does not exercise GPU (NVENC) transcode, the captions sidecar, live SPEKE/DRM, or
S3/CloudFront scale; those belong on the Tier-2 cloud stack (`deploy/terraform/`).
