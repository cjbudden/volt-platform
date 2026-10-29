// ============================================================================
//  MOVING LIBRARY IMAGES BETWEEN FOLDERS AND REMOVING EMPTY FOLDERS, end to end
//  (services/media/libraryMoves.ts, docs/IMAGES.md section 18): references
//  rewritten in every shape, the old address forwards, chains collapse, a
//  folder goes only when empty. Needs DATABASE_URL (a migrated database).
//  Usage: npx tsx test/library-moves.e2e.ts
// ============================================================================
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const T = mkdtempSync(join(tmpdir(), 'volt-mv-'));
process.env.IMAGE_STORE_DIR = join(T, 'images'); process.env.IMAGE_STORE_DRIVER = 'local'; process.env.IMAGE_CACHE_DRIVER = 'none';
let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };

async function main() {
  const { one, query, pool } = await import('../src/db');
  const { imageStore } = await import('../src/services/imageStore');
  const { saveToLibrary } = await import('../src/services/media/libraryImages');
  const M = await import('../src/services/media/libraryMoves');
  const sharp = (await import('sharp')).default;
  const img = (c: string) => sharp({ create: { width: 120, height: 80, channels: 3, background: c } }).png().toBuffer();
  const acct = (await one<any>(`INSERT INTO accounts (name) VALUES ('Moves') RETURNING id`))!.id;
  const other = (await one<any>(`INSERT INTO accounts (name) VALUES ('Other') RETURNING id`))!.id;
  const kA = await saveToLibrary(acct, 'slates', 'a b.png', await img('#f00'), 'image/png', 'slate', {});
  const kBak = await saveToLibrary(acct, 'slates', 'a b.png.bak', await img('#0f0'), 'image/png', 'slate', {});
  const kC = await saveToLibrary(acct, 'slates', 'c.png', await img('#00f'), 'image/png', 'slate', {});
  await saveToLibrary(acct, 'archive/2026', 'c.png', await img('#ff0'), 'image/png', 'slate', {});   // a name already taken there
  const id = async (k: string) => (await one<any>(`SELECT id FROM media_files WHERE store_key = $1`, [k]))!.id;
  const idA = await id(kA), idC = await id(kC);

  // Things that use the images, in the shapes they are stored in.
  const g = (await one<any>(`INSERT INTO groups (account_id, name) VALUES ($1, 'G') RETURNING id`, [acct]))!.id;
  const ch = (await one<any>(`INSERT INTO channels (group_id, name, filler_slate_ref) VALUES ($1, 'Ch', 'slates/a b.png') RETURNING id`, [g]))!.id;
  const og = (await one<any>(`INSERT INTO groups (account_id, name) VALUES ($1, 'G2') RETURNING id`, [other]))!.id;
  const och = (await one<any>(`INSERT INTO channels (group_id, name, filler_slate_ref) VALUES ($1, 'Other ch', 'slates/a b.png') RETURNING id`, [og]))!.id;
  await query(`UPDATE accounts SET brand_logo_ref = $2 WHERE id = $1`, [acct, `/${kA}`]);
  const v = (await one<any>(`INSERT INTO vod_assets (account_id, source_kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, poster_key, metadata)
    VALUES ($1,'upload','V','/x',0,1,1,$2,$3) RETURNING id`, [acct, kA, JSON.stringify({ image: `/${kA}`, backup: `/${kBak}`,
      link: `https://img.example.com/img/SIG/640x360,cover/library/${acct}/slates/a%20b.png`, nested: { list: [`/${kC}`] } })]))!.id;
  await query(`INSERT INTO vod_asset_images (asset_id, account_id, type_key, image_key) VALUES ($1,$2,'hero',$3)`, [v, acct, kA]);

  console.log('== moving ==');
  const r = await M.moveFiles(acct, [idA, idC], 'archive/2026', { userId: null });
  const nA = `library/${acct}/archive/2026/a b.png`;
  ok(r.moved.length === 1 && r.moved[0].to === 'archive/2026/a b.png', 'moved the one that fits', JSON.stringify(r));
  ok(r.skipped.length === 1 && /already in archive\/2026/.test(r.skipped[0].reason), 'a name already taken there is skipped and said');
  ok(!!(await imageStore().stat(nA)) && (await one<any>(`SELECT path, folder, store_key FROM media_files WHERE id = $1`, [idA]))!.store_key === nA, 'bytes and row moved');
  const a = (await one<any>(`SELECT poster_key, metadata FROM vod_assets WHERE id = $1`, [v]))!;
  ok(a.poster_key === nA, 'asset main image rewritten');
  ok(a.metadata.image === `/${nA}`, 'metadata image field rewritten');
  ok(a.metadata.link === `https://img.example.com/img/SIG/640x360,cover/library/${acct}/archive/2026/a%20b.png`, 'a percent-encoded URL rewritten', a.metadata.link);
  ok(a.metadata.backup === `/${kBak}`, 'a.png.bak is a different file: untouched');
  ok(a.metadata.nested.list[0] === `/${kC}`, 'the skipped image is untouched');
  ok((await one<any>(`SELECT image_key FROM vod_asset_images WHERE asset_id = $1`, [v]))!.image_key === nA, 'typed asset image rewritten');
  ok((await one<any>(`SELECT brand_logo_ref FROM accounts WHERE id = $1`, [acct]))!.brand_logo_ref === `/${nA}`, 'account logo rewritten');
  ok((await one<any>(`SELECT filler_slate_ref FROM channels WHERE id = $1`, [ch]))!.filler_slate_ref === 'archive/2026/a b.png', 'a channel slate held as a bare path rewritten');
  ok((await one<any>(`SELECT filler_slate_ref FROM channels WHERE id = $1`, [och]))!.filler_slate_ref === 'slates/a b.png', "another account's channel with the same path is untouched");
  ok(Object.values(r.references).reduce((x, y) => x + y, 0) >= 5, 'references counted', JSON.stringify(r.references));

  console.log('== forwarding ==');
  const old = await imageStore().get(kA);
  ok(!!old && old.length > 0, 'the old key still reads (forwarded)');
  ok(!(await imageStore().exists(kA)), 'but nothing is stored at the old key');
  const { signedImageUrl, imageService } = await import('../src/modules/images');
  const u = new URL(signedImageUrl(kA, '64x64,cover'), 'http://x');
  const parts = u.pathname.replace(/^\/img\//, '').split('/');
  const out = await imageService().handle(parts[0], decodeURIComponent(parts.slice(1).join('/')));
  ok(out.contentType?.startsWith('image/') && out.body.length > 0, 'a signed image URL made before the move still renders');

  console.log('== moving again and back ==');
  await M.moveFiles(acct, [idA], 'posters', { userId: null });
  const nA2 = `library/${acct}/posters/a b.png`;
  const fw = await query<any>(`SELECT old_key, new_key FROM media_file_moves WHERE account_id = $1 ORDER BY old_key`, [acct]);
  ok(fw.length === 2 && fw.every((f) => f.new_key === nA2), 'chains collapse to the newest place', JSON.stringify(fw));
  await M.moveFiles(acct, [idA], 'slates', { userId: null });
  const fw2 = await query<any>(`SELECT old_key FROM media_file_moves WHERE account_id = $1`, [acct]);
  ok(!fw2.some((f) => f.old_key === kA), 'moved back: the original key needs no forwarding');
  ok((await one<any>(`SELECT poster_key FROM vod_assets WHERE id = $1`, [v]))!.poster_key === kA, 'references follow it back');
  ok((await M.moveFiles(acct, [idA], 'slates', { userId: null })).skipped[0]?.reason === 'already in that folder', 'same folder: nothing to do');
  await M.moveFiles(acct, [idC], '', { userId: null });
  ok((await one<any>(`SELECT path FROM media_files WHERE id = $1`, [idC]))!.path === 'c.png', 'to the top level');

  console.log('== deleting folders ==');
  let e1: any = null; try { await M.deleteFolder(acct, 'slates'); } catch (e) { e1 = e; }
  ok(e1?.status === 409 && /holds 2 images \(2 here\)/.test(e1.message), 'a folder with images is refused', e1?.message);
  let e2: any = null; try { await M.deleteFolder(acct, 'archive'); } catch (e) { e2 = e; }
  ok(e2?.status === 409 && /in folders inside it/.test(e2.message) && e2.contents.inSubfolders === 1, 'images in a folder below count too', e2?.message);
  await query(`INSERT INTO media_folders (account_id, path) VALUES ($1,'empty'),($1,'empty/sub'),($1,'emptyish')`, [acct]);
  const c = await M.folderContents(acct, 'empty');
  ok(c.images === 0 && c.subfolders.join() === 'empty/sub', 'contents of an empty folder');
  const d = await M.deleteFolder(acct, 'empty');
  ok(d.removed.join() === 'empty,empty/sub', 'an empty folder goes, with its empty subfolders');
  ok((await one<any>(`SELECT 1 AS x FROM media_folders WHERE account_id = $1 AND path = 'emptyish'`, [acct]))?.x === 1, '"emptyish" is not inside "empty"');
  let e3: any = null; try { await M.deleteFolder(acct, 'nope'); } catch (e) { e3 = e; }
  ok(e3?.status === 404, 'no such folder');
  let e4: any = null; try { await M.deleteFolder(other, 'slates'); } catch (e) { e4 = e; }
  ok(e4?.status === 404, "another account's folder is not this account's");

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end(); process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
