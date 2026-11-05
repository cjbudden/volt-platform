// ============================================================================
//  HYBRID SITES 2: on-prem watchfolders, upload to the cloud (build queue H2,
//  HYBRID_SITES.md).
//
//  Through the real API on a real database, with the agent's own watch code
//  scanning a real folder standing in for customer storage:
//    - licence off: no on-prem folder can be made and the form is not offered;
//    - creating one: its site, placement (Encode at site refused until H4),
//      a path; the site's config version moves; Scan now refused;
//    - credential scope: a pending host, another site's host and another
//      account cannot reach the folder or its uploads;
//    - a pass: a refused file moved to the review folder ON SITE and listed
//      in the console queue with its reason; an accepted video uploaded and
//      in the Media Library with its encode queued; an image target refused
//      with the reason; the quiet-file rule;
//    - rules changed between the agent's copy and the cloud's: refused;
//    - restart without re-upload: an upload cut off half way, a fresh agent
//      with no memory resumes it from the cloud's offset; one upload, no
//      second copy; later passes upload nothing;
//    - Reprocess: the agent moves the file back and it is decided again;
//      a file that can no longer be moved back returns to Needs review;
//    - the server's own scan and ingest passes leave site folders alone;
//    - `volt-agent site run` as a second process takes a new drop in.
//
//  The encode itself (ffmpeg and the packager) is the existing VOD encode,
//  checked by its own suites; here the job is checked to be queued for the
//  uploaded file.
//
//  Usage: DATABASE_URL=... npx tsx test/site-watchfolders.check.ts
// ============================================================================
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, utimesSync, mkdirSync, readFileSync, unlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };

