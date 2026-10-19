/**
 * OPENAPI SPEC FOR THE CUSTOMER DOCS, BUILT FROM WHAT THE API ACTUALLY DOES.
 *
 * Nothing here is written by hand. Two generated inputs, both already kept
 * honest by their own checks:
 *
 *   docs/api-routes.json              EVERY route, read from the running app
 *                                     (npm run docs:routes; --check in docs.check)
 *   api/Volt.postman_collection.json  a REAL request and response for each
 *                                     captured route (npm run api:capture)
 *
 * From those it writes docs/openapi.json (OpenAPI 3.1), which the docs site
 * renders with Scalar. Every customer-facing route is in it, because the route
 * list comes from the app; routes that have a captured request also get their
 * parameters, request body and example responses.
 *
 * Customer docs only: the Volt-staff platform API and machine-to-machine routes
 * (encoders, engines, payment callbacks) are left out on purpose.
 *
 * Captured examples pass through docs-site/scrub.json's replace rules, so demo
 * tenant names and test credentials never reach the published reference.
 *
 *   npm run docs:openapi            write docs/openapi.json
 *   npm run docs:openapi -- --check exit 1 if docs/openapi.json is out of date
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = join(APP, '..');
const OUT = join(APP, 'docs', 'openapi.json');
const CHECK = process.argv.includes('--check');

const INCLUDE = new Set(['public', 'admin', 'sign-in', 'delivery', 'discovery']);
const TAG_GROUP = { discovery: 'Discovery', 'sign-in': 'Sign-in', public: 'Public API', admin: 'Admin API', delivery: 'Delivery' };
const MAX_ARRAY_EXAMPLE = 3;
const MAX_EXAMPLE_BYTES = 6000;

const routes = JSON.parse(readFileSync(join(APP, 'docs', 'api-routes.json'), 'utf8'));
const collection = JSON.parse(readFileSync(join(APP, 'api', 'Volt.postman_collection.json'), 'utf8'));
const scrub = JSON.parse(readFileSync(join(REPO, 'docs-site', 'scrub.json'), 'utf8'));
// HAND-WRITTEN WORDING, layered over the generated reference: a better summary,
// description or tag for any route, keyed "METHOD /path" exactly as in
// api-routes.json. --check fails on a key that no longer matches a route, so
// the overlay can never describe a route that is gone.
const LIST_SPECS_PATH = join(APP, 'docs', 'api-list-specs.json');
const listSpecs = existsSync(LIST_SPECS_PATH) ? JSON.parse(readFileSync(LIST_SPECS_PATH, 'utf8')) : [];
const listSpecFor = new Map(listSpecs.map((sp) => [`${sp.method} ${sp.path}`, sp]));
const OVERLAY_PATH = join(APP, 'docs', 'openapi-overlay.json');
const overlay = existsSync(OVERLAY_PATH) ? JSON.parse(readFileSync(OVERLAY_PATH, 'utf8')) : {};
const version = existsSync(join(REPO, 'VERSION')) ? readFileSync(join(REPO, 'VERSION'), 'utf8').trim() : '0.0.0';

const replaceRules = scrub.replace.map((r) => [new RegExp(r.from, 'gi'), r.to]);
const clean = (s) => replaceRules.reduce((acc, [re, to]) => acc.replace(re, to), String(s));
function cleanDeep(v) {
  if (typeof v === 'string') return clean(v);
  if (Array.isArray(v)) return v.map(cleanDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cleanDeep(x)]));
  return v;
}

/* ---------- match captured requests to routes ---------- */
const shape = (p) => p.split('?')[0].replace(/\/+$/, '').split('/').map((s) => (s.startsWith(':') || /^\{\{.*\}\}$/.test(s) ? '*' : s)).join('/');
function* requests(items, folder = '') {
  for (const it of items) {
    if (it.item) yield* requests(it.item, it.name);
    else yield { ...it, folder };
  }
}
const captured = new Map();
for (const r of requests(collection.item)) {
  const raw = r.request.url.raw.replace('{{baseUrl}}', '');
  const key = `${r.request.method} ${shape(raw)}`;
  if (!captured.has(key)) captured.set(key, []);
  captured.get(key).push(r);
}

