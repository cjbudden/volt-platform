// ============================================================================
//  ANALYTICS RETENTION — reports outlive the events they were computed from.
//
//  One claim is being tested and everything else supports it:
//
//      A REPORT GIVES THE SAME ANSWER AFTER THE RAW DATA IS DELETED.
//
//  The suite writes real session rows across several days, rolls them up, takes
//  a snapshot of every figure a report can show, prunes the raw data, and
//  compares the figures field by field. If a single number moves, the promise is
//  broken.
//
//  The other half is the SAFETY ORDERING. A day's summary is sealed from
//  complete raw data before that day's raw data is deleted. Prune first and the
//  number is gone: the report does not go missing, it quietly becomes wrong,
//  which is worse. So the suite also unseals a day and checks the prune refuses
//  to touch it.
//
//  Usage: DATABASE_URL=... npx tsx test/analytics-retention.check.ts
// ============================================================================
import { pool, query, one } from '../src/db';
import {
  recomputeDay, sealDueDays, pruneRawSessions, sweepAnalytics,
  retentionStatus, setRawRetention,
} from '../src/services/analyticsRetention';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected truthy, got [${String(v)}]`));
const contains = (m: string, hay: string, needle: string) =>
  (hay ?? '').toLowerCase().includes(needle.toLowerCase())
    ? ok(m) : bad(m, `expected to mention "${needle}", got "${String(hay).slice(0, 160)}"`);

const MARK = 'retention-test';

/** The figures a report can show for a day, as the report reads them. */
async function reportFor(accountId: string, day: string) {
  const rows = await query<any>(
    `SELECT scope, scope_id, total_views, unique_views, watch_seconds, blocked_count,
            by_app, by_device, by_geo, sealed
       FROM analytics_rollups
      WHERE account_id = $1 AND bucket_date = $2::date
      ORDER BY scope, scope_id NULLS FIRST`,
    [accountId, day]
  );
  return rows.map((r) => ({
    scope: r.scope, scopeId: r.scope_id,
    total: Number(r.total_views), unique: Number(r.unique_views),
    watch: Number(r.watch_seconds), blocked: Number(r.blocked_count),
    byDevice: JSON.stringify(r.by_device), byGeo: JSON.stringify(r.by_geo),
  }));
}

async function main() {
  const acct = await one<any>(`SELECT id FROM accounts WHERE name = 'AdminCo'`);
  if (!acct) { console.log('FATAL: no AdminCo account'); process.exit(1); }

  // A clean slate for the test's own days, and nothing else touched.
  await query(`DELETE FROM play_sessions WHERE session_key LIKE $1`, [`${MARK}%`]);
  const testDays = [40, 39, 38, 2];    // three old days and one recent
  for (const d of testDays) {
    await query(
      `DELETE FROM analytics_rollups
        WHERE account_id = $1 AND bucket_date = (current_date - ($2 || ' days')::interval)::date`, [acct.id, d]
    );
  }

  // ---- write real sessions -----------------------------------------------
  // Three distinct viewers, six sessions, on the day 40 days ago: so total views
  // and unique views are genuinely DIFFERENT numbers and the difference is
  // checkable rather than incidental.
  const viewers = ['ip-a', 'ip-b', 'ip-c'];
  const devices = ['tv', 'mobile', 'tv', 'desktop', 'mobile', 'tv'];
  const geos = ['GB', 'GB', 'IE', 'GB', 'US', 'GB'];
  for (let i = 0; i < 6; i++) {
    await query(
      `INSERT INTO play_sessions
         (account_id, session_key, asset_kind, asset_id, device_type, geo_country,
          ip_hash, started_at, last_seen_at, ended_at, seconds_watched, blocked)
       VALUES ($1, $2, 'channel', 'asset-one', $3, $4, $5,
               (current_date - interval '40 days') + ($6 || ' minutes')::interval,
               (current_date - interval '40 days') + ($6 || ' minutes')::interval,
               (current_date - interval '40 days') + ($6 || ' minutes')::interval + interval '5 minutes',
               $7, $8)`,
      [acct.id, `${MARK}-d40-${i}`, devices[i], geos[i], viewers[i % 3],
       String(i * 10), 300 + i * 10, i === 5]
    );
  }
  // A quieter day, and one recent day that must NOT be pruned.
  for (const [d, n] of [[39, 2], [38, 3], [2, 4]] as const) {
    for (let i = 0; i < n; i++) {
      await query(
        `INSERT INTO play_sessions
           (account_id, session_key, asset_kind, asset_id, device_type, geo_country,
            ip_hash, started_at, last_seen_at, ended_at, seconds_watched)
         VALUES ($1, $2, 'channel', 'asset-two', 'tv', 'GB', $3,
                 (current_date - ($4 || ' days')::interval) + interval '1 hour',
                 (current_date - ($4 || ' days')::interval) + interval '1 hour',
                 (current_date - ($4 || ' days')::interval) + interval '1 hour' + interval '2 minutes', 120)`,
        [acct.id, `${MARK}-d${d}-${i}`, `ip-${i}`, d]
      );
    }
  }
  const written = await one<any>(
    `SELECT count(*)::int AS n FROM play_sessions WHERE session_key LIKE $1`, [`${MARK}%`]);
  check('the test wrote its sessions', written?.n, 15);

  // ---- recompute: unique is not the same as total ------------------------
  const day40 = (await one<any>(`SELECT to_char(current_date - 40, 'YYYY-MM-DD') AS d`))!.d;
  await recomputeDay(acct.id, day40);
  const acctRow = await one<any>(
    `SELECT * FROM analytics_rollups
      WHERE account_id = $1 AND scope = 'account' AND scope_id IS NULL AND bucket_date = $2::date`,
    [acct.id, day40]
  );
  check('the day rolls up every session', Number(acctRow?.total_views), 6);
  // The bug this replaced: the incremental path added one to BOTH columns per
  // session, so unique_views was always equal to total_views and meant nothing.
  check('unique views counts viewers, not sessions', Number(acctRow?.unique_views), 3);
  check('watch seconds are summed', Number(acctRow?.watch_seconds), 300 + 310 + 320 + 330 + 340 + 350);
  check('blocked sessions are counted', Number(acctRow?.blocked_count), 1);
  check('and the row records what it was computed from', Number(acctRow?.sessions_counted), 6);

  const byDevice = acctRow?.by_device ?? {};
  check('the device breakdown is a real aggregate', byDevice.tv, 3);
  check('across every device', `${byDevice.mobile}/${byDevice.desktop}`, '2/1');
  const byGeo = acctRow?.by_geo ?? {};
  check('and so is the geography', `${byGeo.GB}/${byGeo.IE}/${byGeo.US}`, '4/1/1');

  const perAsset = await one<any>(
    `SELECT * FROM analytics_rollups
      WHERE account_id = $1 AND scope = 'channel' AND scope_id = 'asset-one' AND bucket_date = $2::date`,
    [acct.id, day40]
  );
  truthy('the per-asset scope is rolled up too', !!perAsset);
  check('with the same totals for a single-asset day', Number(perAsset?.total_views), 6);

  // ---- the promise: the report survives the prune ------------------------
  await setRawRetention(acct.id, 30);
  const status = await retentionStatus(acct.id);
  check('the retention window is what was set', status.rawRetentionDays, 30);
  contains('and the promise is stated plainly', status.note, 'Reports are kept indefinitely');

  const before40 = await reportFor(acct.id, day40);
  const day2 = (await one<any>(`SELECT to_char(current_date - 2, 'YYYY-MM-DD') AS d`))!.d;

  const sealed = await sealDueDays();
  truthy('the finished days out of the window are sealed', sealed.sealed >= 2);
  const sealedRow = await one<any>(
    `SELECT sealed, sealed_at FROM analytics_rollups
      WHERE account_id = $1 AND scope = 'account' AND scope_id IS NULL AND bucket_date = $2::date`,
    [acct.id, day40]);
  check('the old day is sealed', sealedRow?.sealed, true);
  truthy('with when', !!sealedRow?.sealed_at);

  const recentRow = await one<any>(
    `SELECT sealed FROM analytics_rollups
      WHERE account_id = $1 AND scope = 'account' AND scope_id IS NULL AND bucket_date = $2::date`,
    [acct.id, day2]);
  check('a day still inside the window is NOT sealed',
    recentRow == null ? 'no row yet' : recentRow.sealed, recentRow == null ? 'no row yet' : false);

  const pruned = await pruneRawSessions();
  truthy('raw sessions outside the window are deleted', pruned.sessionsDeleted >= 11);
  const leftOld = await one<any>(
    `SELECT count(*)::int AS n FROM play_sessions
      WHERE session_key LIKE $1 AND started_at < current_date - interval '30 days'`, [`${MARK}%`]);
  check('none of the old raw data remains', leftOld?.n, 0);
  const leftNew = await one<any>(
    `SELECT count(*)::int AS n FROM play_sessions
      WHERE session_key LIKE $1 AND started_at >= current_date - interval '30 days'`, [`${MARK}%`]);
  check('the recent raw data is untouched', leftNew?.n, 4);

  // THE CLAIM.
  const after40 = await reportFor(acct.id, day40);
  check('the report has the same shape after the prune', after40.length, before40.length);
  const same = JSON.stringify(before40) === JSON.stringify(after40);
  check('and every figure in it is identical', same, true);
  if (!same) {
    console.log('  before:', JSON.stringify(before40));
    console.log('  after: ', JSON.stringify(after40));
  }

  // ---- a sealed day is never recomputed ----------------------------------
  // The raw data is gone, so a recompute would find nothing and would zero the
  // figures. The seal is what stops it.
  await recomputeDay(acct.id, day40);
  const afterRecompute = await reportFor(acct.id, day40);
  check('recomputing a sealed day changes nothing',
    JSON.stringify(afterRecompute), JSON.stringify(before40));

  // ---- the safety ordering -----------------------------------------------
  // Put a day back with raw data and NO seal, and the prune must leave it alone.
  await query(
    `INSERT INTO play_sessions
       (account_id, session_key, asset_kind, asset_id, device_type, geo_country,
        ip_hash, started_at, last_seen_at, ended_at, seconds_watched)
     VALUES ($1, $2, 'channel', 'asset-three', 'tv', 'GB', 'ip-z',
             current_date - interval '45 days', current_date - interval '45 days', current_date - interval '45 days' + interval '1 minute', 60)`,
    [acct.id, `${MARK}-unsealed-0`]
  );
  const day45 = (await one<any>(`SELECT to_char(current_date - 45, 'YYYY-MM-DD') AS d`))!.d;
  await query(
    `DELETE FROM analytics_rollups WHERE account_id = $1 AND bucket_date = $2::date`,
    [acct.id, day45]
  );
  const held = await pruneRawSessions();
  truthy('a day whose summary is not sealed is held back', held.heldForUnsealed >= 1);
  const survived = await one<any>(
    `SELECT count(*)::int AS n FROM play_sessions WHERE session_key = $1`, [`${MARK}-unsealed-0`]);
  check('and its raw data is still there', survived?.n, 1);

  // Seal it properly and it goes.
  const swept = await sweepAnalytics();
  truthy('a full sweep seals it first', swept.seal.sealed >= 1);
  const gone = await one<any>(
    `SELECT count(*)::int AS n FROM play_sessions WHERE session_key = $1`, [`${MARK}-unsealed-0`]);
  check('and then prunes it', gone?.n, 0);
  const summary = await one<any>(
    `SELECT total_views FROM analytics_rollups
      WHERE account_id = $1 AND scope = 'account' AND scope_id IS NULL AND bucket_date = $2::date`,
    [acct.id, day45]);
  check('with the figure preserved', Number(summary?.total_views), 1);

  // ---- keeping raw data forever --------------------------------------------
  await setRawRetention(acct.id, null);
  const forever = await retentionStatus(acct.id);
  check('an account can keep raw data forever', forever.rawRetentionDays, null);
  contains('and is told so', forever.note, 'indefinitely');
  await query(
    `INSERT INTO play_sessions
       (account_id, session_key, asset_kind, asset_id, started_at, last_seen_at, ended_at, seconds_watched)
     VALUES ($1, $2, 'channel', 'asset-four', current_date - interval '400 days', current_date - interval '400 days',
             current_date - interval '400 days' + interval '1 minute', 60)`,
    [acct.id, `${MARK}-forever-0`]
  );
  await pruneRawSessions();
  const stillThere = await one<any>(
    `SELECT count(*)::int AS n FROM play_sessions WHERE session_key = $1`, [`${MARK}-forever-0`]);
  check('and nothing is pruned for it, however old', stillThere?.n, 1);
  // An account keeping raw data forever is not merely spared the delete: it is
  // excluded from the prune's query entirely, so a large archive costs nothing
  // to skip.
  const considered = await query<any>(
    `SELECT 1 FROM accounts WHERE id = $1 AND analytics_raw_retention_days IS NOT NULL`, [acct.id]);
  check('and it is not in the set the prune walks', considered.length, 0);

  // ---- a retention of zero is refused --------------------------------------
  let refused = false;
  try { await setRawRetention(acct.id, 0); } catch { refused = true; }
  check('a retention of zero days is refused', refused, true);

  // clean up: the test owns everything it wrote
  await setRawRetention(acct.id, 90);
  await query(`DELETE FROM play_sessions WHERE session_key LIKE $1`, [`${MARK}%`]);
  for (const d of [...testDays, 45, 400]) {
    await query(
      `DELETE FROM analytics_rollups
        WHERE account_id = $1 AND bucket_date = (current_date - ($2 || ' days')::interval)::date`,
      [acct.id, d]
    );
  }

  console.log(`\nanalytics-retention: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
