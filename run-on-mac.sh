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
#   1. Applies the latest code update (adds the React app + newest API)
#   2. Makes sure a Postgres is running (uses Docker if it has to start one)
#   3. Loads the exact database snapshot from Claude's test (same 2 channels)
#   4. Starts the control-plane API on :8080 and the React app on :5173
#
#  Requirements: Node 20+ (you have it via nvm) and EITHER a local Postgres
#  on :5432 OR Docker Desktop running. Nothing else.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
DBURL="postgres://volt:volt@localhost:5432/volt"
SNAP="$ROOT/volt_web_demo.sql"

have() { command -v "$1" >/dev/null 2>&1; }
pg_up() { (exec 3<>/dev/tcp/localhost/5432) 2>/dev/null; }

echo "==> 1/4  Checking the app is present (the repo now syncs via GitHub, not the bundle)..."
# NOTE: the old volt-update.bundle sync was removed. Get the latest with a normal
# 'git pull' from GitHub before running this. The stale bundle used to abort here.
[ -d volt-web ] || { echo "    volt-web/ is missing. Run 'git pull' to fetch the latest from GitHub, then re-run."; exit 1; }

echo "==> 2/4  Ensuring Postgres is available on localhost:5432..."
USE_DOCKER=0
if ! pg_up; then
  if have docker; then
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

echo "==> 3/4  Loading the test database snapshot..."
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
run_psql -q -c "UPDATE channels SET status='ended' WHERE status='live'; UPDATE events SET status='ended' WHERE status='live';" >/dev/null 2>&1 || true
echo "    reset any stale 'live' streams to ended (clean start)."

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
if [ "$WANT_DOCKER" = "0" ] && [ "$ENCODER_MODE" = "mock" ] && have docker && docker info >/dev/null 2>&1; then
  echo "    native encoder tools missing, but Docker is running — using the Docker encoder."
  WANT_DOCKER=1
fi
if [ "$WANT_DOCKER" = "1" ]; then
  if ! have docker || ! docker info >/dev/null 2>&1; then
    echo "    ENCODER_MODE=docker requested but Docker isn't running. Start Docker Desktop and re-run."
    exit 1
  fi
  IMG="${ENCODER_IMAGE:-volt-encoder:local}"
  if docker image inspect "$IMG" >/dev/null 2>&1; then
    echo "    encoder image '$IMG' present."
  else
    echo "    building encoder image '$IMG' (first run only — a few minutes)..."
    docker build -t "$IMG" "$ROOT/volt-encoder"
  fi
  ENCODER_MODE="docker"
  export ENCODER_IMAGE="$IMG"
  echo "    real encoder: DOCKER ('$IMG') — production-identical ffmpeg (SRT + drawtext) + Shaka."
  echo "      NB: Docker uses your Mac's CPU; keep ladders light (720p/480p) for smooth realtime."
fi

echo "==> 4/4  Starting API (:8080) and the app (:5173)..."
# free stale dev servers from a previous run, otherwise the new ones can't bind and
# you keep seeing the OLD build. (Safe: only touches these two ports.)
free_port() {
  local pids
  pids=$(lsof -ti tcp:"$1" 2>/dev/null || true)
  if [ -n "$pids" ]; then echo "    freeing port $1 (stale pids: $pids)"; kill $pids 2>/dev/null || true; sleep 1; kill -9 $pids 2>/dev/null || true; fi
}
free_port 8080
free_port 5173
# Reap any orphaned encoder/ffmpeg/packager from a previous run BEFORE starting.
# If they are still holding the internal bus UDP ports (20000+), the packager cannot
# bind them and fails with "Could not bind UDP socket, error = 48", so the channel
# produces no output. These match our unique bin/origin paths, so it is safe.
pkill -f "$ROOT/volt-encoder/bin/encoder.py" 2>/dev/null || true
pkill -f "$ROOT/volt-app/origin" 2>/dev/null || true
if command -v docker >/dev/null 2>&1; then docker ps -q --filter "name=volt-enc-" 2>/dev/null | xargs -r docker rm -f >/dev/null 2>&1 || true; fi
export DATABASE_URL="$DBURL" JWT_ACCESS_SECRET=dev-access-secret JWT_REFRESH_SECRET=dev-refresh-secret \
       INGEST_TOKEN=dev-ingest PORT=8080 ORCH_LAUNCHER="$ENCODER_MODE" CORS_ORIGIN='*' \
       ENCODER_BIN="$ROOT/volt-encoder/bin" ORIGIN_DIR="$ROOT/volt-app/origin" \
       PACKAGER_BIN="${PACKAGER_BIN:-packager}"
( cd volt-app && { echo "    installing API deps…"; npm install --no-audit --no-fund >/dev/null 2>&1 || npm install; }; mkdir -p "$ROOT/volt-app/origin"; npx tsx src/index.ts > "$ROOT/volt-app/origin/_control-plane.log" 2>&1 ) &
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
  docker ps -q --filter "name=volt-enc-" 2>/dev/null | xargs -r docker rm -f >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

cd volt-web
echo "    installing app deps (picks up new packages like hls.js)…"
npm install --no-audit --no-fund >/dev/null 2>&1 || npm install
( sleep 4; have open && open http://localhost:5173 >/dev/null 2>&1 || true ) &
echo
echo "======================================================================"
echo "  Opening http://localhost:5173   —  sign in: admin@rtm.example / volt1234"
echo "  (Ctrl-C here stops both the app and the API.)"
echo "======================================================================"
echo
npm run dev
