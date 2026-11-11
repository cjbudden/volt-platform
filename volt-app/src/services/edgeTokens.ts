// ============================================================================
//  EDGE PLAY TOKENS FOR ON-DEMAND MEDIA (build queue P2, PUBLISHING_POLICIES.md
//  "Enforcement: every public path honours the policy").
//
//  Hiding a title from a list does not stop a copied play URL. So when the
//  play gate (/api/availability) lets a viewer play an on-demand asset, the
//  URLs it hands back carry a short signed token IN THE PATH:
//
//    https://cdn/vod/<id>/master.m3u8  ->  https://cdn/t/<token>/vod/<id>/master.m3u8
//
//  In the path, not the query, because every playlist and MPD Volt packages
//  names its segments relatively: a player resolves "720p/seg_3.m4s" against
//  the manifest's URL, so every segment request carries the token too, with
//  no player code and no manifest rewriting (a query string is dropped by
//  Safari's native HLS on segment requests). The edge checks the token and
//  strips the prefix, so the cache key stays the plain path and every viewer
//  shares one cached copy of each segment.
//
//  The token: "<claims>.<sig>", claims = base64url JSON, sig = the first 32
//  hex of HMAC-SHA256(key, "<claims>"), the same shape as the rights-class
//  claim (services/edgeRights.ts) so the edge code is the same few lines:
//    a  asset id                     (the revocation set is keyed on it)
//    p  the path prefix it opens     ("/vod/<id>/" or "/clips/vod/<id>/")
//    c  the viewer's country         ("" when the gate did not know it)
//    k  policy class                 open | members | premium | rights
//    d  DRM flag                     0 today: on-demand packaging is clear (H5-4)
//    s  the play attempt's sid       when the player sent one
//    n  issued at = not before       (epoch seconds)
//    e  expiry                       the earlier of now + lifetime and the end
//                                    of the asset's effective window, so the
//                                    edge ends playback on the exact second
//                                    without knowing any dates
//
//  The edge (deploy/edge/vod-token-viewer-request.js on CloudFront, and
//  deploy/staging/edge-token.js in the staging nginx on the Mac) refuses with
//  403 a bad signature, an expired or not-yet-valid token, a path outside `p`,
//  a viewer country that is not `c` (a URL shared across a border), and a
//  token issued before the asset's revocation time ("r:<asset id>"), which the
//  control plane writes when a title stops being public before its window ends
//  (withdrawn, archived, restricted). Tokens issued after that (republished)
//  play again, so a revocation never needs undoing.
//
//  VOLT_EDGE_TOKENS: "off" (default: URLs as before), "issue" (the gate hands
//  out tokenised URLs; the edge checks every /t/ request; plain paths still
//  play, so nothing breaks while players and caches turn over), "enforce"
//  (as issue, and plain on-demand paths, /clips/vod/ and /vod/, are refused:
//  at CloudFront, at the staging nginx and by the API itself). The console's
//  previews (GET /api/vod/:id `preview`) and share pages carry tokens in both
//  issue and enforce, so they keep playing when enforce is turned on (build
//  queue P2-2b). The API checks /t/<token>/ paths itself too
//  (tokenPathMiddleware), so a single Mac with no edge in front, and the ALB's
//  /clips/* route on AWS, honour the same tokens.
//
//  TOKEN-FREE TITLES (build queue P2-2c): a title whose publishing rule asks
//  for token-free playback, that no viewer condition applies to, plays by its
//  plain address under enforce too. The control plane keeps "f:<asset id>" in
//  the edge store for each such title while it is Available (the value: when
//  that ends, epoch seconds, or 0 for no end), and the three plain-path checks
//  (CloudFront's vod-plain-refuse.js, the staging njs, the API) let a plain
//  /vod/<id>/ or /clips/vod/<id>/ request through when the key is there and
//  not past. Everything else under enforce is refused as before.
//
//  CLIP OUTPUT FOLDERS (build queue P2-2d): a clip cut from a recording keeps
//  its files in a folder of its own, /clips/<asset id>/ (hls/, clip.mp4,
//  clip.mp3), not under /clips/vod/. Under enforce those are refused plain
//  too, at all three checks, so a clip's copied address stops working the
//  same way an encode's does. Everything of Volt's own that hands one to a
//  person already carries a token: the play gate and the console's preview
//  and share pages (tokenPrefix gives the clip's folder), and the recording
//  export's download links (modules/recordings.ts). Server-side readers (FAST,
//  the ad stitcher, the archive, skip markers, social) read the files on disk
//  or in the bucket, never through the public path. Other folders under
//  /clips/ (ad creatives in /clips/ads/) are not titles and pass as before.
//
//  SHARED TOKENS (build queue P2-2f, decided by Christian 11 Nov 2026, option
//  B). A FAST channel's playlist and a guided ad playlist are written once for
//  every viewer and cached at the CDN, so they cannot carry one viewer's
//  token. They carry a shared one instead, one per FAST channel or guided
//  playlist version, whose claims name the titles it opens rather than one
//  folder:
//    k  "shared"
//    g  what it is for ("fast:<channel id>", "guided:<version>"): logs only
//    A  the titles it opens, each as its 32 hex id (dashes dropped to keep
//       the token short: it sits in front of every segment line). It opens
//       /vod/<id>/, /clips/vod/<id>/ and /clips/<id>/ of each (the plain
//       folders enforce refuses), nothing else.
//    d  0 (clear)
//    n  issued at, e expiry, as above
//  No country: country rules stay where they are today (the channel playlist
//  and its rights variants), a shared token is for every viewer. The
//  revocation set still applies per title: the edge takes the title from the
//  path and checks "r:<that id>", so a withdrawn title stops within a minute
//  even though the token also opens other titles.
//
//  ROTATION. sharedEdgeToken() mints on a fixed clock: a new token every
//  `periodSec` (default 3 hours) that lives `periodSec + overlapSec` (default
//  1 hour more), so the token written before a switch keeps opening the
//  segments still in a live window for the overlap, and a copied segment
//  address stops at the end of its period plus the overlap. The same inputs
//  give the same token in every process, so the API and a playout writer
//  agree without sharing state, and a cached playlist stays valid. A title
//  revoked inside the current period moves `n` past its revocation, so it
//  plays again as soon as it is republished, without waiting for a rotation.
//  At most SHARED_TOKEN_MAX_TITLES titles a token (CloudFront takes a path
//  segment up to 2048 characters here); sharedEdgeTokens() splits a longer
//  list into several tokens.
// ============================================================================
import { createHmac, timingSafeEqual } from 'node:crypto';
import { query } from '../db';
import { config } from '../config';
import type { EdgeStore } from './edgeRights';
import type { Request, Response, NextFunction } from 'express';

