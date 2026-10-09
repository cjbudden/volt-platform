// ============================================================================
//  ONE PLACE OWNS `on_air`, AND IT OWNS THE LEDGER WITH IT.
//
//  The column and the history are not two facts that happen to agree. They are
//  one fact recorded twice, and the only way to keep them that way is to make
//  it impossible to write one without the other.
//
//  THIS IS THE ACTUAL REQUIREMENT, not the table. Four places used to run
//  `UPDATE channels SET on_air = ...` and they already disagreed about whether
//  to record anything: radio wrote an event, channels wrote nothing at all. Any
//  fifth caller would have had to remember, and the reason to expect it would
//  not is that the previous four did not. So the column moves behind this
//  function and nothing else touches it -- which a check suite asserts by
//  reading the source, because a convention nobody can break is worth more than
//  a convention everybody agrees with.
//
//  IDEMPOTENT ON PURPOSE. Going on air when already on air is not an error and
//  must not open a second window: the partial unique index would reject it, and
//  a caller that has to catch a constraint violation to do the ordinary thing
//  is a caller that will eventually swallow a real one. Asking for the state it
//  is already in does nothing and says so.
//
//  THE LEDGER IS WRITTEN INSIDE THE SAME TRANSACTION as the column. A process
//  that dies between the two writes is the whole problem this file exists to
//  prevent; leaving them separate would trade a boolean with no history for a
//  boolean that disagrees with its history, which is worse, because the second
//  one looks like it works.
// ============================================================================
import { pool, query, one } from '../db';

export type AirKind = 'channel' | 'radio' | 'event';

/** Why a window closed. An availability figure that cannot separate an operator
 *  finishing a broadcast from a stream falling over is not worth signing. */
export type CloseReason = 'operator' | 'stream stopped' | 'schedule' | 'fault' | 'reconciled';

export interface AirChange {
  /** True when this call actually changed the state. False when it was already there. */
  changed: boolean;
  onAir: boolean;
  /** The window this call opened or closed, when it changed anything. */
  sessionId: string | null;
}

/**
 * Put a stream on or off air, and record the window.
 *
 * The row is read inside the transaction so the snapshot of the name belongs to
 * the moment the window opened, and so two concurrent calls cannot both decide
 * they are the one making the change.
 */
