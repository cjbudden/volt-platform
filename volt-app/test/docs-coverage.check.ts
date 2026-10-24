/**
 * Guide coverage map and screenshots (build queue 1.14-G0).
 *
 * docs-site/scripts/check-coverage.mjs decides whether every console section,
 * workflow and developer topic has a guide written to the template. This
 * runs it on the real tree (no errors; the known gaps are listed, not failed)
 * and on small made-up sites that break one rule each, so a checker that
 * stopped noticing would fail here. It also checks that every screenshot a
 * guide shows is in the manifest and on disk, and the other way round.
 * No database, no API.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0, failed = 0;
function ok(cond: unknown, msg: string) {
  if (cond) { passed++; console.log(`  ok   ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}

const SITE = join(__dirname, '../../docs-site');
const APP = join(__dirname, '../../volt-web/src/App.tsx');

const SECTION_HEADS = ['What it is for', 'Before you start', 'Step by step', 'How it connects', 'Who can do it', 'Troubleshooting', 'Through the API'];
const fakeApp = (items: Array<[string, string]>) =>
  `const NAV: NavGroup[] = [\n  { group: 'X', items: [\n${items.map(([k, l]) => `    { key: '${k}', label: '${l}', icon: I.x },`).join('\n')}\n  ] },\n]\nconst ADMIN_NAV: NavGroup[] = []\nconst ADMIN_KEYS = new Set()\n`;
const guide = (kind: string, heads: string[], extra = '') =>
  `---\ntitle: T\nguide: ${kind}\n---\n\n# T\n\n${heads.map((h) => `## ${h}\n\ntext\n`).join('\n')}${extra}`;

/** A throwaway docs site: templates, docs and a coverage map. */
function fakeSite(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'cov-'));
  mkdirSync(join(dir, 'templates'));
  mkdirSync(join(dir, 'docs/guides'), { recursive: true });
  writeFileSync(join(dir, 'templates/section.md'), guide('section', SECTION_HEADS));
  for (const [p, body] of Object.entries(files)) { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), body); }
  return dir;
}
const baseCoverage = (over: any = {}) => ({
  required: ['G1'],
  templates: { section: SECTION_HEADS, map: ['The sections'] },
  sections: [{ key: 'dashboard', label: 'Dashboard', batch: 'G1', guides: ['guides/dashboard.md'] }],
  workflows: [], developer: [], pages: [],
  ...over,
});