export type PolicyClass = 'open' | 'members' | 'premium' | 'rights';
export interface EdgeClaims { a: string; p: string; c: string; k: PolicyClass; d: 0 | 1; s?: string; n: number; e: number }
/** A shared token's claims (P2-2f): the titles it opens, for every viewer. */
export interface SharedClaims { k: 'shared'; g: string; A: string[]; d: 0; n: number; e: number }

/** Where the edge reads the key ("k:pt") and the revocations ("r:<asset id>"). */
export const TOKEN_KEY = 'k:pt';
export const revocationKey = (assetId: string) => `r:${assetId}`;
/** A token-free title's key in the edge store (P2-2c): value "<until epoch s>" or "0". */
export const openKey = (assetId: string) => `f:${assetId}`;

/** The asset id of a plain on-demand path (/vod/<id>/..., /clips/vod/<id>/... or a clip's /clips/<id>/...), or null. */
export function plainAssetId(uri: string): string | null {
  const m = /^\/(?:clips\/vod|vod|clips)\/([0-9a-fA-F-]{36})\//.exec(uri);
  return m && uri.indexOf('/../') < 0 ? m[1].toLowerCase() : null;
}

/**
 * THE PLAIN-PATH CHECK, in TypeScript: the reference the CloudFront function
 * and the staging njs are tested against. "ok" lets the request through,
 * "403" refuses it. `open`: the value of "f:<id>" for the path's asset.
 */
export function plainPathVerdict(uri: string, mode: string, open: string | null | undefined, nowSec: number): 'ok' | '403' {
  if (String(mode ?? '').trim().toLowerCase() !== 'enforce' || !PLAIN_VOD_RE.test(uri)) return 'ok';
  if (open == null || !plainAssetId(uri)) return '403';
  const until = Number(open);
  return Number.isFinite(until) && (until === 0 || nowSec < until) ? 'ok' : '403';
}

export function edgeTokensMode(): 'off' | 'issue' | 'enforce' {
  const v = String(process.env.VOLT_EDGE_TOKENS ?? '').trim().toLowerCase();
  return v === 'enforce' ? 'enforce' : v === 'issue' || v === 'on' ? 'issue' : 'off';
}

