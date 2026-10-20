#!/usr/bin/env python3
"""
Volt encoder health and metrics endpoint.

The control plane already hears from a running encoder (events.py posts a
status every ten seconds), but nothing ON the box could answer "is this
container healthy" for the orchestrator's health check, or be scraped by
Prometheus / CloudWatch agent / Grafana Alloy. This serves three things on
HEALTH_PORT (off unless set), from data the encoder already holds:

  GET /healthz   LIVENESS. 200 while the supervisor loop is turning and every
                 critical child (packager, transcoder, uploader) is running;
                 503 with the reasons otherwise. This is the one an ECS
                 container health check should use: failing it means a restart
                 would help.
  GET /readyz    READINESS. 200 when viewers are getting pictures: the output
                 is available (live source or filler) and the newest segment is
                 fresh (within three segment durations). 503 with the reasons
                 otherwise. A source outage with no filler fails this but not
                 /healthz, because restarting the container would not bring the
                 source back.
  GET /metrics   Prometheus text format: up, children, active source, filler,
                 output, segment age, CPU and ingest bits per second.
  GET /status    the same status snapshot the control plane receives, as JSON.

Stdlib only. Binds to HEALTH_BIND (default 0.0.0.0) because the health check
and the scraper are outside the container; it serves no secrets (the status
snapshot never carries keys or source credentials).
"""

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOOP_STALE_S = 30.0


def _esc(v):
    return str(v).replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")


def liveness(snap, now=None):
    """(ok, reasons) for /healthz."""
    now = time.time() if now is None else now
    reasons = []
    beat = snap.get("loop_beat")
    if beat is None or now - beat > LOOP_STALE_S:
        reasons.append("supervisor loop not turning" + (f" for {now - beat:.0f}s" if beat else ""))
    for name, alive, critical in snap.get("children", []):
        if critical and not alive:
            reasons.append(f"critical process {name} has exited")
    return (not reasons, reasons)


def readiness(snap, now=None):
    """(ok, reasons) for /readyz."""
    now = time.time() if now is None else now
    ok, reasons = liveness(snap, now)
    st = snap.get("status") or {}
    if st.get("packager_ok") is False:
        reasons.append("packager not running")
    if st.get("output_available") is False:
        reasons.append(f"no output: active source {st.get('active_source', 'unknown')} is down and no filler is on air")
    seg_s = float(snap.get("segment_seconds") or 4)
    age = snap.get("segment_age_s")
    if age is None:
        reasons.append("no segment written yet")
    elif age > 3 * seg_s:
        reasons.append(f"newest segment is {age:.0f}s old (limit {3 * seg_s:.0f}s)")
    return (not reasons, reasons)


