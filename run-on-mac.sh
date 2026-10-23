#!/usr/bin/env bash
# ============================================================================
#  Run the Volt Stream app LIVE on your Mac and open it in your browser.
#
#    cd .../LiveEventsAndChannelsManager/volt
#    bash run-on-mac.sh
#
#  Then open  http://localhost:5173   (sign in: admin@rtm.example / volt1234)
#
#  What it does:
#   1. Checks the app is present
#   2. Checks Docker is RUNNING, and starts it if it is not
#   3. Makes sure a Postgres is running (uses Docker if it has to start one)
#   4. Loads the exact database snapshot from Claude's test (same 2 channels)
#   5. Starts the control-plane API on :8080 and the React app on :5173,
#      with an Icecast relay on :8000 so radio stations can serve MP3
#
#   6. Checks and builds the customer docs (guides, API reference, release
#      notes) and serves them on :3000, so the ? button in the app works
#
#  Docs only (checks + build, then exit):   bash run-on-mac.sh docs
#  Skip the docs:                           DOCS=0 bash run-on-mac.sh
#  Docs with live reload while writing:     DOCS_DEV=1 bash run-on-mac.sh
#
#  Requirements: Node 20+ (you have it via nvm) and EITHER a local Postgres
#  on :5432 OR Docker installed. Docker does NOT need to be running before you
#  start: step 2 starts Docker Desktop, OrbStack or colima for you and waits.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
DBURL="postgres://volt:volt@localhost:5432/volt"
SNAP="$ROOT/volt_web_demo.sql"
DOCS_ONLY=0; [ "${1:-}" = "docs" ] && DOCS_ONLY=1
DOCS="${DOCS:-1}"; [ "$DOCS_ONLY" = "1" ] && DOCS=1
DOCS_PORT="${DOCS_PORT:-3000}"

have() { command -v "$1" >/dev/null 2>&1; }
pg_up() { (exec 3<>/dev/tcp/localhost/5432) 2>/dev/null; }
port_open() { (exec 3<>/dev/tcp/localhost/"$1") 2>/dev/null; }
docker_up() { docker info >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
#  DOCKER: INSTALLED AND RUNNING ARE DIFFERENT QUESTIONS.
#
#  Everything optional in this script goes through Docker -- Postgres when
#  there is no local one, the containerised encoder, the Icecast relay -- and
#  every one of those checks used to ask `have docker`, which answers "is the
#  CLI on PATH". The CLI is on PATH whether or not the daemon is running, so
#  with Docker Desktop closed the Postgres branch ran `docker run` and died on
#  a raw daemon error, and the Icecast branch skipped in silence and left you
#  with a station whose MP3 never worked and nothing saying why.
#
#  So: ask the daemon, and if it is not up, START it rather than reporting the
#  problem back to somebody who would only go and do the same thing.
# ---------------------------------------------------------------------------
DOCKER_OK=0
ensure_docker() {
  if ! have docker; then
    echo "    Docker is not installed. Postgres must then be local, and there will be"
    echo "    no Icecast relay, so stations go on air over HLS/DASH without MP3."
    return 1
  fi
  if docker_up; then DOCKER_OK=1; echo "    Docker is running."; return 0; fi

  # The daemon is down. Which one is installed decides how to start it, and all
  # three of these are things people actually run on a Mac.
  local how=""
  if [ -d "/Applications/Docker.app" ]; then how="desktop"
  elif [ -d "/Applications/OrbStack.app" ]; then how="orbstack"
  elif have colima; then how="colima"
  fi

  case "$how" in
    desktop)  echo "    Docker Desktop is installed but not running — starting it..."
              open -ga Docker >/dev/null 2>&1 || true ;;
    orbstack) echo "    OrbStack is installed but not running — starting it..."
              open -ga OrbStack >/dev/null 2>&1 || true ;;
    colima)   echo "    colima is installed but not running — starting it..."
              colima start >/dev/null 2>&1 || true ;;
    *)        echo "    The docker command exists but no daemon is running, and no Docker"
              echo "    Desktop, OrbStack or colima was found to start. Start your Docker"
              echo "    daemon and re-run."
              return 1 ;;
  esac

  # Docker Desktop takes its time on a cold start; 90s is generous rather than
  # optimistic, because the alternative is the whole run failing at step 3.
  printf "    waiting for the Docker daemon"
  for i in $(seq 1 90); do
    if docker_up; then DOCKER_OK=1; printf " ready after %ss\n" "$i"; return 0; fi
    printf "."; sleep 1
  done
  printf "\n"
  echo "    Docker did not come up within 90s. Open it manually and re-run."
  return 1
}

echo "==> 1/5  Checking the app is present (the repo now syncs via GitHub, not the bundle)..."
# NOTE: the old volt-update.bundle sync was removed. Get the latest with a normal
# 'git pull' from GitHub before running this. The stale bundle used to abort here.
[ -d volt-web ] || { echo "    volt-web/ is missing. Run 'git pull' to fetch the latest from GitHub, then re-run."; exit 1; }

