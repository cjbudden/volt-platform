// ============================================================================
//  LIVE UPDATES — THE DECISION, NOT THE SOCKET.
//
//  Two admins on one record. The 409 already existed and it is the wrong end of
//  the problem: it fires AFTER an operator has retyped a form against a record
//  they could not see. The new part tells them while the form is still open.
//
//  THE ONE THAT MATTERS IS OUR OWN WRITE COMING BACK. The SSE hub fans out to
//  every subscriber on the account, INCLUDING the client that caused the change.
//  Without a baseline check, every save an operator made would pop a banner
//  accusing them of conflicting with themselves — and a warning that fires on
//  the happy path is a warning nobody reads, which makes the real one invisible
//  too. That is why `isForeignEdit` exists and why it is pure.
//
//  ALSO PINNED, structurally: that `patchEntity` is the only publisher. It is
//  the single function that changes a record, so it is the only place that can
//  be certain a change happened and what changed. Four call sites once wrote
//  `on_air` and disagreed about whether to record anything; a caller that has to
//  remember to publish is a caller that will forget.
//
//  AND THAT VALUES NEVER TRAVEL. The frame carries column NAMES, a version and a
//  user id. If it ever carried the new values, the hub would be handing every
//  admin on the account fields they may not be allowed to read, and no amount of
//  care at the receiving end could undo that.
//
//  Usage: npx tsx test/live-record.check.ts
// ============================================================================
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import './lib/react-global';   // first: the console import chain reaches a .tsx
import { isForeignEdit, mergeChange, describeFields } from '../../volt-web/src/liveRecord';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);

// ---- whose edit was it? ----------------------------------------------------
console.log('== our own save coming back around the hub is not a conflict ==');
check('a frame at the version we hold is ours', isForeignEdit(7, 7), false);
check('a frame BELOW it is stale and also ours', isForeignEdit(6, 7), false);
check('a frame above it is somebody else', isForeignEdit(8, 7), true);
// Absent is not zero, and it is not "ours" either. With nothing to compare, the
// safe answer is to tell the operator: a spurious banner is recoverable, a
// silently swallowed conflict is not.
check('a frame with no version is reported rather than dropped', isForeignEdit(null, 7), true);
check('and so is one we have no baseline for', isForeignEdit(9, null), true);
check('neither known: still reported', isForeignEdit(null, null), true);

// ---- folding several edits together ---------------------------------------
console.log('\n== several edits while the form is open read as one notice ==');
const a = mergeChange(null, { changed: ['name'], version: 8 });
check('the first edit is one edit', a.edits, 1);
check('naming the field', a.changed.join(','), 'name');
const b = mergeChange(a, { changed: ['dvr_window_sec'], version: 9 });
check('a second edit counts', b.edits, 2);
check('and both fields are carried', b.changed.sort().join(','), 'dvr_window_sec,name');
check('with the newest version', b.version, 9);
const c = mergeChange(b, { changed: ['name'], version: 10 });
// The same field twice is one field, not two. A banner that says "the name and
// the name and the DVR window" reads as a bug in the banner.
check('the same field twice is still one field', c.changed.length, 2);
check('but it is still a third edit', c.edits, 3);

// ---- what the operator actually reads --------------------------------------
console.log('\n== the notice names fields the way an operator would ==');
check('one field', describeFields(['name']), 'the name');
check('two fields', describeFields(['name', 'dvr_window_sec']), 'the name and DVR window');
check('three, with an Oxford-free list',
  describeFields(['name', 'dvr_window_sec', 'geo_mode']), 'the name, DVR window and geo rules');
// A column we have no label for is still readable, rather than being shown raw.
check('an unmapped column is de-underscored rather than shown raw',
  describeFields(['some_new_column']), 'the some new column');
check('and an empty list says something rather than nothing',
  describeFields([]), 'this record');

// ---- the rules that keep it true -------------------------------------------
console.log('\n== patchEntity is the only thing that publishes a record change ==');
const appSrc = join(__dirname, '../src');
const offenders: string[] = [];
const walk = (dir: string) => {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) { walk(p); continue; }
    if (!f.name.endsWith('.ts')) continue;
    if (p.endsWith('services/audit.ts')) continue;          // the owner
    if (p.endsWith('services/statusHub.ts')) continue;      // the transport
    const src = readFileSync(p, 'utf8');
    if (/publish\s*\(\s*[^,]+,\s*'record'/.test(src)) offenders.push(p.replace(appSrc, 'src'));
  }
};
if (existsSync(appSrc)) {
  walk(appSrc);
  check('no module publishes a record frame except the one that writes the record',
    offenders.join(', '), '');
} else {
  console.log('SKIP volt-app/src not found');
}

console.log('\n== the frame carries the shape of a change, never its content ==');
const audit = join(appSrc, 'services/audit.ts');
if (existsSync(audit)) {
  const src = readFileSync(audit, 'utf8');
  const frame = /publish\(o\.accountId,\s*'record',\s*\{([\s\S]*?)\}\);/.exec(src)?.[1] ?? '';
  // `reported` since a rename counts as one change (audit.ts diff): still the
  // keys of what moved, never their values.
  check('it names the columns that moved', /changed:\s*(cols|reported)\b/.test(frame), true);
  check('the version after the edit', /version:\s*Number\(row\.version\)/.test(frame), true);
  check('and who did it', /by:\s*o\.userId/.test(frame), true);
  // THE ASSERTION WITH TEETH. `set` and `changes` are the new VALUES; if either
  // ever reaches this object, the hub is handing every admin on the account
  // fields they may not be allowed to read.
  check('but never the new values', /\b(set|changes|patch)\b/.test(frame), false);
  check('and never the whole row', /\brow\s*[,}]|\.\.\.row/.test(frame), false);
} else {
  console.log('SKIP services/audit.ts not found');
}

console.log(`\nlive-record: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
