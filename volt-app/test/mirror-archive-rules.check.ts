// ============================================================================
//  MIRROR AND ARCHIVE: copy rules and scheduled re-checks (build queue H3-3,
//  HYBRID_SITES.md "Add-on: Mirror and Archive to external storage").
//
//  Through the real API on a real database, with the REAL site agent code
//  (volt-agent/src/siteArchive.ts) writing into a folder that stands in for
//  the customer's NAS:
//    - the off-peak window (pure): inside, before, over midnight, in a zone;
//    - copy rules in the publishing ladder: refused without the licence,
//      refused for another account's target or the same target twice, an
//      empty list always allowed, a bad zone refused;
//    - on ingest: an original is copied to the targets its rule names for
//      ingest, nothing for publish-only rules, once only; an asset's own
//      rung can switch copies off; a disabled target is skipped with why;
//      without the licence nothing is queued even with a rule in place;
//    - on publish: publishing the asset queues the publish copy;
//    - the off-peak window holds the job back until it opens;
//    - storage targets carry recheckDays (30 by default, null for never);
//    - scheduled re-checks: a verified copy older than its target's cadence
//      gets one check, read back by the agent; a fresh one, a never-recheck
//      target, a disabled target, a corrupt copy and an unlicensed account
//      get none; a copy changed at the NAS is found corrupt by the pass.
//
//  Usage: DATABASE_URL=... npx tsx test/mirror-archive-rules.check.ts
// ============================================================================
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