(async () => {
  const mod: any = await import(join(SITE, 'scripts/check-coverage.mjs'));
  const { checkCoverage, readNav } = mod;

  console.log('the real tree');
  const appSource = readFileSync(APP, 'utf8');
  const coverage = JSON.parse(readFileSync(join(SITE, 'coverage.json'), 'utf8'));
  const nav = readNav(appSource);
  ok(nav.length >= 30 && nav.some((n: any) => n.key === 'channels' && n.label === 'Channels'), `the console nav is read from the source (${nav.length} sections)`);
  ok(nav.some((n: any) => n.key === 'audit') && nav.some((n: any) => n.key === 'dashboard'), 'both the daily and the Admin nav are read');
  const real = checkCoverage({ site: SITE, coverage, appSource });
  ok(real.errors.length === 0, `no errors on the real tree${real.errors.length ? ': ' + real.errors.join(' | ') : ''}`);
  ok(real.required.includes('G0'), 'G0 is a required batch');
  ok(!real.gaps.some((g: any) => g.batch === 'G0'), 'nothing in G0 is left as a gap (the How Volt fits together page is in its template)');
  // G1 (the live sections) is done and required: each of its sections has a
  // guide in the section template, so none of them is a gap any more.
  ok(real.required.includes('G1'), 'G1 is a required batch');
  ok(!real.gaps.some((g: any) => g.batch === 'G1'), 'nothing in G1 is left as a gap');
  for (const k of ['dashboard', 'live', 'monitoring', 'multiview', 'channels', 'radio', 'events', 'fast']) {
    const sec = coverage.sections.find((x: any) => x.key === k);
    ok(sec && sec.batch === 'G1' && sec.guides.length > 0, `${k} is mapped to a G1 guide`);
  }
  // G2 (around the live stream) is done and required too: EPG and Captions
  // were brought into the template, Loops & Fillers, Graphics and Formats &
  // reframing got their first guides, each with its own screenshot.
  ok(real.required.includes('G2'), 'G2 is a required batch');
  ok(!real.gaps.some((g: any) => g.batch === 'G2'), 'nothing in G2 is left as a gap');
  const g2 = { epg: 'guides/epg.md', loops: 'guides/loops-and-fillers.md', graphics: 'guides/graphics.md', captions: 'guides/captions.md', reframing: 'guides/formats-and-reframing.md' } as Record<string, string>;
  const g2shots = JSON.parse(readFileSync(join(SITE, 'screenshots.json'), 'utf8')).shots;
  for (const [k, path] of Object.entries(g2)) {
    const sec = coverage.sections.find((x: any) => x.key === k);
    ok(sec && sec.batch === 'G2' && sec.guides.includes(path), `${k} is mapped to ${path}`);
    ok(g2shots.some((s: any) => s.guide === path), `${path} has a screenshot in the manifest`);
  }
  const map = readFileSync(join(SITE, 'docs/getting-started/how-volt-fits-together.md'), 'utf8');
  ok(Object.values(g2).every((p) => map.includes(`../${p}`)), 'How Volt fits together links each G2 section to its guide');
  // G3 (media and media setup) is done and required: thirteen guides in the
  // section template, each with its own screenshot, linked from the map, and
  // the share links guide listed under the three streams that open it.
  ok(real.required.includes('G3'), 'G3 is a required batch');
  ok(!real.gaps.some((g: any) => g.batch === 'G3'), 'nothing in G3 is left as a gap');
  const g3: Record<string, string> = {
    vod: 'guides/media-library.md', recordings: 'guides/recordings.md', images: 'guides/images-and-thumbnails.md',
    review: 'guides/review.md', encoding: 'guides/encoding-profiles.md', watchfolders: 'guides/watchfolders.md',
    storage: 'guides/storage.md', workflows: 'guides/workflows.md', 'content-types': 'guides/content-types.md',
    publishing: 'guides/publishing-rules.md', ingest: 'guides/ingest-rules.md', groups: 'guides/channel-groups.md',
  };
  for (const [k, path] of Object.entries(g3)) {
    const sec = coverage.sections.find((x: any) => x.key === k);
    ok(sec && sec.batch === 'G3' && sec.guides.includes(path), `${k} is mapped to ${path}`);
    ok(g2shots.some((s: any) => s.guide === path), `${path} has a screenshot in the manifest`);
    ok(map.includes(`../${path}`), `How Volt fits together links ${k} to ${path}`);
  }
  for (const k of ['channels', 'radio', 'events']) {
    ok(coverage.sections.find((x: any) => x.key === k)?.guides.includes('guides/share-links.md'), `${k} lists the share links guide`);
  }
  ok(g2shots.some((s: any) => s.guide === 'guides/share-links.md'), 'the share links guide has a screenshot in the manifest');
  // The batches not yet written still show as gaps, both kinds.
  ok(real.gaps.some((g: any) => g.key === 'plan' && g.problems.includes('no guide')), 'Plan & limits (G4) is listed as a gap with no guide');
  ok(real.gaps.some((g: any) => g.key === 'audit' && /not in the section template/.test(g.problems.join())), 'Audit log (G4) is listed as having a guide not yet in the template');
  ok(!coverage.sections.some((s: any) => s.key === 'system' && !s.internal), 'System Admin is marked internal, not a customer gap');
  ok(real.total === real.inTemplate + real.gaps.length, `every entry is either covered or a gap (${real.inTemplate} + ${real.gaps.length} = ${real.total})`);

  console.log('the console and the map must agree');
  const plusOne = appSource.replace("{ key: 'dashboard', label: 'Dashboard'", "{ key: 'brandnew', label: 'Brand new', icon: I.dash },\n    { key: 'dashboard', label: 'Dashboard'");
  ok(checkCoverage({ site: SITE, coverage, appSource: plusOne }).errors.some((e: string) => e.includes('Brand new')), 'a new console section with no map entry is an error');
  const relabelled = appSource.replace("label: 'Radio'", "label: 'Audio'");
  ok(checkCoverage({ site: SITE, coverage, appSource: relabelled }).errors.some((e: string) => /radio is "Audio"/.test(e)), 'a section renamed in the console is an error until the map follows');
  const fewer = { ...coverage, sections: coverage.sections.filter((s: any) => s.key !== 'fast') };
  ok(checkCoverage({ site: SITE, coverage: fewer, appSource }).errors.some((e: string) => e.includes('"FAST"')), 'a console section dropped from the map is an error');
  const stale = { ...coverage, sections: [...coverage.sections, { key: 'gone', label: 'Gone', batch: 'G1', guides: [] }] };
  ok(checkCoverage({ site: SITE, coverage: stale, appSource }).errors.some((e: string) => e.includes('no longer has')), 'a map entry for a section the console no longer has is an error');
  ok(checkCoverage({ site: SITE, coverage: { ...coverage, required: [...coverage.required, 'G4'] }, appSource }).errors.some((e: string) => e.includes('"Plan & limits"') && e.includes('no guide')), 'requiring G4 today fails on its gaps (Plan & limits has no guide)');
  // A G2 guide that loses a template heading fails the build again.
  const brokenSite = mkdtempSync(join(tmpdir(), 'cov-g2-'));
  for (const d of ['templates', 'docs/guides', 'docs/getting-started', 'docs/api']) mkdirSync(join(brokenSite, d), { recursive: true });
  const copyTree = (from: string, to: string) => { for (const f of readdirSync(from)) { const a = join(from, f), b = join(to, f); if (statSync(a).isDirectory()) { mkdirSync(b, { recursive: true }); copyTree(a, b); } else writeFileSync(b, readFileSync(a)); } };
  copyTree(join(SITE, 'templates'), join(brokenSite, 'templates'));
  copyTree(join(SITE, 'docs'), join(brokenSite, 'docs'));
  const loopsPath = join(brokenSite, 'docs/guides/loops-and-fillers.md');
  writeFileSync(loopsPath, readFileSync(loopsPath, 'utf8').replace('## Troubleshooting', '## Problems'));
  ok(checkCoverage({ site: brokenSite, coverage, appSource }).errors.some((e: string) => e.includes('loops-and-fillers.md') && e.includes('Troubleshooting')), 'a G2 guide that loses a template heading is an error');
  const storagePath = join(brokenSite, 'docs/guides/storage.md');
  writeFileSync(storagePath, readFileSync(storagePath, 'utf8').replace('## Who can do it', '## Access'));
  ok(checkCoverage({ site: brokenSite, coverage, appSource }).errors.some((e: string) => e.includes('storage.md') && e.includes('Who can do it')), 'a G3 guide that loses a template heading is an error');
  // A finished batch stays finished: drop a G1 guide from the map and the page
  // is reported as unlisted, and its section as having no guide.
  const dropped = { ...coverage, sections: coverage.sections.map((x: any) => x.key === 'fast' ? { ...x, guides: [] } : x) };
  const dr = checkCoverage({ site: SITE, coverage: dropped, appSource }).errors;
  ok(dr.some((e: string) => e.includes('guides/fast.md') && e.includes('does not list it')) && dr.some((e: string) => e.includes('"FAST"') && e.includes('required')), 'unlisting a G1 guide fails the required batch');

  console.log('the template rules, on made-up sites');
  const app1 = fakeApp([['dashboard', 'Dashboard']]);
  let site = fakeSite({ 'docs/guides/dashboard.md': guide('section', SECTION_HEADS) });
  let r = checkCoverage({ site, coverage: baseCoverage(), appSource: app1 });
  ok(r.errors.length === 0 && r.inTemplate === 1, 'a guide with the frontmatter and all seven headings covers its section');
  site = fakeSite({ 'docs/guides/dashboard.md': guide('section', SECTION_HEADS.filter((h) => h !== 'Troubleshooting')) });
  r = checkCoverage({ site, coverage: baseCoverage(), appSource: app1 });
  ok(r.errors.some((e: string) => e.includes('missing: Troubleshooting')), 'a missing heading is named');
  site = fakeSite({ 'docs/guides/dashboard.md': guide('workflow', SECTION_HEADS) });
  r = checkCoverage({ site, coverage: baseCoverage(), appSource: app1 });
  ok(r.errors.some((e: string) => e.includes('frontmatter guide: workflow')), 'the wrong kind in the frontmatter is an error');
  r = checkCoverage({ site, coverage: baseCoverage({ required: [] }), appSource: app1 });
  ok(r.errors.length === 0 && r.gaps.length === 1, 'the same problem outside a required batch is a gap, not a failure');
  site = fakeSite({});
  r = checkCoverage({ site, coverage: baseCoverage(), appSource: app1 });
  ok(r.errors.some((e: string) => e.includes('guides/dashboard.md does not exist')), 'a guide path that does not exist is an error');
  site = fakeSite({ 'docs/guides/dashboard.md': guide('section', SECTION_HEADS), 'docs/guides/stray.md': guide('section', SECTION_HEADS) });
  r = checkCoverage({ site, coverage: baseCoverage(), appSource: app1 });
  ok(r.errors.some((e: string) => e.includes('guides/stray.md is a guide')), 'a guide page the map does not list is an error');
  site = fakeSite({ 'docs/guides/dashboard.md': guide('section', SECTION_HEADS) });
  writeFileSync(join(site, 'templates/section.md'), guide('section', SECTION_HEADS.slice(0, 3)));
  r = checkCoverage({ site, coverage: baseCoverage(), appSource: app1 });
  ok(r.errors.some((e: string) => e.startsWith('templates/section.md lacks')), 'a template that lost a heading is an error');
  const mapCov = (body: string) => {
    const s = fakeSite({ 'docs/guides/dashboard.md': guide('section', SECTION_HEADS), 'docs/map.md': body });
    return checkCoverage({ site: s, appSource: fakeApp([['dashboard', 'Dashboard'], ['radio', 'Radio']]), coverage: baseCoverage({
      required: ['G0'],
      sections: [{ key: 'dashboard', label: 'Dashboard', batch: 'G1', guides: ['guides/dashboard.md'] }, { key: 'radio', label: 'Radio', batch: 'G1', guides: [] }],
      pages: [{ key: 'map', title: 'Map', kind: 'map', batch: 'G0', guides: ['map.md'] }],
    }) });
  };
  ok(mapCov(guide('map', ['The sections'], 'Dashboard and Radio.\n')).errors.length === 0, 'a map page naming every section passes');
  ok(mapCov(guide('map', ['The sections'], 'Dashboard only.\n')).errors.some((e: string) => e.includes('does not mention: Radio')), 'a map page that leaves a section out is an error');

  console.log('screenshots');
  const shots = JSON.parse(readFileSync(join(SITE, 'screenshots.json'), 'utf8')).shots;
  ok(shots.length >= 2, `the manifest has ${shots.length} shots`);
  for (const s of shots) {
    const png = join(SITE, 'static/img/screens', `${s.name}.png`);
    ok(existsSync(png) && statSync(png).size > 10_000, `${s.name}.png exists`);
    ok(existsSync(join(SITE, 'docs', s.guide)) && readFileSync(join(SITE, 'docs', s.guide), 'utf8').includes(`/img/screens/${s.name}.png`), `${s.guide} shows ${s.name}.png`);
  }
  const used = new Set<string>();
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.mdx?$/.test(f)) for (const m of readFileSync(p, 'utf8').matchAll(/\/img\/screens\/([\w-]+)\.png/g)) used.add(m[1]); } };
  walk(join(SITE, 'docs'));
  const names = new Set(shots.map((s: any) => s.name));
  const unmanaged = [...used].filter((u) => !names.has(u));
  ok(unmanaged.length === 0, `every screenshot a guide shows is in the manifest, so it gets retaken${unmanaged.length ? ' (not: ' + unmanaged.join(', ') + ')' : ''}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); console.log(`\n${passed} passed, ${failed + 1} failed`); process.exit(1); });
