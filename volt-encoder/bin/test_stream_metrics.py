import os, subprocess, sys, tempfile, time
sys.path.insert(0, os.path.dirname(__file__))
import stream_metrics as sm

ok = 0; bad = 0
def check(m, c):
    global ok, bad
    print(("PASS " if c else "FAIL ") + m); ok += c; bad += (not c)

# 1) progress tail parsing
d = tempfile.mkdtemp()
p = os.path.join(d, "p.txt")
open(p, "w").write("x" * 10000 + "\ntotal_size=100\nprogress=continue\ntotal_size=250\nprogress=continue\n")
check("reads the newest total_size from the tail only", sm.progress_total_bytes(p) == 250)
check("a missing file is None", sm.progress_total_bytes(os.path.join(d, "none")) is None)

# 2) injected: rates, restart carry, cpu
clock = [0.0]; raw = {"a": 0}; ticks = {1: 0, 2: 0}
m = sm.StreamMetrics(pids=lambda: list(ticks), inputs=lambda: [("primary:720p", "primary", "720p", "a")],
    clock=lambda: clock[0], clk_tck=100, ticks=lambda pid: ticks.get(pid), total=lambda k: raw[k],
    cores=lambda: 2.0, own_netns=lambda: False)
s = m.sample()
check("first sample: no rate or cpu yet (nothing to divide by)", s["cpu_pct"] is None and s["ingest"]["primary:720p"]["bps"] is None)
clock[0] = 10; raw["a"] = 10 * 250_000; ticks[1] = 500; ticks[2] = 300   # 8 s of CPU in 10 s on 2 cores
s = m.sample()
check("rate: 2.5 MB in 10 s is 2 Mbps", s["ingest"]["primary:720p"]["bps"] == 2_000_000)
check("cpu: 8 core-seconds in 10 s of 2 cores is 40%", s["cpu_pct"] == 40.0)
clock[0] = 20; raw["a"] = 1_000_000; ticks[1] = 600; del ticks[2]          # relay restarted, a process exited
s = m.sample()
check("a restarted relay keeps the total", s["ingest"]["primary:720p"]["bytes"] == 2_500_000 + 1_000_000)
check("...and its rate is the new bytes", s["ingest"]["primary:720p"]["bps"] == 800_000)
check("an exited process does not make cpu negative", s["cpu_pct"] == 5.0)

# 3) real: our own process tree through /proc, and a real ffmpeg -progress file
if os.path.exists("/proc/self/stat"):
    prog = os.path.join(d, "real.txt")
    src = "testsrc2=size=640x360:rate=25"
    proc = subprocess.Popen(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-progress", prog, "-stats_period", "1",
                             "-re", "-f", "lavfi", "-i", src, "-t", "8", "-c:v", "libx264", "-preset", "veryfast", "-b:v", "1500k",
                             "-f", "mpegts", "-y", os.devnull])
    real = sm.StreamMetrics(pids=lambda: [os.getpid(), proc.pid], inputs=lambda: [("primary:r0", "primary", "r0", prog)])
    time.sleep(1.5); real.sample(); time.sleep(4); s = real.sample()
    proc.wait()
    r = s["ingest"].get("primary:r0", {})
    print("   real:", s)
    check("real ffmpeg: a rate around 1.5 Mbps is read from its progress file", r.get("bps") is not None and 600_000 < r["bps"] < 3_000_000)
    check("real ffmpeg: cpu is measured and above zero", s["cpu_pct"] is not None and s["cpu_pct"] > 0)
print(f"\nstream_metrics: {ok} passed, {bad} failed"); sys.exit(1 if bad else 0)
