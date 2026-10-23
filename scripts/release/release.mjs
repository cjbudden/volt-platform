#!/usr/bin/env node
/**
 * CUT A RELEASE. One command, the same every time:
 *
 *   node scripts/release/release.mjs minor            # or major | patch | 1.4.0
 *   node scripts/release/release.mjs minor --dry-run  # show what would happen, change nothing
 *   node scripts/release/release.mjs minor --commit   # also commit the release files and tag vX.Y.Z
 *
 * It:
 *   1. reads every note in changes/unreleased/ (and refuses a malformed one)
 *   2. bumps VERSION
 *   3. writes the CUSTOMER release notes, docs-site/release-notes/<date>-v<ver>.md,
 *      from the notes with scope: core only, grouped New / Improved / Fixed / ...
 *      and by area. SaaS-platform and internal notes never reach customers.
 *   4. prepends the FULL entry (every scope) to CHANGELOG.md, for the team
 *   5. moves the notes to changes/released/v<ver>/ (the record of what shipped)
 *   6. regenerates the API reference so it carries the new version
 *   7. records the release in release/state.json (the baseline for check.mjs)
 *
 * Publishing is separate and comes after: deploy the app, then publish the docs
 * (scripts/docs/publish-docs.sh). See RELEASING.md.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, UNRELEASED, TYPES, TYPE_HEADING, unreleasedNotes, git, state } from './lib.mjs';

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const commit = args.includes('--commit');
const bump = args.find((a) => !a.startsWith('--'));
const dateArg = args.find((a) => a.startsWith('--date='))?.slice(7);
if (!bump) { console.error('usage: release.mjs <major|minor|patch|X.Y.Z> [--dry-run] [--commit] [--date=YYYY-MM-DD]'); process.exit(2); }

const prev = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();
const [ma, mi, pa] = prev.split('.').map(Number);
const version = /^\d+\.\d+\.\d+$/.test(bump) ? bump
  : bump === 'major' ? `${ma + 1}.0.0` : bump === 'minor' ? `${ma}.${mi + 1}.0` : bump === 'patch' ? `${ma}.${mi}.${pa + 1}` : null;
if (!version) { console.error(`unknown bump "${bump}"`); process.exit(2); }
const cmp = (a, b) => a.split('.').map(Number).reduce((r, x, i) => r || x - b.split('.').map(Number)[i], 0);
if (cmp(version, prev) <= 0) { console.error(`${version} is not after the current ${prev}`); process.exit(2); }
const date = dateArg ?? new Date().toLocaleDateString('en-CA') /* local date, YYYY-MM-DD */;

let notes;
try { notes = unreleasedNotes(); } catch (e) { console.error(e.message); process.exit(1); }
if (!notes.length) { console.error('No change notes in changes/unreleased/. Nothing to release (add notes with change.mjs).'); process.exit(1); }

const byScope = (s) => notes.filter((n) => n.scope === s);
const core = byScope('core');

/* ---- customer release notes: core only ---- */
// The docs site compiles release notes as MDX, where a bare `<resource>` is a
// JSX tag and `{id}` is an expression: one such line in v0.2.0 failed the whole
// docs build. Outside inline code, escape them so notes can be written plainly.
function mdxSafe(line) {
  return line.split(/(`[^`]*`)/).map((part, i) => (i % 2 ? part : part
    .replace(/[{}]/g, (c) => `\\${c}`)
    .replace(/<(?=[A-Za-z\/!])/g, '&lt;'))).join('');
}
function section(list, withArea) {
  const out = [];
  for (const t of TYPES) {
    const items = list.filter((n) => n.type === t);
    if (!items.length) continue;
    out.push(`## ${TYPE_HEADING[t]}`, '');
    for (const n of items.sort((a, b) => a.area.localeCompare(b.area))) {
      const [first, ...rest] = n.body.split('\n');
      out.push(`- ${withArea && n.area ? `**${n.area}:** ` : ''}${mdxSafe(first)}`);
      for (const l of rest) if (l.trim()) out.push(`  ${mdxSafe(l)}`);
    }
    out.push('');
  }
  return out.join('\n');
}
const areas = [...new Set(core.map((n) => n.area))].sort();
const summary = core.length
  ? `Changes to ${areas.slice(0, -1).join(', ')}${areas.length > 1 ? ' and ' : ''}${areas.at(-1)}.`
  : 'Reliability and maintenance improvements. Nothing changes in how you use Volt.';
