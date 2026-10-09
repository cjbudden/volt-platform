#!/usr/bin/env python3
"""Integration test: does a REAL PLAYER put our cues where we said they were?

syncheck proves the numbers we publish are right. This proves the player agrees with
them, which is a separate question and historically the one that bit: a WebVTT segment
whose X-TIMESTAMP-MAP is subtly misinterpreted looks perfect on disk and shows captions
in the wrong place, or only near one spot on the timeline, or not at all.

Method. Build a short asset, package it with Shaka exactly as a channel is packaged,
then write the subtitle track with THE ENCODER'S OWN functions (_media_epoch, _seg_pts,
_live_sub_playlist, _write_sub_segment, _write_companion). Every cue's TEXT states the
media time it claims to be at. Play it in headless Chromium with hls.js using the app's
live configuration, sample the playhead and the on-screen text four times a second, and
check each cue appeared when the playhead really was where the cue said.

The asset is video-only VP9 rather than H.264/AAC because headless Chromium ships without
the proprietary decoders. Nothing under test here is codec-specific: the subject is the
timestamp arithmetic and the manifests, which are identical in shape either way. Caption
windows are keyed off the video segments' tfdt here for the same reason; in production
they are keyed off the audio segments' tfdt, which is the same function on the same clock.

Needs: ffmpeg (libvpx-vp9, libopus), Shaka Packager (PACKAGER_BIN), playwright+chromium.
Skips cleanly with exit 0 if any of those is missing, so it never blocks a test run.

Run: python3 test_player_alignment.py
"""
import functools
import glob
import http.server
import json
import os
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

TOLERANCE_SEC = 1.0     # a cue must appear within this of the time it claims
DURATION_SEC = 32
SEG = 4.0
WINDOW = 8.0
PORT = 8127


HLSJS_URL = "https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js"


def ensure_hlsjs(directory):
    """The probe page needs hls.js locally: the browser has no route to a CDN from a
    file server on 127.0.0.1 in every environment, and a test that silently depends on
    the internet is a test that fails for the wrong reason. Fetched once and cached; not
    committed to the repo."""
    path = os.path.join(directory, "hls.min.js")
    if os.path.exists(path) and os.path.getsize(path) > 100000:
        return path
    import urllib.request
    try:
        with urllib.request.urlopen(HLSJS_URL, timeout=30) as r, open(path, "wb") as fh:
            fh.write(r.read())
    except Exception as e:  # noqa: BLE001
        raise SystemExit(f"could not fetch hls.js ({e}); place hls.min.js in {directory}")
    return path


def have(cmd):
    return shutil.which(cmd) is not None


def skip(why):
    print(f"SKIP: {why}")
    raise SystemExit(0)


def build_asset(work):
    """A short VP9/Opus asset packaged to CMAF + HLS, the same shape a channel produces."""
    src_v = os.path.join(work, "v.webm")
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error",
         "-f", "lavfi", "-i", f"testsrc2=size=320x180:rate=25:duration={DURATION_SEC}",
         "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "300k",
         "-g", str(int(SEG * 25)), "-keyint_min", str(int(SEG * 25)), "-an", "-f", "webm", src_v],
        check=True, timeout=300)
    out = os.path.join(work, "out")
    packager = os.environ.get("PACKAGER_BIN", "packager")
    subprocess.run(
        [packager,
         f"in={src_v},stream=video,init_segment={out}/360p/init.mp4,"
         f"segment_template={out}/360p/seg_$Number$.m4s",
         "--segment_duration", str(SEG), "--fragment_duration", str(SEG),
         "--hls_master_playlist_output", f"{out}/master.m3u8",
         # VOD so the player starts at the beginning and walks the WHOLE timeline;
         # a live playlist would drop it at the edge and only ever exercise one spot
         "--hls_playlist_type", "VOD", "--mpd_output", f"{out}/manifest.mpd"],
        check=True, capture_output=True, timeout=300)
    return out


def write_subtitles(out):
    """Write the subtitle track through the encoder's real functions. Each cue's text is
    the media time it claims to be at, so the browser can be checked against it."""
    import encoder
    encoder._TS_CACHE.clear()
    encoder._PTS_CACHE.clear()
    encoder._EPOCH.clear()
    sub_dir = os.path.join(out, "subtitles", "en")
    os.makedirs(sub_dir, exist_ok=True)

    class Cue:
        def __init__(s, a, b, t):
            s.start, s.end, s.text, s.lang = a, b, t, "en"

    nums = sorted(int(p.rsplit("_", 1)[1].split(".")[0])
                  for p in glob.glob(os.path.join(out, "360p", "seg_*.m4s")))
    per_win = int(round(WINDOW / SEG))
    epoch = encoder._media_epoch(out, SEG)
    published, expected = [], []
    for i in range(0, len(nums) - per_win, per_win):
        first = nums[i]
        start = encoder._seg_pts(out, f"360p/seg_{first}.m4s")
        nxt = encoder._seg_pts(out, f"360p/seg_{first + per_win}.m4s")
        if start is None or nxt is None:
            continue
        cues = []
        # two cues per window: one at the very start, one part-way in, so the check
        # covers both the segment boundary and an offset inside a segment
        for at in (start + 0.20, start + (nxt - start) / 2):
            text = f"MARK {at:.3f}"
            cues.append(Cue(at, at + 1.6, text))
            expected.append((at, text))
        encoder._write_sub_segment(os.path.join(sub_dir, f"sub_{first}.vtt"),
                                   cues, start, nxt,
                                   mpegts=int(round(start * 90000)))
        published.append((first, epoch + start, nxt - start))
        with open(os.path.join(sub_dir, "subs.m3u8"), "w") as fh:
            fh.write(encoder._live_sub_playlist(published, WINDOW, published[0][0]))
    # close the subtitle playlist to match the VOD video playlists in this fixture
    with open(os.path.join(sub_dir, "subs.m3u8"), "a") as fh:
        fh.write("#EXT-X-ENDLIST\n")
    encoder._write_companion(out, ["en"], "en", SEG)
    return expected, epoch


