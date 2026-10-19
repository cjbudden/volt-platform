// Copies everything the site needs from the rest of the repo into static/.
// Runs before every start and build, so the site never serves a stale copy.
//   - the OpenAPI spec, generated from the running API (volt-app/docs/openapi.json)
//   - the Scalar bundle, pinned to the installed version, served from this site
//   - the Volt fonts and logos, from the brand folder (one source of truth)
import { cpSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = join(here, '..');
const out = (...p) => join(here, 'static', ...p);

function fail(msg) { console.error(`prepare: ${msg}`); process.exit(1); }

// 1. OpenAPI spec
const spec = join(repo, 'volt-app', 'docs', 'openapi.json');
if (!existsSync(spec)) fail(`missing ${spec}. Run: (cd volt-app && npm run docs:openapi)`);
const parsed = JSON.parse(readFileSync(spec, 'utf8'));
if (!parsed.openapi || !parsed.paths) fail('openapi.json is not an OpenAPI document');
// "Try it" calls the customer's own API: the Volt app host serves /api.
if (process.env.VOLT_APP_URL) parsed.servers = [{ url: process.env.VOLT_APP_URL.replace(/\/+$/, ''), description: 'Your Volt API' }];
writeFileSync(out('openapi.json'), JSON.stringify(parsed));

// 2. Scalar, pinned
// (read from disk: the package's "exports" do not expose package.json)
const scalarDir = join(here, 'node_modules', '@scalar', 'api-reference');
const pkg = JSON.parse(readFileSync(join(scalarDir, 'package.json'), 'utf8'));
const bundle = join(scalarDir, 'dist', 'browser', 'standalone.js');
if (!existsSync(bundle)) fail(`missing ${bundle}. Run npm ci in docs-site.`);
mkdirSync(out('vendor', 'scalar'), { recursive: true });
cpSync(bundle, out('vendor', 'scalar', `api-reference-${pkg.version}.js`));

// 3. Brand
const brand = join(repo, 'brand');
mkdirSync(out('fonts'), { recursive: true });
for (const f of ['Archivo-Variable.woff2', 'Inter-Variable.woff2', 'JetBrainsMono-Variable.woff2']) {
  const src = join(brand, 'fonts', 'web', f);
  if (existsSync(src)) cpSync(src, out('fonts', f));
}
const logos = join(brand, 'logos', 'svg');
const pick = (names) => names.map((n) => join(logos, n)).find(existsSync);
const light = pick(['volt-short-on-light.svg', 'volt-lockup-on-light.svg']);
const dark = pick(['volt-short-on-dark.svg', 'volt-lockup-on-dark.svg']);
if (light) cpSync(light, out('img', 'logo-light.svg'));
if (dark) cpSync(dark, out('img', 'logo-dark.svg'));
const mark = join(logos, 'volt-mark.svg');
if (existsSync(mark)) cpSync(mark, out('img', 'favicon.svg'));
if (!light || !dark) console.warn('prepare: brand logo not found, navbar shows the title only');

console.log(`prepare: openapi (${Object.keys(parsed.paths).length} paths), scalar ${pkg.version}, brand assets`);
