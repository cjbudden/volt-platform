# Running Volt on a Mac

One script brings up the whole product on one Mac: Postgres, the control
plane, the console, the encoder, the Icecast relay for radio and the customer
docs. This is the single server the build queue tests against before AWS.

## What you need

- Node 20 or later (22 recommended) and npm.
- Postgres 16 on :5432, or Docker (Docker Desktop, OrbStack or colima). Docker
  does not need to be running: the script starts it and waits.
- For real encoding: ffmpeg, Python 3 and Shaka Packager on the PATH. Without
  them the app still runs, with encoders recorded but not started (`mock`).
- For live captions and face tracking on social formats, the encoder's Python
  needs faster-whisper, numpy and OpenCV. The script looks for a virtual
  environment at volt-encoder/.venv first, says at start-up which engines are
  ready, and prints the exact install command for any that are not.

## Start it

```bash
bash run-on-mac.sh                           # (Mac)
```

It prints five steps and then the addresses:

| Step | What happens |
|---|---|
| 1 | checks the app is present |
| 2 | checks Docker and starts it if it is installed but not running |
| 3 | makes sure Postgres answers on :5432, starting a container if it has to |
| 4 | loads the demo snapshot (`volt_web_demo.sql`) into a fresh database; an existing database is kept |
| 5 | starts the control plane on :8080, the Icecast relay on :8000 and the console on :5173 |

Then it checks and builds the customer docs and serves them on :3000, so the
**?** button in the console works. The console opens in your browser; the
sign-in is printed on the last lines. Ctrl-C stops the console, the API, the
docs and every encoder the run started.

| Address | What |
|---|---|
| http://localhost:5173 | the console |
| http://localhost:8080 | the API (`/health`, `/api/...`, `/live/...`) |
| http://localhost:8000 | the Icecast relay (radio MP3) |
| http://localhost:3000 | the customer docs |

## Options

```bash
RESET_DB=1 bash run-on-mac.sh                # (Mac) reload the demo snapshot; your data is replaced
ENCODER_MODE=docker bash run-on-mac.sh       # (Mac) encoders in the production image (ffmpeg with SRT and drawtext)
REBUILD_IMAGES=1 ENCODER_MODE=docker bash run-on-mac.sh   # (Mac) rebuild the encoder and radio images first
DOCS=0 bash run-on-mac.sh                    # (Mac) no docs
DOCS_DEV=1 bash run-on-mac.sh                # (Mac) docs with live reload while you write
bash run-on-mac.sh docs                      # docs checks and build only, then exit (0 = passed)
```

**Which encoder.** Homebrew's ffmpeg usually has no SRT and no drawtext, so
SRT ingest and some overlays only work with `ENCODER_MODE=docker`. If the
native tools are missing but Docker is up, the script picks Docker by itself.
Docker on a Mac still uses the Mac's CPU, so keep test ladders light (720p and
480p).

## Where things go

| What | Where |
|---|---|
| Control plane log | `volt-app/origin/_control-plane.log` |
| Docs build log | `volt-app/origin/_docs.log` |
| Live and recorded segments | `volt-app/origin` |
| Image library originals and rendered sizes | `volt-app/image-store` |
| The standalone encoder's scratch output | `volt-encoder/_local_out` |

## Housekeeping

```bash
bash volt-clean.sh                           # clear input scratch, keep 2 minutes of origin segments
RETAIN_MIN=5 bash volt-clean.sh              # keep 5 minutes instead (set it above the DVR window when testing catch-up)
DRY=1 bash volt-reset-recorded-data.sh       # count what a reset would remove, change nothing
bash volt-station-check.sh                   # does every radio station play? report only
```

`volt-reset-recorded-data.sh` without `DRY=1` takes the system back to
"nothing has ever been broadcast" while keeping accounts, channels, schedules
and the library: recordings, segments and the usage ledger go together. It
asks you to type RESET. It deletes data, so it is never run by a check or by
the build queue.

## When something does not start

- **API failed:** the script prints the last lines of
  `volt-app/origin/_control-plane.log`. A port already in use is freed for
  :8080 and :5173; anything else on :8000 that is not Icecast is named.
- **API failed after a fresh load or `RESET_DB=1`:** at the time of writing
  the demo snapshot predates the schema, so the migration runner stops at
  `volt-app/migrations/0003_containers_dayparts.sql` ("column c.radio_config
  does not exist").
  An existing database is not affected. Queued as build item 1.14-G7a.
- **Stations have no MP3:** there is no Icecast relay, usually because Docker
  could not start. Stations still go on air over HLS and DASH.
- **No subtitles on a captioned channel:** the start-up line for the captions
  engine says NOT AVAILABLE and prints the fix.
- **Hands-on test plans** for failover, captions, recordings and radio on the
  Mac: `TESTING_WORKFLOWS.md`.
