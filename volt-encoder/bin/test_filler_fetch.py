"""Tests for filler_build.fetch_prebuilt (build queue 2.1a-3): an encoder on AWS
fetching the pre-built loop the control plane keeps in the bucket, over HTTP
from a real local server. Run: python3 test_filler_fetch.py
"""
import functools
import http.server
import json
import os
import tempfile
import threading

import filler_build

PASS = FAIL = 0


def ok(cond, name):
    global PASS, FAIL
    if cond:
        PASS += 1
    else:
        FAIL += 1
        print("FAIL", name)


def build(root, h, extra=None):
    """A built loop as filler_build.build leaves it: two tracks, filler.json last."""
    meta = {"hash": h, "segment_seconds": 2, "loop_seconds": 4, "has_watermark": False, "tracks": {
        "720p": {"kind": "video", "width": 1280, "height": 720, "init": "720p/init.mp4",
                 "segments": [{"uri": "720p/seg_1.m4s", "dur": 2}, {"uri": "720p/seg_2.m4s", "dur": 2}]},
        "audio": {"kind": "audio", "init": "audio/init.mp4", "segments": [{"uri": "audio/seg_1.m4s", "dur": 2}]}}}
    if extra:
        meta["tracks"]["720p"]["segments"].append({"uri": extra, "dur": 2})
    for t in meta["tracks"].values():
        for rel in [t["init"]] + [x["uri"] for x in t["segments"]]:
            p = os.path.join(root, *rel.split("/"))
            if ".." in rel or rel.startswith("/"):
                continue
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "wb") as fh:
                fh.write(f"{h}:{rel}".encode())
    with open(os.path.join(root, "master.m3u8"), "w") as fh:
        fh.write("#EXTM3U\n")
    with open(os.path.join(root, "filler.json"), "w") as fh:
        json.dump(meta, fh)
    return meta


served = tempfile.mkdtemp(prefix="filler-served-")
hits = []


class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        hits.append(self.path)
        return super().do_GET()


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(H, directory=served))
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{srv.server_address[1]}"

# ---- a whole loop comes down ---------------------------------------------------
os.makedirs(os.path.join(served, "prebuilt", "s1", "h1"))
build(os.path.join(served, "prebuilt", "s1", "h1"), "h1")
dest = os.path.join(tempfile.mkdtemp(prefix="filler-dest-"), "filler-pre", "h1")
meta = filler_build.fetch_prebuilt(f"{base}/prebuilt/s1/h1/", dest)
ok(meta["hash"] == "h1", "returns the build's metadata")
ok(filler_build.load(dest) and filler_build.load(dest)["hash"] == "h1", "dest loads like a local build")
for rel in ("720p/init.mp4", "720p/seg_1.m4s", "720p/seg_2.m4s", "audio/init.mp4", "audio/seg_1.m4s"):
    p = os.path.join(dest, *rel.split("/"))
    ok(os.path.isfile(p) and open(p, "rb").read() == f"h1:{rel}".encode(), f"{rel} fetched byte for byte")
ok(not os.path.exists(os.path.join(dest, "master.m3u8")), "only what filler.json names is fetched (playlists are not needed)")
ok(not os.path.exists(dest + ".part"), "no partial folder is left")
ok(hits[0].endswith("/filler.json"), "filler.json is asked for first")

# ---- the same build again is not fetched again ---------------------------------------
hits.clear()
filler_build.fetch_prebuilt(f"{base}/prebuilt/s1/h1", dest)   # no trailing slash
ok(len(hits) == 1 and hits[0].endswith("/prebuilt/s1/h1/filler.json"), "same hash already here: only filler.json is read")

# ---- a new build replaces the old one -------------------------------------------------
build(os.path.join(served, "prebuilt", "s1", "h1"), "h2")
meta = filler_build.fetch_prebuilt(f"{base}/prebuilt/s1/h1/", dest)
ok(meta["hash"] == "h2" and open(os.path.join(dest, "720p", "seg_1.m4s"), "rb").read() == b"h2:720p/seg_1.m4s", "another hash is fetched again and replaces the folder")

# ---- a file missing part-way: nothing that looks complete is left --------------------
d2 = os.path.join(tempfile.mkdtemp(prefix="filler-dest-"), "h3")
os.makedirs(os.path.join(served, "prebuilt", "s2", "h3"))
build(os.path.join(served, "prebuilt", "s2", "h3"), "h3")
os.remove(os.path.join(served, "prebuilt", "s2", "h3", "audio", "seg_1.m4s"))
err = None
try:
    filler_build.fetch_prebuilt(f"{base}/prebuilt/s2/h3/", d2)
except Exception as e:  # noqa: BLE001
    err = e
ok(err is not None, "a missing segment fails the fetch")
ok(not os.path.exists(d2) and not os.path.exists(d2 + ".part"), "and leaves neither the folder nor a partial one")

# ---- an existing good copy survives a failed fetch of a newer one ---------------------
build(os.path.join(served, "prebuilt", "s1", "h1"), "h4")
os.remove(os.path.join(served, "prebuilt", "s1", "h1", "720p", "seg_2.m4s"))
try:
    filler_build.fetch_prebuilt(f"{base}/prebuilt/s1/h1/", dest)
except Exception:  # noqa: BLE001
    pass
ok(filler_build.load(dest)["hash"] == "h2", "the copy already here is kept when a newer one cannot be fetched")

# ---- names that would leave the folder are refused -----------------------------------
for evil in ("../../etc/passwd", "/etc/passwd", "720p/../../x", "http://evil/x", "a\\b"):
    os.makedirs(os.path.join(served, "prebuilt", "s3", "bad"), exist_ok=True)
    build(os.path.join(served, "prebuilt", "s3", "bad"), "bad", extra=evil)
    d3 = os.path.join(tempfile.mkdtemp(prefix="filler-dest-"), "bad")
    err = None
    try:
        filler_build.fetch_prebuilt(f"{base}/prebuilt/s3/bad/", d3)
    except ValueError as e:
        err = e
    ok(err is not None and "outside its folder" in str(err) and not os.path.exists(d3), f"refused: {evil!r}")

# ---- nothing to fetch -------------------------------------------------------------------
os.makedirs(os.path.join(served, "prebuilt", "s4", "e"))
with open(os.path.join(served, "prebuilt", "s4", "e", "filler.json"), "w") as fh:
    json.dump({"hash": "e", "tracks": {}}, fh)
err = None
try:
    filler_build.fetch_prebuilt(f"{base}/prebuilt/s4/e/", os.path.join(tempfile.mkdtemp(), "e"))
except ValueError as e:
    err = e
ok(err is not None, "a filler.json that lists no files is refused")

srv.shutdown()
print(f"{PASS} passed, {FAIL} failed")
raise SystemExit(1 if FAIL else 0)
