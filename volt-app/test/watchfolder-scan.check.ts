// ============================================================================
//  THE SCANNER, AGAINST REAL FILES IN A REAL DIRECTORY.
//
//  The rules engine is pure and pinned elsewhere. Everything interesting HERE is
//  filesystem behaviour, so this suite builds an actual folder, drops actual
//  files into it, and checks what ends up where. A mocked fs would pass while
//  every one of these failed.
//
//  THE FOUR THAT MATTER, all of them things a drop folder does in week one:
//
//    A FILE STILL BEING COPIED. `.part` is caught by hygiene, but Finder, `cp`
//    and most FTP clients write straight to the final name and let the file
//    grow. It has the right name the entire time it is half a programme. Only
//    quiet files are considered, and "quiet" is measured, not hoped for.
//
//    THE QUARANTINE FOLDER BEING SCANNED. It lives inside the watched root so an
//    operator finds it beside the drop. If the walk descends into it, every
//    rejected file is refused again on the next pass and moved onto itself,
//    forever. Asserted by scanning twice and checking nothing moves the second
//    time.
//
//    THE SAME FILE ON EVERY PASS. Without content-keyed dedupe a scan every
//    minute re-ingests the same library all day. With dedupe keyed on NAME
//    ALONE, a corrected re-drop under the same filename is silently ignored,
//    which is worse. Both directions are asserted.
//
//    ONE BAD FILE STOPPING THE SCAN. A folder with one unreadable object must
//    still ingest the other ninety-nine. A scan that aborts on the first problem
//    stops working the week somebody drops something odd in.
//
//  Usage: npx tsx test/watchfolder-scan.check.ts   (no database, no ffmpeg)
// ============================================================================
import { mkdtemp, mkdir, writeFile, rm, utimes, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scanFolder, walk, checksumFile, type ItemStore, type RecordedItem, type ScanFolder,
} from '../src/services/watchfolder/scanner';
import type { WatchRule } from '../src/services/watchfolder/rules';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);

/** The same contract the Postgres adapter implements. */
class MemoryStore implements ItemStore {
  rows: (RecordedItem & { folderId: string })[] = [];
  async isKnown(folderId: string, objectKey: string, checksum: string) {
    return this.rows.some((r) => r.folderId === folderId && r.objectKey === objectKey && r.checksum === checksum);
  }
  async record(folderId: string, _accountId: string, item: RecordedItem) {
    this.rows.push({ ...item, folderId });
  }
  async quarantineKeysInUse(folderId: string) {
    return new Set(this.rows.filter((r) => r.folderId === folderId && r.quarantineKey)
      .map((r) => r.quarantineKey!));
  }
}

const rule = (o: Partial<WatchRule> & { id: string; ordinal: number; pattern: string; targetKind: string }): WatchRule =>
  ({ name: o.id, matchType: 'glob', action: 'accept', enabled: true, ...o });

const RULES: WatchRule[] = [
  rule({ id: 'r-slate', ordinal: 10, name: 'Slates', pattern: 'slate_*.png', targetKind: 'slate', workflow: 'register' }),
  rule({ id: 'r-loop', ordinal: 20, name: 'Loops', pattern: 'loop_*.mp4', targetKind: 'loop', workflow: 'loop-ingest' }),
];

/** Write a file and age it, so it counts as quiet. */
async function drop(root: string, rel: string, body: string, ageMs = 60_000) {
  const p = join(root, rel);
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, body);
  const t = new Date(Date.now() - ageMs);
  await utimes(p, t, t);
  return p;
}

const folder = (root: string, over: Partial<ScanFolder> = {}): ScanFolder => ({
  id: 'wf-1', accountId: 'acct-1', path: root, quarantinePath: '_review',
  rules: RULES, policy: {}, minAgeMs: 5000, ...over,
});

