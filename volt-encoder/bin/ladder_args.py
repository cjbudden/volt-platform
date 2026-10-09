"""Shared ladder encoder settings — imported by the live encoder and the file encoder.

Its own module, with NO import-time side effects, so the file encoder can use it
without pulling in the live encoder's environment, its source selector, or its
working directory. That is not tidiness: a shared definition that is expensive to
import is a shared definition somebody eventually copies.
"""

# ---------------------------------------------------------------------------
#  THE LADDER'S ENCODER SETTINGS — ONE DEFINITION, LIVE AND FILE.
#
#  These arguments used to live inline in start_transcode, which was fine while
#  live was the only thing that encoded. It is not any more: a file dropped in a
#  watchfolder or uploaded in the console is encoded to the SAME ladder, and the
#  requirement is that it match — same bitrates, same rate control, same GOP, so
#  a VOD asset and a live rendition of the same channel are the same picture at
#  the same cost and cut at the same boundaries.
#
#  A SECOND COPY OF THIS WOULD BE WRONG WITHIN A MONTH. Somebody tunes maxrate
#  for live, VOD keeps 1.1x, and nothing fails: both encodes succeed, both look
#  plausible, and the only symptom is that the two disagree. So there is one
#  definition and both callers use it, and dev/test_ladder_args.py fails if a
#  third caller starts building these by hand.
#
#  WHY EACH ONE IS WHAT IT IS:
#    maxrate 1.1x   a 10% ceiling over target: enough headroom for a hard scene
#                   without letting a rung exceed the bandwidth it advertises in
#                   the manifest, which is what makes ABR switching decisions wrong.
#    bufsize 2x     two seconds of VBV at the target rate. Smaller starves hard
#                   cuts; larger lets the instantaneous rate drift far enough from
#                   the advertised one that a player mis-estimates.
#    g = seg x fps  the GOP is exactly one segment, so every segment starts on an
#                   IDR. This is what makes the renditions switchable at all.
#    sc_threshold 0 closed GOP: no scene-cut keyframes, or the rungs place their
#                   IDRs differently and a switch lands mid-GOP.
#    force_key_frames  belt and braces with the above, on wall time rather than
#                   frame count, so a variable-fps source still aligns.
#    -an            video only; audio is a separate elementary stream so the
#                   packager can offer it as its own track.
# ---------------------------------------------------------------------------
def gop_for(seg, fps):
    """Frames per GOP: exactly one segment, which is what aligns the renditions."""
    return int(seg * fps)


def video_rung_args(r, *, seg, fps, gpu=False, vf=None):
    """One ladder rung's video encoder arguments, WITHOUT the output target.

    `vf` overrides the scale filter (the watermark overlay chain already contains
    its own scale); pass None for a plain rung.
    """
    gop = gop_for(seg, fps)
    vcodec = ["-c:v", "h264_nvenc", "-preset", "p4"] if gpu else \
             ["-c:v", "libx264", "-preset", "veryfast"]
    return (["-map", "0:v:0"]
            # `is not None`, not truthiness: the filter graph is correctness-critical
            # and must not be defeated by a caller that passes an empty string.
            + ["-vf", vf if vf is not None else f"scale=-2:{r['height']}"]
            + vcodec
            + ["-b:v", f"{r['bitrate_kbps']}k",
               "-maxrate", f"{int(r['bitrate_kbps']*1.1)}k",
               "-bufsize", f"{r['bitrate_kbps']*2}k",
               "-g", str(gop), "-keyint_min", str(gop),
               "-sc_threshold", "0",           # closed GOP, no scene-cut
               "-force_key_frames", f"expr:gte(t,n_forced*{seg})",
               "-r", str(fps),
               "-an"])                         # video-only; audio is separate


def audio_track_args(index):
    """One source audio track's encoder arguments, WITHOUT the output target.

    The `?` on the map makes the track optional: a source that claims three
    tracks and delivers two must not take the whole encode down.
    """
    return ["-map", f"0:a:{index}?", "-c:a", "aac", "-b:a", "128k", "-ac", "2"]
