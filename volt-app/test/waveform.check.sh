#!/usr/bin/env bash
# ============================================================================
#  WAVEFORM — the audio envelope the timeline draws, checked against real media.
#
#  Nothing here is a fixture. The script finds a channel that actually has audio
#  segments on disk, asks the API for the envelope over the window those segments
#  occupy, and asserts the picture agrees with the coverage the timeline reports
#  for the same window.
#
#  What it guards, and why each one has been wrong before:
#
#   * CONTINUITY. A segment's measured peak describes its WHOLE duration, so it
#     must paint every bucket it overlaps. Painting only the bucket holding its
#     midpoint left two of every three columns blank at a half-hour zoom, and the
#     envelope read as a picket fence — worse than useless when the job is to
#     find the quiet moment to cut on. So: the share of buckets carrying data
#     must track the share of the window that is recorded.
#
#   * SCALE. Heights are LINEAR AMPLITUDE (10^(dB/20)), not loudness and not dB
#     mapped linearly over a 60 dB window. The old mapping put -13 dBFS at 0.78
#     and -4 dBFS at 0.93: real programme audio came out as a featureless block
#     pinned near the top. A correct waveform on real material has spread.
#
#   * HONESTY. Peak is never below RMS, nothing exceeds 1, a window with no media
#     draws nothing rather than inventing a floor, and an unbounded window is
#     refused rather than answered slowly.
#
#  Usage: API=http://localhost:8080 DATABASE_URL=... bash test/waveform.check.sh
# ============================================================================
set -uo pipefail
API="${API:-http://localhost:8080}"
EMAIL="${EMAIL:-root@adminco.example}"
PASS_WORD="${PASS_WORD:-volt1234}"

