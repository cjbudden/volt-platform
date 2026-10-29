// ============================================================================
//  IMAGE NAMES THAT FOLLOW THE ASSET (<asset>-<hash>.jpg), FOLDERS WITH A REAL
//  DATE, AND THE BACKGROUND TIDY OF OLDER NAMES. Needs DATABASE_URL.
//  Usage: npx tsx test/asset-image-names.e2e.ts
// ============================================================================
import { mkdtempSync, existsSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const T = mkdtempSync(join(tmpdir(), 'volt-n-'));
process.env.IMAGE_STORE_DIR = join(T, 'images'); process.env.IMAGE_STORE_DRIVER = 'local'; process.env.IMAGE_CACHE_DRIVER = 'none';
let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };
const eq = (m: string, g: unknown, w: unknown) => ok(JSON.stringify(g) === JSON.stringify(w), m, `expected ${JSON.stringify(w)} got ${JSON.stringify(g)}`);
async function main() {
  await (await import('../src/services/migrate')).migrate();
  const P = await import('../src/services/media/libraryPaths');
  const today = new Date().toISOString().slice(0, 10);
  console.log('== names and dates ==');
  eq('no extension', P.withoutExt('sintel_1080p.mkv'), 'sintel_1080p');
  eq('a dot that is not an extension stays', P.withoutExt('Mr. Robot S01E01'), 'Mr. Robot S01E01');
  eq('main image name', P.assetImageName('sintel_1080p.mkv', '21fe57ffc0aa'), 'sintel-1080p-21fe57ffc0.jpg');
  eq('typed image name', P.assetImageName('Big Buck Bunny.mov', '9a0c33b2e1ff', 'hero'), 'big-buck-bunny-hero-9a0c33b2e1.jpg');
  eq('epoch 0 is not 1970', [P.day(0), P.day('0')], [today, today]);
  eq('a real date stays', P.day(Date.parse('2026-10-20T10:00:00Z')), '2026-10-20');
  const { placeOf } = await import('../src/services/media/assetImage');
  eq('an upload: folder from its name and the day it was added', P.assetFolder(placeOf({ title: 'sintel_1080p.mkv', start_epoch_ms: '0', created_at: new Date('2026-10-20T03:00:00Z') })), 'media/sintel-1080p/2026-10-20');
  eq('a recording keeps its start', P.assetFolder(placeOf({ title: 'Match', start_epoch_ms: String(Date.parse('2026-09-01T09:00:00Z')), created_at: new Date('2026-10-20') })), 'media/match/2026-09-01');

  console.log('== tidying older names ==');
  const { one, query, pool } = await import('../src/db');
  const { imageStore } = await import('../src/services/imageStore');
  const sharp = (await import('sharp')).default;
  const { createHash } = await import('node:crypto');
  const acct = (await one<any>(`INSERT INTO accounts (name) VALUES ('N') RETURNING id`))!.id;
  const v = (await one<any>(`INSERT INTO vod_assets (account_id, source_kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, created_at)
    VALUES ($1,'upload','sintel_1080p.mkv','/x',0,0,1,'2026-10-20T03:00:00Z') RETURNING id`, [acct]))!.id;
  const buf = await sharp({ create: { width: 64, height: 36, channels: 3, background: '#468' } }).jpeg().toBuffer();
  const sum = createHash('sha256').update(buf).digest('hex');
  const old = (type: string | null, folder: string, name: string) => one<any>(`INSERT INTO media_files (account_id, kind, path, folder, name, store_key, checksum, source, content_type, metadata)
    VALUES ($1,'poster',$2,$3,$4,$5,$6,'auto','image/jpeg',$7) RETURNING store_key`, [acct, `${folder}/${name}`, folder, name, `library/${acct}/${folder}/${name}`, type ? sum.replace(/^./, 'f') : sum, JSON.stringify({ assetId: v, ...(type ? { imageType: type } : {}) })]);
  const k1 = (await old(null, 'media/sintel-1080p-mkv/1970-01-01', 'poster.jpg'))!.store_key;
  await imageStore().put(k1, buf, 'image/jpeg');
  const k2 = (await old('hero', 'media/sintel-1080p-mkv/1970-01-01', 'hero-abcdef0123.jpg'))!.store_key;
  await imageStore().put(k2, buf, 'image/jpeg');
  await query(`UPDATE vod_assets SET poster_key = $2, metadata = $3 WHERE id = $1`, [v, k1, JSON.stringify({ image: `/${k1}` })]);
  await query(`INSERT INTO vod_asset_images (asset_id, account_id, type_key, image_key) VALUES ($1,$2,'hero',$3)`, [v, acct, k2]);
  const M = await import('../src/services/media/libraryMoves');
  const r1 = await M.tidyAssetImageNames(50);
  const want1 = `library/${acct}/media/sintel-1080p/2026-10-20/sintel-1080p-${sum.slice(0, 10)}.jpg`;
  const a = (await one<any>(`SELECT poster_key, metadata FROM vod_assets WHERE id = $1`, [v]))!;
  ok(r1.renamed === 2, 'both renamed', JSON.stringify(r1));
  eq('the main image', a.poster_key, want1);
  ok(a.metadata.image === `/${want1}`, 'its metadata field follows');
  const hero = (await one<any>(`SELECT image_key FROM vod_asset_images WHERE asset_id = $1`, [v]))!.image_key;
  ok(/\/media\/sintel-1080p\/2026-10-20\/sintel-1080p-hero-f[0-9a-f]{9}\.jpg$/.test(hero), 'the typed image', hero);
  ok(!existsSync(join(T, 'images', 'library', acct, 'media', 'sintel-1080p-mkv')), 'the old 1970 folder is gone');
  ok(!!(await imageStore().get(k1)), 'the old address still forwards');
  const r2 = await M.tidyAssetImageNames(50);
  eq('nothing to do the second time, and nothing re-checked', r2, { renamed: 0, checked: 0 });
  await query(`UPDATE vod_assets SET title = 'Sintel (2010).mkv' WHERE id = $1`, [v]);
  const r3 = await M.tidyAssetImageNames(50);
  const a3 = (await one<any>(`SELECT poster_key FROM vod_assets WHERE id = $1`, [v]))!;
  ok(r3.renamed === 2 && a3.poster_key.endsWith(`/media/sintel-2010/2026-10-20/sintel-2010-${sum.slice(0, 10)}.jpg`), 'renaming the asset renames its images', a3.poster_key);
  await pool.end(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
