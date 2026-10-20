// ============================================================================
//  OPERATOR SOURCE CONTROL: switch source / force slate or loop, on a running
//  encoder wherever it runs.
//
//  The Failover panel (POST /api/channels/:id/failover-test) used to write a
//  control file into the channel's origin directory ON THE CONTROL PLANE'S
//  DISK, which the encoder's source selector and playout read. That works
//  when both run on one machine. On ECS the encoder is another task on
//  another host and never saw it, so "force slate" and "switch to backup" did
//  nothing in production.
//
//  Now the choice is a stream event ('failover.control', kept with who made
//  it, so the QC log shows it) and the encoder receives it on the timed-events
//  poll it already makes every few seconds (GET /api/streams/:id/timed-events,
//  `control.failover`). It writes the same local control file, so the
//  selector and playout are unchanged. A choice belongs to the run it was made
//  in: an event newer than the stream's latest channel.start, so a restart is
//  always back to automatic, as the local file's removal at start already
//  guaranteed.
// ============================================================================
import { one } from '../db';

export const FAILOVER_MODES = ['auto', 'primary_down', 'backup', 'slate', 'loop'] as const;
export type FailoverMode = typeof FAILOVER_MODES[number];
export type StreamKind = 'channel' | 'event';

export interface FailoverControl { mode: FailoverMode; at: string | null; by: string | null }

const col = (kind: StreamKind) => (kind === 'event' ? 'event_id' : 'channel_id');

/** Record an operator's choice for the run now in progress. */
export async function setFailoverControl(kind: StreamKind, id: string, mode: FailoverMode, by: string | null): Promise<FailoverControl> {
  const row = await one<any>(
    `INSERT INTO stream_events (${col(kind)}, type, detail, ts) VALUES ($1, 'failover.control', $2, now()) RETURNING ts`,
    [id, JSON.stringify({ mode, by })]);
  return { mode, at: row?.ts ? new Date(row.ts).toISOString() : null, by };
}

/**
 * The control in force for the current run: the newest failover.control that
 * is newer than the newest channel.start. One indexed read, so the encoder's
 * poll can ask every few seconds.
 */
export async function currentFailoverControl(kind: StreamKind, id: string): Promise<FailoverControl> {
  const row = await one<any>(
    `SELECT type, detail, ts FROM stream_events
      WHERE ${col(kind)} = $1 AND type IN ('failover.control', 'channel.start')
      ORDER BY ts DESC, id DESC LIMIT 1`, [id]);
  if (!row || row.type !== 'failover.control') return { mode: 'auto', at: null, by: null };
  const d = typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail ?? {};
  const mode = (FAILOVER_MODES as readonly string[]).includes(d.mode) ? d.mode as FailoverMode : 'auto';
  return { mode, at: new Date(row.ts).toISOString(), by: d.by ?? null };
}
