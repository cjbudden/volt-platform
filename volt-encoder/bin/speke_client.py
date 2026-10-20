#!/usr/bin/env python3
"""
Minimal SPEKE v2 / CPIX client for the Volt encoder.

Shaka Packager cannot talk SPEKE/CPIX directly, so this tool performs the
CPIX POST to the key server (Axinom Key Service, or any SPEKE v2 endpoint),
parses the returned content keys, and prints a small JSON document the
encoder turns into Shaka raw-key flags (encoder.py shaka_drm_flags):

    {
      "keys": [{"label": "", "key_id": "<hex>", "key": "<hex>", "iv": "<hex, optional>"}],
      "pssh": {"<systemId>": "<hex pssh box>"},
      "pssh_hex": "<every pssh box, concatenated, for Shaka --pssh>",
      "protection_systems": "Widevine,PlayReady,FairPlay",
      "hls_key_uri": "skd://... (FairPlay key URI for EXT-X-KEY)",
      "hls_signaling": {"media": "#EXT-X-KEY:...", "master": "#EXT-X-SESSION-KEY:..."}
    }

FAIRPLAY (20 Oct 2026). The key server says where a FairPlay player gets its
key in one of two places, and the client read neither (the loop was a
`pass`), so the HLS playlists never carried a FairPlay EXT-X-KEY:
  - SPEKE v2: <cpix:HLSSignalingData playlist="media"> holds the base64 of
    the whole #EXT-X-KEY line; its URI="skd://..." is the key URI.
  - SPEKE v1 style: <speke:URIExtXKey> holds the base64 of the skd:// URI.
A per-key explicitIV is passed on as `iv`. PSSH boxes the server returned are
concatenated for Shaka, and the systems asked for become Shaka's
--protection_systems, which is what makes Shaka write the
KEYFORMAT="com.apple.streamingkeydelivery" key tag.

Auth: Axinom expects HTTP Basic where the credential is
base64("<tenantId>:<managementKey>"). Give it in the SPEKE_AUTH environment
variable (preferred: argv is visible to every process on the host) or --auth,
already encoded or as "tenantId:managementKey" and we encode it.

This is intentionally dependency-free (stdlib only) so the container stays
slim. Network calls go only to the operator-supplied --url (never a URL from
stream/observed content).
"""

import argparse
import base64
import json
import os
import re
import sys
import urllib.request
import uuid
import xml.etree.ElementTree as ET

CPIX_NS = "urn:dashif:org:cpix"
PSKC_NS = "urn:ietf:params:xml:ns:keyprov:pskc"
SPEKE_NS = "urn:aws:amazon:com:speke"

SYSTEM_IDS = {
    "widevine":  "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",
    "playready": "9a04f079-9840-4286-ab92-e65be0885f95",
    "fairplay":  "94ce86fb-07ff-4f43-adb8-93d2fa968ca2",
}
# Shaka Packager's names for the same systems (--protection_systems).
SHAKA_NAMES = {"widevine": "Widevine", "playready": "PlayReady", "fairplay": "FairPlay"}
FAIRPLAY_ID = SYSTEM_IDS["fairplay"]


def build_cpix_request(content_id, systems):
    """Construct a minimal SPEKE v2 CPIX request document."""
    ET.register_namespace("cpix", CPIX_NS)
    ET.register_namespace("speke", SPEKE_NS)
    root = ET.Element(f"{{{CPIX_NS}}}CPIX", {"id": content_id})

    kid = str(uuid.uuid4())
    klist = ET.SubElement(root, f"{{{CPIX_NS}}}ContentKeyList")
    ck = ET.SubElement(klist, f"{{{CPIX_NS}}}ContentKey")
    ck.set("kid", kid)
    ck.set("commonEncryptionScheme", "cbcs")

    drm_list = ET.SubElement(root, f"{{{CPIX_NS}}}DRMSystemList")
    for sysname in systems:
        sid = SYSTEM_IDS.get(sysname.strip().lower())
        if not sid:
            continue
        d = ET.SubElement(drm_list, f"{{{CPIX_NS}}}DRMSystem")
        d.set("kid", kid)
        d.set("systemId", sid)
        if sid == FAIRPLAY_ID:
            # Ask for the HLS signalling explicitly: some servers only return
            # what the request names.
            for playlist in ("media", "master"):
                h = ET.SubElement(d, f"{{{CPIX_NS}}}HLSSignalingData")
                h.set("playlist", playlist)

    usage = ET.SubElement(root, f"{{{CPIX_NS}}}ContentKeyUsageRuleList")
    rule = ET.SubElement(usage, f"{{{CPIX_NS}}}ContentKeyUsageRule")
    rule.set("kid", kid)

    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def encode_auth(auth):
    if not auth:
        return None
    # "tenant:key" is encoded here; anything else is taken as already encoded.
    if ":" in auth:
        return base64.b64encode(auth.encode()).decode()
    return auth


