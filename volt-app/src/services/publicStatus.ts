// ============================================================================
//  PUBLIC STATUS: what a viewer gets of an on-demand asset right now, and why
//  (build queue P1, PUBLISHING_POLICIES.md "Lifecycle model").
//
//  People set intent: the EDITORIAL STATE (draft, published, archived) and the
//  dates. Volt computes the rest, so a contradictory status cannot be saved:
//
//    editorial state   archived     archived_at is set
//                      published    availability_state scheduled, available
//                                   or expired (and the assets from before
//                                   availability existed, published = true)
//                      draft        everything else (never published, or
//                                   withdrawn, which keeps its dates)
//
//    public status     draft, in_review, changes_requested, rejected
//                                   a draft, by its review state
//                      processing   published, but the media is not ready
//                      restricted   published, but the rights say no now
//                      scheduled    published, the window has not opened
//                      available    published and inside every window
//                      expired      the window has closed
//                      archived     archived
//    (deleted assets have no row: a public request finds nothing.)
//
//  THE PUBLIC VISIBILITY RULE (Christian, 3 Nov): only Available assets, and
//  Scheduled assets past their Listed from date (a teaser with no playable
//  URL), are public. Everything else is answered by every public route
//  exactly as an id that never existed (404), so nothing leaks. The admin API
//  and the console still see everything.
//
//  ON THE REQUEST PATH nothing walks the rules: the play gate computes the
//  status with the pure function below from the asset's cached decision row
//  (services/viewerPath.ts vodAvailabilityRow, tagged asset:<id>) and its
//  cached rights profile, so a warm gate makes no database reads. The same
//  answer is STORED on the row (public_status, status_reason, status_until)
//  for anything that lists assets in SQL; `status_until` is the next moment
//  the answer can change, so a list filters on it and never serves a title
//  past its end, and the minute sweep recomputes rows whose moment has come
//  or that changed since they were last computed.
// ============================================================================
import { query, one } from '../db';
import { invalidateTag } from '../scale/cache';
import { rightsForAsset, type EffectiveRights } from './rightsProfiles';
import { vodAvailabilityRow } from './viewerPath';

export const PUBLIC_STATUSES = [
  'draft', 'in_review', 'changes_requested', 'rejected', 'processing',
  'scheduled', 'available', 'restricted', 'expired', 'archived',
] as const;
export type PublicStatus = typeof PUBLIC_STATUSES[number];
export type EditorialState = 'draft' | 'published' | 'archived';

/** The row fields the computation reads (all in vodAvailabilityRow). */
export interface StatusRow {
  availability_state?: string | null;
  published?: boolean | null;
  review_state?: string | null;
  media_state?: string | null;
  master_key?: string | null;
  available_from?: string | Date | null;
  available_until?: string | Date | null;
  listed_from?: string | Date | null;
  unlisted?: boolean | null;
  archived_at?: string | Date | null;
  withdrawn_by?: string | null;
}

export interface StatusAnswer {
  status: PublicStatus;
  editorial: EditorialState;
  /** One line for people: why it is in this status. */
  reason: string;
  /** The next moment this answer can change on its own (a date passing), or null. */
  until: Date | null;
  /** The window a viewer can actually play in: publish window inside the rights window. */
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  /** When it shows in browse and search (default: the effective start). */
  listedFrom: Date | null;
  unlisted: boolean;
}

const d = (v: unknown): Date | null => (v == null || v === '' ? null : new Date(v as any));
const day = (x: Date) => x.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const later = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a > b ? a : b);
const earlier = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a < b ? a : b);
/** The earliest of the given moments that is still in the future. */
const nextAfter = (now: Date, ...xs: (Date | null)[]) => xs.filter((x): x is Date => !!x && x > now).reduce<Date | null>((m, x) => earlier(m, x), null);

export function editorialStateOf(a: StatusRow): EditorialState {
  if (a.archived_at) return 'archived';
  const st = a.availability_state ?? 'draft';
  if (st === 'scheduled' || st === 'available' || st === 'expired') return 'published';
  // Assets from before availability existed: `published` still decides.
  if (st === 'draft' && a.published) return 'published';
  return 'draft';
}

/**
 * PURE: the public status of one asset at `now`, from its row and its
 * effective rights. Every caller (the play gate, the sweep, the tests) gets
 * the same answer from the same facts.
 */
