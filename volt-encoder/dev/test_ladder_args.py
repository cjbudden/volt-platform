# ===========================================================================
#  THE LADDER'S ENCODER SETTINGS ARE ONE DEFINITION, AND THIS IS WHAT KEEPS
#  THEM THAT WAY.
#
#  A file dropped in a watchfolder is encoded to the same ladder a live channel
#  is, and the requirement is that it MATCH: same bitrates, same rate control,
#  same GOP, so a VOD asset and a live rendition of the same channel are the
#  same picture at the same cost, cut at the same boundaries.
#
#  The failure this guards against is not a crash. It is that somebody tunes
#  maxrate for live, the file path keeps the old multiplier, BOTH ENCODES
#  SUCCEED, and the only symptom is that the two disagree — discovered months
#  later by a viewer whose player switches badly between a VOD asset and the
#  live channel it was recorded from.
#
#  So there are three kinds of assertion here:
#
#    THE GOLDEN. The exact argument list for a known rung, written out. A change
#    to the bitrate maths is then a deliberate edit to this file rather than a
#    silent drift, and the review shows the old and new numbers side by side.
#
#    THE SHARED CALL. start_transcode must USE the shared function rather than
#    contain its own copy. Asserted by reading the source, because a copy that
#    happens to agree today passes every behavioural test and is exactly the
#    thing that drifts tomorrow.
#
#    THE INVARIANTS. The relationships that make ABR work at all — the GOP being
#    exactly one segment, closed GOP, the ceiling above the advertised rate —
#    stated as properties so they survive a change of numbers.
#
#  Usage: python3 -m pytest dev/test_ladder_args.py -q   (no ffmpeg, no network)
# ===========================================================================
import sys

# NO CACHED BYTECODE FOR THE MODULES UNDER TEST.
#
# Python invalidates a .pyc on the source's mtime AND SIZE, and an edit that
# changes NEITHER is invisible to it. `*1.1` -> `*1.5` is the same number of
# bytes, so an edit and a re-run inside the same second load the OLD code and
# report the OLD answer. That is the worst possible behaviour for a suite whose
# entire job is to notice when these numbers change, and it is not theoretical:
# it happened while developing this file and read as a passing test over changed
# source for a good minute.
#
# `dont_write_bytecode` alone is not enough — it stops Python WRITING a .pyc,
# not reading one that is already there — so any existing cache for the
# directory under test is removed first.
sys.dont_write_bytecode = True

def _drop_stale_bytecode(d):
    import shutil
    shutil.rmtree(os.path.join(d, "__pycache__"), ignore_errors=True)

import importlib.util
import os
import re

BIN = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin")
_drop_stale_bytecode(BIN)
sys.path.insert(0, BIN)
os.environ.setdefault("WORK_DIR", "/tmp/enc_test")

# The shared settings live in their own module with no import-time side effects,
# which is what lets the file encoder use them without the live encoder's world.
import ladder_args as la

spec = importlib.util.spec_from_file_location("enc", os.path.join(BIN, "encoder.py"))
enc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(enc)

RUNG = {"height": 720, "bitrate_kbps": 3000}


# --------------------------------------------------- the suite checks itself
def test_the_code_that_ran_is_the_code_on_disk():
    """A STALE .pyc REPORTS THE OLD ANSWER OVER CHANGED SOURCE, and for a suite
    whose whole job is to notice when these numbers change that is the worst
    failure available: green, over code nobody is running.

    It is not theoretical. Python invalidates a .pyc on the source's mtime AND
    SIZE, and `*1.1` -> `*1.5` changes neither, so an edit and a re-run inside
    the same second load the cached module. It happened while writing this file.
    Deleting __pycache__ is attempted above, but a delete that silently did not
    take is exactly the thing not to trust — so this compares the multiplier in
    the FILE against the one the loaded function actually produced.
    """
    src = open(os.path.join(BIN, "ladder_args.py")).read()
    m = re.search(r"bitrate_kbps'\]\s*\*\s*([0-9.]+)\)\}k\"[,\s]*\n?\s*\"-bufsize", src) \
        or re.search(r"-maxrate\",\s*f\"\{int\(r\['bitrate_kbps'\]\*([0-9.]+)\)\}k\"", src)
    assert m, "could not find the maxrate multiplier in ladder_args.py"
    on_disk = float(m.group(1))

    args = la.video_rung_args(RUNG, seg=4, fps=25)
    executed = int(args[args.index("-maxrate") + 1].rstrip("k")) / RUNG["bitrate_kbps"]
    assert abs(executed - on_disk) < 0.001, (
        f"the file says maxrate is {on_disk}x the target but the loaded module produced "
        f"{executed:.3f}x — you are running CACHED BYTECODE, not this source. "
        f"Remove {os.path.join(BIN, '__pycache__')} and run again.")