def post_cpix(url, body, auth):
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/xml")
    req.add_header("X-Speke-Version", "2.0")
    enc = encode_auth(auth)
    if enc:
        req.add_header("Authorization", f"Basic {enc}")
    with urllib.request.urlopen(req, timeout=25) as resp:
        return resp.read()


def _hex_from_b64(text):
    return base64.b64decode(text).hex()


def _text_b64(text):
    return base64.b64decode(text.strip()).decode("utf-8", "replace").strip()


def key_uri_from_ext_x_key(line):
    """URI="..." from an #EXT-X-KEY / #EXT-X-SESSION-KEY line."""
    m = re.search(r'URI="([^"]+)"', line or "")
    return m.group(1) if m else None


def parse_cpix_response(xml_bytes, systems=None):
    root = ET.fromstring(xml_bytes)
    out = {"keys": [], "pssh": {}, "hls_signaling": {}}
    for ck in root.iter(f"{{{CPIX_NS}}}ContentKey"):
        kid = ck.get("kid", "").replace("-", "").lower()
        key_hex = None
        for sec in ck.iter(f"{{{PSKC_NS}}}PlainValue"):
            key_hex = _hex_from_b64(sec.text.strip())
        if key_hex:
            k = {"label": "", "key_id": kid, "key": key_hex}
            iv = ck.get("explicitIV")
            if iv:
                k["iv"] = _hex_from_b64(iv)
            out["keys"].append(k)
    # PSSH per DRM system, and FairPlay's HLS key signalling.
    for d in root.iter(f"{{{CPIX_NS}}}DRMSystem"):
        sid = (d.get("systemId") or "").lower()
        for pssh in d.iter(f"{{{CPIX_NS}}}PSSH"):
            if pssh.text and pssh.text.strip():
                out["pssh"][sid] = _hex_from_b64(pssh.text.strip())
        for h in d.iter(f"{{{CPIX_NS}}}HLSSignalingData"):
            if h.text and h.text.strip():
                out["hls_signaling"][h.get("playlist", "media")] = _text_b64(h.text)
        for u in d.iter(f"{{{SPEKE_NS}}}URIExtXKey"):
            if u.text and u.text.strip() and sid == FAIRPLAY_ID:
                out["hls_key_uri"] = _text_b64(u.text)
    if not out["keys"]:
        raise SystemExit("SPEKE response contained no content keys")
    if "hls_key_uri" not in out:
        uri = key_uri_from_ext_x_key(out["hls_signaling"].get("media") or out["hls_signaling"].get("master"))
        if uri:
            out["hls_key_uri"] = uri
    if out["pssh"]:
        out["pssh_hex"] = "".join(out["pssh"].values())
    if systems:
        names = [SHAKA_NAMES[s.strip().lower()] for s in systems if s.strip().lower() in SHAKA_NAMES]
        if names:
            out["protection_systems"] = ",".join(names)
    if not out["hls_signaling"]:
        del out["hls_signaling"]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--content-id", required=True)
    ap.add_argument("--auth", default="", help="prefer the SPEKE_AUTH environment variable")
    ap.add_argument("--systems", default="widevine,playready,fairplay")
    args = ap.parse_args()

    systems = [s for s in args.systems.split(",") if s]
    body = build_cpix_request(args.content_id, systems)
    auth = os.environ.get("SPEKE_AUTH") or args.auth
    try:
        resp = post_cpix(args.url, body, auth)
    except Exception as exc:  # noqa: BLE001 - surface any transport error
        print(f"speke_client: request failed: {exc}", file=sys.stderr)
        sys.exit(2)
    result = parse_cpix_response(resp, systems)
    if "fairplay" in [s.lower() for s in systems] and not result.get("hls_key_uri"):
        # Encrypting for FairPlay with no key URI makes playlists no Apple
        # player can open. Refuse rather than ship that.
        print("speke_client: FairPlay was requested but the key server returned no key URI "
              "(HLSSignalingData or URIExtXKey)", file=sys.stderr)
        sys.exit(3)
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
