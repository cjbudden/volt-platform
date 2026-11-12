// ============================================================================
//  THE ARCHIVE STORAGE TIER FOR VOD TITLES (build queue P5-3 (a);
//  services/media/vodArchiveTier.ts, s3Driver.ts copyInPlace, trash.ts).
//
//  Against a REAL S3 API (moto, started here when `moto_server` is on PATH, or
//  the endpoint in SITE_S3_TEST_ENDPOINT) and a real database, through the API:
//    - pure: only ever colder, the restore wait and its words;
//    - archiving a title whose policy says Archive storage moves every object
//      under vod/<id>/ and its original in the bucket to GLACIER (the keys do
//      not change), logs it and shows it on GET /api/vod/:id;
//    - a policy with no tier moves nothing; on the Mac (VOD_STORE=local, a
//      local original) there is nothing to move;
//    - Infrequent access: STANDARD_IA on archive, restored at once, its media
//      back to STANDARD afterwards;
//    - from Archive storage the restore time is said first (409 restore_wait
//      with when, nothing requested); accepted, the restore starts (202), the
//      title stays archived, a second request answers 409 restoring; while S3
//      has not finished the sweep waits; once it has, the media is copied
//      back to STANDARD and the title becomes what was asked for;
//    - a policy changed to a colder tier moves an archived title further, a
//      warmer one or none leaves it;
//    - a title in Archive storage deleted to the restore bin stays at its keys
//      (S3 cannot copy it), restores from the bin with nothing moved, and the
//      purge deletes it;
//    - an object over the single-copy limit changes class by a multipart copy
//      that keeps its size and content type (limit lowered for the test).
//
//  Usage: DATABASE_URL=... npx tsx test/vod-archive-tier.check.ts
// ============================================================================
import { mkdtemp, mkdir } from 'node:fs/promises';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let moto: ChildProcess | null = null;
  let endpoint = process.env.SITE_S3_TEST_ENDPOINT || '';
  if (!endpoint) {
    if (spawnSync('moto_server', ['--help'], { stdio: 'ignore' }).status !== 0) {
      console.log('PASS skipped: no S3 API here (install moto: pip install "moto[server]", or set SITE_S3_TEST_ENDPOINT)');
      console.log('\n1 passed, 0 failed');
      process.exit(0);
    }
    const port = 5900 + Math.floor(Math.random() * 300);
    moto = spawn('moto_server', ['-p', String(port)], { stdio: 'ignore' });
    endpoint = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) { try { await fetch(endpoint); break; } catch { await sleep(200); } }
  }
  const BUCKET = `volt-tier-${Date.now().toString(36)}`;
  const root = await mkdtemp(join(tmpdir(), 'vod-tier-'));
  Object.assign(process.env, {
    IMAGE_STORE_DIR: join(root, '_images'), FILLER_DIR: join(root, '_filler'), CLIPS_DIR: join(root, '_clips'), ORIGIN_DIR: join(root, '_origin'),
    VOLT_TRASH_DIR: join(root, '_trash'),
    VOD_STORE: 's3', VOD_SOURCE_DRIVER: 's3', S3_BUCKET: BUCKET, AWS_ENDPOINT_URL: endpoint, AWS_ENDPOINT_URL_S3: endpoint, S3_FORCE_PATH_STYLE: '1',
    AWS_ACCESS_KEY_ID: process.env.SITE_S3_TEST_KEY_ID || 'test', AWS_SECRET_ACCESS_KEY: process.env.SITE_S3_TEST_SECRET || 'test',
    AWS_REGION: process.env.AWS_REGION || 'us-east-1',
    // A 6 MB original is "big" here, so the multipart copy runs on a real API.
    S3_COPY_LIMIT_BYTES: String(5 * 1024 * 1024), S3_COPY_PART_BYTES: String(5 * 1024 * 1024),
  });
  await mkdir(process.env.CLIPS_DIR!, { recursive: true });
  const { S3Client, CreateBucketCommand, PutObjectCommand, ListObjectsV2Command, HeadObjectCommand } = await import('@aws-sdk/client-s3');
  const s3 = new S3Client({ region: process.env.AWS_REGION, endpoint, forcePathStyle: true });
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
  const classes = async (prefix: string) => {
    const r: any = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
    return (r.Contents ?? []).map((o: any) => `${o.Key.slice(prefix.length)}:${o.StorageClass ?? 'STANDARD'}`).sort();
  };

  const T = await import('../src/services/media/vodArchiveTier');
  console.log('== pure ==');
  ok(T.shouldMove('glacier', null) && T.shouldMove('infrequent', null) && T.shouldMove('glacier', 'infrequent'), 'moves to a colder tier');
  ok(!T.shouldMove('infrequent', 'glacier') && !T.shouldMove(null, 'glacier') && !T.shouldMove('glacier', 'glacier') && !T.shouldMove(null, null), 'never warmer, never the same, never with no tier');
  ok(T.restoreWaitMs('glacier') === 5 * 3_600_000 && T.restoreWaitMs('infrequent') === 0 && T.restoreWaitMs(null) === 0, 'Archive storage waits 5 hours (Standard restore); Infrequent access and none do not');
  ok(T.waitWords(5 * 3_600_000) === 'about 5 hours' && T.waitWords(3_600_000) === 'about 1 hour' && T.waitWords(300_000) === 'about 5 minutes', 'the wait in words');

  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const tag = Date.now().toString(36);
  const mkAcct = async (n: string) => (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`${n}-${tag}`]))!.id as string;
  const gl = await mkAcct('tier-glacier'), ia = await mkAcct('tier-ia'), none = await mkAcct('tier-none');
  const tokFor = async (a: string, n: string) => {
    const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `${n}-${tag}@example.com`]))!.id;
    return signAccess({ sub: u, account_id: a, role: 'owner' } as any);
  };
  const tok: Record<string, string> = { [gl]: await tokFor(gl, 'gl'), [ia]: await tokFor(ia, 'ia'), [none]: await tokFor(none, 'none') };
  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (acct: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok[acct]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let b: any = null; try { b = text ? JSON.parse(text) : null; } catch { b = text; }
    return { status: r.status, body: b };
  };
  const rule = (a: string, retention: any) =>
    query(`INSERT INTO publishing_rules(account_id, scope_kind, scope_id, settings) VALUES ($1,'account',NULL,$2::jsonb) RETURNING id`, [a, JSON.stringify({ retention })]);
  const glRule = (await one<any>(`INSERT INTO publishing_rules(account_id, scope_kind, scope_id, settings) VALUES ($1,'account',NULL,$2::jsonb) RETURNING id`, [gl, JSON.stringify({ retention: { keep: 'forever', archiveTier: 'glacier' } })]))!.id;
  await rule(ia, { keep: 'forever', archiveTier: 'infrequent' });
  await rule(none, { keep: 'forever' });

  // A title as the bucket store leaves it: a package under vod/<id>/ and an original under vod-src/.
  const mk = async (a: string, title: string, o: { bigOriginal?: boolean } = {}) => {
    const id = (await one<any>(
      `INSERT INTO vod_assets (account_id, source_kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, availability_state)
       VALUES ($1,'upload',$2,'pending',0,0,1,'draft') RETURNING id`, [a, title]))!.id as string;
    const put = (Key: string, Body: Buffer | string, ContentType: string) => s3.send(new PutObjectCommand({ Bucket: BUCKET, Key, Body, ContentType }));
    await put(`vod/${id}/master.m3u8`, '#EXTM3U\n', 'application/vnd.apple.mpegurl');
    await put(`vod/${id}/v0/seg_1.m4s`, Buffer.alloc(2048, 1), 'video/iso.segment');
    await put(`vod/${id}/ladders/g1/2s/master.m3u8`, '#EXTM3U\n', 'application/vnd.apple.mpegurl');
    const src = `vod-src/${id}/${title.replace(/\W+/g, '-')}.mp4`;
    await put(src, Buffer.alloc(o.bigOriginal ? 6 * 1024 * 1024 + 123 : 4096, 2), 'video/mp4');
    await query(`UPDATE vod_assets SET master_key = $2, source_key = $3 WHERE id = $1`, [id, `vod/${id}/master.m3u8`, `s3://${BUCKET}/${src}`]);
    return { id, src };
  };
  const row = (id: string) => one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [id]);
  const logOf = async (id: string) => (await query<any>(`SELECT event FROM vod_retention_log WHERE vod_asset_id = $1 ORDER BY created_at`, [id])).map((x) => x.event);
  const until = async (fn: () => Promise<boolean>, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; };

  try {
    console.log('\n== archive to Archive storage ==');
    const A = await mk(gl, 'Big Film', { bigOriginal: true });
    let r = await api(gl, 'POST', `/api/vod/${A.id}/archive`, {});
    ok(r.status === 200 && !!r.body.archivedAt, 'archived through the API', r.status);
    ok(await until(async () => (await row(A.id))!.archive_tier === 'glacier'), 'the archive route starts the move at once (no wait for the sweep)', (await row(A.id))?.archive_tier_error);
    ok(JSON.stringify(await classes(`vod/${A.id}/`)) === JSON.stringify(['ladders/g1/2s/master.m3u8:GLACIER', 'master.m3u8:GLACIER', 'v0/seg_1.m4s:GLACIER']), 'every object under vod/<id>/ (package and ladder variant) is in GLACIER at the same key', await classes(`vod/${A.id}/`));
    const h: any = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: A.src }));
    ok(h.StorageClass === 'GLACIER' && Number(h.ContentLength) === 6 * 1024 * 1024 + 123 && h.ContentType === 'video/mp4', 'the original over the single-copy limit moved by a multipart copy, same size and content type', { cls: h.StorageClass, len: h.ContentLength, type: h.ContentType });
    ok((await row(A.id))!.archive_tier_state === 'moved' && !!(await row(A.id))!.archive_tier_at && (await logOf(A.id)).includes('tier_moved'), 'stored on the title and logged');
    let s = await T.sweepArchiveTiers({ accountId: gl });
    ok(s.moved === 0 && s.failed === 0, 'the next sweep leaves it (already there)', s);
    r = await api(gl, 'GET', `/api/vod/${A.id}`);
    ok(r.body.archive_storage?.tier === 'glacier' && r.body.archive_storage?.restoreWait === 'about 5 hours' && r.body.archive_storage?.state === 'moved', 'GET /api/vod/:id says where its media is and how long a restore takes', r.body.archive_storage);

    console.log('\n== restore from Archive storage: the wait is said first ==');
    r = await api(gl, 'POST', `/api/vod/${A.id}/unarchive`, { to: 'published' });
    const exp = new Date(r.body?.expectedBy ?? 0).getTime() - Date.now();
    ok(r.status === 409 && r.body.code === 'restore_wait' && exp > 4.9 * 3_600_000 && exp <= 5 * 3_600_000 && /about 5 hours/.test(r.body.error), 'without acceptWait: 409 restore_wait with when it is expected and the wait in words', r);
    ok(!!(await row(A.id))!.archived_at && !(await row(A.id))!.archive_tier_state?.startsWith('restoring'), 'still archived and no restore asked for');
    // While S3 has not restored the objects, the sweep waits.
    await query(`UPDATE vod_assets SET archive_tier_state = 'restoring', archive_restore_to = 'published' WHERE id = $1`, [A.id]);
    ok(await T.finishRestore(await one<any>(`SELECT v.*, v.account_id FROM vod_assets v WHERE id = $1`, [A.id])) === 'waiting', 'while S3 has not finished, the sweep waits');
    ok(!!(await row(A.id))!.archived_at && (await classes(`vod/${A.id}/`)).every((x: string) => x.endsWith(':GLACIER')), 'and nothing changes');
    await query(`UPDATE vod_assets SET archive_tier_state = 'moved', archive_restore_to = NULL WHERE id = $1`, [A.id]);
    r = await api(gl, 'POST', `/api/vod/${A.id}/unarchive`, { to: 'draft', acceptWait: true });
    ok(r.status === 202 && r.body.restoring === true && r.body.archiveStorage?.state === 'restoring' && r.body.editorial_state === 'archived', 'accepted: 202, the restore starts and the title stays archived', r);
    const rr = await row(A.id);
    ok(rr!.archive_tier_state === 'restoring' && rr!.archive_restore_to === 'draft' && !!rr!.archive_restore_expected_by, 'restoring, to Draft, with when it is expected');
    r = await api(gl, 'POST', `/api/vod/${A.id}/unarchive`, { to: 'published', acceptWait: true });
    ok(r.status === 409 && r.body.code === 'restoring', 'a second request answers 409 restoring', r);
    s = await T.sweepArchiveTiers({ accountId: gl });
    ok(s.restored === 1 && s.failed === 0, 'once S3 has restored it, the sweep finishes the restore', s);
    ok(JSON.stringify(await classes(`vod/${A.id}/`)) === JSON.stringify(['ladders/g1/2s/master.m3u8:STANDARD', 'master.m3u8:STANDARD', 'v0/seg_1.m4s:STANDARD']), 'the package is back in STANDARD at its keys', await classes(`vod/${A.id}/`));
    const h2: any = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: A.src }));
    ok((h2.StorageClass ?? 'STANDARD') === 'STANDARD' && Number(h2.ContentLength) === 6 * 1024 * 1024 + 123, 'the original too', h2.StorageClass);
    const after = await row(A.id);
    ok(!after!.archived_at && after!.archive_tier === null && after!.archive_tier_state === null && after!.archive_restore_to === null, 'the title is out of the archive and its tier cleared');
    r = await api(gl, 'GET', `/api/vod/${A.id}`);
    ok(r.body.editorial_state === 'draft' && r.body.archive_storage === null, 'restored as a Draft, as asked', { st: r.body.editorial_state, as: r.body.archive_storage });
    ok((await logOf(A.id)).join(',').includes('tier_moved,tier_restoring,tier_returned'), 'moved, restoring and returned are logged', await logOf(A.id));

    console.log('\n== no tier, and the Mac ==');
    const N = await mk(none, 'No tier');
    r = await api(none, 'POST', `/api/vod/${N.id}/archive`, {});
    await sleep(500);
    s = await T.sweepArchiveTiers();
    ok((await row(N.id))!.archive_tier === null && (await classes(`vod/${N.id}/`)).every((x: string) => x.endsWith(':STANDARD')), 'a policy with no tier moves nothing', await classes(`vod/${N.id}/`));
    r = await api(none, 'POST', `/api/vod/${N.id}/unarchive`, { to: 'draft' });
    ok(r.status === 200 && r.body.editorial_state === 'draft', 'and restores at once as before', r.status);
    process.env.VOD_STORE = 'local';
    ok((await T.locationsOf({ id: N.id, source_key: '/Users/x/vod-src/a.mp4' })).length === 0, 'on the Mac (local store, local original) there is nothing to move');
    ok(await T.applyArchiveTier({ id: N.id, archived_at: new Date(), source_key: '/Users/x/vod-src/a.mp4' }, 'glacier') === 'kept', 'and applying a tier there keeps it as it is');
    process.env.VOD_STORE = 's3';

    console.log('\n== Infrequent access ==');
    const I = await mk(ia, 'Talk');
    r = await api(ia, 'POST', `/api/vod/${I.id}/archive`, {});
    ok(await until(async () => (await row(I.id))!.archive_tier === 'infrequent'), 'archived: moved to Infrequent access');
    ok((await classes(`vod/${I.id}/`)).every((x: string) => x.endsWith(':STANDARD_IA')) && (await classes(`vod-src/${I.id}/`)).every((x: string) => x.endsWith(':STANDARD_IA')), 'package and original in STANDARD_IA', await classes(`vod/${I.id}/`));
    r = await api(ia, 'GET', `/api/vod/${I.id}`);
    ok(r.body.archive_storage?.tier === 'infrequent' && r.body.archive_storage?.restoreWaitMs === 0, 'no restore wait for Infrequent access', r.body.archive_storage);
    r = await api(ia, 'POST', `/api/vod/${I.id}/unarchive`, { to: 'draft' });
    ok(r.status === 200 && r.body.editorial_state === 'draft', 'restored at once (no wait)', r);
    ok(await until(async () => (await row(I.id))!.archive_tier === null), 'its media is moved back afterwards', (await row(I.id))?.archive_tier_error);
    ok((await classes(`vod/${I.id}/`)).every((x: string) => x.endsWith(':STANDARD')) && (await classes(`vod-src/${I.id}/`)).every((x: string) => x.endsWith(':STANDARD')), 'package and original back in STANDARD');

    console.log('\n== a policy changed while archived ==');
    const I2 = await mk(ia, 'Lecture');
    await api(ia, 'POST', `/api/vod/${I2.id}/archive`, {});
    await until(async () => (await row(I2.id))!.archive_tier === 'infrequent');
    await query(`UPDATE publishing_rules SET settings = jsonb_set(settings, '{retention,archiveTier}', '"glacier"') WHERE account_id = $1`, [ia]);
    s = await T.sweepArchiveTiers({ accountId: ia });
    ok(s.moved === 1 && (await row(I2.id))!.archive_tier === 'glacier' && (await classes(`vod/${I2.id}/`)).every((x: string) => x.endsWith(':GLACIER')), 'changed to a colder tier: the archived title moves further (IA to GLACIER)', s);
    await query(`UPDATE publishing_rules SET settings = jsonb_set(settings, '{retention,archiveTier}', 'null') WHERE account_id = $1`, [ia]);
    s = await T.sweepArchiveTiers({ accountId: ia });
    ok((await row(I2.id))!.archive_tier === 'glacier' && (await classes(`vod/${I2.id}/`)).every((x: string) => x.endsWith(':GLACIER')), 'changed to none: it stays where it is (no copy and restore for nothing)');

    console.log('\n== deleted while in Archive storage ==');
    const D = await mk(gl, 'Old Doc');
    await api(gl, 'POST', `/api/vod/${D.id}/archive`, {});
    await until(async () => (await row(D.id))!.archive_tier === 'glacier');
    const { removeVodAsset } = await import('../src/services/vodRemove');
    const binId = await removeVodAsset(D.id, { reason: 'test' });
    const item = await one<any>(`SELECT * FROM trash_items WHERE id = $1`, [binId]);
    ok(!!binId && !(await row(D.id)) && item.objects?.[0]?.inPlace === true && item.objects[0].from === item.objects[0].to, 'it goes to the restore bin, its media recorded in place', item?.objects);
    ok((await classes(`vod/${D.id}/`)).length === 3 && (await classes(`trash/${binId}/`)).length === 0, 'its objects stay at their keys (S3 cannot copy Glacier objects)');
    const { restoreItem, purgeItem } = await import('../src/services/media/trash');
    const back = await restoreItem(binId!, { accountId: gl });
    ok(!!(await row(D.id)) && (await row(D.id))!.archive_tier === 'glacier' && (await classes(`vod/${D.id}/`)).length === 3, 'restored from the bin: the title is back, still archived in Archive storage, nothing moved', back);
    const bin2 = await removeVodAsset(D.id, { reason: 'test again' });
    await purgeItem(bin2!);
    ok((await classes(`vod/${D.id}/`)).length === 0, 'the purge deletes it at its own keys');

    console.log('\n== the driver ==');
    const { S3Driver, mediaS3Client } = await import('../src/services/media/s3Driver');
    const d = new S3Driver(() => mediaS3Client(process.env.AWS_REGION!));
    let err = '';
    try { await d.transition(`s3://${BUCKET}/vod/${I2.id}/`, 's3_standard'); } catch (e: any) { err = e.message; }
    ok(/restore it before moving it/.test(err), 'Glacier objects that are not restored are still refused without `restored`', err);
  } finally {
    srv.close();
    moto?.kill();
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(1); });