/**
 * The plain on-demand paths enforce refuses: an encode's folder, an S3-served
 * copy, and a clip's own folder (/clips/<asset id>/, build queue P2-2d).
 */
export const PLAIN_VOD_RE = /^\/(clips\/vod|vod|clips\/[0-9a-fA-F-]{36})\//;
/** The part of PLAIN_VOD_RE the API serves itself (it serves no /vod/ media). */
export const PLAIN_CLIPS_RE = /^\/clips\/(vod|[0-9a-fA-F-]{36})\//;

/**
 * TOKENISED PREVIEW URLS for people who are not a viewer of an app: the
 * console's preview of a title (any status: a draft must be previewable) and a
 * share page. Every URL under the folder the manifests share gets the same
 * token (manifests, the MP4 and MP3 files, a clip's own folder). URLs outside
 * that folder, or absolute URLs on another host, are left as they are. Null
 * when tokens are off or there is nothing to tokenise.
 */
export function tokenisedUrls<T extends Record<string, string | null | undefined>>(urls: T, o: {
  assetId: string; country?: string | null; policyClass?: PolicyClass; effectiveUntil?: Date | null; lifetimeSec?: number | null; nowSec?: number;
}): { urls: { [K in keyof T]: string | null }; expiresAt: number } | null {
  if (edgeTokensMode() === 'off') return null;
  const list = Object.values(urls).filter((u): u is string => !!u);
  // The folder the manifests share; when the other files sit beside it (a
  // clip's MP4 next to its hls/ folder), the folder above, never shallower
  // than tokenPrefix allows.
  const prefix = tokenPrefix(list) ?? tokenPrefix(list.filter((u) => /\.(m3u8|mpd)(\?|$)/i.test(u)));
  if (!prefix) return null;
  const t = mintEdgeToken({ assetId: o.assetId, prefix, country: o.country ?? null, policyClass: o.policyClass ?? 'rights',
    effectiveUntil: o.effectiveUntil ?? null, lifetimeSec: o.lifetimeSec ?? null, nowSec: o.nowSec });
  const pathOf = (u: string) => { try { return new URL(u, 'http://x').pathname; } catch { return ''; } };
  const out: any = {};
  for (const [k, u] of Object.entries(urls)) out[k] = u && pathOf(u).startsWith(prefix) ? withToken(u, t.token) : (u ?? null);
  return { urls: out, expiresAt: t.claims.e };
}

/** The latest revocation time of an asset (epoch seconds), cached briefly: the API's own token check reads it per request. */
export async function revokedAtFor(assetId: string): Promise<number | null> {
  const { cached } = await import('../scale/cache');
  return cached<number | null>(`edgerev:${assetId}`, { ttlSec: 5, tags: [`asset:${assetId}`] }, async () => {
    const r = await query<any>(`SELECT extract(epoch FROM revoked_at)::bigint AS at FROM edge_revocations WHERE asset_id::text = $1 AND expires_at > now()`, [assetId]);
    return r[0] ? Number(r[0].at) : null;
  });
}

/**
 * The key tokens are signed with and that the sync publishes at "k:pt". Its own
 * derivation, so the edge never holds a key that signs anything else.
 */
export function edgeTokenKey(): string {
  return process.env.EDGE_TOKEN_KEY
    || createHmac('sha256', config.jwt.accessSecret).update('volt-edge-play-token-v1').digest('hex');
}

/**
 * How long a token lives before its window clamps it. No renewal exists yet,
 * so a restricted title's token must outlast a long viewing: 4 hours; open
 * content 24 hours (it still ends on its exact date through the clamp). A
 * publishing rule's token lifetime (Protection, build queue P3-4b) replaces
 * these for the titles it governs: the play gate passes it as `lifetimeSec`.
 */
export function tokenLifetimeSec(k: PolicyClass): number {
  const n = (v: string | undefined, dflt: number) => { const x = Number(v); return Number.isFinite(x) && x >= 60 ? Math.floor(x) : dflt; };
  return k === 'open' ? n(process.env.EDGE_TOKEN_OPEN_TTL_SEC, 24 * 3600) : n(process.env.EDGE_TOKEN_TTL_SEC, 4 * 3600);
}
/** The longest token lifetime a publishing rule may set (modules/publishingRules.ts allows 30 s to 24 h). */
export const POLICY_MAX_TOKEN_LIFETIME_SEC = 86_400;
/**
 * The longest a token can live: how long a revocation must be kept at the
 * edge. A rule may set up to a day whatever the defaults are, so a revocation
 * is kept at least that long, or a long-lived token would outlast it.
 */
