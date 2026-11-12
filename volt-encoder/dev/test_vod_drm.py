#!/usr/bin/env python3
# ===========================================================================
#  DRM FOR FILE ENCODES (build queue P4-2): vod_encoder.py fetches the key
#  from the job's SPEKE key service exactly as the live encoder does
#  (encoder.fetch_drm_keys through speke_client.py) and hands Shaka the same
#  cbcs flags (encoder.shaka_drm_flags).
#
#  Asserted: no drm in the job, no key request and no extra flags; with drm,
#  one CPIX request naming the content id, with the Basic credential from
#  auth_ref + tenant_id; the package command ends with raw-key cbcs flags
#  (clear lead 0, key id and key, IV, PSSH, FairPlay key URI); a key service
#  that fails ends the encoder with an error instead of packaging in the
#  clear. The full encode with Shaka is in
#  volt-app/test/publishing-encode-policy.check.ts (a recording stub where
#  there is no Shaka; the real one on the Mac with PACKAGER_BIN).
#
#    python3 dev/test_vod_drm.py
# ===========================================================================
import base64
import http.server
import importlib.util
import os
import subprocess
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(HERE, "..", "bin")
sys.path.insert(0, BIN)
spec = importlib.util.spec_from_file_location("vod", os.path.join(BIN, "vod_encoder.py"))
vod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vod)

PASS = FAIL = 0


def ok(cond, msg, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"PASS {msg}")
    else:
        FAIL += 1
        print(f"FAIL {msg}" + (f" -- {extra}" if extra else ""))


SEEN = []
DOWN = {"on": False}
KEY = bytes(range(16))
IV = bytes([0xA5] * 16)
SKD = "skd://keys.example.test/fairplay/vod"


class Speke(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
        SEEN.append({"auth": self.headers.get("Authorization"), "body": body})
        if DOWN["on"]:
            self.send_response(500)
            self.end_headers()
            return
        import re
        kid = re.search(r'ContentKey[^>]*kid="([^"]+)"', body).group(1)
        b64 = lambda b: base64.b64encode(b).decode()
        line = f'#EXT-X-KEY:METHOD=SAMPLE-AES,URI="{SKD}",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"'
        xml = f'''<?xml version="1.0"?>
<cpix:CPIX xmlns:cpix="urn:dashif:org:cpix" xmlns:pskc="urn:ietf:params:xml:ns:keyprov:pskc">
 <cpix:ContentKeyList><cpix:ContentKey kid="{kid}" explicitIV="{b64(IV)}"><cpix:Data><pskc:Secret><pskc:PlainValue>{b64(KEY)}</pskc:PlainValue></pskc:Secret></cpix:Data></cpix:ContentKey></cpix:ContentKeyList>
 <cpix:DRMSystemList><cpix:DRMSystem kid="{kid}" systemId="94ce86fb-07ff-4f43-adb8-93d2fa968ca2"><cpix:HLSSignalingData playlist="media">{b64(line.encode())}</cpix:HLSSignalingData></cpix:DRMSystem></cpix:DRMSystemList>
</cpix:CPIX>'''.encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(xml)))
        self.end_headers()
        self.wfile.write(xml)


srv = http.server.HTTPServer(("127.0.0.1", 0), Speke)
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{srv.server_address[1]}/speke/v2.0/copyProtection"
os.environ["VOLT_TEST_VOD_SECRET"] = "s3cret"
DRM = {"mode": "cbcs", "speke_url": URL, "content_id": "asset-42", "auth_ref": "env:VOLT_TEST_VOD_SECRET",
       "tenant_id": "tenant-9", "systems": ["widevine", "playready", "fairplay"]}
CFG = {"segment_seconds": 2, "packaging": "both"}
PARTS = [{"label": "720p", "path": "/w/720p.ts"}]
import tempfile
OUT = tempfile.mkdtemp(prefix="vod-drm-out-")

# ---- no DRM asked ----------------------------------------------------------
ok(vod.drm_keys(CFG) is None and vod.drm_keys({**CFG, "drm": {"mode": "none"}}) is None and not SEEN,
   "no drm in the job (or mode none): no key request")
clear = vod.build_package_cmd(CFG, PARTS, "/w/audio.ts", OUT)
ok("--enable_raw_key_encryption" not in clear and clear == vod.build_package_cmd(CFG, PARTS, "/w/audio.ts", OUT, None),
   "the clear package command is unchanged")

# ---- DRM asked ------------------------------------------------------------
got = vod.drm_keys({**CFG, "drm": DRM})
ok(len(SEEN) == 1, "exactly one key request", str(len(SEEN)))
ok(SEEN[0]["auth"] == "Basic " + base64.b64encode(b"tenant-9:s3cret").decode(),
   "the credential comes from auth_ref + tenant_id (never the job)", SEEN[0]["auth"])
ok('id="asset-42"' in SEEN[0]["body"], "the CPIX request names the title as the content id")
ok(got and got["keys"]["keys"][0]["key"] == KEY.hex() and got["keys"].get("hls_key_uri") == SKD, "the key and FairPlay key URI come back")
cmd = vod.build_package_cmd(CFG, PARTS, "/w/audio.ts", OUT, got["flags"])
tail = cmd[len(clear):]
ok(cmd[:len(clear)] == clear, "the DRM flags are added after the clear command, which is otherwise the same")


def at(flag):
    return tail[tail.index(flag) + 1] if flag in tail else None


ok("--enable_raw_key_encryption" in tail and at("--protection_scheme") == "cbcs" and at("--clear_lead") == "0",
   "raw-key cbcs with no clear lead", " ".join(tail))
ok(at("--keys") and f"key={KEY.hex()}" in at("--keys") and at("--iv") == IV.hex(), "the key, its id and the IV")
ok(at("--hls_key_uri") == SKD and at("--protection_systems") == "Widevine,PlayReady,FairPlay", "the FairPlay key URI and the systems")

# ---- the whole script: a failing key service fails the encode -------------
DOWN["on"] = True
import json
import tempfile
d = tempfile.mkdtemp(prefix="vod-drm-")
src = os.path.join(d, "in.mp4")
open(src, "wb").write(b"not really media")
job = os.path.join(d, "job.json")
json.dump({"input": src, "out_dir": os.path.join(d, "out"), "segment_seconds": 2, "ladder": [], "drm": DRM}, open(job, "w"))
r = subprocess.run([sys.executable, os.path.join(BIN, "vod_encoder.py"), job], capture_output=True, text=True,
                   env=dict(os.environ, PACKAGER_BIN="/nonexistent/packager"), timeout=60)
ok(r.returncode != 0 and "SPEKE key request failed" in (r.stdout + r.stderr),
   "a key service that fails ends the encoder before any encoding, with the reason", (r.stdout + r.stderr)[-300:])
ok(not os.path.exists(os.path.join(d, "out", "master.m3u8")), "nothing is packaged in the clear instead")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
