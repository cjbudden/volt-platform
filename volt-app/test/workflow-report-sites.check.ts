// ============================================================================
//  SITE STAGES ON THE WORKFLOWS MAP AND IN THE REPORT (build queue H5-2).
//
//  Work the Volt agent does on a customer's own servers was missing from the
//  Workflows page: site encodes were listed under "other jobs" by type, and
//  copy jobs (Mirror and Archive) were not counted at all, because a copy job
//  names its copy, not an asset or a stream, so no account was found for it.
//
//  Planted site and copy jobs with known outcomes, rolled up by the real
//  rollup, read back through GET /api/workflows/map and /report:
//    - map: a "Your sites" lane with Encode at site (Hybrid Sites licence) and
//      Archive copies (Mirror and Archive licence) and their arrows, only
//      for an account licensed for them; an account with neither sees the
//      three lanes and 13 stages it always did;
//    - report: Encode at site counts site.vod-probe and site.vod-encode (a
//      FAST ladder variant's job too), with its failures coded and a fallback
//      to the cloud as cancelled; Archive copies counts copies, folder
//      copies, read-backs and recordings, each under its own account;
//    - a day rolled up before the site types had a stage shows on the map;
//    - a licence taken away: the work stays in the totals under other jobs;
//    - the jobs API still does not list copy jobs (the account join is the
//      report's only).
//
//  Usage: DATABASE_URL=... npx tsx test/workflow-report-sites.check.ts
// ============================================================================
let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };

(async () => {
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const adb = await import('../src/services/qoe/analyticsDb');
  const { config } = await import('../src/config');
  const roll = await import('../src/services/workflows/rollup');
  const wmap = await import('../src/services/workflows/map');

  console.log('== the map as data ==');
  if (typeof (wmap as any).mapFor !== 'function') ok(false, 'the map takes the account\'s licences (mapFor)');
  else {
    const base = wmap.mapFor([]);
    ok(base.lanes.length === 3 && base.stages.length === 14 && base.edges.length === 13, 'no licence: the three lanes, 14 stages and 13 arrows (Subtitles and description after Encode)', [base.lanes.length, base.stages.length, base.edges.length]);
    const both = wmap.mapFor(['hybrid_sites', 'mirror_archive']);
    ok(both.lanes.map((l) => l.id).join() === 'live,post,file,site' && both.stages.length === 16, 'both licences: a fourth lane with two stages', both.lanes.map((l) => l.id));
    const hy = wmap.mapFor(['hybrid_sites']);
    ok(hy.stages.some((s) => s.id === 'siteenc') && !hy.stages.some((s) => s.id === 'archive'), 'Hybrid Sites alone: Encode at site, no copies');
    ok(hy.edges.every(([a, b]) => a !== 'archive' && b !== 'archive') && hy.edges.some(([a, b]) => a === 'rules' && b === 'siteenc') && hy.edges.some(([a, b]) => a === 'siteenc' && b === 'qc'),
      'its arrows: Ingest rules to Encode at site to QC, none to a stage it does not have');
    const ma = wmap.mapFor(['mirror_archive']);
    ok(ma.stages.some((s) => s.id === 'archive') && !ma.stages.some((s) => s.id === 'siteenc'), 'Mirror and Archive alone: copies, no site encode');
    ok(ma.edges.filter(([, y]) => y === 'archive').map(([x]) => x).join() === 'publish' && ma.edges.length === 14, 'one arrow into the copies, from Publish (ingest, schedule and recordings are in its description)');
    ok(/ingested/.test(ma.stages.find((s) => s.id === 'archive')!.description) && /recordings close/.test(ma.stages.find((s) => s.id === 'archive')!.description), 'its description names the other moments a copy is made');
    const ids = new Set(both.stages.map((s) => s.id));
    ok(wmap.EDGES.every(([a, b]) => ids.has(a) && ids.has(b)), 'every arrow joins two stages that exist');
    ok(Object.values(wmap.JOB_STAGES).every((s) => ids.has(s)), 'every job type is mapped to a stage that exists');
  }

  const aname = new URL(adb.analyticsUrl()).pathname.slice(1);
  {
    const { Client } = await import('pg'); const u = new URL(config.databaseUrl); u.pathname = '/postgres';
    const c = new Client({ connectionString: u.toString() }); await c.connect(); await c.query(`DROP DATABASE IF EXISTS "${aname}" WITH (FORCE)`); await c.end();
  }

  const tag = Date.now().toString(36);
  const mkAcct = async (n: string, lic: string[]) => (await one<any>(`INSERT INTO accounts(name, licences) VALUES ($1, $2) RETURNING id`, [`${n}-${tag}`, lic]))!.id;
  const acct = await mkAcct('wfs', ['hybrid_sites', 'mirror_archive']);
  const other = await mkAcct('wfs-b', ['mirror_archive']);
  const plain = await mkAcct('wfs-c', []);
  const user = async (a: string, n: string) => (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `${n}-${tag}@example.com`]))!.id;
  const tok = signAccess({ sub: await user(acct, 'wfs'), account_id: acct, role: 'owner' } as any);
  const tokB = signAccess({ sub: await user(other, 'wfs-b'), account_id: other, role: 'owner' } as any);
  const tokC = signAccess({ sub: await user(plain, 'wfs-c'), account_id: plain, role: 'owner' } as any);
  const chan = async (a: string) => {
    const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [a]))!.id;
    const grp = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [a, prof]))!.id;
    return (await one<any>(`INSERT INTO channels(group_id, name, status) VALUES ($1,'Food','ended') RETURNING id`, [grp]))!.id;
  };
  const ch = await chan(acct);
  const asset = async (a: string, title: string) => (await one<any>(
    `INSERT INTO vod_assets (account_id, source_kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms) VALUES ($1,'upload',$2,'/x',0,0,1) RETURNING id`, [a, title]))!.id;
  const film = await asset(acct, 'Harbour');
  // One copy row per asset and kind of copy, so each planted copy gets an asset of its own.
  const copyOf = async (a: string) => {
    const site = (await one<any>(`INSERT INTO sites (account_id, name) VALUES ($1, 'Studio') RETURNING id`, [a]))!.id;
    const target = (await one<any>(`INSERT INTO archive_targets (account_id, site_id, name, path) VALUES ($1,$2,'NAS','/mnt/nas') RETURNING id`, [a, site]))!.id;
    return async () => (await one<any>(`INSERT INTO archive_copies (account_id, target_id, vod_asset_id, source_uri, file_name) VALUES ($1,$2,$3,'file:///x','x.mov') RETURNING id`,
      [a, target, await asset(a, 'Pier')]))!.id;
  };
  const newCopy = await copyOf(acct);
  const newCopyB = await copyOf(other);

  const MIN = 60_000, DAY = 86_400_000;
  const now = Date.now();
  const base = Math.floor(now / MIN) * MIN - 3 * 3600_000;
  const iso = (t: number) => new Date(t).toISOString();
  const job = (type: string, state: string, startAt: number, runMs: number, payload: any, o: { attempts?: number; code?: string | null; channel?: string | null } = {}) =>
    query(`INSERT INTO jobs (type, state, channel_id, payload, pool, attempts, max_attempts, error_code, created_at, started_at, finished_at)
           VALUES ($1,$2::job_state,$3,$4::jsonb,'site:x',$5,5,$6,$7,$8,$9) RETURNING id`,
      [type, state, o.channel ?? null, JSON.stringify(payload), o.attempts ?? 1, o.code ?? null, iso(startAt - 1000), iso(startAt),
       state === 'queued' || state === 'running' ? null : iso(startAt + runMs)]);

  // Encode at site: two probes, three encodes (one failed for a share not
  // mounted after three attempts, one cancelled by the fallback to the cloud)
  // and a FAST ladder variant's encode, which names its channel.
  const p = { vodAssetId: film, accountId: acct };
  await job('site.vod-probe', 'succeeded', base + 1 * MIN, 2000, p);
  await job('site.vod-probe', 'succeeded', base + 2 * MIN, 4000, p);
  await job('site.vod-encode', 'succeeded', base + 3 * MIN, 60_000, p);
  await job('site.vod-encode', 'failed', base + 5 * MIN, 1000, p, { attempts: 3, code: 'source_unavailable' });
  await job('site.vod-encode', 'cancelled', base + 6 * MIN, 0, p);
  await job('site.vod-encode', 'succeeded', base + 7 * MIN, 30_000, { ...p, variant: { channelId: ch } }, { channel: ch });
  await job('site.vod-encode', 'running', base + 8 * MIN, 0, p);
  // Archive copies: copy jobs name only their copy.
  const c1 = await newCopy(), c2 = await newCopy(), c3 = await newCopy();
  await job('archive.copy', 'succeeded', base + 10 * MIN, 5000, { copyId: c1 });
  await job('archive.copy', 'failed', base + 11 * MIN, 5000, { copyId: c2 }, { attempts: 2, code: 'checksum_mismatch' });
  await job('archive.copy-folder', 'succeeded', base + 12 * MIN, 20_000, { copyId: c3 });
  await job('archive.verify', 'succeeded', base + 13 * MIN, 1000, { copyId: c1 });
  await job('archive.verify-folder', 'failed', base + 14 * MIN, 1000, { copyId: c3 }, { code: 'corrupt' });
  await job('archive.recording', 'succeeded', base + 15 * MIN, 8000, { accountId: acct }, { channel: ch });
  // Another account's copies are its own, and a copy id that is not an id is no account at all.
  await job('archive.copy', 'succeeded', base + 16 * MIN, 5000, { copyId: await newCopyB() });
  await job('archive.copy', 'succeeded', base + 17 * MIN, 5000, { copyId: await newCopyB() });
  await job('archive.copy', 'succeeded', base + 18 * MIN, 5000, { copyId: 'not-an-id' });

  console.log('== the rollup ==');
  for (let i = 0; i < 40; i++) {
    await roll.rollupPass(now);
    if (roll.rollupStats.lastTo && new Date(roll.rollupStats.lastTo).getTime() >= Math.floor(now / MIN) * MIN - 60_000) break;
  }
  const ap = await adb.analyticsPool();
  const kinds = async (a: string) => Object.fromEntries((await ap.query(`SELECT kind, stage, sum(runs)::int n FROM wf_days WHERE account_id = $1 GROUP BY 1, 2`, [a])).rows.map((r: any) => [r.kind, r]));
  const ka = await kinds(acct);
  ok(ka['site.vod-encode']?.n === 4 && ka['site.vod-encode']?.stage === 'siteenc', 'site encodes rolled up under Encode at site (the running one not yet)', ka['site.vod-encode']);
  ok(ka['archive.copy']?.n === 2 && ka['archive.copy']?.stage === 'archive', 'copy jobs now found their account through the copy (they were never counted)', ka['archive.copy']);
  ok((await kinds(other))['archive.copy']?.n === 2, "another account's copies under that account");
  const orphan = (await ap.query(`SELECT sum(runs)::int n FROM wf_days WHERE kind = 'archive.copy' AND account_id <> ALL($1::uuid[])`, [[acct, other]])).rows[0];
  ok(!orphan.n, 'a copy job whose copy id is not an id belongs to no account and is not counted', orphan);

  // A day rolled up before this change: site encodes then had no stage.
  const older = new Date(Math.floor(now / DAY) * DAY - 20 * DAY).toISOString().slice(0, 10);
  await ap.query(`INSERT INTO wf_days (account_id, day, source, kind, hook, stage, runs, succeeded, failed) VALUES ($1,$2,'job','site.vod-encode','','',5,5,0)`, [acct, older]);

  const srv = createServer().listen(0);
  const baseUrl = `http://127.0.0.1:${(srv.address() as any).port}`;
  const get = async (path: string, t = tok) => { const r = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${t}` } }); return { status: r.status, body: await r.json().catch(() => null) as any }; };

  console.log('== the map ==');
  const m = await get('/api/workflows/map');
  ok(m.status === 200 && m.body.lanes.map((l: any) => l.id).join() === 'live,post,file,site', 'licensed for both: the Your sites lane', m.body?.lanes);
  const siteenc = m.body.stages.find((s: any) => s.id === 'siteenc'), arch = m.body.stages.find((s: any) => s.id === 'archive');
  ok(siteenc?.lane === 'site' && siteenc.label === 'Encode at site' && arch?.lane === 'site' && arch.label === 'Archive copies', 'with Encode at site and Archive copies', [siteenc, arch]);
  ok(!('impl' in siteenc) && m.body.edges.some(([a, b]: string[]) => a === 'publish' && b === 'archive'), 'no source file names in the API; the arrows come with them');
  const mb = await get('/api/workflows/map', tokB);
  ok(mb.body.lanes.length === 4 && mb.body.stages.length === 15 && !mb.body.stages.some((s: any) => s.id === 'siteenc'), 'Mirror and Archive only: the lane with copies, no site encode', mb.body.stages.length);
  const mc = await get('/api/workflows/map', tokC);
  ok(mc.body.lanes.length === 3 && mc.body.stages.length === 14 && mc.body.edges.length === 13, 'no licence: the map as it always was', [mc.body.lanes.length, mc.body.stages.length, mc.body.edges.length]);

  console.log('== the report ==');
  const r7 = await get('/api/workflows/report?range=7d');
  const st = (r: any, id: string) => r.body.stages.find((s: any) => s.id === id);
  const se = st(r7, 'siteenc');
  ok(se && se.fedBy === 'jobs' && se.lane === 'site', 'Encode at site is fed by its jobs, in the Your sites lane', se);
  ok(se.runs === 6 && se.succeeded === 4 && se.failed === 1 && se.cancelled === 1, 'Encode at site: 2 probes and 4 encodes finished (a ladder variant included), 1 failed, the fallback cancelled', se);
  ok(se.retries === 2 && se.topCodes[0]?.code === 'source_unavailable', 'its retries and its code: the share was not mounted', se);
  const ar = st(r7, 'archive');
  ok(ar && ar.runs === 6 && ar.failed === 2 && ar.retries === 1, 'Archive copies: copies, a folder copy, two read-backs and a recording, two failed', ar);
  ok(JSON.stringify(ar.topCodes.map((c: any) => c.code).sort()) === JSON.stringify(['checksum_mismatch', 'corrupt']), 'its codes: a copy that did not match, a read-back that found it changed', ar.topCodes);
  ok(!r7.body.otherJobs.some((o: any) => /^(site|archive)\./.test(o.type)), 'site and copy jobs no longer under other jobs', r7.body.otherJobs);
  const today = new Date(base).toISOString().slice(0, 10);
  const lane = r7.body.series.find((s: any) => s.lane === 'site' && s.t.startsWith(today));
  ok(lane && lane.runs === 12 && lane.failed === 3, 'per lane per day: the Your sites lane, 12 runs, 3 failed', lane);
  ok(r7.body.lanes.length === 4 && r7.body.stages.length === 16, 'the report has the same lanes and stages as this account\'s map');
  ok(r7.body.totals.runs === 12 && r7.body.totals.failed === 3, 'totals include the site work', r7.body.totals);
  const r30 = await get('/api/workflows/report?range=30d');
  ok(st(r30, 'siteenc').runs === 11, 'a day rolled up before site encodes had a stage is counted on the stage now (6 + 5)', st(r30, 'siteenc').runs);

  const rb = await get('/api/workflows/report?range=7d', tokB);
  ok(st(rb, 'archive').runs === 2 && !st(rb, 'siteenc'), 'another account: its own two copies, and no site encode stage', st(rb, 'archive'));

  console.log('== a licence taken away ==');
  await query(`UPDATE accounts SET licences = '{}' WHERE id = $1`, [acct]);
  const rx = await get('/api/workflows/report?range=7d');
  ok(rx.body.lanes.length === 3 && !st(rx, 'siteenc') && !st(rx, 'archive'), 'the site stages are gone from the report');
  const oj = Object.fromEntries(rx.body.otherJobs.map((o: any) => [o.type, o.runs]));
  ok(oj['site.vod-encode'] === 4 && oj['site.vod-probe'] === 2 && oj['archive.copy'] === 2 && oj['archive.recording'] === 1, 'their work is listed under other jobs instead, nothing lost', oj);
  ok(!rx.body.series.some((s: any) => s.lane === 'site'), 'no series for a lane it does not see');
  ok((await get('/api/workflows/map')).body.lanes.length === 3, 'and the map is back to three lanes');

  console.log('== the jobs API is unchanged ==');
  const jl = await get('/api/jobs?limit=100');
  ok(jl.status === 200 && !jl.body.jobs.items?.some?.((j: any) => j.type === 'archive.copy') && !(jl.body.jobs.data ?? jl.body.jobs ?? []).some?.((j: any) => j.type === 'archive.copy'),
    'copy jobs are still not listed by GET /api/jobs (the join is the report\'s only)', jl.status);
  ok((await fetch(`${baseUrl}/api/workflows/map`)).status === 401, 'signed in only');

  srv.close();
  await adb.closeAnalytics();
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
