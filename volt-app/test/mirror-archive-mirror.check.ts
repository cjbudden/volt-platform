// ============================================================================
//  MIRROR AND ARCHIVE: mirror mode (build queue H3-10, decided by Christian on
//  11 Nov 2026).
//
//  Through the real API on a real database, with the REAL site agent code
//  (volt-agent/src/siteArchive.ts) deleting from folders that stand in for
//  the customer's NAS, and from an in-memory S3-compatible store:
//    - rules: `mode: 'mirror'` saved, archive stored unsaid, an unknown mode
//      refused; the target's grace period 7 by default, 0 to 90, refused
//      outside it;
//    - a deleted asset in the restore bin starts nothing; a restore puts it
//      back; once the bin is purged the grace period starts (mirror targets
//      only), nothing is deleted before it ends, then the agent removes the
//      copy, the row says so and the audit trail has it;
//    - nothing is ever deleted from an archive-mode target;
//    - a file changed at the site is kept (and reported); one already gone is
//      recorded so; a rule switched back to archive keeps the copy;
//    - a caption removed from an asset that stays starts its own grace;
//    - a package goes file by file (only Volt's files; its folder only once
//      empty; nothing at all if a file changed);
//    - a store target: the object is deleted, a changed one kept;
//    - a restore cancels a pending delete and its queued job; a longer grace
//      period moves pending deletes later; no licence, a disabled target or an
//      agent that does not know `archive.delete` means nothing is deleted.
//
//  Usage: DATABASE_URL=... npx tsx test/mirror-archive-mirror.check.ts
// ============================================================================
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const DAY = 86_400_000;

