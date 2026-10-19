/**
 * ROUTE INVENTORY: every HTTP route the API serves, read from the running
 * Express app (not from a hand-kept list), with
 *
 *   - the API it belongs to: public, admin, platform, sign-in, machine, delivery
 *   - the credential it takes
 *   - for admin routes, the feature and level a role needs (from the same
 *     requirementFor() the API enforces with, auth/roles.ts)
 *   - whether the viewer tier (ROLE=api-public) serves it
 *
 * Writes docs/API_ROUTES.md, docs/api-routes.json and docs/api-list-specs.json
 * (the search/filter/sort definition of every list, from src/util/listQuery.ts).
 *
 *   npm run docs:routes            (needs DATABASE_URL; nothing is written to it)
 *   npm run docs:routes -- --check (exit 1 if the committed files are out of date)
 *
 * test/docs.check.sh runs the --check form so a new route cannot ship
 * without appearing in the reference.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

process.env.ROLE = 'all';
process.env.PREWARM_ENABLED = 'false';

type Api = 'public' | 'sign-in' | 'admin' | 'platform' | 'machine' | 'delivery' | 'discovery';
interface Row { method: string; path: string; api: Api; credential: string; access: string; viewerTier: boolean; group: string }

const SAMPLE_ID = '00000000-0000-0000-0000-000000000000';

/** Express 4 keeps a mount path only as a regexp: turn it back into a string. */
function mountOf(layer: any): string {
  if (layer.path !== undefined && typeof layer.path === 'string') return layer.path;
  const src: string = layer.regexp?.source ?? '';
  if (src === '^\\/?$' || src === '^\\/?(?=\\/|$)') return '';
  let s = src.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\\\/\?\$$/, '').replace(/\(\?=\\\/\|\$\)$/, '');
  let k = 0;
  s = s.replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, () => `:${layer.keys?.[k++]?.name ?? 'param'}`);
  return s.replace(/\\\//g, '/').replace(/\\\./g, '.').replace(/\\-/g, '-');
}

interface Raw { method: string; path: string; authed: boolean; ingest: boolean }
function walk(stack: any[], prefix: string, authed: boolean, ingest: boolean, out: Raw[]) {
  let a = authed, ing = ingest;
  for (const l of stack) {
    if (l.route) {
      const names = l.route.stack.map((s: any) => s.name);
      const ra = a || names.includes('requireAuth');
      const ri = ing || names.includes('requireIngestToken');
      const paths = Array.isArray(l.route.path) ? l.route.path : [l.route.path];
      for (const p of paths) {
        if (typeof p !== 'string') continue;
        for (const m of Object.keys(l.route.methods)) {
          if (m === '_all') continue;
          out.push({ method: m.toUpperCase(), path: (prefix + p).replace(/\/+/g, '/').replace(/(.)\/$/, '$1'), authed: ra, ingest: ri });
        }
      }
    } else if (l.name === 'router' && l.handle?.stack) {
      walk(l.handle.stack, prefix + mountOf(l), a, ing, out);
    } else if (l.name === 'requireAuth') {
      a = true;
    } else if (l.name === 'requireIngestToken') {
      ing = true;
    }
  }
}

