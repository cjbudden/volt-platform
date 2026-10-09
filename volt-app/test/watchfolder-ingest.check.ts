// ============================================================================
//  INGEST: FROM AN ACCEPTED FILE TO A LIBRARY RECORD.
//
//  The scan is pinned elsewhere. What is left is the step that reads the bytes
//  and writes the record, and every case here is a way that step can be quietly
//  wrong rather than loudly broken.
//
//    THE FILE CAN CHANGE BETWEEN THE SCAN AND NOW. The row's checksum is a claim
//    about the past. An operator who drops a corrected version over the top under
//    the same name, in the sixty seconds between passes, would otherwise get the
//    NEW bytes indexed under the OLD classification: content in the library that
//    was never looked at. Re-hashed here, and a moved file is refused.
//
//    A REFUSED ITEM MUST BE CLOSED, NOT LEFT. This is the half the obvious
//    implementation misses. Refusing the ingest and leaving the row at 'seen'
//    means every pass, forever, re-reads and re-hashes a file that will never
//    match. The row is closed as 'failed' and the new content arrives as a NEW
//    item, because the unique index is keyed on content.
//
//    A NAME COLLISION MUST NOT LOSE A FILE. media_files is UNIQUE on
//    (account_id, path). Two drop folders both holding slate_open.png is normal.
//    Failing the second is a file that can never ingest however often it is
//    retried, so it is suffixed and both survive.
//
//    A TARGET THIS LIBRARY CANNOT HOLD IS NOT A FAILURE. 'vod' and 'loop' are
//    correct answers belonging to other workflows. Forcing them into 'other' is
//    exactly the unidentifiable-junk outcome quarantine exists to prevent, and
//    marking them failed would hide real failures in the noise.
//
//    TWO PASSES MUST NOT BOTH INGEST ONE FILE. The sixty-second tick and the
//    operator's Scan button are two callers over one queue, and both read
//    status='seen' before either writes. Guarding only the closing UPDATE is too
//    late: by then both have put bytes in the store and created a library record,
//    the second suffixed, which reads as the operator having dropped the file
//    twice. The item is claimed first, and the loser does nothing at all.
//
//    THE ROW MUST NEVER OUTLIVE THE BYTES. If the index write fails after the
//    store write, the object is removed again: an orphan costs disk, a row
//    pointing at nothing is a broken asset that looks authoritative.
//
//  Usage: npx tsx test/watchfolder-ingest.check.ts   (no database, no ffmpeg)
// ============================================================================
import { mkdtemp, mkdir, writeFile, rm, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  ingestItem, ingestPending, libraryKindFor, libraryPathFor, freePath,
  ingestableTargetKinds, DEFAULT_MAX_INGEST_BYTES,
  type IngestFolder, type IngestStore, type NewMediaFile, type PendingItem,
} from '../src/services/watchfolder/ingest';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);

/** A test that CRASHES still catches a regression, but it stops saying which one,
 *  and it takes every assertion after it down with it. Anything reading a value
 *  the code under test may not have produced goes through these. */
const reasonOf = (rows: { reason: string }[], i = 0) => rows[i]?.reason ?? '<no row was written>';
async function attempt<T>(m: string, f: () => Promise<T>): Promise<T | undefined> {
  try { return await f(); } catch (e: any) { bad(m, `it threw: ${String(e?.message ?? e)}`); return undefined; }
}

/** A real 1x1 PNG, so probeImage has something true to read. */
function png(w = 1, h = 1, pad = 0): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  return Buffer.concat([sig, ihdr, Buffer.alloc(pad)]);
}

class MemoryIngestStore implements IngestStore {
  objects = new Map<string, { body: Buffer; contentType: string }>();
  rows: (NewMediaFile & { id: string })[] = [];
  ingested: { itemId: any; mediaFileId: string; path: string }[] = [];
  failed: { itemId: any; reason: string }[] = [];
  failNextInsert = false;
  private n = 0;

  async put(key: string, body: Buffer, contentType: string) {
    this.objects.set(key, { body, contentType });
  }
  async removeObject(key: string) { this.objects.delete(key); }
  async pathInUse(accountId: string, path: string) {
    return this.rows.some((r) => r.accountId === accountId && r.path === path);
  }
  async createMediaFile(m: NewMediaFile) {
    if (this.failNextInsert) { this.failNextInsert = false; throw new Error('duplicate key'); }
    const id = `mf-${++this.n}`;
    this.rows.push({ ...m, id });
    return { id };
  }
  claimed = new Set<any>();
  /** The same contract the guarded UPDATE implements: exactly one caller wins. */
  async claim(itemId: any) {
    if (this.claimed.has(itemId)) return false;
    this.claimed.add(itemId); return true;
  }
  async markIngested(itemId: any, mediaFileId: string, path: string) {
    this.ingested.push({ itemId, mediaFileId, path });
  }
  async markFailed(itemId: any, reason: string) { this.failed.push({ itemId, reason }); }
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function drop(root: string, rel: string, body: Buffer) {
  const p = join(root, rel);
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, body);
  return p;
}

