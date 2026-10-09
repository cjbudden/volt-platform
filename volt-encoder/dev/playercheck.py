#!/usr/bin/env python3
"""playercheck — what a real player actually shows, and when.

syncheck measures the metadata: it proves the cues we published sit at the right point
on the delivered media timeline. That is necessary but it is not the thing the viewer
experiences, because it assumes the player interprets X-TIMESTAMP-MAP and
EXT-X-PROGRAM-DATE-TIME the way we intend. This closes that gap: hls.js plays the real
output in Chromium with the app's live configuration, and we record, four times a
second, which cue is on screen and where the playhead is on the media timeline.

Each sample is then compared against the offline reference transcript of the same
delivered audio: the words on screen versus the words being spoken at that instant.
The distribution of the difference is the SYNC ERROR AS SEEN BY A VIEWER.

The same run answers the playback questions: time to first frame, stalls, waiting
events, fatal errors, and whether the playhead advances at 1x throughout.

Usage: playercheck.py <run_dir> [--seconds 90] [--ref ref.json] [--manifest master_cc.m3u8]
"""
import glob
import json
import os
import re
import subprocess
import sys
import threading
import time
import http.server
import socketserver
import functools
import datetime as dt

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import syncheck  # noqa: E402


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


def serve(directory, port):
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def media_epoch_from_playlist(out):
    """PDT of media PTS 0, recovered from the published companion playlist. Lets us turn
    the player's reported playingDate back into a media PTS without trusting the encoder
    to tell us: it is read out of the manifest the player itself consumed."""
    for cc in sorted(glob.glob(os.path.join(out, "stream_*_cc.m3u8"))):
        for seg in syncheck.parse_playlist(cc):
            if not seg["pdt"]:
                continue
            pts = syncheck.mp4_tfdt(os.path.join(out, seg["uri"]))
            ts = syncheck.mp4_timescale(os.path.join(out, os.path.dirname(seg["uri"]), "init.mp4"))
            if pts is None or not ts:
                continue
            wall = dt.datetime.fromisoformat(seg["pdt"].replace("Z", "+00:00")).timestamp()
            return wall - pts / ts
    return None


def run_browser(url, seconds, hold):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        b = pw.chromium.launch(args=["--autoplay-policy=no-user-gesture-required",
                                     "--disable-dev-shm-usage"])
        page = b.new_page()
        logs = []
        page.on("console", lambda m: logs.append(m.text))
        t0 = time.time()
        page.goto(url, wait_until="domcontentloaded")
        first_frame = None
        deadline = time.time() + seconds
        while time.time() < deadline:
            if first_frame is None:
                try:
                    if page.evaluate("window.__probe && window.__probe.ready"):
                        first_frame = time.time() - t0
                except Exception:  # noqa: BLE001
                    pass
            time.sleep(0.5)
        probe = page.evaluate("window.__probe")
        b.close()
        probe["time_to_first_frame_sec"] = round(first_frame, 2) if first_frame else None
        probe["console"] = logs[-20:]
        return probe


def vodify(out):
    """Copy the origin and close its playlists so the DVR window plays as on-demand."""
    import shutil
    dest = out.rstrip("/") + "_vod"
    if os.path.exists(dest):
        shutil.rmtree(dest)
    shutil.copytree(out, dest, symlinks=True)
    # every MEDIA playlist gets closed; the MASTER must not (an ENDLIST in a master is
    # invalid and hls.js rejects the whole manifest)
    media = [p for p in glob.glob(os.path.join(dest, "*.m3u8"))
             if not os.path.basename(p).startswith("master")]
    for path in media + glob.glob(os.path.join(dest, "subtitles", "*", "subs.m3u8")):
        txt = open(path).read()
        if "#EXT-X-ENDLIST" in txt:
            continue
        lines, out_lines = txt.splitlines(), []
        for l in lines:
            if l.startswith("#EXT-X-MEDIA-SEQUENCE"):
                out_lines.append(l)
                out_lines.append("#EXT-X-PLAYLIST-TYPE:VOD")
                continue
            out_lines.append(l)
        open(path, "w").write("\n".join(out_lines) + "\n#EXT-X-ENDLIST\n")
    return dest


