// ============================================================================
//  MEDIA OBJECTS — the lifecycle, and the one question it exists to answer:
//  can this be read right now, and if not, what is happening and when?
//
//  The state machine is deliberately explicit rather than implied by columns.
//  Every transition is checked against what is legal from the current state, and
//  every transition is logged with what asked for it. Both matter for the same
//  reason: when a recording is missing, the first question is always whether a
//  rule deleted it, someone deleted it, or it was never written, and a lifecycle
//  that cannot answer that is not one you can put an archive behind.
// ============================================================================
import { one, query } from '../../db';
import {
  capabilities, isImmediate, restoreWindowMs, storageDriver,
  type RestoreSpeed, type StorageTier,
} from './storage';
import { config } from '../../config';

export type MediaState =
  | 'pending' | 'writing' | 'available' | 'archiving' | 'archived'
  | 'restoring' | 'restored' | 'deleting' | 'deleted';

export interface MediaObject {
  id: string;
  recording_id: string | null;
  vod_asset_id: string | null;
  channel_id: string | null;
  event_id: string | null;
  logical_key: string;
  kind: string;
  rendition: string | null;
  state: MediaState;
  bytes: string | number | null;
  duration_ms: string | number | null;
  segment_count: number | null;
  checksum: string | null;
  retain_until: string | null;
  hold: boolean;
  hold_reason: string | null;
  restore_requested_at: string | null;
  restore_expected_by: string | null;
  restore_expires_at: string | null;
  restore_tier: string | null;
  last_error: string | null;
}

export interface MediaLocation {
  id: string;
  object_id: string;
  tier: StorageTier;
  uri: string;
  bytes: string | number | null;
  present: boolean;
  verified_at: string | null;
}

/**
 * What may follow what.
 *
 * Written out rather than inferred so an illegal move is a caught error at the
 * point it is attempted, not a row in a state nothing knows how to leave. The
 * two that look surprising both earn their place: `archived -> deleting` is a
 * rule deleting something without restoring it first, which is the ordinary end
 * of a ladder; and `restored -> archived` is a restored copy LAPSING, which
 * happens on a timer with nobody asking for it.
 */
const LEGAL: Record<MediaState, MediaState[]> = {
  pending:   ['writing', 'available', 'deleting', 'deleted'],
  writing:   ['available', 'deleting', 'deleted'],
  available: ['archiving', 'deleting', 'deleted', 'available'],
  archiving: ['archived', 'available', 'deleting'],     // back to available if it fails
  archived:  ['restoring', 'deleting', 'deleted'],
  restoring: ['restored', 'archived', 'deleting'],      // back to archived if it fails
  restored:  ['archived', 'archiving', 'deleting', 'deleted'],
  deleting:  ['deleted', 'available', 'archived'],      // back if the delete fails
  deleted:   [],                                        // terminal, and a tombstone
};

export class IllegalTransition extends Error {
  constructor(public from: MediaState, public to: MediaState) {
    super(`A media object cannot go from ${from} to ${to}.`);
    this.name = 'IllegalTransition';
  }
}

