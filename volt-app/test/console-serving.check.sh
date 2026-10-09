#!/usr/bin/env bash
# ============================================================================
#  THE CONTROL PLANE SERVES THE CONSOLE.
#
#  volt-web builds to a static bundle and, until now, nothing served it: the
#  control plane served an old `public/console.html` and had no SPA fallback at
#  all, despite volt-web's router documenting the opposite. `docker compose up`
#  therefore produced an API and no interface, and the built bundle had nowhere
#  to go.
#
#  Four things have to hold, and three of them are ways this can go subtly
#  wrong rather than visibly:
#
#    1. The app is served at the root.
#    2. A DEEP route is served the app too. The console uses history routing,
#       so /channels/<id> is a real URL a person reloads and shares, and a 404
#       there is the classic broken SPA deployment.
#    3. An unmatched /api route still answers as an API. A catch-all placed
#       carelessly swallows those and returns an HTML page with status 200, so
#       a typo'd endpoint looks like a success to a client and fails at the
#       JSON parse with no clue why.
#    4. index.html is never cached and hashed assets are cached hard. Getting
#       this backwards means a deploy leaves browsers holding a stale page that
#       references assets which no longer exist.
#
#  Skips honestly when no bundle has been built, because that is a developer
#  who has not run the frontend build, not a defect.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."
. "$(dirname "$0")/lib/portable.sh"   # setsid/timeout/stat differ on macOS; see that file
: "${DATABASE_URL:?set DATABASE_URL}"

PORT=8141
WORK=$(mktemp -d)
# NOTE the guard on SRV. `kill -TERM -0` is not a no-op: 0 means "my own
# process group", so an unguarded cleanup on an early exit -- a seed that
# failed, a port already in use -- signals the test runner itself, and the
# suite looks like it hung rather than like it bailed out.
cleanup(){ [ -n "${SRV:-}" ] && kill -TERM -"$SRV" 2>/dev/null; rm -rf "$WORK"; return 0; }
trap cleanup EXIT

pass=0; fail=0
ok(){ if eval "$2"; then echo "  PASS $1"; pass=$((pass+1)); else echo "  FAIL $1"; fail=$((fail+1)); fi; }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }
ctype(){ curl -s -o /dev/null -w '%{content_type}' "$@"; }
hdr(){ curl -s -D- -o /dev/null "$1" | tr -d '\r' | grep -i "^$2:" | head -1; }

# A bundle to serve. Prefer one already built; build it if node_modules allow.
DIST=""
if [ -f ../volt-web/dist/index.html ]; then
  DIST=$(cd ../volt-web/dist && pwd)
elif [ -d ../volt-web/node_modules ]; then
  (cd ../volt-web && npm run build >"$WORK/build.log" 2>&1) && DIST=$(cd ../volt-web/dist && pwd)
fi
if [ -z "$DIST" ]; then
  echo "SKIP no console bundle and could not build one (run npm run build in volt-web)"
  echo; echo "== RESULT: 0 passed, 0 failed =="; exit 0
fi

if curl -fsS --max-time 1 "localhost:$PORT/health" >/dev/null 2>&1; then
  echo "SKIP something is already listening on :$PORT"
  echo; echo "== RESULT: 0 passed, 0 failed =="; exit 0
fi

export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z
export WEB_DIST_DIR="$DIST" ORCH_LAUNCHER=mock
vsetsid npx tsx src/index.ts >"$WORK/api.log" 2>&1 &
SRV=$!
for i in $(seq 1 40); do curl -fsS "localhost:$PORT/health" >/dev/null 2>&1 && break || sleep 0.5; done
if ! curl -fsS --max-time 2 "localhost:$PORT/health" >/dev/null 2>&1; then
  echo "FATAL the control plane did not come up:"; tail -8 "$WORK/api.log"
  echo; echo "== RESULT: 0 passed, 1 failed =="; exit 1
fi
B="http://localhost:$PORT"

echo "== the console is served =="
ok "the root serves the app" '[ "$(code $B/)" = "200" ]'
ok "as HTML" 'case "$(ctype $B/)" in text/html*) true;; *) false;; esac'
ok "and it is the built bundle, not the old test console" 'curl -s $B/ | grep -qE "/assets/index-.*\.js"'

echo "== deep routes reload, because the router is history based =="
ok "a section route serves the app" '[ "$(code $B/channels)" = "200" ]'
ok "and so does a nested one" '[ "$(code $B/recordings/source/abc)" = "200" ]'

echo "== the API is still an API =="
# The failure this guards against is a catch-all mounted too early.
ok "an unknown API route is 404, not the app" '[ "$(code $B/api/no-such-route)" = "404" ]'
ok "and answers in JSON, not HTML" 'case "$(ctype $B/api/no-such-route)" in application/json*) true;; *) false;; esac'
ok "a real API route still requires auth" '[ "$(code $B/api/channels)" = "401" ]'
ok "health is untouched" 'curl -s $B/health | grep -q volt-control-plane'
ok "the origin surface keeps its own 404" '[ "$(code $B/origin/nothing/master.m3u8)" = "404" ]'

echo "== caching is the right way round =="
# Backwards, this is the deploy that leaves browsers on a stale page pointing
# at asset filenames that no longer exist.
ok "index.html is never cached" 'hdr "$B/" cache-control | grep -qi "no-store"'
ASSET=$(curl -s $B/ | grep -oE '/assets/[^"]+\.js' | head -1)
ok "a hashed asset was found to check" '[ -n "$ASSET" ]'
ok "and hashed assets are immutable" 'hdr "$B$ASSET" cache-control | grep -qi "immutable"'
ok "served with a javascript content type" 'case "$(ctype $B$ASSET)" in *javascript*) true;; *) false;; esac'

echo
echo "== RESULT: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