export async function setOnAir(
  kind: AirKind,
  id: string,
  on: boolean,
  opts: { actor?: string | null; reason?: CloseReason } = {}
): Promise<AirChange> {
  const actor = opts.actor ?? null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // FOR UPDATE: the state we are about to change must not move under us.
    // Without it, two operators pressing the button at the same moment can both
    // read `false`, both decide they are opening the window, and the second
    // insert dies on the unique index -- correct, but as a 500 rather than as
    // the no-op it should be.
    const row = kind === 'event'
      ? (await client.query(
          `SELECT e.id, e.name, g.account_id,
                  (e.public_start IS NOT NULL AND e.public_end IS NULL) AS on_air
             FROM events e JOIN groups g ON g.id = e.group_id
            WHERE e.id = $1 FOR UPDATE OF e`, [id])).rows[0]
      : (await client.query(
          `SELECT c.id, c.name, c.on_air, g.account_id
             FROM channels c JOIN groups g ON g.id = c.group_id
            WHERE c.id = $1 FOR UPDATE OF c`, [id])).rows[0];

    if (!row) { await client.query('ROLLBACK'); throw new Error(`no such ${kind}: ${id}`); }

    // ALREADY THERE. Not an error, not a second window, and not a lie in the
    // ledger either: nothing happened, so nothing is recorded.
    if (!!row.on_air === on) {
      await client.query('COMMIT');
      return { changed: false, onAir: on, sessionId: null };
    }

    let sessionId: string | null = null;

    if (on) {
      if (kind !== 'event') {
        await client.query(`UPDATE channels SET on_air = true, updated_at = now() WHERE id = $1`, [id]);
      }
      const ins = await client.query(
        `INSERT INTO air_sessions
           (account_id, stream_kind, stream_id, stream_name, channel_id, event_id, from_at, opened_by)
         VALUES ($1,$2,$3,$4,$5,$6, now(), $7)
         RETURNING id`,
        [row.account_id, kind, id, row.name,
         kind === 'event' ? null : id, kind === 'event' ? id : null, actor]);
      sessionId = String(ins.rows[0].id);
    } else {
      if (kind !== 'event') {
        await client.query(`UPDATE channels SET on_air = false, updated_at = now() WHERE id = $1`, [id]);
      }
      // Close the OPEN window, whichever it is. Keyed on to_at IS NULL rather
      // than on an id the caller carries, because the caller taking a stream off
      // air is very often not the one that put it on.
      const upd = await client.query(
        `UPDATE air_sessions
            SET to_at = now(),
                seconds = GREATEST(0, EXTRACT(EPOCH FROM (now() - from_at))::int),
                closed_by = $2, close_reason = $3
          WHERE stream_id = $1 AND to_at IS NULL
          RETURNING id`,
        [id, actor, opts.reason ?? 'operator']);
      // No open row is possible and is not a fault: a stream that was on air
      // before this ledger existed has nothing to close. The column still moves.
      sessionId = upd.rows[0] ? String(upd.rows[0].id) : null;
    }

    await client.query('COMMIT');
    return { changed: true, onAir: on, sessionId };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Close any window whose stream is not running.
 *
 * A control plane killed mid-broadcast leaves a window open, and an open window
 * grows on its own: every read of "hours on air" would include the time since
 * the process died. Called from the same reconciliation that already corrects a
 * stale `status`, and it closes at `now()` rather than guessing when the stream
 * actually stopped, marked `reconciled` so the report can say the end time is
 * approximate rather than pretending it is measured.
 */
export async function closeOrphanAirSessions(): Promise<number> {
  // THE COLUMN COMES WITH IT, and the first version of this function forgot,
  // which its own suite caught immediately. Closing the window while leaving
  // `on_air = true` produces exactly the state the header of this file warns
  // about: a boolean that disagrees with its own history, which is worse than
  // a boolean with no history because it looks like it works. The next call to
  // setOnAir would then see "already on air", decline to change anything, and
  // silently never open the window again.
  const rows = await query<{ id: string; stream_id: string }>(
    `WITH closed AS (
       UPDATE air_sessions a
          SET to_at = now(),
              seconds = GREATEST(0, EXTRACT(EPOCH FROM (now() - a.from_at))::int),
              close_reason = 'reconciled'
        WHERE a.to_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM instances i
             WHERE i.terminated_at IS NULL
               AND COALESCE(i.channel_id, i.event_id) = a.stream_id)
        RETURNING a.id, a.stream_id
     ), flag AS (
       UPDATE channels c SET on_air = false, updated_at = now()
        WHERE c.id IN (SELECT stream_id FROM closed) AND c.on_air
       RETURNING c.id
     )
     SELECT id, stream_id FROM closed`);
  if (rows.length) {
    console.log(`[air] closed ${rows.length} air session(s) whose stream is not running`);
  }
  return rows.length;
}

export interface AirTotals {
  /** Completed windows in range, plus the open one clipped to `to`. */
  seconds: number;
  sessions: number;
  /** True when a window is still open, so the total is still moving. */
  live: boolean;
}

/**
 * Air seconds for one stream over a period.
 *
 * CLIPPED TO THE WINDOW, not counted whole. A broadcast that started before the
 * period and ended inside it contributes only the part that falls in range;
 * counting it whole is how a monthly report comes to exceed the month.
 */
export async function airTotals(streamId: string, from: Date, to: Date): Promise<AirTotals> {
  const r = await one<any>(
    `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (
              LEAST(COALESCE(to_at, now()), $3::timestamptz)
              - GREATEST(from_at, $2::timestamptz)))), 0)::int AS seconds,
            count(*)::int AS sessions,
            bool_or(to_at IS NULL) AS live
       FROM air_sessions
      WHERE stream_id = $1
        AND from_at < $3::timestamptz
        AND COALESCE(to_at, now()) > $2::timestamptz`,
    [streamId, from.toISOString(), to.toISOString()]);
  return {
    seconds: Math.max(0, Number(r?.seconds ?? 0)),
    sessions: Number(r?.sessions ?? 0),
    live: !!r?.live,
  };
}

/** The windows themselves, newest first, for the per-stream report. */
export async function airSessions(streamId: string, from: Date, to: Date) {
  return query<any>(
    `SELECT id, stream_kind, stream_name, from_at, to_at, seconds,
            opened_by, closed_by, close_reason
       FROM air_sessions
      WHERE stream_id = $1
        AND from_at < $3::timestamptz
        AND COALESCE(to_at, now()) > $2::timestamptz
      ORDER BY from_at DESC`,
    [streamId, from.toISOString(), to.toISOString()]);
}
