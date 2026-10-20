#!/usr/bin/env python3
# ===========================================================================
#  LIVE CAPTIONS ON CPU: faster-whisper tiny/base inside the encoder.
#
#  Speech is synthesised with espeak-ng (no fixture to keep in the repo), then
#  the encoder's own WhisperAdapter transcribes it on CPU with int8, warm, as
#  the live worker does window after window. Asserted: the words come back,
#  cues are timed inside the audio, and a warm window transcribes in well under
#  its own length (the live budget). Also: with in_encoder false (the GPU
#  add-on transcribes) the encoder only advertises the subtitle tracks and
#  starts no worker.
#
#    ESPEAK_BIN=espeak-ng [ESPEAK_DATA=...] python3 dev/test_whisper_cpu.py
#  Skips the transcription part when faster_whisper or espeak-ng is missing.
# ===========================================================================
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(HERE, "..", "bin")
sys.path.insert(0, BIN)
import captions as capmod  # noqa: E402

PASS = FAIL = 0


def ok(cond, msg, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"PASS {msg}")
    else:
        FAIL += 1
        print(f"FAIL {msg}" + (f" -- {extra}" if extra else ""))


tmp = tempfile.mkdtemp(prefix="volt-whispercpu-", dir=os.environ.get("TMPDIR"))

# ---- the GPU add-on case: the encoder starts no worker --------------------------------------------
spec = importlib.util.spec_from_file_location("enc", os.path.join(BIN, "encoder.py"))
enc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(enc)
logs = []
enc.log = lambda m: logs.append(m)
enc.WORK_DIR = tmp
before = {t.name for t in threading.enumerate()}
enc.start_captions({"segment_seconds": 4, "captions": {"enabled": True, "engine": "whisper", "targets": ["en", "ms"],
                                                     "source_lang": "en", "in_encoder": False}}, os.path.join(tmp, "out"))
ok(os.path.exists(os.path.join(tmp, "out", "subtitles", "ms", "subs.m3u8")), "in_encoder false: subtitle playlists are still advertised")
ok("captions" not in {t.name for t in threading.enumerate()} - before and any("runs as its own task" in m for m in logs),
   "in_encoder false: no caption worker in the encoder", str(logs))

# ---- real transcription on CPU -------------------------------------------------------------------
try:
    import faster_whisper  # noqa: F401
    have_fw = True
except Exception:  # noqa: BLE001
    have_fw = False
ESPEAK = os.environ.get("ESPEAK_BIN") or shutil.which("espeak-ng") or shutil.which("espeak")
if not have_fw or not ESPEAK or not shutil.which("ffmpeg"):
    print("PASS skipped the transcription part: needs faster_whisper, espeak-ng and ffmpeg")
else:
    raw = os.path.join(tmp, "speech.wav")
    args = [ESPEAK, "-w", raw]
    if os.environ.get("ESPEAK_DATA"):
        args += ["--path", os.environ["ESPEAK_DATA"]]
    subprocess.run(args + ["Good evening. This is the Volt news at six. Tomorrow will be sunny with a light breeze."], check=True)
    wav = os.path.join(tmp, "speech16.wav")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", raw, "-ac", "1", "-ar", "16000", wav], check=True)
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav],
                               capture_output=True, text=True).stdout.strip())
    for size in ("tiny", "base"):
        a = capmod.WhisperAdapter("", "en", size)
        a.audio_path = wav
        a.transcribe(["en"])                     # warm, as the live worker keeps it
        t0 = time.time()
        cues = a.transcribe(["en"])
        wall = time.time() - t0
        text = " ".join(c.text for c in cues).lower()
        ok("evening" in text and "tomorrow" in text, f"{size}: the words come back ({text.replace(chr(10), ' ')!r})")
        ok(cues and all(0 <= c.start < c.end <= dur + 0.5 for c in cues) and all(c.lang == "en" for c in cues), f"{size}: cues timed inside the {dur:.1f}s of audio")
        ok(wall < dur / 2, f"{size}: a warm window transcribes in {wall:.2f}s for {dur:.1f}s of audio (live budget: under half)")
shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
