#!/usr/bin/env python3
"""
FILE ENCODER — one video file in, the same ladder a live channel produces out.

WHY THIS EXISTS SEPARATELY FROM encoder.py: live is a supervised pipeline of
long-running processes reading a socket, writing to a UDP bus, with a packager
holding a sliding window. A file is none of those. It has an end, it can be
probed before it starts, it can be encoded in one pass, and it is packaged as
VOD rather than LIVE. Bending the live pipeline around a file would make the
live path harder to reason about for no benefit to either.

WHAT IT DOES NOT DO SEPARATELY: the encoder settings. Bitrate, rate control,
GOP and audio come from ladder_args.video_rung_args / audio_track_args — the
SAME functions the live transcoder calls. That is the requirement: a file
encoded to a channel's ladder is the same picture at the same cost, cut at the
same boundaries, so the two can sit in one player, one manifest, one splice.
dev/test_ladder_args.py reads this file and fails if it ever starts building
those arguments by hand.

THREE THINGS THAT ARE DIFFERENT FROM LIVE AND ARE DELIBERATE:

  ONE PASS, NOT A UDP BUS. Live fans out over localhost UDP because the
  renditions are produced continuously by one long-lived ffmpeg and consumed
  continuously by the packager. A file has an end, so each rendition is written
  to a real file and the packager reads those. No ports, no bus, nothing to
  collide with a live channel running on the same box.

  THE PROBE DECIDES THE LADDER, and the control plane has already done it. The
  rungs in the job config are the ones to encode, full stop. Deciding again here
  would put the upscale policy in two places, and the one place it belongs is
  the control plane, where the operator can see the answer before the encode.

  VOD PLAYLISTS, NOT LIVE. --hls_playlist_type VOD and no time-shift window: the
  asset is complete when the job ends, and a live playlist would advertise a
  sliding window over media that never moves.

Usage:  vod_encoder.py /path/to/job.json
"""
import json
import os
import shlex
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ladder_args import video_rung_args, audio_track_args   # THE SHARED DEFINITION

PACKAGER_BIN = os.environ.get("PACKAGER_BIN", "packager")
FFMPEG_BIN = os.environ.get("FFMPEG_BIN", "ffmpeg")
FFPROBE_BIN = os.environ.get("FFPROBE_BIN", "ffprobe")


def log(msg):
    print(f"[vod-encoder] {msg}", flush=True)


