# Live HTML graphics burn-in for Volt: feasibility spike

Date: 20 Oct 2026. Machine: 2 vCPU, 7 GB, no GPU, ffmpeg 6.1.1, headless Chromium 1194.
Every figure below was measured with the scripts in this folder (see `README.md`). Raw results are in `out/`.

## 1. Verdict: BUILD, with a hybrid edge

A per-channel graphics sidecar (Node + headless Chromium) renders the template only when its state changes. It hands ffmpeg a small alpha PNG by atomic file replace (tmp + rename), and ffmpeg composites it once onto the decoded source, before the ladder split.

| Requirement | Target | Measured | Status |
|---|---|---|---|
| Encoder cost of the overlay (NFR-4) | <= 15 % | +1.9 % static, +3.7 % animating (bbox graphic, 1080p 3-rung ladder, noise about +/-5 %) | Pass |
| Added latency on the main video path | about 0 | +6 ms median (260 vs 266 ms), no extra buffering | Pass |
| State change to burned output (cut) | < 2 s, ideally < 200 ms | 300 ms median (348 max) with `-thread_queue_size 1` | Pass (not the 200 ms ideal) |
| Output never stalls because graphics failed | hard | Sidecar hung 6 s, killed, restarted: no main-path disturbance, graphic holds | Pass, one caveat (section 6) |
| A/V sync | unchanged | identical in every configuration | Pass |
| Sidecar cost | small | idle 1 % CPU, ~200 MB PSS (own Chromium), ~18 MB per extra binding in a shared Chromium | OK |

The hybrid part:
* Continuous animation (tickers, crawls) does not belong in Chromium: 0.83 of a CPU core per channel, permanently. The same crawl done natively in ffmpeg (`drawbox` + `drawtext`, scrolling `x`, reloadable text file) cost nothing measurable.
* Third-party graphics platforms become a "graphics source URL": the sidecar renders any URL with a transparent background. Singular, Viz Flowics, SPX or H2R output pages burn in through the same path, on the customer's own licence.

What did not work: a raw RGBA pipe (stalled the channel 6 s when the sidecar hung, +1.9 s on the main path), `-re` on the graphic input (+1.6 s), `movie=` (never picks up a changed file), Chromium CDP virtual time (captures never return), `overlay=format=auto` (+62 % encode CPU).

## 2. What was built

* `sidecar/sidecar.js`: HTTP state API (`POST/PATCH /state`, `/play`, `/stop`, `/next`, SSE `/events`, `/health`, `/frame.png`). Renders on change, pre-renders transitions at 25 fps, plays them out on a drift-corrected clock, holds the last frame. Atomic PNG output, write errors keep the old file, current frame re-asserted every 2 s.
* `sidecar/vclock.js`: virtual clock injected before template scripts (`performance.now`, `Date`, rAF, timers, Web Animations). Makes unmodified CasparCG-style templates deterministic and seekable.
* Templates with the CasparCG API plus a JSON manifest: `scorebug` (CSS wipe, score flash, accepts CasparCG XML), `lowerthird` (GSAP), `ticker` (rAF crawl).
* `preview/index.html`: operator test and preview page.
* `sidecar/feed_poller.js`: JSON-with-field-mapping and RSS adapter.
* `proposal/composite_once.py`: the `start_transcode()` filter-graph builder (self-tested: watermark + 2 bindings + 3 rungs).

## 3. Encoder CPU (NFR-4)

Method: 30 s 1080p25 source, ladder 1080/720/480 at 5000/3000/1200 kbps, x264 veryfast, closed 4 s GOP, encoded flat out, child CPU via `wait4()`, 5 interleaved runs, median. Baseline spread 42.6 to 46.1 s.

| Variant | CPU-s / 30 s | vs baseline |
|---|---|---|
| Baseline: decode, split, 3 rungs | 44.5 | 0 |
| Composite once, 620x68 bbox graphic, static | 45.3 | +1.9 % |
| Composite once, bbox graphic changing every frame | 46.1 | +3.7 % |
| Composite once, full 1920x1080 transparent canvas | 58.9 | +32.6 % |
| Today's per-rung static watermark | 46.1 | +3.7 % |
| Per-rung dynamic graphic | 46.6 | +4.7 % |
| Native ffmpeg ticker crawl | 43.4 | not measurable |
| Composite once with `overlay=format=auto` | 69.2 | +62 % |

1. Nearly free if the graphic is a bounding box. Cost scales with area, so capture the bbox only (NFR-2 confirmed).
2. Composite-once vs per-rung is a wash at this size. Keep composite-once: cost does not multiply by rungs for large or many graphics.
3. Never use `format=auto`.

## 4. Sidecar: capture, determinism, cost

