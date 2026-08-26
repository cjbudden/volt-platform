// ============================================================================
//  RECORDING CONTAINERS — the broadcast-day grouping.
//
//  A container is not media. It is the answer to "which broadcast day does this
//  belong to", frozen at capture time along with the timezone and anchor that
//  produced it. Freezing matters: if the tz and anchor were read from the
//  channel at query time, an operator editing the channel would retroactively
//  rewrite which day historical recordings belong to, and an archive that
//  reshuffles itself when you change a setting is not an archive.
//
//  Containers are created lazily. There is no nightly job creating empty days:
//  a container exists because something was recorded into it.
// ============================================================================
import { one, query } from '../db';
import { broadcastDayOf, broadcastDaysBetween, type BroadcastDay } from './broadcastDay';
import { channelDayConfig } from './dayparts';

export type RecordingType =
  | 'tv_channel' | 'radio_station' | 'audio_stream' | 'event' | 'simulcast' | 'ad_hoc';

export interface ContainerRow {
  id: string;
  channel_id: string | null;
  event_id: string | null;
  recording_type: RecordingType;
  broadcast_day: string;
  tz: string;
  anchor_hour: number;
  starts_at_ms: string | number;
  ends_at_ms: string | number;
  state: 'open' | 'closed';
}

/** What a source IS, for the type column. Derived once, then stored. */
export async function recordingTypeFor(
  channelId: string | null, eventId: string | null
): Promise<RecordingType> {
  if (eventId) return 'event';
  if (!channelId) return 'ad_hoc';
  const c = await one<any>(
    `SELECT radio_config, kind FROM channels WHERE id = $1`, [channelId]
  );
  if (!c) return 'ad_hoc';
  if (c.radio_config != null) return 'radio_station';
  return c.kind === 'radio' ? 'audio_stream' : 'tv_channel';
}

/**
 * The container holding an instant, created if it does not exist yet.
 *
 * Concurrency-safe by construction: the unique index on (channel, day) is the
 * arbiter, and a losing insert falls through to a select rather than throwing.
 * Two encoders rolling at the same moment therefore cannot make two containers
 * for one day.
 */
export async function containerFor(
  opts: { channelId?: string | null; eventId?: string | null; atMs: number }
): Promise<ContainerRow> {
  const { channelId = null, eventId = null, atMs } = opts;
  if (!channelId && !eventId) throw new Error('containerFor needs a channel or an event');

  const cfg = channelId
    ? await channelDayConfig(channelId)
    : { tz: 'Europe/London', anchorHour: 6, presetId: null };
  const day = broadcastDayOf(atMs, cfg.tz, cfg.anchorHour);
  const type = await recordingTypeFor(channelId, eventId);

  const col = channelId ? 'channel_id' : 'event_id';
  const owner = channelId ?? eventId;

  const inserted = await one<ContainerRow>(
    `INSERT INTO recording_containers
       (${col}, recording_type, broadcast_day, tz, anchor_hour, starts_at_ms, ends_at_ms, state)
     VALUES ($1, $2::recording_type, $3::date, $4, $5, $6, $7, 'open')
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [owner, type, day.day, day.tz, day.anchorHour, day.startMs, day.endMs]
  );
  if (inserted) return inserted;

  const existing = await one<ContainerRow>(
    `SELECT * FROM recording_containers WHERE ${col} = $1 AND broadcast_day = $2::date`,
    [owner, day.day]
  );
  if (!existing) throw new Error(`container for ${owner} on ${day.day} vanished between insert and select`);
  return existing;
}

/** Attach a recording to its container, creating the container if needed. */
export async function attachRecording(recordingId: string): Promise<ContainerRow | null> {
  const rec = await one<any>(`SELECT * FROM recordings WHERE id = $1`, [recordingId]);
  if (!rec) return null;
  const container = await containerFor({
    channelId: rec.channel_id, eventId: rec.event_id, atMs: Number(rec.start_epoch_ms),
  });
  await query(
    `UPDATE recordings SET container_id = $2,
            recording_type = COALESCE(recording_type, $3::recording_type)
      WHERE id = $1`,
    [recordingId, container.id, container.recording_type]
  );
  return container;
}

/** Close containers whose broadcast day has ended and hold no open recording. */
export async function closeFinishedContainers(): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE recording_containers c SET state = 'closed', closed_at = now()
      WHERE c.state = 'open'
        AND c.ends_at_ms < (extract(epoch from now()) * 1000)::bigint
        AND NOT EXISTS (
          SELECT 1 FROM recordings r
           WHERE r.container_id = c.id AND r.status = 'recording')
      RETURNING c.id`
  );
  return rows.length;
}

