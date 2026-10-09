#!/usr/bin/env python3
"""VOLT encoder soak test: test-and-refine harness for production hardening.

Self-contained: synthesizes a LOCAL live HLS source (test card + tone), boots the real
encoder against it, and walks the lifecycle the console depends on, asserting the
STATUS reflects reality at every step:

  1. STARTUP    output available, primary up, packager ok, segments advancing
  2. LOSS       kill the source: primary reported down, filler engaged
  3. RECOVERY   restore the source: primary reported UP again (the stuck-status case)
  4. RESTART    stop + relaunch the encoder: fresh run dir, fresh boot_ms, healthy again
  5. CAPTIONS   (--captions, needs faster-whisper) subtitle segments exist and the
                newest one stays CURRENT (age < 30s) for the soak window: the
                never-fall-behind guarantee

Run:  python3 soak.py [--captions] [--soak-sec 120]
Exit code 0 = all checks passed. Safe to run repeatedly; uses its own temp dirs/ports.
"""
import argparse
import http.server
import json
import os
import shutil
import signal
import socketserver
import subprocess
import sys
import tempfile
import threading
import time

BIN = os.path.dirname(os.path.abspath(__file__))
PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""), flush=True)


def wait_for(name, fn, timeout, interval=1.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            if fn():
                check(name, True)
                return True
        except Exception:
            pass
        time.sleep(interval)
    check(name, False, f"timeout {timeout}s")
    return False


class Source:
    """A local live HLS source: ffmpeg test card + tone -> sliding-window HLS,
    served over http. Killable and restartable to exercise failover + recovery."""

    def __init__(self, root, port):
        self.dir = os.path.join(root, "src")
        self.port = port
        self.proc = None
        self.httpd = None
        os.makedirs(self.dir, exist_ok=True)
        handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=self.dir, **k)  # noqa: E731
        self.httpd = socketserver.TCPServer(("127.0.0.1", port), handler)
        self.httpd.allow_reuse_address = True
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.port}/live.m3u8"

    def start(self):
        self.proc = subprocess.Popen([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-re",
            "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
            "-c:v", "libx264", "-preset", "veryfast", "-b:v", "800k",
            "-g", "50", "-keyint_min", "50", "-sc_threshold", "0",
            "-c:a", "aac", "-b:a", "96k", "-ac", "2",
            "-f", "hls", "-hls_time", "2", "-hls_list_size", "6",
            "-hls_flags", "delete_segments",
            os.path.join(self.dir, "live.m3u8"),
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        # leave stale playlist/segments: a dead-but-cached source is the realistic case

    def close(self):
        self.stop()
        try:
            self.httpd.shutdown()
        except Exception:
            pass


class Encoder:
    def __init__(self, root, src_url, udp_base, captions):
        self.base = os.path.join(root, "origin")
        os.makedirs(self.base, exist_ok=True)
        slate = os.path.join(root, "slate.png")
        if not os.path.exists(slate):
            subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                            "-f", "lavfi", "-i", "color=c=0x224466:s=640x360",
                            "-frames:v", "1", slate], check=True)
        self.cfg = {
            "channel_id": "soak-test", "workflow": "transcode",
            "segment_seconds": 4, "fps": 25,
            "inputs": [{"role": "primary", "protocol": "hls", "url": src_url, "has_audio": True}],
            "ladder": [{"height": 360, "bitrate_kbps": 800}],
            "output": {"mode": "local", "dir": self.base},
            "redundancy": {"input_failover": True, "auto_failback": True,
                           "input_loss_behavior": "slate", "start_grace_sec": 15,
                           "filler": {"slate_ref": slate}},
            "recording": {"enabled": False, "retention_sec": None},
        }
        if captions:
            self.cfg["captions"] = {"enabled": True, "engine": "whisper",
                                    "source_lang": "auto", "targets": ["en"], "offset_sec": 0}
        self.udp_base = udp_base
        self.proc = None

    def start(self):
        env = dict(os.environ, JOB_CONFIG_JSON=json.dumps(self.cfg),
                   WORK_DIR=self.base, UDP_BASE_PORT=str(self.udp_base))
        self.proc = subprocess.Popen(
            [sys.executable, os.path.join(BIN, "encoder.py")], env=env, cwd=BIN,
            stdout=open(os.path.join(self.base, "soak-encoder.log"), "a"),
            stderr=subprocess.STDOUT, start_new_session=True)

    def stop(self):
        if self.proc and self.proc.poll() is None:
            os.killpg(self.proc.pid, signal.SIGTERM)
            try:
                self.proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(self.proc.pid, signal.SIGKILL)
        # the encoder's children (ffmpeg/packager) are in the same process group

    def status(self):
        try:
            with open(os.path.join(self.base, "status.json")) as fh:
                return json.load(fh)
        except Exception:
            return {}

    def run_dir(self):
        try:
            rid = open(os.path.join(self.base, "current_run.txt")).read().strip()
            return os.path.join(self.base, "runs", rid)
        except Exception:
            return None

    def manifest_fresh(self, max_age=15):
        """Output advancing = ANY root manifest recently rewritten. The multivariant
        master is written once; Shaka rewrites the CHILD playlists and the MPD every
        segment, so freshness must scan them all (same rule the control plane uses)."""
        d = self.run_dir()
        if not d:
            return False
        import glob as g
        manis = g.glob(os.path.join(d, "*.m3u8")) + g.glob(os.path.join(d, "*.mpd"))
        return bool(manis) and (time.time() - max(os.path.getmtime(m) for m in manis)) < max_age


