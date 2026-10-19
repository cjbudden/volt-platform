#!/usr/bin/env python3
"""Live burn-in harness: latency, glass-to-glass, stalls and fault injection.

Topology (all on this box, realtime):

  python producer --raw 720p25, wall-clock barcode in every frame-->  ffmpeg x264 ultrafast
     --> MPEG-TS over UDP (output_ts_offset 36000 s: a live source with LARGE PTS)
     --> ENCODER UNDER TEST: decode, [overlay gfx ONCE], split=4, 3x x264 ladder + audio,
         4th branch = 640x360 gray "tap" on stdout
  sidecar (Node + headless Chromium, scorebug template) --> gfx.png (file) | FIFO (raw RGBA) | movie=
  this script reads the tap: decodes the barcode (main-path latency, freezes) and the
  marker square the sidecar draws (state-change-to-output latency).

Usage: python3 bench/live_test.py --gfx none|file|fifo|movie [--faults] [--secs 60]
"""
import argparse, json, os, signal, socket, subprocess, sys, threading, time, statistics
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
OUT = os.path.join(ROOT, "out", "live")
os.makedirs(OUT, exist_ok=True)

ap = argparse.ArgumentParser()
ap.add_argument("--gfx", default="file")
ap.add_argument("--faults", action="store_true")
ap.add_argument("--secs", type=int, default=50)
ap.add_argument("--tqs", type=int, default=0, help="thread_queue_size for the gfx input (0 = default)")
ap.add_argument("--port", type=int, default=8190)
ap.add_argument("--tag", default="")
ap.add_argument("--eof", default="repeat")
ap.add_argument("--no-corrupt", action="store_true")
ap.add_argument("--gfx-re", action="store_true", help="-re on the gfx input")
a = ap.parse_args()
TAG = a.tag or a.gfx + ("_faults" if a.faults else "")

W, H, FPS = 1280, 720, 25
TW, TH = 640, 360
UDP = "udp://127.0.0.1:5600"
T0 = time.time()
now_ms = lambda: (time.time() - T0) * 1000.0
events = []
def ev(_e, **k):
    k.update(ev=_e, t=round(now_ms(), 1)); events.append(k); print(json.dumps(k), flush=True)

GFX_FILE = os.path.join(OUT, "gfx.png")
GFX_FIFO = os.path.join(OUT, "gfx.rgba")
SLOG = os.path.join(OUT, f"sidecar_{TAG}.jsonl")
for p in (GFX_FILE, SLOG):
    if os.path.exists(p): os.remove(p)

# ---------------- sidecar ----------------
side = None
def start_sidecar():
    global side
    args = ["node", os.path.join(ROOT, "sidecar", "sidecar.js"), "--template", "scorebug",
            "--port", str(a.port), "--log", SLOG]
    if a.gfx in ("file", "movie"): args += ["--file", GFX_FILE]
    if a.gfx == "fifo":
        if not os.path.exists(GFX_FIFO): os.mkfifo(GFX_FIFO)
        args += ["--fifo", GFX_FIFO]
    side = subprocess.Popen(args, cwd=ROOT, start_new_session=True,
                            stdout=subprocess.DEVNULL, stderr=open(os.path.join(OUT, f"sidecar_{TAG}.err"), "w"))
    ev("sidecar_start", pid=side.pid)

def wait_ready(timeout=30):
    t = time.time()
    while time.time() - t < timeout:
        try:
            for line in open(SLOG):
                if '"ready"' in line: return True
        except FileNotFoundError: pass
        time.sleep(0.05)
    return False

