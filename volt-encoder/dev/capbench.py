#!/usr/bin/env python3
"""Ground-truth caption benchmark against the Unified Streaming vod2live demo.

The source carries a professional English subtitle track (textstream) with per-segment
PDT: ground truth for WHEN each sentence is spoken on the live timeline. We run the
REAL encoder (whisper captions) on a video variant of the same stream, then compare
our produced cues against the source's own, cue by cue:

  * DELAY   our cue's wall-clock (subs playlist PDT) minus the ground-truth start:
            median = end-to-end transcription delay, stdev = placement jitter
  * SYNC    internal consistency of the claimed video PTS pinning vs our capture clock
  * QUALITY token-overlap of matched text (whisper tiny vs the real transcript),
            plus unmatched counts both ways

Run: python3 capbench.py [--minutes 4]
"""
import argparse
import datetime
import glob
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

BASE = "https://demo.unified-streaming.com/k8s/vod2live/stable/unified-learning.isml"
SRC_VARIANT = f"{BASE}/unified-learning-audio_eng=128000-video=2200000.m3u8"
GT_PLAYLIST = f"{BASE}/unified-learning-textstream_eng=1000.m3u8"
ENC_BIN = "/tmp/app/volt-encoder/bin"


def get(url, timeout=8):
    req = urllib.request.Request(url, headers={"User-Agent": "volt-capbench/1.0"})
    return urllib.request.urlopen(req, timeout=timeout).read().decode("utf-8", "ignore")


def parse_iso(s):
    s = s.strip().rstrip("Z")
    # fractional seconds of any width
    if "." in s:
        head, frac = s.split(".")
        frac = (frac + "000000")[:6]
        s = f"{head}.{frac}"
        fmt = "%Y-%m-%dT%H:%M:%S.%f"
    else:
        fmt = "%Y-%m-%dT%H:%M:%S"
    return datetime.datetime.strptime(s, fmt).replace(tzinfo=datetime.timezone.utc).timestamp()


def parse_vtt_cues(text):
    """[(rel_start, rel_end, text)] from a WEBVTT body."""
    cues = []
    ts = r"(\d+):(\d\d):(\d\d)\.(\d\d\d)|(\d\d):(\d\d)\.(\d\d\d)"
    for m in re.finditer(
            r"^([\d:.]+)\s+-->\s+([\d:.]+).*\n((?:(?!\n\n)[\s\S])*?)(?:\n\n|\Z)", text, re.M):
        def sec(t):
            parts = t.split(":")
            parts = [float(p) for p in parts]
            while len(parts) < 3:
                parts.insert(0, 0.0)
            return parts[0] * 3600 + parts[1] * 60 + parts[2]
        body = " ".join(l.strip() for l in m.group(3).strip().splitlines() if l.strip())
        if body:
            cues.append((sec(m.group(1)), sec(m.group(2)), body))
    return cues


class GroundTruth:
    """Polls the source subtitle playlist; collects cues with ABSOLUTE wall times."""

    def __init__(self):
        self.cues = []           # (abs_start, abs_end, text)
        self._seen = set()
        self._primed = False     # first poll: skip the DVR backlog, follow the LIVE edge
        self._stop = False
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while not self._stop:
            try:
                pl = get(GT_PLAYLIST)
                lines = pl.splitlines()
                pdt = None
                dur_acc = 0.0
                pend = 1.92
                for i, l in enumerate(lines):
                    if l.startswith("#EXT-X-PROGRAM-DATE-TIME:"):
                        pdt = parse_iso(l.split(":", 1)[1])
                        dur_acc = 0.0
                    elif l.startswith("#EXTINF:"):
                        pend = float(l[len("#EXTINF:"):].split(",")[0])
                    elif l and not l.startswith("#") and pdt is not None:
                        seg_start = pdt + dur_acc
                        dur_acc += pend
                        if l in self._seen:
                            continue
                        self._seen.add(l)
                        if not self._primed:
                            continue     # backlog segment: mark seen, do not fetch
                        try:
                            body = get(f"{BASE}/{l}")
                            for rs, re_, tx in parse_vtt_cues(body):
                                # source repeats a rolling cue in consecutive segments;
                                # keep its FIRST appearance (the true start)
                                key = tx.strip().lower()
                                if any(k == key and abs(seg_start + rs - a) < 8
                                       for a, _b, k in ((c[0], c[1], c[2].strip().lower()) for c in self.cues[-12:])):
                                    continue
                                self.cues.append((seg_start + rs, seg_start + re_, tx))
                        except Exception:
                            pass
                self._primed = True
            except Exception:
                pass
            time.sleep(2.0)

    def stop(self):
        self._stop = True


