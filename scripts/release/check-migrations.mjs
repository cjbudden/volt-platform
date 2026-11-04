#!/usr/bin/env node
// "Can the previous release still run on this schema?" (build queue D2)
//
//   check-migrations.mjs                  every migration not shipped yet, and new boot top-ups
//   check-migrations.mjs --staged         the same, files git knows only (the pre-commit hook)
//   check-migrations.mjs --all            every migration, shipped or not (a report; the
//                                         shipped ones predate the rule)
//   check-migrations.mjs --update-baseline  record every git-tracked migration as shipped
//                                         (release.mjs does this when it cuts a release)
//   --root <dir>                          another checkout (the check suite uses this)
//
// Runs from check.mjs, so the pre-commit hook, release.mjs and deploy.mjs all
// run it. The rules and why are in migrations.mjs and RELEASING.md, "Schema".
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRepo, updateBaseline } from './migrations.mjs';

const args = process.argv.slice(2);
const rootArg = args.indexOf('--root');
const root = rootArg >= 0 ? args[rootArg + 1] : join(dirname(fileURLToPath(import.meta.url)), '..', '..');

if (args.includes('--update-baseline')) {
  const rel = args.find((a) => /^--release=/.test(a))?.slice(10);
  try {
    const added = updateBaseline(root, { release: rel });
    console.log(`migration baseline: ${added.length} migration(s) recorded as shipped${added.length ? ` (${added.join(', ')})` : ''}`);
    process.exit(0);
  } catch (e) { console.error(`migration baseline: ${e.message}`); process.exit(1); }
}

const all = args.includes('--all');
const r = checkRepo(root, { all, trackedOnly: args.includes('--staged') });
if (!r.problems.length) {
  console.log(`migration safety: ok (${r.checked} unshipped migration(s) checked${all ? '' : `, ${r.baselined} shipped`})`);
  process.exit(0);
}
const files = new Set(r.problems.map((p) => p.file));
console.error(`migration safety: ${r.problems.length} problem(s) in ${files.size} file(s)${all ? ` (of ${r.checked} checked, ignoring the baseline)` : ''}:`);
for (const p of r.problems) console.error(`  ${p.file}:${p.line}  ${p.message}`);
if (!all) console.error('\nThe rule and the way to remove something in two releases: RELEASING.md, "Schema".');
process.exit(1);
