"""Packager log filter: the harmless AAC rounding gap is summarised, real gaps never are.
Usage: python3 -m pytest dev/test_packager_log.py -q   (no ffmpeg, no network)"""
import os
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin"))
import packager_log as pl

# Verbatim shape of the line Shaka prints (from a live run, 17 Oct 2026).
LINE = ("W1017 12:48:41.761345 7871910 representation.cc:435] Representation "
        "(id=1,codec='mp4a.40.2',frequency=44100,language='') Found a gap of size {} > "
        "kRoundingErrorGrace (5). The new segment starts at 289801084 but the previous "
        "segment ends at 289800947.")


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def test_first_shown_then_summarised():
    c = Clock()
    f = pl.PackagerLogFilter("summary", clock=c)
    first = f.feed(LINE.format(137))
    assert first[0] == LINE.format(137) and "rounding" in first[1]
    for g in (136, 138, 137):
        assert f.feed(LINE.format(g)) == []
    c.t = 61
    out = f.feed(LINE.format(137))
    assert len(out) == 1 and "4 audio rounding gaps of 136-138 ticks" in out[0]


def test_a_whole_frame_or_more_is_always_shown():
    for mode in ("summary", "quiet"):
        f = pl.PackagerLogFilter(mode, clock=Clock())
        f.feed(LINE.format(137))
        assert f.feed(LINE.format(2100)) == [LINE.format(2100)]   # > 2089.8 ticks
        assert f.feed(LINE.format(-50)) == [LINE.format(-50)]


def test_a_changed_pattern_is_shown():
    f = pl.PackagerLogFilter("summary", clock=Clock())
    for g in (137, 137, 136):
        f.feed(LINE.format(g))
    assert f.feed(LINE.format(900)) == [LINE.format(900)]


def test_quiet_hides_even_the_first():
    f = pl.PackagerLogFilter("quiet", clock=Clock())
    assert f.feed(LINE.format(137)) == []
    assert "1 audio rounding gaps" in f.flush()[0]


def test_all_passes_everything_and_other_lines_untouched():
    f = pl.PackagerLogFilter("all", clock=Clock())
    assert f.feed(LINE.format(137)) == [LINE.format(137)]
    g = pl.PackagerLogFilter("summary", clock=Clock())
    other = "E1017 12:49:05 mp2t_media_parser.cc:200] PES error"
    assert g.feed(other) == [other]


def test_mode_resolution():
    assert pl.resolve_mode() == "summary"
    assert pl.resolve_mode("quiet") == "quiet"
    assert pl.resolve_mode("quiet", "ALL") == "all"     # env wins
    assert pl.resolve_mode("nonsense") == "summary"
