# Testing the live workflows

How to test each live workflow yourself, what a pass looks like, and what was
measured on 8 and 9 Oct 2026. Every test here reads the stream that was actually
delivered. None of them take the encoder's own word for it.

All commands run from the repo root (`.../LiveEventsAndChannelsManager/volt`)
unless a `cd` says otherwise.

## 0. Before anything: is the machine ready?

```bash
which ffmpeg packager                                   # both must print a path
volt-encoder/.venv/bin/python3 -c "import faster_whisper; print('captions engine OK')"
```

If the second line fails, live subtitles cannot work on this machine:

```bash
python3 -m venv volt-encoder/.venv
volt-encoder/.venv/bin/pip install faster-whisper
```

`run-on-mac.sh` now uses that venv for the encoder, and prints
`live captions engine: READY` or `NOT AVAILABLE` at startup. Until 8 Oct it ran
Homebrew `python3`, which has no faster-whisper, so the caption worker failed on
import on every channel.

## 1. Unit suites (about 1 minute)

```bash
cd volt-encoder
for t in dev/test_*.py; do printf '%-28s ' "$t"; PYTHONPATH=bin .venv/bin/python3 "$t" 2>&1 | tail -1; done
```

Pass: every line ends in `0 failed` or `ALL PASSED`. `test_player_alignment.py`
needs a real Chrome and may skip.

```bash
cd volt-app
DATABASE_URL=postgres://volt:volt@localhost:5432/volt node scripts/check.js           # everything, ~10 min
DATABASE_URL=postgres://volt:volt@localhost:5432/volt node scripts/check.js captions  # one area
```

8 Oct: 96 of 103 suites pass. The 7 that don't are test drift or missing test
media, not product faults. They're listed in section 9.

## 2. Live video stability and live captions (the demo-critical test)

```bash
cd volt-encoder
PACKAGER_BIN=packager SKIP_PLAYER=1 ./synctest.sh demo 300
```

This runs the real encoder (transcode, x264 ladder, Shaka, live whisper
captions) against the public unified-streaming live source for 5 minutes, then
reports on it.

| Section | Pass looks like |
|---|---|
| start-up | `first_manifest_sec` under ~12, `first_caption_sec` under ~30 |
| playback stability | `OK ... no violations` |
| ingest health | truncated fetches `0` |
| clean stop | processes still alive `0` |
| `sync_error_sec` | `median` within ±0.3s, `within_1s` above 0.85 |
| `pdt_step_error` | `max_abs` 0.0 |
| `delivered_audio` | `missing_pct` 0.0 |
| `wer_vs_delivered_audio` | under ~0.25 |

Measured 8 Oct on 2 vCPU, same source, 5 minutes each:

| | before the restore | after |
|---|---|---|
| median caption sync error | -19.8s | **+0.02s** |
| cues within 1s / 2s | 0% / 0% | **94% / 100%** |
| PDT step error | 8.1s mean | **0.000s** |
| word error rate | 1.47 | **0.14** |
| playback check under CPU load | 336 PDT tears + a 15s stall | **no violations** |
| first manifest | 23s | **9s** |
| manifest audio tracks | 6 duplicates | **1** |

To watch playback stability on any running channel in the console:

```bash
python3 volt-encoder/dev/playcheck.py --url http://localhost:8080/origin/<channel-id>/live/master_cc.m3u8 --seconds 120
```

Use `master.m3u8` when captions are off.

## 3. Captions in the console

1. Account: captions engine Whisper (Admin, Captions; or
   `UPDATE accounts SET captions_provider='whisper'`).
2. Channel, Settings, Subtitles: on, **source language English**. `auto` loads
   the slower multilingual model, and `en` loads `base.en`.
3. Start the channel. Within about 30s the event log shows
   `caption.status producing`, then one `caption.offset` per 8s window.
4. In the player, CC shows `EN`. The player sits 14s behind live so cues exist
   before they're due.
5. If `caption.slow` appears, transcription is using more than half of each
   window. On a laptop, run one captioned channel at a time.

## 4. Failover, failback, fallback to loop or slate, and watermark

Since 9 Oct the loop is not pushed through the encoder any more. When a source is
added, its renditions are probed (resolution, fps, H.264 profile and level, bitrate,
audio) and stored on the input. The loop video or slate is then rendered once to that
exact ladder, with the channel's watermark, and packaged. On a loss, the playlists the
player reads (`master_cc.m3u8`, `stream_N_cc.m3u8`) splice the loop in with a
discontinuity, and splice live back in when the source returns. `PLAYOUT.md` has the
design.

