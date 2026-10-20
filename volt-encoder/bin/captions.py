#!/usr/bin/env python3
"""
Volt Streaming — live captions / transcribe + translate sidecar.

Runs as an encoder child process (like the uploader), gated on captions.enabled
in the job config. It taps the program audio, sends it to a streaming STT +
translation provider (Gladia), and writes segmented WebVTT subtitle renditions
that Shaka/HLS/DASH reference — one per target language — applying the configured
playout OFFSET so subtitles line up with the delayed A/V, and a final
consolidated VTT when the event ends.

The transformation logic (offset, segmentation into HLS-aligned WebVTT segments,
final VTT) is pure and unit-tested (test_captions.py). The provider call sits
behind a small adapter seam and one of three engines is chosen per job:
  • offline  — OfflineAdapter reads a transcript fixture (tests / local dry-run)
  • whisper  — WhisperAdapter, self-hosted faster-whisper (no key, no per-min cost;
               transcribes ~100 langs, native X->English translation; other target
               languages need a downstream MT model)
  • gladia   — GladiaAdapter, paid streaming STT + native multi-target MT (needs
               GLADIA_API_KEY + network)
The account picks whether captions are enabled at all and which provider to use
(accounts.captions_provider = none|whisper|gladia); the per-profile engine falls
back to that account default.
"""
from __future__ import annotations
import json
import os
import sys
from dataclasses import dataclass
from typing import Iterable


@dataclass
class Cue:
    start: float          # seconds (program time)
    end: float
    text: str
    lang: str = "en"


def fmt_ts(seconds: float) -> str:
    """Seconds -> WebVTT timestamp HH:MM:SS.mmm (clamped at 0)."""
    if seconds < 0:
        seconds = 0.0
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def apply_offset(cues: Iterable[Cue], offset_sec: float) -> list[Cue]:
    """Shift every cue by the playout offset (positive = later)."""
    return [Cue(c.start + offset_sec, c.end + offset_sec, c.text, c.lang) for c in cues]


def cue_block(c: Cue) -> str:
    return f"{fmt_ts(c.start)} --> {fmt_ts(c.end)}\n{c.text}"


def final_vtt(cues: list[Cue]) -> str:
    """One consolidated WebVTT for the whole asset (VOD subtitle track)."""
    body = "\n\n".join(cue_block(c) for c in sorted(cues, key=lambda c: c.start))
    return "WEBVTT\n\n" + body + ("\n" if body else "")


