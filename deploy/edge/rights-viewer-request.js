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
//    {"v":1,"a":["b"|"a",[cc]],"c":["b"|"a",[cc]],
//     "w":[[from,to,"b"|"a",[cc],r,[rc]]],"vm":{"AU":"v1a2b3c4d"},"vs":1}
//      a   the account's restriction (block list or allow list)
//      c   the channel's own geo setting
//      w   programme windows (epoch seconds) with their own list; r=1 means
//          the programme has a replacement rather than a plain blackout;
//          the optional 6th element lists rights classes exempt from it
//      vm  audience ("AU", "*" for any other country, "AU/<class>",
//          "*/<class>") to variant key: every audience whose replace
//          timeline is the same shares one variant (EDGE_RIGHTS_VARIANTS.md)
//      vs  the variant manifest service answers /v/<key>/
//
//  The viewer's rights class comes from a signed claim, `vrc` in the query
//  or a cookie: "<class>.<exp>.<sig>", sig = first 32 hex of
//  HMAC-SHA256(key, "<stream id>|<class>|<exp>") with the key at "k:rc".
//  No claim, a forged or expired one, or no key: the default class.
//
//  Outcomes, on .m3u8 and .mpd only (segments pass: a viewer who cannot get
//  a manifest has no segment names to ask for):
//    allow          the request goes on unchanged
//    replace:<key>  the URI is rewritten to /<kind>/<id>/v/<key>/<file>
//                   (same URL for the viewer, no new URL) and sent to the
//                   variant manifest service's origin ("variants")
//    block          451, not cached. Also a replace with no variant for the
//                   audience or no variant service (vs absent): never serve
//                   what the rights say this viewer may not see.
//  A request that names a variant itself (/v/<key>/...) is served only to a
//  viewer this function would send there: the variant carries the main
//  stream outside its windows, so it must not be a way round a block.
//  No rules for a stream (no key) means no restriction. A store that cannot
//  be read fails OPEN for the same reason a missing key does: an outage of
//  the rules must not take every channel off air; the play gate
//  (/api/availability) still enforces on its own.
//
//  Viewer-specific access rules (entitlements, groups) need the viewer's
//  identity and stay in the play gate; they are not represented here.
// ============================================================================
import cf from 'cloudfront';
import crypto from 'crypto';

// The store's id is put in by Terraform (templatefile, edge_rights.tf).
const kvs = cf.kvs('${kvs_id}');
const STREAM = /^\/(channel|event)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(?:v\/(v[0-9a-f]{8})\/)?(.*)$/;

function listStops(rule, cc) {
  if (!rule) return false;
  var mode = rule[0], list = rule[1] || [];
  if (mode === 'b') return !!cc && list.indexOf(cc) >= 0;
  if (mode === 'a') return !cc || list.indexOf(cc) < 0;
  return false;
}

// "allow" | "block" | "replace" for a country and rights class
function decideFor(rules, cc, rc, nowSec) {
  if (!rules || rules.v !== 1) return 'allow';
  if (listStops(rules.a, cc)) return 'block';
  if (listStops(rules.c, cc)) return 'block';
  var w = rules.w || [];
  for (var i = 0; i < w.length; i++) {
    var x = w[i];
    if (nowSec >= x[0] && nowSec < x[1] && listStops([x[2], x[3]], cc) && !(rc && x[5] && x[5].indexOf(rc) >= 0)) {
      return x[4] ? 'replace' : 'block';
    }
  }
  return 'allow';
}

// the default class (no claim)
function decide(rules, cc, nowSec) { return decideFor(rules, cc, '', nowSec); }

function variantFor(vm, cc, rc) {
  if (!vm) return null;
  return (cc && rc && vm[cc + '/' + rc]) || (cc && vm[cc]) || (rc && vm['*/' + rc]) || vm['*'] || null;
}

// "allow" | "block" | "replace:<key>"
function edgeDecision(rules, cc, rc, nowSec) {
  var d = decideFor(rules, cc, rc, nowSec);
  if (d !== 'replace') return d;
  var k = variantFor(rules.vm, cc, rc);
  return k && rules.vs ? 'replace:' + k : 'block';
}

// the rights class a claim proves, or '' (CloudFront Functions has no
// constant-time compare; the claim is short-lived and tied to one stream)
function claimClass(value, id, key, nowSec) {
  var m = /^([a-z0-9_-]{1,16})\.(\d{1,12})\.([0-9a-f]{32})$/.exec(value || '');
  if (!m || !key || !(Number(m[2]) > nowSec)) return '';
  var want = crypto.createHmac('sha256', key).update(id + '|' + m[1] + '|' + m[2]).digest('hex').slice(0, 32);
  return want === m[3] ? m[1] : '';
}

function claimOf(req) {
  var q = req.querystring && req.querystring.vrc;
  if (q && q.value) return q.value;
  var c = req.cookies && req.cookies.vrc;
  return c && c.value ? c.value : '';
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
    raw = await kvs.get('s:' + m[2]);
  } catch (e) {
    return req;            // no key (no rules) or the store is unreadable: open
  }
  var rules;
  try { rules = JSON.parse(raw); } catch (e) { return req; }
  var h = req.headers['cloudfront-viewer-country'];
  var cc = h && h.value ? h.value.toUpperCase() : '';
  var now = Math.floor(Date.now() / 1000);
  var rc = '';
  var claim = claimOf(req);
  if (claim) {
    var key = null;
    try { key = await kvs.get('k:rc'); } catch (e) { key = null; }
    rc = claimClass(claim, m[2], key, now);
  }
  var d = edgeDecision(rules, cc, rc, now);
  if (m[3]) return d === 'replace:' + m[3] ? toVariants(req) : blocked();
  if (d === 'allow') return req;
  if (d.indexOf('replace:') === 0) {
    req.uri = '/' + m[1] + '/' + m[2] + '/v/' + d.slice(8) + '/' + m[4];
    return toVariants(req);
  }
  return blocked();
}

// A variant is made by the manifest service, not stored in S3: send the
// rewritten request to its origin (id "variants", deploy/terraform). The
// behaviour was chosen before this function ran, so the origin is picked here.
function toVariants(req) {
  if (cf.selectRequestOriginById) cf.selectRequestOriginById('variants');
  return req;
}