def render_metrics(snap, now=None):
    """Prometheus text exposition (version 0.0.4)."""
    now = time.time() if now is None else now
    st = snap.get("status") or {}
    stream = _esc(snap.get("stream_id") or st.get("stream_id") or "")
    lab = f'stream="{stream}"'
    live_ok, _ = liveness(snap, now)
    ready_ok, _ = readiness(snap, now)
    out = []

    def metric(name, help_, typ, rows):
        out.append(f"# HELP {name} {help_}")
        out.append(f"# TYPE {name} {typ}")
        for labels, value in rows:
            if value is None:
                continue
            out.append(f"{name}{{{labels}}} {float(value):g}" if labels else f"{name} {float(value):g}")

    metric("volt_encoder_up", "1 when the supervisor loop and every critical process are running.", "gauge", [(lab, 1 if live_ok else 0)])
    metric("volt_encoder_ready", "1 when viewers are getting fresh segments.", "gauge", [(lab, 1 if ready_ok else 0)])
    metric("volt_encoder_child_up", "1 per running child process.", "gauge",
           [(f'{lab},name="{_esc(n)}",critical="{"true" if c else "false"}"', 1 if a else 0) for n, a, c in snap.get("children", [])])
    active = st.get("active_source")
    metric("volt_encoder_active_source", "1 for the source group now on air (primary, backup or filler).", "gauge",
           [(f'{lab},source="{_esc(g)}"', 1 if g == active else 0) for g in sorted(set(list((st.get("sources") or {}).keys()) + ([active] if active else [])))])
    metric("volt_encoder_source_up", "1 per source group that is receiving.", "gauge",
           [(f'{lab},source="{_esc(g)}"', 1 if (s or {}).get("state") in ("up", "ready") else 0) for g, s in sorted((st.get("sources") or {}).items())])
    metric("volt_encoder_filler_in_use", "1 while the slate or loop is on air.", "gauge", [(lab, 1 if st.get("filler_in_use") else 0)])
    metric("volt_encoder_output_available", "1 when the output has a picture (live or filler).", "gauge",
           [(lab, None if st.get("output_available") is None else (1 if st.get("output_available") else 0))])
    metric("volt_encoder_segment_age_seconds", "Seconds since the newest media segment was written.", "gauge", [(lab, snap.get("segment_age_s"))])
    m = snap.get("metrics") or st.get("metrics") or {}
    metric("volt_encoder_cpu_percent", "CPU used by the encoder and its children, as a share of what it may use.", "gauge", [(lab, m.get("cpu_pct"))])
    metric("volt_encoder_cpu_cores", "CPU cores this encoder may use.", "gauge", [(lab, m.get("cpu_cores"))])
    metric("volt_encoder_ingest_bits_per_second", "Bits per second received per input.", "gauge",
           [(f'{lab},input="{_esc(k)}",role="{_esc((v or {}).get("role") or "")}"', (v or {}).get("bps")) for k, v in sorted((m.get("ingest") or {}).items())])
    metric("volt_encoder_ingest_bytes_total", "Bytes received per input since the encoder started.", "counter",
           [(f'{lab},input="{_esc(k)}",role="{_esc((v or {}).get("role") or "")}"', (v or {}).get("bytes")) for k, v in sorted((m.get("ingest") or {}).items())])
    started = snap.get("started_at")
    metric("volt_encoder_uptime_seconds", "Seconds since the encoder started.", "gauge", [(lab, (now - started) if started else None)])
    return "\n".join(out) + "\n"


class _Handler(BaseHTTPRequestHandler):
    snapshot = staticmethod(lambda: {})

    def log_message(self, *a):  # the encoder's own log stays readable
        pass

    def _send(self, code, body, ctype):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: N802
        path = self.path.split("?", 1)[0]
        try:
            snap = self.snapshot()
        except Exception as exc:  # noqa: BLE001
            return self._send(503, json.dumps({"ok": False, "reasons": [f"snapshot failed: {exc}"]}), "application/json")
        if path == "/healthz":
            ok, reasons = liveness(snap)
            return self._send(200 if ok else 503, json.dumps({"ok": ok, "reasons": reasons}), "application/json")
        if path == "/readyz":
            ok, reasons = readiness(snap)
            return self._send(200 if ok else 503, json.dumps({"ok": ok, "reasons": reasons}), "application/json")
        if path == "/metrics":
            return self._send(200, render_metrics(snap), "text/plain; version=0.0.4; charset=utf-8")
        if path == "/status":
            return self._send(200, json.dumps(snap.get("status") or {}, default=str), "application/json")
        return self._send(404, json.dumps({"error": "not found", "paths": ["/healthz", "/readyz", "/metrics", "/status"]}), "application/json")


def start(port, snapshot, bind="0.0.0.0"):
    """Serve in a daemon thread. Returns the server (server.server_address[1] is the port)."""
    handler = type("VoltHealthHandler", (_Handler,), {"snapshot": staticmethod(snapshot)})
    srv = ThreadingHTTPServer((bind, int(port)), handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, name="health", daemon=True).start()
    return srv
