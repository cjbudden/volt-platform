#!/usr/bin/env python3
# ===========================================================================
#  OPERATOR SOURCE CONTROL ON A REMOTE ENCODER (switch source, force slate).
#
#  The control plane's Failover panel choice arrives on the timed-events poll
#  (`control.failover`). The encoder writes it to the control file the source
#  selector and playout read. Asserted end to end through the real pieces:
#  TriggerFeed hands the control over, apply_remote_control writes only on a
#  change, the selector's _read_override and the playout's _forced_filler see
#  it, back to auto clears the force, unknown modes are ignored, and a broken
#  control never stops the triggers.
#    python3 dev/test_source_control.py
# ===========================================================================
import importlib.util
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(HERE, "..", "bin")
sys.path.insert(0, BIN)
import source_selector  # noqa: E402
import timed_events  # noqa: E402

spec = importlib.util.spec_from_file_location("enc", os.path.join(BIN, "encoder.py"))
enc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(enc)

PASS = FAIL = 0


def ok(cond, msg, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"PASS {msg}")
    else:
        FAIL += 1
        print(f"FAIL {msg}" + (f" -- {extra}" if extra else ""))


root = tempfile.mkdtemp(prefix="volt-srcctl-", dir=os.environ.get("TMPDIR"))
enc.BASE_OUT_DIR = root
enc.OUT_DIR = os.path.join(root, "runs", "r1")
os.makedirs(enc.OUT_DIR)
logs = []
enc.log = lambda m: logs.append(m)
path = os.path.join(root, "_failover_control.json")

# the selector reads the same file, from the channel root (control_dir)
sel = source_selector.SourceSelector.__new__(source_selector.SourceSelector)
sel.control_path = path

body = {"triggers": [], "control": {"failover": {"mode": "auto", "at": None}}}
feed = timed_events.TriggerFeed("http://unused", fetch=lambda: body, on_control=enc.apply_remote_control)

ok(feed.poll_once() and not os.path.exists(path), "auto with nothing forced: no control file written")
body["control"] = {"failover": {"mode": "slate", "at": "2026-10-20T14:00:00Z", "by": "u1"}}
feed.poll_once()
ok(json.load(open(path))["mode"] == "slate" and json.load(open(path))["source"] == "control-plane", "force slate: control file written")
ok(sel._read_override() == "slate", "the source selector reads slate")
ok(enc._forced_filler() is True, "playout delivers the loop/slate (forced)")
m = os.stat(path).st_mtime_ns
feed.poll_once()
ok(os.stat(path).st_mtime_ns == m, "the same mode again is not rewritten")
body["control"] = {"failover": {"mode": "backup"}}
feed.poll_once()
ok(sel._read_override() == "backup" and enc._forced_filler() is False, "switch to backup: selector sees backup, no forced filler")
body["control"] = {"failover": {"mode": "auto"}}
feed.poll_once()
ok(sel._read_override() == "auto" and enc._forced_filler() is False, "back to auto clears the force")
body["control"] = {"failover": {"mode": "explode"}}
feed.poll_once()
ok(sel._read_override() == "auto", "an unknown mode is ignored")
body["control"] = "garbage"
ok(feed.poll_once() is True, "a malformed control never stops the triggers")
body["control"] = {"failover": {"mode": "loop"}}
enc.apply_remote_control = None  # noqa  (the feed holds its own reference)
feed.poll_once()
ok(sel._read_override() == "loop", "loop forced too")
ok(any("source control from the control plane: loop" in l for l in logs), "each change is logged")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