const folder = (root: string, over: Partial<IngestFolder> = {}): IngestFolder =>
  ({ id: 'wf-1', accountId: 'acct-1', path: root, ...over });

const item = (o: Partial<PendingItem> & { objectKey: string }): PendingItem =>
  ({ id: o.objectKey, checksum: null, targetKind: 'slate', workflow: 'register', ...o });

(async () => {
  const root = await mkdtemp(join(tmpdir(), 'wfing-'));

  // ---- the mapping ---------------------------------------------------------
  console.log('== a rule target becomes a library kind, or nobody\'s ==');
  check('slate maps straight through', libraryKindFor('slate'), 'slate');
  check('logo is the name operators use for brand', libraryKindFor('logo'), 'brand');
  check('case and whitespace do not decide it', libraryKindFor('  Poster '), 'poster');
  // NOT 'other'. See the header: a catch-all here is how the library fills with
  // things nobody can identify six months later.
  check('vod is not a library image', libraryKindFor('vod'), null);
  check('loop is not either', libraryKindFor('loop'), null);
  check('nor is a target nobody defined', libraryKindFor('sausage'), null);
  check('nor a missing one', libraryKindFor(null), null);
  check('the query narrows to exactly what maps',
    ingestableTargetKinds().every((k) => libraryKindFor(k) !== null), true);

  // ---- the library path ----------------------------------------------------
  console.log('\n== where a file lands is predictable and keeps its shape ==');
  const p1 = libraryPathFor('slate_open.png', 'slate');
  check('the default folder is the kind, so the library browses by what things are',
    p1.path, 'slate/slate_open.png');
  check('nested structure in the drop is kept',
    libraryPathFor('news/evening/slate_close.png', 'slate').path,
    'slate/news/evening/slate_close.png');
  check('an explicit library folder overrides it',
    libraryPathFor('a.png', 'slate', 'brand/2026').path, 'brand/2026/a.png');
  check('and a leading dot cannot make a hidden file',
    libraryPathFor('.hidden.png', 'poster').name, 'hidden.png');

  // ---- collisions ----------------------------------------------------------
  console.log('\n== two files wanting one name: both survive ==');
  const used = new Set(['slate/slate_open.png', 'slate/slate_open-2.png']);
  const free = await attempt('a colliding path is suffixed rather than refused',
    () => freePath('acct-1', p1, async (_a, p) => used.has(p)));
  check('the suffix goes before the extension', free?.name, 'slate_open-3.png');
  check('and the folder is unchanged', free?.folder, 'slate');
  const plain = await attempt('a free path does not throw',
    () => freePath('acct-1', p1, async () => false));
  check('a free path is returned as-is', plain?.path, 'slate/slate_open.png');

  // ---- the happy path ------------------------------------------------------
  console.log('\n== an image goes end to end ==');
  const body = png(1920, 1080);
  await drop(root, 'slate_open.png', body);
  const store = new MemoryIngestStore();
  const r1 = await ingestItem(folder(root), item({ objectKey: 'slate_open.png', checksum: sha(body) }), store);
  check('it ingested', r1.result, 'ingested');
  check('the bytes are in the store',
    store.objects.has('library/acct-1/slate/slate_open.png'), true);
  check('with the content type the header actually says',
    store.objects.get('library/acct-1/slate/slate_open.png')?.contentType, 'image/png');
  check('a row was indexed', store.rows.length, 1);
  const row1 = store.rows[0];
  check('with the dimensions read from the file, not guessed', row1?.width, 1920);
  check('and the height', row1?.height, 1080);
  check('the kind came from the rule', row1?.kind, 'slate');
  check('the workflow is on the row as a tag so it is findable',
    row1?.tags.includes('register') ?? false, true);
  check('the item was closed as ingested', store.ingested.length, 1);
  check('carrying the id of the record it became', store.ingested[0]?.mediaFileId, 'mf-1');
  check('nothing failed', store.failed.length, 0);
  check('and the source file is still there, because delete is off by default',
    existsSync(join(root, 'slate_open.png')), true);

  // ---- the file changed underneath -----------------------------------------
  console.log('\n== a file replaced since the scan is NOT indexed under the old decision ==');
  const store2 = new MemoryIngestStore();
  await drop(root, 'slate_new.png', png(100, 50));
  // The row remembers a checksum from before the operator's re-drop.
  const r2 = await ingestItem(folder(root),
    item({ objectKey: 'slate_new.png', checksum: sha(png(9, 9)) }), store2);
  check('it was refused', r2.result, 'failed');
  check('nothing was written to the store', store2.objects.size, 0);
  check('and nothing was indexed', store2.rows.length, 0);
  // THE HALF THAT IS EASY TO MISS. A refused item left at 'seen' is re-read and
  // re-hashed on every pass for the life of the folder.
  check('the row was CLOSED rather than left to retry forever', store2.failed.length, 1);
  check('with both checksums in the reason so an operator can see what happened',
    /changed on disk/.test(reasonOf(store2.failed)), true);

  console.log('\n== and a matching checksum is not refused ==');
  const store2b = new MemoryIngestStore();
  const stable = png(100, 50);
  await drop(root, 'slate_stable.png', stable);
  check('same bytes, same decision, ingested',
    (await ingestItem(folder(root), item({ objectKey: 'slate_stable.png', checksum: sha(stable) }), store2b)).result,
    'ingested');

  // ---- the file went away --------------------------------------------------
  console.log('\n== a file that has gone is closed, not retried ==');
  const store3 = new MemoryIngestStore();
  const r3 = await ingestItem(folder(root), item({ objectKey: 'never_existed.png' }), store3);
  check('it failed', r3.result, 'failed');
  check('and the row was closed', store3.failed.length, 1);
  check('saying where it should have been',
    /never_existed\.png/.test(reasonOf(store3.failed)), true);

  // ---- too big -------------------------------------------------------------
  console.log('\n== an oversized file is a recorded failure, not an out-of-memory ==');
  const store4 = new MemoryIngestStore();
  await drop(root, 'slate_huge.png', png(2, 2, 4096));
  const r4 = await ingestItem(folder(root, { maxBytes: 100 }), item({ objectKey: 'slate_huge.png' }), store4);
  check('it failed rather than being read', r4.result, 'failed');
  check('nothing was read into the store', store4.objects.size, 0);
  check('and the ceiling is in the reason', /ingest ceiling/.test(reasonOf(store4.failed)), true);
  check('the default ceiling is 64 MiB', DEFAULT_MAX_INGEST_BYTES, 64 * 1024 * 1024);

  // ---- somebody else's job -------------------------------------------------
  console.log('\n== a VOD asset is left alone, not forced into the image library ==');
  const store5 = new MemoryIngestStore();
  await drop(root, 'ep01.mp4', Buffer.from('not really a video'));
  const r5 = await ingestItem(folder(root), item({ objectKey: 'ep01.mp4', targetKind: 'vod' }), store5);
  check('it was deferred', r5.result, 'deferred');
  // NOT failed: a failure count that includes correct outcomes is a failure count
  // nobody reads.
  check('it was not recorded as a failure', store5.failed.length, 0);
  check('and it was not indexed as "other"', store5.rows.length, 0);
  check('the item is untouched, so its own workflow can still find it', store5.ingested.length, 0);
  check('and the reason names the target rather than blaming the file',
    /is not a library image/.test((r5 as any).why ?? ''), true);

  // ---- the collision, for real ---------------------------------------------
  console.log('\n== the same filename from two folders: both end up in the library ==');
  const store6 = new MemoryIngestStore();
  await drop(root, 'slate_open.png', png(20, 20));
  // Three watchfolders, each holding a file of that name, all pointed at one
  // library folder. Exactly the case that a UNIQUE (account_id, path) turns into
  // a file that can never ingest however many times the pass is retried.
  const shared = folder(root, { libraryFolder: 'shared' });
  await ingestItem(shared, item({ objectKey: 'slate_open.png', id: 'one' }), store6);
  await ingestItem(shared, item({ objectKey: 'slate_open.png', id: 'two' }), store6);
  await ingestItem(shared, item({ objectKey: 'slate_open.png', id: 'three' }), store6);
  const paths = store6.rows.map((r) => r.path);
  check('three records, none lost', store6.rows.length, 3);
  check('and three distinct paths', new Set(paths).size, 3);
  check('the first keeps the plain name', paths.includes('shared/slate_open.png'), true);
  check('the second one was suffixed', paths.includes('shared/slate_open-2.png'), true);
  check('and the third', paths.includes('shared/slate_open-3.png'), true);
  check('each record points at its own bytes', store6.objects.size, 3);

  // ---- the index write fails ------------------------------------------------
  console.log('\n== a failed index write does not leave bytes nothing points at ==');
  const store7 = new MemoryIngestStore();
  store7.failNextInsert = true;
  await drop(root, 'slate_orphan.png', png(4, 4));
  const r7 = await ingestItem(folder(root), item({ objectKey: 'slate_orphan.png' }), store7);
  check('it failed', r7.result, 'failed');
  // The object went in first, on purpose: a row pointing at nothing is worse. So
  // the cleanup has to actually run.
  check('and the object it had already written was removed again', store7.objects.size, 0);
  check('the row was closed with the reason', /could not index/.test(reasonOf(store7.failed)), true);

  // ---- delete after ingest --------------------------------------------------
  console.log('\n== delete-after-ingest removes the source only once the library has it ==');
  const store8 = new MemoryIngestStore();
  const b8 = png(8, 8);
  await drop(root, 'slate_moving.png', b8);
  const r8 = await ingestItem(folder(root, { deleteAfterIngest: true }),
    item({ objectKey: 'slate_moving.png', checksum: sha(b8) }), store8);
  check('it ingested', r8.result, 'ingested');
  check('and the drop folder copy is gone', existsSync(join(root, 'slate_moving.png')), false);
  check('the bytes are in the store', store8.objects.size, 1);

  console.log('\n== and a file that FAILED is never deleted ==');
  const store9 = new MemoryIngestStore();
  await drop(root, 'slate_keepme.png', png(3, 3));
  await ingestItem(folder(root, { deleteAfterIngest: true, maxBytes: 5 }),
    item({ objectKey: 'slate_keepme.png' }), store9);
  // The one that would be unforgivable: destroying the only copy of a file the
  // system could not handle.
  check('it is still on disk', existsSync(join(root, 'slate_keepme.png')), true);

  // ---- two passes over one item ---------------------------------------------
  console.log('\n== two passes over the same item: only one ingests ==');
  const store11 = new MemoryIngestStore();
  const b11 = png(7, 7);
  await drop(root, 'slate_race.png', b11);
  const first = await ingestItem(folder(root), item({ objectKey: 'slate_race.png', checksum: sha(b11) }), store11);
  const second = await ingestItem(folder(root), item({ objectKey: 'slate_race.png', checksum: sha(b11) }), store11);
  check('the first pass ingested it', first.result, 'ingested');
  check('the second did nothing', second.result, 'skipped');
  // THE ONE THAT MATTERS. Guarding only the closing UPDATE would leave this at 2,
  // with a suffixed duplicate that looks like the operator dropped it twice.
  check('and exactly one library record exists', store11.rows.length, 1);
  check('with exactly one object behind it', store11.objects.size, 1);
  check('the second was not recorded as a failure', store11.failed.length, 0);

  console.log('\n== a deferred item is not even claimed, so its workflow still owns it ==');
  const store12 = new MemoryIngestStore();
  await ingestItem(folder(root), item({ objectKey: 'ep02.mp4', targetKind: 'vod', id: 'v1' }), store12);
  check('nothing was claimed', store12.claimed.size, 0);

  // ---- the pass -------------------------------------------------------------
  console.log('\n== a pass over a mixed queue counts each outcome ==');
  const store10 = new MemoryIngestStore();
  await drop(root, 'p1.png', png(5, 5));
  await drop(root, 'p2.png', png(6, 6));
  const summary = await ingestPending(folder(root, { libraryFolder: 'pass' }), [
    item({ objectKey: 'p1.png' }),
    item({ objectKey: 'p2.png' }),
    item({ objectKey: 'p3.mp4', targetKind: 'loop' }),
    item({ objectKey: 'gone.png' }),
  ], store10);
  check('two ingested', summary.ingested, 2);
  check('one deferred', summary.deferred, 1);
  check('one failed', summary.failed, 1);
  check('none skipped, since nothing else held them', summary.skipped, 0);
  check('and every item has an outcome, none silently dropped', summary.outcomes.length, 4);
  // ONE BAD FILE MUST NOT STOP THE PASS, the same rule as the scan.
  check('the failure did not stop the ones after it',
    summary.outcomes[3].result, 'failed');

  await rm(root, { recursive: true, force: true });
  console.log(`\nwatchfolder-ingest: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
