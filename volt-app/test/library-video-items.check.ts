// ============================================================================
//  VIDEO ITEMS KEEP THEIR FILES TOGETHER (services/media/libraryMoves.ts,
//  services/motionGraphics.ts; docs/IMAGES.md section 18).
//
//  A video item is one library row and three files: its WebM (what templates
//  play), its first frame (the row's store_key) and the file as uploaded. Moving,
//  renaming, replacing and deleting it does all three; references to its WebM
//  follow a move; an item an earlier move split is put back together; and two
//  videos that open on the same empty frame are not offered as duplicates.
//
//  Needs Postgres (DATABASE_URL, migrations applied) and ffmpeg with libvpx.
//  Usage: npx tsx test/library-video-items.check.ts
// ============================================================================
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const ROOT = mkdtempSync(join(tmpdir(), 'lib-video-'));
process.env.IMAGE_STORE_DIR = join(ROOT, 'store');
process.env.VOLT_TRASH_DIR = join(ROOT, 'trash');

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`));

/** A 1 s VP9 WebM with alpha: transparent at first, a coloured box from 0.5 s. */
function alphaWebm(colour: string): Buffer | null {
  const out = join(ROOT, `${colour}.webm`);
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=black@0.0:s=64x32:r=10:d=1,format=yuva420p,drawbox=enable='gte(t,0.5)':x=0:y=0:w=32:h=16:color=${colour}@1:t=fill`,
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-metadata:s:v:0', 'alpha_mode=1', '-auto-alt-ref', '0', '-y', out]);
  return r.status === 0 ? readFileSync(out) : null;
}