def play(out, seconds):
    from playwright.sync_api import sync_playwright
    root = os.path.dirname(os.path.abspath(__file__))
    ensure_hlsjs(root)
    stage = os.path.join(out, "_serve")
    os.makedirs(stage, exist_ok=True)
    for asset in ("player_probe.html", "hls.min.js"):
        dst = os.path.join(stage, asset)
        if not os.path.exists(dst) and os.path.exists(os.path.join(root, asset)):
            os.symlink(os.path.join(root, asset), dst)
    if not os.path.exists(os.path.join(stage, "origin")):
        os.symlink(out, os.path.join(stage, "origin"))
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=stage)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as pw:
            b = pw.chromium.launch(args=["--autoplay-policy=no-user-gesture-required",
                                         "--disable-dev-shm-usage"])
            pg = b.new_page()
            # start near the beginning: this is a short asset, not a live edge
            pg.goto(f"http://127.0.0.1:{PORT}/player_probe.html"
                    f"?src=/origin/master_cc.m3u8&hold=2", wait_until="domcontentloaded")
            time.sleep(seconds)
            probe = pg.evaluate("window.__probe")
            b.close()
            return probe
    finally:
        httpd.shutdown()


def main():
    if not (have("ffmpeg") and shutil.which(os.environ.get("PACKAGER_BIN", "packager"))):
        skip("ffmpeg or Shaka Packager not available")
    try:
        import playwright.sync_api  # noqa: F401
    except Exception:  # noqa: BLE001
        skip("playwright not installed")

    work = tempfile.mkdtemp(prefix="volt-playertest-")
    try:
        out = build_asset(work)
        expected, epoch = write_subtitles(out)
        if not expected:
            print("FAIL: no subtitle cues were produced")
            raise SystemExit(1)
        probe = play(out, DURATION_SEC + 12)
    finally:
        pass

    if probe.get("fatal") == "manifestIncompatibleCodecsError":
        shutil.rmtree(work, ignore_errors=True)
        skip("this browser has no decoder for the test asset")
    if probe.get("fatal"):
        print(f"FAIL: player error {probe['fatal']}")
        raise SystemExit(1)

    if os.environ.get("PLAYERTEST_DEBUG"):
        print(json.dumps({"events": probe.get("events"), "fatal": probe.get("fatal"),
                          "last_samples": (probe.get("samples") or [])[-3:]}, indent=1))
    samples = probe.get("samples") or []
    tracks = next((e["d"] for e in (probe.get("events") or []) if e["type"] == "subtitle_tracks"), [])
    passed = failed = 0

    def ok(c, m):
        nonlocal passed, failed
        if c:
            passed += 1
            print("PASS", m)
        else:
            failed += 1
            print("FAIL", m)

    ok(bool(tracks), f"the player sees a subtitle track ({tracks})")
    playing = [x for x in samples if not x["paused"] and x["ct"] > 0]
    ok(len(playing) > 10, f"playback actually ran ({len(playing)} samples)")

    # onset of each distinct cue, and where the playhead really was
    onsets, prev = [], None
    for x in samples:
        text = " ".join(x["cues"]).replace("\n", " ").strip()
        if text and text != prev and x["pdt"] is not None:
            onsets.append((x["pdt"] - epoch, text))
        prev = text
    ok(len(onsets) >= max(2, len(expected) // 3),
       f"cues actually appeared on screen ({len(onsets)} of {len(expected)} written)")

    errs = []
    for pts, text in onsets:
        if "MARK" not in text:
            continue
        try:
            claimed = float(text.split("MARK", 1)[1].split()[0])
        except (IndexError, ValueError):
            continue
        errs.append(pts - claimed)
    if errs:
        errs.sort()
        med = errs[len(errs) // 2]
        worst = max(errs, key=abs)
        ok(abs(med) <= TOLERANCE_SEC,
           f"median placement error {med:+.3f}s (tolerance {TOLERANCE_SEC}s)")
        ok(abs(worst) <= TOLERANCE_SEC * 3,
           f"worst placement error {worst:+.3f}s")
        ok(sum(1 for e in errs if abs(e) <= TOLERANCE_SEC) / len(errs) >= 0.8,
           f"{sum(1 for e in errs if abs(e) <= TOLERANCE_SEC)}/{len(errs)} cues within tolerance")
        # cues must be spread across the whole asset, not clustered at one point:
        # that clustering was the "worked for two chunks then stopped" failure
        span = max(p for p, _t in onsets) - min(p for p, _t in onsets)
        ok(span > DURATION_SEC * 0.4,
           f"cues appear across the whole timeline, not at one spot (span {span:.1f}s)")
    else:
        ok(False, "no MARK cues were readable on screen")

    shutil.rmtree(work, ignore_errors=True)
    print(f"\n{passed} passed, {failed} failed")
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
