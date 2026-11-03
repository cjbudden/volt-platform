// ============================================================================
//  MP3 FOR LISTENERS, BEHIND A SWITCH (build queue 2.1c-2).
//
//  There is no relay any more: a station writes HLS and DASH and nothing else.
//  MP3 for hardware receivers and old apps is still possible, made on demand
//  from the HLS by the control plane (mp3Gateway.ts), but it is OFF unless the
//  account has it switched on (accounts.mp3_feed_enabled, set by the system
//  admin through /api/platform/accounts/{id}) and the station has not turned
//  its own MP3 output off. Until then every MP3 address answers 404 and none
//  is advertised.
// ============================================================================
import { one } from '../../db';

/** Is MP3 on for this station: its account's switch, and its own output. */
export async function mp3FeedFor(channelId: string): Promise<boolean> {
  const r = await one<{ on: boolean }>(
    `SELECT (COALESCE(a.mp3_feed_enabled, false)
             AND COALESCE((c.radio_config -> 'outputs' ->> 'mp3')::boolean, true)) AS on
       FROM channels c JOIN groups g ON g.id = c.group_id JOIN accounts a ON a.id = g.account_id
      WHERE c.id = $1`, [channelId]);
  return !!r?.on;
}

/** The account's switch alone (what the console shows). */
export async function mp3FeedForAccount(accountId: string): Promise<boolean> {
  const r = await one<{ mp3_feed_enabled: boolean }>(`SELECT mp3_feed_enabled FROM accounts WHERE id = $1`, [accountId]);
  return !!r?.mp3_feed_enabled;
}

/** A station's public MP3 path, served by publicLive.ts. */
export function publicMp3Path(channelId: string): string {
  return `/live/${channelId}/stream.mp3`;
}