async function main() {
  const { query, one, pool } = await import('../src/db');
  const { imageStore } = await import('../src/services/imageStore');
  const M = await import('../src/services/media/libraryMoves');
  const { ingestMotion } = await import('../src/services/motionGraphics');
  const { restoreItem } = await import('../src/services/media/trash');
  const store = imageStore();
  const red = alphaWebm('red'), blue = alphaWebm('blue');
  if (!red || !blue) { console.log('SKIP: ffmpeg could not make an alpha WebM'); await pool.end(); return; }

  const ACC = randomUUID(), GRP = randomUUID(), CH = randomUUID();
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'VideoCo')`, [ACC]);
  await query(`INSERT INTO groups(id,account_id,name) VALUES ($1,$2,'G')`, [GRP, ACC]);
  const L = (p: string) => `library/${ACC}/${p}`;
  const row = async (id: string) => one<any>(`SELECT * FROM media_files WHERE id = $1`, [id]);
  const whole = async (r: any) => (await Promise.all(M.partsOf(r).map((p) => store.exists(p.key)))).every(Boolean);

  const a = (await ingestMotion({ accountId: ACC, folder: 'bugs', name: 'Red Bug.webm', data: red })).row;
  const b = (await ingestMotion({ accountId: ACC, folder: 'bugs', name: 'Blue Bug.webm', data: blue })).row;
  check('an upload is three files', M.partsOf(a).map((p) => p.key).sort(), [L('bugs/Red Bug.png'), L('bugs/Red Bug.source.webm'), L('bugs/Red Bug.webm')]);
  // a channel's graphics hold the WebM directly
  await query(`INSERT INTO channels(id,group_id,name,status,tz,kind,graphics) VALUES ($1,$2,'Sport','ended','UTC','tv',$3::jsonb)`,
    [CH, GRP, JSON.stringify({ bug: { video: '/' + L('bugs/Red Bug.webm'), still: '/' + L('bugs/Red Bug.png') } })]);

  console.log('== moving a video item ==');
  M.forgetReferenceColumns();
  const mv = await M.moveFiles(ACC, [a.id], 'bugs/sport', { userId: null });
  check('moved', mv.moved.map((x) => x.to), ['bugs/sport/Red Bug.webm']);
  const a2 = await row(a.id);
  check('all three files moved with it', M.partsOf(a2).map((p) => p.key).sort(), [L('bugs/sport/Red Bug.png'), L('bugs/sport/Red Bug.source.webm'), L('bugs/sport/Red Bug.webm')]);
  check('the first frame is still the store key', a2.store_key, L('bugs/sport/Red Bug.png'));
  check('every file is there', await whole(a2), true);
  check('nothing is left in the old folder', (await store.list(L('bugs/'))).map((o) => o.key).filter((k) => k.includes('/bugs/Red Bug')), []);
  check('the WebM is a WebM and the frame a PNG', [(await store.get(a2.metadata.motion.video))!.subarray(0, 4).toString('hex'), (await store.get(a2.store_key))!.subarray(1, 4).toString()], ['1a45dfa3', 'PNG']);
  const g = (await one<any>(`SELECT graphics FROM channels WHERE id = $1`, [CH])).graphics;
  check('a channel holding the WebM and the frame follows', [g.bug.video, g.bug.still], ['/' + L('bugs/sport/Red Bug.webm'), '/' + L('bugs/sport/Red Bug.png')]);
  check('old addresses forward', [await M.resolveMoved(L('bugs/Red Bug.webm')), await M.resolveMoved(L('bugs/Red Bug.source.webm'))], [L('bugs/sport/Red Bug.webm'), L('bugs/sport/Red Bug.source.webm')]);

  console.log('== renaming ==');
  await M.relocate(ACC, [{ id: a.id, folder: 'bugs/sport', name: 'Red Sting' }], { userId: null });
  const a3 = await row(a.id);
  check('the name keeps .webm and every file follows', [a3.path, ...M.partsOf(a3).map((p) => p.key.split('/').pop())], ['bugs/sport/Red Sting.webm', 'Red Sting.png', 'Red Sting.webm', 'Red Sting.source.webm']);
  check('every file is there', await whole(a3), true);

  console.log('== an item an earlier move split ==');
  // what a move did before: the first frame went to bugs/old/Blue Bug.webm, the rest stayed
  await store.move(b.store_key, L('bugs/old/Blue Bug.webm'));
  await query(`UPDATE media_files SET folder = 'bugs/old', path = 'bugs/old/Blue Bug.webm', store_key = $2 WHERE id = $1`, [b.id, L('bugs/old/Blue Bug.webm')]);
  const rep = await M.repairVideoItems(ACC);
  check('it is put back together', rep.repaired.map((x) => x.path), ['bugs/old/Blue Bug.webm']);
  const b2 = await row(b.id);
  check('under its path', M.partsOf(b2).map((p) => p.key).sort(), [L('bugs/old/Blue Bug.png'), L('bugs/old/Blue Bug.source.webm'), L('bugs/old/Blue Bug.webm')]);
  check('the WebM is the video again and the frame a PNG', [(await store.get(b2.metadata.motion.video))!.subarray(0, 4).toString('hex'), (await store.get(b2.store_key))!.subarray(1, 4).toString()], ['1a45dfa3', 'PNG']);
  check('running it again leaves it alone', (await M.repairVideoItems(ACC)).repaired.length, 0);

  console.log('== duplicates ==');
  // both open on the same empty frame: the frame checksums match
  await query(`UPDATE media_files SET checksum = 'same-empty-first-frame' WHERE id = ANY($1::uuid[])`, [[a.id, b.id]]);
  check('videos that only share a first frame are not duplicates', (await M.findDuplicates(ACC)).length, 0);

  console.log('== replacing and deleting ==');
  const img = await one<any>(`INSERT INTO media_files(account_id, kind, path, folder, name, store_key, source) VALUES ($1,'bug','bugs/still.png','bugs','still.png',$2,'upload') RETURNING id`, [ACC, L('bugs/still.png')]);
  await store.put(L('bugs/still.png'), Buffer.from('png'), 'image/png');
  try { await M.replaceImages(ACC, img.id, [b.id], { userId: null }); bad('a video replaced by an image', 'did not refuse'); }
  catch (e: any) { /video can only be replaced with another video/.test(e.message) ? ok('a video cannot be replaced by an image') : bad('refusal', e.message); }
  const r = await M.replaceImages(ACC, a.id, [b.id], { userId: null });
  check('a video replaced by a video: all its files to the bin', await Promise.all(M.partsOf(b2).map((p) => store.exists(p.key))), [false, false, false]);
  check('each old file forwards to the same part of the one that stays',
    [await M.resolveMoved(b2.metadata.motion.video), await M.resolveMoved(b2.store_key)], [a3.metadata.motion.video, a3.store_key]);
  await restoreItem(r.binId!);
  check('restoring brings all three back', await whole(await row(b.id)), true);
  const b3 = await row(b.id);
  await M.deleteItemFiles(b3);
  check('deleting an item deletes all its files', await Promise.all(M.partsOf(b3).map((p) => store.exists(p.key))), [false, false, false]);

  await query(`DELETE FROM trash_items WHERE account_id = $1`, [ACC]);
  await query(`DELETE FROM accounts WHERE id = $1`, [ACC]);
  await pool.end();
  rmSync(ROOT, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