/**
 * Backfill: give every existing recording a container.
 *
 * Runs once at boot and is a no-op afterwards. Existing rows keep their
 * `day_utc` and their unique index untouched — this only ADDS the grouping, so
 * the old roll logic continues to work while the transition happens.
 */
export async function backfillContainers(limit = 5000): Promise<number> {
  const orphans = await query<any>(
    `SELECT id FROM recordings WHERE container_id IS NULL ORDER BY start_epoch_ms LIMIT $1`, [limit]
  );
  let done = 0;
  for (const r of orphans) {
    try { await attachRecording(r.id); done++; }
    catch (e) { console.error('[containers] backfill failed for', r.id, e); }
  }
  if (done) console.log(`[containers] backfilled ${done} recording(s) into broadcast-day containers`);
  return done;
}

export interface ContainerSummary extends Omit<ContainerRow, 'starts_at_ms' | 'ends_at_ms'> {
  startsAtMs: number;
  endsAtMs: number;
  recordings: number;
  recordedMs: number;
  /** Recorded milliseconds as a share of the day's real length, which is 23 or
   *  25 hours on a clock-change day. */
  coveragePct: number;
}

/** Containers overlapping a window, with their coverage. */
export async function containersInRange(
  ownerKind: 'channel' | 'event', ownerId: string, fromMs: number, toMs: number
): Promise<ContainerSummary[]> {
  const col = ownerKind === 'channel' ? 'channel_id' : 'event_id';
  const rows = await query<any>(
    // broadcast_day is rendered as TEXT deliberately. A Postgres DATE arrives as
    // a JS Date at UTC midnight, and a broadcast day does not start at UTC
    // midnight — it starts at the anchor, 05:00Z for a UK summer day. Serialising
    // the Date would hand the UI a timestamp that looks authoritative and is five
    // hours wrong. The day is a LABEL; keep it a label.
    `SELECT c.id, c.channel_id, c.event_id, c.recording_type,
            to_char(c.broadcast_day, 'YYYY-MM-DD') AS broadcast_day,
            c.tz, c.anchor_hour, c.starts_at_ms, c.ends_at_ms, c.state,
            count(r.id)::int AS recordings,
            COALESCE(sum(
              LEAST(COALESCE(r.end_epoch_ms, (extract(epoch from now())*1000)::bigint), c.ends_at_ms)
              - GREATEST(r.start_epoch_ms, c.starts_at_ms)
            ), 0)::bigint AS recorded_ms
       FROM recording_containers c
       LEFT JOIN recordings r ON r.container_id = c.id
      WHERE c.${col} = $1 AND c.ends_at_ms > $2 AND c.starts_at_ms < $3
      GROUP BY c.id
      ORDER BY c.starts_at_ms`,
    [ownerId, fromMs, toMs]
  );
  return rows.map((r) => {
    const startsAtMs = Number(r.starts_at_ms);
    const endsAtMs = Number(r.ends_at_ms);
    const recordedMs = Math.max(0, Number(r.recorded_ms));
    const dayMs = endsAtMs - startsAtMs;
    return {
      ...r,
      startsAtMs, endsAtMs, recordedMs,
      recordings: r.recordings,
      coveragePct: dayMs > 0 ? Math.round((Math.min(recordedMs, dayMs) / dayMs) * 1000) / 10 : 0,
    };
  });
}

/** Broadcast days spanning a window for a channel, whether or not they exist yet. */
export async function daysForChannel(
  channelId: string, fromMs: number, toMs: number
): Promise<BroadcastDay[]> {
  const cfg = await channelDayConfig(channelId);
  return broadcastDaysBetween(fromMs, toMs, cfg.tz, cfg.anchorHour);
}