(async () => {
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const store = await import('../src/services/watchfolder/store');
  const W = await import('../../volt-agent/src/siteWatch');
  const agentSite = await import('../../volt-agent/src/site');

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`sitewf-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`sitewf-b-${tag}`]))!.id;
  const mkUser = async (a: string, role: string, n: string) => (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x',$3,'active') RETURNING id`, [a, `${n}-${tag}@example.com`, role]))!.id;
  const owner = await mkUser(acct, 'owner', 'own');
  const ownerB = await mkUser(other, 'owner', 'ownb');
  const tok = signAccess({ sub: owner, account_id: acct, role: 'owner' } as any);
  const tokB = signAccess({ sub: ownerB, account_id: other, role: 'owner' } as any);

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: unknown, t: string | null = tok) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };
  const facts = (hostname: string) => ({ hostname, cpuCores: 8, memoryBytes: 16 * 2 ** 30, gpus: [], diskFreeBytes: 1e12, diskTotalBytes: 2e12, os: 'Linux', arch: 'x64', agentVersion: '0.3.0', encoderVersion: null });
  const enrolHost = async (siteId: string, name: string, approve: boolean, t = tok) => {
    const tk = (await api('POST', `/api/sites/${siteId}/enrolment-tokens`, {}, t)).body.token;
    const e = (await api('POST', '/api/site-agent/enrol', { token: tk, host: facts(name) }, null)).body;
    if (approve) await api('POST', `/api/sites/${siteId}/hosts/${e.hostId}/approve`, {}, t);
    return e as { hostId: string; credential: string };
  };

  console.log('== licence off ==');
  let r = await api('GET', '/api/watchfolders/site-options');
  ok(r.status === 200 && r.body.licensed === false && r.body.sites.length === 0, 'the form is told there is no Hybrid Sites licence', r.body);
  r = await api('POST', '/api/watchfolders', { name: 'Edit drop', kind: 'site', siteId: '00000000-0000-0000-0000-000000000001', config: { path: '/mnt/nas/drop' } });
  ok(r.status === 403 && r.body?.code === 'licence_required', 'an on-prem folder is refused without the licence', r);
  r = await api('POST', '/api/watchfolders', { name: 'Local still works', kind: 'local', config: { path: mkdtempSync(join(tmpdir(), 'wf-local-')) } });
  ok(r.status === 201 && r.body.kind === 'local' && r.body.site_id === null && r.body.placement === null, 'a local folder is made as before', r.body);
  const localId = r.body.id;
  await query(`UPDATE accounts SET licences = '{hybrid_sites}' WHERE id = ANY($1::uuid[])`, [[acct, other]]);

  console.log('== an on-prem folder ==');
  const site = (await api('POST', '/api/sites', { name: 'Main broadcast centre' })).body.id;
  const site2 = (await api('POST', '/api/sites', { name: 'Edit suite' })).body.id;
  const siteB = (await api('POST', '/api/sites', { name: 'Theirs' }, tokB)).body.id;
  r = await api('GET', '/api/watchfolders/site-options');
  ok(r.body.licensed === true && r.body.sites.length === 2 && r.body.placements.find((p: any) => p.placement === 'encode_site')?.available === false, 'the form lists the sites; Encode at site not yet available', r.body);
  const root = mkdtempSync(join(tmpdir(), 'site-nas-'));
  const cv0 = (await one<any>(`SELECT config_version FROM sites WHERE id = $1`, [site]))!.config_version;
  r = await api('POST', '/api/watchfolders', { name: 'NAS drop', kind: 'site', config: { path: root } });
  ok(r.status === 400, 'no site: refused', r);
  r = await api('POST', '/api/watchfolders', { name: 'NAS drop', kind: 'site', siteId: siteB, config: { path: root } });
  ok(r.status === 400, "another account's site: refused", r);
  r = await api('POST', '/api/watchfolders', { name: 'NAS drop', kind: 'site', siteId: site, config: {} });
  ok(r.status === 400, 'no path: refused', r);
  r = await api('POST', '/api/watchfolders', { name: 'NAS drop', kind: 'site', siteId: site, placement: 'encode_site', config: { path: root } });
  ok(r.status === 422 && r.body?.code === 'placement_not_available', 'Encode at site refused until site encoders', r);
  // Without the default rules by type (H2b): this suite writes its own rules,
  // and its "rules changed" case needs a .mov that no rule takes in.
  r = await api('POST', '/api/watchfolders', { name: 'NAS drop', kind: 'site', siteId: site, config: { path: root, min_age_ms: 10000 }, defaultRules: false });
  ok(r.status === 201 && r.body.kind === 'site' && r.body.site_id === site && r.body.placement === 'upload_cloud' && r.body.site_name === 'Main broadcast centre', 'created: Upload and encode in the cloud by default', r.body);
  const fid = r.body.id;
  ok((await one<any>(`SELECT config_version FROM sites WHERE id = $1`, [site]))!.config_version === cv0 + 1, "the site's config version moved");
  const addRule = (b: any) => api('POST', `/api/watchfolders/${fid}/rules`, b);
  ok((await addRule({ name: 'Video', matchType: 'extension', pattern: 'mp4', targetKind: 'vod' })).status === 201, 'rule: *.mp4 to the Media Library');
  ok((await addRule({ name: 'Project files', matchType: 'extension', pattern: 'prproj', targetKind: 'vod', action: 'reject', rejectReason: 'project files are never wanted here' })).status === 201, 'rule: project files refused');
  ok((await addRule({ name: 'Posters', matchType: 'extension', pattern: 'png', targetKind: 'poster' })).status === 201, 'rule: posters (an image target)');
  r = await api('GET', '/api/watchfolders');
  ok(r.body.find((f: any) => f.id === fid)?.site_name === 'Main broadcast centre', 'the list names the site');
  r = await api('POST', `/api/watchfolders/${fid}/scan`, {});
  ok(r.status === 409 && r.body?.code === 'scanned_at_site', 'Scan now refused: the agent scans it', r);
  r = await api('PATCH', `/api/watchfolders/${fid}`, { placement: 'encode_site' });
  ok(r.status === 422, 'placement cannot be moved to Encode at site yet', r.status);
  r = await api('PATCH', `/api/watchfolders/${localId}`, { placement: 'upload_cloud' });
  ok(r.status === 400, 'a local folder has no placement', r.status);

  console.log('== who can reach it ==');
  const h1 = await enrolHost(site, 'nas-01', true);
  const pending = await enrolHost(site, 'nas-02', false);
  const h2 = await enrolHost(site2, 'edit-01', true);
  const hB = await enrolHost(siteB, 'theirs-01', true, tokB);
  r = await api('GET', '/api/site-agent/watchfolders', undefined, pending.credential);
  ok(r.status === 403 && r.body?.code === 'waiting_for_approval', 'a host waiting for approval gets no folders', r);
  r = await api('GET', '/api/site-agent/config', undefined, pending.credential);
  ok(r.status === 200 && r.body.watchfolders.length === 0, 'and none in its config', r.body);
  r = await api('GET', '/api/site-agent/config', undefined, h1.credential);
  ok(r.body.watchfolders.length === 1 && r.body.watchfolders[0].id === fid && r.body.watchfolders[0].placement === 'upload_cloud', "an approved host's config lists the folder", r.body.watchfolders);
  r = await api('GET', '/api/site-agent/watchfolders', undefined, h1.credential);
  ok(r.status === 200 && r.body.items.length === 1 && r.body.items[0].rules.length === 3 && r.body.items[0].path === root && r.body.items[0].minAgeMs === 10000, 'the agent gets the folder with its rules, as the scanner takes it', r.body.items[0]);
  r = await api('GET', '/api/site-agent/watchfolders', undefined, h2.credential);
  ok(r.status === 200 && r.body.items.length === 0, "another site's host does not see it");
  for (const [who, cred] of [['another site', h2.credential], ['another account', hB.credential]] as const) {
    r = await api('GET', `/api/site-agent/watchfolders/${fid}/uploads`, undefined, cred);
    ok(r.status === 404, `${who}: its uploads 404`, r.status);
    r = await api('POST', `/api/site-agent/watchfolders/${fid}/items`, { objectKey: 'x.mp4', checksum: 'a'.repeat(64), sizeBytes: 1, status: 'seen' }, cred);
    ok(r.status === 404, `${who}: cannot report into it`, r.status);
  }
  r = await api('GET', `/api/site-agent/watchfolders/${fid}/uploads`, undefined, tok);
  ok(r.status === 401, 'a console session is not a host credential', r.status);
  r = await api('POST', `/api/site-agent/watchfolders/${fid}/items`, { objectKey: '../etc/passwd', checksum: 'a'.repeat(64), sizeBytes: 1, status: 'seen' }, h1.credential);
  ok(r.status === 400, 'a key outside the folder is refused', r.status);

  console.log('== a pass ==');
  const old = (Date.now() - 60_000) / 1000;
  const put = (name: string, data: Buffer | string, aged = true) => { const p = join(root, name); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, data); if (aged) utimesSync(p, old, old); return p; };
  const ff = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', join(root, 'show.mp4')]);
  const realMedia = ff.status === 0;
  if (!realMedia) { console.log('NOTE ffmpeg not here: show.mp4 is bytes, not a programme'); writeFileSync(join(root, 'show.mp4'), randomBytes(200_000)); }
  utimesSync(join(root, 'show.mp4'), old, old);
  put('cut/scene.prproj', 'project');
  put('notes.txt', 'what is this');
  put('poster.png', randomBytes(2000));
  put('late.mp4', randomBytes(50_000), false);   // still being written: quiet rule
  const mem = W.emptyMemory();
  const logs: string[] = [];
  const ctx = (m = mem, extra: Partial<Parameters<typeof W.passFolder>[0]> = {}) => ({ server: base, credential: () => h1.credential, memory: m, log: (s: string) => logs.push(s), ...extra });
  let res = await W.watchPass(ctx());
  const p1 = res[0];
  ok(res.length === 1 && !p1.error, 'one folder, one pass, no fault', p1.error);
  ok(p1.scan!.quarantined.length === 2 && existsSync(join(root, '_review', 'scene.prproj')) && existsSync(join(root, '_review', 'notes.txt')) && !existsSync(join(root, 'notes.txt')), 'refused files moved into the review folder on site', p1.scan!.quarantined.map((q) => q.quarantineKey));
  ok(p1.scan!.skippedTooNew.includes('late.mp4'), 'a file still being written is left alone (quiet-file rule)', p1.scan!.skippedTooNew);
  ok(p1.uploaded.includes('show.mp4') && p1.uploadErrors.length === 0, 'the accepted video uploaded', p1);
  r = await api('GET', `/api/watchfolders/${fid}/items?status=quarantined`);
  const q = r.body.items as any[];
  ok(q.length === 2 && q.find((i) => i.object_key === 'cut/scene.prproj')?.reason === 'project files are never wanted here' && /no rule matched/.test(q.find((i) => i.object_key === 'notes.txt')?.reason ?? ''), 'both shown in the console queue with their reasons', q.map((i) => [i.object_key, i.reason]));
  r = await api('GET', `/api/watchfolders`);
  ok(r.body.find((f: any) => f.id === fid)?.review_count === 2, 'the folder card counts them for review');
  const show = await one<any>(`SELECT * FROM watchfolder_items WHERE watchfolder_id = $1 AND object_key = 'show.mp4'`, [fid]);
  ok(show?.status === 'ingested' && show.vod_asset_id && /uploaded from the site; in the Media Library/.test(show.reason), 'the item closed as in the library', show);
  const asset = await one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [show.vod_asset_id]);
  ok(asset?.account_id === acct && asset.source_kind === 'watchfolder' && Number(asset.source_bytes) === Number(show.size_bytes) && asset.source_key && existsSync(asset.source_key), 'a Media Library record of this account, its source the uploaded file', asset && { k: asset.source_kind, key: asset.source_key });
  ok(asset && readFileSync(asset.source_key).equals(readFileSync(join(root, 'show.mp4'))), 'the bytes in the cloud are the file on site');
  const job = await one<any>(`SELECT * FROM jobs WHERE type = 'vod.encode' AND payload->>'vodAssetId' = $1`, [show.vod_asset_id]);
  ok(job && asset.encode_job_id === job.id && job.payload.sourcePath, 'its VOD encode is queued, as for any upload', job && { id: job.id, src: job.payload.sourcePath });
  const sess = await one<any>(`SELECT * FROM upload_sessions WHERE id = $1`, [show.upload_session_id]);
  ok(sess?.state === 'complete' && sess.source === fid && sess.relative_path === 'show.mp4' && sess.opened_by === null, 'one upload session, the folder as its source', sess && { state: sess.state, source: sess.source });
  const png = await one<any>(`SELECT * FROM watchfolder_items WHERE watchfolder_id = $1 AND object_key = 'poster.png'`, [fid]);
  ok(png?.status === 'failed' && /Image Library/.test(png.reason) && existsSync(join(root, 'poster.png')), 'an image target is refused with the reason, the file left where it is', png?.reason);
  const f1 = await one<any>(`SELECT last_scan_at, last_scan_error FROM watchfolders WHERE id = $1`, [fid]);
  ok(f1.last_scan_at && f1.last_scan_error === null, 'the folder shows when it was last scanned', f1);

  console.log('== the quiet file, once quiet ==');
  utimesSync(join(root, 'late.mp4'), old, old);
  res = await W.watchPass(ctx());
  ok(res[0].uploaded.length === 1 && res[0].uploaded[0] === 'late.mp4' && res[0].scan!.skippedKnown >= 2, 'taken in once quiet; known files not reported again', res[0]);
  ok((await one<any>(`SELECT status FROM watchfolder_items WHERE watchfolder_id = $1 AND object_key = 'late.mp4'`, [fid]))?.status === 'ingested', 'and in the library');

  console.log('== rules changed between the agent and the cloud ==');
  const sha = (await import('node:crypto')).createHash('sha256').update('x').digest('hex');
  r = await api('POST', `/api/site-agent/watchfolders/${fid}/items`, { objectKey: 'thing.mov', checksum: sha, sizeBytes: 1, status: 'seen' }, h1.credential);
  ok(r.status === 409 && r.body?.code === 'rules_changed', 'an acceptance the cloud\'s rules refuse is not recorded', r);
  ok(!(await one(`SELECT 1 FROM watchfolder_items WHERE watchfolder_id = $1 AND object_key = 'thing.mov'`, [fid])), 'nothing recorded for it');

  console.log('== restart without re-upload ==');
  const big = randomBytes(3 * 1024 * 1024 + 123);
  put('big.mp4', big);
  let patches = 0, sentFirst = 0;
  const cutting: typeof fetch = async (url: any, init: any) => {
    if (init?.method === 'PATCH') { if (++patches > 2) throw new Error('the line dropped'); sentFirst += init.body.length; }
    return fetch(url, init);
  };
  res = await W.watchPass(ctx(mem, { fetch: cutting, chunkBytes: 512 * 1024, retries: 0 }));
  const cut = await one<any>(`SELECT i.status, i.upload_session_id, u.received_bytes, u.state FROM watchfolder_items i JOIN upload_sessions u ON u.id = i.upload_session_id WHERE i.watchfolder_id = $1 AND i.object_key = 'big.mp4'`, [fid]);
  ok(res[0].uploadErrors.length === 1 && cut?.status === 'seen' && cut.state === 'open' && Number(cut.received_bytes) === 1024 * 1024, 'cut off after 1 MB: the item waits with its upload open', cut);
  let sentSecond = 0;
  const counting: typeof fetch = async (url: any, init: any) => { if (init?.method === 'PATCH') sentSecond += init.body.length; return fetch(url, init); };
  const fresh = W.emptyMemory();   // a new agent with no state file
  res = await W.watchPass(ctx(fresh, { fetch: counting, chunkBytes: 512 * 1024 }));
  ok(res[0].uploaded.includes('big.mp4'), 'a fresh agent finishes it', res[0]);
  ok(sentSecond === big.length - 1024 * 1024, 'resumed from the cloud\'s offset: only the missing bytes sent', { sentFirst, sentSecond, size: big.length });
  const bigItem = await one<any>(`SELECT * FROM watchfolder_items WHERE watchfolder_id = $1 AND object_key = 'big.mp4'`, [fid]);
  ok(bigItem.status === 'ingested' && bigItem.upload_session_id === cut.upload_session_id, 'the same upload, now in the library', bigItem.status);
  ok((await one<any>(`SELECT count(*)::int AS n FROM upload_sessions WHERE source = $1 AND relative_path = 'big.mp4'`, [fid]))!.n === 1, 'one upload session for it, never a second');
  const bigAsset = await one<any>(`SELECT source_key FROM vod_assets WHERE id = $1`, [bigItem.vod_asset_id]);
  ok(bigAsset && readFileSync(bigAsset.source_key).equals(big), 'the joined file is byte for byte the original');
  let sentThird = 0;
  const third: typeof fetch = async (url: any, init: any) => { if (init?.method === 'PATCH' || (init?.method === 'POST' && String(url).includes('/tus'))) sentThird++; return fetch(url, init); };
  res = await W.watchPass(ctx(W.emptyMemory(), { fetch: third }));
  ok(sentThird === 0 && res[0].uploaded.length === 0 && res[0].scan!.accepted.length === 0, 'a later pass, even with no memory, uploads nothing again', res[0]);
  const items = (await one<any>(`SELECT count(*)::int AS n FROM watchfolder_items WHERE watchfolder_id = $1`, [fid]))!.n;
  ok(items === 6, 'and adds no item', items);
  const created = await fetch(base + '/api/site-agent/tus', { method: 'POST', headers: { 'Tus-Resumable': '1.0.0', authorization: `Bearer ${h1.credential}`, 'Upload-Length': '10', 'Upload-Metadata': `itemId ${Buffer.from(String(bigItem.id)).toString('base64')}` } });
  ok(created.status === 409, 'an upload for a file already in the library is refused', created.status);
  const lateItem = await one<any>(`SELECT id FROM watchfolder_items WHERE watchfolder_id = $1 AND object_key = 'late.mp4'`, [fid]);
  const head = await fetch(base + `/api/site-agent/tus/${bigItem.upload_session_id}`, { method: 'HEAD', headers: { 'Tus-Resumable': '1.0.0', authorization: `Bearer ${h2.credential}` } });
  ok(head.status === 404, "another site's host cannot read this site's upload", head.status);
  const pend = await fetch(base + '/api/site-agent/tus', { method: 'POST', headers: { 'Tus-Resumable': '1.0.0', authorization: `Bearer ${pending.credential}`, 'Upload-Length': '10', 'Upload-Metadata': `itemId ${Buffer.from(String(lateItem.id)).toString('base64')}` } });
  ok(pend.status === 403, 'a host waiting for approval cannot upload', pend.status);

  console.log('== Reprocess ==');
  ok((await addRule({ name: 'Text', matchType: 'extension', pattern: 'txt', targetKind: 'vod', action: 'reject', rejectReason: 'text files are notes, not media' })).status === 201, 'a rule added for text files');
  const notes = q.find((i) => i.object_key === 'notes.txt');
  r = await api('POST', `/api/watchfolders/${fid}/items/${notes.id}/resolve`, { resolution: 'reprocess' });
  ok(r.status === 200 && r.body.status === 'reprocessed' && r.body.site_action === 'return' && existsSync(join(root, '_review', 'notes.txt')), 'Reprocess asks the site: nothing moved on this server', r.body);
  const scene = q.find((i) => i.object_key === 'cut/scene.prproj');
  renameSync(join(root, '_review', 'scene.prproj'), join(root, 'scene-elsewhere.bak'));   // someone tidied the review folder
  r = await api('POST', `/api/watchfolders/${fid}/items/${scene.id}/resolve`, { resolution: 'reprocess' });
  ok(r.status === 200, 'Reprocess on a file someone has moved away');
  res = await W.watchPass(ctx());
  ok(res[0].returned === 1, 'the agent moved one file back', res[0]);
  const notes2 = await one<any>(`SELECT * FROM watchfolder_items WHERE id = $1`, [notes.id]);
  ok(notes2.status === 'quarantined' && notes2.reason === 'text files are notes, not media' && notes2.site_action === null && existsSync(join(root, notes2.quarantine_key)), 'decided again with the new rule, back in review', notes2);
  const scene2 = await one<any>(`SELECT * FROM watchfolder_items WHERE id = $1`, [scene.id]);
  ok(scene2.status === 'quarantined' && /could not move it back/.test(scene2.resolution_note ?? '') && scene2.site_action === null, 'the one that could not be moved back returns to Needs review with why', scene2);

  console.log('== the server leaves site folders alone ==');
  const scans = await store.scanAllFolders();
  ok(!scans.some((x) => x.folderId === fid), "the server's scan pass does not touch a site folder");
  const ing = await store.ingestAllFolders();
  ok(!ing.some((x) => x.folderId === fid), "nor its ingest pass");
  ok((await store.loadFolder(fid)) === null, 'and its loader gives no local path for it');

  console.log('== `volt-agent site run` as a second process ==');
  const dir = mkdtempSync(join(tmpdir(), 'site-agent-'));
  const stateFile = join(dir, 'site.json');
  await agentSite.saveSiteState(stateFile, { server: base, siteId: site, hostId: h1.hostId, credential: h1.credential, status: 'approved' });
  put('evening.mp4', randomBytes(80_000));
  const tsx = join(__dirname, '..', 'node_modules', '.bin', 'tsx');
  const child = spawn(tsx, [join(__dirname, '..', '..', 'volt-agent', 'src', 'cli.ts'), 'site', 'run', stateFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const t0 = Date.now();
  let ev: any = null;
  while (Date.now() - t0 < 45_000) {
    ev = await one<any>(`SELECT status FROM watchfolder_items WHERE watchfolder_id = $1 AND object_key = 'evening.mp4'`, [fid]);
    if (ev?.status === 'ingested') break;
    await new Promise((res2) => setTimeout(res2, 500));
  }
  child.kill('SIGTERM');
  ok(ev?.status === 'ingested' && /evening\.mp4 uploaded/.test(out) && /host approved/.test(out), 'the agent process heartbeats and takes a new drop into the library', out.slice(0, 600));
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
  ok(saved.watch && Object.keys(saved.watch.sums).length > 0, 'it keeps its checksum memory in the state file');

  srv.close();
  await pool.end();
  console.log(`\nsite-watchfolders: ${pass}/${pass + fail} passed${realMedia ? '' : ' (show.mp4 was not real media here)'}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
