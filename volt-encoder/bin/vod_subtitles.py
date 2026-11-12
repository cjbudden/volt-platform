#!/usr/bin/env python3
"""
Volt: subtitles for a FILE (an uploaded or watch-folder asset), made from its
audio with faster-whisper. The live captions sidecar (captions.py) does the
same for a running stream in rolling windows; this reads the whole programme
once, so whisper sees every sentence whole and needs no window stitching.

    vod_subtitles.py <job.json>

job.json:
    input            the asset's media (a file, or an HLS/MP4 URL ffmpeg reads)
    out_dir          where <lang>.vtt files are written
    spoken           'auto' to detect, or the language spoken ('en')
    targets          more languages to make (['en','fr']): English by whisper's
                     own translate task, others by NLLB when it is installed
    model            whisper size (tiny|base|small|medium|large-v3)
    transcript_only  write transcript.txt only, no caption files (for the AI
                     description of an asset that has no subtitles)
    offline_fixture  a transcript fixture instead of whisper (tests)

Progress goes to stderr as `PROGRESS <pct> <note>`; the last stdout line is
one JSON summary: { ok, language, languages: {lang: {cues, file}}, unmet,
transcript?, error? }.

The cue building, offsets and WebVTT writing are captions.py's, so a file's
subtitles read exactly like a stream's.
"""
from __future__ import annotations
import json
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from captions import (  # noqa: E402
    FLORES, OfflineAdapter, WhisperAdapter, NllbTranslator, final_vtt,
)


def progress(pct: int, note: str = "") -> None:
    print(f"PROGRESS {pct} {note}", file=sys.stderr, flush=True)


def whisper_ready() -> bool:
    try:
        import faster_whisper  # noqa: F401
        return True
    except Exception:
        return False


def mt_ready() -> bool:
    try:
        import transformers  # noqa: F401
        return True
    except Exception:
        return False


def plan_targets(targets: list[str], spoken: str) -> tuple[list[str], list[str]]:
    """Which extra languages can be made here, and which cannot.
    English is whisper's own translate task. Any other language needs NLLB
    installed and a FLORES code for both sides (the spoken side is checked
    after detection)."""
    can, cannot = [], []
    have_mt = mt_ready()
    for t in dict.fromkeys(x.strip() for x in targets if x and x.strip()):
        if t == spoken:
            continue
        if t == "en" or (have_mt and t in FLORES):
            can.append(t)
        else:
            cannot.append(t)
    return can, cannot


def extract_audio(src: str, wav: str, ffmpeg: str) -> None:
    """Mono 16 kHz WAV: what whisper reads, and small enough to keep in /tmp."""
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
           "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", wav]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(wav) or os.path.getsize(wav) < 1024:
        msg = (r.stderr or "").strip().splitlines()[-1:] or ["no audio track"]
        raise RuntimeError(f"the audio could not be read: {msg[0][:300]}")


def transcript_text(cues) -> str:
    return "\n".join(" ".join(c.text.split()) for c in sorted(cues, key=lambda c: c.start) if c.text.strip())


def run(job: dict) -> dict:
    out_dir = job["out_dir"]
    os.makedirs(out_dir, exist_ok=True)
    spoken = (job.get("spoken") or "auto").strip() or "auto"
    only_text = bool(job.get("transcript_only"))
    targets = [] if only_text else list(job.get("targets") or [])
    fixture = job.get("offline_fixture") or os.environ.get("CAPTIONS_FIXTURE")

    if not fixture and not whisper_ready():
        return {"ok": False, "code": "whisper_missing",
                "error": "Whisper (faster-whisper) is not installed for this server's Python, so it cannot make subtitles here."}

    can, cannot = plan_targets(targets, spoken)
    tmp = tempfile.mkdtemp(prefix="volt-subs-")
    try:
        if fixture:
            adapter = OfflineAdapter(fixture)
        else:
            progress(5, "reading the audio")
            wav = os.path.join(tmp, "audio.wav")
            extract_audio(job["input"], wav, job.get("ffmpeg") or os.environ.get("FFMPEG_BIN") or "ffmpeg")
            translator = NllbTranslator() if any(t != "en" for t in can) else None
            adapter = WhisperAdapter(wav, spoken, job.get("model") or None, translator=translator)
        progress(15, "listening")
        cues = adapter.transcribe(can)
        progress(90, "writing the subtitles")

        # The spoken language: what whisper detected (or was told). A fixture
        # names it on its cues; the first language not asked for is the source.
        detected = getattr(adapter, "_last_lang", None) or (spoken if spoken != "auto" else None)
        if not detected:
            langs = [c.lang for c in cues]
            detected = next((l for l in langs if l not in can), langs[0] if langs else "en")

        if only_text:
            text = transcript_text([c for c in cues if c.lang == detected])
            return {"ok": True, "language": detected, "languages": {}, "unmet": [], "transcript": text}

        written = {}
        for lang in dict.fromkeys([detected, *can]):
            mine = [c for c in cues if c.lang == lang]
            if not mine:
                continue
            path = os.path.join(out_dir, f"{lang}.vtt")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(final_vtt(mine))
            written[lang] = {"cues": len(mine), "file": path}
        unmet = cannot + [t for t in can if t not in written and t != detected]
        progress(100, "done")
        return {"ok": True, "language": detected, "languages": written, "unmet": unmet}
    except Exception as e:  # pragma: no cover (reported to the job, which fails with it)
        return {"ok": False, "error": str(e)[:500]}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":  # pragma: no cover
    if len(sys.argv) < 2:
        print("usage: vod_subtitles.py <job.json>", file=sys.stderr)
        sys.exit(2)
    with open(sys.argv[1]) as fh:
        job = json.load(fh)
    if job.get("check"):
        print(json.dumps({"whisper": whisper_ready(), "mt": mt_ready()}))
        sys.exit(0)
    print(json.dumps(run(job)))
