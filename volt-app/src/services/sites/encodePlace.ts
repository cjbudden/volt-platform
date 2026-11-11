// ============================================================================
//  WHERE AN ASSET IS ENCODED (build queue H4-8, HYBRID_SITES.md).
//
//  An Encode at site original stays on the customer's storage and is encoded
//  by a server of that site (`ingest.siteSource`); when no server takes it
//  within the folder's fallback time the site sends the original and it is
//  encoded in the cloud instead (`ingest.siteFallback`, siteFallback.ts).
//
//  Both facts were on the asset but buried in the ingest record, so an asset
//  waiting at a site read only "Building" with no hint of why it took hours,
//  and one that fell back never said why its original had left the site.
//  This turns them into one small answer the Media Library and the asset page
//  can show as they are: where, which site, and why it moved.
//
//  It is null for every other asset, so their responses only gain a null.
// ============================================================================

/** The site's name, read for the asset's own account only (null when the site was deleted). */
export const SITE_NAME_SQL = (v = 'v', owner = 'COALESCE(g.account_id, v.account_id)') =>
  `(SELECT s.name FROM sites s WHERE s.id::text = ${v}.ingest->'siteSource'->>'siteId' AND s.account_id = ${owner})`;

export type EncodePlaceState =
  | 'site'              // encoded (or being encoded) at the site
  | 'fallback_waiting'  // the site was asked to send the original for a cloud encode
  | 'fallback_cloud'    // the original came, the cloud encodes it (or did)
  | 'fallback_failed';  // the site could not send the original

export interface EncodePlace {
  /** Where the asset's own encode runs: at the customer's site or in the cloud. */
  at: 'site' | 'cloud';
  state: EncodePlaceState;
  siteId: string;
  /** Null when the site has since been deleted. */
  siteName: string | null;
  /** Why it moved to the cloud, in words (the fallback's own reason). */
  reason: string | null;
  /** What went wrong when the site could not send the original. */
  error: string | null;
}

/** The answer for one asset's ingest record. Null for an asset not kept at a site. */
export function encodePlaceOf(ingest: any, siteName: string | null | undefined): EncodePlace | null {
  const src = ingest?.siteSource;
  if (!src || typeof src.siteId !== 'string') return null;
  const fb = ingest?.siteFallback;
  const base = { siteId: src.siteId, siteName: siteName ?? null };
  if (!fb || !fb.state) return { ...base, at: 'site', state: 'site', reason: null, error: null };
  const reason = typeof fb.reason === 'string' ? fb.reason : null;
  const state: EncodePlaceState = fb.state === 'failed' ? 'fallback_failed'
    : fb.state === 'encoding' ? 'fallback_cloud' : 'fallback_waiting';
  return { ...base, at: 'cloud', state, reason, error: state === 'fallback_failed' && typeof fb.error === 'string' ? fb.error : null };
}

/** Adds `encode_place` to a row read with SITE_NAME_SQL as `site_name`, and drops the helper column. */
export function withEncodePlace<T extends Record<string, any>>(row: T): T & { encode_place: EncodePlace | null } {
  const { site_name, ...rest } = row as any;
  return { ...rest, encode_place: encodePlaceOf(row.ingest, site_name) };
}
