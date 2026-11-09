// ============================================================================
//  THE BLOCK MESSAGE AND "NOTIFY ME" (build queue P2-2, PUBLISHING_POLICIES.md
//  "Block message").
//
//  A viewer who cannot play a title where they are (geo or rights, answered
//  451 by the play gate) is told so in the account's own words, the same on
//  every platform, rather than meeting a missing title or a broken player.
//  The account may also offer "Notify me if it becomes available": the player
//  shows the button, and the request is kept here for that title.
//
//  Publishing policies (P3) will set the message per policy. Until then each
//  account has one default, set on the Rights page (GET/PUT /api/rights/settings).
//  The play gate reads it on every refusal, so it is cached like the rest of
//  the viewer path: no database read when warm.
// ============================================================================
import { one, query } from '../db';
import { cached, invalidateTag } from '../scale/cache';
import { scaleConfig } from '../scale/config';

/** What a viewer is told when nothing else is set. The edge says the same. */
export const DEFAULT_BLOCK_MESSAGE = 'Not available in your region';
export const BLOCK_MESSAGE_MAX = 200;

export interface BlockSettings { message: string; custom: boolean; notify: boolean }

/** The account's block message and whether "Notify me" is offered (cached). */
export function blockSettings(accountId: string): Promise<BlockSettings> {
  return cached<BlockSettings>(`blockmsg:${accountId}`, { ttlSec: scaleConfig.cache.rulesTtlSec, tags: [`acct:${accountId}`, `blockmsg:${accountId}`] },
    () => blockSettingsFresh(accountId));
}

/** Change them (the Rights page). Empty or null message: back to the default. */
export async function setBlockSettings(accountId: string, o: { message?: string | null; notify?: boolean }): Promise<{ from: BlockSettings; to: BlockSettings }> {
  const from = await blockSettingsFresh(accountId);
  if (o.message !== undefined) {
    const m = o.message == null ? null : o.message.replace(/\s+/g, ' ').trim();
    await query(`UPDATE accounts SET block_message = $2 WHERE id = $1`, [accountId, m ? m.slice(0, BLOCK_MESSAGE_MAX) : null]);
  }
  if (o.notify !== undefined) await query(`UPDATE accounts SET block_notify = $2 WHERE id = $1`, [accountId, o.notify]);
  invalidateTag(`blockmsg:${accountId}`);
  return { from, to: await blockSettingsFresh(accountId) };
}

/** Read straight from the database (the Rights page, which must show a change made by another process at once). */
export async function blockSettingsFresh(accountId: string): Promise<BlockSettings> {
  const a = await one<any>(`SELECT block_message, block_notify FROM accounts WHERE id = $1`, [accountId]);
  const custom = typeof a?.block_message === 'string' && a.block_message.trim() !== '';
  return { message: custom ? a.block_message.trim() : DEFAULT_BLOCK_MESSAGE, custom, notify: !!a?.block_notify };
}

/** Why a title is held back from this viewer, as the notify request records it. */
export type NotifyReason = 'region' | 'rights' | 'scheduled';

/**
 * Keep a viewer's "Notify me" for a title. One per title and person: asking
 * twice changes nothing (and says so). `who` is the signed-in viewer when there
 * is one, else the email address given.
 */
export async function addNotifyRequest(o: {
  accountId: string; assetId: string; reason: NotifyReason; country: string | null;
  viewerId?: string | null; email?: string | null;
}): Promise<{ created: boolean }> {
  const email = o.email ? o.email.trim().toLowerCase() : null;
  const who = o.viewerId ? `viewer:${o.viewerId}` : `email:${email}`;
  const row = await one<any>(
    `INSERT INTO availability_notify (account_id, asset_id, who, email, viewer_id, country, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (asset_id, who) DO NOTHING RETURNING id`,
    [o.accountId, o.assetId, who, email, o.viewerId ?? null, o.country, o.reason]);
  return { created: !!row };
}

/** How many viewers are waiting, and for which titles (the Rights page). */
export async function notifySummary(accountId: string): Promise<{ total: number; titles: Array<{ assetId: string; title: string | null; count: number }> }> {
  const t = await one<any>(`SELECT count(*)::int AS n FROM availability_notify WHERE account_id = $1 AND notified_at IS NULL`, [accountId]);
  const rows = await query<any>(
    `SELECT n.asset_id, v.title, count(*)::int AS n
       FROM availability_notify n LEFT JOIN vod_assets v ON v.id = n.asset_id
      WHERE n.account_id = $1 AND n.notified_at IS NULL
      GROUP BY n.asset_id, v.title ORDER BY n DESC, v.title LIMIT 10`, [accountId]);
  return { total: t?.n ?? 0, titles: rows.map((r) => ({ assetId: r.asset_id, title: r.title ?? null, count: r.n })) };
}
