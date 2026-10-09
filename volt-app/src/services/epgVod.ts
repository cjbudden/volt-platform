// ============================================================================
//  A PROGRAMME'S LIFE AS A VOD ASSET.
//
//  The schedule already knew two things about a slot: whether it is marked to
//  auto-convert, and whether the clip was made. Between those two sits the
//  state an operator actually cares about and could not see anywhere:
//
//      IT AIRED, IT WAS RECORDED, THE MEDIA IS STILL THERE,
//      AND NOTHING IS GOING TO TURN IT INTO A VOD.
//
//  That is every slot where auto_vod was left off, and every slot whose
//  automatic conversion failed. The material is sitting on disk, convertible
//  today and gone after retention sweeps it, and the guide showed a dash.
//
//  ------------------------------------------------------------------------
//  THE STATES, AND WHY EACH IS SEPARATE.
//
//    manual        Has not finished airing, and will NOT auto-convert. Not a
//                  problem, but it is a decision that is easy to have made by
//                  accident, and it is much cheaper to notice now than after
//                  retention.
//    scheduled     Has not finished airing, and WILL auto-convert when it does.
//    converting    Claimed by the scheduler right now.
//    converted     There is an asset. The only state with something to open.
//    failed        The automatic attempt errored. Carries the reason, which
//                  `clip_error` has always stored and nothing has ever shown.
//    convertible   AIRED, MEDIA STILL COVERS IT, NO ASSET. The missing state.
//                  Carries coverage and, when the channel has a retention
//                  rule, the date the material goes away.
//    unavailable   Aired, and nothing on disk covers it any more. Distinct
//                  from `convertible` because the action differs completely:
//                  one offers a button, the other explains why there is none.
//
//  ------------------------------------------------------------------------
//  COVERAGE IS MEASURED ONCE FOR THE WHOLE WINDOW, NOT ONCE PER PROGRAMME.
//
//  resolveRange() scans the run directories on disk. Calling it for each of a
//  day's thirty slots would scan the same runs thirty times. It is called once
//  for the day and each programme's span is intersected against the resolved
//  blocks in memory, which is the same arithmetic resolveRange does internally
//  and gives identical answers for a fraction of the work.
//
//  MEASURED, NOT DECLARED. A recording row claims a window; the disk holds
//  what was actually written. A crash mid-run leaves the claim intact and the
//  media missing, so offering "convert" off the row would promise material
//  that is not there. Coverage here always comes from the blocks.
// ============================================================================
import { query, one } from '../db';
import { resolveRange, type Resolution } from './clips/resolve';
import { isAudioOnly } from './localRecordingIndex';
import { createClipVod, enqueueClipBuild } from './clips';

export type VodState =
  | 'manual' | 'scheduled' | 'converting' | 'converted'
  | 'failed' | 'convertible' | 'unavailable';

export interface ProgrammeVod {
  id: string;
  state: VodState;
  /** How much of the slot the media actually covers, 0..100. */
  coveragePct: number;
  coveredMs: number;
  /** Set only in `converted`. */
  assetId: string | null;
  assetTitle: string | null;
  assetState: string | null;
  /** Set only in `failed`. */
  error: string | null;
  /**
   * When the material behind a `convertible` slot is expected to be swept.
   * Null when the owner keeps recordings forever, which is a real and common
   * configuration and must not render as "expires: never" ambiguity.
   */
  expiresAt: string | null;
  /** True while any part of the slot is still to come. */
  future: boolean;
}

