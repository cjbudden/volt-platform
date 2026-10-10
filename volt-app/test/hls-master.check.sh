#!/usr/bin/env bash
# HLS source inspection through the API: a master behind a redirect (the ABC
# Jazz case, where an old address now points somewhere else), its variants with
# absolute addresses, a media playlist, Check source carrying the playlist
# beside ffprobe's answer, and the refusals: not a playlist, too big, a
# redirect loop, a 404, a non-http scheme, no sign-in.
# Run from volt-app/ with DATABASE_URL set.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8506}"
FPORT="${FPORT:-8507}"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*'
fuser -k "$PORT"/tcp "$FPORT"/tcp 2>/dev/null; sleep 0.4
pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
B="http://localhost:$PORT"; J='content-type:application/json'; F="http://127.0.0.1:$FPORT"
W=$(mktemp -d)
jget(){ python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

cat > "$W/srv.py" <<'PY'
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
MASTER = b"""#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=252000,AVERAGE-BANDWIDTH=246000,CODECS="mp4a.40.2"
jazz/v0-221.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=140000,AVERAGE-BANDWIDTH=112000,CODECS="mp4a.40.29"
jazz/v0-222.m3u8
"""
MEDIA = b"#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg1.aac\n"
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body=b'', headers=None):
        self.send_response(code)
        for k, v in (headers or {}).items(): self.send_header(k, v)
        self.send_header('content-length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        p = self.path
        if p == '/old/masterhls.m3u8': return self.send(302, headers={'location': '/audio/hls/jazz.m3u8'})
        if p == '/audio/hls/jazz.m3u8': return self.send(200, MASTER, {'content-type': 'application/vnd.apple.mpegurl'})
        if p == '/audio/hls/jazz/v0-221.m3u8': return self.send(200, MEDIA)
        if p == '/loop.m3u8': return self.send(302, headers={'location': '/loop.m3u8'})
        if p == '/big.m3u8': return self.send(200, b'#EXTM3U\n' + b'#' * (1100 * 1024))
        if p == '/page.m3u8': return self.send(200, b'<html>hello</html>')
        self.send(404, b'nope')
ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
PY
python3 "$W/srv.py" "$FPORT" & SRV=$!
npx tsx src/index.ts >/tmp/hls_master_api.log 2>&1 &
API=$!
for i in $(seq 1 60); do curl -sf "$B/health" >/dev/null && break; sleep 0.25; done
TOK=$(curl -s -X POST "$B/api/auth/login" -H "$J" -d '{"email":"root@adminco.example","password":"volt1234"}' | sed -n 's/.*"access":"\([^"]*\)".*/\1/p')
A="authorization: Bearer $TOK"
hls(){ curl -s -X POST "$B/api/sources/hls" -H "$A" -H "$J" -d "{\"url\":\"$1\"}"; }

R=$(hls "$F/old/masterhls.m3u8")
ok "the old address is followed and the redirect reported" '[ "$(echo "$R" | jget "d[\"redirectedTo\"]")" = "$F/audio/hls/jazz.m3u8" ]'
ok "it is a master with 2 audio-only variants: AAC-LC 252k, HE-AAC v2 140k" '[ "$(echo "$R" | jget "[(v[\"codecNames\"][0], v[\"bandwidth\"], v[\"audioOnly\"]) for v in d[\"variants\"]]")" = "[('"'"'AAC-LC'"'"', 252000, True), ('"'"'HE-AAC v2'"'"', 140000, True)]" ]'
ok "variant addresses are absolute, against where the master really is" '[ "$(echo "$R" | jget "d[\"variants\"][0][\"uri\"]")" = "$F/audio/hls/jazz/v0-221.m3u8" ]'
R=$(hls "$F/audio/hls/jazz/v0-221.m3u8")
ok "a variant's own address is a live media playlist" '[ "$(echo "$R" | jget "(d[\"kind\"], d[\"live\"], d[\"redirectedTo\"])")" = "('"'"'media'"'"', True, None)" ]'
ok "not a playlist is said plainly" 'hls "$F/page.m3u8" | grep -q "does not return an HLS playlist"'
ok "a response over 1 MB is refused" 'hls "$F/big.m3u8" | grep -q "larger than a playlist"'
ok "a redirect loop stops" 'hls "$F/loop.m3u8" | grep -q "redirects"'
ok "a 404 is reported" 'hls "$F/nothing.m3u8" | grep -q "404"'
ok "a non-http scheme is refused" 'hls "file:///etc/passwd" | grep -q "cannot be checked"'
C=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/sources/hls" -H "$J" -d "{\"url\":\"$F/audio/hls/jazz.m3u8\"}")
ok "reading playlists needs a sign-in ($C)" '[ "$C" = 401 ]'
P=$(curl -s -X POST "$B/api/sources/probe" -H "$A" -H "$J" -d "{\"url\":\"$F/old/masterhls.m3u8\",\"protocol\":\"hls\"}")
ok "Check source carries the playlist too (master, 2 variants, the redirect)" '[ "$(echo "$P" | jget "(d[\"hls\"][\"kind\"], len(d[\"hls\"][\"variants\"]), bool(d[\"hls\"][\"redirectedTo\"]))")" = "('"'"'master'"'"', 2, True)" ]'
P=$(curl -s -X POST "$B/api/sources/probe" -H "$A" -H "$J" -d '{"url":"srt://0.0.0.0:9000","protocol":"srt"}')
ok "a non-HLS source has no playlist part" '[ "$(echo "$P" | jget "\"hls\" in d")" = False ]'

kill $API $SRV 2>/dev/null
rm -rf "$W"
echo; echo "hls-master.check: $pass passed, $fail failed"
[ "$fail" = 0 ]
