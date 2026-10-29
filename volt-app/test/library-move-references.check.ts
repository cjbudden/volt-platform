// ============================================================================
//  MOVING AN IMAGE KEEPS EVERY RELATIONSHIP (services/media/libraryMoves.ts,
//  docs/IMAGES.md section 18).
//
//  One image is referenced from every kind of place a reference can live:
//  a *_key column, a bare library path in a channel *_ref, a JSON list
//  (an asset's candidate frames), nested JSON (a song lookup), a text column
//  whose name says nothing about images, a text array, a percent-encoded
//  signed URL. It is moved with the library's own move, and every one of them
//  must follow it. History (the audit log) keeps what it recorded; the old
//  address still opens through forwarding; a file whose name merely starts
//  the same is left alone.
//
//  Needs Postgres (DATABASE_URL, migrations applied).
//  Usage: npx tsx test/library-move-references.check.ts
// ============================================================================
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const ROOT = mkdtempSync(join(tmpdir(), 'move-refs-'));
process.env.IMAGE_STORE_DIR = join(ROOT, 'store');

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`));

async function main() {
  const { query, one, pool } = await import('../src/db');
  const { imageStore } = await import('../src/services/imageStore');
  const M = await import('../src/services/media/libraryMoves');
  const store = imageStore();

  const ACC = randomUUID(), GRP = randomUUID(), CH = randomUUID(), VOD = randomUUID();
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'MoveCo')`, [ACC]);
  await query(`INSERT INTO groups(id,account_id,name) VALUES ($1,$2,'G')`, [GRP, ACC]);

  const oldPath = 'brand/Station logo.png', newPath = 'brands/Station logo.png';
  const oldKey = `library/${ACC}/${oldPath}`, newKey = `library/${ACC}/${newPath}`;
  const enc = (k: string) => k.split('/').map(encodeURIComponent).join('/');
  const twin = `library/${ACC}/brand/Station logo.png.bak`;   // a different file whose name starts the same
  await store.put(oldKey, Buffer.from('png-bytes'), 'image/png');
  const f = await one<any>(`INSERT INTO media_files(account_id, kind, path, folder, name, store_key, source)
                            VALUES ($1,'brand',$2,'brand','Station logo.png',$3,'upload') RETURNING id`, [ACC, oldPath, oldKey]);

  await query(`INSERT INTO channels(id,group_id,name,status,tz,kind,brand_ref,geo_countries) VALUES ($1,$2,'Jazz','ended','UTC','radio',$3,$4::text[])`,
    [CH, GRP, oldPath, [oldKey, 'AU']]);
  await query(`INSERT INTO vod_assets(id, account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms,
                 poster_key, poster_candidates, music_lookup, markers_note)
               VALUES ($1,$2,'upload','export','Song',0,0,1000,$3,$4::jsonb,$5::jsonb,$6)`,
    [VOD, ACC, oldKey,
     JSON.stringify([{ key: oldKey, score: 0.9 }, { key: twin, score: 0.1 }, { url: `/img/abc/600x0/${enc(oldKey)}` }]),
     JSON.stringify({ chosen: { cover: { imageKey: oldKey } } }),
     `artwork: ${oldKey} (and not ${twin})`]);
  await query(`INSERT INTO audit_log(account_id, action, entity_type, detail) VALUES ($1,'update','media_file',$2::jsonb)`, [ACC, JSON.stringify({ key: oldKey })]);

  M.forgetReferenceColumns();
  const r = await M.moveFiles(ACC, [f.id], 'brands', { userId: null });
  check('the image moved', r.moved.map((x) => x.to), [newPath]);

  const ch = await one<any>(`SELECT brand_ref, geo_countries FROM channels WHERE id = $1`, [CH]);
  check('a bare library path in a channel *_ref', ch.brand_ref, newPath);
  check('a text array', ch.geo_countries, [newKey, 'AU']);
  const v = await one<any>(`SELECT poster_key, poster_candidates, music_lookup, markers_note FROM vod_assets WHERE id = $1`, [VOD]);
  check('a *_key column', v.poster_key, newKey);
  check('a JSON list of candidate frames', v.poster_candidates[0].key, newKey);
  check('a percent-encoded signed URL inside JSON', v.poster_candidates[2].url, `/img/abc/600x0/${enc(newKey)}`);
  check('nested JSON (a song lookup\'s chosen cover)', v.music_lookup.chosen.cover.imageKey, newKey);
  check('a text column whose name says nothing about images', v.markers_note, `artwork: ${newKey} (and not ${twin})`);
  check('a file whose name only starts the same is left alone', v.poster_candidates[1].key, twin);
  const counted = Object.keys(r.references).sort();
  check('the move reports where it rewrote', counted.filter((k) => /^(channels|vod_assets)\./.test(k)),
    ['channels.brand_ref', 'channels.geo_countries', 'vod_assets.markers_note', 'vod_assets.music_lookup', 'vod_assets.poster_candidates', 'vod_assets.poster_key']);
  check('history keeps what it recorded', (await one<any>(`SELECT detail FROM audit_log WHERE account_id = $1`, [ACC])).detail.key, oldKey);
  check('the old address still opens (forwarding)', [await M.resolveMoved(oldKey), (await store.get(oldKey))?.toString()], [newKey, 'png-bytes']);
  const cols = await M.referenceColumns();
  check('history and log tables are not scanned', ['audit_log', 'player_events', 'job_logs', 'trash_items'].filter((t) => cols.some((c) => c.table === t)), []);

  // A move made under the old rules left a reference behind; the repair replays recorded moves.
  await query(`UPDATE vod_assets SET music_lookup = $2::jsonb WHERE id = $1`, [VOD, JSON.stringify({ cover: oldKey })]);
  const rep = await M.repairMovedReferences();
  check('the repair rewrites a reference an earlier move missed', (await one<any>(`SELECT music_lookup FROM vod_assets WHERE id = $1`, [VOD])).music_lookup.cover, newKey);
  check('and reports it', (rep.references['vod_assets.music_lookup'] ?? 0) >= 1, true);
  const rep2 = await M.repairMovedReferences();
  check('running it again finds nothing to change for this account', rep2.references['vod_assets.music_lookup'] ?? 0, 0);

  await query(`DELETE FROM accounts WHERE id = $1`, [ACC]);
  await pool.end();
  rmSync(ROOT, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