/** The lifecycle of every programme in a window, for one owner. */
export async function programmeVodStates(
  kind: 'channel' | 'event',
  ownerId: string,
  fromIso: string,
  toIso: string,
): Promise<ProgrammeVod[]> {
  const col = kind === 'channel' ? 'channel_id' : 'event_id';
  const progs = await query<any>(
    `SELECT p.id, p.title, p.starts_at, p.ends_at, p.actual_start, p.actual_end,
            p.auto_vod, p.clip_status, p.clip_asset_id, p.clip_error,
            v.title AS asset_title,
            -- vod_assets has no status column; the state that matters to an
            -- operator looking at the guide is whether the DERIVATIVES have
            -- been built, which is thumb_status. An asset row exists the
            -- instant the clip is requested, so "there is an asset" and "the
            -- asset is watchable" are different facts and the second is the
            -- one worth showing.
            v.thumb_status::text AS asset_state
       FROM programmes p
       LEFT JOIN vod_assets v ON v.id = p.clip_asset_id
      WHERE p.${col} = $1 AND p.span && tstzrange($2,$3,'[)')
      ORDER BY p.starts_at`,
    [ownerId, fromIso, toIso]
  );
  if (!progs.length) return [];

  // Retention, for the expiry a `convertible` slot is racing. `_sec` wins over
  // `_days` where both are set, matching the retention sweep's own precedence;
  // NULL in both means keep forever, which is why this is nullable rather than
  // defaulted to some large number.
  const ownerRow = await one<any>(
    kind === 'channel'
      ? `SELECT recording_retention_days, recording_retention_sec FROM channels WHERE id=$1`
      : `SELECT recording_retention_days, recording_retention_sec FROM events WHERE id=$1`,
    [ownerId]
  );
  const retentionMs =
    ownerRow?.recording_retention_sec != null ? Number(ownerRow.recording_retention_sec) * 1000
    : ownerRow?.recording_retention_days != null ? Number(ownerRow.recording_retention_days) * 86_400_000
    : null;

  // ONE scan for the whole window. Anything already answered without touching
  // the disk (everything is in the future, or everything already converted)
  // skips it entirely: an operator paging through next month's schedule should
  // not make the server walk the archive.
  const nowMs = Date.now();
  const needsMedia = progs.some((p) => {
    const endMs = new Date(p.actual_end ?? p.ends_at).getTime();
    return endMs <= nowMs && p.clip_status !== 'created' && p.clip_status !== 'firing';
  });
  let resolution: Resolution | null = null;
  if (needsMedia) {
    try {
      const mediaKind = isAudioOnly(ownerId) ? 'audio' : 'video';
      resolution = resolveRange(ownerId, Date.parse(fromIso), Date.parse(toIso), mediaKind);
    } catch (e) {
      // A failure to read the archive is NOT "there is no media". Left null,
      // which makes coverage unknown, and an unknown-coverage aired slot is
      // reported `convertible` rather than `unavailable`: offering a button
      // that might fail is better than telling an operator their recording is
      // gone when the scan simply did not run.
      console.warn('[epg] could not measure coverage for', ownerId, e);
    }
  }

  return progs.map((p) => shape(p, resolution, retentionMs, nowMs));
}

/** Milliseconds of `blocks` that fall inside [from,to]. */
export function coveredWithin(r: Resolution | null, fromMs: number, toMs: number): number | null {
  if (!r) return null;
  let ms = 0;
  for (const b of r.blocks) {
    const lo = Math.max(b.startMs, fromMs);
    const hi = Math.min(b.endMs, toMs);
    if (hi > lo) ms += hi - lo;
  }
  return ms;
}

function shape(p: any, r: Resolution | null, retentionMs: number | null, nowMs: number): ProgrammeVod {
  const startMs = new Date(p.actual_start ?? p.starts_at).getTime();
  const endMs = new Date(p.actual_end ?? p.ends_at).getTime();
  const future = endMs > nowMs;
  const base = {
    id: p.id, coveragePct: 0, coveredMs: 0,
    assetId: p.clip_asset_id ?? null,
    assetTitle: p.asset_title ?? null,
    assetState: p.asset_state ?? null,
    error: p.clip_error ?? null,
    expiresAt: null as string | null,
    future,
  };

  if (p.clip_status === 'created' && p.clip_asset_id) return { ...base, state: 'converted' };
  if (p.clip_status === 'firing') return { ...base, state: 'converting' };

  // Not yet finished airing: the question is only whether it is set to convert.
  if (future) {
    return { ...base, state: p.auto_vod ? 'scheduled' : 'manual', error: null };
  }

  const span = Math.max(1, endMs - startMs);
  const covered = coveredWithin(r, startMs, endMs);
  const pct = covered == null ? 0 : Math.round((covered / span) * 1000) / 10;

  // A failed attempt reports as failed whatever the media says. The reason it
  // failed is the actionable thing, and hiding it behind `convertible` because
  // the bytes happen to be there would lose it. The retry action is offered on
  // this state too, so nothing is harder to recover from.
  if (p.clip_status === 'error') {
    return { ...base, state: 'failed', coveredMs: covered ?? 0, coveragePct: pct };
  }

  // covered == null means the scan did not run, not that nothing is there.
  if (covered != null && covered <= 0) {
    return { ...base, state: 'unavailable', error: null };
  }

  return {
    ...base,
    state: 'convertible',
    coveredMs: covered ?? 0,
    coveragePct: covered == null ? 0 : pct,
    error: null,
    expiresAt: retentionMs == null ? null : new Date(endMs + retentionMs).toISOString(),
  };
}

