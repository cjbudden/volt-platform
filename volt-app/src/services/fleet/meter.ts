// ============================================================================
//  THE METER.
//
//  Turns "a task is running" into billable TIME that survives the run ending,
//  the control plane restarting, and the tick firing twice.
//
//  What it replaces: buildBilling(), which computed `now - launched_at` on
//  every page load and kept nothing. That number was correct while you were
//  looking at it and ceased to exist the moment the run stopped, so "how many
//  billable minutes did this channel use in July" had no answer at all.
//
//  ------------------------------------------------------------------------
//  THE MARK IS THE WHOLE DESIGN.
//
//  `instances.metered_through` says: everything up to this instant is already
//  in the ledger. A tick accrues the window (mark, now] and moves the mark.
//  Two properties fall straight out of that, and neither is available to
//  anything that meters from now():
//
//    RUNNING TWICE IS FREE. The second run finds the mark already at now, so
//    its window is empty and it writes nothing. Two control planes, an
//    operator hitting a manual endpoint, a tick that overlaps a slow previous
//    tick: none of them can double-bill.
//
//    BEING DOWN COSTS NOTHING. The mark does not move while the process is
//    dead, so the next tick accrues the whole gap. An hour of downtime is an
//    hour of catch-up, not an hour of lost usage.
//
//  ------------------------------------------------------------------------
//  WINDOWS ARE CUT AT THE UTC DAY BOUNDARY.
//
//  A run from 23:00 to 01:00 is two days of usage, and a single accrual row
//  spanning both would have to be apportioned by whatever read it later. Every
//  reader would have to implement that apportionment, and they would not all
//  implement it the same way. Cutting at accrual time instead means every
//  roll-up in the system is a plain SUM over rows whose from_at is inside the
//  period, with no arithmetic to get wrong.
//
//  UTC, not the channel's broadcast day. A broadcast day is an editorial
//  concept for scheduling; usage is a wall-clock fact about a machine that was
//  switched on, and two channels on different broadcast days must not report
//  overlapping accounts of the same hour of the same server.
//
//  ------------------------------------------------------------------------
//  A TERMINATED TASK IS METERED TO ITS TERMINATION, ONCE, AND THEN NEVER
//  AGAIN. That is what makes stopping a stream actually stop the meter — the
//  bug this codebase has already had, where an instance row nobody cleared
//  metered forever.
// ============================================================================
import { pool, query } from '../../db';
import { rateFor, costOf } from './rates';

/** Start of the UTC day AFTER the one containing `d`. */
export function nextUtcDay(d: Date): Date {
  const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  n.setUTCDate(n.getUTCDate() + 1);
  return n;
}

export interface MeterResult {
  /** Tasks that had time owed. */
  considered: number;
  /** Ledger rows written. More than `considered` when windows were split. */
  windows: number;
  seconds: number;
  /** Windows written with no rate available. Time is still recorded. */
  unpriced: number;
}

interface Owed {
  id: string;
  channel_id: string | null;
  event_id: string | null;
  host_id: string | null;
  task_kind: string | null;
  instance_type: string | null;
  lifecycle: 'spot' | 'on_demand' | null;
  region: string | null;
  account_id: string | null;
  stream_name: string | null;
  launched_at: Date | null;
  terminated_at: Date | null;
  metered_through: Date | null;
}

/**
 * Everything with time owed, most-overdue first.
 *
 * The account comes from the channel's or event's group, resolved HERE and
 * frozen onto the ledger row, because a channel can be moved between accounts
 * and last month's usage must not move with it.
 *
 * A task whose owner has been deleted yields a null account and is skipped
 * rather than accrued to nobody: the ledger's account_id is NOT NULL by
 * design, since a usage row that cannot be attributed is not usage, it is
 * noise that would inflate every fleet-wide total.
 */
const OWED_SELECT = `
  SELECT i.id, i.channel_id, i.event_id, i.host_id, i.task_kind,
         COALESCE(h.instance_type, i.instance_type)      AS instance_type,
         COALESCE(h.lifecycle, i.lifecycle::text)        AS lifecycle,
         h.region                                        AS region,
         COALESCE(gc.account_id, ge.account_id)          AS account_id,
         COALESCE(c.name, e.name)                        AS stream_name,
         i.launched_at, i.terminated_at, i.metered_through
    FROM instances i
    LEFT JOIN compute_hosts h ON h.id = i.host_id
    LEFT JOIN channels c ON c.id = i.channel_id
    LEFT JOIN groups   gc ON gc.id = c.group_id
    LEFT JOIN events   e ON e.id = i.event_id
    LEFT JOIN groups   ge ON ge.id = e.group_id
   WHERE i.launched_at IS NOT NULL
     AND COALESCE(i.metered_through, i.launched_at) < LEAST(COALESCE(i.terminated_at, $1::timestamptz), $1::timestamptz)`;

/** The tick's work list: everything owed, most-overdue first, claimed. */
const OWED_BATCH = `${OWED_SELECT}
   ORDER BY i.metered_through NULLS FIRST
   LIMIT $2
   FOR UPDATE OF i SKIP LOCKED`;