(async () => {
  const A = await import('../src/services/archive/archive');
  const AG = await import('../../volt-agent/src/siteArchive');

  console.log('== the off-peak window (pure) ==');
  const at = (iso: string) => new Date(iso);
  ok(A.offPeakStart(at('2026-11-06T23:30:00Z'), { from: '22:00', to: '06:00' }) === null, 'inside a window over midnight: start now');
  ok(A.offPeakStart(at('2026-11-06T03:00:00Z'), { from: '22:00', to: '06:00' }) === null, 'and after midnight, still inside');
  ok(A.offPeakStart(at('2026-11-06T12:15:00Z'), { from: '22:00', to: '06:00' })?.toISOString() === '2026-11-06T22:00:00.000Z', 'outside: held until the window opens', A.offPeakStart(at('2026-11-06T12:15:00Z'), { from: '22:00', to: '06:00' }));
  ok(A.offPeakStart(at('2026-11-06T06:00:00Z'), { from: '22:00', to: '06:00' })?.toISOString() === '2026-11-06T22:00:00.000Z', 'the end of the window is outside it');
  ok(A.offPeakStart(at('2026-11-06T09:00:00Z'), { from: '01:00', to: '05:00' })?.toISOString() === '2026-11-07T01:00:00.000Z', 'a window that has passed today opens tomorrow');
  ok(A.offPeakStart(at('2026-07-01T12:00:00Z'), { from: '22:00', to: '06:00', timeZone: 'Europe/London' })?.toISOString() === '2026-07-01T21:00:00.000Z', 'in the given zone (22:00 London summer time is 21:00 UTC)', A.offPeakStart(at('2026-07-01T12:00:00Z'), { from: '22:00', to: '06:00', timeZone: 'Europe/London' }));
  ok(A.offPeakStart(at('2026-11-06T12:00:00Z'), { from: '02:00', to: '02:00' }) === null && A.offPeakStart(at('2026-11-06T12:00:00Z'), null) === null, 'equal ends or no window: start now');

  process.env.CLIPS_DIR ||= mkdtempSync(join(tmpdir(), 'mar-clips-'));
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');

  const tag = Date.now().toString(36);
  const mkAcct = async (n: string, lic: string[]) => (await one<any>(`INSERT INTO accounts(name, licences) VALUES ($1, $2) RETURNING id`, [`${n}-${tag}`, lic]))!.id;
  const acct = await mkAcct('mar', ['mirror_archive']);
  const none = await mkAcct('mno', []);
  const other = await mkAcct('mot', ['mirror_archive']);
  const tokFor = async (a: string, n: string) => {
    const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `${n}-${tag}@example.com`]))!.id;
    return signAccess({ sub: u, account_id: a, role: 'owner' } as any);
  };
  const tok = await tokFor(acct, 'own'), tokN = await tokFor(none, 'none'), tokO = await tokFor(other, 'oth');

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: unknown, t: string | null = tok) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let b: any = null; try { b = text ? JSON.parse(text) : null; } catch { b = text; }
    return { status: r.status, body: b };
  };
  const facts = (hostname: string) => ({ hostname, cpuCores: 4, memoryBytes: 8 * 2 ** 30, diskFreeBytes: 1e12, diskTotalBytes: 2e12, os: 'Linux', arch: 'x64', agentVersion: '0.5.0' });
  const host = async (siteId: string, name: string, t: string) => {
    const tk = await api('POST', `/api/sites/${siteId}/enrolment-tokens`, {}, t);
    const e = await api('POST', '/api/site-agent/enrol', { token: tk.body.token, host: facts(name) }, null);
    await api('POST', `/api/sites/${siteId}/hosts/${e.body.hostId}/approve`, {}, t);
    return { id: e.body.hostId as string, cred: e.body.credential as string };
  };

  const site = (await api('POST', '/api/sites', { name: 'NAS room' })).body.id;
  const h = await host(site, 'nas-01', tok);
  const nas = mkdtempSync(join(tmpdir(), 'mar-nas-'));
  const nas2 = mkdtempSync(join(tmpdir(), 'mar-nas2-'));

  console.log('== storage targets: re-check cadence ==');
  let r = await api('POST', '/api/archive/targets', { name: 'Archive NAS', siteId: site, path: nas });
  ok(r.status === 201 && r.body.recheckDays === 30, 'a new target re-checks every 30 days by default', r.body);
  const target = r.body.id;
  r = await api('POST', '/api/archive/targets', { name: 'Second NAS', siteId: site, path: nas2, recheckDays: null });
  ok(r.status === 201 && r.body.recheckDays === null, 'or never, on a schedule', r.body);
  const target2 = r.body.id;
  r = await api('PATCH', `/api/archive/targets/${target}`, { recheckDays: 0 });
  ok(r.status === 400, 'a cadence of 0 days is refused', r.status);
  r = await api('PATCH', `/api/archive/targets/${target}`, { recheckDays: 7 });
  ok(r.status === 200 && r.body.recheckDays === 7 && r.body.changed.includes('recheckDays'), 'the cadence can be changed', r.body);
  const otherSite = (await api('POST', '/api/sites', { name: 'Theirs' }, tokO)).body.id;
  const theirTarget = (await api('POST', '/api/archive/targets', { name: 'Their NAS', siteId: otherSite, path: nas }, tokO)).body.id;

  console.log('== copy rules in the publishing ladder ==');
  r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: target, on: ['ingest'] }] } } }, tokN);
  ok(r.status === 403 && r.body?.code === 'licence_required', 'without Mirror and Archive a copy rule is refused', r);
  r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [] } } }, tokN);
  ok(r.status === 200, 'but saying "no copies" is always allowed', r.status);
  r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: theirTarget, on: ['ingest'] }] } } });
  ok(r.status === 400, "another account's target is refused", r);
  r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: target, on: ['ingest'] }, { targetId: target, on: ['publish'] }] } } });
  ok(r.status === 400, 'the same target twice is refused', r.status);
  r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: target, on: [] }] } } });
  ok(r.status === 422, 'a copy needs at least one moment (schema check, 422)', r.status);
  r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: target, on: ['ingest'] }], offPeak: { from: '22:00', to: '06:00', timeZone: 'Mars/Olympus' } } } });
  ok(r.status === 400, 'an unknown time zone is refused', r.status);
  r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: target, on: ['ingest'] }, { targetId: target2, on: ['publish'] }] } } });
  ok(r.status === 200 && r.body.settings.archive.copies.length === 2, 'a rule with two targets is saved', r.body);

  console.log('== on ingest ==');
  const srcDir = join(process.env.CLIPS_DIR!, 'vod-src');
  mkdirSync(srcDir, { recursive: true });
  const mkAsset = async (a: string, file: string, body: Buffer) => {
    const key = join(srcDir, file); writeFileSync(key, body);
    return (await one<any>(`INSERT INTO vod_assets (account_id, source_kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, source_key, sha256)
      VALUES ($1,'upload',$2,'/x',0,0,1,$3,$4) RETURNING id`, [a, file, key, sha(body)]))!.id as string;
  };
  const bytes1 = randomBytes(200_000);
  const asset1 = await mkAsset(acct, `Rule One ${tag}.mp4`, bytes1);
  const now = new Date();
  let out = await A.copyOnRule(acct, asset1, 'ingest', now);
  ok(out.queued.length === 1 && out.skipped.length === 0, 'an ingested original is copied to the target its rule names for ingest', out);
  const copy1 = out.queued[0];
  let row = await one<any>(`SELECT c.target_id, j.pool, j.type, j.run_after FROM archive_copies c JOIN jobs j ON j.id = c.job_id WHERE c.id = $1`, [copy1]);
  ok(row.target_id === target && row.pool === `site:${site}` && row.type === 'archive.copy' && new Date(row.run_after).getTime() <= Date.now() + 1000, 'as an archive job in the site\'s pool, to start now', row);
  out = await A.copyOnRule(acct, asset1, 'ingest', now);
  ok(out.queued.length === 0 && out.skipped[0]?.why === 'already_copied_or_queued', 'a second ingest of the same asset queues nothing more', out);
  ok((await one<any>(`SELECT count(*)::int AS n FROM archive_copies WHERE vod_asset_id = $1 AND target_id = $2`, [asset1, target2])).n === 0, 'the publish-only target is not copied on ingest');

  const ctx = { server: base, credential: () => h.cred, log: (_s: string) => {}, progressEveryMs: 50 };
  let ran = await AG.archivePass(ctx);
  let c = (await api('GET', `/api/archive/copies/${copy1}`)).body;
  ok(ran === 1 && c.state === 'verified' && existsSync(join(nas, c.storedPath)) && readFileSync(join(nas, c.storedPath)).equals(bytes1), 'the agent copies it and it is verified', { ran, c });

  // The asset's own rung switches copies off for it alone.
  const asset2 = await mkAsset(acct, `Rule Two ${tag}.mp4`, randomBytes(1000));
  await query(`UPDATE vod_assets SET availability_override = $2::jsonb WHERE id = $1`, [asset2, JSON.stringify({ archive: { copies: [] } })]);
  out = await A.copyOnRule(acct, asset2, 'ingest', now);
  ok(out.queued.length === 0 && out.skipped.length === 0, 'an asset whose own rung says no copies is not copied', out);
  r = await api('PATCH', `/api/vod/${asset2}/availability`, { override: { archive: { copies: [{ targetId: theirTarget, on: ['ingest'] }] } } });
  ok(r.status === 400, "an asset's own rung is checked the same way (another account's target refused)", r.status);

  // A disabled target is skipped, with why.
  await api('PATCH', `/api/archive/targets/${target}`, { status: 'disabled' });
  const asset3 = await mkAsset(acct, `Rule Three ${tag}.mp4`, randomBytes(1000));
  out = await A.copyOnRule(acct, asset3, 'ingest', now);
  ok(out.queued.length === 0 && out.skipped[0]?.why === 'target_disabled', 'a disabled target is skipped and says why', out);
  await api('PATCH', `/api/archive/targets/${target}`, { status: 'active' });

  // Without the licence a rule already in the database does nothing.
  const tN = await one<any>(`INSERT INTO sites (account_id, name) VALUES ($1, 'x') RETURNING id`, [none]);
  const targN = await one<any>(`INSERT INTO archive_targets (account_id, site_id, name, path) VALUES ($1,$2,'n','/mnt/n') RETURNING id`, [none, tN.id]);
  await query(`UPDATE publishing_rules SET settings = $2::jsonb WHERE account_id = $1 AND scope_kind = 'account'`, [none, JSON.stringify({ archive: { copies: [{ targetId: targN.id, on: ['ingest'] }] } })]);
  const assetN = await mkAsset(none, `None ${tag}.mp4`, randomBytes(1000));
  out = await A.copyOnRule(none, assetN, 'ingest', now);
  ok(out.queued.length === 0 && (await one<any>(`SELECT count(*)::int AS n FROM archive_copies WHERE account_id = $1`, [none])).n === 0, 'without the licence nothing is queued, even with a rule in place', out);

  console.log('== on publish ==');
  const { publish } = await import('../src/services/availability');
  let pubErr: any = null;
  try { await publish(asset1, 'test'); } catch (e: any) { pubErr = e; }
  const pubCopy = await one<any>(`SELECT * FROM archive_copies WHERE vod_asset_id = $1 AND target_id = $2`, [asset1, target2]);
  ok(!pubErr && pubCopy?.state === 'queued', 'publishing the asset copies it to the publish target', pubErr?.message ?? pubCopy);
  ran = await AG.archivePass(ctx);
  ok(ran === 1 && (await one<any>(`SELECT state FROM archive_copies WHERE id = $1`, [pubCopy?.id])).state === 'verified', 'and the agent makes that copy too', ran);

  console.log('== the off-peak window holds the job ==');
  const wnd = { from: '00:00', to: '00:01', timeZone: 'UTC' };
  r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: target, on: ['ingest'] }], offPeak: wnd } } });
  ok(r.status === 200 && r.body.settings.archive.offPeak.from === '00:00', 'a rule with an off-peak window is saved', r.body);
  const asset4 = await mkAsset(acct, `Rule Four ${tag}.mp4`, randomBytes(5000));
  const noon = at(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`);
  out = await A.copyOnRule(acct, asset4, 'ingest', noon);
  row = await one<any>(`SELECT j.id, j.run_after FROM archive_copies c JOIN jobs j ON j.id = c.job_id WHERE c.id = $1`, [out.queued[0]]);
  ok(out.queued.length === 1 && new Date(row.run_after).toISOString() === A.offPeakStart(noon, wnd)!.toISOString(), 'outside the window the copy is queued to start when it opens', { out, row });
  if (new Date(row.run_after).getTime() > Date.now() + 60_000) {
    r = await api('POST', '/api/site-agent/jobs/lease', { types: ['archive.copy'] }, h.cred);
    ok(r.status === 204, 'and the agent is not given it before then', r.status);
  } else ok(true, 'and the agent is not given it before then (window opens within a minute: lease not asked)');
  await query(`UPDATE jobs SET run_after = now() WHERE id = $1`, [row.id]);
  ran = await AG.archivePass(ctx);
  ok(ran === 1, 'once the window is open the agent takes it', ran);

  console.log('== scheduled re-checks ==');
  const backdate = (id: string, days: number) => query(`UPDATE archive_copies SET checked_at = now() - make_interval(days => $2), verified_at = now() - make_interval(days => $2) WHERE id = $1`, [id, days]);
  await api('PATCH', `/api/archive/targets/${target}`, { recheckDays: 30 });
  await backdate(copy1, 31);
  let rc = await A.recheckDue({ accountId: acct });
  const v1 = await one<any>(`SELECT j.type, j.pool, j.state FROM archive_copies c JOIN jobs j ON j.id = c.verify_job_id WHERE c.id = $1`, [copy1]);
  ok(rc.queued === 1 && v1?.type === 'archive.verify' && v1.pool === `site:${site}`, 'a verified copy past its target\'s cadence gets one re-check in the site\'s pool', { rc, v1 });
  rc = await A.recheckDue({ accountId: acct });
  ok(rc.queued === 0, 'while that check is waiting, the next pass queues no other', rc);
  ran = await AG.archivePass(ctx);
  c = (await api('GET', `/api/archive/copies/${copy1}`)).body;
  ok(ran === 1 && c.state === 'verified' && Date.now() - Date.parse(c.checkedAt) < 60_000, 'the agent reads it back and the copy is confirmed again today', { ran, c });
  rc = await A.recheckDue({ accountId: acct });
  ok(rc.queued === 0, 'a copy just checked is not checked again', rc);

  await backdate(copy1, 10);
  ok((await A.recheckDue({ accountId: acct })).queued === 0, 'a copy checked inside the cadence is left alone');
  await backdate(pubCopy!.id, 400);
  ok((await A.recheckDue({ accountId: acct })).queued === 0, 'a target with no scheduled re-checks is left alone however old');

  await backdate(copy1, 31);
  await api('PATCH', `/api/archive/targets/${target}`, { status: 'disabled' });
  ok((await A.recheckDue({ accountId: acct })).queued === 0, 'a disabled target is not re-checked');
  await api('PATCH', `/api/archive/targets/${target}`, { status: 'active' });
  await query(`UPDATE accounts SET licences = '{}' WHERE id = $1`, [acct]);
  ok((await A.recheckDue({ accountId: acct })).queued === 0, 'without the licence nothing is re-checked');
  await query(`UPDATE accounts SET licences = '{mirror_archive}' WHERE id = $1`, [acct]);

  // Someone edits the file on the NAS; the next scheduled check finds it.
  writeFileSync(join(nas, c.storedPath), randomBytes(200_000));
  rc = await A.recheckDue({ accountId: acct });
  ran = await AG.archivePass(ctx);
  c = (await api('GET', `/api/archive/copies/${copy1}`)).body;
  ok(rc.queued >= 1 && c.state === 'corrupt' && c.errorCode === 'checksum_mismatch', 'a copy changed at the NAS is found corrupt by the scheduled check', { rc, ran, c });
  await backdate(copy1, 60);
  ok((await A.recheckDue({ accountId: acct })).queued === 0, 'a corrupt copy is not re-checked again (it needs copying again)');

  console.log('== hooks are wired ==');
  const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
  ok(/copyOnRule\(f\.accountId, f\.assetId, 'ingest'\)/.test(src('src/services/ingest/pipeline.ts')), 'ingest calls the copy rules');
  ok(/recheckDue\(\)/.test(src('src/services/orchestrator/index.ts')), 'the scheduler runs the re-check pass');

  srv.close();
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
