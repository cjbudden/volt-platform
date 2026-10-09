#!/usr/bin/env bash
# Test ALL encoder functions, INCLUDING SRT ingest, inside Docker using a Linux ffmpeg
# built with SRT — the same runtime the encoder uses in production. Nothing changes on
# your Mac's ffmpeg. Requires Docker Desktop running.
set -euo pipefail
ENC="$(cd "$(dirname "$0")" && pwd)"
IMG="${IMG:-volt-encoder:test}"
command -v docker >/dev/null || { echo "ERROR: docker not found. Install/start Docker Desktop." >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo "ERROR: Docker daemon not running. Start Docker Desktop and retry." >&2; exit 2; }
echo "== building encoder test image ($IMG) — first build pulls ffmpeg, a few minutes =="
docker build --build-arg SHAKA_VERSION=v3.4.2 -t "$IMG" "$ENC"
echo "== running the full test-all (HLS + SRT) inside the container =="
# Mount the encoder dir read-write so validate.sh runs its normal flow; it writes only to
# a container temp dir. The image already has ffmpeg (with SRT), python3 and Shaka packager.
docker run --rm -e RUNSECS="${RUNSECS:-18}" -v "$ENC":/enc -w /enc "$IMG" bash validate.sh
