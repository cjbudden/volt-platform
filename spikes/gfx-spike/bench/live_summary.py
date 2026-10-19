#!/usr/bin/env python3
import json, glob, os
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "out", "live")
for f in sorted(glob.glob(os.path.join(D, "result_*.json"))):
    r = json.load(open(f))
    print(f"\n## {r['tag']}  frames={r['frames']} alive={r['encoder_alive_at_end']} main_lat_med={r.get('main_latency_ms_median')} p95={r.get('main_latency_ms_p95')} "
          f"max_gap={r.get('max_tap_gap_ms')}ms@{r.get('max_tap_gap_at_s')}s repeated={r.get('repeated_main_frames')} gfx_lat_med={r.get('gfx_latency_ms_median_steady')} max={r.get('gfx_latency_ms_max_steady')} "
          f"after_restart={r.get('gfx_latency_ms_after_restart')} av_delta={r.get('rung0_av_start_delta_ms')} cpu={r.get('cpu')} enc_log_lines={r.get('encoder_log_lines')}")
    lat = r.get("main_latency_by_2s", {})
    bad = {k: v for k, v in lat.items() if v > 400 and int(k) > 4}
    if bad: print("   main latency spikes (2 s buckets >400 ms):", bad)
    if r.get("faults"):
        for g in r.get("gfx_change_latency", []): print("   change", g)
        for e in r.get("events", []):
            if e["ev"] == "fault": print(f"   fault @{e['t']/1000:.1f}s {e['name']}")
