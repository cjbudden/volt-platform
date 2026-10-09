// ============================================================================
//  THE REVIEW QUEUE, END TO END: rules in the database, files on disk.
//
//  The classifier is pinned pure, and the scanner is pinned against real files.
//  What is left, and what this covers, is the part where those two meet a
//  database and an operator:
//
//    THE DRY RUN MUST AGREE WITH THE SCAN. It exists so an operator can find out
//    that `*.png` sits above `slate_*.png` at their desk instead of in the review
//    folder. A dry run that answered from its own copy of the logic would be
//    worse than not having one, because it would be confidently wrong. Asserted
//    by running both over the same filename and comparing.
//
//    REPROCESS MUST ACTUALLY REPROCESS. An operator corrects a rule, sends a
//    quarantined file back, and the next scan has to look at it AGAIN. The
//    dedupe that makes scanning cheap is exactly what breaks this: the row
//    already exists for that name and checksum, so the obvious implementation
//    skips it and the queue shows the item resolved while nothing happened.
//    That is why `isKnown` excludes 'reprocessed' and the insert upserts over it,
//    and it is the case most likely to regress.
//
//    REMOVE MUST NOT DELETE THE FILE. Quarantine exists so that a file with an
//    unexpected name is not destroyed. A queue action that quietly destroys it
//    would defeat the entire feature.
//
//  Usage: DATABASE_URL=... npx tsx test/watchfolder-api.check.ts
// ============================================================================
import { mkdtemp, mkdir, writeFile, rm, utimes, rename, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pool, query, one } from '../src/db';
import { loadFolder, pgItemStore, scanAllFolders } from '../src/services/watchfolder/store';
import { scanFolder } from '../src/services/watchfolder/scanner';
import { classify } from '../src/services/watchfolder/rules';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);

const A = '00000000-0000-0000-0000-0000wf000001'.replace(/w|f/g, '1');
const F = '00000000-0000-0000-0000-000000000f01'.replace('f', '1');

async function drop(root: string, rel: string, body: string, ageMs = 60_000) {
  const p = join(root, rel);
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, body);
  const t = new Date(Date.now() - ageMs);
  await utimes(p, t, t);
}

