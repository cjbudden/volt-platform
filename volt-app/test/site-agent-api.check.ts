/**
 * THE SITE AGENT API REFERENCE MATCHES THE APP (build queue H5-3).
 *
 * The routes volt-agent calls (/api/site-agent/...) are machine-to-machine,
 * so the customer API reference leaves them out on purpose. Their reference
 * is docs/engineering/site-agent-api.md. This reads the routes from the real
 * Express app (as scripts/api-routes.ts does) and fails when one is missing
 * from that page, or when the page names a route that is gone, so the page
 * cannot drift the way a hand-kept list does. It also feeds the comparison a
 * page with a row taken out and one made up, so a checker that stopped
 * noticing would fail here. Needs DATABASE_URL only because the app's modules
 * load the pool; nothing is read or written.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0, failed = 0;
function ok(cond: unknown, msg: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ok   ${msg}`); }
  else { failed++; console.log(`  FAIL ${msg}${detail !== undefined ? ` -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
}

const DOC = join(__dirname, '../../docs/engineering/site-agent-api.md');
const PREFIX = '/api/site-agent';

/** Express 4 keeps a mount path only as a regexp: turn it back into a string (as scripts/api-routes.ts). */
function mountOf(layer: any): string {
  if (typeof layer.path === 'string') return layer.path;
  const src: string = layer.regexp?.source ?? '';
  if (src === '^\\/?$' || src === '^\\/?(?=\\/|$)') return '';
  let s = src.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\\\/\?\$$/, '').replace(/\(\?=\\\/\|\$\)$/, '');
  let k = 0;
  s = s.replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, () => `:${layer.keys?.[k++]?.name ?? 'param'}`);
  return s.replace(/\\\//g, '/').replace(/\\\./g, '.').replace(/\\-/g, '-');
}

/** Every METHOD path the app serves under the prefix. A router.all() route is 'ALL'. */
export function appRoutes(stack: any[], prefix = '', out = new Set<string>()): Set<string> {
  for (const l of stack) {
    if (l.route) {
      const paths = Array.isArray(l.route.path) ? l.route.path : [l.route.path];
      for (const p of paths) {
        if (typeof p !== 'string') continue;
        const full = (prefix + p).replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
        if (!full.startsWith(PREFIX)) continue;
        for (const m of Object.keys(l.route.methods)) out.add(`${m === '_all' ? 'ALL' : m.toUpperCase()} ${full}`);
      }
    } else if (l.name === 'router' && l.handle?.stack) {
      appRoutes(l.handle.stack, prefix + mountOf(l), out);
    }
  }
  return out;
}

/** The routes the page documents: table rows that start with `METHOD /api/site-agent/...`. */
export function documented(md: string): Set<string> {
  const out = new Set<string>();
  for (const m of md.matchAll(/^\|\s*`(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\/api\/site-agent[^`\s]*)`\s*\|/gm)) out.add(`${m[1]} ${m[2]}`);
  return out;
}

/** What is wrong between the app and the page. An ALL route is covered by any method on its path. */
export function compare(app: Set<string>, doc: Set<string>) {
  const docPaths = new Set([...doc].map((r) => r.split(' ')[1]));
  const allPaths = new Set([...app].filter((r) => r.startsWith('ALL ')).map((r) => r.split(' ')[1]));
  const missing = [...app].filter((r) => (r.startsWith('ALL ') ? !docPaths.has(r.split(' ')[1]) : !doc.has(r)));
  const gone = [...doc].filter((r) => !app.has(r) && !allPaths.has(r.split(' ')[1]));
  return { missing, gone };
}

(async () => {
  const { createServer } = await import('../src/server');
  const app: any = createServer();
  const routes = appRoutes(app._router.stack);
  const md = readFileSync(DOC, 'utf8');
  const doc = documented(md);

  console.log('the app and the page');
  ok(routes.size >= 30, `the app serves the site agent's routes (${routes.size})`);
  ok(routes.has('POST /api/site-agent/enrol') && routes.has('POST /api/site-agent/jobs/lease'), 'enrolment and the job lease are among them');
  ok(routes.has('GET /api/site-agent/watchfolders/:id/fallbacks') && routes.has('POST /api/site-agent/watchfolders/:id/fallbacks/:itemId'), 'the H5 fallback routes are read from the app');
  ok(routes.has('ALL /api/site-agent/transfers/:token'), 'the signed transfer route (router.all) is read from the app');
  ok(doc.size >= 30, `the page documents routes in its tables (${doc.size})`);
  const r = compare(routes, doc);
  ok(r.missing.length === 0, 'every route the app serves is on the page', r.missing);
  ok(r.gone.length === 0, 'every route on the page is served by the app', r.gone);

  console.log('the comparison notices');
  const without = md.replace(/^\| `POST \/api\/site-agent\/jobs\/:id\/outputs` \|.*\n/m, '');
  ok(without !== md, 'a row can be taken out of the page');
  const r2 = compare(routes, documented(without));
  ok(r2.missing.length === 1 && r2.missing[0] === 'POST /api/site-agent/jobs/:id/outputs', 'a route taken off the page is reported missing', r2.missing);
  const r3 = compare(routes, documented(md + '\n| `POST /api/site-agent/jobs/:id/pause` | made up |\n'));
  ok(r3.gone.length === 1 && r3.gone[0] === 'POST /api/site-agent/jobs/:id/pause', 'a route the app does not serve is reported', r3.gone);
  const r4 = compare(routes, documented(md.replace(/^\| `(GET|PUT) \/api\/site-agent\/transfers\/:token` \|.*\n/gm, '')));
  ok(r4.missing.includes('ALL /api/site-agent/transfers/:token'), 'the transfer route is reported when neither of its rows is there', r4.missing);

  console.log('kept out of the customer reference');
  const openapi = JSON.parse(readFileSync(join(__dirname, '../docs/openapi.json'), 'utf8'));
  ok(!Object.keys(openapi.paths).some((p) => p.startsWith(PREFIX)), 'the customer API reference has no site agent route');
  ok(Object.keys(openapi.paths).includes('/api/sites') && Object.keys(openapi.paths).includes('/api/archive/targets'), 'the console routes for sites and Mirror and Archive are in it');
  ok(/scripts\/openapi\.mjs/.test(md) && /HYBRID_SITES\.md/.test(md), 'the page says why the routes are not in the customer reference, and where the design is');

  console.log(`\nsite-agent-api: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