def newest_sub_age(run_dir, lang="en"):
    import glob as g
    vtts = g.glob(os.path.join(run_dir or "", "subtitles", lang, "sub_*.vtt"))
    if not vtts:
        return None
    return time.time() - max(os.path.getmtime(v) for v in vtts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--captions", action="store_true", help="also soak whisper captions (needs faster-whisper)")
    ap.add_argument("--soak-sec", type=int, default=90, help="caption currency observation window")
    ap.add_argument("--keep", action="store_true", help="keep the temp dir for inspection")
    args = ap.parse_args()

    root = tempfile.mkdtemp(prefix="volt-soak-")
    print(f"soak dir: {root}", flush=True)
    src = Source(root, 8188)
    enc = Encoder(root, src.url, udp_base=24000, captions=args.captions)
    try:
        # ---- 1. STARTUP ----
        src.start()
        time.sleep(4)   # let the source publish its first segments
        enc.start()
        wait_for("startup: output available", lambda: enc.status().get("output_available"), 90)
        wait_for("startup: primary reported UP",
                 lambda: (enc.status().get("sources", {}).get("primary", {}).get("state") == "up"), 45)
        check("startup: packager ok", bool(enc.status().get("packager_ok")))
        wait_for("startup: manifest advancing", lambda: enc.manifest_fresh(), 30)
        boot1 = enc.status().get("boot_ms")
        run1 = enc.run_dir()
        check("startup: status carries boot_ms (run identity)", bool(boot1))

        # ---- 2. LOSS ----
        src.stop()
        wait_for("loss: primary reported DOWN",
                 lambda: (enc.status().get("sources", {}).get("primary", {}).get("state") == "down"), 45)
        wait_for("loss: filler engaged (output keeps going)",
                 lambda: enc.status().get("active_source") == "filler" and enc.manifest_fresh(), 30)

        # ---- 3. RECOVERY (the stuck-status case) ----
        src.start()
        wait_for("recovery: primary reported UP again",
                 lambda: (enc.status().get("sources", {}).get("primary", {}).get("state") == "up"), 60)
        wait_for("recovery: back on primary", lambda: enc.status().get("active_source") == "primary", 30)
        check("recovery: output still advancing", enc.manifest_fresh())

        # ---- 4. RESTART ----
        enc.stop()
        time.sleep(2)
        enc.start()
        wait_for("restart: output available in the NEW run", lambda: enc.status().get("output_available"), 90)
        wait_for("restart: primary UP in the NEW run",
                 lambda: (enc.status().get("sources", {}).get("primary", {}).get("state") == "up"), 45)
        boot2 = enc.status().get("boot_ms")
        run2 = enc.run_dir()
        check("restart: fresh boot_ms (status can never be mistaken for the old run)",
              bool(boot2) and boot2 != boot1)
        check("restart: fresh run dir (nothing overwritten)", bool(run2) and run2 != run1)

        # ---- 5. CAPTIONS currency ----
        if args.captions:
            wait_for("captions: first subtitle segment produced",
                     lambda: newest_sub_age(enc.run_dir()) is not None, 120)
            worst = 0.0
            t0 = time.time()
            while time.time() - t0 < args.soak_sec:
                age = newest_sub_age(enc.run_dir())
                if age is not None:
                    worst = max(worst, age)
                time.sleep(5)
            check(f"captions: stayed CURRENT for {args.soak_sec}s (worst gap {worst:.0f}s < 30s)", worst < 30)
    finally:
        enc.stop()
        src.close()
        if not args.keep:
            shutil.rmtree(root, ignore_errors=True)

    print(f"\n== SOAK RESULT: {len(PASS)} passed, {len(FAIL)} failed ==")
    if FAIL:
        print("failed:", ", ".join(FAIL))
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