export async function transition(
  objectId: string, to: MediaState,
  opts: { action: string; actor?: string; tier?: StorageTier; detail?: string; error?: string } = { action: 'transition' }
): Promise<MediaObject> {
  const obj = await one<MediaObject>(`SELECT * FROM media_objects WHERE id = $1`, [objectId]);
  if (!obj) throw new Error(`media object ${objectId} not found`);
  if (obj.state === to && to !== 'available') return obj;
  if (!LEGAL[obj.state].includes(to)) throw new IllegalTransition(obj.state, to);

  const updated = await one<MediaObject>(
    `UPDATE media_objects
        SET state = $2::media_state,
            last_error = $3,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [objectId, to, opts.error ?? null]
  );
  await query(
    `INSERT INTO media_events (object_id, from_state, to_state, action, tier, actor, detail)
     VALUES ($1, $2::media_state, $3::media_state, $4, $5::storage_tier, $6, $7)`,
    [objectId, obj.state, to, opts.action, opts.tier ?? null, opts.actor ?? 'system', opts.detail ?? null]
  );
  return updated!;
}

/**
 * Declare a piece of media, and where a copy of it is.
 *
 * Idempotent on (owner, logical_key): re-registering an object that already
 * exists updates its size and confirms its location rather than making a second
 * row. That matters because registration runs on every boot reconciliation.
 */
export async function registerObject(opts: {
  recordingId?: string | null;
  vodAssetId?: string | null;
  channelId?: string | null;
  eventId?: string | null;
  logicalKey: string;
  kind: string;
  rendition?: string | null;
  tier: StorageTier;
  uri: string;
  bytes?: number | null;
  durationMs?: number | null;
  segmentCount?: number | null;
  state?: MediaState;
  actor?: string;
}): Promise<MediaObject> {
  // IDENTITY. A logical key identifies media within its owner, and the owner is
  // the recording or asset when there is one, the STREAM when there is not.
  //
  // That second case is not an edge: media on disk whose recording row was never
  // written, or has since been deleted, is exactly what a lifecycle has to be
  // able to see. Keyed only by recording, such media matched nothing on every
  // pass and reconciliation inserted a fresh row each time — three duplicate
  // objects for one directory after three boots, each with its own state, each
  // separately governed by retention.
  const ownerCol = opts.recordingId ? 'recording_id'
    : opts.vodAssetId ? 'vod_asset_id'
    : opts.channelId ? 'channel_id'
    : opts.eventId ? 'event_id'
    : null;
  const ownerId = opts.recordingId ?? opts.vodAssetId ?? opts.channelId ?? opts.eventId ?? null;

  let existing = ownerCol
    ? await one<MediaObject>(
        `SELECT * FROM media_objects WHERE ${ownerCol} = $1 AND logical_key = $2
          ORDER BY created_at LIMIT 1`,
        [ownerId, opts.logicalKey]
      )
    : null;

  // THE ORPHAN CASE. A run is often on disk before its recording row exists, or
  // after that row has been deleted, so it registers keyed to the stream. When
  // the recording turns up, looking only under the recording finds nothing and
  // a SECOND object is inserted for the same directory — the same media, twice,
  // with two histories and two separate retention futures. So an unclaimed
  // object with the same key under the same stream is looked for too.
  if (!existing && opts.recordingId && (opts.channelId || opts.eventId)) {
    const col = opts.channelId ? 'channel_id' : 'event_id';
    existing = await one<MediaObject>(
      `SELECT * FROM media_objects
        WHERE ${col} = $1 AND logical_key = $2
          AND recording_id IS NULL AND vod_asset_id IS NULL
        ORDER BY created_at LIMIT 1`,
      [opts.channelId ?? opts.eventId, opts.logicalKey]
    );
  }

  // A recording row appearing later must ADOPT the object rather than fork it:
  // the media did not change, only what we know about it.
  if (existing && opts.recordingId && !existing.recording_id) {
    await query(
      `UPDATE media_objects SET recording_id = $2, updated_at = now() WHERE id = $1`,
      [existing.id, opts.recordingId]
    );
    await query(
      `INSERT INTO media_events (object_id, from_state, to_state, action, actor, detail)
       VALUES ($1, $2::media_state, $2::media_state, 'adopt', $3, $4)`,
      [existing.id, existing.state, opts.actor ?? 'system', `linked to recording ${opts.recordingId}`]
    );
    existing.recording_id = opts.recordingId;
  }

  const obj = existing ?? await one<MediaObject>(
    `INSERT INTO media_objects
       (recording_id, vod_asset_id, channel_id, event_id, logical_key, kind, rendition,
        state, bytes, duration_ms, segment_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::media_state,$9,$10,$11)
     RETURNING *`,
    [
      opts.recordingId ?? null, opts.vodAssetId ?? null,
      opts.channelId ?? null, opts.eventId ?? null,
      opts.logicalKey, opts.kind, opts.rendition ?? null,
      opts.state ?? 'available',
      opts.bytes ?? null, opts.durationMs ?? null, opts.segmentCount ?? null,
    ]
  );
  if (!obj) throw new Error('failed to register media object');

  if (!existing) {
    await query(
      `INSERT INTO media_events (object_id, to_state, action, tier, actor, detail)
       VALUES ($1, $2::media_state, 'register', $3::storage_tier, $4, $5)`,
      [obj.id, obj.state, opts.tier, opts.actor ?? 'system', opts.logicalKey]
    );
  } else if (opts.bytes != null || opts.segmentCount != null) {
    // A live run grows. Keep the measurements current without a transition.
    //
    // `updated_at` moves only when a measurement ACTUALLY changes. Reconcile
    // re-registers every run on disk on every tick and passes the same numbers
    // back, so an unconditional bump rewrote the timestamp perpetually for
    // media that had not changed in months. Retention reads this column when
    // it has nothing better (see closedAtMsOf), and a timestamp that is always
    // `now` is a clock that never ticks. The WHERE clause makes the write a
    // no-op when there is nothing new to say.
    await query(
      `UPDATE media_objects
          SET bytes = COALESCE($2, bytes),
              duration_ms = COALESCE($3, duration_ms),
              segment_count = COALESCE($4, segment_count),
              updated_at = now()
        WHERE id = $1
          AND (bytes IS DISTINCT FROM COALESCE($2, bytes)
            OR duration_ms IS DISTINCT FROM COALESCE($3, duration_ms)
            OR segment_count IS DISTINCT FROM COALESCE($4, segment_count))`,
      [obj.id, opts.bytes ?? null, opts.durationMs ?? null, opts.segmentCount ?? null]
    );
  }

  await query(
    `INSERT INTO media_locations (object_id, tier, uri, bytes, present, verified_at)
     VALUES ($1, $2::storage_tier, $3, $4, true, now())
     ON CONFLICT (object_id, tier) DO UPDATE
       SET uri = EXCLUDED.uri, bytes = COALESCE(EXCLUDED.bytes, media_locations.bytes),
           present = true, removed_at = NULL, verified_at = now()`,
    [obj.id, opts.tier, opts.uri, opts.bytes ?? null]
  );

  return (await one<MediaObject>(`SELECT * FROM media_objects WHERE id = $1`, [obj.id]))!;
}

export async function locationsOf(objectId: string): Promise<MediaLocation[]> {
  return query<MediaLocation>(
    `SELECT * FROM media_locations WHERE object_id = $1 AND present ORDER BY tier`,
    [objectId]
  );
}

export interface Readability {
  readable: boolean;
  reason: 'ok' | 'archived' | 'restoring' | 'deleted' | 'not_written' | 'no_location';
  message: string;
  /** Present while a restore is outstanding. An expectation, not a promise. */
  expectedBy: string | null;
  /** When a restored copy lapses back to archived. */
  expiresAt: string | null;
  tier: StorageTier | null;
}

/**
 * Can this be played right now?
 *
 * The question every playback path has to ask before handing back a manifest.
 * Answering it with a boolean would be the mistake: an archived object and a
 * deleted one both come back "no", and the difference between "wait four hours"
 * and "it is gone forever" is the entire answer.
 */
export async function readability(objectId: string): Promise<Readability> {
  const obj = await one<MediaObject>(`SELECT * FROM media_objects WHERE id = $1`, [objectId]);
  if (!obj) {
    return { readable: false, reason: 'deleted', message: 'No such media.', expectedBy: null, expiresAt: null, tier: null };
  }
  const locs = await locationsOf(objectId);
  const immediate = locs.find((l) => isImmediate(l.tier));

  if (obj.state === 'deleted') {
    return {
      readable: false, reason: 'deleted',
      message: 'This media has been deleted under a retention rule. It cannot be restored.',
      expectedBy: null, expiresAt: null, tier: null,
    };
  }
  if (obj.state === 'pending' || obj.state === 'writing') {
    return {
      readable: obj.state === 'writing' && !!immediate, reason: 'not_written',
      message: obj.state === 'writing' ? 'This media is still being recorded.' : 'This media has not been written yet.',
      expectedBy: null, expiresAt: null, tier: immediate?.tier ?? null,
    };
  }
  if (obj.state === 'restoring') {
    return {
      readable: false, reason: 'restoring',
      message: obj.restore_expected_by
        ? `A restore is in progress. Expected by ${new Date(obj.restore_expected_by).toISOString()}.`
        : 'A restore is in progress.',
      expectedBy: obj.restore_expected_by, expiresAt: null,
      tier: locs[0]?.tier ?? null,
    };
  }
  if (obj.state === 'archived' || obj.state === 'archiving') {
    return {
      readable: false, reason: 'archived',
      message: 'This media is archived. Request a restore before playing it; ' +
        'archived tiers take minutes to hours to become readable.',
      expectedBy: null, expiresAt: null, tier: locs[0]?.tier ?? null,
    };
  }
  // RESTORED media is readable FROM ITS ARCHIVE TIER. A restore does not move
  // anything: the object stays on Glacier under the same key and is temporarily
  // served from there. Demanding an immediate-tier location here reported a
  // successfully restored object as having no readable copy — the state is what
  // makes it readable, and the expiry is what makes that temporary.
  if (obj.state === 'restored') {
    if (!locs.length) {
      return {
        readable: false, reason: 'no_location',
        message: 'This media has no copy on any tier.',
        expectedBy: null, expiresAt: null, tier: null,
      };
    }
    return {
      readable: true, reason: 'ok',
      message: obj.restore_expires_at
        ? `Restored, and readable until ${new Date(obj.restore_expires_at).toISOString()}.`
        : 'Restored and readable.',
      expectedBy: null, expiresAt: obj.restore_expires_at,
      tier: (immediate ?? locs[0]).tier,
    };
  }
  if (!immediate) {
    return {
      readable: false, reason: 'no_location',
      message: 'This media has no readable copy on any tier.',
      expectedBy: null, expiresAt: null, tier: locs[0]?.tier ?? null,
    };
  }
  return {
    readable: true, reason: 'ok', message: 'Readable.',
    expectedBy: null, expiresAt: obj.restore_expires_at, tier: immediate.tier,
  };
}

/**
 * Ask for an archived object to be made readable.
 *
 * Returns the expectation, and records it, so every later question about this
 * object gets the same answer rather than each caller inventing its own
 * estimate. Refused for a deployment with no archive, and refused for a speed
 * the tier does not offer — Deep Archive has no expedited retrieval, and
 * accepting the request and quietly downgrading it would make the promised time
 * a lie.
 */
export async function requestRestore(
  objectId: string, speed?: RestoreSpeed, actor = 'system'
): Promise<{ ok: true; object: MediaObject } | { ok: false; code: string; message: string }> {
  const caps = capabilities();
  if (!caps.archiveEnabled) {
    return { ok: false, code: 'no_archive', message: caps.archiveUnavailableReason ?? 'Archiving is not available here.' };
  }
  const obj = await one<MediaObject>(`SELECT * FROM media_objects WHERE id = $1`, [objectId]);
  if (!obj) return { ok: false, code: 'not_found', message: 'No such media.' };
  if (obj.state === 'restored' || obj.state === 'available') {
    return { ok: false, code: 'already_readable', message: 'This media is already readable.' };
  }
  if (obj.state !== 'archived') {
    return { ok: false, code: 'not_archived', message: `Media in state ${obj.state} cannot be restored.` };
  }

  const locs = await locationsOf(objectId);
  const archived = locs.find((l) => !isImmediate(l.tier));
  if (!archived) return { ok: false, code: 'no_location', message: 'This media has no archived copy to restore.' };

  const chosen = speed ?? config.mediaStore.restoreSpeed;
  const windowMs = restoreWindowMs(archived.tier, chosen);
  if (windowMs == null) {
    return {
      ok: false, code: 'speed_unavailable',
      message: `${archived.tier} does not offer ${chosen} retrieval. Use standard or bulk.`,
    };
  }

  const status = await storageDriver().requestRestore(archived.uri, chosen);
  const expectedBy = status.expectedBy ?? new Date(Date.now() + windowMs);
  const expiresAt = status.expiresAt
    ?? new Date(Date.now() + windowMs + config.mediaStore.restoreKeepDays * 86_400_000);

  await query(
    `UPDATE media_objects
        SET restore_requested_at = now(), restore_expected_by = $2,
            restore_expires_at = $3, restore_tier = $4, updated_at = now()
      WHERE id = $1`,
    [objectId, expectedBy, expiresAt, chosen]
  );
  const moved = await transition(objectId, 'restoring', {
    action: 'restore', actor, tier: archived.tier,
    detail: `${chosen}, expected by ${expectedBy.toISOString()}`,
  });
  return { ok: true, object: moved };
}

/**
 * Move outstanding restores forward.
 *
 * Called on the tick. Two things happen here and they are opposites: a restore
 * that has landed becomes readable, and a restored copy whose window has passed
 * LAPSES back to archived. The second is the one that gets forgotten, and
 * forgetting it means the system believes it can serve bytes that AWS has
 * already taken back.
 */
export async function pollRestores(): Promise<{ landed: number; lapsed: number }> {
  const driver = storageDriver();
  let landed = 0, lapsed = 0;

  const pending = await query<MediaObject>(
    `SELECT * FROM media_objects WHERE state = 'restoring' ORDER BY restore_expected_by NULLS FIRST LIMIT 200`
  );
  for (const obj of pending) {
    const locs = await locationsOf(obj.id);
    const archived = locs.find((l) => !isImmediate(l.tier));
    if (!archived) continue;
    try {
      const st = await driver.restoreStatus(archived.uri);
      if (!st.ready) continue;
      if (st.expiresAt) {
        await query(`UPDATE media_objects SET restore_expires_at = $2 WHERE id = $1`, [obj.id, st.expiresAt]);
      }
      await transition(obj.id, 'restored', { action: 'restore', tier: archived.tier, detail: 'restore landed' });
      landed++;
    } catch (e: any) {
      await query(`UPDATE media_objects SET last_error = $2 WHERE id = $1`, [obj.id, String(e?.message ?? e).slice(0, 500)]);
    }
  }

  const expired = await query<MediaObject>(
    `SELECT * FROM media_objects
      WHERE state = 'restored' AND restore_expires_at IS NOT NULL AND restore_expires_at < now()
      LIMIT 200`
  );
  for (const obj of expired) {
    await transition(obj.id, 'archived', {
      action: 'restore_lapsed',
      detail: 'the restored copy passed its expiry and is archived again',
    });
    await query(
      `UPDATE media_objects SET restore_requested_at = NULL, restore_expected_by = NULL,
              restore_expires_at = NULL, restore_tier = NULL WHERE id = $1`,
      [obj.id]
    );
    lapsed++;
  }
  return { landed, lapsed };
}

/** Put a hold on media, which outranks every retention rule. */
export async function setHold(objectId: string, hold: boolean, reason: string | null, actor = 'system'): Promise<MediaObject> {
  const obj = await one<MediaObject>(
    `UPDATE media_objects SET hold = $2, hold_reason = $3, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [objectId, hold, hold ? reason : null]
  );
  if (!obj) throw new Error(`media object ${objectId} not found`);
  await query(
    `INSERT INTO media_events (object_id, from_state, to_state, action, actor, detail)
     VALUES ($1, $2::media_state, $2::media_state, $3, $4, $5)`,
    [objectId, obj.state, hold ? 'hold' : 'hold_released', actor, reason ?? null]
  );
  return obj;
}

/** The history of one object, newest first. */
export async function historyOf(objectId: string, limit = 100) {
  return query<any>(
    `SELECT at, from_state, to_state, action, tier, actor, detail
       FROM media_events WHERE object_id = $1 ORDER BY at DESC, id DESC LIMIT $2`,
    [objectId, limit]
  );
}