def post(path, obj=None):
    s = socket.create_connection(("127.0.0.1", a.port), timeout=2)
    body = json.dumps(obj or {}).encode()
    s.sendall(f"POST {path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode() + body)
    s.recv(100); s.close()

# ---------------- producer ----------------
def producer(stop):
    p = subprocess.Popen(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "yuv420p",
                          "-s", f"{W}x{H}", "-framerate", str(FPS), "-i", "pipe:0",
                          "-re", "-f", "lavfi", "-i", "sine=f=1000:sample_rate=48000",
                          "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
                          "-g", "25", "-b:v", "4M", "-c:a", "aac", "-f", "mpegts", "-output_ts_offset", "36000",
                          UDP + "?pkt_size=1316"], stdin=subprocess.PIPE)
    y = np.tile(np.linspace(40, 200, W, dtype=np.uint8), (H, 1))
    uv = np.full((H // 2) * (W // 2) * 2, 128, np.uint8).tobytes()
    n = 0; t0 = time.time()
    while not stop.is_set():
        stamp = int(now_ms()) & 0xFFFFFFFF
        f = y.copy()
        for i in range(32):
            f[300:340, i * 40:(i + 1) * 40] = 235 if (stamp >> (31 - i)) & 1 else 16
        bx = (n * 8) % (W - 100); f[500:600, bx:bx + 100] = 255
        try:
            p.stdin.write(f.tobytes()); p.stdin.write(uv)
        except BrokenPipeError: break
        n += 1
        d = t0 + n / FPS - time.time()
        if d > 0: time.sleep(d)
    p.stdin.close(); p.terminate()

# ---------------- encoder under test ----------------
def encoder_cmd():
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-nostdin", "-y",
           "-fflags", "+genpts", "-analyzeduration", "2000000", "-probesize", "2000000",
           "-i", UDP + "?fifo_size=100000&overrun_nonfatal=1"]
    tq = (["-thread_queue_size", str(a.tqs)] if a.tqs else []) + (["-re"] if a.gfx_re else [])
    gx, gy, gw = 43, 29, 448   # 1920x1080 canvas bbox (64,44,672,112) scaled to the 720p source
    if a.gfx == "file":
        cmd += tq + ["-f", "image2", "-loop", "1", "-framerate", str(FPS), "-i", GFX_FILE]
        g = f"[1:v]scale={gw}:-2[g];[0:v][g]overlay={gx}:{gy}:eof_action={a.eof}[c];"
    elif a.gfx == "fifo":
        cmd += tq + ["-f", "rawvideo", "-pix_fmt", "rgba", "-video_size", "672x112", "-framerate", str(FPS), "-i", GFX_FIFO]
        g = f"[1:v]scale={gw}:-2[g];[0:v][g]overlay={gx}:{gy}:eof_action={a.eof}[c];"
    elif a.gfx == "movie":
        g = f"movie=filename={GFX_FILE}:loop=0,setpts=N/{FPS}/TB,scale={gw}:-2[g];[0:v][g]overlay={gx}:{gy}:eof_action={a.eof}[c];"
    else:
        g = "[0:v]null[c];"
    g += "[c]split=4[a][b][d][t];[a]scale=-2:720[v0];[b]scale=-2:480[v1];[d]scale=-2:360[v2];[t]scale=640:360,format=gray[tap]"
    cmd += ["-filter_complex", g]
    for i, kb in enumerate([3000, 1500, 800]):
        cmd += ["-map", f"[v{i}]", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", f"{kb}k", "-g", "100",
                "-keyint_min", "100", "-sc_threshold", "0", "-r", str(FPS), "-an"]
        if i == 0:
            cmd += ["-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-f", "mpegts", os.path.join(OUT, f"rung0_{TAG}.ts")]
        else:
            cmd += ["-f", "mpegts", "/dev/null"]
    cmd += ["-map", "[tap]", "-f", "rawvideo", "pipe:1"]
    return cmd

frames = []   # (wall_ms, stamp_ms, markerY)
def tap_reader(p):
    sz = TW * TH
    while True:
        b = p.stdout.read(sz)
        if not b or len(b) < sz: break
        t = now_ms()
        f = np.frombuffer(b, np.uint8).reshape(TH, TW)
        bits = (f[160, 10::20][:32] > 128).astype(np.int64)
        stamp = int((bits * (1 << np.arange(31, -1, -1, dtype=np.int64))).sum())
        m = float(f[16:19, 23:26].mean())
        frames.append((t, stamp, m))

def tree(pid):
    """pid and all descendants (Playwright puts Chromium in its own process group)."""
    kids = {}
    for d in os.listdir("/proc"):
        if d.isdigit():
            try: kids.setdefault(int(open(f"/proc/{d}/stat").read().rsplit(")", 1)[1].split()[1]), []).append(int(d))
            except Exception: pass
    out, st = [], [pid]
    while st:
        q = st.pop(); out.append(q); st += kids.get(q, [])
    return out

def proc_cpu(pid):
    """utime+stime (s) of pid and all descendants."""
    tot = 0.0
    for k in tree(pid):
        try:
            st = open(f"/proc/{k}/stat").read().rsplit(")", 1)[1].split()
            tot += (int(st[11]) + int(st[12])) / os.sysconf("SC_CLK_TCK")
        except Exception: pass
    return tot

def rss_mb(pid):
    tot = 0
    for k in tree(pid):
        try:
            for l in open(f"/proc/{k}/status"):
                if l.startswith("VmRSS"): tot += int(l.split()[1])
        except Exception: pass
    return tot / 1024

def signal_tree(pid, sig):
    for k in tree(pid):
        try: os.kill(k, sig)
        except Exception: pass

# ---------------- run ----------------
import atexit
def _cleanup():
    for pr in [globals().get("enc"), globals().get("side")]:
        try: os.killpg(os.getpgid(pr.pid), signal.SIGKILL)
        except Exception: pass
    subprocess.run(["pkill", "-f", "[u]dp://127.0.0.1:5600"])
atexit.register(_cleanup)
stop = threading.Event()
if a.gfx != "none":
    start_sidecar()
    if not wait_ready(): print("sidecar not ready"); sys.exit(1)
    ev("sidecar_ready")
    post("/state", {"home": "AUK", "away": "WLG", "homeScore": 0, "awayScore": 0, "clock": "00:00", "marker": 0})
    post("/play")
    time.sleep(1.5)
threading.Thread(target=producer, args=(stop,), daemon=True).start()
enc = subprocess.Popen(encoder_cmd(), stdout=subprocess.PIPE, stderr=open(os.path.join(OUT, f"encoder_{TAG}.err"), "w"),
                       start_new_session=True)
ev("encoder_start")
threading.Thread(target=tap_reader, args=(enc,), daemon=True).start()

MARKS = [230, 30, 160, 90]
posts = []   # (t_ms, value)
mi = 0
def mark():
    global mi
    v = MARKS[mi % len(MARKS)]; mi += 1
    t = now_ms()
    try: post("/state", {"marker": v}); posts.append((t, v))
    except Exception as e: ev("post_failed", err=str(e)); posts.append((t, v, "failed"))

def sleep_until(s):
    d = T0 + s - time.time()
    if d > 0: time.sleep(d)

cpu_samples = {}
def cpu_window(name, t_from, t_to, pid):
    sleep_until(t_from); c0 = proc_cpu(pid); w0 = time.time()
    return lambda: cpu_samples.__setitem__(name, round((proc_cpu(pid) - c0) / (time.time() - w0) * 100, 1))

sleep_until(8)
ev("phase", name="steady")
if a.gfx != "none":
    side_c0, enc_c0, w0 = proc_cpu(side.pid), proc_cpu(enc.pid), time.time()
    # idle window: 8-14s no changes
    sleep_until(14)
    cpu_samples["sidecar_idle_cpu%"] = round((proc_cpu(side.pid) - side_c0) / (time.time() - w0) * 100, 1)
    cpu_samples["encoder_cpu%_idle"] = round((proc_cpu(enc.pid) - enc_c0) / (time.time() - w0) * 100, 1)
    cpu_samples["sidecar_rss_mb"] = round(rss_mb(side.pid))
    side_c0, enc_c0, w0 = proc_cpu(side.pid), proc_cpu(enc.pid), time.time()
    for k in range(12):          # 14-26s: a change every second (score flash + marker)
        sleep_until(14 + k)
        mark()
        if k % 3 == 0: post("/state", {"homeScore": k // 3 + 1})
    sleep_until(26)
    cpu_samples["sidecar_busy_cpu%"] = round((proc_cpu(side.pid) - side_c0) / (time.time() - w0) * 100, 1)
    cpu_samples["encoder_cpu%_busy"] = round((proc_cpu(enc.pid) - enc_c0) / (time.time() - w0) * 100, 1)
else:
    c0, w0 = proc_cpu(enc.pid), time.time(); sleep_until(26)
    cpu_samples["encoder_cpu%"] = round((proc_cpu(enc.pid) - c0) / (time.time() - w0) * 100, 1)

if a.faults and a.gfx != "none":
    ev("fault", name="SIGSTOP sidecar (hung Chromium) 26-32s, change posted at 28s")
    signal_tree(side.pid, signal.SIGSTOP)
    sleep_until(28)
    threading.Thread(target=mark, daemon=True).start()   # blocks until SIGCONT
    sleep_until(32)
    signal_tree(side.pid, signal.SIGCONT); ev("fault", name="SIGCONT sidecar")
    sleep_until(34); mark()
    sleep_until(36)
    ev("fault", name="SIGKILL sidecar + Chromium")
    signal_tree(side.pid, signal.SIGKILL)
    sleep_until(38)
    if a.gfx in ("file", "movie") and not a.no_corrupt:
        ev("fault", name="corrupt gfx.png in place (non-atomic garbage write)")
        open(GFX_FILE, "wb").write(b"\x89PNG\r\n\x1a\n garbage")
    sleep_until(40)
    ev("fault", name="restart sidecar")
    start_sidecar(); ok = wait_ready(); ev("sidecar_ready_again", ok=ok)
    try:
        post("/state", {"home": "AUK", "away": "WLG", "homeScore": 9, "awayScore": 9, "clock": "45:00", "marker": 0}); post("/play")
    except Exception as e: ev("post_failed", err=str(e))
    for k in range(4):
        sleep_until(46 + k * 1.5); mark()
    if a.gfx in ("file", "movie"):
        sleep_until(52)
        ev("fault", name="DELETE gfx.png for 1 s, then a change")
        os.remove(GFX_FILE); time.sleep(1.0)
        sleep_until(54); mark(); sleep_until(56); mark()
    end = max(a.secs, 59)
else:
    end = a.secs
sleep_until(end)
stop.set()
time.sleep(0.5)
enc_alive = enc.poll() is None
os.killpg(os.getpgid(enc.pid), signal.SIGINT)
try: enc.wait(5)
except Exception: os.killpg(os.getpgid(enc.pid), signal.SIGKILL)
if side and side.poll() is None:
    os.killpg(os.getpgid(side.pid), signal.SIGTERM)

# ---------------- analysis ----------------
res = {"tag": TAG, "gfx": a.gfx, "faults": a.faults, "encoder_alive_at_end": enc_alive, "frames": len(frames)}
steady = [f for f in frames if 8000 <= f[0] <= 26000]
lat = [f[0] - f[1] for f in steady if 0 < f[0] - f[1] < 60000]
if lat:
    res["main_latency_ms_median"] = round(statistics.median(lat), 1)
    res["main_latency_ms_p95"] = round(sorted(lat)[int(len(lat) * .95)], 1)
gaps = [(frames[i][0] - frames[i - 1][0], frames[i][0]) for i in range(1, len(frames)) if 6000 < frames[i][0] < (end - 0.5) * 1000]
res["max_tap_gap_ms"] = round(max(g for g, _ in gaps), 1) if gaps else None
res["max_tap_gap_at_s"] = round(max(gaps)[1] / 1000, 1) if gaps else None
# frozen main picture: same stamp on consecutive output frames
frozen = sum(1 for i in range(1, len(frames)) if frames[i][1] == frames[i - 1][1] and frames[i][0] > 6000)
res["repeated_main_frames"] = frozen
# main-path latency over the whole run, per 2 s bucket (shows a stall + catch-up)
buckets = {}
for t, s, m in frames:
    if 0 < t - s < 60000: buckets.setdefault(int(t // 2000) * 2, []).append(t - s)
res["main_latency_by_2s"] = {k: round(statistics.median(v)) for k, v in sorted(buckets.items())}
# state-change -> output latency
Y = lambda v: v   # measured: the tap carries the marker grey 1:1 (30->30, 90->90, 160->160, 230->231)
glat = []
for p in posts:
    t, v = p[0], p[1]
    hit = next((f for f in frames if f[0] >= t and abs(f[2] - Y(v)) < 12), None)
    seen = sorted({round(f[2]) for f in frames if t <= f[0] <= t + 1500})
    glat.append((round(t / 1000, 1), v, round(hit[0] - t, 1) if hit else None, seen[:8]))
res["gfx_change_latency"] = glat
ok = [g[2] for g in glat if g[2] is not None and g[0] < 27]
res['gfx_latency_ms_after_restart'] = [g[2] for g in glat if 45 < g[0] < 52]
if ok:
    res["gfx_latency_ms_median_steady"] = round(statistics.median(ok), 1)
    res["gfx_latency_ms_max_steady"] = round(max(ok), 1)
res["cpu"] = cpu_samples
res["events"] = [e for e in events if e["ev"] in ("fault", "sidecar_ready_again", "post_failed", "sidecar_ready", "sidecar_start")]
try:
    import re
    lines = [l.strip() for l in open(os.path.join(OUT, f"encoder_{TAG}.err")) if l.strip()]
    res["encoder_log_tail"] = lines[-8:]
    res["encoder_log_lines"] = len(lines)
except Exception: pass
# A/V start alignment of rung0 (video vs audio first PTS)
try:
    pr = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,start_time", "-of", "json",
                         os.path.join(OUT, f"rung0_{TAG}.ts")], capture_output=True, text=True).stdout
    st = {s["codec_type"]: float(s["start_time"]) for s in json.loads(pr)["streams"]}
    res["rung0_av_start_delta_ms"] = round((st.get("audio", 0) - st.get("video", 0)) * 1000, 1)
except Exception as e: res["rung0_av_start_delta_ms"] = str(e)
json.dump(res, open(os.path.join(OUT, f"result_{TAG}.json"), "w"), indent=1)
print(json.dumps({k: v for k, v in res.items() if k not in ("main_latency_by_2s",)}, indent=1))
print("main_latency_by_2s", res["main_latency_by_2s"])
