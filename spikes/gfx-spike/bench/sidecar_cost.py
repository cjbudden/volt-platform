#!/usr/bin/env python3
"""Sidecar resource cost: Node + the whole headless Chromium process tree.

(Playwright starts Chromium in its OWN process group, so this walks the parent/child
tree from /proc rather than using the process group.)

Phases, 20 s each, for N concurrent sidecars (one per channel binding):
  idle      no state changes
  updates   one marker update per second per sidecar (cut, 2 frames rendered)
  flashes   one score change per second per sidecar (800 ms CSS flash, ~22 frames)
Reports CPU % (100 = one core) and total RSS (PSS would be lower: Chromium shares pages).
Usage: python3 bench/sidecar_cost.py [N]
"""
import json, os, signal, subprocess, sys, time, urllib.request, threading
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "out", "sidecar_cost"); os.makedirs(OUT, exist_ok=True)
N = int(sys.argv[1]) if len(sys.argv) > 1 else 1
TPL = os.environ.get("TPL", "scorebug")
TCK = os.sysconf("SC_CLK_TCK")

def tree(pid):
    kids = {}
    for d in os.listdir("/proc"):
        if d.isdigit():
            try:
                pp = int(open(f"/proc/{d}/stat").read().rsplit(")", 1)[1].split()[1]); kids.setdefault(pp, []).append(int(d))
            except Exception: pass
    out, st = [], [pid]
    while st:
        p = st.pop(); out.append(p); st += kids.get(p, [])
    return out

def cpu_s(pids):
    t = 0.0
    for p in pids:
        try:
            s = open(f"/proc/{p}/stat").read().rsplit(")", 1)[1].split(); t += (int(s[11]) + int(s[12])) / TCK
        except Exception: pass
    return t

def mem(pids):
    rss = pss = 0
    for p in pids:
        try:
            for l in open(f"/proc/{p}/smaps_rollup"):
                if l.startswith("Rss:"): rss += int(l.split()[1])
                if l.startswith("Pss:"): pss += int(l.split()[1])
        except Exception: pass
    return round(rss / 1024), round(pss / 1024)

def post(port, path, body):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json"})
    urllib.request.urlopen(req, timeout=5).read()

procs = []
for i in range(N):
    port = 8300 + i
    log = os.path.join(OUT, f"s{i}.jsonl")
    if os.path.exists(log): os.remove(log)
    procs.append((port, log, subprocess.Popen(["node", "sidecar/sidecar.js", "--template", TPL, "--port", str(port),
                                               "--file", os.path.join(OUT, f"g{i}.png"), "--log", log], cwd=ROOT)))
t_start = time.time()
for port, log, p in procs:
    while not (os.path.exists(log) and "ready" in open(log).read()): time.sleep(0.1)
    post(port, "/state", {"home": "AUK", "away": "WLG", "homeScore": 0, "awayScore": 0, "clock": "00:00",
                          "f0": "Name", "f1": "Title"}); post(port, "/play", {})
startup = round(time.time() - t_start, 1)
time.sleep(3)
pids = lambda: [x for _, _, p in procs for x in tree(p.pid)]

def phase(name, action):
    c0, w0 = cpu_s(pids()), time.time()
    end = w0 + 20; k = 0
    while time.time() < end:
        if action:
            for port, _, _ in procs: action(port, k)
        k += 1; time.sleep(max(0, w0 + k - time.time()))
    cpu = (cpu_s(pids()) - c0) / (time.time() - w0) * 100
    rss, pss = mem(pids())
    return {"phase": name, "cpu_pct": round(cpu, 1), "rss_mb": rss, "pss_mb": pss}

res = {"sidecars": N, "template": TPL, "startup_s_all": startup, "procs_per_sidecar": len(pids()) // N}
res["phases"] = [phase("idle", None),
                 phase("updates_1Hz", lambda port, k: post(port, "/state", {"marker": (k * 37) % 255, "f1": f"Title {k}"})),
                 phase("flash_1Hz", lambda port, k: post(port, "/state", {"homeScore": k + 1, "f0": f"Name {k}"}))]
# render timings from the logs
med = []
for _, log, _ in procs:
    med += [json.loads(l)["medFrameMs"] for l in open(log) if '"rendered"' in l]
med.sort(); res["render_ms_per_frame_median"] = med[len(med) // 2] if med else None
for _, _, p in procs: p.send_signal(signal.SIGTERM)
time.sleep(2)
print(json.dumps(res, indent=1))
json.dump(res, open(os.path.join(OUT, f"result_{TPL}_{N}.json"), "w"), indent=1)
