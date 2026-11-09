// ============================================================================
//  VOLT EDGE PLAY TOKENS on the staging edge (nginx njs): the Mac's stand-in
//  for deploy/edge/vod-token-viewer-request.js, the same checks in the same
//  order (volt-app/src/services/edgeTokens.ts, build queue P2).
//
//  nginx.conf.template: `js_set $edge_token edgetoken.verdict;` and, in the
//  /t/ location, refuse unless the verdict is "ok", then strip /t/<token> and
//  pass the plain path to api-public (/clips/...).
//
//  The keys the CloudFront KeyValueStore holds ("k:pt" the signing key,
//  "r:<asset id>" revocations) come from a JSON file the scheduler writes on
//  the shared volume (EDGE_STORE_FILE, default /data/edge/store.json). The
//  viewer's country is the X-Test-Country header, as everywhere on staging.
//
//  Verdicts: "ok", "403" (bad, expired, wrong folder, wrong country, revoked),
//  "503" (no key yet: the scheduler has not synced).
// ============================================================================
import fs from 'fs';
import crypto from 'crypto';

var TOK = /^\/t\/([A-Za-z0-9_-]{8,2048})\.([0-9a-f]{32})(\/.*)$/;

function storePath() {
  return (process.env && process.env.EDGE_STORE_FILE) || '/data/edge/store.json';
}

function readStore() {
  try { return JSON.parse(fs.readFileSync(storePath(), 'utf8')); } catch (e) { return {}; }
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

// uri: the request path; cc: the viewer's country; store: the keys; now: epoch seconds
function check(uri, cc, store, now) {
  var m = TOK.exec(uri);
  if (!m) return '403';
  var c = claimsOf(m[1]);
  if (!c || typeof c.p !== 'string' || typeof c.a !== 'string') return '403';
  var key = store['k:pt'];
  if (!key) return '503';
  var want = crypto.createHmac('sha256', key).update(m[1]).digest('hex').slice(0, 32);
  if (want !== m[2]) return '403';
  if (now + 60 < c.n || !(now < c.e)) return '403';
  var rest = m[3];
  if (!c.p || rest.indexOf(c.p) !== 0 || rest.indexOf('/../') >= 0) return '403';
  cc = (cc || '').toUpperCase();
  if (c.c && cc && c.c !== cc) return '403';
  var rv = store['r:' + c.a];
  if (rv && c.n <= Number(rv)) return '403';
  return 'ok';
}

function verdict(r) {
  return check(r.uri, r.headersIn['X-Test-Country'] || '', readStore(), Math.floor(Date.now() / 1000));
}

export default { verdict, check };