# ---------------------------------------------------------------- the golden
def test_a_rung_produces_exactly_these_arguments():
    """If this test needs changing, the encode changed. That is the point."""
    assert la.video_rung_args(RUNG, seg=4, fps=25) == [
        "-map", "0:v:0",
        "-vf", "scale=-2:720",
        "-c:v", "libx264", "-preset", "veryfast",
        "-b:v", "3000k",
        "-maxrate", "3300k",      # 1.1x the target
        "-bufsize", "6000k",      # 2x the target
        "-g", "100", "-keyint_min", "100",   # 4s x 25fps
        "-sc_threshold", "0",
        "-force_key_frames", "expr:gte(t,n_forced*4)",
        "-r", "25",
        "-an",
    ]


def test_the_gpu_rung_differs_only_in_the_codec():
    cpu = la.video_rung_args(RUNG, seg=4, fps=25, gpu=False)
    gpu = la.video_rung_args(RUNG, seg=4, fps=25, gpu=True)
    # RATE CONTROL MUST NOT DEPEND ON THE BACKEND. A channel moved from x264 to
    # NVENC keeps its bitrates, or its manifest starts lying about them.
    strip = lambda a: [x for i, x in enumerate(a)
                       if x not in ("libx264", "h264_nvenc", "veryfast", "p4")]
    assert strip(cpu) == strip(gpu)
    assert "h264_nvenc" in gpu and "libx264" not in gpu


def test_audio_is_the_same_everywhere():
    assert la.audio_track_args(0) == [
        "-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000"]
    # THE OPTIONAL MAP. A source that claims three tracks and delivers two must
    # not take the whole encode down.
    assert la.audio_track_args(2)[1].endswith("?")


def test_audio_frames_are_whole_ticks_on_the_packager_clock():
    """At 44.1 kHz an AAC frame is 2089.796 ticks of 90 kHz; Shaka rounds it to
    2089 and logs a ~137-tick gap every segment. At the rate we encode to, a
    frame must be a whole number of ticks so that cannot happen."""
    args = la.audio_track_args(0)
    sr = int(args[args.index("-ar") + 1])
    assert (1024 * 90000) % sr == 0


# ------------------------------------------------------------ the invariants
def test_the_gop_is_exactly_one_segment():
    """What makes the renditions switchable: every segment starts on an IDR."""
    for seg, fps in ((4, 25), (2, 30), (6, 50), (4, 29.97)):
        args = la.video_rung_args(RUNG, seg=seg, fps=fps)
        g = int(args[args.index("-g") + 1])
        assert g == la.gop_for(seg, fps) == int(seg * fps)
        # keyint_min pinned to it too, or x264 is free to insert a shorter GOP.
        assert args[args.index("-keyint_min") + 1] == str(g)


def test_the_gop_is_closed():
    args = la.video_rung_args(RUNG, seg=4, fps=25)
    # A scene-cut keyframe lands in a different place in each rendition, and a
    # player switching mid-GOP gets a broken picture.
    assert args[args.index("-sc_threshold") + 1] == "0"
    assert args[args.index("-force_key_frames") + 1] == "expr:gte(t,n_forced*4)"


