#!/usr/bin/env python3
"""Deterministic tests for the source-selector logic (no processes spawned).
Run: python3 bin/test_source_selector.py"""
import sys
sys.path.insert(0, "bin")
sys.path.insert(0, ".")
import source_selector as ss

FAILS = []
def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        FAILS.append(name)

# ---------------- Health hysteresis ----------------
def test_health_up_hold():
    h = ss.Health(up_hold=3.0, down_hold=2.0, start_up=False)
    check("health starts down", h.state == "down")
    check("health still down before up_hold", h.sample(0.0, True) == "down")
    check("health still down at 2s", h.sample(2.0, True) == "down")
    check("health up at 3s", h.sample(3.0, True) == "up")

def test_health_down_hold():
    h = ss.Health(up_hold=3.0, down_hold=2.0, start_up=True)
    check("health up", h.state == "up")
    check("blip: still up before down_hold", h.sample(0.0, False) == "up")
    check("still up at 1.9s", h.sample(1.9, False) == "up")
    check("down at 2s", h.sample(2.0, False) == "down")

def test_health_blip_ignored():
    # a 1s blip in an otherwise-alive source must NOT flip to down (down_hold=2)
    h = ss.Health(up_hold=1.0, down_hold=2.0, start_up=True)
    h.sample(0.0, False)          # blip starts
    check("blip <down_hold stays up", h.sample(1.0, False) == "up")
    check("recovers, stays up", h.sample(1.5, True) == "up")

def test_health_recovery_needs_up_hold():
    h = ss.Health(up_hold=3.0, down_hold=2.0, start_up=True)
    for t in (0.0, 2.0):
        h.sample(t, False)
    check("went down", h.state == "down")
    check("brief return not yet up", h.sample(4.0, True) == "down")
    check("still not up at 6.9", h.sample(6.9, True) == "down")
    check("up after 3s continuous", h.sample(7.0, True) == "up")

# ---------------- SelectorPolicy ----------------
def test_policy_stays_primary():
    p = ss.SelectorPolicy(has_backup=True)
    check("primary while up", p.decide(0, True, True) == "primary")
    check("primary stays", p.decide(1, True, False) == "primary")

def test_policy_failover_to_backup():
    p = ss.SelectorPolicy(has_backup=True)
    p.decide(0, True, True)
    check("primary down -> backup", p.decide(1, False, True) == "backup")

def test_policy_failover_to_filler():
    p = ss.SelectorPolicy(has_backup=True)
    p.decide(0, True, True)
    check("both down -> filler", p.decide(1, False, False) == "filler")

def test_policy_no_backup_goes_filler():
    p = ss.SelectorPolicy(has_backup=False)
    p.decide(0, True, False)
    check("no backup, primary down -> filler", p.decide(1, False, True) == "filler")

def test_policy_filler_leaves_immediately_on_backup():
    p = ss.SelectorPolicy(has_backup=True)
    p.decide(0, False, False)  # filler
    check("on filler", p.active == "filler")
    check("backup returns -> backup at once", p.decide(1, False, True) == "backup")

def test_policy_auto_failback():
    p = ss.SelectorPolicy(has_backup=True, auto_failback=True, failback_hold=10.0)
    p.decide(0, True, True)
    p.decide(1, False, True)   # -> backup
    check("on backup", p.active == "backup")
    check("primary back but within hold -> stay backup", p.decide(5, True, True) == "backup")
    check("still backup at 10s since backup-switch but primary_up_since=5 -> hold not met",
          p.decide(11, True, True) == "backup")
    check("failback after primary stable 10s (t=15, up since 5)",
          p.decide(15, True, True) == "primary")

def test_policy_no_failback_when_disabled():
    p = ss.SelectorPolicy(has_backup=True, auto_failback=False, failback_hold=1.0)
    p.decide(0, True, True)
    p.decide(1, False, True)   # -> backup
    check("stay on backup with failback off, backup healthy",
          p.decide(100, True, True) == "backup")
    check("but if backup ALSO dies, take primary", p.decide(101, True, False) == "primary")

def test_policy_filler_to_primary_direct():
    p = ss.SelectorPolicy(has_backup=True, auto_failback=False)
    p.decide(0, False, False)  # filler
    check("filler -> primary directly when primary returns (filler never rests)",
          p.decide(1, True, False) == "primary")

# ---------------- command builders ----------------
def test_relay_cmd():
    inp = {"protocol": "srt", "url": "srt://h:9000?streamid=x"}
    cmd = ss.relay_cmd(inp, "primary", 2, "/work/p.txt")
    check("relay copies (no reencode)", "-c" in cmd and "copy" in cmd)
    check("relay targets primary priv port 21002", "udp://127.0.0.1:21002" in " ".join(cmd))
    check("relay has progress", "-progress" in cmd and "/work/p.txt" in cmd)

