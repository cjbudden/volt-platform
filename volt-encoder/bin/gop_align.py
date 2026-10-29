"""Segment length that fits the SOURCE's GOP (package_only).

WHY THIS EXISTS (23 Oct 2026, measured on the RTM Berita feed)
--------------------------------------------------------------
package_only never re-encodes, so video can only be cut at the source's own
keyframes. Berita has a keyframe every 3.6 s; the job asked for 4 s segments.
Shaka cut video at 3.6 s (and 7.2 s when one keyframe arrived late) but cut
AUDIO at 4 s, because audio can be cut anywhere. The two tracks were each
correct, but their segment NUMBERS stopped meaning the same moment: audio
seg_40 started 2.4 s before video seg_40, and the gap wandered from 0 to ~4 s.

hls.js and Shaka place segments by their timestamps and play that correctly.
Chrome's built-in HLS player (on by default on desktop since late 2025) and
some TV stacks pair audio and video by sequence number, and play the two up to
a segment apart: sound visibly out of sync with the picture. Segments that do
not line up also break the edge's segment-boundary switch to a replacement loop.

The fix is to ask for what the source can deliver: the requested length,
rounded to a whole number of source GOPs. Then audio and video cut on the same
boundaries and seg_N is the same few seconds on every track.

Only HTTP(S) HLS sources are probed. A push source (SRT, RTMP) is not there
yet at start, and an encoded rendition (NDI, 2110) sets its own GOP from the
segment length, so both keep the configured value.
"""
import json
import statistics
import subprocess

# A GOP this irregular cannot be lined up by choosing a length: keep the target.
MAX_GOP_JITTER = 0.12        # coefficient of variation of the keyframe intervals
MIN_SEG, MAX_SEG = 1.0, 12.0


def keyframe_intervals(times):
    """Intervals between successive keyframe times, ignoring repeats."""
    ts = sorted(t for t in times if t is not None)
    out = []
    for a, b in zip(ts, ts[1:]):
        d = b - a
        if d > 0.04:          # same frame reported twice, or a field pair
            out.append(d)
    return out


def source_gop(times):
    """(gop_seconds, jitter) from keyframe timestamps, or (None, None)."""
    iv = keyframe_intervals(times)
    if len(iv) < 2:
        return None, None
    med = statistics.median(iv)
    if med <= 0:
        return None, None
    jitter = statistics.pstdev(iv) / med
    return round(med, 3), round(jitter, 3)


def aligned_segment(target, gop, jitter=0.0):
    """The segment length to package with: `target` rounded to whole GOPs.

    Returns (seconds, reason). Never shorter than one GOP, never outside
    [MIN_SEG, MAX_SEG]; falls back to `target` when the GOP is unknown or too
    irregular to align to.
    """
    target = float(target)
    if not gop or gop <= 0:
        return target, "gop unknown"
    if jitter is not None and jitter > MAX_GOP_JITTER:
        return target, f"gop irregular (jitter {jitter:.2f})"
    k = max(1, int(round(target / gop)))
    seg = round(k * gop, 3)
    while seg > MAX_SEG and k > 1:
        k -= 1
        seg = round(k * gop, 3)
    if seg < MIN_SEG or seg > MAX_SEG:
        return target, f"gop {gop}s outside {MIN_SEG}-{MAX_SEG}s"
    if abs(seg - target) < 0.001:
        return target, "already aligned"
    return seg, f"{k} x source gop {gop}s"


def probe_keyframes(url, seconds=12, timeout=25, run=subprocess.run):
    """Keyframe times of the first `seconds` of `url` (video stream 0)."""
    cmd = ["ffprobe", "-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey",
           "-show_entries", "frame=pts_time,best_effort_timestamp_time",
           "-read_intervals", f"%+{int(seconds)}", "-of", "json", url]
    try:
        r = run(cmd, capture_output=True, text=True, timeout=timeout)
        frames = json.loads(r.stdout or "{}").get("frames", [])
    except Exception:  # noqa: BLE001 - a probe that fails just leaves the target
        return []
    out = []
    for f in frames:
        v = f.get("pts_time") or f.get("best_effort_timestamp_time")
        try:
            out.append(float(v))
        except (TypeError, ValueError):
            pass
    return out


def probeable(inp):
    proto = str(inp.get("protocol", "")).lower()
    url = str(inp.get("url") or "")
    return proto == "hls" and url.startswith(("http://", "https://"))



def timeline_args(inp):
    """Output args that place a copy relay's timeline. A relay starts its output
    at zero (-muxdelay 0, first keyframe on the segment grid); a RESPAWNED relay
    is given `_ts_offset`, the point the previous one reached plus the time it
    was gone, rounded up to whole segments (source_selector.continue_offset), so
    the bus never goes back in time.

    Not -copyts: on ffmpeg 4.4 (the encoder image) -re paces from timestamp zero,
    so a relay on the source's own clock (hours in) waits hours before it sends."""
    off = float(inp.get("_ts_offset") or 0.0)
    return ["-output_ts_offset", f"{off:.6f}"] if off > 0 else []
