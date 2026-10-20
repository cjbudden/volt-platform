#!/usr/bin/env python3
# ===========================================================================
#  GLADIA LIVE ADAPTER against a local stand-in for the Gladia v2 live API.
#
#  No key and no network: a local HTTP server answers POST /v2/live with a
#  websocket URL, and a local websocket server (built on ws_client's framing)
#  plays Gladia: it counts the PCM it receives and sends a final transcript
#  for every two seconds of audio, plus a translation per target language.
#
#  Asserted: the init request (key header, sample rate, translation targets),
#  one session reused across caption windows, only each window's new audio
#  sent (never the preroll), utterance stream times mapped onto each window's
#  WAV (so the encoder's preroll rule works), translations as their own
#  language, a dropped socket raising for that window and the next window
#  opening a new session, stop_recording on close, and make_adapter wiring.
#  Also the websocket client itself: handshake check, masking, fragments,
#  ping/pong, close.
#    python3 dev/test_gladia_live.py
# ===========================================================================
import http.server
import json
import os
import socket
import socketserver
import struct
import sys
import tempfile
import threading
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "bin"))
import captions as capmod  # noqa: E402
import ws_client as wsc  # noqa: E402

PASS = FAIL = 0


def ok(cond, msg, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"PASS {msg}")
    else:
        FAIL += 1
        print(f"FAIL {msg}" + (f" -- {extra}" if extra else ""))


SR = 16000
STATE = {"init": [], "sessions": 0, "audio_bytes": [], "texts": [], "drop_after_s": None, "conn": None}


class WsServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class WsHandler(socketserver.BaseRequestHandler):
    def handle(self):
        s = self.request
        req = b""
        while b"\r\n\r\n" not in req:
            req += s.recv(4096)
        hdr = {k.strip().lower(): v.strip() for k, _, v in (l.partition(":") for l in req.decode().split("\r\n")[1:] if l)}
        key = hdr["sec-websocket-key"]
        s.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                   f"Sec-WebSocket-Accept: {wsc.accept_for(key)}\r\n\r\n").encode())
        STATE["sessions"] += 1
        sess = STATE["sessions"]
        targets = (STATE["init"][-1].get("realtime_processing") or {}).get("translation_config", {}).get("target_languages", [])
        got = 0
        said = 0
        STATE["audio_bytes"].append(0)
        while True:
            try:
                fin, op, data = wsc.read_frame(s)
            except wsc.WebSocketClosed:
                return
            if op == wsc.OP_CLOSE:
                s.sendall(wsc.encode_frame(wsc.OP_CLOSE, data[:2], mask=False))
                return
            if op == wsc.OP_TEXT:
                STATE["texts"].append(json.loads(data))
                continue
            if op != wsc.OP_BINARY:
                continue
            got += len(data)
            STATE["audio_bytes"][-1] = got
            secs = got / 2 / SR
            if STATE["drop_after_s"] is not None and secs >= STATE["drop_after_s"]:
                STATE["drop_after_s"] = None
                s.close()          # the provider drops the connection mid-session
                return
            while (said + 1) * 2 <= secs + 1e-9:
                st, en = said * 2.0, said * 2.0 + 1.8
                text = f"Session {sess} sentence {said}."
                msg = {"type": "transcript", "data": {"id": f"u{said}", "is_final": True,
                       "utterance": {"start": st, "end": en, "text": text, "language": "en",
                                     "words": [{"word": "Session", "start": st, "end": st + 0.4}]}}}
                s.sendall(wsc.encode_frame(wsc.OP_TEXT, json.dumps(msg).encode(), mask=False))
                for t in targets:
                    tr = {"type": "translation", "data": {"utterance_id": f"u{said}", "original_language": "en", "target_language": t,
                          "translated_utterance": {"start": st, "end": en, "text": f"[{t}] {text}", "language": t}}}
                    s.sendall(wsc.encode_frame(wsc.OP_TEXT, json.dumps(tr).encode(), mask=False))
                said += 1