Capture with `--disable-frame-rate-limit --disable-gpu-vsync`: 672x112 bbox 6.1 ms (31.2 ms default), ticker band 5.5 ms, full frame 29.8 ms. The earlier 33 ms figure was vsync-bound. Step + capture 9 to 11 ms per frame, so transitions pre-render 3 to 4x faster than realtime. First frame ready 15 to 45 ms after the POST.

Determinism: the vclock shim made all three templates deterministic, with jump-to-frame equal to stepping. CDP virtual time never returned captures. GSAP `seek(t)` is deterministic only if paused at `play()`.

| | 1 sidecar | 4 sidecars |
|---|---|---|
| Idle CPU | 1.1 % | 3.9 % |
| 1 cut/s | 6.2 % | 23.8 % |
| 1 animated change/s (stress) | 35.9 % | 184.7 % (2 vCPU saturated) |
| RSS / PSS | 448 / 207 MB | 1877 / 549 MB |

Shared Chromium: 1 page 202 MB, 4 pages 260 MB, 8 pages 334 MB PSS (about 18 MB per binding). Chromium ticker: 25 fps held but 82.8 % of a core.

## 5. Hand-off to ffmpeg

Harness: a producer stamps the wall clock as a barcode into each 720p25 frame, sent as MPEG-TS over UDP with large PTS. The encoder under test composites, splits into a 3-rung ladder and a tap. Main-path latency and freezes are read from the barcode, state-to-output latency from a marker set by `POST /state`.

| Configuration | Main latency | Max frame gap | State to output, median (max) |
|---|---|---|---|
| No graphic | 260 ms | 102 ms | n/a |
| File `image2 -loop 1`, default queue | 267 ms | 92 ms | 576 ms (612) |
| File, `-thread_queue_size 1` | 266 ms | 103 ms | 300 ms (348) |
| File with `-re` | 1854 ms | 99 ms | 217 ms (247) |
| RGBA FIFO at 25 fps | 2153 ms | 6009 ms (sidecar paused) | 91 ms (143) |
| `movie=gfx.png:loop=0` | 261 ms | 102 ms | never updates |

Why: `overlay` syncs by timestamp. An unpaced file input is read on demand and never gates the main path. Anything wall-clock paced on the graphic side couples the channel to it. No `setpts` needed for large PTS. Audio never enters the graph.

| Fault (file hand-off) | Main output | Graphic |
|---|---|---|
| Sidecar frozen 6 s | No disturbance | Held, change appeared 0.5 s after resume |
| Sidecar and Chromium killed | No disturbance | Held last frame |
| Sidecar restarted | No disturbance | Back in < 1 s |
| `gfx.png` deleted 1 s | No disturbance | Frozen until transcoder restart |
| Overwritten in place with garbage | 2.5 s output stall | Frozen |
| File missing at ffmpeg start | ffmpeg refuses to start | n/a |
| FIFO variant, sidecar frozen 6 s | Output stalled 6.0 s | Never recovered |

Torn reads: direct overwrite caused decode errors, tmp + rename gave 0 errors and 0 torn frames.

## 6. Failure modes and mitigations

| Failure | Effect | Mitigation |
|---|---|---|
| Sidecar hang or crash | Graphic holds, channel fine | Supervisor restart, plus a dead-man in `encoder.py` that writes a transparent PNG (per binding: hold or clear) |
| File missing at ffmpeg start | Channel down | `encoder.py` seeds a transparent PNG before every spawn |
| File deleted while running | Graphic frozen | Nothing ever unlinks it |
| Corrupt file | 2.5 s main stall | Single writer, tmp + rename, write errors keep the old file. Residual risk closed in phase 3 |
| Template JS bug | Treated as a hang | Per-page render watchdog |
| Render slower than realtime | Transition late, channel fine | Bbox capture, flags, pool sizing, latest-state-wins |

Caveat: never-stall relies on the file always being a valid PNG. That is code discipline, not an ffmpeg property. Phase 3 replaces it with a small custom ffmpeg source ("latest frame from shared memory") that never blocks or errors, and takes cut latency to 1 to 2 frames.

## 7. Recommended architecture

```
operator panel / REST PATCH / feed poller / RSS
        | state JSON (control plane: overlay_state + audit log)
        v
graphics renderer (shared pool: one Chromium, one page per binding, vclock shim)
   renders on change, bbox PNG with alpha, transitions pre-rendered at 25 fps
        | atomic PNG replace (same host) or HTTP PUT to an encoder-side agent
        v
encoder, TRANSCODE workflow only:
 [src] decode -> overlay(watermark) -> overlay(binding 1..n) -> split=N -> scale -> rungs
                 tickers and clocks: native drawtext in the same chain
```

