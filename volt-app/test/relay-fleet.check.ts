// ============================================================================
//  THE RELAY TIER: ASSIGNMENT, TELEMETRY, COST, AND WHO MAY SEE ANY OF IT.
//
//  Radio's MP3 output is the one thing the platform serves that is not a file.
//  It is a live push to an Icecast relay, which makes the relay the only
//  component whose cost is driven by AUDIENCE rather than by how many streams
//  are running — and, until now, the only one that existed as a single
//  environment variable with nothing tracking it.
//
//  FOUR PROPERTIES, and the last is the one that would be expensive to get
//  wrong:
//
//    1. ASSIGNMENT IS STICKY. mountFor() derives the mount from the channel id
//       precisely so a renamed station keeps its listener URL. Choosing a relay
//       afresh on every start would move the HOST in that URL instead and undo
//       the whole point. Hardware receivers are configured once and never again.
//
//    2. NO RELAYS MEANS THE ENVIRONMENT, not an error. A development machine
//       with one Icecast and no rows must keep working exactly as before.
//
//    3. ABSENT TELEMETRY IS ABSENT, NOT ZERO. host_samples writes no row for a
//       reading that failed, so a relay nothing has measured must read as
//       unknown. Drawn at 0% CPU it invites a conclusion; drawn as stale it
//       invites a look.
//
//    4. THE COST BASIS IS SYSTEM-ADMIN ONLY. relay_accruals and cost_actuals are
//       what the platform pays to serve traffic. A tenant who can see that can
//       compute our margin. The boundary is enforced by these things having no
//       route on the tenant surface at all, rather than by a role check that
//       could one day be edited out — and that is what the last section asserts.
//
//  Usage: DATABASE_URL=... npx tsx test/relay-fleet.check.ts
// ============================================================================
import { pool, query, one } from '../src/db';
import {
  resolveRelayFor, relayHealth, costComparison, listRelays,
} from '../src/services/fleet/relays';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected something, got [${String(v)}]`));
const falsy = (m: string, v: unknown) => (!v ? ok(m) : bad(m, `expected nothing, got [${String(v)}]`));

const A = '00000000-0000-0000-0000-00000f910001';
const P = '00000000-0000-0000-0000-00000f910002';
const G = '00000000-0000-0000-0000-00000f910003';
const S1 = '00000000-0000-0000-0000-00000f910010';
const S2 = '00000000-0000-0000-0000-00000f910011';
const S3 = '00000000-0000-0000-0000-00000f910012';

(async () => {
  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
  await query(`DELETE FROM relays WHERE name LIKE 'chk-%'`);
  await query(`DELETE FROM cost_actuals WHERE source='relay-fleet-check'`);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'RelayCo')`, [A]);
  await query(
    `INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type,packaging,segment_dur,dvr_window_sec)
     VALUES ($1,$2,'p','[{"height":0,"bitrate_kbps":128}]','package_only','both',4,60)`, [P, A]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels)
               VALUES ($1,$2,'g',$3,50)`, [G, A, P]);
  await query(
    `INSERT INTO channels(id,group_id,name,status,kind) VALUES
       ($1,$4,'Station One','ended','radio'),
       ($2,$4,'Station Two','ended','radio'),
       ($3,$4,'Station Three','ended','radio')`, [S1, S2, S3, G]);

  // ---- 2. no relays registered -> the environment --------------------------
  console.log('== a deployment with no relays keeps working ==');
  const envT = await resolveRelayFor(S1);
  check('the target comes from the environment', envT.relayId, null);
  truthy('and it still has a host to push to', envT.host);
  const stillNull = await one<any>(`SELECT relay_id FROM channels WHERE id=$1`, [S1]);
  falsy('nothing was assigned, because there was nothing to assign',
    stillNull?.relay_id);

  // ---- 1. assignment, and stickiness ---------------------------------------
  console.log('\n== with relays registered, a station is assigned and STAYS ==');
  const r1 = await one<any>(
    `INSERT INTO relays(name, source_host, source_port, public_base, region)
     VALUES ('chk-alpha','relay-a.internal',8000,'https://a.cdn.example','eu-west-1') RETURNING *`);
  const r2 = await one<any>(
    `INSERT INTO relays(name, source_host, source_port, public_base, region)
     VALUES ('chk-bravo','relay-b.internal',8000,'https://b.cdn.example','eu-west-1') RETURNING *`);

  const t1 = await resolveRelayFor(S1);
  truthy('the station gets a relay', t1.relayId);
  check('and the push address is the relay\'s, not the environment\'s',
    t1.host, t1.relayId === r1.id ? 'relay-a.internal' : 'relay-b.internal');
  check('the listener base follows the assignment',
    t1.publicBase, t1.relayId === r1.id ? 'https://a.cdn.example' : 'https://b.cdn.example');

  const again = await resolveRelayFor(S1);
  check('asking again returns THE SAME relay — a listener URL that moves is broken',
    again.relayId, t1.relayId);
  const persisted = await one<any>(`SELECT relay_id FROM channels WHERE id=$1`, [S1]);
  check('and the assignment is written down, not recomputed', persisted?.relay_id, t1.relayId);

  // Least-loaded: the second station must land on the other relay.
  const t2 = await resolveRelayFor(S2);
  truthy('a second station goes to the LEAST LOADED relay, not the same one',
    t2.relayId !== t1.relayId);

  // ---- draining ------------------------------------------------------------
  console.log('\n== draining stops new stations without touching the old ones ==');
  await query(`UPDATE relays SET state='draining' WHERE id=$1`, [t2.relayId]);
  const t3 = await resolveRelayFor(S3);
  check('a new station skips the draining relay', t3.relayId, t1.relayId);
  const s2Still = await resolveRelayFor(S2);
  check('but the station already on it is NOT moved — it is still broadcasting',
    s2Still.relayId, t2.relayId);

  // ---- offline is the harder statement -------------------------------------
  console.log('\n== offline DOES move a station, because staying is not an option ==');
  await query(`UPDATE relays SET state='offline' WHERE id=$1`, [t2.relayId]);
  await query(`UPDATE relays SET state='active' WHERE id=$1`, [t1.relayId]);
  const s2Moved = await resolveRelayFor(S2);
  truthy('the station is reassigned off the offline relay', s2Moved.relayId !== t2.relayId);
  truthy('a station that cannot go on air is worse than one whose URL changed',
    s2Moved.relayId === t1.relayId);

  // ---- 3. telemetry: absent is not zero ------------------------------------
  console.log('\n== a relay nothing has measured reads as unknown, never as idle ==');
  await query(`UPDATE relays SET state='active' WHERE name LIKE 'chk-%'`);
  const noHost = (await relayHealth()).find((h) => h.relay.name === 'chk-alpha');
  truthy('the relay is listed', noHost);
  check('with no host row there is no sample', noHost?.sample, null);
  check('and it is not marked stale either — there is nothing to be stale',
    noHost?.stale, false);
  truthy('its station count is real', (noHost?.stations ?? 0) > 0);

  const host = await one<any>(
    `INSERT INTO compute_hosts(kind, external_id, instance_type, region, lifecycle, role, first_seen_at)
     VALUES ('ec2','i-chkrelay0001','c6in.large','eu-west-1','on_demand','relay', now() - interval '3 hours')
     RETURNING *`);
  await query(`UPDATE relays SET host_id=$2 WHERE id=$1`, [r1.id, host.id]);

  const unmeasured = (await relayHealth()).find((h) => h.relay.name === 'chk-alpha');
  check('a host with no readings has no sample', unmeasured?.sample, null);
  check('and IS stale, because now there is something we should be measuring',
    unmeasured?.stale, true);
  truthy('uptime comes from when the host was first seen',
    (unmeasured?.uptimeSeconds ?? 0) >= 3 * 3600 - 60);

  await query(
    `INSERT INTO host_samples(host_id, source, cpu_pct, mem_pct, net_in_bps, net_out_bps, tasks_on_host)
     VALUES ($1,'onbox', 12.5, 30.0, 400000, 128000000, 2)`, [host.id]);
  const measured = (await relayHealth()).find((h) => h.relay.name === 'chk-alpha');
  check('a fresh reading is no longer stale', measured?.stale, false);
  check('cpu is reported', measured?.sample?.cpuPct, 12.5);
  // net_out is the number that matters: it IS the egress bill.
  check('and network OUT, which is what the relay actually costs',
    measured?.sample?.netOutBps, 128000000);

  // ---- estimated against actual -------------------------------------------
  console.log('\n== estimated against actual, which is the point of accruing ==');
  await query(
    `INSERT INTO relay_accruals(relay_id, relay_ref, relay_name, instance_type, lifecycle,
                                from_at, to_at, seconds, bytes_out, usd_per_hour, usd_per_gb,
                                est_compute_usd, est_egress_usd, est_usd, indicative)
     VALUES ($1,$1,'chk-alpha','c6in.large','on_demand',
             date_trunc('month', now()), date_trunc('month', now()) + interval '10 hours',
             36000, 200000000000, 0.11340, 0.09000, 1.13, 16.76, 17.89, true)`, [r1.id]);

  const before = (await costComparison(2)).find((c) => c.category === 'relay');
  truthy('the estimate is there', (before?.estimatedUsd ?? 0) > 0);
  check('with no bill entered, actual is NULL and not zero', before?.actualUsd, null);
  check('so there is no variance to report yet', before?.varianceUsd, null);
  truthy('and the estimate says it is indicative, all the way to this line',
    before?.indicative);

  const month = new Date();
  const monthStr = `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, '0')}-01`;
  await query(
    `INSERT INTO cost_actuals(period_month, category, usd, source)
     VALUES ($1::date,'relay',25.00,'relay-fleet-check')
     ON CONFLICT (period_month, category) DO UPDATE SET usd=EXCLUDED.usd`, [monthStr]);

  const after = (await costComparison(2)).find((c) => c.category === 'relay');
  check('once the bill is entered, actual is real', after?.actualUsd, 25);
  check('and the variance is the number the operator wanted',
    after?.varianceUsd, Number((25 - (after?.estimatedUsd ?? 0)).toFixed(2)));
  truthy('with a percentage to go with it', after?.variancePct != null);

  // ---- 4. the boundary -----------------------------------------------------
  console.log('\n== the cost basis is SYSTEM ADMIN only ==');
  //
  // Asserted structurally rather than by calling the API, because the property
  // being protected is that these things HAVE NO TENANT ROUTE — not that a
  // tenant route checks a role. A role check can be edited out in a hurry; a
  // route that does not exist cannot be reached by mistake.
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const platformSrc = readFileSync(join(__dirname, '../src/modules/platform.ts'), 'utf8');
  truthy('the relay fleet is served from the platform surface',
    /platformRouter\.get\(\s*'\/relays'/.test(platformSrc));
  truthy('and it is guarded by requirePlatform',
    /'\/relays'[\s\S]{0,120}requirePlatform/.test(platformSrc));
  truthy('creating a relay needs saas_admin, not merely platform access',
    /platformRouter\.post\(\s*'\/relays',[\s\S]{0,80}requirePlatform\('saas_admin'\)/.test(platformSrc));
  truthy('entering an actual bill needs saas_admin too',
    /'\/costs\/actuals',[\s\S]{0,80}requirePlatform\('saas_admin'\)/.test(platformSrc));

  // The TENANT fleet view must not show relay hosts. Explicit, not accidental:
  // the inner join on instances already excludes them, but that was written for
  // another reason and would stop protecting anything the moment a relay got a
  // task row.
  const hostsSrc = readFileSync(join(__dirname, '../src/services/fleet/hosts.ts'), 'utf8');
  truthy("the tenant host list is filtered to role='compute'",
    /liveHosts[\s\S]{0,2500}h\.role = 'compute'/.test(hostsSrc));

  // The tenant modules must not mention any of it.
  for (const mod of ['radio.ts', 'channels.ts', 'fleet.ts']) {
    const src = readFileSync(join(__dirname, '../src/modules', mod), 'utf8');
    const leaks = /relay_accruals|cost_actuals|FROM relays\b/.test(src);
    leaks
      ? bad(`the tenant module ${mod} does not touch the cost basis`, 'it references it')
      : ok(`the tenant module ${mod} does not touch the cost basis`);
  }

  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
  await query(`DELETE FROM relays WHERE name LIKE 'chk-%'`);
  await query(`DELETE FROM compute_hosts WHERE external_id='i-chkrelay0001'`);
  await query(`DELETE FROM cost_actuals WHERE source='relay-fleet-check'`);
  console.log(`\nrelay-fleet: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('FATAL', e);
  await pool.end().catch(() => {});
  process.exit(1);
});