def start_encoder(root):
    base = os.path.join(root, "origin")
    os.makedirs(base, exist_ok=True)
    cfg = {
        "channel_id": "capbench", "workflow": "transcode",
        "segment_seconds": 4, "fps": 25,
        "inputs": [{"role": "primary", "protocol": "hls", "url": SRC_VARIANT, "has_audio": True}],
        "ladder": [{"height": 360, "bitrate_kbps": 800}],
        "output": {"mode": "local", "dir": base},
        "captions": {"enabled": True, "engine": "whisper", "source_lang": "auto",
                     "targets": ["en"], "offset_sec": 0},
        "recording": {"enabled": False},
    }
    env = dict(os.environ, JOB_CONFIG_JSON=json.dumps(cfg), WORK_DIR=base,
               UDP_BASE_PORT="26000", WHISPER_MODEL="tiny")
    proc = subprocess.Popen([sys.executable, os.path.join(ENC_BIN, "encoder.py")],
                            env=env, cwd=ENC_BIN,
                            stdout=open(os.path.join(root, "enc.log"), "a"),
                            stderr=subprocess.STDOUT, start_new_session=True)
    return proc, base


def our_cues(base):
    """Parse OUR live subtitle output -> [(abs_wall, claimed_pts, text)]."""
    rid = open(os.path.join(base, "current_run.txt")).read().strip()
    sub = os.path.join(base, "runs", rid, "subtitles", "en")
    pl = open(os.path.join(sub, "subs.m3u8")).read().splitlines()
    out = []
    pdt = None
    for l in pl:
        if l.startswith("#EXT-X-PROGRAM-DATE-TIME:"):
            pdt = parse_iso(l.split(":", 1)[1])
        elif l.endswith(".vtt") and pdt is not None:
            try:
                body = open(os.path.join(sub, l)).read()
            except OSError:
                continue
            mp = re.search(r"X-TIMESTAMP-MAP=MPEGTS:(\d+)", body)
            pts0 = (int(mp.group(1)) / 90000.0) if mp else None
            for rs, re_, tx in parse_vtt_cues(body):
                out.append((pdt + rs, (pts0 + rs) if pts0 is not None else None, tx))
    return out


def norm_tokens(t):
    return set(re.sub(r"[^a-z0-9 ]", "", t.lower()).split())


def jaccard(a, b):
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def analyze(gt, ours):
    matches = []
    gt_sorted = sorted(gt)
    for wall, pts, tx in ours:
        toks = norm_tokens(tx)
        best, best_s = None, 0.0
        for gs, ge, gtx in gt_sorted:
            if abs(gs - wall) > 90:
                continue
            s = jaccard(toks, norm_tokens(gtx))
            if s > best_s:
                best, best_s = (gs, ge, gtx), s
        if best and best_s >= 0.4:
            matches.append({"our_wall": wall, "our_pts": pts, "text": tx,
                            "gt_start": best[0], "gt_text": best[2], "sim": best_s,
                            "delay": wall - best[0]})
    return matches


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--minutes", type=float, default=4.0)
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()

    root = tempfile.mkdtemp(prefix="capbench-")
    print(f"bench dir: {root}", flush=True)
    gt = GroundTruth()
    proc, base = start_encoder(root)
    try:
        t_end = time.time() + args.minutes * 60
        while time.time() < t_end:
            time.sleep(10)
            try:
                n = len(our_cues(base))
            except Exception:
                n = 0
            print(f"  t+{int(args.minutes*60 - (t_end - time.time()))}s: gt={len(gt.cues)} ours={n}", flush=True)
        ours = our_cues(base)
    finally:
        gt.stop()
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=15)
        except Exception:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except Exception:
                pass

    m = analyze(gt.cues, ours)
    print("\n===== RESULTS =====")
    print(f"ground-truth cues: {len(gt.cues)}   our cues: {len(ours)}   matched: {len(m)}")
    if m:
        delays = sorted(x["delay"] for x in m)
        med = delays[len(delays) // 2]
        import statistics
        sd = statistics.pstdev(delays)
        sims = [x["sim"] for x in m]
        print(f"caption DELAY vs ground truth: median {med:.1f}s  stdev {sd:.1f}s  "
              f"min {delays[0]:.1f}s  max {delays[-1]:.1f}s")
        print(f"text similarity (token jaccard): mean {sum(sims)/len(sims):.2f}")
        # internal PTS pinning consistency: claimed video PTS should advance 1:1 with wall
        pts_pairs = [(x["our_wall"], x["our_pts"]) for x in m if x["our_pts"] is not None]
        if len(pts_pairs) >= 3:
            drift = [(w - pts_pairs[0][0]) - (p - pts_pairs[0][1]) for w, p in pts_pairs]
            print(f"PTS pinning drift across run: max |{max(abs(d) for d in drift):.2f}|s "
                  f"(0 = cues advance exactly with the timeline)")
        print("\nsample matches (our text <= gt text, delay):")
        for x in m[:10]:
            print(f"  {x['delay']:6.1f}s  sim {x['sim']:.2f}  '{x['text'][:46]}' <= '{x['gt_text'][:46]}'")
    if args.keep:
        print(f"kept: {root}")
    else:
        shutil.rmtree(root, ignore_errors=True)
    json.dump({"gt": len(gt.cues), "ours": len(ours), "matched": len(m),
               "matches": m,
               "our_sample": [(x[0], x[1], x[2]) for x in ours[:25]],
               "gt_sample": [(c[0], c[2]) for c in sorted(gt.cues)[:40]]},
              open("/tmp/capbench/last_run.json", "w"), indent=1)
    print("full detail: /tmp/capbench/last_run.json")


if __name__ == "__main__":
    main()