export function computePublicStatus(a: StatusRow, rights: EffectiveRights, now: Date = new Date()): StatusAnswer {
  const editorial = editorialStateOf(a);
  const from = d(a.available_from), until = d(a.available_until);
  // The rights always narrow: a publish window never reaches past them.
  const effectiveFrom = later(from, rights.from);
  const effectiveUntil = earlier(until, rights.until);
  const listedFrom = d(a.listed_from) ?? effectiveFrom;
  const unlisted = !!a.unlisted;
  const base = { editorial, effectiveFrom, effectiveUntil, listedFrom, unlisted };
  const ans = (status: PublicStatus, reason: string, next: Date | null = null): StatusAnswer => ({ status, reason, until: next, ...base });

  if (editorial === 'archived') return ans('archived', 'Archived: off the catalogue and not playable.');
  if (editorial === 'draft') {
    const rs = a.review_state ?? 'draft';
    if (rs === 'in_review') return ans('in_review', 'In review: waiting for approval.');
    if (rs === 'changes_requested') return ans('changes_requested', 'Changes requested in review.');
    if (rs === 'rejected') return ans('rejected', 'Rejected in review.');
    if (a.availability_state === 'withdrawn') return ans('draft', `Withdrawn${a.withdrawn_by ? ` by ${a.withdrawn_by}` : ''}: back to draft, dates kept.`);
    return ans('draft', 'Draft: not published.');
  }

  // PUBLISHED. The media first: nothing is public until it can be played.
  const ms = a.media_state ?? null;
  if (ms === 'processing') return ans('processing', 'Processing: the media is being made; it goes live on its own when ready.');
  if (ms === 'failed' || ms === 'missing' || ms === 'unplayable') return ans('processing', `Not playable: the media is ${ms}.`);
  if (!a.master_key) return ans('processing', 'Processing: waiting for the media.');

  // The publish window closed: expired (it reappears if the window is extended).
  if (a.availability_state === 'expired' || (until && now >= until)) {
    return ans('expired', `Expired${until ? ` ${day(until)}` : ''}.`);
  }
  // The rights, which nothing overrides.
  if (!rights.uses.includes('on_demand')) {
    return ans('restricted', rights.uses.length ? `Restricted: the rights (${rights.profileName}) do not allow on demand.` : `Restricted: the rights (${rights.profileName}) allow no use.`);
  }
  if (rights.territoryMode === 'allow' && !rights.territories.length) {
    return ans('restricted', `Restricted: the rights (${rights.profileName}) allow no territory.`);
  }
  if (rights.until && now >= rights.until) return ans('restricted', `Restricted: the rights window ended ${day(rights.until)}.`);
  // Not open yet. Before the publish window: scheduled. Inside it but before the rights open: restricted for the gap.
  if (from && now < from) {
    // It changes at the window's start (to available, or restricted while the
    // rights are not open yet) and, for a teaser, at its Listed from date.
    return ans('scheduled', `Scheduled: available ${day(effectiveFrom ?? from)}.`, nextAfter(now, from, listedFrom));
  }
  if (rights.from && now < rights.from) {
    return ans('restricted', `Restricted: the rights window opens ${day(rights.from)}.`, rights.from);
  }
  return ans('available', effectiveUntil ? `Available until ${day(effectiveUntil)}.` : 'Available.', effectiveUntil);
}

/** May a public route show this asset at all (detail by id)? */
export function publiclyVisible(s: StatusAnswer, now: Date = new Date()): boolean {
  if (s.status === 'available') return true;
  return s.status === 'scheduled' && !!s.listedFrom && s.listedFrom <= now;
}

/** May it appear in browse and search (catalogue lists)? Unlisted stays playable by link only. */
export function publiclyListed(s: StatusAnswer, now: Date = new Date()): boolean {
  return publiclyVisible(s, now) && !s.unlisted;
}

/**
 * The SQL a public catalogue list filters on, from the STORED status, so paging
 * stays correct. `status_until` makes it exact between sweeps: an Available row
 * whose window has just ended is out at once, a Scheduled teaser appears at its
 * Listed from date.
 */
export function publicListSql(v = 'v'): string {
  return `(NOT ${v}.unlisted AND (
      (${v}.public_status = 'available' AND (${v}.status_until IS NULL OR ${v}.status_until > now()))
   OR (${v}.public_status = 'scheduled' AND ${v}.available_from > now()
       AND COALESCE(${v}.listed_from, ${v}.available_from) <= now())))`;
}

/**
 * THE PLAY PATH'S ANSWER: the status computed from the cached decision row and
 * the cached rights profile, no database read when warm. Null for an id that is
 * not an on-demand asset.
 */
export async function publicDecision(assetId: string, now: Date = new Date()): Promise<StatusAnswer | null> {
  const a = await vodAvailabilityRow(assetId);
  if (!a) return null;
  return computePublicStatus(a, await rightsForAsset(a), now);
}

const ROW_SQL = `SELECT v.id, v.availability_state, v.published, v.review_state::text AS review_state, v.media_state, v.master_key,
       v.available_from, v.available_until, v.listed_from, v.unlisted, v.archived_at, v.withdrawn_by,
       v.rights_profile_id, v.rights_narrow, v.created_at, v.first_aired_at, v.public_status, v.status_reason, v.status_until
  FROM vod_assets v`;