const PUBLIC_CRED: [RegExp, string][] = [
  [/^\/api\/public\/auth\/token-exchange/, 'account secret key (sk_live_…)'],
  [/^\/api\/public\/auth\/mfa\/challenge/, 'sign-in challenge (body)'],
  [/^\/api\/public\/auth\/(refresh|logout)/, 'viewer refresh token (body)'],
  [/^\/api\/public\/auth\/mfa\//, 'viewer session'],
  [/^\/api\/public\/auth/, 'publishable key (appKey in body)'],
  [/^\/api\/public\/me/, 'viewer session (Bearer)'],
  [/^\/api\/(public\/)?availability/, 'publishable key; viewer session optional'],
  [/^\/api\/(public\/)?access/, 'publishable key'],
  [/^\/api\/(public\/)?player/, 'publishable key or player token'],
  [/^\/api\/(public\/)?analytics\/beacon/, 'playback token'],
  [/^\/api\/(public\/)?payments/, 'publishable key + viewer'],
  [/^\/api\/share/, 'share link token (path), plus PIN or emailed code when the link has one'],
];
const MACHINE: [RegExp, string][] = [
  [/^\/api\/engine-hooks/, 'engine callback signature'],
  [/^\/api\/addon-callbacks/, 'add-on run token'],
  [/^\/api\/payments\/webhooks/, 'payment provider signature'],
  [/^\/api\/radio\/icecast/, 'Icecast auth callback secret'],
  [/^\/api\/ingest\/transfers\/[^/]+\/events/, 'transfer provider callback (checked per provider)'],
  [/^\/api\/social\/callback/, 'OAuth redirect (state parameter)'],
];
/** Routes that check a credential inside the handler instead of with requireAuth. */
const SPECIAL: [RegExp, Api, string, string][] = [
  [/^\/api\/(caption-languages|ingest-protocols)$/, 'discovery', 'none', 'reference data for forms'],
  [/^\/api\/status\/stream$/, 'admin', 'admin session (Bearer, or ?ticket= for EventSource)', 'live status push, filtered by the features the user holds'],
  [/^\/api\/tus/, 'admin', 'admin session (Bearer), checked per request', 'media: manage (resumable upload, tus protocol)'],
  [/^\/api\/uploads\/:id\/(chunks|finish|state)/, 'admin', 'upload session token (Bearer)', 'the upload the token was issued for'],
];
const SIGN_IN = /^\/api\/auth\/(login|register|refresh|mfa\/challenge\/(send|verify))$|^\/api\/platform\/auth\/(login|mfa)$/;
const SETUP_WITH_CHALLENGE = /^\/api\/auth\/mfa\/(totp|email|sms)\/(start|confirm)$/;

async function main() {
  const { createServer } = await import('../src/server');
  const { requirementFor, CATALOGUE } = await import('../src/auth/roles');
  const { scaleConfig } = await import('../src/scale/config');
  const app: any = createServer();
  const raw: Raw[] = [];
  walk(app._router.stack, '', false, false, raw);

  const label = new Map(CATALOGUE.map((f: any) => [f.key, f.label]));
  const isPublicPrefix = (p: string) => scaleConfig.publicPrefixes.some((x: string) =>
    x.endsWith('/') ? p.startsWith(x) : p === x || p.startsWith(x + '/') || p.startsWith(x + '?'));

  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const r of raw) {
    // The console's own routes exist only when its bundle is built: listed in the intro instead.
    if (r.path === '*' || r.path === '/console') continue;
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const p = r.path;
    // `:action(start|stop)` is a choice of literal words: sample the first one.
    const sample = p.replace(/:[A-Za-z_]+\(([^|)]+)[^)]*\)/g, '$1').replace(/:[A-Za-z_]+/g, SAMPLE_ID).replace(/\*/g, 'x');
    let api: Api; let credential = ''; let access = '';
    const machine = MACHINE.find(([rx]) => rx.test(p));
    const special = SPECIAL.find(([rx]) => rx.test(p));
    if (special) { api = special[1]; credential = special[2]; access = special[3]; }
    else if (p.startsWith('/health')) { api = 'discovery'; credential = 'none'; access = 'liveness / readiness'; }
    else if (p === '/api' || p === '/api/doc' || p === '/api/context.jsonld') { api = 'discovery'; credential = 'none'; access = 'Hydra service document'; }
    else if (r.ingest) { api = 'machine'; credential = 'X-Volt-Ingest-Token'; access = 'encoder / thumbnailer report'; }
    else if (machine && !r.authed) { api = 'machine'; credential = machine[1]; access = 'callback'; }
    else if (p.startsWith('/api/public/') || (isPublicPrefix(p) && p.startsWith('/api/'))) {
      api = 'public';
      credential = PUBLIC_CRED.find(([rx]) => rx.test(p))?.[1] ?? 'publishable key';
      access = p.startsWith('/api/public/') ? 'public API' : `public (legacy alias of /api/public${p.slice(4)})`;
    }
    else if (SIGN_IN.test(p)) { api = 'sign-in'; credential = p.includes('refresh') ? 'refresh token (body)' : p.includes('challenge') || p.endsWith('/mfa') ? 'sign-in challenge (body)' : 'email + password'; access = 'no session'; }
    else if (p.startsWith('/api/platform')) {
      api = 'platform';
      credential = p.startsWith('/api/platform/auth/step-up') ? 'admin session (Bearer)' : 'platform session (aud volt:platform, after TOTP)';
      access = p.startsWith('/api/platform/auth') ? 'platform staff' : 'platform_role (saas_admin / support as the route says)';
    }
    else if (p.startsWith('/api/auth')) {
      api = 'admin';
      credential = SETUP_WITH_CHALLENGE.test(p) ? 'admin session, or the setup challenge during sign-in' : 'admin session (Bearer)';
      access = 'own account (any admin user)';
    }
    else if (p.startsWith('/api/')) {
      if (!r.authed) { api = 'public'; credential = 'none or per-route'; access = 'open'; }
      else {
        api = 'admin';
        credential = 'admin session (Bearer) or account secret key';
        let need: any = null;
        try { need = await requirementFor(r.method, sample, {}, async () => 'tv'); } catch { need = null; }
        if (!need) access = r.method === 'GET' ? 'any signed-in admin user' : 'operator tier or above';
        else if (need.level === 'none') access = `${need.features.join(' or ')}: any signed-in admin user (lookup for forms)`;
        else access = `${need.features.map((f: string) => label.get(f) ? `${f}` : f).join(' or ')}: ${need.level}`;
        if (/^\/api\/channels\/:/.test(p) && need?.features?.[0] === 'channels') access += ' (radio: same level, when the channel is a station)';
        if (p === '/api/apps/secret-keys' || p.startsWith('/api/apps/secret-keys')) access += ' + admin tier';
        if (p.startsWith('/api/users/security-policy') && r.method !== 'GET') access += ' + admin tier';
      }
    }
    else {
      api = 'delivery';
      credential = isPublicPrefix(p) ? 'none, share token or playback token' : 'admin session or internal';
      access = isPublicPrefix(p) ? 'public delivery' : 'preview / internal';
    }
    const group = p.startsWith('/api/') ? '/' + p.split('/').slice(1, p.startsWith('/api/public/') || p.startsWith('/api/platform/') ? 4 : 3).join('/') : '/' + (p.split('/')[1] ?? '');
    rows.push({ method: r.method, path: p, api, credential, access, viewerTier: isPublicPrefix(p) || p.startsWith('/health'), group });
  }
  rows.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

  const ORDER: [Api, string, string][] = [
    ['public', 'Public API', 'For apps and players. A publishable key (`pk_…`) names the client account. Viewer sessions are Bearer tokens with audience `volt:viewer`. Served by the viewer tier.'],
    ['sign-in', 'Sign-in (no session yet)', 'Admin and platform sign-in. Returns a session, or a two-step challenge.'],
    ['admin', 'Admin API', 'A client\'s staff. Admin session (audience `volt:admin`) or the account secret key. Each route needs the feature and level shown, from the user\'s roles (ACCESS_CONTROL.md section 3).'],
    ['platform', 'Platform API', 'Volt staff only. Needs a platform session, minted after the authenticator step.'],
    ['machine', 'Machine-to-machine', 'Encoders, engines, add-ons, payment providers. Each has its own secret.'],
    ['delivery', 'Delivery and previews (outside /api)', 'Streams, images, share pages and players. The admin console web app is also served from `/` when its bundle is built (it signs in through the admin API).'],
    ['discovery', 'Health and discovery', ''],
  ];
  const esc = (s: string) => s.replace(/\|/g, '\\|');
  let md = `# Volt API: every route\n\n` +
    `Generated from the running app by \`npm run docs:routes\` (scripts/api-routes.ts). Do not edit by hand.\n` +
    `The usage guide is [API_GUIDE.md](API_GUIDE.md), the access model is [ACCESS_CONTROL.md](../../ACCESS_CONTROL.md).\n\n` +
    `**${rows.length} routes.** ` + ORDER.map(([k, t]) => `${t}: ${rows.filter((r) => r.api === k).length}`).join(' · ') + `\n\n` +
    `- **Access:** for admin routes, \`feature: level\` is what one of the user's roles must grant (levels: view < operate < manage). The API answers \`403 forbidden_feature\` with the feature and level when it is missing.\n` +
    `- **Viewer tier:** ✓ means the public tier (ROLE=api-public) serves the route. Everything else answers 404 there.\n` +
    `- **Paths:** \`:id\` and similar are path parameters.\n\n`;
  for (const [k, title, intro] of ORDER) {
    const list = rows.filter((r) => r.api === k);
    if (!list.length) continue;
    md += `## ${title}\n\n${intro ? intro + '\n\n' : ''}`;
    const groups = [...new Set(list.map((r) => r.group))];
    for (const g of groups) {
      const gl = list.filter((r) => r.group === g);
      md += `### \`${g}\`\n\n| Method | Path | Credential | Access | Viewer tier |\n|---|---|---|---|---|\n`;
      for (const r of gl) md += `| ${r.method} | \`${esc(r.path)}\` | ${esc(r.credential)} | ${esc(r.access)} | ${r.viewerTier ? '✓' : ''} |\n`;
      md += '\n';
    }
  }
  const json = JSON.stringify(rows, null, 1) + '\n';
  // THE LIST STANDARD'S DEFINITIONS (src/util/listQuery.ts), registered as the
  // modules loaded above. The API reference documents exactly these.
  const { listSpecsForDocs } = await import('../src/util/listQuery');
  const specs = listSpecsForDocs();
  for (const sp of specs) {
    if (!rows.some((r) => r.method === sp.method && r.path === sp.path)) {
      console.error(`defineList({ path: '${sp.path}' }) names a route that does not exist`);
      process.exit(1);
    }
  }
  const specJson = JSON.stringify(specs, null, 1) + '\n';
  const specPath = join(__dirname, '..', 'docs', 'api-list-specs.json');
  const mdPath = join(__dirname, '..', 'docs', 'API_ROUTES.md');
  const jsonPath = join(__dirname, '..', 'docs', 'api-routes.json');
  if (process.argv.includes('--check')) {
    const same = existsSync(mdPath) && readFileSync(mdPath, 'utf8') === md && existsSync(jsonPath) && readFileSync(jsonPath, 'utf8') === json
      && existsSync(specPath) && readFileSync(specPath, 'utf8') === specJson;
    console.log(same ? 'docs/API_ROUTES.md is current' : 'docs/API_ROUTES.md is OUT OF DATE: run npm run docs:routes');
    process.exit(same ? 0 : 1);
  }
  writeFileSync(mdPath, md);
  writeFileSync(jsonPath, json);
  writeFileSync(specPath, specJson);
  console.log(`wrote ${rows.length} routes to docs/API_ROUTES.md and docs/api-routes.json`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