echo "==> 2/5  Checking Docker (Postgres, the encoder and the MP3 relay all use it)..."
ensure_docker || true

echo "==> 3/5  Ensuring Postgres is available on localhost:5432..."
USE_DOCKER=0
if ! pg_up; then
  # DOCKER_OK, not `have docker`: the CLI being on PATH says nothing about
  # whether anything will accept `docker run`.
  if [ "$DOCKER_OK" = "1" ]; then
    USE_DOCKER=1
    docker rm -f volt-pg >/dev/null 2>&1 || true
    docker run -d --name volt-pg \
      -e POSTGRES_USER=volt -e POSTGRES_PASSWORD=volt -e POSTGRES_DB=volt \
      -p 5432:5432 postgres:16 >/dev/null
    echo "    started Docker container 'volt-pg'; waiting..."
    for i in $(seq 1 40); do pg_up && break; sleep 1; done
  else
    cat <<'EOF'
    Nothing is listening on :5432 and Docker isn't installed.
    Start Postgres one of these ways, then re-run this script:
      Docker Desktop:  (install it, start it, then re-run)
      Homebrew:        brew install postgresql@16 && brew services start postgresql@16 \
                       && createuser -s volt && psql -d postgres -c "ALTER USER volt PASSWORD 'volt';" \
                       && createdb -O volt volt
EOF
    exit 1
  fi
fi
# small settle for a freshly-started server to accept auth
sleep 2

# Make sure the 'volt' role + database exist. (Docker already created them via the
# POSTGRES_* env vars; a pre-existing local Postgres usually has not.)
if ! PGPASSWORD=volt psql -U volt -h localhost -d volt -c '\q' 2>/dev/null; then
  echo "    'volt' role/db not found — creating them in your local Postgres..."
  ADMIN_DB=""
  for d in postgres "$USER" template1; do
    if psql -d "$d" -c '\q' 2>/dev/null; then ADMIN_DB="$d"; break; fi
  done
  if [ -z "$ADMIN_DB" ]; then
    echo "    Couldn't connect to your local Postgres as '$USER'. Create them manually, then re-run:"
    echo "      createuser -s volt && createdb -O volt volt && psql -d volt -c \"ALTER ROLE volt PASSWORD 'volt'\""
    exit 1
  fi
  psql -d "$ADMIN_DB" -v ON_ERROR_STOP=1 \
    -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='volt') THEN CREATE ROLE volt LOGIN PASSWORD 'volt' SUPERUSER; END IF; END \$\$;"
  psql -d "$ADMIN_DB" -tAc "SELECT 1 FROM pg_database WHERE datname='volt'" | grep -q 1 \
    || psql -d "$ADMIN_DB" -c "CREATE DATABASE volt OWNER volt;"
  # ensure the password is set even if the role pre-existed without one
  psql -d "$ADMIN_DB" -c "ALTER ROLE volt PASSWORD 'volt';" >/dev/null 2>&1 || true
fi

echo "==> 4/5  Loading the test database snapshot..."
run_psql() {  # run SQL against the volt db, via docker if that's what we started
  if [ "$USE_DOCKER" = "1" ]; then docker exec -i volt-pg psql -U volt -d volt "$@";
  else PGPASSWORD=volt psql -U volt -h localhost -d volt "$@"; fi
}
load_file() {
  if [ "$USE_DOCKER" = "1" ]; then docker exec -i volt-pg psql -U volt -d volt -v ON_ERROR_STOP=1 -q < "$1";
  else PGPASSWORD=volt psql -U volt -h localhost -d volt -v ON_ERROR_STOP=1 -q -f "$1"; fi
}
if [ ! -f "$SNAP" ]; then echo "    Snapshot $SNAP not found. Tell Claude."; exit 1; fi
# Persist test data across runs: only load the demo snapshot on a FRESH database
# (or when RESET_DB=1 is set). If the schema already exists, keep whatever you
# entered during testing so you can build up real test data build-to-build.
HAS=$(run_psql -tAc "SELECT to_regclass('public.channels') IS NOT NULL" 2>/dev/null | tr -d '[:space:]')
if [ "${RESET_DB:-0}" = "1" ] || [ "$HAS" != "t" ]; then
  [ "${RESET_DB:-0}" = "1" ] && echo "    RESET_DB=1 — reloading the demo snapshot (your data will be replaced)."                              || echo "    fresh database — loading the demo snapshot once..."
  run_psql -q -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null
  load_file "$SNAP"
  echo "    loaded $(run_psql -tAc 'select count(*) from channels') channels."
else
  echo "    existing database detected — keeping your data (no reload). Use RESET_DB=1 to reset."