/**
 * Recompute and store one asset's status. Drops the cached decision row when the
 * answer changed, so the play gate and lists agree at once. Returns the answer.
 */
export async function refreshPublicStatus(assetId: string, now: Date = new Date()): Promise<StatusAnswer | null> {
  const a = await one<any>(`${ROW_SQL} WHERE v.id = $1`, [assetId]);
  if (!a) return null;
  return store(a, now);
}

async function store(a: any, now: Date): Promise<StatusAnswer> {
  const s = computePublicStatus(a, await rightsForAsset(a), now);
  const changed = a.public_status !== s.status || a.status_reason !== s.reason
    || (d(a.status_until)?.getTime() ?? null) !== (s.until?.getTime() ?? null);
  await query(
    `UPDATE vod_assets SET public_status = $2, status_reason = $3, status_until = $4, status_at = now() WHERE id = $1`,
    [a.id, s.status, s.reason, s.until]);
  if (changed) invalidateTag(`asset:${a.id}`);
  // It was playable and is not any more, before its window ran out (withdrawn,
  // archived, restricted, moved back to scheduled, or the window cut short):
  // play tokens already handed out must stop at the edge too
  // (services/edgeTokens.ts, build queue P2).
  if (a.public_status === 'available' && s.status !== 'available') {
    await (await import('./edgeTokens')).revokeAsset(a.id, s.reason, Math.floor(now.getTime() / 1000))
      .catch((e) => console.error(`[edge-tokens] revoke ${a.id}:`, e?.message ?? e));
  }
  return s;
}

/**
 * THE CLOCK, on the availability sweep (once a minute). Recomputes the rows
 * whose next moment has come, rows never computed (the ones from before this
 * existed), and rows changed since they were computed (any writer that moves
 * updated_at: media, review, rights, metadata). Bounded per tick so a large
 * backfill spreads over minutes instead of holding one long transaction.
 */
export async function sweepPublicStatus(limit = 500, now: Date = new Date()): Promise<number> {
  const rows = await query<any>(
    `${ROW_SQL}
      WHERE v.status_at IS NULL OR v.status_until <= now() OR v.updated_at > v.status_at
      ORDER BY v.status_at NULLS FIRST LIMIT $1`, [limit]);
  for (const a of rows) await store(a, now);
  return rows.length;
}

/**
 * ARCHIVE: off the catalogue and not playable, media kept. Its publications are
 * withdrawn as by Withdraw. It can be restored at any time until retention
 * deletes it (unarchive).
 */
export async function archiveAsset(assetId: string, by: string): Promise<StatusAnswer | null> {
  const row = await one<any>(
    `UPDATE vod_assets SET archived_at = now(), archived_by = $2, published = false, portal_visible = false, updated_at = now()
      WHERE id = $1 RETURNING id`, [assetId, by.slice(0, 300)]);
  if (!row) return null;
  await query(`UPDATE publications SET status = 'withdrawn' WHERE vod_asset_id = $1 AND status IN ('published', 'pending')`, [assetId]);
  return refreshPublicStatus(assetId);
}

/**
 * Restore an archived asset to Draft (as withdrawn: dates kept), or to Published
 * by going back through publish(), with every gate and the rights checked again.
 */
export async function unarchiveAsset(assetId: string, by: string, to: 'draft' | 'published'): Promise<StatusAnswer | null> {
  const row = await one<any>(
    `UPDATE vod_assets SET archived_at = NULL, archived_by = NULL,
            availability_state = CASE WHEN availability_state = 'draft' THEN 'draft' ELSE 'withdrawn' END,
            withdrawn_at = CASE WHEN availability_state = 'draft' THEN withdrawn_at ELSE now() END,
            withdrawn_by = CASE WHEN availability_state = 'draft' THEN withdrawn_by ELSE $2 END,
            published = false, portal_visible = false, updated_at = now()
      WHERE id = $1 AND archived_at IS NOT NULL RETURNING id`, [assetId, `${by}: restored from archive`.slice(0, 300)]);
  if (!row) return null;
  if (to === 'published') await (await import('./availability')).republish(assetId, by);
  return refreshPublicStatus(assetId);
}

/** Set the listing fields (teaser date and Unlisted). Delivery-time: no reprocessing. */
export async function setListing(assetId: string, listing: { listedFrom?: Date | null; unlisted?: boolean }): Promise<StatusAnswer | null> {
  const sets: string[] = []; const args: any[] = [assetId];
  if (listing.listedFrom !== undefined) { args.push(listing.listedFrom); sets.push(`listed_from = $${args.length}`); }
  if (listing.unlisted !== undefined) { args.push(listing.unlisted); sets.push(`unlisted = $${args.length}`); }
  if (sets.length) await query(`UPDATE vod_assets SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, args);
  return refreshPublicStatus(assetId);
}
