// ============================================================================
//  A RE-ENCODE BRINGS THE ORIGINAL BACK BY ITSELF (build queue H3-5d;
//  services/archive/originals.ts restoreThen / runAfterRestore,
//  services/fast/prepare.ts, services/ingest/pipeline.ts queueEncodeFor,
//  the vod.encode and vod.ladder handlers).
//
//  Through the real API on a real database, with the REAL site agent code
//  reading the archive copy from a folder that stands in for the NAS:
//    - two originals copied by the agent and taken out of the cloud;
//    - a FAST channel without a ladder and one whose ladder the asset is not
//      packaged to (an encode profile change): readiness says the original is
//      in the archive and Prepare brings it back (it said "no source");
//      Prepare starts ONE restore for both channels and queues no encode yet;
//      while it comes back the asset reads as preparing and a second Prepare
//      does nothing more;
//    - an encode that finds the original gone (the handler's path, and
//      queueEncodeFor) starts the restore and waits for it; an asset encoded
//      already is not brought back by a later queueEncodeFor;
//    - the asset page says it is coming back, and what waits;
//    - the agent uploads the copy: the encode, the ladder packaging and the
//      other encode are queued with the restored address, the list emptied;
//    - a copy that is no longer verified: no restore, the reason is said;
//    - an asset with no original anywhere is still "no source".
//
//  Usage: DATABASE_URL=... npx tsx test/retention-originals-reencode.check.ts
// ============================================================================
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