fi

# Clean state: any channel/event left 'live' from a previous run has NO encoder running
# now. Mark them ended so the list is truthful and a fresh Send source can't collide
# with a stale launch.
# Not in docs-only mode: the app may be running in another terminal.
if [ "$DOCS_ONLY" != "1" ]; then
  run_psql -q -c "UPDATE channels SET status='ended' WHERE status='live'; UPDATE events SET status='ended' WHERE status='live';" >/dev/null 2>&1 || true
  echo "    reset any stale 'live' streams to ended (clean start)."
fi

# the test-stream feature (Start test stream → real HLS playback + live subtitles)
# needs ffmpeg on PATH; the app still runs without it, just no live playback.
if have ffmpeg; then echo "    ffmpeg: $(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f1-3) — test streams enabled"
else echo "    NOTE: ffmpeg not found — 'Start test stream' will be disabled. Install with: brew install ffmpeg"; fi

# The REAL local encoder service (channel Start → ingest → x264 ladder → Shaka CMAF
# HLS+DASH → DVR + recording → thumbnails) needs ffmpeg + python3 + Shaka 'packager'.
# When all three are present we run the real encoder; otherwise Start just records
# intent (mock) and the app still runs. This decides ORCH_LAUNCHER below.
REQ_MODE="${ENCODER_MODE:-}"; ENCODER_MODE="mock"; MISSING=""
# Shaka Packager ships under a few names depending on how it was installed.
PACKAGER_BIN=""
for cand in packager shaka-packager packager-osx-arm64 packager-osx-x64; do
  if have "$cand"; then PACKAGER_BIN="$cand"; break; fi
done
have ffmpeg      || MISSING="$MISSING ffmpeg"
have python3     || MISSING="$MISSING python3"

# ---------------------------------------------------------------------------
#  THE ENCODER'S PYTHON MUST BE THE ONE THAT HAS THE CAPTION ENGINE.
#
#  faster-whisper, NLLB and torch are installed in volt-encoder/.venv, but the
#  launcher ran `python3` (PYTHON_BIN from volt-app/.env), which is Homebrew's
#  Python with none of them. Every captioned channel therefore started its
#  caption worker, failed `import faster_whisper`, logged it once and carried
#  on without subtitles. Use the venv when it exists; say plainly when the
#  engine is missing instead of finding out on air.
# ---------------------------------------------------------------------------
PYTHON_BIN="python3"
if [ -x "$ROOT/volt-encoder/.venv/bin/python3" ]; then PYTHON_BIN="$ROOT/volt-encoder/.venv/bin/python3"; fi
if "$PYTHON_BIN" -c "import faster_whisper" >/dev/null 2>&1; then
  echo "    live captions engine: READY (faster-whisper via $PYTHON_BIN)"
else
  echo "    live captions engine: NOT AVAILABLE, $PYTHON_BIN cannot import faster_whisper."
  echo "      Channels will stream, but without subtitles. Fix with:"
  echo "        python3 -m venv volt-encoder/.venv && volt-encoder/.venv/bin/pip install faster-whisper"
fi
# SOCIAL FORMATS (volt/REFRAME.md): the face tracker in reframe_analyse.py
# needs numpy and OpenCV in the same Python. Without them the Formats tab still
# finds the shots and frames on the centre, and says why faces were not found.
if "$PYTHON_BIN" -c "import numpy, cv2; cv2.FaceDetectorYN" >/dev/null 2>&1; then
  echo "    social formats face tracking: READY (OpenCV via $PYTHON_BIN)"
else
  echo "    social formats face tracking: installing numpy and OpenCV for $PYTHON_BIN…"
  if "$PYTHON_BIN" -m pip install --quiet numpy opencv-python-headless >/dev/null 2>&1 \
     || "$PYTHON_BIN" -m pip install --quiet --user --break-system-packages numpy opencv-python-headless >/dev/null 2>&1; then
    echo "      installed."
  else
    echo "      NOT AVAILABLE: shots are still found, faces are not. Fix with:"
    echo "        $PYTHON_BIN -m pip install numpy opencv-python-headless"
  fi
fi
export PYTHON_BIN
[ -n "$PACKAGER_BIN" ] || MISSING="$MISSING shaka-packager"
if [ -z "$MISSING" ]; then
  ENCODER_MODE="local"
  echo "    real local encoder: ENABLED (ffmpeg + python3 + Shaka '$PACKAGER_BIN' $($PACKAGER_BIN --version 2>/dev/null | head -1))"
