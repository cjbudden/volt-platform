"""Live output conformance: is the stream we deliver telling one consistent time?

WHY (23 Oct 2026)
-----------------
The monitor showed sound out of step with the picture and a picture that
jumped back in time. Every existing check was green: the packager was up,
segments were advancing, the five gates were healthy. None of them looked at
TIME, so nothing in Volt could have said what was wrong, or that anything was.

This reads the packager's own media playlists and the first few KB of each
recent segment (its tfdt) and checks the properties a player relies on. It is
cheap enough to run every few seconds: a handful of small reads per track, and
segment facts are memoised because a written segment never changes.

FAULT CODES (each one maps to a symptom a viewer would see)
  index_misaligned   audio and video segments do not start at the same moments
                     (CMAF alignment). Some players play them out of sync, and a
                     boundary-aligned switch to a replacement loop cannot land.
  av_skew            the newest audio and the newest video end far apart: one
                     track has stalled or restarted, so the live edge has no
                     matching sound or picture.
  rendition_skew     two video renditions disagree about time: an ABR switch
                     jumps forwards or backwards.
  timeline_backwards a track's next segment starts before the previous one
                     ended: the picture or sound jumps back.
  (a forward hole is expected while the filler loop covers a lost source,
   so it is not reported)
  sequence_regressed the playlist's media sequence went DOWN between two checks:
                     a player reloading it is sent back in time.
"""
import os
import re

import mp4util

INDEX_TOL = 0.5          # s: same seg number, different start time across tracks
GAP_TOL = 1.0            # s: hole within one track
BACK_TOL = 0.25          # s: overlap within one track
LOOKBACK = 6             # newest segments examined per track

_TS = {}
_TFDT = {}


def _timescale(init):
    ts = _TS.get(init)
    if ts is None:
        try:
            ts = mp4util.timescale(init)
        except Exception:  # noqa: BLE001
            ts = None
        if ts:
            _TS[init] = ts
    return ts


def _start(path):
    """Start time (s) of one segment, memoised (segments are immutable)."""
    if path in _TFDT:
        return _TFDT[path]
    ts = _timescale(os.path.join(os.path.dirname(path), "init.mp4"))
    try:
        t = mp4util.tfdt(path)
    except Exception:  # noqa: BLE001
        t = None
    val = (t / ts) if (t is not None and ts) else None
    if val is not None:
        if len(_TFDT) > 20000:
            _TFDT.clear()
        _TFDT[path] = val
    return val


def parse_playlist(text):
    """(media_sequence, init_uri, [(uri, duration)]) of an HLS media playlist."""
    seq, init, segs, dur = 0, None, [], None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("#EXT-X-MEDIA-SEQUENCE:"):
            try:
                seq = int(line.split(":", 1)[1])
            except ValueError:
                pass
        elif line.startswith("#EXT-X-MAP:"):
            m = re.search(r'URI="([^"]+)"', line)
            init = m.group(1) if m else None
        elif line.startswith("#EXTINF:"):
            try:
                dur = float(line.split(":", 1)[1].split(",")[0])
            except ValueError:
                dur = None
        elif line and not line.startswith("#"):
            segs.append((line, dur))
            dur = None
    return seq, init, segs


def _seg_no(uri):
    m = re.search(r"(\d+)\.m4s$", uri)
    return int(m.group(1)) if m else None


def read_tracks(out_dir, lookback=LOOKBACK, start=_start):
    """Per media playlist written by the packager (not the *_cc / *_rp copies):
    {name: {kind, seq, segs:[(no, start, dur)]}}."""
    tracks = {}
    try:
        names = sorted(f for f in os.listdir(out_dir)
                       if re.fullmatch(r"stream_\d+\.m3u8", f))
    except OSError:
        return tracks
    for name in names:
        try:
            with open(os.path.join(out_dir, name)) as fh:
                seq, init, segs = parse_playlist(fh.read())
        except OSError:
            continue
        if not segs:
            continue
        folder = os.path.dirname(segs[0][0]) or (os.path.dirname(init or "") or "")
        kind = "audio" if re.match(r"(audio|aud|a\d)", folder) else "video"
        rows = []
        for uri, dur in segs[-lookback:]:
            t = start(os.path.join(out_dir, uri))
            if t is not None and dur:
                rows.append((_seg_no(uri), t, dur))
        tracks[name] = {"kind": kind, "seq": seq, "folder": folder, "segs": rows}
    return tracks


