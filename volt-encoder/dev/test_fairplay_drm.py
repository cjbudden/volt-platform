#!/usr/bin/env python3
# ===========================================================================
#  FAIRPLAY END TO END: SPEKE key server -> speke_client -> encoder flags ->
#  a real Shaka Packager -> HLS with a FairPlay key tag -> decrypt to frames.
#
#  A local stand-in key server speaks SPEKE v2 CPIX (checks the request, the
#  version header and the Basic credential), returns a content key with an
#  explicit IV, a Widevine PSSH and FairPlay HLS signalling. The rest is the
#  production code path: speke_client.py parses it, encoder.shaka_drm_flags
#  turns it into flags, and Shaka packages a short ffmpeg clip with them.
#
#  Asserted: the media playlists carry
#    #EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://...",KEYFORMAT="com.apple.streamingkeydelivery"
#  the init segments are cbcs with our key id, and decrypting with the key
#  gives back every frame (so the bytes really are encrypted with that key,
#  not just labelled). Also: the credential reaches the server from
#  auth_ref + tenant_id, never through argv, and FairPlay without a key URI
#  is refused.
#
#    PACKAGER_BIN=/path/to/packager python3 dev/test_fairplay_drm.py
#  Skips (passes) the packaging part when no packager or ffmpeg is found.
# ===========================================================================
import base64
import http.server
import importlib.util
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import uuid
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(HERE, "..", "bin")
sys.path.insert(0, BIN)
import speke_client as sc  # noqa: E402

spec = importlib.util.spec_from_file_location("enc", os.path.join(BIN, "encoder.py"))
enc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(enc)

PASS = FAIL = 0


def ok(cond, msg, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"PASS {msg}")
    else:
        FAIL += 1
        print(f"FAIL {msg}" + (f" -- {extra}" if extra else ""))


KEY = bytes(range(16))
IV = bytes([0xA5] * 16)
SKD = "skd://keys.example.test/fairplay/abc123"
TENANT, SECRET = "tenant-1", "mgmt-secret"
WIDEVINE = sc.SYSTEM_IDS["widevine"]


def pssh_box(system_id, data=b"volt-test"):
    body = struct.pack(">I", 0) + uuid.UUID(system_id).bytes + struct.pack(">I", len(data)) + data
    return struct.pack(">I", 8 + len(body)) + b"pssh" + body


SEEN = {}
OMIT_FAIRPLAY_URI = {"on": False}


