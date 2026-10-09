#!/usr/bin/env bash
# ============================================================================
#  A HEARTBEAT IS NOT AN EVENT.
#
#  radio.py runs a ten-second beat that calls EventLog.packager(True) for as
#  long as a station lives. That beat is correct and must stay: the five-gate
#  health model reads report FRESHNESS, so silence has to mean something is
#  wrong rather than something is quiet.
#
#  What was wrong is that packager() emitted an EVENT on every call. Six rows a
#  minute, 360 an hour, 8,640 a day, per running station, into a stream_events
#  table that nothing prunes. On a real machine the fleet activity log is sixty
#  rows, so ONE station's heartbeat reduced the whole fleet's history to about
#  nine minutes and pushed a crash loop off the end of the page before anybody
#  could read it.
#
#  A LEVEL WAS BEING REPORTED AS AN EDGE. source_state(), ten lines below it in
#  the same file, has always had the transition guard and says so in its own
#  docstring. This suite pins the same rule for packager(), and pins the half
#  that must NOT become conditional: _publish() still runs every single call,
#  because that is what carries the freshness the gates read.
#
#  Usage: bash test/packager-heartbeat.check.sh     (no database, no API)
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."
BIN="$(cd .. && pwd)/volt-encoder/bin"

if [ ! -f "$BIN/events.py" ]; then
  echo "FAIL cannot find volt-encoder/bin/events.py at $BIN"
  echo "packager-heartbeat: 0 passed, 1 failed"
  exit 1
fi

python3 - "$BIN" <<'PY'
import sys, importlib.util, pathlib

bin_dir = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("volt_events", bin_dir / "events.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

npass = nfail = 0
def ok(m):
    global npass; npass += 1; print("PASS " + m)
def bad(m, d):
    global nfail; nfail += 1; print(f"FAIL {m} -- {d}")
def check(m, got, want):
    ok(m) if got == want else bad(m, f"expected [{want}] got [{got}]")

def make():
    """An EventLog with nowhere to report to, capturing what it emits, and
    counting publishes so the freshness half can be asserted separately."""
    emitted = []
    t = [0]
    def clock():
        t[0] += 1000          # a second per call, so events are ordered
        return float(t[0])
    log = mod.EventLog("chan-1", clock, report_url=None, report_token=None,
                       status_path=None, emit=lambda line: emitted.append(line))
    published = [0]
    real_publish = log._publish
    def counting_publish(*a, **k):
        published[0] += 1
        return real_publish(*a, **k)
    log._publish = counting_publish
    return log, emitted, published

def count(emitted, needle):
    return sum(1 for line in emitted if needle in line)

# -- the heartbeat --------------------------------------------------------
print("== a station beating for five minutes emits ONE packager.up ==")
log, emitted, published = make()
for _ in range(30):                     # 30 beats = 5 minutes at 10s
    log.packager(True)
check("one event, not thirty", count(emitted, "packager.up"), 1)
check("and no spurious down", count(emitted, "packager.down"), 0)
check("but the status was published every beat", published[0], 30)
check("and the level itself is recorded", log.status["packager_ok"], True)

# -- a real transition ----------------------------------------------------
print("\n== a REAL change still speaks, immediately ==")
log.packager(False)
check("the down edge is emitted", count(emitted, "packager.down"), 1)
check("the level followed it", log.status["packager_ok"], False)
for _ in range(10):
    log.packager(False)
check("and repeating it stays silent", count(emitted, "packager.down"), 1)
log.packager(True)
check("recovery is emitted too", count(emitted, "packager.up"), 2)
check("publishes kept up with all of it", published[0], 30 + 1 + 10 + 1)

# -- the first call from a cold start -------------------------------------
print("\n== the first beat of a run is a change, so it is not swallowed ==")
log2, emitted2, published2 = make()
check("nothing emitted before it", count(emitted2, "packager."), 0)
log2.packager(True)
check("the first packager.up survives the guard", count(emitted2, "packager.up"), 1)

# -- the shape of the rule, stated ----------------------------------------
print("\n== the guard is the same one source_state has ==")
src = (bin_dir / "events.py").read_text()
body = src.split("def packager(", 1)[1].split("def source_state", 1)[0]
check("packager() compares before emitting", "changed" in body, True)
check("and _publish is NOT inside the conditional",
      body.rstrip().endswith("self._publish()"), True)

print(f"\npackager-heartbeat: {npass} passed, {nfail} failed")
sys.exit(1 if nfail else 0)
PY
