#!/usr/bin/env python3
"""
Volt encoder event log + live status snapshot.

Two jobs:

1. A per-stream EVENT LOG. Every significant thing that happens to a channel —
   start/stop, a source going up or down, a failover switch, filler engaging or
   clearing, the packager coming up — is emitted as a single-line JSON event to
   stdout. On ECS that goes to CloudWatch Logs, giving a durable, queryable log
   per stream with no extra infrastructure.

2. A live STATUS SNAPSHOT the admin can show: is the OUTPUT still available,
   what each INPUT source's state is, and whether a FALLBACK (backup or filler)
   is currently in use. The snapshot is (a) written to a local file so a sidecar
   or health probe can read it, and (b) POSTed to the control-plane ingest
   endpoint on every change so the admin API has near-real-time state without
   polling the container. Both are best-effort and never block the media path.

The snapshot shape (also the body we POST):

    {
      "channel_id": "...",
      "output_available": true,        # is the manifest still advancing?
      "active_source": "primary",      # primary | backup | filler
      "fallback_in_use": false,        # active_source != primary
      "filler_in_use": false,          # active_source == filler
      "packager_ok": true,
      "sources": {
        "primary": {"state": "up",   "renditions": 4},
        "backup":  {"state": "down", "renditions": 2},
        "filler":  {"state": "ready"}
      },
      "seq": 42,
      "updated_at_ms": 173...          # stamped by the parent, not here
    }
"""

import json
import threading
import urllib.request


class EventLog:
    def __init__(self, channel_id, clock, report_url=None, report_token=None,
                 status_path=None, emit=print, has_backup=False, has_filler=False):
        # clock() -> float epoch ms; injected so the whole thing is testable and
        # so we don't call the blocked Date.now()/time in the sandbox tests.
        self.channel_id = channel_id
        self.clock = clock
        self.report_url = report_url
        self.report_token = report_token
        self.status_path = status_path
        self._emit = emit
        self._seq = 0
        self._lock = threading.Lock()
        self.status = {
            "channel_id": channel_id,
            "output_available": False,
            "active_source": "primary",
            "fallback_in_use": False,
            "filler_in_use": False,
            "packager_ok": False,
            "sources": {
                "primary": {"state": "unknown"},
                **({"backup": {"state": "unknown"}} if has_backup else {}),
                **({"filler": {"state": "unknown"}} if has_filler else {}),
            },
            "seq": 0,
            "updated_at_ms": None,
        }

    # -- event emission -----------------------------------------------------
    def event(self, etype, **detail):
        """Emit one structured event (to stdout / CloudWatch), report it to the
        control plane (fire-and-forget), and return it."""
        with self._lock:
            self._seq += 1
            ev = {
                "ts_ms": self.clock(),
                "channel_id": self.channel_id,
                "seq": self._seq,
                "type": etype,
                "detail": detail,
            }
        try:
            self._emit(json.dumps(ev, separators=(",", ":")))
        except Exception:
            pass
        self._report({"kind": "channel", "id": self.channel_id, "event": ev})
        return ev

    # -- status transitions (each records an event + republishes) -----------
    def channel_start(self, workflow, renditions):
        self.event("channel.start", workflow=workflow, renditions=renditions)

    def channel_stop(self, reason="server_window_closed"):
        self.status["output_available"] = False
        self.event("channel.stop", reason=reason)
        self._publish()

    def packager(self, ok):
        self.status["packager_ok"] = bool(ok)
        self.event("packager.up" if ok else "packager.down")
        self._recompute_output()
        self._publish()

    def source_state(self, group, up, renditions=None):
        """Record a source group going up/down (only emits on a real change)."""
        cur = self.status["sources"].get(group, {})
        new_state = "up" if up else "down"
        if cur.get("state") == new_state:
            return
        entry = {"state": new_state}
        if renditions is not None:
            entry["renditions"] = renditions
        self.status["sources"][group] = entry
        self.event("source.up" if up else "source.down", source=group,
                   renditions=renditions)
        self._recompute_output()
        self._publish()

    def filler_ready(self, ready=True):
        if "filler" in self.status["sources"]:
            self.status["sources"]["filler"] = {"state": "ready" if ready else "down"}

    def switch(self, old, new, reason):
        """Record a failover switch between source groups and update flags."""
        self.status["active_source"] = new
        self.status["fallback_in_use"] = new != "primary"
        self.status["filler_in_use"] = new == "filler"
        self.event("failover.switch", **{"from": old, "to": new, "reason": reason})
        if new == "filler":
            self.event("filler.engaged", reason=reason)
        elif old == "filler":
            self.event("filler.cleared", to=new)
        self._recompute_output()
        self._publish()

    # -- derived output-available + publishing ------------------------------
    def _recompute_output(self):
        active = self.status["active_source"]
        src = self.status["sources"]
        # Output is available whenever the packager is healthy AND the active
        # source is feeding the bus. Filler counts as feeding (that's its whole
        # job), so the output is only "degraded" if the packager is down or even
        # filler isn't ready while all live inputs are down.
        if not self.status["packager_ok"]:
            self.status["output_available"] = False
            return
        if active == "filler":
            self.status["output_available"] = src.get("filler", {}).get("state") != "down"
        else:
            self.status["output_available"] = src.get(active, {}).get("state") == "up"

    def snapshot(self):
        with self._lock:
            self.status["seq"] = self._seq
            self.status["updated_at_ms"] = self.clock()
            return dict(self.status)

    def _publish(self):
        snap = self.snapshot()
        if self.status_path:
            try:
                tmp = self.status_path + ".tmp"
                with open(tmp, "w") as fh:
                    json.dump(snap, fh)
                import os
                os.replace(tmp, self.status_path)
            except Exception:
                pass
        self._report({"kind": "channel", "id": self.channel_id, "status": snap})

    def _report(self, payload):
        """POST an event and/or status snapshot to the control-plane ingest
        endpoint. Fire-and-forget on a daemon thread — the media path never
        blocks or fails because the control plane is slow or down (it can always
        fall back to the local/S3 status file)."""
        if not self.report_url:
            return
        threading.Thread(target=self._post, args=(payload,), daemon=True).start()

    def _post(self, payload):
        try:
            body = json.dumps(payload).encode()
            req = urllib.request.Request(self.report_url, data=body, method="POST")
            req.add_header("Content-Type", "application/json")
            if self.report_token:
                req.add_header("X-Volt-Ingest-Token", self.report_token)
            urllib.request.urlopen(req, timeout=5).read()
        except Exception:
            pass