def die(msg, code=1):
    print(f"[vod-encoder] FATAL {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


# ---------------------------------------------------------------------------
#  PROBE
# ---------------------------------------------------------------------------
def probe(path):
    """What the file actually contains.

    EVERY FIELD MAY BE ABSENT, and absent is reported as None rather than 0. A
    height of 0 reads as "smaller than every rung" and would drop the whole
    ladder while the log claimed the source was tiny; None reads as "not
    measured", which is a different decision with a different outcome.
    """
    out = subprocess.run(
        [FFPROBE_BIN, "-v", "error", "-print_format", "json",
         "-show_streams", "-show_format", path],
        capture_output=True, text=True)
    if out.returncode != 0:
        return {"ok": False, "error": (out.stderr or "").strip()[:500]}
    try:
        d = json.loads(out.stdout)
    except Exception as e:
        return {"ok": False, "error": f"unreadable ffprobe output: {e}"}

    v = next((s for s in d.get("streams", []) if s.get("codec_type") == "video"), None)
    a = next((s for s in d.get("streams", []) if s.get("codec_type") == "audio"), None)

    fps = None
    if v:
        # avg_frame_rate is 'num/den' and can be '0/0' on a stream ffprobe could
        # not measure. That is NOT zero fps, it is no answer.
        for key in ("avg_frame_rate", "r_frame_rate"):
            raw = v.get(key) or ""
            if "/" in raw:
                num, den = raw.split("/", 1)
                try:
                    num, den = float(num), float(den)
                    if den > 0 and num > 0:
                        fps = round(num / den, 3)
                        break
                except ValueError:
                    pass

    dur = None
    for src in (d.get("format", {}), v or {}):
        raw = src.get("duration")
        if raw not in (None, "", "N/A"):
            try:
                dur = int(float(raw) * 1000)
                break
            except ValueError:
                pass

    return {
        "ok": True,
        "hasVideo": v is not None,
        "hasAudio": a is not None,
        "width": int(v["width"]) if v and v.get("width") else None,
        "height": int(v["height"]) if v and v.get("height") else None,
        "fps": fps,
        "durationMs": dur,
        "videoCodec": v.get("codec_name") if v else None,
        "audioCodec": a.get("codec_name") if a else None,
        # Rotation matters for the cap: a portrait phone clip is often stored
        # landscape with a side-data rotation, so the stored height is the width
        # the viewer sees. Reported, not acted on, so the control plane decides.
        "rotation": _rotation(v) if v else None,
    }


def _rotation(v):
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            try:
                return int(float(sd["rotation"]))
            except (TypeError, ValueError):
                return None
    tag = (v.get("tags") or {}).get("rotate")
    if tag:
        try:
            return int(float(tag))
        except ValueError:
            return None
    return None


# ---------------------------------------------------------------------------
#  ENCODE
# ---------------------------------------------------------------------------
def rendition_dir(out_dir, label):
    d = os.path.join(out_dir, label)
    os.makedirs(d, exist_ok=True)
    return d


def build_encode_cmd(cfg, work_dir):
    """One ffmpeg run producing every rendition, plus the audio track.

    ONE RUN, NOT ONE PER RUNG: the source is decoded once and fed to every
    encoder, which is the whole reason ffmpeg accepts multiple outputs. N runs
    decode the file N times, and on a long asset that is the dominant cost.
    """
    src = cfg["input"]
    seg = cfg["segment_seconds"]
    fps = cfg["fps"]
    gpu = bool(cfg.get("gpu"))
    ladder = cfg["ladder"]
    if not ladder:
        die("the job config has no rungs; the control plane must not enqueue an empty ladder")

    cmd = [FFMPEG_BIN, "-hide_banner", "-loglevel", "warning", "-nostdin", "-y"]
    if gpu:
        cmd += ["-hwaccel", "cuda"]
    cmd += ["-i", src]

    parts = []
    for r in ladder:
        label = f"{r['height']}p"
        # THE SHARED SETTINGS. Not a copy of them.
        cmd += video_rung_args(r, seg=seg, fps=fps, gpu=gpu)
        # An elementary MPEG-TS per rendition, the same intermediate the live
        # path puts on the UDP bus, so the packager sees exactly what it sees
        # live: parameter sets in band ahead of every IDR.
        path = os.path.join(work_dir, f"{label}.ts")
        cmd += ["-f", "mpegts", path]
        parts.append({"label": label, "path": path, "height": r["height"],
                      "bitrate_kbps": r["bitrate_kbps"]})

    audio_path = None
    if cfg.get("has_audio", True):
        cmd += audio_track_args(0)
        audio_path = os.path.join(work_dir, "audio.ts")
        cmd += ["-f", "mpegts", audio_path]

    return cmd, parts, audio_path


def build_package_cmd(cfg, parts, audio_path, out_dir):
    """Shaka, in VOD mode.

    --hls_playlist_type VOD and no time-shift window: the asset is complete when
    the job ends, and a LIVE playlist would advertise a sliding window over media
    that never moves, which players handle by never showing the end.
    """
    seg = cfg["segment_seconds"]
    packaging = cfg.get("packaging", "both")
    cmd = [PACKAGER_BIN]
    for p in parts:
        d = rendition_dir(out_dir, p["label"])
        cmd.append(
            f"in={p['path']},stream=video,"
            f"init_segment={d}/init.mp4,segment_template={d}/seg_$Number$.m4s")
    if audio_path:
        d = rendition_dir(out_dir, "audio")
        cmd.append(
            f"in={audio_path},stream=audio,"
            f"init_segment={d}/init.mp4,segment_template={d}/seg_$Number$.m4s,"
            f"hls_group_id=audio,hls_name=Audio")
    cmd += ["--segment_duration", str(seg), "--fragment_duration", str(seg)]
    if packaging in ("dash", "both"):
        cmd += ["--mpd_output", os.path.join(out_dir, "manifest.mpd"),
                # BOTH MANIFESTS MUST SAY VOD, and only one of them does by
                # default. Without this the MPD comes out type="dynamic" with a
                # minimumUpdatePeriod and a timeShiftBufferDepth: a LIVE manifest
                # describing a finished file. DASH players then poll for updates
                # that never arrive and compute an availability window from
                # availabilityStartTime, so seeking to the start of a twelve
                # second asset fails against a thirty minute window that does not
                # exist. The HLS playlist being right is not evidence the DASH one
                # is; they are set by different flags.
                "--generate_static_live_mpd"]
    if packaging in ("hls", "both"):
        cmd += ["--hls_master_playlist_output", os.path.join(out_dir, "master.m3u8"),
                "--hls_playlist_type", "VOD"]
    return cmd


def run(cmd, what):
    log(f"{what}: {' '.join(shlex.quote(c) for c in cmd)}")
    t0 = time.time()
    try:
        p = subprocess.run(cmd, capture_output=True, text=True)
    except FileNotFoundError:
        # A MISSING BINARY IS A DIAGNOSIS, NOT A STACK TRACE. This surfaces in
        # the job's last_error, where an operator reads it; a Python traceback
        # there tells them the encoder crashed rather than that the box is
        # missing a tool somebody can install.
        die(f"{what} could not start: {cmd[0]} is not installed or not on PATH")
    if p.returncode != 0:
        tail = (p.stderr or "").strip().splitlines()[-12:]
        die(f"{what} failed (exit {p.returncode}):\n" + "\n".join(tail), code=p.returncode or 1)
    log(f"{what} finished in {time.time() - t0:.1f}s")


def main():
    if len(sys.argv) < 2:
        die("usage: vod_encoder.py <job.json>")
    cfg = json.load(open(sys.argv[1]))
    if cfg.get("gpu"):
        # same rule as the live encoder: a profile asking for NVENC on a machine
        # without an NVIDIA GPU encodes on the CPU rather than failing outright
        probe = subprocess.run([FFMPEG_BIN, "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                                "-i", "color=s=256x144:d=0.1", "-frames:v", "1",
                                "-c:v", "h264_nvenc", "-f", "null", "-"], capture_output=True)
        if probe.returncode != 0:
            log("GPU (NVENC) requested but not available here; encoding with x264 instead")
            cfg["gpu"] = False

    src = cfg.get("input")
    if not src or not os.path.exists(src):
        die(f"source file not found: {src}")

    out_dir = cfg["out_dir"]
    os.makedirs(out_dir, exist_ok=True)
    work_dir = cfg.get("work_dir") or os.path.join(out_dir, ".enc")
    os.makedirs(work_dir, exist_ok=True)

    if cfg.get("probe_only"):
        print(json.dumps(probe(src)))
        return

    cmd, parts, audio_path = build_encode_cmd(cfg, work_dir)
    run(cmd, "encode")
    run(build_package_cmd(cfg, parts, audio_path, out_dir), "package")

    # THE INTERMEDIATES ARE NOT THE OUTPUT. Leaving them doubles the disk cost of
    # every asset, and they are worthless once the CMAF exists.
    if not cfg.get("keep_intermediates"):
        for p in parts:
            try:
                os.unlink(p["path"])
            except OSError:
                pass
        if audio_path:
            try:
                os.unlink(audio_path)
            except OSError:
                pass
        try:
            os.rmdir(work_dir)
        except OSError:
            pass

    result = {
        "ok": True,
        "out_dir": out_dir,
        "renditions": [{"label": p["label"], "height": p["height"],
                        "bitrate_kbps": p["bitrate_kbps"]} for p in parts],
        "has_audio": audio_path is not None,
        "master": os.path.join(out_dir, "master.m3u8") if cfg.get("packaging", "both") in ("hls", "both") else None,
        "mpd": os.path.join(out_dir, "manifest.mpd") if cfg.get("packaging", "both") in ("dash", "both") else None,
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
