#!/usr/bin/env python3
"""Unit tests for the captions sidecar (offline; no network). Run: python3 test_captions.py"""
import json
import os
import tempfile
import captions as C

p = f = 0
def ok(c, m):
    global p, f
    if c: p += 1; print("PASS", m)
    else: f += 1; print("FAIL", m)

# ---- fmt_ts ----
ok(C.fmt_ts(0) == "00:00:00.000", "fmt_ts zero")
ok(C.fmt_ts(3661.5) == "01:01:01.500", "fmt_ts 1h1m1.5s")
ok(C.fmt_ts(-3) == "00:00:00.000", "fmt_ts clamps negative")

# ---- offset ----
cues = [C.Cue(1.0, 2.0, "hi"), C.Cue(3.0, 4.0, "there")]
shifted = C.apply_offset(cues, 2.5)
ok(shifted[0].start == 3.5 and shifted[0].end == 4.5, "apply_offset shifts start+end")

# ---- final_vtt ----
v = C.final_vtt(cues)
ok(v.startswith("WEBVTT"), "final_vtt has WEBVTT header")
ok("00:00:01.000 --> 00:00:02.000" in v, "final_vtt formats cue timing")
ok("hi" in v and "there" in v, "final_vtt includes cue text")

# ---- segmentation (HLS-aligned) ----
# 20s total, 6s segments => 4 segments (0-6,6-12,12-18,18-24)
segs = C.segment_vtt([C.Cue(1, 2, "a"), C.Cue(7, 8, "b"), C.Cue(19, 20, "c")], 6, 20)
ok(len(segs) == 4, f"segment_vtt makes 4 segments for 20s/6s (got {len(segs)})")
ok("a" in segs[0] and "a" not in segs[1], "cue lands in its own segment only")
ok("b" in segs[1], "second cue lands in second segment")
ok("c" in segs[3], "late cue lands in last segment")
ok(all(s.startswith("WEBVTT") for s in segs), "every segment has WEBVTT header")
ok("X-TIMESTAMP-MAP" in segs[0], "segment carries X-TIMESTAMP-MAP")

# a cue spanning a boundary appears in both segments
span = C.segment_vtt([C.Cue(5, 8, "x")], 6, 12)
ok("x" in span[0] and "x" in span[1], "boundary-spanning cue appears in both segments")

# ---- media playlist ----
pl = C.media_playlist(4, 6)
ok(pl.count("sub_") == 4 and "#EXT-X-ENDLIST" in pl, "media playlist lists 4 subtitle segments + ENDLIST")

# ---- run() end-to-end with OfflineAdapter (offset + multi-language) ----
with tempfile.TemporaryDirectory() as d:
    fx = os.path.join(d, "t.json")
    json.dump([{"start": 1, "end": 2, "text": "hello", "lang": "en"},
               {"start": 7, "end": 8, "text": "world", "lang": "en"}], open(fx, "w"))
    out = os.path.join(d, "subs")
    res = C.run({"enabled": True, "source_lang": "en", "targets": ["es"], "offset_sec": 2,
                 "segment_seconds": 6, "total_seconds": 12, "offline_fixture": fx}, out)
    ok(res["enabled"] and set(res["languages"]) == {"en", "es"}, "run produces en + es tracks")
    ok(os.path.exists(os.path.join(out, "en", "final.vtt")), "en final.vtt written")
    ok(os.path.exists(os.path.join(out, "es", "subs.m3u8")), "es subtitle playlist written")
    # offset applied: cue at 1s -> 3s in the output
    envtt = open(os.path.join(out, "en", "final.vtt")).read()
    ok("00:00:03.000 --> 00:00:04.000" in envtt, "playout offset applied to cue timing")
    esvtt = open(os.path.join(out, "es", "final.vtt")).read()
    ok("[es] hello" in esvtt, "translation track carries target-language cues")
    ok(C.run({"enabled": False}, out) == {"enabled": False}, "disabled config is a no-op")

# ---- make_adapter routing (no network / no model load) ----
# offline fixture always wins, even if engine says gladia
with tempfile.TemporaryDirectory() as d:
    fx = os.path.join(d, "t.json"); open(fx, "w").write("[]")
    ok(isinstance(C.make_adapter({"engine": "gladia", "offline_fixture": fx}), C.OfflineAdapter),
       "make_adapter: offline_fixture overrides engine")
# whisper engine -> WhisperAdapter (constructs lazily, no model loaded yet)
ad = C.make_adapter({"engine": "whisper", "audio_path": "/tmp/x.wav", "source_lang": "en"})
ok(isinstance(ad, C.WhisperAdapter) and ad.audio_path == "/tmp/x.wav", "make_adapter: engine=whisper -> WhisperAdapter")
# whisper without audio path is a clear error
try:
    C.make_adapter({"engine": "whisper"}); ok(False, "whisper w/o audio should raise")
except SystemExit:
    ok(True, "make_adapter: whisper without audio_path raises")
# gladia engine without key raises (no fixture)
os.environ.pop("GLADIA_API_KEY", None)
try:
    C.make_adapter({"engine": "gladia"}); ok(False, "gladia w/o key should raise")