(async () => {
  const root = await mkdtemp(join(tmpdir(), 'wf-'));

  // ---- a normal pass -------------------------------------------------------
  console.log('== a normal pass sorts the drop folder ==');
  await drop(root, 'slate_open.png', 'x'.repeat(100));
  await drop(root, 'loop_ident.mp4', 'y'.repeat(200));
  await drop(root, 'notes.pdf', 'z'.repeat(50));
  await drop(root, 'nested/slate_close.png', 'w'.repeat(80));

  const store = new MemoryStore();
  const r1 = await scanFolder(folder(root), store);
  check('every file was looked at', r1.scanned, 4);
  check('two slates and a loop were accepted', r1.accepted.length, 3);
  check('and the pdf was refused', r1.quarantined.length, 1);
  check('the refused one is the pdf', r1.quarantined[0].objectKey, 'notes.pdf');
  check('with a reason stored', /no rule matched/.test(r1.quarantined[0].reason ?? ''), true);
  check('a nested file is found too', r1.accepted.some((a) => a.objectKey === 'nested/slate_close.png'), true);
  check('and carries the workflow its rule names',
    r1.accepted.find((a) => a.objectKey === 'loop_ident.mp4')?.workflow, 'loop-ingest');

  console.log('\n== the refused file MOVED, it was not deleted and not left in place ==');
  check('it is gone from the drop', existsSync(join(root, 'notes.pdf')), false);
  check('and it is in the review folder', existsSync(join(root, '_review/notes.pdf')), true);
  check('the row says where it went', r1.quarantined[0].quarantineKey, '_review/notes.pdf');
  check('accepted files are left exactly where they are',
    existsSync(join(root, 'slate_open.png')), true);

  // ---- the second pass -----------------------------------------------------
  console.log('\n== scanning again does nothing, which is the whole point ==');
  const r2 = await scanFolder(folder(root), store);
  check('nothing new was accepted', r2.accepted.length, 0);
  check('and nothing new was refused', r2.quarantined.length, 0);
  check('everything was recognised as already handled', r2.skippedKnown, 3);
  // THE QUARANTINE FOLDER MUST NOT BE WALKED. If it were, notes.pdf would be
  // found again, refused again, and moved onto itself.
  check('the review folder was not scanned', r2.scanned, 3);
  check('and the refused file is still sitting there untouched',
    existsSync(join(root, '_review/notes.pdf')), true);

  // ---- still being written -------------------------------------------------
  console.log('\n== a file still being copied is left alone until it is quiet ==');
  await drop(root, 'slate_arriving.png', 'partial', 0);   // mtime = now
  const r3 = await scanFolder(folder(root), store);
  check('it is not ingested while it is still moving', r3.accepted.length, 0);
  check('and it is reported as too new rather than ignored',
    r3.skippedTooNew.includes('slate_arriving.png'), true);
  // Now let it settle.
  await drop(root, 'slate_arriving.png', 'the whole file now', 60_000);
  const r4 = await scanFolder(folder(root), store);
  check('once quiet it is picked up', r4.accepted.some((a) => a.objectKey === 'slate_arriving.png'), true);
  // AND THE CONTENT INGESTED IS THE FINISHED FILE, not the truncated one.
  check('with the finished content, not the partial',
    r4.accepted.find((a) => a.objectKey === 'slate_arriving.png')?.sizeBytes,
    'the whole file now'.length);

  // ---- re-drop -------------------------------------------------------------
  console.log('\n== a corrected re-drop under the same name is NOT swallowed ==');
  await drop(root, 'slate_open.png', 'x'.repeat(999));   // same name, new content
  const r5 = await scanFolder(folder(root), store);
  check('it is treated as a new item', r5.accepted.some((a) => a.objectKey === 'slate_open.png'), true);
  check('because the checksum changed',
    r5.accepted.find((a) => a.objectKey === 'slate_open.png')?.sizeBytes, 999);

  // ---- collisions in the review folder -------------------------------------
  console.log('\n== two refused files with the same name both survive the move ==');
  await drop(root, 'a/notes.pdf', 'first');
  await drop(root, 'b/notes.pdf', 'second');
  const r6 = await scanFolder(folder(root), store);
  check('both were refused', r6.quarantined.length, 2);
  const keys = r6.quarantined.map((q) => q.quarantineKey).sort();
  check('and neither overwrote the other', new Set(keys).size, 2);
  check('the suffixed one exists on disk', existsSync(join(root, keys[1]!)), true);
  const reviewFiles = (await readdir(join(root, '_review'))).sort();
  check('three files in review now, none lost', reviewFiles.length, 3);

  // ---- one bad file does not stop the scan ---------------------------------
  console.log('\n== an unreadable file is reported, and the rest still run ==');
  await drop(root, 'slate_good.png', 'fine');
  const gone = join(root, 'slate_vanishes.png');
  await drop(root, 'slate_vanishes.png', 'here for now');
  const store2 = new MemoryStore();
  // Delete it after the walk has listed it, which is exactly what a folder
  // somebody else is tidying does mid-scan.
  const r7 = await (async () => {
    const p = scanFolder(folder(root), store2);
    await rm(gone, { force: true });
    return p;
  })();
  check('the scan completed rather than throwing', typeof r7.scanned, 'number');
  check('and the healthy files still got through', r7.accepted.length > 0, true);

  // ---- walk + checksum -----------------------------------------------------
  console.log('\n== the pieces behave on their own ==');
  const listed = await walk(root, new Set(['_review']));
  check('the walk skips the review folder',
    listed.some((f) => f.startsWith('_review/')), false);
  check('and finds nested files with forward slashes',
    listed.some((f) => f === 'nested/slate_close.png'), true);
  const c1 = await checksumFile(join(root, 'slate_good.png'));
  const c2 = await checksumFile(join(root, 'slate_good.png'));
  check('a checksum is stable', c1, c2);
  check('and is a sha256', c1.length, 64);
  await drop(root, 'other.png', 'different');
  check('different content gives a different checksum',
    (await checksumFile(join(root, 'other.png'))) !== c1, true);

  await rm(root, { recursive: true, force: true });
  console.log(`\nwatchfolder-scan: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