pass=0; fail=0
ok(){ echo "PASS $1"; pass=$((pass+1)); }
bad(){ echo "FAIL $1 -- $2"; fail=$((fail+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$3] got [$2]"; fi; }

TOK=$(curl -s -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS_WORD\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access"])')
[ -n "$TOK" ] || { echo "FATAL: no token (is the API up at $API?)"; exit 1; }
get(){ curl -s -H "authorization: Bearer $TOK" "$API/api$1"; }

# ---- find a channel whose media is actually on disk -------------------------
# The recordings table can claim time that a crash meant was never written, so
# the subject is chosen from what the timeline MEASURES, not from what SQL says.
get "/recordings/sources" > /tmp/_srcs.json
export TOK API
read -r CH FROM TO <<<"$(python3 - <<'PY'
import json, os, time, urllib.request
tok = os.environ["TOK"]; api = os.environ["API"]
now = int(time.time() * 1000)
best = None
for s in json.load(open("/tmp/_srcs.json"))["sources"]:
    if s["type"] == "event":
        continue
    url = api + "/api/channels/" + s["id"] + "/timeline?from=%d&to=%d" % (now - 7 * 86400000, now)
    try:
        rq = urllib.request.Request(url, headers={"authorization": "Bearer " + tok})
        d = json.load(urllib.request.urlopen(rq, timeout=20))
    except Exception:
        continue
    if d.get("kind") != "audio":
        continue
    runs = d["media"]["runs"]
    if not runs:
        continue
    total = sum(r["endMs"] - r["startMs"] for r in runs)
    if not best or total > best[0]:
        best = (total, s["id"],
                min(r["startMs"] for r in runs), max(r["endMs"] for r in runs))
print("NONE 0 0" if not best else "%s %d %d" % (best[1], best[2], best[3]))
PY
)"
rm -f /tmp/_srcs.json
[ "$CH" != "NONE" ] && [ -n "${CH:-}" ] || { echo "SKIP: no audio channel with measured media on disk"; exit 0; }
echo "subject: $CH  media $FROM..$TO"

# Pad the window so it contains the media AND some empty time either side: an
# envelope that only ever sees full coverage cannot prove it draws gaps as gaps.
PAD=$(( (TO-FROM)/4 + 60000 ))
WFROM=$((FROM-PAD)); WTO=$((TO+PAD))

# Prime once, then wait for the background pass, so the assertions below measure
# the finished picture rather than a partial one.
get "/channels/$CH/waveform?from=$WFROM&to=$WTO&buckets=600&prime=1" > /dev/null
for _ in $(seq 1 25); do
  DONE=$(get "/channels/$CH/waveform?from=$WFROM&to=$WTO&buckets=600" \
    | python3 -c 'import sys,json;d=json.load(sys.stdin);print("y" if d["complete"] else "n")')
  [ "$DONE" = "y" ] && break
  sleep 2
done
check "the envelope finishes priming" "$DONE" "y"

WF=$(get "/channels/$CH/waveform?from=$WFROM&to=$WTO&buckets=600")
COV=$(get "/channels/$CH/coverage?from=$WFROM&to=$WTO")

echo "$WF" > /tmp/_wf.json; echo "$COV" > /tmp/_cov.json

# ---- 1. continuity: drawn share tracks recorded share ----------------------
CONT=$(python3 - <<'PY'
import json
wf=json.load(open('/tmp/_wf.json')); cov=json.load(open('/tmp/_cov.json'))
b=wf["buckets"]; drawn=sum(1 for x in b if x)/len(b)
rec=cov["coveragePct"]/100.0
# A bucket is painted when a segment overlaps it. The two shares agree to within
# a bucket at each run edge; anything wider means the envelope is combing.
tol=max(0.03, 4.0*len(cov["runs"])/len(b))
print("ok" if abs(drawn-rec)<=tol else f"drawn {drawn:.3f} vs recorded {rec:.3f} (tol {tol:.3f})")
PY
)
check "every recorded bucket is drawn, and only those" "$CONT" "ok"

# ---- 2. gaps are drawn as gaps, not as a floor -----------------------------
GAPS=$(python3 - <<'PY'
import json
wf=json.load(open('/tmp/_wf.json')); cov=json.load(open('/tmp/_cov.json'))
b=wf["buckets"]; n=len(b); span=wf["to"]-wf["from"]
bad=0
for g in cov["gaps"]:
    # buckets strictly inside the gap must be empty
    i0=int((g["fromMs"]-wf["from"])/span*n)+1
    i1=int((g["toMs"]-wf["from"])/span*n)-1
    for i in range(max(0,i0), min(n,i1+1)):
        if b[i]: bad+=1
print("ok" if bad==0 else f"{bad} bucket(s) drawn inside a gap")
PY
)
check "nothing is drawn where nothing was recorded" "$GAPS" "ok"

# ---- 3. linear amplitude, not a block pinned near the top -------------------
SPREAD=$(python3 - <<'PY'
import json,statistics
wf=json.load(open('/tmp/_wf.json'))
v=[x["peak"] for x in wf["buckets"] if x]
if len(v)<8: print("too few buckets to judge"); raise SystemExit
lo,hi,med=min(v),max(v),statistics.median(v)
# The old dB-linear mapping compressed real material into the top of the range.
# Linear amplitude leaves a median well below the ceiling and a real spread.
print("ok" if med<0.9 and (hi-lo)>0.08 else f"median {med:.3f} span {hi-lo:.3f} -- looks compressed")
PY
)
check "peaks are linear amplitude, with real dynamic range" "$SPREAD" "ok"

# ---- 4. peak is never below RMS, nothing exceeds 1 -------------------------
SANE=$(python3 - <<'PY'
import json
wf=json.load(open('/tmp/_wf.json'))
bad=[x for x in wf["buckets"] if x and not (0<=x["rms"]<=x["peak"]<=1.0000001)]
print("ok" if not bad else f"{len(bad)} impossible bucket(s), e.g. {bad[0]}")
PY
)
check "peak >= rms and both stay inside 0..1" "$SANE" "ok"

# ---- 5. bucket count is honoured and bounded -------------------------------
N=$(get "/channels/$CH/waveform?from=$WFROM&to=$WTO&buckets=137" \
  | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["buckets"]))')
check "the requested bucket count is what comes back" "$N" "137"

TOOMANY=$(get "/channels/$CH/waveform?from=$WFROM&to=$WTO&buckets=99999" \
  | python3 -c 'import sys,json;print("error" in json.load(sys.stdin))')
check "an absurd bucket count is refused, not silently clamped" "$TOOMANY" "True"

# ---- 6. a window with no media draws nothing, and says so -------------------
EMPTY=$(get "/channels/$CH/waveform?from=1000000000000&to=1000000600000" \
  | python3 -c '
import sys,json;d=json.load(sys.stdin)
print("ok" if all(x is None for x in d["buckets"]) and d["complete"] and d["pending"]==0 else "drew something")')
check "a window with no media is empty and complete" "$EMPTY" "ok"

# ---- 7. an unbounded window is refused -------------------------------------
WIDE=$(get "/channels/$CH/waveform?from=0&to=9999999999999" \
  | python3 -c 'import sys,json;print("error" in json.load(sys.stdin))')
check "an unbounded window is refused" "$WIDE" "True"

# ---- 8. the cache makes a second look free ---------------------------------
T1=$( { TIMEFORMAT=%R; time get "/channels/$CH/waveform?from=$WFROM&to=$WTO&buckets=600" > /dev/null; } 2>&1 )
FAST=$(python3 -c "print('ok' if float('$T1')<1.5 else 'took ${T1}s')")
check "a primed window answers from cache without decoding" "$FAST" "ok"

rm -f /tmp/_wf.json /tmp/_cov.json
echo
echo "waveform: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
