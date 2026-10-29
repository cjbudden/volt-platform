// ============================================================================
//  RETENTION TIDIES FOLDERS, COUNTS FOLLOW THE GRID, SONG COVERS, AN ASSET'S OWN
//  IMAGES, DUPLICATES. End to end against Postgres and a local image store.
//  Needs DATABASE_URL (a migrated database).
//  Usage: npx tsx test/library-tidy.e2e.ts
// ============================================================================
import { mkdtempSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const T = mkdtempSync(join(tmpdir(), 'volt-r-'));
process.env.IMAGE_STORE_DIR = join(T, 'images'); process.env.IMAGE_STORE_DRIVER = 'local'; process.env.IMAGE_CACHE_DRIVER = 'none';
process.env.CLIPS_DIR = join(T, 'clips');
let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };

async function main() {
  const { one, query, pool } = await import('../src/db');
  const sharp = (await import('sharp')).default;
  const img = (c: string) => sharp({ create: { width: 160, height: 90, channels: 3, background: c } }).jpeg().toBuffer();
  const acct = (await one<any>(`INSERT INTO accounts (name) VALUES ('R') RETURNING id`))!.id;

  console.log('== covers backfill (migration 0093) ==');
  await query(`DELETE FROM schema_migrations WHERE id = '0093_covers_and_asset_image_ids.sql'`);
  const ins = (path: string, kind: string, md: any) => query(`INSERT INTO media_files (account_id, kind, path, folder, name, store_key, metadata, tags)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [acct, kind, path, path.slice(0, path.lastIndexOf('/')), path.split('/').pop(), `library/${acct}/${path}`, JSON.stringify(md), ['auto', kind]]);
  await ins('media/queen/a-night-at-the-opera/bohemian-rhapsody/cover.jpg', 'poster', { coverOf: 'musicbrainz:x' });
  await ins('media/orange-crush/singles/infinite-lights/cover.png', 'imported', { sourceUrl: 'http://x' });
  await ins('media/harbour/2026-10-01/poster-abc.jpg', 'poster', { assetId: 'x' });
  await (await import('../src/services/migrate')).migrate();
  const kinds = Object.fromEntries((await query<any>(`SELECT name, path, kind, tags FROM media_files WHERE account_id = $1`, [acct])).map((r) => [r.path, r.kind]));
  ok(kinds['media/queen/a-night-at-the-opera/bohemian-rhapsody/cover.jpg'] === 'cover' && kinds['media/orange-crush/singles/infinite-lights/cover.png'] === 'cover', 'song covers are kind cover');
  ok(kinds['media/harbour/2026-10-01/poster-abc.jpg'] === 'poster', 'an asset frame stays a poster');
  await query(`DELETE FROM media_files WHERE account_id = $1`, [acct]);
  ok((await query<any>(`SELECT 1 FROM information_schema.columns WHERE table_name = 'vod_asset_images' AND column_name = 'id'`)).length === 1, 'typed asset images have an id for the restore bin');

  console.log('== no copies ==');
  const { saveToLibrary } = await import('../src/services/media/libraryImages');
  const red = await img('#c00');
  const k1 = await saveToLibrary(acct, 'media/song-a', 'cover.jpg', red, 'image/jpeg', 'cover', { coverOf: 'mb:1' });
  const k2 = await saveToLibrary(acct, 'media/song-b', 'cover.jpg', red, 'image/jpeg', 'cover', { coverOf: 'mb:1' });
  ok(k1 === k2, 'the same bytes saved for a second song is the first file', `${k1} ${k2}`);

  console.log('== duplicates ==');
  const { imageStore } = await import('../src/services/imageStore');
  const blue = await img('#00c');
  const put = async (path: string, source: string, created: string) => {
    const key = `library/${acct}/${path}`; await imageStore().put(key, blue, 'image/jpeg');
    const sum = (await import('node:crypto')).createHash('sha256').update(blue).digest('hex');
    return (await one<any>(`INSERT INTO media_files (account_id, kind, path, folder, name, store_key, checksum, source, created_at, size_bytes)
      VALUES ($1,'poster',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, store_key`, [acct, path, path.slice(0, path.lastIndexOf('/')), path.split('/').pop(), key, sum, source, created, blue.length]))!;
  };
  const autoOld = await put('media/clip-1/2026-10-01/poster-1.jpg', 'auto', '2026-10-01');
  const upl = await put('posters/harbour.jpg', 'upload', '2026-10-05');
  const autoNew = await put('media/clip-2/2026-10-02/poster-2.jpg', 'auto', '2026-10-06');
  const v1 = (await one<any>(`INSERT INTO vod_assets (account_id, source_kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, poster_key, metadata)
    VALUES ($1,'upload','Clip 1','/x',0,1,1,$2,$3) RETURNING id`, [acct, autoOld.store_key, JSON.stringify({ image: `/${autoNew.store_key}` })]))!.id;
  const M = await import('../src/services/media/libraryMoves');
  const found = await M.findDuplicates(acct);
  ok(found.length === 1 && found[0].keep.id === upl.id && found[0].drop.length === 2, 'one set; the uploaded copy stays', JSON.stringify(found.map((g) => [g.keep.path, g.drop.map((d) => d.path)])));
  const mr = await M.mergeDuplicates(acct);
  const a = (await one<any>(`SELECT poster_key, metadata FROM vod_assets WHERE id = $1`, [v1]))!;
  ok(mr.removed === 2 && a.poster_key === upl.store_key && a.metadata.image === `/${upl.store_key}`, 'the asset now points at the copy that stays', JSON.stringify({ mr, a }));
  ok(!(await imageStore().exists(autoOld.store_key)) && !!(await imageStore().get(autoOld.store_key)), 'a copy is gone but its old address forwards');
  ok(!existsSync(join(T, 'images', 'library', acct, 'media', 'clip-1')) && !existsSync(join(T, 'images', 'library', acct, 'media', 'clip-2')), 'the copies\' emptied folders went, on disk too');
  ok((await M.findDuplicates(acct)).length === 0, 'none left');

  console.log('== retention: empty folders go ==');
  await query(`INSERT INTO media_folders (account_id, path) VALUES ($1,'thumbnails'),($1,'thumbnails/sport'),($1,'thumbnails/sport/2026-10-01'),($1,'keepme')`, [acct]);
  const k = await saveToLibrary(acct, 'thumbnails/sport/2026-10-01/18', 'a.jpg', await img('#0c0'), 'image/jpeg', 'keyframe', {});
  await saveToLibrary(acct, 'thumbnails/news/2026-10-01/18', 'b.jpg', await img('#0cc'), 'image/jpeg', 'keyframe', {});
  await query(`DELETE FROM media_files WHERE store_key = $1`, [k]); await imageStore().delete(k);
  const pr = await M.pruneEmptyFolders(acct, ['thumbnails/sport/2026-10-01/18']);
  const left = (await query<any>(`SELECT path FROM media_folders WHERE account_id = $1 ORDER BY path`, [acct])).map((r) => r.path);
  ok(left.join() === 'keepme,thumbnails', 'the emptied day and channel folders went; thumbnails (still holds news) and an untouched empty folder stay', left.join());
  ok(!existsSync(join(T, 'images', 'library', acct, 'thumbnails', 'sport')) && existsSync(join(T, 'images', 'library', acct, 'thumbnails', 'news')), 'directories on disk too', JSON.stringify(pr));
  mkdirSync(join(T, 'images', 'library', acct, 'stray', 'a', 'b'), { recursive: true });
  ok((await M.tidyEmptyDirs(true)) >= 3 && !existsSync(join(T, 'images', 'library', acct, 'stray')), 'stray empty directories are tidied');

  console.log('== asset removal takes its own frames and folder ==');
  const { assetFolder } = await import('../src/services/media/libraryPaths');
  const { placeOf } = await import('../src/services/media/assetImage');
  const v2 = (await one<any>(`INSERT INTO vod_assets (account_id, source_kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms)
    VALUES ($1,'upload','Gone Clip','/x',0,1,1) RETURNING *`, [acct]))!;
  const f2 = assetFolder(placeOf(v2));
  const frame = await saveToLibrary(acct, f2, 'poster-x.jpg', await img('#cc0'), 'image/jpeg', 'poster', { assetId: v2.id });
  await query(`UPDATE vod_assets SET poster_key = $2 WHERE id = $1`, [v2.id, frame]);
  await query(`INSERT INTO vod_asset_images (asset_id, account_id, type_key, image_key) VALUES ($1,$2,'hero',$3)`, [v2.id, acct, frame]);
  const binId = await (await import('../src/services/vodRemove')).removeVodAsset(v2.id, { reason: 'test' });
  ok(!(await one<any>(`SELECT 1 AS x FROM media_files WHERE store_key = $1`, [frame])) && !existsSync(join(T, 'images', 'library', acct, ...f2.split('/'))), 'its frame went into the bin and its folder went', f2);
  const bin = (await one<any>(`SELECT images, rows FROM trash_items WHERE id = $1`, [binId]))!;
  ok(bin.images.length === 1 && bin.rows.some((r: any) => r.table === 'vod_asset_images'), 'the bin holds the frame and the typed image row', JSON.stringify(bin.rows.map((r: any) => r.table)));

  console.log('== an asset\'s own images ==');
  const g = (await one<any>(`INSERT INTO groups (account_id, name) VALUES ($1,'G') RETURNING id`, [acct]))!.id;
  const ch = (await one<any>(`INSERT INTO channels (group_id, name) VALUES ($1,'Sport') RETURNING id`, [g]))!.id;
  const t0 = Date.parse('2026-10-10T10:00:00Z');
  for (let i = 0; i < 100; i++) await query(`INSERT INTO media_files (account_id, kind, path, folder, name, store_key, source, channel_id, captured_at)
      VALUES ($1,'keyframe',$2,'thumbnails/sport/x',$3,$4,'encoder',$5,$6)`, [acct, `thumbnails/sport/x/s${i}.jpg`, `s${i}.jpg`, `library/${acct}/thumbnails/sport/x/s${i}.jpg`, ch, new Date(t0 + i * 60_000)]);
  const v3 = (await one<any>(`INSERT INTO vod_assets (channel_id, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms)
    VALUES ($1,'Match','/x',$2,$3,$4) RETURNING *`, [ch, t0 + 10 * 60_000, t0 + 70 * 60_000, 3_600_000]))!;
  const f3 = assetFolder(placeOf({ ...v3, channel_name: 'Sport', channel_kind: 'tv' }));
  const up = await saveToLibrary(acct, f3, 'my-upload.jpg', await img('#808'), 'image/jpeg', 'poster', {});
  await query(`UPDATE vod_assets SET poster_key = $2 WHERE id = $1`, [v3.id, up]);
  const S = await import('../src/services/media/assetImageSet');
  const rel = (await S.relatedImages(v3.id, acct))!;
  const by = Object.fromEntries(rel.groups.map((x) => [x.key, x.files]));
  ok(by.inUse?.length === 1 && by.inUse[0].store_key === up, 'what it uses now comes first');
  ok(!by.own || by.own.every((f: any) => f.store_key !== up), 'not listed twice');
  ok(by.stills?.length === 48 && by.stills.every((s: any) => Date.parse(s.captured_at) >= t0 + 600_000 && Date.parse(s.captured_at) <= t0 + 4_200_000), '48 stills spread over the time it aired', String(by.stills?.length));
  ok(!rel.groups.some((x) => x.key === 'cover'), 'a video is offered no song cover');

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end(); process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
