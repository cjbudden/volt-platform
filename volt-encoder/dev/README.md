# volt-encoder/dev — developer harness, NOT part of the product

Everything in this folder predates the control plane. None of it is used by the
running system, and knowing that is the point of the folder existing.

**Nothing here is referenced by:**

- `run-on-mac.sh`, the way the product is actually started
- the control plane (`volt-app`), which spawns only `bin/encoder.py`,
  `bin/radio.py`, `bin/thumbnailer.py` and `bin/test-stream.sh`
- the production images: `Dockerfile` copies `bin/`, `Dockerfile.radio` copies
  three named files, `Dockerfile.captions` copies one
- any of the check suites in `volt-app/test/`

## Why it was confusing

`run-local.sh` starts a synthetic source, runs the real encoder, and serves
`player.html` from `python3 -m http.server` on :8088. That page looks like an
interface, and it is not the console: it is a bare hls.js page with no API, no
database and no authentication behind it. Somebody arriving at it reasonably
concludes the product has a second, older front end. It does not.

There were also three different "run it locally" entry points, which is two too
many:

| Script | What it is |
|---|---|
| `run-on-mac.sh` (repo root) | **The one to use.** Postgres, Icecast, the API, the console. |
| `volt-app/run-local.sh` | An older app runner, superseded by the above. |
| `volt-encoder/dev/run-local.sh` | This one. The encoder alone, no product. |

## What is still genuinely useful here

- **`validate.sh` / `validate-docker.sh`** run the real encoder against a
  synthetic source and print PASS/FAIL per function, including SRT ingest inside
  a Linux container when the host ffmpeg has no SRT. That is a real conformance
  check and the only thing covering SRT. It is not wired into
  `volt-app/scripts/check.js`, so nobody runs it; folding it in would be worth
  doing.
- **`run-local.sh`** is a fast way to exercise the encoder with no database when
  changing packaging or ladder behaviour.
- The `test_*.py` files are standalone python checks for encoder internals.

## What was moved, and from where

From `volt-encoder/`: `run-local.sh`, `player.html`, `validate.sh`,
`validate-docker.sh`, `job.local-synth.json`, `RUN_LOCAL.md`.

From `volt-encoder/bin/`: `run_local_live.py`, `synth_source.sh`, `_common.sh`,
`capbench.py`, `playcheck.py`, `playercheck.py`, `soak.py`, `syncheck.py`, and
the six `test_*.py` files.

`bin/` now holds only what the product actually runs: the four container
entrypoints plus `events.py`, `s3-uploader.sh`, `source_selector.py`,
`speke_client.py` and `test-stream.sh`.