export const maxTokenLifetimeSec = () => Math.max(tokenLifetimeSec('open'), tokenLifetimeSec('rights'), POLICY_MAX_TOKEN_LIFETIME_SEC);

const b64u = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const sig = (key: string, body: string) => createHmac('sha256', key).update(body).digest('hex').slice(0, 32);

export function signEdgeToken(c: EdgeClaims, key = edgeTokenKey()): string {
  const body = b64u(JSON.stringify(c));
  return `${body}.${sig(key, body)}`;
}

/**
 * Mint a token for a play. `effectiveUntil` is the end of the window the
 * viewer may play in (publish window inside the rights window).
 */
export function mintEdgeToken(o: {
  assetId: string; prefix: string; country?: string | null; policyClass: PolicyClass; drm?: boolean; sid?: string | null;
  effectiveUntil?: Date | null; nowSec?: number; key?: string;
  /** The title's rule's token lifetime (Protection); null or absent: the policy class default. */
  lifetimeSec?: number | null;
}): { token: string; claims: EdgeClaims } {
  const n = o.nowSec ?? Math.floor(Date.now() / 1000);
  const life = o.lifetimeSec && o.lifetimeSec > 0 ? Math.min(Math.floor(o.lifetimeSec), POLICY_MAX_TOKEN_LIFETIME_SEC) : tokenLifetimeSec(o.policyClass);
  let e = n + life;
  if (o.effectiveUntil) e = Math.min(e, Math.floor(o.effectiveUntil.getTime() / 1000));
  const claims: EdgeClaims = { a: o.assetId, p: o.prefix, c: (o.country ?? '').toUpperCase(), k: o.policyClass, d: o.drm ? 1 : 0, ...(o.sid ? { s: o.sid } : {}), n, e };
  return { token: signEdgeToken(claims, o.key), claims };
}

export type EdgeVerdict = 'ok' | 'malformed' | 'signature' | 'early' | 'expired' | 'path' | 'country' | 'revoked';

// ---------------------------------------------------------------------------
//  Shared tokens (P2-2f)
// ---------------------------------------------------------------------------
/** The title folders a shared token can open: an encode's, local or in the bucket, and a clip's own (the same three enforce refuses plain). */
export const SHARED_PATH_RE = /^\/(?:clips\/vod|vod|clips)\/([0-9a-fA-F-]{36})\//;
/** The most titles one shared token names (the token must stay under 2048 characters). */
export const SHARED_TOKEN_MAX_TITLES = 32;
const hex32 = (id: string) => id.replace(/-/g, '').toLowerCase();

export function sharedRotation(): { periodSec: number; overlapSec: number } {
  const n = (v: string | undefined, dflt: number, min: number) => { const x = Number(v); return Number.isFinite(x) && x >= min ? Math.floor(x) : dflt; };
  return { periodSec: n(process.env.EDGE_SHARED_TOKEN_PERIOD_SEC, 3 * 3600, 300), overlapSec: n(process.env.EDGE_SHARED_TOKEN_OVERLAP_SEC, 3600, 60) };
}

/**
 * The shared token in force at `nowSec` for these titles (at most
 * SHARED_TOKEN_MAX_TITLES; see sharedEdgeTokens for more). `revokedAt`: the
 * titles' revocation times (epoch s) where they have one, so a title
 * republished inside the period gets a token issued after its revocation.
 * `periodStart` and `nextAt` say when this token was due and when the next is.
 * The caller names only titles that may play now: a revoked title named here
 * would play again (that is how a republished one does).
 */
export function sharedEdgeToken(o: {
  scope: string; assetIds: string[]; nowSec?: number; key?: string; periodSec?: number; overlapSec?: number;
  revokedAt?: Record<string, number | null | undefined>; effectiveUntil?: Date | null;
}): { token: string; claims: SharedClaims; periodStart: number; nextAt: number } {
  const now = o.nowSec ?? Math.floor(Date.now() / 1000);
  const dflt = sharedRotation();
  const P = o.periodSec ?? dflt.periodSec, O = o.overlapSec ?? dflt.overlapSec;
  const ids = [...new Set(o.assetIds.map(hex32))].sort();
  if (!ids.length) throw new Error('a shared token opens at least one title');
  if (ids.length > SHARED_TOKEN_MAX_TITLES) throw new Error(`a shared token opens at most ${SHARED_TOKEN_MAX_TITLES} titles`);
  const start = Math.floor(now / P) * P;
  let n = start;
  for (const [id, at] of Object.entries(o.revokedAt ?? {})) {
    if (at != null && ids.includes(hex32(id)) && at >= n && at < now) n = at + 1;
  }
  let e = start + P + O;
  if (o.effectiveUntil) e = Math.min(e, Math.floor(o.effectiveUntil.getTime() / 1000));
  const claims: SharedClaims = { k: 'shared', g: o.scope.slice(0, 80), A: ids, d: 0, n, e };
  const body = b64u(JSON.stringify(claims));
  return { token: `${body}.${sig(o.key ?? edgeTokenKey(), body)}`, claims, periodStart: start, nextAt: start + P };
}

