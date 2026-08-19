#!/usr/bin/env python3
"""
syncheck — measure, in seconds, how far a run's subtitles are from the words in
the audio that run actually delivered.

There is no guesswork and no external reference: the yardstick is the run's OWN
packaged audio. Every CMAF audio segment carries a tfdt (baseMediaDecodeTime),
which is the exact media-timeline PTS its content starts at. So we can decode
the delivered audio to one wav whose t=0 is a known PTS, transcribe it OFFLINE
at high quality with word timestamps, and get "these words are at these media
times" as ground truth for that exact stream.

Then each live cue we wrote is matched to those words by text and the difference
in time is the SYNC ERROR. Positive = our cue is LATE (shown after the words are
spoken). Negative = EARLY.

Two more numbers come out of the same pass:
  * coverage  — how much of the spoken time we actually put a cue on screen for
  * accuracy  — word error rate of our live text against the source's own
                subtitle track (truth.jsonl), which is what "do the subs match
                the source" means

Usage: syncheck.py <run_dir> [--model medium.en] [--lang en]
"""
from __future__ import annotations
import glob
import json
import os
import re
import subprocess
import sys
import tempfile

# --- CMAF box readers (same logic the encoder uses, kept standalone on purpose:
# the checker must not import the thing it is checking) ----------------------


def mp4_timescale(init_path):
    data = open(init_path, "rb").read(65536)
    i = data.find(b"mdhd")
    if i < 0:
        return None
    ver = data[i + 4]
    off = i + 8 + (16 if ver == 1 else 8)
    return int.from_bytes(data[off:off + 4], "big") or None


def mp4_tfdt(seg_path):
    data = open(seg_path, "rb").read(65536)
    i = data.find(b"tfdt")
    if i < 0:
        return None
    ver = data[i + 4]
    n = 8 if ver == 1 else 4
    return int.from_bytes(data[i + 8:i + 8 + n], "big")


def seg_number(path):
    mo = re.search(r"seg_(\d+)\.m4s$", path)
    return int(mo.group(1)) if mo else -1


# --- WebVTT / playlist parsing ----------------------------------------------

def ts_to_sec(t):
    mo = re.match(r"(?:(\d+):)?(\d+):(\d+)[.,](\d+)", t.strip())
    h = int(mo.group(1) or 0)
    return h * 3600 + int(mo.group(2)) * 60 + int(mo.group(3)) + int(mo.group(4)) / 1000.0


def parse_vtt(text):
    """-> (mpegts_or_None, [ {start,end,text} ] ) with times relative to the file."""
    mpegts = None
    mo = re.search(r"X-TIMESTAMP-MAP\s*=\s*MPEGTS:(\d+)", text)
    if mo:
        mpegts = int(mo.group(1))
    cues, cur = [], None
    for line in text.splitlines():
        if "-->" in line:
            a, b = line.split("-->")
            cur = {"start": ts_to_sec(a), "end": ts_to_sec(b.split()[0]), "text": []}
        elif cur is not None:
            if not line.strip():
                if cur["text"]:
                    cues.append({"start": cur["start"], "end": cur["end"],
                                 "text": " ".join(cur["text"]).strip()})
                cur = None
            else:
                cur["text"].append(line.strip())
    if cur and cur["text"]:
        cues.append({"start": cur["start"], "end": cur["end"], "text": " ".join(cur["text"]).strip()})
    return mpegts, cues


def parse_playlist(path):
    """-> [ {uri, dur, pdt} ] for any HLS media playlist."""
    out, pdt, dur = [], None, None
    if not os.path.exists(path):
        return out
    for line in open(path):
        line = line.strip()
        if line.startswith("#EXT-X-PROGRAM-DATE-TIME:"):
            pdt = line.split(":", 1)[1]
        elif line.startswith("#EXTINF:"):
            dur = float(line[8:].split(",")[0])
        elif line and not line.startswith("#"):
            out.append({"uri": line, "dur": dur, "pdt": pdt})
            pdt, dur = None, None
    return out


# --- text matching -----------------------------------------------------------

WORD_RE = re.compile(r"[a-z0-9']+")


def norm_words(s):
    return WORD_RE.findall(s.lower().replace("’", "'"))


