#!/bin/bash
# Runs the live harness configurations quoted in REPORT.md, one after another.
cd "$(dirname "$0")/.."
run() { echo "=== $*"; timeout 200 python3 bench/live_test.py "$@" > out/live/run_${@: -1}.txt 2>&1; pkill -f "[s]idecar/sidecar.js"; pkill -f "[u]dp://127.0.0.1:5600"; sleep 2; }
run --gfx none --secs 30 --tag none
run --gfx file --secs 30 --tag file
run --gfx file --secs 30 --tqs 1 --tag file_tqs1
run --gfx file --secs 30 --gfx-re --tag file_re
run --gfx file --faults --no-corrupt --tag file_faults
run --gfx file --faults --tag file_faults_corrupt
run --gfx fifo --faults --tag fifo_faults
run --gfx movie --faults --no-corrupt --tag movie_faults
python3 bench/live_summary.py
