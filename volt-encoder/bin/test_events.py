#!/usr/bin/env python3
"""Deterministic tests for the encoder event log + status snapshot.
Run: python3 bin/test_events.py"""
import sys, json
sys.path.insert(0, "bin"); sys.path.insert(0, ".")
import events as ev

FAILS = []
def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond: FAILS.append(name)

class Clock:
    def __init__(self): self.t = 1000
    def __call__(self): self.t += 1; return self.t

def new_log(**kw):
    emitted = []
    log = ev.EventLog("chan-1", Clock(), emit=emitted.append, **kw)
    return log, emitted

def parse(emitted):
    return [json.loads(e) for e in emitted]

# events are structured JSON with monotonically increasing seq
def test_event_shape_and_seq():
    log, em = new_log()
    log.channel_start("package_only", 4)
    log.packager(True)
    evs = parse(em)
    check("channel.start emitted first", evs[0]["type"] == "channel.start")
    check("carries channel_id", evs[0]["channel_id"] == "chan-1")
    check("detail captured", evs[0]["detail"]["workflow"] == "package_only")
    check("seq increments", [e["seq"] for e in evs] == list(range(1, len(evs) + 1)))
    check("has ts_ms", all("ts_ms" in e for e in evs))

# output not available until packager up AND a source is up
def test_output_availability():
    log, em = new_log(has_backup=True, has_filler=True)
    check("start: output down", log.status["output_available"] is False)
    log.packager(True)
    check("packager up but no source yet -> still down", log.status["output_available"] is False)
    log.source_state("primary", True, 4)
    check("primary up + packager -> output available", log.status["output_available"] is True)
    log.packager(False)
    check("packager down -> output unavailable", log.status["output_available"] is False)

# a failover to backup sets fallback_in_use but keeps output available
def test_failover_flags():
    log, em = new_log(has_backup=True, has_filler=True)
    log.packager(True)
    log.source_state("primary", True, 4)
    log.source_state("backup", True, 2)
    log.switch("primary", "backup", "primary_lost")
    check("fallback_in_use on backup", log.status["fallback_in_use"] is True)
    check("filler_in_use false on backup", log.status["filler_in_use"] is False)
    check("active=backup", log.status["active_source"] == "backup")
    check("output still available on backup", log.status["output_available"] is True)
    types = [e["type"] for e in parse(em)]
    check("failover.switch logged", "failover.switch" in types)

# filler engaged: filler_in_use, output stays available while filler ready
def test_filler_engaged():
    log, em = new_log(has_backup=True, has_filler=True)
    log.packager(True)
    log.filler_ready(True)
    log.switch("backup", "filler", "all_inputs_lost")
    check("filler_in_use", log.status["filler_in_use"] is True)
    check("fallback_in_use (filler counts)", log.status["fallback_in_use"] is True)
    check("output available while filler ready", log.status["output_available"] is True)
    types = [e["type"] for e in parse(em)]
    check("filler.engaged logged", "filler.engaged" in types)
    # clearing back to primary
    log.source_state("primary", True, 4)
    log.switch("filler", "primary", "primary_recovered")
    check("filler.cleared logged", "filler.cleared" in [e["type"] for e in parse(em)])
    check("back to primary, no fallback", log.status["fallback_in_use"] is False)

# source_state only emits on change (no duplicate spam)
def test_source_state_dedup():
    log, em = new_log(has_backup=True)
    log.packager(True)
    log.source_state("primary", True, 4)
    n1 = len(em)
    log.source_state("primary", True, 4)   # same -> no event
    check("duplicate source.up suppressed", len(em) == n1)
    log.source_state("primary", False, 4)  # change -> event
    check("source.down emitted on change", len(em) == n1 + 1)

# snapshot is JSON-serialisable and carries the flags the admin needs
def test_snapshot_contract():
    log, em = new_log(has_backup=True, has_filler=True)
    log.packager(True); log.source_state("primary", True, 4)
    snap = log.snapshot()
    json.dumps(snap)  # must not raise
    for k in ("channel_id","output_available","active_source","fallback_in_use",
              "filler_in_use","packager_ok","sources","seq","updated_at_ms"):
        check(f"snapshot has {k}", k in snap)
    check("sources has primary/backup/filler", set(snap["sources"]) == {"primary","backup","filler"})

# status file is written atomically on publish
def test_status_file(tmp="/tmp/volt_status_test.json"):
    import os
    if os.path.exists(tmp): os.remove(tmp)
    log, em = new_log(has_backup=True, status_path=tmp)
    log.packager(True); log.source_state("primary", True, 4)
    check("status file written", os.path.exists(tmp))
    with open(tmp) as fh: disk = json.load(fh)
    check("status file reflects output_available", disk["output_available"] is True)

for fn in list(globals().values()):
    if callable(fn) and getattr(fn, "__name__", "").startswith("test_"):
        fn()
print("\n" + ("ALL PASSED" if not FAILS else f"{len(FAILS)} FAILED: {FAILS}"))
sys.exit(1 if FAILS else 0)
