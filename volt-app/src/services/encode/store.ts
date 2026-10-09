// ============================================================================
//  LOADING A LADDER FROM THE DATABASE.
//
//  `ladder.ts` decides which rungs, purely. This fetches what it decides from.
//  The split is the same one the watchfolder uses: the behaviour worth testing
//  is pure, and the adapter is thin enough to read.
//
//  THE TRACKING JOIN IS THE POINT OF THE WHOLE FEATURE. A group that tracks a
//  live output profile reads `output_profiles.rungs` HERE, at encode time. There
//  is no copy anywhere, so "the file encode matches the live channel" is a
//  property of the query rather than something an operator has to maintain.
// ============================================================================
import { one, query } from '../../db';
import {
  resolveLadder, type LadderGroupRow, type ResolvedLadder, type Rung,
} from './ladder';

export class NoLadderError extends Error {}

/** The account's ladder groups, for a picker. */
export async function listLadderGroups(accountId: string) {
  return query<any>(
    `SELECT g.*,
            p.name AS tracked_profile_name,
            (SELECT count(*) FROM encode_ladder_members m WHERE m.group_id = g.id)::int AS member_count
       FROM encode_ladder_groups g
       LEFT JOIN output_profiles p ON p.id = g.tracks_output_profile_id
      WHERE g.account_id = $1
      ORDER BY g.is_default DESC, g.name`,
    [accountId]
  );
}

/**
 * Resolve one ladder group to the rungs an encode would use.
 *
 * Throws rather than returning an empty ladder: a job that encodes nothing and
 * reports success is worse than a job that refuses, because the asset then sits
 * in the library looking finished with no renditions behind it.
 */
export async function loadLadder(groupId: string, accountId: string): Promise<ResolvedLadder> {
  const g = await one<LadderGroupRow & { account_id: string }>(
    `SELECT * FROM encode_ladder_groups WHERE id = $1 AND account_id = $2`,
    [groupId, accountId]
  );
  if (!g) throw new NoLadderError(`ladder group ${groupId} not found for this account`);

  if (g.tracks_output_profile_id) {
    // THE TRACKING READ. Not a copy taken when the group was created: the live
    // profile as it is right now.
    const p = await one<any>(
      `SELECT name, rungs, segment_dur, drm_enabled FROM output_profiles WHERE id = $1`,
      [g.tracks_output_profile_id]
    );
    const rungs: Rung[] = Array.isArray(p?.rungs) ? p.rungs : [];
    return resolveLadder(g, {
      trackedRungs: rungs,
      trackedProfileName: p?.name ?? null,
      trackedSegmentDur: p?.segment_dur == null ? null : Number(p.segment_dur),
      // A live profile stores fps on its first rung rather than as a column, the
      // same place buildEncoderJobConfig reads it from. Reading it anywhere else
      // is how the file encode ends up with a different GOP.
      trackedFps: rungs[0]?.fps == null ? null : Number(rungs[0].fps),
    });
  }

  const members = await query<any>(
    `SELECT p.height, p.bitrate_kbps, p.fps
       FROM encode_ladder_members m
       JOIN encode_profiles p ON p.id = m.profile_id
      WHERE m.group_id = $1
      ORDER BY m.ordinal`,
    [groupId]
  );
  return resolveLadder(g, {
    memberRungs: members.map((r) => ({
      height: Number(r.height), bitrate_kbps: Number(r.bitrate_kbps),
      fps: r.fps == null ? null : Number(r.fps),
    })),
  });
}

/**
 * The ladder to use when nothing named one.
 *
 * Falls back through: the explicit group, then the account default, then
 * nothing. NOTHING IS AN ERROR, not a built-in ladder: a hardcoded fallback
 * would encode to bitrates that appear in no profile the operator can see or
 * edit, and that is exactly the drift this feature exists to remove.
 */
export async function resolveLadderFor(
  accountId: string,
  preferred?: string | null
): Promise<ResolvedLadder> {
  if (preferred) return loadLadder(preferred, accountId);
  const def = await one<{ id: string }>(
    `SELECT id FROM encode_ladder_groups WHERE account_id = $1 AND is_default LIMIT 1`,
    [accountId]
  );
  if (!def) {
    throw new NoLadderError(
      'no ladder group was named and this account has no default one; ' +
      'set a default in Encoding profiles, or choose a ladder on the folder or the upload');
  }
  return loadLadder(def.id, accountId);
}

/**
 * Create the ladder group that mirrors a group's live output profile.
 *
 * The obvious first thing an operator wants, and the one that is correct by
 * construction: it tracks rather than copies, so it can never disagree with the
 * channels it was made from.
 */
export async function ensureTrackingGroup(
  accountId: string,
  outputProfileId: string,
  name: string,
  opts: { makeDefault?: boolean; userId?: string | null } = {}
): Promise<string> {
  const existing = await one<{ id: string }>(
    `SELECT id FROM encode_ladder_groups
      WHERE account_id = $1 AND tracks_output_profile_id = $2 LIMIT 1`,
    [accountId, outputProfileId]
  );
  if (existing) return existing.id;
  const row = await one<{ id: string }>(
    `INSERT INTO encode_ladder_groups
       (account_id, name, tracks_output_profile_id, is_default, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$5) RETURNING id`,
    [accountId, name, outputProfileId, !!opts.makeDefault, opts.userId ?? null]
  );
  return row!.id;
}
