/**
 * Geo / rights evaluation for the play gate. For a live channel, the CURRENT
 * programme (EPG) governs blackout: geo_mode worldwide | allow | block against
 * the viewer's country. A blocked viewer is offered the programme's
 * replacement_asset (blackout slate / alternate) rather than nothing — the same
 * control doubles as last-minute content replacement. VOD/events default to
 * allowed until per-asset rights are modelled.
 */
import { one } from '../db';

export interface AccessDecision {
  allowed: boolean;
  reason?: string;
  replacementAssetId?: string | null;
}

/**
 * assetId is treated as a channel id first (live blackout is the main case); if
 * it isn't a live channel with a current programme, access defaults to allowed.
 * geo = ISO-3166 alpha-2 (from the edge / client). No geo → treated as unknown,
 * which is allowed unless a rule requires an explicit allow-list match.
 */
export async function evaluateAccess(assetId: string, geo?: string): Promise<AccessDecision> {
  const prog = await one<any>(
    `SELECT geo_mode, geo_countries, replacement_asset_id
       FROM programmes WHERE channel_id=$1 AND span @> now()
       ORDER BY starts_at DESC LIMIT 1`,
    [assetId]
  );
  if (!prog || prog.geo_mode === 'worldwide') return { allowed: true };

  const country = (geo || '').toUpperCase();
  const list: string[] = (prog.geo_countries || []).map((c: string) => c.toUpperCase());
  let blocked = false;
  if (prog.geo_mode === 'block') {
    blocked = !!country && list.includes(country);
  } else if (prog.geo_mode === 'allow') {
    // allow-list: only listed countries may watch; unknown geo is blocked
    blocked = !country || !list.includes(country);
  }
  if (!blocked) return { allowed: true };
  return {
    allowed: false,
    reason: prog.geo_mode === 'block' ? `blacked out in ${country}` : `not licensed in ${country || 'your region'}`,
    replacementAssetId: prog.replacement_asset_id ?? null,
  };
}
