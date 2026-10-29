// ============================================================================
//  REPLACING AN IMAGE WITH ANOTHER (services/media/libraryMoves.ts findUses,
//  replaceImages, mergeDuplicates; docs/IMAGES.md section 18).
//
//    * where an image is used, in words (a channel, an asset, a song lookup);
//    * replacing images with one that stays: every use moves to it, the
//      removed images' addresses forward to it, and they go to the restore bin;
//    * restoring puts the files and rows back at their own addresses;
//    * duplicates merge one group at a time, through the same path;
//    * what cannot be replaced says why.
//
//  Needs Postgres (DATABASE_URL, migrations applied).
//  Usage: npx tsx test/library-replace.check.ts
// ============================================================================
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const ROOT = mkdtempSync(join(tmpdir(), 'lib-replace-'));
process.env.IMAGE_STORE_DIR = join(ROOT, 'store');
process.env.VOLT_TRASH_DIR = join(ROOT, 'trash');

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`));

async function main() {
  const { query, one, pool } = await import('../src/db');
  const { imageStore } = await import('../src/services/imageStore');
  const M = await import('../src/services/media/libraryMoves');
  const { restoreItem } = await import('../src/services/media/trash');
  const store = imageStore();

  const ACC = randomUUID(), GRP = randomUUID(), CH = randomUUID(), VOD = randomUUID();
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'ReplaceCo')`, [ACC]);
  await query(`INSERT INTO groups(id,account_id,name) VALUES ($1,$2,'G')`, [GRP, ACC]);
  const img = async (path: string, bytes: string, source = 'upload') => {
    const key = `library/${ACC}/${path}`;
    await store.put(key, Buffer.from(bytes), 'image/png');
    const sum = createHash('sha256').update(bytes).digest('hex');
    const r = await one<any>(`INSERT INTO media_files(account_id, kind, path, folder, name, store_key, source, size_bytes, checksum)
                              VALUES ($1,'brand',$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [ACC, path, path.split('/').slice(0, -1).join('/'), path.split('/').pop(), key, source, bytes.length, sum]);
    return { id: r.id as string, key, path };
  };
  const A = await img('brands/jazz.png', 'the-good-logo');
  const B = await img('brand/jazz-copy.png', 'the-good-logo');            // same bytes as A
  const C = await img('covers/jazz-old.png', 'an-older-export-of-it');    // the same picture, another file

  await query(`INSERT INTO channels(id,group_id,name,status,tz,kind,brand_ref) VALUES ($1,$2,'Jazz FM','ended','UTC','radio',$3)`, [CH, GRP, C.path]);
  await query(`INSERT INTO vod_assets(id, account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, poster_key, music_lookup)
               VALUES ($1,$2,'upload','export','Late Show',0,0,1000,$3,$4::jsonb)`, [VOD, ACC, B.key, JSON.stringify({ cover: C.key })]);

  console.log('== where an image is used ==');
  M.forgetReferenceColumns();
  const uses = await M.findUses(ACC, [A, B, C].map((x) => ({ id: x.id, storeKey: x.key, path: x.path })));
  check('A is not used', uses[A.id].length, 0);
  check('B: an asset\'s main image', uses[B.id].map((u) => `${u.what}:${u.label}:${u.column}`), ['Asset:Late Show:poster_key']);
  check('C: a channel\'s brand and a song lookup', uses[C.id].map((u) => `${u.what}:${u.label}:${u.column}`).sort(), ['Asset:Late Show:music_lookup', 'Channel:Jazz FM:brand_ref']);

  console.log('== replacing with the one that stays ==');
  const r = await M.replaceImages(ACC, A.id, [B.id, C.id], { userId: null });
  check('two removed', r.removed.map((x) => x.path).sort(), [B.path, C.path].sort());
  check('the channel uses the kept image', (await one<any>(`SELECT brand_ref FROM channels WHERE id = $1`, [CH])).brand_ref, A.path);
  const v = await one<any>(`SELECT poster_key, music_lookup FROM vod_assets WHERE id = $1`, [VOD]);
  check('the asset\'s main image and its song lookup too', [v.poster_key, v.music_lookup.cover], [A.key, A.key]);
  const usesAfter = await M.findUses(ACC, [{ id: A.id, storeKey: A.key, path: A.path }]);
  check('the kept image now has all three uses', usesAfter[A.id].length, 3);
  check('the removed rows are gone from the library', (await query<any>(`SELECT 1 FROM media_files WHERE id = ANY($1::uuid[])`, [[B.id, C.id]])).length, 0);
  check('their old addresses open the kept image', [(await store.get(B.key))?.toString(), (await store.get(C.key))?.toString()], ['the-good-logo', 'the-good-logo']);
  check('the brand folder they emptied is gone', (await query<any>(`SELECT 1 FROM media_files WHERE account_id = $1 AND folder IN ('brand', 'covers')`, [ACC])).length, 0);
  const item = await one<any>(`SELECT kind, state, label FROM trash_items WHERE id = $1`, [r.binId]);
  check('they are in the restore bin', [item?.kind, item?.state], ['media_file', 'held']);

  console.log('== restoring ==');
  await restoreItem(r.binId!);
  check('both rows are back', (await query<any>(`SELECT 1 FROM media_files WHERE id = ANY($1::uuid[])`, [[B.id, C.id]])).length, 2);
  check('at their own addresses, with their own bytes', [(await store.get(B.key))?.toString(), (await store.get(C.key))?.toString()], ['the-good-logo', 'an-older-export-of-it']);
  check('no longer forwarded', await M.resolveMoved(C.key), null);
  check('uses stay on the kept image', (await one<any>(`SELECT brand_ref FROM channels WHERE id = $1`, [CH])).brand_ref, A.path);

  console.log('== duplicates, one group at a time ==');
  const groups = await M.findDuplicates(ACC);
  check('A and B are one group', groups.map((g) => [g.keep.id, ...g.drop.map((d) => d.id)].sort()), [[A.id, B.id].sort()]);
  const keepB = await M.mergeDuplicates(ACC, { keepers: { [groups[0].checksum]: B.id }, checksums: [groups[0].checksum] });
  check('merging keeps the chosen copy', [keepB.removed, (await query<any>(`SELECT id FROM media_files WHERE id = ANY($1::uuid[])`, [[A.id, B.id]])).map((x: any) => x.id)], [1, [B.id]]);
  check('and moves A\'s uses to it', (await one<any>(`SELECT brand_ref FROM channels WHERE id = $1`, [CH])).brand_ref, B.path);
  truthy('through the bin', keepB.binIds.length === 1);

  console.log('== what cannot be replaced ==');
  const still = await img('thumbnails/x/still.jpg', 'a-still', 'encoder');
  for (const [m, keep, drop, rx] of [
    ['nothing else chosen', B.id, [B.id], /at least one/],
    ['an encoder still', B.id, [still.id], /Encoder stills/],
    ['an unknown image', B.id, [randomUUID()], /not found/],
  ] as const) {
    try { await M.replaceImages(ACC, keep, [...drop], { userId: null }); bad(m, 'did not refuse'); }
    catch (e: any) { (e instanceof M.ReplaceError && rx.test(e.message)) ? ok(`refuses ${m}: ${e.message}`) : bad(m, e.message); }
  }

  await query(`DELETE FROM trash_items WHERE account_id = $1`, [ACC]);
  await query(`DELETE FROM accounts WHERE id = $1`, [ACC]);
  await pool.end();
  rmSync(ROOT, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected truthy, got [${String(v)}]`));

main().catch((e) => { console.error(e); process.exit(1); });
