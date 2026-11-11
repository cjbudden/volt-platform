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
//
//    protection.tokenFree         plain addresses for content no viewer
//                                 condition applies to (build queue P2-2c):
//                                 tokenFreeBlockers() says what stops it,
//                                 tokenFreeNow() whether a title plays by a
//                                 plain address right now
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
  /** What the stamp asks for; whether it applies is tokenFreeNow()'s answer. */
  tokenFree: boolean;
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
    tokenFree: p.tokenFree === true,
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

// ---------------------------------------------------------------------------
//  TOKEN-FREE PLAYBACK (build queue P2-2c)
// ---------------------------------------------------------------------------
/**
 * A plain address plays for whoever has it: nothing checks the viewer. So a
 * title may only be token-free when nothing about it depends on who or where
 * the viewer is, or on how it is played. Each of these is a reason it cannot
 * be (the codes are stable; the words are for people):
 *
 *   geo        the policy's geo, or an access rule, limits countries
 *   account    the account's own geo limit (Account settings)
 *   rights     the rights profile limits territories or apps
 *   paywall    paid or entitled access, a paywall, or a premium rule
 *   sign_in    an access rule or a collection asks viewers to sign in
 *   collection a collection the title is in asks for a package or a sign-in
 *   drm        DRM packaging (a licence per viewer)
 *   referrers  allowed referrer domains (only the play gate can check them)
 *   concurrent a concurrent streams limit (only the play gate can count)
 *
 * PURE. `settings` is a stamp or resolved settings; the rest is optional so a
 * rule being saved (no title, no account limit known) is checked on its own.
 */
export interface TokenFreeBlocker { code: 'geo' | 'account' | 'rights' | 'paywall' | 'sign_in' | 'collection' | 'drm' | 'referrers' | 'concurrent'; words: string }
export function tokenFreeBlockers(settings: any, o: {
  rights?: { territoryMode?: string | null; appMode?: string | null } | null;
  accountGeo?: { mode: string; countries: string[] } | null;
  collectionAccess?: { g?: { levels: { rules?: { access: string }[] }[] }[] } | null;
} = {}): TokenFreeBlocker[] {
  const s = settings ?? {}, p = s.protection ?? {};
  const out: TokenFreeBlocker[] = [];
  const add = (code: TokenFreeBlocker['code'], words: string) => { if (!out.some((b) => b.code === code)) out.push({ code, words }); };
  const rules: any[] = Array.isArray(s.accessRules) ? s.accessRules : [];
  const worldIn = (r: any) => r?.if?.geo === 'in' && (r.if.countries ?? []).length > 0 && (r.if.countries ?? []).every((c: string) => String(c).toUpperCase() === 'WORLD');
  if ((s.geo?.mode === 'allow' || s.geo?.mode === 'block') || rules.some((r) => !worldIn(r))) add('geo', 'it is limited to some countries');
  if (o.accountGeo && (o.accountGeo.mode === 'allow' || o.accountGeo.mode === 'block')) add('account', 'the account is limited to some countries');
  if (o.rights && ((o.rights.territoryMode && o.rights.territoryMode !== 'worldwide') || (o.rights.appMode && o.rights.appMode !== 'all'))) add('rights', 'its rights limit territories or apps');
  if (s.access === 'paid' || s.access === 'entitled' || (s.paywall && typeof s.paywall === 'object') || rules.some((r) => r?.then?.access === 'premium')) add('paywall', 'it needs a payment or an entitlement');
  if (rules.some((r) => r?.then?.access === 'members' || (r?.then?.userGroups ?? []).length)) add('sign_in', 'viewers must sign in');
  const levels = (o.collectionAccess?.g ?? []).flatMap((ch) => ch.levels ?? []);
  if (levels.some((l) => (l.rules ?? []).some((r) => r.access !== 'free'))) add('collection', 'a collection it is in asks for a sign-in or a package');
  if (p.drm === true) add('drm', 'DRM is on');
  if (Array.isArray(p.referrers) && p.referrers.length) add('referrers', 'it may only be embedded on some sites');
  if (p.concurrentStreams != null && Number(p.concurrentStreams) > 0) add('concurrent', 'it has a concurrent streams limit');
  return out;
}