def main():
    run = sys.argv[1]
    seconds = 90
    hold = 14
    ref_path = None
    manifest = "master_cc.m3u8"
    vod = "--vod" in sys.argv
    for i, a in enumerate(sys.argv):
        if a == "--seconds":
            seconds = int(sys.argv[i + 1])
        if a == "--ref":
            ref_path = sys.argv[i + 1]
        if a == "--hold":
            hold = float(sys.argv[i + 1])
        if a == "--manifest":
            manifest = sys.argv[i + 1]
    out = run
    if os.path.isdir(os.path.join(run, "origin", "runs")):
        out = sorted(glob.glob(os.path.join(run, "origin", "runs", "*")))[-1]

    port = 8099
    root = os.path.dirname(os.path.abspath(__file__))
    if vod:
        # REPLAY MODE. A live playlist ends at the live edge, so once the encoder stops a
        # player can only watch the last few seconds before it runs dry. Closing the
        # playlists turns the run's DVR window into an on-demand asset, which lets the
        # browser play the WHOLE window from the start with no encoder competing for CPU.
        # It also exercises the claim that matters most about alignment: a cue must land
        # on the right frame anywhere in the window, not just at the live edge.
        out = vodify(out)
        manifest = "master_cc.m3u8"
    # one document root that exposes both the player page and the origin
    stage = os.path.join(run, "_serve")
    os.makedirs(stage, exist_ok=True)
    ensure_hlsjs(root)
    for asset in ("player_probe.html", "hls.min.js"):
        dst = os.path.join(stage, asset)
        if not os.path.exists(dst):
            os.symlink(os.path.join(root, asset), dst)
    link = os.path.join(stage, "origin")
    if not os.path.exists(link):
        os.symlink(out, link)
    httpd = serve(stage, port)
    url = f"http://127.0.0.1:{port}/player_probe.html?src=/origin/{manifest}&hold={hold}"
    probe = run_browser(url, seconds, hold)
    httpd.shutdown()

    report = {"run": run, "out": out, "manifest": manifest,
              "time_to_first_frame_sec": probe.get("time_to_first_frame_sec"),
              "fatal_error": probe.get("fatal")}
    if probe.get("fatal") == "manifestIncompatibleCodecsError":
        # Chromium builds without the proprietary decoders cannot play H.264/AAC at all.
        # Say so plainly instead of reporting it as a pipeline failure, and point at the
        # test that does cover player behaviour on such a machine.
        report["note"] = ("this browser has no H.264/AAC decoder, so it cannot play the "
                          "output; run on a machine with Google Chrome, or use "
                          "test_player_alignment.py which checks cue placement with a "
                          "codec every browser can decode")
        print(json.dumps(report, indent=2))
        return

    evs = probe.get("events") or []
    report["subtitle_tracks_seen"] = next((e["d"] for e in evs if e["type"] == "subtitle_tracks"), [])
    report["audio_tracks_seen"] = next((e["d"] for e in evs if e["type"] == "audio_tracks"), [])
    report["waiting_events"] = sum(1 for e in evs if e["type"] == "waiting")
    report["stalled_events"] = sum(1 for e in evs if e["type"] == "stalled")
    report["errors"] = [e["d"] for e in evs if e["type"] == "error"][:10]
    report["subtitle_fragments_loaded"] = sum(1 for e in evs if e["type"] == "sub_frag" and e["d"].get("ok"))

    s = probe.get("samples") or []
    playing = [x for x in s if not x["paused"]]
    report["samples"] = len(s)
    if len(playing) > 4:
        # playback smoothness: currentTime should advance ~0.25s per 0.25s sample
        gaps = []
        for a, b in zip(playing, playing[1:]):
            dw = b["wall"] - a["wall"]
            dc = b["ct"] - a["ct"]
            if dw > 0:
                gaps.append(dc / dw)
        frozen = sum(1 for g in gaps if g < 0.25)
        report["playback"] = {
            "rate_median": round(sorted(gaps)[len(gaps) // 2], 3),
            "frozen_samples": frozen,
            "frozen_pct": round(100.0 * frozen / len(gaps), 2),
            "backwards_jumps": sum(1 for g in gaps if g < -0.1),
        }
    with_cues = [x for x in s if x["cues"]]
    report["cue_on_screen_pct"] = round(100.0 * len(with_cues) / max(1, len(playing)), 1)

    # --- the sync measurement: displayed words vs spoken words -----------------
    epoch = media_epoch_from_playlist(out)
    report["media_epoch"] = epoch
    if ref_path and os.path.exists(ref_path):
        ref = json.load(open(ref_path))
    else:
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            wav = os.path.join(td, "d.wav")
            dec = syncheck.decode_delivered_audio(out, wav)
            ref = syncheck.reference_words(wav, dec[0], model=os.environ.get("REF_MODEL", "base.en")) if dec else []
        if ref_path:
            json.dump(ref, open(ref_path, "w"))
    report["reference_words"] = len(ref)

    # A cue stays on screen for seconds, so sampling it repeatedly would just measure
    # its own duration. Take the ONSET of each distinct cue: the first sample where it
    # appeared, which is the moment the viewer sees those words arrive.
    onsets, prev = [], None
    for x in s:
        text = " ".join(x["cues"]).replace("\n", " ").strip()
        if text and text != prev and x["pdt"] is not None and not x["paused"]:
            onsets.append((x["pdt"], text))
        prev = text
    report["cue_onsets"] = len(onsets)

    errs = []
    if ref and epoch:
        for pdt, text in onsets:
            pts = pdt - epoch               # where the playhead is on the media timeline
            cw = [w.strip(".,!?;:'\"") for w in syncheck.norm_words(text)]
            rt = syncheck.match_cue(cw, ref, pts)
            if rt is None:
                continue
            # the cue APPEARS when the playhead is at `pts`; its first word is spoken at
            # `rt`. Positive => the words appear on screen AFTER they are said.
            errs.append(round(pts - rt, 3))
    report["displayed_sync_error_sec"] = {
        "n": len(errs),
        "median": syncheck.pct(errs, 50),
        "p05": syncheck.pct(errs, 5),
        "p95": syncheck.pct(errs, 95),
        "within_1s": round(sum(1 for e in errs if abs(e) <= 1.0) / len(errs), 3) if errs else None,
        "within_2s": round(sum(1 for e in errs if abs(e) <= 2.0) / len(errs), 3) if errs else None,
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
