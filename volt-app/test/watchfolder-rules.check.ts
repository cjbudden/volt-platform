// ============================================================================
//  WATCHFOLDER RULES — AND THE FILES THAT DO NOT BELONG.
//
//  A drop folder takes slates, loops, posters and finished VOD named by whatever
//  convention the edit suite uses. The interesting cases are not the ones that
//  match. They are:
//
//    THE FILE THAT MATCHES TWO RULES. `*.png -> poster` and `slate_*.png ->
//    slate` both match `slate_open.png`. Without a defined order the winner is
//    whatever the database happened to return first, and it changes the day
//    somebody adds an index. Ordinal, ascending, first match — asserted both
//    ways round so a stable-sort accident cannot pass it.
//
//    THE FILE THAT MATCHES NOTHING. It must not be ingested as `other`, which
//    fills the library with things nobody can identify later, and it must not be
//    deleted, which destroys the only copy of a file whose crime was an
//    unexpected name. It is refused, moved, and the reason recorded.
//
//    THE FILE THAT IS NOT A FILE YET. A `.part` still being copied, or a
//    correctly-named zero-byte file left by a failed copy. Classified by name
//    alone, both become valid-looking assets that contain nothing — the quiet
//    failure that reaches a playout list before anyone notices.
//
//    TWO REJECTS WITH THE SAME NAME. `a/output.mov` and `b/output.mov` both
//    refused, both moved to `_review`. If the second overwrites the first, the
//    queue holds two rows and one file, and an operator reviews a file that is
//    not the one the row describes.
//
//  Usage: npx tsx test/watchfolder-rules.check.ts   (pure; no database)
// ============================================================================
import { classify, matches, hygiene, globToRegExp, quarantineKey, type WatchRule } from '../src/services/watchfolder/rules';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);

const rule = (o: Partial<WatchRule> & { id: string; ordinal: number; pattern: string; targetKind: string }): WatchRule =>
  ({ name: o.id, matchType: 'glob', action: 'accept', enabled: true, ...o });

const RULES: WatchRule[] = [
  rule({ id: 'r-slate', ordinal: 10, name: 'Slates', pattern: 'slate_*.png', targetKind: 'slate', workflow: 'register' }),
  rule({ id: 'r-loop', ordinal: 20, name: 'Loops', pattern: 'loop_*.mp4', targetKind: 'loop', workflow: 'loop-ingest' }),
  rule({ id: 'r-vod', ordinal: 30, name: 'VOD masters', pattern: '*_MASTER.mov', targetKind: 'vod', workflow: 'vod-publish' }),
  rule({ id: 'r-img', ordinal: 40, name: 'Images', pattern: '*.png', targetKind: 'poster', workflow: 'register' }),
  rule({ id: 'r-proj', ordinal: 50, name: 'Project files', pattern: '*.prproj', targetKind: 'other',
         action: 'reject', rejectReason: 'edit project files are not media and are never wanted here' }),
];

// ---- hygiene ---------------------------------------------------------------
console.log('== filesystem artefacts never reach the rules ==');
check('.DS_Store is refused', hygiene('.DS_Store', 6120) !== null, true);
check('an Office lock file is refused', hygiene('~$brief.docx', 200) !== null, true);
check('an AppleDouble sidecar is refused', hygiene('._clip.mov', 4096) !== null, true);
// STILL BEING WRITTEN. Classified by name this is a valid asset that is half a file.
check('a .part upload in flight is refused', hygiene('master.mov.part', 900000) !== null, true);
check('and a .crdownload too', hygiene('promo.mp4.crdownload', 12) !== null, true);
// THE QUIET ONE.
check('a correctly-named zero-byte file is refused', hygiene('slate_open.png', 0) !== null, true);
check('and says the copy did not finish', /copy did not finish/.test(hygiene('slate_open.png', 0) ?? ''), true);
check('a normal file passes hygiene', hygiene('slate_open.png', 51200), null);
// A leading dot is not automatically junk.
check('a legitimate dotfile is not treated as junk', hygiene('.brandrc.png', 900), null);

// ---- matching --------------------------------------------------------------
console.log('\n== globs behave like an operator expects ==');
check('* spans anything', globToRegExp('slate_*.png').test('slate_open.png'), true);
check('and is anchored at both ends', globToRegExp('slate_*.png').test('a_slate_open.png.bak'), false);
check('? is exactly one character', globToRegExp('cam?.mp4').test('cam1.mp4'), true);
check('not two', globToRegExp('cam?.mp4').test('cam12.mp4'), false);
check('a dot is literal, not any-character',
  globToRegExp('promo.mp4').test('promoxmp4'), false);
check('matching is case-insensitive', globToRegExp('*.PNG').test('slate.png'), true);
check('the path is stripped before matching',
  matches(RULES[0], 'incoming/2026/slate_open.png'), true);

