#!/usr/bin/env node
// "Did this change say what it changed?"
//
//   check.mjs --staged   (the pre-commit hook) the files staged for this commit:
//                        if any is CORE, a change note must be staged with it.
//   check.mjs            (before a release) every file changed since the last
//                        release: if any is core, there must be unreleased notes.
//
// A change with nothing customer-visible still gets a note, scope: internal
// ("refactor, no visible change"). That is the point: the decision is made by
// the person who made the change, at the time, not reconstructed at release.
// Bypass once with `git commit --no-verify` (and say why in the commit).
import { git, scopeOf, relToRoot, unreleasedNotes, state } from './lib.mjs';

const staged = process.argv.includes('--staged');
let notes;
try { notes = unreleasedNotes(); } catch (e) { console.error(`change notes: ${e.message}`); process.exit(1); }

let files;
if (staged) {
  files = relToRoot(git('diff', '--cached', '--name-only', '--diff-filter=ACMRD').split('\n').filter(Boolean));
} else {
  const since = state().commit;
  const committed = since ? git('diff', '--name-only', `${since}..HEAD`).split('\n') : [];
  const working = git('status', '--porcelain').split('\n').map((l) => l.slice(3).split(' -> ').pop());
  files = relToRoot([...new Set([...committed, ...working].filter(Boolean))]);
}
const core = files.filter((f) => scopeOf(f) === 'core');
const notesInChange = staged ? files.filter((f) => f.startsWith('changes/unreleased/') && f.endsWith('.md')) : notes.map((n) => n.file);

if (!core.length) { console.log(`change notes: ok (no core files${staged ? ' staged' : ' changed since the last release'})`); process.exit(0); }
if (notesInChange.length) {
  console.log(`change notes: ok (${core.length} core file(s), ${notesInChange.length} note(s))`);
  process.exit(0);
}
console.error(`change notes: ${core.length} core file(s) ${staged ? 'staged' : 'changed'} but no change note:`);
for (const f of core.slice(0, 15)) console.error(`  ${f}`);
if (core.length > 15) console.error(`  … and ${core.length - 15} more`);
console.error(`\nAdd one (then stage it):\n  node scripts/release/change.mjs --scope core --type fixed --area <Area> "What the customer will notice."\nNothing customer-visible? Use --scope internal.`);
process.exit(1);