def wer(ref_words, hyp_words):
    """Levenshtein at word level, normalised by reference length (banded for speed)."""
    n, m = len(ref_words), len(hyp_words)
    if n == 0:
        return None
    prev = list(range(m + 1))
    for i in range(1, n + 1):
        cur = [i] + [0] * m
        ri = ref_words[i - 1]
        for j in range(1, m + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ri != hyp_words[j - 1]))
        prev = cur
    return prev[m] / n


# --- the checks --------------------------------------------------------------

def collect_our_cues(run_out, lang="en"):
    """Every cue we published, with its ABSOLUTE media PTS (the position on the
    delivered timeline where the player will show it)."""
    subs_dir = os.path.join(run_out, "subtitles", lang)
    rows = []
    for path in sorted(glob.glob(os.path.join(subs_dir, "sub_*.vtt")),
                       key=lambda p: int(re.search(r"sub_(\d+)", p).group(1))):
        idx = int(re.search(r"sub_(\d+)", path).group(1))
        mpegts, cues = parse_vtt(open(path).read())
        for c in cues:
            rows.append({
                "chunk": idx,
                "mpegts": mpegts,
                # no timestamp map => the player cannot place this cue on the media
                # timeline at all; recorded as unplaceable rather than guessed
                "pts": (mpegts / 90000.0 + c["start"]) if mpegts is not None else None,
                "end_pts": (mpegts / 90000.0 + c["end"]) if mpegts is not None else None,
                "text": c["text"],
            })
    return rows


def decode_delivered_audio(run_out, wav_path):
    """Decode the run's delivered audio to one 16k mono wav, and return a map from a
    position in that wav back to the media PTS it came from.

    Why a map and not a single offset: a delivered segment does not always contain as
    much audio as its own timeline claims. If the ingest lost part of a source segment,
    the packaged segment still advertises (say) 4.0s via its tfdt but holds 3.2s of
    samples. Concatenating and assuming continuity then makes every later word appear
    EARLIER than it really is, by the running total of everything lost, and a checker
    built that way reports a growing sync error that is entirely its own invention. So
    each segment is decoded on its own, its real duration measured, and the wav position
    is mapped back through the actual breakpoints.

    Returns (breakpoints, stats) where breakpoints is [(wav_pos, media_pts)] and stats
    reports how much audio is missing, which is a defect worth seeing in its own right."""
    adir = os.path.join(run_out, "audio")
    init_path = os.path.join(adir, "init.mp4")
    segs = sorted(glob.glob(os.path.join(adir, "seg_*.m4s")), key=seg_number)
    if not os.path.exists(init_path) or not segs:
        return None
    ts = mp4_timescale(init_path)
    if not ts:
        return None
    init = open(init_path, "rb").read()
    tmp_mp4 = wav_path + ".seg.mp4"
    tmp_raw = wav_path + ".seg.raw"
    breakpoints, pos, short = [], 0.0, 0.0
    with open(wav_path + ".raw", "wb") as combined:
        for i, s in enumerate(segs):
            pts = mp4_tfdt(s)
            if pts is None:
                continue
            pts = pts / ts
            with open(tmp_mp4, "wb") as fh:
                fh.write(init)
                fh.write(open(s, "rb").read())
            r = subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", tmp_mp4, "-vn",
                                "-ac", "1", "-ar", "16000", "-f", "s16le", tmp_raw],
                               capture_output=True)
            if r.returncode != 0 or not os.path.exists(tmp_raw):
                continue
            n = os.path.getsize(tmp_raw)
            dur = n / (16000 * 2)
            nominal = None
            if i + 1 < len(segs):
                nxt = mp4_tfdt(segs[i + 1])
                if nxt is not None:
                    nominal = nxt / ts - pts
            if nominal:
                short += max(0.0, nominal - dur)
            breakpoints.append((pos, pts))
            combined.write(open(tmp_raw, "rb").read())
            pos += dur
    for p in (tmp_mp4, tmp_raw):
        if os.path.exists(p):
            os.remove(p)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "s16le", "-ar", "16000", "-ac", "1",
                    "-i", wav_path + ".raw", wav_path], check=True)
    os.remove(wav_path + ".raw")
    if not breakpoints:
        return None
    span = breakpoints[-1][1] - breakpoints[0][1]
    stats = {"segments": len(breakpoints), "decoded_sec": round(pos, 2),
             "timeline_sec": round(span, 2), "missing_audio_sec": round(short, 2),
             "missing_pct": round(100.0 * short / span, 2) if span else None}
    return breakpoints, stats