/**
 * Does this on-demand title play by its plain address right now? Only an
 * Available title whose stamp asks for it and that no blocker applies to.
 * `until`: when that stops on its own (the end of its window), so the edge
 * can stop letting plain requests through on the exact second. Everything it
 * reads is cached (the availability row, the rights profile, the account's
 * geo), so the API's own plain-path check makes no database read when warm.
 */
export async function tokenFreeNow(assetId: string, o: { accountId?: string | null; now?: Date } = {}):
  Promise<{ open: boolean; until: Date | null; blockers: TokenFreeBlocker[] }> {
  const no = { open: false, until: null, blockers: [] as TokenFreeBlocker[] };
  if (!/^[0-9a-f-]{36}$/i.test(assetId)) return no;
  const row = await vodAvailabilityRow(assetId);
  if (!row || row.availability?.protection?.tokenFree !== true) return no;
  const now = o.now ?? new Date();
  const { publicDecision } = await import('./publicStatus');
  const ps = await publicDecision(assetId, now);
  if (!ps || ps.status !== 'available') return no;
  const blockers = await blockersOf(assetId, row, o.accountId);
  return { open: !blockers.length, until: ps.effectiveUntil ?? null, blockers };
}

/** tokenFreeBlockers for an asset's own row, with its rights, its account's geo and its collections. */
async function blockersOf(assetId: string, row: any, accountId?: string | null): Promise<TokenFreeBlocker[]> {
  const { rightsForAsset } = await import('./rightsProfiles');
  const { accountGeo } = await import('./geoAccess');
  const acct = accountId ?? await accountOf(assetId);
  return tokenFreeBlockers(row?.availability, {
    rights: row ? await rightsForAsset(row) : null, accountGeo: acct ? await accountGeo(acct) : null, collectionAccess: row?.collection_access ?? null });
}

/**
 * MAY THE schema.org DATA NAME THE TITLE'S MEDIA? (build queue P2-2g,
 * decided by Christian, 11 Nov 2026.) `GET /api/vod/{id}/schema.org` puts the
 * plain MP4 in `contentUrl` and the plain HLS, DASH and MP4 in
 * `associatedMedia`. Those are plain addresses with no play token: where
 * tokens are enforced they answer 403, and where they are only issued (or
 * off) they are a ready-made way round the play gate for a title the gate
 * would refuse some viewers. So they are named only where a plain address is
 * the right answer anyway:
 *   - a token-free title (tokenFreeNow: it plays by its plain address at the
 *     edge), in every mode;
 *   - under issue or off, a title with no viewer condition at all (the same
 *     test as tokenFreeBlockers: geo, rights territories or apps, paywall or
 *     paid access, sign-in, a collection's access, DRM, referrers, a streams
 *     limit).
 * Never under enforce otherwise. `embedUrl` (the watch page) is not decided
 * here: it always stays, so the title can still get video results.
 */
export async function schemaOrgMediaAllowed(assetId: string, o: { accountId?: string | null } = {}): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(assetId)) return false;
  const tf = await tokenFreeNow(assetId, o).catch(() => null);
  if (tf?.open) return true;
  const { edgeTokensMode } = await import('./edgeTokens');
  if (edgeTokensMode() === 'enforce') return false;
  const row = await vodAvailabilityRow(assetId);
  return (await blockersOf(assetId, row, o.accountId)).length === 0;
}

/** The account an asset belongs to, cached (an asset never changes account). */
async function accountOf(assetId: string): Promise<string | null> {
  const { cached } = await import('../scale/cache');
  const { one } = await import('../db');
  return cached<string | null>(`vodacct:${assetId}`, { ttlSec: 3600, tags: [`asset:${assetId}`] },
    async () => (await one<any>(`SELECT account_id FROM vod_assets WHERE id = $1`, [assetId]))?.account_id ?? null);
}
