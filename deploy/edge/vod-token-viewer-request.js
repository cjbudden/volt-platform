// ============================================================================
//  VOLT EDGE PLAY TOKENS: CloudFront Function, viewer-request, cloudfront-js-2.0,
//  on the /t/* behaviours (deploy/terraform/edge_tokens.tf).
//
//  The play gate hands out on-demand URLs with a signed token in the path,
//  /t/<token>/vod/<id>/master.m3u8 (volt-app/src/services/edgeTokens.ts, build
//  queue P2). Segments are named relatively in every manifest, so each segment
//  request carries the token too. Here, on every manifest AND segment request:
//
//    token   "<claims>.<sig>": claims base64url JSON, sig the first 32 hex of
//            HMAC-SHA256(key, claims), key at "k:pt" in the KeyValueStore
//    refuse  403 a bad signature, not yet valid (more than 60 s early),
//            expired, a path outside the token's folder (p), a viewer
//            country other than the token's (c: a URL shared across a
//            border), or a token issued at or before the asset's revocation
//            time ("r:<asset id>", written when a title stops being public
//            before its window ends)
//    pass    strip /t/<token> and go on to S3 with the plain path, so the
//            cache key is the plain path and viewers share every segment
//
//  SHARED TOKENS (build queue P2-2f): claims {k:"shared", A:[32 hex ids], n, e}
//  open /vod/<id>/ and /clips/vod/<id>/ of each title named, for any viewer
//  (no country); the revocation checked is the path's title's.
//
//  No key in the store (only before the control plane's first sync): 503 Try
//  again shortly. Not "open content plays": without the key the claims cannot
//  be trusted, so a forged "open" token would open anything. A revocation that
//  cannot be read counts as none: the token's own expiry still holds.
// ============================================================================
import cf from 'cloudfront';
import crypto from 'crypto';

const kvs = cf.kvs('${kvs_id}');
const TOK = /^\/t\/([A-Za-z0-9_-]{8,2048})\.([0-9a-f]{32})(\/.*)$/;
const SHARED = /^\/(?:clips\/vod|vod)\/([0-9a-fA-F-]{36})\//;

function refuse(code, text) {
  return {
    statusCode: code,
    statusDescription: code === 403 ? 'Forbidden' : 'Service Unavailable',
    headers: { 'cache-control': { value: 'no-store' }, 'content-type': { value: 'text/plain' } },
    body: text,
  };
}

function claimsOf(body) {
  try {
    var s = body.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
  } catch (e) {
    return null;
  }
}

async function handler(event) {
  var req = event.request;
  var m = TOK.exec(req.uri);
  if (!m) return refuse(403, 'Not available');
  var key = null;
  try { key = await kvs.get('k:pt'); } catch (e) { key = null; }
  if (!key) return refuse(503, 'Try again shortly');
  var want = crypto.createHmac('sha256', key).update(m[1]).digest('hex').slice(0, 32);
  if (want !== m[2]) return refuse(403, 'Not available');
  var c = claimsOf(m[1]);
  var uri = m[3];
  var title = null;
  if (c && c.k === 'shared') {
    if (!Array.isArray(c.A)) return refuse(403, 'Not available');
  } else if (!c || typeof c.p !== 'string' || typeof c.a !== 'string') return refuse(403, 'Not available');
  var now = Math.floor(Date.now() / 1000);
  if (now + 60 < c.n || !(now < c.e)) return refuse(403, 'This link has expired');
  if (c.k === 'shared') {
    var sm = SHARED.exec(uri);
    if (!sm || uri.indexOf('/../') >= 0 || c.A.indexOf(sm[1].replace(/-/g, '').toLowerCase()) < 0) return refuse(403, 'Not available');
    title = sm[1].toLowerCase();
  } else {
    if (!c.p || uri.indexOf(c.p) !== 0 || uri.indexOf('/../') >= 0) return refuse(403, 'Not available');
    var h = req.headers['cloudfront-viewer-country'];
    var cc = h && h.value ? h.value.toUpperCase() : '';
    if (c.c && cc && c.c !== cc) return refuse(403, 'Not available in your region');
    title = c.a;
  }
  var rv = null;
  try { rv = await kvs.get('r:' + title); } catch (e) { rv = null; }
  if (rv && c.n <= Number(rv)) return refuse(403, 'No longer available');
  req.uri = uri;
  return req;
}