else
  echo "    real local encoder: DISABLED — missing:$MISSING"
  echo "      Channel Start will record intent only until these are installed (test streams still work if ffmpeg is present)."
  case "$MISSING" in *ffmpeg*)        echo "      ffmpeg         : brew install ffmpeg" ;; esac
  case "$MISSING" in *python3*)       echo "      python3        : brew install python" ;; esac
  case "$MISSING" in *shaka-packager*)
    ARCH=$(uname -m); ASSET="packager-osx-arm64"; [ "$ARCH" = "x86_64" ] && ASSET="packager-osx-x64"
    echo "      shaka-packager : brew install --cask shaka-packager"
    echo "                       — or download '$ASSET' from https://github.com/shaka-project/shaka-packager/releases/latest ,"
    echo "                         then:  chmod +x $ASSET && sudo mv $ASSET /usr/local/bin/packager" ;;
  esac
fi


# ---- Layer 2: run the encoder INSIDE Docker (production-identical ffmpeg WITH
# SRT + drawtext + Shaka Packager), instead of the Mac's Homebrew ffmpeg which
# has no SRT/drawtext. Opt in with:  ENCODER_MODE=docker bash run-on-mac.sh
# It also auto-activates when the native encoder tools are missing but Docker is
# up, so a Mac without Shaka/SRT still gets a real, working encoder.
# NB: Docker still uses your Mac's CPU, so keep test ladders light (720p/480p).
WANT_DOCKER=0
[ "${REQ_MODE:-}" = "docker" ] && WANT_DOCKER=1
if [ "$WANT_DOCKER" = "0" ] && [ "$ENCODER_MODE" = "mock" ] && [ "$DOCKER_OK" = "1" ] && [ "$DOCS_ONLY" != "1" ]; then
  echo "    native encoder tools missing, but Docker is running — using the Docker encoder."
  WANT_DOCKER=1
fi
if [ "$WANT_DOCKER" = "1" ]; then
  # Step 2 already tried to start it, so reaching here means it could not be
  # started rather than that nobody thought to try.
  if [ "$DOCKER_OK" != "1" ]; then
    echo "    ENCODER_MODE=docker requested but Docker could not be started (see step 2)."
    exit 1
  fi
  # Both images the Docker launcher runs: the encoder (television, events) AND
  # the station image (radio). Only the encoder used to be built, so in Docker
  # mode every radio station failed at `docker run` ("pull access denied for
  # volt-radio") and sat at "Input: connecting" with nothing in its log.
  # Each image is labelled with its Dockerfile's hash and rebuilt when that
  # changes (bin/ is mounted live, so code edits never need a rebuild).
  ensure_image() {  # <tag> <dockerfile> <label>
    local tag="$1" df="$2" what="$3" want have
    want=$(shasum -a 256 "$df" 2>/dev/null | cut -c1-16)
    have=$(docker image inspect -f '{{ index .Config.Labels "volt.dockerfile" }}' "$tag" 2>/dev/null || true)
    if [ -n "$have" ] && [ "$have" = "$want" ]; then
      echo "    $what image '$tag' present."
      return 0
    fi
    if [ -z "$have" ] && docker image inspect "$tag" >/dev/null 2>&1 && [ "${REBUILD_IMAGES:-0}" != "1" ]; then
      echo "    $what image '$tag' present (unlabelled; REBUILD_IMAGES=1 to refresh it)."
      return 0
    fi
    echo "    building $what image '$tag' (a few minutes the first time)..."
    if ! docker build -f "$df" --label "volt.dockerfile=$want" -t "$tag" "$ROOT/volt-encoder"; then
      echo "    !! could not build $what image '$tag'. Streams that need it will report why in their event log."
      return 1
    fi
  }
  IMG="${ENCODER_IMAGE:-volt-encoder:local}"
  RIMG="${RADIO_IMAGE:-volt-radio:local}"
  ensure_image "$IMG"  "$ROOT/volt-encoder/Dockerfile"       encoder || true
  ensure_image "$RIMG" "$ROOT/volt-encoder/Dockerfile.radio" station || true
  ENCODER_MODE="docker"
  export ENCODER_IMAGE="$IMG" RADIO_IMAGE="$RIMG"
  echo "    real encoder: DOCKER ('$IMG') — production-identical ffmpeg (SRT + drawtext) + Shaka."
  echo "      NB: Docker uses your Mac's CPU; keep ladders light (720p/480p) for smooth realtime."
fi

