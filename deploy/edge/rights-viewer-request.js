// ============================================================================
//  VOLT EDGE RIGHTS: CloudFront Function, viewer-request, cloudfront-js-2.0.
//
//  The play URL never changes (geo_rights_delivery.md): a viewer keeps
//  polling the same manifest URL, and whether they get the channel, the
//  replacement or nothing is decided HERE, on every manifest request, from
//  the viewer's country (CloudFront-Viewer-Country) and the stream's rules in
//  the KeyValueStore, which the control plane keeps current
//  (volt-app/src/services/edgeRights.ts, key "s:<stream id>"):
//
//    {"v":1,"a":["b"|"a",[cc]],"c":["b"|"a",[cc]],"w":[[from,to,"b"|"a",[cc],r]],"rp":1}
//      a   the account's restriction (block list or allow list)
//      c   the channel's own geo setting
//      w   programme windows (epoch seconds) with their own list; r=1 means
//          the programme has a replacement rather than a plain blackout
//      rp  the encoder writes replacement playlists (<name>_rp.m3u8 /
//          manifest_rp.mpd) for those windows, so a "replace" can be served
//
//  Outcomes, on .m3u8 and .mpd only (segments pass: a viewer who cannot get
//  a manifest has no segment names to ask for):
//    allow    the request goes on unchanged
//    replace  the URI is rewritten to the replacement playlist (same URL for
//             the viewer, a discontinuity in the stream, no new URL)
//    block    451, not cached. Also "replace" when the stream has no
//             replacement playlists (rp absent): never serve what the rights
//             say this viewer may not see.
//  No rules for a stream (no key) means no restriction. A store that cannot
//  be read fails OPEN for the same reason a missing key does: an outage of
//  the rules must not take every channel off air; the play gate
//  (/api/availability) still enforces on its own.
//
//  Viewer-specific access rules (entitlements, groups) need the viewer's
//  identity and stay in the play gate; they are not represented here.
// ============================================================================
import cf from 'cloudfront';

// The store's id is put in by Terraform (templatefile, edge_rights.tf).
const kvs = cf.kvs('${kvs_id}');
const STREAM = /^\/(?:channel|event)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//;

function listStops(rule, cc) {
  if (!rule) return false;
  var mode = rule[0], list = rule[1] || [];
  if (mode === 'b') return !!cc && list.indexOf(cc) >= 0;
  if (mode === 'a') return !cc || list.indexOf(cc) < 0;
  return false;
}

// "allow" | "block" | "replace"
function decide(rules, cc, nowSec) {
  if (!rules || rules.v !== 1) return 'allow';
  if (listStops(rules.a, cc)) return 'block';
  if (listStops(rules.c, cc)) return 'block';
  var w = rules.w || [];
  for (var i = 0; i < w.length; i++) {
    var x = w[i];
    if (nowSec >= x[0] && nowSec < x[1] && listStops([x[2], x[3]], cc)) {
      return x[4] ? 'replace' : 'block';
    }
  }
  return 'allow';
}

function blocked() {
  return {
    statusCode: 451,
    statusDescription: 'Unavailable For Legal Reasons',
    headers: { 'cache-control': { value: 'no-store' }, 'content-type': { value: 'text/plain' } },
    body: 'Not available in your region',
  };
}

async function handler(event) {
  var req = event.request;
  var uri = req.uri;
  if (!/\.(m3u8|mpd)$/.test(uri)) return req;
  var m = uri.match(STREAM);
  if (!m) return req;
  var raw = null;
  try {
    raw = await kvs.get('s:' + m[1]);
  } catch (e) {
    return req;            // no key (no rules) or the store is unreadable: open
  }
  var rules;
  try { rules = JSON.parse(raw); } catch (e) { return req; }
  var h = req.headers['cloudfront-viewer-country'];
  var cc = h && h.value ? h.value.toUpperCase() : '';
  var d = decide(rules, cc, Math.floor(Date.now() / 1000));
  if (d === 'allow') return req;
  if (d === 'replace' && rules.rp) {
    // a replacement playlist sits beside each delivered one
    req.uri = uri.replace(/(_cc)?\.(m3u8|mpd)$/, '_rp.$2');
    return req;
  }
  return blocked();
}