(async () => {
  process.env.CLIPS_DIR ||= mkdtempSync(join(tmpdir(), 'rre-clips-'));
  process.env.VOD_STORE = 'local';
  const AG = await import('../../volt-agent/src/siteArchive');
  const O = await import('../src/services/archive/originals');
  const { readinessWithLadder, prepare } = await import('../src/services/fast/prepare');
  const { queueEncodeFor } = await import('../src/services/ingest/pipeline');
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name, licences) VALUES ($1, $2) RETURNING id`, [`rre-${tag}`, ['mirror_archive']]))!.id as string;
  const uid = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `rre-${tag}@example.com`]))!.id;
  const tok = signAccess({ sub: uid, account_id: acct, role: 'owner' } as any);
  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: unknown, t: string | null = tok) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let b: any = null; try { b = text ? JSON.parse(text) : null; } catch { b = text; }
    return { status: r.status, body: b };
  };
  const facts = (hostname: string) => ({ hostname, cpuCores: 4, memoryBytes: 8 * 2 ** 30, diskFreeBytes: 1e12, diskTotalBytes: 2e12, os: 'Linux', arch: 'x64', agentVersion: '0.12.0' });
  const site = (await api('POST', '/api/sites', { name: 'NAS room' })).body.id;
  const tk = await api('POST', `/api/sites/${site}/enrolment-tokens`, {});
  const e = await api('POST', '/api/site-agent/enrol', { token: tk.body.token, host: facts('nas-01') }, null);
  await api('POST', `/api/sites/${site}/hosts/${e.body.hostId}/approve`, {});
  const cred = e.body.credential as string;
  const logs: string[] = [];
  const ctx = { server: base, credential: () => cred, log: (s: string) => logs.push(s), progressEveryMs: 50 };
  const nas = mkdtempSync(join(tmpdir(), 'rre-nas-'));
  const target = (await api('POST', '/api/archive/targets', { name: 'Archive NAS', siteId: site, path: nas })).body.id;

  const srcDir = join(process.env.CLIPS_DIR!, 'vod-src');
  mkdirSync(srcDir, { recursive: true });
  // Encoded before audio and video were aligned for splicing: a FAST channel re-encodes it.
  const mkAsset = async (name: string, ageDays: number) => {
    const body = randomBytes(200_000);
    const key = join(srcDir, `${name}-${tag}.mp4`); writeFileSync(key, body);
    const id = (await one<any>(`INSERT INTO vod_assets (account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, source_key, sha256, encode_result, media_state, created_at)
      VALUES ($1,'upload','export',$2,$3,0,0,8000,$4,$5,$6::jsonb,'ready', now() - make_interval(days => $7)) RETURNING id`,
      [acct, name, `/clips/vod/${name}/master.m3u8`, key, sha(body), JSON.stringify({ zeroStart: false, segmentSeconds: 6, kept: [{ height: 720, bitrate_kbps: 3000 }] }), ageDays]))!.id as string;
    return { id, key, body };
  };
  const row = (id: string) => one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [id]);
  const restores = async (id: string) => (await query<any>(`SELECT id, state FROM jobs WHERE type = 'archive.restore' AND payload->>'vodAssetId' = $1`, [id]));
  const encodes = async (id: string) => (await query<any>(`SELECT id, type, state, payload, channel_id FROM jobs WHERE type IN ('vod.encode','vod.ladder') AND payload->>'vodAssetId' = $1 ORDER BY created_at`, [id]));

  console.log('== originals archived, then taken out of the cloud ==');
  let r = await api('PUT', '/api/storage/retention', { name: 'Default', stages: [{ afterDays: 3650, action: 'delete' }], originalAfterDays: 30 });
  ok(r.status === 200, 'the rule takes originals out after 30 days', r.body);
  const film = await mkAsset('Film', 40);
  const spot = await mkAsset('Spot', 40);
  const lost = await mkAsset('Lost', 40);
  const later = await mkAsset('Later', 40);
  for (const a of [film, spot, lost, later]) await api('POST', '/api/archive/copies', { targetId: target, vodAssetId: a.id });
  await AG.archivePass(ctx);
  const res = await O.sweepOriginals({ accountId: acct, actor: 'test' });
  ok(res.removed === 4 && !existsSync(film.key) && !existsSync(spot.key), 'the pass took the originals out of the cloud', res);
  // A copy that went missing at the NAS since: it cannot be restored from.
  await query(`UPDATE archive_copies SET state = 'missing' WHERE vod_asset_id = $1`, [lost.id]);
  const none = (await one<any>(`INSERT INTO vod_assets (account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, encode_result, media_state)
      VALUES ($1,'upload','export','Nowhere','/clips/vod/n/master.m3u8',0,0,8000,'{"zeroStart":false}'::jsonb,'ready') RETURNING id`, [acct]))!.id as string;

  // Two FAST channels: one without a ladder, one with a ladder the film is not packaged to.
  const grp = (await one<any>(`INSERT INTO groups(account_id, name) VALUES ($1,'G') RETURNING id`, [acct]))!.id;
  const prof = async (h: number, kb: number) => (await one<any>(`INSERT INTO encode_profiles(account_id,name,height,bitrate_kbps) VALUES ($1,$2,$3,$4) RETURNING id`, [acct, `${h}p-${tag}`, h, kb]))!.id;
  const LG = (await one<any>(`INSERT INTO encode_ladder_groups(account_id,name,segment_dur,fps) VALUES ($1,'HD',4,25) RETURNING id`, [acct]))!.id as string;
  for (const [i, [h, kb]] of [[1080, 6000], [720, 3000]].entries()) await query(`INSERT INTO encode_ladder_members(group_id,profile_id,ordinal) VALUES ($1,$2,$3)`, [LG, await prof(h, kb), i]);
  const CH = randomUUID(), CH2 = randomUUID();
  await query(`INSERT INTO channels(id,group_id,name,status,tz,kind,origin,fast_media) VALUES ($1,$2,'Movies','ended','UTC','tv','playlist','video')`, [CH, grp]);
  await query(`INSERT INTO channels(id,group_id,name,status,tz,kind,origin,fast_media,fast_ladder_group_id) VALUES ($1,$2,'Movies HD','ended','UTC','tv','playlist','video',$3)`, [CH2, grp, LG]);
  const slots = (ids: string[]) => JSON.stringify(ids.map((id, i) => ({ id: `s${i}`, kind: 'title', pool: [{ assetId: id }] })));
  await query(`INSERT INTO fast_lineups(channel_id,name,epoch,zone,status,slots) VALUES ($1,'Main',now(),'UTC','draft',$2::jsonb)`, [CH, slots([film.id, lost.id, none])]);
  await query(`INSERT INTO fast_lineups(channel_id,name,epoch,zone,status,slots) VALUES ($1,'Main',now(),'UTC','draft',$2::jsonb)`, [CH2, slots([film.id])]);

  console.log('== readiness: an original in the archive is not "no source" ==');
  const by = (x: any, id: string) => x.items.find((i: any) => i.assetId === id);
  let rd = await readinessWithLadder(CH);
  ok(by(rd, film.id)?.state === 'needs-prepare' && /in the archive: Prepare brings it back first/.test(by(rd, film.id).why), 'the film needs preparing, and Prepare brings the original back first', by(rd, film.id));
  ok(by(rd, none)?.state === 'no-source', 'an asset with no original anywhere is still no source', by(rd, none));
  let rd2 = await readinessWithLadder(CH2);
  ok(rd2.ladder?.groupName === 'HD' && by(rd2, film.id)?.state === 'needs-prepare' && /packaged to the channel's ladder/.test(by(rd2, film.id).why) && /archive/.test(by(rd2, film.id).why),
    "on the HD channel: not packaged to the ladder, and the original comes back first", by(rd2, film.id));

  console.log('== Prepare starts the restore, not an encode ==');
  const p1 = await prepare(CH);
  ok(p1.queued.includes(film.id) && !p1.queued.includes(none), 'the film is queued; the asset with no original is not', p1);
  const lostSkip = p1.skipped.find((x) => x.assetId === lost.id);
  ok(lostSkip && /cannot be brought back/.test(String(lostSkip.why)) && /missing/.test(String(lostSkip.why)), 'a copy that is not verified: skipped, and the reason is said', lostSkip);
  ok((await restores(lost.id)).length === 0, 'no restore for it');
  let rs = await restores(film.id);
  ok(rs.length === 1 && rs[0].state === 'queued', 'one archive.restore job for the film', rs);
  ok((await encodes(film.id)).length === 0, 'no encode yet: there is nothing to read');
  let a = await row(film.id);
  ok(a.original_restore_job_id === rs[0].id && JSON.stringify(a.original_restore_then) === JSON.stringify([{ kind: 'fast', channelId: CH }]), 'the asset keeps the restore and that the channel waits for it', a.original_restore_then);
  rd = await readinessWithLadder(CH);
  ok(by(rd, film.id)?.state === 'preparing' && /coming back from the archive/.test(by(rd, film.id).why), 'while it comes back the film reads as preparing', by(rd, film.id));
  const p2 = await prepare(CH);
  ok(!p2.queued.includes(film.id) && (await restores(film.id)).length === 1, 'a second Prepare does nothing more', p2.queued);
  const p3 = await prepare(CH2);
  rs = await restores(film.id);
  a = await row(film.id);
  ok(p3.queued.includes(film.id) && rs.length === 1 && a.original_restore_then.length === 2, 'the HD channel joins the same restore; both channels wait for it', { rs, then: a.original_restore_then });

  console.log('== an encode that finds the original gone ==');
  const encJob = (await one<any>(`INSERT INTO jobs (type, payload, priority, max_attempts, dedupe_key, state, attempts)
    VALUES ('vod.encode', $1::jsonb, 100, 2, NULL, 'running', 1) RETURNING *`, [JSON.stringify({ vodAssetId: spot.id, accountId: acct, sourcePath: spot.key, ladderGroupId: null })]))!;
  const why = await O.restoreForJob(encJob, spot.id);
  ok(/in the archive: it is being brought back/.test(String(why)), 'the encode says the original is being brought back (it said "the source file is not there")', why);
  ok((await restores(spot.id)).length === 1, 'and the restore is started');
  const why2 = await O.restoreForJob({ ...encJob, payload: { vodAssetId: lost.id, accountId: acct, sourcePath: lost.key } } as any, lost.id);
  ok(/cannot be brought back from Volt/.test(String(why2)) && /missing/.test(String(why2)), 'from a copy that is not verified: why it cannot be brought back', why2);
  ok(await O.restoreForJob(encJob, none) === null, 'an asset that never had an original in the archive: nothing to say here');
  // queueEncodeFor: an asset encoded already is not brought back.
  const okJob = (await one<any>(`INSERT INTO jobs (type, payload, state) VALUES ('vod.encode','{}'::jsonb,'succeeded') RETURNING id`))!.id;
  await query(`UPDATE vod_assets SET encode_job_id = $2 WHERE id = $1`, [later.id, okJob]);
  ok(!existsSync(later.key) && await queueEncodeFor(later.id) === okJob && (await restores(later.id)).length === 0, 'queueEncodeFor on an asset encoded already starts no restore');
  await query(`UPDATE vod_assets SET encode_job_id = NULL WHERE id = $1`, [later.id]);
  ok(await queueEncodeFor(later.id) === null && (await restores(later.id)).length === 1, 'never encoded: queueEncodeFor starts the restore and waits');

  console.log('== the asset page ==');
  r = await api('GET', `/api/vod/${film.id}`);
  const back = r.body?.original_return;
  ok(r.status === 200 && back?.restoring === true && back.targetName === 'Archive NAS', 'the asset says its original is coming back from Archive NAS', back);
  ok(Array.isArray(back?.waiting) && back.waiting.map((w: any) => w.label).sort().join('|') === 'preparing for Movies|preparing for Movies HD', 'and what waits for it', back?.waiting);
  r = await api('GET', `/api/vod/${none}`);
  ok(r.body?.original_return === null, 'an asset with no archived original: null');

  console.log('== the agent uploads the copies ==');
  const ran = await AG.archivePass(ctx);
  a = await row(film.id);
  ok(ran >= 3 && existsSync(film.key) && readFileSync(film.key).equals(film.body) && a.source_key === film.key && !a.original_removed_at, 'the film is back at its address, the same bytes', { ran, logs: logs.slice(-4) });
  ok(Array.isArray(a.original_restore_then) && a.original_restore_then.length === 0, 'the waiting list is emptied');
  const fe = await encodes(film.id);
  const enc = fe.find((j) => j.type === 'vod.encode'), lad = fe.find((j) => j.type === 'vod.ladder');
  ok(enc && enc.channel_id === CH && enc.payload.sourcePath === film.key && enc.state === 'queued', 'the Movies channel was prepared again: its encode is queued from the restored original', enc);
  ok(lad && lad.channel_id === CH2 && lad.payload.sourcePath === film.key && lad.payload.ladderGroupId === LG, 'the HD channel was prepared again: packaging to the HD ladder is queued', lad);
  rd = await readinessWithLadder(CH);
  ok(by(rd, film.id)?.state === 'preparing' && by(rd, film.id).why === 'encoding', 'the film now reads as encoding', by(rd, film.id));
  const s = await row(spot.id);
  const se = (await encodes(spot.id)).filter((j) => j.state === 'queued');
  ok(se.length === 1 && se[0].payload.sourcePath === spot.key && s.encode_job_id === se[0].id, 'the encode that found it gone is queued again with the restored address, and the asset follows it', { se, ej: s.encode_job_id });
  const le = (await encodes(later.id)).filter((j) => j.state === 'queued');
  ok(le.length === 1 && le[0].payload.sourcePath === later.key && le[0].payload.vodAssetId === later.id, "queueEncodeFor's encode is queued once the original lands", le);
  r = await api('GET', `/api/vod/${film.id}`);
  ok(r.body?.original_return === null, 'the asset page no longer shows it in the archive');

  srv.close();
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