(async () => {
  process.env.CLIPS_DIR ||= mkdtempSync(join(tmpdir(), 'mam-clips-'));
  process.env.IMAGE_STORE_DIR = mkdtempSync(join(tmpdir(), 'mam-img-'));
  process.env.ARCHIVE_BUILD_DIR = mkdtempSync(join(tmpdir(), 'mam-build-'));
  process.env.VOLT_TRASH_DIR = mkdtempSync(join(tmpdir(), 'mam-trash-'));
  const A = await import('../src/services/archive/archive');
  const M = await import('../src/services/archive/mirror');
  const AG = await import('../../volt-agent/src/siteArchive');
  const { packageManifest } = await import('../src/services/archive/packageManifest');
  const { removeVodAsset } = await import('../src/services/vodRemove');
  const T = await import('../src/services/media/trash');
  const { imageStore } = await import('../src/services/imageStore');
  const { enqueue } = await import('../src/services/jobs/queue');

  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name, licences) VALUES ($1, $2) RETURNING id`, [`mam-${tag}`, ['mirror_archive']]))!.id as string;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `mam-${tag}@example.com`]))!.id;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' } as any);

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: unknown, t: string | null = tok) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let b: any = null; try { b = text ? JSON.parse(text) : null; } catch { b = text; }
    return { status: r.status, body: b };
  };
  const facts = (hostname: string) => ({ hostname, cpuCores: 4, memoryBytes: 8 * 2 ** 30, diskFreeBytes: 1e12, diskTotalBytes: 2e12, os: 'Linux', arch: 'x64', agentVersion: '0.13.0' });
  const site = (await api('POST', '/api/sites', { name: 'NAS room' })).body.id;
  const tk = await api('POST', `/api/sites/${site}/enrolment-tokens`, {});
  const en = await api('POST', '/api/site-agent/enrol', { token: tk.body.token, host: facts('nas-01') }, null);
  await api('POST', `/api/sites/${site}/hosts/${en.body.hostId}/approve`, {});

  // An in-memory S3-compatible store at the site, reached only by the agent.
  const ENDPOINT = 'http://fake-store.local:9000';
  const store = new Map<string, Buffer>();
  const realFetch = fetch;
  const fakeFetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    if (!url.startsWith(ENDPOINT)) return realFetch(input, init);
    const key = decodeURIComponent(new URL(url).pathname.replace(/^\/[^/]+\//, ''));
    const method = init.method ?? 'GET';
    if (method === 'GET') { const b = store.get(key); return b ? new Response(b, { status: 200 }) : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 }); }
    if (method === 'DELETE') { store.delete(key); return new Response(null, { status: 204 }); }
    return new Response('not here', { status: 501 });
  }) as typeof fetch;
  const keysFile = join(mkdtempSync(join(tmpdir(), 'mam-keys-')), 'archive-keys.json');
  writeFileSync(keysFile, JSON.stringify({ 'nas-store': { accessKeyId: 'AK', secretAccessKey: 'SK' } })); chmodSync(keysFile, 0o600);
  const ctx = { server: base, credential: () => en.body.credential as string, log: (_s: string) => {}, progressEveryMs: 50, fetch: fakeFetch, keysFile };
  const drain = async () => { let n = 0; for (let i = 0; i < 20; i++) { const ran = await AG.archivePass(ctx); n += ran; if (!ran) break; } return n; };

  const nas = mkdtempSync(join(tmpdir(), 'mam-nas-'));
  const keep = mkdtempSync(join(tmpdir(), 'mam-keep-'));

  console.log('== targets: the grace period ==');
  let r = await api('POST', '/api/archive/targets', { name: 'Mirror NAS', siteId: site, path: nas });
  ok(r.status === 201 && r.body.mirrorGraceDays === 7 && r.body.pendingDeletes === 0 && r.body.nextDeleteAt === null, 'a new target waits 7 days by default and has nothing pending', r.body);
  const mirror = r.body.id as string;
  r = await api('POST', '/api/archive/targets', { name: 'Archive NAS', siteId: site, path: keep, mirrorGraceDays: 0 });
  ok(r.status === 201 && r.body.mirrorGraceDays === 0, '0 days is allowed (delete as soon as it has left Volt)', r.body?.mirrorGraceDays);
  const archive = r.body.id as string;
  for (const bad of [91, -1, 2.5, 'x', null]) {
    r = await api('PATCH', `/api/archive/targets/${mirror}`, { mirrorGraceDays: bad });
    ok(r.status === 400, `a grace period of ${JSON.stringify(bad)} is refused`, r.status);
  }
  r = await api('PATCH', `/api/archive/targets/${mirror}`, { mirrorGraceDays: 2 });
  ok(r.status === 200 && r.body.mirrorGraceDays === 2 && r.body.changed.includes('mirrorGraceDays'), 'the period is changed per target', r.body);
  ok((await one<any>(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND detail->'changes' ? 'mirrorGraceDays'`, [mirror])).n === 1, 'and the change is audited');

  console.log('== rules: mode ==');
  r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: mirror, on: ['ingest'], mode: 'sync' }] } } });
  ok(r.status === 422, 'an unknown mode is refused', r.status);
  r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: mirror, on: ['ingest'], what: ['source', 'sidecars'], mode: 'mirror' }, { targetId: archive, on: ['ingest'], mode: 'archive' }] } } });
  ok(r.status === 200 && r.body.settings.archive.copies[0].mode === 'mirror' && r.body.settings.archive.copies[1].mode === undefined,
    'mirror is saved; archive (the default) is stored unsaid', r.body?.settings?.archive);

  const srcDir = join(process.env.CLIPS_DIR!, 'vod-src');
  mkdirSync(srcDir, { recursive: true });
  const mkAsset = async (file: string, body: Buffer) => {
    const key = join(srcDir, file); writeFileSync(key, body);
    return (await one<any>(`INSERT INTO vod_assets (account_id, source_kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, source_key, sha256)
      VALUES ($1,'upload',$2,'/x',0,0,61000,$3,$4) RETURNING id`, [acct, file.replace(/\.[a-z0-9]+$/, ''), key, sha(body)]))!.id as string;
  };
  const copiesOf = (assetOrIds: string | string[], target?: string) => typeof assetOrIds === 'string'
    ? query<any>(`SELECT * FROM archive_copies WHERE vod_asset_id = $1 AND ($2::uuid IS NULL OR target_id = $2) ORDER BY what`, [assetOrIds, target ?? null])
    : query<any>(`SELECT * FROM archive_copies WHERE id = ANY($1::uuid[]) ORDER BY what`, [assetOrIds]);
  const nowish = Date.now();

  console.log('== an asset in the bin is still in Volt ==');
  const bytesA = randomBytes(120_000);
  const assetA = await mkAsset(`News A ${tag}.mp4`, bytesA);
  let out = await A.copyOnRule(acct, assetA, 'ingest');
  await drain();
  const aMirror = await copiesOf(assetA, mirror), aArchive = await copiesOf(assetA, archive);
  ok(aMirror.length === 2 && aMirror.every((c) => c.state === 'verified' && c.mode === 'mirror'), 'copies at the mirror target are verified and marked mirror', aMirror.map((c) => [c.what, c.state, c.mode]));
  ok(aArchive.length === 1 && aArchive[0].state === 'verified' && aArchive[0].mode === 'archive', 'the copy at the archive target is marked archive', aArchive.map((c) => [c.what, c.mode]));
  const aIds = [...aMirror, ...aArchive].map((c) => c.id);
  const aFile = join(nas, `NewsA${tag}.mp4`), aMeta = join(nas, `NewsA${tag}.json`), aKeep = join(keep, `NewsA${tag}.mp4`);
  ok(existsSync(aFile) && existsSync(aMeta) && existsSync(aKeep), 'the files are at both targets', readdirSync(nas));
  r = await api('GET', `/api/archive/copies/${aMirror[0].id}`);
  ok(r.body.mode === 'mirror' && r.body.deleteAfter === null && r.body.removedAt === null && r.body.deleting === false, 'a copy shows its mode and that nothing is pending', r.body);

  let binA = await removeVodAsset(assetA, { by: null });
  ok(!!binA && (await copiesOf(aIds)).every((c) => c.vod_asset_id === null), 'deleting the asset puts it in the bin; its copies lose the link');
  let p = await M.mirrorPass({ accountId: acct, now: new Date(nowish) });
  ok(p.started === 0 && (await copiesOf(aIds)).every((c) => c.delete_after === null), 'while it is in the bin (it can be restored) no grace period starts', p);
  p = await M.mirrorPass({ accountId: acct, now: new Date(nowish + 30 * DAY) });
  ok(p.started === 0 && p.queued === 0, 'not even a month later while the bin item is held', p);
  await T.restoreItem(binA!, { accountId: acct });
  ok((await copiesOf(aIds)).every((c) => c.vod_asset_id === assetA), 'a restore puts the links back');
  p = await M.mirrorPass({ accountId: acct, now: new Date(nowish) });
  ok(p.started === 0, 'and nothing is pending', p);

  console.log('== out of the bin for good: the grace period, then the delete ==');
  binA = await removeVodAsset(assetA, { by: null });
  await T.purgeItem(binA!);
  const t0 = new Date(nowish);
  p = await M.mirrorPass({ accountId: acct, now: t0 });
  let rows = await copiesOf(aIds);
  const mrows = rows.filter((c) => c.target_id === mirror), arows = rows.filter((c) => c.target_id === archive);
  ok(p.started === 2 && mrows.every((c) => c.delete_after && Math.abs(new Date(c.delete_after).getTime() - (t0.getTime() + 2 * DAY)) < 2000),
    'once purged, the mirror copies wait the target\'s 2 days from then', { p, d: mrows.map((c) => c.delete_after) });
  ok(arows.every((c) => c.delete_after === null), 'the archive target\'s copy has nothing pending');
  r = await api('GET', `/api/archive/targets/${mirror}`);
  ok(r.body.pendingDeletes === 2 && new Date(r.body.nextDeleteAt).getTime() === new Date(mrows[0].delete_after).getTime(), 'the target shows the pending deletes and when the next one is due', r.body);
  r = await api('GET', `/api/archive/copies?mode=mirror&delete_after=notnull`);
  r = await api('GET', `/api/archive/copies?mode=mirror`);
  ok(r.status === 200 && r.body.items.filter((c: any) => mrows.some((m) => m.id === c.id)).every((c: any) => c.deleteAfter), 'the copies list filters by mode and shows deleteAfter', r.status);

  p = await M.mirrorPass({ accountId: acct, now: new Date(t0.getTime() + DAY) });
  ok(p.queued === 0 && p.started === 0, 'a day in, nothing is deleted', p);
  ok((await drain()) === 0 && existsSync(aFile), 'and the file is still at the target');
  p = await M.mirrorPass({ accountId: acct, now: new Date(t0.getTime() + 2 * DAY + 60_000) });
  ok(p.queued === 2, 'after the grace period both deletes go to the site', p);
  r = await api('GET', `/api/archive/copies/${mrows[0].id}`);
  ok(r.body.deleting === true, 'the copy shows it is being deleted', r.body?.deleting);
  ok((await M.mirrorPass({ accountId: acct, now: new Date(t0.getTime() + 3 * DAY) })).queued === 0, 'a second pass does not queue them again');
  const ran = await drain();
  rows = await copiesOf(aIds);
  ok(ran === 2 && !existsSync(aFile) && !existsSync(aMeta), 'the agent removes both files from the mirror target', { ran, files: readdirSync(nas) });
  ok(rows.filter((c) => c.target_id === mirror).every((c) => c.state === 'removed' && c.removed_at && c.delete_after === null), 'the rows say removed, and when', rows.map((c) => [c.state, c.removed_at]));
  ok(existsSync(aKeep) && readFileSync(aKeep).equals(bytesA) && arows[0].state === 'verified', 'the archive target keeps its copy, untouched');
  const audits = await query<any>(`SELECT * FROM audit_log WHERE entity_type = 'archive_copy' AND entity_id = ANY($1::uuid[]) AND action = 'delete'`, [mrows.map((c) => c.id)]);
  ok(audits.length === 2 && audits.every((a) => a.detail?.snapshot?.removed === true && a.detail?.snapshot?.storedPath && /site agent at NAS room/.test(a.detail?.actor)),
    'every delete is in the audit trail: by the site agent, which file', audits.map((a) => a.detail));
  r = await api('GET', `/api/archive/copies?state=removed`);
  ok(r.status === 200 && r.body.items.length >= 2, 'removed copies are listed by state', r.body?.items?.length);
  ok((await M.mirrorPass({ accountId: acct, now: new Date(t0.getTime() + 10 * DAY) })).started === 0, 'a removed copy never starts again');

  // Helpers for the next cases: an asset copied under the rule, then gone for good.
  const copied = async (name: string) => {
    const b = randomBytes(40_000);
    const id = await mkAsset(`${name} ${tag}.mp4`, b);
    await A.copyOnRule(acct, id, 'ingest'); await drain();
    const cs = await copiesOf(id, mirror);
    return { id, bytes: b, cs, file: join(nas, cs.find((c) => c.what === 'source')!.stored_path) };
  };
  const goneForGood = async (id: string) => { const bin = await removeVodAsset(id, { by: null }); await T.purgeItem(bin!); };
  const due = (days = 3) => M.mirrorPass({ accountId: acct, now: new Date(Date.now() + days * DAY) });

  console.log('== a file changed at the site is kept ==');
  const b = await copied('News B');
  writeFileSync(b.file, Buffer.concat([b.bytes, Buffer.from('edited at the site')]));
  await goneForGood(b.id);
  await M.mirrorPass({ accountId: acct }); p = await due(); await drain();
  const bSrc = (await copiesOf(b.cs.map((c) => c.id))).find((c) => c.what === 'source');
  ok(existsSync(b.file) && bSrc.state !== 'removed' && bSrc.mode === 'archive' && bSrc.error_code === 'changed_kept' && /changed after Volt copied it/.test(bSrc.error),
    'the changed file stays, Volt stops trying and says why', bSrc && { state: bSrc.state, mode: bSrc.mode, code: bSrc.error_code });
  ok((await one<any>(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = 'update' AND (detail->'snapshot'->>'kept')::boolean`, [bSrc.id])).n === 1, 'and that it was kept is audited');
  ok((await due(30)).queued === 0, 'and it is not tried again');

  console.log('== a file already gone at the site ==');
  const c = await copied('News C');
  unlinkSync(c.file);
  await goneForGood(c.id);
  await M.mirrorPass({ accountId: acct }); await due(); await drain();
  const cSrc = (await copiesOf(c.cs.map((x) => x.id))).find((x) => x.what === 'source');
  ok(cSrc.state === 'removed' && cSrc.error_code === 'already_gone', 'is recorded as removed, already gone', { state: cSrc.state, code: cSrc.error_code });

  console.log('== a rule switched back to archive keeps the copy ==');
  const d = await copied('News D');
  await goneForGood(d.id);
  p = await M.mirrorPass({ accountId: acct });
  ok(p.started === 2, 'its grace period starts', p);
  await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: mirror, on: ['ingest'], what: ['source', 'sidecars'] }, { targetId: archive, on: ['ingest'] }] } } });
  p = await due();
  const dRows = await copiesOf(d.cs.map((x) => x.id));
  ok(p.kept === 2 && p.queued === 0 && dRows.every((x) => x.mode === 'archive' && x.delete_after === null) && existsSync(d.file),
    'when no rule mirrors to the target any more, the copies are kept as archive copies', { p, rows: dRows.map((x) => [x.mode, x.delete_after]) });
  // Mirror again from here on, on the content-type rung this time: the check covers every rung.
  const schema = (await one<any>(`INSERT INTO metadata_schemas (account_id, name) VALUES ($1, $2) RETURNING id`, [acct, `Mirror type ${tag}`]).catch(() => null))?.id;
  if (schema) {
    r = await api('PUT', `/api/publishing-rules/schema/${schema}`, { settings: { archive: { copies: [{ targetId: mirror, on: ['ingest'], what: ['source', 'sidecars'], mode: 'mirror' }] } } });
    ok(r.status === 200, 'a content type can mirror to the target', r.status);
  }
  await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: mirror, on: ['ingest'], what: ['source', 'sidecars'], mode: 'mirror' }, { targetId: archive, on: ['ingest'] }] } } });

  console.log('== a caption removed from an asset that stays ==');
  const e = await copied('News E');
  const capBody = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHello\n');
  const capId = (await one<any>(`SELECT gen_random_uuid() AS id`))!.id;
  const capKey = `companions/${acct}/${e.id}/${capId}/en.srt`;
  await imageStore().put(capKey, capBody);
  await query(`INSERT INTO vod_asset_files (id, asset_id, account_id, kind, format, name, store_key, bytes, sha256, language, label)
    VALUES ($1,$2,$3,'captions','srt','en.srt',$4,$5,$6,'en','en')`, [capId, e.id, acct, capKey, capBody.length, sha(capBody)]);
  await A.copyOnRule(acct, e.id, 'ingest'); await drain();
  const capCopy = (await copiesOf(e.id, mirror)).find((x) => x.what === `captions:${capId}`);
  ok(capCopy?.state === 'verified' && capCopy.mode === 'mirror', 'the caption file is copied under the mirror rule', capCopy && [capCopy.state, capCopy.mode]);
  const capFile = join(nas, capCopy.stored_path);
  const { deleteFile } = await import('../src/services/companions/store');
  await deleteFile(e.id, acct, capId);
  p = await M.mirrorPass({ accountId: acct });
  const eRows = await copiesOf(e.id, mirror);
  ok(p.started === 1 && eRows.filter((x) => x.delete_after).map((x) => x.what).join() === `captions:${capId}`, 'only the caption\'s copy starts its grace period; the asset stays', { p, w: eRows.map((x) => [x.what, !!x.delete_after]) });
  await due(); await drain();
  ok(!existsSync(capFile) && existsSync(e.file), 'then the caption file goes and the original stays', readdirSync(nas).filter((n) => n.includes('NewsE')));

  console.log('== a restore cancels a pending delete ==');
  const f = await copied('News F');
  const binF = await removeVodAsset(f.id, { by: null });
  const fIds = f.cs.map((x) => x.id);
  // As if a delete were already waiting for these copies (it cannot be while the
  // bin holds them; the restore must clear it whatever the cause).
  const job = await enqueue({ type: A.ARCHIVE_DELETE, pool: `site:${site}`, payload: { copyId: fIds[0], storedPath: 'x', sha256: '0'.repeat(64), target: { id: mirror, kind: 'path', path: nas } } });
  await query(`UPDATE archive_copies SET delete_after = now() + interval '1 day', delete_job_id = $2 WHERE id = $1`, [fIds[0], job.id]);
  await T.restoreItem(binF!, { accountId: acct });
  const fRow = (await copiesOf([fIds[0]]))[0];
  ok(fRow.delete_after === null && (await one<any>(`SELECT state FROM jobs WHERE id = $1`, [job.id]))!.state === 'cancelled', 'the restore clears the pending delete and cancels its queued job', { d: fRow.delete_after });
  await query(`UPDATE archive_copies SET delete_after = now() + interval '1 day' WHERE id = $1`, [fIds[0]]);
  p = await M.mirrorPass({ accountId: acct });
  ok(p.cancelled >= 1 && (await copiesOf([fIds[0]]))[0].delete_after === null, 'and the pass clears any pending delete of something that is in Volt', p);

  console.log('== the grace period moves pending deletes ==');
  const g = await copied('News G');
  await goneForGood(g.id);
  await M.mirrorPass({ accountId: acct, now: new Date(nowish) });
  const before = (await copiesOf(g.cs.map((x) => x.id))).map((x) => new Date(x.delete_after).getTime());
  r = await api('PATCH', `/api/archive/targets/${mirror}`, { mirrorGraceDays: 9 });
  const after = (await copiesOf(g.cs.map((x) => x.id))).map((x) => new Date(x.delete_after).getTime());
  ok(r.status === 200 && after.every((t, i) => t - before[i] === 7 * DAY), 'a longer period moves what is waiting later by the difference', { before, after });
  p = await due(3);
  ok(p.queued === 0 && existsSync(g.file), 'so it is not deleted on the old date', p);

  console.log('== nothing without the licence, a disabled target or a new enough agent ==');
  await query(`UPDATE accounts SET licences = '{}' WHERE id = $1`, [acct]);
  ok((await due(12)).queued === 0, 'without the licence nothing is queued');
  await query(`UPDATE accounts SET licences = '{mirror_archive}' WHERE id = $1`, [acct]);
  await api('PATCH', `/api/archive/targets/${mirror}`, { status: 'disabled' });
  ok((await due(12)).queued === 0 && existsSync(g.file), 'a disabled target is not touched');
  await api('PATCH', `/api/archive/targets/${mirror}`, { status: 'active' });
  ok((await due(12)).queued === 2, 'once active again the deletes go', p);
  const lease = await fetch(`${base}/api/site-agent/jobs/lease`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${en.body.credential}` },
    body: JSON.stringify({ types: ['archive.copy', 'archive.verify', 'archive.copy-folder', 'archive.verify-folder', 'archive.restore'] }) });
  ok(lease.status === 204, 'an agent from before mirror mode never leases a delete', lease.status);
  await drain();
  ok(!existsSync(g.file), 'the current agent does');

  console.log('== a package: only Volt\'s files, all or nothing ==');
  const mkPackage = async (name: string, extra?: string) => {
    const dir = join(nas, name); mkdirSync(join(dir, 'hls'), { recursive: true });
    const files = [{ path: 'master.m3u8', body: Buffer.from('#EXTM3U\n') }, { path: 'hls/seg1.ts', body: randomBytes(5000) }, { path: 'hls/seg2.ts', body: randomBytes(5000) }];
    for (const x of files) writeFileSync(join(dir, x.path), x.body);
    if (extra) writeFileSync(join(dir, extra), 'not Volt\'s');
    const listed = files.map((x) => ({ path: x.path, bytes: x.body.length, sha256: sha(x.body) }));
    const cj = await enqueue({ type: A.ARCHIVE_COPY_FOLDER, pool: 'site:none', payload: { files: listed } });
    await query(`UPDATE jobs SET state = 'succeeded', finished_at = now() WHERE id = $1`, [cj.id]);
    const row = await one<any>(`INSERT INTO archive_copies (account_id, target_id, vod_asset_id, what, source_uri, file_name, stored_path, sha256, bytes, state, job_id, mode)
      VALUES ($1,$2,NULL,'package','vod/x',$3,$3,$4,$5,'verified',$6,'mirror') RETURNING *`, [acct, mirror, name, packageManifest(listed), listed.reduce((s, x) => s + x.bytes, 0), cj.id]);
    return { dir, row };
  };
  const pk1 = await mkPackage(`Pkg1-${tag}-package`);
  const pk2 = await mkPackage(`Pkg2-${tag}-package`, 'notes.txt');
  const pk3 = await mkPackage(`Pkg3-${tag}-package`);
  writeFileSync(join(pk3.dir, 'hls/seg2.ts'), 'changed');
  await M.mirrorPass({ accountId: acct }); await due(12); await drain();
  const pks = await copiesOf([pk1.row.id, pk2.row.id, pk3.row.id]);
  const st = (id: string) => pks.find((x) => x.id === id);
  ok(!existsSync(pk1.dir) && st(pk1.row.id).state === 'removed', 'a whole package goes, its folders with it', existsSync(pk1.dir) && readdirSync(pk1.dir));
  ok(existsSync(join(pk2.dir, 'notes.txt')) && !existsSync(join(pk2.dir, 'master.m3u8')) && !existsSync(join(pk2.dir, 'hls')) && st(pk2.row.id).state === 'removed',
    'a file that is not Volt\'s stays, with its folder; Volt\'s files go', existsSync(pk2.dir) && readdirSync(pk2.dir));
  ok(existsSync(join(pk3.dir, 'master.m3u8')) && existsSync(join(pk3.dir, 'hls/seg1.ts')) && st(pk3.row.id).error_code === 'changed_kept' && st(pk3.row.id).mode === 'archive',
    'a package with a changed file is kept whole', { code: st(pk3.row.id).error_code });

  console.log('== an S3-compatible store ==');
  r = await api('POST', '/api/archive/targets', { name: 'Store', siteId: site, kind: 's3', mirrorGraceDays: 1, s3: { endpoint: ENDPOINT, bucket: 'nas-archive', prefix: 'Volt', credentialRef: 'nas-store' } });
  const storeT = r.body.id as string;
  await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: storeT, on: ['ingest'], mode: 'mirror' }] } } });
  const s1 = randomBytes(3000), s2 = randomBytes(3000);
  store.set('Volt/one.mp4', s1); store.set('Volt/two.mp4', Buffer.from('changed in the store'));
  const sRows = [];
  for (const [n, body] of [['one.mp4', s1], ['two.mp4', s2]] as const) {
    sRows.push(await one<any>(`INSERT INTO archive_copies (account_id, target_id, vod_asset_id, what, source_uri, file_name, stored_path, sha256, bytes, state, mode)
      VALUES ($1,$2,NULL,'source','x',$3,$3,$4,$5,'verified','mirror') RETURNING *`, [acct, storeT, n, sha(body), body.length]));
  }
  await M.mirrorPass({ accountId: acct }); p = await due(2); await drain();
  const sAfter = await copiesOf(sRows.map((x) => x.id));
  ok(!store.has('Volt/one.mp4') && sAfter.find((x) => x.file_name === 'one.mp4').state === 'removed', 'the object is deleted from the store', [...store.keys()]);
  ok(store.has('Volt/two.mp4') && sAfter.find((x) => x.file_name === 'two.mp4').error_code === 'changed_kept', 'an object changed in the store is kept');

  console.log('== wired ==');
  const src = (pth: string) => readFileSync(join(__dirname, '..', pth), 'utf8');
  ok(/mirrorPass\(\)/.test(src('src/services/orchestrator/index.ts')), 'the scheduler runs the mirror pass');
  ok(/archive_copies/.test(src('src/services/media/trash.ts')) && /delete_after = NULL/.test(src('src/services/media/trash.ts')), 'a bin restore clears pending mirror deletes');

  srv.close();
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
