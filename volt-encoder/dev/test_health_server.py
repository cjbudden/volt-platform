#!/usr/bin/env python3
# ===========================================================================
#  ENCODER HEALTH ENDPOINT: liveness, readiness, Prometheus metrics.
#
#  Pure verdicts for each failure the endpoint must tell apart (a dead
#  packager is a restart, a lost source with no filler is not), the
#  exposition format, the HTTP server on a real socket, and the encoder's own
#  snapshot (encoder.health_snapshot) read from its real state holders.
#    python3 dev/test_health_server.py
# ===========================================================================
import importlib.util
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(HERE, "..", "bin")
sys.path.insert(0, BIN)
import health_server as hs  # noqa: E402

PASS = FAIL = 0


def ok(cond, msg, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"PASS {msg}")
    else:
        FAIL += 1
        print(f"FAIL {msg}" + (f" -- {extra}" if extra else ""))


NOW = 1_800_000_000.0


def snap(**over):
    s = {
        "stream_id": "chan-1", "loop_beat": NOW - 2, "started_at": NOW - 600, "segment_seconds": 4, "segment_age_s": 3,
        "children": [("packager", True, True), ("relay-primary-0", True, False), ("transcode", True, True)],
        "status": {"packager_ok": True, "output_available": True, "active_source": "primary", "filler_in_use": False,
                   "sources": {"primary": {"state": "up"}, "backup": {"state": "up"}, "filler": {"state": "ready"}}},
        "metrics": {"cpu_pct": 42.5, "cpu_cores": 2, "ingest": {"primary-0": {"role": "primary", "label": "1080p", "bytes": 1000, "bps": 5000000}}},
    }
    s.update(over)
    return s


# ---- verdicts ------------------------------------------------------------------
ok(hs.liveness(snap(), NOW) == (True, []), "healthy: live")
ok(hs.readiness(snap(), NOW) == (True, []), "healthy: ready")
l, r = hs.liveness(snap(children=[("packager", False, True), ("relay-primary-0", True, False)]), NOW)
ok(not l and "critical process packager has exited" in r, "dead packager fails liveness", r)
l, r = hs.liveness(snap(children=[("packager", True, True), ("relay-primary-0", False, False)]), NOW)
ok(l, "a dead relay (failover's job) does not fail liveness")
l, r = hs.liveness(snap(loop_beat=NOW - 90), NOW)
ok(not l and "not turning" in r[0], "stalled supervisor loop fails liveness", r)
st = snap()["status"] | {"output_available": False, "active_source": "primary"}
l, _ = hs.liveness(snap(status=st), NOW)
rd, r = hs.readiness(snap(status=st), NOW)
ok(l and not rd and "no output" in r[0], "source lost with no filler: live but not ready (a restart would not help)", r)
st2 = snap()["status"] | {"active_source": "filler", "filler_in_use": True}
ok(hs.readiness(snap(status=st2), NOW)[0], "filler on air is ready: viewers have a picture")
rd, r = hs.readiness(snap(segment_age_s=20), NOW)
ok(not rd and "20s old (limit 12s)" in r[0], "stale segments fail readiness", r)
ok(not hs.readiness(snap(segment_age_s=None), NOW)[0], "no segment yet: not ready")

# ---- exposition ------------------------------------------------------------------
txt = hs.render_metrics(snap(), NOW)
ok('volt_encoder_up{stream="chan-1"} 1' in txt and 'volt_encoder_ready{stream="chan-1"} 1' in txt, "up and ready gauges")
ok('volt_encoder_active_source{stream="chan-1",source="primary"} 1' in txt and 'volt_encoder_active_source{stream="chan-1",source="backup"} 0' in txt, "active source one-hot")
ok('volt_encoder_child_up{stream="chan-1",name="packager",critical="true"} 1' in txt, "child gauges")
ok('volt_encoder_ingest_bits_per_second{stream="chan-1",input="primary-0",role="primary"} 5e+06' in txt, "ingest bps", txt)
ok('volt_encoder_cpu_percent{stream="chan-1"} 42.5' in txt and 'volt_encoder_uptime_seconds{stream="chan-1"} 600' in txt, "cpu and uptime")
ok(all(re.match(r'^(# (HELP|TYPE) \S+ .+|[a-z_]+(\{[^}]*\})? -?[0-9.e+]+)$', line) for line in txt.strip().split("\n")), "every line is valid exposition format")
ok("volt_encoder_output_available" in txt and "None" not in txt, "unknown values are left out, never printed as None")
nasty = hs.render_metrics(snap(stream_id='a"b\\c'), NOW)
ok('stream="a\\"b\\\\c"' in nasty, "label values are escaped")

# ---- the server on a socket --------------------------------------------------------
state = {"s": snap(loop_beat=time.time())}
srv = hs.start(0, lambda: state["s"], bind="127.0.0.1")
base = f"http://127.0.0.1:{srv.server_address[1]}"


def get(path):
    try:
        with urllib.request.urlopen(base + path, timeout=5) as r:
            return r.status, r.headers.get("Content-Type"), r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type"), e.read().decode()


c, t, b = get("/healthz")
ok(c == 200 and json.loads(b)["ok"], "GET /healthz 200")
c, t, b = get("/metrics")
ok(c == 200 and t.startswith("text/plain; version=0.0.4") and "volt_encoder_up" in b, "GET /metrics text exposition")
c, t, b = get("/status")
ok(c == 200 and json.loads(b)["active_source"] == "primary", "GET /status is the status snapshot")
state["s"] = snap(loop_beat=time.time(), children=[("packager", False, True)])
c, t, b = get("/healthz")
ok(c == 503 and "packager" in b, "GET /healthz 503 with the reason when the packager died")
state["s"] = snap(loop_beat=time.time(), segment_age_s=60)
ok(get("/readyz")[0] == 503 and get("/healthz")[0] == 200, "stale output: /readyz 503, /healthz still 200")
ok(get("/nope")[0] == 404, "unknown path 404")
srv.shutdown()

# ---- the encoder's own snapshot ----------------------------------------------------
spec = importlib.util.spec_from_file_location("enc", os.path.join(BIN, "encoder.py"))
enc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(enc)
out = tempfile.mkdtemp(prefix="volt-health-", dir=os.environ.get("TMPDIR"))
os.makedirs(os.path.join(out, "720p"))
seg = os.path.join(out, "720p", "seg_00001.m4s")
open(seg, "wb").write(b"x")
os.utime(seg, (time.time() - 5, time.time() - 5))


class P:
    def __init__(self, rc): self.rc = rc
    def poll(self): return self.rc


enc.OUT_DIR = out
enc._children[:] = [("packager", P(None), True), ("relay-primary-0", P(1), False)]
enc._health["loop_beat"] = time.time()
enc._health["metrics"] = {"cpu_pct": 10.0, "cpu_cores": 1, "ingest": {}}
s = enc.health_snapshot({"stream_id": "chan-9", "segment_seconds": 4})
ok(s["children"] == [("packager", True, True), ("relay-primary-0", False, False)], "snapshot: children with liveness and criticality")
ok(4 <= s["segment_age_s"] < 8, f"snapshot: newest segment age from the output tree ({s['segment_age_s']:.1f}s)")
ok(s["stream_id"] == "chan-9" and s["segment_seconds"] == 4 and s["metrics"]["cpu_pct"] == 10.0, "snapshot: stream, segment length, metrics")
ok(hs.liveness(s)[0], "snapshot of a running encoder is live")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