def check(tracks, seg_seconds=4.0, previous=None):
    """Pure: the faults in `tracks` (see read_tracks). Returns
    ([{code, track, message, value}], state) where `state` feeds the next call."""
    faults = []
    seg = float(seg_seconds or 4.0)
    state = {n: t["seq"] for n, t in tracks.items()}

    # 1) each track on its own
    for n, t in tracks.items():
        rows = t["segs"]
        for (_, a, da), (no_b, b, _) in zip(rows, rows[1:]):
            end = a + da
            if b < end - BACK_TOL:
                faults.append({"code": "timeline_backwards", "track": t["folder"] or n,
                               "value": round(end - b, 3),
                               "message": f"{t['folder'] or n} segment {no_b} starts {end - b:.2f}s before the previous one ends"})
                break
            # A forward hole is NOT a fault here: while the source is lost the
            # packager gets nothing and the delivered playlists splice the loop
            # over the hole. Going BACK is the fault (above).
        if previous and n in previous and t["seq"] < previous[n]:
            faults.append({"code": "sequence_regressed", "track": t["folder"] or n,
                           "value": previous[n] - t["seq"],
                           "message": f"{t['folder'] or n} media sequence went back from {previous[n]} to {t['seq']}"})

    audio = [t for t in tracks.values() if t["kind"] == "audio" and t["segs"]]
    video = [t for t in tracks.values() if t["kind"] == "video" and t["segs"]]

    # 2) live edge: newest audio vs each video rendition's newest. A player
    #    plays ONE video rendition with the audio, so any rendition far from
    #    the audio is a stream where that quality has no matching sound.
    if audio and video:
        a_end = max(t["segs"][-1][1] + t["segs"][-1][2] for t in audio)
        worst = None
        for t in video:
            v_end = t["segs"][-1][1] + t["segs"][-1][2]
            skew = v_end - a_end
            if worst is None or abs(skew) > abs(worst[0]):
                worst = (skew, t["folder"])
        skew, which = worst
        if abs(skew) > max(1.5 * seg, 6.0):
            faults.append({"code": "av_skew", "track": which, "value": round(skew, 3),
                           "message": (f"{which} video and the audio are {abs(skew):.1f}s apart at the live edge "
                                       f"({'video' if skew > 0 else 'audio'} ahead): one input is arriving late or "
                                       "its relay is running below real time")})

    # 3) do audio and video cut at the same moments? (CMAF alignment)
    #    Compared by TIME, not by segment number: numbers drift legitimately
    #    (audio may start a segment or two earlier, a filler gap advances one
    #    track's count), while boundaries that do not line up are the real fault.
    if audio and video:
        vstarts = [st for _, st, _ in video[0]["segs"]]
        worst = 0.0
        for a in audio:
            for _, st, _ in a["segs"]:
                if st < vstarts[0] - 0.5 or st > vstarts[-1] + 0.5:
                    continue          # outside the span the video rows cover: the
                                      # newest track is often a segment ahead
                d = min((st - v for v in vstarts), key=abs)
                if abs(d) > abs(worst):
                    worst = d
        if abs(worst) > INDEX_TOL:
            faults.append({"code": "index_misaligned", "track": "audio", "value": round(worst, 3),
                           "message": (f"audio and video segments do not start together (up to {abs(worst):.2f}s apart); "
                                       "some players play them out of sync and a switch to the replacement loop "
                                       "cannot land cleanly (segment length is not a multiple of the source GOP)")})

    # 4) video renditions agree on time
    if len(video) > 1:
        base = {no: s for no, s, _ in video[0]["segs"] if no is not None}
        for other in video[1:]:
            for no, s, _ in other["segs"]:
                if no in base and abs(s - base[no]) > 0.1:
                    faults.append({"code": "rendition_skew", "track": other["folder"], "value": round(s - base[no], 3),
                                   "message": f"{other['folder']} and {video[0]['folder']} disagree by {abs(s - base[no]):.2f}s at segment {no}; ABR switches jump"})
                    break
    return faults, state


class OutputWatch:
    """Stateful wrapper the encoder runs every few seconds: reports a CHANGE
    in the fault set as one event, never the same verdict twice."""

    def __init__(self, out_dir, seg_seconds, emit, read=read_tracks):
        self.out_dir, self.seg = out_dir, seg_seconds
        self.emit, self.read = emit, read
        self.prev_state = None
        self.codes = frozenset()
        self._last_seen = frozenset()

    def tick(self):
        tracks = self.read(self.out_dir)
        if not tracks:
            return []
        faults, self.prev_state = check(tracks, self.seg, self.prev_state)
        # SEEN TWICE BEFORE SAID ONCE. Tracks are written a moment apart, and
        # the first segment of a run is partial, so a single look can catch a
        # state that is gone by the next one. A condition is reported once it
        # holds on two checks in a row; going back in time is reported at once.
        now = frozenset(f["code"] for f in faults)
        instant = {"timeline_backwards", "sequence_regressed"}
        steady = {c for c in now if c in instant or c in self._last_seen}
        self._last_seen = now
        faults = [f for f in faults if f["code"] in steady]
        codes = frozenset(steady)
        if codes != self.codes:
            if faults:
                self.emit("output.timeline", state="fault", faults=faults,
                          message="; ".join(f["message"] for f in faults))
            elif self.codes:
                self.emit("output.timeline", state="ok", cleared=sorted(self.codes))
            self.codes = codes
        return faults


if __name__ == "__main__":   # python3 output_check.py <run dir> [segment seconds]
    import json
    import sys
    tr = read_tracks(sys.argv[1])
    f, _ = check(tr, float(sys.argv[2]) if len(sys.argv) > 2 else 4.0)
    print(json.dumps({"tracks": {k: {**v, "segs": v["segs"][-3:]} for k, v in tr.items()},
                      "faults": f}, indent=1))
    sys.exit(1 if f else 0)
