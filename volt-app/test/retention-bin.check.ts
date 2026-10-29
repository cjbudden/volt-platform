// ============================================================================
//  RETENTION THAT KEEPS WHAT CLIPS NEED, THE RESTORE BIN, AND MANUAL EXPIRY,
//  end to end against Postgres, real fMP4 runs on disk and the HTTP app.
//  docs/RETENTION.md.
//
//  Usage: DATABASE_URL=... npx tsx test/retention-bin.check.ts   (a migrated, disposable database)
// ============================================================================
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(tmpdir(), `volt-retention-${Date.now().toString(36)}`);
process.env.ORIGIN_DIR = join(ROOT, 'origin');
process.env.CLIPS_DIR = join(ROOT, 'clips');
process.env.IMAGE_STORE_DIR = join(ROOT, 'image-store');
process.env.VOLT_TRASH_DIR = join(ROOT, 'trash');

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };
const segsIn = (dir: string) => existsSync(dir) ? readdirSync(dir).filter((f) => /^seg_\d+\.m4s$/.test(f)).map((f) => parseInt(f.match(/\d+/)![0], 10)).sort((a, b) => a - b) : [];

(async () => {
  // ---- a real recorded run: 30 two-second fMP4 segments in three renditions ----
  const src = join(ROOT, 'src'); mkdirSync(src, { recursive: true });
  const ff = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-t', '60',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0',
    '-f', 'hls', '-hls_time', '2', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', join(src, 'seg_%d.m4s'), join(src, 'index.m3u8')], { encoding: 'utf8' });
  if (ff.status !== 0) { console.log('SKIP: ffmpeg could not make the test run', ff.stderr); process.exit(0); }

  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { reconcileStream } = await import('../src/services/media/reconcile');
  const { pruneRecording, pruneRun } = await import('../src/services/media/prune');
  const { purgeExpired, trashRoot } = await import('../src/services/media/trash');
  const { sweep, saveRule } = await import('../src/services/media/retention');
  const { imageStore } = await import('../src/services/imageStore');
  const { scanRun, invalidateRunScan } = await import('../src/services/localRecordingIndex');

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`ret-${tag}`]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `ret-${tag}@volt.test`]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
  const grp = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'Retention TV') RETURNING id`, [grp]))!.id;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' });
  const app: any = createServer(); const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: any) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j: any = t; try { j = JSON.parse(t); } catch { /* */ } return { s: r.status, j };
  };

  // Lay a run down N days ago: three renditions, segment mtimes on a 2 s grid.
  async function layRun(daysAgo: number, name: string) {
    const t0 = Date.now() - daysAgo * 86_400_000;
    const runId = new Date(t0).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const runDir = join(process.env.ORIGIN_DIR!, ch, 'runs', runId);
    for (const r of ['1080p', '720', 'audio']) {
      cpSync(src, join(runDir, r), { recursive: true });
      for (let i = 0; i < 30; i++) { const t = new Date(t0 + (i + 1) * 2000); utimesSync(join(runDir, r, `seg_${i}.m4s`), t, t); }
    }
    writeFileSync(join(runDir, 'master.m3u8'), '#EXTM3U\n');
    const rec = (await one<any>(`INSERT INTO recordings(kind, channel_id, title, day_utc, status, start_epoch_ms, end_epoch_ms)
       VALUES ('channel_day', $1, $2, $3, 'complete', $4, $5) RETURNING id`, [ch, name, new Date(t0).toISOString().slice(0, 10), t0, t0 + 60_000]))!.id;
    return { runId, runDir, rec, t0 };
  }

  try {
    console.log('== a run with a clip cut from it ==');
    const A = await layRun(5, 'With a clip');
    await reconcileStream(ch);
    const objsA = await query<any>(`SELECT * FROM media_objects WHERE logical_key LIKE $1`, [`run/${A.runId}/%`]);
    await query(`UPDATE media_objects SET recording_id = $2, state = 'available' WHERE id = ANY($1::uuid[])`, [objsA.map((o: any) => o.id), A.rec]);
    ok(objsA.length >= 2, `retention tracks the run (${objsA.length} objects: ${objsA.map((o: any) => o.rendition).join(', ')})`);
    invalidateRunScan(ch);
    const placed = scanRun(ch, A.runId, '1080p');
    ok(placed.length === 30, `the run is placed on the wall clock (${placed.length} segments)`);
    const p10 = placed.find((s) => s.seq === 10)!, p12 = placed.find((s) => s.seq === 12)!;
    const s10 = { startMs: Math.round(p10.startMs) }, s12 = { startMs: Math.round(p12.startMs), durMs: Math.round(p12.durMs) };
    const clip = (await one<any>(`INSERT INTO vod_assets(account_id, channel_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, thumb_status)
        VALUES ($1,$2,'recording','clip','The goal',$3,$4,$5,'ready') RETURNING id`, [acct, ch, s10.startMs, s12.startMs + s12.durMs, s12.startMs + s12.durMs - s10.startMs]))!.id;
    await query(`INSERT INTO clip_segments(vod_asset_id, ordinal, recording_id, run_id, rendition, first_seq, last_seq, segment_count, source_from_ms, source_to_ms, clip_offset_ms, duration_ms)
        VALUES ($1,0,$2,$3,'1080p',10,12,3,$4,$5,0,$6)`, [clip, A.rec, A.runId, s10.startMs, s12.startMs + s12.durMs, s12.startMs + s12.durMs - s10.startMs]);

    // Encoder stills each 10 s and two storyboard sheets (30 s each), one over the clip.
    const stills: { id: string; key: string; at: number }[] = [];
    for (let t = A.t0 + 1000; t < A.t0 + 60_000; t += 10_000) {
      const key = `library/${acct}/thumbnails/rtv/still-${t}.jpg`;
      await imageStore().put(key, Buffer.from('jpg' + t), 'image/jpeg');
      const id = (await one<any>(`INSERT INTO media_files(account_id, kind, path, folder, name, store_key, size_bytes, source, channel_id, captured_at)
          VALUES ($1,'keyframe',$2,'thumbnails/rtv',$3,$4,10,'encoder',$5,$6) RETURNING id`, [acct, key.split(`${acct}/`)[1], key.split('/').pop(), key, ch, new Date(t)]))!.id;
      stills.push({ id, key, at: t });
    }
    // Sprite sheets live in the sprite store with a sprite_sheets row each (thumbnails/spriteStore.ts).
    const sheetKeys = [0, 1].map((i) => `derived/${acct}/sprites/streams/rtv/sheet-${i}.jpg`);
    for (const k of sheetKeys) await imageStore().put(k, Buffer.from(k), 'image/jpeg');
    // Sheet 0 covers the first 30 s (where the clip is, about 20 s in); sheet 1 the last 30 s.
    const sheets = [{ key: sheetKeys[0], start_ms: Math.round(placed[0].startMs), slots: 15, filled: [] }, { key: sheetKeys[1], start_ms: Math.round(placed[15].startMs), slots: 15, filled: [] }];
    const sb = (await one<any>(`INSERT INTO storyboards(account_id, stream_kind, stream_id, unit_start, unit_end, folder, interval_ms, tile_w, tile_h, cols, rows, sheets, status)
        VALUES ($1,'channel',$2,$3,$4,'thumbnails/rtv',2000,160,90,5,3,$5::jsonb,'complete') RETURNING id`,
      [acct, ch, new Date(A.t0 - 3_600_000), new Date(A.t0 + 3_600_000), JSON.stringify(sheets)]))!.id;
    for (const sh of sheets) await query(`INSERT INTO sprite_sheets(account_id, owner_kind, store_key, stream_kind, stream_id, storyboard_id, start_ms, interval_ms, tiles, size_bytes)
        VALUES ($1,'stream',$2,'channel',$3,$4,$5,2000,15,10)`, [acct, sh.key, ch, sb, sh.start_ms]);

    console.log('== retention removes the run but keeps the clip\'s segments ==');
    await saveRule({ actingAccountId: acct, channelId: ch, name: 'Two days', appliesTo: 'recording', stages: [{ afterDays: 2, action: 'delete' }] });
    const dry = await sweep({ dryRun: true, accountId: acct });
    ok(dry.deleted >= 1, `the dry run says it would delete (${dry.deleted})`);
    const swept = await sweep({ accountId: acct, actor: 'test' });
    ok(swept.deleted >= 1, `the sweep removes (${swept.deleted} deleted, ${swept.failed} failed)`);
    for (const r of ['1080p', '720', 'audio']) {
      const left = segsIn(join(A.runDir, r));
      ok(JSON.stringify(left) === JSON.stringify([9, 10, 11, 12, 13]), `${r}: segments 9 to 13 kept (the clip's 10 to 12 and one either side)`, JSON.stringify(left));
    }
    ok(existsSync(join(A.runDir, '1080p', 'init.mp4')) && existsSync(join(A.runDir, 'master.m3u8')), 'init segments and playlists stay');
    const held = await query<any>(`SELECT hold, hold_reason, state FROM media_objects WHERE logical_key LIKE $1`, [`run/${A.runId}/%`]);
    ok(held.every((h: any) => h.hold && /^kept 15 segments that 1 clip/.test(h.hold_reason) && h.state === 'available'), 'its media objects are held, saying what was kept', JSON.stringify(held[0]));
    const again = await sweep({ accountId: acct, actor: 'test' });
    ok(again.deleted === 0 && again.failed === 0, 'the next sweep leaves it alone');

    const left = await query<any>(`SELECT id FROM media_files WHERE id = ANY($1::uuid[])`, [stills.map((s) => s.id)]);
    const clipWin = [s10.startMs - 2000, s12.startMs + s12.durMs + 2000];
    const wantKept = stills.filter((s) => s.at >= clipWin[0] && s.at < clipWin[1]).map((s) => s.id);
    ok(left.length === wantKept.length && left.every((l: any) => wantKept.includes(l.id)), `stills outside the clip are removed from the Image Library (${stills.length - left.length} of ${stills.length})`);
    ok(!(await imageStore().exists(stills.find((s) => !wantKept.includes(s.id))!.key)), 'and their files');
    const sbAfter = await one<any>(`SELECT sheets FROM storyboards WHERE id = $1`, [sb]);
    ok(sbAfter.sheets.length === 1 && sbAfter.sheets[0].key === sheetKeys[0], 'the sprite sheet not over the clip is removed, the one over it stays');
    ok(!(await imageStore().exists(sheetKeys[1])) && !(await one(`SELECT 1 FROM sprite_sheets WHERE store_key = $1`, [sheetKeys[1]])), 'with its file and sprite row');
    ok(!!(await one(`SELECT 1 FROM sprite_sheets WHERE store_key = $1`, [sheetKeys[0]])), 'the kept sheet keeps its sprite row');

    console.log('== the restore bin ==');
    let r = await api('GET', '/api/storage/bin');
    const item = r.j.items.find((i: any) => i.subjectId === A.rec);
    ok(r.s === 200 && !!item && item.state === 'held' && item.files >= 75 && r.j.days === 7, `the removal is in the bin (${item?.files} files, kept ${r.j.days} days)`, JSON.stringify(r.j).slice(0, 200));
    r = await api('POST', `/api/storage/bin/${item.id}/restore`);
    ok(r.s === 200 && r.j.files >= 75, `restored (${r.j.files} files, ${r.j.images} images, ${r.j.rows} rows)`, JSON.stringify(r.j));
    ok(segsIn(join(A.runDir, '720')).length === 30, 'every segment is back');
    ok((await query<any>(`SELECT id FROM media_files WHERE id = ANY($1::uuid[])`, [stills.map((s) => s.id)])).length === stills.length && await imageStore().exists(stills[0].key), 'the stills are back, rows and files');
    ok((await one<any>(`SELECT sheets FROM storyboards WHERE id = $1`, [sb])).sheets.length === 2 && await imageStore().exists(sheetKeys[1])
      && !!(await one(`SELECT 1 FROM sprite_sheets WHERE store_key = $1`, [sheetKeys[1]])), 'the sprite sheet is back, file and sprite row');
    ok((await api('POST', `/api/storage/bin/${item.id}/restore`)).s === 400, 'an item cannot be restored twice');

    console.log('== a run nothing was cut from goes whole; manual expiry ==');
    const B = await layRun(1, 'No clips');
    await reconcileStream(ch);
    await query(`UPDATE media_objects SET recording_id = $2, state = 'available' WHERE logical_key LIKE $1`, [`run/${B.runId}/%`, B.rec]);
    r = await api('GET', '/api/storage/expiring');
    const listed = r.j.items.map((x: any) => x.id);
    const aRow = r.j.items.find((x: any) => x.id === A.rec);
    ok(r.s === 200 && listed.indexOf(B.rec) < listed.indexOf(A.rec) && aRow.expirySource === 'kept_for_clips' && aRow.expiresAt === null,
      'the retention list is ordered by expiry; the pruned one shows "kept for clips" with no date, last', JSON.stringify(r.j.items.map((x: any) => [x.title, x.expiresAt, x.expirySource])));
    const bRow = r.j.items.find((x: any) => x.id === B.rec);
    ok(bRow.expirySource === 'rule' && bRow.rule?.deleteAfterDays === 2, 'with where the date comes from (the rule, 2 days)');
    r = await api('PATCH', `/api/storage/recordings/${B.rec}/expiry`, { deleteAfter: new Date(Date.now() - 60_000).toISOString(), note: 'not needed' });
    ok(r.s === 200, 'an expiry set by hand');
    r = await api('GET', '/api/storage/expiring');
    ok(r.j.items[0].id === B.rec && r.j.items[0].expirySource === 'manual' && r.j.items[0].manual.note === 'not needed', 'moves it to the top, marked manual');
    await sweep({ accountId: acct, actor: 'test' });
    ok(!existsSync(B.runDir), 'the sweep takes a run with no clips whole, on the manual date');
    const bObjs = await query<any>(`SELECT state FROM media_objects WHERE recording_id = $1`, [B.rec]);
    ok(bObjs.every((o: any) => o.state === 'deleted') && (await one<any>(`SELECT storage_state FROM recordings WHERE id = $1`, [B.rec])).storage_state === 'deleted', 'its objects and the recording read deleted');
    const binB = (await api('GET', '/api/storage/bin')).j.items.find((i: any) => i.subjectId === B.rec);
    r = await api('POST', `/api/storage/bin/${binB.id}/restore`);
    ok(r.s === 200 && segsIn(join(B.runDir, '1080p')).length === 30, 'restored whole');
    const bBack = await query<any>(`SELECT state, hold, hold_reason FROM media_objects WHERE recording_id = $1`, [B.rec]);
    ok(bBack.every((o: any) => o.state === 'available' && o.hold && o.hold_reason === 'restored from the bin'), 'readable again and held, so retention does not take it straight back');
    ok((await one<any>(`SELECT delete_after FROM recordings WHERE id = $1`, [B.rec])).delete_after === null, 'the manual date is cleared');

    console.log('== hold, purge ==');
    r = await api('POST', `/api/storage/recordings/${A.rec}/hold`, { hold: true, reason: 'legal' });
    ok(r.s === 200 && r.j.objects >= 2, 'a recording can be held from the list');
    await pruneRun({ streamId: ch, runId: B.runId, accountId: acct, recordingId: B.rec, reason: 'test', actor: 'test' });
    const binC = (await api('GET', '/api/storage/bin')).j.items.find((i: any) => i.subjectId === B.rec && i.state === 'held');
    await query(`UPDATE trash_items SET purge_after = now() - interval '1 minute' WHERE id = $1`, [binC.id]);
    const p = await purgeExpired();
    ok(p.items >= 1 && !existsSync(join(trashRoot(), binC.id)), 'purge removes the bin copy once its days are up');
    ok((await api('POST', `/api/storage/bin/${binC.id}/restore`)).s === 400, 'a purged item cannot be restored');

    console.log('== deleting a library asset goes to the bin ==');
    const asset = (await one<any>(`INSERT INTO vod_assets(account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, thumb_status, metadata)
        VALUES ($1,'upload','clip','Promo',0,0,0,'ready','{"series":"S1"}') RETURNING id`, [acct]))!.id;
    const out = join(process.env.CLIPS_DIR!, 'vod', asset); mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'master.m3u8'), '#EXTM3U\n');
    await query(`INSERT INTO vod_markers(vod_asset_id, kind, at_ms, label) VALUES ($1,'chapter',1000,'Start')`, [asset]).catch(() => {});
    r = await api('DELETE', `/api/vod/${asset}`);
    ok(r.s === 200 && !existsSync(out) && !(await one(`SELECT 1 FROM vod_assets WHERE id = $1`, [asset])), 'deleted from the library, files moved');
    const binD = (await api('GET', '/api/storage/bin')).j.items.find((i: any) => i.subjectId === asset);
    ok(!!binD && binD.kind === 'vod_asset', 'and it is in the bin');
    r = await api('POST', `/api/storage/bin/${binD.id}/restore`);
    const back = await one<any>(`SELECT metadata FROM vod_assets WHERE id = $1`, [asset]);
    ok(r.s === 200 && back?.metadata?.series === 'S1' && existsSync(join(out, 'master.m3u8')), 'restored with its metadata and files');
    ok((await api('GET', '/api/vod/' + clip)).s === 200, 'the clip itself was never touched');

    console.log('== undelete from the asset form (vod permission, not storage) ==');
    r = await api('GET', `/api/vod/${asset}/delete-impact`);
    ok(r.s === 200 && r.j.name === 'Promo' && r.j.blocker === null && r.j.binDays >= 1 && typeof r.j.counts?.markers === 'number', 'the delete dialog is told what goes and for how long', JSON.stringify(r.j));
    r = await api('DELETE', `/api/vod/${asset}`);
    ok(r.s === 200 && !!r.j?.bin && r.j.binDays >= 1 && !!r.j.purgeAfter, 'the delete says which bin item and for how long', JSON.stringify(r.j));
    r = await api('POST', `/api/vod/${asset}/restore`);
    ok(r.s === 200 && r.j?.bin && existsSync(join(out, 'master.m3u8')) && !!(await one(`SELECT 1 FROM vod_assets WHERE id = $1`, [asset])), 'undelete puts the record and files back');
    ok((await api('POST', `/api/vod/${asset}/restore`)).s === 404, 'a second undelete finds nothing in the bin');
  } catch (e) {
    fail++; console.log('FAIL threw', e);
  } finally {
    srv.close(); await pool.end().catch(() => {});
    rmSync(ROOT, { recursive: true, force: true });
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
