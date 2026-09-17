#!/usr/bin/env bash
# ============================================================================
#  THE INGEST FRAMEWORK TEST SUITE, one command, no database.
#
#    volt-app$ bash test/ingest.sh            # everything
#    volt-app$ bash test/ingest.sh core tus    # a subset by name
#
#  What runs, and what each needs:
#    core        pure: naming, rules ladder, duplicates, sniff, ID3, merge, payload
#    tus         tus 1.0.0 over real HTTP with the memory store
#    s3          S3 destination and S3 watchfolder mirror over the in-memory bucket
#    sources     URL / Dropbox / OneDrive / Drive adapters and the range fetcher, fake provider on localhost
#    providers   Aspera / MASV / Signiant / S3 acceleration against fake endpoints
#    agent       the desktop agent: sync roots, and a full pass against a fake Volt
#    extract     extract() over real media made with ffmpeg   (needs ffmpeg + ffprobe on PATH)
#    package     @volt/ingest-core syncs from volt-app and compiles on its own
#
#  Compiles with tsc into a scratch directory (no tsx needed), links the
#  few node_modules the checks import, runs each and prints one line per
#  suite plus a total. Exit code is non-zero if any suite fails.
# ============================================================================
set -u
cd "$(dirname "$0")/.."
APP="$PWD"
OUT="${INGEST_TEST_OUT:-/tmp/volt-ingest-tests}"
FIX="$OUT/fixtures"
want=("$@"); [ ${#want[@]} -eq 0 ] && want=(core tus s3 sources providers agent extract package)
has() { for w in "${want[@]}"; do [ "$w" = "$1" ] && return 0; done; return 1; }

rm -rf "$OUT"; mkdir -p "$OUT/node_modules" "$FIX"
for m in express pg dotenv @smithy @aws-sdk; do ln -sfn "$APP/node_modules/$m" "$OUT/node_modules/$m"; done

TSC="npx tsc --target ES2022 --module commonjs --moduleResolution node --esModuleInterop --skipLibCheck --outDir $OUT --rootDir .."
declare -A SUITE=( [core]=ingest-core [tus]=tus [s3]=ingest-s3 [sources]=ingest-sources [providers]=ingest-providers [agent]=agent [extract]=ingest-extract )
files=()
for k in "${!SUITE[@]}"; do has "$k" && files+=("test/${SUITE[$k]}.check.ts"); done
if [ ${#files[@]} -gt 0 ]; then
  if ! $TSC "${files[@]}" 2>&1 | grep -v "npm notice"; then :; fi
fi

pass=0; fail=0; failed=()
run() {  # name, script, args...
  local name="$1"; shift; local script="$1"; shift
  local line
  line=$(node "$OUT/volt-app/test/$script.check.js" "$@" 2>&1 | tail -1)
  if echo "$line" | grep -q " 0 failed"; then pass=$((pass+1)); printf "  ok    %-10s %s\n" "$name" "$line"
  else fail=$((fail+1)); failed+=("$name"); printf "  FAIL  %-10s %s\n" "$name" "$line"; node "$OUT/volt-app/test/$script.check.js" "$@" 2>&1 | grep -A2 "^FAIL" | head -20; fi
}

echo "ingest framework tests"
has core      && run core      ingest-core
has tus       && run tus       tus
has s3        && run s3        ingest-s3
has sources   && run sources   ingest-sources
has providers && run providers ingest-providers
has agent     && run agent     agent
if has extract; then
  if command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null; then
    ffmpeg -v error -y -f lavfi -i "sine=frequency=440:duration=2" -metadata title="Blue Train" -metadata artist="John Coltrane" -metadata album="Blue Train" -metadata genre="Jazz" -metadata track="1/5" -id3v2_version 3 "$FIX/song.mp3"
    ffmpeg -v error -y -f lavfi -i "testsrc=size=640x360:rate=25:duration=1" -f lavfi -i "sine=frequency=440:duration=1" -c:v libx264 -pix_fmt yuv420p -c:a aac "$FIX/clip.mov"
    cp "$FIX/clip.mov" "$FIX/wrongext.mp3"
    run extract ingest-extract "$FIX"
  else
    printf "  skip  %-10s ffmpeg/ffprobe not on PATH\n" extract
  fi
fi
if has package; then
  P="$APP/../packages/ingest-core"
  # tsc resolves peers from the package's own node_modules; link volt-app's (gitignored there).
  mkdir -p "$P/node_modules"; for m in @types express @aws-sdk @smithy typescript; do ln -sfn "$APP/node_modules/$m" "$P/node_modules/$m"; done
  ok=1
  (cd "$P" && node scripts/sync.js >/dev/null) || ok=0
  if [ $ok -eq 1 ]; then
    tscout=$(cd "$P" && "$APP/node_modules/.bin/tsc" -p tsconfig.json --outDir "$OUT/pkg/dist" 2>&1 | grep -v "npm notice")
    echo "$tscout" | grep -q "error TS" && ok=0
  fi
  if [ $ok -eq 1 ]; then
    n=$(node -e "const c=require('$OUT/pkg/dist'); console.log(Object.keys(c).length)")
    pass=$((pass+1)); printf "  ok    %-10s @volt/ingest-core compiles standalone, %s exports\n" package "$n"
  else
    fail=$((fail+1)); failed+=(package); printf "  FAIL  %-10s package did not sync or compile standalone\n" package; echo "$tscout" | head -10
  fi
  rm -rf "$P/src" 2>/dev/null
fi

echo
echo "suites: $pass passed, $fail failed${failed:+ (${failed[*]})}"
[ "$fail" -eq 0 ]
