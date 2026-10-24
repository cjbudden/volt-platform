// Guide coverage check (build queue 1.14-G0).
//
// coverage.json maps every console section, workflow and developer topic to
// the guides that explain it. This keeps that map honest:
//   errors (exit 1): a console nav section missing from the map, or listed but
//   no longer in the console; a label that no longer matches the nav; a guide
//   path that does not exist; a guide page (frontmatter `guide:`) that the map
//   does not list; a template that lost one of its headings; and, for every
//   batch in `required`, an entry with no guide, a guide not written to the
//   template, or a map page that leaves a section out.
//   gaps (listed, not failures): the same shortfalls in batches not yet
//   required. That list is the to-do for the guides items G1 to G6.
//
// The console's nav is read from its source (volt-web/src/App.tsx), so a new
// section cannot ship without someone deciding where it is documented.
//   node scripts/check-coverage.mjs          (from docs-site; also in npm run build)
//   node scripts/check-coverage.mjs --json   (machine-readable result)
//   node scripts/check-coverage.mjs --summary  (counts only; what the build prints)
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Every { key, label } in the console's NAV and ADMIN_NAV, in order. */
export function readNav(appSource) {
  const start = appSource.indexOf('const NAV: NavGroup[]');
  const end = appSource.indexOf('const ADMIN_KEYS');
  if (start < 0 || end < start) throw new Error('could not find NAV and ADMIN_NAV in the console source');
  const block = appSource.slice(start, end);
  const out = [];
  for (const m of block.matchAll(/\{\s*key:\s*'([^']+)',\s*label:\s*'([^']+)'/g)) out.push({ key: m[1], label: m[2] });
  if (!out.length) throw new Error('the console nav parsed to nothing');
  return out;
}

export function frontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  const fm = {};
  if (m) for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '');
  }
  return fm;
}

export function headings(md) {
  // Level-two headings outside fenced code.
  const out = [];
  let fence = false;
  for (const line of md.split('\n')) {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    else if (!fence) { const h = line.match(/^##\s+(.+?)\s*$/); if (h) out.push(h[1]); }
  }
  return out;
}

function missingHeadings(md, required) {
  const have = headings(md).map((h) => h.toLowerCase());
  return required.filter((r) => !have.some((h) => h === r.toLowerCase() || h.startsWith(r.toLowerCase() + ':')));
}

function walk(dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.mdx?$/.test(f) && !f.startsWith('_')) out.push(p);
  }
  return out;
}

/**
 * The whole check, on plain inputs so a test can feed it broken maps.
 * site: the docs-site folder; coverage: parsed coverage.json; appSource: App.tsx.
 */
