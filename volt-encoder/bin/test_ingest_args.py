"""Checks for ingest_args.py: python3 test_ingest_args.py"""
import os
import tempfile
import ingest_args as ia

ok = bad = 0


def check(name, cond, detail=""):
    global ok, bad
    if cond:
        ok += 1; print("PASS", name)
    else:
        bad += 1; print("FAIL", name, detail)


u = ia.srt_url("srt://src.example.com:9000", {"mode": "caller", "latency": 200, "passphrase": "abcdefghijk", "pbkeylen": "32", "streamid": "#!::r=live/m1"})
check("SRT: mode, latency in microseconds, passphrase, key length, stream id", all(x in u for x in ["mode=caller", "latency=200000", "passphrase=abcdefghijk", "pbkeylen=32", "streamid=#!::r=live/m1"]), u)
u2 = ia.srt_url("srt://src.example.com:9000?latency=500000", {"latency": 200})
check("SRT: a value written in the URL by hand wins", "latency=500000" in u2 and u2.count("latency") == 1, u2)
check("SRT: no passphrase, no key length", "pbkeylen" not in ia.srt_url("srt://h:1", {"pbkeylen": "32"}))
a = ia.open_args({"protocol": "srt", "url": "srt://0.0.0.0:9000", "params": {"mode": "listener"}}, "/tmp")
check("SRT listener opens with mode=listener", a[-1].startswith("srt://0.0.0.0:9000") and "mode=listener" in a[-1], a)
check("RTMP opens the URL as given", ia.open_args({"protocol": "rtmp", "url": "rtmp://h/live/key"}, "/tmp")[-1] == "rtmp://h/live/key")
d = ia.open_args({"protocol": "dash", "url": "https://c/x.mpd"}, "/tmp")
check("DASH reconnects like HLS", "-reconnect" in d and d[-1] == "https://c/x.mpd", d)

with tempfile.TemporaryDirectory() as w:
    cfg = ia.write_ndi_config({"groups": "studio", "discoveryServer": "10.0.0.5:5959"}, w)
    import json
    j = json.load(open(os.path.join(cfg, "ndi-config.v1.json")))
    check("NDI: groups and discovery server go in the SDK config", j == {"ndi": {"networks": {"discovery": "10.0.0.5:5959"}, "groups": {"recv": "studio"}}}, j)
    check("NDI: no config when there is nothing to set", ia.write_ndi_config({}, w) is None)
    ia._ndi_support = False
    try:
        ia.open_args({"protocol": "ndi", "url": "PC (Cam)", "params": {}}, w)
        check("NDI: an ffmpeg without NDI is refused with the reason", False)
    except RuntimeError as e:
        check("NDI: an ffmpeg without NDI is refused with the reason", "no NDI support" in str(e))
    ia._ndi_support = True
    env = {}
    n = ia.open_args({"protocol": "ndi", "url": "PC (Cam)", "params": {"extraIps": "10.0.1.2, 10.0.1.3", "groups": "g"}}, w, env=env)
    check("NDI: libndi input, extra IPs, the source name", n[:2] == ["-f", "libndi_newtek"] and "10.0.1.2,10.0.1.3" in n and n[-1] == "PC (Cam)" and "NDI_CONFIG_DIR" in env, n)

    s = ia.open_args({"protocol": "st2110", "url": "239.1.1.1:5000", "params": {"sdp": "v=0\r\no=- 1 1 IN IP4 10.0.0.1\r\nm=video 5000 RTP/AVP 96", "interfaceIp": "192.168.50.10"}}, w, idx=2)
    check("ST 2110: the SDP is written and opened over RTP on the interface", s[-1].endswith("st2110-2.sdp") and "-localaddr" in s and "192.168.50.10" in s and "sdp" in s, s)
    check("ST 2110: SDP text kept with LF endings", open(s[-1]).read().startswith("v=0\no=- 1 1"))
    p = ia.write_sdp({"sdp": "https://x/flows.sdp"}, w, 3, fetch=lambda u: "v=0\nm=video 5000 RTP/AVP 96")
    check("ST 2110: an SDP URL is fetched", open(p).read().startswith("v=0"))
    try:
        ia.write_sdp({"sdp": "nonsense"}, w, 4)
        check("ST 2110: text that is not an SDP is refused", False)
    except ValueError:
        check("ST 2110: text that is not an SDP is refused", True)

check("packaging encodes NDI and ST 2110, copies the rest", ia.needs_encode({"protocol": "ndi"}) and ia.needs_encode({"protocol": "st2110"}) and not ia.needs_encode({"protocol": "srt"}))
e = ia.encode_rendition_args({"rendition_label": "720p", "bitrate_kbps": 2800, "_seg": 4, "_fps": 25})
check("the encoded rendition: its height, bitrate, one segment per GOP", "scale=-2:720" in e and "2800k" in e and e[e.index("-g") + 1] == "100", e)
check("audio only on the rendition that carries it", "-an" in ia.encode_rendition_args({"rendition_label": "480p", "has_audio": False}))
print(f"\ningest_args: {ok} passed, {bad} failed")
raise SystemExit(1 if bad else 0)
