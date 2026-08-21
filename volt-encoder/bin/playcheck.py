#!/usr/bin/env python3
"""playcheck — cheap, repeatable OUTPUT-QUALITY verification for a live channel.

Watches a live HLS output the way a player does and asserts the invariants that
make playback smooth. Catches the "repeats segments / stalls" class of failure
at the MANIFEST level, with evidence, no cloud account needed: run it against a
channel on a laptop.

    python3 playcheck.py --url http://localhost:8080/origin/<id>/live/master_cc.m3u8 --seconds 120
    python3 playcheck.py --dir /path/to/origin/<id>/runs/<run> --seconds 120

Checks, every second, per video variant playlist:
  truncated    : response is not a complete playlist (mid-write read)
  seq-regress  : EXT-X-MEDIA-SEQUENCE went backwards between polls
  window-regress: the segment list lost segments from the tail (rewind)
  dup-uri      : the same segment listed twice in one playlist
  pdt-backwards: EXT-X-PROGRAM-DATE-TIME not monotonically increasing
  pdt-jump     : PDT gap bigger than 3x the segment duration (timeline tear)
  stale        : playlist did not advance for > 3x target duration
Exit code 0 = no violations, 1 = violations (counts printed per class).
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone

def fetch(url_or_path):
    if re.match(r"^https?://", url_or_path):
        with urllib.request.urlopen(url_or_path, timeout=5) as r:
            return r.read().decode("utf-8", "replace")
    with open(url_or_path, encoding="utf-8") as f:
        return f.read()

def join(base, rel):
    if re.match(r"^https?://", rel):
        return rel
    if re.match(r"^https?://", base):
        return base.rsplit("/", 1)[0] + "/" + rel
    return os.path.join(os.path.dirname(base), rel)

def parse_pdt(s):
    s = s.strip().replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(s).timestamp()
    except ValueError:
        return None

def variant_playlists(master):
    """Video variant URIs from a master playlist (skips audio/subs media)."""
    text = fetch(master)
    out, expect = [], False
    for l in text.splitlines():
        if l.startswith("#EXT-X-STREAM-INF"):
            expect = True
        elif expect and l and not l.startswith("#"):
            out.append(join(master, l.strip()))
            expect = False
    return out

class VariantState:
    def __init__(self, url):
        self.url = url
        self.name = url.rsplit("/", 1)[-1]
        self.last_seq = None
        self.last_uris = []
        self.last_advance = time.time()
        self.violations = {}

    def note(self, kind, detail=""):
        self.violations.setdefault(kind, []).append(detail)

    def poll(self, target_dur_hint=4.0):
        try:
            text = fetch(self.url)
        except Exception as e:  # noqa: BLE001
            self.note("fetch-error", str(e)[:80])
            return
        lines = text.splitlines()
        # completeness: starts as a playlist and the last non-blank line is a tag or URI
        if not lines or not lines[0].startswith("#EXTM3U"):
            self.note("truncated", "missing #EXTM3U header")
            return
        last = next((l for l in reversed(lines) if l.strip()), "")
        if not (last.startswith("#") or last.endswith((".m4s", ".ts", ".mp4", ".vtt", ".m3u8"))):
            self.note("truncated", f"dangling last line {last[:40]!r}")
            return
        seq = None
        target = target_dur_hint
        uris, pdts, dur = [], [], None
        for l in lines:
            if l.startswith("#EXT-X-MEDIA-SEQUENCE:"):
                seq = int(l.split(":", 1)[1])
            elif l.startswith("#EXT-X-TARGETDURATION:"):
                target = float(l.split(":", 1)[1])
            elif l.startswith("#EXT-X-PROGRAM-DATE-TIME:"):
                pdts.append((len(uris), parse_pdt(l.split(":", 1)[1])))
            elif l.startswith("#EXTINF:"):
                try: dur = float(l[8:].split(",")[0])
                except ValueError: dur = None
            elif l and not l.startswith("#"):
                uris.append(l.strip())
        # duplicate URIs inside one playlist
        if len(set(uris)) != len(uris):
            dups = sorted({u for u in uris if uris.count(u) > 1})
            self.note("dup-uri", ",".join(dups[:3]))
        # sequence monotonic
        if seq is not None and self.last_seq is not None and seq < self.last_seq:
            self.note("seq-regress", f"{self.last_seq} -> {seq}")
        # window append-only: previously-listed tail must still be a prefix-suffix match
        if self.last_uris and uris:
            prev_tail = self.last_uris[-1]
            if prev_tail not in uris and seq is not None and self.last_seq is not None and seq <= self.last_seq:
                self.note("window-regress", f"tail {prev_tail} vanished without sequence advance")
        # PDT monotonic + tear-free
        ts = [t for _, t in pdts if t is not None]
        for a, b in zip(ts, ts[1:]):
            if b < a - 0.2:
                self.note("pdt-backwards", f"{b - a:+.2f}s")
            elif dur and b - a > 3 * (dur or target):
                self.note("pdt-jump", f"{b - a:.1f}s gap")
        # liveness
        if uris and uris != self.last_uris:
            self.last_advance = time.time()
        elif time.time() - self.last_advance > 3 * target:
            self.note("stale", f"no advance for {time.time() - self.last_advance:.0f}s")
            self.last_advance = time.time()   # report once per stall period
        self.last_seq = seq if seq is not None else self.last_seq
        self.last_uris = uris

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", help="master playlist URL (e.g. .../live/master_cc.m3u8)")
    ap.add_argument("--dir", help="run directory containing master.m3u8 (local check)")
    ap.add_argument("--seconds", type=int, default=120)
    ap.add_argument("--interval", type=float, default=1.0)
    ap.add_argument("--json", action="store_true", help="machine-readable summary")
    args = ap.parse_args()
    master = args.url or (os.path.join(args.dir, "master_cc.m3u8")
                          if args.dir and os.path.exists(os.path.join(args.dir, "master_cc.m3u8"))
                          else os.path.join(args.dir or "", "master.m3u8"))
    if not args.url and not args.dir:
        ap.error("--url or --dir required")

    # wait for the master to appear (channel may still be starting)
    t0 = time.time()
    while time.time() - t0 < 60:
        try:
            fetch(master); break
        except Exception:
            time.sleep(1)
    try:
        variants = variant_playlists(master)
    except Exception as e:  # noqa: BLE001
        print(f"FAIL cannot read master {master}: {e}")
        sys.exit(1)
    if not variants:
        print(f"FAIL no video variants in {master}")
        sys.exit(1)
    states = [VariantState(v) for v in variants]
    print(f"playcheck: watching {len(states)} variant(s) for {args.seconds}s @ {args.interval}s")
    end = time.time() + args.seconds
    polls = 0
    while time.time() < end:
        for s in states:
            s.poll()
        polls += 1
        time.sleep(args.interval)

    total = 0
    summary = {}
    for s in states:
        for kind, items in s.violations.items():
            total += len(items)
            summary.setdefault(kind, 0)
            summary[kind] += len(items)
            print(f"VIOLATION {s.name} {kind} x{len(items)}: {items[:4]}")
    if args.json:
        print(json.dumps({"polls": polls, "variants": len(states), "violations": summary}))
    if total == 0:
        print(f"OK {polls} polls x {len(states)} variants: no violations")
        sys.exit(0)
    print(f"FAIL {total} violation(s) across {polls} polls")
    sys.exit(1)

if __name__ == "__main__":
    main()