```bash
cd volt-encoder
PACKAGER_BIN=packager dev/wftest.sh vod_loop transcode       # ~4.5 min
PACKAGER_BIN=packager dev/wftest.sh slate    transcode
PACKAGER_BIN=packager dev/wftest.sh vod_loop package_only
```

The test makes two synthetic live HLS sources, one per colour (primary RED, backup
BLUE), runs the real encoder with failover on and a white watermark, and kills the
sources on cue:

```
  0s  start          60s  kill primary      110s  kill backup
160s  restart primary                       230s  stop
```

It then decodes every segment of the DELIVERED playlist and names what was on air.
`playersim.py` replays a live player sitting 3 segments behind the edge against a
record of when each segment was listed, once for the delivered playlist and once for
the packager's own playlist as a before/after comparison, and once for the DASH MPD
(`manifest_cc.mpd`), where it also checks every segment is listed before the time a
clock-driven player would ask for it.

**In a real browser.** With `CHROME_BIN` set, the same run also plays the stream in
Chrome with the console's own hls.js and dash.js (`dev/browsercheck.mjs`), samples the
colour on screen every second and counts every second the picture froze. Headless
Chromium has no H.264, so it needs Chrome for Testing (one time):

```bash
npx @puppeteer/browsers install chrome@stable          # prints the chrome path
npm i --prefix ~/.volt-browser playwright-core
export CHROME_BIN=<that path>  NODE_PATH=~/.volt-browser/node_modules
# on a Mac with Chrome installed you can instead use:
# export CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

`BROWSER_SET=manifest_cc.mpd` (or `master_cc.m3u8`) runs one format only and
`BROWSER_SNAP="none product edge"` picks the start behaviour: `none` is the library's
own live start, `product` copies the console player (12s behind live, or 14s with
captions), `edge` is the console's start before 9 Oct (0.5s behind the newest data).
Each player writes `browser_<format>_<snap>.txt` and a `.log` of the library's own
logging plus the buffer state every second (`DASH_LOG=5` for dash.js debug, which also
turns on hls.js debug).

Pass:

```
SEQUENCE: RED x14 -> GREEN x1 -> RED x2 -> BLUE x10 -> GREEN x13 -> BLUE x1 -> RED x14
delivered (with splice): OK no stalls
DASH player: OK no stalls, a continuous timeline across Periods, and every segment listed before its availability time
dash.js (none start): ... on screen: RED 57s -> GREEN 7s -> BLUE 42s -> GREEN 53s -> BLUE 3s -> RED 40s
  OK no stalls: the playhead advanced every second from the first frame to the end
playcheck: OK ... no violations
```

The single loop segment at the primary-to-backup switch is expected. The switch takes
about 7s to detect, which is longer than the 3s hold (three quarters of a segment), so one slot is filled from the
loop instead of stalling. To trade that for a tighter player margin, raise
`redundancy.splice_hold_sec`.

9 Oct results (seconds frozen in a real Chrome, from the first frame to the end of a
205s watch through primary, backup, loop and primary again):

| Workflow | HLS, hls.js | DASH, dash.js | Without the splice |
|---|---|---|---|
| transcode, library start | **0** | **0** | 51 to 54s stalled |
| transcode, console start (12s) | **0** | **0** | |
| package_only, library start | **0** (one run in five froze, see section 9) | **0** | packager stopped, channel went down |
| package_only, console start (12s) | **0** | not run | |
| any, console start before 9 Oct (0.5s) | **6s** frozen at the first splice | | |
| transcode via the API (probe, pre-built slate, Start, kill sources, forced slate) | **0** (simulated player), no playcheck violations | | |

The last-but-one row is a console fix: with captions off the console player used to
jump to 0.5s behind the newest segment, so any segment that came a little late (every
source hiccup and every splice) froze the picture. It now holds 12s back, three 4s
segments, which is what hls.js and dash.js do on their own.

### Recordings and the loop

The loop is never recorded. A recording only holds what the source sent, so an outage
is a hole in it. The recording workbench now marks where the loop or slate was on air
over that hole (an amber strip on the timeline, "Loop on air" in the hole's tooltip and
a count above the timeline), from the encoder's `playout.jsonl`. A forced slate from
the pre-flight panel is marked too, over media that WAS recorded (the source kept
running). To check through the API after any failover run:

```bash
curl -s localhost:8080/api/recordings/<recording-id>/timeline -H "authorization: Bearer $TOK" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["fallbacks"]); print(d["gaps"])'
```

9 Oct, API product path (`fallbacks` from the encoder, holes from the recording):

```
fallback +57s .. +61s   slate (source-lost)     gap +52s .. +59s   missing-media onAir=slate
fallback +101s .. +149s slate (source-lost)     gap +97s .. +148s  missing-media onAir=slate
fallback +173s .. +197s slate (forced)          (no hole: the source was still recorded)
```

### Pre-built loop through the API

```bash
curl -s localhost:8080/api/channels/<id>/filler -H "authorization: Bearer $TOK"        # probes + build state
curl -s -X POST localhost:8080/api/channels/<id>/filler -H "authorization: Bearer $TOK" # probe and rebuild now
```

The build is queued automatically when a channel or event is created, and again when
its sources, ladder, loss behaviour, slate, loop asset or watermark change. At Start
the encoder checks the build against its real output. If it doesn't match, or the
source is an SRT/RTMP push that couldn't be probed in advance, the encoder rebuilds it
from that output. You can see this in `encoder.log` as `playout: using the pre-built
loop` or `playout: building a ... loop matched to ...`.

### The same thing from the console (pre-flight failover)

`slate` and `loop` now force the splice: the loop is delivered while the inputs keep
running, and `auto` returns to live at the next segment.

```bash
for m in slate auto; do
  curl -s -X POST localhost:8080/api/channels/<id>/failover-test \
    -H "authorization: Bearer $TOK" -H 'content-type: application/json' -d "{\"mode\":\"$m\"}"
  sleep 30