const customer = [
  '---',
  `title: Volt ${version}`,
  `slug: v${version}`,
  `date: ${date}`,
  `description: ${JSON.stringify(summary)}`,
  `tags: [${areas.map((a) => JSON.stringify(a)).join(', ')}]`,
  '---',
  '',
  summary,
  '',
  '<!-- truncate -->',
  '',
  core.length ? section(core, true) : '',
].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
const customerFile = join(ROOT, 'docs-site', 'release-notes', `${date}-v${version}.md`);

/* ---- team changelog: everything ---- */
const team = [`## ${version} (${date})`, ''];
for (const s of ['core', 'saas', 'internal']) {
  const list = byScope(s);
  if (!list.length) continue;
  team.push(`### ${s === 'core' ? 'Product (in customer release notes)' : s === 'saas' ? 'SaaS platform' : 'Internal'}`, '');
  for (const n of list) team.push(`- ${n.type}${n.area ? ` · ${n.area}` : ''}: ${n.body.split('\n').join(' ')}`);
  team.push('');
}
const changelogPath = join(ROOT, 'CHANGELOG.md');
const header = '# Volt changelog\n\nEvery release, every change: product, SaaS platform and internal. The customer-facing subset is published as the release notes in the docs.\n\n';
const oldLog = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8').replace(/^# Volt changelog[\s\S]*?\n(?=## )/, '') : '';
const newLog = header + team.join('\n') + '\n' + oldLog;

console.log(`Release ${prev} -> ${version} (${date})`);
console.log(`  notes: ${core.length} core, ${byScope('saas').length} saas, ${byScope('internal').length} internal`);
console.log(`  customer release notes: ${customerFile.slice(ROOT.length + 1)}`);
if (dry) {
  console.log('\n--- customer release notes (dry run) ---\n' + customer + '\n--- CHANGELOG.md entry ---\n' + team.join('\n'));
  process.exit(0);
}

writeFileSync(join(ROOT, 'VERSION'), version + '\n');
writeFileSync(customerFile, customer);
writeFileSync(changelogPath, newLog);
const dest = join(ROOT, 'changes', 'released', `v${version}`);
mkdirSync(dest, { recursive: true });
for (const n of notes) renameSync(n.file, join(dest, basename(n.file)));
execFileSync('node', [join(ROOT, 'volt-app', 'scripts', 'openapi.mjs')], { stdio: 'inherit' });

const head = (() => { try { return git('rev-parse', 'HEAD'); } catch { return null; } })();
writeFileSync(join(ROOT, 'release', 'state.json'), JSON.stringify({ version, date, commit: head, previous: state() }, null, 2) + '\n');

if (commit) {
  const paths = ['VERSION', 'CHANGELOG.md', 'release/state.json', 'changes', 'volt-app/docs/openapi.json', customerFile.slice(ROOT.length + 1)];
  git('add', '-A', '--', ...paths);
  execFileSync('git', ['commit', '--no-verify', '-m', `Release v${version}`], { cwd: ROOT, stdio: 'inherit' });
  git('tag', '-a', `v${version}`, '-m', `Volt ${version}`);
  // The baseline for the next release is the release commit itself.
  const s = JSON.parse(readFileSync(join(ROOT, 'release', 'state.json'), 'utf8'));
  s.commit = git('rev-parse', 'HEAD');
  writeFileSync(join(ROOT, 'release', 'state.json'), JSON.stringify(s, null, 2) + '\n');
  git('add', 'release/state.json');
  execFileSync('git', ['commit', '--no-verify', '--amend', '--no-edit'], { cwd: ROOT, stdio: 'inherit' });
  git('tag', '-f', '-a', `v${version}`, '-m', `Volt ${version}`);
  console.log(`committed and tagged v${version}. Push with: git push && git push origin v${version}`);
} else {
  console.log(`done. Review, then commit, and tag: git tag -a v${version} -m "Volt ${version}"`);
}
console.log('next: deploy the app, then publish the docs (scripts/docs/publish-docs.sh). See RELEASING.md.');
