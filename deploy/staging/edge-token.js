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
//  `plain`: "403" for a plain /clips/vod/ path when VOLT_EDGE_TOKENS is
//  "enforce" (build queue P2-2b), "ok" otherwise, and "ok" under enforce for a
//  token-free title: "f:<asset id>" in the store, not past its end (build
//  queue P2-2c; plainPathVerdict in services/edgeTokens.ts).
//
//  A shared token (build queue P2-2f, `k: "shared"`) opens the encode folders
//  of the titles it names, for any viewer, each title's revocation applying.
//
//  Verdicts: "ok", "403" (bad, expired, wrong folder, wrong country, revoked),
//  "503" (no key yet: the scheduler has not synced). `refusal` gives the
//  words for the refusal's body, the same as the CloudFront Function's
//  (build queue P2-2): `return 403 $edge_refusal;` in nginx.conf.template.
// ============================================================================
import fs from 'fs';
import crypto from 'crypto';

var TOK = /^\/t\/([A-Za-z0-9_-]{8,2048})\.([0-9a-f]{32})(\/.*)$/;
var SHARED = /^\/(?:clips\/vod|vod)\/([0-9a-fA-F-]{36})\//;

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

var NOPE = 'Not available';
var EXPIRED = 'This link has expired';
var REGION = 'Not available in your region';
var GONE = 'No longer available';

// uri: the request path; cc: the viewer's country; store: the keys; now: epoch seconds.
// Answers [verdict, words]: "ok", "403" or "503", and what a refusal says.
function decide(uri, cc, store, now) {
  var m = TOK.exec(uri);
  if (!m) return ['403', NOPE];
  var c = claimsOf(m[1]);
  var shared = !!c && c.k === 'shared';
  if (shared ? !Array.isArray(c.A) : (!c || typeof c.p !== 'string' || typeof c.a !== 'string')) return ['403', NOPE];
  var key = store['k:pt'];
  if (!key) return ['503', 'Try again shortly'];
  var want = crypto.createHmac('sha256', key).update(m[1]).digest('hex').slice(0, 32);
  if (want !== m[2]) return ['403', NOPE];
  if (now + 60 < c.n || !(now < c.e)) return ['403', EXPIRED];
  var rest = m[3];
  var title;
  if (shared) {
    // A shared token (build queue P2-2f): the titles it names, any viewer.
    var sm = SHARED.exec(rest);
    if (!sm || rest.indexOf('/../') >= 0 || c.A.indexOf(sm[1].replace(/-/g, '').toLowerCase()) < 0) return ['403', NOPE];
    title = sm[1].toLowerCase();
  } else {
    if (!c.p || rest.indexOf(c.p) !== 0 || rest.indexOf('/../') >= 0) return ['403', NOPE];
    cc = (cc || '').toUpperCase();
    if (c.c && cc && c.c !== cc) return ['403', REGION];
    title = c.a;
  }
  var rv = store['r:' + title];
  if (rv && c.n <= Number(rv)) return ['403', GONE];
  return ['ok', ''];
}

function check(uri, cc, store, now) {
  return decide(uri, cc, store, now)[0];
}

function words(uri, cc, store, now) {
  return decide(uri, cc, store, now)[1];
}

function verdict(r) {
  return check(r.uri, r.headersIn['X-Test-Country'] || '', readStore(), Math.floor(Date.now() / 1000));
}

// A plain on-demand path under enforce. mode: VOLT_EDGE_TOKENS; store and now
// only matter for a token-free title ("f:<asset id>").
// A clip's own folder, /clips/<asset id>/, is one too (build queue P2-2d).
var PLAIN_ID = /^\/(?:clips\/vod|vod|clips)\/([0-9a-fA-F-]{36})\//;
var PLAIN_GUARD = /^\/(clips\/vod|vod|clips\/[0-9a-fA-F-]{36})\//;
function plainVerdict(uri, mode, store, now) {
  var m = String(mode || '').trim().toLowerCase();
  if (m !== 'enforce' || !PLAIN_GUARD.test(uri)) return 'ok';
  var id = PLAIN_ID.exec(uri);
  if (!id || uri.indexOf('/../') >= 0 || !store) return '403';
  var open = store['f:' + id[1].toLowerCase()];
  if (open === undefined || open === null) return '403';
  var until = Number(open);
  return until === 0 || now < until ? 'ok' : '403';
}

function plain(r) {
  var mode = process.env && process.env.VOLT_EDGE_TOKENS;
  // The store is read only under enforce, and only for a plain on-demand path.
  if (plainVerdict(r.uri, mode, null, 0) === 'ok') return 'ok';
  return plainVerdict(r.uri, mode, readStore(), Math.floor(Date.now() / 1000));
}

// Read only on a refusal (nginx evaluates js_set variables when used).
function refusal(r) {
  return words(r.uri, r.headersIn['X-Test-Country'] || '', readStore(), Math.floor(Date.now() / 1000)) + '\n';
}

export default { verdict, check, refusal, words, plain, plainVerdict };