/** One named task, for the stop path. No lock: accrueInstance takes its own. */
const OWED_ONE = `${OWED_SELECT} AND i.id = $2`;

/**
 * Accrue everything owed as of `now`.
 *
 * SKIP LOCKED rather than a global lock: two control planes both running the
 * meter will divide the work between them instead of one waiting on the other,
 * and neither can touch the same instance row, so the mark can never be moved
 * twice for the same window.
 *
 * Each instance is its own transaction. A single bad row (a rate lookup that
 * throws, a constraint we did not anticipate) rolls back that instance's
 * window and its mark together, so it is retried intact on the next tick
 * rather than half-accrued.
 */
export async function meterOnce(now: Date = new Date(), batch = 500): Promise<MeterResult> {
  const out: MeterResult = { considered: 0, windows: 0, seconds: 0, unpriced: 0 };

  const client = await pool.connect();
  let owed: Owed[];
  try {
    await client.query('BEGIN');
    const res = await client.query<Owed>(OWED_BATCH, [now, batch]);
    owed = res.rows;
    // The lock is released here on purpose. Holding row locks across the whole
    // accrual would keep a transaction open for as long as the batch takes,
    // and every stop/start of every stream in the batch would block behind it.
    // Re-reading the mark inside each per-instance transaction below is what
    // actually guarantees correctness; this pass is only a work list.
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  for (const o of owed) {
    if (!o.account_id) continue;
    out.considered++;
    try {
      const written = await accrueInstance(o, now);
      out.windows += written.windows;
      out.seconds += written.seconds;
      out.unpriced += written.unpriced;
    } catch (e) {
      console.error('[meter] could not accrue instance', o.id, e);
    }
  }
  return out;
}

/**
 * Accrue one task, splitting at UTC midnight, in one transaction.
 *
 * THE MARK IS RE-READ UNDER A ROW LOCK. The work list above was assembled
 * without holding locks, so between then and now another meter run may have
 * advanced this instance. Trusting the stale value would write an overlapping
 * window. Reading it again inside the transaction makes the check-and-write
 * atomic, which is the only place it needs to be.
 */
async function accrueInstance(o: Owed, now: Date): Promise<{ windows: number; seconds: number; unpriced: number }> {
  const client = await pool.connect();
  let windows = 0, seconds = 0, unpriced = 0;
  try {
    await client.query('BEGIN');
    const fresh = await client.query<{ launched_at: Date | null; terminated_at: Date | null; metered_through: Date | null }>(
      `SELECT launched_at, terminated_at, metered_through FROM instances WHERE id = $1 FOR UPDATE`,
      [o.id]
    );
    const row = fresh.rows[0];
    if (!row?.launched_at) { await client.query('ROLLBACK'); return { windows, seconds, unpriced }; }

    let cursor = row.metered_through ?? row.launched_at;
    const end = row.terminated_at && row.terminated_at < now ? row.terminated_at : now;

    const rate = await rateFor(o.instance_type, o.lifecycle, o.region, end);

    // Bounded so a task that somehow presents years of owed time cannot hold
    // one transaction open writing thousands of rows. What is left is picked
    // up by the next tick, because the mark advances as we go.
    const MAX_WINDOWS = 400;
    while (cursor < end && windows < MAX_WINDOWS) {
      const boundary = nextUtcDay(cursor);
      const to = boundary < end ? boundary : end;
      const secs = Math.max(0, Math.round((to.getTime() - cursor.getTime()) / 1000));
      if (secs > 0) {
        const usd = costOf(secs, rate.usdPerHour);
        await client.query(
          `INSERT INTO usage_accruals
             (account_id, instance_id, channel_id, event_id, stream_id, stream_name,
              host_id, task_kind, instance_type, lifecycle, from_at, to_at, seconds,
              usd_per_hour, est_usd, indicative)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          // stream_id duplicates channel_id/event_id deliberately: it has no
          // foreign key, so deleting the channel cannot take its billing
          // history with it. See the column comment in migration 0016.
          [o.account_id, o.id, o.channel_id, o.event_id,
           o.channel_id ?? o.event_id, o.stream_name,
           o.host_id, o.task_kind, o.instance_type, o.lifecycle, cursor, to, secs,
           rate.usdPerHour, usd, rate.indicative]
        );
        windows++; seconds += secs;
        if (rate.usdPerHour == null) unpriced++;
      }
      cursor = to;
    }

    await client.query(`UPDATE instances SET metered_through = $2 WHERE id = $1`, [o.id, cursor]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return { windows, seconds, unpriced };
}

/**
 * Close the meter for a task that has just been terminated.
 *
 * Called from the stop path so a stream that stops at 14:32 shows its final
 * minutes immediately rather than at the next tick. It is not REQUIRED for
 * correctness — the tick would find it — but "I stopped it and the usage
 * figure did not move" reads as a broken meter, and a fix that only becomes
 * true thirty seconds later is not a fix an operator can see.
 */
export async function meterInstanceNow(instanceId: string, now: Date = new Date()): Promise<number> {
  const rows = await query<Owed>(OWED_ONE, [now, instanceId]);
  const o = rows[0];
  if (!o?.account_id) return 0;
  const r = await accrueInstance(o, now);
  return r.seconds;
}
