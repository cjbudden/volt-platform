# ===========================================================================
#  THE FILE ENCODER: does it produce the same encode as live, and a finished
#  asset rather than one that claims to still be going?
#
#  THE THREE THAT MATTER:
#
#    BOTH MANIFESTS MUST SAY VOD, and only one of them does by default. Shaka
#    takes --hls_playlist_type VOD for HLS and nothing for DASH, so the MPD came
#    out type="dynamic" with a minimumUpdatePeriod and a thirty-minute
#    timeShiftBufferDepth over a twelve-second file. Checking the HLS playlist
#    and concluding the package was right is the exact shape of being correct
#    about the wrong question: two manifests, two flags, one of them was wrong.
#
#    ONE DECODE, NOT N. ffmpeg takes many outputs from one input for a reason. A
#    run per rung decodes the source once per rendition, and on a feature-length
#    asset that is the dominant cost of the whole job.
#
#    A PROBE THAT COULD NOT MEASURE MUST SAY SO. ffprobe returns '0/0' for a
#    frame rate it could not read and omits duration on some containers. Reported
#    as 0 those become "no frames" and "zero length", and the control plane's
#    upscale cap then drops every rung because the source is "smaller than all of
#    them". None means not measured, and it has to survive the whole way out.
#
#  Usage: python3 -m pytest dev/test_vod_encoder.py -q   (no ffmpeg, no network)
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
import json
import os

BIN = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin")
_drop_stale_bytecode(BIN)
sys.path.insert(0, BIN)

spec = importlib.util.spec_from_file_location("vod", os.path.join(BIN, "vod_encoder.py"))
vod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vod)

import ladder_args as la

CFG = {
    "input": "/tmp/src.mp4",
    "out_dir": "/tmp/out",
    "segment_seconds": 4,
    "fps": 25,
    "gpu": False,
    "packaging": "both",
    "has_audio": True,
    "ladder": [{"height": 720, "bitrate_kbps": 3000},
               {"height": 360, "bitrate_kbps": 600}],
}


# ------------------------------------------------------- the encode command
def test_one_ffmpeg_run_produces_every_rendition():
    cmd, parts, audio = vod.build_encode_cmd(CFG, "/tmp/work")
    # ONE INPUT. Two would mean the source is decoded twice.
    assert cmd.count("-i") == 1
    assert len(parts) == 2
    assert cmd.count("-f") == 3          # two video renditions + one audio
    assert audio and audio.endswith("audio.ts")


def test_each_rung_uses_the_shared_live_settings():
    """THE REQUIREMENT. Not 'similar to' live: the same bytes."""
    cmd, _, _ = vod.build_encode_cmd(CFG, "/tmp/work")
    for r in CFG["ladder"]:
        expected = la.video_rung_args(r, seg=4, fps=25, gpu=False)
        # The rung's arguments appear as a contiguous run in the command.
        joined, needle = " ".join(cmd), " ".join(expected)
        assert needle in joined, f"the {r['height']}p rung does not use video_rung_args"
    assert " ".join(la.audio_track_args(0)) in " ".join(cmd)


def test_the_gpu_flag_reaches_both_the_decoder_and_the_rungs():
    cmd, _, _ = vod.build_encode_cmd({**CFG, "gpu": True}, "/tmp/work")
    assert "-hwaccel" in cmd and "cuda" in cmd
    assert "h264_nvenc" in cmd and "libx264" not in cmd


def test_a_silent_source_produces_no_audio_output():
    cmd, parts, audio = vod.build_encode_cmd({**CFG, "has_audio": False}, "/tmp/work")
    assert audio is None
    # Mapping an audio stream that is not there is a failed encode, not an
    # encode with a silent track.
    assert "-c:a" not in cmd
    assert cmd.count("-f") == len(parts)


def test_an_empty_ladder_is_refused_rather_than_encoded():
    """A job with no rungs produces no renditions and reports success. The
    control plane must never enqueue one, and this is the second line."""
    try:
        vod.build_encode_cmd({**CFG, "ladder": []}, "/tmp/work")
        assert False, "an empty ladder was accepted"
    except SystemExit:
        pass


# ------------------------------------------------------ the package command
def _pkg(cfg=None):
    cfg = cfg or CFG
    _, parts, audio = vod.build_encode_cmd(cfg, "/tmp/work")
    return vod.build_package_cmd(cfg, parts, audio, "/tmp/out")


def test_the_hls_playlist_is_vod():
    cmd = _pkg()
    assert "--hls_playlist_type" in cmd
    assert cmd[cmd.index("--hls_playlist_type") + 1] == "VOD"


def test_the_dash_manifest_is_static_too():
    """THE ONE THAT WAS WRONG. Without this the MPD is type="dynamic" with a
    minimumUpdatePeriod and a timeShiftBufferDepth: a live manifest describing a
    file that has finished, so a DASH player polls forever and cannot seek to
    the start."""
    assert "--generate_static_live_mpd" in _pkg()