class Speke(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        SEEN["auth"] = self.headers.get("Authorization")
        SEEN["version"] = self.headers.get("X-Speke-Version")
        SEEN["ctype"] = self.headers.get("Content-Type")
        root = ET.fromstring(body)
        ns = {"cpix": sc.CPIX_NS}
        ck = root.find("cpix:ContentKeyList/cpix:ContentKey", ns)
        kid = ck.get("kid")
        SEEN["kid"] = kid
        SEEN["systems"] = [d.get("systemId") for d in root.iter(f"{{{sc.CPIX_NS}}}DRMSystem")]
        SEEN["asked_hls"] = [h.get("playlist") for h in root.iter(f"{{{sc.CPIX_NS}}}HLSSignalingData")]
        b64 = lambda b: base64.b64encode(b).decode()
        ext_x_key = f'#EXT-X-KEY:METHOD=SAMPLE-AES,URI="{SKD}",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"'
        session = ext_x_key.replace("#EXT-X-KEY", "#EXT-X-SESSION-KEY")
        fair = "" if OMIT_FAIRPLAY_URI["on"] else (
            f'<cpix:HLSSignalingData playlist="media">{b64(ext_x_key.encode())}</cpix:HLSSignalingData>'
            f'<cpix:HLSSignalingData playlist="master">{b64(session.encode())}</cpix:HLSSignalingData>')
        xml = f'''<?xml version="1.0" encoding="UTF-8"?>
<cpix:CPIX xmlns:cpix="{sc.CPIX_NS}" xmlns:pskc="{sc.PSKC_NS}" xmlns:speke="{sc.SPEKE_NS}" id="{root.get('id')}">
  <cpix:ContentKeyList>
    <cpix:ContentKey kid="{kid}" explicitIV="{b64(IV)}" commonEncryptionScheme="cbcs">
      <cpix:Data><pskc:Secret><pskc:PlainValue>{b64(KEY)}</pskc:PlainValue></pskc:Secret></cpix:Data>
    </cpix:ContentKey>
  </cpix:ContentKeyList>
  <cpix:DRMSystemList>
    <cpix:DRMSystem kid="{kid}" systemId="{WIDEVINE}"><cpix:PSSH>{b64(pssh_box(WIDEVINE))}</cpix:PSSH></cpix:DRMSystem>
    <cpix:DRMSystem kid="{kid}" systemId="{sc.FAIRPLAY_ID}">{fair}</cpix:DRMSystem>
  </cpix:DRMSystemList>
</cpix:CPIX>'''.encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/xml")
        self.send_header("Content-Length", str(len(xml)))
        self.end_headers()
        self.wfile.write(xml)


srv = http.server.HTTPServer(("127.0.0.1", 0), Speke)
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{srv.server_address[1]}/speke/v2.0/copyProtection"

# ---- the encoder's own fetch, with the credential from auth_ref -------------
os.environ["VOLT_TEST_DRM_SECRET"] = SECRET
drm = {"mode": "cbcs", "speke_url": URL, "content_id": "chan-1", "auth_ref": "env:VOLT_TEST_DRM_SECRET",
       "tenant_id": TENANT, "systems": ["widevine", "fairplay"]}
ok(enc.resolve_drm_auth(drm) == f"{TENANT}:{SECRET}", "auth_ref env: + tenant_id give the Axinom credential")
ok(enc.resolve_drm_auth({"auth": "literal"}) == "literal", "a literal auth still wins (tests, old jobs)")
ok(enc.resolve_drm_auth({}) == "", "no credential configured: empty, not a crash")
# A Secrets Manager ARN (with a JSON field) is read through the aws CLI, faked on PATH here.
shim = tempfile.mkdtemp(prefix="volt-awsshim-", dir=os.environ.get("TMPDIR"))
with open(os.path.join(shim, "aws"), "w") as fh:
    fh.write('#!/bin/sh\necho "$@" > "$(dirname "$0")/args"\necho \'{"axinom_management_key": "from-sm", "other": "x"}\'\n')
os.chmod(os.path.join(shim, "aws"), 0o755)
old_path = os.environ["PATH"]
os.environ["PATH"] = shim + os.pathsep + old_path
arn = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:volt-integrations-AbCd"
got = enc.resolve_drm_auth({"auth_ref": arn + "#axinom_management_key", "tenant_id": "t9"})
os.environ["PATH"] = old_path
args_seen = open(os.path.join(shim, "args")).read()
ok(got == "t9:from-sm" and f"--secret-id {arn} " in args_seen and "#" not in args_seen, "Secrets Manager ARN#field resolves the JSON field", got)

argv_seen = {}
real_co = subprocess.check_output


def spy(args, **kw):
    argv_seen["args"] = list(args)
    argv_seen["env_auth"] = (kw.get("env") or {}).get("SPEKE_AUTH")
    return real_co(args, **kw)


enc.subprocess.check_output = spy
keys = enc.fetch_drm_keys(drm)
enc.subprocess.check_output = real_co
ok(SEEN.get("auth") == "Basic " + base64.b64encode(f"{TENANT}:{SECRET}".encode()).decode(), "key server got the Basic credential")
ok(SECRET not in " ".join(argv_seen["args"]) and argv_seen["env_auth"] == f"{TENANT}:{SECRET}", "the secret travels in the environment, not argv")
ok(SEEN.get("version") == "2.0" and SEEN.get("ctype") == "application/xml", "SPEKE v2 headers")
ok(set(SEEN["systems"]) == {WIDEVINE, sc.FAIRPLAY_ID} and SEEN["asked_hls"] == ["media", "master"], "request names Widevine + FairPlay and asks for HLS signalling")
ok(keys["keys"][0]["key_id"] == SEEN["kid"].replace("-", "") and keys["keys"][0]["key"] == KEY.hex(), "content key parsed")
ok(keys["keys"][0].get("iv") == IV.hex(), "explicit IV parsed")
ok(keys.get("hls_key_uri") == SKD, "FairPlay key URI taken from HLSSignalingData", keys.get("hls_key_uri"))
ok(keys.get("pssh_hex") == pssh_box(WIDEVINE).hex(), "Widevine PSSH box passed through")
ok(keys.get("protection_systems") == "Widevine,FairPlay", "Shaka protection systems named")

# SPEKE v1-style URIExtXKey is read too.
v1 = f'''<cpix:CPIX xmlns:cpix="{sc.CPIX_NS}" xmlns:pskc="{sc.PSKC_NS}" xmlns:speke="{sc.SPEKE_NS}">
<cpix:ContentKeyList><cpix:ContentKey kid="11111111-2222-3333-4444-555555555555"><cpix:Data><pskc:Secret><pskc:PlainValue>{base64.b64encode(KEY).decode()}</pskc:PlainValue></pskc:Secret></cpix:Data></cpix:ContentKey></cpix:ContentKeyList>
<cpix:DRMSystemList><cpix:DRMSystem kid="11111111-2222-3333-4444-555555555555" systemId="{sc.FAIRPLAY_ID}"><speke:URIExtXKey>{base64.b64encode(SKD.encode()).decode()}</speke:URIExtXKey></cpix:DRMSystem></cpix:DRMSystemList></cpix:CPIX>'''
ok(sc.parse_cpix_response(v1.encode(), ["fairplay"]).get("hls_key_uri") == SKD, "URIExtXKey (SPEKE v1 style) read too")

flags = enc.shaka_drm_flags(keys)
fj = " ".join(flags)
ok("--protection_scheme cbcs" in fj and f"--hls_key_uri {SKD}" in fj and "--protection_systems Widevine,FairPlay" in fj
   and f"--iv {IV.hex()}" in fj and f"--pssh {pssh_box(WIDEVINE).hex()}" in fj and "--clear_lead 0" in fj,
   "encoder flags carry scheme, key URI, systems, IV, PSSH, no clear lead", fj)

# FairPlay asked for, no key URI returned: refused (exit 3), never shipped.
OMIT_FAIRPLAY_URI["on"] = True
r = subprocess.run([sys.executable, os.path.join(BIN, "speke_client.py"), "--url", URL, "--content-id", "x", "--systems", "fairplay"],
                   capture_output=True, text=True, env=dict(os.environ, SPEKE_AUTH="a:b"))
ok(r.returncode == 3 and "no key URI" in r.stderr, "FairPlay without a key URI is refused", r.stderr)
OMIT_FAIRPLAY_URI["on"] = False

# ---- a real Shaka with those flags ------------------------------------------
PACKAGER = os.environ.get("PACKAGER_BIN") or shutil.which("packager")
FFMPEG = shutil.which("ffmpeg")
if not PACKAGER or not FFMPEG or not os.path.exists(PACKAGER):
    print("PASS skipped the packaging part: set PACKAGER_BIN (Shaka Packager) and have ffmpeg on PATH")
else:
    work = tempfile.mkdtemp(prefix="volt-fairplay-", dir=os.environ.get("TMPDIR"))
    src = os.path.join(work, "src.ts")
    subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=25", "-f", "lavfi", "-i", "sine=frequency=440",
                    "-t", "4", "-c:v", "libx264", "-g", "50", "-keyint_min", "50", "-sc_threshold", "0", "-c:a", "aac", "-ar", "48000", src], check=True)
    out = os.path.join(work, "out")
    os.makedirs(out)
    cmd = [PACKAGER,
           f"in={src},stream=video,init_segment={out}/v/init.mp4,segment_template={out}/v/$Number$.m4s,playlist_name=v/index.m3u8",
           f"in={src},stream=audio,init_segment={out}/a/init.mp4,segment_template={out}/a/$Number$.m4s,playlist_name=a/index.m3u8,hls_group_id=audio",
           "--segment_duration", "2", "--hls_master_playlist_output", f"{out}/master.m3u8", "--mpd_output", f"{out}/manifest.mpd"] + flags
    p = subprocess.run(cmd, capture_output=True, text=True)
    ok(p.returncode == 0, "Shaka packaged with the encoder's DRM flags", p.stderr[-400:])
    vpl = open(f"{out}/v/index.m3u8").read() if os.path.exists(f"{out}/v/index.m3u8") else ""
    apl = open(f"{out}/a/index.m3u8").read() if os.path.exists(f"{out}/a/index.m3u8") else ""
    key_re = re.compile(r'#EXT-X-KEY:METHOD=SAMPLE-AES,URI="' + re.escape(SKD) + r'".*KEYFORMAT="com\.apple\.streamingkeydelivery"')
    ok(bool(key_re.search(vpl)), "video playlist: FairPlay EXT-X-KEY with our skd:// URI", vpl[:400])
    ok(bool(key_re.search(apl)), "audio playlist: FairPlay EXT-X-KEY too")
    mpd = open(f"{out}/manifest.mpd").read() if os.path.exists(f"{out}/manifest.mpd") else ""
    ok("cenc:default_KID" in mpd and WIDEVINE in mpd.lower(), "DASH: default KID and the Widevine ContentProtection")
    init = open(f"{out}/v/init.mp4", "rb").read()
    kid = bytes.fromhex(keys["keys"][0]["key_id"])
    ok(b"encv" in init and b"cbcs" in init and kid in init, "video init segment: encv, cbcs scheme, our key id in tenc")
    ok(b"enca" in open(f"{out}/a/init.mp4", "rb").read(), "audio init segment encrypted too (enca)")
    seg1 = open(f"{out}/v/1.m4s", "rb").read()
    ok(b"senc" in seg1 or b"saiz" in seg1, "media segments carry sample encryption info")

    # Decrypt with the key: every frame comes back, so the bytes are encrypted
    # with THIS key and not only labelled.
    full = os.path.join(work, "v_full.mp4")
    segs = sorted((f for f in os.listdir(f"{out}/v") if f.endswith(".m4s")), key=lambda f: int(f.split(".")[0]))
    with open(full, "wb") as w:
        w.write(init)
        for f in segs:
            w.write(open(f"{out}/v/{f}", "rb").read())
    clear = os.path.join(work, "clear.mp4")
    d = subprocess.run([PACKAGER, f"in={full},stream=video,output={clear}", "--enable_raw_key_decryption",
                        "--keys", f"key_id={kid.hex()}:key={KEY.hex()}"], capture_output=True, text=True)
    ok(d.returncode == 0, "Shaka decrypts it with the SPEKE key", d.stderr[-300:])
    frames = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames",
                             "-of", "csv=p=0", clear], capture_output=True, text=True).stdout.strip()
    ok(frames == "100", f"decrypted video decodes: {frames} of 100 frames")
    bad = os.path.join(work, "bad.mp4")
    subprocess.run([PACKAGER, f"in={full},stream=video,output={bad}", "--enable_raw_key_decryption",
                    "--keys", f"key_id={kid.hex()}:key={'00' * 16}"], capture_output=True, text=True)
    errs = subprocess.run([FFMPEG, "-v", "error", "-i", bad, "-f", "null", "-"], capture_output=True, text=True).stderr if os.path.exists(bad) else "no output"
    ok(bool(errs.strip()), "the wrong key does not give a clean decode")
    shutil.rmtree(work, ignore_errors=True)

srv.shutdown()
print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
