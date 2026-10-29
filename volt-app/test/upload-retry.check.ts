// ============================================================================
//  RE-UPLOADING A FILE WHOSE ENCODE FAILED, end to end against Postgres and the
//  real HTTP app: the ingest preview names the failed record, and each answer the
//  panel can give (reattach, replace, new) does what it says when the bytes land.
//  Also: an uploaded asset can be deleted with its files, and a file whose earlier
//  copy failed is not held as a duplicate of the failure.
//
//  Usage: DATABASE_URL=... npx tsx test/upload-retry.check.ts   (a migrated, disposable database)
// ============================================================================
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };

(async () => {
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { config } = await import('../src/config');

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`retry-${tag}`]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `retry-${tag}@volt.test`]))!.id;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' });
  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: any) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j: any = t; try { j = JSON.parse(t); } catch { /* */ }
    return { s: r.status, j };
  };
  const srcDir = join(config.clips.dir, 'vod-src'); mkdirSync(srcDir, { recursive: true });

  // A record whose encode failed, as sintel_4k.mov was: an uploaded source, a failed job, no master.
  const BYTES = 200_000;
  async function failedRecord(name: string) {
    const id = randomUUID();
    const path = join(srcDir, `${id}.mov`); writeFileSync(path, randomBytes(BYTES));
    const job = (await one<any>(`INSERT INTO jobs(type, state, payload, last_error, attempts, max_attempts) VALUES ('vod.encode','failed',$1,'worker 1-abc stopped reporting; lease expired',2,2) RETURNING id`,
      [JSON.stringify({ vodAssetId: id })]))!.id;
    await query(`INSERT INTO vod_assets(id, account_id, source_kind, kind, title, original_filename, source_bytes, source_key, metadata, encode_job_id,
                   start_epoch_ms, end_epoch_ms, duration_ms, thumb_status)
                 VALUES ($1,$2,'upload','clip',$3,$3,$4,$5,$6,$7,0,0,0,'processing')`,
      [id, acct, name, BYTES, path, JSON.stringify({ description: 'typed before the first upload', series: 'Open Movies' }), job]);
    return { id, path };
  }
  // The chunk protocol: open, one chunk, finish.
  async function upload(name: string, retryOf: any) {
    const data = randomBytes(BYTES);
    const o = await api('POST', '/api/uploads', { purpose: 'vod', name: name.replace(/\.[^.]+$/, ''), filename: name, contentType: 'video/quicktime', totalBytes: data.length, retryOf });
    if (o.s !== 201) return { open: o };
    const s = o.j;
    const put = await fetch(`${base}/api/uploads/${s.id}/chunks/0`, { method: 'PUT', headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/octet-stream' }, body: new Uint8Array(data) });
    const fin = await fetch(`${base}/api/uploads/${s.id}/finish`, { method: 'POST', headers: { authorization: `Bearer ${s.token}` } });
    return { open: o, session: s, put: put.status, fin: fin.status, finBody: await fin.json().catch(() => null) };
  }
  const assets = async (name: string) => query<any>(`SELECT * FROM vod_assets WHERE account_id = $1 AND (title = $2 OR original_filename = $2) ORDER BY created_at`, [acct, name]);

  try {
    console.log('== the preview names the failed record ==');
    const A = await failedRecord('sintel_4k.mov');
    let r = await api('POST', '/api/ingest/preview', { files: [{ name: 'sintel_4k.mov', bytes: BYTES }, { name: 'other.mov', bytes: 123 }] });
    ok(r.s === 200 && r.j[0].failedMatch?.assetId === A.id, 'sintel_4k.mov matches the failed record', JSON.stringify(r.j?.[0]?.failedMatch));
    ok(r.j[0].failedMatch?.error?.includes('lease expired') && r.j[0].failedMatch.metadataFields === 2 && r.j[0].failedMatch.sameSize, 'with why it failed, its metadata count and same size');
    ok(r.j[0].duplicate === 'proceed', 'and it is not treated as a duplicate of the failure');
    ok(r.j[1].failedMatch === null, 'an unrelated file has no match');

    console.log('== reattach: the new file becomes the source of the existing record ==');
    let u = await upload('sintel_4k.mov', { assetId: A.id, action: 'reattach' });
    ok(u.fin === 200, 'upload lands', JSON.stringify(u.open?.j).slice(0, 160));
    let rows = await assets('sintel_4k.mov');
    ok(rows.length === 1 && rows[0].id === A.id, 'still one record, the same id (the placeholder is gone)', String(rows.length));
    ok(rows[0].source_key !== A.path && existsSync(rows[0].source_key), 'its source is the new file');
    ok(!existsSync(A.path), 'the old file is removed');
    ok(rows[0].metadata?.description === 'typed before the first upload' && rows[0].metadata?.series === 'Open Movies', 'its metadata is kept', JSON.stringify(rows[0].metadata));
    const job = await one<any>(`SELECT * FROM jobs WHERE id = $1`, [rows[0].encode_job_id]);
    ok(!!job && job.state === 'queued' && job.payload.vodAssetId === A.id, 'a new encode is queued for the existing record');
    const sess = await one<any>(`SELECT vod_asset_id, retry_of FROM upload_sessions WHERE id = $1`, [u.session.id]);
    ok(sess.vod_asset_id === A.id && sess.retry_of?.action === 'reattach', 'the upload session points at the record');

    console.log('== replace: the failed record is deleted ==');
    const B = await failedRecord('tears_of_steel.mov');
    u = await upload('tears_of_steel.mov', { assetId: B.id, action: 'replace' });
    rows = await assets('tears_of_steel.mov');
    ok(u.fin === 200 && rows.length === 1 && rows[0].id !== B.id, 'one record, a new one', String(rows.length));
    ok(!existsSync(B.path) && !(await one(`SELECT 1 FROM vod_assets WHERE id = $1`, [B.id])), 'the failed record and its file are gone');
    ok(!rows[0].metadata?.series, 'the new record starts without the old metadata');

    console.log('== new: both stay ==');
    const C = await failedRecord('cosmos.mov');
    u = await upload('cosmos.mov', { assetId: C.id, action: 'new' });
    rows = await assets('cosmos.mov');
    ok(u.fin === 200 && rows.length === 2 && rows.some((x: any) => x.id === C.id) && existsSync(C.path), 'two records, the failed one untouched');
    ok(rows.find((x: any) => x.id !== C.id).ingest?.status === 'ingested', 'the new one is ingested, not held as a duplicate', rows.find((x: any) => x.id !== C.id).ingest?.status);

    console.log('== refused and deleted ==');
    const D = await failedRecord('good.mov');
    await query(`UPDATE vod_assets SET master_key = '/clips/vod/x/master.m3u8' WHERE id = $1`, [D.id]);
    r = await api('POST', '/api/ingest/preview', { files: [{ name: 'good.mov', bytes: 999 }] });
    ok(r.j[0].failedMatch === null, 'a record that did encode is not offered');
    u = await upload('good.mov', { assetId: D.id, action: 'reattach' });
    ok(u.open.s === 409, 'reattaching to a record that is not a failed encode is refused', String(u.open.s));
    const E = await failedRecord('delete-me.mov');
    r = await api('DELETE', `/api/vod/${E.id}`);
    ok(r.s === 200 && !existsSync(E.path) && !(await one(`SELECT 1 FROM vod_assets WHERE id = $1`, [E.id])), 'an uploaded asset can be deleted, with its file', String(r.s));
    const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`retry-o-${tag}`]))!.id;
    const ou = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [other, `retry-o-${tag}@volt.test`]))!.id;
    const F = await failedRecord('theirs.mov');
    const r2 = await fetch(`${base}/api/vod/${F.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${signAccess({ sub: ou, account_id: other, role: 'owner' })}` } });
    ok(r2.status === 404 && existsSync(F.path), 'another account cannot delete it');
  } catch (e) {
    fail++; console.log('FAIL threw', e);
  } finally {
    srv.close(); await pool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
