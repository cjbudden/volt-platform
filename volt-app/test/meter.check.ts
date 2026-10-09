// ============================================================================
//  THE METER — billable time that survives everything that used to lose it.
//
//  Before this existed, "what is this account billable for" had no answer.
//  services/billing.ts computed `now - launched_at` on every page load against
//  an indicative rate and kept nothing, so the moment a run ended its usage
//  ceased to exist. usage_records had been in the schema since 0001 with an
//  index on (account_id, period_start) and had never been written to.
//
//  A meter is easy to write and easy to write WRONG, and every way it goes
//  wrong is quiet: nothing crashes, the numbers merely stop meaning anything.
//  So this suite is organised around the four ways, and each one is a scenario
//  that would have produced a plausible-looking wrong number:
//
//    1. DOUBLE BILLING. The tick fires twice, or two control planes both run
//       it. A meter that accrues "since launch" charges the whole run again
//       every time it runs. Here the mark makes the second pass a no-op, and
//       the assertion is that a second immediate run writes zero rows — not
//       that the totals happen to look right.
//
//    2. LOST TIME. The control plane is down for an hour. A meter that accrues
//       "since the last tick" using an in-memory timestamp loses that hour
//       silently. Here the mark did not move while the process was gone, so
//       the hour is accrued on the next pass.
//
//    3. METERING FOREVER. A task terminates and the row is never closed. This
//       codebase has already had exactly this bug with radio instance rows.
//       A terminated task must accrue up to its termination and then stop,
//       permanently, no matter how many passes run afterwards.
//
//    4. WINDOWS THAT STRADDLE MIDNIGHT. A run from 23:00 to 01:00 is two days
//       of usage. If it is one row, every reader has to apportion it, and they
//       will not all do it the same way. The meter cuts at the UTC boundary so
//       every roll-up is a plain SUM.
//
//  The clock is INJECTED throughout. A meter tested against the real clock can
//  only assert "roughly", and "roughly" is how a billing bug survives review.
//  Every assertion here is exact to the second.
//
//  Usage: DATABASE_URL=... npx tsx test/meter.check.ts
// ============================================================================
import { pool, query, one } from '../src/db';
import { meterOnce, meterInstanceNow, nextUtcDay } from '../src/services/fleet/meter';
import { usageTotals, usagePerStream, usageSeries } from '../src/services/fleet/usage';
import { upsertHost, attachInstanceToHost, retireStaleHosts, liveHosts } from '../src/services/fleet/hosts';
import { regionFromAz, lifecycleFromProvider } from '../src/services/fleet/placement';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected truthy, got [${String(v)}]`));

// Ids namespaced to this suite.
const A  = '00000000-0000-0000-0000-000009930001';
const A2 = '00000000-0000-0000-0000-000009930002';
const P  = '00000000-0000-0000-0000-000009930010';
const G  = '00000000-0000-0000-0000-000009930011';
const G2 = '00000000-0000-0000-0000-000009930012';
const CH_TV    = '00000000-0000-0000-0000-000009930021';
const CH_RADIO = '00000000-0000-0000-0000-000009930022';
const CH_OTHER = '00000000-0000-0000-0000-000009930023';
const EV       = '00000000-0000-0000-0000-000009930031';

const T = (iso: string) => new Date(iso);

async function seed() {
  await query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [[A, A2]]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'MeterCo'),($2,'OtherCo')`, [A, A2]);
  await query(
    `INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type,packaging,segment_dur,dvr_window_sec)
     VALUES ($1,$2,'p','[{"height":720,"bitrate_kbps":2500}]','transcode','both',4,60)`,
    [P, A]
  );
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels)
               VALUES ($1,$2,'g',$3,50)`, [G, A, P]);
  await query(`INSERT INTO groups(id,account_id,name,max_channels)
               VALUES ($1,$2,'g2',50)`, [G2, A2]);
  await query(
    `INSERT INTO channels(id,group_id,name,status,kind)
     VALUES ($1,$4,'News','live','tv'),($2,$4,'Jazz FM','live','radio'),($3,$5,'Not Yours','live','tv')`,
    [CH_TV, CH_RADIO, CH_OTHER, G, G2]
  );
  await query(
    `INSERT INTO events(id,group_id,name,status,scheduled_start,scheduled_end)
     VALUES ($1,$2,'Cup Final','live', now(), now() + interval '2 hours')`,
    [EV, G]
  );
}

/** Insert a task row directly. The meter's input is the row, not the launcher. */
async function task(opts: {
  id: string; channelId?: string; eventId?: string; kind: string;
  launchedAt: Date; terminatedAt?: Date | null; hostId?: string | null;
  instanceType?: string | null; lifecycle?: 'spot' | 'on_demand';
}): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO instances(id, channel_id, event_id, task_arn, is_gpu, lifecycle, role,
                           task_kind, state, launched_at, terminated_at, host_id, instance_type)
     VALUES ($1,$2,$3,$4,false,$5,'primary',$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [opts.id, opts.channelId ?? null, opts.eventId ?? null, `mock:${opts.id}`,
     opts.lifecycle ?? 'on_demand', opts.kind,
     opts.terminatedAt ? 'terminated' : 'running',
     opts.launchedAt, opts.terminatedAt ?? null, opts.hostId ?? null,
     opts.instanceType ?? null]
  );
  return r!.id;
}

const iid = (n: number) => `00000000-0000-0000-0000-0000099301${String(n).padStart(2, '0')}`;

async function accrualsFor(instanceId: string) {
  return query<any>(
    `SELECT from_at, to_at, seconds, task_kind, account_id, usd_per_hour, indicative
       FROM usage_accruals WHERE instance_id = $1 ORDER BY from_at`,
    [instanceId]
  );
}

async function markOf(instanceId: string): Promise<Date | null> {
  const r = await one<any>(`SELECT metered_through FROM instances WHERE id=$1`, [instanceId]);
  return r?.metered_through ?? null;
}

(async () => {
  await seed();
  try {
    // ======================================================================
    console.log('\n== a running task accrues from launch to now ==');
    // ======================================================================
    const t1 = await task({ id: iid(1), channelId: CH_TV, kind: 'transcode',
                            launchedAt: T('2026-03-10T10:00:00Z') });

    const r1 = await meterOnce(T('2026-03-10T10:30:00Z'));
    check('one task was considered', r1.considered, 1);
    check('one window was written', r1.windows, 1);
    check('thirty minutes of it', r1.seconds, 1800);

    const a1 = await accrualsFor(t1);
    check('the window starts at launch', a1[0].from_at.toISOString(), '2026-03-10T10:00:00.000Z');
    check('and ends at the instant asked for', a1[0].to_at.toISOString(), '2026-03-10T10:30:00.000Z');
    check('the kind of work is carried onto the ledger', a1[0].task_kind, 'transcode');
    check('and the account is frozen onto the row', a1[0].account_id, A);
    check('the mark advanced to exactly that instant',
          (await markOf(t1))?.toISOString(), '2026-03-10T10:30:00.000Z');

    // ======================================================================
    console.log('\n== running the meter again accrues NOTHING ==');
    //
    // The failure this prevents: a meter that accrues "since launch" charges
    // the whole run again on every pass. Two control planes, an overlapping
    // slow tick, or an operator poking a manual endpoint would each double the
    // bill, and the resulting number is plausible enough that nobody notices.
    // ======================================================================
    const r2 = await meterOnce(T('2026-03-10T10:30:00Z'));
    check('nothing was considered', r2.considered, 0);
    check('no window was written', r2.windows, 0);
    check('and the ledger still holds exactly one row', (await accrualsFor(t1)).length, 1);

    // Even a meter run BEHIND the mark, which is what a clock skew between two
    // control planes looks like, must not write a negative or duplicate window.
    const r3 = await meterOnce(T('2026-03-10T10:15:00Z'));
    check('a pass with a clock behind the mark writes nothing', r3.windows, 0);
    check('and does not move the mark backwards',
          (await markOf(t1))?.toISOString(), '2026-03-10T10:30:00.000Z');

    // ======================================================================
    console.log('\n== time is not lost while the control plane is down ==');
    //
    // The mark lives in the database, not in the process. An hour of downtime
    // is an hour of catch-up rather than an hour that never happened.
    // ======================================================================
    const r4 = await meterOnce(T('2026-03-10T11:30:00Z'));
    check('the missed hour is accrued', r4.seconds, 3600);
    const a4 = await accrualsFor(t1);
    check('as a second window', a4.length, 2);
    check('that begins exactly where the first ended',
          a4[1].from_at.toISOString(), a4[0].to_at.toISOString());
    check('so the windows do not overlap and do not gap',
          a4.reduce((s: number, w: any) => s + w.seconds, 0), 5400);

    // ======================================================================
    console.log('\n== a terminated task meters to its end, once, forever ==');
    //
    // The bug this codebase has already had: an instance row nobody closed,
    // metering indefinitely. The assertion that matters is not that the final
    // figure is right, it is that it STAYS right after further passes.
    // ======================================================================
    await query(`UPDATE instances SET terminated_at=$2, state='terminated' WHERE id=$1`,
                [t1, T('2026-03-10T12:00:00Z')]);
    const r5 = await meterOnce(T('2026-03-10T13:00:00Z'));
    check('the last half hour before termination is accrued', r5.seconds, 1800);

    const r6 = await meterOnce(T('2026-03-10T14:00:00Z'));
    check('an hour later it accrues nothing', r6.windows, 0);
    const r7 = await meterOnce(T('2026-03-11T10:00:00Z'));
    check('and a day later, still nothing', r7.windows, 0);

    const total = await one<any>(
      `SELECT SUM(seconds)::int AS s FROM usage_accruals WHERE instance_id=$1`, [t1]);
    check('the run totals exactly two hours', total.s, 7200);

    // ======================================================================
    console.log('\n== windows are cut at the UTC day boundary ==');
    //
    // Otherwise a run from 23:00 to 01:00 is one row that every daily report
    // has to apportion, and they will not all apportion it the same way.
    // ======================================================================
    check('nextUtcDay of a mid-day instant is the following midnight',
          nextUtcDay(T('2026-03-10T13:45:12Z')).toISOString(), '2026-03-11T00:00:00.000Z');
    check('and of an exact midnight is the NEXT one, not itself',
          nextUtcDay(T('2026-03-11T00:00:00Z')).toISOString(), '2026-03-12T00:00:00.000Z');

    const t2 = await task({ id: iid(2), channelId: CH_RADIO, kind: 'radio',
                            launchedAt: T('2026-03-20T23:00:00Z') });
    const r8 = await meterOnce(T('2026-03-21T01:00:00Z'));
    check('two hours across midnight is metered as two windows', r8.windows, 2);
    const a8 = await accrualsFor(t2);
    check('the first ends at midnight', a8[0].to_at.toISOString(), '2026-03-21T00:00:00.000Z');
    check('the second starts at midnight', a8[1].from_at.toISOString(), '2026-03-21T00:00:00.000Z');
    check('an hour on the first day', a8[0].seconds, 3600);
    check('and an hour on the second', a8[1].seconds, 3600);
    // Closed here so later scenarios' clocks do not keep accruing it. A task
    // left running IS accrued forward by every subsequent pass, which is the
    // correct behaviour and was what first made this suite's own arithmetic
    // wrong: the fixtures leaked, not the meter.
    await query(`UPDATE instances SET terminated_at=$2, state='terminated' WHERE id=$1`,
                [t2, T('2026-03-21T01:00:00Z')]);

    // A three-day gap is three whole days plus the remainder, not one row.
    const t3 = await task({ id: iid(3), channelId: CH_TV, kind: 'package_only',
                            launchedAt: T('2026-04-01T06:00:00Z') });
    const r9 = await meterOnce(T('2026-04-04T06:00:00Z'));
    check('a three day run is cut into four windows', r9.windows, 4);
    check('and still totals exactly three days', r9.seconds, 3 * 86400);
    await query(`UPDATE instances SET terminated_at=$2, state='terminated' WHERE id=$1`,
                [t3, T('2026-04-04T06:00:00Z')]);

    // ======================================================================
    console.log('\n== seconds are recorded even when the rate is not known ==');
    //
    // The rule that matters most in this file. Time is a fact; cost is an
    // estimate. A task on a host whose type we never learned must still be
    // metered, because un-priced time can be priced later and un-recorded time
    // is gone.
    // ======================================================================
    const unpricedRows = await accrualsFor(t3);
    check('a task with no known instance type is still metered',
          unpricedRows.reduce((s: number, w: any) => s + w.seconds, 0), 3 * 86400);
    check('with a null rate rather than a zero one', unpricedRows[0].usd_per_hour, null);
    check('and is flagged indicative', unpricedRows[0].indicative, true);

    // With a host carrying a known type, the seeded rate is found and frozen.
    const hostId = await upsertHost({
      hostKind: 'ec2', externalId: 'i-meter00000000001', instanceType: 'c6i.xlarge',
      availabilityZone: 'ap-southeast-1b', lifecycle: 'on_demand', vcpus: 4, memoryMib: 8192,
    });
    const t4 = await task({ id: iid(4), eventId: EV, kind: 'transcode',
                            launchedAt: T('2026-05-01T00:00:00Z'), hostId });
    await meterOnce(T('2026-05-01T01:00:00Z'));
    const a10 = await accrualsFor(t4);
    check('a task on a known host takes the rate from the table',
          Number(a10[0].usd_per_hour), 0.17);
    check('and one hour costs exactly that', Number(
      (await one<any>(`SELECT est_usd FROM usage_accruals WHERE instance_id=$1`, [t4])).est_usd
    ), 0.17);

    // ======================================================================
    console.log('\n== the host registry converges rather than accumulating ==');
    // ======================================================================
    const again = await upsertHost({
      hostKind: 'ec2', externalId: 'i-meter00000000001',
      // A THINNER observation: no instance type this time, which is what a
      // throttled describe looks like. It must not erase what we know.
      instanceType: null, availabilityZone: null, lifecycle: null, vcpus: null, memoryMib: null,
    });
    check('the same machine is the same row', again, hostId);
    const h = await one<any>(`SELECT * FROM compute_hosts WHERE id=$1`, [hostId]);
    check('a thinner observation does not erase the instance type', h.instance_type, 'c6i.xlarge');
    check('nor the availability zone', h.availability_zone, 'ap-southeast-1b');
    check('the region was derived from the AZ', h.region, 'ap-southeast-1');
    check('regionFromAz refuses a string that is not an AZ', regionFromAz('not-an-az'), null);
    check('and lifecycle from an unrecognised provider is the SAFE direction',
          lifecycleFromProvider('volt-mystery'), 'on_demand');
    check('while a spot provider is read as spot',
          lifecycleFromProvider('volt-spot'), 'spot');

    // ======================================================================
    console.log('\n== a host is not retired while it still carries work ==');
    // ======================================================================
    await attachInstanceToHost(t4, hostId, {
      hostKind: 'ec2', externalId: 'i-meter00000000001', instanceType: 'c6i.xlarge',
      containerInstanceArn: 'arn:aws:ecs:ap-southeast-1:1:container-instance/abc',
      capacityProvider: 'volt-ondemand', cpuUnits: 2048, taskMemoryMib: 4096,
    });
    const inst4 = await one<any>(`SELECT * FROM instances WHERE id=$1`, [t4]);
    check('the task records the machine it landed on', inst4.ec2_instance_id, 'i-meter00000000001');
    check('and the container instance it was placed through',
          inst4.container_instance_arn, 'arn:aws:ecs:ap-southeast-1:1:container-instance/abc');
    check('and what it reserved', inst4.cpu_units, 2048);

    await query(`UPDATE compute_hosts SET last_seen_at = now() - interval '2 hours' WHERE id=$1`, [hostId]);
    check('a stale host carrying a live task is NOT retired', await retireStaleHosts(60), 0);

    await query(`UPDATE instances SET terminated_at=$2, state='terminated' WHERE id=$1`,
                [t4, T('2026-05-01T01:00:00Z')]);
    check('once empty and unseen, it is retired', await retireStaleHosts(60), 1);
    const gone = await one<any>(`SELECT state FROM compute_hosts WHERE id=$1`, [hostId]);
    check('as gone, not deleted', gone.state, 'gone');
    truthy('so the ledger can still name the machine that ran the work',
           (await accrualsFor(t4))[0]);

    // ======================================================================
    console.log('\n== usage reads back per account, per stream, per period ==');
    // ======================================================================
    // Another account's channel, running the whole time. It must appear
    // nowhere in this account's figures.
    const tOther = await task({ id: iid(9), channelId: CH_OTHER, kind: 'transcode',
                               launchedAt: T('2026-03-10T00:00:00Z'),
                               terminatedAt: T('2026-03-11T00:00:00Z') });
    await meterOnce(T('2026-03-11T00:00:00Z'));
    truthy('the other account accrued its own day', (await accrualsFor(tOther)).length > 0);

    const perStream = await usagePerStream(A, T('2026-05-01T02:00:00Z'));
    const names = perStream.map((s) => s.name).sort();
    check('only this account\'s streams are listed', names.join(','), 'Cup Final,Jazz FM,News');
    truthy('the other account\'s channel is absent',
           !perStream.some((s) => s.id === CH_OTHER));

    const news = perStream.find((s) => s.id === CH_TV)!;
    // News ran t1 (2h on 10 March) and t3 (3 days from 1 April).
    check('a channel\'s all-time total spans every run it ever had',
          news.allTimeSeconds, 7200 + 3 * 86400);
    check('and its kind is reported', news.kind, 'channel');
    const jazz = perStream.find((s) => s.id === CH_RADIO)!;
    check('a radio station is identified as one', jazz.channelKind, 'radio');
    check('with its own two hours', jazz.allTimeSeconds, 7200);

    const finalUsage = perStream.find((s) => s.id === EV)!;
    check('an event carries usage exactly like a channel', finalUsage.allTimeSeconds, 3600);
    check('and is typed as an event', finalUsage.kind, 'event');

    // Today / month, asked as of a date inside the event's run.
    const asOf = T('2026-05-01T02:00:00Z');
    const totals = await usageTotals(A, asOf);
    check('the month total covers only that month', totals.monthSeconds, 3600);
    check('the day total covers only that day', totals.todaySeconds, 3600);
    check('and all time covers everything', totals.allTimeSeconds, 7200 + 7200 + 3 * 86400 + 3600);
    check('one distinct server was used that month', totals.serversMonth, 1);

    const series = await usageSeries(A, 'month', 12);
    const months = series.map((b) => b.periodStart.slice(0, 7));
    check('the series has one bucket per month with usage', months.join(','), '2026-05,2026-04,2026-03');
    const march = series.find((b) => b.periodStart.startsWith('2026-03'))!;
    check('March holds both the television run and the station',
          march.seconds, 7200 + 7200);
    check('split by the kind of work: transcode', march.byTaskKind.transcode, 7200);
    check('and radio', march.byTaskKind.radio, 7200);

    // ======================================================================
    console.log('\n== stopping a stream settles the meter immediately ==');
    // ======================================================================
    const t5 = await task({ id: iid(5), channelId: CH_RADIO, kind: 'radio',
                           launchedAt: T('2026-06-01T00:00:00Z') });
    await meterOnce(T('2026-06-01T00:10:00Z'));
    await query(`UPDATE instances SET terminated_at=$2, state='terminated' WHERE id=$1`,
                [t5, T('2026-06-01T00:25:00Z')]);
    const settled = await meterInstanceNow(t5, T('2026-06-01T00:25:00Z'));
    check('the final fifteen minutes are settled on the spot', settled, 900);
    check('and settling again adds nothing',
          await meterInstanceNow(t5, T('2026-06-01T00:25:00Z')), 0);

    // ======================================================================
    console.log('\n== billing outlives the channel it billed for ==');
    //
    // This started as a test that a task with no owner is not accrued to
    // nobody, and the schema turned out to already guarantee it: instances
    // CHECKs that one of channel_id/event_id is set, and migration 0013 made
    // both owners CASCADE precisely so an ownerless task cannot exist. Good.
    //
    // The interesting case is the one behind it. Deleting a channel cascades
    // its instance rows away and NULLs usage_accruals.channel_id. If the
    // roll-up grouped on that column, deleting a channel would retroactively
    // erase months of already-reported usage: the account total would survive
    // while "which channel used those hours" silently became unknown, for
    // periods that had already been reported. That is why the ledger carries
    // stream_id with no foreign key and a snapshot of the name beside it.
    // ======================================================================
    const doomed = '00000000-0000-0000-0000-000009930029';
    await query(`INSERT INTO channels(id,group_id,name,status,kind)
                 VALUES ($1,$2,'Doomed Channel','live','tv')`, [doomed, G]);
    const t7 = await task({ id: iid(10), channelId: doomed, kind: 'transcode',
                            launchedAt: T('2026-02-01T00:00:00Z'),
                            terminatedAt: T('2026-02-01T04:00:00Z') });
    await meterOnce(T('2026-02-02T00:00:00Z'));
    check('the doomed channel accrued four hours',
          (await accrualsFor(t7)).reduce((s: number, w: any) => s + w.seconds, 0), 14400);

    await query(`DELETE FROM channels WHERE id=$1`, [doomed]);
    check('deleting the channel cascades its task rows away',
          (await query(`SELECT id FROM instances WHERE id=$1`, [t7])).length, 0);
    const surviving = await query<any>(
      `SELECT stream_id, stream_name, channel_id, seconds FROM usage_accruals WHERE stream_id=$1`,
      [doomed]);
    truthy('but the ledger rows survive', surviving.length > 0);
    check('with channel_id nulled by the foreign key', surviving[0].channel_id, null);
    check('and stream_id intact, because it has no foreign key to null',
          surviving[0].stream_id, doomed);
    check('carrying the name the channel had at the time',
          surviving[0].stream_name, 'Doomed Channel');

    const afterDelete = await usagePerStream(A, T('2026-05-01T02:00:00Z'));
    const ghost = afterDelete.find((x) => x.id === doomed);
    truthy('so a deleted channel still appears in the usage report', !!ghost);
    check('under its remembered name', ghost?.name, 'Doomed Channel');
    check('with its hours intact', ghost?.allTimeSeconds, 14400);

    // ======================================================================
    console.log('\n== live hosts report streams, not tasks ==');
    //
    // One channel with an encoder AND a captions add-on is ONE stream on the
    // host. Counting tasks would report the host as twice as loaded as it is,
    // which is the number an operator would act on.
    // ======================================================================
    const h2 = await upsertHost({
      hostKind: 'ec2', externalId: 'i-meter00000000002', instanceType: 'c6i.2xlarge',
      availabilityZone: 'ap-southeast-1a', lifecycle: 'spot', vcpus: 8, memoryMib: 16384,
    });
    await task({ id: iid(7), channelId: CH_TV, kind: 'transcode',
                 launchedAt: T('2026-08-01T00:00:00Z'), hostId: h2 });
    await task({ id: iid(8), channelId: CH_TV, kind: 'captions',
                 launchedAt: T('2026-08-01T00:00:00Z'), hostId: h2 });
    const hosts = await liveHosts();
    const shared = hosts.find((x) => x.external_id === 'i-meter00000000002')!;
    check('two tasks are on the host', shared.tasks, 2);
    check('but they are one stream', shared.streams, 1);
    truthy('and both kinds of work are named',
           shared.task_kinds.includes('transcode') && shared.task_kinds.includes('captions'));
  } finally {
    await query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [[A, A2]]).catch(() => {});
    await query(`DELETE FROM compute_hosts WHERE external_id LIKE 'i-meter%'`).catch(() => {});
  }

  console.log(`\nmeter: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
