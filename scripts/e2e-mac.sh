#!/usr/bin/env bash
# The Mac end-to-end run sheet (build queue 1.15). Runs the whole product path
# against the Volt that run-on-mac.sh started and prints PASS, FAIL or SKIP per
# step. The steps and what each one checks are in scripts/e2e-mac.mjs; how to
# run it and what a pass looks like is TESTING_WORKFLOWS.md section 8.
#
#   bash scripts/e2e-mac.sh            # everything (about 15 minutes)
#   bash scripts/e2e-mac.sh --plan     # list the steps, change nothing
#   bash scripts/e2e-mac.sh --only rights,failover
#   bash scripts/e2e-mac.sh --cleanup  # remove what the run made at its end
#
# Settings: VOLT_API (http://localhost:8080), VOLT_EMAIL / VOLT_PASSWORD (the
# demo sign-in), PACKAGER_BIN, PYTHON_BIN, E2E_SOURCE_PORT (8790, and the next
# port for the radio source), E2E_SOURCE_HOST (host.docker.internal with the
# Docker encoder), E2E_ENCODER=docker, E2E_TIME_SCALE (2 doubles every wait).
set -uo pipefail
cd "$(dirname "$0")/.."
command -v node >/dev/null || { echo "node is needed (brew install node)"; exit 2; }
# Same packager lookup as run-on-mac.sh: on PATH, or the binary kept in the repo.
if [ -z "${PACKAGER_BIN:-}" ] && ! command -v packager >/dev/null; then
  if command -v shaka-packager >/dev/null; then export PACKAGER_BIN=shaka-packager
  else for p in packager-osx-arm64/packager-osx-arm64 packager-osx-arm64/packager; do [ -x "$p" ] && [ -f "$p" ] && export PACKAGER_BIN="$PWD/$p" && break; done; fi
fi
exec node scripts/e2e-mac.mjs "$@"