console.log('\n== a broken regex refuses its own rule, it does not break the scan ==');
const badRe = rule({ id: 'r-bad', ordinal: 1, pattern: '([unclosed', targetKind: 'other', matchType: 'regex' });
check('an unclosed group simply does not match', matches(badRe, 'anything.png'), false);
check('and classification still completes',
  classify('slate_open.png', 1000, [badRe, ...RULES]).decision, 'accept');

// ---- order -----------------------------------------------------------------
console.log('\n== two rules match: the ORDER decides, not the array ==');
const both = classify('slate_open.png', 51200, RULES);
check('the more specific rule wins because it is first', both.decision === 'accept' && both.targetKind, 'slate');
// Asserted in the other direction too: if this only passed because the array
// happened to be in ordinal order, reversing it would change the answer.
const reversed = classify('slate_open.png', 51200, [...RULES].reverse());
check('and it still wins when the rules arrive in the wrong order',
  reversed.decision === 'accept' && reversed.targetKind, 'slate');
// Change the ordinal and the answer must change, or the sort is decorative.
const reordered = RULES.map((r) => r.id === 'r-img' ? { ...r, ordinal: 5 } : r);
check('moving a rule to the top actually changes the outcome',
  (classify('slate_open.png', 51200, reordered) as any).targetKind, 'poster');

console.log('\n== a disabled rule is skipped, not merely hidden ==');
const off = RULES.map((r) => r.id === 'r-slate' ? { ...r, enabled: false } : r);
check('the next matching rule takes it', (classify('slate_open.png', 51200, off) as any).targetKind, 'poster');

// ---- the happy paths -------------------------------------------------------
console.log('\n== each convention lands on its own type and workflow ==');
const loop = classify('loop_ident_30s.mp4', 5_000_000, RULES);
check('a loop is a loop', loop.decision === 'accept' && loop.targetKind, 'loop');
check('with its workflow', loop.decision === 'accept' && loop.workflow, 'loop-ingest');
const vod = classify('EP0142_MASTER.mov', 900_000_000, RULES);
check('a master is VOD', vod.decision === 'accept' && vod.targetKind, 'vod');
check('with the publish workflow', vod.decision === 'accept' && vod.workflow, 'vod-publish');

// ---- refusal ---------------------------------------------------------------
console.log('\n== what does not belong is refused, with a reason worth reading ==');
const unknown = classify('notes.pdf', 40_000, RULES);
check('an unmatched file is quarantined, never ingested as "other"', unknown.decision, 'quarantine');
check('and the reason says a person needs to look',
  /no rule matched/.test((unknown as any).reason), true);

const rejected = classify('cut1.prproj', 2_000_000, RULES);
check('an explicit reject rule quarantines too', rejected.decision, 'quarantine');
// AN EXPLICIT REJECT IS WORTH MORE THAN A FALLTHROUGH: it tells the operator the
// rule set is right and the drop was wrong, rather than the other way round.
check('with its own reason rather than "no rule matched"',
  /never wanted here/.test((rejected as any).reason), true);
check('and it names the rule that did it', (rejected as any).ruleId, 'r-proj');

console.log('\n== a folder may opt into a fallback, and the absence of one is the safe default ==');
const withDefault = classify('notes.pdf', 40_000, RULES, { defaultTargetKind: 'other', defaultWorkflow: 'register' });
check('a declared default accepts what nothing matched', withDefault.decision, 'accept');
check('and says the default did it', withDefault.decision === 'accept' && withDefault.ruleName, 'folder default');
check('no default means quarantine', classify('notes.pdf', 40_000, RULES, {}).decision, 'quarantine');

console.log('\n== size is checked before the rules, so the reason is the true one ==');
const huge = classify('slate_open.png', 4_000_000_000, RULES, { maxBytes: 50_000_000 });
check('an oversized file is refused', huge.decision, 'quarantine');
// Reporting "no rule matched" here would send an operator to edit rules that are
// perfectly correct.
check('for its size, not for its name', /above the folder's maximum/.test((huge as any).reason), true);
check('an undersized one likewise',
  /below the folder's minimum/.test((classify('slate_open.png', 10, RULES, { minBytes: 1024 }) as any).reason), true);

// ---- where refused files go ------------------------------------------------
console.log('\n== two refused files with the same name both survive ==');
const seen = new Set<string>();
const first = quarantineKey('_review', 'incoming/a/output.mov', seen); seen.add(first);
const second = quarantineKey('_review', 'incoming/b/output.mov', seen); seen.add(second);
check('the first keeps its name', first, '_review/output.mov');
// OVERWRITING WOULD LEAVE TWO ROWS AND ONE FILE, and the operator would review a
// file that is not the one the row describes.
check('the second is suffixed rather than overwriting', second, '_review/output-2.mov');
check('and a third keeps going', quarantineKey('_review', 'c/output.mov', seen), '_review/output-3.mov');
check('the extension is preserved', second.endsWith('.mov'), true);
check('a file with no extension still works',
  quarantineKey('_review', 'x/README', new Set(['_review/README'])), '_review/README-2');
check('a messy quarantine path is normalised', quarantineKey('/_review/', 'a.png'), '_review/a.png');

console.log(`\nwatchfolder-rules: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
