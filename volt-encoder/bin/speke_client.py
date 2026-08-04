#!/usr/bin/env python3
"""
Minimal SPEKE v2 / CPIX client for the Volt encoder.

Shaka Packager cannot talk SPEKE/CPIX directly, so this tool performs the
CPIX POST to the key server (Axinom Key Service, or any SPEKE v2 endpoint),
parses the returned content keys, and prints a small JSON document the
orchestrator turns into Shaka raw-key flags:

    {
      "keys": [{"label": "SD", "key_id": "<hex>", "key": "<hex>"}],
      "pssh_hex": "<optional concatenated pssh boxes>",
      "hls_key_uri": "<optional FairPlay key/cert URI>"
    }

Auth: Axinom expects HTTP Basic where the credential is
base64("<tenantId>:<managementKey>"). Pass it via --auth already-encoded, or
as "tenantId:managementKey" and we encode it.

This is intentionally dependency-free (stdlib only) so the container stays
slim. Network calls go only to the operator-supplied --url (never a URL from
stream/observed content).
"""

import argparse
import base64
import json
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

    usage = ET.SubElement(root, f"{{{CPIX_NS}}}ContentKeyUsageRuleList")
    rule = ET.SubElement(usage, f"{{{CPIX_NS}}}ContentKeyUsageRule")
    rule.set("kid", kid)

    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def encode_auth(auth):
    if not auth:
        return None
    # Already base64? (contains no colon and decodes cleanly)
    if ":" in auth:
        return base64.b64encode(auth.encode()).decode()
    return auth  # assume caller passed pre-encoded token


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


def parse_cpix_response(xml_bytes):
    root = ET.fromstring(xml_bytes)
    out = {"keys": [], "pssh": {}}
    for ck in root.iter(f"{{{CPIX_NS}}}ContentKey"):
        kid = ck.get("kid", "").replace("-", "")
        key_hex = None
        for sec in ck.iter(f"{{{PSKC_NS}}}PlainValue"):
            key_hex = _hex_from_b64(sec.text.strip())
        if key_hex:
            out["keys"].append({"label": "", "key_id": kid, "key": key_hex})
    # Collect any PSSH the server returned per DRM system.
    for d in root.iter(f"{{{CPIX_NS}}}DRMSystem"):
        for pssh in d.iter(f"{{{CPIX_NS}}}PSSH"):
            if pssh.text:
                out["pssh"][d.get("systemId", "")] = _hex_from_b64(pssh.text.strip())
        for uri in d.iter(f"{{{CPIX_NS}}}HLSSignalingData"):
            pass
    if not out["keys"]:
        raise SystemExit("SPEKE response contained no content keys")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--content-id", required=True)
    ap.add_argument("--auth", default="")
    ap.add_argument("--systems", default="widevine,playready,fairplay")
    args = ap.parse_args()

    systems = [s for s in args.systems.split(",") if s]
    body = build_cpix_request(args.content_id, systems)
    try:
        resp = post_cpix(args.url, body, args.auth)
    except Exception as exc:  # noqa: BLE001 - surface any transport error
        print(f"speke_client: request failed: {exc}", file=sys.stderr)
        sys.exit(2)
    result = parse_cpix_response(resp)
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