Changes to `volt-encoder/bin/encoder.py`:
1. `start_transcode()`: replace per-rung `-vf` with one `-filter_complex` (watermark and bindings overlaid once, then `split` and `scale` per rung). See `proposal/composite_once.py`.
2. Graphic inputs: `-thread_queue_size 1 -f image2 -loop 1 -framerate <fps> -i <file>`, `overlay=x:y:eof_action=repeat`. Never `-re`, `-copyts` or `format=auto`.
3. Positions from the manifest bbox on a 1920x1080 canvas, scaled to the source.
4. Seed a transparent PNG per binding before spawn, add the dead-man thread.
5. Tickers and running clocks: `drawbox` + `drawtext=textfile=...:reload=N` in the same chain.
6. Burn-in needs the transcode workflow. Package-only channels have no decode stage, so a burned binding there is refused (or the channel is switched to transcode at full encode cost). The player overlay works everywhere.

Scale: per binding about 1 % CPU idle, 6 % with a 1 Hz clock, a third of a core during a 1 s transition. Encoder side about 0.03 core. Use a shared render pool per encoder host.

## 8. Template contract

Adopt the CasparCG HTML template API so CasparCG, SPX, Loopic and NodeCG-style templates run unmodified: `update(data)` (JSON, also CasparCG XML), `play()`, `next()`, `stop()`, optional `remove()`.

Volt manifest (`<script type="application/json" id="volt-manifest">`): `canvas`, `fps`, `bbox`, typed `fields` (drives the form), `sample` (drives preview), `animation`: `event` or `continuous` (steer continuous to native ffmpeg).

Determinism comes from the runtime (vclock), not from authors. Author rules: transparent body, no network at render, no `<video>`, stay inside the bbox.

## 9. Preview and data inputs

`preview/index.html`: manifest-driven fields with +/- score buttons, JSON editor, Play/Stop/Next, a scaled browser preview of the same template file, and the actual burned frame. Mirrors other writers through SSE (FR-9).

All inputs reduce to `PATCH /state`: operator panel, REST push from a sports feed, a polled JSON URL with a field map (only changes are sent, a dead feed holds last state), RSS or JSON headlines into the native ticker.

## 10. Market check

| Product | What | Cost | Integration |
|---|---|---|---|
| [Singular.live](https://singular.live/pricing) | Cloud HTML graphics, output URL page | Free (watermark), Pro $150/mo per output, Enterprise $350/mo + $100/mo per extra output | Customer's own seat, our sidecar renders their output URL (transparency to verify) |
| [Viz Flowics](https://support.flowics.com/obs/integrating-graphics-with-obs) | Vizrt cloud HTML graphics, URL / NDI / SDI | About US$9,000/yr single output ([reseller](https://creationnetworks.net/products/vizrt-viz-flowics-professional-with-single-output-annual-subscription)) | Output URL into our sidecar |
| [SPX Graphics](https://obsproject.com/forum/resources/spx-gc-html-graphics-enginen-open-source.1078/) | MIT graphics controller and template packs | Free / paid packs | CasparCG-API templates run directly |
| [CasparCG](https://github.com/CasparCG/help/wiki/Media:-HTML-Templates) | Open-source playout with HTML producer | Free | Origin of the API we adopt, wrong shape as our core |
| [NodeCG](https://github.com/nodecg/nodecg) | MIT framework, graphics as web pages | Free | URLs render in our sidecar |
| Loopic | Web editor exporting CasparCG/SPX templates | Unverified | Should run as CasparCG templates |
| H2R Graphics | Desktop graphics app with output URL | Unverified | Output URL into sidecar |
| [AWS Elemental Live](https://docs.aws.amazon.com/elemental-live/latest/ug/graphic-overlay.html) | Encoder with HTML5 motion graphic overlay | Part of encoder | Precedent for this exact feature |

## 11. Build effort (one engineer who knows the encoder)

| Phase | Scope | Effort |
|---|---|---|
| 0 | Composite-once refactor, seeded placeholder, dead-man, package-only guard, tests with this harness | 1 week |
| 1 | Production render pool (vclock, bbox, atomic or PUT hand-off), control-plane state API + SSE + audit, on-air flag, supervisor | 2-3 weeks |
| 2 | Console operator panel + preview, 3-4 shipped templates, data adapters, native ticker and clock | 2 weeks |
| 3 | Custom "latest frame" ffmpeg source, third-party sandboxing and import, external URL sources, chaos tests | 2-3 weeks |

About 5-6 weeks to a shippable live burn-in, 7-9 weeks with hardening. Phases 0 and 1 also serve the player overlay and the offline VoD render.

## 12. Limits of this spike

* Live tests used a 720p ultrafast ladder (2 vCPU). CPU cost was measured offline at 1080p veryfast.
* Latency is producer-to-composite on one host. Packager and player latency are unchanged by the overlay and were not measured.
* Not tested: NVENC, multiple bindings in the live harness (the builder self-tests it), 50/60 fps, HDR.
* Singular and Flowics output-page transparency is inferred, not tested.