def pts_at(breakpoints, wav_pos):
    """Map a position in the decoded wav back to its media PTS."""
    lo, hi = 0, len(breakpoints) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if breakpoints[mid][0] <= wav_pos:
            lo = mid
        else:
            hi = mid - 1
    base_pos, base_pts = breakpoints[lo]
    return base_pts + (wav_pos - base_pos)


def reference_words(wav_path, breakpoints, model="medium.en", lang="en"):
    """Offline, high-quality, word-level transcript of the delivered audio, with every
    word placed back on the media timeline through the breakpoint map.
    Slow on purpose: this is the yardstick, not the product."""
    from faster_whisper import WhisperModel
    m = WhisperModel(model, device="cpu", compute_type="int8", cpu_threads=os.cpu_count() or 2)
    segments, _ = m.transcribe(wav_path, language=lang, beam_size=5, word_timestamps=True,
                               vad_filter=True, condition_on_previous_text=False)
    words = []
    for s in segments:
        for w in (s.words or []):
            t = w.word.strip()
            if t:
                words.append({"t": pts_at(breakpoints, w.start),
                              "end": pts_at(breakpoints, w.end), "w": t})
    return words


def match_cue(cue_words, ref, start_hint, window=90.0):
    """Find where a cue's words sit in the reference, searching a window around the
    cue's own claimed position first and then the whole reference. Returns the
    reference time of the cue's FIRST word, or None if it cannot be located."""
    if not cue_words:
        return None
    n = len(cue_words)
    best, best_score = None, 0.0
    lo, hi = 0, len(ref)
    if start_hint is not None:
        lo = max(0, next((i for i, r in enumerate(ref) if r["t"] > start_hint - window), 0))
        hi = next((i for i, r in enumerate(ref) if r["t"] > start_hint + window), len(ref))
        if hi - lo < n:
            lo, hi = 0, len(ref)
    best_dist = None
    for i in range(lo, max(lo, hi - n + 1)):
        win = [r["w"].lower().strip(".,!?;:'\"") for r in ref[i:i + n]]
        hits = sum(1 for a, b in zip(cue_words, win) if a == b)
        score = hits / n
        if score < best_score:
            continue
        t = ref[i]["t"]
        dist = abs(t - start_hint) if start_hint is not None else 0.0
        # a short cue's words recur all over a long transcript, so an equally good match
        # is broken by nearness: otherwise the checker invents an 80s error out of the
        # word "So." appearing somewhere else in the programme
        if score > best_score or (best_dist is not None and dist < best_dist):
            best_score, best, best_dist = score, t, dist
    # a cue has to be at least half-recognisable in the reference before its
    # timing is worth reporting; below that we are timing noise against noise
    return best if best_score >= 0.5 else None


def pct(xs, p):
    if not xs:
        return None
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100.0 * (len(xs) - 1))))]