def test_hls_only_and_dash_only_each_emit_just_their_own():
    hls = _pkg({**CFG, "packaging": "hls"})
    assert "--mpd_output" not in hls and "--hls_master_playlist_output" in hls
    dash = _pkg({**CFG, "packaging": "dash"})
    assert "--hls_master_playlist_output" not in dash and "--mpd_output" in dash
    # The static flag belongs to the DASH output, so it must travel with it.
    assert "--generate_static_live_mpd" in dash


def test_the_segment_duration_matches_the_gop():
    """Segment length and GOP are the same number in two places, and a mismatch
    means segments that do not start on a keyframe."""
    cmd = _pkg()
    seg = cmd[cmd.index("--segment_duration") + 1]
    assert seg == "4"
    enc, _, _ = vod.build_encode_cmd(CFG, "/tmp/work")
    assert enc[enc.index("-g") + 1] == str(la.gop_for(4, 25))


def test_every_rendition_gets_its_own_directory():
    cmd = " ".join(_pkg())
    # Sharing one directory means the second rendition overwrites the first's
    # segments, and the manifest then lists media that is not there.
    assert "/tmp/out/720p/init.mp4" in cmd and "/tmp/out/360p/init.mp4" in cmd
    assert "/tmp/out/audio/init.mp4" in cmd


# ------------------------------------------------------------------ the probe
class _Result:
    def __init__(self, stdout, code=0, stderr=""):
        self.stdout, self.returncode, self.stderr = stdout, code, stderr


def _probe_with(streams, fmt=None, monkey=None):
    payload = json.dumps({"streams": streams, "format": fmt or {}})
    real = vod.subprocess.run
    vod.subprocess.run = lambda *a, **k: _Result(payload)
    try:
        return vod.probe("/tmp/x.mp4")
    finally:
        vod.subprocess.run = real


def test_a_normal_file_probes_as_you_would_expect():
    p = _probe_with(
        [{"codec_type": "video", "width": 1920, "height": 1080,
          "avg_frame_rate": "25/1", "codec_name": "h264"},
         {"codec_type": "audio", "codec_name": "aac"}],
        {"duration": "12.5"})
    assert (p["width"], p["height"], p["fps"], p["durationMs"]) == (1920, 1080, 25.0, 12500)
    assert p["hasVideo"] and p["hasAudio"]


def test_an_unmeasurable_frame_rate_is_none_and_not_zero():
    """'0/0' is ffprobe saying it could not tell. Zero fps is a different claim
    and it would make the control plane cap the ladder to nothing."""
    p = _probe_with([{"codec_type": "video", "width": 640, "height": 360,
                      "avg_frame_rate": "0/0", "r_frame_rate": "0/0"}])
    assert p["fps"] is None


def test_it_falls_back_to_r_frame_rate_when_the_average_is_missing():
    p = _probe_with([{"codec_type": "video", "width": 640, "height": 360,
                      "avg_frame_rate": "0/0", "r_frame_rate": "30000/1001"}])
    assert p["fps"] == 29.97


def test_a_missing_duration_is_none_and_not_zero():
    p = _probe_with([{"codec_type": "video", "width": 640, "height": 360}],
                    {"duration": "N/A"})
    assert p["durationMs"] is None


def test_a_missing_size_is_none_and_not_zero():
    """The one that matters most: height 0 is 'below every rung' and drops the
    whole ladder, while None is 'not measured' and encodes it."""
    p = _probe_with([{"codec_type": "video", "codec_name": "h264"}])
    assert p["height"] is None and p["width"] is None


def test_an_audio_only_file_is_not_a_video_of_no_height():
    p = _probe_with([{"codec_type": "audio", "codec_name": "aac"}], {"duration": "60"})
    assert p["hasVideo"] is False and p["hasAudio"] is True
    assert p["height"] is None


def test_a_failed_probe_reports_the_failure_rather_than_an_empty_file():
    real = vod.subprocess.run
    vod.subprocess.run = lambda *a, **k: _Result("", 1, "moov atom not found")
    try:
        p = vod.probe("/tmp/x.mp4")
    finally:
        vod.subprocess.run = real
    # Not {height: None, ok: True}: "we could not read this file" and "this file
    # has no video track" are different, and only one of them is worth retrying.
    assert p["ok"] is False and "moov" in p["error"]


def test_rotation_is_reported_so_the_cap_can_be_argued_with():
    p = _probe_with([{"codec_type": "video", "width": 1080, "height": 1920,
                      "side_data_list": [{"rotation": -90}]}])
    assert p["rotation"] == -90


# ---------------------------------------------------------------------------
#  Runnable with plain python3, no test framework. Still collects under pytest.
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import sys as _sys
    from _run import main as _main
    _sys.exit(_main(dict(globals()), "vod-encoder"))