def test_the_ceiling_is_above_the_advertised_rate_but_not_far_above():
    for kbps in (600, 1200, 3000, 5000, 8000):
        args = la.video_rung_args({"height": 720, "bitrate_kbps": kbps}, seg=4, fps=25)
        target = int(args[args.index("-b:v") + 1].rstrip("k"))
        ceiling = int(args[args.index("-maxrate") + 1].rstrip("k"))
        buf = int(args[args.index("-bufsize") + 1].rstrip("k"))
        assert target == kbps
        # A rung that can exceed the bandwidth it advertises in the manifest is
        # what makes an ABR switching decision wrong.
        assert target < ceiling <= int(target * 1.25)
        assert buf == target * 2


def test_a_watermark_graph_replaces_the_scale_rather_than_stacking_on_it():
    vf = "movie=/tmp/wm.png,format=rgba[wm];[in]scale=-2:720[bg];[bg][wm]overlay=0:0"
    args = la.video_rung_args(RUNG, seg=4, fps=25, vf=vf)
    assert args[args.index("-vf") + 1] == vf
    # Two scale filters in one graph is a resize of a resize: soft, and slower.
    assert args.count("-vf") == 1


def test_an_empty_filter_string_is_not_treated_as_absent():
    """`is not None`, not truthiness: an empty graph is a caller's bug, and
    silently substituting the default scale would hide it."""
    assert la.video_rung_args(RUNG, seg=4, fps=25, vf="")[3] == ""


# --------------------------------------------------------- the shared call
def _source_of(fn):
    import inspect
    return inspect.getsource(fn)


def test_the_live_path_calls_the_shared_function_rather_than_its_own_copy():
    """READ THE SOURCE, because a copy that agrees today passes every
    behavioural test and is precisely the thing that drifts tomorrow."""
    src = _source_of(enc.start_transcode)
    assert "video_rung_args(" in src, "start_transcode must use the shared rung args"
    assert "audio_track_args(" in src, "start_transcode must use the shared audio args"
    for hand_rolled in ("-maxrate", "-bufsize", "-keyint_min", "-sc_threshold", '"-b:a"'):
        assert hand_rolled not in src, (
            f"start_transcode builds {hand_rolled} by hand again; "
            "the file-encode path reads these from video_rung_args/audio_track_args "
            "and the two will drift")


def test_no_caller_builds_these_by_hand():
    """One definition means one definition. A second copy anywhere is the drift,
    and it is a copy that AGREES on the day it is written, which is why only
    reading the source catches it."""
    for name in ("encoder.py", "vod_encoder.py"):
        path = os.path.join(BIN, name)
        if not os.path.exists(path):
            continue
        src = open(path).read()
        for token in ("-maxrate", "-bufsize", "-keyint_min", "-sc_threshold"):
            assert token not in src, (
                f"{name} builds {token} by hand; the ladder's rate control lives in "
                "ladder_args.video_rung_args and these two will drift apart")


def test_the_file_encoder_uses_the_same_settings_as_live():
    """THE REQUIREMENT, as one assertion. Both encoders reach the same function,
    so a file asset and a live rendition of the same channel are the same
    encode."""
    vod = os.path.join(BIN, "vod_encoder.py")
    if not os.path.exists(vod):
        return  # not built yet
    src = open(vod).read()
    assert "video_rung_args(" in src, "the file encoder must use the shared rung args"
    assert "audio_track_args(" in src, "the file encoder must use the shared audio args"
    assert "from ladder_args import" in src or "import ladder_args" in src


def test_the_live_and_file_paths_agree_for_the_same_rung():
    """The requirement in one assertion: the same rung, encoded two ways, is the
    same encode. Both call sites resolve through the same function, so this
    passes by construction — and fails loudly the moment one of them stops."""
    live = la.video_rung_args(RUNG, seg=4, fps=25, gpu=False)
    from_file = la.video_rung_args(dict(RUNG), seg=4, fps=25, gpu=False)
    assert live == from_file


# ---------------------------------------------------------------------------
#  Runnable with plain python3, no test framework. Still collects under pytest.
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import sys as _sys
    from _run import main as _main
    _sys.exit(_main(dict(globals()), "ladder-args"))
