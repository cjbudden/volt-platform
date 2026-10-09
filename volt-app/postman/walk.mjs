// ============================================================================
//  BLIND WALK: can a client navigate this API using ONLY what the responses say?
//  Rule of the harness: the ONLY URL typed by hand is the entrypoint. Every
//  other request must come from a string found inside a previous response.
//  Anything we cannot reach that way is, by definition, out-of-band knowledge.
// ============================================================================
const BASE = 'http://127.0.0.1:8080';
const ENTRY = BASE + '/api';

const login = await (await fetch(BASE + '/api/auth/login', {
  method:'POST', headers:{'content-type':'application/json'},
  body: JSON.stringify({ email:'admin@rtm.example', password:'volt1234' })
})).json();
const TOKEN = login.access || login.access_token || login.accessToken || login.token;
if (!TOKEN) { console.log('LOGIN FAILED', JSON.stringify(login).slice(0,300)); process.exit(1); }

const H = { authorization: 'Bearer ' + TOKEN, accept: 'application/ld+json' };
const seen = new Map();          // url -> {status, ct, links:[], sample}
const queue = [[ENTRY, 0, 'typed by hand']];
const MAXDEPTH = 4;

const isOurs = (s) => typeof s === 'string' && s.startsWith(BASE);

// Pull every absolute URL on our host out of a JSON body, remembering the key
// it was found under, because the key IS the link relation in this design.
function harvest(node, out, path='') {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string') { if (isOurs(node)) out.push([path || '(value)', node]); return out; }
  if (Array.isArray(node)) { node.slice(0, 3).forEach((v,i) => harvest(v, out, path + '[' + i + ']')); return out; }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) harvest(v, out, path ? path + '.' + k : k);
  }
  return out;
}

while (queue.length) {
  const [url, depth, via] = queue.shift();
  if (seen.has(url) || depth > MAXDEPTH) continue;
  let r, body, text;
  try { r = await fetch(url, { headers: H }); text = await r.text(); } catch (e) {
    seen.set(url, { status:'ERR', err:String(e), depth, via, links:[] }); continue;
  }
  try { body = JSON.parse(text); } catch { body = null; }
  const links = body ? harvest(body, []) : [];
  seen.set(url, {
    status: r.status, ct: (r.headers.get('content-type')||'').split(';')[0], depth, via,
    linkCount: links.length,
    links: links.map(([k]) => k),
    hasId: !!(body && (body['@id'] || (Array.isArray(body.items) && body.items[0] && body.items[0]['@id']))),
    topKeys: body && !Array.isArray(body) ? Object.keys(body).slice(0,14) : (Array.isArray(body) ? ['(bare array, ' + body.length + ')'] : []),
    sample: text.slice(0, 400)
  });
  for (const [rel, next] of links) if (!seen.has(next)) queue.push([next, depth+1, url + ' :: ' + rel]);
}

const rows = [...seen.entries()].sort((a,b) => a[1].depth - b[1].depth || a[0].localeCompare(b[0]));
console.log('=== REACHED ' + rows.length + ' URLS BY FOLLOWING LINKS ONLY ===\n');
for (const [u, m] of rows) {
  console.log(`d${m.depth} ${String(m.status).padEnd(3)} ${m.ct.padEnd(24)} ${u.replace(BASE,'')}`);
  console.log(`      keys: ${(m.topKeys||[]).join(', ') || '-'}`);
  console.log(`      links out: ${m.linkCount ? m.links.slice(0,8).join(', ') : 'NONE'}`);
}
const byDepth = {};
rows.forEach(([,m]) => byDepth[m.depth] = (byDepth[m.depth]||0)+1);
console.log('\ndepth histogram:', JSON.stringify(byDepth));
console.log('dead ends (200 but no outgoing links):',
  rows.filter(([,m]) => m.status===200 && !m.linkCount).length);
