// ============================================================================
//  THE POLICY AT DELIVERY (build queue P3-4b, PUBLISHING_POLICIES.md "What a
//  policy contains", "Encode-time vs delivery-time fields").
//
//  A publishing rule's protection and distribution sections were saved,
//  locked, checked and stamped on every published title (P3, P3-4), but
//  nothing where a title is played or handed out read them. This is where the
//  delivery paths read them, always from the title's STAMP (the resolved
//  rules written on it at publish and kept current by restampStale), never
//  from the rules themselves: the stamp is in the cached availability row the
//  play gate already reads, so a warm gate still makes no database read.
//
//    protection.tokenLifetimeSec  the edge token's lifetime (services/edgeTokens.ts)
//    protection.referrers         the sites a player may be embedded on (the play gate)
//    distribution.mp4Download     the MP4 file leaving Volt: Downloads and a share
//                                 link's hi-res download
//    distribution.shareLinks      making and opening share links
//
//  A title stamped before a section existed has none on its stamp: the
//  baseline applies (everything allowed, the platform's token lifetime), as it
//  did before. A title that is not published has no stamp: the paths that can
//  reach one (making a share link, staff downloads) resolve its rules instead,
//  which is a database read on a console path, never on the play path.
//
//  Concurrent streams, FAST eligibility and the sitemap and schema.org
//  exposure are P3-4c.
// ============================================================================
import { BASELINE, resolveForAsset } from './publishingRules';
import { vodAvailabilityRow } from './viewerPath';

export interface DeliveryPolicy {
  /** null: the platform default for the title's policy class. */
  tokenLifetimeSec: number | null;
  /** Empty: any site. */
  referrers: string[];
  mp4Download: boolean;
  shareLinks: boolean;
}

/** The delivery fields of a stamp (or of resolved settings), with the baseline under anything missing. */
export function deliveryPolicyOf(settings: any): DeliveryPolicy {
  const p = settings?.protection ?? {}, d = settings?.distribution ?? {};
  const base = BASELINE as any;
  const life = Number(p.tokenLifetimeSec);
  return {
    tokenLifetimeSec: Number.isFinite(life) && life > 0 ? Math.floor(life) : null,
    referrers: Array.isArray(p.referrers) ? p.referrers.map((r: unknown) => String(r).trim().toLowerCase()).filter(Boolean) : [],
    mp4Download: typeof d.mp4Download === 'boolean' ? d.mp4Download : base.distribution?.mp4Download !== false,
    shareLinks: typeof d.shareLinks === 'boolean' ? d.shareLinks : base.distribution?.shareLinks !== false,
  };
}

/**
 * The delivery policy of an on-demand title: its stamp when it is published
 * (cached, no read when warm), otherwise its rules as they resolve now.
 * null when there is no such asset.
 */
export async function deliveryPolicyFor(assetId: string, accountId: string): Promise<DeliveryPolicy | null> {
  const row = await vodAvailabilityRow(assetId);
  if (!row) return null;
  if (row.availability && typeof row.availability === 'object' && row.availability_state && row.availability_state !== 'draft')
    return deliveryPolicyOf(row.availability);
  const plan = await resolveForAsset(accountId, { id: assetId, schema_id: row.schema_id ?? null, channel_id: row.channel_id ?? null, event_id: row.event_id ?? null,
    availability_override: await overrideOf(assetId) });
  return deliveryPolicyOf(plan.settings);
}

async function overrideOf(assetId: string): Promise<any> {
  const { one } = await import('../db');
  return (await one<any>(`SELECT availability_override FROM vod_assets WHERE id = $1`, [assetId]))?.availability_override ?? null;
}

/** The host name of an Origin or Referer header, without the port. */
export function hostNameOf(u?: string | null): string | null {
  if (!u) return null;
  try { return new URL(u).hostname.toLowerCase() || null; }
  catch { return u.toLowerCase().replace(/^https?:\/\//, '').split(/[/:]/)[0] || null; }
}

/** "example.com" matches only itself; "*.example.com" matches example.com and every name under it. */
export function domainMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (p.startsWith('*.')) return host === p.slice(2) || host.endsWith(p.slice(1));
  return host === p;
}

/**
 * ALLOWED REFERRER DOMAINS at the play gate. A browser says which page is
 * asking (Origin on a fetch, Referer otherwise): it must be one of the
 * domains. A request that names no page is a phone, TV or server app, which
 * is not embedded anywhere and passes; but a web app's key always comes from
 * a page, so a web app that names none is refused (as the app's own
 * allow-list does, services/apiKeys.ts). Returns the refusal's words, or null.
 */
export function referrerRefusal(referrers: string[], req: { origin?: string | null; referrer?: string | null; webApp: boolean }): string | null {
  if (!referrers.length) return null;
  const host = hostNameOf(req.origin) ?? hostNameOf(req.referrer);
  if (!host) return req.webApp ? 'This title can only be played on its approved sites.' : null;
  return referrers.some((d) => domainMatches(d, host)) ? null : `This title cannot be played on ${host}.`;
}