/**
 * Turn one programme into a VOD asset.
 *
 * THIS IS THE ONLY IMPLEMENTATION. It was lifted out of the orchestrator tick
 * so that the manual "convert now" action and the automatic post-airing
 * conversion are the same code rather than two paths that agree today. Two
 * paths would drift: the metadata harvest, the master-key base, the build
 * enqueue, are each easy to leave out of a second copy, and the result is an
 * asset that looks created and never renders.
 *
 * THE CLAIM IS A CONDITIONAL UPDATE, not a read-then-write. `clip_status` goes
 * to 'firing' only from a status the caller expects, so the tick and an
 * operator pressing the button at the same moment cannot both proceed. The
 * loser is told so rather than making a second asset from the same span.
 */
export async function convertProgramme(
  programmeId: string,
  opts: { allowRetry?: boolean } = {},
): Promise<{ assetId: string } | { skipped: string }> {
  const from = opts.allowRetry ? ['none', 'error'] : ['none'];
  const claimed = await one<any>(
    `UPDATE programmes SET clip_status='firing', clip_error=NULL
      WHERE id=$1 AND clip_status = ANY($2::text[])
      RETURNING *`,
    [programmeId, from]
  );
  if (!claimed) {
    const cur = await one<any>(`SELECT clip_status FROM programmes WHERE id=$1`, [programmeId]);
    return { skipped: cur ? `already ${cur.clip_status}` : 'no such programme' };
  }

  const p = claimed;
  try {
    const col = p.channel_id ? 'channel_id' : 'event_id';
    const ownerId = p.channel_id ?? p.event_id;
    const startMs = new Date(p.actual_start ?? p.starts_at).getTime();
    const endMs = new Date(p.actual_end ?? p.ends_at).getTime();
    const rec = await one<any>(
      `SELECT * FROM recordings WHERE ${col}=$1
         AND start_epoch_ms <= $2 AND (end_epoch_ms IS NULL OR end_epoch_ms >= $3)
       ORDER BY start_epoch_ms DESC LIMIT 1`,
      [ownerId, startMs, endMs]
    );
    if (!rec) {
      await query(`UPDATE programmes SET clip_status='error', clip_error=$2 WHERE id=$1`,
                  [p.id, 'no recording covers the slot']);
      return { skipped: 'no recording covers the slot' };
    }
    const asset = await createClipVod({
      ownerCol: col as 'channel_id' | 'event_id',
      ownerId,
      recordingId: rec.id,
      title: p.title,
      startMs, endMs,
      outputKind: 'manifest',
      masterKeyBase: rec.master_key ?? 'vod',
    });
    // The programme's metadata is the single source of truth for the asset's.
    await query(`UPDATE vod_assets SET metadata=$2::jsonb WHERE id=$1`,
                [(asset as any).id, JSON.stringify(p.metadata ?? {})]);
    // AND BUILD IT. Creating the row without queueing the extraction left the
    // asset at thumb_status 'processing' forever, pointing at a manifest
    // nothing would write, while the status said 'created'.
    await enqueueClipBuild({
      vodAssetId: (asset as any).id, streamId: ownerId,
      fromMs: startMs, toMs: endMs, outputKind: 'manifest',
      channelId: p.channel_id ?? null, eventId: p.event_id ?? null,
    });
    await query(`UPDATE programmes SET clip_status='created', clip_asset_id=$2, clip_error=NULL WHERE id=$1`,
                [p.id, (asset as any).id]);
    return { assetId: (asset as any).id };
  } catch (e) {
    // The claim is released back to 'error', never left at 'firing'. A row
    // stuck in 'firing' is unrecoverable without a database edit, which is a
    // bug this codebase has already had with job claims.
    await query(`UPDATE programmes SET clip_status='error', clip_error=$2 WHERE id=$1`,
                [p.id, String((e as any)?.message ?? e).slice(0, 300)]).catch(() => {});
    throw e;
  }
}

/**
 * Test seam.
 *
 * `shape` is the state machine and is the part with seven outcomes and no
 * database or disk in it. Exposed so the states can be asserted exactly,
 * against injected clocks and injected coverage, rather than by arranging real
 * media on disk for each one — which is how a state machine ends up with three
 * of its branches untested.
 */
export const __testing = { shape };