ws_srv = WsServer(("127.0.0.1", 0), WsHandler)
threading.Thread(target=ws_srv.serve_forever, daemon=True).start()
WS_URL = f"ws://127.0.0.1:{ws_srv.server_address[1]}/v2/live?token=abc"


class Api(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        body["_key"] = self.headers.get("X-Gladia-Key")
        body["_path"] = self.path
        STATE["init"].append(body)
        out = json.dumps({"id": f"sess-{len(STATE['init'])}", "url": WS_URL}).encode()
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


api = http.server.HTTPServer(("127.0.0.1", 0), Api)
threading.Thread(target=api.serve_forever, daemon=True).start()
API_URL = f"http://127.0.0.1:{api.server_address[1]}"

tmp = tempfile.mkdtemp(prefix="volt-gladia-", dir=os.environ.get("TMPDIR"))


def window_wav(pre_s, win_s, name):
    p = os.path.join(tmp, name)
    with wave.open(p, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(b"\x01\x00" * int((pre_s + win_s) * SR))
    return p


# ---- the adapter over two windows of one session -------------------------------------------
a = capmod.GladiaAdapter("test-key", "en", ["en", "es"], base_url=API_URL, wait_s=3)
a.audio_path, a.split_at = window_wav(2, 4, "w1.wav"), 2.0
c1 = a.transcribe(["en", "es"])
init = STATE["init"][0]
ok(init["_path"] == "/v2/live" and init["_key"] == "test-key", "init: POST /v2/live with X-Gladia-Key")
ok(init["sample_rate"] == 16000 and init["encoding"] == "wav/pcm" and init["bit_depth"] == 16 and init["channels"] == 1, "init: 16 kHz mono 16-bit PCM")
ok(init["realtime_processing"]["translation_config"]["target_languages"] == ["es"] and init["language_config"]["languages"] == ["en"], "init: source en, translate to es (not to the source)")
ok(STATE["audio_bytes"][0] == 4 * SR * 2, f"window 1 sent only its own 4 s, not the preroll ({STATE['audio_bytes'][0]} bytes)")
en1 = sorted((c.start, c.end, c.text) for c in c1 if c.lang == "en")
ok([(round(s, 2), round(e, 2)) for s, e, _ in en1] == [(2.0, 3.8), (4.0, 5.8)], f"window 1 cues land after split_at on the WAV: {en1}")
es1 = [c for c in c1 if c.lang == "es"]
ok(len(es1) == 2 and es1[0].text.startswith("[es]"), "translations come back as their own language")

a.audio_path, a.split_at = window_wav(2, 4, "w2.wav"), 2.0
c2 = a.transcribe(["en", "es"])
en2 = sorted((round(c.start, 2), round(c.end, 2), c.text) for c in c2 if c.lang == "en")
ok(STATE["sessions"] == 1 and a.sessions_opened == 1, "one session serves both windows")
ok([x[:2] for x in en2] == [(2.0, 3.8), (4.0, 5.8)] and "sentence 2" in en2[0][2], f"window 2: stream times 4 to 8 s mapped onto its WAV: {en2}")
ok(STATE["audio_bytes"][0] == 8 * SR * 2, "8 s sent in total over two windows")

# ---- the provider drops the connection ------------------------------------------------------
STATE["drop_after_s"] = 9.0
a.audio_path, a.split_at = window_wav(2, 4, "w3.wav"), 2.0
try:
    a.transcribe(["en", "es"])
    ok(False, "a dropped session raises for that window")
except RuntimeError as e:
    ok("gladia session ended" in str(e), f"a dropped session raises for that window ({e})")
ok(a.ws is None, "and the session is closed")
a.audio_path, a.split_at = window_wav(2, 4, "w4.wav"), 2.0
c4 = a.transcribe(["en", "es"])
en4 = sorted((round(c.start, 2), c.text) for c in c4 if c.lang == "en")
ok(a.sessions_opened == 2 and STATE["sessions"] == 2, "the next window opens a new session")
ok(en4 and en4[0][0] == 2.0 and en4[0][1].startswith("Session 2"), f"and maps from the new session's start: {en4}")
a.close()
import time as _t
_t.sleep(0.2)
ok(STATE["texts"][-1:] == [{"type": "stop_recording"}], "close() sends stop_recording")

# ---- wiring -----------------------------------------------------------------------------------
os.environ.pop("GLADIA_API_KEY", None)
try:
    capmod.make_adapter({"engine": "gladia"})
    ok(False, "no key: refused")
except SystemExit as e:
    ok("GLADIA_API_KEY" in str(e), "no key: refused with the reason")
os.environ["GLADIA_API_KEY"] = "k"
m = capmod.make_adapter({"engine": "gladia", "source_lang": "en", "targets": ["fr"], "audio_path": "/x.wav"})
ok(isinstance(m, capmod.GladiaAdapter) and m.targets == ["fr"] and m.source_lang == "en" and m.audio_path == "/x.wav", "make_adapter builds a GladiaAdapter with language, targets and audio")
enc_src = open(os.path.join(HERE, "..", "bin", "encoder.py")).read()
ok('elif engine == "gladia":' in enc_src and 'make_adapter({"engine": "gladia"' in enc_src, "the encoder builds one gladia adapter per run, not one per window")
ok('state="producing", langs=langs, recovered=True' in enc_src, "the encoder announces recovery after transcribe errors (QC lane clears)")

# ---- the websocket client on its own --------------------------------------------------------
frame = wsc.encode_frame(wsc.OP_TEXT, b"hello")
ok(frame[1] & 0x80 and len(frame) == 2 + 4 + 5, "client frames are masked")
big = wsc.encode_frame(wsc.OP_BINARY, b"x" * 70000, mask=False)
ok(big[1] == 127 and struct.unpack(">Q", big[2:10])[0] == 70000, "64-bit length encoding")


class Echo(socketserver.BaseRequestHandler):
    def handle(self):
        s = self.request
        req = b""
        while b"\r\n\r\n" not in req:
            req += s.recv(4096)
        key = [l.split(":", 1)[1].strip() for l in req.decode().split("\r\n") if l.lower().startswith("sec-websocket-key")][0]
        bad = b"/bad" in req.split(b"\r\n")[0]
        acc = "nope" if bad else wsc.accept_for(key)
        s.sendall(f"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {acc}\r\n\r\n".encode()
                  + wsc.encode_frame(wsc.OP_PING, b"p", mask=False)
                  + wsc.encode_frame(wsc.OP_TEXT, b"hel", mask=False, fin=False)
                  + wsc.encode_frame(wsc.OP_CONT, b"lo", mask=False))
        try:
            fin, op, data = wsc.read_frame(s)       # the pong
            STATE["pong"] = (op, data)
            fin, op, data = wsc.read_frame(s)       # our text
            s.sendall(wsc.encode_frame(wsc.OP_CLOSE, struct.pack(">H", 1000) + b"bye", mask=False))
        except wsc.WebSocketClosed:
            pass


echo = WsServer(("127.0.0.1", 0), Echo)
threading.Thread(target=echo.serve_forever, daemon=True).start()
ws = wsc.WebSocket(f"ws://127.0.0.1:{echo.server_address[1]}/x")
op, data = ws.recv()
ok(op == wsc.OP_TEXT and data == b"hello", "a fragmented message is reassembled (ping answered in between)")
ws.send_text("hi")
try:
    ws.recv()
    ok(False, "close frame raises")
except wsc.WebSocketClosed as e:
    ok(e.code == 1000 and e.reason == "bye", "close frame raises WebSocketClosed with code and reason")
ok(STATE.get("pong") == (wsc.OP_PONG, b"p"), "ping got its pong")
try:
    wsc.WebSocket(f"ws://127.0.0.1:{echo.server_address[1]}/bad")
    ok(False, "a wrong Sec-WebSocket-Accept is refused")
except wsc.WebSocketClosed as e:
    ok("Accept" in str(e), "a wrong Sec-WebSocket-Accept is refused")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