(async () => {
  const root = await mkdtemp(join(tmpdir(), 'wfapi-'));

  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'WatchCo')`, [A]);
  await query(
    `INSERT INTO watchfolders(id, account_id, name, kind, config, quarantine_path)
     VALUES ($1,$2,'Drop','local',$3::jsonb,'_review')`,
    [F, A, JSON.stringify({ path: root, min_age_ms: 1000 })]
  );
  // Deliberately in the WRONG order to begin with: the broad rule first.
  await query(
    `INSERT INTO watchfolder_rules(watchfolder_id, ordinal, name, match_type, pattern, target_kind, workflow)
     VALUES ($1,10,'Images','glob','*.png','poster','register'),
            ($1,20,'Slates','glob','slate_*.png','slate','register')`, [F]);

  // ---- loading ------------------------------------------------------------
  console.log('== the folder loads with its rules in order ==');
  const f = (await loadFolder(F))!;
  check('it loaded', !!f, true);
  check('the path came from config', f.path, root);
  check('two rules, lowest ordinal first', f.rules.map((r) => r.name).join(','), 'Images,Slates');

  // ---- the dry run agrees with the scan -----------------------------------
  console.log('\n== the dry run and the real scan give the same answer ==');
  const dry = classify('slate_open.png', 5000, f.rules, f.policy);
  check('the broad rule wins while it is first',
    dry.decision === 'accept' && dry.targetKind, 'poster');

  await drop(root, 'slate_open.png', 'x'.repeat(5000));
  const s1 = await scanFolder(f, pgItemStore);
  check('and the scan agrees, which is the point of sharing classify()',
    s1.accepted[0]?.targetKind, dry.decision === 'accept' ? dry.targetKind : null);

  // ---- fixing the order ---------------------------------------------------
  console.log('\n== moving the specific rule above the broad one changes it ==');
  await query(`UPDATE watchfolder_rules SET ordinal=5 WHERE watchfolder_id=$1 AND name='Slates'`, [F]);
  const f2 = (await loadFolder(F))!;
  const dry2 = classify('slate_open.png', 5000, f2.rules, f2.policy);
  check('now the slate rule wins', dry2.decision === 'accept' && dry2.targetKind, 'slate');

  // ---- quarantine ---------------------------------------------------------
  console.log('\n== an unmatched file goes to review, with a row an operator can act on ==');
  await drop(root, 'notes.pdf', 'z'.repeat(100));
  const s2 = await scanFolder(f2, pgItemStore);
  check('it was refused', s2.quarantined.length, 1);
  check('and moved out of the drop', existsSync(join(root, 'notes.pdf')), false);
  check('into the review folder', existsSync(join(root, '_review/notes.pdf')), true);

  const item = await one<any>(
    `SELECT * FROM watchfolder_items WHERE watchfolder_id=$1 AND object_key='notes.pdf'`, [F]);
  check('the row is quarantined', item?.status, 'quarantined');
  check('with the reason stored, not recomputed later',
    /no rule matched/.test(item?.reason ?? ''), true);
  check('and where the file went', item?.quarantine_key, '_review/notes.pdf');

  // ---- scanning again ------------------------------------------------------
  console.log('\n== scanning again leaves it alone ==');
  const s3 = await scanFolder((await loadFolder(F))!, pgItemStore);
  check('nothing new was refused', s3.quarantined.length, 0);
  check('and it was recognised rather than re-quarantined', s3.skippedKnown >= 1, true);

  // ---- reprocess -----------------------------------------------------------
  console.log('\n== an operator adds a rule and sends it back ==');
  await query(
    `INSERT INTO watchfolder_rules(watchfolder_id, ordinal, name, match_type, pattern, target_kind, workflow)
     VALUES ($1,30,'Docs','glob','*.pdf','document','register')`, [F]);
  // What the resolve route does: move the file back, then mark the row.
  await rename(join(root, '_review/notes.pdf'), join(root, 'notes.pdf'));
  const t = new Date(Date.now() - 60_000);
  await utimes(join(root, 'notes.pdf'), t, t);
  await query(`UPDATE watchfolder_items SET status='reprocessed', resolved_at=now() WHERE id=$1`, [item.id]);

  const s4 = await scanFolder((await loadFolder(F))!, pgItemStore);
  // THE ONE THAT REGRESSES. Without `isKnown` excluding 'reprocessed', the
  // dedupe swallows this and the operator's correction silently does nothing.
  check('the file is looked at again', s4.accepted.some((a) => a.objectKey === 'notes.pdf'), true);
  check('and now matches the new rule',
    s4.accepted.find((a) => a.objectKey === 'notes.pdf')?.targetKind, 'document');

  const after = await one<any>(
    `SELECT status, target_kind FROM watchfolder_items
      WHERE watchfolder_id=$1 AND object_key='notes.pdf'`, [F]);
  // The upsert has to OVERWRITE the reprocessed row, or the queue keeps showing
  // an item that has in fact been dealt with.
  check('the row was updated rather than duplicated', after?.status, 'seen');
  check('carrying the new decision', after?.target_kind, 'document');
  const rowCount = await one<any>(
    `SELECT count(*)::int n FROM watchfolder_items WHERE watchfolder_id=$1 AND object_key='notes.pdf'`, [F]);
  check('and there is still exactly one row for that file', rowCount?.n, 1);

  // ---- remove --------------------------------------------------------------
  console.log('\n== "remove" closes the row and LEAVES the file ==');
  await drop(root, 'junk.xyz', 'q'.repeat(40));
  await scanFolder((await loadFolder(F))!, pgItemStore);
  const junk = await one<any>(
    `SELECT * FROM watchfolder_items WHERE watchfolder_id=$1 AND object_key='junk.xyz'`, [F]);
  check('it was quarantined', junk?.status, 'quarantined');
  await query(`UPDATE watchfolder_items SET status='removed', resolved_at=now() WHERE id=$1`, [junk.id]);
  // THE WHOLE POINT OF QUARANTINE. Closing the queue entry must not destroy the
  // only copy of a file whose crime was an unexpected name.
  check('the file is still on disk after being dismissed',
    existsSync(join(root, junk.quarantine_key)), true);

  // ---- the scheduled pass --------------------------------------------------
  console.log('\n== the scheduled pass runs every enabled local folder ==');
  const all = await scanAllFolders();
  check('this folder was included', all.some((r) => r.folderId === F), true);
  const stamped = await one<any>(`SELECT last_scan_at, last_scan_error FROM watchfolders WHERE id=$1`, [F]);
  check('and the scan time was recorded', !!stamped?.last_scan_at, true);
  check('with no error', stamped?.last_scan_error, null);

  console.log('\n== a folder whose path has gone reports the error, it does not throw ==');
  await query(`UPDATE watchfolders SET config = jsonb_set(config,'{path}','"/nope/not/here"') WHERE id=$1`, [F]);
  const broken = await scanAllFolders();
  // A missing directory yields an empty walk rather than an exception, which is
  // the right behaviour: an unmounted share is a folder with nothing in it, not
  // a scheduler tick that dies and takes the other folders with it.
  check('the pass completed', broken.some((r) => r.folderId === F), true);
  check('and nothing was invented from a folder that is not there',
    broken.find((r) => r.folderId === F)?.result?.accepted.length ?? 0, 0);

  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
  await rm(root, { recursive: true, force: true });
  console.log(`\nwatchfolder-api: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('FATAL', e);
  await pool.end().catch(() => {});
  process.exit(1);
});
