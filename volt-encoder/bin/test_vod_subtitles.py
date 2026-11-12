"""vod_subtitles.py: a file's subtitles from a transcript fixture (no whisper needed).
Run: python3 -m pytest volt-encoder/bin/test_vod_subtitles.py  (or python3 test_vod_subtitles.py)"""
import json
import os
import tempfile

import vod_subtitles as vs


def _fixture(d):
    p = os.path.join(d, "fx.json")
    with open(p, "w") as fh:
        json.dump([
            {"start": 0.5, "end": 2.0, "text": "Welcome to the harbour.", "lang": "en"},
            {"start": 2.5, "end": 4.0, "text": "The lights come on at dusk.", "lang": "en"},
        ], fh)
    return p


def test_writes_the_spoken_language():
    d = tempfile.mkdtemp()
    out = vs.run({"out_dir": d, "offline_fixture": _fixture(d), "spoken": "auto", "targets": []})
    assert out["ok"] and out["language"] == "en"
    assert list(out["languages"]) == ["en"] and out["languages"]["en"]["cues"] == 2
    body = open(out["languages"]["en"]["file"]).read()
    assert body.startswith("WEBVTT") and "00:00:00.500 --> 00:00:02.000" in body and "Welcome to the harbour." in body


def test_english_target_from_another_language_is_planned_others_need_mt():
    can, cannot = vs.plan_targets(["en", "fr", "xx", "en", "de"], "fr")
    assert "en" in can and "fr" not in can and "fr" not in cannot   # the spoken language is not a target
    assert "xx" in cannot and "de" in cannot                          # no FLORES code: never makeable
    if not vs.mt_ready():
        assert cannot == ["xx", "de"]


def test_transcript_only_writes_no_files():
    d = tempfile.mkdtemp()
    out = vs.run({"out_dir": d, "offline_fixture": _fixture(d), "transcript_only": True, "targets": ["en"]})
    assert out["ok"] and out["languages"] == {}
    assert out["transcript"] == "Welcome to the harbour.\nThe lights come on at dusk."
    assert not [f for f in os.listdir(d) if f.endswith(".vtt")]


def test_no_whisper_says_so():
    if vs.whisper_ready():
        return
    out = vs.run({"out_dir": tempfile.mkdtemp(), "input": "/nope.mp4", "targets": []})
    assert out == {"ok": False, "code": "whisper_missing", "error": out["error"]} and "not installed" in out["error"]


if __name__ == "__main__":
    n = 0
    for k, f in list(globals().items()):
        if k.startswith("test_"):
            f(); n += 1; print("PASS", k)
    print(f"{n} passed")
