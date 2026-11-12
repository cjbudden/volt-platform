// ============================================================================
//  THE WORKFLOW REPORT (build queue W1, WORKFLOWS.md "The report").
//
//  Planted jobs, hook events and add-on runs with known times and outcomes,
//  rolled up by the real rollup into the analytics database, then read back
//  through GET /api/workflows/report:
//    - per stage: runs, succeeded, failed, cancelled, error rate, retries,
//      p50 and p95 time and wait (within the sketch's 1 %), top error codes;
//    - stages with no jobs of their own report their hook events (a stream
//      stopped for a fault is a failure; recordings carry their duration);
//    - job types no stage claims listed apart; add-on delivery jobs never
//      counted twice; queued and running work not counted;
//    - add-on runs per add-on and hook, timed out as a failure, a retry
//      counted, a hand run under 'manual';
//    - error rate per lane per day and per hour;
//    - 7 days against 30 days; another account sees none of it;
//    - the backfill and a second pass give the same rows (idempotent);
//    - the worker stores a code with a failure that brought none.
//
//  Usage: DATABASE_URL=... npx tsx test/workflow-report.check.ts
// ============================================================================
let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };
const near = (a: number | null | undefined, b: number, rel = 0.011) => a != null && Math.abs(a - b) <= b * rel + 1;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const adb = await import('../src/services/qoe/analyticsDb');
  const { config } = await import('../src/config');
  const ec = await import('../src/services/jobs/errorCode');
  const roll = await import('../src/services/workflows/rollup');

  console.log('== error codes ==');
  ok(ec.errorCodeOf(Object.assign(new Error('x'), { code: 'ENOENT' })) === 'enoent', "an error's own code is kept, normalised", ec.errorCodeOf(Object.assign(new Error('x'), { code: 'ENOENT' })));
  ok(ec.errorCodeOf(new Error('ffmpeg exited with code 1')) === 'tool_exit', 'a tool that exited non-zero');
  ok(ec.errorCodeOf(new Error('upstream answered HTTP 503')) === 'http_503', 'an HTTP status');
  ok(ec.errorCodeOf(new Error('probe timed out after 30s')) === 'timeout', 'a timeout');
  ok(ec.errorCodeOf(new Error('the source file does not exist')) === 'source_missing', 'a missing source');
  ok(ec.errorCodeOf('something odd') === 'error', 'anything else is still coded');
  ok(ec.normaliseCode('DRM_LICENSE') === 'drm_license' && ec.normaliseCode('ProviderTimeout') === 'provider_timeout' && ec.normaliseCode('a b') === null, 'codes normalised to lower case with underscores');

  const aname = new URL(adb.analyticsUrl()).pathname.slice(1);
  {
    const { Client } = await import('pg'); const u = new URL(config.databaseUrl); u.pathname = '/postgres';
    const c = new Client({ connectionString: u.toString() }); await c.connect(); await c.query(`DROP DATABASE IF EXISTS "${aname}" WITH (FORCE)`); await c.end();
  }

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`wfr-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`wfr-b-${tag}`]))!.id;
  const chan = async (a: string) => {
    const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [a]))!.id;
    const grp = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [a, prof]))!.id;
    return (await one<any>(`INSERT INTO channels(group_id, name, status) VALUES ($1,'News','ended') RETURNING id`, [grp]))!.id;
  };
  const ch = await chan(acct);
  const chB = await chan(other);
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `wfr-${tag}@example.com`]))!.id;
  const userB = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [other, `wfr-b-${tag}@example.com`]))!.id;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' } as any);
  const tokB = signAccess({ sub: userB, account_id: other, role: 'owner' } as any);

  const MIN = 60_000, DAY = 86_400_000;
  const now = Date.now();
  const base = Math.floor(now / MIN) * MIN - 3 * 3600_000; // three hours ago, on a minute
  const iso = (t: number) => new Date(t).toISOString();
  const job = (type: string, state: string, startAt: number, runMs: number, o: { waitMs?: number; attempts?: number; code?: string | null; err?: string | null; channel?: string } = {}) =>
    query(`INSERT INTO jobs (type, state, channel_id, attempts, max_attempts, error_code, last_error, created_at, started_at, finished_at)
           VALUES ($1,$2::job_state,$3,$4,5,$5,$6,$7,$8,$9)`,
      [type, state, o.channel ?? ch, o.attempts ?? 1, o.code ?? null, o.err ?? null, iso(startAt - (o.waitMs ?? 2000)), iso(startAt),
       state === 'queued' || state === 'running' ? null : iso(startAt + runMs)]);

  // QC: ten runs of 1 s to 10 s, each waiting 2 s. 7 pass, 2 fail, 1 cancelled; two needed three attempts.
  for (let i = 1; i <= 10; i++) {
    const state = i <= 7 ? 'succeeded' : i <= 9 ? 'failed' : 'cancelled';
    await job('qc.run', state, base + i * MIN, i * 1000, {
      attempts: i === 2 || i === 8 ? 3 : 1,
      code: i === 8 ? 'source_missing' : null,
      err: i === 9 ? 'ffmpeg exited with code 1' : null,
    });
  }
  for (let i = 0; i < 4; i++) await job('clip.extract', 'succeeded', base + 30 * MIN + i * MIN, 20_000);
  await job('frames.index', 'succeeded', base + 40 * MIN, 500);
  await job('frames.index', 'failed', base + 41 * MIN, 500, { code: 'tool_exit' });
  for (let i = 0; i < 3; i++) await job('addon.dispatch', 'failed', base + 42 * MIN, 100, { code: 'http_500' });
  await job('qc.run', 'queued', base + 50 * MIN, 0);
  await job('qc.run', 'running', base + 50 * MIN, 0);
  await job('clip.extract', 'succeeded', now - 9 * DAY, 30_000);             // in 30 days, not in 7
  for (let i = 0; i < 5; i++) await job('qc.run', 'failed', base + i * MIN, 1000, { channel: chB, code: 'timeout' }); // another account

  const ev = (hook: string, at: number, data: any, subject = ch, account = acct) =>
    query(`INSERT INTO workflow_events (account_id, hook, subject_type, subject_id, channel_id, data, created_at) VALUES ($1,$2,'channel',$3,$3,$4::jsonb,$5)`,
      [account, hook, subject, JSON.stringify(data), iso(at)]);
  await ev('stream.started', base + 60 * MIN, {});
  await ev('stream.started', base + 61 * MIN, {});
  await ev('stream.stopped', base + 70 * MIN, { intent: 'operator' });
  await ev('stream.stopped', base + 71 * MIN, { intent: 'fault' });
  await ev('stream.stopped', base + 72 * MIN, { intent: 'schedule' });
  await ev('recording.completed', base + 73 * MIN, { durationMs: 60_000 });
  await ev('recording.completed', base + 74 * MIN, { durationMs: 120_000 });
  await ev('clip.ready', base + 75 * MIN, {}); // the clip stage counts its jobs, not this
  await ev('review.decided', base + 76 * MIN, { to: 'approved' });

  const addon = (await one<any>(`INSERT INTO addon_services(account_id, name, category, kind, signing_secret) VALUES ($1,'Summariser','ai_agent','demo','s') RETURNING id`, [acct]))!.id;
  const run = (hook: string, state: string, at: number, runMs: number, o: { err?: string; by?: string } = {}) =>
    query(`INSERT INTO addon_runs (account_id, addon_id, hook, subject_type, subject_id, state, error, created_by, callback_hash, created_at, dispatched_at, finished_at, deadline_at)
           VALUES ($1,$2,$3,'channel',$4,$5,$6,$7,'h',$8,$9,$10,$10)`,
      [acct, addon, hook, ch, state, o.err ?? null, o.by ?? 'trigger:x', iso(at), iso(at + 500), iso(at + runMs)]);
  await run('recording.completed', 'succeeded', base + 80 * MIN, 4000);
  await run('recording.completed', 'succeeded', base + 81 * MIN, 6000, { by: 'retry:abc' });
  await run('recording.completed', 'timed_out', base + 82 * MIN, 3600_000);
  await run('manual', 'failed', base + 83 * MIN, 1000, { err: 'endpoint answered HTTP 503' });
  await run('recording.completed', 'running', base + 84 * MIN, 0);

  console.log('== the rollup ==');
  let passes = 0;
  while (passes < 40) {
    await roll.rollupPass(now); passes++;
    if (roll.rollupStats.lastTo && new Date(roll.rollupStats.lastTo).getTime() >= Math.floor(now / MIN) * MIN - 60_000) break;
  }
  ok(passes >= 30 && passes <= 33, `a first start backfills ${roll.BACKFILL_DAYS} days, one day a pass (${passes} passes)`);
  const ap = await adb.analyticsPool();
  const snap = async () => (await ap.query(`SELECT account_id, day, source, kind, hook, stage, runs, succeeded, failed, cancelled, retries, run_sketch, wait_sketch, codes FROM wf_days ORDER BY 1,2,3,4,5`)).rows;
  const before = JSON.stringify(await snap());
  const minutesBefore = (await ap.query(`SELECT count(*)::int n, sum(runs)::int r FROM wf_minutes`)).rows[0];
  await roll.rollupWindow(base - DAY, now - 60_000);
  await roll.rollupPass(now);
  ok(JSON.stringify(await snap()) === before, 'recomputing the same window and another pass give the same day rows');
  const minutesAfter = (await ap.query(`SELECT count(*)::int n, sum(runs)::int r FROM wf_minutes`)).rows[0];
  ok(minutesAfter.n === minutesBefore.n && minutesAfter.r === minutesBefore.r, 'and the same minute rows', [minutesBefore, minutesAfter]);
  ok(!(await ap.query(`SELECT 1 FROM wf_minutes WHERE minute < now() - interval '14 days 1 minute'`)).rows.length, 'minutes older than 14 days are not kept');
  const old = (await ap.query(`SELECT sum(runs)::int n FROM wf_days WHERE account_id = $1 AND kind = 'clip.extract' AND day < current_date - 7`, [acct])).rows[0];
  ok(old.n === 1, 'the backfill reached a clip 9 days back', old);

  const srv = createServer().listen(0);
  const baseUrl = `http://127.0.0.1:${(srv.address() as any).port}`;
  const get = async (path: string, t = tok) => { const r = await fetch(`${baseUrl}/api/workflows${path}`, { headers: { authorization: `Bearer ${t}` } }); return { status: r.status, body: await r.json().catch(() => null) as any }; };

  console.log('== the report, 7 days ==');
  const r7 = await get('/report?range=7d');
  ok(r7.status === 200, 'GET /api/workflows/report answers', r7);
  const st = (r: any, id: string) => r.body.stages.find((s: any) => s.id === id);
  const qc = st(r7, 'qc');
  ok(qc.runs === 10 && qc.succeeded === 7 && qc.failed === 2 && qc.cancelled === 1, 'QC: 10 finished runs, 7 succeeded, 2 failed, 1 cancelled (queued and running not counted)', qc);
  ok(qc.errorRate === 20 && qc.successRate === 70, 'QC error rate 20 %, success 70 %', qc);
  ok(qc.retries === 4, 'QC retries: two runs took three attempts', qc.retries);
  ok(near(qc.p50Ms, 5000) && near(qc.p95Ms, 10_000), 'QC p50 5 s and p95 10 s, within the sketch\'s 1 %', [qc.p50Ms, qc.p95Ms]);
  ok(near(qc.waitP50Ms, 2000) && near(qc.waitP95Ms, 2000), 'QC waited 2 s to start', [qc.waitP50Ms, qc.waitP95Ms]);
  ok(JSON.stringify(qc.topCodes) === JSON.stringify([{ code: 'source_missing', count: 1 }, { code: 'tool_exit', count: 1 }]), 'QC error codes: the stored one, and one worked out from the message', qc.topCodes);
  ok(qc.fedBy === 'jobs' && qc.lane === 'post', 'QC is fed by its jobs, in the post-production lane');
  const clip = st(r7, 'clip');
  ok(clip.runs === 4 && clip.errorRate === 0 && near(clip.p50Ms, 20_000), 'Clip: 4 runs in 7 days (the one 9 days ago is outside), its own jobs only (clip.ready not counted again)', clip);
  const enc = st(r7, 'encode');
  ok(enc.fedBy === 'events' && enc.runs === 3 && enc.failed === 1 && enc.topCodes[0]?.code === 'stream_fault', 'Encode: three stream runs from their stops (starts not counted), the fault stop a failure', enc);
  const rec = st(r7, 'record');
  ok(rec.runs === 2 && rec.failed === 0 && near(rec.p50Ms, 60_000) && near(rec.p95Ms, 120_000), 'Record: two recordings, times from their duration', rec);
  ok(st(r7, 'review').runs === 1, 'Review: one decision');
  ok(st(r7, 'rules').fedBy === 'none' && st(r7, 'rules').runs === 0, 'a stage with no jobs and no completion hook says so, with zeros');
  ok(r7.body.stages.length === 14 && r7.body.lanes.length === 3, 'every stage and lane of the map is in the report');
  const fr = r7.body.otherJobs.find((o: any) => o.type === 'frames.index');
  ok(fr && fr.runs === 2 && fr.failed === 1, 'a job type no stage claims is listed apart, by type', r7.body.otherJobs);
  ok(!r7.body.otherJobs.some((o: any) => o.type === 'addon.dispatch') && !r7.body.stages.some((s: any) => s.topCodes.some((c: any) => c.code === 'http_500')), 'add-on delivery jobs are not counted (their runs are)');
  const ad = r7.body.addons.find((a: any) => a.hook === 'recording.completed');
  ok(ad && ad.name === 'Summariser' && ad.runs === 3 && ad.succeeded === 2 && ad.failed === 1 && ad.retries === 1, 'add-on runs per add-on and hook: 3 finished, a timeout a failure, a retry counted, the open one not', ad);
  ok(ad?.topCodes[0]?.code === 'timed_out' && near(ad.waitP50Ms, 500), 'its timeout coded, its wait to dispatch measured', ad);
  const man = r7.body.addons.find((a: any) => a.hook === 'manual');
  ok(man && man.runs === 1 && man.topCodes[0]?.code === 'http_503', 'a hand run under manual, coded from its error', man);
  const today = new Date(base).toISOString().slice(0, 10);
  const lanePost = r7.body.series.find((s: any) => s.lane === 'post' && s.t.startsWith(today));
  ok(r7.body.bucket === 'day' && lanePost && lanePost.runs === 10 + 4 + 1 && lanePost.failed === 2, 'per lane per day: post-production runs and failures (QC, clips, review)', lanePost);
  const laneLive = r7.body.series.find((s: any) => s.lane === 'live' && s.t.startsWith(today));
  ok(laneLive && laneLive.runs === 3 + 2 && laneLive.failed === 1 && laneLive.errorRate === 20, 'per lane per day: live (stream runs and recordings), one fault in five', laneLive);
  ok(r7.body.totals.runs === 10 + 4 + 3 + 2 + 1 && r7.body.totals.failed === 3, 'totals over the stages', r7.body.totals);
  ok(typeof r7.body.rollup.through === 'string', 'says how fresh it is', r7.body.rollup);

  console.log('== 24 hours, 30 days, other account ==');
  const r24 = await get('/report?range=24h');
  ok(r24.body.bucket === 'hour' && st(r24, 'qc').runs === 10 && near(st(r24, 'qc').p95Ms, 10_000), '24 hours from the minute rollups, per hour', st(r24, 'qc'));
  ok(r24.body.series.filter((s: any) => s.lane === 'post').reduce((n: number, s: any) => n + s.runs, 0) === 15, 'the hourly series adds up to the same runs');
  const r30 = await get('/report?range=30d');
  ok(st(r30, 'clip').runs === 5, '30 days include the clip from 9 days ago', st(r30, 'clip'));
  const rb = await get('/report?range=7d', tokB);
  ok(st(rb, 'qc').runs === 5 && st(rb, 'qc').failed === 5 && st(rb, 'clip').runs === 0 && rb.body.addons.length === 0, "another account sees only its own", st(rb, 'qc'));
  ok((await get('/report?range=1y')).status === 422, 'an unknown range is refused (422, as every invalid query)');
  ok((await fetch(`${baseUrl}/api/workflows/report`)).status === 401, 'signed in only');

  console.log('== the worker codes a failure ==');
  {
    const { registerHandler, startWorker } = await import('../src/services/jobs/worker');
    const { enqueue } = await import('../src/services/jobs/queue');
    registerHandler('test.wfr', async () => { throw new Error('probe timed out after 30 s'); });
    const w = startWorker({ concurrency: 1, pollMs: 100, reapMs: 60_000 });
    const j = await enqueue({ type: 'test.wfr', maxAttempts: 1, channelId: ch });
    let row: any = null;
    for (let i = 0; i < 50; i++) { row = await one<any>(`SELECT state, error_code FROM jobs WHERE id = $1`, [j.id]); if (row?.state === 'failed') break; await sleep(100); }
    await w.stop();
    ok(row?.state === 'failed' && row.error_code === 'timeout', 'a plain thrown error is stored with a code (it had none before)', row);
    const att = await one<any>(`SELECT error_code FROM job_attempts WHERE job_id = $1`, [j.id]);
    ok(att?.error_code === 'timeout', 'on its attempt too', att);
  }

  srv.close();
  await adb.closeAnalytics();
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