export function checkCoverage({ site, coverage, appSource }) {
  const errors = [];
  const gaps = [];
  const docs = join(site, 'docs');
  const required = new Set(coverage.required || []);
  const templates = coverage.templates || {};
  const read = (rel) => readFileSync(join(docs, rel), 'utf8');

  // 1. The map and the console nav agree.
  const nav = readNav(appSource);
  const byKey = new Map((coverage.sections || []).map((s) => [s.key, s]));
  for (const n of nav) {
    const s = byKey.get(n.key);
    if (!s) errors.push(`console section "${n.label}" (${n.key}) is not in coverage.json: add it with the batch that will document it`);
    else if (s.label !== n.label) errors.push(`section ${n.key} is "${n.label}" in the console but "${s.label}" in coverage.json`);
  }
  const navKeys = new Set(nav.map((n) => n.key));
  for (const s of coverage.sections || []) {
    if (!navKeys.has(s.key)) errors.push(`coverage.json lists section ${s.key} ("${s.label}"), which the console no longer has`);
  }

  // 2. Templates carry their headings.
  for (const [kind, heads] of Object.entries(templates)) {
    if (kind === 'map') continue;
    const file = join(site, 'templates', `${kind}.md`);
    if (!existsSync(file)) { errors.push(`templates/${kind}.md is missing`); continue; }
    const miss = missingHeadings(readFileSync(file, 'utf8'), heads);
    if (miss.length) errors.push(`templates/${kind}.md lacks: ${miss.join(', ')}`);
  }

  // 3. Every entry: guides exist; required batches are covered and templated.
  const groups = [['section', coverage.sections || []], ['workflow', coverage.workflows || []], ['developer', coverage.developer || []], ['page', coverage.pages || []]];
  const listed = new Set();
  let total = 0, inTemplate = 0;
  for (const [area, entries] of groups) {
    for (const e of entries) {
      if (e.internal) continue;
      total++;
      const kind = area === 'page' ? e.kind : area;
      const name = e.label || e.title || e.key;
      const isRequired = required.has(e.batch);
      const problems = [];
      const guides = e.guides || [];
      for (const g of guides) {
        listed.add(g);
        if (!existsSync(join(docs, g))) { errors.push(`${area} "${name}": guide ${g} does not exist`); continue; }
      }
      const present = guides.filter((g) => existsSync(join(docs, g)));
      if (!present.length) problems.push('no guide');
      // The entry is covered when at least one of its guides is written to the
      // template for its kind; older guides it also lists are extra reading.
      const templated = present.filter((g) => {
        const md = read(g);
        return frontmatter(md).guide === kind && !missingHeadings(md, templates[kind] || []).length;
      });
      if (present.length && !templated.length) {
        const why = present.map((g) => {
          const md = read(g);
          const fmKind = frontmatter(md).guide;
          const miss = missingHeadings(md, templates[kind] || []);
          return `${g}${fmKind !== kind ? ` (frontmatter guide: ${fmKind || 'none'}, wants ${kind})` : ''}${miss.length ? ` (missing: ${miss.join(', ')})` : ''}`;
        });
        problems.push(`not in the ${kind} template yet: ${why.join('; ')}`);
      }
      // A map page names every section, so a new one cannot be left off it.
      if (kind === 'map' && templated.length) {
        const text = templated.map(read).join('\n').toLowerCase();
        const missing = (coverage.sections || []).filter((s) => !s.internal && !text.includes(s.label.toLowerCase())).map((s) => s.label);
        if (missing.length) problems.push(`does not mention: ${missing.join(', ')}`);
      }
      if (!problems.length) { inTemplate++; continue; }
      if (isRequired) for (const p of problems) errors.push(`${area} "${name}" (batch ${e.batch}, required): ${p}`);
      else gaps.push({ batch: e.batch, area, key: e.key, name, problems });
    }
  }

  // 4. Every templated guide page is on the map.
  if (existsSync(docs)) for (const f of walk(docs)) {
    const rel = relative(docs, f).split('\\').join('/');
    if (frontmatter(readFileSync(f, 'utf8')).guide && !listed.has(rel)) errors.push(`${rel} is a guide (frontmatter guide:) but coverage.json does not list it`);
  }

  return { errors, gaps, total, inTemplate, required: [...required] };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const site = join(dirname(fileURLToPath(import.meta.url)), '..');
  const coverage = JSON.parse(readFileSync(join(site, 'coverage.json'), 'utf8'));
  const appSource = readFileSync(join(site, '../volt-web/src/App.tsx'), 'utf8');
  const r = checkCoverage({ site, coverage, appSource });
  if (process.argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(r.errors.length ? 1 : 0); }
  const byBatch = {};
  for (const g of r.gaps) (byBatch[g.batch] ||= []).push(g);
  if (r.gaps.length && process.argv.includes('--summary')) {
    // The build only says how many: the full list is npm run coverage.
    console.log(`Guide gaps by batch (npm run coverage lists them): ${Object.keys(byBatch).sort().map((b) => `${b} ${byBatch[b].length}`).join(', ')}`);
  } else if (r.gaps.length) {
    console.log(`Gaps (not yet required), by batch:`);
    for (const b of Object.keys(byBatch).sort()) {
      console.log(`  ${b}:`);
      for (const g of byBatch[b]) console.log(`    - ${g.area} ${g.name}: ${g.problems.join('; ')}`);
    }
  }
  for (const e of r.errors) console.log(`ERROR ${e}`);
  console.log(`\ncoverage: ${r.inTemplate} of ${r.total} covered by a guide in the template; ${r.gaps.length} gaps in batches not yet required; required batches: ${r.required.join(', ') || 'none'}; ${r.errors.length} errors`);
  process.exit(r.errors.length ? 1 : 0);
}
