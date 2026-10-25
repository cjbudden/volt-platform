// ============================================================================
//  FIXES FOUND WRITING THE WORKFLOW GUIDES (build queue 1.14-G5a).
//
//  1. A lost idle database connection no longer ends the process (db.ts pool
//     'error' handler): its backend is terminated from outside, the process
//     lives and the next query works.
//  2. GET /api/jobs/{id} finds an upload's encode job (it has no channel or
//     event, only the asset in its payload), for its own account only; the
//     list shows it; a payload that is not a uuid breaks nothing.
//  3. Auto-publish runs on approval of a held clip and for a full-event
//     replay (Publish full VOD and Automatic VOD on end), and still not for a
//     manual rule, a clip that is still building, or an upload.
//  4. FAST: the stitched-ads refusal names the option as the console shows
//     it; Public is refused until a run order is active; private always works.
//  5. Rights preview: when the loop is not ready it says what it would be
//     built from (a slate) or why there is none.
//  6. The console's sign-in form fills in the demo login in development only.
//    DATABASE_URL=... npx tsx test/workflow-fixes.check.ts
// ============================================================================
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ORIGIN_DIR = mkdtempSync(join(tmpdir(), 'volt-g5a-'));   // no loop built anywhere

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};

(async () => {
  // ---- 6. the sign-in form (source; the production bundle is checked by the run) ----
  const app = readFileSync(join(__dirname, '../../volt-web/src/App.tsx'), 'utf8');
  check('sign-in: the demo email is filled in for development only',
    /useState\(import\.meta\.env\.DEV \? 'admin@rtm\.example' : ''\)/.test(app) && !/useState\('admin@rtm\.example'\)/.test(app), true);
  check('sign-in: and the demo password', /useState\(import\.meta\.env\.DEV \? 'volt1234' : ''\)/.test(app) && !/useState\('volt1234'\)/.test(app), true);

  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { Client } = await import('pg');
  const { signAccess } = await import('../src/auth/jwt');
  const { enqueue } = await import('../src/services/jobs/queue');

  // ---- 1. a lost idle connection --------------------------------------------------
  const pid = (await one<any>(`SELECT pg_backend_pid() AS pid`))!.pid;   // that client goes back to the pool, idle
  const killer = new Client({ connectionString: process.env.DATABASE_URL });
  await killer.connect();
  await killer.query(`SELECT pg_terminate_backend($1)`, [pid]);
  await killer.end();
  await new Promise((r) => setTimeout(r, 500));                           // the pool hears it: 'error' on the pool
  check('db: the process outlived a terminated idle connection, and the next query works', (await one<any>(`SELECT 1 AS n`))?.n, 1);

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`g5a-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`g5a-o-${tag}`]))!.id;
  const mkUser = async (a: string, who: string) =>
    (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `${who}-${tag}@example.com`]))!.id;
  const owner = await mkUser(acct, 'owner'), otherOwner = await mkUser(other, 'other');
  const g = (await one<any>(`INSERT INTO groups(account_id, name) VALUES ($1,'G5a') RETURNING id`, [acct]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'G5a News') RETURNING id`, [g]))!.id;
  const chManual = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'G5a Manual') RETURNING id`, [g]))!.id;
  const now = Math.floor(Date.now() / 1000);
  const ev = (await one<any>(`INSERT INTO events(group_id, name, status, scheduled_start, scheduled_end) VALUES ($1,'G5a Final','scheduled',to_timestamp($2),to_timestamp($3)) RETURNING id`, [g, now - 600, now + 7200]))!.id;

  const srv = createServer().listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const T = signAccess({ sub: owner, account_id: acct, role: 'owner' }), TO = signAccess({ sub: otherOwner, account_id: other, role: 'owner' });
  const call = async (method: string, path: string, body?: unknown, tok = T) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { s: r.status, j: await r.json().catch(() => null) as any };
  };
  try {
    // ---- 2. an upload's encode job ----------------------------------------------------
    const up = (await one<any>(`INSERT INTO vod_assets (account_id, source_kind, title, start_epoch_ms, end_epoch_ms, duration_ms) VALUES ($1,'upload','G5a upload',0,60000,60000) RETURNING id`, [acct]))!.id;
    const theirs = (await one<any>(`INSERT INTO vod_assets (account_id, source_kind, title, start_epoch_ms, end_epoch_ms, duration_ms) VALUES ($1,'upload','Not yours',0,60000,60000) RETURNING id`, [other]))!.id;
    const job = await enqueue({ type: 'vod.encode', payload: { vodAssetId: up, accountId: acct }, runAfter: new Date(Date.now() + 3600e3) });
    const theirJob = await enqueue({ type: 'vod.encode', payload: { vodAssetId: theirs, accountId: acct }, runAfter: new Date(Date.now() + 3600e3) });  // a payload that claims our account
    await enqueue({ type: 'vod.encode', payload: { vodAssetId: 'not-a-uuid' }, runAfter: new Date(Date.now() + 3600e3) });
    const chJob = await enqueue({ type: 'filler.build', payload: {}, channelId: ch, runAfter: new Date(Date.now() + 3600e3) });
    let r = await call('GET', `/api/jobs/${job.id}`);
    check('jobs: an upload encode job is found by its account (200), named after the asset', [r.s, r.j?.id, r.j?.source_name], [200, job.id, 'G5a upload']);
    check("jobs: another account's upload job is 404, even with our account in its payload", (await call('GET', `/api/jobs/${theirJob.id}`)).s, 404);
    check('jobs: and 404 to the other account for ours', (await call('GET', `/api/jobs/${job.id}`, undefined, TO)).s, 404);
    check("jobs: the other account does see its own upload's job", (await call('GET', `/api/jobs/${theirJob.id}`, undefined, TO)).s, 200);
    r = await call('GET', `/api/jobs?limit=200`);
    const ids = (Array.isArray(r.j?.jobs) ? r.j.jobs : r.j?.jobs?.items ?? []).map((x: any) => x.id);
    check('jobs: the list answers with a junk payload in the table, and shows the upload and channel jobs only', [r.s, ids.includes(job.id), ids.includes(chJob.id), ids.includes(theirJob.id)], [200, true, true, false]);
    check('jobs: cancel works on the upload job', (await call('POST', `/api/jobs/${job.id}/cancel`)).s, 200);

    // ---- 3. auto-publish ---------------------------------------------------------------
    await query(`INSERT INTO publishing_rules(account_id, scope_kind, settings) VALUES ($1,'account',$2::jsonb)`,
      [acct, JSON.stringify({ autoPublish: true, gate: { requireReview: true, blockOnQcFail: false } })]);
    await query(`INSERT INTO publishing_rules(account_id, scope_kind, scope_id, settings) VALUES ($1,'owner',$2,$3::jsonb)`,
      [acct, chManual, JSON.stringify({ autoPublish: false })]);
    await query(`INSERT INTO publishing_rules(account_id, scope_kind, scope_id, settings) VALUES ($1,'owner',$2,$3::jsonb)`,
      [acct, ev, JSON.stringify({ gate: { requireReview: false, blockOnQcFail: false } })]);
    let day = 0;
    const rec = async (owner: { channel_id?: string; event_id?: string }) => (await one<any>(
      `INSERT INTO recordings(channel_id, event_id, kind, status, start_epoch_ms, end_epoch_ms, duration_ms, master_key, day_utc)
       VALUES ($1,$2,$3,'complete',$4,$5,600000,$6,$7) RETURNING *`,
      [owner.channel_id ?? null, owner.event_id ?? null, owner.event_id ? 'event' : 'channel_day', Date.now() - 600000, Date.now(), `rec/${tag}/${Math.random().toString(36).slice(2)}`,
       owner.channel_id ? new Date(Date.now() - (day++) * 86400e3).toISOString().slice(0, 10) : null]))!;   // one channel_day row per day
    const recCh = await rec({ channel_id: ch }), recMan = await rec({ channel_id: chManual });
    const clip = async (chId: string, recId: string, title: string) => (await one<any>(
      `INSERT INTO vod_assets(channel_id, recording_id, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, review_state, thumb_status)
       VALUES ($1,$2,'clip',$3,'x/master.m3u8',0,30000,30000,'in_review','ready') RETURNING id`, [chId, recId, title]))!.id;
    const held = await clip(ch, recCh.id, 'Held clip'), manual = await clip(chManual, recMan.id, 'Manual clip'), building = await clip(ch, recCh.id, 'Building clip');
    await enqueue({ type: 'clip.extract', payload: { vodAssetId: building }, channelId: ch, runAfter: new Date(Date.now() + 3600e3) });
    await query(`UPDATE vod_assets SET review_state = 'in_review' WHERE id = $1`, [up]);

    const { autoPublishOnBuild } = await import('../src/services/availability');
    check('auto-publish: the held clip was held at build (review required)', await autoPublishOnBuild(held), 'skipped');
    r = await call('POST', `/api/vod/${held}/review`, { to: 'approved' });
    const pubs = await query<any>(`SELECT platform FROM publications WHERE vod_asset_id = $1`, [held]);
    check('auto-publish: approving it publishes it, and the answer says so', [r.s, r.j?.review_state, r.j?.autoPublish, r.j?.availability_state, pubs.map((p) => p.platform)], [200, 'approved', 'published', 'available', ['portal']]);
    r = await call('POST', `/api/vod/${manual}/review`, { to: 'approved' });
    check('auto-publish: approving under a manual rule publishes nothing', [r.s, r.j?.autoPublish, (await one<any>(`SELECT count(*)::int AS n FROM publications WHERE vod_asset_id = $1`, [manual]))!.n], [200, 'skipped', 0]);
    r = await call('POST', `/api/vod/${building}/review`, { to: 'approved' });
    check('auto-publish: a clip still building is left to its build', [r.j?.autoPublish, (await one<any>(`SELECT count(*)::int AS n FROM publications WHERE vod_asset_id = $1`, [building]))!.n], ['skipped', 0]);
    r = await call('POST', `/api/vod/${up}/review`, { to: 'approved' });
    check('auto-publish: an approved upload does not publish itself (asked of Christian)', [r.s, r.j?.autoPublish, (await one<any>(`SELECT count(*)::int AS n FROM publications WHERE vod_asset_id = $1`, [up]))!.n], [200, 'skipped', 0]);

    const recEv = await rec({ event_id: ev });
    r = await call('POST', `/api/recordings/${recEv.id}/publish`, { title: 'G5a full replay' });
    check('auto-publish: Publish full VOD publishes the replay under its rules', [r.s, r.j?.kind, r.j?.autoPublish, r.j?.availability_state], [201, 'full_event', 'published', 'available']);
    const { deriveEventVod } = await import('../src/services/clips');
    const recEv2 = await rec({ event_id: ev });
    const auto = await deriveEventVod(recEv2);
    check('auto-publish: Automatic VOD on end publishes the replay too',
      (await one<any>(`SELECT availability_state FROM vod_assets WHERE id = $1`, [auto!.id]))?.availability_state, 'available');
    const recMan2 = await rec({ channel_id: chManual });
    r = await call('POST', `/api/recordings/${recMan2.id}/publish`, {});
    check('auto-publish: a full recording under a manual rule waits', [r.s, r.j?.autoPublish], [201, 'skipped']);

    // ---- 4. FAST -----------------------------------------------------------------------
    const fast = (await one<any>(`INSERT INTO channels(group_id, name, origin) VALUES ($1,'G5a FAST','playlist') RETURNING id`, [g]))!.id;
    const lineup = (await one<any>(`INSERT INTO fast_lineups(channel_id, name, epoch, zone) VALUES ($1,'Main lineup',now(),'UTC') RETURNING id`, [fast]))!.id;
    await query(`INSERT INTO channel_ads(channel_id) VALUES ($1) ON CONFLICT DO NOTHING`, [fast]);
    r = await call('PUT', `/api/fast/channels/${fast}/ads`, { mode: 'stitched' });
    check('FAST: stitched with no ad server is refused, naming the option as the console shows it',
      [r.s, /Ad markers for a FAST platform/.test(r.j?.error ?? r.j?.message ?? ''), /Markers only/.test(JSON.stringify(r.j))], [400, true, false]);
    r = await call('POST', `/api/fast/channels/${fast}/on-air`, { on: true });
    check('FAST: Public is refused with no active run order (409), and says why', [r.s, /Activate a run order/.test(r.j?.error ?? r.j?.message ?? '')], [409, true]);
    check('FAST: ...and the channel stays private', (await one<any>(`SELECT on_air FROM channels WHERE id = $1`, [fast]))?.on_air, false);
    check('FAST: private is always allowed', (await call('POST', `/api/fast/channels/${fast}/on-air`, { on: false })).s, 200);
    await query(`UPDATE fast_lineups SET status = 'active' WHERE id = $1`, [lineup]);
    r = await call('POST', `/api/fast/channels/${fast}/on-air`, { on: true });
    check('FAST: with the run order active, Public works', [r.s, r.j?.onAir], [200, true]);
    check('FAST: and back to private', (await call('POST', `/api/fast/channels/${fast}/on-air`, { on: false })).j?.onAir, false);

    // ---- 5. rights preview: what the loop is built from ---------------------------------
    await query(`INSERT INTO programmes(event_id, title, starts_at, ends_at, geo_mode, geo_countries, replacement_kind, replacement_ref)
                 VALUES ($1,'Final AU',to_timestamp($2),to_timestamp($3),'block',ARRAY['AU'],'loop','f')`, [ev, now - 60, now + 900]);
    const P = async () => (await call('GET', `/api/events/${ev}/rights-preview?country=AU`)).j;
    let p = await P();
    check('rights preview: replaced, no loop, failover off: says failover is off', [p?.decision, p?.loopReady, p?.loopSource?.kind, p?.loopSource?.reason], ['replace', false, null, 'input failover is off']);
    await query(`UPDATE events SET input_failover_enabled = true, input_loss_behavior = 'slate', filler_slate_ref = NULL WHERE id = $1`, [ev]);
    p = await P();
    check('rights preview: failover on, nothing set: no slate or loop', [p?.loopSource?.kind, p?.loopSource?.reason], [null, 'no slate image or loop video has been added']);
    await query(`UPDATE events SET filler_slate_ref = '/library/images/slate.png' WHERE id = $1`, [ev]);
    p = await P();
    check('rights preview: with a slate set: built from the slate, nothing to set', [p?.loopReady, p?.loopSource?.kind, p?.loopSource?.reason], [false, 'image', null]);
    p = (await call('GET', `/api/events/${ev}/rights-preview?country=MY`)).j;
    check('rights preview: not replaced: no loop question asked', [p?.decision, p?.loopReady, p?.loopSource], ['allow', null, null]);
  } finally {
    srv.close();
    await query(`DELETE FROM jobs WHERE payload->>'vodAssetId' = 'not-a-uuid'`).catch(() => {});
  }
  console.log(`\nworkflow-fixes: ${pass} passed, ${fail} failed`);
  await pool.end().catch(() => {});
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