/**
 * Shared tokens for any number of titles: one per SHARED_TOKEN_MAX_TITLES,
 * and which token opens which title (keyed by the id as given).
 */
export function sharedEdgeTokens(o: Omit<Parameters<typeof sharedEdgeToken>[0], 'assetIds'> & { assetIds: string[] }):
  { tokens: string[]; byAsset: Map<string, string>; nextAt: number } {
  const uniq = [...new Map(o.assetIds.map((id) => [hex32(id), id])).values()].sort((x, y) => hex32(x) < hex32(y) ? -1 : 1);
  const tokens: string[] = []; const byAsset = new Map<string, string>(); let nextAt = 0;
  for (let i = 0; i < uniq.length; i += SHARED_TOKEN_MAX_TITLES) {
    const part = uniq.slice(i, i + SHARED_TOKEN_MAX_TITLES);
    const t = sharedEdgeToken({ ...o, assetIds: part });
    tokens.push(t.token); nextAt = t.nextAt;
    for (const id of part) byAsset.set(id, t.token);
  }
  return { tokens, byAsset, nextAt };
}

/**
 * The words in an edge refusal's body (build queue P2-2), the same at both
 * edges and on the play gate: a URL taken across a border says what the gate
 * would have said (DEFAULT_BLOCK_MESSAGE). The edge cannot read an account's
 * own block message (it has no database), so it always uses the default words;
 * players show the account's message from the gate's 451 before they get here.
 */
export const EDGE_REFUSAL_TEXT: Record<Exclude<EdgeVerdict, 'ok'>, string> = {
  malformed: 'Not available', signature: 'Not available', path: 'Not available',
  early: 'This link has expired', expired: 'This link has expired',
  country: 'Not available in your region', revoked: 'No longer available',
};

/**
 * THE EDGE'S CHECK, in TypeScript: the reference the two edge files are tested
 * against (test/edge-tokens.check.ts runs all three on the same cases).
 * `uri` is the path after the /t/<token> prefix.
 */