done
```

## 5. Encoder crash and auto reconnect

1. Start a channel and wait for `autoconnect.armed` in its event log. That's
   about 20 to 40s after all four gates are healthy.
2. Kill the encoder process hard: `pgrep -fl volt-encoder/bin/encoder.py`, then
   `kill -9 <pid>` for the python line. Avoid a bare `pkill -f encoder.py`,
   because it also matches any shell whose command line mentions it.
3. Expect the channel to show `ended` within about 30s (the orchestrator tick),
   then come back `live` within about 20s more (`[resume] started channel ...
   auto connect, attempt 1`), with segments flowing.

8 Oct: **pass**. Ended at +24s, relaunched at +48s. Before the fixes this never
recovered:

- Arming failed on every pass (a UNION of `channels.*` with `events.*`), then
  silently armed nothing (channels' own `kind` column overwrote the literal).
- A crashed local encoder was never noticed: the reconcile ran only at boot.

## 6. GPU profiles on a machine without a GPU

New output profiles default to `nvenc`. On a Mac the transcoder died on
`Cannot load libcuda.so.1` and was respawned for ever: the channel said live
and there was no picture. It now falls back to x264 and logs
`GPU (NVENC) requested but not available`. To check, start any channel on an
nvenc profile and look for that line in `origin/<id>/encoder.log`.

## 7. Radio

```bash
cd volt-app && DATABASE_URL=... node scripts/check.js radio
bash volt-station-check.sh          # end to end against a station
```

8 Oct: 38 of 41 in `radio.check.sh`. The 3 failures are in metadata-log
classification (song/advert), not playback.

## 8. Full product path: the run sheet

One command runs the whole product path against the Volt that `run-on-mac.sh`
started, and prints PASS, FAIL or SKIP per step. Every step reads what was
delivered (playlists, segments, decoded frames), not what the API says.

```bash
bash run-on-mac.sh                       # in one terminal, as usual
bash scripts/e2e-mac.sh --plan           # the steps, nothing changed
bash scripts/e2e-mac.sh                  # everything, about 15 minutes
bash scripts/e2e-mac.sh --only rights,failover
bash scripts/e2e-mac.sh --cleanup        # the run removes what it made at the end
```

It makes its own synthetic sources (ffmpeg colour bars served from the script
on port 8790: primary RED, backup BLUE, with spoken audio from `say` so live
captions have words to find), and its own objects named `E2E <time>`: an
output profile and group of its own when the plan has room, otherwise an
existing transcode group used as it is (nothing in it is changed, so captions
are checked only if that group already has them on). Without `--cleanup` the
objects stay for a look; everything it started is stopped either way, also
on Ctrl-C.

| Step | What it does | Pass looks like |
|---|---|---|
| `preflight` | `/health`, sign in, tools | signed in; ffmpeg, packager, faster-whisper and a voice listed |
| `setup` | output profile (x264 720p and 360p) and group | the run's own group, or the existing group it uses |
| `sources` | two live HLS sources | the primary decodes RED |
| `channel` | transcode channel: primary and backup, failover on, auto failback, slate on total loss, recording, captions | channel created and read back |
| `start` | Start | `master_cc.m3u8` names a rendition with segments; the newest frame is RED; status `live` |
| `air` | On air | `/live/<id>/master.m3u8` answers with a playlist |
| `captions` | live captions (Whisper, English) on the run's own profile | `TYPE=SUBTITLES` in the master, the subtitle playlist grows, a cue has words |
| `rights` | a programme from now for ten minutes that blocks AU with the loop | preview: AU `replace`, MY `allow`; AU's rendition carries `/filler/` segments, MY's none, both in the preview's play address and on the public address with `?as=AU` / `?as=MY` |
| `failover` | kill the primary, then the backup, then restart both | BLUE, then the slate, then RED again (failback), with the seconds each took |
| `stop` | off air, Stop | status `ended`; a recording for the run |
| `record` | | at least 30 s recorded; the slate marked over the hole (`fallbacks`); no loop segment in the recording (the rights window changed AU's copy only) |
| `clip` | 20 s from the recording | the clip build job succeeds |
| `vod` | | the clip's own master plays: first segment loads, ffprobe says about 20 s |
| `publish` | | publish answers `published` (or `scheduled`) |
| `radio` | a station on a synthetic ICY source (`volt-app/test/icecast-sim.js`) | audio segments delivered, on air on `/live/<id>/master.m3u8`, a source title in now playing |
| `event` | an event on the primary source | live, the picture RED, stopped, a recording |
| `fast` | a FAST channel with a run order of the clip | prepared, public, its playlist airs the clip's segments |

A step SKIPs when the machine lacks what it needs (it says what to install)
or when a step it depends on did not pass; a SKIP is never counted as a pass,
and the exit code is non-zero when anything failed.

Settings, as environment variables: `VOLT_API` (`http://localhost:8080`),
`VOLT_EMAIL` and `VOLT_PASSWORD` (the demo sign-in), `PACKAGER_BIN` (found on
the PATH or in `packager-osx-arm64/` otherwise), `PYTHON_BIN` (the encoder
venv), `E2E_GROUP` (a group to use as it is), `E2E_SOURCE_PORT`,
`E2E_SOURCE_HOST` and `E2E_ENCODER=docker` (the Docker encoder reaches the
sources at `host.docker.internal`), `E2E_TIME_SCALE=2` (every wait twice as
long, for a busy laptop). Each run writes `result.json` with every step's
notes; the path is printed at the end.