def main():
    run = sys.argv[1]
    model = "medium.en"
    lang = "en"
    for i, a in enumerate(sys.argv):
        if a == "--model":
            model = sys.argv[i + 1]
        if a == "--lang":
            lang = sys.argv[i + 1]
    out = run
    if os.path.isdir(os.path.join(run, "origin", "runs")):
        runs = sorted(glob.glob(os.path.join(run, "origin", "runs", "*")))
        out = runs[-1]

    report = {"run": run, "out": out}

    # 1. timeline sanity: does the companion playlist's PDT advance at EXTINF rate?
    cc = sorted(glob.glob(os.path.join(out, "stream_*_cc.m3u8")))
    if cc:
        import datetime as dt
        segs = parse_playlist(cc[0])
        stamped = [s for s in segs if s["pdt"]]
        deltas = []
        for a, b in zip(stamped, stamped[1:]):
            ta = dt.datetime.fromisoformat(a["pdt"].replace("Z", "+00:00")).timestamp()
            tb = dt.datetime.fromisoformat(b["pdt"].replace("Z", "+00:00")).timestamp()
            deltas.append(round(tb - ta - (a["dur"] or 0), 3))
        report["pdt_step_error"] = {
            "n": len(deltas),
            "max_abs": max((abs(d) for d in deltas), default=None),
            "mean_abs": round(sum(abs(d) for d in deltas) / len(deltas), 3) if deltas else None,
            "worst": sorted(deltas, key=abs, reverse=True)[:5],
        }

    # 2. our published cues
    ours = collect_our_cues(out, lang)
    report["cues"] = {"n": len(ours), "unplaceable": sum(1 for c in ours if c["pts"] is None)}
    if ours:
        mp = [c["mpegts"] for c in ours if c["mpegts"] is not None]
        report["cues"]["mpegts_monotonic"] = all(a <= b for a, b in zip(mp, mp[1:]))

    # 3. the reference: transcribe what we actually delivered
    with tempfile.TemporaryDirectory() as td:
        wav = os.path.join(td, "delivered.wav")
        dec = decode_delivered_audio(out, wav)
        if dec is None:
            report["error"] = "no delivered audio to check against"
            print(json.dumps(report, indent=2))
            return
        breakpoints, astats = dec
        report["delivered_audio"] = astats
        ref = reference_words(wav, breakpoints, model=model, lang=lang)
        report["reference_words"] = len(ref)
        if ref:
            report["reference_span_pts"] = [round(ref[0]["t"], 2), round(ref[-1]["end"], 2)]

        # 4. sync error, cue by cue
        errs, unmatched, short = [], 0, 0
        detail = []
        for c in ours:
            cw = [w.strip(".,!?;:'\"") for w in norm_words(c["text"])]
            # a one or two word cue cannot be located reliably in a long transcript, so
            # timing it would measure the matcher, not the pipeline
            if len(cw) < 4:
                short += 1
                continue
            rt = match_cue(cw, ref, c["pts"])
            if rt is None or c["pts"] is None:
                unmatched += 1
                continue
            e = round(c["pts"] - rt, 3)
            errs.append(e)
            detail.append({"chunk": c["chunk"], "err": e, "text": c["text"][:60]})
        report["sync_error_sec"] = {
            "n": len(errs), "unmatched": unmatched, "too_short_to_locate": short,
            "median": pct(errs, 50), "mean": round(sum(errs) / len(errs), 3) if errs else None,
            "p05": pct(errs, 5), "p95": pct(errs, 95),
            "min": min(errs) if errs else None, "max": max(errs) if errs else None,
            "within_0s5": round(sum(1 for e in errs if abs(e) <= 0.5) / len(errs), 3) if errs else None,
            "within_1s": round(sum(1 for e in errs if abs(e) <= 1.0) / len(errs), 3) if errs else None,
            "within_2s": round(sum(1 for e in errs if abs(e) <= 2.0) / len(errs), 3) if errs else None,
        }
        report["worst_cues"] = sorted(detail, key=lambda d: abs(d["err"]), reverse=True)[:8]

        # 5. coverage: of the reference speech, how much had a cue on screen
        if ref and ours:
            spans = [(c["pts"], c["end_pts"]) for c in ours if c["pts"] is not None]
            covered = sum(1 for w in ref if any(a <= w["t"] <= b for a, b in spans))
            report["coverage_of_spoken_words"] = round(covered / len(ref), 3)

        # 6. text accuracy of our live transcript vs the reference transcript
        hyp = norm_words(" ".join(c["text"] for c in ours))
        refw = [w["w"].lower().strip(".,!?;:'\"") for w in ref]
        refw = [w for w in refw if w]
        if refw and hyp:
            report["wer_vs_delivered_audio"] = round(wer(refw, hyp), 3)

    # 7. text accuracy vs the SOURCE's own subtitle track
    tp = os.path.join(run, "truth.jsonl")
    if os.path.exists(tp):
        seen, src = set(), []
        for line in open(tp):
            r = json.loads(line)
            key = (r["text"], round(r["start"], 1))
            if r["text"] in seen:
                continue
            seen.add(r["text"])
            src.append(r)
        srcw = norm_words(" ".join(r["text"] for r in sorted(src, key=lambda r: r["start"])))
        hyp = norm_words(" ".join(c["text"] for c in ours))
        if srcw and hyp:
            report["source_subtitle_words"] = len(srcw)
            report["wer_vs_source_subtitles"] = round(wer(srcw, hyp), 3)

    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