/* ---------- helpers ---------- */
const TYPE = { string: 'string', number: 'number', integer: 'integer', int: 'integer', boolean: 'boolean', bool: 'boolean', object: 'object', array: 'array', uuid: 'string', date: 'string', datetime: 'string' };
function schemaForType(t) {
  const s = String(t || 'string').toLowerCase().replace(/`/g, '').trim();
  if (s.endsWith('[]')) return { type: 'array', items: schemaForType(s.slice(0, -2)) };
  if (s.includes('|')) return { type: 'string', description: `One of: ${s}` };
  const base = TYPE[s] ?? 'string';
  const out = { type: base };
  if (s === 'uuid') out.format = 'uuid';
  if (s === 'datetime' || s === 'date') out.format = s === 'date' ? 'date' : 'date-time';
  return out;
}
function infer(v, depth = 0) {
  if (v === null) return {};
  if (Array.isArray(v)) return { type: 'array', items: v.length && depth < 6 ? infer(v[0], depth + 1) : {} };
  if (typeof v === 'object') {
    if (depth >= 6) return { type: 'object' };
    return { type: 'object', properties: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, infer(x, depth + 1)])) };
  }
  if (typeof v === 'number') return { type: Number.isInteger(v) ? 'integer' : 'number' };
  if (typeof v === 'boolean') return { type: 'boolean' };
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return { type: 'string', format: 'date-time' };
  if (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v)) return { type: 'string', format: 'uuid' };
  return { type: 'string' };
}
function trimExample(v, depth = 0) {
  if (Array.isArray(v)) return v.slice(0, MAX_ARRAY_EXAMPLE).map((x) => trimExample(x, depth + 1));
  if (v && typeof v === 'object' && depth < 8) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trimExample(x, depth + 1)]));
  return v;
}
function parseJson(s) {
  if (!s) return undefined;
  try { return JSON.parse(s.replace(/"?\{\{(\w+)\}\}"?/g, (m, name) => (m.startsWith('"') ? `"<${name}>"` : `"<${name}>"`))); } catch { return undefined; }
}
/** The parameter table every captured request carries in its description. */
function paramTable(desc) {
  const rows = [];
  for (const line of String(desc || '').split('\n')) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*(body|query|path|header)\s*\|\s*([^|]*)\|\s*(yes|no)\s*\|\s*(.*?)\|?\s*$/i);
    if (m) rows.push({ name: m[1], in: m[2].toLowerCase(), type: m[3].trim(), required: m[4].toLowerCase() === 'yes', desc: m[5].trim() });
  }
  return rows;
}
/** The prose part of a captured description: drop the credential line and the table. */
function prose(desc) {
  return String(desc || '')
    .split('\n')
    .filter((l) => !/^\*\*API:\*\*/.test(l) && !/^\|/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
const ACRONYM = { epg: 'EPG', vod: 'VOD', xmltv: 'XMLTV', api: 'API', mfa: 'MFA', totp: 'TOTP', sso: 'SSO', sms: 'SMS', hls: 'HLS', dash: 'DASH', mp3: 'MP3', id: 'ID', ids: 'IDs', url: 'URL', tus: 'Uploads (tus)', jsonld: 'JSON-LD', oauth: 'OAuth', ui: 'UI', img: 'Image delivery', m3u8: 'M3U8' };
const titleCase = (s) => s.replace(/[-_.]/g, ' ').split(' ').filter(Boolean).map((w) => ACRONYM[w.toLowerCase()] ?? w[0].toUpperCase() + w.slice(1)).join(' ');
const words = (s) => s.replace(/[-_.]/g, ' ').split(' ').filter(Boolean).map((w) => ACRONYM[w.toLowerCase()] ?? w.toLowerCase()).join(' ');
/** What one item of a collection is called, where the path segment says it badly. */
const NOUN = { epg: 'programme', vod: 'VOD asset', apps: 'app', 'access-roles': 'role', 'scheduled-clips': 'scheduled clip', 'share-links': 'share link', 'publish-targets': 'publishing target', 'metadata-schemas': 'metadata schema', 'encode-profiles': 'encoding profile', 'output-profiles': 'output profile', 'filler-assets': 'slate or loop', 'ingest-rules': 'ingest rule', 'user-groups': 'user group', 'publishing-rules': 'publishing rule', addons: 'add-on' };
const singular = (seg) => NOUN[seg] ?? words(seg).replace(/ies$/, 'y').replace(/([^s])s$/, '$1');
const plural = (seg) => (NOUN[seg] ? `${NOUN[seg]}s` : words(seg));
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const a = (w) => (/^[aeiou]/i.test(w) && !/^(uni|use|eu)/i.test(w) ? `an ${w}` : `a ${w}`);
function tagFor(route) {
  if (route.api === 'discovery') return 'Discovery';
  const segs = route.group.replace(/^\/api\/?/, '').replace(/^public\//, '').split('/').filter((s) => s && !s.startsWith(':'));
  return titleCase(segs[0] || 'Service');
}
/** A readable name for a route nobody has captured or described yet.
 *  docs/openapi-overlay.json overrides it with hand-written wording. */
function summaryFor(route) {
  const segs = route.path.replace(/^\/api\/(public\/)?/, '').split('/').filter(Boolean);
  const last = segs[segs.length - 1] ?? '';
  const prev = segs[segs.length - 2] ?? '';
  const M = route.method;
  if (last.startsWith(':')) {
    const thing = singular(prev || segs[0] || 'item');
    return { GET: `Get ${a(thing)}`, PATCH: `Update ${a(thing)}`, PUT: `Replace ${a(thing)}`, DELETE: `Delete ${a(thing)}` }[M] ?? `${M} ${a(thing)}`;
  }
  if (segs.length === 1) {
    return { GET: `List ${plural(last)}`, POST: `Create ${a(singular(last))}`, PATCH: `Update ${words(last)}`, PUT: `Set ${words(last)}`, DELETE: `Delete ${words(last)}` }[M] ?? `${M} ${words(last)}`;
  }
  const what = words(last);
  if (prev.startsWith(':')) {
    const owner = singular(segs[segs.length - 3] ?? segs[0]);
    return { GET: `Get ${a(owner)}'s ${what}`, POST: `${cap(what)} (${owner})`, PUT: `Set ${a(owner)}'s ${what}`, PATCH: `Update ${a(owner)}'s ${what}`, DELETE: `Remove ${a(owner)}'s ${what}` }[M] ?? `${M} ${what}`;
  }
  const area = words(prev);
  return { GET: `Get ${area} ${what}`, POST: `${cap(area)}: ${what}`, PUT: `Set ${area} ${what}`, PATCH: `Update ${area} ${what}`, DELETE: `Delete ${area} ${what}` }[M] ?? `${M} ${what}`;
}
function opId(route) {
  return (route.method.toLowerCase() + route.path.replace(/^\/api/, '').split('/').filter(Boolean).map((s) => titleCase(s.replace(/^:/, 'by-'))).join('')).replace(/[^A-Za-z0-9]/g, '');
}
function securityFor(cred) {
  const c = cred.toLowerCase();
  if (c === 'none' || c.startsWith('none')) return [];
  const s = [];
  if (c.includes('admin session') || c.includes('secret key')) s.push({ adminBearer: [] });
  if (c.includes('viewer session') && !c.includes('optional')) s.push({ viewerBearer: [] });
  if (c.includes('publishable key')) {
    s.push({ publishableKey: [] });
    if (c.includes('viewer session optional') || c.includes('viewer')) s.push({ publishableKey: [], viewerBearer: [] });
  }
  if (c.includes('viewer refresh token') || c.includes('challenge')) return [];
  return s;
}

/* ---------- the list standard (src/util/listQuery.ts, docs/API_STANDARDS.md) ---------- */
const OP_WORDS = { eq: 'equals', ne: 'not equal', gt: '>', gte: '>=', lt: '<', lte: '<=', in: 'any of, comma list', nin: 'none of, comma list', contains: 'contains', starts: 'starts with', exists: 'has a value, true or false' };
function applyListSpec(op, ls) {
  const fields = Object.entries(ls.fields);
  const filterable = fields.filter(([, f]) => f.filter);
  const sortable = fields.filter(([, f]) => f.sort).map(([k]) => k);
  const P = [];
  if (ls.search.length) P.push({ name: 'q', in: 'query', required: false, schema: { type: 'string' }, description: `Search ${ls.search.join(', ')}. Every word must match, case-insensitive.` });
  for (const [name, f] of filterable) {
    const schema = f.type === 'number' ? { type: 'number' } : f.type === 'boolean' ? { type: 'boolean' } : f.type === 'timestamp' ? { type: 'string', format: 'date-time' } : f.type === 'uuid' ? { type: 'string', format: 'uuid' } : f.values ? { type: 'string', enum: f.values } : { type: 'string' };
    P.push({ name, in: 'query', required: false, schema, description: `${f.doc ? f.doc + '. ' : ''}Filter: \`${name}=value\`${f.ops.includes('in') ? ' (comma list = any of)' : ''}, or \`${name}[op]=value\` with op: ${f.ops.map((o) => `\`${o}\` (${OP_WORDS[o]})`).join(', ')}.` });
  }
  P.push({ name: 'sort', in: 'query', required: false, schema: { type: 'string', default: ls.defaultSort }, description: `Comma list of: ${sortable.join(', ')}. Prefix \`-\` for descending. Default \`${ls.defaultSort}\`; ties by id.` });
  P.push({ name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: ls.maxLimit, default: ls.defaultLimit }, ...(ls.unpagedLimit ? { description: `Page size. Without limit, cursor or offset this list returns up to ${ls.unpagedLimit} rows (compatibility); pass limit to page.` } : {}) });
  P.push({ name: 'cursor', in: 'query', required: false, schema: { type: 'string' }, description: 'The next page: copy it from the previous response (`Link: rel="next"` or `X-Next-Cursor`). Only valid with the same q, filters and sort.' });
  if (ls.allowOffset) P.push({ name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0, maximum: 100000 }, description: 'Skip this many rows (page jumps). Prefer cursor.' });
  P.push({ name: 'count', in: 'query', required: false, schema: { type: 'boolean' }, description: 'Also return the total that match, in `X-Total-Count`.' });
  const have = new Set((op.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name));
  op.parameters = [...(op.parameters ?? []).filter((p) => p.in === 'path'), ...P.filter((p) => !have.has(p.name))];
  op.description = `${op.description}\n\n**List:** searchable, filterable, sortable and paged the standard way (see Using the API). Filter on ${filterable.map(([k]) => `\`${k}\``).join(', ')}.`;
  for (const code of Object.keys(op.responses)) {
    if (code.startsWith('2') && !op.responses[code].$ref) op.responses[code].headers = { $ref: undefined, ...LIST_HEADERS };
  }
  for (const code of Object.keys(op.responses)) if (op.responses[code].headers) delete op.responses[code].headers.$ref;
  op['x-volt-list'] = true;
}
const LIST_HEADERS = {
  Link: { description: 'RFC 8288. `rel="next"` when there is another page.', schema: { type: 'string' } },
  'X-Next-Cursor': { description: 'Cursor for the next page (absent on the last page).', schema: { type: 'string' } },
  'X-Total-Count': { description: 'Total matching rows, only with count=true.', schema: { type: 'integer' } },
  'X-Page-Limit': { description: 'The page size used.', schema: { type: 'integer' } },
};

/* ---------- build ---------- */
const paths = {};
const tagsSeen = new Map();
let withExamples = 0;
const hiddenTags = new Set(Object.entries(overlay.tags ?? {}).filter(([, t]) => t?.hidden).map(([k]) => k));
const included = routes.filter((r) => INCLUDE.has(r.api) && !r.path.startsWith('/api/platform') && !hiddenTags.has(tagFor(r)));

for (const route of included) {
  const oaPath = route.path.replace(/:(\w+)/g, '{$1}');
  const caps = captured.get(`${route.method} ${shape(route.path)}`) ?? [];
  // The summary comes from a SUCCESSFUL capture: a route's negative test
  // ("Refused: ...") is an example of an error, not a description of the route.
  const first = caps.find((c) => (c.response ?? []).some((r) => Number(r.code) < 300)) ?? caps[0];
  const tag = tagFor(route);
  tagsSeen.set(tag, route.api);

  const params = new Map();
  for (const m of route.path.matchAll(/:(\w+)/g)) params.set(`path:${m[1]}`, { name: m[1], in: 'path', required: true, schema: { type: 'string' } });
  const table = first ? paramTable(first.request.description) : [];
  for (const p of table.filter((p) => p.in !== 'body')) {
    params.set(`${p.in}:${p.name}`, { name: p.name, in: p.in, required: p.in === 'path' ? true : p.required, description: p.desc || undefined, schema: schemaForType(p.type) });
  }

  const op = {
    operationId: opId(route),
    summary: first?.name ?? summaryFor(route),
    tags: [tag],
    description: [first ? prose(first.request.description) : '', `**Credential:** ${route.credential}`, route.access && route.api === 'admin' ? `**Access needed:** ${route.access}` : ''].filter(Boolean).join('\n\n'),
    security: securityFor(route.credential),
    parameters: [...params.values()],
    responses: {},
  };
  if (!op.parameters.length) delete op.parameters;

  const bodyRows = table.filter((p) => p.in === 'body');
  const bodyEx = first ? parseJson(first.request.body?.raw) : undefined;
  if (bodyRows.length || bodyEx !== undefined) {
    const schema = bodyRows.length
      ? { type: 'object', properties: Object.fromEntries(bodyRows.map((p) => [p.name, { ...schemaForType(p.type), description: p.desc || undefined }])), required: bodyRows.filter((p) => p.required).map((p) => p.name) }
      : infer(bodyEx);
    if (schema.required && !schema.required.length) delete schema.required;
    op.requestBody = { required: bodyRows.some((p) => p.required), content: { 'application/json': { schema, ...(bodyEx !== undefined ? { example: bodyEx } : {}) } } };
  }

  for (const cap of caps) {
    for (const res of cap.response ?? []) {
      const code = String(res.code ?? res.status ?? 200);
      if (op.responses[code]) continue;
      let ex = parseJson(res.body);
      const entry = { description: res.name?.replace(/ example$/, '') || 'Response' };
      if (ex !== undefined) {
        ex = trimExample(ex);
        if (JSON.stringify(ex).length > MAX_EXAMPLE_BYTES) ex = undefined;
      }
      if (ex !== undefined) entry.content = { 'application/json': { schema: infer(ex), example: ex } };
      op.responses[code] = entry;
    }
  }
  const extra = overlay[`${route.method} ${route.path}`];
  if (extra) {
    if (extra.summary) op.summary = extra.summary;
    if (extra.description) op.description = `${extra.description}\n\n${op.description}`;
    if (extra.tag) { op.tags = [extra.tag]; tagsSeen.set(extra.tag, route.api); }
  }
  const ls = listSpecFor.get(`${route.method} ${route.path}`);
  if (ls) applyListSpec(op, ls);
  if (Object.keys(op.responses).length) withExamples++;
  else op.responses['200'] = { description: 'Success' };
  if (op.security.length) {
    op.responses['401'] ??= { $ref: '#/components/responses/Unauthorized' };
    if (route.api === 'admin') op.responses['403'] ??= { $ref: '#/components/responses/Forbidden' };
  }
  if (!op.security.length) delete op.security;
  paths[oaPath] ??= {};
  paths[oaPath][route.method.toLowerCase()] = op;
}

const groups = {};
for (const [tag, api] of [...tagsSeen].sort((a, b) => a[0].localeCompare(b[0]))) (groups[TAG_GROUP[api] ?? 'Other'] ??= []).push(tag);
const groupOrder = ['Discovery', 'Sign-in', 'Public API', 'Admin API', 'Delivery', 'Other'];

const spec = cleanDeep({
  openapi: '3.1.0',
  info: {
    title: 'Volt API',
    version,
    description: [
      'The Volt API: the **Public API** for apps, players and their audience, and the **Admin API** for your own staff and servers.',
      'Every route Volt serves to customers is listed here. Routes with a captured example show a real request and response from a test account.',
      'Guides: Using the API, Authentication and Errors in the docs sidebar.',
    ].join('\n\n'),
  },
  servers: [{ url: 'https://{host}', description: 'Your Volt API', variables: { host: { default: 'api.volt.example', description: 'The host you sign in to Volt on' } } }],
  tags: [...tagsSeen.keys()].sort().map((name) => {
    const t = overlay.tags?.[name];
    return t ? { name, ...(t.displayName ? { 'x-displayName': t.displayName } : {}), description: t.description } : { name };
  }),
  'x-tagGroups': groupOrder.filter((g) => groups[g]).map((g) => ({ name: g, tags: groups[g] })),
  paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
  components: {
    securitySchemes: {
      adminBearer: { type: 'http', scheme: 'bearer', description: 'An admin session (from sign-in) or your account secret key (sk_live_...). Server-side only for the secret key.' },
      viewerBearer: { type: 'http', scheme: 'bearer', description: 'A public user session, from the public sign-in routes.' },
      publishableKey: { type: 'apiKey', in: 'query', name: 'appKey', description: "An app's publishable key (pk_live_...). Safe to ship in an app." },
    },
    responses: {
      Unauthorized: { description: 'No credential, an expired one, or the wrong kind for this API.', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' } } }, example: { error: 'unauthorized' } } } },
      Forbidden: { description: 'Signed in, but your role does not have the access this route needs.', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' } } }, example: { error: 'forbidden' } } } },
    },
  },
});

const text = JSON.stringify(spec, null, 1) + '\n';
const stats = `${included.length} routes (${withExamples} with captured examples), ${routes.length - included.length} staff/machine routes left out`;
const routeKeys = new Set(routes.map((r) => `${r.method} ${r.path}`));
// EVERY SERVICE SAYS WHAT IT IS FOR. Once the overlay has a "tags" section,
// a service without a usage statement (or a statement for a service that is
// gone) fails the check, so a new service cannot ship undocumented.
if (overlay.tags) {
  const missing = [...tagsSeen.keys()].filter((t) => !overlay.tags[t]?.description);
  const gone = Object.keys(overlay.tags).filter((t) => !t.startsWith('_') && !tagsSeen.has(t) && !hiddenTags.has(t));
  if (missing.length || gone.length) {
    if (missing.length) console.error(`openapi: services without a usage statement (add to openapi-overlay.json "tags"): ${missing.join(', ')}`);
    if (gone.length) console.error(`openapi: usage statements for services that no longer exist: ${gone.join(', ')}`);
    process.exit(1);
  }
}
const staleOverlay = Object.keys(overlay).filter((k) => !k.startsWith('_') && k !== 'tags' && !routeKeys.has(k));
if (staleOverlay.length) {
  console.error(`openapi: docs/openapi-overlay.json has entries for routes that no longer exist:\n  ${staleOverlay.join('\n  ')}`);
  process.exit(1);
}
if (CHECK) {
  const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (cur !== text) {
    console.error(`openapi: docs/openapi.json is out of date (${stats}). Run: npm run docs:openapi`);
    process.exit(1);
  }
  console.log(`openapi: up to date, ${stats}`);
} else {
  writeFileSync(OUT, text);
  console.log(`openapi: wrote docs/openapi.json, ${stats}`);
}