`check.js e2e-runsheet` keeps it runnable: every API call in the script is a
route the API has, each step has a row above, and the steps that need no
video encoder (setup, sources, channel, radio, then `--cleanup`) run for real
against a fresh account.

27 Oct 2026, run in the build container (no Shaka Packager or
faster-whisper there): preflight, setup (the demo plan is full, so the
existing RTM Transcode group was used), sources, channel and radio passed;
start to FAST skipped for the packager. **The full run is the Mac's**: it has
not been run end to end yet.

8 Oct, before the script, the same path was run by hand: API login, a
transcode channel with an HLS source and a watermark, captions on, Start;
`SUBTITLES` in `master_cc.m3u8`, a growing `subs.m3u8` with real cues,
playcheck on :8090 with no violations, all four gates healthy, auto connect
armed, Stop closed a recording, a killed encoder recovered (section 5).

## 9. Known open items

- **gpac (a DASH client used as a second opinion) stops following the live MPD** at
  the first or second Period change. Chrome with dash.js plays every Period without a
  freeze, and gpac plays the same MPD correctly once it is static, so this looks like
  gpac's live multi-Period handling. ExoPlayer (Android) and Shaka Player are not
  tested yet.
- **One hls.js run in five on a package channel froze for 40s** at the first splice,
  then recovered. It did not repeat in the next three runs. The simulated player and
  playcheck saw nothing wrong in that run, so it is a player-side behaviour still to
  pin down; the browser check writes hls.js debug logs (`DASH_LOG=5`) for when it
  happens again.
- **A primary-to-backup switch shows one loop segment**, because detection
  (~7s) is longer than the 3s hold. There's no stall.
- **Production (ECS/S3) is untested.** The control plane's pre-built loop is not on
  an ECS task's disk, so the encoder builds its own from its output at Start (a few
  seconds), and the uploader syncs it with the run. The public redirect sends viewers
  to `master_cc.m3u8` for channels with failover or captions.
- **A fresh database can't start from `volt_web_demo.sql`.** The 6 Aug snapshot
  no longer migrates (0003 needs `radio_config`), so `RESET_DB=1 bash
  run-on-mac.sh` would refuse to boot. Your current database is fine. Use
  migrations plus `scripts/seed-demo.ts` instead, as `check.js` does.
- **Check suites still failing for test reasons:** `meter` (fixed dates),
  `clip-extract` (expects full-render where smart-render now applies),
  `metadata-events` (expects unknown keys rejected, which aaa7718 deliberately
  changed), `now-playing`, `clip-smart-render` and `ingest-extract` (need test
  media generated first), and `radio` (3 classification asserts).