except SystemExit:
    ok(True, "make_adapter: gladia without key raises")
# unknown engine raises
try:
    C.make_adapter({"engine": "nope"}); ok(False, "unknown engine should raise")
except SystemExit:
    ok(True, "make_adapter: unknown engine raises")

# ---- MT stage routing (fake translator; no model download) ----
class FakeMT:
    def translate_cues(self, cues, src, tgt):
        return [C.Cue(c.start, c.end, f"<{tgt}>{c.text}", tgt) for c in cues]

# FLORES has our three target pairs
ok(all(l in C.FLORES for l in ("en", "ms", "zh", "ta")), "FLORES maps en/ms/zh/ta")
# make_translator: English-only target needs no MT model
ok(C.make_translator(["en"], "ms") is None, "make_translator: en-only target -> no MT (Whisper handles it)")
# make_translator: a non-English target builds an NllbTranslator
ok(isinstance(C.make_translator(["ms"], "en"), C.NllbTranslator), "make_translator: ms target -> NllbTranslator")
# make_translator: unmapped language is a clear error
try:
    C.make_translator(["xx"], "en"); ok(False, "unmapped target should raise")
except SystemExit:
    ok(True, "make_translator: unmapped target raises")

# WhisperAdapter routes targets per chunk with PER-CHUNK language detection.
# Stub out the Whisper model so no audio/model is needed. The stub simulates a
# broadcast where the detected language changes chunk to chunk (en <-> ms).
class Info:
    def __init__(self, language, probability=0.95):
        self.language = language
        self.language_probability = probability

class StubWhisper(C.WhisperAdapter):
    detect = Info("en")     # what the next transcribe pass "detects"
    def _model(self):  # no real model
        return object()
    def _run_task(self, model, task, lang, language=None):
        self.last_pinned = language
        if task == "transcribe":
            return [C.Cue(0.0, 1.0, "hello", lang)], self.detect
        return [C.Cue(0.0, 1.0, "HELLO-EN", lang)], self.detect

# pinned English source, non-English targets go through MT
wa = StubWhisper("/dev/null", source_lang="en", translator=FakeMT())
cues = wa.transcribe(["ms", "zh", "ta"])
langs = {c.lang for c in cues}
ok(langs == {"en", "ms", "zh", "ta"}, f"whisper+MT yields en+ms+zh+ta (got {langs})")
ms = [c.text for c in cues if c.lang == "ms"]
ok(ms == ["<ms>hello"], "non-English target routed through MT translator")

# pinned non-English source, English target uses Whisper's translate task (no MT)
wa2 = StubWhisper("/dev/null", source_lang="ms", translator=None)
cues2 = wa2.transcribe(["en"])
ok(any(c.lang == "en" and c.text == "HELLO-EN" for c in cues2), "X->English uses Whisper translate task, no MT needed")

# ---- per-chunk detection: the mid-programme language switch (the broadcast case) ----
wa3 = StubWhisper("/dev/null", source_lang="auto", translator=FakeMT())
# chunk 1: English detected -> target en served by the transcript itself, no translate pass
wa3.detect = Info("en")
c1 = wa3.transcribe(["en"])
ok({c.lang for c in c1} == {"en"} and any(c.text == "hello" for c in c1),
   "auto: English chunk -> en track from transcript, no translation")
# chunk 2: the programme switches to MALAY -> target en must be TRANSLATED, not raw Malay
wa3.detect = Info("ms")
c2 = wa3.transcribe(["en"])
ok(any(c.lang == "en" and c.text == "HELLO-EN" for c in c2),
   "auto: Malay chunk -> en track gets Whisper-translated English")
ok(not any(c.lang == "en" and c.text == "hello" for c in c2),
   "auto: Malay chunk -> raw Malay text never labelled as English")
ok(any(c.lang == "ms" and c.text == "hello" for c in c2),
   "auto: Malay chunk -> source cues labelled with the DETECTED language")
ok(wa3.last_pinned == "ms", "translate pass pinned to the detected language")
# chunk 3: switch back to English -> en served directly again
wa3.detect = Info("en")
c3 = wa3.transcribe(["en"])
ok(any(c.lang == "en" and c.text == "hello" for c in c3), "auto: back to English chunk")

# low-confidence detection is sticky: keep the last confident language
wa4 = StubWhisper("/dev/null", source_lang="auto", translator=None)
wa4.detect = Info("ms", probability=0.9)
wa4.transcribe(["en"])
wa4.detect = Info("ta", probability=0.2)   # shaky guess on a noisy chunk
c5 = wa4.transcribe(["en"])
ok(any(c.lang == "ms" for c in c5), "low-confidence detection falls back to last confident language")

# non-English target from a DETECTED (not configured) language goes through MT
wa5 = StubWhisper("/dev/null", source_lang="auto", translator=FakeMT())
wa5.detect = Info("en")
c6 = wa5.transcribe(["ms"])
ok(any(c.lang == "ms" and c.text == "<ms>hello" for c in c6),
   "auto: English chunk -> ms target via MT from detected en")

print(f"\n{p} passed, {f} failed")
raise SystemExit(1 if f else 0)
