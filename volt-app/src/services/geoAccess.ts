// ============================================================================
//  GEO RESTRICTIONS THAT SIT ABOVE THE RULES (docs/ACCOUNT_SETTINGS.md).
//
//  Two layers the play gate checks before anything else:
//
//    ACCOUNT  where anything of the account may be watched at all: channels,
//             events, stations, on-demand assets, share links. "Nothing from
//             Israel" is one entry here, and no rule lower down can undo it.
//    CHANNEL  the channel's own geo setting (Channel settings > Geo), for its
//             live stream.
//
//  Each is { mode: 'block' | 'allow', countries: ['IL', ...] }. A block list
//  lets an unknown country through (nothing says it is a blocked one); an
//  allow list does not (nothing says it is an allowed one), as the programme
//  blackout already does.
// ============================================================================
import { one } from '../db';
import { cached } from '../scale/cache';
import { scaleConfig } from '../scale/config';

export interface GeoAccess { mode: 'block' | 'allow'; countries: string[] }

export function normGeo(g: any): GeoAccess | null {
  if (!g || (g.mode !== 'block' && g.mode !== 'allow')) return null;
  const countries = [...new Set((Array.isArray(g.countries) ? g.countries : []).map((c: any) => String(c).trim().toUpperCase()).filter((c: string) => /^[A-Z]{2}$/.test(c)))] as string[];
  if (g.mode === 'block' && !countries.length) return null;
  return { mode: g.mode, countries };
}

/** Does this restriction stop a viewer in `country`? Returns the reason, or null. */
export function geoBlocks(g: GeoAccess | null, country: string | null | undefined, what = 'This'): string | null {
  if (!g) return null;
  const c = (country || '').trim().toUpperCase();
  if (g.mode === 'block') return c && g.countries.includes(c) ? `${what} is not available in ${c}` : null;
  return c && g.countries.includes(c) ? null : `${what} is not available in ${c || 'your region'}`;
}

/** The account's restriction, cached; a change invalidates it (migration 0053). */
export function accountGeo(accountId: string): Promise<GeoAccess | null> {
  return cached<GeoAccess | null>(
    `acctgeo:${accountId}`,
    { ttlSec: scaleConfig.cache.keyTtlSec, tags: [`acct:${accountId}`] },
    async () => normGeo((await one<any>(`SELECT geo_access FROM accounts WHERE id = $1`, [accountId]))?.geo_access),
  );
}

/** The channel's own geo setting (geo_mode worldwide | allow | block). */
export function channelGeo(row: { geo_mode?: string | null; geo_countries?: string[] | null } | null | undefined): GeoAccess | null {
  if (!row || (row.geo_mode !== 'allow' && row.geo_mode !== 'block')) return null;
  return normGeo({ mode: row.geo_mode, countries: row.geo_countries ?? [] });
}
