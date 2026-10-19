#!/usr/bin/env python3
"""What does a continuously animated ticker cost?

A) In Chromium: sidecar renders the ticker template every frame (1920x56 bbox, 25 fps,
   virtual clock stepped once per frame). Measure sidecar+Chromium CPU over 30 s,
   per-frame render time (median/p95 from the sidecar log) and whether it held 25 fps.
B) Native in ffmpeg: drawbox band + drawtext crawl with x = w - mod(t*120, w+tw),
   text from a reloadable file. Measured as a cpu_bench.py variant (ONLY=baseline,ticker_drawtext).
"""
import json, os, signal, subprocess, time
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "out", "ticker"); os.makedirs(OUT, exist_ok=True)
LOG = os.path.join(OUT, "sidecar.jsonl")
if os.path.exists(LOG): os.remove(LOG)

import sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
def _tree(pid):
    kids = {}
    for d in os.listdir("/proc"):
        if d.isdigit():
            try: kids.setdefault(int(open(f"/proc/{d}/stat").read().rsplit(")", 1)[1].split()[1]), []).append(int(d))
            except Exception: pass
    out, st = [], [pid]
    while st:
        q = st.pop(); out.append(q); st += kids.get(q, [])
    return out
def cpu(pid):
    t = 0.0
    for k in _tree(pid):
        try:
            st = open(f"/proc/{k}/stat").read().rsplit(")", 1)[1].split(); t += (int(st[11]) + int(st[12])) / os.sysconf("SC_CLK_TCK")
        except Exception: pass
    return t
def rss(pid):
    t = 0
    for k in _tree(pid):
        try:
            for l in open(f"/proc/{k}/status"):
                if l.startswith("VmRSS"): t += int(l.split()[1])
        except Exception: pass
    return round(t / 1024)

p = subprocess.Popen(["node", "sidecar/sidecar.js", "--template", "ticker", "--port", "8097", "--file", os.path.join(OUT, "ticker.png"),
                      "--log", LOG, "--autoplay"], cwd=ROOT, start_new_session=True)
for _ in range(100):
    if os.path.exists(LOG) and "ready" in open(LOG).read(): break
    time.sleep(0.2)
time.sleep(3)
pg = p.pid
c0, w0 = cpu(pg), time.time()
fo0 = int(open(LOG).read().count("frame_out"))
time.sleep(30)
c1, w1 = cpu(pg), time.time()
import urllib.request
h = json.loads(urllib.request.urlopen("http://127.0.0.1:8097/health").read())
res = {"chromium_ticker_cpu_pct": round((c1 - c0) / (w1 - w0) * 100, 1), "rss_mb": rss(pg),
       "continuous_log": [json.loads(l) for l in open(LOG) if '"continuous"' in l][-3:], "health": h}
p.send_signal(signal.SIGTERM)
print(json.dumps(res, indent=1))
json.dump(res, open(os.path.join(OUT, "result.json"), "w"), indent=1)