[ "$DOCS_ONLY" = "1" ] || echo "==> 5/5  Starting API (:8080) and the app (:5173)..."
# free stale dev servers from a previous run, otherwise the new ones can't bind and
# you keep seeing the OLD build. (Safe: only touches these two ports.)
free_port() {
  local pids
  pids=$(lsof -ti tcp:"$1" 2>/dev/null || true)
  if [ -n "$pids" ]; then echo "    freeing port $1 (stale pids: $pids)"; kill $pids 2>/dev/null || true; sleep 1; kill -9 $pids 2>/dev/null || true; fi
}
# Docs-only mode leaves a running app alone: it frees and reaps nothing.
if [ "$DOCS_ONLY" != "1" ]; then
free_port 8080
free_port 5173
# Reap any orphaned encoder/ffmpeg/packager from a previous run BEFORE starting.
# If they are still holding the internal bus UDP ports (20000+), the packager cannot
# bind them and fails with "Could not bind UDP socket, error = 48", so the channel
# produces no output. These match our unique bin/origin paths, so it is safe.
pkill -f "$ROOT/volt-encoder/bin/encoder.py" 2>/dev/null || true
pkill -f "$ROOT/volt-app/origin" 2>/dev/null || true
if command -v docker >/dev/null 2>&1; then docker ps -q --filter "name=volt-enc-" 2>/dev/null | xargs -r docker rm -f >/dev/null 2>&1 || true; fi
fi
# ---------------------------------------------------------------------------
#  THE MP3 RELAY.
#
#  A radio station pushes its MP3 to an Icecast relay; HLS and DASH are written
#  to disk. This script never started one, so every station pushed at
#  localhost:8000 with nothing listening.
#
#  That used to take the WHOLE station down, not just the MP3: one ffmpeg
#  carries every output and opens them all before encoding, so a refused
#  icecast:// connection killed the process and no HLS or DASH was written
#  either. bin/radio.py now probes the relay first and drops the MP3 output
#  when it is unreachable, so a station without Icecast still goes on air —
#  but it is a better demo with one, so start it if Docker can.
# ---------------------------------------------------------------------------
#  A CONNECTED PORT IS NOT A RUNNING ICECAST. The old check was a TCP connect
#  to :8000, which any process holding that port satisfies, so a Vite server or
#  a leftover container could report the relay as ready and every station would
#  then fail to push to it. Ask Icecast to identify itself instead: it names
#  itself in the Server header on any response, including its 404.
icecast_alive() {
  curl -sI --max-time 2 "http://localhost:8000/" 2>/dev/null | grep -qi 'icecast' \
    || curl -s --max-time 2 "http://localhost:8000/status-json.xsl" 2>/dev/null | grep -q 'icestats'
}

ICE_OK=0
if [ "$DOCS_ONLY" = "1" ]; then
  echo "    docs only: no Icecast relay needed."
elif [ "$DOCKER_OK" != "1" ]; then
  echo "    no Docker, so no Icecast relay on :8000."
elif icecast_alive; then
  echo "    Icecast is already running on :8000."
  ICE_OK=1
elif port_open 8000; then
  # Something holds the port and it is not Icecast. Name it: this is the whole
  # diagnosis and it is one command away, and without it the operator sees only
  # a station whose MP3 does not serve.
  echo "    :8000 is in use by something that is NOT Icecast:"
  lsof -nP -iTCP:8000 -sTCP:LISTEN 2>/dev/null | sed -n '2,4p' | sed 's/^/      /' \
    || echo "      (could not identify the process)"
  echo "    Free that port and re-run, or stations will have no MP3 output."
else
  echo "    starting the Icecast relay (MP3) on :8000..."
  docker rm -f volt-icecast >/dev/null 2>&1 || true
  #  DO NOT SWALLOW THE ERROR. This was `>/dev/null 2>&1 || true`, so a failed
  #  image pull, a port clash or a name conflict all produced the same silence
  #  followed by twenty seconds of waiting and a NOTE that blamed Docker being
  #  off. The reason docker prints is the answer; keep it and show it.
  ICE_ERR=""
  if ! ICE_ERR=$(docker run -d --name volt-icecast -p 8000:8000 \
      -e ICECAST_SOURCE_PASSWORD=hackme -e ICECAST_ADMIN_PASSWORD=hackme \
      -e ICECAST_RELAY_PASSWORD=hackme -e ICECAST_PASSWORD=hackme \
      libretime/icecast:2.4.4 2>&1); then
    echo "    could not start the Icecast container:"
    echo "$ICE_ERR" | tail -3 | sed 's/^/      /'
  else
    printf "    waiting for Icecast"
    for i in $(seq 1 25); do
      if icecast_alive; then ICE_OK=1; printf " ready after %ss\n" "$i"; break; fi
      printf "."; sleep 1
    done
    if [ "$ICE_OK" != "1" ]; then
      printf "\n"
      #  The container started and never answered. Its own log says why, and it
      #  is about to be the only record: nobody goes looking for `docker logs`
      #  on a container they did not know existed.
      echo "    the container started but Icecast never answered. Its last lines:"
      docker logs --tail 12 volt-icecast 2>&1 | sed 's/^/      /' || true
      echo "    (inspect further with: docker logs volt-icecast)"
    fi
  fi
fi

if [ "$ICE_OK" = "1" ]; then
  echo "    Icecast relay ready — stations that ask for MP3 will serve it."
else
  echo "    NOTE: no Icecast on :8000. Stations go on air over HLS/DASH, and any"
  echo "          station configured to push MP3 reports its output as DEGRADED"
  echo "          with the reason, rather than failing to start."