export function verifyEdgeToken(token: string, uri: string, o: {
  country?: string | null; nowSec: number; key?: string;
  /** The revocation time of the title the path is in (for a shared token, the path's title, see sharedAssetOf). */
  revokedAt?: number | null;
}): { verdict: EdgeVerdict; claims?: EdgeClaims; shared?: SharedClaims; asset?: string } {
  const m = /^([A-Za-z0-9_-]{8,2048})\.([0-9a-f]{32})$/.exec(token);
  if (!m) return { verdict: 'malformed' };
  const want = Buffer.from(sig(o.key ?? edgeTokenKey(), m[1])), got = Buffer.from(m[2]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { verdict: 'signature' };
  let c: EdgeClaims;
  try { c = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch { return { verdict: 'malformed' }; }
  if ((c as any)?.k === 'shared') {
    // P2-2f: the titles it names, any viewer; the revocation set per title.
    const sc = c as unknown as SharedClaims;
    if (!Array.isArray(sc.A)) return { verdict: 'malformed' };
    if (o.nowSec + 60 < sc.n) return { verdict: 'early', shared: sc };
    if (o.nowSec >= sc.e) return { verdict: 'expired', shared: sc };
    const asset = sharedAssetOf(uri);
    if (!asset || sc.A.indexOf(hex32(asset)) < 0) return { verdict: 'path', shared: sc };
    if (o.revokedAt != null && sc.n <= o.revokedAt) return { verdict: 'revoked', shared: sc, asset };
    return { verdict: 'ok', shared: sc, asset };
  }
  if (typeof c?.p !== 'string' || typeof c?.a !== 'string') return { verdict: 'malformed' };
  if (o.nowSec + 60 < c.n) return { verdict: 'early', claims: c };
  if (o.nowSec >= c.e) return { verdict: 'expired', claims: c };
  if (!c.p || uri.indexOf(c.p) !== 0 || uri.indexOf('/../') >= 0) return { verdict: 'path', claims: c };
  const cc = (o.country ?? '').toUpperCase();
  if (c.c && cc && c.c !== cc) return { verdict: 'country', claims: c };
  if (o.revokedAt != null && c.n <= o.revokedAt) return { verdict: 'revoked', claims: c, asset: c.a };
  return { verdict: 'ok', claims: c, asset: c.a };
}

/** The title a shared token's path is in (lower case, with dashes), or null when it is not a title folder it can open. */
export function sharedAssetOf(uri: string): string | null {
  const m = SHARED_PATH_RE.exec(uri);
  return m && uri.indexOf('/../') < 0 ? m[1].toLowerCase() : null;
}

/**
 * THE SHARED TOKENS A PLAYLIST WRITER PUTS IN FRONT OF ITS TITLES' SEGMENTS
 * (P2-2f-2): given the master keys a FAST channel's timeline names (local
 * "/clips/vod/<id>/..." or the bucket's "vod/<id>/..."), the token for each
 * title folder, keyed by the folder's id in lower case. Null when tokens are
 * off. The writer asks again well inside each period (the FAST playout reads
 * its timeline every 20 s), so it moves to the next token at `nextAt` with the
 * one before still valid for the overlap.
 *
 * WHO IS NAMED: a title is left out while it has a live revocation and is not
 * public now (withdrawn, archived, its rights ended early): its segments stop
 * at the edge within a minute and no later token opens them again. A title
 * revoked and public again (republished) is named with its revocation time,
 * so it plays at once. Titles never offered on demand (FAST-only) have no
 * revocation and are named. Folders that are not a title's (ad creatives,
 * prepared loops under the origin) need no token and are not named.
 */
export async function playlistEdgeTokens(scope: string, masterKeys: (string | null | undefined)[], nowSec = Math.floor(Date.now() / 1000)):
  Promise<{ byAsset: Record<string, string>; nextAt: number; periodSec: number; overlapSec: number } | null> {
  if (edgeTokensMode() === 'off') return null;
  const ids = [...new Set(masterKeys.map((k) => k ? sharedAssetOf('/' + k.replace(/^\/+/, '')) : null).filter((x): x is string => !!x))];
  const rot = sharedRotation();
  const empty = { byAsset: {}, nextAt: (Math.floor(nowSec / rot.periodSec) + 1) * rot.periodSec, ...rot };
  if (!ids.length) return empty;
  const rows = await query<any>(
    `SELECT r.asset_id::text AS id, extract(epoch FROM r.revoked_at)::bigint AS at, v.public_status = 'available' AS public
       FROM edge_revocations r LEFT JOIN vod_assets v ON v.id = r.asset_id
      WHERE r.asset_id::text = ANY($1::text[]) AND r.expires_at > now()`, [ids]);
  const revokedAt: Record<string, number> = {};
  const out = new Set<string>();
  for (const r of rows) { if (r.public) revokedAt[r.id] = Number(r.at); else out.add(r.id); }
  const named = ids.filter((id) => !out.has(id));
  if (!named.length) return empty;
  const t = sharedEdgeTokens({ scope, assetIds: named, nowSec, revokedAt });
  return { byAsset: Object.fromEntries(t.byAsset), nextAt: t.nextAt, ...rot };
}

/**
 * The prefix a token opens: the folder both manifests live in. Null when the
 * URLs share no folder at least two levels deep (never open "/" or "/clips/").
 */
export function tokenPrefix(urls: (string | null | undefined)[]): string | null {
  const paths = urls.filter((u): u is string => !!u).map((u) => { try { return new URL(u, 'http://x').pathname; } catch { return null; } });
  if (!paths.length || paths.some((p) => !p)) return null;
  const dirs = (paths as string[]).map((p) => p.slice(0, p.lastIndexOf('/') + 1));
  let pre = dirs[0];
  for (const d of dirs.slice(1)) { while (pre && !d.startsWith(pre)) pre = pre.slice(0, pre.slice(0, -1).lastIndexOf('/') + 1); }
  return pre && pre.split('/').filter(Boolean).length >= 2 ? pre : null;
}

/** "/clips/vod/x/master.m3u8" or "https://cdn/vod/x/master.m3u8" with the token put in front of the path. */
export function withToken(url: string | null | undefined, token: string): string | null {
  if (!url) return url ?? null;
  const abs = /^https?:\/\//i.test(url);
  const u = new URL(url, 'http://x');
  u.pathname = `/t/${token}${u.pathname}`;
  return abs ? u.toString() : u.pathname + u.search;
}

/** The policy class from the asset's rights and the gate's decision. */
export function policyClassOf(o: { territoryMode?: string | null; via?: string | null }): PolicyClass {
  if (o.territoryMode && o.territoryMode !== 'worldwide') return 'rights';
  if (o.via === 'entitlement') return 'premium';
  if (o.via === 'members') return 'members';
  return 'open';
}

// ---------------------------------------------------------------------------
//  The revocation set
// ---------------------------------------------------------------------------
/**
 * A title stopped being public: refuse its tokens issued until now. Kept as
 * long as a token can live, then dropped (by then every such token expired).
 */
export async function revokeAsset(assetId: string, reason: string, nowSec = Math.floor(Date.now() / 1000)): Promise<void> {
  await query(
    `INSERT INTO edge_revocations (asset_id, revoked_at, expires_at, reason)
     VALUES ($1, to_timestamp($2), to_timestamp($2) + make_interval(secs => $3), $4)
     ON CONFLICT (asset_id) DO UPDATE SET revoked_at = EXCLUDED.revoked_at, expires_at = EXCLUDED.expires_at, reason = EXCLUDED.reason`,
    [assetId, nowSec, maxTokenLifetimeSec(), reason.slice(0, 200)]);
}

/**
 * Keep the edge store in step: the key at "k:pt", one "r:<id>" per live
 * revocation (value: revoked-at epoch seconds), expired ones removed from the
 * store and the table. Writes only what changed (memo).
 */
export async function syncEdgeTokens(store: EdgeStore, memo?: Map<string, string | null>, key = edgeTokenKey()):
  Promise<{ put: number; deleted: number }> {
  const res = { put: 0, deleted: 0 };
  const cur = memo?.has(TOKEN_KEY) ? memo.get(TOKEN_KEY)! : await store.get(TOKEN_KEY);
  if (cur !== key) { await store.put(TOKEN_KEY, key); res.put++; }
  memo?.set(TOKEN_KEY, key);
  const rows = await query<any>(`SELECT asset_id, extract(epoch FROM revoked_at)::bigint AS at, expires_at <= now() AS gone FROM edge_revocations`);
  for (const r of rows) {
    const k = revocationKey(r.asset_id);
    if (r.gone) {
      await store.delete(k); memo?.set(k, null); res.deleted++;
      await query(`DELETE FROM edge_revocations WHERE asset_id = $1 AND expires_at <= now()`, [r.asset_id]);
      continue;
    }
    const v = String(r.at);
    const was = memo?.has(k) ? memo.get(k)! : await store.get(k);
    if (was !== v) { await store.put(k, v); res.put++; }
    memo?.set(k, v);
  }
  return res;
}

/**
 * THE TOKEN-FREE SET at the edge (P2-2c): "f:<id>" for every title that plays
 * by its plain address now, removed when it stops (rule changed, a condition
 * added, window ended, withdrawn). The keys written are kept in
 * edge_open_assets, because the store cannot be listed: that is how a key
 * that is no longer wanted is found and removed after a restart.
 */
export async function syncEdgeOpen(store: EdgeStore, memo?: Map<string, string | null>, now = new Date()): Promise<{ put: number; deleted: number }> {
  const res = { put: 0, deleted: 0 };
  const { tokenFreeNow } = await import('./deliveryPolicy');
  // Candidates: stamped token-free and Available. tokenFreeNow decides.
  const cand = await query<any>(
    `SELECT v.id::text AS id, COALESCE(g.account_id, v.account_id)::text AS account_id
       FROM vod_assets v
       LEFT JOIN channels c ON c.id = v.channel_id
       LEFT JOIN events   e ON e.id = v.event_id
       LEFT JOIN groups   g ON g.id = COALESCE(c.group_id, e.group_id)
      WHERE v.availability -> 'protection' ->> 'tokenFree' = 'true' AND v.availability_state = 'available' AND v.archived_at IS NULL`);
  const want = new Map<string, string>();
  for (const r of cand) {
    const tf = await tokenFreeNow(r.id, { accountId: r.account_id, now }).catch(() => null);
    if (tf?.open) want.set(r.id, tf.until ? String(Math.floor(tf.until.getTime() / 1000)) : '0');
  }
  const had = await query<any>(`SELECT asset_id::text AS id, value FROM edge_open_assets`);
  for (const h of had) {
    if (want.has(h.id)) continue;
    await store.delete(openKey(h.id)); memo?.set(openKey(h.id), null); res.deleted++;
    await query(`DELETE FROM edge_open_assets WHERE asset_id = $1::uuid`, [h.id]);
  }
  const hadV = new Map(had.map((h) => [h.id, h.value]));
  for (const [id, v] of want) {
    const k = openKey(id);
    const was = memo?.has(k) ? memo.get(k)! : hadV.get(id) ?? null;
    if (was !== v) {
      await store.put(k, v); res.put++;
      await query(`INSERT INTO edge_open_assets (asset_id, value, synced_at) VALUES ($1::uuid, $2, now())
                   ON CONFLICT (asset_id) DO UPDATE SET value = EXCLUDED.value, synced_at = now()`, [id, v]);
    }
    memo?.set(k, v);
  }
  return res;
}

/**
 * The staging edge's store (the Mac): one JSON file of the same keys the
 * CloudFront KeyValueStore holds, on the volume the nginx edge mounts. Written
 * whole to a temporary file and renamed, so the edge never reads half a file.
 */
export async function fileEdgeStore(path: string): Promise<EdgeStore> {
  const fs = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const read = async (): Promise<Record<string, string>> => {
    try { return JSON.parse(await fs.readFile(path, 'utf8')); } catch { return {}; }
  };
  const write = async (o: Record<string, string>) => {
    await fs.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(o));
    await fs.rename(tmp, path);
  };
  return {
    async get(k) { const o = await read(); return k in o ? o[k] : null; },
    async put(k, v) { const o = await read(); o[k] = v; await write(o); },
    async delete(k) { const o = await read(); if (k in o) { delete o[k]; await write(o); } },
  };
}

// ---------------------------------------------------------------------------
//  The API as its own edge (build queue P2-2b)
// ---------------------------------------------------------------------------
const refuseText = (res: Response, code: number, text: string) => {
  res.status(code).set({ 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }).end(text + '\n');
};

/**
 * /t/<token>/clips/... served by the API itself: the same check as the two
 * edges (signature, time, folder, the viewer's country, the revocation set),
 * then the plain path is served by the /clips routes below it. A single Mac
 * with no edge in front plays tokenised URLs this way, the staging nginx
 * passes its checked /t/ requests on unchanged, and on AWS the ALB's /clips/*
 * route (the API's own address) answers the same as CloudFront.
 *
 * ENFORCE: a plain /clips/vod/ or clip output (/clips/<asset id>/) request
 * is refused. Mounted before every /clips route, so nothing under it can
 * serve a plain path.
 */
export function tokenPathMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    let path = req.path;
    try { path = decodeURIComponent(req.path); } catch { /* the raw path is checked */ }
    if (!path.startsWith('/t/')) {
      // /clips/vod/ and clip outputs only: the API serves no /vod/ media (that
      // is S3 behind CloudFront), and /vod is the console's Media Library page.
      if (edgeTokensMode() === 'enforce' && PLAIN_CLIPS_RE.test(path)) {
        // A token-free title (P2-2c) plays by its plain address: the same
        // answer the edges read from "f:<id>", here from the cached stamp.
        const id = plainAssetId(path);
        const { tokenFreeNow } = await import('./deliveryPolicy');
        const tf = id ? await tokenFreeNow(id).catch(() => null) : null;
        if (!tf?.open) return refuseText(res, 403, EDGE_REFUSAL_TEXT.path);
      }
      return next();
    }
    const m = /^\/t\/([^/]+)(\/.*)$/.exec(req.path);
    // Only what the API itself serves can sit behind a token here.
    if (!m || !m[2].startsWith('/clips/')) return refuseText(res, 403, EDGE_REFUSAL_TEXT.malformed);
    const { viewerGeo } = await import('../scale/edge');
    const nowSec = Math.floor(Date.now() / 1000);
    const v = verifyEdgeToken(m[1], m[2], { country: viewerGeo(req) ?? null, nowSec });
    if (v.verdict !== 'ok') return refuseText(res, 403, EDGE_REFUSAL_TEXT[v.verdict]);
    // The title the request is in: the token's own, or for a shared token
    // (P2-2f) the one in the path, so each title's revocation applies.
    const rv = await revokedAtFor(v.asset!).catch(() => null);
    const issued = v.claims?.n ?? v.shared!.n;
    if (rv != null && issued <= rv) return refuseText(res, 403, EDGE_REFUSAL_TEXT.revoked);
    const q = req.url.indexOf('?');
    req.url = m[2] + (q >= 0 ? req.url.slice(q) : '');
    next();
  };
}
