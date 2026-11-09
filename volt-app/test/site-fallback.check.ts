// ============================================================================
//  HYBRID SITES 5a: FALL BACK TO CLOUD ENCODING (build queue H5).
//
//  The real site agent (volt-agent siteWatch.ts) against the real API on a
//  real database. No site encoder runs, which is the point: the site's
//  servers are not taking the encode.
//    - an Encode at site folder has a fallback time: none by default (wait
//      for the site), 5 minutes to 7 days, only on an on-prem folder;
//    - with none, an encode waiting for hours stays at the site;
//    - with one, an encode waiting longer than it is cancelled at the site
//      and the asset asks for the original (why, since when, the audit log);
//      one still inside the time, or one a server is working on, stays;
//    - the agent sends the original on the resumable upload; the cloud
//      checks it is the registered file, keeps it as the asset's original and
//      queues the normal cloud encode; the original is still at the site;
//    - a file that changed or is gone fails the asset with the reason;
//    - nothing else can queue a site encode while the original is asked for;
//      an upload Volt did not ask for is refused; another site sees nothing.
//
//  Usage: DATABASE_URL=... npx tsx test/site-fallback.check.ts
// ============================================================================
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, utimesSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };

(async () => {
  const root = mkdtempSync(join(tmpdir(), 'site-fb-'));
  process.env.CLIPS_DIR = join(root, 'clips');
  process.env.VOD_STORE = 'local';
  mkdirSync(process.env.CLIPS_DIR, { recursive: true });

  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const E = await import('../src/services/sites/siteEncode');
  const F = await import('../src/services/sites/siteFallback');
  const P = await import('../src/services/ingest/pipeline');
  const Wk = await import('../../volt-agent/src/siteWatch');

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name, licences) VALUES ($1, '{hybrid_sites}') RETURNING id`, [`fb-${tag}`]))!.id;
  const owner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `fb-${tag}@example.com`]))!.id;
  const tok = signAccess({ sub: owner, account_id: acct, role: 'owner' } as any);
  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: unknown, t: string | null = tok) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let b: any = null; try { b = text ? JSON.parse(text) : null; } catch { b = text; }
    return { status: r.status, body: b };
  };
  const facts = (hostname: string) => ({ hostname, cpuCores: 8, memoryBytes: 16 * 2 ** 30, gpus: [], diskFreeBytes: 1e12, diskTotalBytes: 2e12, os: 'Linux', arch: 'x64', agentVersion: '0.11.0', encoderVersion: null });
  const enrol = async (siteId: string, name: string) => {
    const tk = (await api('POST', `/api/sites/${siteId}/enrolment-tokens`, {})).body.token;
    const e = (await api('POST', '/api/site-agent/enrol', { token: tk, host: facts(name) }, null)).body;
    await api('POST', `/api/sites/${siteId}/hosts/${e.hostId}/approve`, {});
    return e.credential as string;
  };
  const site = (await api('POST', '/api/sites', { name: 'Main broadcast centre' })).body.id;
  const site2 = (await api('POST', '/api/sites', { name: 'Edit suite' })).body.id;
  const cred = await enrol(site, 'watch-01');
  const cred2 = await enrol(site2, 'edit-01');

  console.log('== the fallback time on a folder ==');
  const drop = join(root, 'nas', 'drop'); mkdirSync(drop, { recursive: true });
  let r = await api('POST', '/api/watchfolders', { name: 'NAS encode', kind: 'site', siteId: site, placement: 'encode_site', config: { path: drop, min_age_ms: 1000 }, defaultRules: false });
  ok(r.status === 201 && r.body.fallback_minutes === null, 'a new Encode at site folder waits for the site (no fallback time)', [r.status, r.body?.fallback_minutes]);
  const fid = r.body.id;
  await api('POST', `/api/watchfolders/${fid}/rules`, { name: 'Video', matchType: 'extension', pattern: 'mp4', targetKind: 'vod' });
  r = await api('POST', '/api/watchfolders', { name: 'NAS 2', kind: 'site', siteId: site, placement: 'encode_site', fallbackMinutes: 60, config: { path: join(root, 'nas', 'two') }, defaultRules: false });
  ok(r.status === 201 && r.body.fallback_minutes === 60, 'a fallback time can be given when the folder is made', r.body?.fallback_minutes);
  r = await api('PATCH', `/api/watchfolders/${fid}`, { fallbackMinutes: 3 });
  ok(r.status === 400 && /fallbackMinutes/.test(r.body?.error ?? ''), 'under five minutes is refused', r);
  r = await api('PATCH', `/api/watchfolders/${fid}`, { fallbackMinutes: 7 * 24 * 60 + 1 });
  ok(r.status === 400, 'over seven days is refused', r.status);
  r = await api('PATCH', `/api/watchfolders/${fid}`, { fallbackMinutes: 12.5 });
  ok(r.status === 400, 'a part minute is refused', r.status);
  const local = (await api('POST', '/api/watchfolders', { name: 'Local', kind: 'local', config: { path: join(root, 'local') }, defaultRules: false })).body.id;
  r = await api('PATCH', `/api/watchfolders/${local}`, { fallbackMinutes: 30 });
  ok(r.status === 400 && /on-prem/.test(r.body?.error ?? ''), 'a local folder has no fallback time', r);

  // ---- drops ------------------------------------------------------------------------
  const old = (Date.now() - 60_000) / 1000;
  const mk = (name: string, bytes = 64 * 1024) => {
    const p = join(drop, name);
    // An MP4 by its first bytes is enough: ingest runs on the facts, and no encoder runs here.
    writeFileSync(p, Buffer.concat([Buffer.from('000000206674797069736f6d0000020069736f6d69736f32617663316d703431', 'hex'), randomBytes(bytes)]));
    utimesSync(p, old, old);
    return p;
  };
  const files = { a: mk('Evening News.mp4'), b: mk('Late Show.mp4'), c: mk('Weather.mp4'), d: mk('Sport.mp4') };
  const sumA = createHash('sha256').update(readFileSync(files.a)).digest('hex');
  const mem = Wk.emptyMemory();
  const logs: string[] = [];
  const wctx = (credential = cred) => ({ server: base, credential: () => credential, memory: mem, log: (s: string) => logs.push(s), chunkBytes: 16 * 1024 });
  const folder = (await Wk.siteFolders(wctx())).find((f) => f.id === fid)!;
  const p1 = await Wk.passFolder(wctx(), folder);
  ok(p1.registered.length === 4 && p1.fellBack.length === 0, 'four videos registered, nothing sent', [p1.registered, p1.error, p1.uploadErrors]);
  const assetOf = async (name: string) => (await one<any>(`SELECT vod_asset_id FROM watchfolder_items WHERE watchfolder_id = $1 AND object_key = $2`, [fid, name]))!.vod_asset_id as string;
  const A = await assetOf('Evening News.mp4'), B = await assetOf('Late Show.mp4'), C = await assetOf('Weather.mp4'), D = await assetOf('Sport.mp4');
  const jobOf = async (id: string) => one<any>(`SELECT j.* FROM jobs j JOIN vod_assets v ON v.encode_job_id = j.id WHERE v.id = $1`, [id]);
  const age = async (id: string, minutes: number) => query(`UPDATE jobs SET created_at = now() - make_interval(mins => $2), run_after = now() - make_interval(mins => $2) WHERE id = (SELECT encode_job_id FROM vod_assets WHERE id = $1)`, [id, minutes]);
  let jA = await jobOf(A);
  ok(jA?.type === E.SITE_VOD_PROBE && jA.state === 'queued' && jA.pool === `site:${site}`, "each encode waits in the site's pool", jA && [jA.type, jA.state, jA.pool]);

  console.log('== no fallback time: it waits for the site ==');
  for (const x of [A, B, C, D]) await age(x, 600);
  ok(await F.sweepSiteFallbacks() === 0, 'ten hours in the queue and nothing falls back');
  jA = await jobOf(A);
  const a0 = await one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [A]);
  ok(jA.state === 'queued' && !a0.ingest?.siteFallback && a0.media_state === 'processing', 'the encode is still queued at the site and the asset reads Processing', [jA.state, a0.ingest?.siteFallback]);

  console.log('== a fallback time of 15 minutes ==');
  r = await api('PATCH', `/api/watchfolders/${fid}`, { fallbackMinutes: 15 });
  ok(r.status === 200 && r.body.fallback_minutes === 15, 'the folder is set to fall back after 15 minutes', [r.status, r.body?.fallback_minutes]);
  await age(A, 10); await age(B, 20); await age(C, 20); await age(D, 20);
  // B: a server of the site is working on it, however long it has taken.
  await query(`UPDATE jobs SET state = 'running', claimed_by = 'enc-01', lease_until = now() + interval '2 minutes', attempts = 1 WHERE id = (SELECT encode_job_id FROM vod_assets WHERE id = $1)`, [B]);
  ok(await F.sweepSiteFallbacks() === 2, 'two encodes fall back: the ones waiting 20 minutes that no server took');
  jA = await jobOf(A);
  const jB = await jobOf(B);
  const jC = await jobOf(C);
  ok(jA.state === 'queued', 'one waiting 10 minutes stays at the site', jA.state);
  ok(jB.state === 'running', 'one a server of the site is encoding stays there', jB.state);
  ok(jC.state === 'cancelled' && jC.error_code === 'site_fallback' && /fell back to cloud encoding/.test(jC.last_error ?? ''), 'the waiting job is cancelled at the site, saying why', [jC.state, jC.error_code, jC.last_error]);
  let c = await one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [C]);
  const fb = c.ingest?.siteFallback;
  ok(fb?.state === 'requested' && /no server of the site "Main broadcast centre" took the encode within 15 minutes/.test(fb.reason ?? '') && fb.waitedMinutes >= 20 && fb.cancelledJobId === jC.id, 'the asset records that the original is asked for, and why', fb);
  ok(c.media_state === 'processing' && c.source_key === null, 'it still reads Processing, with no original in the cloud yet', [c.media_state, c.source_key]);
  const audit = await one<any>(`SELECT * FROM audit_log WHERE entity_type = 'vod_asset' AND entity_id = $1 AND detail->'snapshot'->'siteFallback'->>'state' = 'requested'`, [C]);
  ok(audit?.account_id === acct && audit.detail?.actor === 'Volt (cloud fallback)', 'the fallback is in the audit log', audit?.detail);
  ok(await F.sweepSiteFallbacks() === 0, 'sweeping again falls back nothing more');
  ok(await P.queueEncodeFor(C) === null && (await jobOf(C)).id === jC.id, 'while the original is asked for, nothing queues another encode at the site');

  console.log('== another site and an upload Volt did not ask for ==');
  r = await api('GET', `/api/site-agent/watchfolders/${fid}/fallbacks`, undefined, cred2);
  ok(r.status === 404, "another site's host cannot see the folder's fallbacks", r.status);
  r = await api('GET', `/api/site-agent/watchfolders/${fid}/fallbacks`, undefined, cred);
  const asked = (r.body?.items ?? []).map((i: any) => i.objectKey).sort();
  ok(r.status === 200 && JSON.stringify(asked) === JSON.stringify(['Sport.mp4', 'Weather.mp4']), 'the agent is asked for exactly the two originals', r.body);
  const aItem = await one<any>(`SELECT * FROM watchfolder_items WHERE vod_asset_id = $1`, [A]);
  const tusRes = await fetch(`${base}/api/site-agent/tus`, { method: 'POST', headers: { authorization: `Bearer ${cred}`, 'tus-resumable': '1.0.0', 'upload-length': String(aItem.size_bytes), 'upload-metadata': `itemId ${Buffer.from(String(aItem.id)).toString('base64')},fallback ${Buffer.from('1').toString('base64')}` } });
  ok(tusRes.status === 409, 'an original Volt did not ask for cannot be sent', tusRes.status);

  console.log('== the agent sends the original; the cloud encodes it ==');
  // D: the file at the site was replaced with other content of the same size.
  const dBytes = readFileSync(files.d); dBytes[100] ^= 0xff; writeFileSync(files.d, dBytes); utimesSync(files.d, old, old);
  const sumC = createHash('sha256').update(readFileSync(files.c)).digest('hex');
  logs.length = 0;
  const p2 = await Wk.passFolder(wctx(), folder);
  ok(p2.fellBack.includes('Weather.mp4') && !p2.error, 'the agent sends the original on its next pass', [p2.fellBack, p2.error, p2.uploadErrors]);
  ok(logs.some((l) => /Weather.mp4 sent to Volt to be encoded in the cloud/.test(l)), 'and says so in its log', logs);
  c = await one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [C]);
  const want = join(process.env.CLIPS_DIR!, 'vod-src', 'site', C, 'Weather.mp4');
  ok(c.source_key === want && existsSync(want) && createHash('sha256').update(readFileSync(want)).digest('hex') === sumC, 'the original is kept as the asset\'s original in the cloud, byte for byte', [c.source_key, want]);
  ok(Number(c.source_bytes) === statSync(files.c).size, 'with its size', c.source_bytes);
  const cloud = await one<any>(`SELECT * FROM jobs WHERE id = $1`, [c.encode_job_id]);
  ok(cloud?.type === 'vod.encode' && cloud.pool === null && cloud.state === 'queued' && cloud.payload.sourcePath === want, 'the normal cloud encode is queued with that original', cloud && [cloud.type, cloud.pool, cloud.payload]);
  ok(c.ingest?.siteFallback?.state === 'encoding' && c.ingest.siteFallback.cloudJobId === cloud.id && c.ingest.siteFallback.uploadedAt && /no server of the site/.test(c.ingest.siteFallback.reason), 'the asset records it is encoded in the cloud, and still says why', c.ingest?.siteFallback);
  ok(c.media_state === 'processing' && c.ingest?.siteSource?.sitePath === files.c, 'it reads Processing, and its place at the site is kept', [c.media_state, c.ingest?.siteSource]);
  ok(existsSync(files.c), 'the original is still in the folder at the site');
  const cItem = await one<any>(`SELECT * FROM watchfolder_items WHERE vod_asset_id = $1`, [C]);
  ok(/encoded in the cloud/.test(cItem.reason ?? ''), 'the folder\'s item says it was encoded in the cloud', cItem.reason);
  const sess = await one<any>(`SELECT * FROM upload_sessions WHERE id = $1`, [cItem.upload_session_id]);
  ok(sess?.state === 'complete' && sess.purpose === 'site_file' && !sess.vod_asset_id, 'the upload closed without making a second Media Library item', sess && [sess.state, sess.purpose, sess.vod_asset_id]);
  ok((await one<any>(`SELECT count(*)::int AS n FROM vod_assets WHERE account_id = $1 AND title = 'Weather'`, [acct]))!.n === 1, 'no second asset for it');
  ok(await P.queueEncodeFor(C) === cloud.id, 'asking again joins the cloud encode, not the site');
  const auditUp = await one<any>(`SELECT * FROM audit_log WHERE entity_id = $1 AND detail->'snapshot'->'siteFallback'->>'state' = 'encoding'`, [C]);
  ok(!!auditUp, 'the arrival is in the audit log too');

  console.log('== a changed file, and a file that is gone ==');
  const d = await one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [D]);
  ok(d.media_state === 'failed' && d.media_error_code === 'site_fallback_changed' && /not the file that was registered/.test(d.media_error ?? '') && d.source_key === null, 'a replaced file is not encoded: the asset fails and says why', [d.media_state, d.media_error_code, d.media_error]);
  ok(d.ingest?.siteFallback?.state === 'failed' && !existsSync(join(process.env.CLIPS_DIR!, 'vod-src', 'site', D)), 'nothing of it is kept', d.ingest?.siteFallback);
  ok(!(await one<any>(`SELECT 1 AS x FROM jobs WHERE type = 'vod.encode' AND payload->>'vodAssetId' = $1`, [D])), 'and no cloud encode is queued for it');
  // A: falls back next, and its file is gone from the folder.
  await age(A, 30);
  ok(await F.sweepSiteFallbacks() === 1, 'the third encode falls back once it has waited long enough');
  unlinkSync(files.a);
  const p3 = await Wk.passFolder(wctx(), folder);
  const a1 = await one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [A]);
  ok(p3.uploadErrors.some((x) => x.objectKey === 'Evening News.mp4' && /no longer in the folder/.test(x.error)), 'the agent reports the file is gone', p3.uploadErrors);
  ok(a1.media_state === 'failed' && a1.media_error_code === 'site_fallback_failed' && /could not send the original/.test(a1.media_error ?? '') && a1.ingest?.siteFallback?.state === 'failed', 'the asset fails with the reason the agent gave', [a1.media_state, a1.media_error]);
  r = await api('POST', `/api/site-agent/watchfolders/${fid}/fallbacks/${aItem.id}`, { ok: false, error: 'again' }, cred);
  ok(r.status === 409, 'a second report changes nothing', r.status);
  r = await api('GET', `/api/site-agent/watchfolders/${fid}/fallbacks`, undefined, cred);
  ok(r.body.items.length === 0, 'nothing is left to send', r.body.items);
  ok(sumA.length === 64 && F.fallbackMinutesOf(null) === null && F.fallbackMinutesOf(0) === null && F.fallbackMinutesOf(30) === 30, 'fallback times: none, and whole minutes');

  console.log(`\nsite-fallback: ${pass}/${pass + fail} passed`);
  srv.close();
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