def test_forwarder_cmd():
    cmd = ss.forwarder_cmd("backup", 1)
    j = " ".join(cmd)
    check("fwd reads backup priv 22001", "udp://127.0.0.1:22001" in j)
    check("fwd writes bus 20001", "udp://127.0.0.1:20001" in j)
    check("fwd is copy", "copy" in cmd)

def test_filler_slate_cmd():
    ladder = [{"height": 1080, "bitrate_kbps": 5000}, {"height": 720, "bitrate_kbps": 2800}]
    cmd = ss.filler_slate_cmd("/app/assets/slate.png", ladder, 4, 25, "/work/f.txt")
    j = " ".join(cmd)
    check("slate loops image", "-loop" in cmd)
    check("slate has 2 outputs -> filler ports 23000,23001",
          "udp://127.0.0.1:23000" in j and "udp://127.0.0.1:23001" in j)
    check("slate GOP aligned (g=seg*fps=100)", cmd.count("100") >= 1)
    check("slate closed GOP", "-sc_threshold" in cmd and "0" in cmd)
    check("slate forces keyframes on segment boundary", any("n_forced*4" in c for c in cmd))

def test_filler_vod_cmd():
    ladder = [{"height": 720, "bitrate_kbps": 2800}]
    cmd = ss.filler_vod_cmd("s3://b/v.mp4", ladder, 2, 30, "/work/f.txt")
    check("vod loops forever", "-stream_loop" in cmd and "-1" in cmd)
    check("vod paced realtime", "-re" in cmd)
    check("vod -> filler port 23000", "udp://127.0.0.1:23000" in " ".join(cmd))

# ---------------- loop from a slate image (breathing zoom) ----------------
def test_filler_motion_slate_cmd():
    ladder = [{"height": 720, "bitrate_kbps": 2800}]
    cmd = ss.filler_motion_slate_cmd("/s.png", ladder, 4, 25, "/work/f.txt")
    j = " ".join(cmd)
    check("motion slate loops the image", "-loop" in cmd)
    check("motion slate applies a breathing zoom (zoompan sin)", "zoompan" in j and "sin(" in j)
    check("motion slate -> filler port 23000", "udp://127.0.0.1:23000" in j)
    check("motion slate GOP aligned (g=seg*fps=100)", cmd.count("100") >= 1)

def _mk_selector(tmp, vod=None, slate="/s.png", bus_base=ss.BUS_BASE):
    red = {"input_loss_behavior": "vod_loop", "filler": {"slate_ref": slate}}
    if vod:
        red["filler"]["vod_loop_url"] = vod
    cfg = {"segment_seconds": 4, "fps": 25, "redundancy": red}
    ladder = [{"height": 480, "bitrate_kbps": 1200}]
    prim = [{"protocol": "hls", "url": "p0", "rendition_label": "480p"}]
    class P:
        def poll(self): return None
        def terminate(self): pass
    return ss.SourceSelector(cfg, ladder, prim, [], lambda n, c: P(), lambda *a: None,
                             work_dir=tmp, control_dir=tmp, bus_base=bus_base)

def test_loop_choice_uploaded_vs_slate():
    import tempfile
    tmp = tempfile.mkdtemp()
    # no uploaded loop -> loop is the slate image with motion
    sel = _mk_selector(tmp)
    sel._filler_cmd("loop")
    check("loop without upload -> animated slate", sel._filler_kind == "motion_slate")
    sel._filler_cmd("slate")
    check("slate -> static slate", sel._filler_kind == "slate")
    # uploaded loop wins
    sel2 = _mk_selector(tmp, vod="s3://b/v.mp4")
    sel2._filler_cmd("loop")
    check("loop with upload -> uploaded video", sel2._filler_kind == "loop")

def test_transcode_feed_bus_base():
    # in transcode single-source mode the forwarder writes to the transcoder feed port
    cmd = ss.forwarder_cmd("primary", 0, ss.SOURCE_FEED_PORT)
    check("forwarder targets the transcode feed port",
          f"udp://127.0.0.1:{ss.SOURCE_FEED_PORT}" in " ".join(cmd))
    # default (package_only) still writes to the Shaka bus
    cmd2 = ss.forwarder_cmd("primary", 1)
    check("default forwarder targets the Shaka bus 20001", "udp://127.0.0.1:20001" in " ".join(cmd2))

for fn in list(globals().values()):
    if callable(fn) and getattr(fn, "__name__", "").startswith("test_"):
        fn()

print("\n" + ("ALL PASSED" if not FAILS else f"{len(FAILS)} FAILED: {FAILS}"))
sys.exit(1 if FAILS else 0)