def segment_vtt(cues: list[Cue], seg_seconds: float, total_seconds: float) -> list[str]:
    """
    Split into HLS-aligned WebVTT SEGMENTS. Segment i covers
    [i*seg, (i+1)*seg); a cue is emitted in every segment its span overlaps
    (players de-dup on identical cue identity), with absolute timestamps and an
    X-TIMESTAMP-MAP so the subtitle timeline matches the media timeline.
    """
    n = max(1, int((total_seconds + seg_seconds - 1e-9) // seg_seconds))
    out: list[str] = []
    for i in range(n):
        lo, hi = i * seg_seconds, (i + 1) * seg_seconds
        inside = [c for c in cues if c.end > lo and c.start < hi]
        header = "WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n"
        body = "\n\n".join(cue_block(c) for c in sorted(inside, key=lambda c: c.start))
        out.append(header + ("\n" + body + "\n" if body else "\n"))
    return out


def media_playlist(n_segments: int, seg_seconds: float, seg_name=lambda i: f"sub_{i}.vtt") -> str:
    lines = ["#EXTM3U", "#EXT-X-VERSION:7", f"#EXT-X-TARGETDURATION:{int(round(seg_seconds))}",
             "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD"]
    for i in range(n_segments):
        lines.append(f"#EXTINF:{seg_seconds:.3f},")
        lines.append(seg_name(i))
    lines.append("#EXT-X-ENDLIST")
    return "\n".join(lines) + "\n"


# ---- machine translation (MT) stage ----------------------------------------
# Whisper transcribes ~100 langs and natively translates X->English only. For any
# OTHER target language (Malay, Chinese, Tamil, ...) we run a downstream MT model.
# NLLB-200 is many-to-many across 200 languages, so ONE model covers every pair we
# need (en<->ms, en<->zh, en<->ta — and ms<->zh, ms<->ta, zh<->ta for free). We map
# our short lang codes to NLLB's FLORES-200 codes.
FLORES = {
    "en": "eng_Latn", "ms": "zsm_Latn",
    "zh": "zho_Hans", "zh-Hans": "zho_Hans", "zh-Hant": "zho_Hant",
    "ta": "tam_Taml", "id": "ind_Latn", "hi": "hin_Deva",
    "es": "spa_Latn", "fr": "fra_Latn", "ar": "arb_Arab",
}


class NllbTranslator:
    """Downstream MT via NLLB-200 (CTranslate2/transformers). Lazy heavy import."""

    def __init__(self, model_name: str | None = None):
        self.model_name = model_name or os.environ.get("NLLB_MODEL", "facebook/nllb-200-distilled-600M")
        self._tok = None
        self._model = None

    def _load(self):
        if self._model is None:  # pragma: no cover (heavy; proven in an integration run)
            from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
            self._tok = AutoTokenizer.from_pretrained(self.model_name)
            self._model = AutoModelForSeq2SeqLM.from_pretrained(self.model_name)

    def translate_texts(self, texts: list[str], src: str, tgt: str) -> list[str]:  # pragma: no cover
        """BATCHED translation: one tokenizer + one generate call for ALL cues of a chunk.
        Per-cue generate calls were the live-captions killer: 3-4 cues x 2 target
        languages = up to 8 sequential CPU generations per 8s chunk, blowing the
        realtime budget and building an ever-growing backlog. Greedy decode
        (num_beams=1) and a tight max_length keep the batch fast; subtitle cues are
        short so quality loss is negligible."""
        if not texts:
            return []
        self._load()
        self._tok.src_lang = FLORES[src]
        enc = self._tok(texts, return_tensors="pt", padding=True, truncation=True, max_length=160)
        out = self._model.generate(
            **enc, forced_bos_token_id=self._tok.convert_tokens_to_ids(FLORES[tgt]),
            max_length=160, num_beams=1,
        )
        return self._tok.batch_decode(out, skip_special_tokens=True)

    def translate_text(self, text: str, src: str, tgt: str) -> str:  # pragma: no cover
        return self.translate_texts([text], src, tgt)[0]

    def translate_cues(self, cues: list[Cue], src: str, tgt: str) -> list[Cue]:
        outs = self.translate_texts([c.text for c in cues], src, tgt)
        return [Cue(c.start, c.end, t, tgt) for c, t in zip(cues, outs)]


def make_translator(targets: list[str], src_lang: str):
    """
    Return an MT translator iff a non-English target is requested AND every
    language in play has a FLORES mapping; otherwise None (English-only targets
    are handled by Whisper's own translate task, no MT model needed).
    """
    need_mt = [t for t in targets if t != "en" and t != src_lang]
    if not need_mt:
        return None
    unknown = [l for l in {src_lang, *need_mt} if l not in FLORES]
    if unknown:
        raise SystemExit(f"captions: no NLLB/FLORES mapping for {unknown} — add it to FLORES")
    return NllbTranslator()


# ---- provider adapters ------------------------------------------------------
class OfflineAdapter:
    """Reads a transcript fixture: [{start,end,text,lang}]. Used by tests / local."""

    def __init__(self, fixture_path: str):
        self.fixture_path = fixture_path

    def transcribe(self, targets: list[str]) -> list[Cue]:
        with open(self.fixture_path) as fh:
            raw = json.load(fh)
        cues = [Cue(float(r["start"]), float(r["end"]), r["text"], r.get("lang", "en")) for r in raw]
        # "translation": for any requested target != source, echo with a tag so the
        # segmentation/多-language plumbing is exercised without a real MT call.
        srcs = {c.lang for c in cues}
        for t in targets:
            if t not in srcs:
                cues += [Cue(c.start, c.end, f"[{t}] {c.text}", t) for c in cues if c.lang in srcs]
        return cues


class GladiaAdapter:
    """Gladia live (v2) streaming STT + translation, behind the same interface as
    WhisperAdapter: the encoder points `audio_path` at each caption window's WAV
    (16 kHz mono s16, from the delivered audio) and sets `split_at` to where the
    window starts inside it; `transcribe()` returns Cues timed against that WAV.

    One live SESSION serves every window of a run, so Gladia keeps its own
    context across window boundaries (it is a streaming recogniser, unlike
    Whisper, so only each window's NEW audio is sent, never the preroll):

      POST {GLADIA_API_URL}/v2/live  (X-Gladia-Key)  -> {id, url}
      websocket url: binary PCM in, JSON out:
        {"type": "transcript",  "data": {"is_final": true, "utterance": {start, end, text, language, words}}}
        {"type": "translation", "data": {"target_language", "translated_utterance": {start, end, text}}}
      {"type": "stop_recording"} to end.

    Utterance times are seconds since the session's first audio byte, so each
    window maps them onto its WAV with the stream time at which its audio began.
    Each window waits up to GLADIA_WINDOW_WAIT_SEC for the final that reaches
    the end of what it sent. A final that still arrives late is returned with
    the next window, timed correctly, so the encoder keeps it only if it falls
    in a window it has not published yet (a live segment cannot be re-cut). A
    dropped socket ends the session; the next window opens a new one.

    Needs GLADIA_API_KEY. Tests point GLADIA_API_URL at a local stand-in.
    """

    CHUNK_BYTES = 3200  # 100 ms of 16 kHz mono s16

    def __init__(self, api_key: str, source_lang: str = "auto", targets=None,
                 base_url: str | None = None, wait_s: float | None = None):
        self.api_key = api_key
        self.source_lang = source_lang
        self.targets = list(targets or [])
        self.base_url = (base_url or os.environ.get("GLADIA_API_URL") or "https://api.gladia.io").rstrip("/")
        self.wait_s = float(wait_s if wait_s is not None else os.environ.get("GLADIA_WINDOW_WAIT_SEC", "4"))
        self.audio_path = ""
        self.split_at = None
        self.ws = None
        self.session_id = None
        self.sent_s = 0.0          # stream seconds sent in this session
        self.sample_rate = 16000
        self._held = []            # (stream_start, stream_end, text, lang) not yet returned
        self.sessions_opened = 0

    # ---- session -----------------------------------------------------------------
    def _init_body(self, targets):
        body = {
            "encoding": "wav/pcm", "sample_rate": self.sample_rate, "bit_depth": 16, "channels": 1,
            "messages_config": {"receive_partial_transcripts": False, "receive_final_transcripts": True},
        }
        if self.source_lang and self.source_lang != "auto":
            body["language_config"] = {"languages": [self.source_lang], "code_switching": False}
        others = [t for t in targets if t != self.source_lang]
        if others:
            body["realtime_processing"] = {"translation": True, "translation_config": {"target_languages": others}}
        return body

    def _open(self, targets):
        import urllib.request
        from ws_client import WebSocket
        req = urllib.request.Request(f"{self.base_url}/v2/live", data=json.dumps(self._init_body(targets)).encode(),
                                     method="POST", headers={"Content-Type": "application/json", "X-Gladia-Key": self.api_key})
        with urllib.request.urlopen(req, timeout=15) as r:
            info = json.loads(r.read())
        self.ws = WebSocket(info["url"])
        self.session_id = info.get("id")
        self.sent_s = 0.0
        self._held = []
        self.sessions_opened += 1

    def close(self):
        if self.ws is not None:
            try:
                self.ws.send_text(json.dumps({"type": "stop_recording"}))
            except OSError:
                pass
            self.ws.close()
        self.ws = None

    # ---- one window ----------------------------------------------------------------
    def _read_window_pcm(self):
        import wave
        with wave.open(self.audio_path, "rb") as w:
            if w.getnchannels() != 1 or w.getsampwidth() != 2:
                raise ValueError("captions[gladia]: window audio must be mono 16-bit PCM")
            self.sample_rate = w.getframerate()
            start = int(round((self.split_at or 0.0) * self.sample_rate))
            w.setpos(min(start, w.getnframes()))
            return w.readframes(w.getnframes() - min(start, w.getnframes()))

    def _take(self, msg, base_lang):
        """A final transcript or translation as (stream_start, stream_end, text, lang)."""
        t, data = msg.get("type"), msg.get("data") or {}
        if t == "transcript" and data.get("is_final", True):
            u = data.get("utterance") or {}
            if (u.get("text") or "").strip():
                return (float(u["start"]), float(u["end"]), u["text"].strip(), u.get("language") or base_lang)
        if t == "translation":
            u = data.get("translated_utterance") or {}
            if (u.get("text") or "").strip():
                return (float(u["start"]), float(u["end"]), u["text"].strip(), data.get("target_language") or u.get("language"))
        if t == "error":
            raise RuntimeError(f"gladia: {data.get('message') or msg}")
        return None

    def transcribe(self, targets: list[str]) -> list[Cue]:
        import socket
        import time as _t
        from ws_client import WebSocketClosed
        targets = list(targets or self.targets)
        if self.ws is None:
            self._open(targets)
        pcm = self._read_window_pcm()
        win_stream_start = self.sent_s
        base_lang = self.source_lang if self.source_lang and self.source_lang != "auto" else "en"
        try:
            for i in range(0, len(pcm), self.CHUNK_BYTES):
                self.ws.send_binary(pcm[i:i + self.CHUNK_BYTES])
            self.sent_s += len(pcm) / 2 / self.sample_rate
            # Collect finals until one reaches the end of what was sent (the window
            # is complete) or the wait runs out (what is still pending is held).
            deadline = _t.time() + self.wait_s
            while _t.time() < deadline:
                self.ws.settimeout(max(0.05, deadline - _t.time()))
                try:
                    _op, raw = self.ws.recv()
                except socket.timeout:
                    break
                got = self._take(json.loads(raw), base_lang)
                if got:
                    self._held.append(got)
                    if got[3] == base_lang and got[1] >= self.sent_s - 0.3:
                        # the source has caught up; give translations a moment, then stop
                        deadline = min(deadline, _t.time() + 0.3)
        except (WebSocketClosed, OSError) as e:
            self.close()
            raise RuntimeError(f"gladia session ended: {e}") from e
        # stream time -> this WAV: the window's audio began at win_stream_start,
        # which is split_at seconds into the WAV.
        shift = (self.split_at or 0.0) - win_stream_start
        out = [Cue(s + shift, e + shift, wrap_cue_text(text), lang) for s, e, text, lang in self._held]
        self._held = []
        return out


# ---- cue shaping -----------------------------------------------------------
# Whisper's own segment boundaries are not subtitle boundaries. Left alone it emits
# both blink-length fragments and 20 second run-ons, and its per-segment start/end
# times are coarse. Word-level timestamps let us cut cues where a reader would and
# time each one to the word that opens it, which is most of the difference between
# "roughly in the right place" and "on the syllable".
MAX_CUE_CHARS = int(os.environ.get("CUE_MAX_CHARS", "84"))    # ~2 lines of 42
MAX_CUE_SEC = float(os.environ.get("CUE_MAX_SEC", "6.0"))
MIN_SPLIT_CHARS = int(os.environ.get("CUE_MIN_SPLIT_CHARS", "24"))
WORD_GAP_SEC = float(os.environ.get("CUE_WORD_GAP_SEC", "0.8"))
_SENTENCE_END = (".", "!", "?", "。", "！", "？")


def wrap_cue_text(text, width=42):
    """At most two lines, broken on a word boundary."""
    text = " ".join(text.split())
    if len(text) <= width:
        return text
    lines, cur = [], ""
    for w in text.split():
        if cur and len(cur) + 1 + len(w) > width and len(lines) < 1:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    lines.append(cur)
    return "\n".join(lines[:2])


def cues_from_words(words, lang, split_at=None):
    """Build readable, word-accurate cues from [(start, end, text)].

    A cue closes when any of these is true: it has reached a readable length, it has
    been on screen long enough, the speaker paused, or a sentence ended and the cue is
    already long enough to stand on its own.

    `split_at` forces an extra cut at a caption WINDOW boundary. Live windows are
    transcribed with a few seconds of the previous window as context (whisper is far
    more accurate when a sentence does not begin at a hard cut), and everything before
    the boundary was already published by the previous window. Without a forced cut, a
    sentence straddling the boundary comes back as ONE cue starting in the context
    region, gets discarded as already-seen, and the half of the sentence that belonged
    to this window is silently lost. Splitting keeps both halves, each timed to its own
    words."""
    cues, buf = [], []

    def flush():
        if buf:
            cues.append(Cue(buf[0][0], buf[-1][1],
                            wrap_cue_text(" ".join(t for _s, _e, t in buf)), lang))
            buf.clear()

    for start, end, text in words:
        text = (text or "").strip()
        if not text:
            continue
        if buf:
            cur_len = sum(len(t) + 1 for _s, _e, t in buf)
            close = (
                cur_len + len(text) > MAX_CUE_CHARS
                or end - buf[0][0] > MAX_CUE_SEC
                or start - buf[-1][1] > WORD_GAP_SEC
                or (buf[-1][2].endswith(_SENTENCE_END) and cur_len >= MIN_SPLIT_CHARS)
                or (split_at is not None and buf[0][0] < split_at <= start)
            )
            if close:
                flush()
        buf.append((start, end, text))
    flush()
    return cues


def default_model(source_lang):
    """Model to use when the job does not pin one.

    `tiny` was the old default and it is a large part of why the text so often did not
    match what was said. `base` is the smallest model that is honestly usable for
    broadcast subtitles and is still comfortably realtime on CPU; the English-only
    weights are noticeably more accurate than the multilingual ones at the same size,
    so a channel pinned to English gets them automatically."""
    env = os.environ.get("WHISPER_MODEL")
    if env:
        return env
    return "base.en" if (source_lang or "").lower().startswith("en") else "base"


class WhisperAdapter:
    """
    Self-hosted STT via faster-whisper (CTranslate2). No API key, no per-minute
    cost — runs on the encoder box (GPU if available, else CPU). Transcribes the
    program audio into Cue segments in the source language.

    Translation nuance (documented so callers don't expect more than Whisper gives):
      • Whisper transcribes ~100 languages.
      • Whisper's own `translate` task ONLY goes X -> English. So a target of
        'en' from a non-English source is done natively here.
      • Any OTHER target language needs a downstream MT model (NLLB / M2M-100);
        we mark those targets as unmet so the caller can fan them out to an MT
        step (or fall back to Gladia, which does streaming MT natively).

    Not natively streaming: faster-whisper transcribes a finite audio input. For
    live it is driven over rolling N-second chunks by the encoder wrapper; here we
    transcribe whatever audio_path points at (a chunk, or the whole event for VOD).
    """

    def __init__(self, audio_path: str, source_lang: str = "auto",
                 model_size: str | None = None, translator=None):
        self.audio_path = audio_path
        self.source_lang = source_lang
        self.model_size = model_size or default_model(source_lang)
        # live only: seconds into audio_path where the CONTEXT ends and the window this
        # call is meant to publish begins. Forces a cue cut there so a sentence crossing
        # the boundary is not lost with the context it started in. None = no boundary.
        self.split_at = None
        # optional downstream MT stage for non-English targets (NLLB). Injectable
        # so tests can pass a fake and avoid loading the real model.
        self.translator = translator

    def _model(self):
        # Load ONCE and reuse. In live mode transcribe() is called per audio chunk;
        # constructing a fresh WhisperModel each time would reload weights from disk
        # every chunk and blow the real-time budget. Memoize on the instance so a
        # reused adapter keeps one warm model.
        m = getattr(self, "_m", None)
        if m is not None:
            return m
        from faster_whisper import WhisperModel  # lazy: heavy import
        device = os.environ.get("WHISPER_DEVICE", "cpu")
        compute = os.environ.get("WHISPER_COMPUTE", "int8")
        self._m = WhisperModel(self.model_size, device=device, compute_type=compute)
        return self._m

    def _run_task(self, model, task: str, lang: str, language: str | None = None):
        """Run one whisper pass. Returns (cues labelled `lang`, whisper info).
        `language` pins the decode language; None lets whisper DETECT it (info.language).

        The decode options here are the difference between a transcript and a
        hallucination, and each one earns its place:

        * vad_filter — whisper was trained on speech and will confidently invent
          sentences over music, room tone or silence. Voice-activity gating is the
          single biggest accuracy win on a live feed, where a large share of any given
          window is not speech.
        * condition_on_previous_text=False — with it on, one bad window poisons the
          next and whisper falls into repeating the same line forever. Windows here are
          independent by design, so the feature has nothing to offer and a well known
          failure mode to contribute.
        * the three thresholds — drop a window whose decode was improbable
          (log_prob), whose output looks like a loop (compression_ratio) or which the
          model itself thinks was silence (no_speech).
        * word_timestamps — cues are then cut and timed from the words themselves
          rather than from whisper's coarse segment boundaries.
        * beam_size — 1 is greedy and fast; live can afford a little more when the
          box has headroom, so it is configurable rather than hard-coded."""
        kw = {
            "task": task,
            "beam_size": int(os.environ.get("WHISPER_BEAM", "2")),
            "condition_on_previous_text": False,
            "vad_filter": os.environ.get("WHISPER_VAD", "1") != "0",
            "vad_parameters": {"min_silence_duration_ms": 400},
            "no_speech_threshold": float(os.environ.get("WHISPER_NO_SPEECH", "0.6")),
            "log_prob_threshold": float(os.environ.get("WHISPER_LOGPROB", "-1.0")),
            "compression_ratio_threshold": float(os.environ.get("WHISPER_COMPRESSION", "2.4")),
            "word_timestamps": os.environ.get("WHISPER_WORD_TS", "1") != "0",
        }
        if language:
            kw["language"] = language
        try:
            segments, info = model.transcribe(self.audio_path, **kw)
        except TypeError:
            # a stub or an older faster-whisper that does not take the tuning options
            segments, info = model.transcribe(self.audio_path, task=task, beam_size=1,
                                              **({"language": language} if language else {}))
        segs = list(segments)
        words = []
        for s in segs:
            for w in (getattr(s, "words", None) or []):
                if (w.word or "").strip():
                    words.append((float(w.start), float(w.end), w.word.strip()))
        if words:
            return cues_from_words(words, lang, split_at=self.split_at), info
        # no word timing available (stub, or word_timestamps off): fall back to
        # whisper's own segments rather than producing nothing
        return ([Cue(float(s.start), float(s.end), s.text.strip(), lang)
                 for s in segs if s.text.strip()], info)

    def transcribe(self, targets: list[str]) -> list[Cue]:
        """Per-chunk transcript + translations, with PER-CHUNK language detection.

        Broadcast reality (the reason this exists): the spoken language changes from
        programme to programme and even inside one programme (English anchor, Malay
        interview, back to English). So the SOURCE language is re-detected on every
        chunk unless the channel pins one, and the requested OUTPUT languages are
        always delivered:
          * target == detected      -> the transcript itself serves that track
          * target 'en', detected X -> Whisper's native X->English translate task
          * any other target        -> NLLB MT from the DETECTED language
        Detection on a short chunk can be shaky, so a low-confidence detection
        (probability < 0.5) falls back to the last confidently detected language
        (sticky), which also stops one noisy chunk from flapping the routing."""
        model = self._model()
        pinned = self.source_lang if self.source_lang and self.source_lang != "auto" else None
        src_cues, info = self._run_task(model, "transcribe", "src", language=pinned)
        if pinned:
            detected = pinned
        else:
            lang = getattr(info, "language", None)
            prob = getattr(info, "language_probability", None)
            if lang and (prob is None or prob >= 0.5):
                detected = lang
            else:
                detected = getattr(self, "_last_lang", None) or lang or "en"
        self._last_lang = detected
        src_cues = [Cue(c.start, c.end, c.text, detected) for c in src_cues]
        cues: list[Cue] = list(src_cues)
        unmet = []
        for t in targets:
            if t == detected:
                continue
            if t == "en":
                # native X->English; pin the decode language to what we detected so the
                # translate pass does not have to re-guess
                en_cues, _ = self._run_task(model, "translate", "en", language=detected)
                cues += en_cues
            elif self.translator is not None and detected in FLORES and t in FLORES:
                cues += self.translator.translate_cues(src_cues, detected, t)
            else:
                unmet.append(t)
        if unmet:
            # a target could not be produced for THIS chunk: either no MT model was
            # wired, or the detected language has no FLORES mapping yet
            print(f"captions[whisper]: chunk in '{detected}' could not serve targets {unmet}"
                  f" (add an MT model / FLORES mapping)", file=sys.stderr)
        return cues


def make_adapter(cfg: dict):
    # explicit offline fixture always wins (tests / local dry-runs)
    fixture = cfg.get("offline_fixture") or os.environ.get("CAPTIONS_FIXTURE")
    if fixture:
        return OfflineAdapter(fixture)
    engine = (cfg.get("engine") or os.environ.get("CAPTIONS_ENGINE") or "gladia").lower()
    if engine == "whisper":
        audio = cfg.get("audio_path") or os.environ.get("CAPTIONS_AUDIO")
        if not audio:
            raise SystemExit("captions[whisper]: no audio_path/CAPTIONS_AUDIO to transcribe")
        src = cfg.get("source_lang", "auto")
        # resolve 'auto' to English for MT-need detection (real source is detected
        # at transcribe time; MT wiring only matters for non-English targets)
        src_for_mt = src if src and src != "auto" else "en"
        translator = make_translator(cfg.get("targets", []), src_for_mt)
        return WhisperAdapter(audio, src, cfg.get("model_size"), translator=translator)
    if engine == "gladia":
        key = os.environ.get("GLADIA_API_KEY")
        if key:
            a = GladiaAdapter(key, cfg.get("source_lang", "auto"), cfg.get("targets", []))
            if cfg.get("audio_path"):
                a.audio_path = cfg["audio_path"]
            return a
        raise SystemExit("captions[gladia]: no GLADIA_API_KEY and no offline_fixture — nothing to do")
    raise SystemExit(f"captions: unknown engine '{engine}' (want whisper|gladia|offline)")


def run(cfg: dict, out_dir: str) -> dict:
    """
    Produce per-language segmented WebVTT + a final VTT. cfg keys:
      enabled, source_lang, targets[], offset_sec, segment_seconds, total_seconds,
      offline_fixture?
    Returns a manifest of what was written.
    """
    if not cfg.get("enabled"):
        return {"enabled": False}
    targets = cfg.get("targets", [])
    langs = sorted({cfg.get("source_lang", "en"), *targets})
    seg = float(cfg.get("segment_seconds", 6))
    total = float(cfg.get("total_seconds", seg))
    offset = float(cfg.get("offset_sec", 0))
    adapter = make_adapter(cfg)
    all_cues = apply_offset(adapter.transcribe(targets), offset)

    os.makedirs(out_dir, exist_ok=True)
    written = {}
    for lang in langs:
        cues = [c for c in all_cues if c.lang == lang]
        ld = os.path.join(out_dir, lang)
        os.makedirs(ld, exist_ok=True)
        segs = segment_vtt(cues, seg, total)
        for i, body in enumerate(segs):
            with open(os.path.join(ld, f"sub_{i}.vtt"), "w") as fh:
                fh.write(body)
        with open(os.path.join(ld, "subs.m3u8"), "w") as fh:
            fh.write(media_playlist(len(segs), seg))
        with open(os.path.join(ld, "final.vtt"), "w") as fh:
            fh.write(final_vtt(cues))
        written[lang] = {"segments": len(segs), "cues": len(cues)}
    return {"enabled": True, "offset_sec": offset, "languages": written}


if __name__ == "__main__":  # pragma: no cover
    raw = os.environ.get("CAPTIONS_CONFIG_JSON")
    if not raw and len(sys.argv) > 1:
        with open(sys.argv[1]) as fh:
            raw = fh.read()
    if not raw:
        print("usage: captions.py <config.json>  (or CAPTIONS_CONFIG_JSON=...)", file=sys.stderr)
        sys.exit(2)
    cfg = json.loads(raw)
    print(json.dumps(run(cfg, os.environ.get("WORK_DIR", "/work") + "/subtitles")))
