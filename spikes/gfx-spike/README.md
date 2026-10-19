# Volt live HTML graphics burn-in: feasibility spike

Everything here is a throwaway prototype plus the measurement scripts behind
`REPORT.md`. Nothing in `/home/claude/w` was changed.

## Layout

| Path | What |
|---|---|
| `sidecar/sidecar.js` | Graphics sidecar: Node + headless Chromium, HTTP state API, renders on change, plays transitions at 25 fps, hands frames to ffmpeg as an atomically replaced PNG (`--file`) or a steady raw RGBA FIFO (`--fifo`) |
| `sidecar/renderer.js` | Chromium driver: bbox-only alpha capture, four clock modes (`vclock`, `cdp`, `seek`, `realtime`) |
| `sidecar/vclock.js` | Virtual clock shim injected into every template: makes unmodified CasparCG/GSAP/CSS/rAF templates deterministic and seekable |
| `sidecar/feed_poller.js` | Data-source adapter sketch: poll JSON (field mapping) or RSS, PATCH only changed fields |
| `templates/scorebug` | CSS-animated scorebug (wipe on, score flash), CasparCG API |
| `templates/lowerthird` | GSAP-timeline lower third, CasparCG API + optional `seek(t)` |
| `templates/ticker` | rAF continuous crawl (the case that breaks "render on change") |
| `preview/index.html` | Operator test page: fields form + JSON editor, browser preview of the same HTML, sidecar's burned frame |
| `bench/cpu_bench.py` | Encoder CPU: 3-rung ladder, no overlay vs composite-once vs per-rung |
| `bench/clock_eval.js` | Determinism / seekability of each clock mode per template |
| `bench/torn_test.py` | image2 `-loop 1` re-read, torn writes, missing file |
| `bench/live_test.py` | Realtime harness: wall-clock barcode source over UDP with large PTS, encoder under test, latency, stalls, fault injection |
| `bench/ticker_cost.py` | Chromium ticker cost (native drawtext crawl is a `cpu_bench.py` variant) |
| `bench/live_batch.sh` + `live_summary.py` | Runs every live configuration quoted in the report and prints the summary |
| `bench/sidecar_cost.py` | Sidecar CPU / RSS / PSS (Node + whole Chromium tree), idle vs 1 Hz updates vs 1 Hz animated changes, N sidecars |
| `bench/pool_mem.js` | Memory of one shared Chromium with 1/4/8 pages |
| `bench/capture_speed.js` | `Page.captureScreenshot` time, default flags vs `--disable-frame-rate-limit --disable-gpu-vsync` |
| `proposal/composite_once.py` | The proposed `start_transcode()` filter graph builder (composite once, then split), self-testing |
| `out/` | Raw results (JSON / logs) of the runs quoted in the report |

## Run

```bash
npm install                                   # playwright-core, gsap, pngjs (no browser download)
# sidecar + preview page
node sidecar/sidecar.js --template scorebug --port 8190 --file /tmp/gfx.png
#   open http://127.0.0.1:8190/  (preview), or drive it:
curl -XPOST localhost:8190/state -d '{"home":"AUK","away":"WLG","homeScore":1}'
curl -XPOST localhost:8190/play

# ffmpeg side, composite once before the ladder split
ffmpeg -re -f lavfi -i testsrc2=size=1920x1080:rate=25 \
  -f image2 -loop 1 -framerate 25 -i /tmp/gfx.png \
  -filter_complex "[0:v][1:v]overlay=64:44:eof_action=repeat[c];[c]split=3[a][b][d];[a]scale=-2:1080[v0];[b]scale=-2:720[v1];[d]scale=-2:480[v2]" \
  -map [v0] -c:v libx264 -preset veryfast -f null - -map [v1] -c:v libx264 -preset veryfast -f null - \
  -map [v2] -c:v libx264 -preset veryfast -f null -

# measurements
python3 bench/make_assets.py                  # test inputs for the CPU bench
python3 bench/cpu_bench.py 5                  # ~15 min on 2 vCPU
node bench/clock_eval.js
python3 bench/torn_test.py
bench/live_batch.sh                           # ~10 min: none, file, file tqs1, file -re, faults, corrupt, fifo, movie
python3 bench/sidecar_cost.py 1 && python3 bench/sidecar_cost.py 4
node bench/pool_mem.js && node bench/capture_speed.js
python3 proposal/composite_once.py
python3 bench/ticker_cost.py && ONLY=baseline,ticker_drawtext python3 bench/cpu_bench.py 3
```

Chromium is found at `$PLAYWRIGHT_BROWSERS_PATH/chromium_headless_shell-1194/...`.

Port 8090 is taken by the Volt control plane on this box, so the examples use 8190.
Note: `python3 bench/live_test.py` binds UDP 5600 and port 8190.