fi

export DATABASE_URL="$DBURL" JWT_ACCESS_SECRET=dev-access-secret JWT_REFRESH_SECRET=dev-refresh-secret \
       INGEST_TOKEN=dev-ingest PORT=8080 ORCH_LAUNCHER="$ENCODER_MODE" CORS_ORIGIN='*' \
       ENCODER_BIN="$ROOT/volt-encoder/bin" ORIGIN_DIR="$ROOT/volt-app/origin" \
       ICECAST_HOST=localhost ICECAST_PORT=8000 ICECAST_SOURCE_USER=source \
       ICECAST_SOURCE_PASSWORD=hackme \
       PACKAGER_BIN="${PACKAGER_BIN:-packager}"

# ---------------------------------------------------------------------------
#  INSTALL ONLY WHEN THE LOCKFILE HAS CHANGED.
#
#  This script ran `npm install` in BOTH packages on every single start, before
#  the API was even launched. On an unchanged checkout that is tens of seconds
#  of doing nothing, twice, every time -- and it is the bulk of "why is startup
#  so long".
#
#  The stamp is a hash of the lockfile, kept inside node_modules. That location
#  is deliberate: delete node_modules and the stamp goes with it, so a wiped
#  install can never be mistaken for an up-to-date one. Change a dependency and
#  the hash moves, and the install runs.
# ---------------------------------------------------------------------------
deps_up_to_date() {
  local dir="$1" lock="$1/package-lock.json" stamp="$1/node_modules/.volt-deps"
  [ -d "$dir/node_modules" ] || return 1
  [ -f "$lock" ] || return 1
  [ -f "$stamp" ] || return 1
  local now; now=$(shasum -a 256 "$lock" 2>/dev/null | cut -d" " -f1)
  [ -n "$now" ] && [ "$now" = "$(cat "$stamp" 2>/dev/null)" ]
}
stamp_deps() {
  local dir="$1" lock="$1/package-lock.json"
  [ -d "$dir/node_modules" ] && [ -f "$lock" ] || return 0
  shasum -a 256 "$lock" 2>/dev/null | cut -d" " -f1 > "$dir/node_modules/.volt-deps" 2>/dev/null || true
}
install_if_needed() {
  local dir="$1" label="$2"
  if deps_up_to_date "$dir"; then
    echo "    $label deps unchanged — skipping install"
    return 0
  fi
  echo "    installing $label deps…"
  ( cd "$dir" && { npm install --no-audit --no-fund >/dev/null 2>&1 || npm install; } )
  stamp_deps "$dir"
}

install_if_needed "$ROOT/volt-app" "API"

# BURNED-IN GRAPHICS (build queue 1.10): the encoder's graphics renderer
# (volt-encoder/gfx/burn_renderer.js) needs playwright-core next to it; it
# drives the Mac's own Google Chrome, so nothing else is downloaded. Without
# it a channel with burned graphics runs without them and its log says why.
if [ -f "$ROOT/volt-encoder/gfx/package.json" ]; then
  install_if_needed "$ROOT/volt-encoder/gfx" "graphics renderer"
fi

# THE PLAYER SDK (volt-player): the embed bundle the API serves at
# /player/volt-player.js (share pages, customer embeds), and the source the
# console imports for its own players. Rebuilt when its source is newer than
# the bundle; the API only serves a bundle that exists when it starts.
if [ -d "$ROOT/volt-player" ]; then
  install_if_needed "$ROOT/volt-player" "player SDK"
  if [ ! -f "$ROOT/volt-player/dist/volt-player.js" ] || [ -n "$(find "$ROOT/volt-player/src" -newer "$ROOT/volt-player/dist/volt-player.js" -type f 2>/dev/null | head -1)" ]; then
    echo "    building the player SDK…"
    ( cd "$ROOT/volt-player" && npx vite build >/dev/null 2>&1 ) && echo "    player SDK built." || echo "    player SDK build FAILED (cd volt-player && npm run build); share pages fall back to hls.js"
  fi
fi

# ---------------------------------------------------------------------------
#  CUSTOMER DOCS: CHECK, BUILD, SERVE   (docs-site/MAINTAINING.md, RELEASING.md)
#
#  The docs are generated from the code, so they go stale the moment the code
#  moves and nobody notices until a customer does. Every start therefore checks
#  the things the docs are made from, in the foreground because they take
#  seconds, and says plainly what is out of date:
#    - the route inventory (read from the app) and the API reference built from it
#    - the guides for terms that must never reach customers (scrub.json)
#    - core changes that have no change note yet (for the next release notes)
#    - the docs sign-in endpoint, against this database
#  Generated files that are merely out of date are regenerated, and named, so
#  they get committed. A real failure is reported, not fatal: the app still starts.
#
#  The site BUILD (which also fails on a broken link or a banned term) runs in
#  the background, only when docs sources changed since the last build, then the
#  site is served on :3000. DOCS_URL points the app's ? button at it. Locally
#  there is no signing key, so no cookie is needed.
# ---------------------------------------------------------------------------
DOCS_FAIL=0
DOCS_LOG="$ROOT/volt-app/origin/_docs.log"
docs_say() { echo "    [docs] $*"; }
docs_regen() {  # $1 label, $2 check cmd, $3 regenerate cmd, $4 files to commit
  if ( cd "$ROOT/volt-app" && eval "$2" ) >/dev/null 2>&1; then docs_say "$1: current"
  elif ( cd "$ROOT/volt-app" && eval "$3" ) >/dev/null 2>&1; then docs_say "$1: was out of date, regenerated. Commit $4"
  else docs_say "$1: FAILED. Run in volt-app: $3"; DOCS_FAIL=1; fi
}
docs_checks() {
  docs_regen "route inventory" "npx tsx scripts/api-routes.ts --check" "npx tsx scripts/api-routes.ts" "volt-app/docs/API_ROUTES.md + api-routes.json"
  docs_regen "API reference" "node scripts/openapi.mjs --check" "node scripts/openapi.mjs" "volt-app/docs/openapi.json"
  if out=$(cd "$ROOT/docs-site" && node scripts/check-scrub.mjs docs release-notes 2>&1); then docs_say "guides: no internal terms"
  else docs_say "guides: banned terms found:"; echo "$out" | sed 's/^/      /' | head -12; DOCS_FAIL=1; fi
  if out=$(node "$ROOT/scripts/release/check.mjs" 2>&1); then docs_say "change notes: $(echo "$out" | sed 's/^change notes: //')"
  else docs_say "change notes: core changes without a note (fine while working; needed before a release):"; echo "$out" | sed -n '2,6p' | sed 's/^/      /'; fi
  if out=$(cd "$ROOT/volt-app" && DOCS_TEST_EMAIL="${DOCS_TEST_EMAIL:-admin@rtm.example}" DOCS_TEST_PASSWORD="${DOCS_TEST_PASSWORD:-volt1234}" npx tsx test/docs-session.check.ts 2>&1); then
    docs_say "sign-in endpoint: $(echo "$out" | grep -c '^PASS') checks passed"
  else docs_say "sign-in endpoint test FAILED:"; echo "$out" | grep -E '^(FAIL|login)' | head -6 | sed 's/^/      /'; DOCS_FAIL=1; fi
  # THE API LIST STANDARD (volt-app/docs/API_STANDARDS.md): every list endpoint,
  # every sort and filter, against this database. Read-only, about half a
  # minute, so it runs in docs-only mode rather than on every start.
  if [ "$DOCS_ONLY" = "1" ]; then
    if out=$(cd "$ROOT/volt-app" && DOCS_TEST_EMAIL="${DOCS_TEST_EMAIL:-admin@rtm.example}" DOCS_TEST_PASSWORD="${DOCS_TEST_PASSWORD:-volt1234}" npx tsx test/listStandard.check.ts 2>&1); then
      docs_say "API lists: $(echo "$out" | tail -1)"
    else docs_say "API lists test FAILED:"; echo "$out" | grep -E '^FAIL' | head -8 | sed 's/^/      /'; DOCS_FAIL=1; fi
  fi
}
docs_needs_build() {  # true when anything the site is built from is newer than the last build
  local stamp="$ROOT/docs-site/build/index.html"
  [ -f "$stamp" ] || return 0
  [ -n "$(find "$ROOT/docs-site/docs" "$ROOT/docs-site/release-notes" "$ROOT/docs-site/src" "$ROOT/docs-site/static/_public" \
           "$ROOT/docs-site/docusaurus.config.ts" "$ROOT/docs-site/sidebars.ts" "$ROOT/docs-site/scrub.json" \
           "$ROOT/docs-site/package-lock.json" "$ROOT/volt-app/docs/openapi.json" "$ROOT/brand/fonts/web" "$ROOT/brand/logos/svg" \
           -type f -newer "$stamp" 2>/dev/null | head -1)" ]
}
docs_build() {
  install_if_needed "$ROOT/docs-site" "docs"
  if docs_needs_build; then
    docs_say "building the site (log: volt-app/origin/_docs.log)..."
    # A stale build cache (after a Docusaurus upgrade, say) fails every page
    # with an unrelated-looking render error. One retry from a clean cache
    # tells that apart from a real problem in the docs.
    if ( cd "$ROOT/docs-site" && VOLT_APP_URL=http://localhost:5173 DOCS_SITE_URL="http://localhost:$DOCS_PORT" npm run build ) > "$DOCS_LOG" 2>&1 \
       || { docs_say "build failed; clearing the build cache and retrying once..."
            ( cd "$ROOT/docs-site" && npx docusaurus clear && VOLT_APP_URL=http://localhost:5173 DOCS_SITE_URL="http://localhost:$DOCS_PORT" npm run build ) > "$DOCS_LOG" 2>&1; }; then
      docs_say "site built: no broken links, no internal terms."
    else
      docs_say "site build FAILED. Last lines:"; grep -E 'Error|error|banned|scrub|Broken|broken' "$DOCS_LOG" | tail -8 | sed 's/^/      /'
      return 1
    fi
  else
    docs_say "site unchanged since the last build: not rebuilding."
  fi
}

if [ "$DOCS" = "1" ] && [ -d "$ROOT/docs-site" ]; then
  echo "==> Docs: checking what the customer docs are generated from..."
  mkdir -p "$ROOT/volt-app/origin"
  docs_checks
  if [ "$DOCS_ONLY" = "1" ]; then
    docs_build || DOCS_FAIL=1
    echo
    if [ "$DOCS_FAIL" = "0" ]; then echo "Docs: all checks passed. Preview: (cd docs-site && npm run serve)"; exit 0
    else echo "Docs: something needs fixing (see [docs] lines above)."; exit 1; fi
  fi
  free_port "$DOCS_PORT"
  export DOCS_URL="http://localhost:$DOCS_PORT"
  if [ "${DOCS_DEV:-0}" = "1" ]; then
    ( install_if_needed "$ROOT/docs-site" "docs" >/dev/null
      cd "$ROOT/docs-site" && npm run prepare-assets >/dev/null 2>&1; VOLT_APP_URL=http://localhost:5173 "$ROOT/docs-site/node_modules/.bin/docusaurus" start --port "$DOCS_PORT" --no-open >> "$DOCS_LOG" 2>&1 ) &
    docs_say "live-reload docs starting on http://localhost:$DOCS_PORT"
  else
    ( if docs_build; then
        cd "$ROOT/docs-site" && "$ROOT/docs-site/node_modules/.bin/docusaurus" serve --port "$DOCS_PORT" --no-open >> "$DOCS_LOG" 2>&1 &
        sleep 2; docs_say "serving http://localhost:$DOCS_PORT"
      fi ) &
  fi
elif [ "$DOCS" != "1" ]; then
  echo "==> Docs: skipped (DOCS=0)."
fi

# HAND-TYPED IDS -> RANDOM UUIDS. The demo data used ids typed to be easy to
# spot (...0000a001 for RTM, ...0c0001 for RTM News 24), which showed in every
# URL and image path. This gives them real random ids, in the database and in
# the origin / image-store folders named by them. It runs before the API so
# nothing is writing to those folders, and once done it finds nothing and
# changes nothing. Refuses if something is already serving on :8080.
( cd volt-app && npx tsx scripts/rekey-placeholder-ids.ts --apply 2>&1 \
    | grep -Ev '^  [a-z_0-9]+\.[a-z_0-9]+: [0-9]+$' | sed 's/^/    /' ) || true

( cd volt-app && mkdir -p "$ROOT/volt-app/origin"; npx tsx src/index.ts > "$ROOT/volt-app/origin/_control-plane.log" 2>&1 ) &
API_PID=$!
echo "    waiting for API..."
for i in $(seq 1 40); do curl -sf localhost:8080/health >/dev/null 2>&1 && break; sleep 1; done
curl -sf localhost:8080/health >/dev/null 2>&1 || { echo "    API failed — see volt-app/origin/_control-plane.log"; tail -20 "$ROOT/volt-app/origin/_control-plane.log"; kill $API_PID 2>/dev/null; exit 1; }
echo "    API up."

cleanup() {
  echo; echo "Shutting down..."
  kill $API_PID 2>/dev/null || true
  # kill any encoder + ffmpeg/packager children this run spawned, so nothing orphans.
  # These reference our unique bin/origin paths, so the match is safe.
  pkill -f "$ROOT/volt-encoder/bin/encoder.py" 2>/dev/null || true
  pkill -f "$ROOT/volt-app/origin" 2>/dev/null || true
  pkill -f "$ROOT/docs-site/node_modules" 2>/dev/null || true   # docs server (serve or live reload)
  docker ps -q --filter "name=volt-enc-" 2>/dev/null | xargs -r docker rm -f >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

cd volt-web
install_if_needed "$ROOT/volt-web" "app"
( sleep 4; have open && open http://localhost:5173 >/dev/null 2>&1 || true ) &
echo
echo "======================================================================"
echo "  Opening http://localhost:5173   —  sign in: admin@rtm.example / volt1234"
[ "$DOCS" = "1" ] && echo "  Docs:   http://localhost:$DOCS_PORT  (or the ? button in the app)"
echo "  (Ctrl-C here stops the app, the API and the docs.)"
echo "======================================================================"
echo
npm run dev
